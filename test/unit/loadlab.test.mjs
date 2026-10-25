// Smoke test for the capture-path load lab (scripts/loadlab.mjs).
//
// Fast and deterministic on purpose: a tiny payload, no timing thresholds. The test asserts
// that the lab produces a well-formed report and that the bytes the fake browser emitted are
// byte-identical to the bytes reassembled from the saved raw log.
//
// It never asserts a latency budget: event-loop delay depends on the machine and would make
// the suite flaky. The numbers are for the report, not for CI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { median, percentile, planChatWorkload, summarize } from '../../scripts/loadlab.mjs';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'loadlab.mjs');

// Tiny payload: 50 KB over 4 streams, 16 KB per CDP frame, 50 rendered-DOM rows. Small
// enough to stay well under the 3 s budget, large enough that every stream shape is emitted
// at least once and the raw log really is written and read back. --repeats 1 keeps it to one
// run per mode (the default is 5).
const TINY = ['--mb', '0.05', '--chunk', '16', '--streams', '4', '--dom-rows', '50', '--repeats', '1', '--json'];

// The lab is run once and shared: every worker is a separate process, so running it per test
// would triple the cost without testing anything new.
let cached = null;
function runLab(extra = []) {
  if (extra.length) {
    const res = spawnSync(process.execPath, [SCRIPT, ...extra], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 120_000 });
    return { res, report: null };
  }
  if (!cached) {
    const res = spawnSync(process.execPath, [SCRIPT, ...TINY], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 120_000 });
    assert.equal(res.status, 0, `loadlab exited ${res.status}\n${res.stderr || res.stdout}`);
    cached = JSON.parse(res.stdout);
  }
  return { res: null, report: cached };
}

test('load lab reports both modes with the expected shape', () => {
  const { report } = runLab();

  assert.equal(report.schema, 'aion-capture-studio.loadlab/1');
  assert.ok(Array.isArray(report.scenarios), 'scenarios must be an array');
  assert.equal(report.scenarios.length, 2, 'capture and baseline scenarios');

  const modes = report.scenarios.map((s) => s.mode).sort();
  assert.deepEqual(modes, ['baseline', 'capture']);

  assert.ok(Array.isArray(report.layers.exercised) && report.layers.exercised.length > 0);
  assert.ok(Array.isArray(report.layers.notExercised) && report.layers.notExercised.length > 0);
  assert.ok(report.layers.exercised.some((l) => l.includes('src/capture/recorder.mjs')));
  assert.ok(report.layers.exercised.some((l) => l.includes('src/store/raw-log.mjs')));

  for (const s of report.scenarios) {
    assert.equal(typeof s.wallMs, 'number');
    assert.ok(s.bytesEmitted > 0, 'the scenario must emit bytes');
    assert.equal(typeof s.bytesPerSec, 'number');
    assert.ok(s.eventLoopDelayMs, 'event loop delay must be reported');
    for (const k of ['p50', 'p99', 'max']) {
      assert.equal(typeof s.eventLoopDelayMs[k], 'number', `eventLoopDelayMs.${k} must be a number`);
    }
    assert.ok(s.memory && typeof s.memory.peakRssMb === 'number', 'peak RSS must be reported');
    assert.ok(s.syncFs && typeof s.syncFs.measured === 'boolean', 'sync fs accounting must be reported');
    assert.ok(s.counters && typeof s.counters.rawRecords === 'number', 'counters must be reported');
    assert.ok(Array.isArray(s.slowestFrames));
  }

  assert.ok(report.delta && typeof report.delta.p99Ms === 'number');
  assert.ok(report.verdict && typeof report.verdict.p99Over50ms.capture === 'boolean');
  assert.equal(typeof report.verdict.bytesEqual, 'boolean');
});

test('load lab reproduces the emitted bytes exactly from the raw log', () => {
  const { report } = runLab();
  const capture = report.scenarios.find((s) => s.mode === 'capture');

  assert.equal(capture.bytes.equal, true, 'reassembled raw bytes must equal the emitted bytes');
  assert.ok(capture.bytes.perStream.length >= 2, 'every stream must be checked');
  for (const p of capture.bytes.perStream) {
    assert.equal(p.equal, true, `stream ${p.sid} must match byte for byte`);
    assert.equal(p.emittedSha256, p.reassembledSha256);
    assert.equal(p.emittedBytes, p.reassembledBytes);
    assert.ok(p.emittedBytes > 0);
  }
  assert.ok(capture.integrity && capture.integrity.ok === true, 'the raw log must verify');
  assert.equal(capture.counters.rawGaps, 0, 'no record may be dropped');
  assert.equal(capture.counters.rawDroppedRecords, 0);
  assert.ok(capture.counters.reducerEvents > 0, 'the reducer must have decoded events');
  assert.ok(capture.counters.domBatches > 0, 'the DOM batch path must have run');
  // The recorder's 1 s status and 5 s persist timers run inside the capture scenario. A throw
  // inside them is caught and recorded as a warning, so it would not fail the run by itself.
  assert.deepEqual(capture.warnings, [], 'the capture scenario must run its timers without errors');

  const baseline = report.scenarios.find((s) => s.mode === 'baseline');
  assert.equal(baseline.bytes.equal, null, 'the baseline writes nothing, so there is nothing to compare');
  assert.equal(baseline.counters.rawRecords, 0, 'the baseline must not write raw records');
});

