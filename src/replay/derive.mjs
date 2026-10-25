// Offline reconstruction from the raw log: datasets, shapes, receipt, time travel, raw bytes.
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { StreamReducer, transportOf } from './reducer.mjs';
import { ShapeInferencer, templateUrl } from '../shapes/infer.mjs';
import { ruleMatchesEvent, extractRecords, extractFromAssembled } from '../shapes/extract.mjs';
import { collectorSourceSha } from '../config.mjs';
import { extractFamilyRecords, familyRecordsFromEvent } from '../families/families.mjs';
import { CorpusCollector } from '../intel/corpus.mjs';
import { siteOf } from '../profiles/profiles.mjs';
import { discoverModel, modelSummary } from '../intel/discover.mjs';
import { resolveModel } from '../intel/identity.mjs';
import { correlateRendered, correlateActions } from '../intel/correlate.mjs';
import { buildGraph } from '../intel/graph.mjs';
import { InvariantViolation, NSP_SCHEMA } from '../core/invariants.mjs';
import { ScopedLearner } from '../intel/learn.mjs';
import { joinStreamToDom } from '../intel/join.mjs';
import { buildStreamMessages } from './stream-messages.mjs';
import { applyStreamMap } from '../profiles/stream-map.mjs';
import { buildStreamComponents, STREAM_COMPONENTS_SCHEMA } from './stream-components.mjs';
import { evaluateAcceptance, writeAcceptance, readAcceptance, reuseAcceptedContext } from '../capture/acceptance.mjs';
import { buildStreamRoles, describeStreamRoles, STREAM_ROLES_SCHEMA, STREAM_ROLE_CLASSIFIER_VERSION } from './stream-role.mjs';

export const STREAM_DOM_JOIN_SCHEMA = 'capture-studio.stream-dom-join/1';
export { STREAM_ROLES_SCHEMA, STREAM_ROLE_CLASSIFIER_VERSION };
// Per-stream event window for the component pass: larger than the reducer's 400 so long answers
// are not cut short; any eviction is still reported as eventsOmitted.
const STREAM_COMPONENTS_EVENT_CAP = 20000;

