// Optional, independently authored capabilities. Only load a backend when requested.
import { randomUUID } from 'node:crypto';
import { EventFeed } from './event-feed.mjs';
import { integer, page, problem, storageName, text } from './http.mjs';

export const LIVE_EVENTS = ['record', 'stream-open', 'event', 'text', 'stream-close', 'stream-update', 'lag', 'warn', 'close', 'target'];
const str = { type: 'string' };
const bool = { type: 'boolean' };
const pagination = { offset: { type: 'integer', minimum: 0, maximum: 1000000 }, limit: { type: 'integer', minimum: 1, maximum: 1000 } };
const schema = (properties, required = []) => ({ type: 'object', properties, required });
const modules = {
  derive: new URL('../replay/derive-all.mjs', import.meta.url),
  mirror: new URL('../mirror/index.mjs', import.meta.url),
  live: new URL('../capture/live-tap.mjs', import.meta.url),
};
// Route tables are a pure function of a saved session's files; cache per session dir so repeated
// reads and tool calls do not rescan every record.
const routeTableCache = new Map();

async function capability(name, exports) {
  let module;
  try { module = await import(modules[name].href); }
  catch (e) {
    if (['ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND', 'ENOENT'].includes(e.code)) {
      throw problem(501, `${name} capability is not installed yet`, 'CAPABILITY_UNAVAILABLE');
    }
    throw e;
  }
  if (exports.some((key) => typeof module[key] !== 'function')) {
    throw problem(501, `${name} capability does not provide the required exports yet`, 'CAPABILITY_UNAVAILABLE');
  }
  return module;
}

function boolean(value, name, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw problem(400, `${name} must be boolean`);
  return value;
}

