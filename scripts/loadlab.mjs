#!/usr/bin/env node
// Capture-path load lab (Phase A.1 of docs/DESIGN-live-drive-studio.md, section 16).
//
// QUESTION
//   Does Studio's CAPTURE PATH starve the Node event loop?
//
// WHAT THIS IS
//   A hermetic load generator. No Chrome, no browser, no network, no server, no real site.
//   Synthetic CDP frames are pushed through an in-process fake DevTools socket into the REAL
//   capture code (src/cdp/client.mjs -> src/capture/network.mjs -> src/capture/recorder.mjs
//   -> src/store/raw-log.mjs -> src/replay/reducer.mjs -> src/shapes/infer.mjs, plus
//   src/capture/dom.mjs for the rendered-DOM batch path).
//
//   Every scenario runs twice:
//     capture  - the real capture path is attached (network handlers, recorder._append,
//                reducer, shapes, dataset, raw log, the recorder's own 1 s status timer and
//                5 s persist timer).
//     baseline - the SAME emitter, the SAME CDP frame parsing, but no capture handlers are
//                attached (handlers no-op). The difference between the two is therefore the
//                capture path itself, not the synthetic load generator.
//
//   Each scenario runs in its own child process so peak RSS and event-loop delay are not
//   polluted by the other one.
//
// MEASURED
//   perf_hooks.monitorEventLoopDelay (p50/p99/max), wall time, bytes/s, peak RSS, sync fs call
//   counts (when the fs facade can be instrumented), and raw byte equality: the sha256 of the
//   bytes the fake browser emitted vs the sha256 of the bytes reassembled from the saved raw
//   log with the existing replay/derive reader.
//
// SAFETY
//   Everything is written under os.tmpdir() in a fresh mkdtemp directory that is removed at the
//   end (unless --keep). The real Capture Studio data dir and any session under LOCALAPPDATA
//   are never touched. The session dir is created with Session.create() inside the temp dir.
//
// USAGE
//   node scripts/loadlab.mjs [--mb N] [--chunk KB] [--streams N] [--dom-rows N]
//                             [--seed N] [--repeats N] [--json] [--out FILE] [--keep] [--help]
//                             [--scenario saturation|chat] [--rate-kbps N] [--duration-s N] [--burst-mb N]
//
//   --scenario chat  realistic AI-chat load instead of saturation (see the CHAT section below):
//                    a paced SSE reply, 4 Hz DOM batches, one history burst at 40 % of the run and
//                    three analytics-like streams. Reports event-loop stalls, their timing relative
//                    to the burst, queue age, peak queue bytes, frames/s, and PASS/FAIL verdicts.
//   Chat run:        node scripts/loadlab.mjs --scenario chat --duration-s 20 --repeats 3 --json
//
//   --repeats N   run each mode (capture ON, baseline OFF) N times, alternating the order per
//                 repeat (default 5). The report then carries median / p95 / min / max / CV over
//                 the repeats for event-loop p99, throughput MB/s and wall time, plus queue age
//                 p50/p99 and peak queue bytes for capture. Synthetic in-process numbers only.
//   --mb N        total synthetic payload bytes across all streams (default 64, hard cap 512)
//   --chunk KB    bytes per Network.dataReceived frame (default 64)
//   --streams N   parallel HTTP streams (default 4)
//   --dom-rows N  total rendered-DOM rows across DOM batches (default 2000)
//   --seed N      deterministic seed (default 1337)
//   --json        print the JSON report on stdout (the table goes to stderr)
//   --profile     attach a V8 CPU profile summary to each scenario (slower, but names the hot
//                 functions of the capture path)
//   --out FILE    also write the JSON report to FILE
//   --keep        keep the temp session dir and print its path
//
//   Headline run:  node scripts/loadlab.mjs --mb 64 --streams 4

import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { fileURLToPath } = require('node:url');

const SELF = path.resolve(process.argv[1] ?? '');
const SCRIPT_PATH = path.resolve(fileURLToPath(import.meta.url));
// main() only runs when this file is the entry point. Importing it (the unit test does, to check
// the repeat statistics) must not start a load run. Workers are spawned with this file as argv[1],
// so they still run main().
const IS_MAIN = SCRIPT_PATH.toLowerCase() === SELF.toLowerCase();
const SCHEMA = 'aion-capture-studio.loadlab/1';
const MAX_MB = 512;
const MAX_REPEATS = 50;
// Mirrors the batch cap in RawLog.flush() (src/store/raw-log.mjs) for writeDelayMs = 0. Used only
// by the queue-age probe below; the lab never changes the cap.
const RAW_FLUSH_BATCH_BYTES = 4 * 1024 * 1024;

// ---------------------------------------------------------------------------------------------
// Which real code this lab drives, and what it cannot reach.
// ---------------------------------------------------------------------------------------------
const LAYERS = {
  exercised: [
    'src/cdp/client.mjs — CdpConnection._onMessage (per-frame JSON.parse + inline handler dispatch) and CdpSession (real attach handshake) over an in-process fake DevTools socket',
    'src/capture/network.mjs — NetworkRecorder.attach() plus the requestWillBeSent / responseReceived / dataReceived / loadingFinished handlers, _chunk() (scrubSecrets + re-encode) and _finalize()',
    'src/capture/recorder.mjs — Recorder._append() (raw append -> reducer.ingest -> events dataset push -> shapes.observeEvent) and Recorder.status() / _persist() / liveReport() on the recorder\'s own 1 s and 5 s timers',
    'src/store/session.mjs — Session.create(), Dataset.push() (events.jsonl) and Session.verify()',
    'src/store/raw-log.mjs — RawLog.append()/flush()/_fsync()/close() (segment rotation, sha256 manifest, streams.json locator, gap accounting)',
    'src/replay/reducer.mjs — StreamReducer.ingest() (decoders + delta assembler) and StreamReducer.summary() (the 1 s status rescan)',
    'src/shapes/infer.mjs — ShapeInferencer.observeEvent() and ShapeInferencer.report() (the 5 s liveReport)',
    'src/capture/dom.mjs — DomObserver._onMessage() (per-batch JSON.parse + scrubText) through the real Runtime.bindingCalled path',
    'src/replay/derive.mjs — streamBytes() (raw byte reassembly from disk) used for the sha256 equality check',
  ],
  notExercised: [
    'Chrome itself and the real DevTools WebSocket transport (replaced by an in-process fake socket that speaks the same JSON frames)',
    'Recorder.start()/stop() lifecycle: target discovery, multi-target attach, DevTools reconnect, real session metadata from a real target',
    'the in-page DOM agent (src/capture/page-agent.js): only the binding payload it would emit is injected',
    'Network.streamResourceContent against a real browser (the arm request is answered by the fake socket)',
    'Network.eventSourceMessageReceived (es.msg), WebSocket frame capture and the retrospective getResponseBody fallback',
    'the studio HTTP server / UI, and browser rendering, paint and scroll responsiveness (those need a real browser and are outside this lab)',
  ],
  notes:
    'Recorder.start() cannot run without a live Chrome (it needs /json/version, /json/list and a real WebSocket). ' +
    'The lab therefore builds a real Recorder instance and wires the same collaborators start() wires ' +
    '(Session, StreamReducer, ShapeInferencer, events dataset, NetworkRecorder, DomObserver, and the same 1 s status / 5 s persist timers). ' +
    'Every function in the capture path is the shipped one; only the browser underneath is synthetic.',
};

// ---------------------------------------------------------------------------------------------
// Sync fs call counting.
//
// node:fs named ESM exports are snapshotted when the builtin facade is first created, so the
// patch has to be installed before ANY module imports node:fs as ESM. The worker process is
// started fresh for that reason. When the facade already existed (for example inside a test
// runner) the patch cannot take effect and the report says so instead of guessing.
// ---------------------------------------------------------------------------------------------
const PROBE_FNS = ['writeSync', 'fsyncSync', 'fdatasyncSync', 'appendFileSync', 'writeFileSync', 'renameSync', 'mkdirSync', 'openSync', 'closeSync', 'readFileSync'];

