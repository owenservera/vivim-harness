// Capture hot-path performance work must not change what is captured or derived.
// Each test compares the optimised path against an inline reference of the previous behaviour.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CardinalitySketch, sha256Head32Ascii, sketchHash32 } from '../../src/intel/statistics.mjs';
import { typedValueKey } from '../../src/intel/similarity.mjs';
import { SchemaNode, schemaDiff, FORMAT_TESTS, computeFormats } from '../../src/intel/schema.mjs';
import { OnlineSchemaProfiler } from '../../src/shapes/profiler.mjs';
import { ShapeInferencer, templateUrl, computeStringFlags } from '../../src/shapes/infer.mjs';
import { StreamReducer } from '../../src/replay/reducer.mjs';

// Background drains and interval flushes are asynchronous: wait for the condition, never for a
// fixed number of milliseconds, or the test fails whenever the machine is busy.
async function waitFor(check, { timeoutMs = 8000, stepMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error('condition still false after ' + timeoutMs + ' ms');
    await new Promise((r) => setTimeout(r, stepMs));
  }
}
import { Dataset, Session } from '../../src/store/session.mjs';

const refHash = (value) => createHash('sha256').update(typedValueKey(value)).digest().readUInt32BE(0);

function refSketch(values, precision = 8) {
  const registers = new Uint8Array(1 << precision);
  for (const value of values) {
    const hash = refHash(value);
    const index = hash >>> (32 - precision), rest = hash << precision;
    const rank = Math.min(32 - precision + 1, Math.clz32(rest) + 1);
    registers[index] = Math.max(registers[index], rank);
  }
  return registers;
}

test('sha256Head32Ascii matches node:crypto at every padding boundary', () => {
  for (let n = 0; n <= 250; n++) {
    const s = randomBytes(n).toString('base64').replace(/[^A-Za-z0-9+/]/g, 'x').slice(0, n).padEnd(n, 'q');
    assert.equal(s.length, n);
    const expected = createHash('sha256').update(s).digest().readUInt32BE(0);
    const got = sha256Head32Ascii(s);
    if (n <= 247) assert.equal(got, expected, `length ${n}`); else assert.equal(got, null);
  }
  assert.equal(sha256Head32Ascii('é'), null, 'non-ASCII falls back to node:crypto');
  assert.equal(sha256Head32Ascii('string:"x"'), createHash('sha256').update('string:"x"').digest().readUInt32BE(0));
});

test('sketchHash32 equals sha256(typedValueKey(value)) for every value kind', () => {
  const values = ['', 'a', 'row-000123', 'héllo wörld', '日本語', 'x'.repeat(300), 'y'.repeat(5000), 'line\nbreak "quoted"',
    0, -0, 1, -1, 3.14159, 1e21, 123456789012, 0.1 + 0.2, true, false, null, undefined, { b: 1, a: [1, 2, { z: 'q' }] }, ['a', 1]];
  for (const v of values) assert.equal(sketchHash32(v), refHash(v), typedValueKey(v).slice(0, 40));
  for (const v of values) assert.equal(sketchHash32(v), refHash(v), 'memoised second lookup');
});

test('CardinalitySketch registers are bit-identical to the previous implementation', () => {
  const values = [];
  for (let i = 0; i < 4000; i++) values.push(`row-${i}`, i, i / 7, `v${i % 37}`, i % 2 === 0);
  values.push('é', 'x'.repeat(400), null);
  const sk = new CardinalitySketch();
  for (const v of values) sk.add(v);
  assert.deepEqual([...sk.registers], [...refSketch(values)]);
  const sk12 = new CardinalitySketch({ precision: 12 });
  for (const v of values) sk12.add(v);
  assert.deepEqual([...sk12.registers], [...refSketch(values, 12)]);
});

test('SchemaNode state with the memoised format/sketch path is stable and round-trips', () => {
  const rows = [];
  for (let i = 0; i < 600; i++) rows.push({ id: `0f8fad5b-d9cb-469f-a165-${String(i).padStart(12, '0')}`, at: '2026-01-02T03:04:05Z', url: `https://x.test/p/${i}`, n: i * 3, kind: ['a', 'b', 'c'][i % 3], md: i % 5 === 0 ? '# head\n- item' : 'plain' });
  const a = new SchemaNode(); for (const r of rows) a.observe(r);
  const b = new SchemaNode(); for (const r of rows) b.observe(r);
  assert.deepEqual(a.toState(), b.toState());
  assert.deepEqual(SchemaNode.fromState(a.toState()).toState(), a.toState());
  const d = a.describe();
  assert.equal(d.fields.id.string.formats.uuid, 1);
  assert.equal(d.fields.at.string.formats.iso_time, 1);
  assert.equal(d.fields.id.string.cardinalityEstimated, true);
});

