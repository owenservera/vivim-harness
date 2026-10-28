// Find view: synthetic DOM only. No browser and no live search index.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as ui from '../../src/studio/ui/chat.mjs';
import * as world from '../../src/studio/ui/world-view.mjs';

const html = readFileSync(new URL('../../src/studio/ui/chat.html', import.meta.url), 'utf8');
const source = readFileSync(new URL('../../src/studio/ui/world-view.mjs', import.meta.url), 'utf8');
const flush = () => new Promise((resolve) => setImmediate(resolve));
const cid = 'c-' + 'a'.repeat(40);
const pid = 'p-find-1';
const oid = 'o-' + 'b'.repeat(36);

class Txt { constructor(data) { this.data = String(data); } }
class Node {
  constructor(tag = 'div') { Object.assign(this, { tag, id: '', children: [], attrs: {}, listeners: {}, hidden: false, disabled: false, value: '', className: '', focused: false }); }
  append(...kids) { this.children.push(...kids); }
  replaceChildren(...kids) { this.children = kids; }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  getAttribute(name) { return Object.hasOwn(this.attrs, name) ? this.attrs[name] : null; }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  set textContent(value) { this.children = value === '' || value == null ? [] : [new Txt(value)]; }
  get textContent() { return this.children.map((child) => (child instanceof Txt ? child.data : child.textContent ?? '')).join(''); }
  focus() { this.focused = true; }
  async click() { for (const fn of this.listeners.click ?? []) await fn({ preventDefault() {} }); }
  async dispatch(type, event = {}) { for (const fn of this.listeners[type] ?? []) await fn({ preventDefault() {}, ...event }); }
}
const walk = (node, fn) => { if (!node || node instanceof Txt) return; fn(node); for (const child of node.children ?? []) walk(child, fn); };
const all = (root, pred) => { const out = []; walk(root, (node) => { if (pred(node)) out.push(node); }); return out; };
const byId = (root, id) => all(root, (node) => node.id === id)[0] ?? null;

function mount(fetchImpl) {
  const doc = { createElement: (tag) => new Node(tag), createTextNode: (text) => new Txt(text) };
  const chat = doc.createElement('div');
  const root = doc.createElement('section');
  const modes = doc.createElement('nav');
  const buttons = {};
  for (const [view, label] of [['capture', 'Capture'], ['conversations', 'Saved conversations'], ['projects', 'Projects'], ['notes', 'Notes'], ['find', 'Find']]) {
    const button = doc.createElement('button');
    button.setAttribute('data-view', view);
    button.textContent = label;
    modes.append(button);
    buttons[view] = button;
  }
  modes.querySelectorAll = (selector) => selector === '[data-view]' ? modes.children.filter((node) => node.getAttribute('data-view')) : [];
  world.mountWorldView({ document: doc, root, modes, chat, rich: ui.createRichRenderer(doc), fetchImpl, storage: { getItem: () => null, setItem() {} }, announce() {} });
  return { root, buttons };
}
const answer = (status, data) => ({ status, json: async () => data });
const hit = (fields) => ({ score: 1, source: {}, ...fields });

test('find is a peer view and does not inject result text as HTML', () => {
  assert.match(html, /data-view="find"/);
  assert.match(html, /Local edits do not change provider content/);
  // Find is a peer entry in the one view nav, never a sub-view nested inside another screen:
  // every data-view marker in the document is a mode button inside #shellModes.
  const nav = html.slice(html.indexOf('id="shellModes"'), html.indexOf('</nav>', html.indexOf('id="shellModes"')));
  assert.match(nav, /id="viewFind" data-view="find"/);
  assert.equal((nav.match(/data-view="/g) ?? []).length, (nav.match(/<button[^>]*data-view="/g) ?? []).length, 'every view marker is a peer mode button');
  assert.equal((html.match(/data-view="/g) ?? []).length, (nav.match(/data-view="/g) ?? []).length, 'no view is nested inside another view');
  assert.doesNotMatch(source, /innerHTML|insertAdjacentHTML|outerHTML|document\.write/);
  assert.match(world.searchStatusText({ shown: 1, total: 2, coverage: { complete: false, truncated: true } }), /1 of 2 matches in this scan/);
  assert.doesNotMatch(world.searchStatusText({ shown: 1, total: 2, coverage: { complete: false } }), /all results/i);
  assert.match(world.searchCoverageLines({ complete: false, truncated: true, reasons: ['message-scan-limit'], absent: { conversations: 2 }, failures: [{ message: 'unread' }], qualification: 'scan only' }).join('\n'), /message-scan-limit/);
  assert.match(world.availabilityLabel({ availability: 'stale', availabilityReason: 'REVISION_CHANGED' }), /not deleted/i);
  assert.doesNotMatch(world.availabilityLabel({ availability: 'missing', availabilityReason: 'SOURCE_MISSING' }), /deleted it/i);
});

