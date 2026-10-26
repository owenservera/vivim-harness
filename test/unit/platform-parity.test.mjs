// Contract tests for the single native Windows/Linux browser-discovery implementation.
// Filesystem probes are injected; no live browser or operating-system spoofing required.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { chromeCandidates, findChrome, launchChrome } from '../../src/chrome/launch.mjs';
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

test('Linux: non-executable discovered browser fails as a caught error, not a Node crash', { timeout: 20000 }, async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX execute bit is not a Windows contract');
  const root = mkdtempSync(path.join(os.tmpdir(), 'vivim-browser-error-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fake = path.join(root, 'chromium');
  writeFileSync(fake, 'not-an-executable\n');
  chmodSync(fake, 0o644);
  const old = process.env.CHROME_PATH;
  process.env.CHROME_PATH = fake;
  t.after(() => {
    if (old === undefined) delete process.env.CHROME_PATH;
    else process.env.CHROME_PATH = old;
  });
  const freePortProbe = net.createServer();
  await new Promise((resolve) => freePortProbe.listen(0, '127.0.0.1', resolve));
  const port = freePortProbe.address().port;
  await new Promise((resolve) => freePortProbe.close(resolve));
  await assert.rejects(
    launchChrome({ profileDir: path.join(root, 'browser-profile'), port, headless: true }),
    /Could not launch browser/,
  );
});
