// Persist-tick cost. (1) Phase timers in gatherEvidence never change the evidence it returns.
// (2) The periodic tick writes STATE and SHAPES asynchronously, yet the files it leaves are complete
// and equal to an explicit read and to the stop result; stop waits for in-flight writes and then
// writes synchronously, so an older periodic snapshot can never land after the final one.
// (3) A failed periodic write is recorded in stats, is never thrown, and produces no unhandled rejection.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Recorder } from '../../src/capture/recorder.mjs';
import { Session, KeyValueStore } from '../../src/store/session.mjs';
import { StreamReducer } from '../../src/replay/reducer.mjs';
import { ShapeInferencer } from '../../src/shapes/infer.mjs';
import { gatherEvidence } from '../../src/families/families.mjs';
import { NetworkRecorder } from '../../src/capture/network.mjs';
import { DomObserver } from '../../src/capture/dom.mjs';

const stable = (rep) => { const { generatedAt, ...rest } = rep; return JSON.parse(JSON.stringify(rest)); };
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

// Minimal reducer surface gatherEvidence reads: summary(), streams (sid -> {_events, _delta}), actions.
function fakeReducer(streams, { actions = [] } = {}) {
  return {
    summary: () => ({
      streams: streams.map((s) => ({ sid: s.sid, method: 'POST', url: s.url, transport: 'HTTP_SSE', kind: 'http', status: s.status, status_code: 200, startedT: 1000, mime: 'text/event-stream', bytes: 0, events: s._events.length })),
      totals: {},
    }),
    streams: new Map(streams.map((s) => [s.sid, s])),
    actions,
  };
}
const streamOf = (sid, url, n, status = 'open', t0 = 0) => ({
  sid, url, status, _delta: { revisions: 0 },
  _events: Array.from({ length: n }, (_, i) => ({ json: { type: ['delta', 'tool_use', 'status'][i % 3], message: { role: i % 2 ? 'user' : 'assistant', text: `line ${t0 + i} lorem ipsum`, id: `${sid}-${t0 + i}` }, items: [{ k: i, v: 'a' }, { k: i + 1, v: 'b' }] } })),
});

test('phase timers do not change the evidence (base, append, new stream, DOM change, stream finishing)', () => {
  const streams = [streamOf('p:1', 'https://lab.test/api/chat', 40), streamOf('p:2', 'https://lab.test/api/other', 15)];
  const reducer = fakeReducer(streams);
  const dom = { inspect: { textLength: 900, proposals: [{ kind: 'inputs', count: 3 }] }, turns: [{ role: 'user' }, { role: 'assistant' }] };
  const steps = [];
  const check = (label) => {
    const plain = gatherEvidence(reducer, { domInspect: dom.inspect, domTurns: dom.turns });
    const phases = {};
    const phased = gatherEvidence(reducer, { domInspect: dom.inspect, domTurns: dom.turns, phases });
    assert.deepEqual(phased, plain, `${label}: phased evidence equals plain evidence`);
    for (const k of ['e.summary', 'e.eventWalk', 'e.derive']) assert.ok(Number.isFinite(phases[k]) && phases[k] >= 0, `${label}: ${k} timed`);
    steps.push(label);
    return plain;
  };
  const base = check('base');
  // Append events to an open stream.
  streams[0]._events.push(...streamOf('p:1', 'x', 10, 'open', 500)._events);
  const appended = check('append');
  assert.equal(appended.eventCount, base.eventCount + 10, 'the appended events are counted');
  // A new stream appears.
  streams.push(streamOf('p:3', 'https://lab.test/api/third', 8, 'open', 900));
  check('new stream');
  // A DOM change (new turns and text length).
  dom.turns.push({ role: 'assistant' }); dom.inspect = { textLength: 1200, proposals: [] };
  const afterDom = check('dom change');
  assert.equal(afterDom.domTurns.length, 3);
  // A stream finishes: the status changes, the events do not.
  streams[1].status = 'complete';
  check('stream finishing');
  assert.deepEqual(steps, ['base', 'append', 'new stream', 'dom change', 'stream finishing']);
});

