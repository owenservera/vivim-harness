// Unit tests for Connect / gRPC frame decoding of protobuf bodies and compressed frames
// (GrpcFrameDecoder in src/decode/decoders.mjs). Fully synthetic fixtures built by a tiny encoder.
// Assertions are by property; no real capture data is used.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { GrpcFrameDecoder, pickAutoDecoder } from '../../src/decode/decoders.mjs';

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
// Strings start with 'l' (0x6c = field 13, wire type 4 = group), so they never parse as messages.
const str = (no, s) => ld(no, Buffer.from(s, 'utf8'));
const msg = (no, ...parts) => ld(no, cat(...parts));
// Connect / gRPC-web envelope: flag byte + 4-byte big-endian length + payload.
function frame(flags, payload) {
  const p = Buffer.from(payload);
  const h = Buffer.alloc(5);
  h[0] = flags;
  h.writeUInt32BE(p.length, 1);
  return Buffer.concat([h, p]);
}

const MIME = 'application/connect+proto';
// Two top-level fields: a string (path 1) and a message with a string and a varint (path 2).
const BODY = cat(str(1, 'lorem-ipsum-title'), msg(2, str(1, 'lalpha-model-name'), vint(2, 7)));
const BODY_STRINGS = [
  { path: '1', text: 'lorem-ipsum-title' },
  { path: '2.1', text: 'lalpha-model-name' },
];

function decodeAll(mime, buf, opts = {}) {
  const d = new GrpcFrameDecoder({ mime, ...opts });
  return [...d.push(buf), ...d.end()];
}
const dataFrames = (evs) => evs.filter((e) => e.type === 'grpc.frame');
const strip = (evs) => evs.map((e) => {
  const o = { ...e };
  for (const k of ['sid', 'seq', 't', 'layer', 'n']) delete o[k];
  return o;
});

// ---------------------------------------------------------------------------------------------
// Uncompressed protobuf frames
// ---------------------------------------------------------------------------------------------
test('uncompressed protobuf frame: string fields appear in proto.strings with correct paths', () => {
  const [ev] = dataFrames(decodeAll(MIME, frame(0x00, BODY)));
  assert.equal(ev.compressed, false);
  assert.equal('compression' in ev, false, 'uncompressed frames carry no compression field');
  assert.equal(ev.proto.ok, true);
  assert.deepEqual(ev.proto.strings, BODY_STRINGS);
  assert.equal(ev.proto.fieldCount, 4);
  assert.equal(ev.proto.truncated, false);
});

// ---------------------------------------------------------------------------------------------
// Compressed frames
// ---------------------------------------------------------------------------------------------
test('gzip-compressed frame is inflated, labelled gzip and decoded from the inflated bytes', () => {
  const [ev] = dataFrames(decodeAll(MIME, frame(0x01, zlib.gzipSync(BODY))));
  assert.equal(ev.compressed, true);
  assert.equal(ev.compression, 'gzip');
  assert.equal(ev.size, zlib.gzipSync(BODY).length, 'size stays the wire (compressed) length');
  assert.equal(ev.proto.ok, true);
  assert.deepEqual(ev.proto.strings, BODY_STRINGS);
});

test('zlib (deflate) and raw deflate compressed frames get their own method labels', () => {
  const [d] = dataFrames(decodeAll(MIME, frame(0x01, zlib.deflateSync(BODY))));
  assert.equal(d.compression, 'deflate');
  assert.deepEqual(d.proto.strings, BODY_STRINGS);
  const [r] = dataFrames(decodeAll(MIME, frame(0x01, zlib.deflateRawSync(BODY))));
  assert.equal(r.compression, 'deflate-raw');
  assert.deepEqual(r.proto.strings, BODY_STRINGS);
});

test('undecodable compressed frame: compression undecodable, proto undecodable, no throw', () => {
  const junk = Buffer.from('not compressed at all', 'utf8');
  const truncatedGzip = zlib.gzipSync(BODY).subarray(0, 12);
  for (const payload of [junk, truncatedGzip, Buffer.alloc(0)]) {
    let evs;
    assert.doesNotThrow(() => { evs = decodeAll(MIME, frame(0x01, payload)); });
    const [ev] = dataFrames(evs);
    assert.equal(ev.compression, 'undecodable');
    assert.deepEqual(ev.proto, { ok: false, reason: 'undecodable' });
  }
});

// ---------------------------------------------------------------------------------------------
// Non-protobuf JSON frames keep their handling
// ---------------------------------------------------------------------------------------------
test('end-stream JSON trailer frame (0x02) keeps its previous event shape exactly', () => {
  const payload = Buffer.from('{"error":{"code":"unknown"}}', 'utf8');
  const expected = [{
    type: 'grpc.frame', compressed: false, size: payload.length,
    span: [0, 5 + payload.length], index: 0, json: { error: { code: 'unknown' } },
  }];
  assert.deepStrictEqual(decodeAll(MIME, frame(0x02, payload)), expected);
  assert.deepStrictEqual(decodeAll('application/grpc+proto', frame(0x02, payload)), expected);
});

test('a JSON payload on a non-proto mime is not protobuf-decoded', () => {
  const [ev] = dataFrames(decodeAll('application/connect+json', frame(0x00, '{"a":1}')));
  assert.deepEqual(ev.json, { a: 1 });
  assert.equal('proto' in ev, false);
});

test('a JSON-looking payload on a proto mime is decoded as protobuf (mime wins)', () => {
  const [ev] = dataFrames(decodeAll('application/grpc+proto', frame(0x00, '{"a":1}')));
  assert.equal(ev.proto.ok, false);
  assert.equal(ev.proto.reason, 'group-wire-type');
});

