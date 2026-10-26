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
  assert.ok(byId(root, 'worldWorkspaceReadBody'), 'the reader body renders; a broken render must fail loudly');
  assert.ok(all(byId(root, 'worldDetail'), (node) => String(node.className).includes('pill')).length >= 1,
    'the reading pane carries a provenance chip element');
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

test('leaving Workspace mid-map and returning shows no fake loading line and keeps Explore usable', async () => {
  const held = deferred();
  const { root, controller } = mount((path) => path.startsWith('/map?') ? held.promise : null);
  await controller.choose('workspace');
  const pending = start(root, pid); await flush();
  assert.equal(byId(root, 'worldWorkspaceStatus').textContent, 'Loading local associations…');
  await controller.choose('capture');
  await controller.choose('workspace');
  held.resolve(answer(200, mapFor(pid))); await pending; await flush();
  assert.doesNotMatch(root.textContent, /Loading local associations…/, 'an aborted map never leaves a fake loading line behind');
  assert.equal(byId(root, 'worldWorkspaceStatus').textContent, '', 'the status is cleared, not stuck');
  assert.equal(byId(root, 'worldWorkspaceShow').disabled, false);
});

test('the reader chip matches the clicked row and is drawn exactly once', async () => {
  const { root, controller } = mount();
  await controller.choose('workspace');
  await start(root, pid);
  await open(root, cid).click();
  const detail = byId(root, 'worldDetail');
  const importedPills = all(detail, (node) => String(node.className).includes('pill') && node.textContent === 'Imported snapshot');
  assert.equal(importedPills.length, 1, 'Imported snapshot is drawn once, not once per pane layer');
  assert.match(detail.textContent, /imported snapshot, not a recording Studio observed/);
  assert.doesNotMatch(detail.textContent, /Provenance unknown/, 'the list said Imported snapshot, so the pane must not say unknown');
});

test('a stored import carrying only coverage.state still reads as Imported snapshot', async () => {
  const nid2 = 'n-33333333-3333-4333-8333-333333333333';
  const { root, controller } = mount((path) => {
    if (path === '/notes/' + nid2) return answer(200, { id: nid2, title: 'Imported margin', coverage: { state: 'imported-snapshot' } });
    if (path.startsWith('/map?')) return answer(200, {
      nodes: [
        { id: nid, kind: 'note', title: 'Margin', provenance: 'user-authored' },
        { id: nid2, kind: 'note', title: 'Imported margin' },
      ],
      edges: [{ from: nid, to: nid2, kind: 'associates' }],
      complete: true, truncated: false,
    });
    return null;
  });
  await controller.choose('workspace');
  await start(root, nid);
  await open(root, nid2).click();
  const detail = byId(root, 'worldDetail');
  const pills = all(detail, (node) => String(node.className).includes('pill') && node.textContent === 'Imported snapshot');
  assert.equal(pills.length, 1);
  assert.doesNotMatch(detail.textContent, /Provenance unknown/, 'coverage.state falls back to the custody chip, not unknown');
});

test('the Starting from header shows the focused item chip before anything is read', async () => {
  const nid2 = 'n-33333333-3333-4333-8333-333333333333';
  const { root, controller } = mount((path) => path.startsWith('/map?') ? answer(200, {
    nodes: [
      { id: nid2, kind: 'note', title: 'Imported margin', provenance: 'imported-snapshot' },
      { id: nid, kind: 'note', title: 'Margin', provenance: 'user-authored' },
      { id: pid, kind: 'project', title: 'Bag', provenance: 'user-authored' },
    ],
    edges: [{ from: nid2, to: nid, kind: 'associates' }],
    complete: true, truncated: false,
  }) : null);
  await controller.choose('workspace');
  await start(root, pid);
  assert.match(byId(root, 'worldWorkspaceFocusChip').textContent, /Yours/, 'a user-authored start is marked Yours in the header');
  const typed = byId(root, 'worldWorkspaceId');
  const show = byId(root, 'worldWorkspaceShow');
  typed.value = nid2;
  await typed.dispatch('change');
  assert.equal(byId(root, 'worldWorkspaceShow'), show, 'the Explore button survives the typed change (mousedown uses it)');
  await show.click();
  assert.match(byId(root, 'worldWorkspaceFocusChip').textContent, /Imported snapshot/,
    'the imported flag is visible from the header, before the item is opened');
  assert.doesNotMatch(byId(root, 'worldDetail').textContent, /Imported margin/, 'nothing was read yet');
});

