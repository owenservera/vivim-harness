import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { stableStringify } from '../../src/intel/similarity.mjs';
import os from 'node:os';
import path from 'node:path';
import { createWorldService } from '../../src/studio/world-service.mjs';
import { createWorldTransfer } from '../../src/studio/world-transfer.mjs';
import { Session } from '../../src/store/session.mjs';
import { dataPaths, ensureDataDirs } from '../../src/config.mjs';
import { startStudio } from '../../src/studio/server.mjs';
import { ProfileStore } from '../../src/profiles/profiles.mjs';

function tree(root, prefix = '') {
  const out = {};
  for (const entry of readdirSync(path.join(root, prefix), { withFileTypes: true })) {
    const name = path.join(prefix, entry.name);
    if (entry.isDirectory()) Object.assign(out, tree(root, name));
    else out[name] = createHash('sha256').update(readFileSync(path.join(root, name))).digest('hex');
  }
  return out;
}
function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'world-restore-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = dataPaths(root); ensureDataDirs(paths);
  const session = Session.create(paths.sessions, { site: 'fixture' });
  session.meta.status = 'complete'; session.saveMeta();
  session.kv.set('DOM_TURNS', [{ id: 'observed', role: 'assistant', text: 'saved', blocks: [{ type: 'future-native', opaque: { x: 1 } }] }]);
  const source = createWorldService({ paths });
  const cid = source.conversations().items[0].id;
  const object = source.createObject({ conversationId: cid, expectedVersion: null });
  const selection = source.createSelection({ objectId: object.id, selectionType: 'part', messageIndex: 0, partPath: [0], expectedVersion: null });
  const note = source.writeNote(null, { title: 'Note', body: 'user', commentsOn: [selection.id], expectedVersion: null });
  let project = source.createProject({ title: 'Project', expectedVersion: null });
  project = source.updateProject(project.id, { expectedVersion: 1, conversationIds: [cid], noteIds: [note.id], memberIds: [object.id, selection.id] });
  const bundle = createWorldTransfer({ service: source }).exportSelection({ ids: [project.id], includeSources: true });
  const targetRoot = mkdtempSync(path.join(os.tmpdir(), 'world-restore-target-'));
  t.after(() => rmSync(targetRoot, { recursive: true, force: true }));
  const targetPaths = dataPaths(targetRoot); ensureDataDirs(targetPaths);
  return { root, paths, session, source, bundle, targetPaths, target: createWorldService({ paths: targetPaths }) };
}

test('restore round trip uses new IDs, imported custody and recomputed selection revision', (t) => {
  const f = fixture(t), transfer = createWorldTransfer({ service: f.target });
  const validated = transfer.validateBundle({ bundle: f.bundle });
  assert.equal(validated.valid, true);
  assert.equal(Object.values(validated.idMap).every((id, index, all) => id !== Object.keys(validated.idMap)[index] && all.indexOf(id) === index), true);
  const dry = transfer.restoreBundle({ bundle: f.bundle, digest: validated.digest });
  assert.equal(dry.dryRun, true); assert.equal(dry.applied.length, 0);
  const restored = transfer.restoreBundle({ bundle: f.bundle, digest: validated.digest, dryRun: false, confirm: true });
  assert.deepEqual(restored.failed, []); assert.equal(restored.partial, false); assert.ok(restored.receipt);
  const localConversation = validated.idMap[f.bundle.records.find((record) => record.kind === 'conversation').id];
  const opened = f.target.conversation(localConversation);
  assert.equal(opened.coverage.state, 'imported-snapshot');
  assert.equal(opened.source.kind, 'imported-reference');
  assert.deepEqual(opened.messages[0].blocks, [{ type: 'future-native', opaque: { x: 1 } }]);
  const localSelection = validated.idMap[f.bundle.records.find((record) => record.kind === 'selection').id];
  assert.equal(f.target.selection(localSelection).availability, 'locally-available');
  assert.equal(f.target.conversations().items.some((item) => item.id === localConversation), false);
  assert.equal(f.target.conversations({ custody: 'imported' }).items[0].custody, 'imported');
  assert.equal(f.target.map({ limit: 1000 }).nodes.find((node) => node.id === localConversation).provenance, 'imported-snapshot');
});

