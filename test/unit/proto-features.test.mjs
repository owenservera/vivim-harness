// Unit tests for src/decode/proto-features.mjs. Fully synthetic fixtures built by a tiny
// encoder below (same pattern as test/unit/protobuf.test.mjs). No real capture data is used.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractProtoFeatures,
  createProtoFeatureExtractor,
  resolveProtoFeatureOptions,
  PROTO_FEATURE_DEFAULTS,
  PROTO_FEATURES_SCHEMA,
} from '../../src/decode/proto-features.mjs';

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

const optPath = (r, p) => r.paths.find((x) => x.path === p);

// ---------------------------------------------------------------------------------------------
// Options and defaults
// ---------------------------------------------------------------------------------------------
test('defaults are finite positive integers and appear in result.options', () => {
  const r = extractProtoFeatures([]);
  for (const [k, v] of Object.entries(PROTO_FEATURE_DEFAULTS)) {
    assert.equal(typeof v, 'number', `type ${k}`);
    assert.ok(Number.isInteger(v) && Number.isFinite(v) && v > 0, `${k} finite positive`);
    assert.equal(r.options[k], v, `option ${k} surfaced`);
  }
  assert.equal(r.schema, PROTO_FEATURES_SCHEMA);
});

test('malformed option values throw TypeError; unknown options are rejected', () => {
  const bad = [0, -1, 1.5, Infinity, -Infinity, NaN, '10', true, null];
  for (const v of bad) {
    assert.throws(() => extractProtoFeatures([], { maxFrames: v }), TypeError, `maxFrames=${String(v)}`);
  }
  assert.throws(() => extractProtoFeatures([], { maxBytesPerFrame: 0 }), TypeError);
  assert.throws(() => extractProtoFeatures([], { maxDepth: 2.5 }), TypeError);
  assert.throws(() => extractProtoFeatures([], 42), TypeError);
  assert.throws(() => extractProtoFeatures([], { bogusOption: 1 }), TypeError);
  assert.doesNotThrow(() => resolveProtoFeatureOptions({}));
  assert.equal(resolveProtoFeatureOptions({ maxPaths: 5 }).maxPaths, 5);
  assert.deepEqual(resolveProtoFeatureOptions(null), { ...PROTO_FEATURE_DEFAULTS });
});

// ---------------------------------------------------------------------------------------------
// Scalar kinds / identical frames / no interpretation
// ---------------------------------------------------------------------------------------------
test('numeric-only frames track scalar kinds and per-path equality without value emission', () => {
  const f = cat(vint(1, 42), fixed32(2, 7), fixed64(3, 9007199254740993n));
  const r = extractProtoFeatures([f, f, f]);
  assert.deepEqual(r.kinds.scalars, { varint: 3, fixed64: 3, fixed32: 3 });
  assert.equal(r.kinds.strings, 0);
  assert.equal(r.decode.fieldsTotal, 9);
  assert.equal(optPath(r, '1').valueEqual, 2); // legitimate repeats counted per transition
  assert.equal(optPath(r, '2').valueEqual, 2);
  assert.equal(optPath(r, '3').valueEqual, 2);
  // No chat role or timestamp attribution: only kind counts, no interpreted features.
  const text = JSON.stringify(r);
  assert.equal(text.includes('timestamp'), false);
  assert.equal(text.includes('"role'), false);
  assert.equal(text.includes('42'), false); // varint decimal value is never emitted
  assert.equal(text.includes('9007199254740993'), false);
});

test('identical payloads are counted repetitions, never deduplicated', () => {
  const f = cat(vint(1, 5), str(2, 'delta'));
  const r = extractProtoFeatures([f, f, f, f]);
  assert.equal(r.records.analyzed, 4);
  assert.equal(r.decode.fieldsTotal, 8); // 2 fields x 4 frames: every repetition decoded
  assert.equal(r.sequence.payloadIdenticalTransitions, 3);
  assert.equal(r.sequence.maxConsecutiveIdenticalStreak, 3);
  assert.equal(r.sequence.structurallyIdenticalTransitions, 3);
  assert.equal(optPath(r, '2').valueEqual, 3);
  assert.equal(optPath(r, '2').valueChanged, 0);
  assert.equal(optPath(r, '1').valueEqual, 3);
});

