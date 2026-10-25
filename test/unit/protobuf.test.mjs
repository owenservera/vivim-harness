// Unit tests for src/decode/protobuf.mjs. Fully synthetic fixtures built by a tiny encoder below.
// Assertions are by property; no real capture data is used.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import {
  splitEnvelopes,
  decodeProtobuf,
  flattenProtobuf,
  protoStrings,
  describeProtobuf,
} from '../../src/decode/protobuf.mjs';

// ---------------------------------------------------------------------------------------------
// Minimal encoder (test-only)
// ---------------------------------------------------------------------------------------------
function vbytes(n) {
  let x = BigInt(n);
  const out = [];
  do {
    let b = Number(x & 0x7fn);
    x >>= 7n;
    if (x) b |= 0x80;
    out.push(b);
  } while (x);
  return Buffer.from(out);
}
const cat = (...parts) => Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p))));
const tag = (no, wt) => vbytes((BigInt(no) << 3n) | BigInt(wt));
const vint = (no, v) => cat(tag(no, 0), vbytes(v));
const ld = (no, payload) => {
  const p = Buffer.from(payload);
  return cat(tag(no, 2), vbytes(p.length), p);
};
const str = (no, s) => ld(no, Buffer.from(s, 'utf8'));
const msg = (no, ...parts) => ld(no, cat(...parts));
function fixed32(no, n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return cat(tag(no, 5), b);
}
function fixed64(no, big) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(big);
  return cat(tag(no, 1), b);
}
// Connect / gRPC-web envelope: flag byte + 4-byte big-endian length + payload.
function frame(flags, payload) {
  const p = Buffer.from(payload);
  const h = Buffer.alloc(5);
  h[0] = flags;
  h.writeUInt32BE(p.length, 1);
  return Buffer.concat([h, p]);
}
const summ = (f) => ({
  flags: f.flags,
  length: f.length,
  payloadHex: f.payload.toString('hex'),
  compressed: f.compressed,
  endStream: f.endStream,
  trailers: f.trailers,
});

// ---------------------------------------------------------------------------------------------
// Varints
// ---------------------------------------------------------------------------------------------
test('varint round trip: 0, 1, 127, 128, 300, 2^53, 2^63-1 as lossless decimal strings', () => {
  const cases = [0n, 1n, 127n, 128n, 300n, 2n ** 53n, 2n ** 63n - 1n];
  for (const v of cases) {
    const r = decodeProtobuf(vint(1, v));
    assert.equal(r.ok, true, `ok for ${v}`);
    assert.equal(r.tree.length, 1);
    assert.equal(r.tree[0].no, 1);
    assert.equal(r.tree[0].wt, 0);
    assert.equal(r.tree[0].kind, 'varint');
    assert.equal(r.tree[0].value, v.toString());
  }
  assert.equal(decodeProtobuf(vint(1, 2n ** 53n)).tree[0].value, '9007199254740992');
});

test('varint: 11-byte continuation and values >= 2^64 are rejected', () => {
  const over = cat(tag(1, 0), Buffer.alloc(10, 0xff), Buffer.from([0x01]));
  const r = decodeProtobuf(over);
  assert.equal(r.ok, false);
  assert.match(r.reason, /varint/);
});

// ---------------------------------------------------------------------------------------------
// Strings
// ---------------------------------------------------------------------------------------------
test('string round trip: ASCII, multi-byte UTF-8 and emoji', () => {
  const cases = ['hello world', 'caf\u00e9 \u4e2d\u6587', '\u{1F600} ok'];
  for (const s of cases) {
    const r = decodeProtobuf(str(1, s));
    assert.equal(r.ok, true);
    assert.equal(r.tree[0].kind, 'string', `kind for ${JSON.stringify(s)}`);
    assert.equal(r.tree[0].value, s);
    assert.equal(r.tree[0].ambiguous, undefined);
  }
});