// ---------------------------------------------------------------------------------------------
// Chunk boundaries
// ---------------------------------------------------------------------------------------------
test('chunk boundaries at every byte position give the same events as a whole-buffer decode', () => {
  const stream = cat(
    frame(0x00, BODY),
    frame(0x01, zlib.gzipSync(BODY)),
    frame(0x01, zlib.deflateSync(BODY)),
    frame(0x80, Buffer.from('grpc-status: 0\r\n', 'utf8')),
    frame(0x02, Buffer.from('{}', 'utf8')),
  );
  const want = strip(decodeAll(MIME, stream));
  assert.equal(want.length, 5);
  for (let k = 0; k <= stream.length; k++) {
    const d = new GrpcFrameDecoder({ mime: MIME });
    const got = [...d.push(stream.subarray(0, k)), ...d.push(stream.subarray(k)), ...d.end()];
    assert.deepStrictEqual(strip(got), want, `split at ${k}`);
  }
});

test('byte-at-a-time feeding gives the same events as a whole-buffer decode', () => {
  const stream = cat(frame(0x01, zlib.gzipSync(BODY)), frame(0x00, BODY));
  const want = strip(decodeAll(MIME, stream));
  const d = new GrpcFrameDecoder({ mime: MIME });
  const got = [];
  for (let i = 0; i < stream.length; i++) got.push(...d.push(stream.subarray(i, i + 1)));
  got.push(...d.end());
  assert.deepStrictEqual(strip(got), want);
});

// ---------------------------------------------------------------------------------------------
// Live cap (jsonMaxBytes) and derive (no cap)
// ---------------------------------------------------------------------------------------------
test('inflated payload above the live cap yields proto oversize with no strings', () => {
  const big = str(1, 'l' + 'x'.repeat(200));
  const gz = decodeAll(MIME, frame(0x01, zlib.gzipSync(big)), { jsonMaxBytes: 64 });
  const [ev] = dataFrames(gz);
  assert.equal(ev.compression, 'gzip');
  assert.deepStrictEqual(ev.proto, { ok: false, reason: 'oversize' });

  const [raw] = dataFrames(decodeAll(MIME, frame(0x00, big), { jsonMaxBytes: 64 }));
  assert.deepStrictEqual(raw.proto, { ok: false, reason: 'oversize' });
});

test('derive (no cap) decodes the same oversize frame fully', () => {
  const big = str(1, 'l' + 'x'.repeat(200));
  const [ev] = dataFrames(decodeAll(MIME, frame(0x01, zlib.gzipSync(big))));
  assert.equal(ev.proto.ok, true);
  assert.equal(ev.proto.strings.length, 1);
  assert.equal(ev.proto.strings[0].text.length, 201);
  assert.equal(ev.proto.truncated, false);
});

test('the live cap reaches the frame decoder through pickAutoDecoder', () => {
  const dec = pickAutoDecoder(MIME, undefined, { jsonMaxBytes: 64 });
  const evs = [...dec.push(frame(0x00, str(1, 'l' + 'y'.repeat(200)))), ...dec.end()];
  const [ev] = dataFrames(evs);
  assert.deepStrictEqual(ev.proto, { ok: false, reason: 'oversize' });
});

// ---------------------------------------------------------------------------------------------
// Per-event caps: strings count and string length
// ---------------------------------------------------------------------------------------------
test('more than 64 strings are capped at 64 with truncated true', () => {
  const body = cat(...Array.from({ length: 70 }, (_, i) => str(1, `l${i} entry`)));
  const [ev] = dataFrames(decodeAll(MIME, frame(0x00, body)));
  assert.equal(ev.proto.ok, true);
  assert.equal(ev.proto.fieldCount, 70);
  assert.equal(ev.proto.strings.length, 64);
  assert.equal(ev.proto.strings[0].path, '1[0]');
  assert.equal(ev.proto.strings[63].path, '1[63]');
  assert.equal(ev.proto.truncated, true);
});

test('a string longer than 4000 characters is cut to 4000 with truncated true', () => {
  const long = 'l' + 'orem ipsum '.repeat(400);
  const [ev] = dataFrames(decodeAll(MIME, frame(0x00, str(1, long))));
  assert.equal(ev.proto.ok, true);
  assert.equal(ev.proto.strings.length, 1);
  assert.equal(Array.from(ev.proto.strings[0].text).length, 4000);
  assert.equal(ev.proto.strings[0].text, long.slice(0, 4000));
  assert.equal(ev.proto.truncated, true);
});

test('a string of exactly 4000 characters is not truncated', () => {
  const exact = 'l' + 'a'.repeat(3999);
  const [ev] = dataFrames(decodeAll(MIME, frame(0x00, str(1, exact))));
  assert.equal(ev.proto.strings[0].text.length, 4000);
  assert.equal(ev.proto.truncated, false);
});

// ---------------------------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------------------------
test('determinism: the same stream decodes to deep-equal events on every run', () => {
  const stream = cat(frame(0x01, zlib.gzipSync(BODY)), frame(0x00, BODY), frame(0x02, '{}'));
  assert.deepStrictEqual(decodeAll(MIME, stream), decodeAll(MIME, stream));
});

test('classifyMime routes Connect streaming content types to the envelope decoder without byte sniffing', async () => {
  const { classifyMime } = await import('../../src/decode/decoders.mjs');
  assert.equal(classifyMime('application/connect+proto'), 'grpc');
  assert.equal(classifyMime('application/connect+json'), 'grpc');
  assert.equal(classifyMime('application/grpc-web+proto'), 'grpc');
  // unrelated types are unaffected
  assert.notEqual(classifyMime('application/json'), 'grpc');
  assert.notEqual(classifyMime('text/event-stream'), 'grpc');
});
