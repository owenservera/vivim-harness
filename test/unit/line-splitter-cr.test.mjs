// RF-1: CR-terminated line spans must be identical whether a stream is decoded whole or chunked.
// A CR that ends a chunk is held until the next byte (LF or not) or end-of-stream (finish()).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LineSplitter, SseDecoder, NdjsonDecoder } from '../../src/decode/decoders.mjs';

const b = (s) => Buffer.from(s, 'latin1');   // ASCII-only fixtures

function plain(lines) {
  return lines.map((l) => ({ t: l.line.toString('latin1'), s: l.start, e: l.end }));
}

// Full line-splitter output for a chunk sequence: pushed lines, then finish(), then any rest().
function splitLines(chunks) {
  const ls = new LineSplitter();
  const out = [];
  for (const c of chunks) out.push(...plain(ls.push(c)));
  out.push(...plain(ls.finish()));
  const r = ls.rest();
  return { lines: out, rest: r ? { t: r.line.toString('latin1'), s: r.start, e: r.end } : null };
}

function allSplits(buf) {
  const sets = [];
  for (let i = 0; i <= buf.length; i++) sets.push({ name: `split@${i}`, chunks: [buf.subarray(0, i), buf.subarray(i)] });
  sets.push({ name: 'one-byte', chunks: [...buf].map((x) => Buffer.from([x])) });
  return sets;
}

function sseRun(chunks) {
  const d = new SseDecoder();
  const evs = [];
  for (const c of chunks) evs.push(...d.push(c));
  evs.push(...d.end());
  return evs;
}

function ndjsonRun(chunks) {
  const d = new NdjsonDecoder();
  const evs = [];
  for (const c of chunks) evs.push(...d.push(c));
  evs.push(...d.end());
  return evs;
}

// (1) CRLF stream: every split point and 1-byte chunks match the whole-buffer result.
test('LineSplitter: CRLF stream gives identical lines and spans at every split point', () => {
  const buf = b('alpha\r\nbeta\r\n\r\ngamma\r\n');
  const whole = splitLines([buf]);
  assert.deepEqual(whole.lines, [
    { t: 'alpha', s: 0, e: 7 },
    { t: 'beta', s: 7, e: 13 },
    { t: '', s: 13, e: 15 },
    { t: 'gamma', s: 15, e: 22 },
  ]);
  assert.equal(whole.rest, null);
  for (const { name, chunks } of allSplits(buf)) assert.deepEqual(splitLines(chunks), whole, name);
});

// (2) A lone CR at the very end of the stream is held, then emitted by finish() with its exact span.
test('LineSplitter: lone CR at end of stream is emitted by finish() with the right span', () => {
  const ls = new LineSplitter();
  assert.deepEqual(ls.push(b('ab\r')), []);
  assert.deepEqual(plain(ls.finish()), [{ t: 'ab', s: 0, e: 3 }]);
  assert.deepEqual(ls.finish(), []);

  const ls2 = new LineSplitter();
  assert.deepEqual(plain(ls2.push(b('x\ny\r'))), [{ t: 'x', s: 0, e: 2 }]);
  assert.deepEqual(plain(ls2.finish()), [{ t: 'y', s: 2, e: 4 }]);

  // Held CR followed by LF in the next chunk: the LF is part of the same line span.
  const ls3 = new LineSplitter();
  assert.deepEqual(ls3.push(b('ab\r')), []);
  assert.deepEqual(plain(ls3.push(b('\ncd'))), [{ t: 'ab', s: 0, e: 4 }]);
  assert.deepEqual(splitLines([b('ab\r'), b('\ncd')]).lines, [{ t: 'ab', s: 0, e: 4 }]);
});

