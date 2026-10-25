import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { createWorldTransfer, WORLD_EXPORT_LIMITS } from '../../src/studio/world-transfer.mjs';
import { createWorldService } from '../../src/studio/world-service.mjs';
import { Session } from '../../src/store/session.mjs';
import { dataPaths, ensureDataDirs } from '../../src/config.mjs';
import { stableStringify } from '../../src/intel/similarity.mjs';
import { startStudio } from '../../src/studio/server.mjs';
import { ProfileStore } from '../../src/profiles/profiles.mjs';

const sha = (value) => createHash('sha256').update(stableStringify(value)).digest('hex');
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
  const root = mkdtempSync(path.join(os.tmpdir(), 'world-transfer-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = dataPaths(root); ensureDataDirs(paths);
  const session = Session.create(paths.sessions, { site: 'fixture' }); session.meta.status = 'complete'; session.saveMeta();
  const blocks = [{ type: 'future-native-part', opaque: { text: '  exact\n<bytes>\u0000', values: [null, 0, false] } }];
  session.kv.set('DOM_TURNS', [{ id: 'observed', domId: 12, role: 'assistant', text: 'answer', blocks }]);
  const service = createWorldService({ paths }), cid = service.conversations().items[0].id;
  const object = service.createObject({ conversationId: cid, expectedVersion: null });
  const selection = service.createSelection({ objectId: object.id, selectionType: 'part', messageIndex: 0, partPath: [0], expectedVersion: null });
  const note = service.writeNote(null, { title: 'N', body: 'Human note', commentsOn: [selection.id], expectedVersion: null });
  let project = service.createProject({ title: 'P', expectedVersion: null });
  project = service.updateProject(project.id, { expectedVersion: 1, noteIds: [note.id] });
  const unrelated = service.writeNote(null, { title: 'Unrelated', body: 'Never export', expectedVersion: null });
  return { root, paths, session, blocks, service, cid, object, selection, note, project, unrelated };
}

test('selected dependency closure exports exact IDs, rich snapshots and qualifiers, never unrelated records', (t) => {
  const f = fixture(t), bundle = createWorldTransfer({ service: f.service }).exportSelection({ ids: [f.project.id], includeSources: true });
  assert.equal(bundle.schema, 'vivim.world-export/1');
  assert.equal(bundle.namespace.id, f.service.namespace().id);
  assert.deepEqual(bundle.records.map((r) => r.id).sort(), [f.project.id, f.note.id, f.selection.id, f.object.id, f.cid].sort());
  assert.ok(!bundle.records.some((r) => r.id === f.unrelated.id));
  assert.equal(bundle.records.find((r) => r.id === f.note.id).custody, 'user-overlay');
  const source = bundle.records.find((r) => r.id === f.cid);
  assert.equal(source.custody, 'saved-observation');
  assert.deepEqual(source.data.messages[0].blocks, f.blocks);
  assert.equal(source.data.identity.account.state, 'unknown');
  assert.equal(bundle.coverage.complete, true);
  assert.equal(bundle.coverage.providerCompleteness, 'not-established');
  for (const { sha256, observed, ...record } of bundle.records) { assert.equal(sha256, sha(record)); assert.equal(Object.hasOwn(record, 'observed'), false); }
  const { integrity, ...payload } = bundle; assert.equal(integrity.sha256, sha(payload));
  assert.deepEqual(createWorldTransfer({ service: f.service }).exportSelection({ ids: [f.project.id], includeSources: true }), bundle);
});

test('default export is reference-only for source content; deterministic hashes and original versions remain unchanged', (t) => {
  const f = fixture(t), before = tree(f.root), transfer = createWorldTransfer({ service: f.service });
  const a = transfer.exportSelection({ ids: [f.project.id] });
  const b = transfer.exportSelection({ ids: [f.project.id, f.project.id] });
  assert.deepEqual(a, b);
  const source = a.records.find((r) => r.id === f.cid);
  assert.equal(source.custody, 'referenced-only'); assert.equal(Object.hasOwn(source.data, 'messages'), false);
  assert.ok(a.omitted.some((r) => r.id === f.cid && r.reason === 'SOURCES_NOT_REQUESTED'));
  assert.equal(a.coverage.complete, true, 'complete for declared references-only scope, not native content');
  assert.equal(a.records.find((r) => r.id === f.project.id).data.version, 2);
  transfer.exportSelection({ ids: [f.project.id], includeSources: true });
  assert.deepEqual(tree(f.root), before);
});

test('active, missing, absent evidence and unreadable sources are omissions, never empty evidence snapshots', (t) => {
  const f = fixture(t);
  const active = createWorldService({ paths: f.paths, isSessionActive: () => true });
  const bundle = createWorldTransfer({ service: active }).exportSelection({ ids: [f.object.id], includeSources: true });
  assert.ok(bundle.omitted.some((r) => r.id === f.cid && r.reason === 'SOURCE_ACTIVE'));
  assert.equal(bundle.coverage.complete, false);
  assert.ok(bundle.records.every((r) => r.custody !== 'saved-observation'));
  f.session.kv.remove('DOM_TURNS');
  const absent = createWorldTransfer({ service: f.service }).exportSelection({ ids: [f.object.id], includeSources: true });
  assert.ok(absent.omitted.some((r) => r.id === f.cid && r.reason === 'EVIDENCE_MISSING'));
  const unreadable = { ...f.service, conversation: () => ({ id: f.cid, messages: [], coverage: { state: 'unavailable', reason: 'METADATA_UNREADABLE' } }) };
  const broken = createWorldTransfer({ service: unreadable }).exportSelection({ ids: [f.cid], includeSources: true });
  assert.ok(broken.omitted.some((r) => r.reason === 'METADATA_UNREADABLE'));
  rmSync(f.session.dir, { recursive: true });
  const missing = createWorldTransfer({ service: f.service }).exportSelection({ ids: [f.object.id], includeSources: true });
  assert.ok(missing.omitted.some((r) => r.id === f.cid && r.reason === 'SOURCE_MISSING'));
  assert.ok(!missing.records.some((r) => r.id === f.cid));
});

test('malformed requests fail before reads; cycles terminate and traversal/size caps fail explicitly', (t) => {
  const f = fixture(t), transfer = createWorldTransfer({ service: f.service });
  for (const body of [null, {}, { ids: [] }, { ids: ['../path'] }, { ids: ['n-bad'] }, { ids: [f.cid], includeSources: 'yes' }, { ids: [f.cid], destination: 'file' }]) {
    assert.throws(() => transfer.exportSelection(body), { code: 'WORLD_EXPORT_INVALID_INPUT' });
  }
  const id = (n) => 'p-00000000-0000-0000-0000-' + String(n).padStart(12, '0');
  let reads = 0;
  const fake = { namespace: () => f.service.namespace(), project: (key) => { reads++; return { id: key, kind: 'project', memberIds: [key === id(1) ? id(2) : id(1)] }; } };
  const cyclic = createWorldTransfer({ service: fake }).exportSelection({ ids: [id(1)] });
  assert.equal(cyclic.records.length, 2); assert.equal(reads, 2);
  fake.project = (key) => ({ id: key, kind: 'project', memberIds: [id(Number(key.slice(-12)) + 1)] });
  assert.throws(() => createWorldTransfer({ service: fake }).exportSelection({ ids: [id(1)] }), { code: 'WORLD_EXPORT_LIMIT' });
  fake.project = (key) => ({ id: key, kind: 'project', text: 'x'.repeat(WORLD_EXPORT_LIMITS.maxRecordBytes + 1) });
  assert.throws(() => createWorldTransfer({ service: fake }).exportSelection({ ids: [id(1)] }), { code: 'WORLD_EXPORT_LIMIT' });
  fake.project = (key) => ({ id: key, kind: 'project', noteIds: {} });
  assert.throws(() => createWorldTransfer({ service: fake }).exportSelection({ ids: [id(1)] }), { code: 'WORLD_EXPORT_INVALID_RECORD' });
});

test('partial observations and missing selected IDs are declared incomplete; unexpected errors are not swallowed', (t) => {
  const f = fixture(t), turns = f.session.kv.get('DOM_TURNS');
  turns[0].truncated = 100; f.session.kv.set('DOM_TURNS', turns);
  const partial = createWorldTransfer({ service: f.service }).exportSelection({ ids: [f.cid], includeSources: true });
  assert.equal(partial.coverage.complete, false);
  assert.equal(partial.records[0].custody, 'saved-observation');
  assert.equal(partial.records[0].data.coverage.state, 'partial');
  assert.ok(partial.omitted.some((o) => o.reason === 'PARTIAL_SOURCE_OBSERVATION'));
  const missing = createWorldTransfer({ service: f.service }).exportSelection({ ids: ['n-00000000-0000-0000-0000-000000000000'] });
  assert.equal(missing.coverage.complete, false); assert.equal(missing.records.length, 0);
  const error = new Error('unexpected owner failure');
  assert.throws(() => createWorldTransfer({ service: { namespace: f.service.namespace, note: () => { throw error; } } })
    .exportSelection({ ids: [f.note.id] }), (e) => e === error);
});

test('stored export hash ignores later evidence changes and re-exports imported IDs', (t) => {
  const f = fixture(t), transfer = createWorldTransfer({ service: f.service });
  const first = transfer.exportSelection({ ids: [f.object.id, f.selection.id], includeSources: true });
  f.session.kv.set('DOM_TURNS', [{ id: 'changed-observed-id', role: 'assistant', text: 'changed content', blocks: [] }]);
  const second = transfer.exportSelection({ ids: [f.object.id, f.selection.id], includeSources: true });
  assert.equal(second.records.find((record) => record.id === f.object.id).sha256, first.records.find((record) => record.id === f.object.id).sha256);
  assert.equal(second.records.find((record) => record.id === f.selection.id).observed.availability, 'stale');
  assert.equal(first.records.find((record) => record.id === f.selection.id).observed.availability, 'locally-available');
  assert.equal(first.namespace.role, 'origin-namespace');
  assert.equal(first.records.find((record) => record.kind === 'conversation').data.identity.qualification, 'imported-claim-on-restore');
  const stale = transfer.exportSelection({ ids: [f.selection.id], includeSources: true });
  assert.equal(stale.records.some((record) => record.kind === 'conversation' && record.custody === 'saved-observation'), false);
  assert.ok(stale.omitted.some((item) => item.id === f.selection.id && item.reason === 'REVISION_CHANGED'));
});

test('real Studio export endpoint returns JSON, 400 and 413 without modifying source or overlay', async (t) => {
  const f = fixture(t);
  const studio = await startStudio({ paths: f.paths, profileStore: new ProfileStore(f.paths.profiles), port: 0,
    conversationRuntime: { isSessionActive: () => false, close: async () => {}, list: async () => [] } });
  try {
    const call = async (body) => {
      const response = await fetch(`http://127.0.0.1:${studio.port}/api/v1/world/transfer/export`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return { status: response.status, data: await response.json() };
    };
    const before = tree(f.root);
    assert.equal((await call({ ids: [f.project.id], includeSources: true })).status, 200);
    assert.equal((await call({ ids: ['../path'] })).status, 400);
    assert.deepEqual(tree(f.root), before);
    f.session.kv.set('DOM_TURNS', [{ role: 'assistant', text: 'x'.repeat(WORLD_EXPORT_LIMITS.maxRecordBytes + 1) }]);
    const oversizedBefore = tree(f.root), oversized = await call({ ids: [f.cid], includeSources: true });
    assert.equal(oversized.status, 413); assert.equal(oversized.data.code, 'WORLD_EXPORT_LIMIT');
    assert.deepEqual(tree(f.root), oversizedBefore);
  } finally { await studio.close(); }
});
