// Issue #84 Round C: genuine multi-turn through the canonical runtime (service + journal + writer window +
// per-turn capture). Fake adapter only: no browser, no provider, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createConversationRuntime } from '../../src/capture/conversation-runtime.mjs';
import { acquireDriveLease } from '../../src/capture/drive-lease.mjs';
import { canonicalThreadKey } from '../../src/capture/thread-turn-journal.mjs';

const THREAD_ID = '11111111-1111-4111-8111-111111111111';
const sha = (v) => createHash('sha256').update(v).digest('hex');
const IDLE = { observed: true, state: 'idle', idleControlPresent: true, stopPresent: false, composerEnabled: true };

function fixture(t, { stopFails = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'conversation-multiturn-runtime-'));
  const paths = { root, sessions: path.join(root, 'sessions') }, calls = [];
  const site = { id: 'chatgpt', url: 'https://chatgpt.com/' };
  const state = { sessions: 0, deliver: true, stopFails, replies: 0 };
  const dependencies = {
    leaseRoot: path.join(root, 'leases'), listSessions: () => [],
    getAdapter: async (value) => value === 'chatgpt' || String(value).startsWith('https://chatgpt.com') ? site : null,
    listTargets: async () => [{ id: 'selected', type: 'page', url: `https://chatgpt.com/c/${THREAD_ID}` }],
    createAdapter() {
      const adapter = {
        mayOwnResources: false, bytesWritten: 1, integrity: null, active: false,
        async connect(binding) { calls.push('connect'); adapter.binding = binding; return { binding, sessionId: null, deferredCapture: true, readiness: { ready: true, draft: { present: false, chars: 0 }, reason: null } }; },
        async armCapture() { calls.push('armCapture'); adapter.active = true; adapter.sessionId = `session-${++state.sessions}`; return adapter.sessionId; },
        async stopTurnCapture() { calls.push('stopTurnCapture'); if (state.stopFails) throw new Error('stop failed'); adapter.active = false; },
        async preflight(binding, options) { calls.push(options?.readOnly ? 'preflight-readonly' : 'preflight'); return { binding, draft: { present: false, chars: 0 }, boundary: { sequence: 10, transcriptCount: state.sessions * 2 } }; },
        async type() { calls.push('type'); },
        async submit(args) { calls.push('submit'); return state.deliver ? { binding: args.binding, evidence: { ...args, sessionId: adapter.sessionId, sequence: 11, kind: 'new-user-turn', source: 'page', identity: `user-${args.turnId}` } } : null; },
        async reconcile() { calls.push('reconcile'); return null; },
        async readReply(onUpdate, args) {
          calls.push('reply'); const text = `answer ${++state.replies}`, contentDigest = sha(text);
          const metadata = { identity: `reply-${args.turnId}`, revision: 1, contentDigest, chars: text.length }, sequence = 14;
          const evidence = { turnId: args.turnId, payloadDigest: args.payloadDigest, sessionId: adapter.sessionId, sequence, kind: 'assistant-reply', source: 'page', ...metadata };
          const update = { turnId: args.turnId, binding: adapter.binding, state: 'ready', text, evidence, readiness: { ...evidence, kind: 'interactive-ready', source: 'adapter', rule: 'chatgpt-controls-idle', ruleVersion: 1,
            threadKey: canonicalThreadKey({ namespace: 'local-owner', origin: adapter.binding.origin, thread: adapter.binding.thread }), boundarySequence: 10,
            samples: [{ sequence, ...metadata }, { sequence: sequence + 1, ...metadata }], sequence: sequence + 1, controls: IDLE } };
          await onUpdate?.(update); // like the real adapter: the ready sample is published before it returns
          return update;
        },
        stopWaiting() {},
        async stop() { calls.push('stop'); adapter.integrity = { ok: true }; },
        async closeTab() {},
      };
      return adapter;
    },
  };
  const runtime = createConversationRuntime({ paths, port: 19222, dependencies });
  t.after(async () => { await runtime.close().catch(() => {}); fs.rmSync(root, { recursive: true, force: true }); });
  const connect = () => runtime.connect({ site: 'chatgpt', targetId: 'selected' });
  const send = async (id, key, prompt) => runtime.submit(id, { key, prompt, confirm: true, expectedRevision: (await runtime.get(id)).revision });
  // Waits until the last turn's reply is ready AND its per-turn capture work has fully settled.
  const settle = async (id, turns) => {
    for (let n = 0; n < 500; n++) {
      const c = await runtime.get(id);
      if (c.turns.length === turns && c.turn.reply.state === 'ready' && c.capture.state === 'idle' && c.writer.active === false) return c;
      await new Promise(setImmediate);
    }
    throw new Error('did not settle');
  };
  return { runtime, calls, state, connect, send, settle };
}