test('guarded format / flag detection equals running every regex', () => {
  const corpus = ['', ' ', 'a', '0', '-1', '12', '3.5', '-0.25', 'abc', 'row-000123', 'item_abcdef1', 'Tx_9f8e7d6c5b', 'deadbeefdeadbeef', 'DEADBEEF1234',
    '0f8fad5b-d9cb-469f-a165-70867728950e', '0F8FAD5B-D9CB-469F-A165-70867728950E', '0f8fad5b-d9cb-469f-a165-7086772895', '2026-10-22', '2026-10-22T10:20:30Z', '2026-10-22 10:20:30.123+02:00',
    '2026-10-2', 'x2026-10-22', 'https://a.test/x', 'http://a', '//cdn.test/a', '/path/to/thing', '/a', '/', '//', '/a b', 'a@b.co', '@b.co', 'a@b', 'user@example.com',
    '# Heading', 'text\n- item', 'plain text with * star', '1. one', '```code```', '| a | b |', 'multi\nline', 'x'.repeat(21), '/' + 'a'.repeat(100), '-', '--', '12345678901234567890',
    'hello wörld', '日本語', '😀', 'ftp://x', 'h', 'H', 'ttp://x', '/abc?x=1&y=2#frag', '/a/b/c/d'];
  for (let i = 0; i < 400; i++) corpus.push(randomBytes(1 + (i % 40)).toString('base64').slice(0, 1 + (i % 37)), String(i * 7919), `${i}-${i}-${i}`, `/${i}/x`);
  const rawFormats = (s) => Object.entries(FORMAT_TESTS).filter(([, t]) => t(s)).map(([f]) => f);
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const ISO = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
  const URLISH = /^(https?:\/\/|\/[\w-])/;
  const rawFlags = (v) => {
    const o = [];
    if (UUID.test(v)) o.push('uuid'); if (ISO.test(v)) o.push('isoTime'); if (URLISH.test(v)) o.push('url');
    if (/^\/[\w/-]*$/.test(v) && v.length < 80) o.push('pointer');
    if (/(^|\n)(#{1,6} |\* |- |\d+\. |```|\|.*\|)/.test(v)) o.push('markdown');
    return o;
  };
  for (const s of corpus) {
    assert.deepEqual(computeFormats(s), rawFormats(s), JSON.stringify(s));
    assert.deepEqual(computeStringFlags(s), rawFlags(s), JSON.stringify(s));
  }
});

test('templateUrl memo returns the same value as a fresh computation', () => {
  const urls = ['https://a.test/api/v1/users/123/items/0f8fad5b-d9cb-469f-a165-70867728950e?x=1', 'not a url?q=1', 'https://a.test/', 'wss://a.test/s/abcdefghijklmnopqrstuv1', undefined, null, 42];
  for (const u of urls) { const first = templateUrl(u); assert.equal(templateUrl(u), first); }
  assert.equal(templateUrl('https://a.test/api/v1/users/123/items/0f8fad5b-d9cb-469f-a165-70867728950e?x=1'), 'a.test/api/v1/users/{id}/items/{id}');
  assert.equal(templateUrl('not a url?q=1'), 'not a url');
});

// Reference = the previous eager implementation (window nodes updated on every observe).
function eagerProfile(values, sources, windowSize, minWindow) {
  let total = new SchemaNode(), current = new SchemaNode(), previous = null, windows = 0;
  values.forEach((v) => {
    if (current.count >= windowSize) { previous = current.describe(); current = new SchemaNode(); windows++; }
    total.observe(v); current.observe(v);
  });
  const cur = current.describe();
  return { observations: total.count, completedWindows: windows, windowObservations: current.count, schema: total.describe(), currentSchema: cur,
    drift: previous && current.count >= minWindow ? schemaDiff(previous, cur) : null, driftBasis: previous ? 'adjacent independent observation windows' : 'insufficient windows',
    previous, totalState: total.toState(), currentState: current.toState() };
}

test('lazy window profiler matches the eager window implementation, incl. drift and resumable state', () => {
  const mk = (i) => (i < 450 ? { id: i, name: `n${i}`, kind: ['a', 'b'][i % 2], t: 1700000000 + i } : { id: i, title: `n${i}`, kind: 'c', t: 1700000000 + i, extra: [1, 2, i] });
  for (const [windowSize, total, spanOf] of [[100, 1037, () => 40], [100, 1000, () => 40], [25, 333, () => 40], [100, 700, () => 20000], [100, 99, () => 40]]) {
    const values = Array.from({ length: total }, (_, i) => mk(i));
    const p = new OnlineSchemaProfiler({ windowSize, minWindow: 10 });
    values.forEach((v, i) => p.observe('g', v, { sid: 's', seq: i, t: i, span: [0, spanOf(i)] }));
    const ref = eagerProfile(values, null, windowSize, 10);
    const d = p.describe('g');
    assert.deepEqual({ ...d, source: undefined }, { group: 'g', observations: ref.observations, completedWindows: ref.completedWindows, windowObservations: ref.windowObservations,
      schema: ref.schema, currentSchema: ref.currentSchema, source: undefined, drift: ref.drift, driftBasis: ref.driftBasis }, `windowSize=${windowSize} total=${total}`);
    const st = p.toState().groups[0];
    assert.deepEqual(st.total, ref.totalState);
    assert.deepEqual(st.current, ref.currentState);
    assert.deepEqual(st.previous, ref.previous);
    const back = OnlineSchemaProfiler.fromState(p.toState());
    assert.deepEqual(back.describe('g').schema, d.schema);
    back.observe('g', mk(5000), { sid: 's' });
    assert.equal(back.describe('g').observations, ref.observations + 1);
  }
});

function feed(reducer, shapes, sid, kind, lines) {
  const mime = kind === 'sse' ? 'text/event-stream' : 'application/x-ndjson';
  reducer.ingest({ k: 'req', sid, url: `https://lab.test/api/feed/${sid}/42`, method: 'GET', type: 'Fetch', t: 1 });
  reducer.ingest({ k: 'res', sid, status: 200, mime, t: 2 });
  let seq = 3;
  for (let i = 0; i < lines.length; i += 7) {
    const text = lines.slice(i, i + 7).join('');
    const evs = reducer.ingest({ k: 'chunk', sid, seq, t: seq, b64: Buffer.from(text).toString('base64') });
    seq++;
    for (const ev of evs) shapes.observeEvent(ev, reducer.streams.get(ev.sid));
  }
  reducer.ingest({ k: 'done', sid, t: seq });
}

function ndjsonLines(n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(`${JSON.stringify({ name: `row-${i}`, value: (i * 7919) % 1000, type: ['alpha', 'bravo', 'charlie'][i % 3], ts: 1700000000000 + i, tags: ['x', i % 4 ? 'y' : 'z'] })}\n`);
  return out;
}

test('deferred shape observation yields exactly the inline report (groups + schema profiles)', async () => {
  const lines = ndjsonLines(900);
  const run = async (opts) => {
    const reducer = new StreamReducer({ maxEventsPerStream: 100 });
    const shapes = new ShapeInferencer(opts);
    feed(reducer, shapes, 'p:1', 'ndjson', lines);
    feed(reducer, shapes, 'p:2', 'ndjson', lines.slice(0, 300));
    const pendingBefore = shapes.pendingObservations;
    const rep = shapes.report(reducer);
    return { pendingBefore, groups: JSON.stringify(rep.groups), profiles: JSON.stringify(rep.schemaProfiles), suggestions: JSON.stringify(rep.suggestions.map((s) => [s.id, s.kind, s.confidence])) };
  };
  const inline = await run({ deferred: false });
  const deferred = await run({ deferred: true });
  const tiny = await run({ deferred: true, maxPending: 5, sliceMs: 0 });
  assert.equal(inline.pendingBefore, 0);
  assert.ok(deferred.pendingBefore > 0, 'work really was deferred off the observe call');
  assert.equal(deferred.groups, inline.groups);
  assert.equal(deferred.profiles, inline.profiles);
  assert.equal(deferred.suggestions, inline.suggestions);
  assert.equal(tiny.groups, inline.groups, 'backpressure path keeps FIFO order');
  assert.equal(tiny.profiles, inline.profiles);
});

test('shape reads drain the queue; time-sliced drain empties it without a read', async () => {
  const reducer = new StreamReducer({ maxEventsPerStream: 50 });
  const shapes = new ShapeInferencer();
  feed(reducer, shapes, 'p:1', 'ndjson', ndjsonLines(200));
  assert.ok(shapes.pendingObservations > 0);
  assert.equal([...shapes._groups.values()].reduce((a, g) => a + g.count, 0) < 200, true);
  await waitFor(() => shapes.pendingObservations === 0);
  assert.equal(shapes.pendingObservations, 0, 'setImmediate slices drained the backlog');
  assert.equal([...shapes.groups.values()].reduce((a, g) => a + g.count, 0), 200);
});

test('reducer.summary() memo: identical to a cold summary at every step, invalidated on append, copy-safe', () => {
  const recs = [];
  let seq = 0;
  const add = (r) => recs.push({ seq: ++seq, t: 1000 + seq * 50, ...r });
  for (const sid of ['p:1', 'p:2', 'p:3']) {
    add({ k: 'req', sid, url: `https://x.test/api/${sid}`, method: 'GET', type: 'Fetch' });
    add({ k: 'res', sid, status: 200, mime: sid === 'p:2' ? 'text/event-stream' : 'application/x-ndjson' });
  }
  for (let i = 0; i < 12; i++) {
    const sid = ['p:1', 'p:2', 'p:3'][i % 3];
    const body = sid === 'p:2' ? `data: {"delta":"w${i}"}\n\n` : `{"id":${i},"text":"row ${i}"}\n`;
    add({ k: 'chunk', sid, b64: Buffer.from(body).toString('base64') });
    if (i === 5) add({ k: 'fail', sid: 'p:3', errorText: 'net::ERR', canceled: false });
    if (i === 7) add({ k: 'req', sid: 'p:4', url: 'https://x.test/api/p:3', method: 'GET', type: 'Fetch' });
    if (i === 9) add({ k: 'gap', droppedRecords: 2, sids: ['p:1'] });
  }
  add({ k: 'done', sid: 'p:1' });
  add({ k: 'run.end' });
  const now = 424242;
  const live = new StreamReducer();
  recs.forEach((rec, i) => {
    live.ingest(rec);
    const cached1 = live.summary({ now });
    const cached2 = live.summary({ now });                                  // served from the memo
    const cold = StreamReducer.replay(recs.slice(0, i + 1)).summary({ now }); // no memo history
    assert.equal(JSON.stringify(cached1), JSON.stringify(cold), `after record ${i + 1} (${rec.k})`);
    assert.equal(JSON.stringify(cached2), JSON.stringify(cold));
  });
  // Caller mutation of a returned summary never leaks into later calls.
  const a = live.summary({ now });
  a.streams[0].deltaDialects.push('hacked'); a.streams[0].deltaOps.hacked = 1; a.streams[0].bytes = -1;
  const b = live.summary({ now });
  assert.ok(!b.streams[0].deltaDialects.includes('hacked'));
  assert.equal(b.streams[0].deltaOps.hacked, undefined);
  assert.ok(b.streams[0].bytes >= 0);
  // The clock-dependent field follows `now`, not the memo.
  const open = new StreamReducer();
  open.ingest({ seq: 1, t: 1000, k: 'req', sid: 'p:9', url: 'https://x.test/', method: 'GET' });
  open.ingest({ seq: 2, t: 1100, k: 'res', sid: 'p:9', status: 200, mime: 'application/x-ndjson' });
  open.ingest({ seq: 3, t: 1200, k: 'chunk', sid: 'p:9', b64: Buffer.from('{"a":1}\n').toString('base64') });
  assert.equal(open.summary({ now: 2000 }).streams[0].idleMs, 800);
  assert.equal(open.summary({ now: 5000 }).streams[0].idleMs, 3800);
});

test('buffered events dataset: identical bytes, visible to every reader before it is flushed', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'cs-perf-ds-'));
  try {
    const session = Session.create(root, { site: 'perf' });
    const buffered = session.dataset('events');
    const plain = session.dataset('timeline');
    assert.equal(buffered.buffered, true);
    assert.equal(plain.buffered, false);
    const rows = Array.from({ length: 50 }, (_, i) => ({ seq: i, sid: 'p:1', t: i, json: { i } }));
    for (let i = 0; i < rows.length; i += 5) { buffered.push(rows.slice(i, i + 5)); plain.push(rows.slice(i, i + 5)); }
    assert.equal(buffered.count, 50);
    assert.equal(existsSync(buffered.file), false, 'nothing hit the disk yet (chunked)');
    // a fresh Dataset instance for the same file (what session.dataset() returns) sees the lines
    const seen = await session.dataset('events').toArray();
    assert.equal(seen.length, 50);
    assert.deepEqual(seen, rows);
    assert.equal(readFileSync(buffered.file, 'utf8'), readFileSync(plain.file, 'utf8'), 'byte-identical to unbuffered appends');
    // verify()/saveMeta()/bytes() flush too
    buffered.push({ seq: 99 });
    assert.ok(session.bytes().datasets > 0);
    assert.equal((await session.dataset('events').toArray()).length, 51);
    buffered.push({ seq: 100 });
    await session.verify();
    assert.match(readFileSync(buffered.file, 'utf8'), /"seq":100/);
    // interval flush without any reader
    buffered.push({ seq: 101 });
    await waitFor(() => { try { return /"seq":101/.test(readFileSync(buffered.file, 'utf8')); } catch { return false; } });
    // size flush
    const big = new Dataset(path.join(root, 'big.jsonl'), { buffered: true, flushBytes: 200 });
    big.push({ pad: 'x'.repeat(300) });
    assert.ok(existsSync(big.file), 'size threshold flushes immediately');
    // reset drops pending lines
    const r = new Dataset(path.join(root, 'r.jsonl'), { buffered: true });
    r.push({ a: 1 }); r.reset();
    assert.equal(existsSync(r.file), false);
    r.push({ a: 2 }); r.close();
    assert.equal(readFileSync(r.file, 'utf8'), '{"a":2}\n');
    await session.raw.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
