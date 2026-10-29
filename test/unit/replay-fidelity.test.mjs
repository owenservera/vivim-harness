// Replay-fidelity QA, Capture Studio Sprint 1 (lane: raw-to-replay fidelity).
// Offline only: no Chrome, no network, no real site data. Each synthetic session is written through
// the real NetworkRecorder chunk path (fake CDP-free, via its _chunk API) and the real RawLog, then
// read back through the real Session, streamBytes (derive.mjs), StreamReducer and decoders.
//
// Criterion, applied to COMPLETE sessions only (no gap, body.excluded or body.truncated record):
//   (a) bytes reassembled from raw chunk records (ws.frame payloads for WebSocket) == bytes fed in
//   (b) StreamReducer replay events == decoder output over the original bytes, field for field.
//       Not compared: wall-clock envelope fields (sid, seq, t, layer, frameT) and the reducer's
//       delta revision counter. duplicate / outOfOrder / sequenceSkip must be absent.
//   (c) assembled document text == expected text
// INCOMPLETE sessions are reported as such and do not count toward the pass total.
//
// Run from the AION checkout:
//   node --test workspace/aion/qa/capture-studio/tests/replay-fidelity.test.mjs
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Session } from '../../src/store/session.mjs';
import { NetworkRecorder } from '../../src/capture/network.mjs';
import { StreamReducer } from '../../src/replay/reducer.mjs';
import { streamBytes } from '../../src/replay/derive.mjs';
import { pickAutoDecoder, WsFrameDecoder } from '../../src/decode/decoders.mjs';
import { buildFamily, collectSessions } from '../../src/families/build.mjs';

const MIB = 1024 * 1024;
const SSE = 'text/event-stream';
const NDJSON = 'application/x-ndjson';
const INCOMPLETE_KINDS = new Set(['gap', 'body.excluded', 'body.truncated']);
// `n` (and `evn`, set only if a decoder already emits its own `n`) is the reducer's per-record event
// position that completes the event id sid#seq.n. A direct decode has no raw record, so it never has it.
const ENVELOPE_KEYS = new Set(['sid', 'seq', 't', 'layer', 'frameT', 'revision', 'n', 'evn']);
const REDUCER_ANNOTATIONS = ['duplicate', 'outOfOrder', 'sequenceSkip'];
const EXPECTED_COMPLETE = 10;
const EXPECTED_INCOMPLETE = 2;

const enc = (s) => Buffer.from(s, 'utf8');

// ---------------------------------------------------------------------------------------------
// Deterministic generator (mulberry32). Same seed, same corpus, byte for byte.
// ---------------------------------------------------------------------------------------------
function rng32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Multi-byte material on purpose: 2-byte Latin, 3-byte CJK, 4-byte emoji, JSON-escaped quote,
// backslash and tab. Synthetic words only; nothing resembling a credential.
const WORDS = ['alpha ', 'beta ', 'gamma, ', 'h\u00e9llo ', '\u4e16\u754c ', '\ud83d\ude42 ', 'na\u00efve ',
  'caf\u00e9. ', '\u03a9mega ', 'x: y; ', 'quote"back\\slash ', 'tab\tend '];
const LEAD = '\u4e16\u754c \ud83d\ude42 ';   // guarantees a 3-byte and a 4-byte sequence in every corpus

