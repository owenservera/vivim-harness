// Agent 14 adversarial acceptance tests for the Z.ai Round 6 drop-in.
// Run from this folder: node --test harness-runs.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHarnessRunStore, HARNESS_RUN_SCHEMA } from '../../src/capture/harness-runs.mjs';

const fixture = (t, exec, opts = {}) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'agent14-harness-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, store: createHarnessRunStore({ dir, toolExecutor: exec, ...opts }) };
};
const errorCode = (code) => (e) => e.code === code;

test('preserves published factory/API contract and durable JSON across instances', (t) => {
  const { dir, store } = fixture(t, async () => ({}));
  const r = store.create({ task: 'task', conversationId: 'conversation-1' });
  assert.equal(r.schema, HARNESS_RUN_SCHEMA);
  assert.equal(r.status, 'running');
  assert.equal(store.list().length, 1);
  assert.equal(createHarnessRunStore({ dir, toolExecutor: async () => ({}) }).get(r.id).conversationId, 'conversation-1');
});

test('concurrent same key uses one executor, records an in-flight claim first', async (t) => {
  let count = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { dir, store } = fixture(t, async () => { count++; await gate; return { ok: true }; });
  const other = createHarnessRunStore({ dir, toolExecutor: async () => { count++; return {}; } });
  const r = store.create({ task: 'task' });
  const first = store.step(r.id, { key: 'same', tool: 'submit_conversation_turn', args: { hello: 1 } });
  assert.equal(store.get(r.id).steps[0].status, 'in_flight');
  await assert.rejects(() => other.step(r.id, { key: 'same', tool: 'submit_conversation_turn', args: { hello: 1 } }), errorCode('STEP_UNCERTAIN'));
  assert.equal(count, 1);
  release();
  assert.equal((await first).step.status, 'succeeded');
  const replay = await other.step(r.id, { key: 'same', tool: 'submit_conversation_turn', args: { hello: 1 } });
  assert.equal(replay.replayed, true);
  assert.equal(count, 1);
  assert.equal(store.get(r.id).steps.length, 1);
});

test('key collision with DIFFERENT tool is rejected even when args equal', async (t) => {
  let count = 0;
  const { store } = fixture(t, async () => { count++; return {}; });
  const r = store.create({ task: 'task' });
  await store.step(r.id, { key: 'k', tool: 'read', args: {} });
  await assert.rejects(() => store.step(r.id, { key: 'k', tool: 'delete', args: {} }), errorCode('IDEMPOTENCY_CONFLICT'));
  assert.equal(count, 1);
});

test('canonical JSON allows equivalent key orders but rejects actual changes', async (t) => {
  let calls = 0;
  const { store } = fixture(t, async () => { calls++; return {}; });
  const r = store.create({ task: 'task' });
  await store.step(r.id, { key: 'k', tool: 'read', args: { b: [1, { y: 2, x: 1 }], a: 3 } });
  const repeat = await store.step(r.id, { key: 'k', tool: 'read', args: { a: 3, b: [1, { x: 1, y: 2 }] } });
  assert.equal(repeat.replayed, true);
  await assert.rejects(() => store.step(r.id, { key: 'k', tool: 'read', args: { a: 4, b: [1, { x: 1, y: 2 }] } }), errorCode('IDEMPOTENCY_CONFLICT'));
  assert.equal(calls, 1);
});

test('executor rejection WITHOUT not-dispatched evidence becomes uncertain and cannot retry or finish', async (t) => {
  let count = 0;
  const { store } = fixture(t, async () => { count++; throw Object.assign(new Error('unexpected'), { code: 'UNKNOWN_ACK' }); });
  const r = store.create({ task: 'task' });
  await assert.rejects(() => store.step(r.id, { key: 'k', tool: 'send', args: {} }), (e) => e.step.status === 'uncertain');
  await assert.rejects(() => store.step(r.id, { key: 'k', tool: 'send', args: {} }), errorCode('STEP_UNCERTAIN'));
  assert.throws(() => store.finish(r.id, { status: 'succeeded' }), errorCode('RUN_HAS_UNRESOLVED_EFFECT'));
  assert.equal(count, 1);
});

