// Read-only platform views over a saved session. Never throws: missing data is an empty shape.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { VERSION, dataPaths, defaultDataDir, resolveSettings } from '../config.mjs';
import { csvToObjects, headerLikelihood, parseCsv, sniffDelimiter } from '../decode/csv.mjs';
import { detectContent } from './autodetect.mjs';
import { betweenness, communities, components, graphAnalytics, pagerank, topK } from './graph-analytics.mjs';
import { lshClusters, rake, simhash } from './rank.mjs';
import { migrations } from '../profiles/migrations.mjs';
import { registry } from '../plugins/registry.mjs';
import { loadArtifacts } from '../replay/derive-all.mjs';
import { detectSecrets, registerPatterns } from '../security/patterns.mjs';
import { verifyManifest } from '../store/integrity.mjs';
import { Session, listSessions } from '../store/session.mjs';

const TEXT_FIELD = /text|content|body|message|prompt|response|caption|title|html|markdown|transcript/i;
const FORMAT_NAMES = Object.freeze(['json', 'ndjson', 'sse', 'csv', 'html', 'xml', 'yaml']);
const BUILTIN_MIGRATION = 'builtin:v1->v2';

let builtinsReady = false;

function emptyGraph() {
  return { nodes: [], edges: [] };
}

function emptyDedupe() {
  return { scanned: 0, clusters: [], stats: { items: 0, clusters: 0, itemsInClusters: 0, wastedShare: 0 } };
}

function emptyAnalysis() {
  return {
    stats: { nodes: 0, edges: 0, density: 0, components: 0, communities: 0, largestComponent: 0 },
    pagerank: { ranked: [], iterations: 0, converged: true },
    betweenness: { ranked: [], sampled: false },
    communities: [],
    components: [],
  };
}

function emptyDetect(text = '') {
  return {
    format: 'text',
    encoding: 'utf-8',
    hasBOM: false,
    newline: 'none',
    delimiter: null,
    candidates: [],
    evidence: [],
    text: String(text ?? '').slice(0, 2000),
    securityScan: { counts: {}, matches: [] },
  };
}

function emptyCsv() {
  return { delimiter: null, header: [], records: [], stats: { rows: 0, columns: 0 }, headerScore: { isHeader: false, score: 0 } };
}

function emptyStats(dataDir = '') {
  return {
    schema: 'capture-studio.platform-stats/1',
    version: typeof VERSION === 'string' ? VERSION : '',
    schemaVersion: 2,
    dataDir,
    sessions: 0,
    integrity: { checked: 0, ok: 0, failed: 0 },
    knowledge: { sessions: 0, derived: 0, failed: 0, entities: 0, types: 0 },
    migrations: migrationNames(),
  };
}

function limitOf(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.floor(n));
}

