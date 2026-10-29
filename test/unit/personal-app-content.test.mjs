// Real, isolated VersionedStore persistence: no browser or AI provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createPersonalAppService } from '../../src/studio/personal-app-service.mjs';
import { createPersonalAppContentService } from '../../src/studio/personal-app-content.mjs';

const now = '2026-10-29T12:00:00.000Z';
function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'vivim-mobile-content-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = { root };
  const appOwner = () => createPersonalAppService({ paths, clock: () => now });
  const app = appOwner().create({ title: 'My World', intent: 'Local notes and tasks',
    idempotencyKey: 'mobile-app-123456789' }).app;
  return { app, make: () => createPersonalAppContentService({ paths, apps: appOwner(),
    clock: () => now }) };
}
test('first content read does not write, and a local note survives service restart', t => {
  const f = fixture(t), service = f.make();
  assert.deepEqual(service.get(f.app.id).items, []);
  assert.equal(service.get(f.app.id).version, 0);
  const saved = service.createItem({ id: f.app.id, expectedVersion: 0,
    idempotencyKey: 'note-create-123456', kind: 'note', title: 'Idea', body: 'One local idea' });
  assert.equal(saved.replayed, false);
  assert.equal(saved.content.version, 1);
  assert.equal(saved.item.completed, false);
  assert.equal(f.make().get(f.app.id).items[0].body, 'One local idea');
  assert.equal(f.make().get(f.app.id).items[0].origin, 'explicit-user-input');
});
test('lost reply is safe to retry with same key; changed input is rejected', t => {
  const f = fixture(t), service = f.make();
  const params = { id: f.app.id, expectedVersion: 0, idempotencyKey: 'task-create-123456',
    kind: 'task', title: 'Call supplier', body: '' };
  const first = service.createItem(params);
  const retry = f.make().createItem(params);
  assert.equal(retry.replayed, true);
  assert.equal(retry.content.version, first.content.version);
  assert.equal(retry.item.id, first.item.id);
  assert.equal(f.make().get(f.app.id).items.length, 1);
  assert.throws(() => service.createItem({ ...params, title: 'Another task' }),
    error => error.code === 'PERSONAL_APP_CONTENT_IDEMPOTENCY_CONFLICT');
});
test('task completion is CAS-fenced, durable and can be reversed by a new explicit action', t => {
  const f = fixture(t), service = f.make();
  const item = service.createItem({ id: f.app.id, expectedVersion: 0,
    idempotencyKey: 'task-completion-12345', kind: 'task', title: 'Finish UI' }).item;
  const done = service.setTaskComplete({ id: f.app.id, itemId: item.id,
    expectedVersion: 1, completed: true });
  assert.equal(done.content.version, 2);
  assert.equal(done.item.completed, true);
  assert.throws(() => f.make().setTaskComplete({ id: f.app.id, itemId: item.id,
    expectedVersion: 1, completed: false }),
    error => error.code === 'PERSONAL_APP_CONTENT_VERSION_CONFLICT');
  assert.equal(f.make().get(f.app.id).items[0].completed, true);
  const redo = f.make().setTaskComplete({ id: f.app.id, itemId: item.id,
    expectedVersion: 2, completed: false });
  assert.equal(redo.content.version, 3);
  assert.equal(redo.item.completed, false);
  assert.equal(f.make().setTaskComplete({ id: f.app.id, itemId: item.id,
    expectedVersion: 3, completed: false }).changed, false);
});
test('foreign IDs, invalid kinds, code-like fields, stale versions and non-tasks cannot mutate content', t => {
  const f = fixture(t), service = f.make(), base = {
    id: f.app.id, expectedVersion: 0, idempotencyKey: 'valid-content-123456',
    kind: 'note', title: 'Safe note', body: 'A note, not code' };
  assert.throws(() => service.get('app-' + 'f'.repeat(32)),
    error => error.code === 'PERSONAL_APP_NOT_FOUND');
  for (const patch of [
    { kind: 'javascript' }, { title: '' }, { body: String.fromCharCode(0) },
    { idempotencyKey: '../escape' }, { title: 'x'.repeat(161) },
  ]) assert.throws(() => service.createItem({ ...base, ...patch }));
  assert.equal(service.get(f.app.id).version, 0);
  const first = service.createItem(base);
  assert.throws(() => service.createItem({ ...base, idempotencyKey: 'another-valid-123456' }),
    error => error.code === 'PERSONAL_APP_CONTENT_VERSION_CONFLICT');
  assert.throws(() => service.setTaskComplete({ id: f.app.id, itemId: first.item.id,
    expectedVersion: 1, completed: true }),
    error => error.code === 'PERSONAL_APP_CONTENT_NOT_FOUND');
  assert.equal(f.make().get(f.app.id).items.length, 1);
});