test('repeat import skips without version 2; conflicting content collides; dangling references stay unresolved', (t) => {
  const f = fixture(t), transfer = createWorldTransfer({ service: f.target });
  const first = transfer.restoreBundle({ bundle: f.bundle, digest: f.bundle.integrity.sha256, dryRun: false, confirm: true });
  const before = tree(f.targetPaths.root);
  const second = transfer.restoreBundle({ bundle: f.bundle, digest: f.bundle.integrity.sha256, dryRun: false, confirm: true });
  assert.equal(second.applied.length, 0); assert.equal(second.skipped.length, first.applied.length);
  assert.deepEqual(tree(f.targetPaths.root), before);
  assert.equal(first.applied.length > 0, true);
  const collisionRoot = mkdtempSync(path.join(os.tmpdir(), 'world-collision-'));
  t.after(() => rmSync(collisionRoot, { recursive: true, force: true }));
  const collisionPaths = dataPaths(collisionRoot); ensureDataDirs(collisionPaths);
  const collisionWorld = createWorldService({ paths: collisionPaths });
  const noteId = f.bundle.records.find((record) => record.kind === 'note').id;
  const occupied = transfer.validateBundle({ bundle: f.bundle }).idMap[noteId];
  collisionWorld.importRecord(occupied, { id: occupied, kind: 'note', title: 'Occupied', body: 'different', importedFrom: { digest: '0'.repeat(64), originalId: noteId, namespaceId: f.bundle.namespace.id } });
  const collision = createWorldTransfer({ service: collisionWorld }).restoreBundle({ bundle: f.bundle, digest: f.bundle.integrity.sha256, dryRun: false, confirm: true });
  assert.equal(collision.partial, true);
  assert.ok(collision.failed.some((failure) => failure.code === 'WORLD_IMPORT_COLLISION'));
});

const resign = (bundle) => {
  for (const record of bundle.records ?? []) {
    const { observed, sha256, ...stored } = record;
    record.sha256 = createHash('sha256').update(stableStringify(stored)).digest('hex');
  }
  const { integrity, ...payload } = bundle;
  bundle.integrity = { ...integrity, sha256: createHash('sha256').update(stableStringify(payload)).digest('hex') };
  return bundle;
};

test('review: imported snapshots stay imported across re-export and dangling restore does not fabricate bindings', (t) => {
  const f = fixture(t), source = createWorldTransfer({ service: f.source }), target = createWorldTransfer({ service: f.target });
  const restored = target.restoreBundle({ bundle: f.bundle, digest: f.bundle.integrity.sha256, dryRun: false, confirm: true });
  assert.equal(restored.failed.length, 0);
  const again = createWorldTransfer({ service: f.target }).exportSelection({ ids: restored.applied.map((id) => target.validateBundle({ bundle: f.bundle }).idMap[id]).filter((id) => id?.startsWith('c-')), includeSources: true });
  const snapshot = again.records.find((record) => record.kind === 'conversation');
  assert.equal(snapshot.custody, 'imported-snapshot');
  assert.equal(again.coverage.sourceSnapshotsIncluded, 0);
  assert.equal(snapshot.data.messages[0].source.kind, 'imported-reference');
  assert.equal(snapshot.data.messages[0].source.sessionId, null);
  const dangling = structuredClone(f.bundle);
  dangling.records.find((record) => record.kind === 'note').data.commentsOn.push('s-00000000-0000-0000-0000-000000000000');
  resign(dangling);
  const report = target.validateBundle({ bundle: dangling });
  assert.equal(report.valid, true);
  assert.ok(report.unresolved.some((item) => item.reason === 'NOT_IN_BUNDLE'));
  const applied = target.restoreBundle({ bundle: dangling, digest: report.digest, dryRun: false, confirm: true });
  assert.equal(applied.failed.length, 0);
  assert.equal(applied.partial, true);
});

