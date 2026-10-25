// session list|show|datasets|streams|timeline|events|delete|prune, plus verify, receipt, shapes
import { existsSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Session } from '../../src/store/session.mjs';
import { datasetCatalog } from '../../src/export/export.mjs';
import { EXIT } from '../../src/config.mjs';
import { define, defineGroup } from '../lib/registry.mjs';
import { usageError, notFound, CliError, fmtBytes, fmtAgo, fmtMs, fmtPct, parseSince, truncate, oneLine } from '../lib/ui.mjs';
import { needArg, knowledgeState, isDerived, siteLabel, looksActive, readRows, intFlag, eventText } from '../lib/util.mjs';
import { unavailable } from '../lib/capabilities.mjs';

defineGroup('session', {
  summary: 'List and inspect saved recordings', section: 'Sessions', default: 'list',
  description: 'Saved recordings: list, inspect, browse streams / timeline / events, delete and prune. A session reference is an id, a unique id prefix or suffix, "latest", "latest~N" or "latest:<site>".',
  subAliases: { ls: 'list', info: 'show', rm: 'delete' },
});

const sessionRow = (m) => ({
  id: m.id, status: m.status, createdAt: m.createdAt, endedAt: m.endedAt ?? null, endReason: m.endReason ?? null,
  site: siteLabel(m), title: m.target?.title ?? '', url: m.target?.url ?? '', profile: m.profile ? `${m.profile.name}@v${m.profile.version}` : null,
  rawBytes: m.rawBytes ?? 0, integrityOk: m.integrity?.ok ?? null, records: m.integrity?.records ?? null,
});

for (const [command, method, summary] of [
  ['stats', 'rawStats', 'Raw storage statistics and index coverage'],
  ['reindex', 'reindex', 'Rebuild the raw seek index from saved segments'],
]) define({
  name: `session ${command}`, section: 'Sessions', usage: '[id|latest]', summary,
  async run(ctx) {
    const session = ctx.session(ctx.args[0]);
    if (typeof session[method] !== 'function') throw unavailable(`Session ${command}`);
    if (command === 'reindex' && looksActive(session)) throw new CliError('Stop recording before rebuilding the raw index.', { exit: EXIT.INTEGRITY, code: 'ACTIVE' });
    const result = await session[method]();
    ctx.out.emit({ session: session.id, result }, (out) => out.result(JSON.stringify(result, null, 2)));
  },
});

define({
  name: 'session compact', section: 'Sessions', usage: '[id|latest] [--dry-run | --replace --yes]',
  summary: 'Compact raw records into a new sidecar directory; original raw is kept',
  description: 'By default writes a uniquely named compacted sidecar. Merging chunks preserves bytes but changes record/timing granularity. --replace --yes makes it the active raw log and retains the original in a backup directory. Stop recording first.',
  flags: {
    'dry-run': { type: 'boolean', desc: 'Estimate savings without writing a compacted log' },
    replace: { type: 'boolean', desc: 'Make compacted raw active, retaining the original as a backup' },
    yes: { type: 'boolean', alias: 'y', desc: 'Confirm replacing the active raw log' },
    'merge-chunks': { type: 'boolean', desc: 'Merge adjacent chunks (default on; --no-merge-chunks to disable)' },
  },
  async run(ctx) {
    const session = ctx.session(ctx.args[0]);
    if (looksActive(session)) throw new CliError('Stop recording before compacting raw data.', { exit: EXIT.INTEGRITY, code: 'ACTIVE' });
    const f = ctx.flags, method = f['dry-run'] ? 'compactionEstimate' : 'compact';
    if (typeof session[method] !== 'function') throw unavailable(`Session ${method}`);
    if (f.replace && !f.yes && !f['dry-run']) throw usageError('--replace requires --yes; the original raw log will be kept as a backup.');
    const outDir = `raw-compact-${randomUUID()}`;
    if (existsSync(path.join(session.dir, outDir))) throw new CliError('Compaction destination already exists; retry.');
    const result = await session[method]({ mergeChunks: f['merge-chunks'] !== false, replace: !!f.replace, out: outDir });
    ctx.out.emit({ session: session.id, dryRun: !!f['dry-run'], ...(!f['dry-run'] ? { directory: f.replace ? 'raw' : outDir } : {}), result }, (out) => out.result(JSON.stringify(result, null, 2)));
  },
});

