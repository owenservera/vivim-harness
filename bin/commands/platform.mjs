// detect, scan, csv, dedupe, kb graph-stats|keyphrases, integrity build|verify, platform stats|registry
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { EXIT } from '../../src/config.mjs';
import { define, defineGroup } from '../lib/registry.mjs';
import { usageError, notFound, fmtBytes } from '../lib/ui.mjs';
import { capability } from '../lib/capabilities.mjs';

// ---------------------------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------------------------

// Read a file argument, or stdin for "-" / no argument.
function readInput(ref) {
  if (!ref || ref === '-') {
    try { return readFileSync(0, 'utf8'); } catch { throw usageError('No input on stdin.', 'Pipe text in: cat page.json | studio detect -'); }
  }
  const file = path.resolve(ref);
  try { statSync(file); } catch { throw notFound(`No file "${ref}".`); }
  return readFileSync(file, 'utf8');
}

// First array of objects found on a result document (engines differ in naming).
const ROW_KEYS = ['tables', 'sections', 'candidates', 'detections', 'fields', 'items', 'rows', 'entities', 'findings', 'matches', 'clusters', 'phrases'];
function firstRows(result, keys = ROW_KEYS) {
  if (Array.isArray(result)) return result;
  for (const k of keys) if (Array.isArray(result?.[k]) && result[k].length) return result[k];
  return null;
}

const cell = (v) => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
function columnsFor(rows, max = 6) {
  const keys = [...new Set(rows.slice(0, 5).flatMap((r) => (r && typeof r === 'object' ? Object.keys(r) : [])))].slice(0, max);
  return keys.map((k) => ({ title: k.toUpperCase(), get: (r) => cell(r?.[k]), max: 40 }));
}

function findingsOf(scan) {
  if (!scan) return [];
  if (Array.isArray(scan)) return scan;
  for (const k of ['findings', 'secrets', 'credentials', 'matches', 'hits', 'items']) if (Array.isArray(scan[k])) return scan[k];
  return [];
}

// ---------------------------------------------------------------------------------------------
defineGroup('platform', {
  section: 'System', default: 'stats',
  summary: 'Local platform capabilities, statistics and registry snapshot',
  description: 'Read-only views of the platform layer: what this build can do and how the local registry is composed.',
});

define({
  name: 'platform stats', section: 'System', summary: 'Platform capability and usage statistics',
  async run(ctx) {
    const mod = await capability('../../src/intel/platform.mjs', ['platformStats'], 'Platform statistics');
    const stats = await mod.platformStats();
    ctx.out.emit(stats, (o) => {
      if (stats && typeof stats === 'object' && !Array.isArray(stats)) {
        o.kv(Object.entries(stats).map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : String(v)]));
        const rows = firstRows(stats);
        if (rows) { o.line(''); o.table(rows, columnsFor(rows)); }
      } else o.result(JSON.stringify(stats, null, 2));
    });
  },
});

define({
  name: 'platform registry', section: 'System', summary: 'Snapshot of the local platform registry',
  async run(ctx) {
    const mod = await capability('../../src/intel/platform.mjs', ['registrySnapshot'], 'Platform registry');
    const snapshot = await mod.registrySnapshot();
    ctx.out.emit(snapshot, (o) => {
      const rows = firstRows(snapshot, ['entries', 'items', 'plugins', 'sources', 'rows']);
      if (rows) { o.table(rows, columnsFor(rows)); return; }
      o.result(JSON.stringify(snapshot, null, 2));
    });
  },
});

// ---------------------------------------------------------------------------------------------
define({
  name: 'detect', section: 'Knowledge', usage: '<file|->', summary: 'Detect the shape of a saved document or stream and summarise it',
  flags: { limit: { type: 'number', alias: 'n', valueName: 'N', default: 20, desc: 'Show at most N detected items' } },
  examples: ['studio detect page.json', 'cat stream.jsonl | studio detect - --json'],
  async run(ctx) {
    const text = readInput(ctx.args[0]);
    const mod = await capability('../../src/intel/platform.mjs', ['detectAndScan'], 'Document detection');
    const result = await mod.detectAndScan(text);
    const rows = firstRows(result) ?? [];
    ctx.out.emit(result, (o) => {
      o.result(`Detected ${rows.length} item(s) in ${fmtBytes(Buffer.byteLength(text))}${result?.kind ? ` (${result.kind})` : ''}${result?.format ? ` as ${result.format}` : ''}.`);
      if (rows.length) { o.line(''); o.table(rows.slice(0, ctx.flags.limit), columnsFor(rows)); }
      const scan = result?.securityScan;
      if (scan) o.line(o.c.dim(`security scan: ${findingsOf(scan).length} finding(s)`));
      if (!rows.length && !scan) { o.line(''); o.result(JSON.stringify(result, null, 2)); }
    });
  },
});

