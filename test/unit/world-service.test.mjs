import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorldService } from '../../src/studio/world-service.mjs';
import { Session } from '../../src/store/session.mjs';
import { dataPaths, ensureDataDirs } from '../../src/config.mjs';
import { startStudio } from '../../src/studio/server.mjs';
import { ProfileStore } from '../../src/profiles/profiles.mjs';

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'world-core-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = dataPaths(root); ensureDataDirs(paths);
  const session = Session.create(paths.sessions, { site: 'fixture' });
  session.meta.status = 'complete'; session.saveMeta();
  const blocks = [{ type: 'code', language: 'js', text: 'a < b' }, { type: 'future-native-part', opaque: { bytes: [1, 2] } }];
  session.kv.set('DOM_TURNS', [{ id: 'observed-1', role: 'assistant', text: 'answer', blocks }]);
  return { paths, session, blocks, world: createWorldService({ paths }) };
}

test('rich saved conversations survive reopen without flattening unknown parts or inventing identity', (t) => {
  const f = fixture(t), id = f.world.conversations().items[0].id;
  const opened = f.world.conversation(id);
  assert.deepEqual(opened.messages[0].blocks, f.blocks);
  assert.equal(opened.identity.state, 'unknown');
  assert.equal(opened.coverage.fullNativeThread, 'unknown');
  assert.equal(opened.messages[0].source.observedTurnId, 'observed-1');
  assert.deepEqual(createWorldService({ paths: f.paths }).conversation(id), opened);
  opened.messages[0].blocks[0].text = 'edited';
  assert.equal(f.world.conversation(id).messages[0].blocks[0].text, 'a < b');
});

test('projects and notes persist with CAS; link and unlink never edit source', (t) => {
  const f = fixture(t), cid = f.world.conversations().items[0].id;
  const source = path.join(f.session.dir, 'kv', 'DOM_TURNS.json'), before = readFileSync(source);
  let p = f.world.createProject({ title: 'Core', expectedVersion: null });
  let n = f.world.writeNote(null, { title: 'Note', body: 'first', expectedVersion: null });
  p = f.world.updateProject(p.id, { conversationIds: [cid], noteIds: [n.id], expectedVersion: p.version });
  const reopened = createWorldService({ paths: f.paths });
  assert.deepEqual(reopened.project(p.id).conversationIds, [cid]);
  n = reopened.writeNote(n.id, { title: 'Note', body: 'second', expectedVersion: n.version });
  assert.equal(reopened.note(n.id).body, 'second');
  assert.throws(() => f.world.writeNote(n.id, { title: 'Note', body: 'stale', expectedVersion: 1 }), { code: 'CAS_VERSION_CONFLICT' });
  assert.throws(() => f.world.updateProject(p.id, { title: 'stale', expectedVersion: 1 }), { code: 'CAS_VERSION_CONFLICT' });
  p = reopened.updateProject(p.id, { conversationIds: [], noteIds: [], expectedVersion: p.version });
  assert.deepEqual(p.conversationIds, []);
  assert.equal(reopened.note(n.id).body, 'second');
  assert.deepEqual(readFileSync(source), before);
  assert.deepEqual(f.world.conversation(cid).messages[0].blocks, f.blocks);
});

test('link validates targets, missing evidence is truthful, and active sessions are excluded', (t) => {
  const f = fixture(t), cid = f.world.conversations().items[0].id;
  const p = f.world.createProject({ title: 'P', expectedVersion: null });
  assert.throws(() => f.world.updateProject(p.id, { conversationIds: ['c-' + '0'.repeat(40)], expectedVersion: 1 }), { code: 'WORLD_NOT_FOUND' });
  assert.throws(() => f.world.updateProject(p.id, { noteIds: ['n-missing'], expectedVersion: 1 }), { code: 'WORLD_NOT_FOUND' });
  f.session.kv.remove('DOM_TURNS');
  assert.equal(f.world.conversation(cid).coverage.state, 'missing');
  f.session.kv.set('DOM_TURNS', [{ role: 'user', text: 'partial', truncated: 200 }]);
  assert.equal(f.world.conversation(cid).coverage.state, 'partial');
  assert.equal(f.world.conversation(cid).messages[0].truncated, true);
  assert.equal(f.world.conversation(cid).messages[0].truncatedOriginalLength, 200, 'source scanner length survives world read');
  assert.deepEqual(createWorldService({ paths: f.paths, isSessionActive: () => true }).conversations().items, []);
  assert.throws(() => f.world.conversation('../escape'), { code: 'WORLD_INVALID_INPUT' });
  assert.throws(() => f.world.createProject({ title: '', expectedVersion: null }), { code: 'WORLD_INVALID_INPUT' });
});