function installFsProbe() {
  const counts = {};
  const patched = {};
  for (const name of PROBE_FNS) {
    const orig = fs[name];
    if (typeof orig !== 'function') continue;
    const wrapped = function (...args) {
      counts[name] = (counts[name] ?? 0) + 1;
      return orig.apply(this, args);
    };
    fs[name] = wrapped;
    patched[name] = wrapped;
  }
  return { counts, patched, measured: false, reason: null };
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------
const DEFAULTS = { mb: 64, chunkKb: 64, streams: 4, domRows: 2000, seed: 1337, repeats: 5, scenario: 'saturation', rateKbps: 40, durationS: 20, burstMb: 6 };
const MAX_CHAT_DURATION_S = 120;
// Chat-scenario targets. Fixed constants on purpose: the run reports whether they are met, it does
// not tune them.
const CHAT_TARGETS = { eventLoopP99Ms: 50, longestStallMs: 100, queueAgeP99Ms: 100 };

function usage() {
  return [
    'Capture-path load lab — hermetic event-loop starvation probe for the Studio capture path.',
    '',
    'Usage: node scripts/loadlab.mjs [options]',
    '',
    `  --mb N         total synthetic payload bytes (default ${DEFAULTS.mb}, hard cap ${MAX_MB})`,
    `  --chunk KB     bytes per Network.dataReceived frame (default ${DEFAULTS.chunkKb})`,
    `  --streams N    parallel HTTP streams (default ${DEFAULTS.streams})`,
    `  --dom-rows N   total rendered-DOM rows across batches (default ${DEFAULTS.domRows})`,
    `  --seed N       deterministic seed (default ${DEFAULTS.seed})`,
    `  --repeats N    runs per mode, order alternates per repeat (default ${DEFAULTS.repeats}, max ${MAX_REPEATS})`,
    '  --scenario S   saturation (default, as fast as possible) or chat (realistic AI-chat load)',
    `  --rate-kbps N  chat: SSE reply rate in KB/s (default ${DEFAULTS.rateKbps})`,
    `  --duration-s N chat: run length in seconds (default ${DEFAULTS.durationS}, max ${MAX_CHAT_DURATION_S})`,
    `  --burst-mb N   chat: history-load burst at 40 % of the run (default ${DEFAULTS.burstMb})`,
    '  --json         print the JSON report on stdout (table goes to stderr)',
    '  --profile      attach a V8 CPU profile summary to each scenario (slower)',
    '  --out FILE     also write the JSON report to FILE',
    '  --keep         keep the temp session dir and print its path',
    '  --help         show this text',
    '',
    'Headline run: node scripts/loadlab.mjs --mb 64 --streams 4',
  ].join('\n');
}

function parseArgs(argv) {
  const cfg = { ...DEFAULTS, json: false, out: null, keep: false, help: false, worker: false, mode: null, profile: false };
  const num = (v, name) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`--${name} expects a positive number (got ${v})`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} expects a value`);
      return v;
    };
    switch (a) {
      case '--mb': cfg.mb = num(next(), 'mb'); break;
      case '--chunk': cfg.chunkKb = num(next(), 'chunk'); break;
      case '--streams': cfg.streams = Math.round(num(next(), 'streams')); break;
      case '--dom-rows': cfg.domRows = Math.round(num(next(), 'dom-rows')); break;
      case '--seed': cfg.seed = Math.round(Number(next())); break;
      case '--repeats': cfg.repeats = Math.round(num(next(), 'repeats')); break;
      case '--json': cfg.json = true; break;
      case '--profile': cfg.profile = true; break;
      case '--out': cfg.out = next(); break;
      case '--keep': cfg.keep = true; break;
      case '--help': case '-h': cfg.help = true; break;
      case '--worker': cfg.worker = true; break;
      case '--mode': cfg.mode = next(); break;
      case '--scenario': cfg.scenario = next(); break;
      case '--rate-kbps': cfg.rateKbps = num(next(), 'rate-kbps'); break;
      case '--duration-s': cfg.durationS = num(next(), 'duration-s'); break;
      case '--burst-mb': cfg.burstMb = num(next(), 'burst-mb'); break;
      default:
        if (a.startsWith('--') && a.includes('=')) {
          const [k, v] = a.split(/=(.*)/s);
          argv.splice(i + 1, 0, v);
          argv[i] = k;
          i--;
          break;
        }
        throw new Error(`unknown argument: ${a}`);
    }
  }
  if (cfg.mb > MAX_MB) throw new Error(`--mb is capped at ${MAX_MB} MB (got ${cfg.mb})`);
  if (cfg.streams < 1 || cfg.streams > 64) throw new Error('--streams must be between 1 and 64');
  if (cfg.repeats < 1 || cfg.repeats > MAX_REPEATS) throw new Error(`--repeats must be between 1 and ${MAX_REPEATS}`);
  if (cfg.chunkKb > 8192) throw new Error('--chunk is capped at 8192 KB');
  if (cfg.scenario !== 'saturation' && cfg.scenario !== 'chat') throw new Error(`--scenario must be saturation or chat (got ${cfg.scenario})`);
  if (cfg.durationS > MAX_CHAT_DURATION_S) throw new Error(`--duration-s is capped at ${MAX_CHAT_DURATION_S} s (got ${cfg.durationS})`);
  if (cfg.burstMb > MAX_MB) throw new Error(`--burst-mb is capped at ${MAX_MB} MB (got ${cfg.burstMb})`);
  return cfg;
}

// ---------------------------------------------------------------------------------------------
// Deterministic synthetic payloads.
//
// Four wire shapes are used so the lab exercises different decoder paths:
//   sse      text/event-stream          -> SseDecoder            (one event per data block)
//   json     application/json (array)   -> ChunkedJsonDecoder    (one event per array item)
//   ndjson   application/x-ndjson       -> NdjsonDecoder         (one event per line)
//   document application/json (object)  -> WholeBodyDecoder      (whole body parsed at end)
//
// The payload bytes are generated from a seeded PRNG, so two runs with the same --seed emit
// exactly the same bytes and the sha256 comparison is meaningful.
// ---------------------------------------------------------------------------------------------
const WORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima', 'mike', 'november', 'oscar', 'papa', 'quebec', 'romeo', 'sierra', 'tango'];

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A byte source that can produce exact-size chunks. It keeps a small pending remainder so
// record boundaries land mid-chunk, exactly like a real socket read.
//
//   sse      "data: {...}\n\n" blocks                       -> SseDecoder
//   json     "{"..."},\n" concatenated JSON documents       -> ChunkedJsonDecoder
//   ndjson   one JSON object per line                       -> NdjsonDecoder
//   document one JSON object of exactly `budget` bytes      -> WholeBodyDecoder
//
// The caller asks for exactly the bytes it still needs, so the total is always the budget and
// the sha256 of the emitted bytes is reproducible.
function byteSource(kind, rand, budget) {
  if (kind === 'document') {
    const doc = buildDocument(rand, budget);
    let off = 0;
    return {
      kind,
      budget,
      get produced() { return off; },
      get done() { return off >= doc.length; },
      next(size) {
        const n = Math.min(size, doc.length - off);
        const out = Buffer.from(doc.subarray(off, off + n));
        off += n;
        return out;
      },
    };
  }

  let pending = Buffer.alloc(0);
  let produced = 0;
  let item = 0;
  let first = true;

  const nextUnit = () => {
    const n = String(item++).padStart(6, '0');
    const v = Math.floor(rand() * 100000);
    const t = WORDS[Math.floor(rand() * WORDS.length)];
    if (kind === 'sse') {
      const w = () => WORDS[Math.floor(rand() * WORDS.length)];
      return Buffer.from(`data: {"delta":"${w()} ${w()} ${w()} ${w()}"}\n\n`, 'utf8');
    }
    if (kind === 'ndjson') {
      return Buffer.from(`{"name":"row-${n}","value":${v},"type":"${t}"}\n`, 'utf8');
    }
    // json: concatenated top-level JSON documents with no separator. That shape is sniffed as
    // "chunked-json" (the incremental JSON scanner), which is a different decoder path from the
    // ndjson framing and from the whole-body document below.
    const sep = first ? '' : '';
    first = false;
    return Buffer.from(`${sep}{"name":"item-${n}","value":${v},"type":"${t}","score":${rand().toFixed(3)}}`, 'utf8');
  };

  return {
    kind,
    budget,
    get produced() { return produced; },
    get done() { return produced >= budget; },
    next(size) {
      const out = Buffer.allocUnsafe(size);
      let off = 0;
      while (off < size) {
        if (!pending.length) pending = nextUnit();
        const take = Math.min(size - off, pending.length);
        pending.copy(out, off, 0, take);
        off += take;
        pending = pending.subarray(take);
      }
      produced += off;
      return out;
    },
  };
}

// One JSON object of exactly `budget` bytes. The pad value carries the slack so the body is
// byte-exact (and therefore byte-comparable) without ever being truncated.
function buildDocument(rand, budget) {
  for (let keys = 64; keys >= 1; keys--) {
    const parts = [];
    for (let i = 0; i < keys; i++) parts.push(`"k${String(i).padStart(3, '0')}":"${WORDS[i % WORDS.length].repeat(3)}"`);
    const skeleton = `{${parts.join(',')}}`;
    const padLen = budget - skeleton.length - 2; // the two quote characters of the pad value
    if (padLen < 0) continue;
    parts[0] = `"k000":"${'x'.repeat(padLen)}"`;
    const doc = `{${parts.join(',')}}`;
    if (doc.length !== budget) continue;
    return Buffer.from(doc, 'utf8');
  }
  // Fallback for budgets too small for even one key: a plain string document.
  const head = '{"pad":"';
  const tail = '"}';
  const padLen = Math.max(0, budget - head.length - tail.length);
  return Buffer.from(`${head}${'x'.repeat(padLen)}${tail}`, 'utf8');
}

// ---------------------------------------------------------------------------------------------
// In-process fake DevTools socket.
//
// It speaks the same JSON frames a real browser would send, and answers the CDP commands the
// capture path issues (Target.attachToTarget, Network.enable, Network.streamResourceContent,
// Runtime.enable, Page.getFrameTree, ...). No socket, no server, no network.
// ---------------------------------------------------------------------------------------------
class FakeCdpSocket {
  constructor(handlers = {}) {
    this.listeners = new Map();
    this.handlers = handlers;
    this.closed = false;
    this.sent = 0;
  }

  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
  }

  removeEventListener(type, fn) {
    this.listeners.get(type)?.delete(fn);
  }

  _emit(type, ev) {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(ev);
  }

  send(text) {
    this.sent++;
    const msg = JSON.parse(text);
    const result = this.handlers[msg.method]?.(msg.params ?? {}) ?? {};
    const reply = { id: msg.id, result };
    queueMicrotask(() => { if (!this.closed) this.deliver(reply); });
  }

  deliver(obj) {
    this._emit('message', { data: JSON.stringify(obj) });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this._emit('close', { code: 1000, reason: 'loadlab' });
  }
}

const CDP_HANDLERS = {
  'Target.attachToTarget': () => ({ sessionId: 'LAB-SESSION-1' }),
  'Target.setAutoAttach': () => ({}),
  'Target.setDiscoverTargets': () => ({}),
  'Target.getTargets': () => ({ targetInfos: [] }),
  'Network.enable': () => ({}),
  'Network.disable': () => ({}),
  'Network.streamResourceContent': () => ({ bufferedData: '' }),
  'Network.getResponseBody': () => ({ body: '', base64Encoded: false }),
  'Runtime.enable': () => ({}),
  'Runtime.addBinding': () => ({}),
  'Runtime.evaluate': () => ({ result: { value: { blocks: [], turns: [] } } }),
  'Page.enable': () => ({}),
  'Page.addScriptToEvaluateOnNewDocument': () => ({}),
  'Page.getFrameTree': () => ({ frameTree: { frame: { id: 'LAB-FRAME-1' } } }),
  'Page.createIsolatedWorld': () => ({ executionContextId: 1 }),
  'Page.setLifecycleEventsEnabled': () => ({}),
};

// ---------------------------------------------------------------------------------------------
// One scenario (one child process).
// ---------------------------------------------------------------------------------------------
async function runScenario({ mode, cfg }) {
  const probe = installFsProbe();
  const warnings = [];
  const capture = mode === 'capture';

  // The capture stack is only imported when it is actually attached, so the baseline worker
  // really is "same emitter, handlers no-op" and does not even load the capture modules.
  // The import order matters for the fs probe: the first module that imports node:fs as ESM
  // creates the builtin facade, so the probe has to be installed before this point (it is).
  const { DomObserver } = await import('../src/capture/dom.mjs');
  const { CdpConnection } = await import('../src/cdp/client.mjs');
  const { normalizeProfile } = await import('../src/profiles/profiles.mjs');
  const { Recorder } = capture ? await import('../src/capture/recorder.mjs') : { Recorder: null };
  const { NetworkRecorder } = capture ? await import('../src/capture/network.mjs') : { NetworkRecorder: null };
  const { StreamReducer } = capture ? await import('../src/replay/reducer.mjs') : { StreamReducer: null };
  const { ShapeInferencer } = capture ? await import('../src/shapes/infer.mjs') : { ShapeInferencer: null };
  const { Session } = capture ? await import('../src/store/session.mjs') : { Session: null };
  const { streamBytes } = capture ? await import('../src/replay/derive.mjs') : { streamBytes: null };
  const { capturePrivacy } = capture ? await import('../src/capture/privacy.mjs') : { capturePrivacy: null };

  const esmFs = await import('node:fs');
  probe.measured = Object.keys(probe.patched).every((n) => esmFs[n] === probe.patched[n]);
  if (!probe.measured) probe.reason = 'node:fs ESM facade was created before the probe was installed (this process imported node:fs first)';

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-loadlab-'));
  const safeTmp = path.resolve(os.tmpdir());
  if (!path.resolve(tmpRoot).startsWith(safeTmp)) throw new Error(`Refusing to write outside the temp dir: ${tmpRoot}`);
  if (/capture-studio/i.test(tmpRoot)) throw new Error(`Refusing to use a capture-studio data path: ${tmpRoot}`);

  const profile = normalizeProfile({
    name: 'loadlab',
    capture: { websockets: false, retrospectiveFallback: true },
    dom: { enabled: true, flushMs: 100 },
  });

  const pageUrl = 'https://lab.invalid/';
  const rand = mulberry32(cfg.seed);

  // ---- plan the streams -------------------------------------------------------------------
  const totalBytes = Math.round(cfg.mb * 1024 * 1024);
  const chunkBytes = Math.round(cfg.chunkKb * 1024);
  const nStreams = cfg.streams;
  // The last stream is reserved for the whole-body JSON document shape, with a bounded budget
  // so that decoder never holds more than a few MB in memory.
  const documentBudget = Math.min(4 * 1024 * 1024, Math.floor(totalBytes / nStreams));
  const otherCount = Math.max(1, nStreams - (nStreams >= 4 ? 1 : 0));
  const otherBudget = Math.floor((totalBytes - documentBudget) / otherCount);
  const shapes = ['sse', 'json', 'ndjson', 'document'];
  const streams = [];
  for (let i = 0; i < nStreams; i++) {
    const isDocument = nStreams >= 4 && i === nStreams - 1;
    const budget = isDocument ? documentBudget : otherBudget;
    const kind = isDocument ? 'document' : shapes[i % 3];
    const mime = kind === 'sse' ? 'text/event-stream' : kind === 'ndjson' ? 'application/x-ndjson' : 'application/json';
    streams.push({
      index: i,
      kind,
      mime,
      budget,
      requestId: `lab-req-${i}`,
      sid: `p:lab-req-${i}`,
      url: `https://lab.invalid/api/feed/${kind}-${i}`,
      source: byteSource(kind, rand, budget),
      hash: crypto.createHash('sha256'),
      bytesEmitted: 0,
      chunks: 0,
    });
  }

  // ---- build the capture stack ------------------------------------------------------------
  let recorder = null;
  let session = null;
  let dom = null;
  let socket = null;
  let cdpSession = null;

  if (capture) {
    recorder = new Recorder({
      sessionsDir: tmpRoot,
      profileStore: null,
      liveEventsPerStream: 2000,
      maxStreamBytes: 0,
      allBodies: true,
    });
    recorder.profile = profile;
    // start() sets this at recorder.mjs:91. status() (the 1 s timer) and _persist() (the 5 s
    // timer) call privacy.url(). Without it both timers throw on every tick and the capture-on
    // run would silently leave that work out. Wiring it here makes the lab run the same code.
    recorder.privacy = capturePrivacy(profile);
    recorder.pageUrl = pageUrl;
    recorder.state = 'recording';
    recorder.startedAt = Date.now();
    recorder.session = Session.create(tmpRoot, {
      site: 'loadlab',
      rawOptions: {},
      meta: {
        target: { id: 'LAB-TARGET', url: pageUrl, title: 'load lab' },
        profile: { name: profile.name, version: profile.version },
        options: { loadlab: true, mode },
        node: process.version,
      },
    });
    recorder.reducer = new StreamReducer({ deltaDialect: profile.decode?.delta ?? 'auto', maxEventsPerStream: 2000 });
    recorder.shapes = new ShapeInferencer();
    recorder.eventsDs = recorder.session.dataset('events');
    const append = (rec) => recorder._append(rec);
    recorder.net = new NetworkRecorder({
      append,
      profile,
      getPageUrl: () => recorder.pageUrl,
      options: { allBodies: true, maxStreamBytes: 0 },
    });
    recorder.net.on('error', (e) => warnings.push(`network handler error: ${e?.message ?? e}`));
    recorder.dom = new DomObserver({ append, profile });
    session = recorder.session;
    dom = recorder.dom;
  } else {
    // Baseline still builds the same collaborators (so the emitter is byte-identical) but never
    // attaches them to the session: the handlers are no-ops.
    dom = new DomObserver({ append: () => {}, profile });
  }

  socket = new FakeCdpSocket(CDP_HANDLERS);
  const conn = new CdpConnection(socket, { requestTimeoutMs: 0, url: 'ws://127.0.0.1:0/loadlab' });
  cdpSession = await conn.attach('LAB-TARGET');
  if (capture) {
    await recorder.net.attach(cdpSession, 'p', { type: 'page' });
    await recorder.dom.attach(cdpSession);
  }

  // The recorder's own periodic work (recorder.mjs:148-149). The lab reproduces the exact
  // cadence because start() cannot run without Chrome. The baseline has no recorder, so it has
  // no periodic work at all.
  let statusTicks = 0;
  let persistTicks = 0;
  const statusTimer = capture ? setInterval(() => {
    try { recorder.emit('status', recorder.status()); statusTicks++; } catch (e) { warnings.push(`status timer: ${e?.message ?? e}`); }
  }, 1000) : null;
  const persistTimer = capture ? setInterval(() => {
    try { recorder._persist(); persistTicks++; } catch (e) { warnings.push(`persist timer: ${e?.message ?? e}`); }
  }, 5000) : null;
  statusTimer?.unref?.();
  persistTimer?.unref?.();

  // ---- instrument --------------------------------------------------------------------------
  const { monitorEventLoopDelay } = await import('node:perf_hooks');
  const hist = monitorEventLoopDelay({ resolution: 10 });
  hist.enable();

  let datasetPushes = 0;
  if (capture) {
    const ds = recorder.eventsDs;
    const origPush = ds.push.bind(ds);
    ds.push = (items) => { datasetPushes++; return origPush(items); };
  }
  let rawFlushBatches = 0;
  if (capture) session.raw.on('written', () => { rawFlushBatches++; });

  // QUEUE AGE PROBE (no change to src/store/raw-log.mjs). The RawLog instance's flush() is wrapped.
  // Before the real flush runs, the wrapper reads the head of raw.queue exactly as flush() will
  // batch it (same cap, RAW_FLUSH_BATCH_BYTES) and records now - record.t for each record about to
  // be written. Then it calls the original flush with the same arguments. The probe only reads
  // fields; it never writes, reorders or retimes anything. It is armed only during the workload
  // window, so the final drain in close() is not counted.
  const queueAgesMs = [];
  let queueAgeArmed = false;
  let queueFlushSamples = 0;
  let queuePeakBytesSeen = 0;
  if (capture) {
    const raw = session.raw;
    const origFlush = raw.flush.bind(raw);
    raw.flush = (...args) => {
      if (queueAgeArmed && raw.fd !== undefined) {
        const now = Date.now();
        let batchBytes = 0;
        for (let i = 0; i < raw.queue.length && batchBytes < RAW_FLUSH_BATCH_BYTES; i++) {
          const r = raw.queue[i];
          batchBytes += r.bytes;
          queueAgesMs.push(now - r.t);
        }
        if (raw.queueBytes > queuePeakBytesSeen) queuePeakBytesSeen = raw.queueBytes;
        queueFlushSamples++;
      }
      return origFlush(...args);
    };
  }
  queueAgeArmed = capture; // armed for the workload window; disarmed right after hist.disable()

  const maxFrame = { ms: 0, method: null, kind: null, frame: null };
  const slowestFrames = [];
  let cdpFrames = 0;
  let dataFrames = 0;
  let controlFrames = 0;
  let domFrames = 0;

  const rssStart = process.memoryUsage().rss;
  let rssPeak = rssStart;
  const tick = () => new Promise((r) => setImmediate(r));

  const deliver = (obj, method, kind = null) => {
    const t0 = process.hrtime.bigint();
    socket.deliver(obj);
    const dt = Number(process.hrtime.bigint() - t0) / 1e6;
    cdpFrames++;
    if (dt > maxFrame.ms) { maxFrame.ms = dt; maxFrame.method = method; maxFrame.kind = kind; maxFrame.frame = cdpFrames; }
    slowestFrames.push({ ms: Math.round(dt * 1000) / 1000, method, kind, frame: cdpFrames });
    if (slowestFrames.length > 40) slowestFrames.sort((a, b) => b.ms - a.ms);
    if (cdpFrames % 32 === 0) { const r = process.memoryUsage().rss; if (r > rssPeak) rssPeak = r; }
  };

  // ---- emit the workload -------------------------------------------------------------------
  const t0 = process.hrtime.bigint();

  for (const s of streams) {
    deliver({
      method: 'Network.requestWillBeSent',
      sessionId: cdpSession.sessionId,
      params: {
        requestId: s.requestId,
        loaderId: 'LAB-LOADER',
        documentURL: pageUrl,
        request: { url: s.url, method: 'GET', headers: { accept: '*/*' }, hasPostData: false },
        timestamp: 1000 + s.index,
        wallTime: 1700000000 + s.index,
        initiator: { type: 'other' },
        type: 'Fetch',
        frameId: 'LAB-FRAME-1',
      },
    }, 'Network.requestWillBeSent');
    controlFrames++;
    await tick();

    deliver({
      method: 'Network.responseReceived',
      sessionId: cdpSession.sessionId,
      params: {
        requestId: s.requestId,
        timestamp: 1000.5 + s.index,
        type: 'Fetch',
        response: {
          url: s.url,
          status: 200,
          statusText: 'OK',
          headers: { 'content-type': s.mime, 'content-length': String(s.budget) },
          mimeType: s.mime,
          protocol: 'h2',
          remoteIPAddress: '127.0.0.1',
          remotePort: 443,
          fromDiskCache: false,
          fromPrefetchCache: false,
          encodedDataLength: 0,
          securityState: 'secure',
        },
      },
    }, 'Network.responseReceived');
    controlFrames++;
    await tick();
  }

  // DOM batches are interleaved with the network traffic, like a page that keeps re-rendering.
  const domBatchRows = 100;
  const domBatches = Math.ceil(cfg.domRows / domBatchRows);
  let domRowsSent = 0;
  let domBatchIndex = 0;

  const emitDomBatch = () => {
    const rows = Math.min(domBatchRows, cfg.domRows - domRowsSent);
    if (rows <= 0) return;
    const items = [];
    for (let i = 0; i < rows; i++) {
      const n = domRowsSent + i;
      items.push({
        id: `row-${String(n).padStart(6, '0')}`,
        sig: `div.list > li.item:nth-child(${(n % 50) + 1})`,
        text: `Virtualized row ${n} — deterministic synthetic rendered text ${WORDS[n % WORDS.length]} ${WORDS[(n + 3) % WORDS.length]}`,
        tag: 'LI',
        op: n % 10 === 0 ? 'added' : 'updated',
      });
    }
    domRowsSent += rows;
    domBatchIndex++;
    deliver({
      method: 'Runtime.bindingCalled',
      sessionId: cdpSession.sessionId,
      params: { name: dom.binding, payload: JSON.stringify({ type: 'dom.batch', url: pageUrl, items }) },
    }, 'Runtime.bindingCalled');
    domFrames++;
  };

  const active = streams.filter((s) => s.budget > 0);
  let chunkIndex = 0;
  const domEvery = Math.max(1, Math.ceil(active.reduce((a, s) => a + Math.ceil(s.budget / chunkBytes), 0) / Math.max(1, domBatches)));
  while (active.length) {
    for (let i = active.length - 1; i >= 0; i--) {
      const s = active[i];
      const want = Math.min(chunkBytes, s.budget - s.bytesEmitted);
      if (want <= 0) { active.splice(i, 1); continue; }
      const buf = s.source.next(want);
      if (!buf.length) { active.splice(i, 1); continue; }
      s.hash.update(buf);
      s.bytesEmitted += buf.length;
      s.chunks++;
      deliver({
        method: 'Network.dataReceived',
        sessionId: cdpSession.sessionId,
        params: {
          requestId: s.requestId,
          timestamp: 1001 + chunkIndex * 0.001,
          data: buf.toString('base64'),
          encodedDataLength: buf.length,
        },
      }, 'Network.dataReceived', s.kind);
      dataFrames++;
      await tick();

      if (domBatchIndex < domBatches && chunkIndex % domEvery === 0) {
        emitDomBatch();
        await tick();
      }
      chunkIndex++;
    }
  }
  while (domBatchIndex < domBatches) {
    emitDomBatch();
    await tick();
  }

  for (const s of streams) {
    deliver({
      method: 'Network.loadingFinished',
      sessionId: cdpSession.sessionId,
      params: { requestId: s.requestId, timestamp: 2000 + s.index, encodedDataLength: s.bytesEmitted },
    }, 'Network.loadingFinished');
    controlFrames++;
    await tick();
  }

  const wallMs = Number(process.hrtime.bigint() - t0) / 1e6;
  hist.disable();
  // End-of-window queue-age sample: the probe only observes flush(), and the periodic flush
  // timer (RawLog flushIntervalMs, default 50 ms) never fires inside a workload window shorter
  // than one interval, which left fast/tiny runs with zero age samples and empty p50/p99 stats.
  // One explicit flush while still armed records the ages of the records still waiting in the
  // queue at window end; close()'s final drain stays uncounted, as before.
  if (capture) session.raw.flush();
  queueAgeArmed = false;

  rssPeak = Math.max(rssPeak, process.memoryUsage().rss);

  // ---- shut the capture stack down and verify the bytes ------------------------------------
  clearInterval(statusTimer);
  clearInterval(persistTimer);

  let integrity = null;
  const perStream = [];
  let bytesEqual = null;
  let rawBytes = 0;

  if (capture) {
    await session.raw.close();
    integrity = await session.verify();
    rawBytes = session.raw.stats.bytes;
    for (const s of streams) {
      const { bytes } = await streamBytes(session, s.sid);
      const reassembledSha = crypto.createHash('sha256').update(bytes).digest('hex');
      const emittedSha = s.hash.digest('hex');
      perStream.push({
        sid: s.sid,
        kind: s.kind,
        mime: s.mime,
        chunks: s.chunks,
        emittedBytes: s.bytesEmitted,
        emittedSha256: emittedSha,
        reassembledBytes: bytes.length,
        reassembledSha256: reassembledSha,
        equal: emittedSha === reassembledSha && bytes.length === s.bytesEmitted,
      });
    }
    bytesEqual = perStream.length > 0 && perStream.every((p) => p.equal);
  }

  const counters = {
    cdpFrames,
    dataFrames,
    controlFrames,
    domFrames,
    domBatches: domBatchIndex,
    domRows: domRowsSent,
    statusTicks,
    persistTicks,
    datasetPushes,
    rawFlushBatches,
    rawRecords: capture ? session.raw.stats.records : 0,
    rawIndexEntries: capture ? session.raw.stats.indexEntries : 0,
    rawGaps: capture ? session.raw.stats.gaps : 0,
    rawDroppedRecords: capture ? session.raw.stats.droppedRecords : 0,
    reducerEvents: capture ? recorder.reducer.totals.events : 0,
    reducerBytes: capture ? recorder.reducer.totals.bytes : 0,
    networkChunks: capture ? recorder.net.stats.chunks : 0,
    networkBytes: capture ? recorder.net.stats.bytes : 0,
    networkRedactions: capture ? recorder.net.stats.redactions : 0,
    handlerErrors: capture ? recorder.net.stats.handlerErrors : 0,
    domBlocks: capture ? recorder.reducer.dom.blocks.size : 0,
    shapeGroups: capture ? recorder.shapes.groups.size : 0,
  };

  const delay = {
    resolutionMs: 10,
    p50: round3(hist.percentile(50) / 1e6),
    p99: round3(hist.percentile(99) / 1e6),
    max: round3(hist.max / 1e6),
    mean: round3(hist.mean / 1e6),
    min: round3(hist.min / 1e6),
    samples: hist.count,
  };

  const syncFs = {
    measured: probe.measured,
    reason: probe.reason,
    ...(probe.measured
      ? { writeSync: probe.counts.writeSync ?? 0, fsyncSync: probe.counts.fsyncSync ?? 0, appendFileSync: probe.counts.appendFileSync ?? 0, writeFileSync: probe.counts.writeFileSync ?? 0, renameSync: probe.counts.renameSync ?? 0, mkdirSync: probe.counts.mkdirSync ?? 0, openSync: probe.counts.openSync ?? 0, closeSync: probe.counts.closeSync ?? 0, readFileSync: probe.counts.readFileSync ?? 0, total: Object.values(probe.counts).reduce((a, b) => a + b, 0) }
      : { total: null }),
  };

  const result = {
    mode,
    label: capture ? 'capture ON (real capture path)' : 'baseline OFF (same emitter, handlers no-op)',
    wallMs: round3(wallMs),
    bytesEmitted: streams.reduce((a, s) => a + s.bytesEmitted, 0),
    bytesPerSec: wallMs > 0 ? Math.round((streams.reduce((a, s) => a + s.bytesEmitted, 0) / wallMs) * 1000) : 0,
    eventLoopDelayMs: delay,
    maxFrameHandlerMs: { ms: round3(maxFrame.ms), method: maxFrame.method, kind: maxFrame.kind, frame: maxFrame.frame },
    slowestFrames: slowestFrames.sort((a, b) => b.ms - a.ms).slice(0, 5),
    memory: {
      peakRssMb: round3(Math.max(rssPeak, process.resourceUsage().maxRSS * 1024) / (1024 * 1024)),
      rssStartMb: round3(rssStart / (1024 * 1024)),
      rssEndMb: round3(process.memoryUsage().rss / (1024 * 1024)),
      processMaxRssMb: round3((process.resourceUsage().maxRSS * 1024) / (1024 * 1024)),
    },
    syncFs,
    queue: capture
      ? {
        // Queue age = flush-time minus record.t, per record, over the workload window (ms).
        ageSamples: queueAgesMs.length,
        flushSamples: queueFlushSamples,
        ageP50Ms: round3(percentile(queueAgesMs, 50)),
        ageP99Ms: round3(percentile(queueAgesMs, 99)),
        ageMinMs: queueAgesMs.length ? queueAgesMs.reduce((a, b) => (b < a ? b : a)) : null,
        ageMaxMs: queueAgesMs.length ? queueAgesMs.reduce((a, b) => (b > a ? b : a)) : null,
        agesNonNegative: queueAgesMs.every((a) => a >= 0),
        // Peak queue.bytes from RawLog's own stats (updated in append()), and the peak the probe saw.
        peakQueueBytes: session.raw.stats.maxQueueBytesSeen,
        peakQueueBytesAtFlush: queuePeakBytesSeen,
      }
      : null,
    counters,
    bytes: {
      equal: bytesEqual,
      rawLogBytes: rawBytes,
      perStream,
    },
    integrity: integrity
      ? { ok: integrity.ok, records: integrity.records, gapRecords: integrity.gapRecords, droppedRecords: integrity.droppedRecords, unexplainedSeqGaps: integrity.unexplainedSeqGaps ?? 0 }
      : null,
    warnings,
  };

  try { conn.close(); } catch { /* ignore */ }
  if (!cfg.keep) {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  } else {
    result.tempDir = tmpRoot;
  }
  return result;
}