function tokenize(input) {
  const tokens = [];
  for (const token of String(input ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (token) tokens.push(token);
  }
  return tokens;
}

function kvGet(session, key) {
  try {
    if (typeof session?.kv?.get !== 'function') return null;
    return session.kv.get(key, null);
  } catch {
    return null;
  }
}

function sidOf(entity) {
  const sid = entity?.anchor?.sid ?? entity?.sid ?? entity?.occurrences?.[0]?.sid ?? null;
  return sid == null || sid === '' ? null : String(sid);
}

function entityText(entity) {
  if (!entity || typeof entity !== 'object') return '';
  if (typeof entity.text === 'string' && entity.text.trim().length >= 8) return entity.text.trim();
  const attrs = entity.attrs && typeof entity.attrs === 'object'
    ? entity.attrs
    : entity.state && typeof entity.state === 'object'
      ? entity.state
      : null;
  if (!attrs) return '';
  const preferred = [];
  let longest = '';
  for (const [key, value] of Object.entries(attrs)) {
    if (typeof value !== 'string') continue;
    const text = value.trim();
    if (text.length < 8) continue;
    if (TEXT_FIELD.test(key)) preferred.push(text);
    if (text.length > longest.length) longest = text;
  }
  if (preferred.length) return preferred.join('\n');
  return longest;
}

function pushText(rows, seen, row, max) {
  const text = String(row?.text ?? '').trim();
  if (text.length < 8 || rows.length >= max) return;
  let id = String(row.id ?? `t${rows.length + 1}`);
  if (seen.has(id)) id = `${id}#${seen.size + 1}`;
  seen.add(id);
  rows.push({ id, sid: row.sid == null || row.sid === '' ? null : String(row.sid), text });
}

function modelEntities(model) {
  if (!model || typeof model !== 'object' || model.error) return [];
  if (Array.isArray(model.entities)) return model.entities;
  const out = [];
  if (Array.isArray(model.types)) {
    for (const type of model.types) {
      if (Array.isArray(type?.entities)) out.push(...type.entities);
      if (Array.isArray(type?.instances)) out.push(...type.instances);
    }
  }
  return out;
}

async function savedModel(session) {
  if (session?.artifacts?.model) return session.artifacts.model;
  if (session?.model && typeof session.model === 'object' && !session.kv) return session.model;
  if (typeof session?.kv?.get === 'function') {
    try {
      const loaded = await loadArtifacts(session);
      if (loaded?.artifacts?.model) return loaded.artifacts.model;
    } catch { /* kv fallback */ }
    return kvGet(session, 'MODEL');
  }
  return null;
}

async function datasetEntities(session, max) {
  const rows = [];
  const seen = new Set();
  if (typeof session?.dataset !== 'function') return rows;
  let ds;
  try { ds = session.dataset('entities'); } catch { return rows; }
  if (!ds?.exists?.()) return rows;
  try {
    for await (const entity of ds.iterate()) {
      pushText(rows, seen, { id: entity?.eid ?? entity?.id ?? `e${rows.length + 1}`, sid: sidOf(entity), text: entityText(entity) }, max);
      if (rows.length >= max) break;
    }
  } catch { /* unreadable dataset */ }
  return rows;
}

function domAndAssembled(session, max) {
  const rows = [];
  const seen = new Set();
  const turns = kvGet(session, 'DOM_TURNS');
  if (Array.isArray(turns)) {
    turns.forEach((turn, index) => {
      pushText(rows, seen, { id: turn?.id ?? `dom:${index}`, sid: turn?.sid ?? null, text: turn?.text ?? '' }, max);
    });
  }
  const assembled = kvGet(session, 'ASSEMBLED');
  if (assembled && typeof assembled === 'object' && !Array.isArray(assembled)) {
    for (const [sid, entry] of Object.entries(assembled)) {
      const found = [];
      collectStrings(entry?.doc ?? entry?.text ?? entry, found, 0);
      found.sort((a, b) => b.length - a.length);
      pushText(rows, seen, { id: sid, sid, text: found[0] ?? '' }, max);
      if (rows.length >= max) break;
    }
  }
  return rows;
}

function collectStrings(value, out, depth) {
  if (out.length >= 40 || depth > 6 || value == null) return;
  if (typeof value === 'string') {
    if (value.trim().length >= 8) out.push(value.trim());
    return;
  }
  if (typeof value !== 'object') return;
  const list = Array.isArray(value) ? value : Object.values(value);
  for (const item of list) collectStrings(item, out, depth + 1);
}

function idOfNode(node) {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (!node || typeof node !== 'object') return null;
  const raw = node.eid ?? node.id ?? node.name ?? null;
  return raw == null || raw === '' ? null : String(raw);
}

function graphFromValue(value) {
  if (!value || typeof value !== 'object') return null;
  const sourceNodes = value.nodes ?? value.graph?.nodes;
  const sourceEdges = value.edges ?? value.graph?.edges;
  if (!sourceNodes && !sourceEdges) return null;
  const nodes = [];
  const seen = new Set();
  for (const node of Array.isArray(sourceNodes) ? sourceNodes : []) {
    const id = idOfNode(node);
    if (id == null || seen.has(id)) continue;
    seen.add(id);
    nodes.push(id);
  }
  const edges = [];
  for (const edge of Array.isArray(sourceEdges) ? sourceEdges : []) {
    if (!edge || typeof edge !== 'object' || edge.status === 'rejected') continue;
    const from = idOfNode(edge.from ?? edge.source);
    const to = idOfNode(edge.to ?? edge.target);
    if (from == null || to == null) continue;
    if (!seen.has(from)) { seen.add(from); nodes.push(from); }
    if (!seen.has(to)) { seen.add(to); nodes.push(to); }
    const raw = edge.weight !== undefined ? edge.weight : edge.confidence;
    const weight = typeof raw === 'number' ? raw : Number(raw);
    edges.push({ from, to, weight: Number.isFinite(weight) && weight >= 0 ? weight : 1 });
  }
  nodes.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  edges.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : a.to < b.to ? -1 : a.to > b.to ? 1 : 0));
  return { nodes, edges };
}

