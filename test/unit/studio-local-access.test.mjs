import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { startStudio } from '../../src/studio/server.mjs';
import { dataPaths, ensureDataDirs } from '../../src/config.mjs';
import { ProfileStore } from '../../src/profiles/profiles.mjs';

async function fixture(t, overrides = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'studio-local-access-'));
  const paths = dataPaths(root); ensureDataDirs(paths);
  const runtime = {
    isSessionActive: () => false, close: async () => {},
    targets: async () => ({ sites: [], targets: [] }), list: async () => [],
  };
  const studio = await startStudio({
    paths, profileStore: new ProfileStore(paths.profiles), conversationRuntime: runtime,
    port: 0, ...overrides,
  });
  t.after(async () => { await studio.close(); rmSync(root, { recursive: true, force: true }); });
  return studio;
}
const base = (studio) => 'http://127.0.0.1:' + studio.port;

test('single-user local access opens plain localhost, no browser token or login', async (t) => {
  const studio = await fixture(t, { accessMode: 'local' });
  assert.equal(studio.accessMode, 'local');
  assert.equal(studio.url, base(studio) + '/');
  assert.equal((await fetch(studio.url)).status, 200);
  assert.equal((await fetch(base(studio) + '/api/v1/conversation-targets')).status, 200);
});

test('existing explicit tokens remain strict and open with a tokenized URL', async (t) => {
  const studio = await fixture(t, { token: 'test-local-token' });
  assert.equal(studio.accessMode, 'token');
  assert.equal((await fetch(base(studio) + '/chat')).status, 401);
  assert.equal((await fetch(base(studio) + '/chat', { headers: { 'x-studio-token': studio.token } })).status, 200);
  assert.ok(studio.url.includes('?token='));
});

test('local no-login mode retains same-origin checks', async (t) => {
  const studio = await fixture(t, { accessMode: 'local' });
  const response = await fetch(base(studio) + '/api/v1/conversation-targets', {
    headers: { origin: 'https://example.org' },
  });
  assert.equal(response.status, 403);
});

test('invalid access-mode value fails before opening a listener', async () => {
  await assert.rejects(startStudio({ accessMode: 'external' }), /must be local or token/);
});

test('localhost endpoint rejects foreign Host headers even in local mode', async (t) => {
  const studio = await fixture(t, { accessMode: 'local' });
  const status = await new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: studio.port,
      path: '/api/v1/conversation-targets', headers: { Host: 'other.example' } },
    (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.end();
  });
  assert.equal(status, 421);
});