// ---------------------------------------------------------------------------------------------
// Nested messages, repeats, fixed, bytes
// ---------------------------------------------------------------------------------------------
test('nested messages 3 deep are decoded as message, message, varint', () => {
  const leaf = vint(1, 42);
  const mid = msg(2, leaf);
  const top = msg(3, mid);
  const r = decodeProtobuf(top);
  assert.equal(r.ok, true);
  const flat = flattenProtobuf(r.tree);
  assert.deepEqual(flat.map((e) => e.path), ['3', '3.2', '3.2.1']);
  assert.deepEqual(flat.map((e) => e.kind), ['message', 'message', 'varint']);
  assert.equal(flat[2].value, '42');
});

test('repeated field numbers at the same level get [i] indexes in paths', () => {
  const buf = cat(msg(3, vint(2, 10)), msg(3, vint(2, 20)), vint(1, 5));
  const r = decodeProtobuf(buf);
  assert.equal(r.ok, true);
  const flat = flattenProtobuf(r.tree);
  assert.deepEqual(flat.map((e) => e.path), ['3[0]', '3[0].2', '3[1]', '3[1].2', '1']);
  assert.equal(flat[1].value, '10');
  assert.equal(flat[3].value, '20');
  assert.equal(flat[4].value, '5');
});

test('fixed32 and fixed64 decode to unsigned little-endian hex', () => {
  const r = decodeProtobuf(cat(fixed32(1, 0x12345678), fixed64(2, 0x0102030405060708n)));
  assert.equal(r.ok, true);
  assert.equal(r.tree[0].kind, 'fixed32');
  assert.equal(r.tree[0].wt, 5);
  assert.equal(r.tree[0].value, '12345678');
  assert.equal(r.tree[1].kind, 'fixed64');
  assert.equal(r.tree[1].wt, 1);
  assert.equal(r.tree[1].value, '0102030405060708');
});

test('bytes that are not UTF-8 and do not parse as a message stay bytes with len and head', () => {
  const r = decodeProtobuf(ld(4, [0xff, 0xfe, 0x00, 0x80]));
  assert.equal(r.ok, true);
  assert.equal(r.tree[0].kind, 'bytes');
  assert.equal(r.tree[0].len, 4);
  assert.equal(r.tree[0].head, 'fffe0080');
  assert.equal(r.tree[0].value, undefined);
});

test('an empty length-delimited field is bytes with len 0', () => {
  const r = decodeProtobuf(ld(4, []));
  assert.equal(r.ok, true);
  assert.equal(r.tree[0].kind, 'bytes');
  assert.equal(r.tree[0].len, 0);
});

test('a group nested inside a length-delimited payload is absorbed as bytes, not a decode failure', () => {
  const r = decodeProtobuf(ld(1, [0x0b]));
  assert.equal(r.ok, true);
  assert.equal(r.tree[0].kind, 'bytes');
});

test('ambiguous: valid printable text that also parses as a one-field message is kept as string and flagged', () => {
  const r = decodeProtobuf(str(1, 'hi'));
  assert.equal(r.ok, true);
  assert.equal(r.tree[0].kind, 'string');
  assert.equal(r.tree[0].value, 'hi');
  assert.equal(r.tree[0].ambiguous, true);
  const flat = flattenProtobuf(r.tree);
  assert.equal(flat[0].ambiguous, true);
});

// ---------------------------------------------------------------------------------------------
// Rejections and truncation
// ---------------------------------------------------------------------------------------------
test('group wire types 3 and 4 at top level are rejected; wire type 6 is invalid', () => {
  assert.equal(decodeProtobuf(Buffer.from([0x0b])).reason, 'group-wire-type');
  assert.equal(decodeProtobuf(Buffer.from([0x0c])).reason, 'group-wire-type');
  assert.equal(decodeProtobuf(Buffer.from([0x0e])).reason, 'invalid-wire-type');
  assert.equal(decodeProtobuf(Buffer.from([0x0b])).ok, false);
});

