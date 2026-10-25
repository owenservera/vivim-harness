// C-10 command catalog is preview-only. Source-level and handler tests; no store, no browser, no provider.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createCommandCatalog, registerCommandRoutes, COMMAND_SYMBOLS } from '../../src/studio/commands.mjs';

const source = readFileSync(new URL('../../src/studio/commands.mjs', import.meta.url), 'utf8');
const catalog = createCommandCatalog();
const BANNED_API = ['execute', 'executeCommand', 'run', 'dispatch', 'perform', 'apply', 'send', 'importRecords', 'write'];
// Exact preview field set: nothing may read as "this can be run now".
const PREVIEW_FIELDS = ['canProceed', 'candidates', 'errors', 'scope', 'uncertain', 'valid', 'wouldDo', 'wouldRequireConfirmation'];
const CONVERSATION = `c-${'a'.repeat(40)}`;
const IMPORTED_CONVERSATION = `c-i${'b'.repeat(38)}`;

function routes() {
  const recorded = [];
  registerCommandRoutes({ add: (method, route, summary, handler) => recorded.push({ method, route, summary, handler }) });
  return recorded;
}

// What the Studio hub serializer would emit for anything a route handler throws (server.mjs error
// path): only { error, code, ...whitelisted store fields } — every other attachment, including
// extra fields like `candidates`, is dropped. Used so tests assert the client-visible payload.
function emit(handler, input) {
  try {
    return { status: 200, body: handler(input) };
  } catch (e) {
    return { status: e.status ?? 500, body: { error: String(e.message ?? e), ...(e.code ? { code: e.code } : {}) } };
  }
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
  // The preview response must not even be able to carry a run-now claim.
  assert.equal(source.includes('executable'), false, 'no executability field or wording');
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
    assert.ok(command.inputs.required.every((key) => Object.hasOwn(command.inputs.properties, key)));
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

test('catalog entries and public copies are deep-frozen snapshots, not live refs', () => {
  const [first] = catalog.list();
  assert.notEqual(first, catalog.list()[0], 'each list() call returns fresh copies');
  assert.throws(() => { first.id = 'x'; }, TypeError);
  assert.throws(() => { first.inputs.properties.q = {}; }, TypeError);
  assert.throws(() => { first.inputs.required.push('nope'); }, TypeError);
  assert.throws(() => { first.inputs.properties.q.maxLength = 1; }, TypeError);
  assert.throws(() => { first.preconditions.push('nope'); }, TypeError);
  assert.throws(() => { first.symbols.push('x'); }, TypeError);
  const described = catalog.describe('find');
  assert.deepEqual(described.inputs.required, ['q']);
  assert.equal(described.inputs.properties.q.maxLength, 200);
  assert.throws(() => { described.inputs.properties.q.maxLength = 1; }, TypeError);
  assert.throws(() => { described.summary = 'tampered'; }, TypeError);
});

test('explicit symbols resolve as command ids, route tokens never throw away advertised symbols', () => {
  assert.equal(COMMAND_SYMBOLS['/find'], 'find');
  assert.equal(COMMAND_SYMBOLS['@project'], 'add-to-project');
  assert.equal(COMMAND_SYMBOLS['+/project'], 'add-to-project');
  const found = catalog.resolve('/find');
  assert.equal(found.exact, true);
  assert.equal(found.id, 'find');
  const project = catalog.describe('@project');
  assert.equal(project.id, 'add-to-project');
  assert.equal(catalog.describe('no-such-command'), null);
  const forced = catalog.resolve('!/find');
  assert.equal(forced.exact, false);
  assert.equal(forced.id, null);
  const [list, describe] = routes().map((route) => route.handler);
  // Every advertised symbol must be resolvable as data on the explicit endpoint-safe path.
  for (const command of list({}).commands) {
    assert.ok(command.symbols.length > 0, `${command.id} advertises its symbols`);
    for (const symbol of command.symbols) {
      assert.equal(COMMAND_SYMBOLS[symbol], command.id);
      const resolved = list({ q: { symbol } });
      assert.equal(resolved.exact, true, `symbol ${symbol} resolves as data`);
      assert.equal(resolved.id, command.id);
      assert.equal(resolved.symbol, symbol);
      assert.equal(resolved.command.id, command.id);
      assert.deepEqual(resolved.candidates, [{ id: command.id, summary: command.summary, score: 100 }]);
      if (symbol.includes('/')) {
        // Slash symbols cannot be path tokens; the symbol endpoint is their only route.
        assert.throws(() => describe({ p: { id: symbol } }), { status: 400, code: 'WORLD_INVALID_INPUT' });
      } else {
        assert.equal(describe({ p: { id: symbol } }).command.id, command.id);
      }
    }
  }
});

test('candidate ranking is real: exact beats prefix beats token, and unknown tokens yield no candidates', () => {
  const exact = catalog.resolve('/find');
  assert.deepEqual(exact.candidates, [{ id: 'find', summary: 'Find saved local records by text.', score: 100 }]);
  // Two commands tie exactly; ranking must be deterministic and deduped.
  const addMatches = catalog.resolve('add');
  assert.deepEqual(addMatches.candidates.map((candidate) => candidate.id), ['add-note', 'add-to-project']);
  assert.deepEqual(addMatches.candidates.map((candidate) => candidate.score), [17, 17]);
  const prefixOnly = catalog.resolve('open');
  assert.deepEqual(prefixOnly.candidates, [{ id: 'open-conversation', summary: 'Open a saved conversation for local reading.', score: 17 }]);
  const tokenOnly = catalog.resolve('findex');
  assert.deepEqual(tokenOnly.candidates, [{ id: 'find', summary: 'Find saved local records by text.', score: 10 }]);
  // A token that overlaps nothing must NOT fall back to the whole catalog at score 0.
  const orphan = catalog.resolve('zzzz-nonsensical-qq');
  assert.equal(orphan.exact, false);
  assert.deepEqual(orphan.candidates, []);
  assert.deepEqual(catalog.preview('zzzz-nonsensical-qq', {}).candidates, []);
});

test('preview responses carry only valid/canProceed arguments-validity and a future-tense confirmation flag', () => {
  const found = catalog.preview('find', { q: 'hello' });
  assert.deepEqual(Object.keys(found).sort(), PREVIEW_FIELDS);
  assert.equal('executable' in found, false);
  assert.equal(found.valid, true);
  assert.equal(found.canProceed, true, 'canProceed only means the arguments passed the schema');
  assert.equal(found.wouldRequireConfirmation, false);
  assert.equal(found.scope, 'read');
  assert.equal(found.candidates.length, 0);
  assert.match(found.wouldDo.join('\n'), /Would /);
  assert.match(found.wouldDo.join('\n'), /Nothing was performed\./);
  assert.equal(found.performed, undefined);
  assert.equal(found.executed, undefined);
  assert.equal(found instanceof Promise, false);
  const added = catalog.preview('+note', { title: 't', body: 'b' });
  assert.deepEqual(Object.keys(added).sort(), PREVIEW_FIELDS);
  assert.equal(added.valid, true);
  assert.equal(added.canProceed, true);
  assert.equal(added.wouldRequireConfirmation, true);
  assert.equal(added.scope, 'local-write');
  assert.match(added.wouldDo.join('\n'), /Would wait for confirmation/);
  assert.match(added.wouldDo.join('\n'), /Nothing was performed\./);
  const missing = catalog.preview('find', {});
  assert.equal(missing.valid, false);
  assert.equal(missing.canProceed, false);
  assert.ok(missing.errors.some((error) => error.includes('missing argument: q')));
  assert.deepEqual(missing.wouldDo, ['Nothing was performed.']);
  const malformed = catalog.preview('/find', { q: '', kind: 'remote', extra: true });
  assert.equal(malformed.valid, false);
  assert.ok(malformed.errors.length >= 2);
  const badId = catalog.preview('add-to-project', { projectId: '../x', targetId: 'n-beta' });
  assert.equal(badId.valid, false);
  assert.ok(badId.errors.some((error) => error.includes('projectId')));
  const remote = catalog.preview('import-check', { source: 'https://example.invalid/file' });
  assert.equal(remote.valid, false);
  assert.equal(remote.canProceed, false);
  const unknown = catalog.preview('nope-not-here', { q: 'x' });
  assert.deepEqual(Object.keys(unknown).sort(), PREVIEW_FIELDS);
  assert.equal(unknown.valid, false);
  assert.equal(unknown.canProceed, false);
  assert.equal(unknown.wouldRequireConfirmation, null);
  assert.equal(unknown.scope, null);
  assert.deepEqual(unknown.wouldDo, ['Nothing was performed.']);
});

test('an external effect never proceeds, including its force alias', () => {
  const args = { conversationId: CONVERSATION, prompt: 'hello', confirm: true };
  for (const id of ['provider-send', '/send', '!/send']) {
    const preview = catalog.preview(id, args);
    assert.deepEqual(Object.keys(preview).sort(), PREVIEW_FIELDS);
    assert.equal(preview.valid, false);
    assert.equal(preview.canProceed, false);
    assert.equal(preview.scope, 'external-effect');
    assert.equal(preview.wouldRequireConfirmation, true);
    assert.equal(preview.errors[0], 'deferred: no live provider/browser work');
    assert.match(preview.wouldDo.join('\n'), /Would not contact a provider or browser\./);
    assert.match(preview.wouldDo.join('\n'), /Nothing was performed\./);
    assert.doesNotMatch(preview.wouldDo.join('\n'), /would send|sent|executed|delivered/i);
    assert.equal(preview.performed, undefined);
  }
  const clean = catalog.preview('provider-send', { conversationId: IMPORTED_CONVERSATION, prompt: 'hello' });
  assert.equal(clean.canProceed, false);
  assert.equal(clean.errors.includes('deferred: no live provider/browser work'), true);
});

test('ids use the world grammar: lowercase prefix form; dots, underscores, uppercase and wrong prefixes are invalid', () => {
  const ok = (command, args) => {
    const preview = catalog.preview(command, args);
    assert.equal(preview.valid, true, `${command} ${JSON.stringify(args)} should be shape-valid: ${preview.errors.join('; ')}`);
  };
  const bad = (command, args, field) => {
    const preview = catalog.preview(command, args);
    assert.equal(preview.valid, false, `${command} ${JSON.stringify(args)} should be invalid`);
    assert.ok(preview.errors.some((error) => error.includes(field)), `${field} blamed for ${JSON.stringify(args)}`);
  };
  ok('open-conversation', { conversationId: CONVERSATION });
  ok('open-conversation', { conversationId: IMPORTED_CONVERSATION });
  bad('open-conversation', { conversationId: CONVERSATION.toUpperCase() }, 'conversationId');
  bad('open-conversation', { conversationId: 'conversation1' }, 'conversationId');
  bad('open-conversation', { conversationId: `c-${'a'.repeat(61)}` }, 'conversationId');
  ok('add-to-project', { projectId: 'p-alpha-1', targetId: 'n-beta' });
  ok('add-to-project', { projectId: 'p-alpha', targetId: CONVERSATION });
  bad('add-to-project', { projectId: 'Project_1', targetId: 'n-beta' }, 'projectId');
  bad('add-to-project', { projectId: 'p.alpha', targetId: 'n-beta' }, 'projectId');
  bad('add-to-project', { projectId: 'n-alpha', targetId: 'n-beta' }, 'projectId');
  bad('add-to-project', { projectId: 'p-alpha', targetId: 'x-beta' }, 'targetId');
  bad('add-to-project', { projectId: 'p-alpha', targetId: 'beta' }, 'targetId');
  ok('add-note', { title: 't', body: 'b', projectId: 'p-alpha' });
  bad('add-note', { title: 't', body: 'b', projectId: 'P-ALPHA' }, 'projectId');
  bad('add-note', { title: 't', body: 'b', projectId: 'p_alpha' }, 'projectId');
  ok('export-selection', { selectionId: `s-${'a'.repeat(36)}` });
  bad('export-selection', { selectionId: 'p-alpha' }, 'selectionId');
});

test('multi-line text fields allow newline and tab but other control characters stay rejected', () => {
  const multilineBody = catalog.preview('add-note', { title: 't', body: 'line1\n\tline2' });
  assert.equal(multilineBody.valid, true);
  assert.equal(multilineBody.errors.some((error) => /control/.test(error)), false);
  const multilineQ = catalog.preview('find', { q: 'a\nb\tc' });
  assert.equal(multilineQ.valid, true);
  const carriageReturn = catalog.preview('add-note', { title: 't', body: 'bad\rline' });
  assert.equal(carriageReturn.valid, false);
  assert.ok(carriageReturn.errors.some((error) => /control/.test(error)));
  const bell = catalog.preview('find', { q: 'a\u0007b' });
  assert.equal(bell.valid, false);
  assert.ok(bell.errors.some((error) => /control/.test(error)));
  const nullChar = catalog.preview('add-note', { title: 't', body: 'a\u0000b' });
  assert.equal(nullChar.valid, false);
  const titleNewline = catalog.preview('add-note', { title: 't\n', body: 'b' });
  assert.equal(titleNewline.valid, false);
  assert.ok(titleNewline.errors.some((error) => error.includes('title')));
});

test('body validation is by schema limits; the byte cap is only a generous outer bound with the same error class', () => {
  const [list, describe, preview] = routes().map((route) => route.handler);
  // 4000 characters of quotes and backslashes: schema-valid fields must not depend on JSON escaping.
  const escaped = emit(preview, { p: { id: 'add-note' }, body: { title: 't', body: '"\\'.repeat(2000) } });
  assert.equal(escaped.status, 200);
  assert.equal(escaped.body.valid, true);
  assert.equal(escaped.body.canProceed, true);
  // U+2028 expands 6x under JSON.stringify — larger than the old 8192 cap, still valid data.
  const separators = emit(preview, { p: { id: 'add-note' }, body: { title: 't', body: '\u2028'.repeat(4000) } });
  assert.equal(separators.status, 200);
  assert.equal(separators.body.valid, true);
  // Above the outer bound: 400, same error class as every other gate rejection.
  const oversized = emit(preview, { p: { id: 'add-note' }, body: { title: 't', body: 'x'.repeat(66000) } });
  assert.equal(oversized.status, 400);
  assert.equal(oversized.body.code, 'WORLD_INVALID_INPUT');
  assert.match(oversized.body.error, /exceeds 65536/);
  // Field limits are the real validation: over-limit q is an invalid preview, not a 400.
  const overField = emit(preview, { p: { id: 'find' }, body: { q: 'x'.repeat(9000) } });
  assert.equal(overField.status, 200);
  assert.equal(overField.body.valid, false);
  assert.match(overField.body.errors.join(' '), /q exceeds 200 characters/);
  void list; void describe;
});

test('preview arguments and route bodies must be plain own-property objects', () => {
  const call = (args) => catalog.preview('find', args);
  assert.deepEqual(call([]).errors, ['arguments must be a JSON object']);
  class Args { constructor() { this.q = 'x'; } }
  assert.deepEqual(call(new Args()).errors, ['arguments must be a JSON object']);
  assert.deepEqual(call(new Map([['q', 'x']])).errors, ['arguments must be a JSON object']);
  assert.deepEqual(call(new Date()).errors, ['arguments must be a JSON object']);
  // Values inherited through a prototype chain are never read.
  assert.deepEqual(call(Object.assign(Object.create({ q: 'x' }), {})).errors, ['arguments must be a JSON object']);
  const plain = call({ q: 'x' });
  assert.equal(plain.valid, true);
  const [, , preview] = routes().map((route) => route.handler);
  assert.throws(() => preview({ p: { id: 'find' }, body: new Args() }), { status: 400, code: 'WORLD_INVALID_INPUT' });
  assert.throws(() => preview({ p: { id: 'find' }, body: new Map() }), { status: 400 });
});

test('routes list, describe as data, preview, and reject malformed input with 400', () => {
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
  const unknownInput = list({ q: { input: 'zzzz-nonsense' } });
  assert.equal(unknownInput.id, null);
  assert.equal(unknownInput.exact, false);
  assert.deepEqual(unknownInput.candidates, []);
  const unknownSymbol = list({ q: { symbol: 'zzzz-nonsense' } });
  assert.equal(unknownSymbol.exact, false);
  assert.equal(unknownSymbol.id, null);
  assert.equal(unknownSymbol.command, null);
  assert.throws(() => list({ q: { input: '' } }), { status: 400, code: 'WORLD_INVALID_INPUT' });
  assert.throws(() => list({ q: { symbol: '' } }), { status: 400, code: 'WORLD_INVALID_INPUT' });
  assert.throws(() => list({ q: { input: 'x'.repeat(129) } }), { status: 400 });
  assert.throws(() => list({ q: { input: '\u0000' } }), { status: 400 });
  const known = emit(describe, { p: { id: '@project' } });
  assert.equal(known.status, 200);
  assert.equal(known.body.found, true);
  assert.equal(known.body.command.id, 'add-to-project');
  // Known route-safe tokens still describe directly.
  assert.equal(describe({ p: { id: 'find' } }).command.id, 'find');
  // Unknown ids resolve as data in a 200 response so candidates survive the hub serializer.
  const notFound = emit(describe, { p: { id: 'zzzz-nonsensical-qq' } });
  assert.equal(notFound.status, 200);
  assert.equal(notFound.body.found, false);
  assert.equal(notFound.body.id, 'zzzz-nonsensical-qq');
  assert.deepEqual(notFound.body.candidates, []);
  assert.ok(!('command' in notFound.body));
  assert.throws(() => describe({ p: { id: '../secret' } }), { status: 400, code: 'WORLD_INVALID_INPUT' });
  assert.throws(() => describe({ p: { id: 'bad id' } }), { status: 400 });
  assert.throws(() => describe({ p: { id: '/find' } }), { status: 400 });
  assert.throws(() => describe({ p: { id: 'a'.repeat(65) } }), { status: 400 });
  assert.throws(() => preview({ p: { id: 'find' }, body: [] }), { status: 400, code: 'WORLD_INVALID_INPUT' });
  assert.throws(() => preview({ p: { id: 'find' }, body: null }), { status: 400 });
  assert.throws(() => preview({ p: { id: 'find' }, body: { q: 'x'.repeat(70000) } }), { status: 400, code: 'WORLD_INVALID_INPUT' });
  const invalid = preview({ p: { id: 'find' }, body: { kind: 'nope' } });
  assert.equal(invalid.valid, false);
  assert.ok(invalid.errors.length > 0);
  assert.equal(invalid.canProceed, false);
  const external = preview({ p: { id: 'provider-send' }, body: { conversationId: CONVERSATION, prompt: 'hello' } });
  assert.equal(external.canProceed, false);
  assert.equal(external.valid, false);
  const candidates = preview({ p: { id: 'zzzz-unknown' }, body: {} });
  assert.equal(candidates.valid, false);
  assert.equal(candidates.scope, null);
  assert.deepEqual(candidates.candidates, []);
  assert.throws(() => registerCommandRoutes({}), /add\(\)/);
});
