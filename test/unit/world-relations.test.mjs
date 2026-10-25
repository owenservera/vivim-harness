import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { createWorldService, registerWorldRoutes } from '../../src/studio/world-service.mjs';
import { Session } from '../../src/store/session.mjs';
import { dataPaths, ensureDataDirs } from '../../src/config.mjs';

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'world-relations-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = dataPaths(root); ensureDataDirs(paths);
  const sessions = ['https://chatgpt.com', 'https://other.example'].map((origin) => {
    const s = Session.create(paths.sessions, { site: 'chatgpt' });
    s.meta.status = 'complete'; s.meta.target = { url: origin + '/c/12345678-1234-1234-1234-123456789abc', title: 'same title' };
    // Operational identity does not establish archive account identity.
    s.meta.conversationOwner = { conversationId: 'same-runtime-id', accountId: 'not-archive-proof' }; s.saveMeta();
    s.kv.set('DOM_TURNS', [{ id: 'same-observed-id', role: 'assistant', text: 'same text', blocks: [
      { id: 'part-observed', type: 'future-native', opaque: { custom: [1, 2] } }, { type: 'file', url: 'https://asset.example/file' },
    ] }]);
    return s;
  });
  return { paths, sessions, world: createWorldService({ paths }) };
}

test('qualified identity retains provider/origin/native parser basis without account or cross-source merging', (t) => {
  const f = fixture(t), items = f.world.conversations().items;
  assert.notEqual(items[0].id, items[1].id);
  assert.notEqual(items[0].identity.origin.value, items[1].identity.origin.value);
  for (const r of items) {
    assert.equal(r.identity.provider.value, 'chatgpt');
    assert.equal(r.identity.accountId, null); assert.equal(r.identity.account.state, 'unknown');
  }
  const chatgpt = items.find((r) => r.identity.origin.value === 'https://chatgpt.com');
  assert.ok(chatgpt.identity.nativeThreadId); assert.equal(chatgpt.identity.thread.state, 'qualified-inference');
  const object = f.world.createObject({ conversationId: chatgpt.id, expectedVersion: null });
  assert.match(object.id, /^o-/); assert.notEqual(object.id, chatgpt.id);
  assert.equal(object.namespaceId, f.world.namespace().id);
  const another = f.world.createObject({ conversationId: items.find((r) => r.id !== chatgpt.id).id, expectedVersion: null });
  const selections = [object, another].map((o) => f.world.createSelection({ objectId: o.id, selectionType: 'message', messageIndex: 0, expectedVersion: null }));
  assert.notEqual(selections[0].id, selections[1].id);
  assert.notEqual(selections[0].source.sessionId, selections[1].source.sessionId);
  assert.equal(selections[0].source.observedTurnId, selections[1].source.observedTurnId);
});

test('local selections preserve qualified address, namespace and unknown parts across reopen without copying source', (t) => {
  const f = fixture(t), cid = f.world.conversations().items[0].id;
  const original = new Map(f.sessions.map((s) => [s.id, readFileSync(path.join(s.dir, 'kv', 'DOM_TURNS.json'))]));
  const o = f.world.createObject({ conversationId: cid, expectedVersion: null });
  const s = f.world.createSelection({ objectId: o.id, selectionType: 'part', messageIndex: 0, partPath: [0], expectedVersion: null });
  assert.equal(s.source.observedPartId, 'part-observed'); assert.equal(s.source.observedTurnId, 'same-observed-id');
  assert.equal(s.source.messageIndex, 0); assert.deepEqual(s.source.partPath, [0]);
  const next = createWorldService({ paths: f.paths });
  assert.deepEqual(next.selection(s.id), f.world.selection(s.id));
  assert.deepEqual(next.namespace(), f.world.namespace());
  assert.equal(next.selection(s.id).availability, 'locally-available');
  assert.equal(next.conversation(cid).messages[0].blocks[0].type, 'future-native');
  assert.equal(Object.hasOwn(s, 'blocks'), false);
  for (const session of f.sessions) assert.deepEqual(readFileSync(path.join(session.dir, 'kv', 'DOM_TURNS.json')), original.get(session.id));
  const source = f.sessions.find((x) => x.id === s.source.sessionId);
  source.kv.set('DOM_TURNS', [{ id: 'different-message', text: 'changed', blocks: [] }]);
  assert.equal(next.selection(s.id).availability, 'stale');
  assert.equal(next.selection(s.id).source.observedTurnId, 'same-observed-id');
  rmSync(source.dir, { recursive: true });
  assert.equal(next.selection(s.id).availability, 'missing');
  assert.equal(next.object(o.id).availability, 'missing');
});