// ---------------------------------------------------------------------------------------------
define({
  name: 'session list', section: 'Sessions', aliases: ['sessions', 'ls'], usage: '[--site S] [--status ST]', summary: 'List saved recordings (newest first)',
  flags: {
    site: { type: 'string', valueName: 'TEXT', desc: 'Only sessions whose site/URL contains TEXT' },
    status: { type: 'string', valueName: 'STATUS', desc: 'Only sessions with this status (complete, recording, …; prefix match)' },
    since: { type: 'string', valueName: 'AGE|DATE', desc: 'Only sessions created within e.g. 7d, 12h, or after an ISO date' },
    limit: { type: 'number', alias: 'n', valueName: 'N', desc: 'Show at most N sessions' },
    sort: { type: 'string', choices: ['created', 'size', 'name'], default: 'created', desc: 'Sort order' },
    long: { type: 'boolean', desc: 'Add derived / knowledge state columns' },
  },
  examples: ['studio sessions', 'studio sessions --site claude.ai --since 7d --json', 'studio sessions --sort size -n 5 --long'],
  async run(ctx) {
    const f = ctx.flags;
    let list = ctx.listSessions();
    if (f.site) { const q = f.site.toLowerCase(); list = list.filter((s) => `${siteLabel(s)} ${s.target?.url ?? ''} ${s.site ?? ''}`.toLowerCase().includes(q)); }
    if (f.status) list = list.filter((s) => String(s.status).startsWith(f.status));
    if (f.since) { const cutoff = parseSince(f.since); list = list.filter((s) => Date.parse(s.createdAt) >= cutoff); }
    if (f.sort === 'size') list = [...list].sort((a, b) => b.rawBytes - a.rawBytes);
    else if (f.sort === 'name') list = [...list].sort((a, b) => a.id.localeCompare(b.id));
    const total = list.length;
    if (f.limit) list = list.slice(0, f.limit);
    let rows = list.map(sessionRow);
    if (f.long || ctx.out.json) {
      rows = rows.map((r, i) => { const s = Session.open(ctx.paths.sessions, r.id); return { ...r, derived: isDerived(s), knowledge: knowledgeState(s), verdict: s.kv.get('RECEIPT', null)?.verdict ?? null }; });
    }
    ctx.out.emit({ total, shown: rows.length, sessions: rows }, (o) => {
      if (!rows.length) { o.result('No sessions yet. Record one with "studio capture <url>".'); return; }
      const cols = [
        { title: 'ID', key: 'id', max: 44 }, { title: 'STATUS', get: (r) => r.status, max: 26 }, { title: 'AGE', get: (r) => fmtAgo(r.createdAt) },
        { title: 'SIZE', get: (r) => fmtBytes(r.rawBytes), align: 'right' }, { title: 'SITE', key: 'site', max: 28 },
        ...(f.long ? [{ title: 'DERIVED', get: (r) => (r.derived ? 'yes' : 'no') }, { title: 'KNOWLEDGE', key: 'knowledge' }, { title: 'VERDICT', get: (r) => r.verdict ?? '-', max: 24 }] : [{ title: 'TITLE', key: 'title', max: 40 }]),
      ];
      o.table(rows, cols);
      if (total > rows.length) o.line(o.c.dim(`${total - rows.length} more (use --limit).`));
    });
  },
});

