// Focused evidence-preservation tests. Local temp files only: no browser, provider, network or
// process. The checkpoint is an observation of existing private files; it never grants acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { captureConversationEvidence, evidenceFileFor, EVIDENCE_SCHEMA } from '../../src/capture/conversation-evidence.mjs';
import { canonicalThreadKey } from '../../src/capture/thread-turn-journal.mjs';
import { createConversationRuntime } from '../../src/capture/conversation-runtime.mjs';

const sha = (v) => createHash('sha256').update(v).digest('hex');
const uuid = '11111111-1111-4111-8111-111111111111';
const thread = { kind: 'chatgpt-c', id: uuid, ref: `chatgpt-c:${uuid}` };
const ID = 'ev-test-conversation';
const TURN = 'turn-1';
const SESSION = '20261025-112739-chatgpt-57cc52';
const AT = '2026-10-25T11:27:39.920Z';
const LATER = '2026-10-25T11:27:43.771Z';
const text = 'ChatGPT said:\nInput Output\nBound Applied';
const replyEvidence = { turnId: TURN, payloadDigest: sha('prompt'), sessionId: SESSION, sequence: 31,
  kind: 'assistant-reply', source: 'page', identity: 'a1', revision: 1, contentDigest: sha(text), chars: text.length };
const delivery = { turnId: TURN, payloadDigest: sha('prompt'), sessionId: SESSION, sequence: 30,
  kind: 'new-user-turn', source: 'page', identity: 'u1' };

function view(overrides = {}) {
  return { id: ID, revision: 7, state: 'ready', site: 'chatgpt', sessionId: SESSION,
    identity: { state: 'bound', reason: null },
    binding: { targetId: 'tab', origin: 'https://chatgpt.com', ownedByStudio: false, thread },
    capture: { state: 'idle', integrity: null, bytesWritten: 42, limitReason: null, endsAt: LATER },
    finish: { requested: true, phase: 'done', error: null },
    diagnostic: { uncertainty: null }, writer: { active: false, releaseError: null },
    createdAt: AT, updatedAt: LATER, limitations: ['Page observations are not acceptance'],
    attempts: [{ id: TURN, key: 'key-1', payloadDigest: sha('prompt'), phase: 'observed', createdAt: AT, updatedAt: LATER,
      boundary: { sequence: 10, transcriptCount: 2 }, send: { state: 'observed', evidence: delivery },
      reply: { state: 'ready', text, chars: text.length, completion: 'unknown', evidence: replyEvidence },
      journal: { id: TURN, key: 'key-1', conversationId: ID, payloadDigest: sha('prompt'), revision: 4, phase: 'delivered',
        boundary: { sessionId: SESSION, sequence: 10, transcriptCount: 2 }, delivery: { state: 'observed', evidence: delivery },
        reply: { state: 'observed', evidence: replyEvidence }, readiness: { state: 'ready', evidence: { ...replyEvidence,
          kind: 'interactive-ready', source: 'adapter', sequence: 33, samples: [], controls: { observed: true, state: 'idle' } } },
        completion: { state: 'unknown', evidence: null }, reason: null, createdAt: AT, updatedAt: LATER } }],
    ...overrides };
}

function journal() {
  return { version: 2, threadKey: canonicalThreadKey({ namespace: 'local-owner', origin: 'https://chatgpt.com', thread }),
    admissionMode: 'interactive-ready', revision: 5, createdAt: AT, updatedAt: LATER, turns: view().attempts.map((a) => a.journal) };
}

