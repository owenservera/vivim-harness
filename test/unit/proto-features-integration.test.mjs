// Protobuf structural features END TO END: GrpcFrameDecoder -> StreamReducer -> role coverage -> derive
// events dataset / STREAM_ROLES -> scoreboard. Synthetic frames built by a tiny encoder; nothing is captured.
// The point is wiring and honesty: a compact snapshot rides on protobuf-path events only, the role stays
// 'unknown' (binary structure is never a reply), and corrupt / partial / capped frames are never "complete".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { GrpcFrameDecoder } from '../../src/decode/decoders.mjs';
import { createProtoFeatureExtractor, PROTO_FEATURES_SCHEMA, PROTO_FEATURES_VERSION } from '../../src/decode/proto-features.mjs';
import { StreamReducer } from '../../src/replay/reducer.mjs';
import { classifyStreamRole, EVIDENCE_FEATURES } from '../../src/replay/stream-role.mjs';
import { derive } from '../../src/replay/derive.mjs';
import { dataPaths, ensureDataDirs } from '../../src/config.mjs';
import { ProfileStore } from '../../src/profiles/profiles.mjs';
import { Session } from '../../src/store/session.mjs';
import { ScopedLearner } from '../../src/intel/learn.mjs';
import { runScoreboard, sessionRef } from '../../scripts/categorization-scoreboard.mjs';

// ---- tiny protobuf / envelope encoder (test only) -----------------------------------------------------
function vbytes(n) { let x = BigInt(n); const out = []; do { let b = Number(x & 0x7fn); x >>= 7n; if (x) b |= 0x80; out.push(b); } while (x); return Buffer.from(out); }
const cat = (...parts) => Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p))));
const tag = (no, wt) => vbytes((BigInt(no) << 3n) | BigInt(wt));
const vint = (no, v) => cat(tag(no, 0), vbytes(v));
const ld = (no, payload) => { const p = Buffer.from(payload); return cat(tag(no, 2), vbytes(p.length), p); };
// Strings start with 'l' (0x6c) so they never parse as nested messages (same convention as the decoder tests).
const str = (no, s) => ld(no, Buffer.from(s, 'utf8'));
function frame(flags, payload) { const p = Buffer.from(payload); const h = Buffer.alloc(5); h[0] = flags; h.writeUInt32BE(p.length, 1); return Buffer.concat([h, p]); }

const SENTINEL = 'lSENTINELtext';
const MIME = 'application/connect+proto';
const body = (i, extra = '') => cat(str(1, `${SENTINEL}-${i}${extra}`), vint(2, i));
const decodeAll = (mime, buf, opts = {}) => { const d = new GrpcFrameDecoder({ mime, ...opts }); return { d, evs: [...d.push(buf), ...d.end()] }; };
const dataEvents = (evs) => evs.filter((e) => e.type === 'grpc.frame');
const size = (o) => JSON.stringify(o).length;

// ---- raw records -> reducer -----------------------------------------------------------------------------
function rawOf(streams) {
  const recs = []; let seq = 1; let t = 1000;
  for (const { sid, mime = MIME, chunks, url = `https://api.example.test/${sid}`, method = 'POST' } of streams) {
    recs.push({ k: 'req', sid, seq: seq++, t: t++, url, method, type: 'Fetch' });
    recs.push({ k: 'res', sid, seq: seq++, t: t++, status: 200, mime, protocol: 'h2' });
    for (const c of chunks) recs.push({ k: 'chunk', sid, seq: seq++, t: t++, b64: Buffer.from(c).toString('base64') });
    recs.push({ k: 'done', sid, seq: seq++, t: t++, encodedDataLength: 1 });
  }
  return recs;
}
const splitBuf = (buf, n) => { const k = Math.ceil(buf.length / n); return Array.from({ length: n }, (_, i) => buf.subarray(i * k, (i + 1) * k)).filter((b) => b.length); };
function replay(streams, opts) { const r = new StreamReducer(opts); r.ingestAll(rawOf(streams)); return r; }
const rowOf = (r, sid) => r.summary({ includeStreamRoles: true }).streams.find((s) => s.sid === sid);

