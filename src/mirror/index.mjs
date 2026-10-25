// Local mirror: re-serves the endpoints captured in one session as a local streaming service.
//
//   const m = await startMirror({ session, port: 0, speed: 1, instant: false, synthesize: false, onRequest });
//   m.url / m.port / m.routes() / m.log() / await m.close()
//
// Matching    every request is scored against every captured exchange (method, path, query,
//             body; see match.mjs). exact > route (same templated path) > nearest fallback.
// Replay      original status, cleaned headers and body chunks with original timing
//             (speed factor, instant mode): SSE, chunked, NDJSON, plain bodies, EventSource
//             messages (re-framed as SSE) and WebSockets (RFC 6455, client-message-driven turns).
// Templating  variable request fields echoed by the response are substituted (template.mjs).
// Synthesize  streaming routes emit a reconstructed answer in the learned delta dialect
//             (synthesize.mjs). synthesize: true | string | async ({ request, route }) => string;
//             per request: ?__mirror_text=... or header x-mirror-text. Falls back to replay when
//             the dialect cannot be learned or the self-check fails.
// Control     GET /__mirror/routes | /__mirror/log | /__mirror/health (JSON).
// onRequest   called with each log entry twice: phase 'start' (after matching) and 'end'.
//
// Local only: binds 127.0.0.1 by default, never contacts the captured site.
import http from 'node:http';
import { loadCatalog, routeTableOf, loadExchangeRecords, openSession, STREAM_KINDS } from './catalog.mjs';
import { parseIncoming, findMatch, textSimilarity } from './match.mjs';
import { substitutionPairs, substituteParts, substituteText, messagePairs } from './template.mjs';
import { createClock, buildHttpPlan, sendHttpPlan, buildWsScript } from './replay.mjs';
import { unitsFromStreamEvents, unitsFromWsFrames, synthesizeUnits } from './synthesize.mjs';
import { acceptUpgrade, OP } from './ws.mjs';
import { reconstructStream } from '../replay/derive.mjs';

export { loadCatalog } from './catalog.mjs';
export { findMatch, parseIncoming, scoreExchange } from './match.mjs';
export { synthesizeUnits, learnDeltas } from './synthesize.mjs';

const MAX_BODY = 16 * 1024 * 1024;
const JSONISH = new Set(['sse', 'ndjson', 'eventsource', 'json', 'chunked', 'ws']);

// [{ method, path, kind, sid, count, ... }] — accepts a session (or path) or a loaded catalog.
export function buildRouteTable(session) {
  const catalog = session?.isMirrorCatalog ? session : loadCatalog(session);
  return routeTableOf(catalog);
}

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let n = 0;
    req.on('data', (d) => { n += d.length; if (n > limit) { reject(Object.assign(new Error('request body too large'), { status: 413 })); req.destroy(); return; } parts.push(d); });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}

function sendJson(res, status, value, extra = []) {
  if (res.headersSent || res.destroyed) return;
  const body = Buffer.from(JSON.stringify(value, null, 2));
  res.writeHead(status, [['content-type', 'application/json; charset=utf-8'], ['cache-control', 'no-store'], ['content-length', String(body.length)], ...extra].flatMap((x) => x));
  res.end(body);
}

function corsHeaders(req, enabled) {
  if (!enabled) return [];
  const origin = req.headers.origin;
  const h = [['access-control-allow-origin', origin || '*'], ['access-control-expose-headers', '*']];
  if (origin) h.push(['access-control-allow-credentials', 'true'], ['vary', 'Origin']);
  return h;
}

