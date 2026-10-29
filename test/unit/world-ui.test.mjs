// Saved-world views inside /chat. No browser, no CDP, no live provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as ui from '../../src/studio/ui/chat.mjs';
import * as world from '../../src/studio/ui/world-view.mjs';

const read = (name) => readFileSync(new URL('../../src/studio/ui/' + name, import.meta.url), 'utf8');
const html = read('chat.html');
const chatSource = read('chat.mjs');
const source = read('world-view.mjs');
const cid = 'c' + '-' + 'a'.repeat(40);
const pid = 'p-project-1';

class Txt { constructor(data) { this.data = String(data); this.nodeType = 3; } appendData(s) { this.data += s; } }
class Node {
  constructor(tag = 'div') {
    Object.assign(this, { tag, id: '', children: [], dataset: {}, attrs: {}, listeners: {}, hidden: false, disabled: false, value: '', text: '', className: '' });
  }
  append(...kids) { this.children.push(...kids); }
  replaceChildren(...kids) { this.children = kids; }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  getAttribute(name) { return Object.hasOwn(this.attrs, name) ? this.attrs[name] : null; }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  set textContent(value) { this.children = value === '' || value == null ? [] : [new Txt(value)]; }
  get textContent() { return this.children.map((child) => (typeof child === 'string' ? child : child instanceof Txt ? child.data : child.textContent ?? '')).join(''); }
  focus() {}
  async click() { for (const fn of this.listeners.click ?? []) await fn({ preventDefault() {} }); }
  async dispatch(type) { for (const fn of this.listeners[type] ?? []) await fn({ preventDefault() {} }); }
}
const fakeDoc = () => ({ createElement: (tag) => new Node(tag), createTextNode: (text) => new Txt(text) });
const walk = (node, fn) => { if (!node || typeof node === 'string' || node instanceof Txt) return; fn(node); for (const child of node.children ?? []) walk(child, fn); };
const all = (root, pred) => { const out = []; walk(root, (node) => { if (pred(node)) out.push(node); }); return out; };
const byId = (root, id) => all(root, (node) => node.id === id)[0] ?? null;
const buttonText = (root, text) => all(root, (node) => node.tag === 'button' && node.textContent.includes(text));

