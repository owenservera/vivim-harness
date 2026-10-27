#!/usr/bin/env node
// One command for the whole portability gate, identical on Windows and Ubuntu.
// The rows of docs/PORTABILITY.md run in order, and the first failure stops the gate so a broken
// tree never reaches the expensive suite. `--fast` skips the suite and says so out loud: a fast
// pass is a development loop, not a parity claim.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const fast = process.argv.includes('--fast');

const steps = [
  { name: 'architecture', args: ['scripts/architecture-inventory.mjs', '--check'] },
  { name: 'parity', args: ['--test', 'test/unit/platform-parity.test.mjs', 'test/unit/platform-boundary.test.mjs'] },
  { name: 'smoke', args: ['scripts/platform-smoke.mjs'] },
  ...(fast ? [] : [{ name: 'suite', args: ['--test', 'test/unit/**/*.test.mjs'] }]),
];

const seconds = (ms) => `${(ms / 1000).toFixed(1)}s`;
const started = Date.now();

console.log(`gate: ${steps.map((step) => step.name).join(' -> ')}  (${process.platform} ${process.version})`);
if (fast) console.log('gate: FAST — the full suite is skipped, so this is not a parity claim.');

for (const step of steps) {
  const at = Date.now();
  const result = spawnSync(process.execPath, step.args, { cwd: root, stdio: 'inherit' });
  if (result.error) {
    console.error(`\ngate FAILED at ${step.name}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`\ngate FAILED at ${step.name} (exit ${result.status}, ${seconds(Date.now() - at)})`);
    process.exit(result.status ?? 1);
  }
  console.log(`gate: ${step.name} ok (${seconds(Date.now() - at)})`);
}

console.log(`gate OK — ${steps.length} steps in ${seconds(Date.now() - started)}${fast ? ' (FAST: suite not run)' : ''}`);