function fixture(t, { withSession = true, sessionId = SESSION, viewOverrides = {}, journalValue } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'conversation-evidence-'));
  const paths = { root, sessions: path.join(root, 'sessions') };
  const directory = path.join(root, 'conversations');
  fs.mkdirSync(directory, { recursive: true });
  const conversationFile = path.join(directory, `${ID}.conversation.json`);
  fs.writeFileSync(conversationFile, `${JSON.stringify(view(viewOverrides), null, 2)}\n`);
  const t0 = t;
  if (t0?.after) t0.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const j = journalValue === undefined ? journal() : journalValue;
  if (j) {
    const name = `${sha(canonicalThreadKey({ namespace: 'local-owner', origin: 'https://chatgpt.com', thread }))}.turn-journal.json`;
    fs.mkdirSync(path.join(directory, 'thread-turns'), { recursive: true });
    fs.writeFileSync(path.join(directory, 'thread-turns', name), `${JSON.stringify({ checksum: sha(JSON.stringify(j)), snapshot: j }, null, 2)}\n`);
  }
  if (withSession) {
    const dir = path.join(paths.sessions, sessionId);
    fs.mkdirSync(path.join(dir, 'raw'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'datasets'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'kv'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'session.json'), `${JSON.stringify({ id: sessionId, site: 'chatgpt', createdAt: AT, endedAt: LATER,
      status: 'complete', endReason: 'conversation_turn', target: { id: 'tab', url: `https://chatgpt.com/c/${uuid}` },
      conversationOwner: { conversationId: ID, pid: 1, port: 9222 }, integrity: { ok: true }, stats: { raw: { records: 4, bytes: 99 },
        network: { requests: 2, streamed: 1, chunks: 3, armFailed: 1, retrospective: 1 }, dom: { batches: 2, mutations: 3, agentStarts: 1 } } }, null, 2)}\n`);
    const raw = '{"seq":1,"k":"dom.turns"}\n';
    fs.writeFileSync(path.join(dir, 'raw', '000001.jsonl'), raw);
    fs.writeFileSync(path.join(dir, 'raw', 'manifest.json'), `${JSON.stringify({ format: 'aion-capture-raw/2', segments: [{ file: '000001.jsonl', bytes: raw.length, records: 1, firstSeq: 1, lastSeq: 1, sha256: sha(raw) }] })}\n`);
    fs.writeFileSync(path.join(dir, 'datasets', 'timeline.jsonl'), '{"seq":1}\n');
    fs.writeFileSync(path.join(dir, 'kv', 'DOM_TURNS.json'), `${JSON.stringify([{ turnId: 'dom-1', text }])}\n`);
  }
  return { root, paths, directory, conversationFile };
}

const call = (f, opts = {}) => captureConversationEvidence({ directory: f.directory, id: ID, view: view(opts.viewOverrides),
  journal: opts.journal ?? journal(), journalError: opts.journalError ?? null, trigger: opts.trigger ?? 'finish', paths: f.paths, ...opts });

test('success: exact snapshot/journal/session pointers, revisions, turn identity, timing and honest unknown coverage', (t) => {
  const f = fixture(t);
  const out = call(f);
  assert.equal(out.skipped, undefined);
  assert.equal(out.turns, 1); assert.equal(out.sessions, 1);
  assert.deepEqual(out.coverage, { ui: 'unknown', knowledge: 'unknown', outcome: 'unknown' });
  const file = evidenceFileFor(f.directory, ID);
  assert.equal(fs.existsSync(file), true);
  const e = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(e.schema, EVIDENCE_SCHEMA); assert.equal(e.revision, 1); assert.equal(e.trigger, 'finish');
  assert.equal(e.conversation.revision, 7); assert.equal(e.conversation.sessionId, SESSION);
  assert.equal(e.conversation.snapshot.sha256, sha(fs.readFileSync(f.conversationFile)));
  assert.equal(e.conversation.binding.thread.ref, thread.ref);
  assert.equal(e.journal.state, 'present'); assert.equal(e.journal.revision, 5);
  assert.match(e.journal.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(e.turns.map((x) => x.id), [TURN]);
  assert.equal(e.turns[0].delivery.evidence.sequence, 30);
  assert.equal(e.turns[0].reply.evidence.contentDigest, sha(text));
  assert.equal(e.sessions[0].present, true); assert.equal(e.sessions[0].sessionId, SESSION);
  assert.equal(e.sessions[0].meta.endReason, 'conversation_turn');
  assert.equal(e.sessions[0].raw.segments[0].sha256, sha('{"seq":1,"k":"dom.turns"}\n'));
  assert.equal(e.sessions[0].datasets[0].name, 'timeline'); assert.match(e.sessions[0].datasets[0].sha256, /^[a-f0-9]{64}$/);
  assert.equal(e.sessions[0].kv.some((k) => k.key === 'DOM_TURNS'), true);
  assert.equal(e.coverage.ui.state, 'unknown'); assert.equal(e.coverage.knowledge.state, 'unknown');
  assert.equal(e.coverage.outcome.state, 'unknown'); assert.equal(e.coverage.outcome.reason, 'CAPTURE_COMPLETION_IS_NOT_ACCEPTANCE');
  assert.equal(e.coverage.reconstruction.state, 'local-pointers');
  assert.ok(e.gaps.some((g) => g.code === 'REPLY_COMPLETION_UNKNOWN'));
  assert.ok(e.gaps.some((g) => g.code === 'READINESS_READY_WITH_COMPLETION_UNKNOWN'));
  assert.equal(e.failures.length, 0);
  assert.equal(e.history.length, 1);
  assert.equal(JSON.stringify(e).includes('Page observations are not acceptance'), true);
});

test('incomplete capture is preserved as incomplete: not-ready reply, recording capture, missing session and explicit gaps', (t) => {
  const f = fixture(t, { withSession: false });
  const v = view();
  v.capture = { ...v.capture, state: 'recording' };
  v.attempts[0].reply = { state: 'waiting', text: '', chars: 0, completion: 'unknown' };
  v.attempts[0].journal.reply = { state: 'unknown', evidence: null };
  v.attempts[0].journal.readiness = { state: 'unknown', evidence: null };
  const j = journal(); j.turns = v.attempts.map((a) => a.journal);
  const out = call(f, { viewOverrides: v, journal: j, trigger: 'turn' });
  assert.equal(out.skipped, undefined);
  const e = JSON.parse(fs.readFileSync(out.file, 'utf8'));
  assert.equal(e.conversation.capture.state, 'recording');
  assert.equal(e.conversation.finish.phase, 'done');
  assert.equal(e.sessions[0].present, false); assert.equal(e.sessions[0].reason, 'SESSION_DIRECTORY_MISSING');
  const codes = e.gaps.map((g) => g.code);
  assert.ok(codes.includes('REPLY_NOT_OBSERVED'));
  assert.ok(codes.includes('CAPTURE_NOT_IDLE_AT_PRESERVATION'));
  assert.ok(codes.includes('SESSION_EVIDENCE_MISSING'));
  assert.equal(e.coverage.outcome.state, 'unknown', 'capture state cannot become acceptance');
});

test('missing data still writes an honest checkpoint and records each failure', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'conversation-evidence-missing-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, 'conversations');
  fs.mkdirSync(directory, { recursive: true });
  const v = { id: ID, revision: 0, state: 'disconnected', site: 'chatgpt', sessionId: null, identity: { state: 'unbound', reason: 'NOT_CONNECTED' },
    binding: null, capture: { state: 'incomplete' }, finish: { requested: false, phase: 'idle', error: null },
    createdAt: AT, updatedAt: AT, attempts: [], limitations: [] };
  const out = captureConversationEvidence({ directory, id: ID, paths: { root }, view: v, journal: null,
    journalError: { code: 'THREAD_IDENTITY_UNVERIFIED', message: 'no bound thread' }, trigger: 'finish' });
  const e = JSON.parse(fs.readFileSync(out.file, 'utf8'));
  const codes = e.gaps.map((g) => g.code);
  assert.ok(codes.includes('NO_CAPTURED_TURN_OR_SESSION')); assert.ok(codes.includes('JOURNAL_REFERENCE_UNAVAILABLE'));
  assert.ok(e.failures.some((x) => x.code === 'THREAD_IDENTITY_UNVERIFIED'));
  assert.equal(e.sessions.length, 0); assert.equal(e.coverage.reconstruction.state, 'unavailable');
});

test('same fingerprint is skipped (bounded writes); a later revision writes a new checkpoint', (t) => {
  const f = fixture(t);
  const first = call(f, { trigger: 'turn' });
  const second = call(f, { trigger: 'turn' });
  assert.equal(second.skipped, true); assert.equal(second.revision, first.revision);
  const changed = view({ revision: 8 }); changed.finish = { requested: true, phase: 'done', error: null };
  const third = captureConversationEvidence({ directory: f.directory, id: ID, view: changed, journal: journal(), trigger: 'finish', paths: f.paths });
  assert.equal(third.revision, 2);
  const e = JSON.parse(fs.readFileSync(third.file, 'utf8'));
  assert.equal(e.history.length, 2);
});

test('oversized files keep the pointer but no digest (bounded hashing)', (t) => {
  const f = fixture(t);
  const big = path.join(f.paths.sessions, SESSION, 'datasets', 'big.jsonl');
  fs.writeFileSync(big, 'x'.repeat(64));
  const out = captureConversationEvidence({ directory: f.directory, id: ID, view: view(), journal: journal(),
    trigger: 'finish', paths: f.paths, limits: { maxHashBytes: 8 } });
  const e = JSON.parse(fs.readFileSync(out.file, 'utf8'));
  const dataset = e.sessions[0].datasets.find((d) => d.name === 'big');
  assert.equal(dataset.sha256, null); assert.equal(dataset.reason, 'HASH_SIZE_CAP'); assert.ok(dataset.bytes >= 64);
});

test('evidence write failure is thrown for the caller to account and never leaves a checkpoint', (t) => {
  const f = fixture(t);
  const io = { ...fs, mkdirSync() { throw Object.assign(new Error('disk full'), { code: 'EACCES' }); } };
  assert.throws(() => captureConversationEvidence({ directory: f.directory, id: ID, view: view(), journal: journal(),
    trigger: 'finish', paths: f.paths, io }), /disk full/);
  assert.equal(fs.existsSync(evidenceFileFor(f.directory, ID)), false);
});

// Runtime integration: the checkpoint is automatic and additive, but can never change lifecycle truth.
function runtimeFixture(t, { evidenceFails = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'conversation-evidence-runtime-'));
  const paths = { root, sessions: path.join(root, 'sessions') };
  fs.mkdirSync(paths.sessions, { recursive: true });
  const site = { id: 'chatgpt', url: 'https://chatgpt.com/' };
  const calls = [];
  const dependencies = {
    leaseRoot: path.join(root, 'leases'), listSessions: () => [],
    getAdapter: async (value) => value === 'chatgpt' || String(value).startsWith('https://chatgpt.com') ? site : null,
    listTargets: async () => [{ id: 'selected', type: 'page', url: `https://chatgpt.com/c/${uuid}` }],
    ...(evidenceFails ? { captureEvidence: async () => { throw Object.assign(new Error('evidence disk failed'), { code: 'EACCES' }); } } : {}),
    createAdapter() {
      let sessions = 0;
      const adapter = { mayOwnResources: false, bytesWritten: 0, integrity: null, active: false,
        async connect(binding) { adapter.binding = binding; return { binding, sessionId: null, deferredCapture: true }; },
        async armCapture() { adapter.active = true; adapter.sessionId = `session-${++sessions}`;
          fs.mkdirSync(path.join(paths.sessions, adapter.sessionId, 'raw'), { recursive: true });
          fs.writeFileSync(path.join(paths.sessions, adapter.sessionId, 'session.json'), JSON.stringify({ id: adapter.sessionId, site: 'chatgpt', status: 'complete', createdAt: AT, endedAt: LATER }));
          return adapter.sessionId; },
        async stopTurnCapture() { adapter.active = false; },
        async preflight(binding) { return { binding, draft: { present: false, chars: 0 }, boundary: { sequence: 10, transcriptCount: 0 } }; },
        async type() { calls.push('type'); },
        async submit(args) { calls.push('submit'); return { binding: args.binding, evidence: { ...args, sessionId: adapter.sessionId, sequence: 11, kind: 'new-user-turn', source: 'page', identity: `user-${args.turnId}` } }; },
        async reconcile() { return null; },
        async readReply(onUpdate, args) {
          const answer = 'answer 1', contentDigest = sha(answer);
          const evidence = { turnId: args.turnId, payloadDigest: args.payloadDigest, sessionId: adapter.sessionId, sequence: 14,
            kind: 'assistant-reply', source: 'page', identity: `reply-${args.turnId}`, revision: 1, contentDigest, chars: answer.length };
          const update = { turnId: args.turnId, binding: adapter.binding, state: 'ready', text: answer, evidence,
            readiness: { ...evidence, kind: 'interactive-ready', source: 'adapter', rule: 'chatgpt-controls-idle', ruleVersion: 1,
              threadKey: canonicalThreadKey({ namespace: 'local-owner', origin: adapter.binding.origin, thread: adapter.binding.thread }),
              boundarySequence: 10, samples: [{ sequence: 14, identity: `reply-${args.turnId}`, revision: 1, contentDigest, chars: answer.length },
                { sequence: 15, identity: `reply-${args.turnId}`, revision: 1, contentDigest, chars: answer.length }], sequence: 15,
              controls: { observed: true, state: 'idle', idleControlPresent: true, stopPresent: false, composerEnabled: true } } };
          await onUpdate?.(update); return update;
        },
        stopWaiting() {}, async stop() {}, async closeTab() {} };
      return adapter;
    },
  };
  const runtime = createConversationRuntime({ paths, port: 19244, dependencies });
  t.after(async () => { await runtime.close().catch(() => {}); fs.rmSync(root, { recursive: true, force: true }); });
  const settle = async (id) => {
    for (let n = 0; n < 500; n++) { const c = await runtime.get(id);
      if (c.turn?.reply.state === 'ready' && c.capture.state === 'idle' && c.writer.active === false) return c;
      await new Promise(setImmediate); }
    throw new Error('did not settle');
  };
  return { runtime, paths, calls, settle, root };
}

