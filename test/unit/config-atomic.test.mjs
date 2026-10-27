// Disposable, browser-free multi-process coverage for native Windows/Linux config storage.
// Exercise production src/config.mjs; never touch an operator's settings, profile or browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { defaultDataDir, saveUserConfig } from '../../src/config.mjs';

const MODULE_URL = new URL('../../src/config.mjs', import.meta.url).href;
function disposableRoot(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'vivim-config-atomic-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('config save publishes one complete private JSON document and no temporary files', (t) => {
  const root = disposableRoot(t);
  const file = path.join(root, 'settings', 'config.json');
  saveUserConfig(file, { color: 'always', studioPort: 7880 });
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { color: 'always', studioPort: 7880 });
  saveUserConfig(file, { color: 'never', studioPort: 7881 });
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { color: 'never', studioPort: 7881 });
  assert.deepEqual(readdirSync(path.dirname(file)), ['config.json']);
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o077, 0);
});

test('separate OS processes save intact snapshots without shared .tmp collisions', { timeout: 30000 }, async (t) => {
  const root = disposableRoot(t), file = path.join(root, 'config.json');
  // Before this fix, 8 simultaneous Linux/Node22 writers sharing config.json.tmp reproduced
  // ENOENT rename errors. No locks, browser, network access or user data required here.
  const worker = [
    "const [file, moduleUrl, worker] = process.argv.slice(1);",
    "const { saveUserConfig } = await import(moduleUrl);",
    "for (let i = 0; i < 60; i++) saveUserConfig(file, { worker: Number(worker), sequence: i, guard: 'x'.repeat(128) });",
  ].join('\n');
  const runs = Array.from({ length: 6 }, (_, i) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', worker, file, MODULE_URL, String(i)],
      { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let error = '';
    child.stderr.on('data', (chunk) => { error += chunk; });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error('worker ' + i + ' exited ' + code + '/' + signal + ': ' + error.slice(0, 500)));
    });
  }));
  await Promise.all(runs);
  const final = JSON.parse(readFileSync(file, 'utf8'));
  assert.ok(Number.isInteger(final.worker) && final.worker >= 0 && final.worker < 6);
  assert.equal(final.sequence, 59);
  assert.equal(final.guard, 'x'.repeat(128));
  assert.deepEqual(readdirSync(root), ['config.json'], 'no leftover partial temp files');
});

test('relative XDG_DATA_HOME is ignored rather than writing private Linux data under cwd', () => {
  const expected = path.join(os.homedir(), '.local', 'share', 'aion-capture-studio');
  assert.equal(defaultDataDir({ XDG_DATA_HOME: 'my-relative-folder' }, 'linux'), expected);
  assert.equal(defaultDataDir({ XDG_DATA_HOME: './private' }, 'linux'), expected);
  assert.equal(defaultDataDir({ XDG_DATA_HOME: '/var/tmp/vivim-fixture' }, 'linux'),
    path.join('/var/tmp/vivim-fixture', 'aion-capture-studio'));
});