define({
  name: 'scan', section: 'Knowledge', usage: '<file|-> [--pii]', summary: 'Scan text for credentials (exit 4 when any are found)',
  description: 'Runs only the security scan of document detection. Exits 4 (lint-style) when a credential is found, 0 otherwise — suitable for pre-commit or CI use.',
  flags: { pii: { type: 'boolean', desc: 'Also report personal-data matches' } },
  examples: ['studio scan notes.txt', 'studio scan - < payload.json --json'],
  async run(ctx) {
    const text = readInput(ctx.args[0]);
    const mod = await capability('../../src/intel/platform.mjs', ['detectAndScan'], 'Security scan');
    const result = await mod.detectAndScan(text, ctx.flags.pii ? { pii: true } : undefined);
    const scan = result?.securityScan ?? result;
    const findings = findingsOf(scan);
    const found = findings.length || Number(scan?.count ?? scan?.total ?? scan?.found ?? 0);
    ctx.out.emit({ found, pii: !!ctx.flags.pii, findings, scan }, (o) => {
      if (findings.length) o.table(findings, columnsFor(findings));
      o.result(found ? `${found} credential finding(s) — failing with exit 4.` : 'No credentials found.');
    });
    if (found) process.exitCode = EXIT.INTEGRITY;
  },
});

define({
  name: 'csv', section: 'Knowledge', usage: '<file|->', summary: 'Analyse delimited text: columns, types and row statistics',
  flags: { limit: { type: 'number', alias: 'n', valueName: 'N', default: 20, desc: 'Show at most N rows' } },
  examples: ['studio csv export.csv', 'studio csv - --json < table.tsv'],
  async run(ctx) {
    const text = readInput(ctx.args[0]);
    const mod = await capability('../../src/intel/platform.mjs', ['csvAnalyze'], 'CSV analysis');
    const result = await mod.csvAnalyze(text);
    const cols = Array.isArray(result?.header) ? result.header : Array.isArray(result?.columns) ? result.columns : [];
    const rawRows = Array.isArray(result?.records) ? result.records : Array.isArray(result?.rows) ? result.rows : [];
    const rows = rawRows.slice(0, ctx.flags.limit).map((r) => (Array.isArray(r) ? Object.fromEntries(cols.map((c, i) => [typeof c === 'string' ? c : c?.name ?? `c${i}`, r[i]])) : r));
    ctx.out.emit(result, (o) => {
      const stats = result?.stats ?? result?.summary;
      if (stats && typeof stats === 'object') { o.kv(Object.entries(stats).map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : String(v)])); o.line(''); }
      const colRows = cols.filter((c) => c && typeof c === 'object');
      if (colRows.length) { o.table(colRows, columnsFor(colRows)); o.line(''); }
      o.result(`${result?.stats?.rows ?? rawRows.length ?? 0} row(s), ${result?.stats?.columns ?? cols.length} column(s).`);
      if (rows.length) o.table(rows, columnsFromStrings(rows, cols));
    });
  },
});

// Column spec for row objects built from header names.
function columnsFromStrings(rows, cols) {
  const keys = Object.keys(rows[0] ?? {});
  if (keys.length) return columnsFor(rows, 8);
  return cols.slice(0, 8).map((c, i) => ({ title: String(typeof c === 'string' ? c : c?.name ?? `c${i}`).toUpperCase(), get: (r) => cell(r?.[i] ?? r?.[`c${i}`]), max: 30 }));
}

