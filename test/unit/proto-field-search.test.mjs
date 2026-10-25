// Unit tests for scripts/proto-field-search.mjs. Synthetic sessions only, built in temp data
// directories. Nothing here reads the owner's real data. Assertions are by property.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, statSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  runSearch, searchSession, aggregate, StreamDecoder, tokenDice, UsageError, STRING_CAP, FRAME_CAP,
} from '../../scripts/proto-field-search.mjs';
import { joinStreamToDom, normalizeForJoin } from '../../src/intel/join.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(here, '..', '..', 'scripts', 'proto-field-search.mjs');
const URL_WITH_QUERY = 'https://chat.example.test/backend-api/conversation/c1?token=SYN-QUERY-TOKEN-123';

// Synthetic reply words. None of them may reach the report.
const SNAP_WORDS = ['Quokka', 'lighthouse', 'marmalade', 'harbour', 'northern', 'bay',
  'tides', 'drift', 'slowly', 'past', 'copper', 'meadows'];
const SNAP_TEXT = SNAP_WORDS.join(' ');
const DELTA_PIECES = SNAP_WORDS.map((w, i) => (i < SNAP_WORDS.length - 1 ? `${w} ` : w));
const SPLIT_PIECES = ['Quokka ', 'Harbour ', 'lighthouse ', 'northern ', 'marmalade ', 'bay'];
const SPLIT_TEXT = SPLIT_PIECES.join('');
const FORBIDDEN = ['quokka', 'lighthouse', 'marmalade', 'harbour', 'northern', 'copper', 'meadows',
  'slowly', 'SYN-QUERY-TOKEN', 'backend-api', '/c/'];

// ---------------------------------------------------------------------------------------------
// Minimal protobuf / envelope encoder (test-only), same style as test/unit/protobuf.test.mjs
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
function frame(flags, payload) {
  const p = Buffer.from(payload);
  const h = Buffer.alloc(5);
  h[0] = flags;
  h.writeUInt32BE(p.length, 1);
  return Buffer.concat([h, p]);
}

// Reply shape: 1 -> { 2 -> { <field> string, 1 varint }, 5 string (noise), 9 varint }.
// Every message level has two or more fields, so it decodes as a message, not an ambiguous string.
function replyPayload(field, text, n) {
  const inner = cat(str(field, text), vint(1, 0));
  return msg(1, cat(msg(2, inner), str(5, 'conv-7f3a'), vint(9, n)));
}

// Cycle through compression methods: raw, gzip, zlib deflate, raw deflate, brotli.
const COMP = [
  (p) => [0x00, p],
  (p) => [0x01, zlib.gzipSync(p)],
  (p) => [0x01, zlib.deflateSync(p)],
  (p) => [0x01, zlib.deflateRawSync(p)],
  (p) => [0x01, zlib.brotliCompressSync(p)],
];
function encodeFrame(k, payload) {
  const [flags, body] = COMP[k % COMP.length](payload);
  return frame(flags, body);
}

// Cumulative snapshots at path 1.2.3, one garbage compressed frame, one end-of-stream control frame.
function snapshotStream() {
  const frames = [];
  SNAP_WORDS.forEach((_, k) => {
    frames.push(encodeFrame(k, replyPayload(3, SNAP_WORDS.slice(0, k + 1).join(' '), k)));
    if (k === 3) frames.push(frame(0x01, Buffer.from([0x1f, 0x8b, 0x08, 0x00]))); // truncated gzip header
  });
  frames.push(frame(0x02, Buffer.from('{}')));
  return cat(...frames);
}

// Append-only deltas at path 1.2.3.
function deltaStream() {
  return cat(...DELTA_PIECES.map((piece, k) => encodeFrame(k, replyPayload(3, piece, k))));
}

// The reply split across paths 1.2.4 and 1.2.5 in alternating frames.
function splitStream() {
  return cat(...SPLIT_PIECES.map((piece, k) => frame(0x00, replyPayload(k % 2 === 0 ? 4 : 5, piece, k))));
}

