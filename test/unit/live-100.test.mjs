import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { allLiveScenarios, assessUserAnswer, LIVE_PROVIDERS, USER_TASKS } from '../../src/capture/live-scenarios.mjs';
import { browserIdentity, checkBrowserOwner, recordBrowserOwner, verifyBrowserOwner } from '../../src/chrome/browser-ownership.mjs';
import { launchChrome } from '../../src/chrome/launch.mjs';
import { runLiveScenarios } from '../../bin/commands/live-100.mjs';

test('live provider scenario catalogue defines 100 distinct real prompts with checkable tasks', () => {
  assert.equal(LIVE_PROVIDERS.length, 5);
  assert.equal(USER_TASKS.length, 20);
  const all = allLiveScenarios();
  assert.equal(all.length, 100);
  assert.equal(new Set(all.map((s) => s.id)).size, 100);
  for (const item of all) {
    assert.ok(item.task.prompt.length > 30);
    assert.ok(item.task.expect.length > 0);
    assert.ok(item.title.includes(item.provider));
    assert.equal(assessUserAnswer(item.task, '').ok, false);
  }
  assert.equal(allLiveScenarios(['chatgpt']).length, 20);
  assert.throws(() => allLiveScenarios(['chatgpt', 'chatgpt']));
  assert.deepEqual(assessUserAnswer(USER_TASKS.find((t) => t.id === 'exact'), 'VIVIM CEDAR READY'), { ok: true, reason: null });
  assert.equal(assessUserAnswer(USER_TASKS.find((t) => t.id === 'exact'), 'Extra VIVIM CEDAR READY').ok, false);
});

test('dedicated browser marker verifies CDP endpoint continuity and rejects origin/port/profile drift', async (t) => {
  const profileDir = mkdtempSync(path.join(os.tmpdir(), 'vivim-owner-'));
  const otherDir = mkdtempSync(path.join(os.tmpdir(), 'vivim-other-'));
  t.after(() => { rmSync(profileDir, { recursive: true, force: true }); rmSync(otherDir, { recursive: true, force: true }); });
  const port = 19317, uuid = '12345678-1234-4234-8234-123456789abc';
  const version = { Browser: 'Chrome/Test', webSocketDebuggerUrl: 'ws://127.0.0.1:' + port + '/devtools/browser/' + uuid };
  assert.equal(browserIdentity(version, port), '/devtools/browser/' + uuid);
  assert.throws(() => browserIdentity({ webSocketDebuggerUrl: 'ws://example.net:' + port + '/devtools/browser/' + uuid }, port));
  assert.throws(() => browserIdentity(version, port + 1));
  const saved = recordBrowserOwner({ profileDir, port, version, pid: process.pid });
  assert.equal(saved.verified, true);
  const marker = JSON.parse(readFileSync(path.join(profileDir, '.vivim-cdp-owner.json'), 'utf8'));
  assert.equal(checkBrowserOwner({ profileDir, port, version, marker }).verified, true);
  assert.equal((await verifyBrowserOwner({ profileDir, port, version })).verified, true);
  await assert.rejects(verifyBrowserOwner({ profileDir: otherDir, port, version }), (e) => e.code === 'BROWSER_PROFILE_UNVERIFIED');
  const changed = { ...version, webSocketDebuggerUrl: 'ws://127.0.0.1:' + port + '/devtools/browser/87654321-1234-4234-8234-123456789abc' };
  await assert.rejects(verifyBrowserOwner({ profileDir, port, version: changed }), (e) => e.code === 'BROWSER_PROFILE_UNVERIFIED');
});

test('launcher refuses to reuse a reachable but unowned CDP port and never requests tabs', async (t) => {
  const profileDir = mkdtempSync(path.join(os.tmpdir(), 'vivim-unowned-'));
  t.after(() => rmSync(profileDir, { recursive: true, force: true }));
  const accesses = [];
  const server = createServer((req, res) => {
    accesses.push(req.url);
    if (req.url === '/json/version') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ Browser: 'Chrome/Test', webSocketDebuggerUrl: 'ws://127.0.0.1:' + server.address().port + '/devtools/browser/12345678-1234-4234-8234-123456789abc' }));
    } else { res.writeHead(404); res.end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;
  await assert.rejects(launchChrome({ profileDir, port }), (e) => e.code === 'BROWSER_PROFILE_UNVERIFIED');
  assert.ok(accesses.length > 0);
  assert.ok(accesses.every((p) => p === '/json/version'));
});

test('live-100 default is a 100-case ZERO-BROWSER-EFFECT preview', async () => {
  let output;
  const ctx = { flags: {}, paths: { root: path.join(os.tmpdir(), 'unused-live-100') }, port: 19317, out: { emit: (v) => { output = v; } } };
  const result = await runLiveScenarios(ctx, {
    launch: () => { throw new Error('Preview must not launch Chrome'); },
    runtimeFactory: () => { throw new Error('Preview must not create an effect owner'); },
  });
  assert.equal(output.selected, 100);
  assert.equal(result.providerSends, 0);
  assert.equal(result.browserAction, false);
});

test('execute without a separate provider-send authorization is refused BEFORE browser access', async () => {
  const ctx = { flags: { execute: true, limit: 1 }, paths: { root: path.join(os.tmpdir(), 'unused-live-100') }, port: 19317,
    out: { emit: () => { throw new Error('Not a preview'); } } };
  await assert.rejects(runLiveScenarios(ctx, {
    launch: () => { throw new Error('Should not launch'); },
    runtimeFactory: () => { throw new Error('Should not create runtime'); },
  }), /--accept-sends/);
});