// ---------------------------------------------------------------------------------------------
define({
  name: 'session show', section: 'Sessions', aliases: ['info'], usage: '[id|latest]', summary: 'Everything about one session at a glance',
  flags: { counts: { type: 'boolean', desc: 'Count rows in each dataset (slower on big sessions)' } },
  async run(ctx) {
    const s = ctx.session(ctx.args[0]);
    const m = s.meta;
    const receipt = s.kv.get('RECEIPT', null);
    const catalog = await datasetCatalog(s, { counts: !!ctx.flags.counts });
    const row = sessionRow({ ...(ctx.listSessions().find((x) => x.id === s.id) ?? m) });
    const data = {
      ...row, dir: s.dir, browser: m.browser, collector: m.collector ?? null, options: m.options ?? null, stats: m.stats ?? null,
      knowledge: { state: knowledgeState(s), status: s.kv.get('KNOWLEDGE_STATUS', null) },
      receipt: receipt ? { verdict: receipt.verdict, transport: receipt.actual_response_transport, chunks: receipt.raw_chunks_received, bytes: receipt.raw_bytes_received, quality: receipt.quality ?? null, family: receipt.family ?? null, knowledge: receipt.knowledge ?? null } : null,
      datasets: catalog,
    };
    ctx.out.emit(data, (o) => {
      o.heading(s.id);
      o.kv([['target', `${data.title} ${data.url}`.trim()], ['site', data.site], ['status', `${m.status}${m.endReason ? ` (${m.endReason})` : ''}`], ['created', `${m.createdAt} (${fmtAgo(m.createdAt)})`],
        ['profile', data.profile], ['browser', m.browser], ['raw size', fmtBytes(data.rawBytes)], ['integrity', m.integrity ? `${m.integrity.ok ? 'ok' : 'WARNINGS'}, ${m.integrity.records} records, ${m.integrity.gapRecords} gap(s)` : 'unchecked'], ['directory', s.dir]]);
      o.line('');
      if (receipt) {
        o.heading('Receipt');
        o.kv([['verdict', receipt.verdict], ['transport', receipt.actual_response_transport], ['chunks', receipt.raw_chunks_received], ['received', fmtBytes(receipt.raw_bytes_received)], ['first byte', fmtMs(receipt.first_byte_observed_ms)],
          ['family', receipt.family ? `${receipt.family.best} (${fmtPct(receipt.family.score)})` : ''], ['knowledge', receipt.knowledge ? (receipt.knowledge.error ? `failed at ${receipt.knowledge.stage}` : `${receipt.knowledge.types} types, ${receipt.knowledge.entities} entities, ${receipt.knowledge.edges} edges`) : data.knowledge.state]]);
      } else o.line(o.c.yellow(`Not derived yet. Run "studio derive ${s.id}".`));
      o.line('');
      o.heading('Datasets');
      o.table(catalog, [{ title: 'NAME', key: 'name' }, { title: 'KIND', key: 'kind' }, ...(ctx.flags.counts ? [{ title: 'ROWS', get: (d) => d.rows ?? '-', align: 'right' }] : []), { title: 'SIZE', get: (d) => (d.bytes ? fmtBytes(d.bytes) : ''), align: 'right' }], { empty: 'No datasets (run "studio derive").' });
    });
  },
});

define({
  name: 'session datasets', section: 'Sessions', usage: '[id|latest]', summary: 'List the datasets you can export, with row counts',
  async run(ctx) {
    const s = ctx.session(ctx.args[0]);
    const catalog = await datasetCatalog(s, { counts: true });
    ctx.out.emit({ session: s.id, datasets: catalog }, (o) => o.table(catalog, [{ title: 'NAME', key: 'name' }, { title: 'KIND', key: 'kind' }, { title: 'ROWS', get: (d) => d.rows, align: 'right' }, { title: 'SIZE', get: (d) => (d.bytes ? fmtBytes(d.bytes) : ''), align: 'right' }, { title: 'ABOUT', get: (d) => d.description ?? '', max: 50 }], { empty: `No datasets. Run "studio derive ${s.id}".` }));
  },
});

// ---------------------------------------------------------------------------------------------
define({
  name: 'session streams', section: 'Sessions', usage: '[id|latest]', summary: 'Streams and requests observed in a session',
  flags: {
    transport: { type: 'string', valueName: 'TEXT', desc: 'Only transports containing TEXT (sse, websocket, ndjson, http …)' },
    grep: { type: 'string', valueName: 'TEXT', desc: 'Only streams whose endpoint contains TEXT' },
    'min-bytes': { type: 'number', valueName: 'N', desc: 'Only streams with at least N bytes' },
    streaming: { type: 'boolean', desc: 'Only streaming transports (SSE, NDJSON, WebSocket, EventSource, chunked)' },
    limit: { type: 'number', alias: 'n', valueName: 'N', desc: 'Show at most N rows' },
  },
  async run(ctx) {
    const s = ctx.session(ctx.args[0]);
    await ctx.ensureDerived(s, { need: 'RECEIPT' });
    const f = ctx.flags;
    let rows = await readRows(s, 'streams');
    if (f.transport) rows = rows.filter((r) => String(r.transport ?? '').toLowerCase().includes(f.transport.toLowerCase()));
    if (f.grep) rows = rows.filter((r) => String(r.endpoint ?? r.url ?? '').toLowerCase().includes(f.grep.toLowerCase()));
    if (f['min-bytes']) rows = rows.filter((r) => (r.bytes ?? 0) >= f['min-bytes']);
    if (f.streaming) rows = rows.filter((r) => ['HTTP_SSE', 'HTTP_NDJSON', 'HTTP_STREAMED', 'EVENT_SOURCE', 'WEBSOCKET'].includes(r.transport));
    rows.sort((a, b) => (b.events ?? 0) - (a.events ?? 0) || (b.bytes ?? 0) - (a.bytes ?? 0));
    if (f.limit) rows = rows.slice(0, f.limit);
    ctx.out.emit({ session: s.id, streams: rows }, (o) => o.table(rows, [
      { title: 'SID', key: 'sid' }, { title: 'TRANSPORT', get: (r) => r.transport ?? '-' }, { title: 'STATUS', get: (r) => r.status ?? '-', max: 18 },
      { title: 'BYTES', get: (r) => fmtBytes(r.bytes ?? 0), align: 'right' }, { title: 'EVENTS', get: (r) => r.events ?? 0, align: 'right' }, { title: 'ENDPOINT', get: (r) => r.endpoint ?? r.url, max: 70 },
    ], { empty: 'No streams match.' }));
  },
});

