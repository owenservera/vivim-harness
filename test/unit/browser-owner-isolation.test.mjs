import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { browserIdentity, checkBrowserOwner, recordBrowserOwner, verifyBrowserOwner } from '../../src/chrome/browser-ownership.mjs';
import { launchChrome } from '../../src/chrome/launch.mjs';

test('dedicated browser marker verifies CDP continuity and rejects origin/port/profile drift', async (t) => {
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

test('launcher refuses to reuse an unowned CDP port without touching tabs', async (t) => {
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