test('notes comment on selections, generic associations coexist with old arrays, map IDs match exact local IDs', (t) => {
  const f = fixture(t), cid = f.world.conversations().items[0].id;
  const o = f.world.createObject({ conversationId: cid, expectedVersion: null });
  const s = f.world.createSelection({ objectId: o.id, selectionType: 'artifact', messageIndex: 0, partPath: [1], expectedVersion: null });
  assert.equal(s.coverage.assetBytes, 'not-established');
  const n = f.world.writeNote(null, { title: 'Comment', body: 'Human interpretation', commentsOn: [s.id], expectedVersion: null });
  let p = f.world.createProject({ title: 'Context', expectedVersion: null });
  p = f.world.updateProject(p.id, { expectedVersion: p.version, conversationIds: [cid], noteIds: [n.id], memberIds: [s.id, o.id] });
  assert.deepEqual(p.memberIds, [s.id, o.id]);
  const map = f.world.map({ limit: 1000 });
  assert.equal(map.complete, true);
  for (const id of [cid, p.id, n.id, s.id, o.id]) assert.ok(map.nodes.some((r) => r.id === id));
  assert.ok(map.edges.some((e) => e.from === n.id && e.to === s.id && e.kind === 'comments_on'));
  assert.ok(map.edges.some((e) => e.from === p.id && e.to === o.id && e.kind === 'associates'));
  assert.equal(map.namespaceId, n.namespaceId);
  assert.equal(map.nodes.find((r) => r.id === cid).identity.account.state, 'unknown');
  const focused = f.world.map({ id: n.id });
  assert.ok(focused.nodes.some((r) => r.id === s.id));
  assert.equal(f.world.map({ limit: 1 }).complete, false);
  assert.throws(() => f.world.writeNote(n.id, { title: 'Stale', body: 'X', expectedVersion: 9 }), { code: 'CAS_VERSION_CONFLICT' });
  const edited = f.world.writeNote(n.id, { title: 'Edited', body: 'Y', expectedVersion: 1 });
  assert.deepEqual(edited.commentsOn, [s.id]);
});

test('selection and relation validation rejects ambiguous or unobserved addresses and preserves old APIs', (t) => {
  const f = fixture(t), cid = f.world.conversations().items[0].id;
  const o = f.world.createObject({ conversationId: cid, expectedVersion: null });
  const base = { objectId: o.id, selectionType: 'part', messageIndex: 0, expectedVersion: null };
  for (const partPath of [[], [99], [0, 'constructor'], [0, 'absent']]) assert.throws(() => f.world.createSelection({ ...base, partPath }), { code: 'WORLD_INVALID_INPUT' });
  assert.throws(() => f.world.writeNote(null, { title: 'N', body: 'X', expectedVersion: null, commentsOn: [cid] }), { code: 'WORLD_INVALID_INPUT' });
  const routes = [];
  registerWorldRoutes({ paths: f.paths, add: (method, url, summary, handler) => routes.push({ method, url, handler }) });
  for (const url of ['/world/namespace', '/world/objects', '/world/selections', '/world/map', '/world/conversations', '/world/projects', '/world/notes']) {
    assert.ok(routes.find((r) => r.method === 'GET' && r.url === url));
  }
  const response = routes.find((r) => r.method === 'POST' && r.url === '/world/objects').handler({ body: { conversationId: cid, expectedVersion: null } });
  assert.equal(response.namespaceId, f.world.namespace().id);
});

test('review regression: missing evidence, active sources and removed sources are distinct', (t) => {
  const f = fixture(t), cid = f.world.conversations().items[0].id;
  const o = f.world.createObject({ conversationId: cid, expectedVersion: null });
  const s = f.world.createSelection({ objectId: o.id, selectionType: 'message', messageIndex: 0, expectedVersion: null });
  const source = f.sessions.find((x) => x.id === o.source.sessionId);
  source.kv.remove('DOM_TURNS');
  assert.equal(f.world.object(o.id).availabilityReason, 'EVIDENCE_MISSING');
  assert.equal(f.world.selection(s.id).availability, 'missing');
  const active = createWorldService({ paths: f.paths, isSessionActive: (id) => id === source.id });
  assert.equal(active.object(o.id).availability, 'unavailable');
  assert.equal(active.selection(s.id).availabilityReason, 'SOURCE_ACTIVE');
  assert.throws(() => active.conversation(cid), { code: 'WORLD_SOURCE_ACTIVE' });
  rmSync(source.dir, { recursive: true });
  assert.equal(f.world.object(o.id).availabilityReason, 'SOURCE_MISSING');
});