export async function startMirror({
  session, port = 0, host = '127.0.0.1', speed = 1, instant = false, synthesize = false, onRequest,
  minScore = 35, fallback = true, cors = true, maxLog = 2000, dialect, cacheBytes = 256 * 1024 * 1024,
} = {}) {
  const sess = openSession(session);
  const catalog = loadCatalog(sess);
  const routeTable = routeTableOf(catalog);
  const deltaDialect = dialect ?? catalog.dialect ?? 'auto';
  const logs = [];
  let seq = 0, closing = false;
  const wsConns = new Set();
  const sockets = new Set();

  // LRU of loaded exchange records (bounded by approximate bytes).
  const cache = new Map();
  let cachedBytes = 0;
  async function recordsOf(ex) {
    if (cache.has(ex.id)) { const v = cache.get(ex.id); cache.delete(ex.id); cache.set(ex.id, v); return v.records; }
    const records = await loadExchangeRecords(catalog, ex);
    const size = records.reduce((a, r) => a + (r.b64?.length ?? 0) + (r.payload?.length ?? 0) + 200, 0);
    cache.set(ex.id, { records, size });
    cachedBytes += size;
    for (const [k, v] of cache) { if (cachedBytes <= cacheBytes || cache.size <= 1) break; cache.delete(k); cachedBytes -= v.size; }
    return records;
  }
  const synthCache = new Map(); // ex.id -> units | null
  async function streamUnits(ex) {
    if (synthCache.has(ex.id)) return synthCache.get(ex.id);
    let units = null;
    try {
      const r = await reconstructStream(sess, ex.sid, { dialect: deltaDialect, limitEvents: 1_000_000 });
      let evs = r.events.filter((e) => e.seq >= ex.seqFrom && e.seq <= ex.seqTo && !e.reassembled);
      // A stream observed both as bytes and as browser-parsed EventSource messages: keep the bytes.
      if (evs.some((e) => e.type === 'sse')) evs = evs.filter((e) => e.type !== 'eventsource');
      units = unitsFromStreamEvents(evs, ex.startT);
    } catch { units = null; }
    synthCache.set(ex.id, units);
    return units;
  }

  const record = (entry) => {
    logs.push(entry);
    if (logs.length > maxLog) logs.splice(0, logs.length - maxLog);
  };
  const notify = (entry, phase) => {
    if (!onRequest) return;
    try { const r = onRequest({ ...entry, phase }); r?.catch?.(() => {}); } catch { /* observer errors never break serving */ }
  };

  async function synthText(inc, ex) {
    if (typeof inc.controls.text === 'string') return inc.controls.text;
    const h = inc.headers['x-mirror-text'];
    if (typeof h === 'string' && h) { try { return decodeURIComponent(h); } catch { return h; } }
    if (typeof synthesize === 'string') return synthesize;
    if (typeof synthesize === 'function') {
      const v = await synthesize({ request: { method: inc.method, path: inc.path, query: inc.query, json: inc.json, text: inc.bodyText }, route: ex.routeKey, sid: ex.sid, kind: ex.routeKind });
      return typeof v === 'string' ? v : undefined;
    }
    return undefined;
  }
  const synthOn = (inc) => !!synthesize || inc.controls.synthesize === '1' || inc.controls.text !== undefined || !!inc.headers['x-mirror-text'];

  // ---- control endpoints --------------------------------------------------------------------
  function control(req, res, inc) {
    const name = inc.path.slice('/__mirror/'.length);
    const extra = corsHeaders(req, cors);
    if (name === 'routes') return sendJson(res, 200, routeTable, extra);
    if (name === 'log') return sendJson(res, 200, logs, extra);
    if (name === 'health') return sendJson(res, 200, { ok: true, session: sess.meta?.id ?? null, exchanges: catalog.exchanges.length, routes: routeTable.length, hosts: catalog.hosts, speed, instant, synthesize: !!synthesize, dialect: deltaDialect }, extra);
    return sendJson(res, 404, { error: 'unknown_control_endpoint', available: ['/__mirror/routes', '/__mirror/log', '/__mirror/health'] }, extra);
  }

  // ---- HTTP ---------------------------------------------------------------------------------
  async function handle(req, res) {
    const started = Date.now();
    const entry = { id: ++seq, at: new Date(started).toISOString(), kind: 'http', method: req.method, url: req.url };
    let body;
    try { body = await readBody(req); } catch (e) { entry.status = e.status ?? 400; entry.error = e.message; record(entry); notify(entry, 'end'); return sendJson(res, entry.status, { error: e.message }); }
    const inc = parseIncoming(req, body);
    if (inc.path.startsWith('/__mirror/')) return control(req, res, inc);
    const extra = corsHeaders(req, cors);
    try {
      const { match, alternatives, reason } = findMatch(catalog, inc, { minScore, fallback });
      if (!match || (inc.method === 'OPTIONS' && match.ex.method !== 'OPTIONS')) {
        if (inc.method === 'OPTIONS' && cors) {
          res.writeHead(204, [...extra, ['access-control-allow-methods', req.headers['access-control-request-method'] || 'GET, POST, PUT, PATCH, DELETE, OPTIONS'], ['access-control-allow-headers', req.headers['access-control-request-headers'] || '*'], ['access-control-max-age', '600']].flatMap((x) => x));
          res.end();
          Object.assign(entry, { status: 204, match: null, mode: 'preflight', ms: Date.now() - started });
          record(entry); notify(entry, 'end');
          return;
        }
        Object.assign(entry, { status: 404, match: null, reason, nearest: alternatives, ms: Date.now() - started });
        record(entry); notify(entry, 'end');
        return sendJson(res, 404, { error: 'no_capture_match', reason, method: inc.method, path: inc.path, nearest: alternatives }, extra);
      }
      const ex = match.ex;
      ex.uses++;
      entry.match = { sid: ex.sid, id: ex.id, route: ex.routeKey, kind: ex.routeKind, how: match.score.how, score: match.score.total, parts: match.score.parts };
      const records = await recordsOf(ex);
      let plan = buildHttpPlan(ex, records, { hosts: catalog.hosts });
      let mode = 'replay';
      if (synthOn(inc) && STREAM_KINDS.has(ex.routeKind)) {
        const units = await streamUnits(ex);
        if (units?.length) {
          const text = await synthText(inc, ex);
          const s = synthesizeUnits(units, text, { dialect: deltaDialect });
          entry.synthesis = { ok: s.ok, reason: s.reason, learned: s.learned, pieces: s.pieces, text: s.text };
          if (s.ok) {
            const lastUnitAt = units[units.length - 1].at;
            const tail = Math.max(0, plan.endAt - lastUnitAt);
            const parts = s.units.map((u) => ({ at: u.at, buf: Buffer.isBuffer(u.raw) ? u.raw : Buffer.from(u.raw ?? '') }));
            plan = { ...plan, parts, endAt: (parts.at(-1)?.at ?? plan.headersAt) + tail, end: plan.end === 'destroy' ? 'destroy' : 'end' };
            mode = 'synthesize';
          }
        } else entry.synthesis = { ok: false, reason: 'framing_not_resynthesizable' };
      }
      const pairs = substitutionPairs(inc, ex);
      if (pairs.length && plan.parts.length) {
        const r = substituteParts(plan.parts.map((p) => p.buf), pairs, { json: JSONISH.has(ex.routeKind) });
        if (r.count) plan = { ...plan, parts: plan.parts.map((p, i) => ({ at: p.at, buf: r.parts[i] })) };
        entry.substitutions = r.count;
        entry.substitutedFields = pairs.map((p) => p.where);
      }
      const mirrorHeaders = [
        ...extra,
        ['x-mirror-sid', ex.sid], ['x-mirror-match', match.score.how], ['x-mirror-score', String(match.score.total)], ['x-mirror-mode', mode],
        ...(plan.notes.excluded ? [['x-mirror-body', `excluded:${plan.notes.excluded}`]] : []),
        ...(plan.notes.bodyDropped ? [['x-mirror-body', 'dropped_by_compaction']] : []),
        ...(plan.notes.truncated ? [['x-mirror-truncated', '1']] : []),
        ...(plan.notes.redactions ? [['x-mirror-redactions', String(plan.notes.redactions)]] : []),
      ];
      Object.assign(entry, { status: plan.status, mode });
      notify(entry, 'start');
      const clock = createClock({ speed, instant });
      const out = await sendHttpPlan(req, res, plan, { clock, extraHeaders: mirrorHeaders, head: inc.method === 'HEAD' });
      Object.assign(entry, { bytes: out.bytes, chunks: out.chunks, aborted: out.aborted || undefined, interrupted: out.interrupted || undefined, ms: Date.now() - started });
    } catch (e) {
      entry.error = String(e?.message ?? e);
      entry.status = entry.status ?? 500;
      if (!res.headersSent) sendJson(res, 500, { error: 'mirror_error', message: entry.error }, extra);
      else res.destroy();
    }
    entry.ms ??= Date.now() - started;
    record(entry);
    notify(entry, 'end');
  }

  // ---- WebSocket ----------------------------------------------------------------------------
  async function upgrade(req, socket, head) {
    const started = Date.now();
    const entry = { id: ++seq, at: new Date(started).toISOString(), kind: 'ws', method: 'GET', url: req.url };
    socket.on('error', () => {});
    const inc = parseIncoming(req);
    const { match, alternatives, reason } = findMatch(catalog, inc, { minScore, fallback });
    if (!match || closing) {
      try { socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); } catch { socket.destroy(); }
      Object.assign(entry, { status: 404, match: null, reason: closing ? 'closing' : reason, nearest: alternatives, ms: Date.now() - started });
      record(entry); notify(entry, 'end');
      return;
    }
    const ex = match.ex;
    ex.uses++;
    entry.match = { sid: ex.sid, id: ex.id, route: ex.routeKey, kind: ex.routeKind, how: match.score.how, score: match.score.total, parts: match.score.parts };
    let script;
    try { script = buildWsScript(ex, await recordsOf(ex)); } catch (e) {
      try { socket.end('HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\n\r\n'); } catch { socket.destroy(); }
      Object.assign(entry, { status: 500, error: String(e?.message ?? e) }); record(entry); notify(entry, 'end');
      return;
    }
    const conn = acceptUpgrade(req, socket, head, {
      selectProtocol: (requested) => (ex.subprotocol && requested.includes(ex.subprotocol) ? ex.subprotocol : null),
      extraHeaders: { 'x-mirror-sid': ex.sid, 'x-mirror-match': match.score.how },
    });
    if (!conn) { Object.assign(entry, { status: 400, error: 'bad_handshake' }); record(entry); notify(entry, 'end'); return; }
    wsConns.add(conn);
    const urlPairs = substitutionPairs(inc, ex);
    const useSynth = synthOn(inc);
    const synthTextP = useSynth ? synthText(inc, ex).catch(() => undefined) : Promise.resolve(undefined);
    Object.assign(entry, { status: 101, mode: useSynth ? 'synthesize' : 'replay', wsMode: script.mode, turnsCaptured: script.turns.length, framesSent: 0, messagesReceived: 0, turnsPlayed: 0, substitutions: 0 });
    notify(entry, 'start');

    const ac = new AbortController();
    const played = new Set();
    let chain = Promise.resolve();

    async function playTurn(turn, pairs) {
      const clock = createClock({ speed, instant });
      let frames = turn.frames;
      if (useSynth) {
        const units = unitsFromWsFrames(frames);
        const s = synthesizeUnits(units, await synthTextP, { dialect: deltaDialect });
        if (s.ok) {
          frames = s.units.map((u) => ({ rel: u.at, opcode: u.opcode ?? 1, text: typeof u.raw === 'string' ? u.raw : null, payload: Buffer.isBuffer(u.raw) ? u.raw : Buffer.from(u.raw ?? '') }));
          (entry.synthesis ??= []).push({ turn: turn.index, ok: true, learned: s.learned, pieces: s.pieces });
        } else if (s.reason !== 'no_text_in_assembled_document' && s.reason !== 'no_delta_carrier') (entry.synthesis ??= []).push({ turn: turn.index, ok: false, reason: s.reason });
      }
      entry.turnsPlayed++;
      for (const f of frames) {
        await clock.until(f.rel, ac.signal);
        if (!conn.open) return;
        if (f.opcode === OP.CLOSE) {
          const code = f.payload?.length >= 2 ? f.payload.readUInt16BE(0) : 1000;
          conn.close(code >= 1000 && code < 5000 && code !== 1005 && code !== 1006 ? code : 1000, f.payload?.length > 2 ? f.payload.subarray(2).toString('utf8') : '');
          return;
        }
        if (f.opcode === OP.PING) { conn.ping(f.payload ?? Buffer.alloc(0)); continue; }
        if (f.opcode === OP.TEXT || (f.opcode !== OP.BINARY && f.text !== null)) {
          let text = f.text ?? f.payload.toString('utf8');
          const r = substituteText(text, pairs, { json: true });
          entry.substitutions += r.count;
          text = r.text;
          conn.send(text, OP.TEXT);
        } else conn.send(f.payload, OP.BINARY);
        entry.framesSent++;
      }
    }
    const enqueue = (turn, pairs) => {
      chain = chain.then(() => playTurn(turn, pairs)).catch(() => {});
      return chain;
    };

    function pickTurn(msgText) {
      const candidates = script.turns.filter((t) => t.index > 0);
      if (msgText !== null) {
        const same = candidates.find((t) => t.repeatable && t.trigger.text === msgText);
        if (same) return same;
      }
      const remaining = candidates.filter((t) => !played.has(t.index) && !t.repeatable);
      if (!remaining.length) return null;
      const withText = remaining.filter((t) => t.trigger?.text !== null && t.trigger?.text !== undefined);
      if (msgText === null || !withText.length) return remaining[0];
      let best = remaining[0], bestScore = -1;
      for (const t of withText.slice(0, 50)) {
        const s = textSimilarity(msgText, t.trigger.text) - (t.index - remaining[0].index) * 0.002;
        if (s > bestScore) { bestScore = s; best = t; }
      }
      return bestScore >= 0.2 ? best : remaining[0];
    }

    conn.on('message', ({ text }) => {
      entry.messagesReceived++;
      if (script.mode !== 'turns') return;
      const turn = pickTurn(text);
      if (!turn) return;
      if (!turn.repeatable) played.add(turn.index);
      const pairs = [...urlPairs, ...(text !== null && turn.trigger?.text ? messagePairs(text, turn.trigger.text) : [])];
      enqueue(turn, pairs);
    });
    conn.on('close', ({ code }) => {
      wsConns.delete(conn);
      ac.abort(new Error('closed'));
      Object.assign(entry, { closeCode: code, ms: Date.now() - started });
      record(entry); notify(entry, 'end');
    });

    if (script.mode === 'timeline') {
      // No client frames were captured: play every server frame on the original timeline.
      enqueue({ index: 0, frames: script.turns.flatMap((t) => t.frames) }, urlPairs);
    } else {
      played.add(0);
      enqueue(script.turns[0], urlPairs);
    }
  }

  // ---- server -------------------------------------------------------------------------------
  const server = http.createServer((req, res) => { handle(req, res).catch(() => { try { res.destroy(); } catch { /* ignore */ } }); });
  server.on('upgrade', (req, socket, head) => {
    if (String(req.headers.upgrade ?? '').toLowerCase() !== 'websocket') { socket.destroy(); return; }
    upgrade(req, socket, head).catch(() => socket.destroy());
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  server.on('clientError', (err, socket) => { try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch { /* ignore */ } });
  await new Promise((resolve, reject) => {
    const onErr = (e) => { server.off('listening', onOk); reject(e); };
    const onOk = () => { server.off('error', onErr); resolve(); };
    server.once('error', onErr);
    server.once('listening', onOk);
    server.listen(port, host);
  });
  const addr = server.address();
  const shownHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host.includes(':') ? `[${host}]` : host;
  const url = `http://${shownHost}:${addr.port}`;

  let closed = null;
  return {
    url, port: addr.port,
    routes: () => routeTable.map((r) => ({ ...r })),
    log: () => logs.map((e) => ({ ...e })),
    catalog,
    close() {
      if (closed) return closed;
      closing = true;
      closed = new Promise((resolve) => {
        for (const c of wsConns) { try { c.close(1001, 'mirror shutting down'); } catch { /* ignore */ } }
        server.close(() => resolve());
        for (const s of sockets) s.destroy();
      });
      return closed;
    },
  };
}
