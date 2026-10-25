#!/usr/bin/env node
// Induced-map vs hand-map survey (READ-ONLY over saved sessions).
//
// For every saved session stream where a built-in hand-written stream map matched, this tool
// induces a map from the same decoded events and reports how the two compare. Output is counts
// and booleans only: no message text, no URL paths or query strings, no titles, no headers, no
// cookies, no site names. Nothing is written into the data directory and nothing is derived,
// captured, or sent over a network.
//
// The write proof is the same one scripts/fidelity-survey.mjs uses: every touched session folder
// is snapshotted (kind/size/mtime per file) before and after the run, and any difference prints
// "WRITE DETECTED <path>" and exits 4 with no report.
//
// Usage:
//   node scripts/induce-vs-handmap.mjs [--data-dir DIR] (--session ID | --all) [--limit N]
//                                     [--json] [--list-mismatches]
//
// Metrics (all numbers, no pass/fail threshold):
//   overlap.<category>   Dice of the SELECTORS (op + when) of induced vs hand rules, per category
//   assembledEqual       the induced map's concatenated component text equals the hand map's
//   charsEqual           the two assembled texts have the same length (weaker than text equality)
//   unexplained          clusters the induction could not express (reason labels, counts)
//   rules                induced rule count for the stream
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { defaultDataDir, dataPaths } from '../src/config.mjs';
import { iterateRaw } from '../src/store/raw-index.mjs';
import { StreamReducer } from '../src/replay/reducer.mjs';
import { detectStreamMap, applyStreamMap } from '../src/profiles/stream-map.mjs';
import { induceStreamMap, compareMaps } from '../src/profiles/stream-map-induce.mjs';
import {
  snapshotSessionDirs, diffSnapshots, assertNotRepoCheckout, parseArgs,
  UsageError, GuardError, errorClassOf,
} from './fidelity-survey.mjs';

export const REPORT_SCHEMA = 'capture-studio.induce-vs-handmap/1';
const EVENT_CAP = 20000;
const CATEGORIES = ['open', 'append', 'close', 'ignore', 'all'];
const EXIT_OK = 0;
const EXIT_ERROR = 1;
const EXIT_USAGE = 2;
const EXIT_WRITE = 4;

const USAGE = [
  'Usage: node scripts/induce-vs-handmap.mjs [--data-dir DIR] (--session ID | --all) [--limit N] [--json] [--list-mismatches]',
  '  --session ID       one session folder (read-only)',
  '  --all              every session folder; --limit N keeps the first N',
  '  --json             print the counts-only JSON report to stdout',
  '  --list-mismatches  add one row per stream whose assembled text differs (counts only)',
  '',
].join('\n');

const r3 = (x) => Math.round(x * 1000) / 1000;
const assembledChars = (r) => r.components.reduce((a, c) => a + (typeof c.text === 'string' ? c.text.length : 0), 0);
// The assembled text is compared, never printed or stored.
const assembledText = (r) => r.components.map((c) => c.text).join('');

function mean(xs) { return xs.length ? r3(xs.reduce((a, b) => a + b, 0) / xs.length) : null; }
function min(xs) { return xs.length ? Math.min(...xs) : null; }
function max(xs) { return xs.length ? Math.max(...xs) : null; }

export async function surveySession(dir, { eventCap = EVENT_CAP, listMismatches = false } = {}) {
  const reducer = new StreamReducer({ deltaDialect: 'auto', keepEvents: true, maxEventsPerStream: eventCap });
  for await (const rec of iterateRaw(path.join(dir, 'raw'), { useIndex: false })) {
    if (!rec || typeof rec !== 'object' || rec.k === 'corrupt') continue;
    reducer.ingest(rec);
  }
  const summary = reducer.summary();
  const streams = [];
  for (const st of summary.streams) {
    if (st.kind === 'ws') continue; // websocket streams are not stream-mapped
    const events = reducer.eventsOf(st.sid);
    if (!events.length) continue;
    const det = detectStreamMap(events);
    if (!det.map) continue;

    const hand = applyStreamMap(det.map, events);
    let induced;
    let cmp;
    let inducedResult;
    let threw = false;
    try {
      induced = induceStreamMap(events);
      cmp = compareMaps(induced, det.map);
      inducedResult = applyStreamMap(induced, events);
    } catch {
      threw = true;
    }
    const equal = !threw && assembledText(inducedResult) === assembledText(hand);
    const charsEqual = !threw && assembledChars(inducedResult) === assembledChars(hand);
    const row = {
      mapId: det.map.id,
      events: events.length,
      inducedRules: threw ? 0 : induced.stream.ops.length,
      unexplainedClusters: threw ? 0 : induced.unexplained.length,
      unexplainedReasons: threw ? {} : induced.unexplained.reduce((o, u) => { o[u.reason] = (o[u.reason] ?? 0) + 1; return o; }, {}),
      assembledEqual: equal,
      charsEqual,
      inducedThrew: threw,
      overlap: threw ? null : cmp,
    };
    if (listMismatches && !equal) {
      row.mismatch = { handComponents: hand.components.length, inducedComponents: threw ? 0 : inducedResult.components.length, handUnmapped: hand.unmapped.length, inducedUnmapped: threw ? 0 : inducedResult.unmapped.length };
    }
    streams.push(row);
  }
  return streams;
}