function makeDeltas(rng, totalCp, minLen, maxLen) {
  const cps = [...LEAD];
  while (cps.length < totalCp) {
    const w = WORDS[Math.floor(rng() * WORDS.length)];
    for (const c of w) cps.push(c);
  }
  const out = [];
  let i = 0;
  while (i < totalCp) {
    const n = minLen + Math.floor(rng() * (maxLen - minLen + 1));
    out.push(cps.slice(i, Math.min(totalCp, i + n)).join(''));
    i += n;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Wire formats (the bytes an origin would send).
// ---------------------------------------------------------------------------------------------
function ssePathOps(deltas, { eol = '\n', ids = false, comments = false } = {}) {
  const out = [];
  deltas.forEach((d, i) => {
    if (comments && i % 5 === 0) out.push(`: keepalive${eol}${eol}`);
    if (ids) out.push(`id: ${i}${eol}`);
    out.push(`data: ${JSON.stringify({ p: '/text', o: 'append', v: d })}${eol}${eol}`);
  });
  out.push(`data: ${JSON.stringify({ p: '/status', o: 'replace', v: 'complete' })}${eol}${eol}`);
  out.push(`data: [DONE]${eol}${eol}`);
  return enc(out.join(''));
}

function sseTyped(deltas) {
  const evs = [{ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }];
  for (const d of deltas) evs.push({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: d } });
  evs.push({ type: 'content_block_stop', index: 0 });
  evs.push({ type: 'message_stop' });
  return enc(evs.map((o) => `event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`).join(''));
}

function ndjsonPathOps(deltas) {
  const lines = deltas.map((d) => JSON.stringify({ p: '/text', o: 'append', v: d }));
  lines.push(JSON.stringify({ p: '/status', o: 'replace', v: 'complete' }));
  return enc(lines.map((l) => `${l}\n`).join(''));
}

function wsFrames(deltas) {
  const frames = deltas.map((d) => ({ dir: 'in', opcode: 1, payload: JSON.stringify({ p: '/text', o: 'append', v: d }) }));
  frames.push({ dir: 'in', opcode: 1, payload: JSON.stringify({ p: '/status', o: 'replace', v: 'complete' }) });
  return frames;
}

// ---------------------------------------------------------------------------------------------
// Chunk boundary helpers.
// ---------------------------------------------------------------------------------------------
const cutsEvery = (len, n) => { const c = []; for (let i = n; i < len; i += n) c.push(i); return c; };

function multibyteCuts(wire) {
  const i3 = wire.indexOf(enc('\u4e16'));
  const i4 = wire.indexOf(enc('\ud83d\ude42'));
  if (i3 < 0 || i4 < 0) throw new Error('fixture lacks multi-byte material');
  const cuts = [i3 + 1, i4 + 2, i4 + 3];
  for (const c of cuts) if ((wire[c] & 0xc0) !== 0x80) throw new Error(`cut ${c} is not inside a UTF-8 sequence`);
  return cuts;
}

function splitAt(buf, cuts) {
  const pts = [...new Set(cuts.filter((c) => c > 0 && c < buf.length))].sort((a, b) => a - b);
  const out = [];
  let prev = 0;
  for (const c of pts) { out.push(Buffer.from(buf.subarray(prev, c))); prev = c; }
  out.push(Buffer.from(buf.subarray(prev)));
  return out;
}

// ---------------------------------------------------------------------------------------------
// Corpus specification.
// ---------------------------------------------------------------------------------------------
function httpSpec(name, { mime, wire, cuts, textPath, expected, rawOptions, recorderOptions, expectComplete = true, expectReason = null }) {
  return { name, kind: 'http', sid: `p:${name}.1`, mime, wire, pieces: splitAt(wire, cuts(wire)), textPath,
    expectedText: expected, rawOptions, recorderOptions, expectComplete, expectReason };
}

function wsSpec(name, { frames, expected }) {
  return { name, kind: 'ws', sid: `w:${name}`, frames, wire: Buffer.concat(frames.map((f) => enc(f.payload))),
    textPath: '/text', expectedText: expected, expectComplete: true, expectReason: null };
}

function buildSpecs() {
  const rng = rng32(1337);
  const d1 = makeDeltas(rng, 600, 1, 20);
  const d2 = makeDeltas(rng, 1500, 5, 60);
  const d3 = makeDeltas(rng, 1000, 5, 80);
  const d4 = makeDeltas(rng, 800, 5, 60);
  const d5 = makeDeltas(rng, 820000, 50, 300);
  const d6 = makeDeltas(rng, 400, 1, 15);
  const d7 = makeDeltas(rng, 700, 5, 40);
  const d8 = makeDeltas(rng, 500, 5, 40);
  const d9 = makeDeltas(rng, 500, 5, 40);
  const d10 = makeDeltas(rng, 500, 5, 40);
  const d11 = makeDeltas(rng, 300, 5, 40);
  const d12 = makeDeltas(rng, 1500, 5, 40);
  const w5 = ssePathOps(d5);
  if (w5.length <= MIB) throw new Error(`long stream is only ${w5.length} bytes`);
  if (ssePathOps(d12).length <= 3000) throw new Error('truncation fixture is smaller than its 3000-byte cap');

  const lineCuts = (w) => {
    const c = [];
    for (let at = w.indexOf('data: '); at >= 0; at = w.indexOf('data: ', at + 1)) c.push(at + 3);
    if (c.length < 5) throw new Error('too few SSE data lines to split');
    return [...c, ...cutsEvery(w.length, 97)];
  };
  const crCuts = (w) => {
    const c = [];
    for (let at = w.indexOf(0x0d); at >= 0; at = w.indexOf(0x0d, at + 1)) c.push(at + 1);
    if (!c.length) throw new Error('no CR bytes to split');
    return [...c, ...cutsEvery(w.length, 137)];
  };

  return [
    httpSpec('sse-typed-events-4k', { mime: SSE, wire: sseTyped(d1), cuts: (w) => cutsEvery(w.length, 4096),
      textPath: '/blocks/0/text', expected: d1.join('') }),
    httpSpec('sse-path-ops-512b', { mime: SSE, wire: ssePathOps(d2), cuts: (w) => cutsEvery(w.length, 512),
      textPath: '/text', expected: d2.join('') }),
    httpSpec('ndjson-path-ops-300b', { mime: NDJSON, wire: ndjsonPathOps(d3), cuts: (w) => cutsEvery(w.length, 300),
      textPath: '/text', expected: d3.join('') }),
    wsSpec('ws-text-path-ops', { frames: wsFrames(d4), expected: d4.join('') }),
    httpSpec('sse-long-over-1mib', { mime: SSE, wire: w5, cuts: (w) => cutsEvery(w.length, 65536),
      textPath: '/text', expected: d5.join('') }),
    httpSpec('sse-many-tiny-chunks-1b', { mime: SSE, wire: ssePathOps(d6), cuts: (w) => cutsEvery(w.length, 1),
      textPath: '/text', expected: d6.join('') }),
    httpSpec('sse-utf8-multibyte-split', { mime: SSE, wire: ssePathOps(d7),
      cuts: (w) => [...multibyteCuts(w), ...cutsEvery(w.length, 211)], textPath: '/text', expected: d7.join('') }),
    httpSpec('sse-line-split-inside-field', { mime: SSE, wire: ssePathOps(d8), cuts: lineCuts,
      textPath: '/text', expected: d8.join('') }),
    httpSpec('ndjson-utf8-line-split', { mime: NDJSON, wire: ndjsonPathOps(d9),
      cuts: (w) => [...multibyteCuts(w), ...cutsEvery(w.length, 61)], textPath: '/text', expected: d9.join('') }),
    httpSpec('sse-crlf-ids-comments-cr-split', { mime: SSE, wire: ssePathOps(d10, { eol: '\r\n', ids: true, comments: true }),
      cuts: crCuts, textPath: '/text', expected: d10.join('') }),
    // Deliberately incomplete. The gap comes from the real RawLog overflow path (tiny queue, slow
    // disk hook), not from a hand-written record.
    httpSpec('sse-gap-raw-overflow', { mime: SSE, wire: ssePathOps(d11), cuts: (w) => cutsEvery(w.length, 256),
      rawOptions: { maxQueueBytes: 2048, writeDelayMs: 25 }, textPath: '/text', expected: d11.join(''),
      expectComplete: false, expectReason: 'gap' }),
    // Deliberately incomplete. The cut comes from the real NetworkRecorder stream cap.
    httpSpec('sse-truncated-at-cap', { mime: SSE, wire: ssePathOps(d12), cuts: (w) => cutsEvery(w.length, 256),
      recorderOptions: { maxStreamBytes: 3000 }, textPath: '/text', expected: d12.join(''),
      expectComplete: false, expectReason: 'body.truncated' }),
  ];
}

// ---------------------------------------------------------------------------------------------
// Writing sessions through the real capture primitives.
// ---------------------------------------------------------------------------------------------
async function writeSession(sessionsDir, spec) {
  const s = Session.create(sessionsDir, {
    site: 'chat.example.test',
    meta: { target: { url: 'https://chat.example.test/' }, fixture: spec.name, synthetic: true },
    rawOptions: spec.rawOptions ?? {},
  });
  const add = (r) => s.raw.append(r);
  add({ k: 'run.start', fixture: spec.name, target: { url: 'https://chat.example.test/' } });
  if (spec.kind === 'ws') {
    add({ k: 'ws.open', sid: spec.sid, url: 'wss://chat.example.test/ws', target: 'p' });
    for (const f of spec.frames) add({ k: 'ws.frame', sid: spec.sid, dir: f.dir, opcode: f.opcode, payload: f.payload });
    add({ k: 'ws.close', sid: spec.sid, target: 'p' });
  } else {
    add({ k: 'req', sid: spec.sid, url: 'https://chat.example.test/api/chat', method: 'POST', type: 'Fetch', frameId: 'F1', target: 'p' });
    add({ k: 'res', sid: spec.sid, status: 200, mime: spec.mime, protocol: 'h2' });
    const net = new NetworkRecorder({ append: add, profile: { capture: {} }, getPageUrl: () => 'https://chat.example.test/',
      options: spec.recorderOptions ?? {} });
    const st = { sid: spec.sid, chunks: 0, bytes: 0 };
    for (const piece of spec.pieces) net._chunk(st, piece);
    if (st.guard && !st.truncated && !st.credentialExcluded) net._appendProtectedChunk(st, st.guard.finish(), { finalSecurityTail: true });
    add({ k: 'done', sid: spec.sid, encodedDataLength: spec.wire.length, chunks: st.chunks, bytes: st.bytes,
      ...(st.truncated ? { truncated: true } : {}) });
  }
  await s.raw.close();
  return s.dir;
}

// ---------------------------------------------------------------------------------------------
// Criterion evaluation.
// ---------------------------------------------------------------------------------------------
function show(v) {
  const s = JSON.stringify(v);
  if (s === undefined) return 'undefined';
  return s.length > 120 ? `${s.slice(0, 120)}...` : s;
}

function firstByteDiff(expected, got) {
  const n = Math.min(expected.length, got.length);
  for (let i = 0; i < n; i++) {
    if (expected[i] !== got[i]) return `first differing byte at offset ${i}: expected 0x${expected[i].toString(16)} got 0x${got[i].toString(16)}`;
  }
  if (expected.length !== got.length) return `length expected ${expected.length} got ${got.length} (common prefix equal)`;
  return null;
}

function firstFieldDiff(a, b, p = '$') {
  if (a === b) return null;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return `${p}: ${show(a)} vs ${show(b)}`;
  if (Array.isArray(a) !== Array.isArray(b)) return `${p}: ${show(a)} vs ${show(b)}`;
  if (Array.isArray(a) && a.length !== b.length) return `${p}.length: ${a.length} vs ${b.length}`;
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const d = firstFieldDiff(a[k], b[k], `${p}.${k}`);
    if (d) return d;
  }
  return null;
}