// ---------------------------------------------------------------------------------------------
// Session fixtures
// ---------------------------------------------------------------------------------------------
const turn = (index, id, role, text) => ({ index, id, domId: `dom-${id}`, role, text, blocks: [] });

function streamRecords(sid, mime, { bytes = null, chunkSize = 0, body = null }) {
  const out = [
    { k: 'req', sid, url: URL_WITH_QUERY, method: 'POST', type: 'Fetch' },
    { k: 'res', sid, status: 200, mime },
  ];
  if (body) {
    out.push({ k: 'body', sid, n: body.length, b64: body.toString('base64') });
  } else {
    for (let i = 0; i < bytes.length; i += chunkSize) {
      const part = bytes.subarray(i, i + chunkSize);
      out.push({ k: 'chunk', sid, n: part.length, b64: part.toString('base64') });
    }
  }
  out.push({ k: 'done', sid });
  return out;
}

function writeSession(sessionsDir, id, { records = [], domTurns = null, corruptMeta = false }) {
  const dir = path.join(sessionsDir, id);
  mkdirSync(path.join(dir, 'raw'), { recursive: true });
  mkdirSync(path.join(dir, 'kv'), { recursive: true });
  if (corruptMeta) {
    writeFileSync(path.join(dir, 'session.json'), '{"id": ');
    return;
  }
  writeFileSync(path.join(dir, 'session.json'), JSON.stringify({
    id, site: 'synthetic', createdAt: '2026-01-01T00:00:00.000Z', status: 'complete', target: { url: URL_WITH_QUERY },
  }, null, 2));
  let seq = 0;
  const lines = records.map((r) => JSON.stringify({ seq: ++seq, t: 1000 + seq, ...r }));
  writeFileSync(path.join(dir, 'raw', '000001.jsonl'), lines.join('\n') + (lines.length ? '\n' : ''));
  if (domTurns) writeFileSync(path.join(dir, 'kv', 'DOM_TURNS.json'), JSON.stringify(domTurns, null, 2));
}

function makeEnv(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'proto-field-search-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sessionsDir = path.join(root, 'sessions');
  mkdirSync(sessionsDir, { recursive: true });
  const user = turn(0, 'u1', 'user', 'Synthetic user prompt');
  writeSession(sessionsDir, 'syn-snap', {
    records: [
      ...streamRecords('s-snap', 'application/connect+proto', { bytes: snapshotStream(), chunkSize: 23 }),
      ...streamRecords('s-sse', 'text/event-stream', { bytes: Buffer.from('data: {}\n\n'), chunkSize: 4 }),
    ],
    domTurns: [user, turn(1, 'a1', 'assistant', SNAP_TEXT)],
  });
  writeSession(sessionsDir, 'syn-delta', {
    records: streamRecords('s-delta', 'application/connect+proto', { bytes: deltaStream(), chunkSize: 31 }),
    domTurns: [user, turn(1, 'a2', 'assistant', SNAP_TEXT)],
  });
  // Body fallback: this stream has no chunk records, only one body record.
  writeSession(sessionsDir, 'syn-split', {
    records: streamRecords('s-split', 'application/grpc+proto', { body: splitStream() }),
    domTurns: [user, turn(1, 'a3', 'assistant', SPLIT_TEXT)],
  });
  writeSession(sessionsDir, 'syn-no-dom', {
    records: streamRecords('s-x', 'application/connect+proto', { bytes: deltaStream(), chunkSize: 64 }),
    domTurns: [user],
  });
  writeSession(sessionsDir, 'syn-no-proto', {
    records: streamRecords('s-y', 'text/event-stream', { bytes: Buffer.from('data: {}\n\n'), chunkSize: 4 }),
    domTurns: [turn(0, 'a4', 'assistant', SNAP_TEXT)],
  });
  writeSession(sessionsDir, 'syn-zz-corrupt', { corruptMeta: true });
  return { root, sessionsDir };
}

