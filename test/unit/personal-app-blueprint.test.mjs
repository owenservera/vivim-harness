import test from 'node:test';
import assert from 'node:assert/strict';
import { createPersonalAppBlueprint, addPersonalAppScreen, personalAppScaffold,
  assertPersonalAppBlueprint, PERSONAL_APP_KINDS, MAX_PERSONAL_APP_SCREENS,
  parsePersonalAppChange, previewPersonalAppChange, PERSONAL_APP_CHANGE_SCHEMA } from '../../src/studio/personal-app-blueprint.mjs';

const now = '2026-10-29T12:00:00.000Z';
const id = 'app-' + 'a'.repeat(32);
const base = () => createPersonalAppBlueprint({
  id, title: 'My AI world', intent: 'Build a personal mobile system that connects to my PC and can grow.', now,
});
test('minimal starter preserves exact user intent and provides a nonexecuting mobile contract', () => {
  const blueprint = base(), manifest = personalAppScaffold(blueprint);
  assert.equal(blueprint.intent, 'Build a personal mobile system that connects to my PC and can grow.');
  assert.deepEqual(blueprint.screens.map(screen => screen.key), ['home', 'agent', 'builder']);
  assert.equal(blueprint.providerExecution, 'not-attempted');
  assert.equal(manifest.defaultScreen, 'home');
  assert.equal(manifest.intelligence.dispatch, 'disabled');
  assert.equal(manifest.connection.paired, false);
  assert.equal(manifest.runnableCode, false);
  assert.equal(manifest.packaging, 'not-implemented');
});
test('user can evolve starter through bounded declarative screens while preserving base and original request', () => {
  const created = base();
  const evolved = addPersonalAppScreen(created, { kind: 'tasks', label: 'My Tasks', now });
  assert.equal(evolved.screens.length, 4);
  assert.equal(evolved.screens[3].key, 'custom-my-tasks');
  assert.equal(evolved.screens[3].kind, 'tasks');
  assert.deepEqual(created.screens.map(screen => screen.key), ['home', 'agent', 'builder']);
  assert.equal(evolved.intent, created.intent);
  assert.equal(evolved.buildHistory[1].basis.includes('no-provider-execution'), true);
  assert.throws(() => addPersonalAppScreen(evolved, { kind: 'notes', label: 'my tasks', now }),
    error => error.code === 'PERSONAL_APP_SCREEN_EXISTS');
});
test('input validation prevents arbitrary code as executable layout and rejects corrupt skeleton', () => {
  for (const kind of ['script','html','provider-send','iframe',undefined]) {
    assert.throws(() => addPersonalAppScreen(base(), { kind, label: 'Danger', now }),
      e => e.code === 'PERSONAL_APP_INVALID');
  }
  for (const intent of ['', 'x'.repeat(2001), 'bad' + String.fromCharCode(0) + 'text']) {
    assert.throws(() => createPersonalAppBlueprint({ id, title: 'x', intent, now }),
      e => e.code === 'PERSONAL_APP_INVALID');
  }
  assert.throws(() => createPersonalAppBlueprint({ id: '../escape', title: 'A', intent: 'B', now }));
  const changed = structuredClone(base()); changed.screens[0].key = 'oops';
  assert.throws(() => assertPersonalAppBlueprint(changed),
    e => e.code === 'PERSONAL_APP_CORRUPT');
});
test('screen limit enforces bounded growth, without changing original state', () => {
  let app = base();
  for (let index = 0; index < MAX_PERSONAL_APP_SCREENS - 3; index++) {
    app = addPersonalAppScreen(app, { kind: PERSONAL_APP_KINDS[0], label: 'Screen ' + index, now });
  }
  assert.equal(app.screens.length, MAX_PERSONAL_APP_SCREENS);
  assert.throws(() => addPersonalAppScreen(app, { kind: 'notes', label: 'Overflow', now }),
    e => e.code === 'PERSONAL_APP_LIMIT');
});

test('untrusted model-like JSON proposals compile to previewed data only with no execution', () => {
  const app = base(); app.version = 4;
  const proposal = { schema: PERSONAL_APP_CHANGE_SCHEMA, appId: app.id, baseVersion: 4,
    operations: [{ type: 'add-screen', kind: 'tasks', label: 'Today' },
      { type: 'add-screen', kind: 'notes', label: 'Ideas' }] };
  const parsed = parsePersonalAppChange(JSON.stringify(proposal));
  assert.deepEqual(parsed, proposal);
  const preview = previewPersonalAppChange(app, proposal, { now });
  assert.equal(preview.effects, 'none');
  assert.equal(preview.externalProvenance, 'not-verified');
  assert.equal(preview.approvalRequired, true);
  assert.equal(preview.scaffold.screens.length, 5);
  assert.deepEqual(preview.diff.map(d => d.key), ['custom-today', 'custom-ideas']);
  assert.equal(app.screens.length, 3, 'preview cannot change persistent or input state');
  assert.equal(preview.scaffold.intelligence.dispatch, 'disabled');
});
test('proposal compiler refuses unknown effects, hidden instructions and stale or foreign app scope', () => {
  const app = base(); app.version = 2;
  const proposal = { schema: PERSONAL_APP_CHANGE_SCHEMA, appId: app.id, baseVersion: 2,
    operations: [{ type: 'add-screen', kind: 'notes', label: 'Ideas' }] };
  for (const extension of [
    { ...proposal, execute: true },
    { ...proposal, operations: [{ type: 'run-code', kind: 'notes', label: 'Ideas' }] },
    { ...proposal, operations: [{ type: 'add-screen', kind: 'html', label: '<script>' }] },
    { ...proposal, operations: Array.from({ length: 5 }, () => proposal.operations[0]) },
    { ...proposal, operations: [{ ...proposal.operations[0], javascript: 'alert(1)' }] },
  ]) assert.throws(() => parsePersonalAppChange(extension),
    e => e.code === 'PERSONAL_APP_INVALID');
  assert.throws(() => previewPersonalAppChange(app, { ...proposal, baseVersion: 1 }, { now }),
    e => e.code === 'PERSONAL_APP_VERSION_CONFLICT');
  assert.throws(() => previewPersonalAppChange(app, { ...proposal, appId: 'app-' + 'b'.repeat(32) }, { now }),
    e => e.code === 'PERSONAL_APP_VERSION_CONFLICT');
  assert.throws(() => parsePersonalAppChange('{this is not JSON}'),
    e => e.code === 'PERSONAL_APP_INVALID');
});