test('empty text is not searched, a stale response is ignored, and coverage stays incomplete', async () => {
  const calls = [];
  let releaseFirst;
  const first = new Promise((resolve) => { releaseFirst = resolve; });
  let secondStarted = false;
  const fetchImpl = async (url, init = {}) => {
    const path = String(url);
    calls.push(path);
    if (!path.includes('/search?')) return answer(200, { items: [], total: 0, offset: 0, limit: 50, nextOffset: null });
    const q = new URL(path, 'http://studio.local').searchParams.get('q');
    if (q === 'one') {
      await first;
      if (init.signal?.aborted) { const error = new Error('aborted'); error.name = 'AbortError'; throw error; }
      return answer(200, { items: [hit({ id: 'p-old', kind: 'project', title: 'Old', snippet: 'old <script>' })], total: 1, offset: 0, limit: 50, nextOffset: null, coverage: { complete: true, truncated: false, reasons: [], failures: [], absent: { conversations: 0 } } });
    }
    secondStarted = true;
    return answer(200, {
      items: [
        hit({ id: 'p-new-a', kind: 'project', title: 'Same', snippet: 'same words' }),
        hit({ id: 'p-new-b', kind: 'project', title: 'Same', snippet: 'same words' }),
      ],
      total: 2, offset: 0, limit: 50, nextOffset: null,
      coverage: { complete: false, truncated: true, reasons: ['message-scan-limit'], absent: { conversations: 2 }, failures: [{ message: 'one read failed' }], qualification: 'not everything that exists' },
    });
  };
  const { root, buttons } = mount(fetchImpl);
  await buttons.find.click();
  await byId(root, 'worldFindSubmit').click();
  assert.equal(calls.some((path) => path.includes('/search?')), false);
  assert.match(byId(root, 'worldFindError').textContent, /Nothing was searched/);

  await byId(root, 'worldFindQuery').dispatch('input');
  byId(root, 'worldFindQuery').value = 'one';
  await byId(root, 'worldFindQuery').dispatch('input');
  const pending = byId(root, 'worldFindSubmit').click();
  await flush();
  byId(root, 'worldFindQuery').value = 'two';
  await byId(root, 'worldFindQuery').dispatch('input');
  await byId(root, 'worldFindSubmit').click();
  assert.equal(secondStarted, true);
  releaseFirst();
  await pending;
  assert.match(root.textContent, /p-new-a/);
  assert.match(root.textContent, /p-new-b/);
  assert.equal(all(root, (node) => node.tag === 'button' && node.textContent.includes('Old')).length, 0);
  assert.match(root.textContent, /message-scan-limit/);
  assert.match(root.textContent, /incomplete/i);
  assert.match(root.textContent, /same words/);
  assert.equal(all(root, (node) => node.tag === 'script').length, 0);
  assert.doesNotMatch(root.textContent, /all results/i);
});

