import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromeCandidates, findChrome } from '../../src/chrome/launch.mjs';
import { defaultDataDir, dataPaths } from '../../src/config.mjs';

const repo = fileURLToPath(new URL('../../', import.meta.url));

test('Linux candidate discovery searches PATH and common Chromium packages', () => {
  const candidates = chromeCandidates({ PATH: '/tmp/one:/usr/local/bin' }, 'linux');
  assert.ok(candidates.includes('/tmp/one/chromium'));
  assert.ok(candidates.includes('/usr/local/bin/google-chrome'));
  assert.ok(candidates.includes('/snap/bin/chromium'));
  assert.ok(candidates.includes('/opt/google/chrome/chrome'));
  assert.equal(candidates.length, new Set(candidates).size);
});

test('Windows candidate discovery respects win32 paths on every test host', () => {
  const candidates = chromeCandidates({
    PROGRAMFILES: 'C:\\Program Files',
    'PROGRAMFILES(X86)': 'C:\\Program Files (x86)',
    LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local',
    Path: 'C:\\Tools;D:\\Browsers',
  }, 'win32');
  assert.ok(candidates.includes('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'));
  assert.ok(candidates.includes('C:\\Tools\\chrome.exe'));
  assert.ok(candidates.includes('D:\\Browsers\\msedge.exe'));
});

test('explicit browser path or PATH basename has priority over auto-discovery', (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'vivim-chrome-path-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const name = process.platform === 'win32' ? 'test-browser.exe' : 'test-browser';
  const executable = path.join(directory, name);
  writeFileSync(executable, '');
  assert.ok(existsSync(executable));
  assert.equal(findChrome({ CHROME_PATH: executable, PATH: '' }, process.platform), executable);
  assert.equal(findChrome({ CHROME_PATH: name, PATH: directory, Path: directory }, process.platform), executable);
});

test('Windows and Linux default data directories are external to code', () => {
  assert.equal(defaultDataDir({ LOCALAPPDATA: 'C:\\Safe' }, 'win32'),
    path.join('C:\\Safe', 'AION', 'capture-studio'));
  assert.equal(defaultDataDir({ XDG_DATA_HOME: '/tmp/safe' }, 'linux'),
    path.join('/tmp/safe', 'aion-capture-studio'));
  assert.equal(dataPaths('/tmp/disposable').chromeProfile, path.join('/tmp/disposable', 'chrome-profile'));
});

test('the native launcher command uses the existing Studio browser owner', () => {
  const pkg = JSON.parse(readFileSync(path.join(repo, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['chrome:cdp'], 'node bin/studio.mjs launch');
  assert.equal(pkg.scripts['smoke:platform'], 'node scripts/platform-smoke.mjs');
  assert.equal(pkg.engines.node, '>=22');
});