test('explicit not-dispatched receipt permits retry ONLY for configured read-only tool', async (t) => {
  let count = 0;
  const { store } = fixture(t, async () => {
    count++;
    if (count === 1) throw Object.assign(new Error('not started'), { code: 'PRE_DISPATCH_FAILED', effectState: 'not_dispatched' });
    return { ok: true };
  }, { retryableTools: ['list_conversations'] });
  const r = store.create({ task: 'task' });
  await assert.rejects(() => store.step(r.id, { key: 'k', tool: 'list_conversations', args: {} }), errorCode('PRE_DISPATCH_FAILED'));
  const retry = await store.step(r.id, { key: 'k', tool: 'list_conversations', args: {} });
  assert.equal(retry.step.attempt, 2);
  assert.equal(retry.step.status, 'succeeded');
  assert.deepEqual(store.get(r.id).steps.map((s) => s.status), ['failed', 'succeeded']);
});

test('effectful not-dispatched failure is NOT retried by default', async (t) => {
  let count = 0;
  const { store } = fixture(t, async () => { count++; throw Object.assign(new Error('blocked'), { effectState: 'not_dispatched' }); });
  const r = store.create({ task: 'task' });
  await assert.rejects(() => store.step(r.id, { key: 'x', tool: 'submit_conversation_turn' }));
  await assert.rejects(() => store.step(r.id, { key: 'x', tool: 'submit_conversation_turn' }), errorCode('STEP_RECONCILIATION_REQUIRED'));
  assert.equal(count, 1);
});

test('crash-after-effect-before-final-persist remains in-flight and is never auto-replayed', async (t) => {
  let count = 0;
  const { dir, store } = fixture(t, async () => { count++; return { ok: true }; });
  const r = store.create({ task: 'task' });
  let rename = 0;
  const io = { ...fs, renameSync: (...args) => {
    rename++;
    if (rename === 2) throw new Error('disk fault after effect');
    return fs.renameSync(...args);
  } };
  const failing = createHarnessRunStore({ dir, io, toolExecutor: async () => { count++; return { ok: true }; } });
  await assert.rejects(() => failing.step(r.id, { key: 'k', tool: 'send' }), errorCode('RUN_PERSIST_FAILED'));
  const afterRestart = createHarnessRunStore({ dir, toolExecutor: async () => { count++; return {}; } });
  assert.equal(afterRestart.get(r.id).steps[0].status, 'in_flight');
  await assert.rejects(() => afterRestart.step(r.id, { key: 'k', tool: 'send' }), errorCode('STEP_UNCERTAIN'));
  assert.equal(count, 1);
});

test('reservation write failure prevents executor from running', async (t) => {
  let count = 0;
  const { dir, store } = fixture(t, async () => ({}));
  const r = store.create({ task: 'task' });
  const io = { ...fs, renameSync: () => { throw new Error('disk fault before effect'); } };
  const broken = createHarnessRunStore({ dir, io, toolExecutor: async () => { count++; } });
  await assert.rejects(() => broken.step(r.id, { key: 'k', tool: 'send' }), errorCode('RUN_PERSIST_FAILED'));
  assert.equal(count, 0);
  assert.equal(store.get(r.id).steps.length, 0);
});

test('notes written during step are preserved; finish is blocked until step exits', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { store } = fixture(t, async () => { await gate; return { ok: true }; });
  const r = store.create({ task: 'task' });
  const pending = store.step(r.id, { key: 'k', tool: 'read' });
  store.note(r.id, { context: { checkpoint: 7 } });
  assert.throws(() => store.finish(r.id, { status: 'succeeded' }), errorCode('RUN_HAS_UNRESOLVED_EFFECT'));
  release();
  const out = await pending;
  assert.equal(out.run.context.checkpoint, 7);
  assert.equal(store.finish(r.id, { status: 'succeeded' }).status, 'succeeded');
});

test('exclusive state lock rejects concurrent writes instead of losing them', async (t) => {
  let count = 0;
  const { dir, store } = fixture(t, async () => { count++; return {}; });
  const r = store.create({ task: 'task' });
  const lock = path.join(dir, `${r.id}.run.json.lock`);
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid }));
  try {
    await assert.rejects(() => store.step(r.id, { key: 'k', tool: 'send' }), errorCode('RUN_BUSY'));
    assert.throws(() => store.note(r.id, { context: { a: 1 } }), errorCode('RUN_BUSY'));
    assert.equal(count, 0);
  } finally { fs.unlinkSync(lock); }
});