// ---------------------------------------------------------------------------------------------
// String prefix observation (cumulative, per-path, adjacent only)
// ---------------------------------------------------------------------------------------------
test('cumulative same-path string growth: hello -> hello world counts one extension', () => {
  const r = extractProtoFeatures([str(1, 'hello'), str(1, 'hello world')]);
  assert.equal(r.strings.prefixExtensions, 1);
  assert.equal(r.strings.prefixAddedChars, 6);
  assert.equal(r.strings.prefixShrinks, 0);
  assert.equal(optPath(r, '1').prefixExtensions, 1);
  assert.equal(optPath(r, '1').prefixAddedChars, 6);
  assert.equal(optPath(r, '1').valueChanged, 0); // extension is not plain "changed"
  assert.equal(r.values.changedTransitions.string, 0);
  assert.equal(r.values.equalTransitions.string, 0); // not an equality, an extension
});

test('cumulative extensions accumulate across further growth steps', () => {
  const r = extractProtoFeatures([
    str(1, 'hello'),
    str(1, 'hello world'),
    str(1, 'hello world again'),
  ]);
  assert.equal(r.strings.prefixExtensions, 2);
  assert.equal(r.strings.prefixAddedChars, 12); // +6, then +6 again
  assert.equal(r.values.equalTransitions.string, 0);
  assert.equal(r.values.changedTransitions.string, 0);
});

test('separate chunks in adjacent frames are NOT joined: no concatenation evidence', () => {
  const r = extractProtoFeatures([str(1, 'hello'), str(1, ' world')]);
  assert.equal(r.strings.prefixExtensions, 0);
  assert.equal(r.strings.prefixAddedChars, 0);
  assert.equal(r.strings.prefixShrinks, 0);
  assert.equal(r.values.changedTransitions.string, 1); // plain change, NOT delta evidence
  assert.equal(r.values.unverifiedTransitions, 0);
  const text = JSON.stringify(r);
  for (const word of ['hello world', 'delta', 'append', 'reply', 'snapshot']) {
    assert.equal(text.includes(word), false, `no combined/semantic token: ${word}`);
  }
});

test('prefix shrinks are counted separately and are not extensions or changes', () => {
  const r = extractProtoFeatures([str(1, 'hello world'), str(1, 'hello')]);
  assert.equal(r.strings.prefixShrinks, 1);
  assert.equal(r.strings.prefixExtensions, 0);
  assert.equal(optPath(r, '1').prefixShrinks, 1);
  assert.equal(r.values.changedTransitions.string, 0);
});

test('same-path non-prefix change stays plain changed with no prefix attribution', () => {
  const r = extractProtoFeatures([str(1, 'alpha'), str(1, 'beta')]);
  assert.equal(r.strings.prefixExtensions, 0);
  assert.equal(r.strings.prefixShrinks, 0);
  assert.equal(r.values.changedTransitions.string, 1);
  assert.equal(optPath(r, '1').valueChanged, 1);
});

test('unrelated field order flips do not disturb path-local prefix evidence', () => {
  const f1 = cat(str(1, 'hello'), vint(2, 1));
  const f2 = cat(vint(2, 1), str(1, 'hello world'));
  const r = extractProtoFeatures([f1, f2]);
  assert.equal(r.strings.prefixExtensions, 1); // path '1' compared path-locally
  assert.equal(optPath(r, '1').prefixExtensions, 1);
  assert.equal(optPath(r, '2').valueEqual, 1);
});

test('identical strings remain equal transitions, never prefixed or deduped', () => {
  const r = extractProtoFeatures([str(1, 'hi'), str(1, 'hi'), str(1, 'hi')]);
  assert.equal(r.strings.prefixExtensions, 0);
  assert.equal(r.values.equalTransitions.string, 2);
  assert.equal(optPath(r, '1').valueEqual, 2);
});

test('positional ([i]) paths never get prefix attribution; suppression is visible', () => {
  const f1 = cat(msg(3, str(2, 'ab')), msg(3, str(2, 'x')));
  const f2 = cat(msg(3, str(2, 'abc')), msg(3, str(2, 'x'))); // '3[0].2' extends positionally
  const r = extractProtoFeatures([f1, f2]);
  assert.equal(r.strings.prefixExtensions, 0);
  assert.equal(r.strings.attributionSuppressed, 1);
  assert.equal(optPath(r, '3[0].2').positional, true);
  assert.equal(optPath(r, '3[0].2').valueChanged, 1);
  assert.equal(r.sequence.containsPositionalPathsFrames, 2);
});