function sized(groups) {
  return groups.map((members) => ({ size: members.length, members: members.slice(0, 50) }));
}

function newlineOf(text) {
  let lf = 0;
  let crlf = 0;
  let cr = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\r') {
      if (text[i + 1] === '\n') { crlf++; i++; }
      else cr++;
    } else if (ch === '\n') lf++;
  }
  const kinds = (lf > 0 ? 1 : 0) + (crlf > 0 ? 1 : 0) + (cr > 0 ? 1 : 0);
  if (kinds === 0) return 'none';
  if (kinds > 1 || cr > 0) return 'mixed';
  return crlf > 0 ? 'crlf' : 'lf';
}

function hasBom(text, evidence) {
  if (String(text).charCodeAt(0) === 0xfeff) return true;
  return (evidence ?? []).some((item) => String(item).startsWith('bom:'));
}

function csvDelimiter(kind, evidence, text) {
  if (kind !== 'csv') return null;
  const tag = (evidence ?? []).find((item) => String(item).startsWith('csv:'));
  if (tag === 'csv:tab') return '\t';
  if (typeof tag === 'string' && tag.length > 4) return tag.slice(4);
  try { return sniffDelimiter(text).delimiter ?? null; } catch { return null; }
}

function migrationNames() {
  try {
    if (typeof migrations?.list === 'function') {
      const listed = migrations.list();
      if (Array.isArray(listed)) return listed.map(String);
    }
    if (migrations && (migrations.currentVersion === 2 || migrations.currentVersion == null)) return [BUILTIN_MIGRATION];
  } catch { /* no public name list */ }
  return [];
}

function ensureBuiltins() {
  if (builtinsReady) return;
  registerPatterns(registry);
  for (const name of FORMAT_NAMES) {
    if (!registry.has('formats', name)) {
      registry.register('formats', name, { format: name }, { builtin: true, meta: { format: name, pii: false } });
    }
  }
  builtinsReady = true;
}

function layoutOf(input) {
  let env = process.env;
  let flags = {};
  let explicit = null;
  if (typeof input === 'string') explicit = input;
  else if (input && typeof input === 'object') {
    if (input.env && typeof input.env === 'object') env = input.env;
    if (input.flags && typeof input.flags === 'object') flags = input.flags;
    if (typeof input.sessionsDir === 'string' && input.sessionsDir) {
      return { dataDir: path.dirname(input.sessionsDir), sessionsDir: input.sessionsDir };
    }
    explicit = input.dataDir ?? input.root ?? input.paths?.root ?? null;
  }
  const root = typeof explicit === 'string' && explicit ? explicit : defaultDataDir(env);
  const paths = dataPaths(root);
  try { resolveSettings({ configFile: input?.configFile ?? paths.config, env, flags }); } catch { /* stats do not depend on settings */ }
  return { dataDir: paths.root, sessionsDir: paths.sessions };
}

export async function sessionTexts(session, options = {}) {
  try {
    const max = limitOf(options?.max, 3000);
    if (max === 0) return [];
    const rows = [];
    const seen = new Set();
    for (const entity of modelEntities(await savedModel(session))) {
      pushText(rows, seen, { id: entity?.eid ?? entity?.id ?? `e${rows.length + 1}`, sid: sidOf(entity), text: entityText(entity) }, max);
    }
    if (!rows.length) {
      for (const row of await datasetEntities(session, max)) pushText(rows, seen, row, max);
    }
    if (!rows.length) {
      for (const row of domAndAssembled(session, max)) pushText(rows, seen, row, max);
    }
    return rows.slice(0, max);
  } catch {
    return [];
  }
}