test('runtime: automatic checkpoint after turn finalization and finish records the native turn and session', async (t) => {
  const f = runtimeFixture(t);
  const c = await f.runtime.connect({ site: 'chatgpt', targetId: 'selected' });
  await f.runtime.submit(c.id, { key: 'k1', prompt: 'hello', confirm: true, expectedRevision: c.revision });
  const sent = await f.settle(c.id);
  assert.equal(sent.evidence.state, 'preserved');
  const file = path.join(f.paths.root, 'conversations', `${c.id}.evidence.json`);
  assert.equal(fs.existsSync(file), true);
  const afterTurn = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(afterTurn.trigger, 'turn');
  assert.deepEqual(afterTurn.turns.map((x) => x.id), [sent.turn.id]);
  assert.equal(afterTurn.sessions[0].sessionId, 'session-1'); assert.equal(afterTurn.sessions[0].present, true);
  assert.equal(afterTurn.coverage.outcome.state, 'unknown');
  const finished = await f.runtime.finish(c.id, { closeTab: false });
  assert.equal(finished.diagnostic.finishPhase, 'done');
  assert.equal(finished.evidence.state, 'preserved');
  const afterFinish = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(afterFinish.trigger, 'finish');
  assert.equal(afterFinish.conversation.finish.phase, 'done');
  assert.equal(Array.isArray(afterFinish.failures), true);
  assert.equal(f.calls.filter((x) => x === 'submit').length, 1, 'evidence never resends');
});

test('runtime: an evidence write failure is reported honestly and cannot alter capture/finish or trigger a resend', async (t) => {
  const f = runtimeFixture(t, { evidenceFails: true });
  const c = await f.runtime.connect({ site: 'chatgpt', targetId: 'selected' });
  await f.runtime.submit(c.id, { key: 'k1', prompt: 'hello', confirm: true, expectedRevision: c.revision });
  const sent = await f.settle(c.id);
  assert.equal(sent.evidence.state, 'failed'); assert.equal(sent.evidence.code, 'EACCES');
  assert.equal(sent.state, 'ready'); assert.equal(sent.capture.state, 'idle'); assert.equal(sent.turn.reply.state, 'ready');
  const finished = await f.runtime.finish(c.id, { closeTab: false });
  assert.equal(finished.diagnostic.finishPhase, 'done'); assert.equal(finished.evidence.state, 'failed');
  assert.equal(f.calls.filter((x) => x === 'submit').length, 1, 'no resend after an evidence failure');
  assert.equal(fs.existsSync(path.join(f.paths.root, 'conversations', `${c.id}.evidence.json`)), false);
});