test('repeated-field cardinality growth shows structure extension suppressed, no string growth', () => {
  // Both frames contain a repeated field-3 family, so the third instance is positional.
  const f1 = cat(msg(3, str(2, 'hello world')), msg(3, str(2, 'x')));
  const f2 = cat(msg(3, str(2, 'hello world')), msg(3, str(2, 'x')), msg(3, str(2, 'y')));
  const r = extractProtoFeatures([f1, f2]);
  assert.equal(r.sequence.frameStructureExtensions, 0); // prev frame has positional paths
  assert.equal(r.sequence.frameStructureExtensionSuppressed, 1);
  assert.equal(r.strings.prefixExtensions, 0); // '3[2].2' is a NEW positional path: baseline
  assert.equal(optPath(r, '3[0].2').valueEqual, 1); // same instance value counted, not deduped
});

// ---------------------------------------------------------------------------------------------
// Frame structure extension (renamed; structure-only, no payload/value semantics)
// ---------------------------------------------------------------------------------------------
test('append-only structural growth is observed as frameStructureExtensions', () => {
  const r = extractProtoFeatures([vint(1, 7), cat(vint(1, 7), str(2, 'hi'))]);
  assert.equal(r.sequence.frameStructureExtensions, 1);
  assert.equal(r.sequence.frameStructureExtensionSuppressed, 0);
});

test('structure extension is content-independent: changed values keep the structural label', () => {
  const f1 = cat(vint(1, 1), vint(2, 2));
  const f2 = cat(vint(1, 9), vint(2, 2), vint(3, 3));
  const r = extractProtoFeatures([f1, f2]);
  assert.equal(r.sequence.frameStructureExtensions, 1); // structure-only observation
  assert.equal(optPath(r, '1').valueChanged, 1); // separate per-path value dimension
  assert.equal(r.strings.prefixExtensions, 0); // string machinery untouched
});

test('growth under a repeated ancestor is structure-suppressed (positional identity)', () => {
  const f1 = cat(msg(3, vint(2, 1)), msg(3, vint(2, 2)));
  const f2 = cat(msg(3, vint(2, 1)), msg(3, vint(2, 2)), msg(3, vint(2, 3)));
  const r = extractProtoFeatures([f1, f2]);
  assert.equal(r.sequence.frameStructureExtensions, 0);
  assert.equal(r.sequence.frameStructureExtensionSuppressed, 1);
});

test('growth extending a repeated sibling family is suppressed', () => {
  const f1 = cat(vint(1, 5), vint(1, 6));
  const f2 = cat(vint(1, 5), vint(1, 6), vint(1, 7)); // third positional instance
  const r = extractProtoFeatures([f1, f2]);
  assert.equal(r.sequence.frameStructureExtensions, 0);
  assert.equal(r.sequence.frameStructureExtensionSuppressed, 1);
});

test('cardinality reduction renumbers paths: no frame extension claimed', () => {
  const f1 = cat(vint(1, 5), vint(1, 6), vint(2, 7));
  const f2 = cat(vint(1, 5), vint(2, 7)); // repeated 1 collapses to one instance
  const r = extractProtoFeatures([f1, f2]);
  assert.equal(r.sequence.frameStructureExtensions, 0);
  assert.equal(r.sequence.changedTransitions, 1);
  assert.equal(optPath(r, '1[1]').fields, 1); // second instance seen only in frame 1
});

test('structural repetition with changed values shows structure-identical, not frame change', () => {
  const r = extractProtoFeatures([vint(1, 1), vint(1, 2)]);
  assert.equal(r.sequence.structurallyIdenticalTransitions, 1);
  assert.equal(r.sequence.changedTransitions, 0);
  assert.equal(r.sequence.frameStructureExtensions, 0);
  assert.equal(optPath(r, '1').valueChanged, 1); // per-path value dimension
});

test('frame shrink (strict structural subset) is reported distinctly', () => {
  const r = extractProtoFeatures([cat(vint(1, 1), vint(2, 2)), vint(1, 1)]);
  assert.equal(r.sequence.frameShrunkTransitions, 1);
  assert.equal(r.sequence.frameStructureExtensions, 0);
});