export async function sessionGraph(session) {
  try {
    const temporal = kvGet(session, 'GRAPH') ?? session?.graph ?? session?.artifacts?.graph ?? null;
    const built = graphFromValue(temporal);
    if (built && (built.nodes.length || built.edges.length)) return built;
    let ranked = kvGet(session, 'GRAPH_RANKED') ?? session?.artifacts?.graphRanked ?? null;
    if (!ranked && typeof session?.kv?.get === 'function') {
      try {
        const loaded = await loadArtifacts(session);
        ranked = loaded?.artifacts?.graphRanked ?? null;
      } catch { ranked = null; }
    }
    return graphFromValue(ranked) ?? emptyGraph();
  } catch {
    return emptyGraph();
  }
}

export async function dedupeSession(session, options = {}) {
  try {
    const max = limitOf(options?.max, 3000);
    const threshold = Number.isFinite(Number(options?.threshold)) ? Math.min(1, Math.max(0, Number(options.threshold))) : 0.8;
    const texts = await sessionTexts(session, { max });
    const items = [];
    for (const row of texts) {
      const tokens = tokenize(row.text);
      if (!tokens.length) continue;
      items.push({ id: row.id, tokens, hash: simhash(tokens) });
    }
    items.sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const found = items.length ? lshClusters(items, { threshold }) : [];
    const clusters = found.map((members, index) => ({ id: `c${index + 1}`, members, size: members.length }));
    const itemsInClusters = clusters.reduce((sum, cluster) => sum + cluster.size, 0);
    const itemCount = items.length;
    return {
      scanned: texts.length,
      clusters,
      stats: {
        items: itemCount,
        clusters: clusters.length,
        itemsInClusters,
        wastedShare: itemCount ? (itemsInClusters - clusters.length) / itemCount : 0,
      },
    };
  } catch {
    return emptyDedupe();
  }
}

export async function analyzeSessionGraph(session) {
  try {
    const graph = await sessionGraph(session);
    const analytics = graphAnalytics(graph);
    const rank = pagerank(graph.nodes, graph.edges);
    const center = betweenness(graph.nodes, graph.edges);
    const parts = components(graph.nodes, graph.edges);
    const comm = communities(graph.nodes, graph.edges);
    const n = analytics.nodes;
    const edges = analytics.edges;
    return {
      stats: {
        nodes: n,
        edges,
        density: n > 1 ? edges / (n * (n - 1)) : 0,
        components: parts.length,
        communities: comm.groups.length,
        largestComponent: parts[0]?.length ?? 0,
      },
      pagerank: { ranked: topK(rank.scores, 20), iterations: rank.iterations, converged: rank.converged },
      betweenness: { ranked: topK(center.scores, 20), sampled: center.sampled === true },
      communities: sized(comm.groups),
      components: sized(parts),
    };
  } catch {
    return emptyAnalysis();
  }
}

export async function keyphrasesSession(session, options = {}) {
  try {
    const limit = limitOf(options?.limit, 20);
    const texts = await sessionTexts(session, { max: 3000 });
    let body = '';
    for (const row of texts) {
      if (body.length >= 200000) break;
      const next = body ? `\n${row.text}` : row.text;
      body += next.slice(0, 200000 - body.length);
    }
    if (!body) return [];
    return rake(body.slice(0, 200000), { limit });
  } catch {
    return [];
  }
}

export async function detectAndScan(text) {
  const source = typeof text === 'string' ? text : text == null ? '' : String(text);
  try {
    const detected = detectContent(source) ?? {};
    const evidence = Array.isArray(detected.evidence) ? detected.evidence : [];
    const format = typeof detected.kind === 'string' ? detected.kind : 'text';
    const hits = detectSecrets(source, { extended: true, pii: true });
    const counts = {};
    const matches = [];
    for (const hit of Array.isArray(hits) ? hits : []) {
      const name = String(hit?.name ?? 'secret');
      counts[name] = (counts[name] ?? 0) + 1;
      matches.push({ kind: name, offset: Number.isFinite(hit?.start) ? hit.start : 0 });
    }
    return {
      format,
      encoding: typeof detected.charset === 'string' ? detected.charset : 'utf-8',
      hasBOM: hasBom(source, evidence),
      newline: newlineOf(source),
      delimiter: csvDelimiter(format, evidence, source),
      candidates: [{ format, confidence: Number.isFinite(detected.confidence) ? detected.confidence : 0, evidence }],
      evidence,
      text: source.slice(0, 2000),
      securityScan: { counts, matches },
    };
  } catch {
    return emptyDetect(source);
  }
}