function firstTextDiff(expected, got) {
  if (got === undefined) return 'no string at the text path';
  const n = Math.min(expected.length, got.length);
  for (let i = 0; i < n; i++) if (expected[i] !== got[i]) return `first differing UTF-16 unit at ${i}: expected ${show(expected.slice(i, i + 20))} got ${show(got.slice(i, i + 20))}`;
  return expected.length !== got.length ? `length expected ${expected.length} got ${got.length} (common prefix equal)` : null;
}

function normEvent(e) {
  const o = {};
  for (const [k, v] of Object.entries(e)) if (!ENVELOPE_KEYS.has(k)) o[k] = v;
  return JSON.parse(JSON.stringify(o));
}

async function evaluate(spec, sessionDir) {
  const session = new Session(sessionDir);
  const records = [];
  for await (const r of session.records()) records.push(r);
  const reasons = records.filter((r) => INCOMPLETE_KINDS.has(r.k)).map((r) => `${r.k}@seq${r.seq}`);
  const res = { name: spec.name, complete: reasons.length === 0, reasons, expectComplete: spec.expectComplete,
    expectReason: spec.expectReason, a: null, b: null, c: null, events: 0 };
  if (!res.complete) return res;
  const verdict = (d) => ({ ok: d === null, detail: d ?? '' });

  // (a) raw bytes from disk versus bytes fed in.
  const { bytes } = await streamBytes(session, spec.sid);
  res.a = verdict(firstByteDiff(spec.wire, bytes));

  // (b) replay path (whole session through the reducer) versus direct decode of the original bytes.
  const reducer = new StreamReducer({ keepEvents: true });
  const replay = reducer.ingestAll(records).filter((e) => e.sid === spec.sid);
  let direct;
  if (spec.kind === 'ws') {
    const wd = new WsFrameDecoder();
    direct = [];
    for (const f of spec.frames) direct.push(...wd.push({ opcode: f.opcode, payload: f.payload, dir: f.dir }));
    direct.push(...wd.end());
  } else {
    const d = pickAutoDecoder(spec.mime);
    direct = [...d.push(spec.wire), ...d.end()];
  }
  const rn = replay.map(normEvent);
  const dn = direct.map(normEvent);
  let dDiff = rn.length === dn.length ? null : `event count replay=${rn.length} direct=${dn.length}`;
  for (let i = 0; dDiff === null && i < rn.length; i++) dDiff = firstFieldDiff(rn[i], dn[i], `event[${i}]`);
  if (dDiff === null) {
    const ann = replay.findIndex((e) => REDUCER_ANNOTATIONS.some((k) => e[k] !== undefined));
    if (ann >= 0) dDiff = `event[${ann}] carries a reducer annotation (${REDUCER_ANNOTATIONS.join('/')})`;
  }
  res.b = verdict(dDiff);
  res.events = rn.length;

  // (c) assembled document text versus expected text.
  const got = reducer.deltaOf(spec.sid)?.textOf(spec.textPath);
  res.c = verdict(got === spec.expectedText ? null : `text at ${spec.textPath}: ${firstTextDiff(spec.expectedText, got)}`);
  return res;
}

