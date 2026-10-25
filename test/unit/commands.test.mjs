// C-10 command catalog is preview-only. Source-level and handler tests; no store, no browser, no provider.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createCommandCatalog, registerCommandRoutes, COMMAND_SYMBOLS } from '../../src/studio/commands.mjs';

const source = readFileSync(new URL('../../src/studio/commands.mjs', import.meta.url), 'utf8');
const catalog = createCommandCatalog();
const BANNED_API = ['execute', 'executeCommand', 'run', 'dispatch', 'perform', 'apply', 'send', 'importRecords', 'write'];

function routes() {
  const recorded = [];
  registerCommandRoutes({ add: (method, route, summary, handler) => recorded.push({ method, route, summary, handler }) });
  return recorded;
}

test('the module exposes a catalog and routes, not an execution function', () => {
  assert.equal(typeof createCommandCatalog, 'function');
  assert.equal(typeof registerCommandRoutes, 'function');
  assert.equal(typeof COMMAND_SYMBOLS, 'object');
  for (const name of BANNED_API) {
    assert.equal(catalog[name], undefined);
    assert.equal(source.includes(`export function ${name}`), false);
    assert.equal(source.includes(`export async function ${name}`), false);
  }
  assert.deepEqual(Object.keys(catalog).sort(), ['describe', 'list', 'preview', 'resolve']);
  assert.doesNotMatch(source, /node:fs|node:child_process|from '\.\.\/(store|capture|replay|decode)/);
  assert.doesNotMatch(source, /export\s+(async\s+)?function\s+(execute|run|dispatch|perform|apply|send)\b/);
});

test('every command is a bounded catalog entry and external effects stay deferred', () => {
  const commands = catalog.list();
  assert.deepEqual(commands.map((command) => command.id), [
    'open-conversation', 'find', 'add-to-project', 'add-note', 'export-selection', 'import-check', 'provider-send',
  ]);
  for (const command of commands) {
    assert.equal(typeof command.summary, 'string');
    assert.equal(command.inputs.type, 'object');
    assert.equal(command.inputs.additionalProperties, false);
    assert.ok(Array.isArray(command.inputs.required));
    assert.ok(['read', 'local-write', 'external-effect'].includes(command.scope));
    assert.equal(typeof command.requiresConfirmation, 'boolean');
    assert.equal(typeof command.effects, 'string');
    assert.ok(Array.isArray(command.preconditions));
    if (command.scope === 'local-write') assert.equal(command.requiresConfirmation, true);
    if (command.scope === 'external-effect') assert.equal(command.unavailableReason, 'deferred: no live provider/browser work');
    else assert.equal(command.unavailableReason, null);
  }
  const send = commands.find((command) => command.id === 'provider-send');
  assert.equal(send.scope, 'external-effect');
});

test('explicit symbols map and unknown input returns candidates without selecting one', () => {
  assert.equal(COMMAND_SYMBOLS['/find'], 'find');
  assert.equal(COMMAND_SYMBOLS['@project'], 'add-to-project');
  const found = catalog.resolve('/find');
  assert.equal(found.exact, true);
  assert.equal(found.id, 'find');
  const project = catalog.describe('@project');
  assert.equal(project.id, 'add-to-project');
  const guessed = catalog.preview('findex', { q: 'hello' });
  assert.equal(guessed.valid, false);
  assert.equal(guessed.executable, false);
  assert.equal(guessed.scope, null);
  assert.equal(guessed.requiresConfirmation, null);
  assert.deepEqual(guessed.wouldDo, ['Nothing was performed.']);
  assert.equal(guessed.candidates.some((candidate) => candidate.id === 'find'), true);
  assert.equal(guessed.candidates.filter((candidate) => candidate.id === 'find').length, 1);
  const forced = catalog.resolve('!/find');
  assert.equal(forced.exact, false);
  assert.equal(forced.id, null);
  assert.equal(forced.candidates.some((candidate) => candidate.id === 'find'), true);
  assert.equal(catalog.describe('no-such-command'), null);
});

test('preview reports invalid arguments and does not perform a valid read or local write', () => {
  const missing = catalog.preview('find', {});
  assert.equal(missing.valid, false);
  assert.equal(missing.executable, false);
  assert.equal(missing.errors.some((error) => error.includes('missing argument: q')), true);
  assert.deepEqual(missing.wouldDo, ['Nothing was performed.']);
  const malformed = catalog.preview('/find', { q: '', kind: 'remote', extra: true });
  assert.equal(malformed.valid, false);
  assert.ok(malformed.errors.length >= 2);
  const found = catalog.preview('/find', { q: 'notes' });
  assert.equal(found.valid, true);
  assert.equal(found.executable, true);
  assert.equal(found.scope, 'read');
  assert.equal(found.requiresConfirmation, false);
  assert.equal(found.candidates.length, 0);
  assert.match(found.wouldDo.join('\n'), /Would /);
  assert.match(found.wouldDo.join('\n'), /Nothing was performed\./);
  assert.equal(found.performed, undefined);
  assert.equal(found.executed, undefined);
  assert.equal(found instanceof Promise, false);
  const added = catalog.preview('@project', { projectId: 'alpha', targetId: 'beta' });
  assert.equal(added.valid, true);
  assert.equal(added.scope, 'local-write');
  assert.equal(added.requiresConfirmation, true);
  assert.equal(added.uncertain.some((item) => /shape only/i.test(item)), true);
  assert.match(added.wouldDo.join('\n'), /Nothing was performed\./);
  const badId = catalog.preview('add-to-project', { projectId: '../x', targetId: 'beta' });
  assert.equal(badId.valid, false);
  assert.equal(badId.errors.some((error) => error.includes('projectId')), true);
  const remote = catalog.preview('import-check', { source: 'https://example.invalid/file' });
  assert.equal(remote.valid, false);
  assert.equal(remote.executable, false);
});

test('an external effect never previews as executable, including its force alias', () => {
  const args = { conversationId: 'conversation1', prompt: 'hello', confirm: true };
  for (const id of ['provider-send', '/send', '!/send']) {
    const preview = catalog.preview(id, args);
    assert.equal(preview.valid, false);
    assert.equal(preview.executable, false);
    assert.equal(preview.scope, 'external-effect');
    assert.equal(preview.requiresConfirmation, true);
    assert.equal(preview.errors[0], 'deferred: no live provider/browser work');
    assert.match(preview.wouldDo.join('\n'), /Would not contact a provider or browser\./);
    assert.match(preview.wouldDo.join('\n'), /Nothing was performed\./);
    assert.doesNotMatch(preview.wouldDo.join('\n'), /would send|sent|executed|delivered/i);
    assert.equal(preview.performed, undefined);
  }
  const clean = catalog.preview('provider-send', { conversationId: 'conversation1', prompt: 'hello' });
  assert.equal(clean.executable, false);
  assert.equal(clean.errors.includes('deferred: no live provider/browser work'), true);
});

test('routes list, describe, and preview, and reject malformed input with 400', () => {
  const recorded = routes();
  assert.deepEqual(recorded.map((route) => `${route.method} ${route.route}`), [
    'GET /commands', 'GET /commands/{id}', 'POST /commands/{id}/preview',
  ]);
  const [list, describe, preview] = recorded.map((route) => route.handler);
  const listed = list({});
  assert.equal(listed.commands.length, 7);
  const resolved = list({ q: { input: '/find' } });
  assert.equal(resolved.exact, true);
  assert.equal(resolved.id, 'find');
  const unknown = list({ q: { input: 'zzzz-unknown' } });
  assert.equal(unknown.id, null);
  assert.equal(unknown.exact, false);
  assert.ok(unknown.candidates.length > 0);
  assert.throws(() => list({ q: { input: '' } }), { status: 400, code: 'MALFORMED_COMMAND' });
  assert.throws(() => list({ q: { input: 'x'.repeat(129) } }), { status: 400 });
  assert.equal(describe({ p: { id: '@project' } }).command.id, 'add-to-project');
  assert.throws(() => describe({ p: { id: 'not-real' } }), (error) => error.status === 404 && error.candidates.length > 0);
  assert.throws(() => describe({ p: { id: '../secret' } }), { status: 400, code: 'MALFORMED_COMMAND' });
  assert.throws(() => describe({ p: { id: 'bad id' } }), { status: 400 });
  assert.throws(() => describe({ p: { id: 'a'.repeat(65) } }), { status: 400 });
  assert.throws(() => preview({ p: { id: 'find' }, body: [] }), { status: 400, code: 'MALFORMED_COMMAND' });
  assert.throws(() => preview({ p: { id: 'find' }, body: null }), { status: 400 });
  assert.throws(() => preview({ p: { id: 'find' }, body: { q: 'x'.repeat(9000) } }), { status: 400 });
  const invalid = preview({ p: { id: 'find' }, body: { kind: 'nope' } });
  assert.equal(invalid.valid, false);
  assert.ok(invalid.errors.length > 0);
  assert.equal(invalid.executable, false);
  const external = preview({ p: { id: 'provider-send' }, body: { conversationId: 'conversation1', prompt: 'hello' } });
  assert.equal(external.executable, false);
  assert.equal(external.valid, false);
  const candidates = preview({ p: { id: 'zzzz-unknown' }, body: {} });
  assert.equal(candidates.valid, false);
  assert.equal(candidates.scope, null);
  assert.ok(candidates.candidates.length > 0);
  assert.throws(() => registerCommandRoutes({}), /add\(\)/);
});
