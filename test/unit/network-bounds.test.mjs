import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NetworkRecorder } from '../../src/capture/network.mjs';

// Bounded-memory and byte-cap behaviour of NetworkRecorder. Driven through the same public
// methods the CDP listeners use, with a fake session: no Chrome, no network.
const KIB = 1024, MIB = 1024 * KIB;
const MODES = ['local-raw', 'filtered'];

const profile = (mode) => ({
  scope: { origins: ['same-site'], thirdParty: 'ignore' },
  capture: { privacyMode: mode, include: [], exclude: [], bodyResourceTypes: ['XHR', 'Fetch'],
    websockets: true, wsSentFrames: false, requestBodies: false, retrospectiveFallback: false },
});
const harness = (mode, options = {}) => {
  const records = [];
  const net = new NetworkRecorder({ append: (r) => { records.push(r); return records.length; },
    profile: profile(mode), getPageUrl: () => 'https://example.com/chat', options });
  return { net, records };
};
// Safe ASCII: contains no credential marker, so filtered mode never excludes it.
const safe = (n, offset = 0) => Buffer.from(Array.from({ length: n }, (_, i) => 97 + ((i + offset) % 26)));
const persisted = (records) => Buffer.concat(records.filter((r) => r.k === 'chunk').map((r) => Buffer.from(r.b64, 'base64')));
const markers = (records) => records.filter((r) => r.k === 'body.truncated');

