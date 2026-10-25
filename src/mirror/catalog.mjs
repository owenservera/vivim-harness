// Capture catalog for the local mirror.
//
// One entry ("exchange") per captured HTTP request hop or WebSocket, built synchronously from the
// raw log. Payload-heavy records (chunk/body/ws.frame/dom.batch) are recognised from their line
// prefix and only counted, so building the catalog never decodes the captured bodies; the first
// body chunk of each exchange is kept (head) so the transport can be sniffed from real bytes.
// Bodies are loaded lazily, per exchange, through Session.streamRecords (stream locator + seek).
import { openSync, readSync, closeSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { Session } from '../store/session.mjs';
import { sniff, classifyMime } from '../decode/decoders.mjs';

const SEG_RE = /^\d{6}\.jsonl$/;
const HEAVY = new Set(['chunk', 'body', 'ws.frame', 'dom.batch']);
const HEAD_BYTES = 1024;

export const STREAM_KINDS = new Set(['sse', 'ndjson', 'eventsource', 'chunked']);

// ---------------------------------------------------------------------------------------------
// Session resolution: a Session instance, a session directory, or { dir }.
// ---------------------------------------------------------------------------------------------
export function openSession(session) {
  if (!session) throw new Error('mirror: a session is required');
  if (typeof session === 'string') {
    const dir = path.resolve(session);
    if (!existsSync(path.join(dir, 'raw')) && !existsSync(path.join(dir, 'session.json'))) throw new Error(`mirror: no capture session at ${dir}`);
    return new Session(dir);
  }
  if (typeof session.records === 'function' && typeof session.dir === 'string') return session;
  if (typeof session.dir === 'string') return new Session(session.dir);
  throw new Error('mirror: unsupported session value (expected Session, directory path or { dir })');
}

export function rawDirOf(session) {
  return session.rawDir ?? path.join(session.dir, 'raw');
}

// ---------------------------------------------------------------------------------------------
// Synchronous raw line reader (segments in order, big lines carried across reads).
// Yielded buffers are only valid until the next iteration step.
// ---------------------------------------------------------------------------------------------
function* rawLines(rawDir) {
  if (!existsSync(rawDir)) return;
  const files = readdirSync(rawDir).filter((f) => SEG_RE.test(f)).sort();
  const buf = Buffer.allocUnsafe(1 << 22);
  for (const f of files) {
    const fd = openSync(path.join(rawDir, f), 'r');
    try {
      let pos = 0, carry = null;
      for (;;) {
        const n = readSync(fd, buf, 0, buf.length, pos);
        if (n <= 0) break;
        pos += n;
        let chunk = buf.subarray(0, n);
        if (carry) { chunk = Buffer.concat([carry, chunk]); carry = null; }
        let start = 0, nl;
        while ((nl = chunk.indexOf(0x0a, start)) !== -1) {
          if (nl > start) yield chunk.subarray(start, nl);
          start = nl + 1;
        }
        if (start < chunk.length) carry = Buffer.from(chunk.subarray(start));
      }
      if (carry?.length) yield carry; // torn trailing line: the parse below rejects it
    } finally { closeSync(fd); }
  }
}

const num = (re, s) => { const m = re.exec(s); return m ? Number(m[1]) : undefined; };
const str = (re, s) => re.exec(s)?.[1];

// ---------------------------------------------------------------------------------------------
// Path helpers shared with the matcher and the route table.
// ---------------------------------------------------------------------------------------------
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isIdLike(seg) {
  const s = String(seg ?? '');
  if (!s) return false;
  return UUID.test(s) || /^\d+$/.test(s) || /^[0-9a-f]{8,}$/i.test(s)
    || (/^[A-Za-z0-9_-]{16,}$/.test(s) && /\d/.test(s) && /[A-Za-z]/.test(s));
}
export function splitPath(p) { return String(p ?? '/').split('/').filter(Boolean); }
export function templatePath(p) {
  return '/' + splitPath(p).map((s) => (isIdLike(s) ? '{id}' : s)).join('/');
}

function parseUrl(url) {
  try {
    const u = new URL(url);
    return { host: u.host, protocol: u.protocol, path: u.pathname || '/', query: [...u.searchParams.entries()] };
  } catch {
    const s = String(url ?? '');
    const q = s.indexOf('?');
    return { host: '', protocol: '', path: (q < 0 ? s : s.slice(0, q)) || '/', query: q < 0 ? [] : [...new URLSearchParams(s.slice(q + 1)).entries()] };
  }
}

// ---------------------------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------------------------
export function loadCatalog(sessionLike) {
  const session = openSession(sessionLike);
  const rawDir = rawDirOf(session);
  const exchanges = [];
  const current = new Map();      // sid -> latest exchange (redirect hops start a new one)
  const hops = new Map();         // sid -> hop count
  let runStartT = null, records = 0, corrupt = 0;

  const open = (sid, init) => {
    const hop = hops.get(sid) ?? 0;
    hops.set(sid, hop + 1);
    const ex = {
      id: hop ? `${sid}#${hop}` : sid, sid, hop, kind: 'http', method: 'GET', url: '', host: '', path: '/', query: [],
      reqHeaders: null, postData: undefined, hasPostData: false, startT: null, seqFrom: null, seqTo: null,
      status: undefined, mime: undefined, resHeaders: null, resT: null, chunks: 0, bytes: 0, head: null,
      esMessages: 0, framesIn: 0, framesOut: 0, framesMetaOnly: 0, endT: null, outcome: 'open',
      bodyExcluded: null, truncated: false, retrospective: false, redirect: false, redirectedTo: null,
      redactions: 0, uses: 0, order: exchanges.length, ...init,
    };
    exchanges.push(ex);
    current.set(sid, ex);
    return ex;
  };

  for (const line of rawLines(rawDir)) {
    const head = line.subarray(0, 320).toString('utf8');
    const k = str(/"k":"([^"]+)"/, head);
    if (!k) { corrupt++; continue; }
    records++;
    if (HEAVY.has(k)) {
      if (k === 'dom.batch') continue;
      const sid = str(/"sid":"((?:[^"\\]|\\.)*)"/, head);
      const ex = sid !== undefined ? current.get(sid) : undefined;
      if (!ex) continue;
      const seq = num(/"seq":(\d+)/, head), t = num(/"t":(\d+)/, head);
      let seqTo = num(/"seqTo":(\d+)/, line.subarray(0, 512).toString('utf8'));
      if (seqTo === undefined && line.length < 4096) seqTo = num(/"seqTo":(\d+)/, line.toString('utf8'));
      if (seqTo === undefined && line.length >= 4096) {
        // A large body line can carry seqTo past any scanned prefix; parse only as a fallback.
        try { const full = JSON.parse(line.toString('utf8')); if (Number.isFinite(Number(full?.seqTo))) seqTo = Number(full.seqTo); } catch { /* non-JSON line: keep the prefix result */ }
      }
      if (seqTo === undefined) seqTo = seq;
      if (seq !== undefined) ex.seqTo = Math.max(ex.seqTo ?? 0, seqTo ?? seq);
      if (t !== undefined) ex.lastT = t;
      if (k === 'ws.frame') {
        const dir = str(/"dir":"(in|out)"/, head);
        if (dir === 'out') ex.framesOut++; else ex.framesIn++;
        continue;
      }
      ex.chunks++;
      if (k === 'body') ex.retrospective = true;
      const n = num(/"n":(\d+)/, head);
      if (n !== undefined) ex.bytes += n;
      if (!ex.head) {
        try {
          const r = JSON.parse(line.toString('utf8'));
          if (typeof r.b64 === 'string') ex.head = Buffer.from(r.b64, 'base64').subarray(0, HEAD_BYTES);
          if (r.redactions?.length) ex.redactions += r.redactions.length;
        } catch { /* torn line */ }
      } else if (/"redactions":\[/.test(head)) ex.redactions++;
      continue;
    }
    let r;
    try { r = JSON.parse(line.toString('utf8')); } catch { corrupt++; continue; }
    if (r.k === 'run.start') { runStartT ??= r.t; continue; }
    if (!r.sid) continue;
    let ex = current.get(r.sid);
    switch (r.k) {
      case 'req': {
        const u = parseUrl(r.url);
        ex = open(r.sid, {
          method: String(r.method ?? 'GET').toUpperCase(), url: r.url ?? '', host: u.host, path: u.path, query: u.query,
          reqHeaders: r.headers ?? null, postData: typeof r.postData === 'string' ? r.postData : undefined,
          hasPostData: !!r.hasPostData || typeof r.postData === 'string', startT: r.t, seqFrom: r.seq, seqTo: r.seq,
          resourceType: r.type, policy: r.policy,
        });
        continue;
      }
      case 'ws.open': {
        const u = parseUrl(r.url);
        ex = open(r.sid, { kind: 'ws', method: 'GET', url: r.url ?? '', host: u.host, path: u.path, query: u.query, startT: r.t, seqFrom: r.seq, seqTo: r.seq, policy: r.policy });
        if (r.policy && String(r.policy).startsWith('metadata_only')) ex.bodyExcluded = r.policy.slice('metadata_only:'.length) || 'metadata_only';
        continue;
      }
      default: break;
    }
    if (!ex) continue;
    ex.seqTo = Math.max(ex.seqTo ?? 0, r.seqTo ?? r.seq ?? 0);
    ex.lastT = r.t;
    switch (r.k) {
      case 'res':
        ex.status = r.status; ex.mime = r.mime; ex.resHeaders = r.headers ?? null; ex.resT = r.t; ex.protocol = r.protocol;
        if (r.redirect) ex.redirect = true;
        break;
      case 'body.excluded': ex.bodyExcluded = r.reason ?? 'excluded'; break;
      case 'body.truncated': ex.truncated = true; break;
      case 'body.unavailable': ex.bodyUnavailable = r.error ?? true; break;
      case 'es.msg': ex.esMessages++; break;
      case 'done': ex.endT = r.t; ex.outcome = 'complete'; if (r.redirectedTo) ex.redirectedTo = r.redirectedTo; break;
      case 'fail': ex.endT = r.t; ex.outcome = r.canceled ? 'canceled' : 'failed'; ex.error = r.errorText; break;
      case 'ws.handshake_request': ex.reqHeaders = r.headers ?? null; if (r.requestedProtocols) ex.requestedProtocols = r.requestedProtocols; break;
      case 'ws.handshake': {
        ex.status = r.status; ex.resHeaders = r.headers ?? null;
        const sp = r.headers?.['sec-websocket-protocol'] ?? r.headers?.['Sec-WebSocket-Protocol'];
        if (sp && sp !== '[redacted]') ex.subprotocol = String(sp).split(',')[0].trim();
        break;
      }
      case 'ws.frame_meta': ex.framesMetaOnly++; if (r.dir === 'out') ex.framesOut++; else ex.framesIn++; break;
      case 'ws.close': ex.endT = r.t; ex.outcome = 'closed'; break;
      default: break;
    }
  }

  for (const ex of exchanges) {
    ex.routeKind = routeKindOf(ex);
    ex.template = templatePath(ex.path);
    ex.routeKey = `${ex.kind === 'ws' ? 'WS' : ex.method} ${ex.template}`;
    if (ex.outcome === 'open') ex.outcome = 'incomplete_at_stop';
  }
  let profile = null;
  try { profile = session.kv?.get('PROFILE_SNAPSHOT') ?? null; } catch { profile = null; }
  return {
    isMirrorCatalog: true, session, rawDir, exchanges,
    hosts: [...new Set(exchanges.map((e) => e.host).filter(Boolean))],
    runStartT, records, corrupt, profile,
    dialect: profile?.decode?.delta ?? 'auto',
  };
}

