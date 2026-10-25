import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withDispatchPreflight } from '../../src/studio/harness-executor-preflight.mjs';

test('invalid tool args fail with proven not_dispatched, never enter effect executor', async () => {
  let effects = 0;
  const wrapped = withDispatchPreflight(async () => { effects++; }, (tool, args) => {
    if (!args?.conversation) throw Object.assign(new Error('Missing conversation'), { code: 'INVALID_TOOL_ARGUMENTS', status: 400 });
  });
  await assert.rejects(() => wrapped({ tool: 'get_conversation', args: {} }), (e) => e.effectState === 'not_dispatched' && e.status === 400);
  assert.equal(effects, 0);
});

test('runtime rejection remains uncertain: pure preflight cannot prove dispatch absence', async () => {
  const wrapped = withDispatchPreflight(async () => { throw Object.assign(new Error('network broke'), { code: 'TIMEOUT' }); }, () => {});
  await assert.rejects(() => wrapped({ tool: 'send', args: {} }), (e) => !e.effectState && e.code === 'TIMEOUT');
});

test('successful preflight delegates once to original executor with unchanged identity', async () => {
  let calls = 0;
  const wrapped = withDispatchPreflight(async ({ tool, args, run }) => { calls++; return { tool, args, id: run.id }; }, () => {});
  assert.deepEqual(await wrapped({ tool: 'get_conversation', args: { conversation: 'c1' }, run: { id: 'r1' } }),
    { tool: 'get_conversation', args: { conversation: 'c1' }, id: 'r1' });
  assert.equal(calls, 1);
});