test('a bad query shows the problem, load more follows nextOffset, and a hit opens its own record', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const path = String(url);
    const method = init.method ?? 'GET';
    calls.push(path + ' ' + method);
    if (path.includes('/search?')) {
      const params = new URL(path, 'http://studio.local').searchParams;
      if (params.get('q') === 'bad') return answer(400, { error: 'kind must be one of message, project', code: 'WORLD_INVALID_INPUT' });
      if (params.get('q') === 'ref') return answer(200, { items: [hit({ id: oid, kind: 'source-reference', title: 'conversation reference', snippet: 'reference', availability: 'stale', availabilityReason: 'REVISION_CHANGED', conversationId: cid })], total: 1, offset: 0, limit: 50, nextOffset: null, coverage: { complete: true, truncated: false, reasons: [], failures: [], absent: { conversations: 0 }, qualification: 'scan only' } });
      const offset = Number(params.get('offset') ?? 0);
      if (offset === 0) return answer(200, { items: [hit({ id: pid, kind: 'project', title: 'Kept', snippet: 'kept' })], total: 2, offset: 0, limit: 50, nextOffset: 50, coverage: { complete: true, truncated: false, reasons: [], failures: [], absent: { conversations: 0 }, qualification: 'scan only' } });
      return answer(200, { items: [hit({ id: cid + ':turn:1', kind: 'message', title: 'assistant message 2', snippet: 'second', conversation: { id: cid, title: 'Saved' }, source: { index: 1, key: 'DOM_TURNS' } })], total: 2, offset: 50, limit: 50, nextOffset: null, coverage: { complete: true, truncated: false, reasons: [], failures: [], absent: { conversations: 0 }, qualification: 'scan only' } });
    }
    if (path.includes('/objects?') || path.includes('/selections?') || path.includes('/notes?')) return answer(200, { items: [], total: 0, offset: 0, limit: 50, nextOffset: null });
    if (path.includes('/projects?')) return answer(200, { items: [], total: 0, offset: 0, limit: 50, nextOffset: null });
    if (path.includes('/projects/' + pid)) return answer(200, { id: pid, kind: 'project', title: 'Kept', conversationIds: [], noteIds: [], memberIds: [], version: 1 });
    if (path.includes('/conversations/' + cid)) return answer(200, {
      id: cid, title: 'Saved', status: 'complete', identity: { nativeThreadId: null, accountId: null, state: 'unknown' },
      source: { sessionId: 's', kind: 'saved-session', providerUrl: null },
      messages: [{ role: 'user', text: 'first', blocks: [] }, { role: 'assistant', text: 'second', blocks: [] }],
      coverage: { state: 'saved-observation', fullNativeThread: 'unknown', richContent: 'as-recorded' },
    });
    if (path.includes('/objects/' + oid)) return answer(200, { id: oid, kind: 'source-reference', objectType: 'conversation', availability: 'stale', availabilityReason: 'REVISION_CHANGED', conversationId: cid });
    if (path.includes('/namespace')) return answer(200, { id: 'w-find', kind: 'namespace' });
    return answer(404, { error: 'missing', code: 'WORLD_NOT_FOUND' });
  };
  const { root, buttons } = mount(fetchImpl);
  await buttons.find.click();
  byId(root, 'worldFindQuery').value = 'bad';
  await byId(root, 'worldFindQuery').dispatch('input');
  await byId(root, 'worldFindQuery').dispatch('keydown', { key: 'Enter' });
  assert.match(byId(root, 'worldFindError').textContent, /kind must be one of message, project/);
  assert.equal(byId(root, 'worldFindMore').hidden, true);

  byId(root, 'worldFindQuery').value = 'kept';
  await byId(root, 'worldFindQuery').dispatch('input');
  await byId(root, 'worldFindSubmit').click();
  assert.equal(byId(root, 'worldFindMore').hidden, false);
  assert.match(byId(root, 'worldFindStatus').textContent, /1 of 2 matches in this scan/);
  await byId(root, 'worldFindMore').click();
  assert.equal(byId(root, 'worldFindMore').hidden, true);
  assert.match(root.textContent, /p-find-1/);
  assert.match(root.textContent, new RegExp(cid + ':turn:1'));

  const messageButton = all(root, (node) => node.tag === 'button' && node.textContent.includes(':turn:1'))[0];
  await messageButton.click();
  assert.equal(byId(root, 'worldMsg1').focused, true);
  assert.match(byId(root, 'worldMsg1').textContent, /second/);
  assert.notEqual(byId(root, 'worldMsg0').focused, true);

  await buttons.find.click();
  const projectButton = all(root, (node) => node.tag === 'button' && node.textContent.includes(pid))[0];
  await projectButton.click();
  assert.equal(byId(root, 'worldTitle').value, 'Kept');

  await buttons.find.click();
  byId(root, 'worldFindQuery').value = 'ref';
  await byId(root, 'worldFindQuery').dispatch('input');
  await byId(root, 'worldFindSubmit').click();
  await all(root, (node) => node.tag === 'button' && node.textContent.includes(oid))[0].click();
  assert.match(root.textContent, /Stale/);
  assert.match(root.textContent, /REVISION_CHANGED/);
  assert.match(root.textContent, /not deleted/i);
  assert.doesNotMatch(root.textContent, /was deleted/i);
});