test('review regression: page before projecting and reuse each transcript once per request', (t) => {
  const f = fixture(t), cid = f.world.conversations().items[0].id;
  const o = f.world.createObject({ conversationId: cid, expectedVersion: null });
  for (let i = 0; i < 3; i++) f.world.createSelection({ objectId: o.id, selectionType: 'message', messageIndex: 0, expectedVersion: null });
  let reads = 0; const original = f.world.conversation;
  f.world.conversation = (...args) => { reads++; return original(...args); };
  assert.equal(f.world.selections({ limit: 2 }).items.length, 2);
  assert.equal(reads, 1, 'same source projected only once for the selected page');
  reads = 0; f.world.selections({ offset: 99, limit: 1 }); assert.equal(reads, 0, 'empty page projects nothing');
  reads = 0; f.world.objects({ offset: 99, limit: 1 }); assert.equal(reads, 0);
  reads = 0; f.world.selections({ limit: 1 }); assert.equal(reads, 1, 'later request refreshes source');
  const a = f.world.createProject({ title: 'A', expectedVersion: null });
  const b = f.world.createProject({ title: 'B', expectedVersion: null });
  const ordered = [a.id, b.id].sort();
  writeFileSync(path.join(f.paths.root, 'world', ordered[1], 'v0001.json'), '{broken');
  assert.equal(f.world.projects({ limit: 1 }).items.length, 1, 'unselected project is not loaded');
  const n1 = f.world.writeNote(null, { title: 'N1', body: '', expectedVersion: null });
  const n2 = f.world.writeNote(null, { title: 'N2', body: '', expectedVersion: null });
  writeFileSync(path.join(f.paths.root, 'world', [n1.id, n2.id].sort()[1], 'v0001.json'), '{broken');
  assert.equal(f.world.notes({ limit: 1 }).items.length, 1, 'unselected note is not loaded');
});

test('review regression: map preserves known reference kind and declares scan bounds; offset rejected', (t) => {
  const f = fixture(t), cid = f.world.conversations().items[0].id;
  let p = f.world.createProject({ title: 'P', expectedVersion: null });
  p = f.world.updateProject(p.id, { conversationIds: [cid], expectedVersion: 1 });
  const source = f.sessions.find((s) => s.id === f.world.conversation(cid).sessionId);
  source.meta.status = 'recording'; source.saveMeta();
  const map = f.world.map({ limit: 1000 });
  const node = map.nodes.find((r) => r.id === cid);
  assert.equal(node.kind, 'conversation');
  assert.equal(node.availabilityReason, 'SOURCE_ACTIVE');
  assert.equal(typeof map.scanned, 'number');
  assert.equal(typeof map.truncated, 'boolean');
  assert.throws(() => f.world.map({ offset: 1 }), { code: 'WORLD_INVALID_INPUT' });
  const note = f.world.writeNote(null, { title: 'Beyond scan', body: '', expectedVersion: null });
  f.world.updateProject(p.id, { noteIds: [note.id], expectedVersion: p.version });
  f.world.notes = () => ({ items: [], total: 1001 });
  const bounded = f.world.map({ limit: 1000 });
  const unresolved = bounded.nodes.find((r) => r.id === note.id);
  assert.equal(unresolved.kind, 'note'); assert.equal(unresolved.availabilityReason, 'NOT_SCANNED');
  assert.equal(bounded.complete, false); assert.equal(bounded.truncated, true);
});

test('review regression: DOM provenance addition does not invalidate old selection fingerprints', (t) => {
  const f = fixture(t), source = f.sessions[0];
  const turns = source.kv.get('DOM_TURNS'); turns[0].domId = 123; turns[0].roleAttribute = 'data-message-author-role'; source.kv.set('DOM_TURNS', turns);
  const cid = f.world.conversations().items.find((r) => r.sessionId === source.id).id;
  const o = f.world.createObject({ conversationId: cid, expectedVersion: null });
  const s = f.world.createSelection({ objectId: o.id, selectionType: 'message', messageIndex: 0, expectedVersion: null });
  const legacyMessages = f.world.conversation(cid).messages.map(({ domId, roleAttribute, ...m }) => {
    const { domId: ignored, ...source } = m.source; return { ...m, source };
  });
  assert.equal(s.source.revision, createHash('sha256').update(JSON.stringify(legacyMessages)).digest('hex'), 'exact legacy fingerprint bytes retained');
  assert.equal(f.world.conversation(cid).messages[0].source.domId, 123);
  assert.equal(f.world.conversation(cid).messages[0].roleAttribute, 'data-message-author-role');
  assert.equal(s.source.domId, 123);
  turns[0].domId = 124; source.kv.set('DOM_TURNS', turns);
  assert.equal(f.world.selection(s.id).availability, 'locally-available', 'legacy fingerprint excludes newly exposed provenance fields');
});

test('review regression: corrupt metadata has controlled coverage instead of a parse failure', (t) => {
  const f = fixture(t), source = f.sessions[0];
  const cid = f.world.conversations().items.find((r) => r.sessionId === source.id).id;
  const o = f.world.createObject({ conversationId: cid, expectedVersion: null });
  writeFileSync(path.join(source.dir, 'session.json'), '{broken');
  assert.equal(f.world.conversation(cid).coverage.state, 'unavailable');
  assert.equal(f.world.conversation(cid).coverage.reason, 'METADATA_UNREADABLE');
  assert.equal(f.world.object(o.id).availabilityReason, 'METADATA_UNREADABLE');
});