test('source-scoped IDs differ across sessions, unlink survives source removal, and invalid edits do not commit', (t) => {
  const f = fixture(t);
  const other = Session.create(f.paths.sessions, { site: 'fixture' });
  other.meta.status = 'complete'; other.saveMeta();
  other.kv.set('DOM_TURNS', f.session.kv.get('DOM_TURNS'));
  const conversations = f.world.conversations().items;
  assert.equal(new Set(conversations.map((c) => c.id)).size, 2);
  assert.notEqual(f.world.conversation(conversations[0].id).messages[0].id, f.world.conversation(conversations[1].id).messages[0].id);
  let p = f.world.createProject({ title: 'P', expectedVersion: null });
  const cid = conversations.find((c) => c.sessionId === other.id).id;
  p = f.world.updateProject(p.id, { conversationIds: [cid], expectedVersion: 1 });
  rmSync(other.dir, { recursive: true });
  assert.throws(() => f.world.conversation(cid), { code: 'WORLD_NOT_FOUND' });
  p = f.world.updateProject(p.id, { conversationIds: [], expectedVersion: p.version });
  assert.equal(p.version, 3);
  assert.throws(() => f.world.updateProject(p.id, { title: 'X' }), { code: 'WORLD_INVALID_INPUT' });
  assert.throws(() => f.world.writeNote(null, { title: 'N', body: 'x'.repeat(200001), expectedVersion: null }), { code: 'WORLD_INVALID_INPUT' });
  assert.throws(() => f.world.createProject({ title: 'P', expectedVersion: null, extra: 'ignored?' }), { code: 'WORLD_INVALID_INPUT' });
  assert.equal(f.world.project(p.id).version, 3);
  assert.equal(f.world.notes().total, 0);
});

test('world routes run through the existing Studio HTTP hub, including CAS wire errors', async (t) => {
  const f = fixture(t);
  const studio = await startStudio({ paths: f.paths, profileStore: new ProfileStore(f.paths.profiles), port: 0,
    conversationRuntime: { isSessionActive: () => false, close: async () => {}, list: async () => [] } });
  // Close before fixture cleanup on Windows.
  try {
    const api = async (url, method = 'GET', body) => {
      const r = await fetch(`http://127.0.0.1:${studio.port}/api/v1/world${url}`, { method,
        headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: r.status, data: await r.json() };
    };
    const listed = await api('/conversations?limit=1');
    assert.equal(listed.status, 200); assert.equal(listed.data.total, 1);
    const rich = await api('/conversations/' + listed.data.items[0].id);
    assert.deepEqual(rich.data.messages[0].blocks, f.blocks);
    const created = await api('/projects', 'POST', { title: 'HTTP', expectedVersion: null });
    assert.equal(created.status, 200);
    const id = created.data.id;
    assert.equal((await api('/projects/' + id, 'PUT', { title: 'Changed', expectedVersion: 1 })).data.version, 2);
    const conflict = await api('/projects/' + id, 'PUT', { title: 'Stale', expectedVersion: 1 });
    assert.equal(conflict.status, 409); assert.equal(conflict.data.code, 'CAS_VERSION_CONFLICT');
    assert.equal((await api('/projects/' + id)).data.title, 'Changed');
    assert.equal((await api('/conversations', 'POST', {})).status, 405);
    const note = await api('/notes', 'POST', { title: 'N', body: 'text', expectedVersion: null });
    assert.equal((await api('/notes/' + note.data.id)).data.provenance, 'user-authored');
  } finally { await studio.close(); }
});