// --- Part focus (find hits carry source.partPath) ---

const detailFixture = () => ({
  id: cid, title: 'Saved', status: 'complete', identity: { nativeThreadId: null, accountId: null, state: 'unknown' },
  source: { sessionId: 's', kind: 'saved-session', providerUrl: null },
  messages: [
    { role: 'user', text: 'first', blocks: [{ type: 'paragraph', text: 'intro paragraph' }] },
    {
      role: 'assistant', text: 'second',
      blocks: [
        { type: 'paragraph', text: 'opening thought' },
        { type: 'paragraph', text: 'the exact words' },
        { type: 'code', language: 'js', text: 'x = 1;' },
      ],
    },
  ],
  coverage: { state: 'saved-observation', fullNativeThread: 'unknown', richContent: 'as-recorded' },
});

function mountWithDetail(searchItems) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const path = String(url);
    calls.push(path);
    if (path.includes('/search?')) {
      return answer(200, {
        items: searchItems, total: searchItems.length, offset: 0, limit: 50, nextOffset: null,
        coverage: { complete: true, truncated: false, reasons: [], failures: [], absent: { conversations: 0 }, qualification: 'scan only' },
      });
    }
    if (path.includes('/objects?') || path.includes('/selections?') || path.includes('/notes?')) return answer(200, { items: [], total: 0, offset: 0, limit: 50, nextOffset: null });
    if (path.includes('/projects?')) return answer(200, { items: [], total: 0, offset: 0, limit: 50, nextOffset: null });
    if (path.includes('/conversations/' + cid)) return answer(200, detailFixture());
    if (path.includes('/namespace')) return answer(200, { id: 'w-find', kind: 'namespace' });
    return answer(404, { error: 'missing', code: 'WORLD_NOT_FOUND' });
  };
  const { root, buttons } = mount(fetchImpl);
  return { root, buttons, calls };
}

async function searchAndClick(root, buttons, label) {
  await buttons.find.click();
  byId(root, 'worldFindQuery').value = 'q';
  await byId(root, 'worldFindQuery').dispatch('input');
  await byId(root, 'worldFindSubmit').click();
  await flush();
  await all(root, (node) => node.tag === 'button' && node.textContent.includes(label))[0].click();
  await flush();
}

const messageHit = (index, extraSource = {}) => ({
  id: `${cid}:turn:${index}`, kind: 'message', title: `assistant message ${index + 1}`,
  snippet: 'second', conversation: { id: cid, title: 'Saved' },
  source: { index, key: 'DOM_TURNS', ...extraSource },
});

const framesOf = (root) => all(root, (node) => node.attrs && Object.prototype.hasOwnProperty.call(node.attrs, 'data-part-path'));

test('a message hit with a partPath focuses and marks the exact rendered part', async () => {
  const { root, buttons } = mountWithDetail([messageHit(1, { partPath: [1] })]);
  await searchAndClick(root, buttons, `${cid}:turn:1`);
  const frame = framesOf(root).find((node) => node.getAttribute('data-part-path') === '1' && node.textContent.includes('the exact words'));
  assert.ok(frame, 'the rendered block for partPath 1 exists with a stable part marker');
  assert.equal(frame.focused, true, 'the exact part receives focus');
  assert.equal(frame.getAttribute('tabindex'), '-1', 'the part frame is reachable by programmatic focus');
  assert.equal(frame.getAttribute('aria-current'), 'true');
  assert.match(frame.textContent, /Matched part/);
  const other = framesOf(root).filter((node) => node.getAttribute('data-part-path') === '0');
  assert.ok(other.length, 'friendly sibling frame is marked too');
  assert.notEqual(other[0].focused, true);
  assert.equal(other[0].getAttribute('aria-current'), null);
  assert.equal(framesOf(root).some((node) => node.getAttribute('data-part-path') === '2'), true, 'the code block keeps its own frame');
  assert.doesNotMatch(root.textContent, /could not be located/);
});