test('truncated buffer returns ok false, a reason and the fields decoded so far in partial', () => {
  const full = cat(vint(1, 300n), str(2, 'hello'));
  const r = decodeProtobuf(full.subarray(0, full.length - 2));
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'length-beyond-buffer');
  assert.equal(r.tree, null);
  assert.equal(r.partial.length, 1);
  assert.equal(r.partial[0].no, 1);
  assert.equal(r.partial[0].value, '300');
});

test('truncated varint and truncated fixed64 are reported with reasons', () => {
  const v = decodeProtobuf(Buffer.from([0x08, 0x80]));
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'truncated-varint');
  assert.deepEqual(v.partial, []);
  const f = decodeProtobuf(cat(tag(1, 1), Buffer.from([1, 2, 3])));
  assert.equal(f.ok, false);
  assert.equal(f.reason, 'truncated-fixed64');
});

test('length beyond buffer end is rejected', () => {
  const r = decodeProtobuf(Buffer.from([0x0a, 0x7f]));
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'length-beyond-buffer');
});

test('field number 0 is invalid, and so is a field number above 2^29-1', () => {
  const zero = decodeProtobuf(Buffer.from([0x00, 0x01]));
  assert.equal(zero.ok, false);
  assert.equal(zero.reason, 'bad-field-number');
  assert.deepEqual(zero.partial, []);
  const big = decodeProtobuf(vbytes((536870912n << 3n) | 0n));
  assert.equal(big.ok, false);
  assert.equal(big.reason, 'bad-field-number');
});

test('depth cap: messages beyond maxDepth fall back to bytes instead of recursing', () => {
  const buf = msg(3, msg(2, vint(1, 42)));
  const deep = decodeProtobuf(buf);
  assert.deepEqual(flattenProtobuf(deep.tree).map((e) => e.path), ['3', '3.2', '3.2.1']);
  const capped = decodeProtobuf(buf, { maxDepth: 2 });
  assert.equal(capped.ok, true);
  const flat = flattenProtobuf(capped.tree);
  assert.deepEqual(flat.map((e) => e.path), ['3', '3.2']);
  assert.equal(flat[1].kind, 'bytes');
});

test('hostile deep nesting (2000 levels) is bounded by maxDepth and does not blow the stack', () => {
  let x = Buffer.alloc(0);
  for (let i = 0; i < 2000; i++) x = ld(1, x);
  const r = decodeProtobuf(x);
  assert.equal(r.ok, true);
  assert.ok(r.stats.depth <= 6, `depth ${r.stats.depth}`);
});

test('maxFields cap aborts with reason max-fields and keeps the fields decoded so far', () => {
  const buf = cat(...Array.from({ length: 50 }, (_, i) => vint(1, i)));
  assert.equal(decodeProtobuf(buf).ok, true);
  assert.equal(decodeProtobuf(buf).tree.length, 50);
  const capped = decodeProtobuf(buf, { maxFields: 10 });
  assert.equal(capped.ok, false);
  assert.equal(capped.reason, 'max-fields');
  assert.equal(capped.partial.length, 10);
});

// ---------------------------------------------------------------------------------------------
// Envelopes
// ---------------------------------------------------------------------------------------------
test('envelope flags: compressed 0x01, endStream 0x02, trailers 0x80; unknown bits rejected', () => {
  const c = splitEnvelopes(frame(0x01, 'a')).frames[0];
  assert.equal(c.compressed, true);
  assert.equal(c.endStream, false);
  assert.equal(c.trailers, false);
  const e = splitEnvelopes(frame(0x02, 'a')).frames[0];
  assert.equal(e.endStream, true);
  assert.equal(e.compressed, false);
  const t = splitEnvelopes(frame(0x80, 'a')).frames[0];
  assert.equal(t.trailers, true);
  const all = splitEnvelopes(frame(0x83, 'a')).frames[0];
  assert.equal(all.compressed && all.endStream && all.trailers, true);
  const bad = splitEnvelopes(frame(0x04, 'a'));
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'unknown-flags');
});