test('persisted metadata never includes private reply body or raw error text', async (t) => {
  const { dir, store } = fixture(t, async () => ({ conversation: { id: 'c1', reply: { text: 'SECRET RESPONSE', state: 'ready', chars: 15 } } }));
  const r = store.create({ task: 'task' });
  await store.step(r.id, { key: 'k', tool: 'read', args: { prompt: 'SECRET PROMPT' } });
  const raw = fs.readFileSync(path.join(dir, `${r.id}.run.json`), 'utf8');
  assert.doesNotMatch(raw, /SECRET RESPONSE|SECRET PROMPT/);
  assert.match(raw, /argsDigest/);
});

test('owner-verified dead PID lock recovery does NOT clear in-flight effect fences', async (t) => {
  let count = 0;
  const { dir, store } = fixture(t, async () => { count++; return {}; });
  const run = store.create({ task: 'task' });
  const lock = path.join(dir, `${run.id}.run.json.lock`);
  const deadPid = 2147483647;
  fs.writeFileSync(lock, JSON.stringify({ pid: deadPid, at: 'old' }));
  assert.throws(() => store.recoverAbandonedLock(run.id, { expectedPid: process.pid }), errorCode('LOCK_OWNER_MISMATCH'));
  const result = store.recoverAbandonedLock(run.id, { expectedPid: deadPid });
  assert.equal(result.released, true);
  assert.equal(store.get(run.id).steps.length, 0);
  await store.step(run.id, { key: 'k', tool: 'read' });
  assert.equal(count, 1);
});

test('invalid JSON arguments are rejected before external execution', async (t) => {
  let count = 0;
  const { store } = fixture(t, async () => { count++; return {}; });
  const r = store.create({ task: 'task' });
  const cyclic = {}; cyclic.ref = cyclic;
  await assert.rejects(() => store.step(r.id, { key: 'k', tool: 'read', args: cyclic }), errorCode('INVALID_STEP_ARGUMENTS'));
  assert.equal(count, 0);
  assert.equal(store.get(r.id).steps.length, 0);
});

test('run and context limits preserve original store validation', (t) => {
  const { store } = fixture(t, async () => ({}), { limits: { maxRuns: 2 } });
  assert.throws(() => store.create({ task: '  ' }), errorCode('INVALID_TASK'));
  assert.throws(() => store.create({ task: 'ok', conversationId: '../x' }), errorCode('INVALID_CONVERSATION_ID'));
  const a = store.create({ task: 'a' });
  store.note(a.id, { context: { version: 1 } });
  store.note(a.id, { context: { next: 2 } });
  assert.deepEqual(store.get(a.id).context, { version: 1, next: 2 });
  assert.throws(() => store.note(a.id, { context: { tooMuch: 'x'.repeat(17000) } }), errorCode('CONTEXT_TOO_LARGE'));
  store.create({ task: 'b' });
  assert.throws(() => store.create({ task: 'c' }), errorCode('RUN_STORE_FULL'));
});
// ---------------------------------------------------------------------------
// Preserved original (patch 0013) assertions, re-based on the Round 6 hardened
// semantics. These identity/validation guarantees are unchanged by the hardening
// and remain enforced; the two superseded originals (failed-without-proof and
// unqualified same-key retry) are intentionally NOT restored — see Agent 14's
// round6 README "Z.ai integration after the 18-patch branch is safely reconciled".
// ---------------------------------------------------------------------------
test('preserved original assertions: identity validation, not-found and finished-run fencing', async (t) => {
  const { store } = fixture(t, async () => ({}));
  const run = store.create({ task: 'task' });
  await assert.rejects(() => store.step(run.id, { key: '', tool: 'list_conversations', args: {} }), errorCode('INVALID_STEP_KEY'));
  await assert.rejects(() => store.step('00000000-0000-4000-8000-000000000000', { key: 'k', tool: 'list_conversations', args: {} }), errorCode('RUN_NOT_FOUND'));
  await assert.rejects(() => store.step('../escape', { key: 'k', tool: 'list_conversations', args: {} }), errorCode('INVALID_RUN_ID'));
  assert.throws(() => store.note(run.id, { context: null }), errorCode('INVALID_CONTEXT'));
  assert.throws(() => store.finish(run.id, { status: 'running' }), errorCode('INVALID_RUN_STATUS'));
  assert.throws(() => store.finish(run.id, { status: 'nope' }), errorCode('INVALID_RUN_STATUS'));
  store.finish(run.id, { status: 'succeeded' });
  await assert.rejects(() => store.step(run.id, { key: 'after', tool: 'list_conversations', args: {} }), errorCode('RUN_FINISHED'));
  assert.throws(() => store.finish(run.id, { status: 'failed' }), errorCode('RUN_FINISHED'));
});
