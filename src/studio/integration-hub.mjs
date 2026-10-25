// Versioned integration surface. Reuses the storage/replay/intelligence APIs; no second truth store.
import { readdirSync, existsSync, statSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Session, listSessions } from '../store/session.mjs';
import { stateAt } from '../replay/derive.mjs';
import { observeSession } from '../shapes/observation.mjs';
import { readAcceptance } from '../capture/acceptance.mjs';
import { StreamReducer } from '../replay/reducer.mjs';
import { TemporalGraph } from '../intel/graph.mjs';
import { ScopedLearner, SCOPES, ROLES, activeQuestions } from '../intel/learn.mjs';
import { buildSiteContinuity, siteFromSession, originFromSession } from '../intel/continuity.mjs';
import { transcriptFromSession, transcriptFromLivePage, probesFromLivePage } from './adapter-probes.mjs';
import { getReadAdapter, listReadAdapters } from '../profiles/sites/index.mjs';
import { AdapterFactoryError } from './adapter-factory-service.mjs';
import { validateExpectedVersion } from '../store/versioned.mjs';
import { VERSION } from '../config.mjs';
import { EventFeed, EVENT_TYPES } from './event-feed.mjs';
import { Webhooks } from './webhooks.mjs';
import { registerCapabilities, LIVE_EVENTS } from './capabilities.mjs';
import { problem, json, integer, text, object, storageName, timestamp, page, datasetPage, storeProblem, storeFields } from './http.mjs';
import { registerConversationTools } from './conversation-tools.mjs';
import { registerHarnessTools } from './harness-api.mjs';

const str = { type: 'string' };
const pagination = { offset: { type: 'integer', minimum: 0, maximum: 1000000 }, limit: { type: 'integer', minimum: 1, maximum: 1000 } };
const timeQuery = { at: { description: 'Epoch milliseconds or ISO timestamp', type: ['string', 'number'] } };
const sessionQuery = { ...pagination, site: str, origin: str, status: str, profile: str, q: str };
const objectSchema = (properties = {}, required = []) => ({ type: 'object', properties, ...(required.length ? { required } : {}) });