export function routeKindOf(ex) {
  if (ex.kind === 'ws') return 'ws';
  const declared = classifyMime(ex.mime);
  if (ex.esMessages > 0 && !ex.chunks) return 'eventsource';
  const d = ex.head?.length ? sniff(ex.mime, ex.head) : declared;
  if (d === 'sse' || declared === 'sse') return 'sse';
  if (d === 'ndjson' || d === 'jsonseq') return 'ndjson';
  if (d === 'chunked-json' || d === 'length-prefixed' || d === 'grpc') return 'chunked';
  if (ex.chunks > 1 && !ex.retrospective) return 'chunked';
  if (d === 'json' || declared === 'json') return 'json';
  if (d === 'html' || declared === 'html') return 'html';
  if (d === 'text' || declared === 'text') return 'text';
  return ex.chunks ? 'binary' : 'http';
}

// Raw records of one exchange (hop-exact), in seq order.
export async function loadExchangeRecords(catalog, ex) {
  const out = [];
  const session = catalog.session;
  const opts = { fromSeq: Math.max(0, (ex.seqFrom ?? 1) - 1), toSeq: ex.seqTo ?? Infinity };
  const iter = typeof session.streamRecords === 'function' ? session.streamRecords(ex.sid, opts) : session.records(opts);
  for await (const r of iter) {
    if (r.sid !== ex.sid) continue;
    if (r.seq < ex.seqFrom) continue;
    if (r.seq > ex.seqTo) break;
    out.push(r);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Route table: one row per METHOD + templated path.
// ---------------------------------------------------------------------------------------------
const KIND_RANK = { sse: 9, eventsource: 8, ndjson: 7, ws: 7, chunked: 6, json: 5, html: 4, text: 3, binary: 2, http: 1 };
export function routeTableOf(catalog) {
  const groups = new Map();
  for (const ex of catalog.exchanges) {
    let g = groups.get(ex.routeKey);
    if (!g) { g = { method: ex.kind === 'ws' ? 'WS' : ex.method, path: ex.template, kinds: {}, list: [], hosts: new Set(), statuses: new Set() }; groups.set(ex.routeKey, g); }
    g.list.push(ex);
    g.kinds[ex.routeKind] = (g.kinds[ex.routeKind] ?? 0) + 1;
    if (ex.host) g.hosts.add(ex.host);
    if (ex.status !== undefined) g.statuses.add(ex.status);
  }
  const rows = [];
  for (const g of groups.values()) {
    const kind = Object.keys(g.kinds).sort((a, b) => (KIND_RANK[b] ?? 0) - (KIND_RANK[a] ?? 0) || g.kinds[b] - g.kinds[a])[0];
    const withBody = g.list.filter((e) => e.bytes > 0 || e.framesIn > 0 || e.esMessages > 0);
    const rep = (withBody.length ? withBody : g.list).at(-1);
    rows.push({
      method: g.method, path: g.path, kind, sid: rep.sid, count: g.list.length,
      hosts: [...g.hosts], statuses: [...g.statuses], withBody: withBody.length,
      streaming: STREAM_KINDS.has(kind) || kind === 'ws',
    });
  }
  return rows.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.method < b.method ? -1 : a.method > b.method ? 1 : 0));
}