// ---------------------------------------------------------------------------------------------
// Build the corpus once, evaluate every session, then report through node:test.
// ---------------------------------------------------------------------------------------------
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'aion-qa-replay-fidelity-'));
after(() => { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* best effort */ } });
const SESSIONS = path.join(ROOT, 'sessions');
fs.mkdirSync(SESSIONS, { recursive: true });

const SPECS = buildSpecs();
const RESULTS = [];
for (const spec of SPECS) {
  const dir = await writeSession(SESSIONS, spec);
  RESULTS.push(await evaluate(spec, dir));
}

// Known product defects. Each entry marks ONE criterion of ONE session as todo; the assertion itself
// stays strict. Remove the entry when the product is fixed.
// (Empty since RF-1 was fixed in decoders.mjs LineSplitter: a CR-terminated line is held until the next
// byte or end of stream, so a CRLF split across chunks keeps its exact span.)
const KNOWN_B = {};

for (const r of RESULTS) {
  if (r.expectComplete) {
    test(`${r.name}: COMPLETE -> (a) raw bytes and (c) text`, () => {
      assert.equal(r.complete, true, `unexpectedly INCOMPLETE: ${r.reasons.join(', ')}`);
      assert.equal(r.a.ok, true, `(a) ${r.name}: ${r.a.detail}`);
      assert.equal(r.c.ok, true, `(c) ${r.name}: ${r.c.detail}`);
    });
    test(`${r.name}: COMPLETE -> (b) replay events == direct decode`, KNOWN_B[r.name] ? { todo: KNOWN_B[r.name] } : {}, () => {
      assert.equal(r.complete, true, `unexpectedly INCOMPLETE: ${r.reasons.join(', ')}`);
      assert.equal(r.b.ok, true, `(b) ${r.name}: ${r.b.detail}`);
    });
  } else {
    test(`${r.name}: INCOMPLETE, reported and excluded from the pass total`, () => {
      assert.equal(r.complete, false, 'deliberately incomplete session was classified COMPLETE');
      assert.ok(r.reasons.some((x) => x.startsWith(r.expectReason)), `expected ${r.expectReason}, got ${r.reasons.join(', ') || 'none'}`);
    });
  }
}