export async function derive(session, profile, { onProgress, families, learner, joinImpl = joinStreamToDom, componentsImpl = applyStreamMap, acceptanceImpl = evaluateAcceptance, rolesImpl = buildStreamRoles } = {}) {
  // Fail closed during rebuild: old MODEL/entities must not appear to be current.
  const knowledgeRun = { schema: 'capture-studio.knowledge-status/1',
    status: 'deriving', startedAt: new Date().toISOString(), dataset: 'entities' };
  session.kv.set('KNOWLEDGE_STATUS', knowledgeRun);
  // Events kept in memory are bounded per stream (evidence + drift); the dataset keeps all of them.
  const reducer = new StreamReducer({ deltaDialect: profile?.decode?.delta ?? 'auto', keepEvents: true, maxEventsPerStream: 400 });
  const shapes = new ShapeInferencer();
  const ds = {
    events: session.dataset('events'), streams: session.dataset('streams'), timeline: session.dataset('timeline'),
  };
  for (const d of Object.values(ds)) d.reset();
  const rules = profile?.records ?? [];
  const recordSets = new Map(rules.map((r) => [r.name, session.dataset(`records-${r.name}`)]));
  for (const d of recordSets.values()) d.reset();
  // "final" revision mode keeps only the latest record per identity; "all" streams every observation.
  const finals = new Map(rules.filter((r) => r.revisions === 'final' && r.key).map((r) => [r.name, new Map()]));
  const emit = (rule, recs) => { const f = finals.get(rule.name); if (!f) return recordSets.get(rule.name).push(recs); for (const r of recs) { const prev = f.get(r._key); f.set(r._key, { ...r, _revision: (prev?._revision ?? 0) + 1 }); } };
  let n = 0, batch = [];
  const firstSeqBySid = new Map(); // stream -> first raw seq (orders stream messages for the join)
  const flush = () => { if (batch.length) { ds.events.push(batch); batch = []; } };
  // Complete-evidence collectors: fed with EVERY decoded event (not the bounded in-memory window).
  let siteName = '';
  try { siteName = siteOf(new URL(session.meta?.target?.url).hostname); } catch { /* no target url */ }
  const corpus = new CorpusCollector({ session, site: siteName });
  const famEvents = {};
  for await (const rec of session.records()) {
    if (rec.sid !== undefined && !firstSeqBySid.has(rec.sid)) firstSeqBySid.set(rec.sid, rec.seq);
    const evs = reducer.ingest(rec);
    for (const ev of evs) {
      batch.push(ev);
      const st = reducer.streams.get(ev.sid);
      corpus.addEvent(ev, st);
      for (const { dataset, record } of familyRecordsFromEvent(profile, ev, st, session)) (famEvents[dataset] ??= []).push(record);
      shapes.observeEvent(ev, st);
      for (const rule of rules) if (ruleMatchesEvent(rule, ev, st)) emit(rule, extractRecords(rule, ev, st));
    }
    if (batch.length > 500) flush();
    if (['action', 'nav', 'gap', 'run.start', 'run.end', 'lifecycle', 'done', 'fail', 'stream.armed', 'stream.arm_failed', 'ws.open', 'ws.close'].includes(rec.k)) {
      ds.timeline.push({ seq: rec.seq, t: rec.t, k: rec.k, sid: rec.sid, kind: rec.kind ?? rec.event, label: rec.target?.label, url: rec.url, reason: rec.reason, error: rec.error ?? rec.errorText });
    }
    if (++n % 5000 === 0) onProgress?.(n);
  }
  flush();
  const summary = reducer.summary();
  ds.streams.push(summary.streams.map((s) => ({ ...s, endpoint: `${s.method ?? (s.kind === 'ws' ? 'WS' : 'GET')} ${templateUrl(s.url)}` })));
  for (const rule of rules.filter((r) => r.source === 'assembled')) {
    for (const s of reducer.streams.values()) recordSets.get(rule.name).push(extractFromAssembled(rule, s._delta.doc, s));
  }
  for (const [name, f] of finals) recordSets.get(name).push([...f.values()]);
  const domInspect = session.kv.get('DOM_INSPECT') ?? null;
  const domTurns = session.kv.get('DOM_TURNS') ?? [];
  const familyList = families ? families.names().map((n) => families.load(n)) : [];
  const report = shapes.report(reducer, { families: familyList, profile, domInspect, domTurns, calibrator: learner?.calibrator });
  session.kv.set('SHAPES', report);
  corpus.addDomTurns(domTurns);
  const corpusResult = corpus.result(reducer);
  session.kv.set('CORPUS_STATS', corpusResult.stats);
  const familySets = extractFamilyRecords(profile, reducer, { session, domTurns, eventRecords: famEvents });
  const familyCounts = {};
  for (const name of listFamilyDatasets(session)) session.dataset(name).reset();
  for (const [name, recs] of Object.entries(familySets)) { session.dataset(name).push(recs); familyCounts[name] = recs.length; }
  const assembled = {};
  for (const s of reducer.streams.values()) if (s._delta.revisions > 0) assembled[s.sid] = { endpoint: `${s.method ?? 'GET'} ${templateUrl(s.url)}`, revisions: s._delta.revisions, dialects: [...s._delta.detected], doc: s._delta.doc };
  session.kv.set('ASSEMBLED', assembled);
  session.kv.set('DOM_BLOCKS', [...reducer.dom.blocks.values()]);
  const receipt = buildReceipt(session, reducer, summary);
  receipt.fidelity_breakdown = fidelityBreakdown(reducer, summary, n);
  receipt.quality = Object.fromEntries(Object.entries(report.quality).filter(([k]) => k !== 'assumptions').map(([k, v]) => [k, v.score]));
  receipt.family = report.families[0] ? { best: report.families[0].family, score: report.families[0].score, linked: profile?.family ?? null } : null;
  session.kv.set('RECEIPT', receipt);

  // ---- Knowledge layer: corpus -> model -> entities -> hypotheses -> temporal graph. ----
  // Isolated: any failure is recorded (MODEL.error / MODEL.stage) and never affects the outputs
  // written above. Raw is never touched; everything here is recomputable from raw.
  const resetEntities = () => session.dataset('entities').reset();
  resetEntities();
  let knowledge, stage = 'discover';
  try {
    const L = learner ?? new ScopedLearner();
    const model = discoverModel(corpusResult.samples, { learner: L, ctx: { site: siteName, family: profile?.family ?? undefined }, families: familyList, patchGroups: corpusResult.patchGroups });
    stage = 'identity';
    const resolutions = resolveModel(model);
    const entities = resolutions.flatMap((r) => r.entities);
    stage = 'correlate';
    const subjectsAll = [...entities].sort((a, b) => b.observations - a.observations || (a.eid < b.eid ? -1 : 1));
    const subjects = subjectsAll.slice(0, 500).map((e) => ({ id: e.eid, kind: 'entity', attrs: e.attrs, t0: e.first, t1: e.last }));
    const blocksAll = [...reducer.dom.blocks.values()].filter((b) => !b.removed && (b.text?.length ?? 0) >= 20);
    const elements = blocksAll.slice(-2000).map((b) => ({ id: b.id, text: b.text, firstT: b.firstT, lastT: b.lastT }));
    const renderedHyps = correlateRendered(subjects, elements);
    const actionHyps = correlateActions(reducer.actions, summary.streams);
    const caps = { subjectsTotal: subjectsAll.length, subjectsUsed: subjects.length, elementsTotal: blocksAll.length, elementsUsed: elements.length };
    stage = 'graph';
    const graph = buildGraph({ model, resolutions, renderedHyps, actionHyps, session });
    stage = 'persist';
    session.kv.set('MODEL', { ...modelSummary(model), corpus: corpusResult.stats });
    session.dataset('entities').push(entities);
    session.kv.set('GRAPH', graph.toJSON());
    session.kv.set('HYPOTHESES', { rendered: renderedHyps, actions: actionHyps, caps });
    // Last write of the completed knowledge transaction. Zero entities is a
    // successful empty result, even though Dataset.push([]) creates no file.
    session.kv.set('KNOWLEDGE_STATUS', { ...knowledgeRun, status: 'complete',
      completedAt: new Date().toISOString(), entityCount: entities.length,
      typeCount: model.types.length, entitiesDatasetPresent: entities.length > 0,
      graphIntegrity: graph.invariants.length ? 'partial' : 'complete',
      graphInvariantViolations: graph.invariants.length,
      graphQuarantinedEntities: graph.quarantinedEntities });
    knowledge = { types: model.types.length, entities: entities.length, edges: graph.edges.size,
      graphIntegrity: graph.invariants.length ? 'partial' : 'complete',
      graphInvariantViolations: graph.invariants.length,
      graphQuarantinedEntities: graph.quarantinedEntities,
      corpusSamples: corpusResult.stats.samples,
      corpusDropped: Object.values(corpusResult.stats.dropped).reduce((a, b) => a + b, 0),
      unmodelledGroups: model.unmodelled.length };
  } catch (e) {
    knowledge = { error: String(e?.message ?? e), stage,
      ...(e instanceof InvariantViolation ? { invariant: e.receipt } : {}) };
    resetEntities();
    session.kv.set('MODEL', knowledge);
    session.kv.set('GRAPH', null);
    session.kv.set('HYPOTHESES', null);
    session.kv.set('KNOWLEDGE_STATUS', { ...knowledgeRun, status: 'failed',
      completedAt: new Date().toISOString(), stage, error: knowledge.error,
      ...(knowledge.invariant ? { invariant: knowledge.invariant } : {}) });
  }
  // ---- Stream-to-DOM join: which rendered turn each assembled response stream became. ----
  // Isolated: a failure is recorded in STREAM_DOM_JOIN and never fails derive. Deterministic: no
  // wall-clock fields, so re-deriving the same raw log writes identical content.
  receipt.stream_dom_join = streamDomJoin(session, reducer, domTurns, { firstSeqBySid, joinImpl });
  // ---- Stream-to-component map: which UI component parts each response stream built. ----
  // Isolated like the join step: a failure is recorded in STREAM_COMPONENTS and never fails derive.
  // One wide replay (larger per-stream event window than the base pass) feeds both this pass and the
  // role pass below; a replay failure is recorded by each consumer in its own artifact.
  const wide = await replayWide(session, profile);
  receipt.stream_components = await streamComponents(session, profile, { componentsImpl, wide });
  // ---- Stream role per response stream (heuristic classification). Isolated like the passes above. ----
  receipt.stream_roles = streamRoles(session, { rolesImpl, wide });
  // ---- Offline acceptance label (no conversation context). A label only: nothing reads it here. ----
  receipt.acceptance = await acceptanceLabel(session, { acceptanceImpl });
  receipt.knowledge = knowledge;
  receipt.nsp = { schema: NSP_SCHEMA, graphInvariantViolations: knowledge.graphInvariantViolations ?? 0,
    graphQuarantinedEntities: knowledge.graphQuarantinedEntities ?? 0,
    ...(knowledge.invariant ? { invariant: knowledge.invariant } : {}) };
  session.kv.set('RECEIPT', receipt);
  return { records: n, summary, report, receipt, knowledge, familyCounts, recordCounts: Object.fromEntries([...recordSets].map(([k, d]) => [k, d.count])) };
}