function hostOf(meta) {
  try { return new URL(meta?.target?.url).hostname || null; } catch { return null; }
}

export function aggregate(sessions) {
  const streams = sessions.filter((s) => s.status === 'ok').flatMap((s) => s.streams);
  const byMap = {};
  const overlap = Object.fromEntries(CATEGORIES.map((c) => [c, []]));
  const reasons = {};
  let uncertain = 0;
  for (const s of streams) {
    const b = byMap[s.mapId] ?? (byMap[s.mapId] = { streams: 0, assembledEqual: 0, overlap: Object.fromEntries(CATEGORIES.map((c) => [c, []])) });
    b.streams++;
    if (s.assembledEqual) b.assembledEqual++;
    if (s.overlap) {
      for (const c of CATEGORIES) {
        overlap[c].push(s.overlap[c]);
        b.overlap[c].push(s.overlap[c]);
      }
    }
    for (const [r, n] of Object.entries(s.unexplainedReasons)) reasons[r] = (reasons[r] ?? 0) + n;
    uncertain += s.unexplainedClusters;
  }
  const stat = (xs) => ({ mean: mean(xs), min: min(xs), max: max(xs) });
  const byMapOut = {};
  for (const id of Object.keys(byMap).sort()) {
    const b = byMap[id];
    byMapOut[id] = {
      streams: b.streams,
      assembledEqual: b.assembledEqual,
      overlap: Object.fromEntries(CATEGORIES.map((c) => [c, stat(b.overlap[c])])),
    };
  }
  return {
    sessionsTotal: sessions.length,
    sessionsOk: sessions.filter((s) => s.status === 'ok').length,
    sessionsWithMatchedStreams: sessions.filter((s) => s.status === 'ok' && s.streams.length > 0).length,
    streamsChecked: streams.length,
    streamsAssembledEqual: streams.filter((s) => s.assembledEqual).length,
    streamsCharsEqual: streams.filter((s) => s.charsEqual).length,
    streamsInducedThrew: streams.filter((s) => s.inducedThrew).length,
    inducedRules: { total: streams.reduce((a, s) => a + s.inducedRules, 0), mean: mean(streams.map((s) => s.inducedRules)) },
    unexplainedClusters: uncertain,
    streamsWithUnexplained: streams.filter((s) => s.unexplainedClusters > 0).length,
    unexplainedByReason: Object.fromEntries(Object.entries(reasons).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))),
    byMap: byMapOut,
    overlap: Object.fromEntries(CATEGORIES.map((c) => [c, stat(overlap[c])])),
  };
}