define({
  name: 'session timeline', section: 'Sessions', usage: '[id|latest]', summary: 'Actions, navigations, lifecycle and gaps over time',
  flags: { kind: { type: 'list', valueName: 'KINDS', desc: 'Only these kinds (action,nav,gap,lifecycle,done,fail,…)' }, limit: { type: 'number', alias: 'n', valueName: 'N', default: 200, desc: 'Show at most N rows' } },
  async run(ctx) {
    const s = ctx.session(ctx.args[0]);
    await ctx.ensureDerived(s);
    const kinds = ctx.flags.kind ? new Set(ctx.flags.kind) : null;
    const all = await readRows(s, 'timeline');
    const t0 = all[0]?.t ?? 0;
    const rows = all.filter((r) => !kinds || kinds.has(r.k)).slice(0, ctx.flags.limit).map((r) => ({ ...r, offsetSeconds: +((r.t - t0) / 1000).toFixed(2) }));
    ctx.out.emit({ session: s.id, total: all.length, rows }, (o) => {
      o.table(rows, [{ title: '+SEC', get: (r) => r.offsetSeconds.toFixed(2), align: 'right' }, { title: 'KIND', get: (r) => `${r.k}${r.kind ? `:${r.kind}` : ''}`, max: 28 }, { title: 'SID', get: (r) => r.sid ?? '' },
        { title: 'DETAIL', get: (r) => [r.label ? `“${r.label}”` : '', r.url ?? '', r.reason ?? '', r.error ? `ERROR ${r.error}` : ''].filter(Boolean).join(' '), max: 80 }], { empty: 'No timeline rows.' });
      if (all.length > rows.length) o.line(o.c.dim(`${all.length - rows.length} more rows (use --limit / --kind).`));
    });
  },
});

define({
  name: 'session events', section: 'Sessions', usage: '[id|latest] --sid SID', summary: 'Decoded protocol events (L2) of one stream',
  flags: { sid: { type: 'string', valueName: 'SID', desc: 'Stream id (see "studio session streams")' }, grep: { type: 'string', valueName: 'TEXT', desc: 'Only events containing TEXT' }, limit: { type: 'number', alias: 'n', valueName: 'N', default: 100, desc: 'Show at most N events' }, full: { type: 'boolean', desc: 'Do not truncate event text' } },
  async run(ctx) {
    const s = ctx.session(ctx.args[0]);
    if (!ctx.flags.sid) throw usageError('--sid is required.', `Find one with "studio session streams ${s.id} --streaming".`);
    await ctx.ensureDerived(s);
    const needle = ctx.flags.grep?.toLowerCase();
    const rows = await readRows(s, 'events', { limit: ctx.flags.limit, filter: (e) => e.sid === ctx.flags.sid && (!needle || eventText(e).toLowerCase().includes(needle)) });
    if (!rows.length) throw notFound(`No events for stream ${ctx.flags.sid}${needle ? ` matching "${ctx.flags.grep}"` : ''}.`);
    ctx.out.emit({ session: s.id, sid: ctx.flags.sid, events: rows }, (o) => {
      const t0 = rows[0].t;
      for (const e of rows) o.result(`${String(e.seq).padStart(6)}  +${((e.t - t0) / 1000).toFixed(3)}s  ${e.type ?? e.protocol ?? 'event'}${e.revision ? ` r${e.revision}` : ''}  ${ctx.flags.full ? oneLine(eventText(e)) : truncate(oneLine(eventText(e)), 140)}`);
    });
  },
});

