import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const entry = path.join(repo, 'bin', 'studio.mjs');
function run(dir, ...words) {
  const result = spawnSync(process.execPath, [entry, 'personal-agent', ...words, '--data-dir', dir, '--json'], {
    encoding: 'utf8', cwd: repo, timeout: 15000,
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
test('native personal-agent CLI is a resumable local lifecycle with no Studio or Chrome process', { timeout: 30000 }, t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'personal-agent-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const before = run(dir, 'status');
  assert.equal(before.initialized, false);
  const initial = run(dir, 'bootstrap');
  assert.equal(initial.initialized, true);
  assert.equal(initial.nextStage, null);
  const same = run(dir, 'bootstrap');
  assert.equal(same.version, initial.version);
  const work = run(dir, 'queue', '--title', 'Local CLI task',
    '--objective', 'No provider effects', '--key', 'cli_work_idempotency_001');
  assert.equal(work.work.byStatus.queued, 1);
  const self = run(dir, 'self', 'work');
  assert.equal(self.answers.work.value.total, 1);
  const sitrep = run(dir, 'sitrep');
  assert.equal(sitrep.workCoverage.openTotal, 1);
  const exported = run(dir, 'export');
  assert.equal(exported.payload.work.detailsOmitted, true);
  assert.equal(exported.payload.memory.detailsOmitted, true);
  const found = run(dir, 'work');
  assert.equal(found.items[0].status, 'queued');
  assert.equal(found.items[0].title, 'Local CLI task');
  const advanced = run(dir, 'advance', found.items[0].id, '--to', 'active');
  assert.equal(advanced.work.byStatus.active, 1);
  assert.equal(run(dir, 'status').work.byStatus.active, 1);
});
