// Offline regression: real Studio HTTP transport and runtime, with a gated synthetic adapter.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dataPaths, ensureDataDirs } from '../../src/config.mjs';
import { ProfileStore } from '../../src/profiles/profiles.mjs';
import { createConversationRuntime } from '../../src/capture/conversation-runtime.mjs';
import { startStudio } from '../../src/studio/server.mjs';
import { createStudioToolClient } from '../../src/studio/tool-client.mjs';

const approvedTemp = 'C:\\Users\\VIVIM.inc\\AppData\\Local\\Temp\\opencode';
const tempRoot = fs.existsSync(approvedTemp) ? approvedTemp : os.tmpdir();

test('create timeout reports unknown once while the original operation persists ready', { timeout: 30000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(tempRoot, 'create-timeout-regression-'));
  const paths = dataPaths(root); ensureDataDirs(paths);
  const profileStore = new ProfileStore(paths.profiles);
  let release, entered, completed;
  const gate = new Promise((resolve) => { release = resolve; });
  const inAdapter = new Promise((resolve) => { entered = resolve; });
  const finished = new Promise((resolve) => { completed = resolve; });
  let connects = 0, requests = 0, forbidden = 0;
  const runtime = createConversationRuntime({ paths, profileStore, port: 19231, dependencies: {
    leaseRoot: path.join(root, 'leases'), listSessions: () => [], ownerIsAlive: () => false,
    listTargets: async () => [],
    getAdapter: async () => ({ id: 'chatgpt', url: 'https://chatgpt.com/' }),
    createAdapter: () => ({
      async connect(binding, hooks) {
        connects++;
        const bound = { ...binding, targetId: 'synthetic-target' };
        hooks.bind(bound); entered();
        await gate;
        return { binding: bound, deferredCapture: true, sessionId: null,
          readiness: { ready: true, draft: { present: false, chars: 0 }, creation: { threadless: true } } };
      },
      async type() { forbidden++; throw new Error('unexpected type'); },
      async submit() { forbidden++; throw new Error('unexpected submit'); },
      async close() {},
    }),
  } });
  const connect = runtime.connect.bind(runtime);
  runtime.connect = async (...args) => { try { return await connect(...args); } finally { completed(); } };
  let studio;
  t.after(async () => { release(); if (connects) await finished; await studio?.close(); await runtime.close(); fs.rmSync(root, { recursive: true, force: true }); });
  studio = await startStudio({ paths, port: 0, profileStore, conversationRuntime: runtime });
  // The client deadline only has to expire while the adapter is still gated. It must not be so
  // tight that parallel-suite scheduling jitter aborts the request before the first assertion can
  // attach a handler to the rejected call (which would surface as an unhandled rejection).
  const client = createStudioToolClient({ port: studio.port, timeoutMs: 1500,
    fetch: (...args) => { requests++; return globalThis.fetch(...args); } });
  const call = client.call('create_conversation', { site: 'chatgpt' });
  await inAdapter;
  const files = () => fs.readdirSync(path.join(root, 'conversations')).filter((f) => f.endsWith('.conversation.json'));
  assert.equal(files().length, 1);
  const snapshot = () => JSON.parse(fs.readFileSync(path.join(root, 'conversations', files()[0]), 'utf8'));
  assert.equal(snapshot().state, 'attaching');
  assert.equal(snapshot().binding.targetId, 'synthetic-target');
  await assert.rejects(call, (error) => error.code === 'STUDIO_REQUEST_UNKNOWN' && error.status === 504 && error.effect === 'unknown' && error.retry === false);
  assert.equal(requests, 1); assert.equal(connects, 1);
  release(); await finished;
  assert.equal(files().length, 1);
  const ready = snapshot();
  assert.equal(ready.state, 'ready'); assert.equal(ready.readiness.ready, true);
  assert.equal(ready.binding.targetId, 'synthetic-target');
  assert.equal(ready.attempts.length, 0); assert.equal(forbidden, 0);
  assert.equal(requests, 1); assert.equal(connects, 1);
});

test('sufficient client deadline returns the original ready record once', { timeout: 30000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(tempRoot, 'create-deadline-control-'));
  const paths = dataPaths(root); ensureDataDirs(paths);
  const profileStore = new ProfileStore(paths.profiles);
  let release, entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const inAdapter = new Promise((resolve) => { entered = resolve; });
  let connects = 0, requests = 0, forbidden = 0;
  const runtime = createConversationRuntime({ paths, profileStore, port: 19232, dependencies: {
    leaseRoot: path.join(root, 'leases'), listSessions: () => [], ownerIsAlive: () => false,
    listTargets: async () => [],
    getAdapter: async () => ({ id: 'chatgpt', url: 'https://chatgpt.com/' }),
    createAdapter: () => ({
      async connect(binding, hooks) {
        connects++;
        const bound = { ...binding, targetId: 'synthetic-target' };
        hooks.bind(bound); entered();
        await gate;
        return { binding: bound, deferredCapture: true, sessionId: null,
          readiness: { ready: true, draft: { present: false, chars: 0 }, creation: { threadless: true } } };
      },
      async type() { forbidden++; throw new Error('unexpected type'); },
      async submit() { forbidden++; throw new Error('unexpected submit'); },
      async close() {},
    }),
  } });
  let studio;
  t.after(async () => { release(); await studio?.close(); await runtime.close(); fs.rmSync(root, { recursive: true, force: true }); });
  studio = await startStudio({ paths, port: 0, profileStore, conversationRuntime: runtime });
  // A sufficient deadline: the gated create completes in ~100 ms of real work, so the budget only
  // has to absorb parallel-suite scheduling jitter, not a slow operation.
  const client = createStudioToolClient({ port: studio.port, timeoutMs: 8000,
    fetch: (...args) => { requests++; return globalThis.fetch(...args); } });
  const call = client.call('create_conversation', { site: 'chatgpt' });
  await inAdapter;
  const directory = path.join(root, 'conversations');
  const files = () => fs.readdirSync(directory).filter((f) => f.endsWith('.conversation.json'));
  assert.equal(files().length, 1);
  const attaching = JSON.parse(fs.readFileSync(path.join(directory, files()[0]), 'utf8'));
  assert.equal(attaching.state, 'attaching');
  release();
  const { conversation: result } = await call;
  assert.equal(files().length, 1);
  const ready = JSON.parse(fs.readFileSync(path.join(directory, files()[0]), 'utf8'));
  assert.equal(result.id, attaching.id); assert.equal(result.id, ready.id);
  assert.equal(result.state, 'ready'); assert.equal(ready.state, 'ready');
  assert.deepEqual(result.readiness, ready.readiness); assert.equal(result.readiness.ready, true);
  assert.equal(result.binding.targetId, 'synthetic-target');
  assert.equal(ready.attempts.length, 0); assert.equal(forbidden, 0);
  assert.equal(requests, 1); assert.equal(connects, 1);
});