for (const mode of MODES) {
  test(`[${mode}] cap 64 KiB: a 128 KiB final chunk is split at the boundary with an exact marker`, async () => {
    const CAP = 64 * KIB;
    const { net, records } = harness(mode, { maxStreamBytes: CAP });
    const st = { sid: 'p:cap', body: true, armed: true, chunks: 0, bytes: 0 };
    net.reqs.set(st.sid, st);
    const head = safe(32 * KIB), final = safe(128 * KIB, 5);
    net._chunk(st, head, { ct: 1 });
    net._chunk(st, final, { ct: 2 });
    await net._finalize({}, st, { timestamp: 3 });

    const out = persisted(records);
    const [marker] = markers(records);
    assert.equal(markers(records).length, 1);
    assert.equal(marker.reason, 'max_stream_bytes');
    assert.equal(marker.cap, CAP);
    assert.equal(marker.bytes, out.length, 'marker reports the exact persisted byte count');
    // Local-raw admits exactly the cap. Filtered admits the cap minus the guard's held tail, which is
    // discarded on truncation as before and reported as withheldBytes (never silently lost).
    const withheld = marker.withheldBytes ?? 0;
    if (mode === 'local-raw') { assert.equal(out.length, CAP); assert.equal(withheld, 0); }
    else { assert.equal(withheld, 128); assert.equal(out.length + withheld, CAP); }
    assert.deepEqual(out, Buffer.concat([head, final]).subarray(0, out.length), 'admitted bytes are a byte-exact prefix');
    const done = records.find((r) => r.k === 'done');
    assert.equal(done.truncated, true);
    assert.equal(out.length + done.droppedByCap, 160 * KIB, 'persisted + dropped equals bytes received');
    assert.equal(records.filter((r) => r.k === 'chunk').every((r) => r.n === Buffer.from(r.b64, 'base64').length), true);
  });

  test(`[${mode}] held arm: pending bytes stay within budget and the overflow is recorded`, async () => {
    const BUDGET = 8 * MIB, CHUNK = 128 * KIB, TOTAL = 64 * MIB;
    const { net, records } = harness(mode, { maxPendingArmBytes: BUDGET, armRetries: 0 });
    let release;
    const held = new Promise((r) => { release = r; });
    const session = { send: async (method) => (method === 'Network.streamResourceContent' ? held : {}) };
    net._onRequest(session, 'p', { requestId: 'r2', request: { url: 'https://example.com/api/feed', method: 'GET', headers: {} }, type: 'XHR', timestamp: 1 }, {});
    const pending = net._onResponse(session, 'p', { requestId: 'r2', type: 'XHR', timestamp: 1,
      response: { status: 200, mimeType: 'application/json', headers: {} } });
    const st = net.reqs.get('p:r2');
    const b64 = safe(CHUNK).toString('base64');
    let peak = 0;
    for (let sent = 0; sent < TOTAL; sent += CHUNK) {
      net._onData('p', { requestId: 'r2', data: b64, timestamp: 2, encodedDataLength: CHUNK });
      peak = Math.max(peak, st.pendingBytes ?? 0);
    }
    assert.ok(peak <= BUDGET, `pending peaked at ${peak}`);
    assert.equal(st.pendingBytes, BUDGET);
    assert.equal(st.pendingOverflow.bytes, TOTAL - BUDGET, 'every byte past the budget is counted, none buffered');

    release({});
    await pending;
    // Bytes that arrive after the arm settles are part of the gap and are not resumed.
    net._onData('p', { requestId: 'r2', data: b64, timestamp: 3, encodedDataLength: CHUNK });
    await net._finalize({}, st, { timestamp: 4 });

    const [marker] = markers(records);
    assert.equal(markers(records).length, 1);
    assert.equal(marker.reason, 'arming_buffer_overflow');
    assert.equal(marker.cap, BUDGET);
    const out = persisted(records);
    assert.equal(marker.bytes, out.length);
    assert.equal(out.length + (marker.withheldBytes ?? 0), BUDGET, 'buffered prefix is written, in order, up to the budget');
    const done = records.find((r) => r.k === 'done');
    assert.equal(done.truncated, true);
    assert.equal(out.length + done.droppedByCap, TOTAL + CHUNK, 'persisted + dropped equals bytes received');
  });

  test(`[${mode}] a stream under the cap is untouched, byte for byte`, async () => {
    const { net, records } = harness(mode, { maxStreamBytes: 64 * KIB });
    const st = { sid: 'p:small', body: true, armed: true, chunks: 0, bytes: 0 };
    net.reqs.set(st.sid, st);
    const src = safe(20 * KIB, 11);
    for (const [a, b] of [[0, 7001], [7001, 14002], [14002, src.length]]) net._chunk(st, src.subarray(a, b), { ct: 1 });
    await net._finalize({}, st, { timestamp: 2 });
    assert.deepEqual(persisted(records), src);
    assert.equal(markers(records).length, 0);
    const done = records.find((r) => r.k === 'done');
    assert.equal(done.truncated, undefined);
    assert.equal(done.droppedByCap, undefined);
    assert.equal(done.bytes, src.length);
  });

  test(`[${mode}] WebSocket frames are never split: the frame that would cross the cap is omitted whole`, () => {
    const { net, records } = harness(mode, { maxStreamBytes: 64 * KIB });
    net.reqs.set('p:ws', { sid: 'p:ws', body: true, ws: true, frames: 0, bytes: 0 });
    const frame = (text) => ({ requestId: 'ws', timestamp: 5, response: { opcode: 1, payloadData: text } });
    net._onWsFrame('p', frame('a'.repeat(40 * KIB)), 'in');
    net._onWsFrame('p', frame('b'.repeat(40 * KIB)), 'in');
    net._onWsFrame('p', frame('c'.repeat(1 * KIB)), 'in');
    const [marker] = markers(records);
    assert.equal(markers(records).length, 1);
    assert.equal(marker.cap, 64 * KIB);
    const admittedFrames = records.filter((r) => r.k === 'ws.frame');
    const omitted = records.filter((r) => r.k === 'ws.frame_meta' && r.droppedByCap === true);
    assert.equal(omitted.length, 2, 'the crossing frame and the later frame are recorded as omitted');
    if (mode === 'local-raw') {
      assert.equal(admittedFrames.length, 1);
      assert.equal(admittedFrames[0].payload.length, 40 * KIB);
      assert.equal(marker.bytes, 40 * KIB);
    } else {
      // Filtered holds a frame until later bytes arrive; a truncation discards it as metadata, and the
      // marker reports it as withheldBytes instead of counting it as persisted.
      assert.equal(admittedFrames.length, 0);
      assert.equal(marker.bytes + (marker.withheldBytes ?? 0), 40 * KIB);
    }
  });
}
