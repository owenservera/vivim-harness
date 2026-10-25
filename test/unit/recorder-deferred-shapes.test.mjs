// Deferred shape observation in the Recorder must never change what is captured, and must never
// change the shape report when nothing was sampled. Overflow may only skip DERIVED shape work.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Recorder } from '../../src/capture/recorder.mjs';
import { Session } from '../../src/store/session.mjs';
import { StreamReducer } from '../../src/replay/reducer.mjs';
import { ShapeInferencer } from '../../src/shapes/infer.mjs';
import { NetworkRecorder } from '../../src/capture/network.mjs';
import { DomObserver } from '../../src/capture/dom.mjs';

function ndjsonLines(n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(`${JSON.stringify({ name: `row-${i}`, value: (i * 7919) % 1000, type: ['alpha', 'bravo', 'charlie'][i % 3], ts: 1700000000000 + i, tags: ['x', i % 4 ? 'y' : 'z'] })}\n`);
  return out;
}

// A Recorder wired the same way start() and loadlab wire it, without a browser.
function makeRecorder(root, opts = {}) {
  const profile = { name: 'deferred-shapes', version: 1, dom: { enabled: false }, match: { hosts: ['*'] } };
  const r = new Recorder({ sessionsDir: root, ...opts });
  r.profile = profile;
  r.privacy = { url: (u) => u };
  r.pageUrl = 'https://lab.test/';
  r.state = 'recording';
  r.startedAt = Date.now();
  r.session = Session.create(root, { site: 'deferred-shapes' });
  r.reducer = new StreamReducer({ deltaDialect: 'auto', maxEventsPerStream: 2000 });
  r.shapes = new ShapeInferencer();
  r.eventsDs = r.session.dataset('events');
  const append = (rec) => r._append(rec);
  r.net = new NetworkRecorder({ append, profile, getPageUrl: () => r.pageUrl, options: { allBodies: true, maxStreamBytes: 0 } });
  r.dom = new DomObserver({ append, profile });
  return r;
}

// Raw records are written with an explicit t so two runs are byte-comparable.
function feed(r, sid, lines, t0 = 1000) {
  r._append({ k: 'req', sid, t: t0, url: `https://lab.test/api/${sid.replace(':', '-')}/chat`, method: 'POST', type: 'Fetch' });
  r._append({ k: 'res', sid, t: t0 + 1, status: 200, mime: 'application/x-ndjson' });
  for (let i = 0; i < lines.length; i += 7) {
    r._append({ k: 'chunk', sid, t: t0 + 2 + i, b64: Buffer.from(lines.slice(i, i + 7).join('')).toString('base64') });
  }
  r._append({ k: 'done', sid, t: t0 + 2 + lines.length });
}

function counters(r) {
  const c = { records: 0, events: 0 };
  r.on('record', () => c.records++);
  r.on('event', () => c.events++);
  return c;
}

const stable = (rep) => { const { generatedAt, ...rest } = rep; return JSON.parse(JSON.stringify(rest)); };
// Per-event groups only: the 'assembled' group observes finished delta documents, not events.
const groupEvents = (rep) => rep.groups.filter((g) => g.source !== 'assembled').reduce((n, g) => n + g.count, 0);

async function runCapture(opts, lines, sids) {
  const root = mkdtempSync(path.join(tmpdir(), 'recorder-deferred-shapes-'));
  const r = makeRecorder(root, opts);
  const c = counters(r);
  for (const sid of sids) feed(r, sid, lines);
  return { root, r, c };
}

async function finish({ root, r }) {
  try { await r.stop({ reason: 'test' }); } finally { rmSync(root, { recursive: true, force: true }); }
}

test('deferShapes true yields the same shape report as deferShapes false for the same input', async () => {
  const lines = ndjsonLines(400);
  const exact = await runCapture({ deferShapes: false }, lines, ['p:1', 'p:2']);
  const deferred = await runCapture({ deferShapes: true }, lines, ['p:1', 'p:2']);
  try {
    assert.ok(deferred.r.status().stats.shapes.deferred > 0, 'work really was deferred');
    assert.equal(deferred.r.status().stats.shapes.sampledOut, 0, 'nothing sampled without overflow');
    assert.deepEqual(stable(deferred.r.liveReport()), stable(exact.r.liveReport()));
    assert.equal(deferred.c.events, exact.c.events);
    assert.equal(deferred.c.records, exact.c.records);
  } finally { await finish(exact); await finish(deferred); }
});

