// derive, replay
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { Session } from '../../src/store/session.mjs';
import { stateAt, streamBytes, streamRolesCurrent } from '../../src/replay/derive.mjs';
import { DeltaAssembler } from '../../src/decode/delta.mjs';
import { isStreaming } from '../../src/replay/reducer.mjs';
import { define } from '../lib/registry.mjs';
import { usageError, notFound, fmtBytes, fmtMs, truncate, oneLine } from '../lib/ui.mjs';
import { knowledgeState, isDerived, looksActive, parseAt, sessionStartT, readRows, eventText } from '../lib/util.mjs';
import { capability, stageProgress } from '../lib/capabilities.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Batch selection for `derive --all|--missing`. Pure apart from `open`, which is injected.
//   * Session metadata that says "recording" is skipped BEFORE the session is opened (opening creates
//     kv/), whatever its age, unless --force. looksActive() stays as a second, age-based guard.
//   * --missing keeps a session when it has no receipt, its knowledge is not complete, or (only when the
//     base stage is part of this run) its STREAM_ROLES artifact is missing / stale / errored. A run that
//     excludes the base stage never needs role work.
//   * An explicitly named session (`derive <id>`) does not go through this at all and is not affected
//     by --force.
export function selectDeriveTargets(metas, { missing = false, force = false, stages = null, open, rolesCurrent = streamRolesCurrent }) {
  const baseSelected = !Array.isArray(stages) || stages.includes('base');
  const skipped = { recording: 0, unreadable: 0, active: 0, upToDate: 0 };
  const targets = [];
  for (const m of metas) {
    if (m.status === 'unreadable_metadata') { skipped.unreadable++; continue; } // cannot be opened
    if (!force && m.status === 'recording') { skipped.recording++; continue; }
    const s = open(m.id);
    if (!force && looksActive(s)) { skipped.active++; continue; }
    if (missing && isDerived(s) && knowledgeState(s) === 'complete' && !(baseSelected && !rolesCurrent(s))) { skipped.upToDate++; continue; }
    targets.push(s);
  }
  return { targets, skipped };
}

// ---------------------------------------------------------------------------------------------
define({
  name: 'derive', section: 'Replay and derive', usage: '[id|latest] [--all|--missing]', summary: 'Rebuild datasets, shapes, knowledge and the receipt from raw',
  description: 'Everything derived is recomputable from the raw log; raw is never modified. Use --profile to derive with a different profile (for example after accepting suggestions) and --all / --missing for batches. Batches never touch a session whose metadata says it is still recording unless --force is given; naming a session explicitly always derives it.',
  flags: {
    profile: { type: 'string', alias: 'p', valueName: 'NAME', desc: 'Derive with this profile instead of the one recorded with the session' },
    all: { type: 'boolean', desc: 'Derive every saved session' },
    missing: { type: 'boolean', desc: 'Derive only sessions with no receipt, incomplete knowledge, or (when the base stage runs) a missing, errored or stale stream-role artifact (written by an older classifier version or schema, i.e. before role coverage)' },
    force: { type: 'boolean', desc: 'In a batch, also derive sessions whose metadata says they are still recording' },
    full: { type: 'boolean', desc: 'Rebuild all requested stages instead of reusing incremental artifacts' },
    stages: { type: 'list', valueName: 'NAMES', desc: 'Run selected derivation stages (comma-separated)' },
  },
  examples: ['studio derive latest', 'studio derive 2026…abc --profile claude', 'studio derive --missing --json'],
  async run(ctx) {
    const f = ctx.flags;
    if (f.stages && !f.stages.length) throw usageError('--stages needs at least one stage name.');
    const { deriveAll } = await capability('../../src/replay/derive-all.mjs', ['deriveAll'], 'Full derivation');
    let targets;
    if (f.all || f.missing) {
      const sel = selectDeriveTargets(ctx.listSessions(), { missing: !!f.missing, force: !!f.force, stages: f.stages, open: (id) => Session.open(ctx.paths.sessions, id) });
      targets = sel.targets;
      const held = sel.skipped.recording + sel.skipped.active;
      if (held) ctx.out.info(`Skipped ${held} session(s) that are still recording (use --force to include them).`);
      if (sel.skipped.unreadable) ctx.out.info(`Skipped ${sel.skipped.unreadable} session(s) with unreadable metadata.`);
    } else targets = [ctx.session(ctx.args[0])];
    if (!targets.length) { ctx.out.emit({ derived: [] }, (o) => o.result('Nothing to derive.')); return; }
    const results = [];
    for (const s of targets) {
      ctx.out.info(`Deriving ${s.id} (${results.length + 1}/${targets.length})`);
      try {
        const d = await deriveAll(s, { profile: ctx.profileFor(s, f.profile), incremental: !f.full, stages: f.stages, onStage: stageProgress(ctx.out, s.id) });
        ctx.out.progressDone();
        results.push({
          session: s.id, ok: !d.manifest?.error && d.manifest?.ok !== false && !['failed', 'error'].includes(d.manifest?.status), manifest: d.manifest, artifacts: d.artifacts,
          ...(d.manifest?.error ? { error: d.manifest.error } : {}),
        });
      } catch (e) { ctx.out.progressDone(); results.push({ session: s.id, ok: false, error: String(e.message ?? e) }); }
    }
    const failed = results.filter((r) => !r.ok);
    ctx.out.emit(targets.length === 1 && !f.all && !f.missing ? results[0] : { derived: results }, (o) => {
      for (const r of results) {
        if (!r.ok) { o.result(`${o.c.red('FAIL')} ${r.session}: ${r.error}`); continue; }
        o.result(`Derived ${r.session}${r.manifest?.status ? `: ${r.manifest.status}` : '.'}`);
        o.line(JSON.stringify(r.manifest, null, 2));
      }
    });
    if (failed.length) process.exitCode = 1;
  },
});