// Writes kv STREAM_DOM_JOIN and returns the one-line receipt entry. Never throws.
function streamDomJoin(session, reducer, domTurnsRaw, { firstSeqBySid, joinImpl }) {
  const turns = Array.isArray(domTurnsRaw) ? domTurnsRaw : [];
  let value;
  try {
    if (!turns.length) value = { schema: STREAM_DOM_JOIN_SCHEMA, status: 'no_dom_turns' };
    else {
      const messages = buildStreamMessages(reducer, { firstSeqBySid });
      if (!messages.length) value = { schema: STREAM_DOM_JOIN_SCHEMA, status: 'no_stream_messages' };
      else {
        const { links, summary } = joinImpl({ messages, turns });
        value = { schema: STREAM_DOM_JOIN_SCHEMA, summary, links: withStreamText(links, messages),
          sources: { streams: messages.map((m) => m.sid), domTurns: turns.length } };
      }
    }
    session.kv.set('STREAM_DOM_JOIN', value);
  } catch (e) {
    value = { schema: STREAM_DOM_JOIN_SCHEMA, error: String(e?.message ?? e) };
    try { session.kv.set('STREAM_DOM_JOIN', value); } catch { /* kv not writable: derive continues */ }
  }
  if (value.summary) {
    const ms = value.summary.messageStatus;
    return `${ms.verified} verified, ${ms.partial} partial, ${ms.ambiguous} ambiguous, ${ms.unlinked_stream} unlinked stream, ${ms.unlinked_dom} unlinked DOM`;
  }
  return value.status ?? 'error';
}