function round3(n) {
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 1000) / 1000;
}

// ---------------------------------------------------------------------------------------------
// Repeat statistics. Exported for the unit test.
//
//   percentile(values, p)  linear interpolation between order statistics (R type 7, the numpy
//                          default): h = (n-1) * p/100. Returns null for an empty list.
//   median(values)         percentile 50.
//   summarize(values)      { n, median, p95, min, max, mean, cv }. cv is the coefficient of
//                          variation = SAMPLE standard deviation (n-1) / |mean|, as a fraction
//                          (0.05 = 5 %). cv is null when n < 2 or the mean is 0.
// Non-finite entries are ignored.
// ---------------------------------------------------------------------------------------------
export function percentile(values, p) {
  const xs = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!xs.length) return null;
  const h = (xs.length - 1) * (p / 100);
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  return xs[lo] + (h - lo) * (xs[hi] - xs[lo]);
}

export function median(values) {
  return percentile(values, 50);
}

export function summarize(values) {
  const xs = values.filter(Number.isFinite);
  const n = xs.length;
  if (!n) return { n: 0, median: null, p95: null, min: null, max: null, mean: null, cv: null };
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  let cv = null;
  if (n > 1 && mean !== 0) {
    const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
    cv = Math.sqrt(variance) / Math.abs(mean);
  }
  return {
    n,
    median: round3(percentile(xs, 50)),
    p95: round3(percentile(xs, 95)),
    min: round3(Math.min(...xs)),
    max: round3(Math.max(...xs)),
    mean: round3(mean),
    cv: cv === null ? null : Math.round(cv * 10000) / 10000,
  };
}