// =====================================================================================================
// decoder
// =====================================================================================================
test('decoder: a compact feature snapshot rides on protobuf-path events only, and legacy fields are untouched', () => {
  const json = frame(0, Buffer.from(JSON.stringify({ a: 1 })));          // JSON data frame (no proto mime -> skipped)
  const buf = Buffer.concat([frame(0, body(1)), frame(1, zlib.gzipSync(body(2))), json, frame(0x80, Buffer.from('grpc-status: 0\r\n'))]);
  const { d, evs } = decodeAll('application/grpc', buf);
  const [f1, f2, j, tr] = evs;
  for (const e of [f1, f2]) {
    assert.equal(e.protoFeatures.schema, PROTO_FEATURES_SCHEMA);
    assert.equal(e.protoFeatures.version, PROTO_FEATURES_VERSION);
    assert.equal(e.proto.ok, true);
  }
  assert.equal(f2.compression, 'gzip');
  assert.equal(f2.protoFeatures.frame.status, 'analyzed', 'the inflated body is analyzed, not the compressed bytes');
  assert.equal('protoFeatures' in j, false, 'a JSON data frame is not a protobuf frame');
  assert.equal(j.json.a, 1);
  assert.equal('protoFeatures' in tr, false, 'trailers are untouched');
  assert.deepEqual(tr.trailers, { 'grpc-status': '0' });
  // legacy fields exactly as before (the snapshot is purely additive)
  const bare = (e) => { const { protoFeatures, ...rest } = e; return rest; };
  assert.deepEqual(bare(f1).proto.strings, [{ path: '1', text: `${SENTINEL}-1` }]);
  assert.deepEqual(bare(f1).span, [0, 5 + body(1).length]);
  assert.equal(bare(f1).size, body(1).length);
  assert.equal(bare(f1).compressed, false);
  assert.ok(d._pf, 'one extractor exists for this decoder');
});

test('decoder: a JSON-only gRPC / Connect stream never creates an extractor', () => {
  const buf = Buffer.concat([frame(0, Buffer.from('{"hello":"world"}')), frame(0, Buffer.from('{"n":2}')), frame(2, Buffer.from('{}'))]);
  const { d, evs } = decodeAll('application/connect+json', buf);
  assert.equal(d._pf, null);
  assert.ok(evs.every((e) => !('protoFeatures' in e)));
  assert.equal(evs[0].json.hello, 'world');
});

test('decoder: payloads split across chunks, duplicated legitimate frames and growing strings are observed, not interpreted', () => {
  const whole = Buffer.concat([frame(0, body(1)), frame(0, body(1)), frame(0, cat(str(1, 'lalpha'))), frame(0, cat(str(1, 'lalpha beta'))), frame(0, cat(str(1, 'lalpha beta gamma')))]);
  const d = new GrpcFrameDecoder({ mime: MIME });
  const evs = [];
  for (const piece of splitBuf(whole, 7)) evs.push(...d.push(piece));   // frames straddle chunk boundaries
  evs.push(...d.end());
  const snaps = evs.map((e) => e.protoFeatures);
  assert.equal(snaps.length, 5);
  const last = snaps.at(-1);
  assert.equal(last.cumulative.analyzed, 5);
  assert.equal(last.cumulative.identicalTransitions, 1, 'a duplicated frame is a legitimate equal transition, counted once, never deduplicated');
  assert.ok(last.cumulative.prefixExtensions >= 2, 'growth of a string field is OBSERVED');
  assert.equal(last.integrity.completeProof, false);
  assert.equal(last.integrity.incomplete, false);
  // observation only: no dialect, no role, no text anywhere in the field
  assert.ok(!JSON.stringify(snaps).includes('alpha'));
  assert.ok(!('dialect' in last) && !('role' in last));
});

test('decoder: snapshot size is constant, so the events dataset does not grow quadratically', () => {
  const frames = Array.from({ length: 300 }, (_, i) => frame(0, cat(str(1, `lrow-${i}-${'x'.repeat(i % 40)}`), vint(2, i), ld(3, cat(str(1, `lnested-${i}`))))));
  const { evs } = decodeAll(MIME, Buffer.concat(frames));
  const first = size(evs[0].protoFeatures); const last = size(evs.at(-1).protoFeatures);
  assert.ok(first < 1400, `first snapshot ${first} bytes`);
  assert.ok(last - first < 220, `snapshot grew ${last - first} bytes over 300 frames (digits only)`);
  assert.ok(!('paths' in evs.at(-1).protoFeatures) && !JSON.stringify(evs.at(-1).protoFeatures).includes('lrow'));
  assert.deepEqual(Object.keys(evs[0].protoFeatures).sort(), ['cumulative', 'frame', 'integrity', 'schema', 'version']);
});