// Re-reads the session's raw records through a dedicated reducer (same decoding as the reducer
// pass, larger per-stream event window). Never throws: a failure comes back as { error } and is
// recorded by each consumer in its own artifact.
async function replayWide(session, profile) {
  try {
    const reducer = new StreamReducer({ deltaDialect: profile?.decode?.delta ?? 'auto', keepEvents: true, maxEventsPerStream: STREAM_COMPONENTS_EVENT_CAP });
    for await (const rec of session.records()) reducer.ingest(rec);
    return { reducer };
  } catch (error) {
    return { error };
  }
}

// Writes kv STREAM_ROLES (schema, classifier version, ordinal-confidence label, per-sid role +
// enum evidence) from the wide replay and returns the one-line receipt entry. Never throws.
// Deterministic: no wall-clock fields, so re-deriving the same raw log writes identical content.
function streamRoles(session, { rolesImpl, wide }) {
  let value;
  try {
    if (wide.error) throw wide.error;
    value = rolesImpl(wide.reducer.summary({ includeStreamRoles: true }).streams, { eventWindow: STREAM_COMPONENTS_EVENT_CAP });
    session.kv.set('STREAM_ROLES', value);
  } catch (e) {
    value = { schema: STREAM_ROLES_SCHEMA, error: String(e?.message ?? e) };
    try { session.kv.set('STREAM_ROLES', value); } catch { /* kv not writable: derive continues */ }
  }
  return describeStreamRoles(value);
}