test('partial trailing envelope is reported incomplete and not consumed', () => {
  const stream = cat(frame(0x00, 'abc'), Buffer.from([0x00, 0x00, 0x00, 0x00, 0x09, 0x01]));
  const r = splitEnvelopes(stream);
  assert.equal(r.ok, true);
  assert.equal(r.frames.length, 2);
  assert.equal(r.frames[0].complete, true);
  const inc = r.frames[1];
  assert.equal(inc.complete, false);
  assert.equal(inc.payload, null);
  assert.equal(inc.length, 9);
  assert.equal(inc.have, 1);
  assert.equal(r.consumed, 8);
  assert.equal(r.leftover.length, 6);
});

test('a header with fewer than 5 bytes yields no frame and is left over', () => {
  const r = splitEnvelopes(Buffer.from([0x00, 0x00]));
  assert.equal(r.ok, true);
  assert.equal(r.frames.length, 0);
  assert.equal(r.consumed, 0);
  assert.equal(r.leftover.length, 2);
});

test('oversize length header is rejected before any allocation (default cap and custom cap)', () => {
  const huge = Buffer.from([0x00, 0xff, 0xff, 0xff, 0xff]);
  const r = splitEnvelopes(huge);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'frame-too-large');
  assert.equal(r.frames.length, 0);
  assert.equal(splitEnvelopes(frame(0x00, 'hello'), { maxFrameBytes: 4 }).reason, 'frame-too-large');
  assert.equal(splitEnvelopes(frame(0x00, 'hello'), { maxFrameBytes: 5 }).ok, true);
});

test('a Connect stream split at every byte boundary reassembles to the whole-buffer frames', () => {
  const stream = cat(
    frame(0x00, vint(1, 7)),
    frame(0x01, Buffer.from([0x1f, 0x8b, 0x08, 0x00])),
    frame(0x80, Buffer.from('grpc-status: 0\r\n', 'utf8')),
    frame(0x02, Buffer.from('{}', 'utf8')),
  );
  const whole = splitEnvelopes(stream);
  assert.equal(whole.ok, true);
  assert.equal(whole.consumed, stream.length);
  assert.equal(whole.leftover.length, 0);
  assert.equal(whole.frames.length, 4);
  const want = whole.frames.map(summ);
  for (let k = 0; k <= stream.length; k++) {
    const r1 = splitEnvelopes(stream.subarray(0, k));
    assert.equal(r1.ok, true, `part1 ok at ${k}`);
    const r2 = splitEnvelopes(Buffer.concat([r1.leftover, stream.subarray(k)]));
    assert.equal(r2.ok, true, `part2 ok at ${k}`);
    assert.equal(r2.frames.every((f) => f.complete), true, `no partial tail at ${k}`);
    const got = [...r1.frames, ...r2.frames].filter((f) => f.complete).map(summ);
    assert.deepEqual(got, want, `frames equal at split ${k}`);
  }
});

test('byte-at-a-time feeding reassembles the same frames', () => {
  const stream = cat(frame(0x00, 'one'), frame(0x80, 'two'), frame(0x00, ''));
  const want = splitEnvelopes(stream).frames.map(summ);
  let carry = Buffer.alloc(0);
  const got = [];
  for (let i = 0; i < stream.length; i++) {
    carry = Buffer.concat([carry, stream.subarray(i, i + 1)]);
    const r = splitEnvelopes(carry);
    assert.equal(r.ok, true);
    for (const f of r.frames) if (f.complete) got.push(summ(f));
    carry = Buffer.from(r.leftover);
  }
  assert.deepEqual(got, want);
  assert.equal(carry.length, 0);
});