export async function runSurvey({ dataDir = defaultDataDir(), session = null, all = false, limit = null, listMismatches = false } = {}) {
  const root = path.resolve(dataDir);
  if ((session === null) === (all === false)) throw new UsageError('choose exactly one of --session ID or --all');
  if (session !== null && !/^[A-Za-z0-9._-]{1,200}$/.test(session)) throw new UsageError('invalid session id');
  if (limit !== null && !all) throw new UsageError('--limit applies to --all');
  assertNotRepoCheckout(root);
  if (!existsSync(root)) throw new GuardError('data directory does not exist (this tool never creates it)');
  const sessionsDir = dataPaths(root).sessions;
  let targets;
  if (all) {
    const ids = existsSync(sessionsDir)
      ? readdirSync(sessionsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && existsSync(path.join(sessionsDir, e.name, 'session.json')))
        .map((e) => e.name).sort().reverse()
      : [];
    targets = (limit ? ids.slice(0, limit) : ids).map((id) => ({ id, dir: path.join(sessionsDir, id) }));
  } else {
    const dir = path.join(sessionsDir, session);
    if (!existsSync(dir)) throw new GuardError(`no session folder "${session}"`);
    targets = [{ id: session, dir }];
  }

  const before = snapshotSessionDirs(targets);
  const sessions = [];
  for (const t of targets) {
    try {
      const streams = await surveySession(t.dir, { listMismatches });
      let host = null;
      try { host = hostOf(JSON.parse(readFileSync(path.join(t.dir, 'session.json'), 'utf8'))); } catch { host = null; }
      sessions.push({ id: t.id, siteHost: host, status: 'ok', streams });
    } catch (e) {
      sessions.push({ id: t.id, siteHost: null, status: 'error', errorClass: errorClassOf(e) });
    }
  }
  const after = snapshotSessionDirs(targets);
  const writes = diffSnapshots(before, after);
  if (writes.length) return { writeDetected: writes, report: null };

  return {
    writeDetected: [],
    report: {
      schema: REPORT_SCHEMA,
      securityNote: 'counts and booleans only: no message text, URL paths, titles, headers or cookies',
      selection: { mode: all ? 'all' : 'session', limit: limit ?? null, sessionCount: sessions.length },
      safety: { readOnly: true, sessionFoldersSnapshotted: targets.length, filesSnapshotted: before.size, writeDetected: false },
      aggregate: aggregate(sessions),
      sessions,
    },
  };
}

function render(report) {
  const a = report.aggregate;
  const fmt = (s) => (s.mean === null ? '-' : `${s.mean} (${s.min}..${s.max})`);
  const lines = [];
  lines.push(`sessions: ${a.sessionsTotal} (ok ${a.sessionsOk}, with matched streams ${a.sessionsWithMatchedStreams})`);
  lines.push(`streams checked: ${a.streamsChecked}; assembled text equal: ${a.streamsAssembledEqual}; same chars: ${a.streamsCharsEqual}; induction threw: ${a.streamsInducedThrew}`);
  lines.push(`induced rules: ${a.inducedRules.total} total, mean ${a.inducedRules.mean}`);
  lines.push(`unexplained clusters: ${a.unexplainedClusters} in ${a.streamsWithUnexplained} stream(s) ${JSON.stringify(a.unexplainedByReason)}`);
  lines.push(`overlap mean (min..max): open ${fmt(a.overlap.open)} | append ${fmt(a.overlap.append)} | close ${fmt(a.overlap.close)} | ignore ${fmt(a.overlap.ignore)} | all ${fmt(a.overlap.all)}`);
  for (const [id, b] of Object.entries(a.byMap)) {
    lines.push(`  ${id}: streams ${b.streams}, assembled equal ${b.assembledEqual}, append ${fmt(b.overlap.append)}, ignore ${fmt(b.overlap.ignore)}, all ${fmt(b.overlap.all)}`);
  }
  return lines.join('\n') + '\n';
}

export async function main(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  let args;
  try {
    // --list-mismatches is this tool's flag; the shared parser handles the rest.
    const listMismatches = argv.includes('--list-mismatches');
    args = { ...parseArgs(argv.filter((a) => a !== '--list-mismatches')), listMismatches };
    if (args.out) throw new UsageError('--out is not supported by this read-only tool');
  } catch (e) {
    stderr.write(`${e.message}\n${USAGE}`);
    return EXIT_USAGE;
  }
  if (args.help) { stdout.write(USAGE); return EXIT_OK; }
  let result;
  try {
    result = await runSurvey({
      dataDir: args.dataDir ? path.resolve(args.dataDir) : defaultDataDir(),
      session: args.session, all: args.all, limit: args.limit, listMismatches: args.listMismatches,
    });
  } catch (e) {
    if (e instanceof UsageError) { stderr.write(`induce-vs-handmap: ${e.message}\n${USAGE}`); return EXIT_USAGE; }
    stderr.write(`induce-vs-handmap: ${e.message}\n`);
    return EXIT_ERROR;
  }
  if (result.writeDetected.length) {
    for (const w of result.writeDetected) stderr.write(`WRITE DETECTED ${w.path} (${w.change})\n`);
    stderr.write('induce-vs-handmap: the touched session folders changed during the run; no report produced\n');
    return EXIT_WRITE;
  }
  const json = `${JSON.stringify(result.report, null, 2)}\n`;
  if (args.json) stdout.write(json);
  else stderr.write(render(result.report));
  return EXIT_OK;
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === pathToFileURL(fileURLToPath(import.meta.url)).href;
if (isMain) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