// Incremental-derive guard. true only when the session holds a complete STREAM_ROLES artifact written
// by the CURRENT schema and classifier version. An incremental derive (derive-all) that skips the base
// stage must treat false as "stale: re-derive", otherwise a pre-role artifact would be reused silently.
export function streamRolesCurrent(session) {
  try {
    const v = session.kv.get('STREAM_ROLES', null);
    return !!v && v.schema === STREAM_ROLES_SCHEMA && !v.error
      && (v.status === 'no_streams' || v.classifier?.version === STREAM_ROLE_CLASSIFIER_VERSION);
  } catch { return false; }
}

// Runs the stream-map engine on each response stream and
// writes kv STREAM_COMPONENTS. Returns the one-line receipt entry. Never throws.
async function streamComponents(session, profile, { componentsImpl, wide }) {
  let value;
  try {
    if (wide.error) throw wide.error;
    const reducer = wide.reducer;
    const eventsBySid = new Map();
    for (const s of reducer.streams.values()) {
      if (s.kind === 'ws') continue;
      const events = reducer.eventsOf(s.sid);
      if (events.length) eventsBySid.set(s.sid, { events, omitted: s.eventsOnlyOnDisk ?? 0 });
    }
    value = eventsBySid.size
      ? buildStreamComponents(eventsBySid, { componentsImpl })
      : { schema: STREAM_COMPONENTS_SCHEMA, status: 'no_events' };
    session.kv.set('STREAM_COMPONENTS', value);
  } catch (e) {
    value = { schema: STREAM_COMPONENTS_SCHEMA, error: String(e?.message ?? e) };
    try { session.kv.set('STREAM_COMPONENTS', value); } catch { /* kv not writable: derive continues */ }
  }
  if (value.totals) {
    const t = value.totals;
    return `${t.mapped} mapped, ${t.noMap} no map, ${t.components} components, ${t.unmappedCount} unmapped events`;
  }
  return value.status ?? 'error';
}

// Stream side of each join link that has a messageIndex: the stream sid and a raw (not normalized)
// text preview of the first STREAM_PREVIEW_CHARS characters. Added here, not in join.mjs, which stays
// pure. Characters are code points, so a preview never splits a surrogate pair. Never mutates input.
const STREAM_PREVIEW_CHARS = 160;
function withStreamText(links, messages) {
  return links.map((l) => {
    if (!Number.isInteger(l.messageIndex)) return l;
    const m = messages[l.messageIndex];
    if (!m) return l;
    const chars = Array.from(typeof m.text === 'string' ? m.text : '');
    return { ...l, stream: {
      sid: m.sid ?? null,
      textPreview: chars.slice(0, STREAM_PREVIEW_CHARS).join(''),
      textLength: chars.length,
      textTruncated: chars.length > STREAM_PREVIEW_CHARS,
    } };
  });
}

// Writes <session>/acceptance.json and returns the one-line receipt entry. Never throws: a failure
// is recorded in the receipt line and derive continues.
async function acceptanceLabel(session, { acceptanceImpl }) {
  try {
    // Valid context-specific gates are not derivable from raw alone. Preserve
    // them only when readAcceptance proves raw AND DOM bindings still match;
    // the current offline evaluator refreshes G4–G7 every time.
    const previous = readAcceptance(session);
    const evaluated = await acceptanceImpl({ session, conversation: null });
    const doc = reuseAcceptedContext(previous, evaluated);
    writeAcceptance(session, doc);
    if (doc.verdict === 'unassessed') return `verdict unassessed: ${doc.reasons.join('; ')}`;
    // Consecutive gates with the same value collapse to a range, in gate order: "G4-G6 passed".
    const runs = [];
    for (const [id, g] of Object.entries(doc.gates)) {
      const last = runs.at(-1);
      if (last && last.value === g.value) last.ids.push(id);
      else runs.push({ value: g.value, ids: [id] });
    }
    const parts = runs.map((r) => `${r.ids.length > 1 ? `${r.ids[0]}-${r.ids.at(-1)}` : r.ids[0]} ${r.value}`);
    return `verdict ${doc.verdict}: ${parts.join(', ')}`;
  } catch (e) {
    return `error: ${String(e?.message ?? e)}`;
  }
}

