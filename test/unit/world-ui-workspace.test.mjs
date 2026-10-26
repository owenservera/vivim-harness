// T1 synthetic DOM only: no CSS/layout, real keyboard or browser proof.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mountWorldView } from '../../src/studio/ui/world-view.mjs';
import { createRichRenderer } from '../../src/studio/ui/chat.mjs';

const cid = 'c-' + 'a'.repeat(40);
const pid = 'p-11111111-1111-4111-8111-111111111111';
const nid = 'n-22222222-2222-4222-8222-222222222222';
const sid = 's-44444444-4444-8444-4444-444444444444';
class Txt { constructor(data) { this.data = String(data); } }
class Node {
  constructor(tag = 'div') { Object.assign(this, { tag, id: '', children: [], attrs: {}, listeners: {}, hidden: false, disabled: false, value: '', className: '' }); }
  append(...kids) { this.children.push(...kids.filter((kid) => kid != null)); }
  replaceChildren(...kids) { this.children = kids.filter((kid) => kid != null); }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  getAttribute(name) { return this.attrs[name] ?? null; }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  set textContent(value) { this.children = value === '' || value == null ? [] : [new Txt(value)]; }
  get textContent() { return this.children.map((child) => child instanceof Txt ? child.data : child.textContent ?? '').join(''); }
  focus() { this.focused = true; }
  async click() { if (!this.disabled) await this.dispatch('click'); }
  async dispatch(type) { if (this.disabled) return; for (const fn of this.listeners[type] ?? []) await fn({ preventDefault() {} }); }
}
const all = (node, pred) => node instanceof Txt ? [] : [...(pred(node) ? [node] : []), ...(node.children ?? []).flatMap((child) => all(child, pred))];
const byId = (root, id) => all(root, (node) => node.id === id)[0];
const answer = (status, data) => ({ status, json: async () => data });
const page = (items) => ({ items, total: items.length, offset: 0, nextOffset: null });
const flush = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const mapFor = (id) => ({
  nodes: [
    { id, title: 'Starting item', provenance: 'user-authored' },
    { id: cid, title: 'Imported conversation', kind: 'conversation', provenance: 'imported-snapshot' },
    { id: nid, title: 'Margin', kind: 'note', provenance: 'user-authored' },
    { id: pid, title: 'Bag', kind: 'project', provenance: 'user-authored' },
    { id: sid, title: 'Unresolved selection', availability: 'unresolved', availabilityReason: 'NOT_SCANNED' },
  ],
  edges: [cid, nid, pid, sid].filter((to) => to !== id).map((to) => ({ from: id, to, kind: 'associates' })),
  truncated: true, complete: false, edgeScanLimit: 100,
});
function mount(override = () => null) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const path = String(url).replace('/api/v1/world', '');
    calls.push({ path, signal: init.signal });
    const special = override(path, init);
    if (special) return special;
    if (path.startsWith('/namespace')) return answer(200, { id: 'w-1' });
    if (path.startsWith('/conversations?')) return answer(200, page([{ id: cid, title: 'Imported conversation' }]));
    if (path.startsWith('/projects?')) return answer(200, page([{ id: pid, title: 'Bag' }]));
    if (path.startsWith('/notes?')) return answer(200, page([{ id: nid, title: 'Margin' }]));
    if (path.startsWith('/objects?') || path.startsWith('/selections?')) return answer(200, page([]));
    if (path.startsWith('/map?')) return answer(200, mapFor(new URL(path, 'http://local').searchParams.get('id')));
    if (path === '/conversations/' + cid) return answer(200, { id: cid, title: 'Imported conversation', custody: 'imported', coverage: { state: 'imported-snapshot' }, messages: [{ role: 'assistant', text: 'Saved answer in reading pane' }] });
    if (path === '/notes/' + nid) return answer(200, { id: nid, title: 'Margin', body: 'Saved note body <not markup>', provenance: 'user-authored' });
    if (path === '/projects/' + pid) return answer(200, { id: pid, title: 'Bag', conversationIds: [cid], noteIds: [nid], memberIds: [] });
    return answer(404, { code: 'WORLD_NOT_FOUND' });
  };
  const doc = { createElement: (tag) => new Node(tag), createTextNode: (text) => new Txt(text) };
  const root = new Node('section'), modes = new Node('nav');
  for (const view of ['capture', 'workspace', 'relations', 'notes']) { const button = new Node('button'); button.setAttribute('data-view', view); modes.append(button); }
  modes.querySelectorAll = () => modes.children;
  const controller = mountWorldView({ document: doc, root, modes, chat: new Node(), rich: createRichRenderer(doc), fetchImpl, storage: { getItem: () => null, setItem() {} }, announce() {} });
  return { root, calls, controller };
}
async function start(root, id) {
  const select = byId(root, 'worldWorkspaceStart'); select.value = id; await select.dispatch('change');
  return byId(root, 'worldWorkspaceShow').click();
}
const open = (root, id) => all(byId(root, 'worldWorkspaceResults'), (node) => node.tag === 'button' && node.getAttribute('aria-label') === 'Open ' + id)[0];