export function createIntegrationHub({ paths, profileStore, learner, recorder, conversationRuntime, harnessApi, deriveSession, previewRecord, previewEvent, getPort, getAccessMode = () => 'local', cdpPort, deriving = new Set(), invalidateReplay = () => {}, adapterFactory = null, learningPipeline = null }) {
  const feed = new EventFeed();
  const webhooks = new Webhooks(feed, { forbiddenPorts: () => [getPort(), cdpPort] });
  const routes = [];
  const listeners = [];
  const on = (event, fn) => { recorder.on(event, fn); listeners.push([event, fn]); };
  const publish = (type, data, session = recorder.session?.id ?? null) => feed.publish(type, data, session);
  on('status', (s) => publish('status', s));
  on('started', (s) => publish('started', { id: s.id, target: recorder.session?.meta.target, profile: s.profile }, s.id));
  on('stopped', (s) => publish('stopped', { id: s.id, reason: s.reason, verify: s.verify }, s.id));
  on('warn', (e) => publish('warn', { message: String(e.message ?? e) }));
  on('record', (r) => publish('record', previewRecord(r)));
  on('event', (e) => publish('event', previewEvent(e)));

  const sessionOf = (id = 'latest') => {
    storageName(id, 'session');
    try { return Session.open(paths.sessions, id); }
    catch (e) {
      if (/matches \d+ sessions/.test(e.message)) throw problem(409, e.message, 'AMBIGUOUS_SESSION');
      if (/No session|No sessions/.test(e.message)) throw problem(404, e.message, 'NOT_FOUND');
      throw e;
    }
  };
  const savedOnly = (s) => {
    if (conversationRuntime?.isSessionActive(s.id)) throw problem(409, 'Finish conversation capture before replaying or rebuilding this session', 'SESSION_ACTIVE');
    if (['recording', 'stopping'].includes(recorder.state) && recorder.session?.id === s.id) throw problem(409, 'Stop capture before replaying or rebuilding this session', 'SESSION_ACTIVE');
  };
  const knowledge = (s) => {
    const outcome = s.kv.get('KNOWLEDGE_STATUS', null);
    const model = s.kv.get('MODEL', null);
    if (outcome && outcome.status !== 'complete') throw problem(409, `Knowledge is ${outcome.status}; stale derived outputs are unavailable`, 'KNOWLEDGE_UNAVAILABLE');
    if (!model || model.error) throw problem(409, 'Session has no successful derived knowledge; derive first', 'KNOWLEDGE_UNAVAILABLE');
    return { outcome: outcome ?? { status: 'legacy-unverified' }, model };
  };
  const graphOf = (s, at) => {
    const { outcome } = knowledge(s);
    const stored = s.kv.get('GRAPH', null);
    if (!stored) throw problem(409, 'No saved graph; derive first', 'KNOWLEDGE_UNAVAILABLE');
    if (at === null) return { ...stored, outcome, asOf: null };
    const graph = new TemporalGraph();
    graph.nodes = new Map((stored.nodes ?? []).map((n) => [n.eid, n]));
    graph.edges = new Map((stored.edges ?? []).map((e) => [e.id, e]));
    const state = graph.stateAt(at);
    const types = new Map((stored.nodes ?? []).map((n) => [n.eid, n.type]));
    return { ...state, edges: state.edges.map((e) => ({ ...e, statusHistory: (e.statusHistory ?? []).filter((h) => Number.isFinite(h.t) && h.t <= at) })), nodes: state.nodes.map((n) => ({ ...n, type: types.get(n.eid) })), types: stored.types, outcome, asOf: at };
  };
  const datasetsOf = (s) => {
    const dir = path.join(s.dir, 'datasets');
    return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => ({ name: f.slice(0, -6), bytes: statSync(path.join(dir, f)).size })) : [];
  };
  const selectedSessions = (q) => listSessions(paths.sessions).filter((s) => (!q.site || siteFromSession(s) === q.site)
    && (!q.origin || originFromSession(s) === q.origin) && (!q.status || s.status === q.status)
    && (!q.profile || s.profile?.name === q.profile)
    && (!q.q || [s.id, s.site, s.target?.title, s.target?.url].some((v) => String(v ?? '').toLowerCase().includes(String(q.q).toLowerCase()))));
  const profileFor = (s) => s.kv.get('PROFILE_SNAPSHOT') ?? profileStore.load(s.meta.profile?.name ?? 'generic');

  // ---- Adaptive webapp adapter factory (learned data-only adapters; read-only surfaces) ----
  const originOfSession = (s) => { try { return new URL(s.kv.get('RECEIPT', null)?.pageUrl ?? s.meta?.target?.url ?? '').origin; } catch { return null; } };
  const resolveSessions = (ids) => (Array.isArray(ids) ? ids : []).map((id) => {
    if (typeof id !== 'string' || !id.length) throw problem(400, 'sessionIds must be non-empty strings');
    const s = sessionOf(id); savedOnly(s);
    return s;
  });
  // Persistence-owner errors (src/store/versioned.mjs) keep their stable codes and committed/conflict facts on the wire.
  const factoryCall = (fn) => (...args) => {
    if (!adapterFactory) throw problem(501, 'Adapter factory not wired in this process (learned-adapters store unavailable)', 'ADAPTER_FACTORY_UNAVAILABLE');
    try { return fn(...args); } catch (e) {
      if (e instanceof AdapterFactoryError) throw problem(400, e.message, e.code);
      throw storeProblem(e);
    }
  };
  const intelligenceCall = (fn) => async (...args) => {
    try { return await fn(...args); } catch (e) { throw storeProblem(e); }
  };
  const candidateBody = { type: 'object', description: 'aion.adaptive-webapp-adapter/1 candidate as returned by synthesize' };

  function add(method, routePath, summary, handler, { query = {}, body, tool, contentType = 'application/json', annotations, inputSchema, pathParameters = {}, successStatus = 200 } = {}) {
    routes.push({ method, path: '/api/v1' + routePath, parts: ('/api/v1' + routePath).split('/'), summary, handler, query, body, tool, contentType, annotations, inputSchema, pathParameters, successStatus });
  }
  registerConversationTools({ add, conversationRuntime });
  registerHarnessTools({ add, harnessApi });

  add('GET', '/health', 'Studio process health without probing Chrome', () => ({ version: VERSION, apiVersion: 1, time: new Date().toISOString(), recorder: recorder.status(), events: feed.info() }), { tool: 'studio_health' });
  add('GET', '/sessions', 'List and filter saved recordings', ({ q }) => page(selectedSessions(q), q), { query: sessionQuery, tool: 'list_sessions' });
  add('GET', '/sessions/{session}', 'Session metadata, derivation state and dataset inventory', ({ p }) => {
    const s = sessionOf(p.session);
    return { meta: s.meta, state: s.kv.get('STATE', null), receipt: s.kv.get('RECEIPT', null), knowledge: s.kv.get('KNOWLEDGE_STATUS', null), datasets: datasetsOf(s), links: { replay: `/api/v1/sessions/${encodeURIComponent(s.id)}/replay/records`, graph: `/api/v1/sessions/${encodeURIComponent(s.id)}/knowledge/graph` } };
  }, { tool: 'get_session' });
  add('GET', '/sessions/{session}/datasets', 'List available derived datasets and byte sizes', ({ p }) => ({ items: datasetsOf(sessionOf(p.session)) }));
  add('GET', '/sessions/{session}/datasets/{dataset}', 'Page through saved structured records', async ({ p, q }) => {
    const s = sessionOf(p.session), name = storageName(p.dataset, 'dataset');
    const ds = s.dataset(name);
    if (name === 'entities') knowledge(s);
    if (!existsSync(ds.file) && !(name === 'entities' && s.kv.get('KNOWLEDGE_STATUS')?.entityCount === 0)) throw problem(404, 'Dataset not found', 'NOT_FOUND');
    return { session: s.id, dataset: name, ...await datasetPage(ds, q) };
  }, { query: pagination, tool: 'read_dataset' });
  add('GET', '/sessions/{session}/receipt', 'Read saved capture receipt without deriving', ({ p }) => ({ receipt: sessionOf(p.session).kv.get('RECEIPT', null) }));
  add('POST', '/sessions/{session}/derive', 'Rebuild derived outputs from saved raw evidence', async ({ p, body }) => {
    const s = sessionOf(p.session); savedOnly(s);
    if (body.profile !== undefined) storageName(body.profile, 'profile');
    const result = await deriveSession(s, body.profile);
    return { session: s.id, records: result.records, receipt: result.receipt, knowledge: result.knowledge, recordCounts: result.recordCounts, familyCounts: result.familyCounts };
  }, { body: objectSchema({ profile: str }) });

  add('GET', '/sessions/{session}/observation', 'Loss-aware aion.web-observation/1 projection over this session\'s derived evidence (identity never fabricated; DOM and network kept separable)',
    async ({ p }) => {
      const s = sessionOf(p.session); savedOnly(s);
      let profile = null;
      try { profile = s.kv.get('PROFILE_SNAPSHOT', null) ?? profileStore.load(s.meta.profile?.name ?? 'generic'); } catch { profile = null; }
      const observation = await observeSession(s, { profile, acceptance: readAcceptance(s) });
      return { session: s.id, observation };
    }, { tool: 'get_session_observation', annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } });

  add('GET', '/sessions/{session}/replay/records', 'Page raw-log evidence by durable sequence, with explicit preview mode', async ({ p, q }) => {
    const s = sessionOf(p.session); savedOnly(s);
    const afterSeq = integer(q.afterSeq, 0, Number.MAX_SAFE_INTEGER);
    const limit = integer(q.limit, 100, 1000, 1);
    const until = timestamp(q.until, 'until');
    const items = [], corruptRecords = []; let lastSeq = afterSeq, hasMore = false, corruptCount = 0;
    if (q.payload !== undefined && !['full', 'preview'].includes(q.payload)) throw problem(400, 'payload must be full or preview');
    for await (const record of s.records({ fromSeq: afterSeq })) {
      // A torn line has no sequence. Report separately rather than issuing a stuck cursor.
      if (record.k === 'corrupt') { corruptCount++; if (corruptRecords.length < 20) corruptRecords.push(record); continue; }
      if (q.sid && record.sid !== q.sid || q.kind && record.k !== q.kind || until !== null && record.t > until) continue;
      if (items.length === limit) { hasMore = true; break; }
      items.push(q.payload === 'preview' ? previewRecord(record) : record);
      if (Number.isSafeInteger(record.seq)) lastSeq = record.seq;
    }
    return { session: s.id, items, afterSeq, nextAfterSeq: hasMore ? lastSeq : null, hasMore, preview: q.payload === 'preview', corruptCount, corruptRecords, note: 'Corrupt lines lack sequence cursors and may be reported again on later pages; diagnostics are capped at 20. Raw gap records disclose source loss.' };
  }, { query: { limit: pagination.limit, afterSeq: { type: 'integer', minimum: 0 }, until: str, sid: str, kind: str, payload: { type: 'string', enum: ['full', 'preview'] } }, tool: 'replay_records' });
  add('GET', '/sessions/{session}/replay/state', 'Reconstruct transport and rendered state at a capture timestamp', async ({ p, q }) => {
    const s = sessionOf(p.session); savedOnly(s);
    const at = timestamp(q.at); if (at === null) throw problem(400, 'at is required');
    return { session: s.id, ...await stateAt(s, at, profileFor(s)) };
  }, { query: timeQuery, tool: 'replay_state' });
  add('GET', '/sessions/{session}/replay/streams/{sid}', 'Reconstruct one stream and its assembled state from raw evidence', async ({ p, q }) => {
    const s = sessionOf(p.session); savedOnly(s);
    const at = timestamp(q.at);
    const reducer = new StreamReducer({ deltaDialect: profileFor(s)?.decode?.delta ?? 'auto', keepEvents: false });
    for await (const record of s.records()) {
      if (at !== null && record.t > at) continue;
      if (record.sid === p.sid || ['run.start', 'run.end', 'gap', 'pause', 'resume'].includes(record.k)) reducer.ingest(record);
    }
    const stream = reducer.summary().streams.find((r) => r.sid === p.sid);
    if (!stream) throw problem(404, 'Stream not found at the requested time', 'NOT_FOUND');
    return { session: s.id, asOf: at, stream, assembled: reducer.assembled(p.sid), gaps: reducer.gaps };
  }, { query: timeQuery, tool: 'replay_stream' });
  add('GET', '/sessions/{session}/replay/events', 'Page decoded events with stream and time filters', async ({ p, q }) => {
    const s = sessionOf(p.session), from = timestamp(q.from, 'from'), to = timestamp(q.to, 'to');
    if (from !== null && to !== null && from > to) throw problem(400, 'from must not be after to');
    return { session: s.id, ...await datasetPage(s.dataset('events'), q, (r) => (!q.sid || r.sid === q.sid) && (from === null || r.t >= from) && (to === null || r.t <= to)) };
  }, { query: { ...pagination, sid: str, from: str, to: str } });

  add('GET', '/sessions/{session}/knowledge', 'Derived knowledge summary with completeness marker', ({ p }) => {
    const s = sessionOf(p.session), { outcome, model } = knowledge(s);
    return { session: s.id, outcome, model, hypotheses: s.kv.get('HYPOTHESES', null), corpus: s.kv.get('CORPUS_STATS', null), graphStats: s.kv.get('GRAPH', null)?.stats ?? null };
  }, { tool: 'get_knowledge' });
  add('GET', '/sessions/{session}/knowledge/entities', 'Page inferred entities, optionally materialized at a historical time', async ({ p, q }) => {
    const s = sessionOf(p.session), at = timestamp(q.at);
    const { outcome } = knowledge(s);
    if (at !== null) return { session: s.id, outcome, asOf: at, ...page(graphOf(s, at).nodes.filter((e) => !q.type || e.type === q.type || e.typeName === q.type), q) };
    const ds = s.dataset('entities');
    if (!existsSync(ds.file) && outcome.entityCount !== 0) throw problem(409, 'Entities dataset is missing', 'KNOWLEDGE_UNAVAILABLE');
    return { session: s.id, outcome, ...await datasetPage(ds, q, (e) => !q.type || e.type === q.type || e.typeName === q.type) };
  }, { query: { ...pagination, ...timeQuery, type: str }, tool: 'list_entities' });
  add('GET', '/sessions/{session}/knowledge/entities/{eid}', 'Entity details and paginated revision provenance', ({ p, q }) => {
    const s = sessionOf(p.session), at = timestamp(q.at), graph = graphOf(s, null);
    const node = graph.nodes.find((n) => n.eid === p.eid);
    if (!node) throw problem(404, 'Entity not found', 'NOT_FOUND');
    const historical = at === null ? node : graphOf(s, at).nodes.find((n) => n.eid === p.eid);
    if (!historical) throw problem(404, 'Entity not observed at this time', 'NOT_FOUND');
    const { history, ...entity } = historical;
    return { session: s.id, asOf: at, outcome: graph.outcome, entity, history: page((node.history ?? []).filter((r) => at === null || Number.isFinite(r.t) && r.t <= at), q) };
  }, { query: { ...pagination, ...timeQuery }, tool: 'get_entity' });
  add('GET', '/sessions/{session}/knowledge/graph', 'Bounded graph nodes and edges, preserving inference status', ({ p, q }) => {
    const s = sessionOf(p.session), graph = graphOf(s, timestamp(q.at));
    const nodes = graph.nodes.filter((n) => !q.type || n.type === q.type || n.typeName === q.type);
    const selected = q.type ? new Set(nodes.map((n) => n.eid)) : null;
    const edges = graph.edges.filter((e) => (!q.kind || e.kind === q.kind) && (!q.status || e.status === q.status) && (!selected || selected.has(e.from) || selected.has(e.to)));
    return { session: s.id, asOf: graph.asOf, outcome: graph.outcome, types: graph.types, nodes: page(nodes, q), edges: page(edges, q), note: 'Node and edge pages are independent; some endpoints reference external observation nodes. Hypotheses are not confirmed facts.' };
  }, { query: { ...pagination, ...timeQuery, type: str, kind: str, status: str }, tool: 'get_graph' });
  add('GET', '/sessions/{session}/knowledge/neighbors/{eid}', 'Bounded breadth-first graph neighborhood with direction and status filters', ({ p, q }) => {
    const s = sessionOf(p.session), graph = graphOf(s, timestamp(q.at));
    const depth = integer(q.depth, 1, 4, 1), limit = integer(q.limit, 100, 1000, 1);
    const direction = q.direction ?? 'both';
    if (!['in', 'out', 'both'].includes(direction)) throw problem(400, 'direction must be in, out or both');
    if (!graph.nodes.some((n) => n.eid === p.eid) && !graph.edges.some((e) => e.from === p.eid || e.to === p.eid)) throw problem(404, 'Graph identity not found', 'NOT_FOUND');
    const seen = new Set([p.eid]), edges = new Map(); let frontier = [p.eid], truncated = false;
    for (let level = 0; level < depth && frontier.length; level++) {
      const next = [], current = new Set(frontier);
      for (const e of graph.edges) {
        if (q.kind && e.kind !== q.kind || q.status && e.status !== q.status || !q.status && e.status === 'rejected') continue;
        const target = direction !== 'in' && current.has(e.from) ? e.to : direction !== 'out' && current.has(e.to) ? e.from : null;
        if (!target) continue;
        if (edges.size >= limit && !edges.has(e.id) || !seen.has(target) && seen.size >= limit) { truncated = true; continue; }
        edges.set(e.id, e);
        if (!seen.has(target)) { seen.add(target); next.push(target); }
      }
      frontier = next;
    }
    const nodes = graph.nodes.filter((n) => seen.has(n.eid));
    const known = new Set(nodes.map((n) => n.eid));
    return { session: s.id, root: p.eid, asOf: graph.asOf, depth, direction, nodes, edges: [...edges.values()], externalNodes: [...seen].filter((id) => !known.has(id)), truncated };
  }, { query: { ...timeQuery, depth: { type: 'integer', minimum: 1, maximum: 4 }, limit: pagination.limit, direction: { type: 'string', enum: ['in', 'out', 'both'] }, kind: str, status: str }, tool: 'graph_neighbors' });
  add('GET', '/sessions/{session}/knowledge/continuity', 'Exact-origin cross-session continuity without automatic type-drift merges', async ({ p, q }) => {
    const s = sessionOf(p.session), site = siteFromSession(s.meta), origin = originFromSession(s.meta);
    if (!site || !origin) throw problem(409, 'Session has no proven site/origin scope');
    const at = timestamp(q.at), limit = integer(q.limit, 50, 1000, 1);
    return buildSiteContinuity(paths.sessions, { site, origin, eid: q.eid ?? null, asOf: at, limit, includeHistory: !!q.eid });
  }, { query: { ...timeQuery, limit: pagination.limit, eid: str }, tool: 'get_continuity' });

  const capabilities = registerCapabilities({ add, paths, recorder, profileStore, sessionOf, savedOnly, profileFor, selectedSessions, publish, deriving, invalidateReplay });
  add('GET', '/live/view', 'Minimal live stream text viewer (also served at /live/view)', ({ res }) => {
    if (!res) return { url: '/live/view', feed: '/api/v1/live' };
    const html = readFileSync(new URL('./ui/live.html', import.meta.url), 'utf8');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'" });
    res.end(html);
  }, { tool: 'live_view', contentType: 'text/html' });

  const learnerDir = paths.learner ?? path.join(paths.root, 'learner');
  const readLearner = () => new ScopedLearner(learnerDir);
  const mutate = (body, operation, { savesItself = false } = {}) => {
    object(body);
    const expected = integer(body.expectedRevision, undefined, Number.MAX_SAFE_INTEGER);
    if (expected === undefined) throw problem(428, 'expectedRevision is required', 'REVISION_REQUIRED');
    const local = readLearner();
    if (expected !== local.revision) throw problem(409, `Expected revision ${expected}, current revision is ${local.revision}`, 'LEARNER_REVISION_CONFLICT');
    let result;
    try { result = operation(local); if (!savesItself) local.save(); }
    catch (e) { if (String(e.code).startsWith('LEARNER_')) throw problem(409, e.message, e.code); throw problem(400, e.message); }
    learner.reload();
    publish('learning.changed', { revision: local.revision }, null);
    return { revision: local.revision, result };
  };
  add('GET', '/learning', 'Learner revision, scopes, calibration and pending proposal counts', () => {
    const local = readLearner();
    return { revision: local.revision, scopes: SCOPES, roles: ROLES, models: Object.entries(local.models).map(([scope, model]) => ({ scope, examples: model.examples })), pendingProposals: local.proposals.filter((p) => p.status === 'proposed').length, corrections: local.corrections.length, calibrations: Object.keys(local.calibrator.bins).map((kind) => ({ kind, ece: local.calibrator.ece(kind) })) };
  }, { tool: 'learning_status' });
  add('POST', '/learning/predict', 'Predict a semantic field role without training', ({ body }) => {
    text(body.name, 'name'); object(body.d ?? {}, 'd'); object(body.ctx ?? {}, 'ctx');
    const local = readLearner();
    return { revision: local.revision, prediction: local.predict(body.name, body.d ?? {}, body.ctx ?? {}) };
  }, { body: objectSchema({ name: str, d: { type: 'object' }, ctx: { type: 'object' } }, ['name']), tool: 'predict_field_role' });
  add('GET', '/learning/proposals', 'Inspect persisted correction proposals', ({ q }) => {
    const local = readLearner(); return { revision: local.revision, ...page(local.proposals.filter((p) => !q.status || p.status === q.status), q) };
  }, { query: { ...pagination, status: str }, tool: 'list_learning_proposals' });
  add('GET', '/learning/corrections', 'Inspect accepted and reverted corrections', ({ q }) => {
    const local = readLearner(); return { revision: local.revision, ...page(local.corrections, q) };
  }, { query: pagination });
  add('GET', '/learning/audit', 'Inspect correction audit trail', ({ q }) => {
    const local = readLearner(); return { revision: local.revision, ...page(local.audit, q) };
  }, { query: pagination });
  add('GET', '/learning/versions', 'List immutable learner revisions', () => {
    const local = readLearner(); return { revision: local.revision, versions: local.versions() };
  });
  add('GET', '/learning/promotions', 'Review cross-site promotion candidates; never auto-promote', ({ q }) => {
    const local = readLearner(); return { revision: local.revision, items: local.promotionCandidates(integer(q.minSites, 2, 100, 2)), automaticallyApplied: false };
  }, { query: { minSites: { type: 'integer', minimum: 2, maximum: 100 } } });
  add('GET', '/sessions/{session}/learning/questions', 'Rank uncertain model fields by expected clarification value', ({ p, q }) => {
    const s = sessionOf(p.session), { model } = knowledge(s);
    const items = (model.types ?? []).flatMap((type) => (type.fields ?? []).map((f) => ({ id: `${type.id}:${f.name}`, kind: 'field_role', type: type.id, name: f.name, role: f.role, entropy: f.roleEntropy ?? 0, impact: type.support ?? 1, prompt: `What does ${type.name}.${f.name} represent?`, choices: ROLES })));
    return { session: s.id, items: activeQuestions(items, integer(q.limit, 10, 100, 1)) };
  }, { query: { limit: { type: 'integer', minimum: 1, maximum: 100 } }, tool: 'learning_questions' });
  const revisionSchema = { type: 'integer', minimum: 0 };
  add('POST', '/learning/proposals', 'Propose a correction without applying it', ({ body }) => mutate(body, (local) => local.proposeCorrection(body)), {
    body: objectSchema({ expectedRevision: revisionSchema, scope: { type: 'string', enum: SCOPES }, name: str, role: { type: 'string', enum: ROLES }, d: { type: 'object' }, ctx: { type: 'object' }, weight: { type: 'number', minimum: 0.01, maximum: 100 }, actor: str, note: str, evidence: {} }, ['expectedRevision', 'scope', 'name', 'role']),
  });
  add('POST', '/learning/proposals/{id}/review', 'Explicitly accept or reject a pending correction proposal', ({ p, body }) => mutate(body, (local) => local.reviewCorrection(p.id, body)), {
    body: objectSchema({ expectedRevision: revisionSchema, action: { type: 'string', enum: ['accept', 'reject'] }, actor: str, note: str, evidence: {} }, ['expectedRevision', 'action']),
  });
  add('POST', '/learning/corrections/{id}/revert', 'Revert a learned correction and retrain from retained evidence', ({ p, body }) => mutate(body, (local) => {
    if (!local.revert(p.id, body)) throw new Error('Correction not found or already reverted');
    return { reverted: p.id };
  }), { body: objectSchema({ expectedRevision: revisionSchema, actor: str, note: str }, ['expectedRevision']) });
  add('POST', '/learning/rollback', 'Restore a historical learner state as a new immutable revision', ({ body }) => {
    if (body.confirm !== true) throw problem(400, 'confirm:true is required to roll back learned state');
    const revision = integer(body.revision, undefined, Number.MAX_SAFE_INTEGER);
    if (revision === undefined) throw problem(400, 'revision is required');
    return mutate(body, (local) => ({ restoredRevision: revision, revision: local.rollbackTo(revision, { actor: body.actor, reason: body.reason }) }), { savesItself: true });
  }, { body: objectSchema({ expectedRevision: revisionSchema, revision: revisionSchema, confirm: { const: true }, actor: str, reason: str }, ['expectedRevision', 'revision', 'confirm']) });
  add('POST', '/learning/calibration', 'Record explicit acceptance feedback for a confidence estimate', ({ body }) => {
    const kind = text(body.kind, 'kind', 128);
    if (!/^[a-z][a-z0-9_.:-]*$/i.test(kind) || ['constructor', 'prototype', '__proto__'].includes(kind)) throw problem(400, 'Invalid calibration kind');
    if (typeof body.confidence !== 'number' || !Number.isFinite(body.confidence) || body.confidence < 0 || body.confidence > 1 || typeof body.accepted !== 'boolean') throw problem(400, 'confidence must be 0..1 and accepted must be boolean');
    return mutate(body, (local) => {
      local.calibrator.observe(kind, body.confidence, body.accepted);
      return { kind, calibrated: local.calibrator.calibrate(kind, body.confidence), ece: local.calibrator.ece(kind) };
    });
  }, { body: objectSchema({ expectedRevision: revisionSchema, kind: str, confidence: { type: 'number', minimum: 0, maximum: 1 }, accepted: { type: 'boolean' } }, ['expectedRevision', 'kind', 'confidence', 'accepted']) });

  // ---- Learned webapp adapter lifecycle (Agent 14 Round 8 factory; data-only, read-only) ----
  const priorSelectorsOf = (priorName) => {
    if (!priorName) return {};
    const prior = adapterFactory?.loadRecord?.(priorName)?.candidate ?? null;
    if (!prior) return {};
    const pick = (f) => (prior.features?.[f]?.selected?.candidate ? [prior.features[f].selected.candidate] : []);
    return { 'user-turn': pick('user-turn'), 'assistant-turn': pick('assistant-turn'), 'thread-route': pick('thread-route') };
  };
  const liveProbesIfRequested = async (body) => {
    if (!body.live) return [];
    if (!recorder?.dom || recorder.state !== 'recording' || !recorder.session) throw problem(409, 'live synthesis requires an active capture with an attached page', 'NOT_LIVE');
    const pageOrigin = (() => { try { return new URL(recorder.pageUrl ?? '').origin; } catch { return null; } })();
    if (pageOrigin !== body.origin) throw problem(409, `Active page origin ${pageOrigin ?? 'unknown'} does not match the synthesis origin ${body.origin}`, 'ORIGIN_MISMATCH');
    return await probesFromLivePage({ dom: recorder.dom, origin: body.origin, captureId: `live-${recorder.session.id}`, priorSelectors: priorSelectorsOf(body.priorName ?? null) });
  };
  add('POST', '/adapters/learned/synthesize', 'Synthesize a data-only adapter candidate from saved derived sessions (+ optional live=1 read-only page measurement of the actively captured tab; pure: nothing persisted, nothing activated)',
    factoryCall(async ({ body }) => {
      const sessions = resolveSessions(body.sessionIds);
      const liveProbes = await liveProbesIfRequested(body);
      const out = adapterFactory.synthesize({ siteId: body.siteId, origin: body.origin, surface: body.surface, sessions, priorName: body.priorName ?? null, liveProbes });
      return { ...out, drift: out.candidate.drift, coverage: out.candidate.coverage, authority: out.candidate.authority, note: 'Candidate only. Shadow-evaluate against held-out sessions before considering promotion.' };
    }), {
      body: objectSchema({ siteId: str, origin: str, surface: str, sessionIds: { type: 'array', items: str }, priorName: str, live: { type: 'boolean' } }, ['siteId', 'origin', 'sessionIds']),
      tool: 'synthesize_webapp_adapter', annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    });

  add('POST', '/adapters/learned/shadow-evaluate', 'Evaluate a candidate against held-out saved sessions (pure shadow replay; no activation)',
    factoryCall(({ body }) => {
      const sessions = resolveSessions(body.sessionIds);
      return adapterFactory.shadowEvaluate({ candidate: body.candidate, sessions });
    }), {
      body: objectSchema({ candidate: candidateBody, sessionIds: { type: 'array', items: str } }, ['candidate', 'sessionIds']),
      tool: 'shadow_evaluate_webapp_adapter', annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    });

  add('POST', '/adapters/learned/promote', 'Promote a candidate to a versioned READ-ONLY learned adapter after server-side re-verification against held-out sessions. expectedVersion is REQUIRED (null = first create, integer = current version); a missing or invalid value is refused with CAS_EXPECTED_VERSION_INVALID and nothing is inferred.',
    factoryCall(({ body }) => {
      validateExpectedVersion(body.expectedVersion, { allowNull: true }); // required: null = first create, integer = current; missing is refused before any evidence work
      const sessions = resolveSessions(body.sessionIds);
      const rec = adapterFactory.promote({ candidate: body.candidate, sessions, clientShadow: body.shadow ?? null, note: body.note ?? '', expectedVersion: body.expectedVersion });
      return { ...rec, readFeatures: rec.adapter?.factory?.readFeatures ?? [], sendPermission: false, note2: 'Read-only activation only; never a send grant.' };
    }), {
      body: objectSchema({ candidate: candidateBody, sessionIds: { type: 'array', items: str }, shadow: { type: 'object' }, note: str, expectedVersion: { type: ['integer', 'null'], minimum: 1, description: 'REQUIRED. null = first create (must not exist); integer = must equal the current version.' } }, ['candidate', 'sessionIds', 'expectedVersion']),
      tool: 'promote_learned_adapter', annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    });

  add('GET', '/adapters/learned', 'List learned data-only adapters with their versions and CURRENT pointers',
    factoryCall(() => ({ items: adapterFactory.list() })), { tool: 'list_learned_adapters', annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false } });

  add('GET', '/adapters/learned/{name}', 'Read one learned adapter: CURRENT candidate, shadow receipt and version history',
    factoryCall(({ p }) => {
      const entry = adapterFactory.list().find((x) => x.name === p.name);
      if (!entry) throw problem(404, `No learned adapter "${p.name}"`, 'NOT_FOUND');
      const adapter = adapterFactory.loadLearned(p.name);
      return { ...entry, adapter };
    }), { tool: 'get_learned_adapter', annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false } });

  add('POST', '/adapters/learned/{name}/rollback', 'Restore a learned adapter to a historical version by APPENDING a new version with that content (CURRENT only moves forward; no re-synthesis). expectedVersion (the current version, integer >= 1) is REQUIRED; a missing or invalid value is refused with CAS_EXPECTED_VERSION_INVALID.',
    factoryCall(({ p, body }) => {
      validateExpectedVersion(body.expectedVersion, { allowNull: false });
      if (body.confirm !== true) throw problem(400, 'confirm:true is required to roll back a learned adapter');
      const v = integer(body.version, 1, Number.MAX_SAFE_INTEGER);
      if (v === undefined) throw problem(400, 'version is required');
      return adapterFactory.rollback(p.name, v, { expectedVersion: body.expectedVersion }); // passed through unchanged: missing is refused, never inferred or ?? null
    }), {
      body: objectSchema({ version: { type: 'integer', minimum: 1 }, confirm: { const: true }, expectedVersion: { type: 'integer', minimum: 1 } }, ['version', 'confirm', 'expectedVersion']),
      tool: 'rollback_learned_adapter', annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    });

  add('GET', '/adapters/learned/{name}/transcript', 'Read-only conversation transcript under the CURRENT learned adapter, from a saved session or (live=1) the actively captured page',
    factoryCall(async ({ p, q }) => {
      const record = adapterFactory.loadRecord(p.name);
      if (!record) throw problem(404, `No learned adapter "${p.name}"`, 'NOT_FOUND');
      const candidate = record.candidate;
      const live = q.live === '1' || q.live === 'true';
      if (live) {
        if (!recorder?.dom || recorder.state !== 'recording' || !recorder.session) throw problem(409, 'Live transcript requires an active capture with an attached page', 'NOT_LIVE');
        const pageOrigin = (() => { try { return new URL(recorder.pageUrl ?? '').origin; } catch { return null; } })();
        if (pageOrigin !== candidate.origin) throw problem(409, `Active page origin ${pageOrigin ?? 'unknown'} does not match the learned adapter origin ${candidate.origin}`, 'ORIGIN_MISMATCH');
        return await transcriptFromLivePage({ dom: recorder.dom, candidate, scrub: (t) => recorder.privacy.text(t) });
      }
      if (!q.session) throw problem(400, 'query "session" is required (or live=1)', 'SESSION_REQUIRED');
      const s = sessionOf(q.session); savedOnly(s);
      const sOrigin = originOfSession(s);
      if (sOrigin !== candidate.origin) throw problem(409, `Session origin ${sOrigin ?? 'unknown'} does not match the learned adapter origin ${candidate.origin}`, 'ORIGIN_MISMATCH');
      return transcriptFromSession(s, candidate);
    }), {
      query: { session: str, live: str },
      tool: 'read_learned_transcript', annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    });

  add('GET', '/adapters/read', 'Read-view of the site registry: handwritten seed adapters plus learned data-only adapters (the drive/send path never sees learned adapters)',
    async () => ({ items: await listReadAdapters() }), { tool: 'list_read_adapters', annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false } });

  add('GET', '/adapters/read/{id}', 'Resolve one adapter through the read view (seed first, then learned candidates)',
    async ({ p }) => {
      const a = await getReadAdapter(p.id);
      if (!a) throw problem(404, `No adapter for "${p.id}" in the read view`, 'NOT_FOUND');
      return { adapter: { id: a.id, label: a.label ?? a.id, hosts: a.hosts ?? [], url: a.url ?? null, learned: a.learned === true, readOnly: a.readOnly === true, sendStrategy: a.send?.strategy ?? 'both', readFeatures: a.factory?.readFeatures ?? [], authority: a.authority ?? null } };
    }, { tool: 'get_read_adapter', annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false } });

  // Four-lane Intelligence integration: the guarded I1 improvement pipeline over REAL saved
  // sessions. Proposals are computed server-side from Core-verified evidence only; promotion
  // is read-only, CAS-guarded and reachable ONLY through a server-minted proposalDigest
  // (a client-submitted JSON object can never satisfy the minted-ledger lookup). No route
  // here grants a browser effect: writes go to the existing learned-adapter VersionedStore.
  if (learningPipeline) {
    const scopeBody = objectSchema({
      siteId: str, origin: str, surface: str, accountRef: str,
      training: { type: 'array', items: str }, heldout: { type: 'array', items: str },
      trigger: { type: 'string', enum: ['new-evidence', 'drift', 'reviewed-correction'] },
      testOnly: { type: 'boolean' }, seed: { type: 'object' },
      incumbent: str, newSelector: str, driftEvidence: { type: 'array', items: { type: 'object' } },
    }, ['siteId', 'origin', 'training', 'heldout']);
    const readScope = (body) => ({ siteId: body.siteId, origin: body.origin,
      surface: body.surface ?? 'chat', accountRef: body.accountRef ?? 'unknown' });
    add('POST', '/adapters/intelligence/propose', 'Run the guarded adapter-improvement pipeline over saved sessions: server-verified manifests, independent train/held-out lineage, Round 8 synthesis, Round 9 holdout gate, shadow evaluation (pure: computes and mints a proposal, activates nothing)',
      async ({ body }) => {
        const proposal = await learningPipeline.proposeFromSessions({
          scope: readScope(body), training: body.training, heldout: body.heldout,
          seed: body.seed ?? null, testOnly: body.testOnly === true, trigger: body.trigger ?? 'new-evidence',
          incumbent: body.incumbent ?? null, newSelector: body.newSelector ?? null, driftEvidence: body.driftEvidence ?? null,
        });
        return { ...proposal, note: 'Read-only proposal. Promotion only via the server-minted proposalDigest; no browser effects, no send permission.' };
      }, { body: scopeBody, tool: 'propose_adapter_improvement',
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false } });
    add('POST', '/adapters/intelligence/promote', 'Promote a SERVER-MINTED read-only proposal through the expected-version CAS store (versioned learned-read adapter; sendPermission stays false; the digest must come from propose in this process)',
      intelligenceCall(async ({ body }) => {
        if (typeof body.proposalDigest !== 'string' || !body.proposalDigest) throw problem(400, 'proposalDigest is required', 'PROPOSAL_DIGEST_REQUIRED');
        return { promoted: await learningPipeline.promote(body.proposalDigest) };
      }), { body: objectSchema({ proposalDigest: str }, ['proposalDigest']), tool: 'promote_read_only_adapter',
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } });
    add('POST', '/adapters/intelligence/rollback', 'Restore the learned read-adapter for one scope to an explicit earlier version under strict expected-version CAS: APPENDS a new version with that content (immutable history preserved, CURRENT only moves forward). expectedVersion (the current version, integer >= 1) is REQUIRED; a missing or null value is refused with CAS_EXPECTED_VERSION_INVALID.',
      intelligenceCall(async ({ body }) => ({ rolledBack: await learningPipeline.rollback(readScope(body), body.targetVersion, body.expectedVersion) })),
      { body: objectSchema({ siteId: str, origin: str, surface: str, accountRef: str, targetVersion: { type: 'integer', minimum: 1 }, expectedVersion: { type: 'integer', minimum: 1 } }, ['siteId', 'origin', 'targetVersion', 'expectedVersion']),
        tool: 'rollback_read_only_adapter', annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } });
    add('GET', '/adapters/intelligence/proposals', 'List proposals minted in this process (digest, status, evidence class, promotion state)',
      () => ({ proposals: learningPipeline.listProposals() }),
      { tool: 'list_adapter_proposals', annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false } });
    add('POST', '/adapters/intelligence/read-selection', 'Read-only selection view for one scope: which adapter (learned vs seed) would serve reads, with sendPermission always false (diagnostic; the registry remains the executable source of truth)',
      async ({ body }) => learningPipeline.resolveRead(readScope(body), body.seed ?? null, { simulation: body.simulation === true, proposal: null }),
      { body: objectSchema({ siteId: str, origin: str, surface: str, accountRef: str, seed: { type: 'object' }, simulation: { type: 'boolean' } }, ['siteId', 'origin']),
        tool: 'resolve_read_selection', annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } });
  }

  add('GET', '/events', 'Resumable live SSE previews; Last-Event-ID or after cursor, heartbeat and gap reset', ({ req, res, q }) => feed.subscribe(req, res, q, { status: recorder.status() }), { query: { types: str, session: str, sid: str, after: str, replay: { type: 'integer', minimum: 0, maximum: 1000 } }, contentType: 'text/event-stream' });
  add('GET', '/integrations', 'Integration capabilities and privacy/delivery semantics', () => ({ apiVersion: 1, events: EVENT_TYPES, liveEvents: LIVE_EVENTS, feed: feed.info(), liveFeed: capabilities.liveFeed.info(), endpoints: { events: '/api/v1/events', live: '/api/v1/live', liveView: '/live/view', mirrors: '/api/v1/mirrors', deriveAll: '/api/v1/sessions/{session}/derive-all', artifacts: '/api/v1/sessions/{session}/artifacts', schemas: '/api/v1/sessions/{session}/schemas', rankedGraph: '/api/v1/sessions/{session}/graph/ranked', timelines: '/api/v1/sessions/{session}/timelines', search: '/api/v1/search', openapi: '/api/v1/openapi.json', tools: '/api/v1/integrations/tools', invoke: '/api/v1/integrations/tools/call', webhooks: '/api/v1/integrations/webhooks' }, optionalCapabilities: 'Loaded on demand; HTTP 501 means the backend module or export is unavailable', authentication: 'Localhost requires no token by default; optional token mode accepts x-studio-token or Studio cookie; both enforce same loopback Host/Origin policy', mirrors: { scope: 'literal-loopback-only', lifetime: 'Studio process', maxInstances: 8, privacy: 'Explicit start exposes captured replay data on the returned local mirror port; Studio authentication protects management endpoints, not the mirror backend' }, webhooks: { scope: 'literal-loopback-only', registration: 'process-lifetime', delivery: 'one attempt; unknown network effects are not retried', defaultPayload: 'metadata-only', confirmation: 'registration POST is explicit opt-in' }, tools: { protocol: 'MCP-style JSON manifest and invocation adapter, not a full MCP transport', readOnly: false, streaming: 'Live feed calls return a subscription descriptor; derive_all calls return final JSON. Use the declared HTTP endpoint for SSE progress.' } }));
  add('GET', '/integrations/webhooks', 'List process-local outbound webhook subscriptions', () => ({ items: webhooks.list() }));
  add('POST', '/integrations/webhooks', 'Opt in to signed loopback webhook deliveries', ({ body }) => webhooks.register(body), { body: objectSchema({ url: str, events: { type: 'array', items: { enum: EVENT_TYPES } }, session: str, includePayload: { type: 'boolean', default: false, description: 'Explicitly include private captured preview data in outbound local deliveries' } }, ['url']) });
  add('GET', '/integrations/webhooks/{id}/deliveries', 'Read bounded metadata-only webhook delivery receipts', ({ p, q }) => page(webhooks.get(p.id).receipts, q), { query: pagination });
  add('DELETE', '/integrations/webhooks/{id}', 'Unsubscribe; an in-flight request may already have reached its destination', ({ p }) => webhooks.remove(p.id));

  // 'required' inside a query spec names mandatory query parameters; it is not a parameter itself.
  const querySchema = (r) => Object.fromEntries(Object.entries(r.query ?? {}).filter(([name]) => name !== 'required'));
  function toolsManifest() {
    return { schema: 'capture-studio.tools/1', protocol: 'MCP-style, not full MCP', tools: routes.filter((r) => r.tool).map((r) => ({
      name: r.tool, description: r.summary,
      inputSchema: r.inputSchema ?? objectSchema({ ...Object.fromEntries(r.parts.filter((s) => s.startsWith('{')).map((s) => [s.slice(1, -1), str])), ...querySchema(r), ...(r.body?.properties ?? {}) }, [...r.parts.filter((s) => s.startsWith('{')).map((s) => s.slice(1, -1)), ...(r.body?.required ?? []), ...(r.query?.required ?? [])]),
      annotations: { readOnlyHint: r.method === 'GET', destructiveHint: r.method === 'DELETE', idempotentHint: r.method === 'GET', openWorldHint: false, ...r.annotations },
      http: { method: r.method, path: r.path, contentType: r.contentType },
    })) };
  }
  add('GET', '/integrations/tools', 'MCP-style tool manifest with mutation annotations and JSON input schemas', toolsManifest);
  add('POST', '/integrations/tools/call', 'Invoke a declared tool; streaming GET tools return an HTTP subscription descriptor', async ({ body }) => {
    text(body.name, 'name'); const args = object(body.arguments ?? {}, 'arguments');
    const route = routes.find((r) => r.tool === body.name);
    if (!route) throw problem(404, 'Unknown integration tool', 'NOT_FOUND');
    const schema = toolsManifest().tools.find((t) => t.name === body.name).inputSchema;
    for (const name of schema.required ?? []) if (args[name] === undefined) throw problem(400, `Missing tool argument: ${name}`);
    for (const name of Object.keys(args)) if (!Object.hasOwn(schema.properties, name)) throw problem(400, `Unknown tool argument: ${name}`);
    const p = Object.fromEntries(route.parts.filter((s) => s.startsWith('{')).map((s) => { const name = s.slice(1, -1); return [name, text(args[name], name, 512)]; }));
    const data = route.contentType === 'text/event-stream' && route.method === 'GET'
      ? { method: 'GET', url: route.path.replace(/\{([^}]+)\}/g, (_, name) => encodeURIComponent(p[name])) + (Object.keys(args).some((name) => Object.hasOwn(route.query, name)) ? '?' + new URLSearchParams(Object.entries(args).filter(([name]) => Object.hasOwn(route.query, name))).toString() : ''), contentType: 'text/event-stream', authentication: 'Default localhost no-login; optional Studio cookie or x-studio-token in token mode' }
      : await route.handler({ p, q: args, body: args });
    return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data, isError: false };
  }, { body: objectSchema({ name: str, arguments: { type: 'object' } }, ['name']) });

  function openapi() {
    const spec = { openapi: '3.1.0', info: { title: 'Capture Studio Integration API', version: VERSION, description: 'Local-first API v1. Default loopback mode needs no token; optional token mode accepts Studio cookie or header. Timestamps use epoch milliseconds or ISO strings.' },
      servers: [{ url: `http://127.0.0.1:${getPort()}` }], security: getAccessMode() === 'local' ? [] : [{ StudioToken: [] }, { StudioCookie: [] }],
      components: { securitySchemes: { StudioToken: { type: 'apiKey', in: 'header', name: 'x-studio-token' }, StudioCookie: { type: 'apiKey', in: 'cookie', name: 'studio_token' } } }, paths: {} };
    for (const r of routes) {
      const parameters = [...r.parts.filter((s) => s.startsWith('{')).map((s) => ({ name: s.slice(1, -1), in: 'path', required: true, schema: r.pathParameters[s.slice(1, -1)] ?? str })), ...Object.entries(querySchema(r)).map(([name, schema]) => ({ name, in: 'query', required: (r.query?.required ?? []).includes(name), schema }))];
      if (r.contentType === 'text/event-stream' && r.method === 'GET') parameters.push({ name: 'Last-Event-ID', in: 'header', schema: str });
      (spec.paths[r.path] ??= {})[r.method.toLowerCase()] = { summary: r.summary, operationId: r.tool ?? `${r.method.toLowerCase()}_${r.path.replace(/[^a-z0-9]+/gi, '_')}`, parameters,
        ...(r.body ? { requestBody: { required: true, content: { 'application/json': { schema: r.body } } } } : {}),
        responses: { [r.successStatus]: { description: r.contentType === 'text/event-stream' ? 'SSE stream; failures after headers are error events. Derive progress ends with complete or error.' : 'Success', content: { [r.contentType]: { schema: {} } } }, 400: { description: 'Invalid request' }, 401: { description: 'Studio authentication required' }, 404: { description: 'Resource unavailable' }, 409: { description: 'State/revision conflict or derived knowledge unavailable' }, 428: { description: 'Learner expectedRevision required' }, 429: { description: 'Integration capacity exceeded' }, 501: { description: 'Optional capability module or export is not available yet' }, 503: { description: 'Studio is closing' } } };
    }
    spec.paths['/live/view'] = { $ref: '#/paths/~1api~1v1~1live~1view' };
    return spec;
  }
  add('GET', '/openapi.json', 'OpenAPI 3.1 description of the versioned integration API', openapi);

  async function handle(req, res, url, body) {
    if (url.pathname !== '/api/v1' && !url.pathname.startsWith('/api/v1/')) return false;
    try {
      let parts;
      try { parts = url.pathname.replace(/\/$/, '').split('/').map(decodeURIComponent); }
      catch { throw problem(400, 'Malformed path encoding'); }
      const matches = routes.filter((r) => r.parts.length === parts.length && r.parts.every((v, i) => v.startsWith('{') || v === parts[i]));
      const route = matches.find((r) => r.method === req.method);
      if (!route) {
        if (matches.length) { res.setHeader('allow', [...new Set(matches.map((r) => r.method))].join(', ')); throw problem(405, 'Method not allowed', 'METHOD_NOT_ALLOWED'); }
        throw problem(404, 'Unknown integration endpoint', 'NOT_FOUND');
      }
      const p = Object.fromEntries(route.parts.flatMap((v, i) => v.startsWith('{') ? [[v.slice(1, -1), parts[i]]] : []));
      const q = Object.fromEntries(url.searchParams);
      const data = await route.handler({ req, res, p, q, body: object(body) });
      if (!res.headersSent) json(res, route.successStatus, data);
    } catch (e) {
      if (res.headersSent) res.destroy();
      else json(res, e.status ?? 500, { error: e.message, code: e.code ?? 'INTERNAL_ERROR', ...storeFields(e) }); // committed/committedVersion and CAS expected/actual reach the client
    }
    return true;
  }

  return { handle, feed, liveFeed: capabilities.liveFeed, publish, webhooks, close() { const closing = capabilities.close(); for (const [event, fn] of listeners) recorder.off(event, fn); webhooks.close(); feed.close(); return closing; } };
}