// ---------------------------------------------------------------------------------------------
// Chat scenario (--scenario chat). Realistic AI-chat traffic instead of saturation.
//
//   (a) one SSE reply with typed events (content_block_delta), paced at --rate-kbps for
//       --duration-s, chunks of 200-800 bytes at seeded, jittered intervals;
//   (b) rendered-DOM batches at 4 Hz (--dom-rows is the total over the run);
//   (c) one burst: a --burst-mb JSON history document in 64 KB frames back to back at 40 % of the
//       run;
//   (d) three analytics-like streams, one tiny NDJSON line every 500 ms.
//
// planChatWorkload() builds the whole run up front from the seed: every frame, its bytes and its
// due time. Nothing in the plan reads the clock, so the same seed gives the same bytes and the
// same sha256 values. runChatScenario() delivers the plan on real timers: it waits until each event
// is due and yields to the event loop before every frame. A stall the probe sees is a real stall
// of the capture path, not a side effect of the generator.
// ---------------------------------------------------------------------------------------------
const CHAT = {
  domHz: 4,
  bgStreams: 3,
  bgIntervalMs: 500,
  burstFrameBytes: 64 * 1024,
  burstFraction: 0.4,
  sseChunkMin: 200,
  sseChunkMax: 800,
  probeMs: 10,
  keptStalls: 5,
};
const CHAT_PAGE_URL = 'https://lab.invalid/';

