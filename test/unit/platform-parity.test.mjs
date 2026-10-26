// Contract tests for the single native Windows/Linux browser-discovery implementation.
// Filesystem probes are injected; no live browser or operating-system spoofing required.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { chromeCandidates, findChrome } from '../../src/chrome/launch.mjs';
import { defaultDataDir, dataPaths } from '../../src/config.mjs';

test('Linux: detects distro, snap, Edge and binaries installed on PATH', () => {
  const items = chromeCandidates({ PATH: '/home/dev/.local/bin:/usr/local/bin:/usr/bin' }, 'linux');
  for (const expected of [
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/snap/bin/chromium',
    '/opt/google/chrome/chrome', '/usr/bin/microsoft-edge',
    '/home/dev/.local/bin/google-chrome', '/usr/local/bin/chromium',
  ]) assert.ok(items.includes(expected), expected);
  assert.equal(items.length, new Set(items).size, 'candidate list should have no duplicates');
});

test('Windows: honors path.win32 syntax and PATH case variants, with override first', () => {
  const env = {
    CHROME_PATH: 'D:\\Portable Browser\\chrome.exe',
    'PROGRAMFILES': 'C:\\Program Files',
    'PROGRAMFILES(X86)': 'C:\\Program Files (x86)',
    Path: 'D:\\Apps;C:\\Tools',
  };
  const items = chromeCandidates(env, 'win32');
  assert.equal(items[0], env.CHROME_PATH);
  assert.ok(items.includes('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'));
  assert.ok(items.includes('D:\\Apps\\chrome.exe'));
  assert.ok(items.includes('C:\\Tools\\msedge.exe'));
  assert.ok(items.every(p => !p.startsWith('/usr/')));
});

test('Linux: CHROME_PATH and PATH precede fallbacks using injected filesystem probe', () => {
  const env = { CHROME_PATH: '/opt/private/chrome', PATH: '/custom/bin' };
  assert.equal(findChrome(env, 'linux', p => p === '/opt/private/chrome' || p === '/usr/bin/chromium'), '/opt/private/chrome');
  assert.equal(findChrome({ PATH: '/custom/bin' }, 'linux', p => p === '/custom/bin/chromium'), '/custom/bin/chromium');
  assert.throws(() => findChrome({ PATH: '' }, 'linux', () => false), /CHROME_PATH/);
});

test('Data roots are OS-native but layout contract is shared', () => {
  const win = defaultDataDir({ LOCALAPPDATA: 'C:\\Users\\Test\\AppData\\Local' }, 'win32');
  const linux = defaultDataDir({ XDG_DATA_HOME: '/home/test/.local/share' }, 'linux');
  assert.match(win, /capture-studio$/);
  assert.ok(linux.startsWith('/home/test/.local/share/'));
  assert.equal(defaultDataDir({ CAPTURE_STUDIO_HOME: '/custom/root' }, 'linux'), '/custom/root');
  for (const root of [win, linux]) {
    const paths = dataPaths(root);
    assert.equal(paths.root, root);
    assert.equal(paths.chromeProfile, path.join(root, 'chrome-profile'));
    assert.equal(paths.sessions, path.join(root, 'sessions'));
  }
});

test('Portable Chrome launch shortcut never calls OS-specific shell', async () => {
  const { readFile } = await import('node:fs/promises');
  const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.scripts['chrome:cdp'], 'node bin/studio.mjs launch');
});

test('CI matrix includes native Linux and Windows for both supported Node majors', async () => {
  const { readFile } = await import('node:fs/promises');
  const workflow = await readFile(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  assert.match(workflow, /ubuntu-latest/);
  assert.match(workflow, /windows-latest/);
  assert.match(workflow, /node: \['22', '24'\]/);
});
