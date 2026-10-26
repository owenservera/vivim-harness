#!/usr/bin/env node
// Native Windows/Linux smoke test. Never launches Chrome, sends provider traffic,
// changes an existing profile, or touches the operator's real data directory.
import { spawnSync } from 'node:child_process';
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
  process.stdout.write(JSON.stringify({ ok: true, platform: process.platform, node: process.version, checks: results }, null, 2) + '\n');
} catch (error) {
  process.stderr.write(JSON.stringify({ ok: false, platform: process.platform, checks: results, failure: error.message }, null, 2) + '\n');
  process.exitCode = 1;
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
