// export dataset|transcript|knowledge|graph|report|bundle|formats   (+ top-level "transcript")
import path from 'node:path';
import {
  exportDataset, exportTranscript, exportKnowledge, exportGraph, exportReport, exportBundle, exportSchemas, exportGraphRanked, datasetCatalog,
  DATASET_FORMATS, TRANSCRIPT_FORMATS, KNOWLEDGE_FORMATS, GRAPH_FORMATS, inferFormat,
} from '../../src/export/export.mjs';
import { define, defineGroup } from '../lib/registry.mjs';
import { fmtBytes } from '../lib/ui.mjs';
import { looksActive, isDerived } from '../lib/util.mjs';

defineGroup('export', {
  summary: 'Export datasets, transcripts, knowledge, graphs, reports and bundles', section: 'Export', default: 'dataset', passthrough: true,
  description: 'Export saved sessions. "studio export <id> --dataset events --format csv" is shorthand for "studio export dataset …". Use --out - to write to stdout so exports compose with other tools.',
});

const GRAPH_EXT = { json: 'json', dot: 'dot', mermaid: 'mmd', graphml: 'graphml' };

// Write location: explicit --out, else <session>-<what>.<ext> in the current folder (stdout with "-").
const outFile = (ctx, session, what, ext) => ctx.flags.out ?? `${session.id}${what ? `-${what}` : ''}.${ext}`;
const showWrite = (o, label, r) => o.result(`Wrote ${label} to ${r.file}${r.bytes ? ` (${fmtBytes(r.bytes)})` : ''}`);

// Sessions whose derived data is missing are derived on the fly (not while another process records them).
async function prepared(ctx, ref) {
  const s = ctx.session(ref);
  if (!isDerived(s) && !looksActive(s)) await ctx.ensureDerived(s);
  return s;
}

// ---------------------------------------------------------------------------------------------
define({
  name: 'export dataset', section: 'Export', usage: '[id|latest] --dataset NAME [--format F] [--out FILE]', summary: 'Export one dataset (JSON, NDJSON, CSV, TSV, Markdown, HTML)',
  description: `Exports a derived dataset (events, streams, timeline, entities, records-<name>, family-<name>-<entity>) or a derived view (model-types, suggestions, dom-turns, assembled, graph-edges, …). Formats: ${DATASET_FORMATS.join(', ')}. Run with --list to see what exists for a session.`,
  flags: {
    dataset: { type: 'string', alias: 'd', valueName: 'NAME', desc: 'Dataset to export' },
    format: { type: 'string', alias: 'f', choices: DATASET_FORMATS, desc: 'Output format (default: from --out extension, else the configured exportFormat)' },
    out: { type: 'string', alias: 'o', valueName: 'FILE', desc: 'Output file; "-" writes to stdout' },
    fields: { type: 'list', valueName: 'A,B.C', desc: 'Only these columns (dotted paths into nested records)' },
    limit: { type: 'number', alias: 'n', valueName: 'N', desc: 'Stop after N rows' },
    grep: { type: 'string', valueName: 'TEXT', desc: 'Only rows containing TEXT (case-insensitive)' },
    list: { type: 'boolean', desc: 'List exportable datasets with row counts and exit' },
    all: { type: 'boolean', desc: 'Export every dataset into --out-dir' },
    'out-dir': { type: 'string', valueName: 'DIR', desc: 'Directory for --all (default ./<session>-datasets)' },
  },
  examples: ['studio export latest --dataset events --format jsonl --out events.jsonl', 'studio export latest -d entities -f csv --fields eid,typeName,key,attrs.name -o -', 'studio export latest --all --format html --out-dir ./out', 'studio export latest --list'],
  async run(ctx) {
    const f = ctx.flags;
    const s = await prepared(ctx, ctx.args[0]);
    if (f.list || (!f.dataset && !f.all)) {
      const catalog = await datasetCatalog(s, { counts: true });
      ctx.out.emit({ session: s.id, datasets: catalog }, (o) => {
        o.table(catalog, [{ title: 'DATASET', key: 'name' }, { title: 'KIND', key: 'kind' }, { title: 'ROWS', get: (d) => d.rows, align: 'right' }, { title: 'SIZE', get: (d) => (d.bytes ? fmtBytes(d.bytes) : ''), align: 'right' }, { title: 'ABOUT', get: (d) => d.description ?? '', max: 50 }], { empty: 'No datasets.' });
        if (!f.list) o.line(o.c.dim('Choose one with --dataset NAME.'));
      });
      if (!f.list) process.exitCode = 2;
      return;
    }
    const fmt = f.format ?? (f.out ? inferFormat(f.out, ctx.settings.exportFormat) : ctx.settings.exportFormat);
    if (f.all) {
      const dir = path.resolve(f['out-dir'] ?? `${s.id}-datasets`);
      const ext = fmt === 'ndjson' ? 'jsonl' : fmt;
      const results = [];
      for (const d of await datasetCatalog(s)) {
        try { results.push({ dataset: d.name, ...(await exportDataset(s, d.name, fmt, path.join(dir, `${d.name}.${ext}`), { limit: f.limit, fields: f.fields, grep: f.grep })) }); }
        catch (e) { results.push({ dataset: d.name, error: e.message }); }
      }
      ctx.out.emit({ session: s.id, dir, format: fmt, results }, (o) => {
        for (const r of results) o.result(r.error ? `${o.c.red('skip')} ${r.dataset}: ${r.error}` : `${String(r.rows).padStart(8)} rows  ${r.dataset}${r.truncated ? ' (truncated; pass --limit to choose)' : ''}`);
        o.result(`Wrote ${results.filter((r) => !r.error).length} file(s) to ${dir}`);
      });
      return;
    }
    const file = outFile(ctx, s, f.dataset, fmt === 'ndjson' ? 'jsonl' : fmt);
    const r = await exportDataset(s, f.dataset, fmt, file, { limit: f.limit, fields: f.fields, grep: f.grep });
    if (r.file === '-') { ctx.out.info(`${r.rows} row(s) written to stdout`); return; }
    ctx.out.emit(r, (o) => o.result(`Wrote ${r.rows} rows to ${r.file}${r.truncated ? ' (truncated for this format; pass --limit to choose)' : ''}`));
  },
});