// Metadata-only lab receipt in the format of EXPERIMENTS.md. Safe to paste into an issue:
// no payload text, no URLs beyond host, no headers.
export function buildReceipt(session, reducer, summary = reducer.summary()) {
  const m = session.meta;
  const streams = summary.streams;
  const counts = summary.transportCounts;
  const kinds = Object.keys(counts);
  const transport = kinds.includes('WEBSOCKET') && kinds.some((k) => k.startsWith('HTTP_') || k === 'EVENT_SOURCE') ? 'MIXED'
    : kinds.includes('HTTP_SSE') || kinds.includes('HTTP_NDJSON') || kinds.includes('HTTP_STREAMED') ? 'HTTP_FETCH'
      : kinds.includes('EVENT_SOURCE') ? 'EVENT_SOURCE' : kinds.includes('WEBSOCKET') ? 'WEBSOCKET' : 'UNKNOWN';
  const armed = streams.filter((s) => s.armed === 'stream');
  const armedWithData = armed.filter((s) => s.bytes > 0);
  const armFailed = streams.filter((s) => s.armError);
  const streaming = streams.filter((s) => ['HTTP_SSE', 'HTTP_NDJSON', 'HTTP_STREAMED', 'EVENT_SOURCE', 'WEBSOCKET'].includes(s.transport));
  const chunks = streams.reduce((a, s) => a + (s.chunks || s.frames || 0), 0);
  const bytes = streams.reduce((a, s) => a + s.bytes, 0);
  const start = reducer.run?.t ?? null;
  const firstByte = Math.min(...streaming.map((s) => s.firstChunkT ?? Infinity));
  const last = Math.max(...streaming.map((s) => s.endT ?? s.lastChunkT ?? -Infinity));
  const lost = reducer.gaps.reduce((a, g) => a + (g.droppedRecords ?? 0), 0);
  const incomplete = streams.filter((s) => s.status === 'incomplete_at_stop').length;
  const verdict = !streams.length ? 'BLOCKED' : armedWithData.length && !lost ? 'A1_RAW_CAPTURE_VIABLE' : armedWithData.length ? 'A1_PARTIAL' : 'A1_UNAVAILABLE';
  let host = '';
  try { host = new URL(m.target?.url).hostname; } catch { /* ignore */ }
  return {
    date_utc: new Date(m.createdAt ?? Date.now()).toISOString(),
    windows_version_observed: m.os ?? 'unknown',
    chrome_version_observed: m.browser ?? 'unknown',
    collector_source_sha: m.collector?.sourceSha ?? collectorSourceSha(),
    attachment_method_and_scope: `CDP flatten session on one user-selected tab (${host}); profile ${m.profile?.name}@v${m.profile?.version}; Network.* observation only, no Fetch interception`,
    actual_response_transport: transport,
    transport_counts: counts,
    cdp_stream_resource_content: armedWithData.length ? 'SUPPORTED_AND_DATA' : armed.length ? 'NO_DATA' : armFailed.length ? 'ERROR' : 'NOT_TESTED',
    stream_resource_content_detail: { armed: armed.length, armed_with_data: armedWithData.length, arm_failed: armFailed.length, buffered_prefix_bytes: streams.reduce((a, s) => a + s.preBytes, 0) },
    raw_chunks_received: chunks,
    raw_bytes_received: bytes,
    first_byte_observed_ms: Number.isFinite(firstByte) && start ? firstByte - start : null,
    first_local_durable_write_ms: 'see raw manifest; writes batched at <=50 ms, fsync <=1 s',
    last_response_or_terminal_ms: Number.isFinite(last) && start ? last - start : null,
    final_visible_text_matches_decoded_payload: 'see studio correlation suggestions (kind=correlation / uncorrelated_ui)',
    replay_and_gap_diagnostics: { gap_records: reducer.gaps.length, dropped_records: lost, streams_incomplete_at_stop: incomplete, coverage_note: 'streams in flight before attach are not observed' },
    data_retained_locally: 'YES',
    other_account_or_sensitive_data_collected: 'NO (credential policy: cookies/auth headers dropped, auth endpoints metadata-only, in-body tokens masked)',
    live_evidence_reference_private_or_redacted: `local session ${m.id}`,
    verdict,
    verdict_scope: 'Describes only this capture experiment: the browser build, tab, profile and responses observed in this session. It does not certify other sites, other transports, continuous capture, or completeness of server-side data.',
  };
}

