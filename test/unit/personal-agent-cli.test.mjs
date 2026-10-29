import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  const snapshot = path.join(dir, 'agent-export.json');
  writeFileSync(snapshot, JSON.stringify(exported, null, 2));
  const checked = run(dir, 'inspect-export', snapshot);
  assert.equal(checked.checksumVerified, true);
  assert.equal(checked.importSupported, false);
  assert.equal(checked.sourceAuthenticated, false);
  assert.equal(checked.workCount, 1);
  assert.equal(JSON.stringify(checked).includes('Local CLI task'), false);
  const tampered = path.join(dir, 'tampered-export.json');
  const changed = structuredClone(exported);
  changed.payload.work.count = 99;
  writeFileSync(tampered, JSON.stringify(changed, null, 2));
  const failed = spawnSync(process.execPath, [entry, 'personal-agent', 'inspect-export', tampered,
    '--data-dir', dir, '--json'], { encoding: 'utf8', cwd: repo, timeout: 15000 });
  assert.notEqual(failed.status, 0, 'tampered export must exit with a failure');
  assert.equal(failed.stdout.includes('Local CLI task'), false, 'errors never emit user Work details');

  const found = run(dir, 'work');
  assert.equal(found.items[0].status, 'queued');
  assert.equal(found.items[0].title, 'Local CLI task');
  const planned = run(dir, 'plan', found.items[0].id, '--next', 'Review offline evidence');
  assert.equal(planned.item.nextAction, 'Review offline evidence');
  assert.equal(run(dir, 'work').items[0].nextAction, 'Review offline evidence');
  const plannedAgain = run(dir, 'plan', found.items[0].id, '--next', 'Review offline evidence');
  assert.equal(plannedAgain.replayed, true);
  assert.equal(plannedAgain.version, planned.version);
  const advanced = run(dir, 'advance', found.items[0].id, '--to', 'active');
  assert.equal(advanced.work.byStatus.active, 1);
  assert.equal(advanced.item.nextAction, 'Review offline evidence');
  const cleared = run(dir, 'plan', found.items[0].id, '--clear');
  assert.equal(cleared.item.nextAction, null);
  assert.equal(run(dir, 'status').work.byStatus.active, 1);
});