// No unbounded queue for a slow/disconnected progress consumer. Derivation itself finishes
// on disconnect, retaining its per-session lock until writes really finish.
function progressStream(res) {
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no', 'x-content-type-options': 'nosniff' });
  const write = (frame) => {
    if (res.destroyed || res.writableEnded) return;
    if (res.writableLength + Buffer.byteLength(frame) > 512 * 1024) { res.destroy(); return; }
    res.write(frame);
  };
  const timer = setInterval(() => write(`: heartbeat ${Date.now()}\n\n`), 15000);
  timer.unref?.();
  res.once('close', () => clearInterval(timer));
  res.once('error', () => clearInterval(timer));
  return {
    send: (type, data) => write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`),
    close() { clearInterval(timer); if (!res.destroyed && !res.writableEnded) res.end(); },
  };
}

export function registerCapabilities({ add, recorder, profileStore, sessionOf, savedOnly, profileFor, selectedSessions, publish, deriving, invalidateReplay }) {
  const mirrors = new Map(), liveFeed = new EventFeed({ eventTypes: LIVE_EVENTS });
  const progress = new Set();
  let pendingMirrors = 0, tapPromise = null, tap = null, closed = false;
  const tapListeners = [];
  const active = () => { if (closed) throw problem(503, 'Integration hub is closing'); };

  async function ensureTap() {
    active();
    if (!tapPromise) {
      tapPromise = (async () => {
        const { createLiveTap } = await capability('live', ['createLiveTap']);
        active();
        const candidate = await createLiveTap(recorder, { decode: true });
        if (!candidate || typeof candidate.on !== 'function' || typeof candidate.off !== 'function') {
          candidate?.close?.();
          throw problem(501, 'Live tap event interface is unavailable', 'CAPABILITY_UNAVAILABLE');
        }
        if (closed) { candidate.close?.(); throw problem(503, 'Integration hub is closing'); }
        tap = candidate;
        for (const type of LIVE_EVENTS) {
          const listener = (data) => liveFeed.publish(type, data, recorder.session?.id ?? null);
          tap.on(type, listener); tapListeners.push([type, listener]);
        }
        return tap;
      })().catch((e) => { tapPromise = null; throw e; });
    }
    return tapPromise;
  }

  add('POST', '/sessions/{session}/derive-all', 'Derive all artifacts; SSE stage, complete and error events (disconnect does not cancel)', async ({ p, body, res }) => {
    const s = sessionOf(p.session); savedOnly(s); active();
    const incremental = boolean(body.incremental, 'incremental', true);
    const stages = body.stages;
    if (stages !== undefined && (!Array.isArray(stages) || !stages.length || stages.length > 64 || stages.some((stage) => typeof stage !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/i.test(stage)))) {
      throw problem(400, 'stages must be a nonempty array of stage names');
    }
    const profile = body.profile === undefined ? profileFor(s) : profileStore.load(storageName(body.profile, 'profile'));
    const { deriveAll } = await capability('derive', ['deriveAll']);
    active(); savedOnly(s);
    if (deriving.has(s.id)) throw problem(409, 'Session derivation is already running', 'DERIVATION_BUSY');
    deriving.add(s.id);
    let stream;
    try {
      invalidateReplay(s.id);
      if (res) { stream = progressStream(res); progress.add(stream); stream.send('start', { session: s.id }); }
      const result = await deriveAll(s, { profile, incremental, stages, onStage: (stage, detail) => stream?.send('stage', { session: s.id, ...(typeof stage === 'object' && stage !== null ? stage : { stage, detail }) }) });
      publish('session.derived', { id: s.id, manifest: result.manifest }, s.id);
      const data = { session: s.id, ...result };
      stream?.send('complete', data);
      return data;
    } catch (e) {
      if (!stream) throw e;
      stream.send('error', { session: s.id, error: e.message, code: e.code ?? 'DERIVATION_FAILED' });
    } finally { stream?.close(); progress.delete(stream); deriving.delete(s.id); }
  }, { body: schema({ profile: str, incremental: { ...bool, default: true }, stages: { type: 'array', minItems: 1, maxItems: 64, items: str } }), tool: 'derive_all', contentType: 'text/event-stream' });

  async function artifactsFor(id) {
    const s = sessionOf(id); savedOnly(s);
    if (deriving.has(s.id)) throw problem(409, 'Wait for session derivation to finish', 'DERIVATION_BUSY');
    const { loadArtifacts } = await capability('derive', ['loadArtifacts']);
    return { s, loaded: await loadArtifacts(s) };
  }
  add('GET', '/sessions/{session}/artifacts', 'Read the saved derivation manifest and artifacts without rebuilding', async ({ p }) => {
    const { s, loaded } = await artifactsFor(p.session);
    return { session: s.id, ...(loaded?.artifacts !== undefined ? loaded : { artifacts: loaded }) };
  }, { tool: 'get_artifacts' });
  for (const [route, keys, tool] of [
    ['schemas', ['schemas'], 'get_schemas'],
    ['graph/ranked', ['rankedGraph', 'graphRanked', 'ranked', 'graph'], 'get_ranked_graph'],
    ['timelines', ['timelines'], 'get_timelines'],
  ]) {
    add('GET', `/sessions/{session}/${route}`, `Read saved ${route} artifacts`, async ({ p }) => {
      const { s, loaded } = await artifactsFor(p.session);
      const artifacts = loaded?.artifacts ?? loaded;
      const key = keys.find((key) => artifacts?.[key] !== undefined && artifacts[key] !== null);
      if (!key) throw problem(409, `No saved ${route} artifact; derive the corresponding stage first`, 'ARTIFACT_UNAVAILABLE');
      return { session: s.id, manifest: loaded?.manifest ?? null, [route === 'graph/ranked' ? 'graph' : route]: artifacts[key] };
    }, { tool });
  }

  add('GET', '/search', 'Search all selected sessions and merge hits by descending relevance score', async ({ q }) => {
    const query = text(q.q, 'q', 1000).trim(), limit = integer(q.limit, 100, 1000, 1);
    const cap = integer(q.sessions, 20, 100, 1);
    const mode = q.layer ?? 'all';
    if (!['all', 'evidence', 'entities'].includes(mode)) throw problem(400, 'layer must be all, evidence or entities');
    const { searchSession } = await capability('derive', ['searchSession']);
    const all = q.session ? [sessionOf(q.session).meta] : selectedSessions({ site: q.site, origin: q.origin });
    const selected = all.slice(0, cap), hits = [], failures = [];
    let backendHasMore = false;
    for (const meta of selected) {
      try {
        const s = sessionOf(meta.id); savedOnly(s);
        if (deriving.has(s.id)) throw problem(409, 'Session derivation is running', 'DERIVATION_BUSY');
        const result = await searchSession(s, query, { limit: limit + 1 });
        const items = Array.isArray(result) ? result : result?.items ?? result?.hits ?? result?.results;
        if (!Array.isArray(items)) throw new Error('Invalid searchSession result');
        backendHasMore ||= !!result?.hasMore || items.length > limit || Number(result?.total ?? result?.totalHits ?? 0) > items.length;
        for (const hit of items) {
          const entity = ['knowledge', 'entities', 'entity'].includes(hit.layer ?? hit.kind) || !!hit.eid;
          if (mode === 'entities' && !entity || mode === 'evidence' && entity) continue;
          hits.push({ ...hit, session: s.id, score: Number.isFinite(hit.score) ? hit.score : 0 });
        }
      } catch (e) {
        if (e.status === 501) throw e;
        failures.push({ session: meta.id, code: e.code ?? 'SEARCH_FAILED' });
      }
    }
    // Do not early-exit on hit count: later sessions may contain the strongest matches.
    hits.sort((a, b) => b.score - a.score || a.session.localeCompare(b.session));
    const hasMore = backendHasMore || hits.length > limit;
    return { query, items: hits.slice(0, limit), limit, hasMore, sessionsScanned: selected.length, sessionsSelected: selected.length, sessionsAvailable: all.length, sessionsNotScanned: all.length - selected.length, failures, complete: !hasMore && selected.length === all.length && !failures.length, ranking: 'descending backend score; session ID breaks ties', ...(mode !== 'all' ? { note: 'Layer filter is applied to each session’s bounded ranked candidates, not its entire corpus.' } : {}) };
  }, { query: { q: str, session: str, site: str, origin: str, sessions: { type: 'integer', minimum: 1, maximum: 100 }, limit: pagination.limit, layer: { type: 'string', enum: ['all', 'evidence', 'entities'] }, required: ['q'] }, tool: 'search_captures' });

  const mirrorInfo = ({ id, session, createdAt, instance }) => ({ id, session, createdAt, url: instance.url, port: instance.port });
  const mirrorOf = (id) => {
    text(id, 'mirror id', 128);
    const mirror = mirrors.get(id);
    if (!mirror) throw problem(404, 'Mirror not found', 'NOT_FOUND');
    return mirror;
  };
  add('POST', '/mirrors', 'Start a process-local loopback replay mirror of a saved session', async ({ body }) => {
    active();
    const s = sessionOf(text(body.session, 'session', 128)); savedOnly(s);
    if (deriving.has(s.id)) throw problem(409, 'Wait for session derivation to finish', 'DERIVATION_BUSY');
    const host = body.host ?? '127.0.0.1';
    if (!['127.0.0.1', '::1'].includes(host)) throw problem(400, 'Mirror host must be a literal loopback address');
    const port = integer(body.port, 0, 65535);
    const speed = body.speed ?? 1;
    if (typeof speed !== 'number' || !Number.isFinite(speed) || speed <= 0 || speed > 1000) throw problem(400, 'speed must be a number greater than zero and at most 1000');
    const instant = boolean(body.instant, 'instant', false), synthesize = boolean(body.synthesize, 'synthesize', false);
    const { startMirror } = await capability('mirror', ['startMirror']);
    active(); savedOnly(s);
    if (deriving.has(s.id)) throw problem(409, 'Wait for session derivation to finish', 'DERIVATION_BUSY');
    if (mirrors.size + pendingMirrors >= 8) throw problem(429, 'At most eight mirrors may be running or starting');
    pendingMirrors++;
    try {
      const instance = await startMirror({ session: s, host, port, speed, instant, synthesize });
      if (closed) { await instance.close(); throw problem(503, 'Integration hub is closing'); }
      const mirror = { id: randomUUID(), session: s.id, createdAt: new Date().toISOString(), instance };
      mirrors.set(mirror.id, mirror);
      return mirrorInfo(mirror);
    } finally { pendingMirrors--; }
  }, { body: schema({ session: str, port: { type: 'integer', minimum: 0, maximum: 65535, default: 0 }, host: { type: 'string', enum: ['127.0.0.1', '::1'], default: '127.0.0.1' }, speed: { type: 'number', exclusiveMinimum: 0, maximum: 1000, default: 1 }, instant: bool, synthesize: bool }, ['session']), tool: 'start_mirror' });
  add('GET', '/mirrors', 'List process-local replay mirrors', async () => {
    await capability('mirror', ['startMirror']);
    return { items: [...mirrors.values()].map(mirrorInfo), starting: pendingMirrors };
  }, { tool: 'list_mirrors' });
  async function removeMirror(id) {
    await capability('mirror', ['startMirror']);
    const mirror = mirrorOf(id);
    await mirror.instance.close();
    mirrors.delete(mirror.id);
    return { stopped: mirror.id, session: mirror.session };
  }
  add('DELETE', '/mirrors', 'Stop one mirror selected by its id query parameter', ({ q }) => removeMirror(q.id), { query: { id: str, required: ['id'] }, tool: 'stop_mirror_by_id' });
  add('DELETE', '/mirrors/{id}', 'Stop one running replay mirror', ({ p }) => removeMirror(p.id), { tool: 'stop_mirror' });
  add('GET', '/mirrors/{id}', 'Read one running mirror', async ({ p }) => {
    await capability('mirror', ['startMirror']); return mirrorInfo(mirrorOf(p.id));
  }, { tool: 'get_mirror' });
  add('GET', '/mirrors/{id}/routes', 'Read a running mirror route table', async ({ p }) => {
    await capability('mirror', ['startMirror']);
    const mirror = mirrorOf(p.id);
    return { id: mirror.id, session: mirror.session, routes: await mirror.instance.routes() };
  }, { tool: 'mirror_routes' });
  const requestLog = async ({ p, q }) => {
    await capability('mirror', ['startMirror']);
    const mirror = mirrorOf(p.id), log = await mirror.instance.log();
    const items = Array.isArray(log) ? log : log?.items ?? log?.requests ?? [];
    return { id: mirror.id, session: mirror.session, ...page(items, q) };
  };
  add('GET', '/mirrors/{id}/log', 'Page the mirror request log', requestLog, { query: pagination, tool: 'mirror_request_log' });
  add('GET', '/mirrors/{id}/requests', 'Page the mirror request log (alias of /log)', requestLog, { query: pagination, tool: 'mirror_requests' });
  add('GET', '/sessions/{session}/mirror/routes', 'Build a saved-session route table without starting a mirror', async ({ p }) => {
    const s = sessionOf(p.session); savedOnly(s);
    const { buildRouteTable } = await capability('mirror', ['buildRouteTable']);
    const key = s.dir ?? s.id;
    let pending = routeTableCache.get(key);
    if (!pending) {
      pending = (async () => { await new Promise((r) => setImmediate(r)); return buildRouteTable(s); })();
      routeTableCache.set(key, pending);
      pending.catch(() => { if (routeTableCache.get(key) === pending) routeTableCache.delete(key); });
    }
    return { session: s.id, routes: await pending };
  }, { tool: 'session_mirror_routes' });

  add('GET', '/live', 'Resumable live-tap SSE: record, stream-open, event, text, stream-close and target', async ({ req, res, q }) => {
    await ensureTap();
    return liveFeed.subscribe(req, res, q, { status: recorder.status() });
  }, { query: { sid: str, kind: { ...str, description: 'Comma-separated record/transport kinds or event names' }, types: { ...str, description: 'Comma-separated live event names' }, session: str, after: str, replay: { type: 'integer', minimum: 0, maximum: 1000 } }, tool: 'live_capture_feed', contentType: 'text/event-stream' });

  return {
    liveFeed,
    close() {
      if (closed) return;
      closed = true;
      for (const [type, listener] of tapListeners) tap?.off(type, listener);
      tapListeners.length = 0;
      tap?.close?.();
      liveFeed.close();
      for (const stream of progress) stream.close();
      progress.clear();
      const closing = [...mirrors.values()].map(async (mirror) => {
        try { await mirror.instance.close(); mirrors.delete(mirror.id); }
        catch (e) { publish('warn', { message: `Mirror ${mirror.id} shutdown failed: ${e.message}` }, mirror.session); }
      });
      return Promise.all(closing);
    },
  };
}