// ---------------------------------------------------------------------------------------------
define({
  name: 'export transcript', section: 'Export', aliases: ['transcript'], usage: '[id|latest] [--format md|html|json]', summary: 'Readable session transcript: timeline, rendered turns, assembled stream text',
  flags: {
    format: { type: 'string', alias: 'f', choices: TRANSCRIPT_FORMATS, desc: 'Output format (default md, or from --out extension)' },
    out: { type: 'string', alias: 'o', valueName: 'FILE', desc: 'Output file; "-" writes to stdout' },
  },
  async run(ctx) {
    const s = await prepared(ctx, ctx.args[0]);
    const fmt = ctx.flags.format ?? (TRANSCRIPT_FORMATS.includes(inferFormat(ctx.flags.out, 'md')) ? inferFormat(ctx.flags.out, 'md') : 'md');
    const r = await exportTranscript(s, outFile(ctx, s, '', fmt), { format: fmt });
    if (r.file !== '-') ctx.out.emit(r, (o) => showWrite(o, 'transcript', r));
  },
});

define({
  name: 'export knowledge', section: 'Export', usage: '[id|latest] [--format json|ndjson|md|html]', summary: 'Data model, entities, graph and hypotheses in one artifact',
  flags: {
    format: { type: 'string', alias: 'f', choices: KNOWLEDGE_FORMATS, default: 'json', desc: 'Output format' },
    out: { type: 'string', alias: 'o', valueName: 'FILE', desc: 'Output file; "-" writes to stdout' },
    limit: { type: 'number', alias: 'n', valueName: 'N', desc: 'Include at most N entities' },
  },
  async run(ctx) {
    const s = await prepared(ctx, ctx.args[0]);
    const fmt = ctx.flags.format;
    const r = await exportKnowledge(s, outFile(ctx, s, 'knowledge', fmt === 'ndjson' ? 'ndjson' : fmt), { format: fmt, limit: ctx.flags.limit });
    if (r.file !== '-') ctx.out.emit(r, (o) => showWrite(o, `knowledge (${r.types} types, ${r.entities} entities, ${r.edges} edges)`, r));
  },
});

define({
  name: 'export graph', section: 'Export', usage: '[id|latest] [--format json|dot|mermaid|graphml]', summary: 'Temporal evidence graph for Graphviz, Mermaid, Gephi/yEd, or JSON',
  flags: {
    format: { type: 'string', alias: 'f', choices: GRAPH_FORMATS, default: 'json', desc: 'Output format' },
    out: { type: 'string', alias: 'o', valueName: 'FILE', desc: 'Output file; "-" writes to stdout' },
    kind: { type: 'string', valueName: 'KIND', desc: 'Only edges of this kind (references, contains, rendered_as, preceded, …)' },
    status: { type: 'string', choices: ['hypothesis', 'confirmed', 'rejected'], desc: 'Only edges with this status' },
    'min-confidence': { type: 'number', valueName: '0-1', desc: 'Only edges at or above this confidence' },
    'max-nodes': { type: 'number', valueName: 'N', default: 500, desc: 'Cap the number of nodes (highest-confidence edges win)' },
    'edges-only': { type: 'boolean', desc: 'Omit nodes that have no kept edge' },
  },
  examples: ['studio export graph latest -f dot -o graph.dot', 'studio export graph latest -f mermaid --kind references -o -'],
  async run(ctx) {
    const f = ctx.flags;
    const s = await prepared(ctx, ctx.args[0]);
    const r = await exportGraph(s, outFile(ctx, s, 'graph', GRAPH_EXT[f.format]), { format: f.format, kind: f.kind, status: f.status, minConfidence: f['min-confidence'], maxNodes: f['max-nodes'], edgesOnly: f['edges-only'] });
    if (r.file !== '-') ctx.out.emit(r, (o) => showWrite(o, `graph (${r.nodes} nodes, ${r.edges} edges${r.droppedEdges ? `, ${r.droppedEdges} omitted` : ''})`, r));
  },
});

