// Full offline derivation. Raw records are read-only; every stage is recomputable.
import { derive, streamRolesCurrent } from './derive.mjs';
import { CorpusSearchIndex, primeFuzzySearch, highlightSpans } from '../intel/search.mjs';
import { rankGraphNodes } from '../intel/graph.mjs';
import { OnlineSchemaProfiler, toJsonSchema } from '../shapes/profiler.mjs';
import { RevisionAccumulator } from '../intel/history.mjs';

const STAGES = Object.freeze(['base', 'search-index', 'graph-ranked', 'schemas', 'stream-timelines', 'revisions']);
const MANIFEST_KEY = 'DERIVE_MANIFEST';
const TEXT_CAP = 4000;
const TIMELINE_CAP = 400;

const HANDLERS = {
  base: stageBase,
  'search-index': stageSearch,
  'graph-ranked': stageGraph,
  schemas: stageSchemas,
  'stream-timelines': stageTimelines,
  revisions: stageRevisions,
};

function emit(onStage, stage, detail = {}) {
  if (typeof onStage !== 'function') return;
  const event = { stage, name: stage, ...detail };
  onStage(event, detail);
}

function clip(text, n = TEXT_CAP) {
  const s = String(text ?? '');
  return s.length > n ? s.slice(0, n) : s;
}

function readKv(session, key) {
  try { return session.kv.get(key, null); } catch { return null; }
}

async function readDataset(session, name) {
  const ds = session.dataset(name);
  if (!ds.exists()) return null;
  return ds.toArray();
}

function writeDataset(session, name, rows) {
  const ds = session.dataset(name);
  ds.reset();
  if (rows.length) ds.push(rows);
  return rows.length;
}

async function rawCount(session) {
  try {
    const stats = session.rawStats?.();
    if (stats && Number.isFinite(stats.records) && stats.records > 0) return stats.records;
  } catch { /* count the log instead */ }
  let n = 0;
  if (typeof session.records === 'function') for await (const _ of session.records()) n++;
  return n;
}

function entityText(entity) {
  const parts = [entity.typeName, entity.type, entity.key, entity.eid];
  if (entity.attrs && typeof entity.attrs === 'object') {
    for (const [key, value] of Object.entries(entity.attrs)) {
      parts.push(key, typeof value === 'string' ? value : JSON.stringify(value));
    }
  }
  return clip(parts.filter((part) => part != null && part !== '').join(' '));
}

function eventText(ev) {
  if (typeof ev.text === 'string' && ev.text) return clip(ev.text);
  if (typeof ev.data === 'string' && ev.data) return clip(ev.data);
  if (ev.json !== undefined) {
    try { return clip(JSON.stringify(ev.json)); } catch { return ''; }
  }
  return '';
}

async function stageBase(session, profile, onStage) {
  const result = await derive(session, profile, {
    onProgress: (records) => emit(onStage, 'base', { status: 'progress', records }),
  });
  return {
    records: result.records ?? 0,
    datasets: session.datasets().map((d) => d.name),
    ...(result.knowledge?.error ? { knowledgeError: result.knowledge.error } : {}),
  };
}

async function stageSearch(session) {
  const index = new CorpusSearchIndex();
  let records = 0;
  let entities = 0;
  for await (const entity of session.dataset('entities').iterate()) {
    const text = entityText(entity);
    if (!text) continue;
    const source = { layer: 'entities', eid: entity.eid ?? null, kind: 'entity', typeName: entity.typeName ?? null };
    index.add(String(entity.eid ?? `entity:${entities}`), { source }, { text, source, boost: 1.2 });
    entities++;
    records++;
  }
  let events = 0;
  for await (const ev of session.dataset('events').iterate()) {
    const text = eventText(ev);
    if (!text) continue;
    const source = { layer: 'events', sid: ev.sid ?? null, seq: ev.seq ?? null, t: ev.t ?? null };
    index.add(`event:${ev.sid ?? ''}:${ev.seq ?? ''}:${events}`, { source }, { text, source, boost: 1 });
    events++;
    records++;
  }
  const blocks = session.kv.get('DOM_BLOCKS', []) ?? [];
  if (Array.isArray(blocks)) {
    let dom = 0;
    for (const block of blocks) {
      const text = clip(block?.text ?? '');
      if (!text) continue;
      const source = { layer: 'dom', domId: block.id ?? dom, t: block.lastT ?? block.firstT ?? null };
      index.add(`dom:${block.id ?? dom}`, { source }, { text, source, boost: 1 });
      dom++;
      records++;
    }
  }
  const rows = index.toRows({ includeDocument: true });
  writeDataset(session, 'search-index', rows);
  return { records, datasets: ['search-index'] };
}