test('a partPath that does not resolve keeps the message open and says so, without fake markers', async () => {
  for (const partPath of [[9], [0, 1], ['bad key'], 'zero']) {
    const { root, buttons, calls } = mountWithDetail([messageHit(1, { partPath })]);
    await buttons.find.click();
    byId(root, 'worldFindQuery').value = 'miss';
    await byId(root, 'worldFindQuery').dispatch('input');
    await byId(root, 'worldFindSubmit').click();
    await flush();
    await all(root, (node) => node.tag === 'button' && node.textContent.includes(`${cid}:turn:1`))[0].click();
    await flush();
    assert.match(byId(root, 'worldError').textContent, /Opened the message; the matching part could not be located/, `honest status for ${JSON.stringify(partPath)}`);
    assert.equal(byId(root, 'worldMsg1').focused, true, 'the message row is still the focused fallback');
    assert.equal(framesOf(root).some((node) => node.getAttribute('aria-current') === 'true'), false, 'no part is falsely marked as matched');
    assert.equal(framesOf(root).some((node) => node.textContent.includes('Matched part')), false);
    assert.ok(calls.some((path) => path.includes('/conversations/' + cid)), 'the conversation was opened for the message hit');
  }
});

test('an imported-snapshot message hit opens through the local imported conversation id', async () => {
  const importedId = 'c-i' + 'b'.repeat(38);
  const calls = [];
  const fetchImpl = async (url) => {
    const path = String(url);
    calls.push(path);
    if (path.includes('/search?')) {
      return answer(200, {
        items: [{ id: `${importedId}:turn:0`, kind: 'message', title: 'user message 1', snippet: 'snapshot line', conversation: { id: importedId, title: 'Imported snapshot' }, source: { index: 0, key: 'DOM_TURNS' } }],
        total: 1, offset: 0, limit: 50, nextOffset: null,
        coverage: { complete: true, truncated: false, reasons: [], failures: [], absent: { conversations: 0 }, qualification: 'scan only' },
      });
    }
    if (path.includes('/objects?') || path.includes('/selections?') || path.includes('/notes?')) return answer(200, { items: [], total: 0, offset: 0, limit: 50, nextOffset: null });
    if (path.includes('/projects?')) return answer(200, { items: [], total: 0, offset: 0, limit: 50, nextOffset: null });
    if (path.includes('/conversations/' + importedId)) return answer(200, {
      id: importedId, title: 'Imported snapshot', status: 'complete', identity: { nativeThreadId: null, accountId: null, state: 'unknown' },
      source: { sessionId: null, kind: 'imported-reference', providerUrl: null },
      messages: [{ role: 'user', text: 'snapshot line', blocks: [] }],
      coverage: { state: 'imported-snapshot', fullNativeThread: 'unknown', richContent: 'as-recorded' },
    });
    if (path.includes('/namespace')) return answer(200, { id: 'w-find', kind: 'namespace' });
    return answer(404, { error: 'missing', code: 'WORLD_NOT_FOUND' });
  };
  const { root, buttons } = mount(fetchImpl);
  await buttons.find.click();
  byId(root, 'worldFindQuery').value = 'snapshot';
  await byId(root, 'worldFindQuery').dispatch('input');
  await byId(root, 'worldFindSubmit').click();
  await flush();
  await all(root, (node) => node.tag === 'button' && node.textContent.includes(`${importedId}:turn:0`))[0].click();
  await flush();
  assert.ok(calls.some((path) => path.includes('/conversations/' + importedId)), 'opening uses the local imported id');
  assert.equal(byId(root, 'worldMsg0').focused, true, 'the imported message opens and focuses');
  assert.match(root.textContent, /imported snapshot/i);
  assert.doesNotMatch(root.textContent, /could not be located/);
});

test('no partPath keeps message-only opening while parts keep their own stable markers', async () => {
  const { root, buttons } = mountWithDetail([messageHit(1)]);
  await buttons.find.click();
  byId(root, 'worldFindQuery').value = 'plain';
  await byId(root, 'worldFindQuery').dispatch('input');
  await byId(root, 'worldFindSubmit').click();
  await flush();
  await all(root, (node) => node.tag === 'button' && node.textContent.includes(`${cid}:turn:1`))[0].click();
  await flush();
  assert.equal(byId(root, 'worldMsg1').focused, true, 'message-level focus is unchanged');
  assert.ok(framesOf(root).length >= 3, 'the same blocks are still rendered as frames');
  assert.equal(framesOf(root).some((node) => node.getAttribute('aria-current') === 'true'), false);
  assert.doesNotMatch(root.textContent, /could not be located/);
  assert.doesNotMatch(root.textContent, /Matched part/);
});