export function planChatWorkload({
  seed = DEFAULTS.seed,
  durationS = DEFAULTS.durationS,
  rateKbps = DEFAULTS.rateKbps,
  burstMb = DEFAULTS.burstMb,
  domRows = DEFAULTS.domRows,
} = {}) {
  const durationMs = Math.round(durationS * 1000);
  const bytesPerMs = (rateKbps * 1024) / 1000;
  // Separate PRNG streams, so each part of the plan does not depend on how many draws another
  // part made.
  const rPlan = mulberry32(seed);
  const rText = mulberry32(seed + 1);
  const rBurst = mulberry32(seed + 2);
  const rBg = mulberry32(seed + 3);

  const streams = [];
  const hashes = new Map();
  const events = [];
  const pushEvent = (atMs, ev) => { events.push({ ...ev, atMs, seq: events.length }); };
  const makeStream = (role, kind, mime, requestId, url) => {
    const s = { index: streams.length, role, kind, mime, requestId, sid: `p:${requestId}`, url, budget: 0, chunks: 0, finishAtMs: 0 };
    streams.push(s);
    hashes.set(s.index, crypto.createHash('sha256'));
    return s;
  };
  const openStream = (s, atMs) => {
    pushEvent(atMs, {
      method: 'Network.requestWillBeSent',
      stream: s.index,
      params: {
        requestId: s.requestId,
        loaderId: 'LAB-LOADER',
        documentURL: CHAT_PAGE_URL,
        request: { url: s.url, method: 'GET', headers: { accept: '*/*' }, hasPostData: false },
        timestamp: 1000 + s.index,
        wallTime: 1700000000 + s.index,
        initiator: { type: 'other' },
        type: 'Fetch',
        frameId: 'LAB-FRAME-1',
      },
    });
    pushEvent(atMs, {
      method: 'Network.responseReceived',
      stream: s.index,
      params: {
        requestId: s.requestId,
        timestamp: 1000.5 + s.index,
        type: 'Fetch',
        response: {
          url: s.url, status: 200, statusText: 'OK', headers: { 'content-type': s.mime }, mimeType: s.mime,
          protocol: 'h2', remoteIPAddress: '127.0.0.1', remotePort: 443, fromDiskCache: false,
          fromPrefetchCache: false, encodedDataLength: 0, securityState: 'secure',
        },
      },
    });
  };
  const addChunk = (s, atMs, buf) => {
    s.budget += buf.length;
    s.chunks++;
    hashes.get(s.index).update(buf);
    pushEvent(atMs, {
      method: 'Network.dataReceived',
      stream: s.index,
      kind: s.kind,
      buf,
      params: { requestId: s.requestId, timestamp: 1001 + atMs / 1000, data: buf.toString('base64'), encodedDataLength: buf.length },
    });
  };

  // (a) SSE reply. The chunk sizes and gaps are drawn first, then the typed-event text fills them.
  // The gap is size / rate times a factor in [0.5, 1.5), so the mean rate is the target rate.
  const sseSizes = [];
  for (let t = 0; t < durationMs;) {
    const size = CHAT.sseChunkMin + Math.floor(rPlan() * (CHAT.sseChunkMax - CHAT.sseChunkMin + 1));
    sseSizes.push({ atMs: t, size });
    t += (size / bytesPerMs) * (0.5 + rPlan());
  }
  const sseTotal = sseSizes.reduce((a, c) => a + c.size, 0);
  let sseText = 'event: message_start\ndata: {"type":"message_start"}\n\n';
  while (sseText.length < sseTotal) {
    const w = () => WORDS[Math.floor(rText() * WORDS.length)];
    sseText += `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"${w()} ${w()} ${w()} "}}\n\n`;
  }
  const sseBytes = Buffer.from(sseText, 'utf8');
  const sse = makeStream('sse', 'sse', 'text/event-stream', 'lab-chat-sse', 'https://lab.invalid/api/chat/completion');
  openStream(sse, 0);
  let sseOff = 0;
  for (const c of sseSizes) {
    addChunk(sse, c.atMs, sseBytes.subarray(sseOff, sseOff + c.size));
    sseOff += c.size;
  }
  sse.finishAtMs = durationMs;

  // (d) analytics-like streams: one tiny NDJSON line every 500 ms, with a seeded phase.
  for (let i = 0; i < CHAT.bgStreams; i++) {
    const s = makeStream('analytics', 'ndjson', 'application/x-ndjson', `lab-chat-bg-${i}`, `https://lab.invalid/collect/analytics-${i}`);
    openStream(s, 0);
    let k = 0;
    for (let t = Math.floor(rBg() * CHAT.bgIntervalMs); t < durationMs; t += CHAT.bgIntervalMs) {
      addChunk(s, t, Buffer.from(`{"ev":"beacon","src":"analytics-${i}","seq":${k},"v":${Math.floor(rBg() * 10000)}}\n`, 'utf8'));
      k++;
    }
    s.finishAtMs = durationMs;
  }

  // (c) the burst: one conversation-history document, 64 KB frames back to back at 40 % of the run.
  // The whole-body JSON parse at loadingFinished is part of what this burst is meant to expose.
  const burstAtMs = Math.round(durationMs * CHAT.burstFraction);
  const burstBytes = Math.round(burstMb * 1024 * 1024);
  const burst = makeStream('burst', 'document', 'application/json', 'lab-chat-burst', 'https://lab.invalid/api/conversations/history');
  openStream(burst, burstAtMs);
  const doc = buildDocument(rBurst, burstBytes);
  for (let off = 0; off < doc.length; off += CHAT.burstFrameBytes) {
    addChunk(burst, burstAtMs, doc.subarray(off, off + CHAT.burstFrameBytes));
  }
  burst.finishAtMs = burstAtMs;

  // (b) rendered-DOM batches at 4 Hz. --dom-rows is the total, spread evenly over the batches.
  const domCount = Math.floor((durationMs * CHAT.domHz) / 1000);
  for (let k = 0; k < domCount; k++) {
    const start = Math.floor((domRows * k) / domCount);
    const end = Math.floor((domRows * (k + 1)) / domCount);
    if (end <= start) continue;
    const items = [];
    for (let n = start; n < end; n++) {
      items.push({
        id: `row-${String(n).padStart(6, '0')}`,
        sig: `div.list > li.item:nth-child(${(n % 50) + 1})`,
        text: `Virtualized row ${n} - deterministic synthetic rendered text ${WORDS[n % WORDS.length]} ${WORDS[(n + 3) % WORDS.length]}`,
        tag: 'LI',
        op: n % 10 === 0 ? 'added' : 'updated',
      });
    }
    pushEvent(Math.round((k * 1000) / CHAT.domHz), {
      method: 'Runtime.bindingCalled',
      stream: null,
      kind: 'dom',
      rows: end - start,
      payload: JSON.stringify({ type: 'dom.batch', url: CHAT_PAGE_URL, items }),
    });
  }

  // Every stream ends at its finish time. Stable sort: events at the same time keep their order.
  for (const s of streams) {
    pushEvent(s.finishAtMs, {
      method: 'Network.loadingFinished',
      stream: s.index,
      params: { requestId: s.requestId, timestamp: 2000 + s.index, encodedDataLength: s.budget },
    });
  }
  events.sort((a, b) => a.atMs - b.atMs || a.seq - b.seq);

  const sumWhere = (pred) => streams.filter(pred).reduce((a, s) => a + s.budget, 0);
  return {
    seed,
    durationMs,
    burstAtMs,
    burstStreamIndex: burst.index,
    pageUrl: CHAT_PAGE_URL,
    events,
    streams: streams.map((s) => ({
      index: s.index,
      role: s.role,
      kind: s.kind,
      mime: s.mime,
      requestId: s.requestId,
      sid: s.sid,
      url: s.url,
      budget: s.budget,
      chunks: s.chunks,
      plannedSha256: hashes.get(s.index).digest('hex'),
    })),
    totals: {
      bytes: streams.reduce((a, s) => a + s.budget, 0),
      sseBytes: sumWhere((s) => s.role === 'sse'),
      analyticsBytes: sumWhere((s) => s.role === 'analytics'),
      burstBytes: burst.budget,
      dataFrames: events.filter((e) => e.buf).length,
      domBatches: events.filter((e) => e.kind === 'dom').length,
      domRows: events.reduce((a, e) => a + (e.rows ?? 0), 0),
    },
  };
}

function withinTarget(value, limit) {
  return Number.isFinite(value) && value <= limit;
}