define({
  name: 'export report', section: 'Export', usage: '[id|latest] [--out FILE]', summary: 'Single-file HTML report: receipt, fidelity, streams, model, suggestions',
  flags: { out: { type: 'string', alias: 'o', valueName: 'FILE', desc: 'Output file; "-" writes to stdout' } },
  async run(ctx) {
    const s = await prepared(ctx, ctx.args[0]);
    const r = await exportReport(s, outFile(ctx, s, 'report', 'html'));
    if (r.file !== '-') ctx.out.emit(r, (o) => showWrite(o, 'report', r));
  },
});

define({
  name: 'export bundle', section: 'Export', usage: '[id|latest] [--out-dir DIR]', summary: 'Portable folder: manifest with hashes, datasets, transcript, report, knowledge',
  description: 'Writes a self-describing folder you can archive or hand to another tool. Raw captures are excluded unless --with-raw is given (raw can contain page content; treat the bundle as private either way).',
  flags: {
    'out-dir': { type: 'string', valueName: 'DIR', desc: 'Destination folder (default ./<session>-bundle)' },
    format: { type: 'string', alias: 'f', choices: DATASET_FORMATS, default: 'jsonl', desc: 'Dataset format inside the bundle' },
    exclude: { type: 'list', valueName: 'NAMES', desc: 'Datasets to leave out (e.g. events)' },
    'with-raw': { type: 'boolean', desc: 'Also copy the raw log segments' },
    derived: { type: 'boolean', desc: 'Also write derived views (model-types, graph-edges, …) as dataset files' },
  },
  async run(ctx) {
    const f = ctx.flags;
    const s = await prepared(ctx, ctx.args[0]);
    const r = await exportBundle(s, f['out-dir'] ?? `${s.id}-bundle`, { format: f.format, exclude: f.exclude, includeRaw: f['with-raw'], derived: f.derived });
    ctx.out.emit(r, (o) => {
      o.result(`Wrote bundle with ${r.files} file(s) to ${r.dir}`);
      for (const k of r.skipped) o.line(`  skipped ${k.name}: ${k.reason}`);
      o.line(o.c.dim(`Manifest: ${r.manifest}`));
    });
  },
});

define({
  name: 'export schemas', section: 'Export', usage: '[id|latest] [--type TYPE] [--out FILE]', summary: 'Export observed schemas as a draft-2020-12 JSON Schema definition bundle',
  flags: {
    type: { type: 'string', valueName: 'TYPE', desc: 'Only this type (exact id or name)' },
    out: { type: 'string', alias: 'o', valueName: 'FILE', desc: 'Output file; "-" writes to stdout' },
  },
  async run(ctx) {
    const session = ctx.session(ctx.args[0]);
    const result = await exportSchemas(session, outFile(ctx, session, 'schemas', 'json'), { type: ctx.flags.type });
    if (result.file !== '-') ctx.out.emit(result, (out) => showWrite(out, `${result.types} schemas`, result));
  },
});

define({
  name: 'export graph-ranked', section: 'Export', usage: '[id|latest] [--limit N] [--format F]', summary: 'Export graph nodes ranked by confidence-weighted PageRank',
  flags: {
    format: { type: 'string', alias: 'f', choices: DATASET_FORMATS, default: 'json', desc: 'Output format' },
    out: { type: 'string', alias: 'o', valueName: 'FILE', desc: 'Output file; "-" writes to stdout' },
    limit: { type: 'number', alias: 'n', valueName: 'N', default: 100, desc: 'Maximum ranked nodes' },
    seeds: { type: 'list', valueName: 'EIDS', desc: 'Entity ids for personalized graph ranking' },
  },
  async run(ctx) {
    const session = ctx.session(ctx.args[0]), f = ctx.flags;
    const result = await exportGraphRanked(session, outFile(ctx, session, 'graph-ranked', f.format), { format: f.format, limit: f.limit, seeds: f.seeds });
    if (result.file !== '-') ctx.out.emit(result, (out) => showWrite(out, `${result.nodes} ranked nodes`, result));
  },
});

define({
  name: 'export formats', section: 'Export', summary: 'List the formats each export supports', noData: true,
  async run(ctx) {
    const data = { dataset: DATASET_FORMATS, transcript: TRANSCRIPT_FORMATS, knowledge: KNOWLEDGE_FORMATS, graph: GRAPH_FORMATS, schemas: ['json-schema'], 'graph-ranked': DATASET_FORMATS, report: ['html'], bundle: ['directory'] };
    ctx.out.emit(data, (o) => o.kv(Object.entries(data).map(([k, v]) => [k, v.join(', ')]), 0));
  },
});