async function stageGraph(session) {
  const graph = session.kv.get('GRAPH', null) ?? { nodes: [], edges: [] };
  const ranked = rankGraphNodes(graph);
  const meta = new Map((graph.nodes ?? []).map((node) => [node.eid, node]));
  const nodes = ranked.map((item, index) => ({
    rank: index + 1, eid: item.eid, score: item.score, typeName: meta.get(item.eid)?.typeName ?? null,
  }));
  const artifact = { algorithm: 'confidence-weighted-pagerank', nodes };
  session.kv.set('GRAPH_RANKED', artifact);
  writeDataset(session, 'graph-ranked', nodes);
  return { records: nodes.length, datasets: ['graph-ranked'] };
}

async function stageSchemas(session) {
  const endpoints = new Map();
  for await (const stream of session.dataset('streams').iterate()) {
    if (stream?.sid) endpoints.set(stream.sid, stream.endpoint ?? stream.url ?? stream.sid);
  }
  const profiler = new OnlineSchemaProfiler();
  let records = 0;
  for await (const entity of session.dataset('entities').iterate()) {
    const value = entity.attrs && typeof entity.attrs === 'object' ? entity.attrs : null;
    if (!value) continue;
    profiler.observe(`entity:${entity.typeName ?? entity.type ?? 'unknown'}`, value, {
      session: session.id, t: entity.first ?? entity.last ?? null,
    });
    records++;
  }
  for await (const ev of session.dataset('events').iterate()) {
    const value = ev.json && typeof ev.json === 'object' ? ev.json : null;
    if (!value) continue;
    profiler.observe(`event:${endpoints.get(ev.sid) ?? ev.sid ?? 'unknown'}`, value, {
      session: session.id, sid: ev.sid, seq: ev.seq, t: ev.t,
    });
    records++;
  }
  const report = profiler.report();
  const groups = report.groups.map((group) => ({
    id: group.group,
    group: group.group,
    name: group.group,
    observations: group.observations,
    schema: group.schema,
    jsonSchema: toJsonSchema(group.schema),
    drift: group.drift,
    source: group.source,
  }));
  const artifact = { groups, evictedGroups: report.evictedGroups, windowSize: report.windowSize, minWindow: report.minWindow };
  session.kv.set('SCHEMAS', artifact);
  writeDataset(session, 'schemas', groups);
  return { records, datasets: ['schemas'] };
}

async function stageTimelines(session) {
  const meta = new Map();
  for await (const stream of session.dataset('streams').iterate()) if (stream?.sid) meta.set(stream.sid, stream);
  const rows = new Map();
  let records = 0;
  for await (const ev of session.dataset('events').iterate()) {
    const sid = ev?.sid ?? 'unknown';
    let row = rows.get(sid);
    if (!row) {
      const stream = meta.get(sid) ?? {};
      row = {
        sid, endpoint: stream.endpoint ?? null, transport: stream.transport ?? null,
        count: 0, t0: null, t1: null, points: [], truncated: false,
      };
      rows.set(sid, row);
    }
    row.count++;
    records++;
    if (Number.isFinite(ev.t)) {
      row.t0 = row.t0 == null ? ev.t : Math.min(row.t0, ev.t);
      row.t1 = row.t1 == null ? ev.t : Math.max(row.t1, ev.t);
    }
    if (row.points.length < TIMELINE_CAP) row.points.push({ t: ev.t ?? null, seq: ev.seq ?? null, kind: ev.event ?? ev.type ?? ev.protocol ?? null });
    else row.truncated = true;
  }
  for (const [sid, stream] of meta) {
    if (rows.has(sid)) continue;
    rows.set(sid, {
      sid, endpoint: stream.endpoint ?? null, transport: stream.transport ?? null,
      count: 0, t0: stream.startedT ?? null, t1: stream.endT ?? null, points: [], truncated: false,
    });
  }
  const streams = [...rows.values()].sort((a, b) => String(a.sid).localeCompare(String(b.sid)));
  writeDataset(session, 'timelines', streams);
  session.kv.set('TIMELINES', { streams });
  return { records, datasets: ['timelines'] };
}