async function runChatScenario({ mode, cfg }) {
  const probe = installFsProbe();
  const warnings = [];
  const capture = mode === 'capture';

  // Same import order as runScenario: the fs probe is installed before any capture module.
  const { DomObserver } = await import('../src/capture/dom.mjs');
  const { CdpConnection } = await import('../src/cdp/client.mjs');
  const { normalizeProfile } = await import('../src/profiles/profiles.mjs');
  const { Recorder } = capture ? await import('../src/capture/recorder.mjs') : { Recorder: null };
  const { NetworkRecorder } = capture ? await import('../src/capture/network.mjs') : { NetworkRecorder: null };
  const { StreamReducer } = capture ? await import('../src/replay/reducer.mjs') : { StreamReducer: null };
  const { ShapeInferencer } = capture ? await import('../src/shapes/infer.mjs') : { ShapeInferencer: null };
  const { Session } = capture ? await import('../src/store/session.mjs') : { Session: null };
  const { streamBytes } = capture ? await import('../src/replay/derive.mjs') : { streamBytes: null };
  const { capturePrivacy } = capture ? await import('../src/capture/privacy.mjs') : { capturePrivacy: null };

  const esmFs = await import('node:fs');
  probe.measured = Object.keys(probe.patched).every((n) => esmFs[n] === probe.patched[n]);
  if (!probe.measured) probe.reason = 'node:fs ESM facade was created before the probe was installed (this process imported node:fs first)';

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-loadlab-'));
  const safeTmp = path.resolve(os.tmpdir());
  if (!path.resolve(tmpRoot).startsWith(safeTmp)) throw new Error(`Refusing to write outside the temp dir: ${tmpRoot}`);
  if (/capture-studio/i.test(tmpRoot)) throw new Error(`Refusing to use a capture-studio data path: ${tmpRoot}`);

  const profile = normalizeProfile({
    name: 'loadlab',
    capture: { websockets: false, retrospectiveFallback: true },
    dom: { enabled: true, flushMs: 100 },
  });

  // The whole run is planned before the clock starts, so planning cost is not measured.
  const plan = planChatWorkload({ seed: cfg.seed, durationS: cfg.durationS, rateKbps: cfg.rateKbps, burstMb: cfg.burstMb, domRows: cfg.domRows });

  // ---- build the capture stack (same collaborators and timers as runScenario) ---------------
  let recorder = null;
  let session = null;
  let dom = null;
  if (capture) {
    recorder = new Recorder({ sessionsDir: tmpRoot, profileStore: null, liveEventsPerStream: 2000, maxStreamBytes: 0, allBodies: true });
    recorder.profile = profile;
    recorder.privacy = capturePrivacy(profile);
    recorder.pageUrl = CHAT_PAGE_URL;
    recorder.state = 'recording';
    recorder.startedAt = Date.now();
    recorder.session = Session.create(tmpRoot, {
      site: 'loadlab',
      rawOptions: {},
      meta: {
        target: { id: 'LAB-TARGET', url: CHAT_PAGE_URL, title: 'load lab' },
        profile: { name: profile.name, version: profile.version },
        options: { loadlab: true, mode, scenario: 'chat' },
        node: process.version,
      },
    });
    recorder.reducer = new StreamReducer({ deltaDialect: profile.decode?.delta ?? 'auto', maxEventsPerStream: 2000 });
    recorder.shapes = new ShapeInferencer();
    recorder.eventsDs = recorder.session.dataset('events');
    const append = (rec) => recorder._append(rec);
    recorder.net = new NetworkRecorder({ append, profile, getPageUrl: () => recorder.pageUrl, options: { allBodies: true, maxStreamBytes: 0 } });
    recorder.net.on('error', (e) => warnings.push(`network handler error: ${e?.message ?? e}`));
    recorder.dom = new DomObserver({ append, profile });
    session = recorder.session;
    dom = recorder.dom;
  } else {
    dom = new DomObserver({ append: () => {}, profile });
  }

  const socket = new FakeCdpSocket(CDP_HANDLERS);
  const conn = new CdpConnection(socket, { requestTimeoutMs: 0, url: 'ws://127.0.0.1:0/loadlab' });
  const cdpSession = await conn.attach('LAB-TARGET');
  if (capture) {
    await recorder.net.attach(cdpSession, 'p', { type: 'page' });
    await recorder.dom.attach(cdpSession);
  }

  let statusTicks = 0;
  let persistTicks = 0;
  const statusTimer = capture ? setInterval(() => {
    try { recorder.emit('status', recorder.status()); statusTicks++; } catch (e) { warnings.push(`status timer: ${e?.message ?? e}`); }
  }, 1000) : null;
  const persistTimer = capture ? setInterval(() => {
    try { recorder._persist(); persistTicks++; } catch (e) { warnings.push(`persist timer: ${e?.message ?? e}`); }
  }, 5000) : null;
  statusTimer?.unref?.();
  persistTimer?.unref?.();

  const { monitorEventLoopDelay } = await import('node:perf_hooks');
  const hist = monitorEventLoopDelay({ resolution: 10 });
  hist.enable();

  let datasetPushes = 0;
  let rawFlushBatches = 0;
  if (capture) {
    const ds = recorder.eventsDs;
    const origPush = ds.push.bind(ds);
    ds.push = (items) => { datasetPushes++; return origPush(items); };
    session.raw.on('written', () => { rawFlushBatches++; });
  }

  // QUEUE AGE PROBE: the same read-only wrapper as runScenario, armed only during the run.
  const queueAgesMs = [];
  let queueAgeArmed = false;
  let queueFlushSamples = 0;
  let queuePeakBytesSeen = 0;
  if (capture) {
    const raw = session.raw;
    const origFlush = raw.flush.bind(raw);
    raw.flush = (...args) => {
      if (queueAgeArmed && raw.fd !== undefined) {
        const now = Date.now();
        let batchBytes = 0;
        for (let i = 0; i < raw.queue.length && batchBytes < RAW_FLUSH_BATCH_BYTES; i++) {
          const r = raw.queue[i];
          batchBytes += r.bytes;
          queueAgesMs.push(now - r.t);
        }
        if (raw.queueBytes > queuePeakBytesSeen) queuePeakBytesSeen = raw.queueBytes;
        queueFlushSamples++;
      }
      return origFlush(...args);
    };
  }

  // ---- stall probe --------------------------------------------------------------------------
  // A chain of 10 ms timers. Each one records how late it fired. Lateness is the time the loop
  // was not free to run this timer, so it is a stall in the same sense as the event-loop histogram,
  // but with a start time and an end time, which the histogram does not give.
  let t0 = process.hrtime.bigint();
  const nowMs = () => Number(process.hrtime.bigint() - t0) / 1e6;
  let probeDue = 0;
  let probeTimer = null;
  let probing = false;
  let longest = { ms: 0, startMs: null, endMs: null };
  const stalls = [];
  const probeTick = () => {
    if (!probing) return;
    const now = nowMs();
    const late = now - probeDue;
    if (late > 0) {
      const st = { ms: round3(late), startMs: round3(probeDue), endMs: round3(now) };
      if (st.ms > longest.ms) longest = st;
      stalls.push(st);
      if (stalls.length > 200) { stalls.sort((a, b) => b.ms - a.ms); stalls.length = CHAT.keptStalls; }
    }
    probeDue = now + CHAT.probeMs;
    probeTimer = setTimeout(probeTick, CHAT.probeMs);
  };

  // ---- deliver the plan ---------------------------------------------------------------------
  const tick = () => new Promise((r) => setImmediate(r));
  const sleepFor = (ms) => new Promise((r) => setTimeout(r, ms));
  const streamState = new Map(plan.streams.map((s) => [s.index, { hash: crypto.createHash('sha256'), bytes: 0, chunks: 0 }]));
  const maxFrame = { ms: 0, method: null, kind: null, frame: null };
  let cdpFrames = 0;
  let dataFrames = 0;
  let controlFrames = 0;
  let domFrames = 0;
  let domRowsSent = 0;
  let domBatchIndex = 0;
  let burstFrames = 0;
  let burstStartMs = null;
  let burstEndMs = null;
  const rssStart = process.memoryUsage().rss;
  let rssPeak = rssStart;

  const send = (ev) => {
    const isDom = ev.kind === 'dom';
    const startedAt = nowMs();
    const t1 = process.hrtime.bigint();
    socket.deliver({
      method: ev.method,
      sessionId: cdpSession.sessionId,
      params: isDom ? { name: dom.binding, payload: ev.payload } : ev.params,
    });
    const dt = Number(process.hrtime.bigint() - t1) / 1e6;
    cdpFrames++;
    if (dt > maxFrame.ms) { maxFrame.ms = dt; maxFrame.method = ev.method; maxFrame.kind = ev.kind ?? null; maxFrame.frame = cdpFrames; }
    if (ev.buf) {
      const st = streamState.get(ev.stream);
      st.hash.update(ev.buf);
      st.bytes += ev.buf.length;
      st.chunks++;
      dataFrames++;
      if (ev.stream === plan.burstStreamIndex) {
        if (burstStartMs === null) burstStartMs = startedAt;
        burstEndMs = nowMs();
        burstFrames++;
      }
    } else if (isDom) {
      domFrames++;
      domRowsSent += ev.rows;
      domBatchIndex++;
    } else {
      controlFrames++;
    }
    if (cdpFrames % 64 === 0) { const r = process.memoryUsage().rss; if (r > rssPeak) rssPeak = r; }
  };

  // Start the clock and the probe together, then arm the queue probe for the workload window.
  t0 = process.hrtime.bigint();
  probeDue = CHAT.probeMs;
  probing = true;
  probeTimer = setTimeout(probeTick, CHAT.probeMs);
  queueAgeArmed = capture;

  for (const ev of plan.events) {
    const wait = ev.atMs - nowMs();
    // A future event sleeps until it is due. A due or overdue event still yields first, so every
    // frame is its own event-loop turn (back to back for the burst, as a socket delivers them).
    if (wait > 1) await sleepFor(wait);
    else await tick();
    send(ev);
  }

  const wallMs = nowMs();
  probing = false;
  clearTimeout(probeTimer);
  hist.disable();
  // Same end-of-window sample as runScenario: guarantee queue-age observations on runs shorter
  // than one RawLog flush interval.
  if (capture) session.raw.flush();
  queueAgeArmed = false;
  rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
  clearInterval(statusTimer);
  clearInterval(persistTimer);

  // ---- shut the capture stack down and verify the bytes -------------------------------------
  let integrity = null;
  const perStream = [];
  let bytesEqual = null;
  let rawBytes = 0;
  if (capture) {
    await session.raw.close();
    integrity = await session.verify();
    rawBytes = session.raw.stats.bytes;
    for (const s of plan.streams) {
      const st = streamState.get(s.index);
      const { bytes } = await streamBytes(session, s.sid);
      const reassembledSha = crypto.createHash('sha256').update(bytes).digest('hex');
      const emittedSha = st.hash.digest('hex');
      perStream.push({
        sid: s.sid,
        kind: s.kind,
        mime: s.mime,
        chunks: st.chunks,
        emittedBytes: st.bytes,
        emittedSha256: emittedSha,
        reassembledBytes: bytes.length,
        reassembledSha256: reassembledSha,
        equal: emittedSha === reassembledSha && bytes.length === st.bytes && st.bytes === s.budget,
      });
    }
    bytesEqual = perStream.length > 0 && perStream.every((p) => p.equal);
  }

  const bytesEmitted = [...streamState.values()].reduce((a, st) => a + st.bytes, 0);
  const sseBytesEmitted = plan.streams.filter((s) => s.role === 'sse').reduce((a, s) => a + streamState.get(s.index).bytes, 0);
  const seconds = wallMs / 1000;
  const stallsTop = [...stalls].sort((a, b) => b.ms - a.ms).slice(0, CHAT.keptStalls);
  const relToBurst = (ms) => (burstStartMs === null || ms === null || ms === undefined ? null : round3(ms - burstStartMs));
  const burstStartRel = burstStartMs === null ? null : round3(burstStartMs);
  const burstEndRel = burstEndMs === null ? null : round3(burstEndMs);

  const counters = {
    cdpFrames,
    dataFrames,
    controlFrames,
    domFrames,
    domBatches: domBatchIndex,
    domRows: domRowsSent,
    statusTicks,
    persistTicks,
    datasetPushes,
    rawFlushBatches,
    rawRecords: capture ? session.raw.stats.records : 0,
    rawIndexEntries: capture ? session.raw.stats.indexEntries : 0,
    rawGaps: capture ? session.raw.stats.gaps : 0,
    rawDroppedRecords: capture ? session.raw.stats.droppedRecords : 0,
    reducerEvents: capture ? recorder.reducer.totals.events : 0,
    reducerBytes: capture ? recorder.reducer.totals.bytes : 0,
    networkChunks: capture ? recorder.net.stats.chunks : 0,
    networkBytes: capture ? recorder.net.stats.bytes : 0,
    handlerErrors: capture ? recorder.net.stats.handlerErrors : 0,
    shapeGroups: capture ? recorder.shapes.groups.size : 0,
  };

  const delay = {
    resolutionMs: 10,
    p50: round3(hist.percentile(50) / 1e6),
    p99: round3(hist.percentile(99) / 1e6),
    max: round3(hist.max / 1e6),
    mean: round3(hist.mean / 1e6),
    min: round3(hist.min / 1e6),
    samples: hist.count,
  };

  const syncFs = {
    measured: probe.measured,
    reason: probe.reason,
    ...(probe.measured
      ? { writeSync: probe.counts.writeSync ?? 0, fsyncSync: probe.counts.fsyncSync ?? 0, appendFileSync: probe.counts.appendFileSync ?? 0, writeFileSync: probe.counts.writeFileSync ?? 0, renameSync: probe.counts.renameSync ?? 0, mkdirSync: probe.counts.mkdirSync ?? 0, openSync: probe.counts.openSync ?? 0, closeSync: probe.counts.closeSync ?? 0, readFileSync: probe.counts.readFileSync ?? 0, total: Object.values(probe.counts).reduce((a, b) => a + b, 0) }
      : { total: null }),
  };

  const result = {
    mode,
    scenario: 'chat',
    label: capture ? 'capture ON (real capture path)' : 'baseline OFF (same emitter, handlers no-op)',
    wallMs: round3(wallMs),
    bytesEmitted,
    bytesPerSec: seconds > 0 ? Math.round(bytesEmitted / seconds) : 0,
    framesPerSec: seconds > 0 ? round3(cdpFrames / seconds) : null,
    sseKbps: seconds > 0 ? round3(sseBytesEmitted / 1024 / seconds) : null,
    eventLoopDelayMs: delay,
    longestStall: {
      ms: longest.ms,
      startMs: longest.startMs,
      endMs: longest.endMs,
      relativeToBurstStartMs: relToBurst(longest.startMs),
      relativeToBurstEndMs: burstEndMs === null || longest.startMs === null ? null : round3(longest.startMs - burstEndMs),
      inBurstWindow: burstStartMs !== null && longest.startMs !== null && longest.endMs >= burstStartMs && longest.startMs <= burstEndMs,
      probeIntervalMs: CHAT.probeMs,
    },
    stalls: stallsTop.map((s) => ({ ms: s.ms, startMs: s.startMs, endMs: s.endMs, relativeToBurstStartMs: relToBurst(s.startMs) })),
    burst: {
      plannedAtMs: plan.burstAtMs,
      startMs: burstStartRel,
      endMs: burstEndRel,
      windowMs: burstStartMs === null ? null : round3(burstEndMs - burstStartMs),
      frames: burstFrames,
      bytes: plan.totals.burstBytes,
    },
    maxFrameHandlerMs: { ms: round3(maxFrame.ms), method: maxFrame.method, kind: maxFrame.kind, frame: maxFrame.frame },
    memory: {
      peakRssMb: round3(Math.max(rssPeak, process.resourceUsage().maxRSS * 1024) / (1024 * 1024)),
      rssStartMb: round3(rssStart / (1024 * 1024)),
      rssEndMb: round3(process.memoryUsage().rss / (1024 * 1024)),
      processMaxRssMb: round3((process.resourceUsage().maxRSS * 1024) / (1024 * 1024)),
    },
    syncFs,
    queue: capture
      ? {
        ageSamples: queueAgesMs.length,
        flushSamples: queueFlushSamples,
        ageP50Ms: round3(percentile(queueAgesMs, 50)),
        ageP99Ms: round3(percentile(queueAgesMs, 99)),
        ageMinMs: queueAgesMs.length ? queueAgesMs.reduce((a, b) => (b < a ? b : a)) : null,
        ageMaxMs: queueAgesMs.length ? queueAgesMs.reduce((a, b) => (b > a ? b : a)) : null,
        agesNonNegative: queueAgesMs.every((a) => a >= 0),
        peakQueueBytes: session.raw.stats.maxQueueBytesSeen,
        peakQueueBytesAtFlush: queuePeakBytesSeen,
      }
      : null,
    counters,
    bytes: { equal: bytesEqual, rawLogBytes: rawBytes, perStream },
    integrity: integrity
      ? { ok: integrity.ok, records: integrity.records, gapRecords: integrity.gapRecords, droppedRecords: integrity.droppedRecords, unexplainedSeqGaps: integrity.unexplainedSeqGaps ?? 0 }
      : null,
    plan: {
      seed: cfg.seed,
      durationS: cfg.durationS,
      rateKbps: cfg.rateKbps,
      burstMb: cfg.burstMb,
      domRows: cfg.domRows,
      plannedBytes: plan.totals,
      streams: plan.streams.map((s) => ({ sid: s.sid, role: s.role, kind: s.kind, budget: s.budget, chunks: s.chunks, plannedSha256: s.plannedSha256 })),
    },
    warnings,
  };

  try { conn.close(); } catch { /* ignore */ }
  if (!cfg.keep) {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  } else {
    result.tempDir = tmpRoot;
  }
  return result;
}