function listFamilyDatasets(session) {
  try { return readdirSync(path.join(session.dir, 'datasets')).filter((f) => f.startsWith('family-') && f.endsWith('.jsonl')).map((f) => f.slice(0, -6)); } catch { return []; }
}

// Raw bytes of one stream reassembled from disk, with the chunk map.
// Uses the per-stream locator and seek index when present (whole segments are skipped), and
// falls back to an ordered full scan when the session has no index.
export async function streamBytes(session, sid) {
  const parts = [], map = [];
  let offset = 0;
  const iter = typeof session.streamRecords === 'function' ? session.streamRecords(sid) : session.records();
  for await (const r of iter) {
    if (r.sid !== sid) continue;
    if (r.k === 'chunk' || r.k === 'body') {
      const b = Buffer.from(r.b64 ?? '', 'base64');
      parts.push(b); map.push({ seq: r.seq, t: r.t, offset, length: b.length, pre: !!r.pre, retrospective: r.k === 'body', redactions: r.redactions });
      offset += b.length;
    } else if (r.k === 'ws.frame') {
      const b = r.opcode === 2 ? Buffer.from(r.payload ?? '', 'base64') : Buffer.from(r.payload ?? '', 'utf8');
      parts.push(b); map.push({ seq: r.seq, t: r.t, offset, length: b.length, dir: r.dir, opcode: r.opcode });
      offset += b.length;
    }
  }
  return { bytes: Buffer.concat(parts), map };
}

// Time travel: state of streams, assembled content and visible DOM blocks at wall time t.
export async function stateAt(session, t, profile) {
  const reducer = new StreamReducer({ deltaDialect: profile?.decode?.delta ?? 'auto', keepEvents: false });
  for await (const r of session.records({ toT: t })) { if (r.t > t) break; reducer.ingest(r); }
  const s = reducer.summary();
  return {
    t, streams: s.streams.map((x) => ({ sid: x.sid, endpoint: `${x.method ?? ''} ${templateUrl(x.url)}`, status: x.status, bytes: x.bytes, events: x.events, transport: transportOf(x), transportDetail: x.transportDetail, assembledTexts: reducer.assembled(x.sid)?.texts?.slice(0, 3) })),
    dom: [...reducer.dom.blocks.values()].filter((b) => !b.removed).slice(-200),
    actions: reducer.actions.slice(-20), nav: reducer.nav.slice(-5), gaps: reducer.gaps,
  };
}

// Re-decode ONE stream from raw bytes, independently of any other stream. Cheap enough to run
// interactively (the stream locator skips every segment the stream does not appear in) and the
// single place that answers "what exactly did this endpoint send, and what did we make of it".
// useLocator=false bypasses the per-stream locator (streams.json is only rewritten when a segment
// closes, so it can lag behind a live recording) and scans from fromSeq instead.
export async function reconstructStream(session, sid, { profile, dialect, limitEvents = 2000, useLocator = true, fromSeq = 0, deltaOpsLog = 200 } = {}) {
  const reducer = new StreamReducer({
    deltaDialect: dialect ?? profile?.decode?.delta ?? 'auto',
    keepEvents: true, maxEventsPerStream: limitEvents, deltaOpsLog,
  });
  const iter = useLocator && typeof session.streamRecords === 'function' ? session.streamRecords(sid) : session.records(fromSeq > 0 ? { fromSeq } : {});
  let records = 0;
  for await (const r of iter) {
    if (r.sid !== sid && !['run.start', 'run.end'].includes(r.k)) continue;
    reducer.ingest(r);
    records++;
  }
  const stream = reducer.summary().streams.find((s) => s.sid === sid) ?? null;
  const delta = reducer.deltaOf(sid);
  return {
    sid, records, stream,
    events: reducer.eventsOf(sid),
    assembled: reducer.assembled(sid),
    deltaStats: delta?.stats() ?? null,
    opsLog: delta?.opsLog ?? [],
    decoder: reducer.decoderOf(sid),
  };
}