// ---------------------------------------------------------------------------------------------
define({
  name: 'replay', section: 'Replay and derive', usage: '[id|latest] [--stream SID | --at TIME | --bytes]', summary: 'Replay a captured stream with its original timing, or time-travel to a moment',
  description: [
    'Three modes, all offline from the saved session:',
    '  --stream SID   replay one stream\'s decoded events with the original timing (--speed 2 doubles it, --instant removes waits).',
    '                 Streams that assemble into a document (chat completions, patch streams) replay as the growing text;',
    '                 use --events to see each protocol event instead. Without --stream the busiest streaming stream is used.',
    '  --at TIME      reconstruct the state of every stream, rendered block and action at a moment:',
    '                 an ISO date, epoch ms, or +SECONDS after the session start.',
    '  --bytes        write the stream\'s raw bytes exactly as received (to --out FILE or stdout).',
  ].join('\n'),
  flags: {
    stream: { type: 'string', alias: 's', valueName: 'SID', desc: 'Stream id to replay (see "studio session streams")' },
    at: { type: 'string', valueName: 'TIME', desc: 'Time-travel: ISO date, epoch ms or +SECONDS from start' },
    bytes: { type: 'boolean', desc: 'Emit the raw bytes of --stream' },
    out: { type: 'string', alias: 'o', valueName: 'FILE', desc: 'Write output to FILE (bytes mode) instead of stdout' },
    speed: { type: 'number', valueName: 'X', default: 1, desc: 'Playback speed multiplier' },
    instant: { type: 'boolean', desc: 'No waiting between events' },
    'max-wait': { type: 'number', valueName: 'MS', default: 1500, desc: 'Cap on any single wait, in milliseconds' },
    events: { type: 'boolean', desc: 'Show protocol events instead of the assembled text' },
    limit: { type: 'number', alias: 'n', valueName: 'N', desc: 'Stop after N events' },
  },
  examples: ['studio replay latest', 'studio replay latest --stream s12 --speed 4', 'studio replay latest --at +12.5 --json', 'studio replay latest --stream s12 --bytes --out stream.bin'],
  async run(ctx) {
    const s = ctx.session(ctx.args[0]);
    const f = ctx.flags;
    if (f.at !== undefined && (f.stream || f.bytes)) throw usageError('--at cannot be combined with --stream/--bytes.');
    if (f.speed <= 0) throw usageError('--speed must be greater than 0.');
    await ctx.ensureDerived(s, { need: 'RECEIPT' });
    const profile = ctx.profileFor(s);

    // ---- time travel --------------------------------------------------------------------
    if (f.at !== undefined) {
      const t = parseAt(f.at, await sessionStartT(s));
      const st = await stateAt(s, t, profile);
      ctx.out.emit(st, (o) => {
        o.heading(`${s.id} at ${new Date(t).toISOString()}`);
        o.table(st.streams, [{ title: 'SID', key: 'sid' }, { title: 'TRANSPORT', get: (x) => x.transport }, { title: 'STATUS', get: (x) => x.status }, { title: 'BYTES', get: (x) => fmtBytes(x.bytes), align: 'right' }, { title: 'EVENTS', get: (x) => x.events, align: 'right' }, { title: 'ENDPOINT', get: (x) => x.endpoint, max: 60 }], { empty: 'No streams had started yet.' });
        const withText = st.streams.filter((x) => x.assembledTexts?.length);
        for (const x of withText) { o.line(''); o.line(o.c.bold(`${x.sid} assembled so far`)); for (const tx of x.assembledTexts) o.line(`  ${truncate(oneLine(tx.text ?? tx), 200)}`); }
        o.line('');
        o.kv([['visible blocks', st.dom.length], ['last navigation', st.nav.at(-1)?.url], ['recent actions', st.actions.slice(-3).map((a) => `${a.kind}${a.target?.label ? ` “${truncate(a.target.label, 24)}”` : ''}`).join(', ')], ['gaps so far', st.gaps.length]]);
      });
      return;
    }

    // ---- pick the stream ----------------------------------------------------------------
    const streams = await readRows(s, 'streams');
    let sid = f.stream;
    if (!sid) {
      const busiest = streams.filter((x) => isStreaming(x) && (x.events ?? 0) > 0).sort((a, b) => (b.events ?? 0) - (a.events ?? 0))[0];
      if (!busiest) throw notFound(`${s.id} has no streaming stream with decoded events.`, `Browse streams with "studio session streams ${s.id}" or use --at to time-travel.`);
      sid = busiest.sid;
      ctx.out.info(`Replaying ${sid}: ${busiest.endpoint ?? busiest.url} (${busiest.events} events). Choose another with --stream.`);
    }
    const meta = streams.find((x) => x.sid === sid);
    if (!meta) throw notFound(`No stream "${sid}" in ${s.id}.`, `List streams with "studio session streams ${s.id}".`);

    // ---- raw bytes ----------------------------------------------------------------------
    if (f.bytes) {
      const { bytes, map } = await streamBytes(s, sid);
      if (f.out) { mkdirSync(path.dirname(path.resolve(f.out)), { recursive: true }); writeFileSync(f.out, bytes); }
      else if (ctx.out.json) { ctx.out.emit({ session: s.id, sid, total: bytes.length, chunks: map }); return; }
      else process.stdout.write(bytes);
      if (f.out) ctx.out.emit({ session: s.id, sid, file: path.resolve(f.out), bytes: bytes.length, chunks: map.length }, (o) => o.result(`Wrote ${fmtBytes(bytes.length)} (${map.length} chunks) to ${path.resolve(f.out)}`));
      return;
    }

    // ---- timed replay -------------------------------------------------------------------
    const assembledDoc = s.kv.get('ASSEMBLED', {})?.[sid];
    const assemble = !!assembledDoc && !f.events;
    const asm = assemble ? new DeltaAssembler(profile.decode?.delta ?? 'auto') : null;
    let shown = '', prevT = null, n = 0, waited = 0, firstT = null, lastT = null;
    const wait = async (t) => {
      if (f.instant || prevT === null) return;
      const ms = Math.min(f['max-wait'], Math.max(0, (t - prevT) / f.speed));
      if (ms > 1) { waited += ms; await sleep(ms); }
    };
    const frames = [];
    for (const ev of await readRows(s, 'events', { filter: (e) => e.sid === sid, limit: f.limit ?? Infinity })) {
      await wait(ev.t);
      prevT = ev.t; firstT ??= ev.t; lastT = ev.t; n++;
      if (ctx.out.json) { frames.push({ seq: ev.seq, t: ev.t, offsetMs: ev.t - firstT, text: eventText(ev) }); continue; }
      if (asm) {
        if (ev.json === undefined || !asm.apply(structuredClone(ev.jsonNested?.json ?? ev.json))) continue;
        const text = asm.texts(1)[0]?.text ?? '';
        if (text.startsWith(shown)) ctx.out.raw(text.slice(shown.length));
        else ctx.out.raw(`\n↻ ${text}`);
        shown = text;
      } else {
        ctx.out.raw(`${oneLine(eventText(ev))}\n`);
      }
    }
    if (ctx.out.json) { ctx.out.emit({ session: s.id, sid, events: n, durationMs: lastT - firstT, frames }); return; }
    if (asm && shown) ctx.out.raw('\n');
    ctx.out.info(`Replayed ${n} event(s) over ${fmtMs(lastT - firstT)} of original time${f.instant ? '' : ` (waited ${fmtMs(waited)} at ${f.speed}x)`}.`);
  },
});