// ---------------------------------------------------------------------------------------------
// Bytes / empty / corrupt / incomplete / invalid
// ---------------------------------------------------------------------------------------------
test('non-UTF8 bytes and empty payloads stay numeric (len stats), never content', () => {
  const x4 = ld(4, [0xff, 0xfe, 0x00, 0x80]);
  const y2 = ld(4, [0xff, 0xfe]);
  const r = extractProtoFeatures([x4, x4, y2]);
  assert.equal(r.kinds.bytes.entries, 3);
  assert.equal(r.kinds.bytes.lenTotal, 10);
  assert.equal(r.kinds.bytes.lenMax, 4);
  assert.equal(optPath(r, '4').kinds.bytes, 3);
  const text = JSON.stringify(r);
  assert.equal(text.includes('fffe'), false); // head hex never emitted
  assert.equal(text.includes('"head"'), false);
  assert.equal(r.strings.prefixExtensions, 0); // bytes carry no string adjacency
});

test('empty payloads decode as field-free frames and count identical repetitions', () => {
  const r = extractProtoFeatures([Buffer.alloc(0), Buffer.alloc(0), Buffer.alloc(0)]);
  assert.equal(r.records.analyzed, 3);
  assert.equal(r.decode.fieldsTotal, 0);
  assert.equal(r.sequence.payloadIdenticalTransitions, 2);
  assert.equal(r.sequence.structurallyIdenticalTransitions, 2);
});

test('corrupt frames are reported with reason histogram, not mixed into budget counts', () => {
  const r = extractProtoFeatures([
    Buffer.from([0x08, 0x80]),               // truncated-varint
    cat(tag(1, 1), Buffer.from([1, 2, 3])),  // truncated-fixed64
    Buffer.from([0x0a, 0x7f]),               // length-beyond-buffer
    Buffer.from([0x00, 0x01]),               // bad-field-number
    Buffer.from([0x0b]),                     // group-wire-type
    Buffer.from([0x0e]),                     // invalid-wire-type
  ]);
  assert.equal(r.records.analyzed, 0);
  assert.equal(r.decode.corruptFrames, 6);
  assert.deepEqual(r.decode.corruptReasons, {
    'truncated-varint': 1,
    'truncated-fixed64': 1,
    'length-beyond-buffer': 1,
    'bad-field-number': 1,
    'group-wire-type': 1,
    'invalid-wire-type': 1,
  });
  assert.equal(r.decode.budgetFrames, 0);
  assert.equal(r.sequence.identityInterruptions, 0); // nothing was ever analyzed to break
});

test('incomplete frame records reset identity; the next payload is not called identical', () => {
  const f = vint(1, 9);
  const r = extractProtoFeatures([f, f, { complete: false }, f]);
  assert.equal(r.records.incomplete, 1);
  assert.equal(r.sequence.identityInterruptions, 1);
  assert.equal(r.sequence.payloadIdenticalTransitions, 1); // second frame only; gap forbids the third
  assert.equal(r.sequence.maxConsecutiveIdenticalStreak, 1);
});

test('invalid records (non-buffer payloads) are counted and keep identity honest', () => {
  const r = extractProtoFeatures([null, { payload: 'nope' }, { payload: 42 }]);
  assert.equal(r.records.invalid, 3);
  assert.equal(r.records.analyzed, 0);
  assert.equal(r.sequence.identityInterruptions, 0); // nothing was analyzed to interrupt
});

// ---------------------------------------------------------------------------------------------
// Ambiguity
// ---------------------------------------------------------------------------------------------
test('parser ambiguity flags are preserved, counted and visibly flagged beside prefix data', () => {
  // 'hi' parses as a 1-field message too -> ambiguous:true; 'hix' fails the speculative
  // parse (truncated varint tail) and is a plain string, so only one ambiguous entry.
  const r = extractProtoFeatures([str(1, 'hi'), str(1, 'hix')]);
  assert.equal(r.decode.ambiguousEntries, 1);
  assert.equal(optPath(r, '1').ambiguous, 1);
  assert.equal(r.strings.prefixExtensions, 1); // observational extension, flag stays visible
  assert.equal(r.values.changedTransitions.string, 0);
});

test('silent multi-field message classification over printable text is inherited un-flagged', () => {
  // "000000" parses both as printable text AND as a 3-field message; the decoder classifies
  // it 'message' silently (classification not recoverable from the tree). Features must not
  // invent an ambiguity flag and must not re-parse the bytes.
  const r = extractProtoFeatures([str(1, '000000')]);
  assert.equal(optPath(r, '1').kinds.message, 1);
  assert.equal(optPath(r, '1').ambiguous, 0);
  assert.equal(r.decode.ambiguousEntries, 0);
});

