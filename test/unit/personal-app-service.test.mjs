// Real local storage tests, no provider/browser/runtime effects.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPersonalAppService } from '../../src/studio/personal-app-service.mjs';

const now = '2026-10-29T12:00:00.000Z';
function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'vivim-personal-app-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, make: () => createPersonalAppService({ paths: { root }, clock: () => now }) };
}
test('local app creation is durable, idempotent, user-scoped and safe for repeat opens', t => {
  const f = fixture(t), service = f.make();
  const args = { title: 'My Companion', intent: 'Build my personal mobile assistant',
    idempotencyKey: 'request-create-123456' };
  const first = service.create(args);
  assert.equal(first.replayed, false);
  assert.match(first.app.id, /^app-[a-f0-9]{32}$/);
  assert.equal(first.app.version, 1);
  assert.equal(first.app.screens.length, 3);
  assert.equal(f.make().get(first.app.id).intent, args.intent);
  assert.equal(f.make().list().total, 1);
  assert.equal(JSON.stringify(f.make().list()).includes(args.intent), false,
    'index must not automatically expose private user intent text');
  const retry = f.make().create(args);
  assert.equal(retry.replayed, true);
  assert.equal(retry.app.version, first.app.version);
  assert.throws(() => service.create({ ...args, intent: 'Different user request' }),
    e => e.code === 'PERSONAL_APP_IDEMPOTENCY_CONFLICT');
  assert.equal(f.make().list().total, 1);
});
test('screen evolution uses strict expected revision and persists through reopens', t => {
  const f = fixture(t), service = f.make();
  const result = service.create({ title: 'My AI World', intent: 'Add useful screens',
    idempotencyKey: 'new-blueprint-8675309' });
  const next = service.addScreen({ id: result.app.id, expectedVersion: result.app.version,
    kind: 'tasks', label: 'My Tasks' });
  assert.equal(next.app.version, 2);
  assert.equal(next.app.screens[3].key, 'custom-my-tasks');
  assert.deepEqual(f.make().scaffold(result.app.id).scaffold.screens.map(s => s.key),
    ['home', 'agent', 'builder', 'custom-my-tasks']);
  assert.equal(f.make().scaffold(result.app.id).scaffold.connection.paired, false);
  assert.equal(f.make().scaffold(result.app.id).scaffold.runnableCode, false);
  assert.throws(() => service.addScreen({ id: result.app.id, expectedVersion: 1,
    kind: 'blank', label: 'Old draft' }), e => e.code === 'PERSONAL_APP_VERSION_CONFLICT');
  assert.equal(f.make().get(result.app.id).screens.length, 4);
});
test('rejects malformed keys, app paths, code-like screen kinds and unknown apps', t => {
  const f = fixture(t), service = f.make();
  assert.throws(() => service.create({ title: 'a', intent: 'b', idempotencyKey: '../escape' }),
    e => e.code === 'PERSONAL_APP_INVALID');
  assert.throws(() => service.get('app-../outside'), e => e.code === 'PERSONAL_APP_INVALID');
  const first = service.create({ title: 'safe', intent: 'private',
    idempotencyKey: 'create-unique-123456' });
  assert.throws(() => service.addScreen({ id: first.app.id, expectedVersion: 1,
    kind: 'html', label: 'Executable' }), e => e.code === 'PERSONAL_APP_INVALID');
  assert.equal(service.get(first.app.id).version, 1);
  assert.throws(() => service.get('app-' + 'f'.repeat(32)),
    e => e.code === 'PERSONAL_APP_NOT_FOUND');
});
