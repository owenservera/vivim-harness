import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const studio = path.join(root, 'bin', 'studio.mjs');
const run = (...args) => spawnSync(process.execPath, [studio, ...args], {
  cwd: path.dirname(root), encoding: 'utf8',
});

test('agent context is discoverable and returns only the checkout context offline', () => {
  const help = run('help', 'agent');
  assert.equal(help.status, 0);
  assert.match(help.stdout, /context.*ordinary agents.*not measured probes/);
  const capabilities = run('agent', 'capabilities', '--json');
  assert.equal(JSON.parse(capabilities.stdout).contextCommand, 'studio agent context');
  const dataDir = path.join(root, `nonexistent-context-test-${process.pid}`);
  assert.equal(existsSync(dataDir), false);
  const result = run('agent', 'context', '--json', '--data-dir', dataDir);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { source: 'context.md', content: readFileSync(path.join(root, 'context.md'), 'utf8') });
  assert.equal(existsSync(dataDir), false);
  const human = run('agent', 'context');
  assert.equal(human.stdout, readFileSync(path.join(root, 'context.md'), 'utf8'));
});

test('agent context rejects extra arguments', () => {
  const result = run('agent', 'context', 'other.md', '--json');
  assert.equal(result.status, 2);
  assert.equal(JSON.parse(result.stderr).error.code, 'USAGE');
});
