#!/usr/bin/env node
// Native Windows/Linux smoke test. Never launches Chrome, sends provider traffic,
// changes an existing profile, or touches the operator's real data directory.
import { spawn, spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = mkdtempSync(path.join(os.tmpdir(), 'vivim platform smoke '));
const results = [];

function run(name, file, args, verify = () => {}) {
  const r = spawnSync(process.execPath, [file, ...args], {
    cwd: root, encoding: 'utf8', timeout: 90_000,
    env: { ...process.env, CAPTURE_STUDIO_HOME: scratch },
    windowsHide: true,
  });
  if (r.error) throw new Error(`${name}: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`${name}: exit=${r.status}\n${r.stderr}\n${r.stdout}`);
  let payload;
  if (args.includes('--json')) {
    try { payload = JSON.parse(r.stdout); }
    catch { throw new Error(`${name}: output is not JSON: ${r.stdout.slice(0, 500)}`); }
  }
  verify(payload, r.stdout);
  results.push({ name, outcome: 'pass' });
}


async function exerciseLoopbackWorld() {
  // Exercise the real installed Studio, not an in-process substitute or synthetic DOM.
  // An IPC channel ensures graceful cross-platform shutdown without signals on Windows.
  const cli = path.join(root, 'bin', 'studio.mjs');
  const child = spawn(process.execPath, [cli, 'serve', '--no-open', '--studio-port', '0', '--data-dir', scratch], {
    cwd: root, env: { ...process.env, CAPTURE_STUDIO_HOME: scratch },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true,
  });
  let stdout = '', stderr = '', settled = false;
  let resolveStartup, rejectStartup;
  const started = new Promise((resolve, reject) => { resolveStartup = resolve; rejectStartup = reject; });
  const startupTimer = setTimeout(() => fail(new Error('Studio startup timeout: ' + stderr.slice(-500))), 25000);
  const fail = (error) => {
    if (settled) return;
    settled = true;
    clearTimeout(startupTimer);
    rejectStartup(error);
  };
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
    const match = stdout.match(/http:\/\/127\.0\.0\.1:\d+\//);
    if (match && !settled) {
      settled = true;
      clearTimeout(startupTimer);
      resolveStartup(match[0]);
    }
  });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  child.once('error', fail);
  child.once('exit', (code, signal) => fail(new Error('Studio exited early: ' + code + '/' + signal + ' ' + stderr.slice(-500))));
  let failed = null;
  try {
    const base = await started;
    const verify = async (route, contentType) => {
      const response = await fetch(new URL(route, base), { signal: AbortSignal.timeout(10000) });
      assert.equal(response.status, 200, route);
      assert.match(response.headers.get('content-type') ?? '', contentType, route);
      return response;
    };
    await verify('chat', /html/);
    for (const module of ['chat.mjs', 'universal-chat.mjs', 'world-view.mjs'])
      await verify('ui/' + module, /javascript/);
    const health = await (await verify('api/v1/health', /json/)).json();
    assert.equal(health.apiVersion, 1, 'Studio API contract');
  } catch (error) { failed = error; }
  finally {
    if (child.exitCode === null) {
      const stopped = new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ timedOut: true }), 10000);
        child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
      });
      if (child.connected) child.send({ type: 'stop' });
      const status = await stopped;
      if (status.timedOut) {
        child.kill();
        failed ??= new Error('Studio IPC shutdown timed out');
      } else if (status.code !== 0) {
        failed ??= new Error('Studio exit after IPC stop: ' + JSON.stringify(status));
      }
    }
  }
  if (failed) throw failed;
  results.push({ name: 'real-loopback-world-ui-api-and-ipc-stop', outcome: 'pass' });
}

try {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node 22+ required');
  const cli = path.join(root, 'bin', 'studio.mjs');
  run('architecture', path.join(root, 'scripts', 'architecture-inventory.mjs'), ['--check']);
  run('cli-version', cli, ['version', '--json'], value => {
    if (!value?.version || !value?.collectorSourceSha) throw new Error('version contract missing');
  });
  run('cli-command-registry', cli, ['commands', '--json'], value => {
    if (!Array.isArray(value) || !value.some(c => c.command === 'start') || !value.some(c => c.command === 'doctor')) {
      throw new Error('start/doctor command registry missing');
    }
  });
  run('portable-paths-with-spaces', cli, ['paths', '--json', '--data-dir', scratch], value => {
    if (value?.root !== scratch || value?.chromeProfile !== path.join(scratch, 'chrome-profile')) {
      throw new Error('portable data root mismatch');
    }
  });
  await exerciseLoopbackWorld();
  process.stdout.write(JSON.stringify({ ok: true, platform: process.platform, node: process.version, checks: results }, null, 2) + '\n');
} catch (error) {
  process.stderr.write(JSON.stringify({ ok: false, platform: process.platform, checks: results, failure: error.message }, null, 2) + '\n');
  process.exitCode = 1;
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