function buildChatReport(cfg, scenarios) {
  const captureRuns = scenarios.filter((s) => s.mode === 'capture');
  const baselineRuns = scenarios.filter((s) => s.mode === 'baseline');
  const med = (runs, f) => summarize(runs.map(f));
  const modeSummary = (runs, isCapture) => ({
    runs: runs.length,
    eventLoopP50Ms: med(runs, (s) => s.eventLoopDelayMs.p50),
    eventLoopP99Ms: med(runs, (s) => s.eventLoopDelayMs.p99),
    eventLoopMaxMs: med(runs, (s) => s.eventLoopDelayMs.max),
    longestStallMs: med(runs, (s) => s.longestStall.ms),
    longestStallRelBurstStartMs: med(runs, (s) => s.longestStall.relativeToBurstStartMs),
    framesPerSec: med(runs, (s) => s.framesPerSec),
    bytesPerSec: med(runs, (s) => s.bytesPerSec),
    queue: isCapture
      ? {
        ageP50Ms: med(runs, (s) => s.queue?.ageP50Ms),
        ageP99Ms: med(runs, (s) => s.queue?.ageP99Ms),
        ageMaxMs: med(runs, (s) => s.queue?.ageMaxMs),
        peakQueueBytes: med(runs, (s) => s.queue?.peakQueueBytes),
      }
      : null,
    perRepeat: runs.map((s) => ({
      repeat: s.repeat,
      eventLoopP99Ms: s.eventLoopDelayMs.p99,
      longestStallMs: s.longestStall.ms,
      longestStallRelBurstStartMs: s.longestStall.relativeToBurstStartMs,
      queueAgeP99Ms: s.queue ? s.queue.ageP99Ms : null,
    })),
    bytesEqualAllRuns: isCapture ? runs.length > 0 && runs.every((s) => s.bytes.equal === true) : null,
  });
  const summary = { capture: modeSummary(captureRuns, true), baseline: modeSummary(baselineRuns, false) };
  const verdictFor = (m, isCapture) => {
    const T = CHAT_TARGETS;
    const checks = {
      eventLoopP99: m.eventLoopP99Ms.median !== null && withinTarget(m.eventLoopP99Ms.median, T.eventLoopP99Ms),
      longestStall: m.longestStallMs.median !== null && withinTarget(m.longestStallMs.median, T.longestStallMs),
    };
    if (isCapture) checks.queueAgeP99 = m.queue.ageP99Ms.median !== null && withinTarget(m.queue.ageP99Ms.median, T.queueAgeP99Ms);
    const within = (r) => withinTarget(r.eventLoopP99Ms, T.eventLoopP99Ms)
      && withinTarget(r.longestStallMs, T.longestStallMs)
      && (!isCapture || withinTarget(r.queueAgeP99Ms, T.queueAgeP99Ms));
    return {
      pass: Object.values(checks).every(Boolean),
      checks,
      allRepeatsWithinTargets: m.perRepeat.length > 0 && m.perRepeat.every(within),
    };
  };
  return {
    schema: SCHEMA,
    scenario: 'chat',
    generatedAt: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    config: {
      scenario: 'chat',
      durationS: cfg.durationS,
      rateKbps: cfg.rateKbps,
      burstMb: cfg.burstMb,
      domRows: cfg.domRows,
      seed: cfg.seed,
      repeats: cfg.repeats,
      domHz: CHAT.domHz,
      bgStreams: CHAT.bgStreams,
      burstAtFraction: CHAT.burstFraction,
      sseChunkBytes: [CHAT.sseChunkMin, CHAT.sseChunkMax],
      probeIntervalMs: CHAT.probeMs,
    },
    targets: CHAT_TARGETS,
    layers: LAYERS,
    scenarios,
    repeats: {
      count: cfg.repeats,
      order: 'repeat r runs capture then baseline when r is odd, baseline then capture when r is even',
      runs: { capture: captureRuns.length, baseline: baselineRuns.length },
    },
    summary,
    verdict: {
      capture: verdictFor(summary.capture, true),
      baseline: verdictFor(summary.baseline, false),
      basis: 'PASS/FAIL uses the median over repeats. allRepeatsWithinTargets reports the worst repeat. The targets are fixed constants and were not tuned.',
    },
    bytesEqual: summary.capture.bytesEqualAllRuns,
    warnings: scenarios.flatMap((s) => (s.warnings ?? []).map((w) => `${s.mode}#${s.repeat}: ${w}`)),
  };
}

function chatTable(report) {
  const fmt = (v, d = 2) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? 'n/a' : Number(v).toFixed(d));
  const cell = (v, n) => String(v).padStart(n);
  const head = [
    'run'.padEnd(10), cell('wall ms', 9), cell('frames/s', 9), cell('p50 ms', 8), cell('p99 ms', 8), cell('max ms', 8),
    cell('stall ms', 9), cell('stall vs burst', 15), cell('qage p50', 9), cell('qage p99', 9), cell('qage max', 9),
    cell('peak q B', 10), cell('equal', 6),
  ].join(' ');
  const rows = [head, '-'.repeat(head.length)];
  for (const s of report.scenarios) {
    const q = s.queue;
    const rel = s.longestStall.relativeToBurstStartMs;
    rows.push([
      `${s.mode === 'capture' ? 'ON' : 'OFF'} #${s.repeat}`.padEnd(10),
      cell(fmt(s.wallMs, 0), 9),
      cell(fmt(s.framesPerSec, 0), 9),
      cell(fmt(s.eventLoopDelayMs.p50), 8),
      cell(fmt(s.eventLoopDelayMs.p99), 8),
      cell(fmt(s.eventLoopDelayMs.max), 8),
      cell(fmt(s.longestStall.ms), 9),
      cell(rel === null ? 'n/a' : `${rel >= 0 ? '+' : ''}${fmt(rel, 0)} ms`, 15),
      cell(q ? fmt(q.ageP50Ms) : 'n/a', 9),
      cell(q ? fmt(q.ageP99Ms) : 'n/a', 9),
      cell(q ? fmt(q.ageMaxMs) : 'n/a', 9),
      cell(q ? q.peakQueueBytes : 'n/a', 10),
      cell(s.mode === 'capture' ? String(s.bytes.equal) : 'n/a', 6),
    ].join(' '));
  }
  const { capture: C, baseline: B } = report.summary;
  const v = report.verdict;
  rows.push('');
  rows.push(`medians over ${report.repeats.count} repeat(s) per mode (synthetic in-process numbers, not real Chrome):`);
  for (const [tag, m] of [['capture ON ', C], ['baseline OFF', B]]) {
    rows.push(`  ${tag} event-loop p50 ${fmt(m.eventLoopP50Ms.median, 3)} ms  p99 ${fmt(m.eventLoopP99Ms.median, 3)} ms  max ${fmt(m.eventLoopMaxMs.median, 2)} ms | longest stall ${fmt(m.longestStallMs.median, 2)} ms at ${fmt(m.longestStallRelBurstStartMs.median, 0)} ms vs burst start | ${fmt(m.framesPerSec.median, 0)} frames/s`);
  }
  if (C.queue) {
    rows.push(`  capture ON  queue age p50 ${fmt(C.queue.ageP50Ms.median, 3)} ms  p99 ${fmt(C.queue.ageP99Ms.median, 3)} ms  max ${fmt(C.queue.ageMaxMs.median, 2)} ms | peak queue ${fmt(C.queue.peakQueueBytes.median, 0)} bytes`);
  }
  rows.push('');
  for (const [tag, key] of [['capture ON ', 'capture'], ['baseline OFF', 'baseline']]) {
    const x = v[key];
    const parts = Object.entries(x.checks).map(([k, ok]) => `${k} ${ok ? 'met' : 'missed'}`).join(', ');
    rows.push(`VERDICT ${tag}: ${x.pass ? 'PASS' : 'FAIL'}  (${parts}; every repeat within targets: ${x.allRepeatsWithinTargets})`);
  }
  const T = report.targets;
  rows.push(`targets: event-loop p99 <= ${T.eventLoopP99Ms} ms, longest stall <= ${T.longestStallMs} ms, queue age p99 <= ${T.queueAgeP99Ms} ms`);
  rows.push(`bytes equal (capture, every repeat): ${report.bytesEqual}`);
  if (report.warnings.length) rows.push(`warnings: ${report.warnings.length}`);
  return rows.join('\n');
}