test('load lab refuses an oversized payload and prints its usage', () => {
  // One spawn covers both: the CLI prints the usage text with the error.
  const tooBig = spawnSync(process.execPath, [SCRIPT, '--mb', '4096'], { encoding: 'utf8', timeout: 60_000 });
  assert.notEqual(tooBig.status, 0, '--mb above the cap must fail');
  assert.match(tooBig.stderr, /capped at 512 MB/);
  assert.match(tooBig.stderr, /--mb N/);
  assert.match(tooBig.stderr, /--streams N/);
});

// ---- repeat statistics (fixed inputs, exact expected values) --------------------------------

test('percentile uses linear interpolation between order statistics', () => {
  // n = 5: h = (n-1) * p/100. p50 -> index 2, p95 -> h = 3.8 -> 4 + 0.8 * (5 - 4) = 4.8.
  assert.equal(percentile([1, 2, 3, 4, 5], 50), 3);
  assert.ok(Math.abs(percentile([1, 2, 3, 4, 5], 95) - 4.8) < 1e-12);
  // Input order must not matter.
  assert.equal(percentile([5, 1, 4, 2, 3], 50), 3);
  // Even count: p50 is the mean of the two middle values.
  assert.equal(median([1, 2, 3, 4]), 2.5);
  // Single value and empty input.
  assert.equal(percentile([7], 95), 7);
  assert.equal(percentile([], 50), null);
});

test('summarize reports median, p95, min, max, mean and sample CV on fixed arrays', () => {
  const s = summarize([1, 2, 3, 4, 5]);
  assert.equal(s.n, 5);
  assert.equal(s.median, 3);
  assert.equal(s.p95, 4.8);
  assert.equal(s.min, 1);
  assert.equal(s.max, 5);
  assert.equal(s.mean, 3);
  // Sample variance = (4 + 1 + 0 + 1 + 4) / 4 = 2.5, sd = 1.5811, CV = sd / mean = 0.5270.
  assert.ok(Math.abs(s.cv - 0.5270) < 1e-4, `cv was ${s.cv}`);

  // Constant input has zero spread.
  const flat = summarize([10, 10, 10]);
  assert.equal(flat.cv, 0);
  assert.equal(flat.median, 10);

  // Unsorted input and non-finite entries are handled: only 2 and 8 count.
  const odd = summarize([8, NaN, 2, null]);
  assert.equal(odd.n, 2);
  assert.equal(odd.median, 5);
  assert.equal(odd.min, 2);
  assert.equal(odd.max, 8);

  // One sample has no sample standard deviation, so CV is null rather than 0.
  assert.equal(summarize([4]).cv, null);
  assert.equal(summarize([]).n, 0);
  assert.equal(summarize([]).median, null);
  // Zero mean: CV is undefined.
  assert.equal(summarize([-1, 1]).cv, null);
});

// ---- repeat mode and queue-age sanity on a tiny run -----------------------------------------

test('repeat mode runs every mode N times and queue age is non-negative and sane', () => {
  const res = spawnSync(process.execPath, [SCRIPT, '--mb', '0.05', '--chunk', '16', '--streams', '4', '--dom-rows', '50', '--repeats', '2', '--json'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 240_000 });
  assert.equal(res.status, 0, `loadlab exited ${res.status}\n${res.stderr}`);
  const report = JSON.parse(res.stdout);

  assert.equal(report.scenarios.length, 4, 'two repeats of capture and baseline');
  assert.equal(report.repeats.count, 2);
  assert.equal(report.repeats.runs.capture, 2);
  assert.equal(report.repeats.runs.baseline, 2);
  assert.deepEqual(report.scenarios.map((s) => `${s.mode}#${s.repeat}`).sort(), ['baseline#1', 'baseline#2', 'capture#1', 'capture#2']);

  const cStats = report.repeats.stats.capture;
  for (const k of ['eventLoopP99Ms', 'throughputMBs', 'wallMs', 'queueAgeP50Ms', 'queueAgeP99Ms', 'peakQueueBytes']) {
    assert.ok(cStats[k] && cStats[k].n === 2, `capture ${k} must summarise both repeats`);
  }
  assert.ok(report.repeats.stats.baseline.eventLoopP99Ms.n === 2);
  assert.equal(typeof report.repeats.comparison.captureWithinPlus5msOfBaseline, 'boolean');

  for (const s of report.scenarios.filter((x) => x.mode === 'capture')) {
    const q = s.queue;
    assert.ok(q, 'capture runs must report queue age');
    assert.ok(q.ageSamples > 0, 'every queued record in the window must be sampled');
    assert.ok(q.flushSamples > 0);
    assert.equal(q.agesNonNegative, true, 'queue age can never be negative');
    assert.ok(q.ageMinMs >= 0);
    assert.ok(q.ageP50Ms >= q.ageMinMs && q.ageP99Ms >= q.ageP50Ms && q.ageMaxMs >= q.ageP99Ms, 'p50 <= p99 <= max, min <= p50');
    assert.ok(q.ageMaxMs <= s.wallMs + 5, 'a record cannot wait longer than the run itself');
    assert.ok(q.peakQueueBytes >= 0 && q.peakQueueBytes >= q.peakQueueBytesAtFlush, 'peak queue bytes covers what the probe saw');
  }
  for (const s of report.scenarios.filter((x) => x.mode === 'baseline')) {
    assert.equal(s.queue, null, 'baseline has no queue');
  }
});