test('KeyValueStore.setAsync writes the same bytes as set(), leaves no temp file, and later calls land last', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'persist-tick-kv-'));
  try {
    const kv = new KeyValueStore(path.join(dir, 'kv'));
    const value = { big: 'x'.repeat(200_000), n: [1, 2, 3] };
    const first = kv.setAsync('SHAPES', value);
    kv.setAsync('SHAPES', { second: true });
    await first;
    await kv.drain();
    assert.deepEqual(kv.get('SHAPES'), { second: true }, 'the later snapshot is the one on disk');
    kv.setAsync('STATE', value);
    await kv.drain();
    const syncDir = path.join(dir, 'sync'); const syncKv = new KeyValueStore(syncDir);
    syncKv.set('STATE', value);
    assert.equal(readFileSync(path.join(dir, 'kv', 'STATE.json'), 'utf8'), readFileSync(path.join(syncDir, 'STATE.json'), 'utf8'), 'async bytes equal sync bytes');
    assert.deepEqual(readdirSync(path.join(dir, 'kv')).filter((f) => f.endsWith('.tmp')), [], 'no temp files remain');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function makeRecorder(root) {
  const profile = { name: 'persist-tick-cost', version: 1, dom: { enabled: false }, match: { hosts: ['*'] } };
  const r = new Recorder({ sessionsDir: root });
  r.profile = profile; r.privacy = { url: (u) => u }; r.pageUrl = 'https://lab.test/'; r.state = 'recording'; r.startedAt = Date.now();
  r.session = Session.create(root, { site: 'persist-tick-cost' });
  r.reducer = new StreamReducer({ deltaDialect: 'auto', maxEventsPerStream: 2000 });
  r.shapes = new ShapeInferencer();
  r.eventsDs = r.session.dataset('events');
  const append = (rec) => r._append(rec);
  r.net = new NetworkRecorder({ append, profile, getPageUrl: () => r.pageUrl, options: { allBodies: true, maxStreamBytes: 0 } });
  r.dom = new DomObserver({ append, profile });
  return r;
}

function feed(r, sid, n, t0 = 1000) {
  const lines = [];
  for (let i = 0; i < n; i++) lines.push(`${JSON.stringify({ name: `row-${i}`, value: (i * 7919) % 1000, type: ['alpha', 'bravo', 'charlie'][i % 3], ts: 1700000000000 + i })}\n`);
  r._append({ k: 'req', sid, t: t0, url: `https://lab.test/api/${sid.replace(':', '-')}/chat`, method: 'POST', type: 'Fetch' });
  r._append({ k: 'res', sid, t: t0 + 1, status: 200, mime: 'application/x-ndjson' });
  for (let i = 0; i < lines.length; i += 7) r._append({ k: 'chunk', sid, t: t0 + 2 + i, b64: Buffer.from(lines.slice(i, i + 7).join('')).toString('base64') });
  r._append({ k: 'done', sid, t: t0 + 2 + lines.length });
}

test('periodic (async) persist, explicit read and stop carry the same content; stop writes synchronously', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'persist-tick-cost-'));
  const r = makeRecorder(root);
  try {
    feed(r, 'p:1', 200); feed(r, 'p:2', 90, 5000);
    const explicit = stable(r.liveReport());
    const res = await r._persist();
    assert.deepEqual(res, { state: true, shapes: true }, 'both periodic writes settled');
    const file = JSON.parse(readFileSync(path.join(r.session.dir, 'kv', 'SHAPES.json'), 'utf8'));
    assert.deepEqual(stable(file), explicit, 'the asynchronously written file parses and equals an explicit read');
    assert.ok(JSON.parse(readFileSync(path.join(r.session.dir, 'kv', 'STATE.json'), 'utf8')).state, 'STATE file is complete');
    assert.equal(r.status().stats.persist.writes, 2);
    assert.equal(r.status().stats.persist.failed, 0);

    // Stop flushes synchronously: the final SHAPES is on disk when the synchronous persist returns.
    feed(r, 'p:3', 30, 9000);
    const beforeStop = stable(r.liveReport());
    r._persistSync();
    assert.deepEqual(stable(r.session.kv.get('SHAPES')), beforeStop, 'synchronous persist is on disk before it returns');
    await r.stop({ reason: 'test' });
    assert.deepEqual(stable(r.session.kv.get('SHAPES')), beforeStop, 'the stop report equals the explicit read');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a periodic write still in flight at stop cannot overwrite the final snapshot', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'persist-tick-cost-'));
  const r = makeRecorder(root);
  try {
    feed(r, 'p:1', 120);
    const inFlight = r._persist(); // snapshot without the later events below
    feed(r, 'p:2', 60, 7000);      // more events arrive while the periodic write is pending
    const explicit = stable(r.liveReport());
    await r.stop({ reason: 'test' });
    await inFlight;
    assert.deepEqual(stable(r.session.kv.get('SHAPES')), explicit, 'the final snapshot (with the later events) wins');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a failing periodic write is recorded in stats, never thrown, never an unhandled rejection', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'persist-tick-cost-'));
  const r = makeRecorder(root);
  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);
  try {
    feed(r, 'p:1', 40);
    // Injected writer: every asynchronous write rejects.
    r.session.kv.setAsync = () => Promise.reject(new Error('injected EIO'));
    let res;
    assert.doesNotThrow(() => { res = r._persist(); });
    assert.deepEqual(await res, { state: false, shapes: false }, 'the tick resolves with failed writes reported');
    assert.equal(r.status().stats.persist.failed, 2);
    assert.match(r.status().stats.persist.lastError, /injected EIO/);
    // A writer that throws synchronously is also contained.
    r.session.kv.setAsync = () => { throw new Error('injected sync failure'); };
    assert.deepEqual(await r._persist(), { state: false, shapes: false });
    assert.equal(r.status().stats.persist.failed, 4);
    // A real failing write: the kv directory disappears under the recorder.
    delete r.session.kv.setAsync;
    rmSync(r.session.kv.dir, { recursive: true, force: true });
    assert.deepEqual(await r._persist(), { state: false, shapes: false }, 'a real ENOENT is contained too');
    await settle();
    assert.deepEqual(unhandled, [], 'no unhandled rejection');
  } finally {
    process.off('unhandledRejection', onUnhandled);
    await r.session.raw.close();
    rmSync(root, { recursive: true, force: true });
  }
});
