// Issue #84 Round C: genuine multi-turn lifecycle in the canonical conversation service, with the real
// thread-turn journal and a fake adapter. Offline fixtures only: no browser, no provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createConversationService } from '../../src/capture/conversation-service.mjs';

const sha = (v) => createHash('sha256').update(v).digest('hex');
const thread = { kind: 'chatgpt-c', id: '11111111-1111-4111-8111-111111111111', ref: 'chatgpt-c:11111111-1111-4111-8111-111111111111' };
const binding = { targetId: 'exact-target', origin: 'https://chatgpt.com', ownedByStudio: true, thread };
const IDLE = { observed: true, state: 'idle', idleControlPresent: true, stopPresent: false, composerEnabled: true };
const rejects = (promise, code) => assert.rejects(promise, (e) => e.code === code);
const cursor = (messageCount, seq = 10) => ({ messageCount, userCount: Math.floor(messageCount / 2), assistantCount: Math.floor(messageCount / 2),
  idsDigest: sha('ids' + messageCount), contentDigest: sha('content' + messageCount), streamSequence: seq });

function fixture(t, overrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conversation-multiturn-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const calls = [], state = { sessions: 0, session: null, messages: 2, deliver: true, preflightError: null, preflightBinding: null };
  let sendArgs;
  const adapter = {
    async connect(b) { calls.push('connect'); return { binding: { ...b }, deferredCapture: true, sessionId: null, readiness: { ready: true, draft: { present: false, chars: 0 }, reason: null } }; },
    async armCapture() { calls.push('armCapture'); state.session = `session-${++state.sessions}`; return state.session; },
    async preflight(b, options) {
      calls.push(options?.readOnly ? 'preflight-readonly' : 'preflight');
      if (state.preflightError) throw Object.assign(new Error(state.preflightError), { code: state.preflightError });
      return { binding: state.preflightBinding ?? { ...b }, draft: { present: false, chars: 0 }, boundary: { sequence: 10, transcriptCount: state.messages }, cursor: cursor(state.messages) };
    },
    async type(args) { calls.push('type'); },
    async submit(args) { calls.push('submit'); sendArgs = args;
      return state.deliver ? { binding: { ...binding }, evidence: { turnId: args.turnId, payloadDigest: args.payloadDigest, sessionId: state.session, sequence: 11, kind: 'new-user-turn', source: 'page', identity: `user-${args.turnId}` } } : null; },
    async reconcile() { calls.push('reconcile'); return null; },
    async stop() { calls.push('stop'); },
    ...overrides,
  };
  const service = createConversationService({ dataDir, id: 'multi', adapter });
  const connect = () => service.connect({ ...binding, expectedRevision: service.read().revision });
  const submit = (key, prompt = 'prompt') => service.submit({ key, prompt, confirm: true, expectedRevision: service.read().revision });
  // The runtime's job after a finalized reply: record the attributed reply + readiness, stop the turn capture.
  async function finalize(turn, text = 'answer') {
    const contentDigest = sha(text), metadata = { identity: `reply-${turn.id}`, revision: 1, contentDigest, chars: text.length };
    const sessionId = state.session, sequence = 14;
    const evidence = { turnId: turn.id, payloadDigest: turn.payloadDigest, sessionId, sequence, kind: 'assistant-reply', source: 'page', ...metadata };
    const readiness = { ...evidence, kind: 'interactive-ready', source: 'adapter', rule: 'chatgpt-controls-idle', ruleVersion: 1, threadKey: service.threadKey(),
      boundarySequence: 10, samples: [{ sequence, ...metadata }, { sequence: sequence + 1, ...metadata }], sequence: sequence + 1, controls: IDLE };
    await service.recordReply({ turnId: turn.id, binding: { ...binding }, text, state: 'ready', evidence, readiness });
    await service.recordCapture({ state: 'idle' });
    state.messages += 2;
  }
  return { service, adapter, calls, state, connect, submit, finalize, sent: () => sendArgs };
}