// ---------------------------------------------------------------------------------------------
define({
  name: 'dedupe', section: 'Knowledge', usage: '<session>', summary: 'Find duplicate or near-duplicate records in a saved session',
  flags: {
    max: { type: 'number', valueName: 'N', default: 1000, desc: 'Maximum records considered' },
    threshold: { type: 'number', valueName: 'F', default: 0.9, desc: 'Similarity threshold (0-1)' },
  },
  examples: ['studio dedupe latest', 'studio dedupe latest --threshold 0.8 --json'],
  async run(ctx) {
    if (ctx.flags.threshold !== undefined && !(ctx.flags.threshold >= 0 && ctx.flags.threshold <= 1)) throw usageError('--threshold must be between 0 and 1.');
    if (ctx.flags.max !== undefined && !(ctx.flags.max > 0)) throw usageError('--max must be a positive integer.');
    const session = ctx.session(ctx.args[0]);
    const mod = await capability('../../src/intel/platform.mjs', ['dedupeSession'], 'Duplicate detection');
    const result = await mod.dedupeSession(session, { max: ctx.flags.max, threshold: ctx.flags.threshold });
    const clusters = Array.isArray(result) ? result : result?.clusters ?? [];
    const stats = Array.isArray(result) ? { clusters: clusters.length } : result?.stats ?? {};
    const rows = clusters.map((c, i) => ({ id: c.id ?? c.key ?? `c${i + 1}`, size: c.size ?? c.members?.length ?? 0, members: (c.members ?? []).slice(0, 5).map((m) => (typeof m === 'string' ? m : m.id ?? m.eid ?? JSON.stringify(m))).join(', ') }));
    ctx.out.emit({ session: session.id, stats, clusters }, (o) => {
      o.result(`Dedupe ${session.id}: ${clusters.length} cluster(s), ${rows.reduce((a, r) => a + r.size, 0)} record(s).`);
      if (Object.keys(stats).length) o.kv(Object.entries(stats).map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : String(v)]));
      if (rows.length) { o.line(''); o.table(rows, [{ title: 'CLUSTER', key: 'id', max: 34 }, { title: 'SIZE', key: 'size', align: 'right' }, { title: 'MEMBERS (first 5)', get: (r) => r.members, max: 80 }]); }
    });
  },
});

// ---------------------------------------------------------------------------------------------
define({
  name: 'knowledge graph-stats', section: 'Knowledge', usage: '[id|latest]', summary: 'Graph statistics, top pagerank nodes and community summary',
  flags: { limit: { type: 'number', alias: 'n', valueName: 'N', default: 10, desc: 'Show at most N ranked nodes' } },
  examples: ['studio kb graph-stats latest', 'studio kb graph-stats latest --json'],
  async run(ctx) {
    const session = ctx.session(ctx.args[0]);
    const mod = await capability('../../src/intel/platform.mjs', ['analyzeSessionGraph'], 'Graph analysis');
    const result = await mod.analyzeSessionGraph(session);
    const stats = result?.stats ?? (Array.isArray(result) ? {} : result) ?? {};
    let rank = result?.pagerank ?? result?.rank ?? [];
    if (!Array.isArray(rank) && rank && typeof rank === 'object') rank = Object.entries(rank).map(([id, score]) => ({ id, score: typeof score === 'number' ? score : score?.score }));
    const ranked = [...(Array.isArray(rank) ? rank : [])].sort((a, b) => (b.score ?? b.rank ?? 0) - (a.score ?? a.rank ?? 0)).slice(0, ctx.flags.limit)
      .map((n) => ({ id: n.id ?? n.eid ?? n.node ?? '', score: n.score ?? n.rank ?? n.pagerank ?? 0 }));
    const communities = result?.communities ?? result?.communitySummary ?? null;
    const commCount = Array.isArray(communities) ? communities.length : communities?.count ?? communities?.length ?? 0;
    const commSizes = Array.isArray(communities) ? communities.map((c) => c.size ?? c.members?.length ?? 0) : communities?.sizes ?? [];
    ctx.out.emit(result, (o) => {
      o.result(`Graph for ${session.id}: ${stats.nodes ?? stats.nodeCount ?? '?'} node(s), ${stats.edges ?? stats.edgeCount ?? '?'} edge(s).`);
      const entries = Object.entries(stats).filter(([, v]) => v !== null && typeof v !== 'object');
      if (entries.length) o.kv(entries.map(([k, v]) => [k, String(v)]));
      if (ranked.length) { o.line(''); o.heading(`Top ${ranked.length} by pagerank`); o.table(ranked, [{ title: 'NODE', key: 'id', max: 40 }, { title: 'SCORE', get: (r) => (Number.isFinite(Number(r.score)) ? Number(r.score).toFixed(4) : ''), align: 'right' }], { indent: 2 }); }
      o.line(''); o.heading('Communities');
      o.line(`  ${commCount} community/communities${commSizes.length ? `, largest ${Math.max(...commSizes)}` : ''}`);
    });
  },
});