// ---------------------------------------------------------------------------------------------
// Budgets: frame cap, per-frame bytes, paths, depth, decoder fields
// ---------------------------------------------------------------------------------------------
test('frame cap: extra records are counted as ignored, budget-flagged, not corrupt', () => {
  const f = vint(1, 1);
  const r = extractProtoFeatures([f, f, f, f, f], { maxFrames: 3 });
  assert.equal(r.records.analyzed, 3);
  assert.equal(r.records.ignoredBeyondCap, 2);
  assert.equal(r.decode.corruptFrames, 0);
  assert.equal(r.integrity.inspectionTruncated, true);
});

test('per-frame byte cap: oversized payloads skipped as budget, never decoded, not corrupt', () => {
  const small = vint(1, 1);
  const big = cat(vint(1, 1), vint(2, 2), vint(3, 3), vint(4, 4), vint(5, 5));
  const r = extractProtoFeatures([small, big, small], { maxBytesPerFrame: big.length - 1 });
  assert.equal(r.records.skippedOversize, 1);
  assert.equal(r.records.analyzed, 2);
  assert.equal(r.decode.corruptFrames, 0);
  // identity resets: the third payload equals the first, but across a skip: no identical claim
  assert.equal(r.sequence.payloadIdenticalTransitions, 0);
});

test('decoder maxFields abort counts as budgetFrames with partial entries honestly reported', () => {
  const f = cat(...Array.from({ length: 50 }, (_, i) => vint(1, i)));
  const r = extractProtoFeatures([f], { maxFields: 10 });
  assert.equal(r.records.analyzed, 0); // aborted frames do not count as cleanly analyzed
  assert.equal(r.decode.budgetFrames, 1);
  assert.equal(r.decode.corruptFrames, 0);
  assert.equal(r.decode.partialTopLevelEntries, 10);
  assert.equal(r.integrity.inspectionTruncated, true);
  assert.equal(r.integrity.completeProof, false);
});

test('path-state cap: overflow entries counted, per-path details bounded by maxPaths', () => {
  const f = cat(...Array.from({ length: 10 }, (_, i) => vint(i + 1, i)));
  const r = extractProtoFeatures([f, f], { maxPaths: 4 });
  assert.equal(r.paths.length, 4);
  assert.equal(r.pathsOverflowEntries > 0, true);
  assert.equal(r.integrity.inspectionTruncated, true);
});

test('pathological depth stays bounded and honors maxDepth', () => {
  let deep = Buffer.alloc(0);
  for (let i = 0; i < 2000; i++) deep = ld(1, deep);
  const r = extractProtoFeatures([deep], { maxDepth: 4 });
  assert.ok(r.decode.maxDepthObserved <= 4);
  assert.ok(r.kinds.bytes.entries >= 1);
});

// ---------------------------------------------------------------------------------------------
// Retention budgets
// ---------------------------------------------------------------------------------------------
test('values over the retained-string cap are unverified, never prefix-attributed', () => {
  // '#'=0x23 has wire type 3 (group), so '####...' fails the speculative message parse and
  // stays a plain (oversize) string: a pure string-budget exercise.
  const big = '#'.repeat(500);
  const r = extractProtoFeatures([str(1, big), str(1, big + 'tail'), str(1, 'small')], {
    maxStringCharsPerPath: 100,
  });
  assert.equal(r.strings.prefixExtensions, 0); // over cap: exclusion, not attribution
  assert.equal(r.strings.prefixShrinks, 0);
  assert.equal(r.values.oversizeStringValues, 2);
  assert.equal(optPath(r, '1').oversizeValues, 2);
  assert.equal(r.values.unverifiedByReason.oversizeCurrent, 1); // frame2 vs oversize frame1
  assert.equal(r.values.unverifiedByReason.oversizePrevious, 1); // frame3 vs dropped oversize
  assert.equal(optPath(r, '1').retainedChars, 5); // 'small' admitted
  assert.equal(optPath(r, '1').valueChanged, 0); // never guessed across budgets
  const text = JSON.stringify(r);
  assert.equal(text.includes(big), false);
});

test('total retained char budget: refusals are counted and the total stays within the cap', () => {
  const fs = Array.from({ length: 40 }, (_, i) => str(i + 1, 'value-' + String(i).padStart(3, '0')));
  const total = 200;
  const r = extractProtoFeatures(fs, { maxTotalRetainedChars: total });
  assert.ok(r.retention.retainedChars <= total);
  assert.equal(r.retention.retentionBudgetRefusals > 0, true);
  assert.equal(r.values.unverifiedByReason.retentionBudget > 0, true);
  assert.equal(r.integrity.inspectionTruncated, true);
  assert.equal(typeof JSON.stringify(r), 'string');
  assert.equal(/value-\d+/.test(JSON.stringify(r)), false);
});

