// Real loopback Studio contract acceptance with isolated local data and a fake browser runtime.
// Never opens Chrome, CDP or an AI provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { dataPaths, ensureDataDirs } from '../../src/config.mjs';
import { ProfileStore } from '../../src/profiles/profiles.mjs';
import { startStudio } from '../../src/studio/server.mjs';

test('same-owner app factory survives Studio restart with token and origin guards', { timeout: 20000 }, async t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vivim-builder-http-'));
  const paths = dataPaths(dir); ensureDataDirs(paths);
  const runtime = () => ({ isSessionActive: () => false, close: async () => {},
    targets: async () => ({ sites: [], targets: [] }), list: async () => [] });
  const start = () => startStudio({ paths, profileStore: new ProfileStore(paths.profiles),
    port: 0, token: 'local-builder-test', accessMode: 'token', conversationRuntime: runtime() });
  let studio = await start();
  t.after(async () => { try { await studio?.close(); } finally { rmSync(dir, { recursive: true, force: true }); } });
  const base = () => 'http://127.0.0.1:' + studio.port;
  const headers = { 'x-studio-token': 'local-builder-test', 'content-type': 'application/json' };
  const request = async (route, method = 'GET', body, auth = true) => {
    const res = await fetch(base() + '/api/v1/personal-apps' + route, {
      method, headers: auth ? headers : { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, data: await res.json(), headers: res.headers };
  };
  assert.equal((await request('', 'GET', undefined, false)).status, 401);
  assert.equal((await request('')).data.total, 0);
  const origin = await fetch(base() + '/api/v1/personal-apps', {
    method: 'POST', headers: { ...headers, origin: 'https://other.example' },
    body: JSON.stringify({ title: 'Bad', intent: 'Should never save', idempotencyKey: 'one-request-12345678' }),
  });
  assert.equal(origin.status, 403);
  assert.equal((await request('')).data.total, 0);
  const input = { title: 'Personal Companion', intent: 'My personal AI app that I control',
    idempotencyKey: 'first-local-app-123456' };
  const first = await request('', 'POST', input);
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.equal(first.data.app.version, 1);
  assert.equal(first.data.replayed, false);
  const id = first.data.app.id;
  assert.equal((await request('', 'POST', input)).data.replayed, true);
  assert.equal((await request('')).data.total, 1);
  assert.equal(JSON.stringify((await request('')).data).includes(input.intent), false);
  assert.equal((await request('/' + id)).data.intent, input.intent);
  const mobile = await request('/' + id + '/scaffold');
  assert.equal(mobile.status, 200);
  assert.deepEqual(mobile.data.scaffold.screens.map(s => s.key), ['home', 'agent', 'builder']);
  assert.equal(mobile.data.scaffold.connection.paired, false);
  const screen = await request('/' + id + '/screens', 'POST', {
    expectedVersion: 1, kind: 'tasks', label: 'My Tasks',
  });
  assert.equal(screen.status, 200);
  assert.equal(screen.data.app.version, 2);
  const proposal = { schema: 'vivim.personal-app-change/1', appId: id, baseVersion: 2,
    operations: [{ type: 'add-screen', kind: 'notes', label: 'Idea Garden' }] };
  const preview = await request('/' + id + '/preview-change', 'POST', { proposal });
  assert.equal(preview.status, 200);
  assert.equal(preview.data.scaffold.screens.length, 5);
  assert.equal(preview.data.effects, 'none');
  assert.equal((await request('/' + id)).data.version, 2,
    'preview is read-only and may not advance a revision');
  assert.equal((await request('/' + id + '/apply-change', 'POST', {
    expectedVersion: 2, proposal,
  })).status, 400, 'missing approval is not permitted');
  const applied = await request('/' + id + '/apply-change', 'POST', {
    expectedVersion: 2, proposal, approval: 'user-confirmed',
  });
  assert.equal(applied.status, 200);
  assert.equal(applied.data.app.version, 3);
  assert.equal(applied.data.deployed, false);
  assert.equal((await request('/' + id + '/apply-change', 'POST', {
    expectedVersion: 2, proposal, approval: 'user-confirmed',
  })).status, 409);
  const unsafe = await request('/' + id + '/preview-change', 'POST', {
    proposal: { ...proposal, execute: true },
  });
  assert.equal(unsafe.status, 400);

  assert.equal((await request('/' + id + '/screens', 'POST', {
    expectedVersion: 1, kind: 'blank', label: 'Stale Screen',
  })).status, 409);
  assert.equal((await request('', 'POST', { ...input, extra: 'unapproved' })).status, 400);
  assert.equal((await request('/' + id + '/screens', 'POST', {
    expectedVersion: 2, kind: 'javascript', label: 'Code injection',
  })).status, 400);
  const toolManifest = await fetch(base() + '/api/v1/integrations/tools', { headers });
  if (toolManifest.ok) {
    const content = JSON.stringify(await toolManifest.json());
    assert.equal(content.includes('/personal-apps'), false,
      'model tool list must not silently expose app mutation');
  }
  // The mobile view runs on the existing authenticated Studio service.
  const emptyContent = await request('/' + id + '/content');
  assert.equal(emptyContent.status, 200);
  assert.equal(emptyContent.data.version, 0);
  const noteInput = { expectedVersion: 0, idempotencyKey: 'mobile-note-123456',
    kind: 'note', title: 'My private note', body: 'Only stored locally' };
  const firstNote = await request('/' + id + '/content/items', 'POST', noteInput);
  assert.equal(firstNote.status, 200, JSON.stringify(firstNote.data));
  assert.equal(firstNote.data.content.version, 1);
  assert.equal((await request('/' + id + '/content/items', 'POST', noteInput)).data.replayed, true);
  assert.equal((await request('/' + id + '/content')).data.items.length, 1);
  assert.equal((await request('/' + id + '/content/items', 'POST',
    { ...noteInput, idempotencyKey: 'another-note-123456' })).status, 409);
  const task = await request('/' + id + '/content/items', 'POST', {
    expectedVersion: 1, idempotencyKey: 'mobile-task-123456',
    kind: 'task', title: 'Verify phone screen',
  });
  assert.equal(task.status, 200);
  assert.equal(task.data.content.version, 2);
  const complete = await request('/' + id + '/content/items/' + task.data.item.id + '/completion',
    'POST', { expectedVersion: 2, completed: true });
  assert.equal(complete.status, 200);
  assert.equal(complete.data.content.version, 3);
  assert.equal(complete.data.item.completed, true);
  assert.equal((await request('/' + id + '/content/items/' + task.data.item.id + '/completion',
    'POST', { expectedVersion: 2, completed: false })).status, 409);
  assert.equal((await request('/' + id + '/content/items', 'POST', {
    ...noteInput, idempotencyKey: 'script-note-123456', kind: 'javascript',
    expectedVersion: 3,
  })).status, 400);
  assert.equal((await request('/' + id + '/content', 'GET', undefined, false)).status, 401);
  const hostile = await fetch(base() + '/api/v1/personal-apps/' + id + '/content/items', {
    method: 'POST', headers: { ...headers, origin: 'https://outside.example' },
    body: JSON.stringify({ ...noteInput, expectedVersion: 3, idempotencyKey: 'cross-origin-123456' }),
  });
  assert.equal(hostile.status, 403);
  assert.equal((await request('/' + id + '/content')).data.version, 3);
  await studio.close(); studio = await start();
  assert.equal((await request('')).data.total, 1);
  assert.equal((await request('/' + id)).data.screens.length, 5);
  assert.equal((await request('/' + id + '/scaffold')).data.scaffold.intelligence.dispatch, 'disabled');
  const contentAfterRestart = await request('/' + id + '/content');
  assert.equal(contentAfterRestart.status, 200);
  assert.equal(contentAfterRestart.data.version, 3);
  assert.equal(contentAfterRestart.data.items.length, 2);
  assert.equal(contentAfterRestart.data.items.find(item => item.kind === 'task').completed, true);

});
