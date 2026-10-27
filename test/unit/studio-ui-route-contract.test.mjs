// End-to-end HTTP smoke for canonical Studio static pages, their module imports and
// security boundaries. Runs on plain Node on Windows and Linux, with disposable data and
// a fake browser runtime; never starts Chrome, CDP or a provider session.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dataPaths, ensureDataDirs } from '../../src/config.mjs';
import { ProfileStore } from '../../src/profiles/profiles.mjs';
import { startStudio } from '../../src/studio/server.mjs';

test('every shipped Studio page serves its referenced JS modules under token security', { timeout: 15000 }, async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vivim-ui-route-'));
  const paths = dataPaths(dir);
  ensureDataDirs(paths);
  const runtime = {
    isSessionActive: () => false, close: async () => {},
    targets: async () => ({ sites: [], targets: [] }), list: async () => [],
  };
  let studio;
  try {
    studio = await startStudio({ paths, profileStore: new ProfileStore(paths.profiles),
      port: 0, token: 'route-fixture-token', accessMode: 'token', conversationRuntime: runtime });
  } catch (error) { rmSync(dir, { force: true, recursive: true }); throw error; }
  t.after(async () => { try { await studio.close(); } finally { rmSync(dir, { force: true, recursive: true }); } });
  const base = 'http://127.0.0.1:' + studio.port;
  const auth = { 'x-studio-token': 'route-fixture-token' };
  const allModules = new Set();

  for (const route of ['/', '/chat', '/drive', '/platform']) {
    assert.equal((await fetch(base + route)).status, 401, route + ' must require configured token');
    const page = await fetch(base + route, { headers: auth });
    assert.equal(page.status, 200, route + ' page');
    assert.match(page.headers.get('content-type') ?? '', /text\/html/, route + ' MIME');
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff', route + ' nosniff');
    assert.equal(page.headers.get('cache-control'), 'no-store', route + ' no-store');
    assert.ok(page.headers.get('content-security-policy'), route + ' CSP');
    const html = await page.text();
    const modules = [...html.matchAll(/<script\b[^>]*\bsrc=["'](\/[^"']+\.mjs)["']/gi)].map((match) => match[1]);
    if (route !== '/') assert.ok(modules.length > 0, route + ' declares its JS module');
    for (const modulePath of modules) allModules.add(modulePath);
    const post = await fetch(base + route, { method: 'POST', headers: auth });
    assert.equal(post.status, 405, route + ' is GET-only');
    assert.match(post.headers.get('allow') ?? '', /GET/, route + ' Allow');
  }

  // Chat has additional lazy modules: the route test guards them even when the
  // request is made before the Chat UI starts or any live Chrome exists.
  allModules.add('/ui/universal-chat.mjs');
  allModules.add('/ui/world-view.mjs');
  for (const modulePath of allModules) {
    assert.equal((await fetch(base + modulePath)).status, 401, modulePath + ' token');
    const response = await fetch(base + modulePath, { headers: auth });
    assert.equal(response.status, 200, modulePath + ' must be deployed alongside its parent page');
    assert.match(response.headers.get('content-type') ?? '', /javascript/, modulePath + ' JS MIME');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff', modulePath + ' nosniff');
    assert.ok((await response.text()).length > 0, modulePath + ' nonempty source');
    assert.equal((await fetch(base + modulePath, { method: 'POST', headers: auth })).status, 405);
  }

  assert.equal((await fetch(base + '/chat', { headers: { ...auth, origin: 'https://evil.example' } })).status, 403,
    'cross-origin request is refused regardless of token');
  assert.equal((await fetch(base + '/ui/does-not-exist.mjs', { headers: auth })).status, 404,
    'unknown modules remain unavailable');
});