test('two turns in ONE conversation, ONE native thread, ONE journal: new turn id, key, session and cursor each turn', async (t) => {
  const f = fixture(t); await f.connect();
  const one = await f.submit('key-1', 'first'); assert.equal(one.send.state, 'observed');
  await f.finalize(one);
  const two = await f.submit('key-2', 'second'); assert.equal(two.send.state, 'observed');
  await f.finalize(two, 'second answer');
  assert.notEqual(one.id, two.id); assert.notEqual(one.key, two.key);
  assert.notEqual(one.journal.boundary.sessionId, two.journal.boundary.sessionId);
  const view = f.service.read();
  assert.deepEqual(view.attempts.map((a) => a.key), ['key-1', 'key-2']);
  assert.equal(view.attempts[0].cursor.messageCount, 2); assert.equal(view.attempts[1].cursor.messageCount, 4, 'turn 2 baseline includes turn 1 user+assistant');
  assert.deepEqual(view.binding.thread, thread, 'exact native identity unchanged');
  assert.equal(view.attempts.every((a) => a.reply.state === 'ready' && a.journal.conversationId === 'multi'), true);
  const journal = f.service.journalSnapshot();
  assert.equal(journal.turns.length, 2); assert.deepEqual(journal.turns.map((x) => x.id), [one.id, two.id]);
  assert.deepEqual(f.calls.filter((c) => c === 'submit').length, 2);
  assert.equal(f.calls.filter((c) => c === 'armCapture').length, 2, 'a fresh capture per turn');
  assert.equal(JSON.stringify(view).includes('"first"'), false, 'no prompt text in the journal-backed view');
});

test('identical prompt text on a later turn is a NEW turn with its own key; the old key still replays turn 1 without a resend', async (t) => {
  const f = fixture(t); await f.connect();
  const one = await f.submit('key-1', 'same text'); await f.finalize(one);
  const two = await f.submit('key-2', 'same text');
  assert.notEqual(two.id, one.id); assert.equal(two.payloadDigest, one.payloadDigest);
  await f.finalize(two);
  const sends = f.calls.filter((c) => c === 'submit').length;
  assert.equal((await f.submit('key-1', 'same text')).id, one.id, 'replay returns the ORIGINAL turn, never turn 2');
  assert.equal(f.calls.filter((c) => c === 'submit').length, sends);
  await rejects(f.submit('key-1', 'different text'), 'IDEMPOTENCY_CONFLICT');
});

test('turn 2 is refused until turn 1 reply is finalized (journal fence); nothing is typed or sent', async (t) => {
  const f = fixture(t); await f.connect();
  await f.submit('key-1', 'first'); // delivered, reply not finalized
  const typed = f.calls.filter((c) => c === 'type').length;
  await rejects(f.submit('key-2', 'second'), 'THREAD_FENCED');
  assert.equal(f.calls.filter((c) => c === 'type').length, typed); assert.equal(f.calls.filter((c) => c === 'submit').length, 1);
  assert.equal(f.service.read().attempts.length, 1);
});

test('an uncertain send locks the next turn until reconciled and is never auto-resent', async (t) => {
  const f = fixture(t); f.state.deliver = false; await f.connect();
  const one = await f.submit('key-1', 'first'); assert.equal(one.send.state, 'uncertain');
  assert.equal(f.service.read().state, 'needs-reconciliation');
  await rejects(f.submit('key-2', 'second'), 'THREAD_FENCED');
  // Re-checking read-only finds nothing: still locked, still one send.
  await f.service.reconcile({ expectedRevision: f.service.read().revision });
  await rejects(f.submit('key-3', 'third'), 'THREAD_FENCED');
  assert.equal(f.calls.filter((c) => c === 'submit').length, 1); assert.equal(f.calls.filter((c) => c === 'type').length, 1);
  assert.equal(f.calls.includes('preflight-readonly'), false, 'an unresolved turn is observed, not treated as a readiness check');
});

test('uncertain lock lifts only after delivery is observed AND the reply is finalized', async (t) => {
  const f = fixture(t); f.state.deliver = false; await f.connect();
  const one = await f.submit('key-1', 'first');
  f.adapter.reconcile = async () => ({ binding: { ...binding }, evidence: { turnId: one.id, payloadDigest: one.payloadDigest, sessionId: f.state.session, sequence: 11, kind: 'new-user-turn', source: 'page', identity: 'user-found' } });
  const checked = await f.service.reconcile({ expectedRevision: f.service.read().revision, turnId: one.id });
  assert.equal(checked.attempts[0].send.state, 'observed');
  await rejects(f.submit('key-2', 'second'), 'THREAD_FENCED'); // delivered but reply not yet finalized
  await f.finalize(checked.attempts[0]);
  f.state.deliver = true;
  assert.equal((await f.submit('key-2', 'second')).send.state, 'observed');
});