// ---- chat scenario (--scenario chat) --------------------------------------------------------

test('chat plan is deterministic for a seed and depends on it', () => {
  const opts = { durationS: 3, rateKbps: 40, burstMb: 1, domRows: 50 };
  const a = planChatWorkload({ seed: 7, ...opts });
  const b = planChatWorkload({ seed: 7, ...opts });
  assert.deepEqual(a.totals, b.totals, 'same seed, same byte counts');
  const digest = (p) => p.streams.map((s) => [s.sid, s.budget, s.chunks, s.plannedSha256]);
  assert.deepEqual(digest(a), digest(b), 'same seed, same bytes');
  assert.equal(a.events.length, b.events.length);

  const c = planChatWorkload({ seed: 8, ...opts });
  assert.notEqual(c.streams[0].plannedSha256, a.streams[0].plannedSha256, 'a different seed changes the bytes');

  // The reply carries about rate x duration: 40 KB/s x 3 s = 122880 bytes.
  const sse = a.streams.find((s) => s.kind === 'sse');
  const want = 40 * 1024 * 3;
  assert.ok(Math.abs(sse.budget - want) / want < 0.1, `sse bytes ${sse.budget} vs ${want}`);
  // The burst is exactly --burst-mb and fires at 40 % of the run.
  assert.equal(a.streams.find((s) => s.role === 'burst').budget, 1024 * 1024);
  assert.equal(a.burstAtMs, 1200);
  // --dom-rows is a total over the run, and 4 Hz over 3 s is 12 batches.
  assert.equal(a.totals.domRows, 50);
  assert.equal(a.totals.domBatches, 12);
});

// One short chat run, shared by the chat tests: 3 s of reply, a 1 MB burst at 1.2 s, one repeat.
let chatCached = null;
function runChat() {
  if (!chatCached) {
    const res = spawnSync(process.execPath, [SCRIPT, '--scenario', 'chat', '--duration-s', '3', '--burst-mb', '1', '--rate-kbps', '40', '--repeats', '1', '--json'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 120_000 });
    assert.equal(res.status, 0, `loadlab chat exited ${res.status}\n${res.stderr}`);
    chatCached = JSON.parse(res.stdout);
  }
  return chatCached;
}

test('chat scenario runs both modes, reproduces the bytes and times the stall against the burst', () => {
  const report = runChat();
  assert.equal(report.schema, 'aion-capture-studio.loadlab/1');
  assert.equal(report.scenario, 'chat');
  assert.deepEqual(report.scenarios.map((s) => s.mode).sort(), ['baseline', 'capture']);
  const capture = report.scenarios.find((s) => s.mode === 'capture');
  const baseline = report.scenarios.find((s) => s.mode === 'baseline');

  assert.equal(capture.scenario, 'chat');
  assert.equal(capture.bytes.equal, true, 'reassembled raw bytes must equal the emitted bytes');
  for (const p of capture.bytes.perStream) assert.equal(p.equal, true, `stream ${p.sid} must match byte for byte`);
  assert.equal(capture.integrity?.ok, true, 'the raw log must verify');
  assert.deepEqual(capture.warnings, [], 'no warnings in the capture run');
  assert.deepEqual(baseline.warnings, [], 'no warnings in the baseline run');

  // The longest stall is reported with its time relative to the burst.
  assert.equal(typeof capture.longestStall.ms, 'number');
  assert.ok('relativeToBurstStartMs' in capture.longestStall, 'longest stall must be timed against the burst');
  assert.ok(Array.isArray(capture.stalls));
  // The burst fires at 40 % of 3 s and is never early. 16 frames of 64 KB make 1 MB.
  assert.ok(capture.burst.startMs >= 1190 && capture.burst.startMs < 3000, `burst start ${capture.burst.startMs}`);
  assert.equal(capture.burst.frames, 16);
  assert.ok(report.verdict.capture && typeof report.verdict.capture.pass === 'boolean');
});
