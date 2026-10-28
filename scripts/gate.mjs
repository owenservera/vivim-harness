#!/usr/bin/env node
// One command for the whole portability gate, identical on Windows and Ubuntu.
// The rows of docs/PORTABILITY.md run in order, and the first failure stops the gate so a broken
// tree never reaches the expensive suite. `--fast` skips the suite and says so out loud: a fast
// pass is a development loop, not a parity claim.
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const fast = process.argv.includes('--fast');
const MINUTE = 60_000;

// `node --test` exits 0 when a glob matches nothing, so a moved or renamed suite would let the
// gate pass with zero tests run. The suite is resolved here instead and an empty match is fatal.
function suiteFiles(dir = 'test/unit', found = []) {
  for (const entry of readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) suiteFiles(rel, found);
    else if (entry.isFile() && entry.name.endsWith('.test.mjs')) found.push(rel);
  }
  return found.sort();
}

// Every step carries a timeout: a hung child must fail the gate by name instead of waiting forever.
const steps = [
  { name: 'architecture', args: ['scripts/architecture-inventory.mjs', '--check'], timeout: 5 * MINUTE },
  { name: 'parity', args: ['--test', 'test/unit/platform-parity.test.mjs', 'test/unit/platform-boundary.test.mjs'], timeout: 5 * MINUTE },
  { name: 'smoke', args: ['scripts/platform-smoke.mjs'], timeout: 10 * MINUTE },
];
if (!fast) {
  let files = [];
  try {
    files = suiteFiles();
  } catch (error) {
    console.error(`\ngate FAILED at suite: cannot read test/unit (${error.message})`);
    process.exit(1);
  }
  if (!files.length) {
    console.error('\ngate FAILED at suite: test/unit/**/*.test.mjs matched no files');
    process.exit(1);
  }
  steps.push({ name: 'suite', args: ['--test', ...files], timeout: 30 * MINUTE });
}

const seconds = (ms) => `${(ms / 1000).toFixed(1)}s`;
const started = Date.now();

console.log(`gate: ${steps.map((step) => step.name).join(' -> ')}  (${process.platform} ${process.version})`);
if (fast) console.log('gate: FAST — the full suite is skipped, so this is not a parity claim.');

for (const step of steps) {
  const at = Date.now();
  const result = spawnSync(process.execPath, step.args, { cwd: root, stdio: 'inherit', timeout: step.timeout });
  if (result.error) {
    const why = result.error.code === 'ETIMEDOUT'
      ? `timed out after ${seconds(step.timeout)}`
      : result.error.message;
    console.error(`\ngate FAILED at ${step.name}: ${why}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`\ngate FAILED at ${step.name} (exit ${result.status}, ${seconds(Date.now() - at)})`);
    process.exit(result.status ?? 1);
  }
  console.log(`gate: ${step.name} ok (${seconds(Date.now() - at)})`);
}

console.log(`gate OK — ${steps.length} steps in ${seconds(Date.now() - started)}${fast ? ' (FAST: suite not run)' : ''}`);
