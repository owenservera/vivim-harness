// World search is a read-only adapter over current saved reads. Source-only tests; no browser, no provider.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorldService } from '../../src/studio/world-service.mjs';
import { createWorldSearch, registerWorldSearchRoutes, WORLD_SEARCH_KINDS } from '../../src/studio/world-search.mjs';
import { Session } from '../../src/store/session.mjs';
import { dataPaths, ensureDataDirs } from '../../src/config.mjs';
import { problem } from '../../src/studio/http.mjs';
import { startStudio } from '../../src/studio/server.mjs';
import { ProfileStore } from '../../src/profiles/profiles.mjs';

function fixture(t, turns = []) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'world-search-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = dataPaths(root); ensureDataDirs(paths);
  const session = Session.create(paths.sessions, { site: 'fixture' });
  session.meta.status = 'complete'; session.saveMeta();
  session.kv.set('DOM_TURNS', turns);
  const world = createWorldService({ paths });
  return { paths, session, world, search: createWorldSearch({ service: world }).search };
}

// Minimal service fixture that honours the real page contract, including its 100-row default.
function pageOf(items, q = {}) {
  const limit = q.limit === undefined ? 100 : Number(q.limit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw problem(400, 'Expected an integer between 1 and 1000');
  const offset = q.offset === undefined ? 0 : Number(q.offset);
  return { items: items.slice(offset, offset + limit), total: items.length, offset, limit,
    nextOffset: offset + limit < items.length ? offset + limit : null };
}
function stubService({ notes = [], conversations = [], failIds = new Set() } = {}) {
  return {
    conversations: (q) => pageOf(conversations.map((c) => c.meta ?? c), q),
    conversation(id) {
      const entry = conversations.find((c) => (c.meta?.id ?? c.id) === id);
      if (!entry || failIds.has(id)) throw Object.assign(new Error('Saved conversation not found'), { status: 404, code: 'WORLD_NOT_FOUND' });
      return entry.detail ?? { id, messages: entry.messages ?? [] };
    },
    projects: (q) => pageOf([], q),
    notes: (q) => pageOf(notes, q),
    objects: (q) => pageOf([], q),
    selections: (q) => pageOf([], q),
    map: () => { throw new Error('world search must not depend on the map endpoint'); },
  };
}
function assertHitShape(hit) {
  assert.equal(typeof hit.id, 'string');
  assert.ok(WORLD_SEARCH_KINDS.includes(hit.kind));
  assert.equal(typeof hit.title, 'string');
  assert.equal(typeof hit.score, 'number');
  assert.equal(typeof hit.snippet, 'string');
  assert.equal(typeof hit.source, 'object');
}

test('note edits are visible on the next query because the index is transient', (t) => {
  const f = fixture(t);
  const note = f.world.writeNote(null, { title: 'Running ledger', body: 'alpha marker', expectedVersion: null });
  const first = f.search({ q: 'alpha' });
  assert.equal(first.total, 1);
  assert.equal(first.items[0].id, note.id);
  assert.equal(first.items[0].kind, 'note');
  assert.equal(first.items[0].source.version, note.version);
  assert.equal(first.coverage.complete, true);
  assert.equal(first.coverage.indexed, 1);

  const updated = f.world.writeNote(note.id, { title: 'Running ledger', body: 'beta marker', expectedVersion: note.version });
  assert.equal(updated.version, note.version + 1);
  assert.equal(f.search({ q: 'alpha' }).total, 0, 'the replaced body is no longer indexed');
  const second = f.search({ q: 'beta' });
  assert.equal(second.total, 1);
  assert.equal(second.items[0].id, note.id);
  assert.match(second.items[0].snippet, /beta marker/);
});

test('rich unknown blocks are searchable by value and field, with alias-qualified source identity', (t) => {
  const turns = [{ id: 'observed-rich', role: 'assistant', text: 'plain answer',
    blocks: [{ type: 'future-native-part', payload: { label: 'quartzite-vein', bytes: [1, 2, 3] } }] }];
  const f = fixture(t, turns);
  const byValue = f.search({ q: 'quartzite-vein', kind: 'message' });
  assert.equal(byValue.total, 1);
  const hit = byValue.items[0];
  assertHitShape(hit);
  assert.equal(hit.kind, 'message');
  assert.equal(hit.source.observedTurnId, 'observed-rich');
  assert.equal(hit.source.key, 'DOM_TURNS');
  assert.match(hit.source.identityScope, /source-observation-alias; not durable part identity/);
  assert.match(hit.snippet, /quartzite-vein/);
  assert.equal(f.search({ q: 'payload', kind: 'message' }).total, 1, 'unknown block field names stay searchable');
});

test('identical text is never deduped across records or kinds', (t) => {
  const f = fixture(t, [{ id: 'observed-dup', role: 'user', text: 'mirrored sentence', blocks: [] }]);
  const a = f.world.writeNote(null, { title: 'A', body: 'mirrored sentence', expectedVersion: null });
  const b = f.world.writeNote(null, { title: 'B', body: 'mirrored sentence', expectedVersion: null });
  const result = f.search({ q: 'mirrored' });
  assert.equal(result.total, 3);
  assert.equal(new Set(result.items.map((hit) => hit.id)).size, 3);
  assert.deepEqual(new Set(result.items.map((hit) => hit.kind)), new Set(['message', 'note']));
  assert.deepEqual(new Set(result.items.filter((hit) => hit.kind === 'note').map((hit) => hit.id)), new Set([a.id, b.id]));
});

test('kind filtering is applied before the top-N cut and skips unneeded scans', (t) => {
  const turns = [1, 2, 3].map((n) => ({ id: `observed-${n}`, role: 'user', text: 'lantern', blocks: [] }));
  const f = fixture(t, turns);
  const filler = Array.from({ length: 200 }, (_, i) => `filler${i}`).join(' ');
  const note = f.world.writeNote(null, { title: 'Lantern note', body: 'lantern ' + filler, expectedVersion: null });

  const all = f.search({ q: 'lantern', limit: '1' });
  assert.equal(all.total, 4);
  assert.equal(all.items.length, 1);
  assert.equal(all.items[0].kind, 'message', 'message hits outrank the long note at the top limit');
  assert.equal(all.coverage.scanned.messages, 3);

  const notesOnly = f.search({ q: 'lantern', kind: 'note', limit: '1' });
  assert.equal(notesOnly.total, 1);
  assert.equal(notesOnly.items.length, 1);
  assert.equal(notesOnly.items[0].id, note.id);
  assert.equal(notesOnly.coverage.scanned.messages, 0, 'a note-scoped query does not read conversations');
  assert.equal(notesOnly.coverage.scanned.conversations, 0);
});

test('paging covers more than the list default and truncation is reported with honest coverage', () => {
  const notes = Array.from({ length: 150 }, (_, i) => ({ id: `n-${i}`, title: `Note ${i}`, body: 'needle', version: 1 }));
  const service = stubService({ notes });
  const calls = [];
  const listNotes = service.notes;
  service.notes = (q) => { calls.push({ ...q }); return listNotes(q); };
  const search = createWorldSearch({ service, limits: { notes: 1000, pageSize: 60 } }).search;

  const first = search({ q: 'needle', kind: 'note', limit: '100' });
  assert.equal(first.total, 150);
  assert.equal(first.items.length, 100);
  assert.equal(first.nextOffset, 100);
  assert.equal(first.offset, 0);
  assert.equal(first.limit, 100);
  assert.equal(first.coverage.scanned.notes, 150, 'all pages were read, not the default 100');
  assert.equal(first.coverage.complete, true);
  assert.equal(first.coverage.truncated, false);
  assert.ok(calls.every((call) => Number.isSafeInteger(call.limit) && call.limit >= 1 && call.limit <= 60
    && Number.isSafeInteger(call.offset)), 'page requests carry explicit bounded offset/limit');

  const second = search({ q: 'needle', kind: 'note', offset: '100', limit: '100' });
  assert.equal(second.items.length, 50);
  assert.equal(second.total, 150);
  assert.equal(second.nextOffset, null);

  const bounded = createWorldSearch({ service, limits: { notes: 10, pageSize: 60 } }).search({
    q: 'needle', kind: 'note' });
  assert.equal(bounded.total, 10, 'total counts matches in the bounded index only');
  assert.equal(bounded.coverage.scanned.notes, 10);
  assert.equal(bounded.coverage.truncated, true);
  assert.equal(bounded.coverage.complete, false);
  assert.deepEqual(bounded.coverage.reasons, ['note-scan-limit']);
  assert.equal(bounded.coverage.limits.notes, 10);
  assert.match(bounded.coverage.qualification, /not that unread or remote content does not exist/);
});

test('item failures are disclosed instead of being reported as a successful empty search', () => {
  const live = { id: 'c-live', title: 'Live', messages: [{ id: 'c-live:turn:0', role: 'user', text: 'survivor text',
    blocks: [], source: { sessionId: 'live', key: 'DOM_TURNS', index: 0, observedTurnId: 'turn-live' } }] };
  const gone = { id: 'c-gone', title: 'Gone' };
  const search = createWorldSearch({ service: stubService({ conversations: [live, gone], failIds: new Set(['c-gone']) }) }).search;

  const partial = search({ q: 'survivor' });
  assert.equal(partial.total, 1);
  assert.equal(partial.items[0].source.sessionId, 'live');
  assert.equal(partial.coverage.complete, false);
  assert.equal(partial.coverage.failures.length, 1);
  assert.equal(partial.coverage.failures[0].id, 'c-gone');
  assert.equal(partial.coverage.failures[0].code, 'WORLD_NOT_FOUND');

  const allGone = createWorldSearch({ service: stubService({ conversations: [gone], failIds: new Set(['c-gone']) }) }).search({ q: 'survivor' });
  assert.equal(allGone.total, 0);
  assert.equal(allGone.coverage.failures.length, 1, 'zero hits with a failure is not a clean empty result');
  assert.equal(allGone.coverage.complete, false);

  const empty = createWorldSearch({ service: stubService() }).search({ q: 'anything' });
  assert.equal(empty.total, 0);
  assert.equal(empty.coverage.complete, true);
  assert.equal(empty.coverage.failures.length, 0);
});

test('source references and selections expose metadata only and survive source loss', (t) => {
  const turns = [{ id: 'observed-object', role: 'user', text: 'private remote payload', blocks: [] }];
  const f = fixture(t, turns);
  const cid = f.world.conversations().items[0].id;
  const object = f.world.createObject({ conversationId: cid, expectedVersion: null });
  const selection = f.world.createSelection({ objectId: object.id, selectionType: 'message', messageIndex: 0,
    partPath: [], expectedVersion: null });

  const content = f.search({ q: 'private' });
  assert.equal(content.total, 1);
  assert.equal(content.items[0].kind, 'message', 'remote reference metadata never indexes source content');
  assert.ok(content.items.every((hit) => hit.kind !== 'source-reference'));

  const refs = f.search({ q: object.id, kind: 'source-reference' });
  assert.equal(refs.total, 1);
  const ref = refs.items[0];
  assertHitShape(ref);
  assert.equal(ref.id, object.id);
  assert.equal(ref.source.sessionId, f.session.id);
  assert.equal(ref.availability, 'locally-available');
  assert.equal(ref.availabilityObserved, 'locally-available');
  assert.equal(ref.availabilityReason, null);
  assert.match(ref.contentScope, /remote content not read/);

  const sel = f.search({ q: selection.id, kind: 'selection' });
  assert.equal(sel.total, 1);
  assert.equal(sel.items[0].source.selectionId, selection.id);
  assert.equal(sel.items[0].source.messageIndex, 0);
  assert.equal(sel.items[0].availabilityReason, null);
  assert.match(sel.items[0].contentScope, /selected content not read/);

  rmSync(f.session.dir, { recursive: true, force: true });
  const after = f.search({ q: object.id, kind: 'source-reference' });
  assert.equal(after.total, 1, 'the local reference remains searchable after the saved source disappears');
  assert.equal(after.items[0].availability, 'missing');
  assert.equal(after.items[0].availabilityObserved, 'missing');
  assert.equal(after.items[0].availabilityReason, 'SOURCE_MISSING');
  assert.equal(after.items[0].source.availabilityReason, 'SOURCE_MISSING');
  assert.equal(after.coverage.complete, true);
});

test('missing DOM_TURNS is disclosed as absent and contributes no searchable content', (t) => {
  const f = fixture(t);
  f.session.kv.remove('DOM_TURNS');
  const result = f.search({ q: 'anything' });
  assert.equal(result.total, 0);
  assert.equal(result.coverage.scanned.conversations, 1);
  assert.equal(result.coverage.scanned.messages, 0);
  assert.deepEqual(result.coverage.absent, { conversations: 1, observedConversations: 1, importedConversations: 0 });
  assert.equal(result.coverage.scanned.observedConversations, 1);
  assert.equal(result.coverage.scanned.importedConversations, 0);
  assert.equal(result.coverage.complete, true);
  assert.ok(result.items.every((hit) => hit.kind !== 'message'), 'absent content never becomes a message hit');
});

test('additive availability states are conservatively unavailable, not deleted content', () => {
  const service = stubService();
  const record = (id, availability, availabilityReason) => ({ id, objectType: 'conversation', conversationId: 'c-x',
    availability, ...(availabilityReason === undefined ? {} : { availabilityReason }),
    source: { sessionId: 'saved-1', kind: 'saved-session' } });
  service.objects = (q) => pageOf([
    record('o-active', 'unavailable', 'SOURCE_ACTIVE'),
    record('o-excluded', 'excluded', 'SOURCE_EXCLUDED'),
    record('o-renamed', 'future-state', null),
    record('o-local', 'locally-available', null),
  ], q);
  const result = createWorldSearch({ service }).search({ q: 'conversation', kind: 'source-reference' });
  assert.equal(result.total, 4);
  const byId = new Map(result.items.map((hit) => [hit.id, hit]));
  for (const id of ['o-active', 'o-excluded', 'o-renamed']) {
    assert.equal(byId.get(id).availability, 'unavailable');
    assert.equal(byId.get(id).source.availability, 'unavailable');
  }
  assert.equal(byId.get('o-active').availabilityObserved, 'unavailable');
  assert.equal(byId.get('o-active').availabilityReason, 'SOURCE_ACTIVE');
  assert.equal(byId.get('o-active').source.availabilityReason, 'SOURCE_ACTIVE');
  assert.equal(byId.get('o-excluded').availabilityReason, 'SOURCE_EXCLUDED');
  assert.equal(byId.get('o-renamed').availabilityReason, null);
  assert.equal(byId.get('o-local').availability, 'locally-available');
  assert.equal(byId.get('o-local').availabilityReason, null);
  assert.match(result.coverage.qualification, /not evidence of deletion/);
});

test('returned unreadable evidence fails coverage instead of a complete empty scan', () => {
  for (const reason of ['METADATA_UNREADABLE', 'EVIDENCE_UNREADABLE']) {
    const service = stubService({ conversations: [{ id: 'c-unreadable', title: 'Unreadable' }] });
    service.conversation = () => ({ id: 'c-unreadable', messages: [], coverage: { state: 'unavailable', reason } });
    const result = createWorldSearch({ service }).search({ q: 'anything' });
    assert.equal(result.total, 0);
    assert.deepEqual(result.items, []);
    assert.equal(result.coverage.complete, false, `${reason} must not be a successful complete scan`);
    assert.equal(result.coverage.scanned.conversations, 1);
    assert.equal(result.coverage.scanned.messages, 0);
    assert.equal(result.coverage.indexed, 0);
    assert.equal(result.coverage.failures.length, 1);
    assert.equal(result.coverage.failures[0].id, 'c-unreadable');
    assert.equal(result.coverage.failures[0].code, reason);
    assert.match(result.coverage.failures[0].message, new RegExp(reason));
    assert.deepEqual(result.coverage.absent, { conversations: 0, observedConversations: 0, importedConversations: 0 }, 'unreadable is not the same as missing');
  }
});

test('invalid q, kind and pagination are HTTP 400 rather than empty success', (t) => {
  const f = fixture(t);
  const bad = (query, pattern) => assert.throws(() => f.search(query), pattern);
  bad({}, { status: 400 });
  bad({ q: '' }, { status: 400 });
  bad({ q: 'x'.repeat(1001) }, { status: 400 });
  bad({ q: 'x', kind: 'bogus' }, { status: 400, code: 'WORLD_INVALID_INPUT' });
  bad({ q: 'x', custody: 'remote' }, { status: 400, code: 'WORLD_INVALID_INPUT' });
  bad(null, { status: 400 });
  for (const page of [{ limit: '0' }, { limit: '1001' }, { limit: '1.5' }, { offset: '-1' }, { offset: 'abc' }, { offset: '1000001' }]) {
    bad({ q: 'x', ...page }, { status: 400 });
  }
  assert.doesNotThrow(() => f.search({ q: 'x', limit: '1', offset: '0' }));
});

test('the registered Studio hub serves /world/search results and 400 validation', async (t) => {
  const f = fixture(t);
  f.world.writeNote(null, { title: 'Hub note', body: 'hubneedle marker', expectedVersion: null });
  const studio = await startStudio({ paths: f.paths, profileStore: new ProfileStore(f.paths.profiles), port: 0,
    conversationRuntime: { isSessionActive: () => false, close: async () => {}, list: async () => [] } });
  try {
    const call = async (search) => {
      const response = await fetch(`http://127.0.0.1:${studio.port}/api/v1/world/search?${search}`);
      return { status: response.status, data: await response.json() };
    };
    const found = await call('q=hubneedle&kind=note');
    assert.equal(found.status, 200);
    assert.equal(found.data.total, 1);
    assert.equal(found.data.items[0].kind, 'note');
    assert.equal(found.data.items[0].title, 'Hub note');
    assert.match(found.data.items[0].snippet, /hubneedle/);
    assert.equal(found.data.coverage.complete, true);
    const invalidQuery = await call('q=');
    assert.equal(invalidQuery.status, 400);
    const invalidKind = await call('q=hubneedle&kind=nope');
    assert.equal(invalidKind.status, 400);
  } finally { await studio.close(); }
});

test('routes are registered on GET /world/search without changing the hub', () => {
  const routes = [];
  const service = stubService();
  registerWorldSearchRoutes({ add: (method, route, summary, handler) => routes.push({ method, route, summary, handler }), service });
  assert.equal(routes.length, 1);
  assert.equal(routes[0].method, 'GET');
  assert.equal(routes[0].route, '/world/search');
  const result = routes[0].handler({ q: { q: 'anything' } });
  assert.equal(result.total, 0);
  assert.throws(() => routes[0].handler({ q: {} }), { status: 400 });
});