async function stageRevisions(session) {
  const rows = [];
  for await (const entity of session.dataset('entities').iterate()) {
    const revisions = Array.isArray(entity.revisions) ? entity.revisions : [];
    const acc = RevisionAccumulator.from(revisions);
    rows.push({
      eid: entity.eid ?? null,
      type: entity.type ?? null,
      typeName: entity.typeName ?? null,
      summary: acc.summary(),
      state: revisions.length ? acc.state : (entity.attrs ?? {}),
    });
  }
  if (!rows.length) {
    const nodes = session.kv.get('GRAPH', null)?.nodes ?? [];
    for (const node of nodes) {
      const acc = RevisionAccumulator.from(node.history ?? []);
      rows.push({ eid: node.eid ?? null, typeName: node.typeName ?? null, summary: acc.summary(), state: acc.state });
    }
  }
  writeDataset(session, 'revisions', rows);
  session.kv.set('REVISIONS', { entities: rows });
  return { records: rows.length, datasets: ['revisions'] };
}

export async function deriveAll(session, { profile, incremental = true, stages, onStage } = {}) {
  const requested = Array.isArray(stages) && stages.length ? stages : [...STAGES];
  const unknown = requested.filter((name) => !STAGES.includes(name));
  if (unknown.length) throw new Error(`Unknown derivation stage "${unknown[0]}"`);
  const selected = new Set(requested);
  const cursor = await rawCount(session);
  const prev = readKv(session, MANIFEST_KEY);
  const done = new Set((prev?.stages ?? []).filter((stage) => stage && !stage.error).map((stage) => stage.name));
  const meta = (() => { try { return session.meta ?? {}; } catch { return {}; } })();
  const ENDED_STATUSES = new Set(['stopped', 'closed', 'done', 'complete', 'complete_with_integrity_warnings', 'failed']);
  const endedAt = meta.endedAt ?? meta.ended_at ?? meta.endT ?? meta.endedT ?? null;
  // A session that is still recording keeps growing: its record count is not a stable cursor.
  const stillRecording = !ENDED_STATUSES.has(String(meta.status ?? '')) || endedAt == null;
  // The base stage writes kv STREAM_ROLES. A manifest from before the role pass (or from an older
  // classifier / schema, or after a failed role pass) has a matching cursor but a stale or missing
  // role artifact; it must not be skipped. Only matters when the base stage is part of this run.
  const rolesStale = selected.has('base') && !streamRolesCurrent(session);
  const fresh = !!incremental && prev?.version === 1 && prev.cursor === cursor && prev.ok !== false && !stillRecording && !rolesStale;
  const plan = STAGES.filter((name) => selected.has(name) && !(fresh && done.has(name)));
  const stageResults = new Map((prev?.stages ?? []).filter((stage) => stage?.name).map((stage) => [stage.name, stage]));

  if (!plan.length) {
    for (const name of STAGES) if (selected.has(name)) emit(onStage, name, { status: 'skipped', records: stageResults.get(name)?.records ?? 0 });
    const loaded = await loadArtifacts(session);
    return { manifest: prev, artifacts: loaded?.artifacts ?? {} };
  }

  const errors = [];
  for (const name of plan) {
    const started = Date.now();
    emit(onStage, name, { status: 'start' });
    try {
      const out = await HANDLERS[name](session, profile, onStage);
      const row = {
        name, ms: Date.now() - started, records: out.records ?? 0, datasets: out.datasets ?? [],
        ...(out.knowledgeError ? { knowledgeError: out.knowledgeError } : {}),
      };
      stageResults.set(name, row);
      emit(onStage, name, { status: 'done', ms: row.ms, records: row.records });
    } catch (error) {
      const row = { name, ms: Date.now() - started, records: 0, datasets: [], error: String(error?.message ?? error) };
      stageResults.set(name, row);
      errors.push(row.error);
      emit(onStage, name, { status: 'error', message: row.error });
    }
  }
  for (const name of STAGES) {
    if (selected.has(name) && !plan.includes(name)) emit(onStage, name, { status: 'skipped', records: stageResults.get(name)?.records ?? 0 });
  }

  const plannedOk = plan.every((name) => !stageResults.get(name)?.error);
  const nextCursor = plannedOk && (plan.includes('base') || prev?.cursor === cursor) ? cursor : (prev?.cursor ?? null);
  const finalStages = STAGES.map((name) => stageResults.get(name)).filter(Boolean);
  const ok = !finalStages.some((stage) => stage && stage.error);
  const manifest = {
    version: 1,
    derivedAt: new Date().toISOString(),
    cursor: nextCursor,
    ok,
    status: ok ? 'complete' : 'partial',
    stages: finalStages,
    datasets: session.datasets().map((d) => d.name),
    ...(ok ? {} : { error: (finalStages.find((stage) => stage?.error)?.error ?? errors[0] ?? null) }),
  };
  session.kv.set(MANIFEST_KEY, manifest);
  const loaded = await loadArtifacts(session);
  return { manifest, artifacts: loaded?.artifacts ?? {} };
}

