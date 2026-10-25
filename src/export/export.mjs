// Export layer. Dataset formats: jsonl (alias ndjson), json, csv, tsv, md, html.
// Plus: Markdown/HTML/JSON session transcript, knowledge export (types + entities + graph),
// graph export (json, dot, mermaid, graphml), a self-contained HTML session report, and a
// portable export bundle (manifest + datasets + transcript + report + knowledge).
// Every function is read-only over the session; nothing here touches raw or derived state.
import { createWriteStream, createReadStream, existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, cpSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { exportSchemas } from './schemas.mjs';
import { exportGraphRanked } from './graph-ranked.mjs';
export { exportSchemas, exportGraphRanked };

export const DATASET_FORMATS = ['jsonl', 'ndjson', 'json', 'csv', 'tsv', 'md', 'html'];
export const TRANSCRIPT_FORMATS = ['md', 'html', 'json'];
export const KNOWLEDGE_FORMATS = ['json', 'ndjson', 'md', 'html'];
export const GRAPH_FORMATS = ['json', 'dot', 'mermaid', 'graphml'];
const EXT_FORMAT = { '.jsonl': 'jsonl', '.ndjson': 'jsonl', '.json': 'json', '.csv': 'csv', '.tsv': 'tsv', '.md': 'md', '.markdown': 'md', '.html': 'html', '.htm': 'html' };

export class ExportError extends Error {
  constructor(message, code = 'EXPORT_ERROR', extra = {}) { super(message); this.name = 'ExportError'; this.code = code; Object.assign(this, extra); }
}

export function inferFormat(file, fallback = 'jsonl') {
  if (!file || file === '-') return fallback;
  return EXT_FORMAT[path.extname(file).toLowerCase()] ?? fallback;
}

// ---------------------------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------------------------
export function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj ?? {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length <= 30) flatten(v, key, out);
    else out[key] = Array.isArray(v) || (v && typeof v === 'object') ? JSON.stringify(v) : v;
  }
  return out;
}
const csvCell = (v, sep = ',') => {
  if (v === undefined || v === null) return '';
  const s = String(v);
  if (sep === '\t') return s.replace(/[\t\r\n]+/g, ' ');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const escapeHtml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const mdCell = (v, max = 200) => String(v ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').slice(0, max);
const clip = (v, max) => { const s = String(v ?? ''); return s.length > max ? `${s.slice(0, max)}…` : s; };

function deepGet(obj, p) {
  let cur = obj;
  for (const part of String(p).split('.')) { if (cur === null || cur === undefined) return undefined; cur = cur[part]; }
  return cur;
}
function project(row, fields) {
  const flat = flatten(row);
  const out = {};
  for (const f of fields) out[f] = flat[f] !== undefined ? flat[f] : deepGet(row, f);
  return out;
}

async function countLines(file) {
  let n = 0;
  for await (const chunk of createReadStream(file)) for (let i = 0; i < chunk.length; i++) if (chunk[i] === 0x0a) n++;
  return n;
}

// ---------------------------------------------------------------------------------------------
// Sinks (file or stdout or in-memory), with backpressure.
// ---------------------------------------------------------------------------------------------
export function openSink(outFile) {
  if (outFile === '-' || outFile === undefined || outFile === null) {
    return {
      path: '-',
      write: (s) => new Promise((resolve) => { if (process.stdout.write(s)) resolve(); else process.stdout.once('drain', resolve); }),
      end: async () => {},
    };
  }
  mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
  const out = createWriteStream(outFile);
  const failed = new Promise((_, reject) => out.once('error', reject));
  return {
    path: path.resolve(outFile),
    write: (s) => Promise.race([new Promise((resolve) => (out.write(s) ? resolve() : out.once('drain', resolve))), failed]),
    end: () => Promise.race([new Promise((resolve) => out.end(resolve)), failed]),
  };
}
function memorySink() {
  const parts = [];
  return { path: '(memory)', write: (s) => { parts.push(s); }, end: async () => {}, text: () => parts.join('') };
}

// ---------------------------------------------------------------------------------------------
// Datasets: real JSONL files plus virtual datasets built from derived KV state.
// ---------------------------------------------------------------------------------------------
const kvArray = (s, key, pick) => { const v = s.kv.get(key, null); const x = pick ? pick(v) : v; return Array.isArray(x) ? x : null; };
export const VIRTUAL_DATASETS = {
  'model-types': { desc: 'Discovered entity types', rows: (s) => kvArray(s, 'MODEL', (m) => m?.types) },
  'model-relationships': { desc: 'Discovered relationships between types', rows: (s) => kvArray(s, 'MODEL', (m) => m?.relationships) },
  'suggestions': { desc: 'Profile suggestions from shape inference', rows: (s) => kvArray(s, 'SHAPES', (m) => m?.suggestions) },
  'dom-blocks': { desc: 'Rendered text blocks (L3)', rows: (s) => kvArray(s, 'DOM_BLOCKS') },
  'dom-turns': { desc: 'Rendered conversation turns', rows: (s) => kvArray(s, 'DOM_TURNS') },
  'assembled': { desc: 'Assembled stream documents', rows: (s) => { const a = s.kv.get('ASSEMBLED', null); return a && typeof a === 'object' ? Object.entries(a).map(([sid, v]) => ({ sid, ...v })) : null; } },
  'graph-nodes': { desc: 'Temporal graph nodes', rows: (s) => kvArray(s, 'GRAPH', (g) => g?.nodes) },
  'graph-edges': { desc: 'Temporal graph edges', rows: (s) => kvArray(s, 'GRAPH', (g) => g?.edges) },
  'hypotheses-rendered': { desc: 'Rendered-as correlation hypotheses', rows: (s) => kvArray(s, 'HYPOTHESES', (h) => h?.rendered) },
  'hypotheses-actions': { desc: 'Action-to-stream correlation hypotheses', rows: (s) => kvArray(s, 'HYPOTHESES', (h) => h?.actions) },
  'receipt': { desc: 'Metadata-only lab receipt', rows: (s) => { const r = s.kv.get('RECEIPT', null); return r ? [r] : null; } },
};

export function realDatasetNames(session) {
  try { return readdirSync(path.join(session.dir, 'datasets')).filter((f) => f.endsWith('.jsonl')).map((f) => f.slice(0, -6)).sort(); } catch { return []; }
}

// Catalog of everything exportable for a session, optionally with row counts and sizes.
export async function datasetCatalog(session, { counts = false } = {}) {
  const out = [];
  for (const name of realDatasetNames(session)) {
    const file = session.dataset(name).file;
    out.push({ name, kind: 'dataset', bytes: statSync(file).size, ...(counts ? { rows: await countLines(file) } : {}) });
  }
  for (const [name, v] of Object.entries(VIRTUAL_DATASETS)) {
    const rows = v.rows(session);
    if (rows) out.push({ name, kind: 'derived', description: v.desc, ...(counts ? { rows: rows.length } : {}) });
  }
  return out;
}

export async function* rowsOf(session, name) {
  const ds = session.dataset(name);
  if (existsSync(ds.file)) { yield* ds.iterate(); return; }
  const virt = VIRTUAL_DATASETS[name]?.rows(session);
  if (virt) { yield* virt; return; }
  const available = (await datasetCatalog(session)).map((d) => d.name);
  throw new ExportError(`Dataset "${name}" not found in ${session.id}. Run "studio derive ${session.id}" first, or pick one of: ${available.join(', ') || '(none derived yet)'}`, 'DATASET_NOT_FOUND', { available });
}

async function* limited(iter, { limit, grep, fields }) {
  const needle = grep ? String(grep).toLowerCase() : null;
  let n = 0;
  for await (const row of iter) {
    if (needle && !JSON.stringify(row).toLowerCase().includes(needle)) continue;
    yield fields?.length ? project(row, fields) : row;
    if (limit && ++n >= limit) return;
  }
}

async function discoverColumns(makeIter, { maxRows = Infinity, maxCols = 200 } = {}) {
  const cols = new Set();
  let n = 0;
  for await (const row of makeIter()) {
    for (const k of Object.keys(flatten(row))) { cols.add(k); if (cols.size >= maxCols) return [...cols]; }
    if (++n >= maxRows) break;
  }
  return [...cols];
}

// ---------------------------------------------------------------------------------------------
// HTML shell (self-contained: no external assets)
// ---------------------------------------------------------------------------------------------
const CSS = `body{font:14px/1.45 system-ui,sans-serif;margin:1.5rem;color:#1b1f23;background:#fff}@media(prefers-color-scheme:dark){body{color:#d7dde4;background:#14171a}th{background:#1d2227!important}td,th{border-color:#2d343b!important}code,pre{background:#1d2227!important}}
h1{font-size:1.4rem}h2{font-size:1.1rem;margin-top:2rem}table{border-collapse:collapse;width:100%;font-size:13px}th,td{border:1px solid #d0d7de;padding:4px 8px;text-align:left;vertical-align:top;max-width:42rem;overflow-wrap:anywhere}th{background:#f6f8fa;position:sticky;top:0}
code,pre{background:#f6f8fa;border-radius:4px;padding:1px 4px}pre{padding:8px;overflow:auto;white-space:pre-wrap}.meta{color:#6a737d}input{padding:4px 8px;margin:6px 0;width:20rem}.ok{color:#1a7f37}.bad{color:#cf222e}`;
const FILTER_JS = `<script>(function(){var q=document.getElementById('q');if(!q)return;q.addEventListener('input',function(){var t=q.value.toLowerCase();document.querySelectorAll('tbody tr').forEach(function(r){r.hidden=t&&r.textContent.toLowerCase().indexOf(t)<0})})})()</script>`;
export function htmlPage(title, body, { filter = false } = {}) {
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>${CSS}</style></head><body>\n${body}\n${filter ? FILTER_JS : ''}</body></html>\n`;
}
const htmlTable = (headers, rows, { max = 500 } = {}) => `<table><thead><tr>${headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${escapeHtml(clip(c, max))}</td>`).join('')}</tr>`).join('')}</tbody></table>`;

// ---------------------------------------------------------------------------------------------
// Row writers: one per format, streaming.
// ---------------------------------------------------------------------------------------------
function rowWriter(format, sink, { columns = [], title = 'Export', meta = '' } = {}) {
  let n = 0;
  switch (format) {
    case 'jsonl': case 'ndjson':
      return { begin: async () => {}, row: async (r) => { await sink.write(JSON.stringify(r) + '\n'); n++; }, end: async () => n };
    case 'json':
      return { begin: async () => { await sink.write('['); }, row: async (r) => { await sink.write((n ? ',\n' : '\n') + JSON.stringify(r)); n++; }, end: async () => { await sink.write('\n]\n'); return n; } };
    case 'csv': case 'tsv': {
      const sep = format === 'tsv' ? '\t' : ',';
      return {
        begin: async () => { await sink.write(columns.map((c) => csvCell(c, sep)).join(sep) + '\n'); },
        row: async (r) => { const f = flatten(r); await sink.write(columns.map((c) => csvCell(f[c], sep)).join(sep) + '\n'); n++; },
        end: async () => n,
      };
    }
    case 'md':
      return {
        begin: async () => { await sink.write(`| ${columns.join(' | ')} |\n| ${columns.map(() => '---').join(' | ')} |\n`); },
        row: async (r) => { const f = flatten(r); await sink.write(`| ${columns.map((c) => mdCell(f[c])).join(' | ')} |\n`); n++; },
        end: async () => n,
      };
    case 'html':
      return {
        begin: async () => { await sink.write(`<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${CSS}</style></head><body>\n<h1>${escapeHtml(title)}</h1><p class="meta">${escapeHtml(meta)}</p><input id="q" placeholder="filter rows" aria-label="filter rows">\n<table><thead><tr>${columns.map((c) => `<th>${escapeHtml(c)}</th>`).join('')}</tr></thead><tbody>\n`); },
        row: async (r) => { const f = flatten(r); await sink.write(`<tr>${columns.map((c) => `<td>${escapeHtml(clip(f[c], 1000))}</td>`).join('')}</tr>\n`); n++; },
        end: async () => { await sink.write(`</tbody></table>\n${FILTER_JS}</body></html>\n`); return n; },
      };
    default:
      throw new ExportError(`Unknown format "${format}" (${DATASET_FORMATS.join('|')})`, 'BAD_FORMAT');
  }
}

const COLUMN_CAPS = { csv: 200, tsv: 200, md: 12, html: 40 };
const ROW_CAPS = { md: 5000, html: 20000 };

// Export one dataset (real or derived). Backward compatible: (session, name, format, outFile).
// opts: { limit, fields:[...], grep, title }. outFile '-' writes to stdout.
export async function exportDataset(session, name, format, outFile, opts = {}) {
  format = format || inferFormat(outFile);
  if (!DATASET_FORMATS.includes(format)) throw new ExportError(`Unknown format ${format} (${DATASET_FORMATS.join('|')})`, 'BAD_FORMAT');
  const fields = Array.isArray(opts.fields) && opts.fields.length ? opts.fields : null;
  const rowCap = opts.limit ?? ROW_CAPS[format] ?? 0;
  const source = () => limited(rowsOf(session, name), { limit: rowCap, grep: opts.grep, fields: format === 'jsonl' || format === 'ndjson' || format === 'json' ? fields : null });
  // Surface "dataset not found" before creating any output file.
  const probe = rowsOf(session, name)[Symbol.asyncIterator]();
  try { await probe.next(); } finally { await probe.return?.(); }
  let columns = [];
  if (COLUMN_CAPS[format]) {
    columns = fields ?? await discoverColumns(source, { maxRows: ROW_CAPS[format] ?? Infinity, maxCols: COLUMN_CAPS[format] });
  }
  const sink = openSink(outFile);
  const w = rowWriter(format, sink, { columns, title: opts.title ?? `${session.id} · ${name}`, meta: `${new Date().toISOString()} · dataset ${name}` });
  await w.begin();
  for await (const r of source()) await w.row(r);
  const rows = await w.end();
  await sink.end();
  const capped = !!ROW_CAPS[format] && !opts.limit && rows >= ROW_CAPS[format];
  return { file: sink.path, rows, format, dataset: name, columns: columns.length || undefined, truncated: capped || undefined };
}

// Format an in-memory list of rows (used for stdout output of query-style commands).
export async function formatRows(rows, format = 'jsonl', { fields, title, columns: given } = {}) {
  if (!DATASET_FORMATS.includes(format)) throw new ExportError(`Unknown format ${format} (${DATASET_FORMATS.join('|')})`, 'BAD_FORMAT');
  const list = fields?.length ? rows.map((r) => project(r, fields)) : rows;
  const cols = given ?? (COLUMN_CAPS[format] ? await discoverColumns(async function* () { yield* list; }, { maxCols: COLUMN_CAPS[format] }) : []);
  const sink = memorySink();
  const w = rowWriter(format, sink, { columns: cols, title: title ?? 'Export', meta: new Date().toISOString() });
  await w.begin();
  for (const r of list) await w.row(r);
  await w.end();
  return sink.text();
}

// ---------------------------------------------------------------------------------------------
// Transcript
// ---------------------------------------------------------------------------------------------
export async function buildTranscript(session, { maxTimeline = 20000, topTexts = 5 } = {}) {
  const m = session.meta;
  const assembled = session.kv.get('ASSEMBLED', {}) ?? {};
  const timeline = await session.dataset('timeline').toArray(maxTimeline);
  const t0 = timeline[0]?.t ?? 0;
  const streams = [];
  for (const [sid, a] of Object.entries(assembled)) {
    const texts = [];
    const walk = (n, p) => { if (typeof n === 'string' && n.length >= 20) texts.push([p, n]); else if (n && typeof n === 'object') for (const [k, v] of Object.entries(n)) walk(v, `${p}/${k}`); };
    walk(a.doc, '');
    streams.push({ sid, endpoint: a.endpoint, revisions: a.revisions, dialects: a.dialects ?? [], texts: texts.sort((x, y) => y[1].length - x[1].length).slice(0, topTexts).map(([p, t]) => ({ path: p, text: t })) });
  }
  const turns = (session.kv.get('DOM_TURNS', []) ?? []).filter((t) => t && (t.text || t.role)).map((t) => ({ id: t.id, role: t.role ?? '', text: t.text ?? '' }));
  return {
    meta: { id: m.id, target: m.target ?? null, browser: m.browser, profile: m.profile ?? null, status: m.status, endReason: m.endReason ?? null, createdAt: m.createdAt ?? null },
    timeline: timeline.map((e) => ({ offsetSeconds: +((e.t - t0) / 1000).toFixed(2), kind: e.k, detail: e.kind ?? null, label: e.label ?? null, sid: e.sid ?? null, reason: e.reason ?? null, error: e.error ?? null, url: e.url ?? null })),
    streams, turns,
  };
}

function timelineLine(e) {
  return `+${e.offsetSeconds.toFixed(2)}s · ${e.kind}${e.detail ? `:${e.detail}` : ''}${e.label ? ` “${e.label}”` : ''}${e.sid ? ` [${e.sid}]` : ''}${e.reason ? ` (${e.reason})` : ''}${e.error ? ` ERROR ${e.error}` : ''}`;
}

export function renderTranscriptMarkdown(tr) {
  const m = tr.meta;
  const out = [`# Capture session ${m.id}`, '', `- Target: ${m.target?.title ?? ''} (${m.target?.url ?? ''})`, `- Browser: ${m.browser}`, `- Profile: ${m.profile?.name}@v${m.profile?.version}`, `- Status: ${m.status} (${m.endReason ?? ''})`, ''];
  out.push('## Timeline', '');
  for (const e of tr.timeline) out.push(`- ${timelineLine(e)}`);
  if (tr.turns.length) {
    out.push('', '## Rendered conversation turns', '');
    for (const t of tr.turns) out.push(`**${t.role || 'turn'}**`, '', t.text, '');
  }
  out.push('', '## Assembled stream content', '');
  for (const a of tr.streams) {
    out.push(`### ${a.endpoint} [${a.sid}] — ${a.revisions} revisions (${a.dialects.join(', ') || 'snapshots'})`, '');
    for (const t of a.texts) out.push(`\`${t.path}\``, '', t.text, '');
  }
  return out.join('\n');
}

export function renderTranscriptHtml(tr) {
  const m = tr.meta;
  const body = [
    `<h1>Capture session ${escapeHtml(m.id)}</h1>`,
    `<ul><li>Target: ${escapeHtml(m.target?.title ?? '')} <code>${escapeHtml(m.target?.url ?? '')}</code></li><li>Browser: ${escapeHtml(m.browser)}</li><li>Profile: ${escapeHtml(m.profile?.name)}@v${escapeHtml(m.profile?.version)}</li><li>Status: ${escapeHtml(m.status)} (${escapeHtml(m.endReason ?? '')})</li></ul>`,
    '<h2>Timeline</h2>', `<ul>${tr.timeline.map((e) => `<li>${escapeHtml(timelineLine(e))}</li>`).join('')}</ul>`,
  ];
  if (tr.turns.length) body.push('<h2>Rendered conversation turns</h2>', ...tr.turns.map((t) => `<p><strong>${escapeHtml(t.role || 'turn')}</strong></p><pre>${escapeHtml(t.text)}</pre>`));
  body.push('<h2>Assembled stream content</h2>');
  for (const a of tr.streams) body.push(`<h3>${escapeHtml(a.endpoint)} <small class="meta">[${escapeHtml(a.sid)}] ${a.revisions} revisions (${escapeHtml(a.dialects.join(', ') || 'snapshots')})</small></h3>`, ...a.texts.map((t) => `<p><code>${escapeHtml(t.path)}</code></p><pre>${escapeHtml(t.text)}</pre>`));
  return htmlPage(`Transcript ${m.id}`, body.join('\n'));
}

// Backward compatible: exportTranscript(session, outFile). Format from opts.format or file extension.
export async function exportTranscript(session, outFile, opts = {}) {
  const format = opts.format ?? (TRANSCRIPT_FORMATS.includes(inferFormat(outFile, 'md')) ? inferFormat(outFile, 'md') : 'md');
  if (!TRANSCRIPT_FORMATS.includes(format)) throw new ExportError(`Unknown transcript format ${format} (${TRANSCRIPT_FORMATS.join('|')})`, 'BAD_FORMAT');
  const tr = await buildTranscript(session, opts);
  const text = format === 'json' ? JSON.stringify(tr, null, 2) + '\n' : format === 'html' ? renderTranscriptHtml(tr) : renderTranscriptMarkdown(tr);
  return writeText(outFile, text, { format });
}

async function writeText(outFile, text, extra = {}) {
  if (outFile === '-' || outFile === undefined) { await openSink('-').write(text.endsWith('\n') ? text : text + '\n'); return { file: '-', bytes: Buffer.byteLength(text), ...extra }; }
  mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
  writeFileSync(outFile, text);
  return { file: path.resolve(outFile), bytes: Buffer.byteLength(text), ...extra };
}

// ---------------------------------------------------------------------------------------------
// Knowledge export: model types + entities + graph + hypotheses in one artifact.
// ---------------------------------------------------------------------------------------------
async function loadKnowledge(session, { maxEntities = Infinity } = {}) {
  const status = session.kv.get('KNOWLEDGE_STATUS', null);
  const model = session.kv.get('MODEL', null);
  if (!model) throw new ExportError(`No knowledge derived for ${session.id}. Run "studio derive ${session.id}" first.`, 'NO_KNOWLEDGE');
  if (model.error) throw new ExportError(`Knowledge derivation failed for ${session.id} at stage ${model.stage ?? '?'}: ${model.error}`, 'KNOWLEDGE_FAILED');
  const entities = [];
  for await (const e of session.dataset('entities').iterate()) { entities.push(e); if (entities.length >= maxEntities) break; }
  return { status, model, entities, graph: session.kv.get('GRAPH', null), hypotheses: session.kv.get('HYPOTHESES', null) };
}

export async function exportKnowledge(session, outFile, opts = {}) {
  const format = opts.format ?? (KNOWLEDGE_FORMATS.includes(inferFormat(outFile, 'json')) ? inferFormat(outFile, 'json') : 'json');
  if (!KNOWLEDGE_FORMATS.includes(format)) throw new ExportError(`Unknown knowledge format ${format} (${KNOWLEDGE_FORMATS.join('|')})`, 'BAD_FORMAT');
  const k = await loadKnowledge(session, { maxEntities: opts.limit });
  const { model, entities, graph, status, hypotheses } = k;
  let text;
  if (format === 'json') {
    text = JSON.stringify({ schema: 'capture-studio.knowledge-export/1', session: session.id, exportedAt: new Date().toISOString(), status, model, entities, graph, hypotheses }, null, 2) + '\n';
  } else if (format === 'ndjson') {
    const lines = [{ kind: 'session', id: session.id, status, exportedAt: new Date().toISOString() }];
    for (const t of model.types ?? []) lines.push({ kind: 'type', ...t });
    for (const r of model.relationships ?? []) lines.push({ kind: 'relationship', ...r });
    for (const e of entities) lines.push({ kind: 'entity', ...e });
    for (const ed of graph?.edges ?? []) lines.push({ kind: 'edge', ...ed });
    text = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
  } else {
    const counts = {}; for (const e of entities) counts[e.type] = (counts[e.type] ?? 0) + 1;
    const typeRows = (model.types ?? []).map((t) => [t.name, t.key ? `${t.key.field}${t.key.weak ? ' (weak)' : ''}` : '(keyless)', t.support, t.confidence, counts[t.id] ?? 0]);
    const entRows = entities.slice(0, opts.maxRows ?? 500).map((e) => [e.eid, e.typeName ?? e.type, e.key ?? '', e.observations ?? '', clip(JSON.stringify(e.attrs ?? {}), 160)]);
    const relRows = (model.relationships ?? []).map((r) => [r.kind, r.from, r.to, r.field ?? '', r.confidence ?? '']);
    if (format === 'md') {
      const tbl = (h, rows) => `| ${h.join(' | ')} |\n| ${h.map(() => '---').join(' | ')} |\n${rows.map((r) => `| ${r.map((c) => mdCell(c, 160)).join(' | ')} |`).join('\n')}`;
      text = [`# Knowledge for ${session.id}`, '', `- Status: ${status?.status ?? 'legacy-unverified'}`, `- Types: ${typeRows.length}, entities: ${entities.length}, graph edges: ${graph?.edges?.length ?? 0}`, '',
        '## Types', '', tbl(['type', 'key', 'support', 'confidence', 'entities'], typeRows), '',
        ...(relRows.length ? ['## Relationships', '', tbl(['kind', 'from', 'to', 'field', 'confidence'], relRows), ''] : []),
        `## Entities${entities.length > entRows.length ? ` (first ${entRows.length} of ${entities.length})` : ''}`, '', tbl(['eid', 'type', 'key', 'observations', 'attributes'], entRows), ''].join('\n');
    } else {
      text = htmlPage(`Knowledge ${session.id}`, [
        `<h1>Knowledge for ${escapeHtml(session.id)}</h1><p class="meta">Status: ${escapeHtml(status?.status ?? 'legacy-unverified')} · ${typeRows.length} types · ${entities.length} entities · ${graph?.edges?.length ?? 0} graph edges</p>`,
        '<h2>Types</h2>', htmlTable(['type', 'key', 'support', 'confidence', 'entities'], typeRows),
        ...(relRows.length ? ['<h2>Relationships</h2>', htmlTable(['kind', 'from', 'to', 'field', 'confidence'], relRows)] : []),
        '<h2>Entities</h2><input id="q" placeholder="filter entities">', htmlTable(['eid', 'type', 'key', 'observations', 'attributes'], entRows),
      ].join('\n'), { filter: true });
    }
  }
  const res = await writeText(outFile, text, { format });
  return { ...res, types: model.types?.length ?? 0, entities: entities.length, edges: graph?.edges?.length ?? 0 };
}

// ---------------------------------------------------------------------------------------------
// Graph export
// ---------------------------------------------------------------------------------------------
export async function exportGraph(session, outFile, opts = {}) {
  const format = opts.format ?? { '.dot': 'dot', '.gv': 'dot', '.mmd': 'mermaid', '.mermaid': 'mermaid', '.graphml': 'graphml', '.json': 'json' }[path.extname(outFile ?? '').toLowerCase()] ?? 'json';
  if (!GRAPH_FORMATS.includes(format)) throw new ExportError(`Unknown graph format ${format} (${GRAPH_FORMATS.join('|')})`, 'BAD_FORMAT');
  const graph = session.kv.get('GRAPH', null);
  if (!graph) throw new ExportError(`No graph for ${session.id}. Run "studio derive ${session.id}" first.`, 'NO_KNOWLEDGE');
  const maxNodes = opts.maxNodes ?? 500;
  let edges = (graph.edges ?? []).filter((e) => (!opts.kind || e.kind === opts.kind) && (!opts.status || e.status === opts.status) && (opts.minConfidence === undefined || e.confidence >= opts.minConfidence));
  edges = edges.sort((a, b) => b.confidence - a.confidence);
  const nodeMap = new Map((graph.nodes ?? []).map((n) => [n.eid, n]));
  const used = new Set();
  const keptEdges = [];
  for (const e of edges) {
    const add = [e.from, e.to].filter((id) => !used.has(id));
    if (used.size + add.length > maxNodes) continue;
    add.forEach((id) => used.add(id)); keptEdges.push(e);
  }
  // Isolated entity nodes fill the remaining budget unless edges-only was requested.
  if (!opts.edgesOnly) for (const n of graph.nodes ?? []) { if (used.size >= maxNodes) break; used.add(n.eid); }
  const label = (id) => { const n = nodeMap.get(id); return n ? `${n.typeName ?? 'entity'}${n.key !== null && n.key !== undefined ? `: ${clip(n.key, 24)}` : ''}` : id; };
  let text;
  if (format === 'json') {
    text = JSON.stringify({ session: session.id, nodes: [...used].map((id) => ({ id, label: label(id), ...(nodeMap.get(id) ? { type: nodeMap.get(id).typeName, key: nodeMap.get(id).key } : {}) })), edges: keptEdges.map(({ evidence, statusHistory, ...e }) => e), stats: graph.stats }, null, 2) + '\n';
  } else if (format === 'dot') {
    const q = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    text = [`digraph ${q(session.id)} {`, '  rankdir=LR; node [shape=box, fontsize=10];',
      ...[...used].map((id) => `  ${q(id)} [label=${q(label(id))}];`),
      ...keptEdges.map((e) => `  ${q(e.from)} -> ${q(e.to)} [label=${q(`${e.kind} ${Math.round(e.confidence * 100)}%`)}${e.status === 'hypothesis' ? ', style=dashed' : ''}];`), '}', ''].join('\n');
  } else if (format === 'mermaid') {
    const ids = new Map([...used].map((id, i) => [id, `n${i}`]));
    const m = (s) => String(s).replace(/["\n\r]/g, ' ');
    text = ['graph LR', ...[...used].map((id) => `  ${ids.get(id)}["${m(label(id))}"]`),
      ...keptEdges.map((e) => `  ${ids.get(e.from)} ${e.status === 'hypothesis' ? '-.->' : '-->'}|${m(e.kind)} ${Math.round(e.confidence * 100)}%| ${ids.get(e.to)}`), ''].join('\n');
  } else {
    const x = escapeHtml;
    text = ['<?xml version="1.0" encoding="UTF-8"?>', '<graphml xmlns="http://graphml.graphdrawing.org/xmlns">',
      '  <key id="label" for="node" attr.name="label" attr.type="string"/>', '  <key id="kind" for="edge" attr.name="kind" attr.type="string"/>',
      '  <key id="confidence" for="edge" attr.name="confidence" attr.type="double"/>', '  <key id="status" for="edge" attr.name="status" attr.type="string"/>',
      `  <graph id="${x(session.id)}" edgedefault="directed">`,
      ...[...used].map((id) => `    <node id="${x(id)}"><data key="label">${x(label(id))}</data></node>`),
      ...keptEdges.map((e, i) => `    <edge id="e${i}" source="${x(e.from)}" target="${x(e.to)}"><data key="kind">${x(e.kind)}</data><data key="confidence">${e.confidence}</data><data key="status">${x(e.status)}</data></edge>`),
      '  </graph>', '</graphml>', ''].join('\n');
  }
  const res = await writeText(outFile, text, { format });
  return { ...res, nodes: used.size, edges: keptEdges.length, droppedEdges: edges.length - keptEdges.length };
}

// ---------------------------------------------------------------------------------------------
// Session report (single HTML file)
// ---------------------------------------------------------------------------------------------
export async function exportReport(session, outFile) {
  const m = session.meta;
  const receipt = session.kv.get('RECEIPT', null);
  const shapes = session.kv.get('SHAPES', null);
  const model = session.kv.get('MODEL', null);
  const status = session.kv.get('KNOWLEDGE_STATUS', null);
  const streams = existsSync(session.dataset('streams').file) ? await session.dataset('streams').toArray(200) : [];
  const kv = (obj) => `<table><tbody>${Object.entries(obj ?? {}).map(([k, v]) => `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(clip(typeof v === 'object' ? JSON.stringify(v) : v, 600))}</td></tr>`).join('')}</tbody></table>`;
  const parts = [
    `<h1>Session ${escapeHtml(m.id)}</h1>`,
    `<p class="meta">${escapeHtml(m.target?.title ?? '')} · <code>${escapeHtml(m.target?.url ?? '')}</code> · ${escapeHtml(m.browser ?? '')}</p>`,
    '<h2>Session</h2>', kv({ status: m.status, endReason: m.endReason, createdAt: m.createdAt, endedAt: m.endedAt, profile: m.profile ? `${m.profile.name}@v${m.profile.version}` : '', integrity: m.integrity, collector: m.collector }),
  ];
  if (receipt) {
    parts.push(`<h2>Receipt — <span class="${/VIABLE/.test(receipt.verdict ?? '') ? 'ok' : 'bad'}">${escapeHtml(receipt.verdict)}</span></h2>`,
      kv({ transport: receipt.actual_response_transport, chunks: receipt.raw_chunks_received, bytes: receipt.raw_bytes_received, first_byte_ms: receipt.first_byte_observed_ms, last_ms: receipt.last_response_or_terminal_ms, gaps: receipt.replay_and_gap_diagnostics, knowledge: receipt.knowledge, quality: receipt.quality, family: receipt.family }));
    if (receipt.fidelity_breakdown) parts.push('<h2>Fidelity</h2>', htmlTable(['category', 'detail', 'note'], Object.entries(receipt.fidelity_breakdown).map(([k, v]) => { const { note, ...rest } = v; return [k, JSON.stringify(rest), note]; })));
  }
  if (streams.length) parts.push(`<h2>Streams (${streams.length})</h2>`, htmlTable(['sid', 'endpoint', 'transport', 'status', 'bytes', 'events'], streams.map((s) => [s.sid, s.endpoint, s.transport, s.status, s.bytes, s.events])));
  if (model && !model.error) parts.push(`<h2>Data model</h2><p class="meta">Knowledge status: ${escapeHtml(status?.status ?? 'legacy-unverified')}</p>`, htmlTable(['type', 'key', 'support', 'confidence'], (model.types ?? []).map((t) => [t.name, t.key?.field ?? '(keyless)', t.support, t.confidence])));
  else if (model?.error) parts.push(`<h2>Data model</h2><p class="bad">Derivation failed at ${escapeHtml(model.stage ?? '?')}: ${escapeHtml(model.error)}</p>`);
  if (shapes?.suggestions?.length) parts.push('<h2>Suggestions</h2>', htmlTable(['confidence', 'id', 'title', 'detail'], shapes.suggestions.slice(0, 40).map((g) => [`${Math.round(g.confidence * 100)}%`, g.id, g.title, g.detail])));
  parts.push(`<p class="meta">Generated ${new Date().toISOString()} by Capture Studio. Metadata and derived structure only; raw payloads are not embedded.</p>`);
  return writeText(outFile, htmlPage(`Session ${m.id}`, parts.join('\n')), { format: 'html' });
}

// ---------------------------------------------------------------------------------------------
// Bundle: a portable folder with manifest, datasets, transcript, knowledge, report.
// ---------------------------------------------------------------------------------------------
const sha256File = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

export async function exportBundle(session, outDir, opts = {}) {
  const format = opts.format ?? 'jsonl';
  if (!DATASET_FORMATS.includes(format)) throw new ExportError(`Unknown format ${format} (${DATASET_FORMATS.join('|')})`, 'BAD_FORMAT');
  const root = path.resolve(outDir);
  mkdirSync(path.join(root, 'datasets'), { recursive: true });
  const exclude = new Set(opts.exclude ?? []);
  const files = [];
  const note = (rel, extra = {}) => { const full = path.join(root, rel); files.push({ file: rel.replaceAll('\\', '/'), bytes: statSync(full).size, sha256: sha256File(full), ...extra }); };
  const skipped = [];

  writeFileSync(path.join(root, 'session.json'), JSON.stringify(session.meta, null, 2)); note('session.json');
  const receipt = session.kv.get('RECEIPT', null);
  if (receipt) { writeFileSync(path.join(root, 'receipt.json'), JSON.stringify(receipt, null, 2)); note('receipt.json'); }
  for (const d of await datasetCatalog(session)) {
    if (exclude.has(d.name)) { skipped.push({ name: d.name, reason: 'excluded' }); continue; }
    if (d.kind === 'derived' && !opts.derived) continue; // derived views are folded into knowledge.json/report.html
    const rel = path.join('datasets', `${d.name}.${format === 'ndjson' ? 'jsonl' : format}`);
    try { const r = await exportDataset(session, d.name, format, path.join(root, rel)); note(rel, { dataset: d.name, rows: r.rows, truncated: r.truncated }); }
    catch (e) { skipped.push({ name: d.name, reason: e.message }); }
  }
  for (const [rel, fn] of [
    ['transcript.md', () => exportTranscript(session, path.join(root, 'transcript.md'), { format: 'md' })],
    ['transcript.html', () => exportTranscript(session, path.join(root, 'transcript.html'), { format: 'html' })],
    ['report.html', () => exportReport(session, path.join(root, 'report.html'))],
    ['knowledge.json', () => exportKnowledge(session, path.join(root, 'knowledge.json'), { format: 'json' })],
    ['schemas.json', () => exportSchemas(session, path.join(root, 'schemas.json'))],
    ['graph-ranked.json', () => exportGraphRanked(session, path.join(root, 'graph-ranked.json'))],
  ]) {
    try { await fn(); note(rel); } catch (e) { skipped.push({ name: rel, reason: e.message }); }
  }
  if (opts.includeRaw && existsSync(path.join(session.dir, 'raw'))) {
    cpSync(path.join(session.dir, 'raw'), path.join(root, 'raw'), { recursive: true });
    for (const f of readdirSync(path.join(root, 'raw'))) note(path.join('raw', f));
  }
  const manifest = { schema: 'capture-studio.bundle/1', session: session.id, exportedAt: new Date().toISOString(), datasetFormat: format, rawIncluded: !!opts.includeRaw, files, skipped };
  writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return { dir: root, files: files.length + 1, skipped, manifest: path.join(root, 'manifest.json') };
}