test('Workspace is a peer: reads saved messages, note body and project summary without leaving, then traverses', async () => {
  const { root, controller } = mount();
  await controller.choose('workspace');
  assert.equal(byId(root, 'worldWorkspaceShow').disabled, true);
  await start(root, pid);
  assert.equal(byId(root, 'worldWorkspaceFocus').textContent, pid);
  assert.match(byId(root, 'worldWorkspaceStatus').textContent, /more exist/);
  assert.match(byId(root, 'worldWorkspaceResults').textContent, /Imported snapshot/);
  assert.match(root.textContent, /edges scanned: up to 100/);
  await open(root, cid).click();
  assert.equal(controller.view(), 'workspace');
  assert.match(byId(root, 'worldDetail').textContent, /Saved answer in reading pane/);
  assert.match(byId(root, 'worldDetail').textContent, /imported snapshot, not a recording Studio observed/);
  await byId(root, 'worldWorkspaceRefocus').click();
  assert.equal(byId(root, 'worldWorkspaceFocus').textContent, cid);
  assert.equal(byId(root, 'worldWorkspaceRefocus'), undefined);
  await open(root, nid).click();
  assert.match(byId(root, 'worldDetail').textContent, /Saved note body <not markup>/);
  await open(root, pid).click();
  assert.match(byId(root, 'worldDetail').textContent, /Saved conversations linked1Notes linked1/);
  assert.equal(byId(root, 'worldWorkspaceReadStatus').attrs['aria-live'], 'polite');
});

test('unresolved neighbours cannot open; invalid typed ids cause no request', async () => {
  const { root, calls, controller } = mount();
  await controller.choose('workspace');
  await start(root, pid);
  assert.match(byId(root, 'worldWorkspaceResults').textContent, /Not scanned \/ unresolved/);
  assert.equal(open(root, sid), undefined);
  const input = byId(root, 'worldWorkspaceId'); input.value = '../not-an-id'; await input.dispatch('change');
  const before = calls.length;
  await byId(root, 'worldWorkspaceShow').click();
  assert.equal(calls.length, before);
  assert.match(byId(root, 'worldWorkspaceError').textContent, /not an id this Studio recognizes/);
  const valid = byId(root, 'worldWorkspaceId'); valid.value = nid; await valid.dispatch('change');
  await byId(root, 'worldWorkspaceShow').click();
  assert.equal(byId(root, 'worldWorkspaceFocus').textContent, nid);
});

test('both panes discard stale replies even when transport ignores abort', async () => {
  const map = deferred(), read = deferred(); let holdMap = true;
  const { root, calls, controller } = mount((path) => {
    if (path.startsWith('/map?') && holdMap) { holdMap = false; return map.promise; }
    if (path === '/conversations/' + cid) return read.promise;
  });
  await controller.choose('workspace');
  const oldMap = start(root, pid); await flush();
  await start(root, nid);
  const oldMapCall = calls.find((call) => call.path.startsWith('/map?'));
  assert.equal(oldMapCall.signal.aborted, true);
  map.resolve(answer(200, { nodes: [{ id: cid, title: 'STALE MAP' }], edges: [{ from: pid, to: cid, kind: 'associates' }] }));
  await oldMap;
  assert.equal(byId(root, 'worldWorkspaceFocus').textContent, nid);
  assert.doesNotMatch(root.textContent, /STALE MAP/);
  const oldRead = open(root, cid).click(); await flush();
  await open(root, pid).click();
  assert.equal(calls.find((call) => call.path === '/conversations/' + cid).signal.aborted, true);
  read.resolve(answer(200, { id: cid, title: 'STALE READING', messages: [] })); await oldRead;
  assert.doesNotMatch(byId(root, 'worldDetail').textContent, /STALE READING/);
  assert.match(byId(root, 'worldDetail').textContent, /Bag/);
});

test('changing focus and leaving Workspace abort pending detail reads; missing stays honest', async () => {
  const held = deferred();
  const { root, calls, controller } = mount((path) => path === '/notes/' + nid ? held.promise : path === '/conversations/' + cid ? answer(404, {}) : null);
  await controller.choose('workspace'); await start(root, pid);
  await open(root, cid).click();
  assert.match(byId(root, 'worldWorkspaceReadStatus').textContent, /missing or stale/);
  assert.equal(byId(root, 'worldWorkspaceRefocus'), undefined);
  const pending = open(root, nid).click(); await flush();
  await start(root, cid);
  assert.equal(calls.find((call) => call.path === '/notes/' + nid).signal.aborted, true);
  held.resolve(answer(200, { id: nid, title: 'OLD NOTE', body: 'obsolete' })); await pending;
  assert.doesNotMatch(byId(root, 'worldDetail').textContent, /OLD NOTE|obsolete/);
  const pendingAgain = open(root, nid).click(); await controller.choose('capture'); await pendingAgain;
  assert.equal(calls.filter((call) => call.path === '/notes/' + nid).at(-1).signal.aborted, true);
});

test('shell includes Workspace and keeps the existing narrow-screen stack and inert text rendering', () => {
  const html = readFileSync(new URL('../../src/studio/ui/chat.html', import.meta.url), 'utf8');
  assert.match(html, /data-view="workspace"/);
  assert.match(html, /worldWorkspaceResults \.rowbtn \{ min-height: 44px/);
  assert.match(html, /\.world-grid \{ grid-template-columns: minmax\(0, 1fr\);/);
  const source = readFileSync(new URL('../../src/studio/ui/world-view.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /innerHTML|insertAdjacentHTML|outerHTML|document\.write/);
});