// Human-visible text of one stream, reconstructed from raw bytes.
export async function streamText(session, sid, opts = {}) {
  const r = await reconstructStream(session, sid, opts);
  const texts = r.assembled?.texts ?? [];
  const fromEvents = r.events.filter((e) => typeof e.text === 'string' && e.text.length > 0).map((e) => e.text);
  return {
    sid,
    assembledText: texts[0]?.text ?? null,
    assembledPath: texts[0]?.path ?? null,
    revisions: r.assembled?.revisions ?? 0,
    blocks: r.assembled?.blocks ?? [],
    eventTextChars: fromEvents.reduce((a, s) => a + s.length, 0),
  };
}

export async function search(sessions, query, { limit = 100 } = {}) {
  const q = String(query).toLowerCase();
  const hits = [];
  for (const session of sessions) {
    for await (const ev of session.dataset('events').iterate()) {
      const hay = typeof ev.data === 'string' ? ev.data : typeof ev.text === 'string' ? ev.text : ev.json !== undefined ? JSON.stringify(ev.json) : '';
      const i = hay.toLowerCase().indexOf(q);
      if (i >= 0) { hits.push({ session: session.id, layer: 'L2', sid: ev.sid, seq: ev.seq, t: ev.t, snippet: hay.slice(Math.max(0, i - 60), i + 100) }); if (hits.length >= limit) return hits; }
    }
    for (const b of session.kv.get('DOM_BLOCKS', []) ?? []) {
      const i = (b.text ?? '').toLowerCase().indexOf(q);
      if (i >= 0) { hits.push({ session: session.id, layer: 'L3', domId: b.id, t: b.lastT, snippet: b.text.slice(Math.max(0, i - 60), i + 100) }); if (hits.length >= limit) return hits; }
    }
  }
  return hits;
}

// The five categories the owner must be able to tell apart. Counts only; no content.
export function fidelityBreakdown(reducer, summary, rawRecords) {
  const streams = summary.streams;
  const redactedStreams = streams.filter((s) => s.redactions > 0);
  const protectedBy = {};
  for (const s of streams) if (s.bodyExcluded) protectedBy[s.bodyExcluded] = (protectedBy[s.bodyExcluded] ?? 0) + 1;
  const pausedNot = (reducer.paused ?? []).reduce((a, p) => a + Object.values(p.notCaptured ?? {}).reduce((x, y) => x + y, 0), 0);
  return {
    original: { streams_with_body: streams.filter((s) => s.bytes > 0).length, bytes: streams.reduce((a, s) => a + s.bytes, 0), raw_records: rawRecords, note: 'byte-faithful as delivered by the browser, except masked spans below' },
    transformed: { streams: redactedStreams.length, masked_spans: redactedStreams.reduce((a, s) => a + s.redactions, 0), note: 'credential-like values overwritten in place with *; offsets preserved; each mask recorded on its chunk' },
    protected: { metadata_only_streams: Object.values(protectedBy).reduce((a, b) => a + b, 0), by_reason: protectedBy, note: 'deliberately not captured: credential policy, profile exclusions, resource types; request/response metadata kept' },
    derived: { decoded_events: streams.reduce((a, s) => a + s.events, 0), assembled_streams: streams.filter((s) => s.deltaRevisions > 0).length, note: 'recomputable from raw at any time' },
    lost_or_unobserved: { gap_records: reducer.gaps.length, dropped_records: reducer.gaps.reduce((a, g) => a + (g.droppedRecords ?? 0), 0), streams_incomplete_at_stop: streams.filter((s) => s.status === 'incomplete_at_stop').length, streams_interrupted: streams.filter((s) => s.interrupted).length, paused_records_not_captured: pausedNot, retrospective_only_streams: streams.filter((s) => s.retrospective).length, note: 'plus anything opened before attach, which cannot be counted' },
  };
}