export async function loadArtifacts(session) {
  const manifest = readKv(session, MANIFEST_KEY);
  const searchIndex = await readDataset(session, 'search-index');
  const graphRanked = readKv(session, 'GRAPH_RANKED') ?? await readDataset(session, 'graph-ranked');
  const schemas = readKv(session, 'SCHEMAS') ?? await readDataset(session, 'schemas');
  const timelines = readKv(session, 'TIMELINES') ?? await readDataset(session, 'timelines');
  const revisions = readKv(session, 'REVISIONS') ?? await readDataset(session, 'revisions');
  if ([manifest, searchIndex, graphRanked, schemas, timelines, revisions].every((value) => value == null)) return null;
  return {
    manifest,
    artifacts: {
      searchIndex, graphRanked, schemas, timelines, revisions,
      rankedGraph: graphRanked, ranked: graphRanked,
      model: readKv(session, 'MODEL'),
    },
  };
}

export async function searchSession(session, query, { limit = 20, fuzzy = true } = {}) {
  const rows = await readDataset(session, 'search-index');
  if (!rows?.length) return [];
  const cap = Number.isInteger(limit) && limit > 0 ? limit : 20;
  if (fuzzy) await primeFuzzySearch().catch(() => false);
  return CorpusSearchIndex.fromRows(rows).search(String(query ?? ''), { limit: cap, fuzzy }).map((hit) => {
    const source = hit.source ?? hit.document?.source ?? {};
    const layer = source.layer ?? (source.domId != null ? 'dom' : 'events');
    const eid = source.eid ?? (layer === 'entities' ? hit.id : undefined);
    const ref = eid ?? (source.sid != null ? source.sid : null) ?? (source.domId != null ? `dom:${source.domId}` : hit.id);
    const matched = hit.matched ?? hit.matchedTerms ?? [];
    const fuzzyMatched = hit.fuzzyMatched ?? [];
    const snippet = hit.snippet ?? '';
    return {
      ...(eid != null ? { eid } : {}),
      ref, score: hit.score, snippet, layer, id: hit.id, source, document: hit.document ?? null,
      matched: [...matched], fuzzyMatched: fuzzyMatched.map((entry) => ({ ...entry })),
      snippetDetail: { text: snippet, highlights: highlightSpans(snippet, [...matched, ...fuzzyMatched.map((entry) => entry.to)]) },
    };
  });
}