// (3) CR CR, CR followed by non-LF, and LF-only streams behave correctly at every split.
test('LineSplitter: CR CR, CR+non-LF and LF-only streams match whole-buffer at every split', () => {
  const cases = [
    'a\r\rb\rc\nd\n\ne',
    'x\r\r',
    'p\nq\n\nr\n',
    '\r',
    '\r\r\n\r\n',
  ];
  for (const src of cases) {
    const buf = b(src);
    const whole = splitLines([buf]);
    for (const { name, chunks } of allSplits(buf)) assert.deepEqual(splitLines(chunks), whole, `${src} ${name}`);
  }
  assert.deepEqual(splitLines([b('a\r\rb\rc\nd\n\ne')]), {
    lines: [
      { t: 'a', s: 0, e: 2 },
      { t: '', s: 2, e: 3 },
      { t: 'b', s: 3, e: 5 },
      { t: 'c', s: 5, e: 7 },
      { t: 'd', s: 7, e: 9 },
      { t: '', s: 9, e: 10 },
    ],
    rest: { t: 'e', s: 10, e: 11 },
  });
  assert.deepEqual(splitLines([b('x\r\r')]).lines, [{ t: 'x', s: 0, e: 2 }, { t: '', s: 2, e: 3 }]);
  assert.deepEqual(splitLines([b('p\nq\n\nr\n')]).lines, [
    { t: 'p', s: 0, e: 2 }, { t: 'q', s: 2, e: 4 }, { t: '', s: 4, e: 5 }, { t: 'r', s: 5, e: 7 },
  ]);
});

// (4) SSE stream with comments and ids; events dispatched by a blank CRLF line split across chunks.
const SSE_SRC = ': keepalive\r\nid: 7\r\nevent: tick\r\ndata: {"n":1}\r\n\r\n: c2\r\nid: 8\r\ndata: x\r\n\r\n';

test('SseDecoder: comments, ids and CRLF dispatch give identical event spans chunked vs whole', () => {
  const buf = b(SSE_SRC);
  const whole = sseRun([buf]);
  assert.equal(whole.length, 2);
  assert.equal(whole[0].event, 'tick');
  assert.equal(whole[0].id, '7');
  assert.deepEqual(whole[0].comments, ['keepalive']);
  assert.deepEqual(whole[0].span, [0, 50]);
  assert.equal(whole[1].id, '8');
  assert.equal(whole[1].data, 'x');
  assert.deepEqual(whole[1].span, [50, buf.length]);
  for (const { name, chunks } of allSplits(buf)) assert.deepEqual(sseRun(chunks), whole, name);
});

// (5) A chunk ending in CR does not lose the final event at end of stream.
test('SseDecoder: chunk ending in CR keeps the final event through end()', () => {
  const d = new SseDecoder();
  assert.deepEqual(d.push(b('data: final\r\n\r')), []);
  const evs = d.end();
  assert.equal(evs.length, 1);
  assert.equal(evs[0].data, 'final');
  assert.deepEqual(evs[0].span, [0, 14]);
  assert.equal(evs[0].incomplete, undefined);
  assert.deepEqual(sseRun([b('data: final\r\n\r')]), sseRun([b('data: final\r\n'), b('\r')]));

  const two = b('data: 1\r\n\r\ndata: 2\r');
  const whole = sseRun([two]);
  assert.equal(whole.length, 2);
  assert.deepEqual(whole[0].span, [0, 11]);
  assert.equal(whole[1].data, '2');
  assert.deepEqual(whole[1].span, [11, 19]);
  assert.equal(whole[1].incomplete, true);
  for (const { name, chunks } of allSplits(two)) assert.deepEqual(sseRun(chunks), whole, name);

  const noBlank = b('data: final\r');
  const w2 = sseRun([noBlank]);
  assert.equal(w2.length, 1);
  assert.deepEqual(w2[0].span, [0, 12]);
  assert.equal(w2[0].incomplete, true);
  for (const { name, chunks } of allSplits(noBlank)) assert.deepEqual(sseRun(chunks), w2, name);
});

// NDJSON shares LineSplitter: a CR-terminated final record must be emitted by end() with its span.
test('NdjsonDecoder: CR-terminated final record is emitted by end() and chunking is invariant', () => {
  const buf = b('{"a":1}\r\n{"b":2}\r\n{"c":3}\r');
  const whole = ndjsonRun([buf]);
  assert.deepEqual(whole.map((e) => e.span), [[0, 9], [9, 18], [18, 26]]);
  assert.deepEqual(whole[2].json, { c: 3 });
  for (const { name, chunks } of allSplits(buf)) assert.deepEqual(ndjsonRun(chunks), whole, name);
});