test('native thread changed between turns: turn 2 is blocked pre-effect with a durable proof; turn 1 is untouched', async (t) => {
  const f = fixture(t); await f.connect();
  const one = await f.submit('key-1', 'first'); await f.finalize(one);
  f.state.preflightError = 'BINDING_CHANGED';
  await rejects(f.submit('key-2', 'second'), 'PREFLIGHT_FAILED');
  const view = f.service.read();
  assert.equal(view.attempts[1].phase, 'blocked'); assert.equal(view.attempts[1].reason, 'BINDING_CHANGED'); assert.equal(view.attempts[1].send.state, 'not-attempted');
  assert.equal(view.attempts[1].journal.preEffect.typing, 'not-executed'); assert.equal(view.readiness.ready, false);
  assert.equal(f.calls.filter((c) => c === 'type').length, 1, 'only turn 1 typed'); assert.equal(f.calls.filter((c) => c === 'submit').length, 1);
  assert.equal(view.attempts[0].send.state, 'observed'); assert.equal(view.attempts[0].reply.state, 'ready');
  // A different thread reported by the adapter is the same refusal.
  f.state.preflightError = null; f.state.preflightBinding = { ...binding, thread: { ...thread, id: '22222222-2222-4222-8222-222222222222', ref: 'chatgpt-c:22222222-2222-4222-8222-222222222222' } };
  await rejects(f.submit('key-3', 'third'), 'DRAFT_OR_BINDING_NOT_READY');
  assert.equal(f.calls.filter((c) => c === 'type').length, 1);
});

test('history shrinking between turns (edit/branch/regenerate removed messages) blocks the next turn pre-effect', async (t) => {
  const f = fixture(t); await f.connect();
  const one = await f.submit('key-1', 'first'); await f.finalize(one);
  f.state.messages = 2; // the page now shows fewer messages than turn 1 alone must have left behind (>= 4)
  await rejects(f.submit('key-2', 'second'), 'THREAD_CHANGED_BETWEEN_TURNS');
  const second = f.service.read().attempts[1];
  assert.equal(second.phase, 'blocked'); assert.equal(second.reason, 'THREAD_CHANGED_BETWEEN_TURNS'); assert.equal(second.journal.preEffect.dispatch, 'not-executed');
  assert.equal(f.calls.filter((c) => c === 'type').length, 1); assert.equal(f.calls.filter((c) => c === 'submit').length, 1);
});

test('the next turn requires the previous capture to have been cleanly stopped', async (t) => {
  const f = fixture(t); await f.connect();
  const one = await f.submit('key-1', 'first'); await f.finalize(one);
  await f.service.recordCapture({ state: 'incomplete' }); // runtime could not confirm the per-turn stop
  await rejects(f.submit('key-2', 'second'), 'PRIOR_TURN_CAPTURE_NOT_FINALIZED');
  assert.equal(f.calls.filter((c) => c === 'type').length, 1); assert.equal(f.service.read().attempts.length, 1);
});

test('after a completed turn, an unscoped Check again is a read-only readiness check for the NEXT turn', async (t) => {
  const f = fixture(t); await f.connect();
  const one = await f.submit('key-1', 'first'); await f.finalize(one);
  const checked = await f.service.reconcile({ expectedRevision: f.service.read().revision });
  assert.equal(checked.state, 'ready'); assert.equal(checked.readiness.ready, true);
  assert.equal(f.calls.at(-1), 'preflight-readonly'); assert.equal(f.calls.includes('reconcile'), false);
  assert.equal(f.calls.filter((c) => c === 'type').length, 1, 'no typing'); assert.equal(f.calls.filter((c) => c === 'armCapture').length, 1, 'no capture armed');
  f.adapter.preflight = async (b) => ({ binding: { ...b, targetId: 'other' }, draft: { present: false, chars: 0 }, boundary: { sequence: 0, transcriptCount: 0 } });
  const moved = await f.service.reconcile({ expectedRevision: f.service.read().revision });
  assert.equal(moved.state, 'blocked'); assert.equal(moved.readiness.reason, 'BINDING_CHANGED');
  // An explicit turn id still uses the observation path, never the readiness path.
  await f.service.reconcile({ expectedRevision: f.service.read().revision, turnId: one.id });
  assert.equal(f.calls.at(-1), 'reconcile');
});

test('restart: a reloaded conversation keeps both turns and still fences an unresolved one', async (t) => {
  const f = fixture(t); await f.connect();
  const one = await f.submit('key-1', 'first'); await f.finalize(one);
  const two = await f.submit('key-2', 'second'); // delivered, reply never finalized
  const reopened = createConversationService({ dataDir: f.service.file.replace(/[^\\/]+$/, ''), id: 'multi', adapter: f.adapter, context: { restarted: true } });
  assert.equal(reopened.read().attempts.length, 2);
  await assert.rejects(reopened.submit({ key: 'key-3', prompt: 'third', confirm: true, expectedRevision: reopened.read().revision }), (e) => ['THREAD_FENCED', 'THREAD_IDENTITY_UNVERIFIED'].includes(e.code));
  assert.equal(f.calls.filter((c) => c === 'submit').length, 2);
  assert.equal(two.send.state, 'observed');
});