// ---------------------------------------------------------------------------------------------
// Parent: run both scenarios and report.
// ---------------------------------------------------------------------------------------------
function runWorker(mode, cfg) {
  const args = [SELF, '--worker', '--mode', mode, '--mb', String(cfg.mb), '--chunk', String(cfg.chunkKb),
    '--streams', String(cfg.streams), '--dom-rows', String(cfg.domRows), '--seed', String(cfg.seed)];
  if (cfg.keep) args.push('--keep');
  if (cfg.scenario === 'chat') {
    args.push('--scenario', 'chat', '--rate-kbps', String(cfg.rateKbps), '--duration-s', String(cfg.durationS), '--burst-mb', String(cfg.burstMb));
  }
  let profileDir = null;
  if (cfg.profile) {
    profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-loadlab-prof-'));
    // The profiler flags must be real command line arguments (Node does not honour them through
    // spawnSync's execArgv), and they have to come before the script path.
    args.unshift(`--cpu-prof-dir=${profileDir}`, '--cpu-prof');
  }
  const res = spawnSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (profileDir) {
    try {
      const summary = summarizeProfile(profileDir);
      if (summary) res.profile = summary;
    } finally {
      try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
  if (res.status !== 0) {
    throw new Error(`worker ${mode} failed (exit ${res.status}):\n${res.stderr || res.stdout || '(no output)'}`);
  }
  const line = (res.stdout || '').trim().split('\n').filter(Boolean).at(-1);
  if (!line) throw new Error(`worker ${mode} produced no output:\n${res.stderr || ''}`);
  let scenario;
  try {
    scenario = JSON.parse(line);
  } catch (e) {
    throw new Error(`worker ${mode} produced invalid JSON: ${e.message}\n${line.slice(0, 400)}`);
  }
  if (res.profile) scenario.cpuProfile = res.profile;
  return scenario;
}

// Self-time summary of a V8 CPU profile: which functions of the capture path actually burn
// the event loop. Only used with --profile.
function summarizeProfile(dir) {
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.cpuprofile')); } catch { return null; }
  if (!files.length) return null;
  const prof = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'));
  const byId = new Map(prof.nodes.map((n) => [n.id, n]));
  const self = new Map();
  for (let i = 0; i < prof.samples.length; i++) {
    const id = prof.samples[i];
    const dt = prof.timeDeltas?.[i] ?? 0;
    self.set(id, (self.get(id) ?? 0) + dt);
  }
  const agg = new Map();
  for (const [id, t] of self) {
    const n = byId.get(id);
    if (!n) continue;
    const cf = n.callFrame;
    const file = (cf.url || '').split(/[\\/]/).slice(-2).join('/');
    const key = `${cf.functionName || '(anonymous)'} @ ${file}:${(cf.lineNumber ?? 0) + 1}`;
    agg.set(key, (agg.get(key) ?? 0) + t / 1000);
  }
  const total = [...agg.values()].reduce((a, b) => a + b, 0);
  return {
    totalMs: Math.round(total),
    top: [...agg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)
      .map(([fn, ms]) => ({ fn, ms: Math.round(ms), pct: +(ms / total * 100).toFixed(1) })),
  };
}

// The run whose event-loop p99 is the median of its mode (lower median for an even count). The
// delta and verdict blocks use it, so repeats = 1 gives exactly the single-run numbers.
function representativeRun(list) {
  if (!list.length) return undefined;
  const sorted = [...list].sort((a, b) => (a.eventLoopDelayMs.p99 ?? 0) - (b.eventLoopDelayMs.p99 ?? 0));
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

function repeatStats(list) {
  const out = {
    eventLoopP99Ms: summarize(list.map((s) => s.eventLoopDelayMs.p99)),
    throughputMBs: summarize(list.map((s) => s.bytesPerSec / 1048576)),
    wallMs: summarize(list.map((s) => s.wallMs)),
  };
  if (list.some((s) => s.queue)) {
    out.queueAgeP50Ms = summarize(list.map((s) => s.queue?.ageP50Ms));
    out.queueAgeP99Ms = summarize(list.map((s) => s.queue?.ageP99Ms));
    out.peakQueueBytes = summarize(list.map((s) => s.queue?.peakQueueBytes));
  }
  return out;
}

function buildReport(cfg, scenarios) {
  const captureRuns = scenarios.filter((s) => s.mode === 'capture');
  const baselineRuns = scenarios.filter((s) => s.mode === 'baseline');
  const capture = representativeRun(captureRuns);
  const baseline = representativeRun(baselineRuns);
  const cP99 = summarize(captureRuns.map((s) => s.eventLoopDelayMs.p99));
  const bP99 = summarize(baselineRuns.map((s) => s.eventLoopDelayMs.p99));
  const p99Delta = cP99.median === null || bP99.median === null ? null : round3(cP99.median - bP99.median);
  const d = (a, b) => (a === null || a === undefined || b === null || b === undefined ? null : round3(a - b));
  const threshold = 50;
  const over = (s) => !!s && s.eventLoopDelayMs.p99 !== null && s.eventLoopDelayMs.p99 > threshold;
  return {
    schema: SCHEMA,
    scenario: 'saturation',
    generatedAt: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    config: {
      mb: cfg.mb,
      chunkKb: cfg.chunkKb,
      streams: cfg.streams,
      domRows: cfg.domRows,
      seed: cfg.seed,
      repeats: cfg.repeats,
      eventLoopDelayResolutionMs: 10,
      p99ThresholdMs: threshold,
    },
    layers: LAYERS,
    scenarios,
    repeats: {
      count: cfg.repeats,
      order: 'repeat r runs capture then baseline when r is odd, baseline then capture when r is even',
      runs: { capture: captureRuns.length, baseline: baselineRuns.length },
      stats: { capture: repeatStats(captureRuns), baseline: repeatStats(baselineRuns) },
      comparison: {
        captureP99MedianMs: cP99.median,
        baselineP99MedianMs: bP99.median,
        eventLoopP99MedianDeltaMs: p99Delta,
        captureWithinPlus5msOfBaseline: p99Delta === null ? null : p99Delta <= 5,
        rule: 'median(capture event-loop p99) - median(baseline event-loop p99) <= 5 ms',
      },
    },
    hotPath: capture?.cpuProfile
      ? { note: 'V8 CPU profile self time of the capture scenario (worker process, whole run).', totalMs: capture.cpuProfile.totalMs, top: capture.cpuProfile.top.slice(0, 12) }
      : null,
    delta: {
      wallMs: d(capture?.wallMs, baseline?.wallMs),
      bytesPerSec: capture && baseline ? round3(capture.bytesPerSec - baseline.bytesPerSec) : null,
      p50Ms: d(capture?.eventLoopDelayMs.p50, baseline?.eventLoopDelayMs.p50),
      p99Ms: d(capture?.eventLoopDelayMs.p99, baseline?.eventLoopDelayMs.p99),
      maxMs: d(capture?.eventLoopDelayMs.max, baseline?.eventLoopDelayMs.max),
      maxFrameHandlerMs: d(capture?.maxFrameHandlerMs.ms, baseline?.maxFrameHandlerMs.ms),
      peakRssMb: d(capture?.memory.peakRssMb, baseline?.memory.peakRssMb),
    },
    verdict: {
      p99Over50ms: { capture: over(capture), baseline: over(baseline) },
      captureStarvesLoop: !!(capture && baseline && capture.eventLoopDelayMs.p99 > threshold && capture.eventLoopDelayMs.p99 > (baseline.eventLoopDelayMs.p99 ?? 0) + 5),
      bytesEqual: capture?.bytes?.equal ?? null,
      note: 'p99 above 50 ms in the capture scenario but not in the baseline points at the capture path, not at the load generator.',
    },
  };
}

function table(report) {
  const rows = [];
  const pad = (v, n, right = true) => {
    const s = String(v);
    return right ? s.padStart(n) : s.padEnd(n);
  };
  const head = [
    pad('scenario', 22, false), pad('mode', 6), pad('wall ms', 10), pad('payload MB', 12), pad('MB/s', 9),
    pad('p50 ms', 9), pad('p99 ms', 9), pad('max ms', 10), pad('peak RSS MB', 13), pad('sync fs', 10), pad('bytes equal', 12),
  ].join(' ');
  rows.push(head);
  rows.push('-'.repeat(head.length));
  for (const s of report.scenarios) {
    rows.push([
      pad(`${s.mode} #${s.repeat ?? 1}`, 22, false),
      pad(s.mode === 'capture' ? 'ON' : 'OFF', 6),
      pad(s.wallMs.toFixed(0), 10),
      pad((s.bytesEmitted / 1048576).toFixed(1), 12),
      pad((s.bytesPerSec / 1048576).toFixed(2), 9),
      pad(s.eventLoopDelayMs.p50?.toFixed(2), 9),
      pad(s.eventLoopDelayMs.p99?.toFixed(2), 9),
      pad(s.eventLoopDelayMs.max?.toFixed(2), 10),
      pad(s.memory.peakRssMb?.toFixed(0), 13),
      pad(s.syncFs.measured ? s.syncFs.total : 'n/a', 10),
      pad(s.bytes.equal === null ? 'n/a' : String(s.bytes.equal), 12),
    ].join(' '));
  }
  const d = report.delta;
  rows.push('-'.repeat(head.length));
  rows.push([
    pad('lag delta (capture - baseline)', 22, false), pad('', 6), pad(d.wallMs?.toFixed(0), 10), pad('', 12), pad('', 9),
    pad(d.p50Ms?.toFixed(2), 9), pad(d.p99Ms?.toFixed(2), 9), pad(d.maxMs?.toFixed(2), 10), pad(d.peakRssMb?.toFixed(0), 13), pad('', 10), pad('', 12),
  ].join(' '));
  const fmt = (v, d = 2) => (v === null || v === undefined ? 'n/a' : Number(v).toFixed(d));
  const line = (label, s, unit, d = 2) => `  ${label.padEnd(30)} median ${fmt(s.median, d)}  p95 ${fmt(s.p95, d)}  min ${fmt(s.min, d)}  max ${fmt(s.max, d)}  CV ${s.cv === null ? 'n/a' : (s.cv * 100).toFixed(1) + '%'}  ${unit}`;
  const rs = report.repeats;
  if (rs) {
    rows.push('');
    rows.push(`repeat statistics over ${rs.count} run(s) per mode (synthetic, in-process; CV = sample stddev / mean):`);
    for (const mode of ['capture', 'baseline']) {
      const st = rs.stats[mode];
      const tag = mode === 'capture' ? 'capture ON ' : 'baseline OFF';
      rows.push(line(`${tag} event-loop p99`, st.eventLoopP99Ms, 'ms', 3));
      rows.push(line(`${tag} throughput`, st.throughputMBs, 'MB/s', 3));
      rows.push(line(`${tag} wall time`, st.wallMs, 'ms', 0));
      if (mode === 'capture' && st.queueAgeP50Ms) {
        rows.push(line('capture queue age p50 (per run)', st.queueAgeP50Ms, 'ms', 3));
        rows.push(line('capture queue age p99 (per run)', st.queueAgeP99Ms, 'ms', 3));
        rows.push(line('capture peak queue.bytes', st.peakQueueBytes, 'bytes', 0));
      }
    }
    const c = rs.comparison;
    rows.push(`  capture p99 median - baseline p99 median = ${fmt(c.eventLoopP99MedianDeltaMs, 3)} ms; capture within +5 ms of baseline: ${c.captureWithinPlus5msOfBaseline}`);
  }
  rows.push('');
  rows.push(`p99 > ${report.config.p99ThresholdMs} ms: capture=${report.verdict.p99Over50ms.capture} baseline=${report.verdict.p99Over50ms.baseline}`);
  rows.push(`raw byte equality (capture): ${report.verdict.bytesEqual}`);
  const c = report.scenarios.find((s) => s.mode === 'capture');
  if (c) {
    rows.push(`capture counters: rawRecords=${c.counters.rawRecords} reducerEvents=${c.counters.reducerEvents} datasetPushes=${c.counters.datasetPushes} domBatches=${c.counters.domBatches} statusTicks=${c.counters.statusTicks} persistTicks=${c.counters.persistTicks} gaps=${c.counters.rawGaps} dropped=${c.counters.rawDroppedRecords}`);
    rows.push(`slowest single CDP frame: ${c.maxFrameHandlerMs.ms} ms (${c.maxFrameHandlerMs.method}${c.maxFrameHandlerMs.kind ? `, ${c.maxFrameHandlerMs.kind}` : ''})`);
  }
  if (report.hotPath) {
    rows.push('');
    rows.push(`hot path (capture, V8 self time, ${report.hotPath.totalMs} ms total):`);
    for (const h of report.hotPath.top.slice(0, 8)) rows.push(`  ${String(h.pct).padStart(5)}%  ${String(h.ms).padStart(7)} ms  ${h.fn}`);
  }
  return rows.join('\n');
}

async function main() {
  let cfg;
  try {
    cfg = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`loadlab: ${e.message}\n\n${usage()}\n`);
    process.exitCode = 2;
    return;
  }
  if (cfg.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  if (cfg.worker) {
    const mode = cfg.mode === 'baseline' ? 'baseline' : 'capture';
    const scenario = cfg.scenario === 'chat' ? await runChatScenario({ mode, cfg }) : await runScenario({ mode, cfg });
    process.stdout.write(`${JSON.stringify(scenario)}\n`);
    return;
  }

  // One child process per run. Order alternates per repeat so a drifting machine does not always
  // favour one mode. With --repeats 1 this is capture then baseline, as before.
  const scenarios = [];
  for (let r = 1; r <= cfg.repeats; r++) {
    const order = r % 2 === 1 ? ['capture', 'baseline'] : ['baseline', 'capture'];
    for (const mode of order) {
      process.stderr.write(`loadlab: repeat ${r}/${cfg.repeats} ${mode}...\n`);
      const scenario = runWorker(mode, cfg);
      scenario.repeat = r;
      scenarios.push(scenario);
    }
  }
  const isChat = cfg.scenario === 'chat';
  const report = isChat ? buildChatReport(cfg, scenarios) : buildReport(cfg, scenarios);
  const text = isChat ? chatTable(report) : table(report);

  if (cfg.out) {
    fs.mkdirSync(path.dirname(path.resolve(cfg.out)), { recursive: true });
    fs.writeFileSync(path.resolve(cfg.out), `${JSON.stringify(report, null, 2)}\n`);
  }
  if (cfg.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.stderr.write(`${text}\n`);
  } else {
    process.stdout.write(`${text}\n`);
  }
}

if (IS_MAIN) await main();
