// Imported snapshot messages stay searchable and explicitly distinct from saved observations.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorldService } from '../../src/studio/world-service.mjs';
import { createWorldTransfer } from '../../src/studio/world-transfer.mjs';
import { createWorldSearch } from '../../src/studio/world-search.mjs';
import { Session } from '../../src/store/session.mjs';
import { dataPaths, ensureDataDirs } from '../../src/config.mjs';
import { startStudio } from '../../src/studio/server.mjs';
import { ProfileStore } from '../../src/profiles/profiles.mjs';

function world(t, text = 'saved') {
  const root = mkdtempSync(path.join(os.tmpdir(), 'world-search-import-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = dataPaths(root); ensureDataDirs(paths);
  const session = Session.create(paths.sessions, { site: 'fixture' });
  session.meta.status = 'complete'; session.saveMeta();
  session.kv.set('DOM_TURNS', [{ id: 'observed', role: 'assistant', text, blocks: [{ type: 'future-native', opaque: { marker: text } }] }]);
  return { root, paths, session, service: createWorldService({ paths }) };
}
function bundleOf(service) {
  const cid = service.conversations().items[0].id;
  const project = service.createProject({ title: 'Export', expectedVersion: null });
  service.updateProject(project.id, { conversationIds: [cid], expectedVersion: project.version });
  return createWorldTransfer({ service }).exportSelection({ ids: [project.id], includeSources: true });
}
function restore(target, bundle) {
  const transfer = createWorldTransfer({ service: target });
  const validated = transfer.validateBundle({ bundle });
  assert.equal(validated.valid, true);
  const restored = transfer.restoreBundle({ bundle, digest: validated.digest, dryRun: false, confirm: true });
  assert.deepEqual(restored.failed, []);
  return validated;
}
const searchOf = (service) => createWorldSearch({ service }).search;

test('imported snapshot messages are searchable and keep imported custody', (t) => {
  const source = world(t, 'quartz-import-marker');
  const target = world(t, 'unrelated observed text');
  restore(target.service, bundleOf(source.service));
  const result = searchOf(target.service)({ q: 'quartz-import-marker' });
  assert.equal(result.total, 1);
  const hit = result.items[0];
  assert.equal(hit.kind, 'message');
  assert.equal(hit.custody, 'imported-snapshot');
  assert.equal(hit.contentScope, 'imported-snapshot; not observed');
  assert.equal(hit.source.kind, 'imported-reference');
  assert.match(hit.conversation.id, /^c-i[a-f0-9]{38}$/);
  assert.equal(hit.conversation.id.endsWith('f'), false);
  assert.equal(hit.source.sessionId, null);
  assert.equal(Object.hasOwn(hit.source, 'originSessionId'), false);
  assert.equal(hit.source.sessionId === source.session.id, false);
  assert.equal(typeof hit.importedFrom.digest, 'string');
  assert.equal(typeof hit.importedFrom.originalId, 'string');
  assert.equal(typeof hit.importedFrom.namespaceId, 'string');
  assert.deepEqual(hit.source.importedFrom, hit.importedFrom);
  assert.equal(result.coverage.scanned.importedConversations, 1);
  assert.equal(result.coverage.scanned.observedConversations, 1);
  assert.equal(result.coverage.absent.importedConversations, 0);
});

test('custody filter selects observed, imported, or both and defaults to all', (t) => {
  const observed = world(t, 'observed-only-marker');
  const imported = world(t, 'imported-only-marker');
  restore(observed.service, bundleOf(imported.service));
  const search = searchOf(observed.service);
  assert.deepEqual(search({ q: 'imported-only-marker', custody: 'observed' }).items, []);
  assert.equal(search({ q: 'observed-only-marker', custody: 'imported' }).total, 0);
  assert.equal(search({ q: 'observed-only-marker', custody: 'observed' }).items[0].custody, 'observed');
  const importedOnly = search({ q: 'imported-only-marker', custody: 'imported' });
  assert.equal(importedOnly.total, 1);
  assert.equal(importedOnly.coverage.scanned.observedConversations, 0);
  assert.equal(importedOnly.coverage.scanned.importedConversations, 1);
  const all = search({ q: 'marker' });
  assert.equal(all.coverage.custody, 'all');
  assert.equal(all.total, 2);
  assert.deepEqual(new Set(all.items.map((hit) => hit.custody)), new Set(['observed', 'imported-snapshot']));
});

test('identical text in an observation and two imports stays three rows', (t) => {
  const target = world(t, 'mirrored sentence');
  restore(target.service, bundleOf(world(t, 'mirrored sentence').service));
  restore(target.service, bundleOf(world(t, 'mirrored sentence').service));
  const result = searchOf(target.service)({ q: 'mirrored', kind: 'message' });
  assert.equal(result.total, 3);
  assert.equal(new Set(result.items.map((hit) => hit.id)).size, 3);
  assert.equal(result.items.filter((hit) => hit.custody === 'imported-snapshot').length, 2);
  assert.equal(result.items.filter((hit) => hit.custody === 'observed').length, 1);
});

test('imported hits never claim to be a saved observation', (t) => {
  const source = world(t, 'labelled-import-marker');
  const target = world(t, 'local observation');
  restore(target.service, bundleOf(source.service));
  const hit = searchOf(target.service)({ q: 'labelled-import-marker', custody: 'imported' }).items[0];
  const encoded = JSON.stringify(hit);
  assert.equal(hit.custody, 'imported-snapshot');
  assert.equal(hit.contentScope, 'imported-snapshot; not observed');
  assert.equal(hit.source.kind, 'imported-reference');
  assert.equal(hit.source.sessionId, null);
  assert.equal(Object.hasOwn(hit.source, 'originSessionId'), false);
  assert.match(hit.source.identityScope, /not observed/);
  assert.doesNotMatch(encoded, /saved-observation/);
  assert.doesNotMatch(encoded, /source-observation-alias/);
});

test('imported classification follows custody and importedFrom, not conversation id shape', () => {
  const page = (items) => ({ items, total: items.length, offset: 0, limit: items.length, nextOffset: null });
  const importedId = 'c-' + 'ab'.repeat(20);
  const observedId = `c-i${'a'.repeat(38)}`;
  const origin = 'origin-session-should-not-surface';
  const service = {
    conversations: (q) => page(q.custody === 'observed' ? [] : [{ id: importedId, title: 'Imported', custody: 'imported', importedFrom: { digest: 'd', originalId: 'c-old', namespaceId: 'w' } }, { id: observedId, title: 'Observed shaped', custody: 'observed', importedFrom: null }]),
    conversation(id) {
      if (id === observedId) return { id, messages: [{ id: `${id}:turn:0`, role: 'user', text: 'shape-is-not-custody', blocks: [], source: { sessionId: 'local-session', key: 'DOM_TURNS' } }], coverage: { state: 'saved-observation' } };
      return { id, custody: 'imported', importedFrom: { digest: 'd', originalId: 'c-old', namespaceId: 'w' }, messages: [{ id: `${id}:turn:0`, role: 'user', text: 'provenance-marker', blocks: [], source: { kind: 'imported-reference', sessionId: null, originSessionId: origin, key: 'DOM_TURNS' } }], coverage: { state: 'imported-snapshot' } };
    },
    projects: () => page([]), notes: () => page([]), objects: () => page([]), selections: () => page([]),
  };
  const search = searchOf(service);
  const imported = search({ q: 'provenance-marker', custody: 'imported' }).items[0];
  assert.equal(imported.custody, 'imported-snapshot');
  assert.equal(imported.conversation.id, importedId);
  assert.equal(imported.source.sessionId, null);
  assert.equal(Object.hasOwn(imported.source, 'originSessionId'), false);
  assert.equal(JSON.stringify(imported).includes(origin), false);
  const observed = search({ q: 'shape-is-not-custody' }).items[0];
  assert.equal(observed.custody, 'observed');
  assert.equal(observed.conversation.id, observedId);
  assert.equal(observed.source.sessionId, 'local-session');
});

test('invalid custody is rejected before scanning', (t) => {
  const target = world(t);
  assert.throws(() => searchOf(target.service)({ q: 'saved', custody: 'remote' }), { status: 400, code: 'WORLD_INVALID_INPUT' });
  assert.throws(() => searchOf(target.service)({ q: 'saved', custody: '' }), { status: 400, code: 'WORLD_INVALID_INPUT' });
});

test('Studio search returns an imported snapshot after a real restore', async (t) => {
  const source = world(t, 'hub-import-marker');
  const target = world(t, 'hub local text');
  const bundle = bundleOf(source.service);
  const transfer = createWorldTransfer({ service: target.service });
  const validated = transfer.validateBundle({ bundle });
  transfer.restoreBundle({ bundle, digest: validated.digest, dryRun: false, confirm: true });
  const studio = await startStudio({ paths: target.paths, profileStore: new ProfileStore(target.paths.profiles), port: 0,
    conversationRuntime: { isSessionActive: () => false, close: async () => {}, list: async () => [] } });
  try {
    const call = async (search) => {
      const response = await fetch(`http://127.0.0.1:${studio.port}/api/v1/world/search?${search}`);
      return { status: response.status, data: await response.json() };
    };
    const found = await call('q=hub-import-marker&custody=imported');
    assert.equal(found.status, 200);
    assert.equal(found.data.total, 1);
    assert.equal(found.data.items[0].custody, 'imported-snapshot');
    assert.equal(found.data.items[0].source.kind, 'imported-reference');
    assert.match(found.data.items[0].conversation.id, /^c-i[a-f0-9]{38}$/);
    assert.equal(found.data.items[0].source.sessionId, null);
    assert.equal(Object.hasOwn(found.data.items[0].source, 'originSessionId'), false);
    assert.notEqual(found.data.items[0].source.sessionId, source.session.id);
    assert.equal(found.data.coverage.scanned.importedConversations, 1);
    assert.equal((await call('q=hub-import-marker&custody=remote')).status, 400);
  } finally { await studio.close(); }
});