test('world module imports without booting a document and does not invent a second renderer', () => {
  assert.equal(typeof world.mountWorldView, 'function');
  assert.deepEqual([...world.VIEWS], ['conversations', 'projects', 'notes']);
  assert.equal(world.mountWorldView({}), null);
  assert.doesNotMatch(source, /innerHTML|insertAdjacentHTML|outerHTML|document\.write|setAttribute\('style'/);
  assert.doesNotMatch(source, /Dashboard|Sign in/);
  assert.match(source, /\/transfer\/export/);
  assert.match(source, /\/search\?/);
  assert.match(chatSource, /import\('\.\/world-view\.mjs'\)/);
  assert.match(chatSource, /mountWorldView/);
  assert.doesNotMatch(chatSource, /innerHTML|insertAdjacentHTML|outerHTML|document\.write/);
  assert.match(html, /id="shellModes"/);
  assert.match(html, /id="worldShell"[^>]*hidden/);
  assert.match(html, /data-view="conversations"/);
  assert.match(html, /data-view="projects"/);
  assert.match(html, /data-view="notes"/);
  assert.match(html, /Local edits do not change provider content/);
  assert.match(html, /data-view="home"/);
  assert.match(html, /data-view="settings"/);
});

test('saved blocks reuse markdown structure and unknown parts do not leak their payload', () => {
  const plan = world.turnPlan({
    role: 'assistant', text: 'answer', truncated: true, redactions: 2,
    blocks: [
      { type: 'code', language: 'js', text: 'a < b' },
      { type: 'heading', level: 2, text: 'Kept' },
      { type: 'table', headers: ['Name'], rows: [['a < b']] },
      { type: 'image', src: 'javascript:alert(1)', alt: 'hidden' },
      { type: 'future-native-part', opaque: { bytes: [9991] } },
    ],
  });
  const parsed = ui.parseRich(plan.markdown);
  assert.equal(parsed.blocks[0].type, 'code');
  assert.equal(parsed.blocks[0].text, 'a < b');
  assert.equal(parsed.blocks[1].type, 'heading');
  assert.equal(parsed.blocks[2].type, 'table');
  assert.equal(plan.truncated, true);
  assert.match(plan.redactionNote, /2/);
  assert.doesNotMatch(JSON.stringify(plan), /9991|opaque|bytes/);
  assert.doesNotMatch(plan.markdown, /javascript/i);
  assert.match(plan.unknowns.map((item) => item.note).join('\n'), /future-native-part/);
  assert.match(plan.unknowns.map((item) => item.note).join('\n'), /does not load it/);
  const fallback = world.turnPlan({ text: 'plain only', blocks: [] });
  assert.equal(fallback.markdown, 'plain only');
  assert.match(fallback.note, /No separate rich parts/);
});

test('coverage, identity and source stay truthful, including additive fields', () => {
  const coverage = world.coverageView({ state: 'saved-observation', fullNativeThread: 'unknown', richContent: 'as-recorded', acceptance: 'not-assessed' });
  assert.deepEqual(coverage.chips[0], ['Saved local observation', 't-info']);
  assert.match(coverage.chips[1][0], /Full remote thread: unknown/);
  assert.equal(coverage.extra.find((row) => row.label === 'Acceptance').value, 'not assessed');
  assert.match(coverage.sentence, /not a claim that the remote thread is complete/);
  assert.equal(world.coverageView({ state: 'missing' }).chips[0][0], 'Saved messages: missing');
  assert.match(world.coverageView({ state: 'unavailable', reason: 'SOURCE_ACTIVE' }).sentence, /SOURCE_ACTIVE/);
  assert.match(world.coverageView({ state: 'unavailable', reason: 'SOURCE_ACTIVE' }).sentence, /not an empty conversation/);
  assert.match(world.coverageView({ state: 'new-later' }).chips[0][0], /new-later/);
  const partial = world.identityRows({
    nativeThreadId: 'thread-1', accountId: null, state: 'partial',
    provider: { value: 'chatgpt', state: 'source-observed', basis: 'session.json/site' },
    origin: { value: 'https://chatgpt.com', state: 'source-observed' },
    thread: { state: 'qualified-inference', nativeRef: 'thread-1' },
    account: { state: 'unknown', ref: null },
    qualification: 'Saved observation only',
  });
  assert.equal(partial.find((row) => row.label === 'Remote thread').value, 'partial');
  assert.equal(partial.find((row) => row.label === 'Account state').value, 'unknown');
  assert.match(partial.find((row) => row.label === 'Thread basis').value, /Not account proof/);
  assert.match(partial.find((row) => row.label === 'Provider').value, /chatgpt \(source-observed\)/);
  assert.doesNotMatch(JSON.stringify(partial), /nativeRef/);
  const identity = world.identityRows({ nativeThreadId: null, accountId: null, state: 'unknown', accountHint: 'later' });
  assert.equal(identity.find((row) => row.label === 'Native thread id').value, 'not recorded');
  assert.equal(identity.find((row) => row.label === 'Account').value, 'not recorded');
  assert.equal(identity.find((row) => row.label === 'Account Hint').value, 'later');
  assert.match(identity.at(-1).value, /not the same conversation/);
  const source = world.sourceRows({ sessionId: 'sess', kind: 'saved-session', providerUrl: null, extraHint: 'kept' });
  assert.equal(source.find((row) => row.label === 'Provider address').value, 'not recorded');
  assert.equal(source.find((row) => row.label === 'Extra Hint').value, 'kept');
  const message = world.messageSourceRows({ sessionId: 'sess', key: 'DOM_TURNS', index: 0, observedTurnId: null, partHint: 'seen' });
  assert.match(message.find((row) => row.label === 'Record').value, /DOM_TURNS/);
  assert.equal(message.find((row) => row.label === 'Observed id').value, 'not recorded');
  assert.equal(message.find((row) => row.label === 'Part Hint').value, 'seen');
});

test('writes succeed only with a versioned 200, and a conflict keeps the same draft', () => {
  const draft = { title: 'Mine', body: '', conversationIds: [cid], noteIds: [] };
  const conflict = world.interpretWrite({ status: 409, data: { error: 'stale', code: 'CAS_VERSION_CONFLICT', expected: 1, actual: 4 } }, draft);
  assert.equal(conflict.ok, false);
  assert.equal(conflict.draft, draft);
  assert.match(conflict.message, /Not saved/);
  assert.match(conflict.message, /version 1/);
  assert.match(conflict.message, /version 4/);
  assert.equal(world.interpretWrite({ status: 200, data: { id: pid, title: 'Nope' } }, draft).ok, false);
  assert.equal(world.interpretWrite({ status: 200, data: { id: pid, title: 'Nope' } }, draft).draft, draft);
  const saved = world.interpretWrite({ status: 200, data: { id: pid, kind: 'project', title: 'Mine', conversationIds: [cid], noteIds: [], version: 2 } }, draft);
  assert.equal(saved.ok, true);
  assert.equal(saved.message, 'Saved.');
  assert.notEqual(saved.draft, draft);
  const form = { title: 'Kept', body: 'text' };
  const created = world.interpretCreate({ status: 400, data: { error: 'title must contain 1..300 characters', code: 'WORLD_INVALID_INPUT' } }, form);
  assert.equal(created.ok, false);
  assert.equal(created.form, form);
  assert.match(created.message, /What you typed is still here/);
  assert.equal(world.readList({ items: [], total: 0, nextOffset: null }).ok, true);
  assert.equal(world.readList({ items: [] }).ok, false);
  assert.deepEqual(world.appendPage([{ id: 'a' }], { items: [{ id: 'a' }, { id: 'b' }] }).map((item) => item.id), ['a', 'b']);
  assert.deepEqual(world.withId(['a'], 'a'), ['a']);
  assert.deepEqual(world.withoutId(['a', 'b'], 'a'), ['b']);
  const local = {
    saved: { kind: 'project', title: 'A', conversationIds: [], noteIds: [], version: 1 },
    draft: { title: 'B', conversationIds: [cid], noteIds: [] }, expectedVersion: 1,
  };
  const newer = world.absorbServer(local, { kind: 'project', title: 'Server', conversationIds: [], noteIds: [], version: 2 });
  assert.equal(newer.draft.title, 'B');
  assert.deepEqual(newer.draft.conversationIds, [cid]);
  assert.equal(newer.expectedVersion, 1);
  assert.match(newer.remoteNote, /version \(2\)/);
  assert.deepEqual(Object.keys(world.projectPutBody({ expectedVersion: 2, title: 'T', conversationIds: [cid], noteIds: [], memberIds: ['o-' + 'a'.repeat(36)] })).sort(), ['conversationIds', 'expectedVersion', 'memberIds', 'noteIds', 'title']);
  assert.deepEqual(world.projectCreateBody('T'), { title: 'T', expectedVersion: null });
  assert.deepEqual(world.notePutBody({ expectedVersion: 3, title: 'N', body: 'b', commentsOn: ['s-' + 'b'.repeat(36)] }).commentsOn, ['s-' + 'b'.repeat(36)]);
});

function studio() {
  const calls = [];
  const oid = 'o-' + 'a'.repeat(36);
  const sid = 's-' + 'b'.repeat(36);
  let project = { id: pid, kind: 'project', title: 'Core', conversationIds: [], noteIds: [], memberIds: [oid], version: 1, savedAt: '2026-10-25T00:00:00.000Z' };
  let rejectProject = true;
  const note = { id: 'n-note-1', kind: 'note', title: 'Margin', body: 'hello', provenance: 'user-authored', version: 1, savedAt: '2026-10-25T00:00:00.000Z' };
  const detail = {
    id: cid, sessionId: 'sess', title: 'Saved chat', status: 'complete', createdAt: '2026-10-25T00:00:00.000Z',
    identity: { nativeThreadId: null, accountId: null, state: 'unknown', accountHint: 'later' },
    source: { sessionId: 'sess', kind: 'saved-session', providerUrl: null, extraHint: 'kept' },
    messages: [{
      id: cid + ':turn:0', role: 'assistant', text: 'answer', truncated: true, redactions: 2,
      blocks: [{ type: 'code', language: 'js', text: 'a < b' }, { type: 'future-native-part', opaque: { bytes: [9991] } }],
      source: { sessionId: 'sess', key: 'DOM_TURNS', index: 0, observedTurnId: null, partHint: 'seen' },
    }],
    coverage: { state: 'partial', fullNativeThread: 'unknown', richContent: 'as-recorded', acceptance: 'not-assessed' },
  };
  const page = (items) => ({ items, total: items.length, offset: 0, limit: 50, nextOffset: null });
  const fetchImpl = async (url, init = {}) => {
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    const path = String(url).replace(/^.*\/api\/v1\/world/, '');
    calls.push({ method, path, body });
    const answer = (status, data) => ({ status, json: async () => data });
    if (path.startsWith('/conversations?')) return answer(200, page([{ id: cid, sessionId: 'sess', title: 'Saved chat', status: 'complete', identity: detail.identity, source: detail.source }]));
    if (path === '/conversations/' + cid) return answer(200, detail);
    if (path.startsWith('/projects?')) return answer(200, page([{ ...project }]));
    if (path === '/projects/' + pid && method === 'GET') return answer(200, { ...project });
    if (path === '/projects' && method === 'POST') {
      return answer(200, { id: 'p-side-1', kind: 'project', title: body.title, conversationIds: [], noteIds: [], version: 1, savedAt: project.savedAt });
    }
    if (path === '/projects/' + pid && method === 'PUT') {
      if (rejectProject || body.expectedVersion !== project.version) {
        rejectProject = false;
        return answer(409, { error: 'stale', code: 'CAS_VERSION_CONFLICT', expected: body.expectedVersion, actual: project.version });
      }
      project = { ...project, title: body.title, conversationIds: body.conversationIds, noteIds: body.noteIds, memberIds: body.memberIds ?? project.memberIds, version: project.version + 1 };
      return answer(200, { ...project });
    }
    if (path === '/namespace') return answer(200, { id: 'w-local-namespace', kind: 'namespace', schema: 'vivim.world/1' });
    if (path.startsWith('/objects?')) return answer(200, page([{ id: oid, kind: 'source-reference', objectType: 'conversation', availability: 'locally-available' }]));
    if (path.startsWith('/selections?')) return answer(200, page([{ id: sid, kind: 'selection', selectionType: 'message', availability: 'locally-available' }]));
    if (path.startsWith('/notes?')) return answer(200, page([]));
    if (path === '/notes' && method === 'POST') return answer(200, { ...note, title: body.title, body: body.body, commentsOn: [], version: 1 });
    if (path === '/notes/n-note-1' && method === 'PUT') return answer(409, { error: 'stale', code: 'CAS_VERSION_CONFLICT', expected: body.expectedVersion, actual: 2 });
    return answer(404, { error: 'missing', code: 'WORLD_NOT_FOUND' });
  };
  return { fetchImpl, calls, project: () => project, oid, sid };
}

async function type(node, value) { node.value = value; await node.dispatch('input'); }

test('the shell can read a saved conversation, edit a project, and refuse a stale save without dropping the draft', async () => {
  const doc = fakeDoc();
  const chat = doc.createElement('div');
  chat.id = 'chatApp';
  chat.marker = 'stay';
  const root = doc.createElement('section');
  const modes = doc.createElement('nav');
  const buttons = {};
  for (const [view, label] of [['capture', 'Capture'], ['conversations', 'Saved conversations'], ['projects', 'Projects'], ['notes', 'Notes']]) {
    const button = doc.createElement('button');
    button.setAttribute('data-view', view);
    button.textContent = label;
    modes.append(button);
    buttons[view] = button;
  }
  modes.querySelectorAll = (selector) => selector === '[data-view]' ? modes.children.filter((node) => node.getAttribute('data-view')) : [];
  const api = studio();
  const mounted = world.mountWorldView({
    document: doc, root, modes, chat, rich: ui.createRichRenderer(doc), fetchImpl: api.fetchImpl,
    storage: { getItem: () => null, setItem() {} }, announce() {},
  });
  assert.equal(mounted.view(), 'capture');
  assert.equal(chat.hidden, false);
  assert.equal(root.hidden, true);
  assert.deepEqual(api.calls, []);
  assert.equal(chat.marker, 'stay');

  await buttons.conversations.click();
  assert.equal(chat.hidden, true);
  assert.equal(root.hidden, false);
  assert.equal(buttons.conversations.getAttribute('aria-pressed'), 'true');
  assert.equal(buttons.projects.getAttribute('aria-pressed'), 'false');
  await buttonText(root, 'Saved chat')[0].click();
  const shown = root.textContent;
  assert.match(shown, /a < b/);
  assert.match(shown, /future-native-part/);
  assert.match(shown, /Full remote thread: unknown/);
  assert.match(shown, /not assessed/);
  assert.match(shown, /Extra Hint/);
  assert.match(shown, /kept/);
  assert.match(shown, /Account Hint/);
  assert.match(shown, /not recorded/);
  assert.match(shown, /Marked truncated/);
  assert.match(shown, /DOM_TURNS/);
  assert.doesNotMatch(shown, /9991|opaque/);
  assert.equal(all(root, (node) => node.tag === 'script' || node.tag === 'img').length, 0);
  assert.equal(chat.marker, 'stay');

  await buttons.projects.click();
  await type(byId(root, 'worldCreateTitle'), 'Side');
  await byId(root, 'worldCreate').click();
  const created = api.calls.find((call) => call.method === 'POST' && call.path === '/projects');
  assert.deepEqual(created.body, { title: 'Side', expectedVersion: null });
  assert.equal(byId(root, 'worldCreateTitle').value, '');
  assert.equal(byId(root, 'worldTitle').value, 'Side');

  await buttonText(root, 'Core')[0].click();
  assert.equal(byId(root, 'worldConvSelect').value, cid);
  await byId(root, 'worldAddConversation').click();
  assert.match(root.textContent, new RegExp(cid));
  await type(byId(root, 'worldTitle'), 'Draft title');
  await byId(root, 'worldSave').click();
  const stale = api.calls.filter((call) => call.method === 'PUT' && call.path === '/projects/' + pid);
  assert.equal(stale.length, 1);
  assert.equal(stale[0].body.expectedVersion, 1);
  assert.equal(stale[0].body.title, 'Draft title');
  assert.deepEqual(stale[0].body.conversationIds, [cid]);
  assert.deepEqual(stale[0].body.memberIds, [api.oid]);
  assert.deepEqual(Object.keys(stale[0].body).sort(), ['conversationIds', 'expectedVersion', 'memberIds', 'noteIds', 'title']);
  assert.match(root.textContent, /Local object/);
  assert.equal(byId(root, 'worldTitle').value, 'Draft title');
  assert.match(byId(root, 'worldError').textContent, /Not saved/);
  assert.match(root.textContent, new RegExp(cid));
  assert.equal(api.project().title, 'Core');
  assert.doesNotMatch(byId(root, 'worldNotice').textContent, /^Saved/);

  await byId(root, 'worldUseSaved').click();
  assert.equal(byId(root, 'worldTitle').value, 'Core');
  assert.doesNotMatch(root.textContent, new RegExp(cid));
  await byId(root, 'worldAddConversation').click();
  await type(byId(root, 'worldTitle'), 'After');
  await byId(root, 'worldSave').click();
  const saved = api.calls.filter((call) => call.method === 'PUT' && call.path === '/projects/' + pid);
  assert.equal(saved.length, 2);
  assert.equal(saved[1].body.expectedVersion, 1);
  assert.equal(saved[1].body.title, 'After');
  assert.deepEqual(saved[1].body.conversationIds, [cid]);
  assert.match(byId(root, 'worldVersion').textContent, /Version 2/);
  assert.match(byId(root, 'worldNotice').textContent, /^Saved/);

  await buttonText(root, 'Open conversation')[0].click();
  assert.match(root.textContent, /a < b/);
  assert.equal(api.calls.filter((call) => call.path === '/conversations/' + cid).length >= 1, true);
  const back = all(root, (node) => node.tag === 'button' && node.textContent === 'After');
  assert.equal(back.length, 1);
  await back[0].click();
  assert.equal(byId(root, 'worldTitle').value, 'After');
  await buttonText(root, 'Remove')[0].click();
  await byId(root, 'worldSave').click();
  const unlinked = api.calls.filter((call) => call.method === 'PUT');
  assert.deepEqual(unlinked.at(-1).body.conversationIds, []);
  assert.deepEqual(unlinked.at(-1).body.memberIds, [api.oid]);
  assert.equal(unlinked.at(-1).body.expectedVersion, 2);
  assert.equal(api.project().conversationIds.length, 0);

  await buttons.notes.click();
  await type(byId(root, 'worldCreateTitle'), 'Margin');
  await type(byId(root, 'worldCreateBody'), 'hello');
  await byId(root, 'worldCreate').click();
  const notePost = api.calls.find((call) => call.method === 'POST' && call.path === '/notes');
  assert.deepEqual(notePost.body, { title: 'Margin', body: 'hello', expectedVersion: null });
  await type(byId(root, 'worldBody'), 'hello draft');
  assert.equal(byId(root, 'worldCommentSelect').value, api.sid);
  await byId(root, 'worldAddComment').click();
  await byId(root, 'worldSave').click();
  assert.equal(byId(root, 'worldBody').value, 'hello draft');
  assert.match(root.textContent, new RegExp(api.sid));
  assert.match(byId(root, 'worldError').textContent, /Not saved/);
  const notePut = api.calls.find((call) => call.method === 'PUT' && call.path === '/notes/n-note-1');
  assert.deepEqual(notePut.body, { title: 'Margin', body: 'hello draft', expectedVersion: 1, commentsOn: [api.sid] });
  assert.equal(api.calls.some((call) => /\/map|\/search/.test(call.path)), false);

  await buttons.capture.click();
  assert.equal(chat.hidden, false);
  assert.equal(root.hidden, true);
  assert.equal(chat.marker, 'stay');
  assert.equal(all(modes, (node) => node.getAttribute('aria-pressed') === 'true').length, 1);
});

const flush = () => new Promise((resolve) => setImmediate(resolve));

function mountHarness(fetchImpl) {
  const doc = fakeDoc();
  const chat = doc.createElement('div');
  const root = doc.createElement('section');
  const modes = doc.createElement('nav');
  const buttons = {};
  for (const [view, label] of [['capture', 'Capture'], ['conversations', 'Saved conversations'], ['projects', 'Projects'], ['notes', 'Notes']]) {
    const button = doc.createElement('button');
    button.setAttribute('data-view', view);
    button.textContent = label;
    modes.append(button);
    buttons[view] = button;
  }
  modes.querySelectorAll = (selector) => selector === '[data-view]' ? modes.children.filter((node) => node.getAttribute('data-view')) : [];
  world.mountWorldView({
    document: doc, root, modes, chat, rich: ui.createRichRenderer(doc), fetchImpl,
    storage: { getItem: () => null, setItem() {} }, announce() {},
  });
  return { root, buttons };
}

test('reconciliation keeps drafts, page counts, member links, and active or unreadable reads distinct', async () => {
  const c1 = 'c-' + '1'.repeat(40);
  const c2 = 'c-' + '2'.repeat(40);
  const pid = 'p-reconcile';
  let project = { id: pid, kind: 'project', title: 'Bag', conversationIds: [], noteIds: [], memberIds: [c2], version: 1 };
  let holdOne = null;
  let saveGate = null;
  const calls = [];
  const answer = (status, data) => ({ status, json: async () => data });
  const listed = (items, total, offset, nextOffset) => ({ items, total, offset, limit: 50, nextOffset });
  const fetchImpl = async (url, init = {}) => {
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    const path = String(url).replace(/^.*\/api\/v1\/world/, '');
    calls.push({ method, path, body });
    if (path.startsWith('/conversations?')) {
      const offset = Number(new URL(url, 'http://studio.local').searchParams.get('offset') ?? 0);
      return offset === 0
        ? answer(200, listed([{ id: c1, title: 'One', status: 'complete', identity: { state: 'unknown' } }], 2, 0, 50))
        : answer(200, listed([{ id: c2, title: 'Two', status: 'complete', identity: { state: 'unknown' } }], 2, 50, null));
    }
    if (path === '/conversations/' + c2) {
      return answer(200, {
        id: c2, title: 'Two', status: 'complete', identity: { nativeThreadId: null, accountId: null, state: 'unknown' },
        source: { sessionId: 's2', kind: 'saved-session', providerUrl: null }, messages: [],
        coverage: { state: 'unavailable', reason: 'EVIDENCE_UNREADABLE', fullNativeThread: 'unknown', richContent: 'unavailable' },
      });
    }
    if (path === '/conversations/' + c1) {
      if (holdOne) await holdOne;
      return answer(409, { error: 'Source is active; saved evidence read unavailable', code: 'WORLD_SOURCE_ACTIVE' });
    }
    if (path.startsWith('/projects?')) return answer(200, listed([{ ...project }], 1, 0, null));
    if (path === '/projects/' + pid && method === 'GET') return answer(200, { ...project });
    if (path === '/projects/' + pid && method === 'PUT') {
      if (saveGate) await saveGate;
      project = { ...project, title: body.title, conversationIds: body.conversationIds, noteIds: body.noteIds, memberIds: body.memberIds, version: project.version + 1 };
      return answer(200, { ...project });
    }
    if (path === '/namespace') return answer(200, { id: 'w-reconcile', kind: 'namespace' });
    if (path.startsWith('/notes') || path.startsWith('/objects') || path.startsWith('/selections')) return answer(200, listed([], 0, 0, null));
    return answer(404, { error: 'missing', code: 'WORLD_NOT_FOUND' });
  };
  const { root, buttons } = mountHarness(fetchImpl);
  await buttons.conversations.click();
  assert.match(byId(root, 'worldListStatus').textContent, /Showing 1 of 2/);
  assert.equal(byId(root, 'worldMore').hidden, false);
  await byId(root, 'worldMore').click();
  assert.match(byId(root, 'worldListStatus').textContent, /Showing 2 of 2/);
  assert.equal(byId(root, 'worldMore').hidden, true);
  assert.equal(buttonText(root, 'One').length, 1);
  assert.equal(buttonText(root, 'Two').length, 1);

  await buttonText(root, 'Two')[0].click();
  assert.match(root.textContent, /EVIDENCE_UNREADABLE/);
  assert.match(root.textContent, /not an empty conversation/);
  assert.doesNotMatch(root.textContent, /No saved messages in this record/);
  assert.equal(buttonText(root, 'Bag').length, 1, 'a project that links this conversation only through memberIds is still shown');

  await buttonText(root, 'Bag')[0].click();
  await type(byId(root, 'worldTitle'), 'Draft bag');
  await buttons.notes.click();
  await buttons.projects.click();
  assert.equal(byId(root, 'worldTitle').value, 'Draft bag');
  let releaseSave;
  saveGate = new Promise((resolve) => { releaseSave = resolve; });
  const pending = byId(root, 'worldSave').click();
  await flush();
  await type(byId(root, 'worldTitle'), 'Draft bag later');
  releaseSave();
  await pending;
  const put = calls.filter((call) => call.method === 'PUT').at(-1);
  assert.equal(put.body.title, 'Draft bag');
  assert.deepEqual(put.body.memberIds, [c2]);
  assert.deepEqual(put.body.conversationIds, []);
  assert.equal(byId(root, 'worldTitle').value, 'Draft bag later');
  assert.match(byId(root, 'worldNotice').textContent, /Edits made after that are still here/);
  assert.match(byId(root, 'worldVersion').textContent, /Version 2/);

  let release;
  holdOne = new Promise((resolve) => { release = resolve; });
  await buttons.conversations.click();
  const stale = buttonText(root, 'One')[0].click();
  await flush();
  await buttonText(root, 'Two')[0].click();
  release();
  await stale;
  assert.doesNotMatch(root.textContent, /still active|Not on this computer/);
  assert.match(root.textContent, /EVIDENCE_UNREADABLE/);
  await buttonText(root, 'One')[0].click();
  assert.match(byId(root, 'worldError').textContent, /still active/);
  assert.equal(calls.some((call) => /\/map|\/search/.test(call.path)), false);
});


test('VIVIM Home, Settings and project gallery use existing local World API and real supported-site discovery', async () => {
  const doc = fakeDoc();
  const root = doc.createElement('section');
  const chat = doc.createElement('div');
  const modes = doc.createElement('nav');
  const buttons = {};
  for (const [view, label] of [
    ['capture', 'Chat'], ['home', 'Home'], ['settings', 'Settings'], ['projects', 'Projects'],
  ]) {
    const button = doc.createElement('button');
    button.setAttribute('data-view', view);
    button.textContent = label;
    modes.append(button);
    buttons[view] = button;
  }
  modes.querySelectorAll = (selector) => selector === '[data-view]'
    ? modes.children.filter((node) => node.getAttribute('data-view')) : [];
  const api = studio();
  const providerCalls = [];
  const fetchImpl = async (url, init = {}) => {
    if (String(url) === '/api/v1/conversation-targets') {
      providerCalls.push({ method: init.method ?? 'GET' });
      return { status: 200, json: async () => ({
        sites: [{ id: 'chatgpt' }, { id: 'claude' }],
        targets: [],
      }) };
    }
    return api.fetchImpl(url, init);
  };
  const mounted = world.mountWorldView({
    document: doc, root, modes, chat, rich: ui.createRichRenderer(doc), fetchImpl,
    storage: { getItem: () => null, setItem() {} }, announce() {},
  });
  await buttons.home.click();
  assert.equal(mounted.view(), 'home');
  assert.equal(root.getAttribute('data-active-view'), 'home');
  assert.match(root.textContent, /Good to see you/);
  assert.equal(all(root, (node) => node.className === 'vivim-overview-card').length, 4);
  assert.match(root.textContent, /Personal Agent/);
  assert.match(root.textContent, /Saved locally in this Harness/);
  await buttons.settings.click();
  assert.equal(mounted.view(), 'settings');
  assert.equal(all(root, (node) => node.getAttribute?.('role') === 'tab').length, 5);
  assert.match(root.textContent, /Supported websites are not verified logins or connected accounts/);
  assert.match(root.textContent, /chatgpt/);
  assert.match(root.textContent, /claude/);
  assert.doesNotMatch(root.textContent, /✓ Connected|Authenticated account/);
  assert.deepEqual(providerCalls, [{ method: 'GET' }], 'supported sites are read, never signed into');
  await buttons.projects.click();
  assert.equal(mounted.view(), 'projects');
  assert.equal(root.getAttribute('data-active-view'), 'projects');
  assert.ok(all(root, (node) => typeof node.className === 'string'
    && node.className.includes('vivim-project-card')).length > 0);
  assert.deepEqual(api.calls.filter((request) => request.method !== 'GET'), [],
    'navigation never writes saved data or sends to a provider');
});