test('decoder: corrupt, undecodable, oversize and trailing partial frames are incomplete, never "complete protobuf"', () => {
  const corrupt = frame(0, Buffer.from([0x0a, 0xff, 0xff, 0xff]));                    // truncated length-delimited field
  const undecodable = frame(1, Buffer.from('this is not compressed data'));            // compressed flag, no inflater accepts it
  const partial = frame(0, body(9)).subarray(0, 9);                                    // a frame cut mid-payload
  const d = new GrpcFrameDecoder({ mime: MIME });
  const evs = [...d.push(Buffer.concat([frame(0, body(1)), corrupt, undecodable, partial])), ...d.end()];
  const [ok, bad, und, part] = evs;
  assert.equal(ok.protoFeatures.frame.status, 'analyzed');
  assert.equal(bad.proto.ok, false);
  assert.equal(bad.protoFeatures.frame.status, 'corrupt');
  assert.equal(und.proto.reason, 'undecodable');
  assert.equal(und.protoFeatures.frame.status, 'incomplete');
  assert.equal(part.type, 'grpc.partial');
  assert.equal(part.incomplete, true, 'the legacy partial marker is preserved');
  assert.equal(part.protoFeatures.frame.status, 'incomplete');
  const s = part.protoFeatures;
  assert.equal(s.cumulative.corrupt, 1);
  assert.equal(s.cumulative.incomplete, 2);
  assert.equal(s.cumulative.analyzed, 1);
  assert.equal(s.integrity.incomplete, true);
  // oversize under the live cap is an incomplete record, not an analyzed one
  const capped = decodeAll(MIME, frame(0, body(3, 'x'.repeat(200))), { jsonMaxBytes: 64 }).evs[0];
  assert.equal(capped.proto.reason, 'oversize');
  assert.equal(capped.protoFeatures.frame.status, 'incomplete');
  assert.equal(capped.protoFeatures.cumulative.analyzed, 0);
  // a trailing partial in a stream with NO protobuf frame creates no extractor and no feature field
  const lone = decodeAll(MIME, frame(0, body(1)).subarray(0, 6));
  assert.equal(lone.d._pf, null);
  assert.ok(!('protoFeatures' in lone.evs[0]));
});

test('decoder: two decoders never share extractor state', () => {
  const a = new GrpcFrameDecoder({ mime: MIME }); const b = new GrpcFrameDecoder({ mime: MIME });
  const ea = [...a.push(frame(0, body(1))), ...a.push(frame(0, body(2)))];
  const eb = [...b.push(frame(0, body(7)))];
  assert.equal(ea.at(-1).protoFeatures.cumulative.analyzed, 2);
  assert.equal(eb[0].protoFeatures.cumulative.analyzed, 1);
  assert.notStrictEqual(a._pf, b._pf);
  assert.deepEqual([...b.push(frame(0, body(8)))][0].protoFeatures.cumulative.analyzed, 2);
  assert.equal(a.push(frame(0, body(3)))[0].protoFeatures.cumulative.analyzed, 3, 'unaffected by the other decoder');
});

// =====================================================================================================
// reducer -> classifier (the role stays unknown; coverage says what was analyzed)
// =====================================================================================================
test('reducer: a protobuf stream is structural binary coverage with role unknown, in summary rows and streamRole()', () => {
  const frames = Array.from({ length: 6 }, (_, i) => frame(0, cat(str(1, `lalpha ${'beta '.repeat(i)}`), vint(2, i))));
  const r = replay([{ sid: 'p1', chunks: splitBuf(Buffer.concat(frames), 5) }]);
  const row = rowOf(r, 'p1');
  assert.equal(row.role, 'unknown', 'prefix-growing strings in a protobuf field are NOT a chat reply');
  const b = row.roleCoverage.binary;
  assert.equal(b.kind, 'structural');
  assert.equal(b.complete, true);
  assert.equal(b.featureEvents, 6);
  assert.equal(b.frames.analyzed, 6);
  assert.deepEqual(b.versions, [PROTO_FEATURES_VERSION]);
  assert.ok(row.roleEvidence.some((e) => e.feature === 'binary_structural_frames' && e.count === 6));
  assert.ok(!row.roleEvidence.some((e) => e.feature === 'delta_growth_steps'));
  assert.equal(row.roleCoverage.inspectionCut, false);
  assert.deepEqual(r.streamRole('p1').coverage.binary, b);
  assert.ok(row.roleEvidence.every((e) => EVIDENCE_FEATURES.includes(e.feature)));
  // the new field is NOT in a default summary
  assert.ok(!('roleCoverage' in r.summary().streams[0]));
});