test('an edge whose id is not recognised is an honest dead end, not a silent Open button', async () => {
  const { root, controller } = mount((path) => path.startsWith('/map?') ? answer(200, {
    nodes: [
      { id: nid, kind: 'note', title: 'Margin', provenance: 'user-authored' },
      { id: 'x-1', kind: 'mystery' },
    ],
    edges: [{ from: nid, to: 'x-1', kind: 'references' }],
    complete: true, truncated: false,
  }) : null);
  await controller.choose('workspace');
  await start(root, nid);
  const results = byId(root, 'worldWorkspaceResults');
  assert.match(results.textContent, /Cannot be opened here: unrecognised id/);
  assert.equal(all(results, (node) => node.tag === 'button').length, 0, 'no Open button for an id Studio cannot open');
});

test('object and selection readers show what the record addresses as plain labelled rows', async () => {
  const oid = 'o-55555555-5555-4555-8555-555555555555';
  const { root, controller } = mount((path) => {
    if (path === '/objects/' + oid) return answer(200, { id: oid, kind: 'source-reference', objectType: 'conversation', conversationId: cid });
    if (path === '/selections/' + sid) return answer(200, { id: sid, kind: 'selection', selectionType: 'part', objectId: oid,
      source: { messageIndex: 3, partPath: ['blocks', 0], revision: 'a'.repeat(12) } });
    if (path.startsWith('/map?')) return answer(200, {
      nodes: [
        { id: nid, kind: 'note', title: 'Margin', provenance: 'user-authored' },
        { id: oid, kind: 'source-reference', title: 'conversation reference', provenance: 'user-linked-source' },
        { id: sid, kind: 'selection', provenance: 'user-selected' },
      ],
      edges: [{ from: nid, to: oid, kind: 'references' }, { from: nid, to: sid, kind: 'references' }],
      complete: true, truncated: false,
    });
    return null;
  });
  await controller.choose('workspace');
  await start(root, nid);
  await open(root, oid).click();
  const detail = byId(root, 'worldDetail');
  assert.match(detail.textContent, new RegExp(`Source conversation${cid}`));
  await open(root, sid).click();
  const rows = byId(root, 'worldDetail').textContent;
  assert.match(rows, /Selection typepart/);
  assert.match(rows, /Parent object/);
  assert.match(rows, /Message index3/);
  assert.match(rows, /Part pathblocks > 0/);
  assert.match(rows, /Pinned revisionaaaaaaaaaaaa/);
  assert.doesNotMatch(rows, /sessionId|revisionBasis|partPath" /, 'source internals stay out; labelled rows only');
});

test('typing an id keeps the Explore control in place for a single click', async () => {
  const { root, controller } = mount();
  await controller.choose('workspace');
  await start(root, pid);
  const typed = byId(root, 'worldWorkspaceId');
  const show = byId(root, 'worldWorkspaceShow');
  typed.value = nid;
  await typed.dispatch('change');
  assert.equal(byId(root, 'worldWorkspaceShow'), show, 'the button between mousedown and mouseup must never be rebuilt');
  assert.equal(show.disabled, false);
  await show.click();
  assert.equal(byId(root, 'worldWorkspaceFocus').textContent, nid);
});

test('opening moves focus to the reading-pane heading and mutates the status node in place', async () => {
  const read = deferred();
  const { root, controller } = mount((path) => path === '/conversations/' + cid ? read.promise : null);
  await controller.choose('workspace');
  await start(root, pid);
  const statusBefore = byId(root, 'worldWorkspaceReadStatus');
  const pending = open(root, cid).click(); await flush();
  assert.match(statusBefore.textContent, /Loading saved item…/);
  read.resolve(answer(200, { id: cid, title: 'Imported conversation', custody: 'imported', messages: [] })); await pending;
  assert.equal(byId(root, 'worldWorkspaceReadStatus'), statusBefore, 'role=status is mutated in place, not rebuilt');
  assert.match(statusBefore.textContent, /Saved item opened\./);
  const head = byId(root, 'worldWorkspaceReadHead');
  assert.equal(head.attrs.tabindex, '-1', 'the reader heading is focusable');
  assert.equal(head.focused, true, 'focus moved to the reading pane after Open');
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
  // Pin the stacked-layout media query itself, not just a stray rule: the rule must live inside
  // @media (max-width: 800px) exactly once.
  assert.match(html, /@media \(max-width: 800px\) \{[^@]*?\.world-grid \{ grid-template-columns: minmax\(0, 1fr\);/);
  assert.equal((html.match(/\.world-grid \{ grid-template-columns/g) ?? []).length, 1);
  const source = readFileSync(new URL('../../src/studio/ui/world-view.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /innerHTML|insertAdjacentHTML|outerHTML|document\.write/);
});