export async function csvAnalyze(text) {
  try {
    const source = typeof text === 'string' ? text : '';
    if (!source) return emptyCsv();
    const sniffed = sniffDelimiter(source);
    const delimiter = sniffed?.delimiter || ',';
    const matrix = parseCsv(source, { delimiter });
    const score = headerLikelihood(matrix);
    const parsed = csvToObjects(source, { delimiter });
    const header = Array.isArray(parsed?.columns) ? parsed.columns : [];
    const records = Array.isArray(parsed?.rows) ? parsed.rows.slice(0, 200) : [];
    return {
      delimiter: parsed?.delimiter ?? delimiter,
      header,
      records,
      stats: { rows: Array.isArray(parsed?.rows) ? parsed.rows.length : 0, columns: header.length },
      headerScore: { isHeader: typeof score === 'number' && score >= 0.5, score: typeof score === 'number' ? score : 0 },
    };
  } catch {
    return emptyCsv();
  }
}

export async function platformStats(dataDirOrCtx) {
  let layout = { dataDir: '', sessionsDir: '' };
  try {
    layout = layoutOf(dataDirOrCtx);
    const listed = listSessions(layout.sessionsDir);
    const integrity = { checked: 0, ok: 0, failed: 0 };
    const knowledge = { sessions: 0, derived: 0, failed: 0, entities: 0, types: 0 };
    for (const meta of listed) {
      const id = meta?.id;
      if (!id) continue;
      const dir = path.join(layout.sessionsDir, id);
      if (existsSync(path.join(dir, 'MANIFEST.json'))) {
        integrity.checked++;
        try {
          const report = verifyManifest(dir);
          if (report?.ok) integrity.ok++;
          else integrity.failed++;
        } catch {
          integrity.failed++;
        }
      }
      let session = null;
      try { session = new Session(dir); } catch { session = null; }
      knowledge.sessions++;
      if (!session) { knowledge.failed++; continue; }
      const manifest = kvGet(session, 'DERIVE_MANIFEST');
      const model = kvGet(session, 'MODEL');
      const status = kvGet(session, 'KNOWLEDGE_STATUS');
      if (manifest) knowledge.derived++;
      const failed = status?.status === 'failed' || !!model?.error || (manifest != null && manifest.ok === false);
      if (failed) knowledge.failed++;
      if (Array.isArray(model?.types)) knowledge.types += model.types.length;
      else if (Number.isFinite(status?.typeCount)) knowledge.types += status.typeCount;
      if (Number.isFinite(status?.entityCount)) knowledge.entities += status.entityCount;
      else if (Array.isArray(model?.entities)) knowledge.entities += model.entities.length;
    }
    return {
      schema: 'capture-studio.platform-stats/1',
      version: VERSION,
      schemaVersion: 2,
      dataDir: layout.dataDir,
      sessions: listed.length,
      integrity,
      knowledge,
      migrations: migrationNames(),
    };
  } catch {
    return emptyStats(layout.dataDir);
  }
}

export async function registrySnapshot() {
  try {
    ensureBuiltins();
    const snap = registry.snapshot();
    const kinds = {};
    for (const [kind, entries] of Object.entries(snap ?? {})) {
      kinds[kind] = {
        kind,
        entries: (Array.isArray(entries) ? entries : []).map((entry) => {
          const meta = entry?.meta && typeof entry.meta === 'object' ? entry.meta : {};
          return {
            name: entry.name,
            builtin: entry.builtin === true,
            extra: false,
            pii: meta.kind === 'pii' || meta.pii === true,
            registeredAt: null,
          };
        }),
      };
    }
    return { kinds };
  } catch {
    return { kinds: {} };
  }
}