// ---------------------------------------------------------------------------------------------
define({
  name: 'session delete', section: 'Sessions', aliases: ['delete', 'rm'], usage: '<id...> --yes', summary: 'Permanently delete saved sessions',
  flags: { yes: { type: 'boolean', alias: 'y', desc: 'Confirm deletion' }, force: { type: 'boolean', desc: 'Delete even if the session looks like it is still recording' } },
  async run(ctx) {
    if (!ctx.args.length) throw usageError('Missing session id.', 'Example: studio delete 20260101-… --yes');
    const targets = ctx.args.map((a) => ctx.session(a));
    for (const s of targets) if (looksActive(s) && !ctx.flags.force) throw new CliError(`${s.id} looks like it is being recorded right now.`, { exit: EXIT.INTEGRITY, code: 'ACTIVE', hint: 'Stop the recording first, or pass --force.' });
    const bytes = (s) => ctx.listSessions().find((x) => x.id === s.id)?.rawBytes ?? 0;
    if (!ctx.flags.yes) {
      ctx.out.emit({ deleted: [], wouldDelete: targets.map((s) => s.id), confirmed: false }, (o) => {
        for (const s of targets) o.result(`Would delete ${s.id} (${fmtBytes(bytes(s))}) at ${s.dir}`);
        o.result('Re-run with --yes to confirm.');
      });
      return;
    }
    const sizes = targets.map(bytes);
    for (const s of targets) rmSync(s.dir, { recursive: true, force: true });
    ctx.out.emit({ deleted: targets.map((s) => s.id), freedBytes: sizes.reduce((a, b) => a + b, 0), confirmed: true }, (o) => o.result(`Deleted ${targets.length} session(s), freed ${fmtBytes(sizes.reduce((a, b) => a + b, 0))}.`));
  },
});

define({
  name: 'session prune', section: 'Sessions', usage: '--older-than 30d [--keep N] [--yes]', summary: 'Delete old sessions in bulk (dry run unless --yes)',
  flags: {
    'older-than': { type: 'string', valueName: 'AGE', desc: 'Delete sessions created before this age (30d, 12h) or ISO date' },
    keep: { type: 'number', valueName: 'N', desc: 'Always keep the newest N sessions' },
    site: { type: 'string', valueName: 'TEXT', desc: 'Only consider sessions of this site' },
    status: { type: 'string', valueName: 'STATUS', desc: 'Only consider sessions with this status prefix' },
    yes: { type: 'boolean', alias: 'y', desc: 'Actually delete' },
  },
  async run(ctx) {
    const f = ctx.flags;
    if (!f['older-than'] && f.keep === undefined) throw usageError('Give --older-than AGE and/or --keep N.', 'Example: studio session prune --older-than 30d --keep 10');
    const all = ctx.listSessions();
    const protectedIds = new Set(all.slice(0, f.keep ?? 0).map((s) => s.id));
    const cutoff = f['older-than'] ? parseSince(f['older-than']) : Infinity;
    const candidates = all.filter((s) => !protectedIds.has(s.id) && Date.parse(s.createdAt) < cutoff
      && (!f.site || `${siteLabel(s)} ${s.target?.url ?? ''}`.toLowerCase().includes(f.site.toLowerCase())) && (!f.status || String(s.status).startsWith(f.status))
      && !looksActive(Session.open(ctx.paths.sessions, s.id)));
    const bytes = candidates.reduce((a, s) => a + s.rawBytes, 0);
    if (f.yes) for (const s of candidates) rmSync(path.join(ctx.paths.sessions, s.id), { recursive: true, force: true });
    ctx.out.emit({ deleted: f.yes ? candidates.map((s) => s.id) : [], wouldDelete: f.yes ? [] : candidates.map((s) => s.id), bytes, confirmed: !!f.yes }, (o) => {
      if (!candidates.length) { o.result('Nothing to prune.'); return; }
      for (const s of candidates) o.result(`${f.yes ? 'Deleted' : 'Would delete'} ${s.id}  ${fmtBytes(s.rawBytes)}  ${fmtAgo(s.createdAt)}`);
      o.result(f.yes ? `Freed ${fmtBytes(bytes)}.` : `${candidates.length} session(s), ${fmtBytes(bytes)}. Re-run with --yes to delete.`);
    });
  },
});

