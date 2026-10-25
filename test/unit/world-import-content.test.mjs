import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { stableStringify } from '../../src/intel/similarity.mjs';
import { createWorldService } from '../../src/studio/world-service.mjs';
import { createWorldTransfer } from '../../src/studio/world-transfer.mjs';
import { Session } from '../../src/store/session.mjs';
import { dataPaths, ensureDataDirs } from '../../src/config.mjs';

const resign = (bundle) => {
  for (const record of bundle.records ?? []) {
    const { observed, sha256, ...stored } = record;
    record.sha256 = createHash('sha256').update(stableStringify(stored)).digest('hex');
  }
  const { integrity, ...payload } = bundle;
  bundle.integrity = { ...integrity, sha256: createHash('sha256').update(stableStringify(payload)).digest('hex') };
  return bundle;
};
const names = (root) => readdirSync(path.join(root, 'world')).sort();
function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'world-import-content-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = dataPaths(root); ensureDataDirs(paths);
  const session = Session.create(paths.sessions, { site: 'fixture' });
  session.meta.status = 'complete'; session.saveMeta();
  session.kv.set('DOM_TURNS', [{ role: 'assistant', text: 'saved', blocks: [{ type: 'future-native', opaque: { kept: true } }] }]);
  const source = createWorldService({ paths });
  const bundle = createWorldTransfer({ service: source }).exportSelection({ ids: [source.conversations().items[0].id], includeSources: true });
  const targetRoot = mkdtempSync(path.join(os.tmpdir(), 'world-import-content-target-'));
  t.after(() => rmSync(targetRoot, { recursive: true, force: true }));
  const targetPaths = dataPaths(targetRoot); ensureDataDirs(targetPaths);
  return { bundle, targetPaths, target: createWorldService({ paths: targetPaths }), transfer: createWorldTransfer({ service: createWorldService({ paths: targetPaths }) }) };
}
function mutate(bundle, change) {
  const copy = structuredClone(bundle);
  change(copy.records.find((record) => record.custody === 'saved-observation').data.messages[0]);
  return resign(copy);
}

test('referenced-only conversations are not stored and do not break listing', (t) => {
  const f = fixture(t);
  const referenced = structuredClone(f.bundle);
  const conversation = referenced.records.find((record) => record.kind === 'conversation');
  conversation.custody = 'referenced-only';
  delete conversation.data.messages;
  resign(referenced);
  const report = f.transfer.validateBundle({ bundle: referenced });
  assert.equal(report.valid, true);
  assert.ok(report.unresolved.some((item) => item.reason === 'REFERENCE_ONLY'));
  const restored = f.transfer.restoreBundle({ bundle: referenced, digest: report.digest, dryRun: false, confirm: true });
  assert.equal(restored.applied.includes(conversation.id), false);
  assert.doesNotThrow(() => f.target.conversations({ custody: 'all' }));
});

test('capture-sized text and odd roles survive export validation; nested and unbounded input fail closed', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'world-import-parity-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = dataPaths(root); ensureDataDirs(paths);
  const session = Session.create(paths.sessions, { site: 'fixture' });
  session.meta.status = 'complete'; session.saveMeta();
  session.kv.set('DOM_TURNS', [{ role: 'Assistant', text: 'x'.repeat(262144), blocks: [{ type: 'list', items: [{ blocks: [{ type: 'code', text: 'nested' }] }] }] }]);
  const bundle = createWorldTransfer({ service: createWorldService({ paths }) }).exportSelection({ ids: [createWorldService({ paths }).conversations().items[0].id], includeSources: true });
  assert.equal(createWorldTransfer({ service: createWorldService({ paths }) }).validateBundle({ bundle }).valid, true);
  const bad = mutate(bundle, (message) => { message.blocks = [{ type: 'list', items: [{ blocks: [{ type: 'code', constructor: { bad: true } }] }] }]; });
  assert.ok(createWorldTransfer({ service: createWorldService({ paths }) }).validateBundle({ bundle: bad }).errors.some((error) => error.code === 'WORLD_IMPORT_CONTENT'));
  const numeric = structuredClone(bundle);
  numeric.records.find((record) => record.kind === 'conversation').data.memberIds = 12;
  resign(numeric);
  assert.doesNotThrow(() => createWorldTransfer({ service: createWorldService({ paths }) }).validateBundle({ bundle: numeric }));
  const cyclic = structuredClone(bundle); cyclic.loop = cyclic;
  assert.throws(() => createWorldTransfer({ service: createWorldService({ paths }) }).validateBundle({ bundle: cyclic }), (error) => error.status === 400 && error.code === 'WORLD_IMPORT_CONTENT');
});

test('unknown imported blocks stay inert while malformed messages are rejected before any restore write', (t) => {
  const f = fixture(t);
  const good = f.transfer.validateBundle({ bundle: f.bundle });
  assert.equal(good.valid, true, 'recorded unknown block type is inert import content');
  const restored = f.transfer.restoreBundle({ bundle: f.bundle, digest: good.digest, dryRun: false, confirm: true });
  const localId = good.idMap[f.bundle.records.find((record) => record.kind === 'conversation').id];
  assert.deepEqual(f.target.conversation(localId).messages[0].blocks, [{ type: 'future-native', opaque: { kept: true } }]);
  assert.equal(f.target.conversation(localId).coverage.state, 'imported-snapshot');
  assert.equal(restored.failed.length, 0);
  for (const [index, change] of [
    (message) => { message.blocks = 'not-an-array'; },
    (message) => { message.text = 12; },
    (message) => { message.role = 7; },
    (message) => { message.text = 'x'.repeat(262145); },
    (message) => { message.blocks = [{ type: 'future-native', constructor: { bad: true } }]; },
  ].entries()) {
    const bundle = mutate(f.bundle, change);
    const before = names(f.targetPaths.root);
    const report = f.transfer.validateBundle({ bundle });
    assert.equal(report.valid, false, `case ${index}: ${JSON.stringify(report.errors)}`);
    assert.ok(report.errors.some((error) => error.code === 'WORLD_IMPORT_CONTENT'));
    assert.throws(() => f.transfer.restoreBundle({ bundle, digest: report.digest, dryRun: false, confirm: true }), (error) => error.code === 'WORLD_IMPORT_CONTENT' && error.report.errors.some((item) => item.code === 'WORLD_IMPORT_CONTENT'));
    assert.deepEqual(names(f.targetPaths.root), before);
  }
});