test('reducer: a corrupt frame and a trailing partial make the same stream incomplete, still unknown', () => {
  const corrupt = frame(0, Buffer.from([0x0a, 0xff, 0xff, 0xff]));
  const tail = frame(0, body(9)).subarray(0, 8);
  const r = replay([{ sid: 'p2', chunks: [Buffer.concat([frame(0, body(1)), frame(0, body(2)), corrupt, tail])] }]);
  const row = rowOf(r, 'p2');
  assert.equal(row.role, 'unknown');
  assert.equal(row.roleCoverage.binary.kind, 'structural');
  assert.equal(row.roleCoverage.binary.complete, false);
  assert.equal(row.roleCoverage.binary.frames.corrupt, 1);
  assert.equal(row.roleCoverage.binary.frames.incomplete, 1);
  assert.equal(row.roleCoverage.inspectionCut, true);
  assert.equal(row.roleCoverage.fullyInspected, false);
  assert.ok(row.roleEvidence.some((e) => e.feature === 'binary_incomplete_frames' && e.count === 2));
});

test('reducer: all-undecodable binary frames are opaque, not structural', () => {
  const r = replay([{ sid: 'p3', chunks: [Buffer.concat([frame(1, Buffer.from('garbage-1')), frame(1, Buffer.from('garbage-2'))])] }]);
  const row = rowOf(r, 'p3');
  assert.equal(row.role, 'unknown');
  assert.equal(row.roleCoverage.binary.kind, 'opaque');
  assert.equal(row.roleCoverage.binary.complete, false);
  assert.equal(row.roleCoverage.binary.frames.analyzed, 0);
});

test('reducer: a JSON gRPC stream keeps its JSON path (no features) and a decoder-level cap is reported, not hidden', () => {
  const r = replay([{ sid: 'j1', mime: 'application/connect+json', chunks: [Buffer.concat([frame(0, Buffer.from('{"a":1}')), frame(0, Buffer.from('{"a":2}'))])] }]);
  const row = rowOf(r, 'j1');
  assert.equal(row.roleCoverage.binary.kind, null);
  assert.equal(row.roleCoverage.binary.featureEvents, 0);
  assert.ok(r.eventsOf('j1').every((e) => !('protoFeatures' in e)));
});

test('contract: the classifier accepts only the producer\'s own schema+version constants', () => {
  const evs = dataEvents(decodeAll(MIME, Buffer.concat([frame(0, body(1)), frame(0, body(2))])).evs);
  const input = (mutate) => ({ summary: { decoder: 'grpc', events: 2, bytes: 40 }, events: evs.map((e) => ({ ...e, protoFeatures: mutate(e.protoFeatures) })) });
  assert.equal(classifyStreamRole(input((p) => p)).coverage.binary.kind, 'structural');
  for (const mutate of [(p) => ({ ...p, version: PROTO_FEATURES_VERSION + 1 }), (p) => ({ ...p, schema: 'proto-features/99' }), (p) => ({ ...p, version: '1' })]) {
    const c = classifyStreamRole(input(mutate)).coverage.binary;
    assert.equal(c.kind, 'opaque');
    assert.equal(c.complete, false);
    assert.equal(c.featureEvents, 0);
  }
});

// =====================================================================================================
// derive (existing events dataset + STREAM_ROLES) and the scoreboard
// =====================================================================================================
function env(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'proto-int-'));
  const paths = dataPaths(root); ensureDataDirs(paths);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, paths, profile: new ProfileStore(paths.profiles).load('generic'), learner: new ScopedLearner(path.join(root, 'learner')) };
}

test('derive: snapshots persist in the existing events dataset and the coverage in STREAM_ROLES; no new artifact', async (t) => {
  const e = env(t);
  const frames = Array.from({ length: 4 }, (_, i) => frame(0, cat(str(1, `lrow-${i}`), vint(2, i))));
  const s = Session.create(e.paths.sessions, { site: 'proto-int' });
  for (const rec of rawOf([{ sid: 'p9', chunks: [Buffer.concat(frames), frame(0, Buffer.from([0x0a, 0xff, 0xff, 0xff]))] }])) s.raw.append(rec);
  await s.raw.close();
  await derive(s, e.profile, { learner: e.learner });
  const rows = []; for await (const ev of s.dataset('events').iterate()) rows.push(ev);
  const withFeatures = rows.filter((x) => x.protoFeatures);
  assert.equal(withFeatures.length, 5);
  assert.ok(withFeatures.every((x) => x.protoFeatures.schema === PROTO_FEATURES_SCHEMA && size(x.protoFeatures) < 1500));
  const doc = s.kv.get('STREAM_ROLES');
  const row = doc.streams.find((x) => x.sid === 'p9');
  assert.equal(row.role, 'unknown');
  assert.equal(row.roleCoverage.binary.kind, 'structural');
  assert.equal(row.roleCoverage.binary.complete, false, 'the corrupt frame keeps it incomplete');
  assert.equal(row.roleCoverage.binary.frames.analyzed, 4);
  assert.equal(doc.totals.inspectionCut, 1);
  assert.ok(row.roleEvidence.every((x) => EVIDENCE_FEATURES.includes(x.feature)));
});

