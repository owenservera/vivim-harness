#!/usr/bin/env node
// Node-only, disposable, local-loopback smoke: no Chrome, provider send or private user profile.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = path.join(root, 'bin', 'studio.mjs');
const home = mkdtempSync(path.join(os.tmpdir(), 'vivim-platform-smoke-'));
const env = { ...process.env, CAPTURE_STUDIO_HOME: home };
const report = { platform: process.platform, node: process.version, checks: [] };
const mark = (what) => report.checks.push(what);

function command(args) {
  const res = spawnSync(process.execPath, [cli, ...args], {
    cwd: root, env, encoding: 'utf8', timeout: 25000, maxBuffer: 2 * 1024 * 1024,
  });
  if (res.error || res.status !== 0)
    throw new Error(`studio ${args.join(' ')}: ${res.error?.message ?? res.stderr ?? res.status}`);
  return res.stdout;
}

function serve() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'serve', '--no-open', '--studio-port', '0', '--data-dir', home], {
      cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let stdout = '', stderr = '', settled = false;
    const fail = (error) => { if (!settled) child.kill(); settle(reject, error); };
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      fn(value);
    };
    const timeout = setTimeout(() => fail(new Error(`Studio timeout: ${stdout.slice(-200)} ${stderr.slice(-400)}`)), 25000);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      const url = stdout.match(/http:\/\/127\.0\.0\.1:\d+\//)?.[0];
      if (url) settle(resolve, { child, url });
    });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('error', fail);
    child.once('exit', (code, signal) => fail(new Error(`Studio exited: ${code}/${signal}; ${stderr.slice(-400)}`)));
  });
}

let child = null;
try {
  assert.match(command(['--version']), /0\.1\.0\s+[0-9a-f]{16}/);
  mark('CLI source version');
  const commands = JSON.parse(command(['commands', '--json']));
  assert.ok(Array.isArray(commands) && commands.some((x) => x.command === 'serve'));
  mark('CLI command registry');
  const dataPaths = JSON.parse(command(['paths', '--data-dir', home, '--json']));
  assert.equal(dataPaths.root, home);
  assert.ok(dataPaths.sessions.startsWith(home));
  mark('disposable private storage');
  const running = await serve();
  child = running.child;
  const read = async (route, type) => {
    const response = await fetch(new URL(route, running.url), { signal: AbortSignal.timeout(10000) });
    assert.equal(response.status, 200, route);
    assert.match(response.headers.get('content-type') ?? '', type);
    return response;
  };
  await read('chat', /html/);
  mark('offline saved-world UI shell');
  await read('ui/chat.mjs', /javascript/);
  await read('ui/universal-chat.mjs', /javascript/);
  await read('ui/world-view.mjs', /javascript/);
  mark('every dynamically imported UI module');
  const health = await (await read('api/v1/health', /json/)).json();
  assert.equal(health.apiVersion, 1);
  mark('loopback HTTP API');
  process.stdout.write(JSON.stringify({ ...report, ok: true }, null, 2) + '\n');
} catch (error) {
  process.stderr.write(JSON.stringify({ ...report, ok: false, error: String(error?.stack ?? error) }, null, 2) + '\n');
  process.exitCode = 1;
} finally {
  if (child && child.exitCode === null) {
    child.kill();
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ]);
  }
  rmSync(home, { recursive: true, force: true, maxRetries: 6, retryDelay: 200 });
}