// ---------------------------------------------------------------------------------------------
// Determinism, isolation, immutability, JSON serializability
// ---------------------------------------------------------------------------------------------
function deepFreeze(x) {
  if (x instanceof Uint8Array) return x; // bytes stay read-only by contract; non-mutation has its own test
  if (x && typeof x === 'object') {
    for (const v of Object.values(x)) deepFreeze(v);
    Object.freeze(x);
  }
  return x;
}

test('deterministic: frozen input, repeated runs give deep-equal JSON summaries', () => {
  const frames = [
    str(1, 'hello'),
    str(1, 'b'),                        // non-prefix change
    cat(str(1, 'b'), ld(9, [0xff, 0x01])), // appended structure, byte-exact prefix
  ];
  const frozen = deepFreeze(frames.map((p) => ({ payload: p })));
  const a = extractProtoFeatures(frozen);
  const b = extractProtoFeatures(frozen);
  assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));
  assert.equal(a.growth, undefined); // removed machinery stays out of the summary
  assert.equal(a.sequence.frameStructureExtensions, 1);
  assert.equal(a.strings.prefixExtensions, 0); // 'hello'->'b' changed, not extended
  assert.equal(a.values.changedTransitions.string, 1);
  const betas = JSON.parse(JSON.stringify(b));
  for (const word of ['hello world', 'b-something']) {
    assert.equal(JSON.stringify(betas).includes(word), false);
  }
});

test('independent calls isolate streams; result() does not mutate running aggregation', () => {
  const f1 = vint(1, 1);
  const f2 = cat(vint(1, 1), vint(2, 2));
  const alone1 = extractProtoFeatures([f1]);
  const alone2 = extractProtoFeatures([f2]);
  const both = extractProtoFeatures([f1, f2]);
  assert.equal(both.sequence.frameStructureExtensions, 1);
  assert.equal(alone1.sequence.frameStructureExtensions, 0);
  assert.equal(alone2.sequence.frameStructureExtensions, 0);

  const ex = createProtoFeatureExtractor();
  ex.add(f1);
  const snap1 = JSON.stringify(ex.result());
  ex.add(f2);
  const snap2 = ex.result();
  assert.equal(JSON.parse(snap1).sequence.frameStructureExtensions, 0);
  assert.equal(snap2.sequence.frameStructureExtensions, 1);
  assert.deepEqual(ex.result(), snap2); // repeat calls are stable and do not advance anything
});

test('input is never mutated: payloads and record objects stay byte-identical', () => {
  const p = Buffer.from([0x08, 0x07]);
  const rec = { payload: p };
  const before = Buffer.from(p);
  extractProtoFeatures([rec, p], { maxFrames: 2 });
  assert.equal(p.equals(before), true);
  assert.deepEqual(rec, { payload: p });
  assert.equal(Object.keys(rec).length, 1);
});

test('output is fully JSON-serializable: no undefined holes survive a round trip', () => {
  const r = extractProtoFeatures([
    cat(vint(1, 1), msg(2, vint(3, 3)), ld(4, []), fixed32(5, 1), fixed64(6, 1n)),
    Buffer.from([0x08, 0x80]),
  ]);
  const round = JSON.parse(JSON.stringify(r));
  assert.deepEqual(round, r);
});

// ---------------------------------------------------------------------------------------------
// Bounded endurance
// ---------------------------------------------------------------------------------------------
test('bounded endurance: 400 stable-structure frames keep retention within explicit caps', () => {
  const frames = [];
  for (let i = 1; i <= 400; i++) {
    const parts = [vint(1, 1)];
    for (let j = 2; j <= i && j <= 60; j++) parts.push(vint(j, j * 2));
    frames.push(cat(...parts));
  }
  const r = extractProtoFeatures(frames, { maxFrames: 400, maxPaths: 30, maxTotalRetainedChars: 4096 });
  assert.ok(r.retention.retainedChars <= 4096);
  assert.equal(r.paths.length, 30);
  assert.ok(r.pathsOverflowEntries > 0); // fields 31..60 exist in every later frame
  assert.equal(r.sequence.frameStructureExtensions, 59); // frames 2..60 grow
  assert.ok(r.sequence.payloadIdenticalTransitions >= 339);
  assert.equal(r.integrity.inspectionTruncated, true);
});
