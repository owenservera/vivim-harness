#!/usr/bin/env node
// Native Windows/Linux integration smoke. Private roots are disposable; zero Chrome/provider effects.
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
      cwd: root, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true,
    });
    let stdout = '', stderr = '', settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      fn(value);
    };
    const fail = (error) => { if (!settled) child.kill(); settle(reject, error); };
    const timeout = setTimeout(() => fail(new Error(`Studio startup timeout: ${stdout.slice(-200)} ${stderr.slice(-400)}`)), 25000);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      const url = stdout.match(/http:\/\/127\.0\.0\.1:\d+\//)?.[0];
      if (url) settle(resolve, { child, url });
    });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('error', fail);
    child.once('exit', (code, signal) => fail(new Error(`Studio exited early: ${code}/${signal}; ${stderr.slice(-400)}`)));
  });
}

async function stopGracefully(child) {
  if (!child || child.exitCode !== null) return child?.exitCode ?? null;
  const exit = new Promise((resolve) => {
    const timeout = setTimeout(() => resolve({ timedOut: true }), 10000);
    child.once('exit', (code, signal) => { clearTimeout(timeout); resolve({ code, signal }); });
  });
  // bin/studio.mjs routes IPC 'stop' through the existing SIGINT close handler.
  // Unlike process.kill('SIGINT'), this works gracefully on Windows too.
  if (child.connected) child.send({ type: 'stop' });
  const outcome = await exit;
  if (outcome.timedOut) {
    child.kill();
    throw new Error('Studio did not exit after IPC stop within 10 seconds');
  }
  assert.equal(outcome.code, 0, `Graceful Studio exit: ${JSON.stringify(outcome)}`);
  return outcome.code;
}

let child = null, failure = null;
try {
  assert.match(command(['--version']), /^\S+\s+[0-9a-f]{16}\s*$/);
  mark('CLI source version');
  const commands = JSON.parse(command(['commands', '--json']));
  assert.ok(Array.isArray(commands) && commands.some((x) => x.command === 'serve'));
  mark('native CLI command registry');
  const dirs = JSON.parse(command(['paths', '--data-dir', home, '--json']));
  assert.equal(dirs.root, home);
  assert.ok(dirs.sessions.startsWith(home));
  mark('disposable private storage');
  // Structural gate: a moved or newly owned code path must be reflected in the manifest.
  const inventory = spawnSync(process.execPath, [path.join(root, 'scripts', 'architecture-inventory.mjs'), '--check'],
    { cwd: root, encoding: 'utf8', timeout: 25000 });
  if (inventory.error || inventory.status !== 0)
    throw new Error(`architecture inventory: ${inventory.error?.message ?? inventory.stderr ?? inventory.status}`);
  mark('architecture inventory matches components.json');
  const running = await serve();
  child = running.child;
  const read = async (route, type) => {
    const response = await fetch(new URL(route, running.url), { signal: AbortSignal.timeout(10000) });
    assert.equal(response.status, 200, route);
    assert.match(response.headers.get('content-type') ?? '', type, route);
    return response;
  };
  await read('chat', /html/);
  mark('offline saved-world UI shell');
  await read('ui/chat.mjs', /javascript/);
  await read('ui/universal-chat.mjs', /javascript/);
  await read('ui/world-view.mjs', /javascript/);
  mark('all dynamically imported WORLD modules');
  const health = await (await read('api/v1/health', /json/)).json();
  assert.equal(health.apiVersion, 1);
  mark('loopback HTTP API');
} catch (error) {
  failure = error;
} finally {
  try {
    if (child) {
      await stopGracefully(child);
      mark('graceful cross-OS IPC shutdown');
    }
  } catch (error) { failure ??= error; }
  try { rmSync(home, { recursive: true, force: true, maxRetries: 6, retryDelay: 200 }); }
  catch (error) { failure ??= error; }
}
if (failure) {
  process.stderr.write(JSON.stringify({ ...report, ok: false, error: String(failure?.stack ?? failure) }, null, 2) + '\n');
  process.exitCode = 1;
} else {
  process.stdout.write(JSON.stringify({ ...report, ok: true }, null, 2) + '\n');
}