function listTree(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = path.join(d, e.name);
      const st = statSync(p);
      out.push([path.relative(dir, p).split(path.sep).join('/'), e.isDirectory() ? 'dir' : 'file', st.size, st.mtimeMs]);
      if (e.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out;
}

function cli(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', timeout: 120000 });
}

const byId = (report) => Object.fromEntries(report.sessions.map((s) => [s.id, s]));

// ---------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------
test('snapshots: path 1.2.3 ranks first with last or longest at Dice 1; compression methods and the garbage frame are counted', async (t) => {
  const { root } = makeEnv(t);
  const { report, writeDetected } = await runSearch({ dataDir: root, all: true });
  assert.deepEqual(writeDetected, []);
  const s = byId(report)['syn-snap'];
  assert.equal(s.status, 'ok');
  assert.equal(s.streams, 2);
  assert.equal(s.protoStreams, 1);
  assert.equal(s.top[0].path, '1.2.3');
  assert.ok(['last', 'longest'].includes(s.top[0].aggregation), `aggregation ${s.top[0].aggregation}`);
  assert.equal(s.top[0].dice, 1);
  assert.equal(s.streamCoverage, 1);
  assert.ok(s.decompressMethods.gzip >= 1);
  assert.ok(s.decompressMethods.inflate >= 1);
  assert.ok(s.decompressMethods.inflateRaw >= 1);
  assert.ok(s.decompressMethods.brotli >= 1);
  assert.equal(s.framesUndecodable, 1, 'the truncated gzip frame is counted as undecodable');
  assert.equal(s.framesControl, 1);
  assert.equal(s.protoDecodeErrors, 0);
  assert.equal(s.envelopeErrors, 0);
});

test('deltas: path 1.2.3 ranks first with concat at Dice 1 (tie order puts concat before chain and unionAll)', async (t) => {
  const { root } = makeEnv(t);
  const s = byId((await runSearch({ dataDir: root, all: true })).report)['syn-delta'];
  assert.equal(s.status, 'ok');
  assert.equal(s.top[0].path, '1.2.3');
  assert.equal(s.top[0].aggregation, 'concat');
  assert.equal(s.top[0].dice, 1);
  assert.equal(s.top[0].occurrences, DELTA_PIECES.length);
});

test('split reply: no single path reaches the match threshold, and the two-path combination does, in frame order', async (t) => {
  const { root } = makeEnv(t);
  const s = byId((await runSearch({ dataDir: root, all: true })).report)['syn-split'];
  assert.equal(s.status, 'ok');
  assert.ok(s.top[0].dice < 0.95, `best single path ${s.top[0].dice}`);
  assert.deepEqual([...s.bestCombination.paths].sort(), ['1.2.4', '1.2.5']);
  assert.equal(s.bestCombination.dice, 1);
  assert.equal(s.bestCombination.coverage, 1);
  assert.equal(s.streamCoverage, 1);
});

test('verdict and candidate: aggregate counts covered sessions and names the candidate path', async (t) => {
  const { root } = makeEnv(t);
  const { report } = await runSearch({ dataDir: root, all: true });
  const v = report.aggregate.verdict.join('\n');
  assert.ok(v.includes('reply fully covered in stream in 3 of 3 sessions'), v);
  assert.ok(v.includes('reply reconstructed by one path in 2 of 3 sessions'), v);
  assert.ok(v.includes('reply reconstructed only by a path combination in 1 of 3 sessions'), v);
  assert.ok(v.includes('candidate reply field: path 1.2.3'), v);
  assert.equal(report.aggregate.sessionsError, 1);
  assert.equal(report.aggregate.sessionsSkipped, 2);
  assert.equal(report.aggregate.skippedReasons.no_proto_stream, 1);
  assert.equal(report.aggregate.skippedReasons.no_dom_assistant_turn, 1);
});

test('skip rules: a session without an assistant DOM turn or without a protobuf stream is skipped, not errored', async (t) => {
  const { root } = makeEnv(t);
  const { report } = await runSearch({ dataDir: root, all: true });
  const s = byId(report);
  assert.equal(s['syn-no-dom'].status, 'skipped');
  assert.equal(s['syn-no-dom'].reason, 'no_dom_assistant_turn');
  assert.equal(s['syn-no-proto'].status, 'skipped');
  assert.equal(s['syn-no-proto'].reason, 'no_proto_stream');
});

test('undecodable compressed frames are counted, never thrown', () => {
  const seen = [];
  const d = new StreamDecoder({ onString: (_i, p, text) => seen.push([p, text]) });
  d.push(frame(0x01, Buffer.from([0x1f, 0x8b, 0x08, 0x00])));
  d.push(frame(0x00, replyPayload(3, 'Quokka lighthouse', 1)));
  d.end();
  assert.equal(d.stats.framesUndecodable, 1);
  assert.equal(d.stats.framesTotal, 2);
  assert.deepEqual(seen.filter(([p]) => p === '1.2.3'), [['1.2.3', 'Quokka lighthouse']]);
});

test('a trailing incomplete frame at end of stream is counted as undecodable', () => {
  const d = new StreamDecoder({ onString: () => {} });
  const whole = frame(0x00, replyPayload(3, 'Quokka', 1));
  d.push(whole.subarray(0, whole.length - 3));
  d.end();
  assert.equal(d.stats.framesTotal, 0);
  assert.equal(d.stats.framesUndecodable, 1);
});

test('an unknown envelope flag stops the stream and is counted as an envelope error', () => {
  const d = new StreamDecoder({ onString: () => {} });
  d.push(Buffer.from([0x04, 0x00, 0x00, 0x00, 0x00]));
  d.end();
  assert.equal(d.stats.envelopeErrors, 1);
  assert.equal(d.stats.framesTotal, 0);
});

test('strings are capped at STRING_CAP characters and frames at FRAME_CAP per stream', () => {
  const big = 'Quokka '.repeat(Math.ceil((STRING_CAP + 1000) / 7));
  const seen = [];
  const d = new StreamDecoder({ onString: (_i, p, text) => seen.push([p, text.length]) });
  d.push(frame(0x00, msg(1, msg(2, cat(str(3, big), vint(1, 0))))));
  d.end();
  assert.deepEqual(seen, [['1.2.3', STRING_CAP]]);
  assert.equal(d.stats.stringsCapped, 1);

  const many = cat(...Array.from({ length: FRAME_CAP + 1 }, () => frame(0x00, Buffer.alloc(0))));
  const d2 = new StreamDecoder({ onString: () => {} });
  d2.push(many);
  d2.end();
  assert.equal(d2.stats.framesTotal, FRAME_CAP);
  assert.equal(d2.stats.framesCapped, true);
});

test('aggregate with no evaluated sessions reports zero counts and no candidate', () => {
  const agg = aggregate([{ id: 'x', status: 'error', errorClass: 'Error' }]);
  assert.equal(agg.sessionsEvaluated, 0);
  assert.equal(agg.sessionsError, 1);
  assert.equal(agg.verdict[0], 'reply fully covered in stream in 0 of 0 sessions (presence coverage >= 0.95)');
  assert.equal(agg.verdict[3], 'candidate reply field: none');
});

test('tokenDice agrees with the join near_match score (drift guard against join.mjs)', () => {
  const words = Array.from({ length: 40 }, (_, i) => `w${i}x`);
  const a = words.join(' ');
  const b = [...words.slice(0, 39), 'changed'].join(' ');
  const local = tokenDice(normalizeForJoin(a), normalizeForJoin(b));
  assert.equal(local, (2 * 39) / 80);
  const { links } = joinStreamToDom({
    messages: [{ key: 'k1', role: 'assistant', text: a, final: true, blocks: [] }],
    turns: [{ index: 0, role: 'assistant', text: b, blocks: [] }],
  });
  assert.equal(links[0].status, 'near_match');
  const m = /token Dice (\d\.\d{3})/.exec(links[0].evidence.notes.join(' | '));
  assert.ok(m, 'join reports a token Dice in its notes');
  assert.equal(Number(m[1]), Number(local.toFixed(3)));
});

test('the report carries no reply words, no query token and no URL path (in-process and CLI)', async (t) => {
  const { root } = makeEnv(t);
  const { report } = await runSearch({ dataDir: root, all: true });
  const text = JSON.stringify(report).toLowerCase();
  for (const phrase of FORBIDDEN) assert.equal(text.includes(phrase.toLowerCase()), false, `report leaks "${phrase}"`);
  assert.equal(text.includes(root.toLowerCase()), false, 'report must not carry the data directory path');
  const r = cli(['--data-dir', root, '--all', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const out = r.stdout.toLowerCase();
  for (const phrase of FORBIDDEN) assert.equal(out.includes(phrase.toLowerCase()), false, `stdout leaks "${phrase}"`);
  const table = cli(['--data-dir', root, '--all']);
  assert.equal(table.status, 0, table.stderr);
  for (const phrase of FORBIDDEN) assert.equal(table.stderr.toLowerCase().includes(phrase.toLowerCase()), false, `table leaks "${phrase}"`);
  assert.equal(JSON.parse(r.stdout).schema, 'capture-studio.proto-field-search/1');
});

test('the data directory listing is identical before and after the search (in-process and CLI)', async (t) => {
  const { root } = makeEnv(t);
  const before = listTree(root);
  const { writeDetected } = await runSearch({ dataDir: root, all: true });
  assert.deepEqual(writeDetected, []);
  assert.deepEqual(listTree(root), before);
  const r = cli(['--data-dir', root, '--all', '--json']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(listTree(root), before);
});

test('a write during the run is reported as WRITE DETECTED and no report is produced', async (t) => {
  const { root } = makeEnv(t);
  const result = await runSearch({
    dataDir: root, all: true,
    _testHookAfterRead: (dataRoot) => writeFileSync(path.join(dataRoot, 'sessions', 'syn-snap', 'INJECTED.txt'), 'x'),
  });
  assert.equal(result.report, null);
  assert.ok(result.writeDetected.some((w) => w.path === 'syn-snap/INJECTED.txt' && w.change === 'added'));
});

test('--out inside the data directory is refused (in-process and CLI exit 2)', async (t) => {
  const { root } = makeEnv(t);
  const out = path.join(root, 'search.json');
  await assert.rejects(runSearch({ dataDir: root, all: true, out }), UsageError);
  assert.equal(existsSync(out), false);
  const r = cli(['--data-dir', root, '--all', '--out', out]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /inside the data directory/);
  assert.equal(existsSync(out), false);
});

test('a corrupt session yields an error entry while the others still report', async (t) => {
  const { root } = makeEnv(t);
  const { report } = await runSearch({ dataDir: root, all: true });
  const s = byId(report);
  assert.equal(s['syn-zz-corrupt'].status, 'error');
  assert.equal(s['syn-zz-corrupt'].errorClass, 'SyntaxError');
  assert.equal(s['syn-snap'].status, 'ok');
  assert.equal(s['syn-split'].status, 'ok');
  assert.equal(report.aggregate.errorClasses.SyntaxError, 1);
});

test('searchSession on one session reports the same ranking as the full run', async (t) => {
  const { root, sessionsDir } = makeEnv(t);
  const alone = await searchSession(path.join(sessionsDir, 'syn-delta'), 'syn-delta');
  const full = byId((await runSearch({ dataDir: root, all: true })).report)['syn-delta'];
  assert.deepEqual(alone.top, full.top);
  assert.deepEqual(alone.decompressMethods, full.decompressMethods);
});

test('--host filters sessions without reading their raw logs', async (t) => {
  const { root } = makeEnv(t);
  const { report } = await runSearch({ dataDir: root, all: true, host: 'elsewhere.example.test' });
  for (const s of report.sessions) {
    if (s.status === 'error') continue;
    assert.equal(s.status, 'skipped', `${s.id} filtered`);
  }
});
