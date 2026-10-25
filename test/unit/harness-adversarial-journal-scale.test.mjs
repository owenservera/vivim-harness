// Adversarial: durable multi-turn journal at scale, recovery boundaries and file identity.
//
// Findings encoded here (exact source lines):
//  F7 src/capture/thread-turn-journal.mjs:168-179  load() re-reads, re-parses and FULLY re-validates
//     the whole snapshot on every operation; save() (180-198) validates the whole snapshot again,
//     re-stringifies it and fsyncs twice. read() calls load() too, so even a read-only snapshot costs
//     O(turns) synchronous validation. Per-turn cost therefore grows with thread history (O(n^2) over
//     a whole thread) and blocks the event loop; recordReply() is called for EVERY streaming update
//     (src/capture/conversation-runtime.mjs:158), i.e. several times per second during a reply.
//  F8 src/capture/thread-turn-journal.mjs:161-162,165  the only tenant separator is
//     sha256(canonicalThreadKey) as a flat file name. Namespace/origin/thread are inside the key, so
//     files cannot collide, but nothing partitions a directory per owner and MAX_TURNS=1000 (line 53)
//     is a hard per-thread ceiling with no eviction: the 1001st reservation fails JOURNAL_LIMIT.
//  F9 src/capture/thread-turn-journal.mjs:237  load() on open is fail-closed with NO recovery write;
//     startup never rewrites phases. A truncated/corrupt or semantically invalid store is rejected
//     (CORRUPT_OR_UNREADABLE_JOURNAL) even when its checksum is recomputed.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createThreadTurnJournal, canonicalThreadKey } from '../../src/capture/thread-turn-journal.mjs';

const UUID = '11111111-1111-4111-8111-111111111111';
const THREAD = { kind: 'chatgpt-c', id: UUID, ref: `chatgpt-c:${UUID}` };
const sha = (v) => createHash('sha256').update(v).digest('hex');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'adv-journal-'));
const at = '2026-10-25T00:00:00.000Z';

// A resolved (blocked) turn: cheapest legal state, so scale tests measure journal mechanics, not
// evidence plumbing.
function blockedTurn(i, overrides = {}) {
  const turnId = `turn-${i}`, payloadDigest = sha(`payload-${i}`);
  return {
    id: turnId, key: `key-${i}`, conversationId: 'conv', payloadDigest, revision: 3, phase: 'blocked',
    boundary: null, delivery: { state: 'unknown', evidence: null }, reply: { state: 'unknown', evidence: null },
    completion: { state: 'unknown', evidence: null }, readiness: { state: 'unknown', evidence: null },
    preEffect: { turnId, payloadDigest, kind: 'pre-effect-blocked', source: 'actuator-audit', reference: `ref-${i}`,
      typing: 'not-executed', dispatch: 'not-executed' },
    reason: null, createdAt: at, updatedAt: at, ...overrides,
  };
}
function snapshotOf(turns, overrides = {}) {
  const key = canonicalThreadKey({ namespace: 'ns', origin: 'https://chatgpt.com', thread: THREAD });
  return { version: 2, threadKey: key, admissionMode: 'interactive-ready',
    revision: turns.reduce((n, t) => n + t.revision, 0), createdAt: at, updatedAt: at, turns, ...overrides };
}
function writeEnvelope(dir, snapshot, checksum = sha(JSON.stringify(snapshot))) {
  const key = canonicalThreadKey({ namespace: 'ns', origin: 'https://chatgpt.com', thread: THREAD });
  const file = path.join(dir, `${sha(key)}.turn-journal.json`);
  fs.writeFileSync(file, `${JSON.stringify({ checksum, snapshot })}\n`);
  return file;
}
const open = (dir, extra = {}) => createThreadTurnJournal({ dataDir: dir, namespace: 'ns', origin: 'https://chatgpt.com', thread: THREAD, ...extra });