// ---------------------------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------------------------
test('protoStrings returns string leaves in document order with paths, and honours minChars', () => {
  const buf = cat(str(1, 'alpha'), msg(2, str(1, 'beta')), str(1, 'gamma'));
  const r = decodeProtobuf(buf);
  assert.equal(r.ok, true);
  assert.deepEqual(protoStrings(r.tree), [
    { path: '1[0]', text: 'alpha' },
    { path: '2.1', text: 'beta' },
    { path: '1[1]', text: 'gamma' },
  ]);
  assert.deepEqual(protoStrings(r.tree, { minChars: 5 }).map((s) => s.text), ['alpha', 'gamma']);
});

test('describeProtobuf reports shape (index-free path, kind, count) and never leaks values', () => {
  const buf = cat(str(1, 'alpha'), msg(2, str(1, 'beta')), str(1, 'gamma'), vint(9, 123456789n));
  const r = decodeProtobuf(buf);
  const shape = describeProtobuf(r.tree);
  assert.deepEqual(shape.find((s) => s.path === '1' && s.kind === 'string'), { path: '1', kind: 'string', count: 2 });
  assert.deepEqual(shape.find((s) => s.path === '2' && s.kind === 'message'), { path: '2', kind: 'message', count: 1 });
  assert.deepEqual(shape.find((s) => s.path === '2.1'), { path: '2.1', kind: 'string', count: 1 });
  const text = JSON.stringify(shape);
  for (const secret of ['alpha', 'beta', 'gamma', '123456789']) assert.equal(text.includes(secret), false);
  for (const s of shape) assert.deepEqual(Object.keys(s).sort(), ['count', 'kind', 'path']);
});

test('flattenProtobuf exposes value for scalars, len for bytes, and no value for messages', () => {
  const r = decodeProtobuf(cat(msg(1, vint(2, 5)), ld(3, [0xff, 0xfe])));
  const flat = flattenProtobuf(r.tree);
  assert.deepEqual(flat[0], { path: '1', wt: 2, kind: 'message' });
  assert.deepEqual(flat[1], { path: '1.2', wt: 0, kind: 'varint', value: '5' });
  assert.deepEqual(flat[2], { path: '3', wt: 2, kind: 'bytes', len: 2 });
});

// ---------------------------------------------------------------------------------------------
// Determinism and bounded fuzz
// ---------------------------------------------------------------------------------------------
test('determinism: same input gives deep-equal output across decode, flatten and split', () => {
  const buf = cat(msg(3, vint(2, 10)), msg(3, vint(2, 20)), str(1, 'hi'), fixed32(4, 9));
  assert.deepEqual(decodeProtobuf(buf), decodeProtobuf(buf));
  const tree = decodeProtobuf(buf).tree;
  assert.deepEqual(flattenProtobuf(tree), flattenProtobuf(tree));
  const env = cat(frame(0x00, buf), frame(0x02, '{}'));
  assert.deepEqual(splitEnvelopes(env), splitEnvelopes(env));
});

function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('bounded fuzz: 2000 seeded random buffers never throw and the loop finishes in under 3 seconds', () => {
  const rnd = prng(0x5eed1234);
  const t0 = performance.now();
  let decodedOk = 0;
  let envOk = 0;
  for (let i = 0; i < 2000; i++) {
    const n = Math.floor(rnd() * 256);
    const b = Buffer.alloc(n);
    const printable = rnd() < 0.5;
    for (let j = 0; j < n; j++) {
      b[j] = printable ? 0x20 + Math.floor(rnd() * 95) : Math.floor(rnd() * 256);
    }
    const r = decodeProtobuf(b);
    assert.equal(typeof r.ok, 'boolean');
    describeProtobuf(r.ok ? r.tree : r.partial);
    if (r.ok) decodedOk++;
    const s = splitEnvelopes(b);
    assert.equal(typeof s.ok, 'boolean');
    if (s.ok) envOk++;
  }
  const elapsed = performance.now() - t0;
  assert.ok(decodedOk + envOk > 0, 'fuzz exercised at least one successful decode or split');
  assert.ok(elapsed < 3000, `fuzz took ${elapsed.toFixed(1)} ms`);
});