test('runtime: turn 2 in the same conversation after a safe turn 1; per-turn state and session are not flattened', async (t) => {
  const f = fixture(t), c = await f.connect();
  assert.equal(c.capture.state, 'idle'); assert.equal(c.sessionId, null);
  await f.send(c.id, 'key-1', 'first');
  const one = await f.settle(c.id, 1);
  assert.equal(one.capture.state, 'idle', 'turn capture stopped and finalized before the next turn');
  assert.equal(one.turn.readiness.state, 'ready'); assert.equal(one.turn.sessionId, 'session-1');
  assert.deepEqual(one.binding.thread.ref, `chatgpt-c:${THREAD_ID}`);
  await f.send(c.id, 'key-2', 'second');
  const two = await f.settle(c.id, 2);
  assert.deepEqual(two.turns.map((x) => x.sessionId), ['session-1', 'session-2']);
  assert.notEqual(two.turns[0].id, two.turns[1].id); assert.notEqual(two.turns[0].key, two.turns[1].key);
  assert.deepEqual(two.turns.map((x) => x.reply.text), ['answer 1', 'answer 2'], 'each reply stays on its own turn');
  assert.equal(two.turns.every((x) => x.send.state === 'observed' && x.reply.state === 'ready' && x.readiness.state === 'ready'), true);
  assert.equal(two.capture.state, 'idle'); assert.equal(two.state, 'ready');
  assert.deepEqual(two.binding.thread, one.binding.thread, 'same exact native thread');
  assert.equal(f.calls.filter((x) => x === 'submit').length, 2); assert.equal(f.calls.filter((x) => x === 'armCapture').length, 2);
  assert.equal(JSON.stringify(await f.runtime.list()).includes('answer 1'), false, 'list stays free of reply bodies');
  const journal = f.runtime.journalSnapshot(c.id);
  assert.equal(journal.turns.length, 2); assert.equal(journal.turns.every((x) => x.readiness.state === 'ready'), true);
});

test('runtime: replaying an earlier key after turn 2 returns that turn and never sends again', async (t) => {
  const f = fixture(t), c = await f.connect();
  await f.send(c.id, 'key-1', 'same'); await f.settle(c.id, 1);
  await f.send(c.id, 'key-2', 'same'); const two = await f.settle(c.id, 2);
  const sends = f.calls.filter((x) => x === 'submit').length;
  const replay = await f.runtime.submit(c.id, { key: 'key-1', prompt: 'same', confirm: true, expectedRevision: -1 });
  assert.equal(replay.turn.id, two.turns[0].id); assert.equal(f.calls.filter((x) => x === 'submit').length, sends);
});

test('runtime: a failed per-turn capture stop is recorded incomplete and blocks the next turn (no fake finalization)', async (t) => {
  const f = fixture(t, { stopFails: true }), c = await f.connect();
  await f.send(c.id, 'key-1', 'first');
  let one;
  for (let n = 0; n < 500; n++) { one = await f.runtime.get(c.id); if (one.turn?.reply.state === 'ready' && one.capture.state === 'incomplete') break; await new Promise(setImmediate); }
  assert.equal(one.capture.state, 'incomplete');
  await assert.rejects(f.send(c.id, 'key-2', 'second'), (e) => e.status === 409 && e.code === 'PRIOR_TURN_CAPTURE_NOT_FINALIZED');
  assert.equal(f.calls.filter((x) => x === 'type').length, 1); assert.equal(f.calls.filter((x) => x === 'submit').length, 1);
});

test('runtime: an uncertain turn 1 blocks turn 2 through the writer window and journal; nothing is re-sent', async (t) => {
  const f = fixture(t); f.state.deliver = false;
  const c = await f.connect();
  await f.send(c.id, 'key-1', 'first');
  let one; for (let n = 0; n < 500; n++) { one = await f.runtime.get(c.id); if (one.turn?.send.state === 'uncertain') break; await new Promise(setImmediate); }
  assert.equal(one.state, 'needs-reconciliation'); assert.equal(one.writer.active, true, 'the effect window stays held for the unresolved turn');
  await assert.rejects(f.send(c.id, 'key-2', 'second'), (e) => e.status === 409 && e.code === 'THREAD_FENCED');
  assert.equal(f.calls.filter((x) => x === 'submit').length, 1); assert.equal(f.calls.filter((x) => x === 'type').length, 1);
  assert.equal((await f.runtime.get(c.id)).turns.length, 1);
});

test('runtime: Check again after a completed turn is a read-only readiness check; nothing is typed, sent or armed', async (t) => {
  const f = fixture(t), c = await f.connect();
  await f.send(c.id, 'key-1', 'first'); const one = await f.settle(c.id, 1);
  const before = [...f.calls];
  const checked = await f.runtime.reconcile(c.id, { expectedRevision: one.revision });
  assert.deepEqual(f.calls.slice(before.length), ['preflight-readonly']);
  assert.equal(checked.state, 'ready'); assert.equal(checked.readiness.ready, true); assert.equal(checked.capture.state, 'idle');
  assert.equal(checked.turns.length, 1);
});

test('runtime: Check again on a deferred idle first connection is read-only and does not arm capture', async (t) => {
  const f = fixture(t), c = await f.connect();
  const checked = await f.runtime.reconcile(c.id, { expectedRevision: c.revision });
  assert.deepEqual(f.calls, ['connect', 'preflight-readonly']);
  assert.equal(checked.sessionId, null); assert.equal(checked.capture.state, 'idle');
});