test('summary: complete passed / incomplete', () => {
  const complete = RESULTS.filter((r) => r.complete);
  const passed = complete.filter((r) => r.a?.ok && r.b?.ok && r.c?.ok);
  const incomplete = RESULTS.filter((r) => !r.complete);
  console.log(`replay-fidelity: ${passed.length} complete passed of ${complete.length} complete; ${incomplete.length} incomplete (excluded from pass total)`);
  assert.equal(complete.length, EXPECTED_COMPLETE, 'corpus shape: a complete session silently became INCOMPLETE');
  assert.equal(incomplete.length, EXPECTED_INCOMPLETE, 'corpus shape: an INCOMPLETE session silently became COMPLETE');
});

// ---------------------------------------------------------------------------------------------
// QA-S1-F1: family eligibility. A derived session (SHAPES present) with no acceptance verdict must
// not be consolidated into a family. Inspection must still expose withheld sessions.
// ---------------------------------------------------------------------------------------------
const S1F1 = 'QA-S1-F1: family build must exclude sessions without a passing acceptance verdict';

function makeDerivedSession(sessionsDir) {
  const s = Session.create(sessionsDir, { site: 'chat.example.test', meta: { target: { url: 'https://chat.example.test/' }, synthetic: true } });
  s.kv.set('SHAPES', {
    endpoints: [{ endpoint: 'POST https://chat.example.test/api/chat', transports: { HTTP_SSE: 1 }, resourceTypes: ['Fetch'] }],
    groups: [{ endpoint: 'POST https://chat.example.test/api/chat', count: 3, fields: { '/text': { count: 3 } }, collections: [] }],
  });
  return s;
}

test('control: a derived SHAPES-only session is visible to collectSessions (fixture is real)', async () => {
  const dir = path.join(ROOT, 's1f1-control');
  const s = makeDerivedSession(dir);
  await s.raw.close();
  const listed = collectSessions({ sessionsDir: dir, host: 'chat.example.test' });
  const hit = listed.find((x) => x.id === s.id);
  assert.ok(hit, 'fixture session not listed at all');
  assert.equal(hit.hasDerived, true);
});

test(S1F1, async () => {
  const dir = path.join(ROOT, 's1f1');
  const s = makeDerivedSession(dir);
  await s.raw.close();
  const listed = collectSessions({ sessionsDir: dir, host: 'chat.example.test' });
  const inspected = listed.find((x) => x.id === s.id);
  assert.ok(inspected, 'withheld session remains visible for inspection');
  assert.equal(inspected.eligible, false, 'SHAPES-only session must not be eligible');
  assert.equal(inspected.acceptance, 'unassessed');
  const built = buildFamily({ sessionsDir: dir, host: 'chat.example.test' });
  assert.equal(built.family.members.includes(s.id), false, 'buildFamily consolidated a session with no acceptance verdict');
});