test('F8/F7: a 1000-turn journal is readable, refuses eviction, and pays a synchronous read cost', (t) => {
  const dir = tmp();
  try {
    const turns = Array.from({ length: 1000 }, (_, i) => blockedTurn(i));
    const snapshot = snapshotOf(turns);
    const file = writeEnvelope(dir, snapshot);
    const journal = open(dir);
    assert.equal(journal.read().turns.length, 1000);

    const started = performance.now();
    for (let i = 0; i < 5; i++) journal.read();
    const readMs = (performance.now() - started) / 5;
    t.diagnostic(`read() over 1000 turns: ${readMs.toFixed(1)}ms per call (synchronous), file ${fs.statSync(file).size}B`);
    assert.ok(readMs < 2000, `read() at 1000 turns took ${readMs.toFixed(1)}ms`);

    // No eviction, no rotation, no silent downgrade: the ceiling is a hard error.
    assert.throws(() => journal.reserve({ key: 'key-overflow', payloadDigest: sha('x'), conversationId: 'conv' }), /JOURNAL_LIMIT/);
    assert.equal(fs.readFileSync(file, 'utf8').includes('key-overflow'), false, 'a refused reservation writes nothing');
    assert.equal(journal.read().turns.length, 1000);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('F9: corrupt or semantically inconsistent stores fail closed even with a valid checksum', (t) => {
  const dir = tmp();
  try {
    // 1. Empty file: never treated as a fresh journal.
    writeEnvelope(dir, snapshotOf([]));
    const file = path.join(dir, `${sha(canonicalThreadKey({ namespace: 'ns', origin: 'https://chatgpt.com', thread: THREAD }))}.turn-journal.json`);
    fs.writeFileSync(file, '');
    assert.throws(() => open(dir), /CORRUPT_OR_UNREADABLE_JOURNAL/);

    // 2. Snapshot revision disagrees with the sum of turn revisions (accepted checksum).
    const mismatch = snapshotOf([blockedTurn(0)], { revision: 99 });
    writeEnvelope(dir, mismatch);
    assert.throws(() => open(dir), /CORRUPT_OR_UNREADABLE_JOURNAL/);

    // 3. Duplicate turn ids or keys are rejected, never de-duplicated.
    const dupIds = snapshotOf([blockedTurn(0), blockedTurn(1, { id: 'turn-0' })]);
    writeEnvelope(dir, dupIds);
    assert.throws(() => open(dir), /CORRUPT_OR_UNREADABLE_JOURNAL/);
    const dupKeys = snapshotOf([blockedTurn(0), blockedTurn(1, { key: 'key-0' })]);
    writeEnvelope(dir, dupKeys);
    assert.throws(() => open(dir), /CORRUPT_OR_UNREADABLE_JOURNAL/);

    // 4. A blocked turn must carry a valid pre-effect proof and no delivery evidence.
    const badProof = snapshotOf([blockedTurn(0, { preEffect: { ...blockedTurn(0).preEffect, typing: 'executed' } })]);
    writeEnvelope(dir, badProof);
    assert.throws(() => open(dir), /CORRUPT_OR_UNREADABLE_JOURNAL/);

    // 5. Reopening a good store performs no recovery write (mtime and bytes unchanged).
    const good = writeEnvelope(dir, snapshotOf([blockedTurn(0)]));
    const before = fs.readFileSync(good, 'utf8'), beforeStat = fs.statSync(good);
    const journal = open(dir);
    journal.read();
    assert.equal(fs.readFileSync(good, 'utf8'), before);
    assert.equal(fs.statSync(good).mtimeMs, beforeStat.mtimeMs);

    // 6. Leftover atomic-replacement temp files are ignored, never adopted.
    fs.writeFileSync(`${good}.${randomUUID()}.tmp`, '{"checksum":"garbage"}');
    assert.equal(open(dir).read().turns.length, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('F8: thread identity decides the file; unrelated threads and namespaces never share one', (t) => {
  const dir = tmp();
  try {
    const other = { kind: 'chatgpt-c', id: '22222222-2222-4222-8222-222222222222', ref: 'chatgpt-c:22222222-2222-4222-8222-222222222222' };
    const a = open(dir);
    const b = createThreadTurnJournal({ dataDir: dir, namespace: 'ns', origin: 'https://chatgpt.com', thread: other });
    const c = createThreadTurnJournal({ dataDir: dir, namespace: 'other', origin: 'https://chatgpt.com', thread: THREAD });
    assert.equal(new Set([a.file, b.file, c.file]).size, 3);
    const r = a.reserve({ key: 'k', payloadDigest: sha('p'), conversationId: 'conv' });
    assert.equal(r.admitted, true);
    assert.equal(b.read().turns.length, 0);
    assert.equal(c.read().turns.length, 0);
    assert.equal(fs.readdirSync(dir).filter((f) => f.endsWith('.turn-journal.json')).length, 1, 'reads never create files');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('F7: per-operation cost grows with history for both read and streaming reply writes', (t) => {
  const rows = [];
  for (const size of [10, 30, 70]) {
    const dir = tmp();
    try {
      const journal = open(dir);
      const fillStarted = performance.now();
      for (let i = 0; i < size; i++) {
        const payloadDigest = sha(`p-${i}`);
        const r = journal.reserve({ key: `k-${i}`, payloadDigest, conversationId: 'conv' });
        journal.provePreEffect({ turnId: r.turn.id, expectedRevision: r.turn.revision, evidence: { turnId: r.turn.id, payloadDigest,
          kind: 'pre-effect-blocked', source: 'actuator-audit', reference: `ref-${i}`, typing: 'not-executed', dispatch: 'not-executed' } });
      }
      const fillMs = performance.now() - fillStarted;

      const readStarted = performance.now();
      for (let i = 0; i < 5; i++) journal.read();
      const readMs = (performance.now() - readStarted) / 5;

      // One streaming reply turn on top of the filled history: every distinct chunk is a journal write.
      const payloadDigest = sha('stream');
      const reserved = journal.reserve({ key: 'stream', payloadDigest, conversationId: 'conv' });
      const turnId = reserved.turn.id;
      let turn = journal.markTyping({ turnId, expectedRevision: reserved.turn.revision, boundary: { sessionId: 's1', sequence: 5, transcriptCount: 0 } });
      turn = journal.markDispatching({ turnId, expectedRevision: turn.revision });
      turn = journal.observeDelivery({ turnId, expectedRevision: turn.revision, evidence: { turnId, payloadDigest, sessionId: 's1',
        kind: 'new-user-turn', source: 'page', identity: 'u-new', sequence: 6 } });
      let seq = 6;
      const writeStarted = performance.now();
      for (let chunk = 1; chunk <= 5; chunk++) {
        const text = `chunk ${chunk} `.repeat(50);
        turn = journal.recordReply({ turnId, expectedRevision: turn.revision, evidence: { turnId, payloadDigest, sessionId: 's1',
          kind: 'assistant-reply', source: 'page', identity: 'a-new', revision: chunk, contentDigest: sha(text), chars: text.length, sequence: ++seq } });
      }
      const writeMs = (performance.now() - writeStarted) / 5;
      const file = path.join(dir, `${sha(canonicalThreadKey({ namespace: 'ns', origin: 'https://chatgpt.com', thread: THREAD }))}.turn-journal.json`);
      rows.push({ turns: size + 1, fillMs: +fillMs.toFixed(0), readMs: +readMs.toFixed(1), streamingWriteMs: +writeMs.toFixed(1),
        fileBytes: fs.statSync(file).size });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
  for (const r of rows) t.diagnostic(`turns=${r.turns} fill=${r.fillMs}ms read=${r.readMs}ms streamingReplyWrite=${r.streamingWriteMs}ms store=${r.fileBytes}B`);
  const [small, , large] = rows;
  // Deterministic evidence: save() rewrites (and re-fsyncs) the ENTIRE snapshot for every mutation, so
  // the bytes written per streaming chunk track the whole thread's size, not the chunk's size.
  assert.ok(large.fileBytes > small.fileBytes * 3, `store grew ${small.fileBytes} -> ${large.fileBytes}B, so each chunk rewrites the whole history`);
  // Relative wall-clock ratios vary with scheduling and filesystem caches; report them above,
  // but use the deterministic file-size assertion for growth and an absolute stall budget here.
  assert.ok(rows.every((r) => Number.isFinite(r.readMs) && r.readMs < 2000), 'journal reads stay within the stall budget');
  // Absolute tripwire: a single synchronous streaming write must not stall the loop for seconds.
  assert.ok(large.streamingWriteMs < 3000, `streaming write at ${large.turns} turns took ${large.streamingWriteMs}ms`);
});