test('review: duplicate IDs, kind disagreement, stripped coverage and stale dependents are explicit', (t) => {
  const f = fixture(t), transfer = createWorldTransfer({ service: f.target });
  const duplicate = structuredClone(f.bundle);
  duplicate.records.push(structuredClone(duplicate.records[0]));
  resign(duplicate);
  assert.equal(transfer.validateBundle({ bundle: duplicate }).valid, false);
  const mismatched = structuredClone(f.bundle);
  const note = mismatched.records.find((record) => record.kind === 'note');
  note.kind = 'project'; resign(mismatched);
  assert.ok(transfer.validateBundle({ bundle: mismatched }).errors.some((error) => error.code === 'WORLD_IMPORT_RECORD_CONFLICT'));
  const stripped = structuredClone(f.bundle); delete stripped.omitted; delete stripped.coverage; resign(stripped);
  const coverage = transfer.validateBundle({ bundle: stripped });
  assert.equal(coverage.valid, false);
  assert.ok(coverage.errors.some((error) => error.code === 'WORLD_IMPORT_COVERAGE_MISSING'));
  const stale = structuredClone(f.bundle);
  stale.records.find((record) => record.kind === 'source-reference').observed = { availability: 'stale', availabilityReason: 'REVISION_CHANGED' };
  resign(stale);
  const result = transfer.restoreBundle({ bundle: stale, digest: stale.integrity.sha256, dryRun: false, confirm: true });
  assert.equal(result.partial, true);
  assert.ok(result.skipped.includes(stale.records.find((record) => record.kind === 'selection').id));
  assert.deepEqual(f.target.loadImportRecord(result.receipt).skipped, result.skipped);
});

test('tampered digest fails, sessions remain unchanged, and a mid-run fault converges on retry', (t) => {
  const f = fixture(t), sessionsBefore = tree(f.paths.sessions);
  const tampered = structuredClone(f.bundle); tampered.records[0].data.title = 'tampered';
  assert.equal(createWorldTransfer({ service: f.target }).validateBundle({ bundle: tampered }).valid, false);
  let calls = 0;
  const original = f.target.importRecord.bind(f.target);
  f.target.importRecord = (id, value) => { if (++calls === 3) throw new Error('injected fault'); return original(id, value); };
  const failed = createWorldTransfer({ service: f.target }).restoreBundle({ bundle: f.bundle, digest: f.bundle.integrity.sha256, dryRun: false, confirm: true });
  assert.equal(failed.partial, true); assert.equal(failed.failed.length, 1); assert.ok(failed.receipt);
  f.target.importRecord = original;
  const converged = createWorldTransfer({ service: f.target }).restoreBundle({ bundle: f.bundle, digest: f.bundle.integrity.sha256, dryRun: false, confirm: true });
  assert.equal(converged.failed.length, 0); assert.equal(converged.partial, false);
  assert.deepEqual(tree(f.paths.sessions), sessionsBefore);
  assert.deepEqual(tree(f.targetPaths.sessions), {});
});

test('real Studio validate and restore endpoints preserve source bytes and require confirmation', async (t) => {
  const f = fixture(t), before = tree(f.paths.root);
  const studio = await startStudio({ paths: f.paths, profileStore: new ProfileStore(f.paths.profiles), port: 0,
    conversationRuntime: { isSessionActive: () => false, close: async () => {}, list: async () => [] } });
  try {
    const call = async (route, body) => {
      const response = await fetch(`http://127.0.0.1:${studio.port}/api/v1/world/transfer/${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return { status: response.status, data: await response.json() };
    };
    const validated = await call('validate', { bundle: f.bundle });
    assert.equal(validated.status, 200); assert.equal(validated.data.valid, true);
    const sessionsBefore = tree(path.join(f.paths.root, 'sessions'));
    assert.deepEqual(tree(path.join(f.paths.root, 'sessions')), sessionsBefore);
    const refused = await call('restore', { bundle: f.bundle, digest: validated.data.digest, dryRun: false });
    assert.equal(refused.status, 400); assert.equal(refused.data.code, 'WORLD_IMPORT_CONFIRMATION_REQUIRED');
    const restored = await call('restore', { bundle: f.bundle, digest: validated.data.digest, dryRun: false, confirm: true });
    assert.equal(restored.status, 200); assert.deepEqual(restored.data.failed, []);
    assert.deepEqual(tree(path.join(f.paths.root, 'sessions')), sessionsBefore);
  } finally { await studio.close(); }
});