define({
  name: 'knowledge keyphrases', section: 'Knowledge', usage: '[id|latest]', summary: 'Extract key phrases from a saved session',
  flags: { limit: { type: 'number', alias: 'n', valueName: 'N', default: 25, desc: 'Show at most N phrases' } },
  examples: ['studio kb keyphrases latest', 'studio kb keyphrases latest --limit 10 --json'],
  async run(ctx) {
    const session = ctx.session(ctx.args[0]);
    const mod = await capability('../../src/intel/platform.mjs', ['keyphrasesSession'], 'Keyphrase extraction');
    const raw = await mod.keyphrasesSession(session, { limit: ctx.flags.limit });
    const list = Array.isArray(raw) ? raw : raw?.keyphrases ?? raw?.phrases ?? [];
    const rows = list.slice(0, ctx.flags.limit).map((p) => (typeof p === 'string' ? { phrase: p } : { phrase: p.phrase ?? p.term ?? p.text ?? '', score: p.score ?? p.weight ?? p.count }));
    ctx.out.emit({ session: session.id, keyphrases: list.slice(0, ctx.flags.limit) }, (o) => {
      o.table(rows, [{ title: 'PHRASE', key: 'phrase', max: 70 }, { title: 'SCORE', get: (r) => (r.score === undefined ? '' : typeof r.score === 'number' ? r.score.toFixed(3) : String(r.score)), align: 'right' }], { empty: 'No keyphrases found.' });
    });
  },
});

// ---------------------------------------------------------------------------------------------
defineGroup('integrity', {
  section: 'System', default: 'verify',
  summary: 'Build or verify a SHA-256 manifest of a session directory',
  description: 'Builds MANIFEST.json over every file in a directory, or verifies an existing manifest (exit 4 when it does not match). Accepts a directory path or a session reference.',
});

function targetDir(ctx, ref, kind) {
  if (!ref) throw usageError(`Give a directory or session reference to ${kind}.`, 'Example: studio integrity build latest');
  const asPath = path.resolve(ref);
  try { if (statSync(asPath).isDirectory()) return asPath; } catch { /* not a path: treat as a session reference */ }
  return ctx.session(ref).dir;
}

define({
  name: 'integrity build', section: 'System', usage: '<dir|session>', summary: 'Write a SHA-256 manifest for a directory',
  examples: ['studio integrity build latest', 'studio integrity build ./backup'],
  async run(ctx) {
    const dir = targetDir(ctx, ctx.args[0], 'build');
    const mod = await capability('../../src/store/integrity.mjs', ['buildManifest', 'verifyManifest'], 'Integrity manifest');
    const manifest = mod.buildManifest(dir);
    ctx.out.emit({ dir, format: manifest.format, rootSha256: manifest.rootSha256, files: manifest.files?.length ?? 0 }, (o) => o.result(`Manifest written for ${dir}: ${manifest.files?.length ?? 0} file(s), root ${manifest.rootSha256}.`));
  },
});

define({
  name: 'integrity verify', section: 'System', usage: '<dir|session>', summary: 'Verify a directory against its manifest (exit 4 when it does not match)',
  examples: ['studio integrity verify latest', 'studio integrity verify ./backup --json'],
  async run(ctx) {
    const dir = targetDir(ctx, ctx.args[0], 'verify');
    const mod = await capability('../../src/store/integrity.mjs', ['verifyManifest'], 'Integrity verification');
    let report;
    try { report = mod.verifyManifest(dir); } catch (e) { throw usageError(e.message, 'Create one with "studio integrity build <dir>".'); }
    ctx.out.emit({ dir, ...report }, (o) => {
      o.result(`${report.ok ? 'OK' : 'FAILED'} ${dir}: ${report.checked ?? 0} checked, ${report.missing?.length ?? 0} missing, ${report.changed?.length ?? 0} changed, ${report.extra?.length ?? 0} extra.`);
      if (report.missing?.length) o.line(`  missing: ${report.missing.slice(0, 5).join(', ')}`);
      if (report.changed?.length) o.line(`  changed: ${report.changed.slice(0, 5).join(', ')}`);
      if (report.extra?.length) o.line(`  extra: ${report.extra.slice(0, 5).join(', ')}`);
    });
    if (!report.ok) process.exitCode = EXIT.INTEGRITY;
  },
});