test('a report requested immediately after appends contains every event (drain on read)', async () => {
  const run = await runCapture({ deferShapes: true }, ndjsonLines(300), ['p:1']);
  try {
    assert.ok(run.r._shapeQ.length - run.r._shapeQi > 0, 'events are still queued when the report is requested');
    const rep = run.r.liveReport();
    assert.equal(groupEvents(rep), run.c.events);
    assert.equal(run.r._shapeQ.length - run.r._shapeQi, 0, 'the read drained the queue');
  } finally { await finish(run); }
});

test('overflow samples derived shape work only: raw and reducer counts equal a deferShapes false run', async () => {
  const lines = ndjsonLines(1500);
  const sids = ['p:1', 'p:2', 'p:3', 'p:4'];
  const exact = await runCapture({ deferShapes: false }, lines, sids);
  const small = await runCapture({ deferShapes: true, maxShapeQueue: 20 }, lines, sids);
  try {
    assert.equal(small.c.records, exact.c.records, 'raw record count is exact');
    assert.equal(small.c.events, exact.c.events, 'reducer event count is exact');
    assert.equal(small.r.session.raw.stats.records, exact.r.session.raw.stats.records);
    const st = small.r.status().stats.shapes;
    assert.ok(st.sampledOut > 0, 'overflow really sampled shape work');
    assert.ok(st.queueHigh <= 20 + 4 * 50, 'queue stays near its cap (forced events are bounded per sid)');
    small.r.flushShapes();
    const seen = new Set();
    for (const g of small.r.shapes.groups.values()) for (const sid of g.streams) seen.add(sid);
    assert.deepEqual([...seen].sort(), sids, 'every sid is still represented');
  } finally { await finish(exact); await finish(small); }
});

test('stop() leaves no pending shape immediate and drains queued work into the report', async () => {
  const run = await runCapture({ deferShapes: true }, ndjsonLines(200), ['p:1']);
  assert.ok(run.r._shapeQ.length - run.r._shapeQi > 0);
  assert.notEqual(run.r._shapeImmediate, null, 'a drain is scheduled');
  await run.r.stop({ reason: 'test' });
  try {
    assert.equal(run.r._shapeImmediate, null, 'the immediate was cleared');
    assert.equal(run.r._shapeQ.length - run.r._shapeQi, 0, 'nothing pending after stop');
    assert.equal(groupEvents(run.r.shapes.report(run.r.reducer)), run.c.events);
    assert.equal(run.r.shapes.report(run.r.reducer).groups.length > 0, true);
  } finally { rmSync(run.root, { recursive: true, force: true }); }
});

test('deferShapes false never schedules a shape drain', async () => {
  const run = await runCapture({ deferShapes: false }, ndjsonLines(100), ['p:1']);
  try {
    assert.equal(run.r._shapeImmediate, null);
    assert.equal(run.r._shapeQ.length, 0);
  } finally { await finish(run); }
});

test('buffered events dataset: a reader that flushes first sees every event; after stop the file has them all', async () => {
  const run = await runCapture({ deferShapes: true }, ndjsonLines(250), ['p:1', 'p:2']);
  const file = run.r.eventsDs.file;
  try {
    assert.equal(run.r.eventsDs.buffered, true, 'events dataset is buffered');
    const seen = await run.r.session.dataset('events').toArray();
    assert.equal(seen.length, run.c.events, 'a reader that flushes first sees every event');
    feed(run.r, 'p:3', ndjsonLines(20), 50_000);
    await run.r.stop({ reason: 'test' });
    const rows = readFileSync(file, 'utf8').split('\n').filter(Boolean);
    assert.equal(rows.length, run.c.events, 'after stop the events file has every event');
    assert.equal(rows.length, (await run.r.session.dataset('events').toArray()).length);
  } finally { rmSync(run.root, { recursive: true, force: true }); }
});