test('scoreboard: structural-complete / structural-incomplete / opaque binary streams are tallied, all unknown, no coverage claimed', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'proto-sb-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sessionsDir = path.join(root, 'data', 'sessions'); mkdirSync(sessionsDir, { recursive: true });
  const mk = (id, streams) => {
    const dir = path.join(sessionsDir, id); mkdirSync(path.join(dir, 'raw'), { recursive: true }); mkdirSync(path.join(dir, 'kv'), { recursive: true });
    writeFileSync(path.join(dir, 'session.json'), JSON.stringify({ id, site: 'synthetic', status: 'complete', createdAt: '2026-01-01T00:00:00.000Z', target: { url: 'https://api.example.test/app' } }));
    writeFileSync(path.join(dir, 'raw', '000001.jsonl'), rawOf(streams).map((r) => JSON.stringify(r)).join('\n') + '\n');
  };
  const ok = Buffer.concat([frame(0, body(1)), frame(0, body(2))]);
  mk('syn-pb-complete', [{ sid: 'a', chunks: [ok] }]);
  mk('syn-pb-incomplete', [{ sid: 'a', chunks: [Buffer.concat([ok, frame(0, Buffer.from([0x0a, 0xff, 0xff, 0xff]))])] }]);
  mk('syn-pb-opaque', [{ sid: 'a', chunks: [Buffer.concat([frame(1, Buffer.from('garbage-1')), frame(1, Buffer.from('garbage-2'))])] }]);
  const { report } = await runScoreboard({ dataDir: path.join(root, 'data') });
  const kinds = (id) => report.sessions.find((x) => x.ref === sessionRef(id)).role.binaryKinds;
  assert.deepEqual(kinds('syn-pb-complete'), { 'structural-complete': 1 });
  assert.deepEqual(kinds('syn-pb-incomplete'), { 'structural-incomplete': 1 });
  assert.deepEqual(kinds('syn-pb-opaque'), { opaque: 1 });
  const m = report.aggregate.measures.role;
  assert.deepEqual(m.binaryKinds, { 'structural-complete': 1, 'structural-incomplete': 1, opaque: 1 });
  assert.equal(m.streamsRawSpecific, 0, 'binary structure yields no role candidate');
  assert.equal(m.streamsFullyInspectedSpecific, 0);
  assert.equal(m.streamsInspectionCutUnknown, 2, 'incomplete and opaque binary streams are inspection cuts; the complete one is not');
  assert.equal(m.streamsUnknown + m.streamsWithheld + m.streamsTruncated, m.streams);
  assert.equal(JSON.stringify(report).includes('SENTINEL'), false);
});

// =====================================================================================================
// measured synthetic overhead (reported, nothing asserted about speed)
// =====================================================================================================
test('overhead report: decoder with features vs the extractor alone, 2000 synthetic frames', (t) => {
  const frames = Array.from({ length: 2000 }, (_, i) => frame(0, cat(str(1, `lrow-${i}-${'x'.repeat(i % 30)}`), vint(2, i))));
  const buf = Buffer.concat(frames);
  const time = (fn) => { const t0 = performance.now(); fn(); return performance.now() - t0; };
  let evs;
  const decoderMs = time(() => { evs = decodeAll(MIME, buf).evs; });
  const payloads = frames.map((f) => f.subarray(5));
  const extractorMs = time(() => { const x = createProtoFeatureExtractor(); for (const p of payloads) x.add(p); x.snapshot(); });
  const eventBytes = size(evs.map((e) => ({ ...e, protoFeatures: undefined })));
  const featureBytes = size(evs.map((e) => e.protoFeatures));
  const line = `2000 frames: decoder incl. features ${decoderMs.toFixed(1)} ms; extractor alone ${extractorMs.toFixed(1)} ms (a second protobuf parse per frame); snapshot bytes ${featureBytes} vs other event bytes ${eventBytes}`;
  t.diagnostic(line);
  console.log(`# ${line}`);
  assert.equal(evs.length, 2000);
});
