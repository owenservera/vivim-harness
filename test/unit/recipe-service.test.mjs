import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRecipeService } from '../../src/recipes/service.mjs';
import { createHarnessRunStore } from '../../src/capture/harness-runs.mjs';
import { createHarnessApi, conversationToolExecutor, HARNESS_RETRYABLE_TOOLS } from '../../src/studio/harness-api.mjs';

function fixture(t, { throwAfterSend = false } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vivim-recipe-service-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const calls = { submits: 0, targets: 0, reads: 0 };
  const runtime = {
    targets: async () => { calls.targets++; return { sites: [], targets: [] }; },
    get: async (id) => { calls.reads++; return { id, revision: 0, identity: { state: 'bound' },
      binding: { thread: { ref: 'chatgpt-c:44444444-4444-4444-8444-444444444444' } }, state: 'connected', recovery: { pending: false } }; },
    submit: async (id) => {
      calls.submits++;
      if (throwAfterSend) throw Object.assign(new Error('simulated unknown outcome'), { code: 'SEND_UNCERTAIN' });
      return { id, revision: 1, state: 'turn-registered', reply: { state: 'waiting' } };
    },
  };
  const runs = createHarnessRunStore({ dir, toolExecutor: conversationToolExecutor(runtime), retryableTools: HARNESS_RETRYABLE_TOOLS });
  const harnessApi = createHarnessApi({ runs, conversationRuntime: runtime });
  const service = createRecipeService({ harnessApi, conversationRuntime: runtime });
  return { calls, runtime, runs, harnessApi, service };
}
const turn = { conversation: 'c1', key: 'original-key-1', prompt: 'A private prompt body',
  confirm: true, expectedRevision: 0 };

test('read-only recipe uses harness owner once and closes successful run; no second runtime', async (t) => {
  const f = fixture(t);
  const result = await f.service.run('provider.targets', {}, { includeContent: true });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.effectState, 'none');
  assert.equal(f.calls.targets, 1);
  assert.deepEqual(result.result, { sites: [], targets: [] });
  assert.equal(f.service.status(result.runId).status, 'succeeded');
});
test('provider send is fenced by a stable operation key and does not claim reply/capture success', async (t) => {
  const f = fixture(t);
  const result = await f.service.run('conversation.continue', turn, { execute: true, authorizeSend: true });
  assert.equal(f.calls.submits, 1);
  assert.equal(result.effectState, 'tool-completed-outcome-unverified');
  assert.equal(result.status, 'running');
  assert.equal(JSON.stringify(result).includes(turn.prompt), false);
  const replay = await f.service.run('conversation.continue', turn, { execute: true, authorizeSend: true });
  assert.equal(replay.existing, true);
  assert.equal(f.calls.submits, 1);
  assert.equal(replay.retryAllowed, false);
});
test('unknown post-send outcome leaves original run ID and never resends on same operation', async (t) => {
  const f = fixture(t, { throwAfterSend: true });
  const result = await f.service.run('conversation.continue', turn, { execute: true, authorizeSend: true });
  assert.equal(result.effectState, 'unknown');
  assert.equal(result.retryAllowed, false);
  assert.equal(f.calls.submits, 1);
  assert.match(result.runId, /^[a-f0-9-]{36}$/);
  const preserved = await f.service.run('conversation.continue', turn, { execute: true, authorizeSend: true });
  assert.equal(preserved.existing, true);
  assert.equal(f.calls.submits, 1);
  assert.ok(['uncertain', 'in_flight'].includes(preserved.lastStep.status));
});
test('mutation cannot execute without both authorization and stable operation key', async (t) => {
  const f = fixture(t);
  await assert.rejects(f.service.run('conversation.continue', turn, { execute: true }), (e) => e.code === 'RECIPE_AUTHORIZATION_REQUIRED');
  await assert.rejects(f.service.run('conversation.finish', { conversation: 'c1', closeTab: false }, { execute: true }), (e) => e.code === 'RECIPE_OPERATION_REQUIRED');
  assert.equal(f.calls.submits, 0);
  assert.deepEqual(f.runs.list(), []);
});
test('recipe run finish is explicit, and native send evidence cannot be automatically promoted to success', async (t) => {
  const f = fixture(t);
  const result = await f.service.run('conversation.continue', turn, { execute: true, authorizeSend: true });
  assert.equal(f.service.status(result.runId).status, 'running');
  const closed = f.service.finish(result.runId, 'interrupted');
  assert.equal(closed.status, 'interrupted');
  await assert.rejects(async () => f.service.finish(result.runId, 'succeeded'), (e) => e.code === 'RUN_FINISHED');
});
