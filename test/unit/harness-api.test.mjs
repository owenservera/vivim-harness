// Harness run surfaces through the real studio server: the same runtime owner, the same tool
// validation, the same auth. Fake runtime (no browser); every assertion is about routing,
// idempotency and honest ledgers, not about provider effects.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startStudio } from '../../src/studio/server.mjs';
import { dataPaths, ensureDataDirs } from '../../src/config.mjs';
import { ProfileStore } from '../../src/profiles/profiles.mjs';

const snapshot = { id: 'conv-1', revision: 1, state: 'ready', site: 'chatgpt', identity: { state: 'bound', reason: null },
  writer: { active: false }, diagnostic: {}, turns: [], reply: { state: 'unknown', text: 'REPLY BODY STAYS PUT' }, readiness: {} };

function fakeRuntime() {
  const calls = [];
  return {
    calls,
    isSessionActive: () => false,
    get: async (id) => { calls.push(['get', id]); return snapshot; },
    list: async () => { calls.push(['list']); return [snapshot]; },
    targets: async () => { calls.push(['targets']); return { sites: [], targets: [] }; },
    connect: async () => snapshot,
    read: async () => ({ messages: [] }),
    submit: async () => snapshot,
    reconcile: async () => snapshot,
    finish: async () => snapshot,
    chatIndex: async () => ({ entries: [] }),
    close: async () => {},
  };
}

async function studioFor(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'harness-api-'));
  const paths = dataPaths(root); ensureDataDirs(paths);
  const runtime = fakeRuntime();
  const studio = await startStudio({ paths, profileStore: new ProfileStore(paths.profiles), port: 0, token: 'fixture-token', accessMode: 'token', conversationRuntime: runtime });
  t.after(async () => { await studio.close(); rmSync(root, { recursive: true, force: true }); });
  return { studio, runtime, base: `http://127.0.0.1:${studio.port}`,
    call: (p, { method = 'GET', body, auth = true } = {}) => fetch(`http://127.0.0.1:${studio.port}/api/v1${p}`,
      { method, headers: { ...(auth ? { 'x-studio-token': studio.token } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }) };
}

test('harness runs live behind the same auth and advertise in the tool manifest', async (t) => {
  const f = await studioFor(t);
  const unauth = await f.call('/harness/runs', { auth: false });
  assert.equal(unauth.status, 401);
  const manifest = await (await f.call('/integrations/tools')).json();
  const names = manifest.tools.map((x) => x.name);
  for (const expected of ['harness_start_run', 'harness_list_runs', 'harness_get_run', 'harness_run_step', 'harness_finish_run', 'harness_note_run']) {
    assert.ok(names.includes(expected), `tool manifest should advertise ${expected}`);
  }
  const step = manifest.tools.find((x) => x.name === 'harness_run_step');
  assert.equal(step.annotations.readOnlyHint, false);
});

test('create, step through the shared executor, idempotent replay, conflict, finish', async (t) => {
  const f = await studioFor(t);
  const created = await f.call('/harness/runs', { method: 'POST', body: { task: 'verify a thread', conversationId: 'conv-1' } });
  assert.equal(created.status, 201);
  const run = (await created.json()).run;
  assert.equal(run.status, 'running');
  assert.equal(run.conversationId, 'conv-1');

  const stepped = await f.call(`/harness/runs/${run.id}/steps`, { method: 'POST',
    body: { key: 'read-1', tool: 'get_conversation', arguments: { conversation: 'conv-1' } } });
  assert.equal(stepped.status, 200);
  const step1 = await stepped.json();
  assert.equal(step1.replayed, false);
  assert.equal(step1.step.status, 'succeeded');
  assert.deepEqual(f.runtime.calls.at(-1), ['get', 'conv-1'], 'the step executed through the SAME runtime owner');
  // The stored run must never carry the reply body.
  const fetched = await (await f.call(`/harness/runs/${run.id}`)).json();
  assert.ok(!JSON.stringify(fetched).includes('REPLY BODY STAYS PUT'));

  const replay = await f.call(`/harness/runs/${run.id}/steps`, { method: 'POST',
    body: { key: 'read-1', tool: 'get_conversation', arguments: { conversation: 'conv-1' } } });
  assert.equal((await replay.json()).replayed, true);
  assert.equal(f.runtime.calls.filter((c) => c[0] === 'get').length, 1, 'a replayed step does not execute again');

  const conflict = await f.call(`/harness/runs/${run.id}/steps`, { method: 'POST',
    body: { key: 'read-1', tool: 'get_conversation', arguments: { conversation: 'other' } } });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).code, 'IDEMPOTENCY_CONFLICT');

  const badTool = await f.call(`/harness/runs/${run.id}/steps`, { method: 'POST', body: { key: 'x', tool: 'not_a_tool', arguments: {} } });
  assert.equal(badTool.status, 404, 'unknown tools fail with the same code as the shared tool surface');
  assert.equal((await badTool.json()).code, 'UNKNOWN_CONVERSATION_TOOL');

  const finished = await f.call(`/harness/runs/${run.id}/finish`, { method: 'POST', body: { status: 'succeeded' } });
  assert.equal((await finished.json()).run.status, 'succeeded');
  const after = await f.call(`/harness/runs/${run.id}/steps`, { method: 'POST',
    body: { key: 'read-2', tool: 'list_conversations', arguments: {} } });
  assert.equal(after.status, 409);
  assert.equal((await after.json()).code, 'RUN_FINISHED');
});

test('tool-validation failures flow through the executor and are recorded as failed steps', async (t) => {
  const f = await studioFor(t);
  const run = (await (await f.call('/harness/runs', { method: 'POST', body: { task: 'task' } })).json()).run;
  const missing = await f.call(`/harness/runs/${run.id}/steps`, { method: 'POST',
    body: { key: 'bad-1', tool: 'get_conversation', arguments: {} } }); // conversation argument missing
  assert.equal(missing.status, 400);
  const stored = await (await f.call(`/harness/runs/${run.id}`)).json();
  assert.equal(stored.run.steps.at(-1).status, 'failed', 'the failed attempt stays in the ledger');
  assert.ok(!JSON.stringify(stored).includes('REPLY BODY STAYS PUT'));
});