// ---------------------------------------------------------------------------------------------
define({
  name: 'verify', section: 'Sessions', usage: '[id|latest]', summary: 'Integrity check: hashes, sequence accounting, declared gaps',
  description: 'Exits 4 when a segment hash does not match, a segment is torn, or a sequence hole is not explained by a declared gap record.',
  flags: { all: { type: 'boolean', desc: 'Verify every saved session' } },
  async run(ctx) {
    const sessions = ctx.flags.all ? ctx.listSessions().map((m) => Session.open(ctx.paths.sessions, m.id)) : [ctx.session(ctx.args[0])];
    const results = [];
    for (const s of sessions) { ctx.out.info(`Verifying ${s.id}…`); results.push({ session: s.id, ...(await s.verify()) }); }
    const bad = results.filter((r) => !r.ok);
    ctx.out.emit(ctx.flags.all ? { ok: !bad.length, results } : results[0], (o) => {
      for (const r of results) {
        o.result(`${r.ok ? o.c.green('ok  ') : o.c.red('FAIL')} ${r.session}  ${r.records} records, ${r.segments.length} segment(s), ${r.gapRecords} declared gap(s)${r.droppedRecords ? `, ${r.droppedRecords} dropped` : ''}${r.unexplainedSeqGaps ? `, ${r.unexplainedSeqGaps} UNEXPLAINED sequence hole(s)` : ''}`);
        for (const seg of r.segments.filter((x) => x.shaMatches === false || x.torn)) o.result(`     segment ${seg.file}: ${seg.shaMatches === false ? 'hash mismatch' : ''}${seg.torn ? ' torn write' : ''}`);
      }
    });
    if (bad.length) process.exitCode = EXIT.INTEGRITY;
  },
});

define({
  name: 'receipt', section: 'Sessions', usage: '[id|latest]', summary: 'Metadata-only lab receipt (safe to paste into an issue)',
  flags: { summary: { type: 'boolean', desc: 'Print a short readable summary instead of the full JSON' } },
  async run(ctx) {
    const s = ctx.session(ctx.args[0]);
    await ctx.ensureDerived(s);
    const r = s.kv.get('RECEIPT');
    if (ctx.flags.summary && !ctx.out.json) {
      ctx.out.kv([['verdict', r.verdict], ['transport', r.actual_response_transport], ['chunks', r.raw_chunks_received], ['received', fmtBytes(r.raw_bytes_received)], ['first byte', fmtMs(r.first_byte_observed_ms)], ['gaps', r.replay_and_gap_diagnostics?.gap_records], ['scope', r.attachment_method_and_scope]], 0);
      return;
    }
    ctx.out.raw(`${JSON.stringify(r, null, 2)}\n`);
  },
});

define({
  name: 'shapes', section: 'Sessions', usage: '[id|latest]', summary: 'Profile suggestions inferred from a session',
  flags: { 'min-confidence': { type: 'number', valueName: '0-1', desc: 'Only suggestions at or above this confidence' }, kind: { type: 'string', valueName: 'KIND', desc: 'Only this suggestion kind' }, limit: { type: 'number', alias: 'n', valueName: 'N', desc: 'Show at most N' } },
  async run(ctx) {
    const s = ctx.session(ctx.args[0]);
    await ctx.ensureDerived(s, { need: 'SHAPES' });
    const rep = s.kv.get('SHAPES');
    let list = rep.suggestions ?? [];
    if (ctx.flags['min-confidence'] !== undefined) list = list.filter((g) => g.confidence >= ctx.flags['min-confidence']);
    if (ctx.flags.kind) list = list.filter((g) => g.kind === ctx.flags.kind);
    if (ctx.flags.limit) list = list.slice(0, ctx.flags.limit);
    ctx.out.emit({ session: s.id, suggestions: list }, (o) => {
      if (!list.length) { o.result('No suggestions.'); return; }
      for (const g of list) o.result(`${String(Math.round(g.confidence * 100)).padStart(3)}%  ${g.id.padEnd(28)} ${g.title}\n      ${g.detail}`);
      o.line(o.c.dim(`Apply one with: studio profile apply <profile> --session ${s.id} --suggestion <id>`));
    });
  },
});
