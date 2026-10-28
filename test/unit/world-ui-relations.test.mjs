// Relations list and labelled saved parts. Synthetic DOM only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as ui from '../../src/studio/ui/chat.mjs';
import * as world from '../../src/studio/ui/world-view.mjs';

const html = readFileSync(new URL('../../src/studio/ui/chat.html', import.meta.url), 'utf8');
const cid = 'c-' + 'a'.repeat(40);
const pid = 'p-11111111-1111-4111-8111-111111111111';
const nid = 'n-22222222-2222-4222-8222-222222222222';
const oid = 'o-55555555-5555-4555-8555-555555555555';
const unid = 's-44444444-4444-8444-4444-444444444444';

class Txt { constructor(data) { this.data = String(data); } }
class Node {
  constructor(tag = 'div') { Object.assign(this, { tag, id: '', children: [], attrs: {}, listeners: {}, hidden: false, disabled: false, value: '', className: '' }); }
  append(...kids) { this.children.push(...kids.filter((kid) => kid != null)); }
  replaceChildren(...kids) { this.children = kids.filter((kid) => kid != null); }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  getAttribute(name) { return Object.hasOwn(this.attrs, name) ? this.attrs[name] : null; }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  set textContent(value) { this.children = value === '' || value == null ? [] : [new Txt(value)]; }
  get textContent() { return this.children.map((child) => (child instanceof Txt ? child.data : child.textContent ?? '')).join(''); }
  focus() {}
  async click() { if (this.disabled) return; for (const fn of this.listeners.click ?? []) await fn({ preventDefault() {} }); }
  async dispatch(type, event = {}) { for (const fn of this.listeners[type] ?? []) await fn({ preventDefault() {}, ...event }); }
}
const walk = (node, fn) => { if (!node || node instanceof Txt) return; fn(node); for (const child of node.children ?? []) walk(child, fn); };
const all = (root, pred) => { const out = []; walk(root, (node) => { if (pred(node)) out.push(node); }); return out; };
const byId = (root, id) => all(root, (node) => node.id === id)[0] ?? null;
const answer = (status, data) => ({ status, json: async () => data });
const page = (items) => ({ items, total: items.length, offset: 0, limit: 50, nextOffset: null });
const flush = () => new Promise((resolve) => setImmediate(resolve));

function mount(fetchImpl) {
  const doc = { createElement: (tag) => new Node(tag), createTextNode: (text) => new Txt(text) };
  const root = doc.createElement('section');
  const modes = doc.createElement('nav');
  const buttons = {};
  for (const [view, label] of [['capture', 'Capture'], ['conversations', 'Saved conversations'], ['projects', 'Projects'], ['notes', 'Notes'], ['relations', 'Relations']]) {
    const button = doc.createElement('button');
    button.setAttribute('data-view', view);
    button.textContent = label;
    modes.append(button);
    buttons[view] = button;
  }
  modes.querySelectorAll = (selector) => selector === '[data-view]' ? modes.children.filter((node) => node.getAttribute('data-view')) : [];
  world.mountWorldView({ document: doc, root, modes, chat: doc.createElement('div'), rich: ui.createRichRenderer(doc), fetchImpl, storage: { getItem: () => null, setItem() {} }, announce() {} });
  return { root, buttons };
}

// A standard list+namespace stub. mapFor answers each map request by focus id.
function listStub(mapFor, { held = null } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const path = String(url).replace(/^.*\/api\/v1\/world/, '');
    calls.push(path);
    if (path.startsWith('/conversations?')) return answer(200, page([{ id: cid, title: 'Observed chat' }]));
    if (path.startsWith('/projects?')) return answer(200, page([{ id: pid, title: 'Bag', conversationIds: [], noteIds: [], memberIds: [] }]));
    if (path.startsWith('/notes?')) return answer(200, page([{ id: nid, title: 'Margin' }]));
    if (path.startsWith('/objects?')) return answer(200, page([{ id: oid, kind: 'source-reference' }]));
    if (path.startsWith('/selections?')) return answer(200, page([{ id: unid, kind: 'selection' }]));
    if (path.startsWith('/namespace')) return answer(200, { id: 'w-1', kind: 'namespace' });
    if (path.startsWith('/map?')) {
      const params = new URL(path, 'http://studio.local').searchParams;
      assert.equal(params.get('offset'), null);
      const id = params.get('id');
      if (held && !held.taken) {
        held.taken = true;
        await held.promise;
        if (init.signal?.aborted) { const error = new Error('aborted'); error.name = 'AbortError'; throw error; }
        return answer(200, held.body);
      }
      return answer(200, mapFor(id));
    }
    if (path === '/projects/' + pid) return answer(200, { id: pid, kind: 'project', title: 'Bag', conversationIds: [], noteIds: [], memberIds: [], version: 1 });
    if (path === '/notes/' + nid) return answer(200, { id: nid, kind: 'note', title: 'Margin', body: '', commentsOn: [], version: 1, provenance: 'user-authored' });
    return answer(404, { error: 'missing', code: 'WORLD_NOT_FOUND' });
  };
  return { fetchImpl, calls };
}

test('saved reasoning, status and tool parts are labelled as their own blocks, and unknown payloads stay hidden', () => {
  assert.match(html, /data-view="relations"/);
  const plan = world.turnPlan({
    blocks: [
      { type: 'thinking', text: 'weigh the options' },
      { type: 'progress', text: 'still working' },
      { kind: 'tool-call', text: 'read file', opaque: { secret: [4242] }, args: { path: 'secret-key.txt' } },
      { type: 'reasoning', blocks: [{ type: 'sealed-part', payload: { noise: [9991] } }] },
      { type: 'status' },
      { type: 'future-native-part', opaque: { bytes: [5555] } },
    ],
  });
  const parsed = ui.parseRich(plan.markdown);
  assert.deepEqual(parsed.blocks.filter((block) => block.type === 'heading').map((block) => block.text),
    ['Reasoning (saved)', 'Status', 'Tool call: stage as recorded', 'Reasoning (saved)', 'Status'],
    'labels are their own heading blocks, not inline bold inside an answer paragraph');
  assert.match(plan.markdown, /weigh the options/);
  assert.match(plan.markdown, /still working/);
  assert.match(plan.markdown, /read file/);
  const notes = plan.unknowns.map((item) => item.note).join('\n');
  assert.match(notes, /sealed-part/, 'nested unrenderable parts are named');
  assert.match(notes, /details of this part were not formatted/, 'a labelled block with no text and no readable children says what was not rendered');
  assert.doesNotMatch(notes, /4242|9991|5555|secret|payload|noise/);
  assert.ok(parsed.blocks.some((block) => block.type === 'paragraph' && block.text === 'weigh the options'));
});

test('provenance chips cover every provenance the map emits, and unresolved nodes are never called yours', () => {
  const chip = (node) => world.provenanceChip(node)[0];
  assert.equal(chip({ provenance: 'user-selected' }), 'Yours');
  assert.equal(chip({ provenance: 'user-linked-source' }), 'Yours');
  assert.equal(chip({ provenance: 'user-authored' }), 'Yours');
  assert.equal(chip({ provenance: 'source-observation' }), 'Observed');
  assert.equal(chip({ provenance: 'imported-snapshot' }), 'Imported snapshot');
  assert.equal(chip({ custody: 'imported' }), 'Imported snapshot');
  assert.equal(chip({ provenance: 'some-future-value' }), 'Provenance unknown');
  assert.equal(chip({ availability: 'unresolved', availabilityReason: 'NOT_SCANNED' }), 'Not scanned / unresolved');
});

test('relation status tells truncated, complete and not-reported apart', () => {
  assert.equal(world.relationStatus({ complete: true, truncated: false }, 2), 'Showing 2.');
  assert.equal(world.relationStatus({ truncated: true }, 2), 'Showing 2, more exist.');
  assert.equal(world.relationStatus({ complete: false }, 0), 'Showing 0, more exist.');
  assert.equal(world.relationStatus({ truncated: false }, 0), 'Showing 0. Whether more exist was not reported.');
  assert.equal(world.relationStatus(null, 0), 'Showing 0. Whether more exist was not reported.');
});

test('relation groups keep edge direction and never fold unknown kinds into references', () => {
  const map = {
    nodes: [
      { id: pid, kind: 'project', title: 'Bag', provenance: 'user-authored' },
      { id: cid, kind: 'conversation', title: 'Observed chat', provenance: 'source-observation' },
      { id: oid, kind: 'source-reference', provenance: 'user-linked-source' },
      { id: 'x-1', kind: 'mystery', provenance: 'custom-kind' },
    ],
    edges: [
      { from: nid, to: pid, kind: 'comments_on', evidence: { basis: 'A margin note made by hand' } },
      { from: oid, to: nid, kind: 'references', evidence: { basis: 'local association; not native equality' } },
      { from: nid, to: cid, kind: 'sidecar', evidence: { basis: 'custom link' } },
      { from: 'x-1', to: nid, kind: 'weird-kind' },
    ],
  };
  const groups = world.relationGroups(nid, map);
  assert.deepEqual(groups.map((group) => group.label),
    ['Comments on', 'Referenced by', 'Unrecognised relation: sidecar', 'Unrecognised relation: weird-kind (incoming)'],
    'direction is stated and unknown kinds keep their own group');
  const comments = groups.find((group) => group.kind === 'comments_on');
  assert.equal(comments.outgoing, true);
  assert.deepEqual(comments.rows.map((row) => row.id), [pid]);
  assert.equal(comments.rows[0].basis, 'A margin note made by hand');
  const references = groups.find((group) => group.kind === 'references');
  assert.equal(references.outgoing, false);
  assert.deepEqual(references.rows.map((row) => row.id), [oid]);
  assert.equal(groups.some((group) => group.kind === 'references' && group.rows.some((row) => row.id === cid)), false,
    'the sidecar edge is not counted as a reference');
});

test('relations lists neighbours from one record, ignores a stale map, and does not call the result deleted', async () => {
  const mapFor = (focus) => ({
    namespaceId: 'w-1',
    nodes: [
      { id: focus, kind: focus === nid ? 'note' : 'project', title: focus === nid ? 'Margin' : 'Bag', provenance: 'user-authored' },
      { id: cid, kind: 'conversation', title: 'Observed chat', provenance: 'source-observation' },
      { id: pid, kind: 'project', title: 'Bag', provenance: 'user-authored' },
      { id: oid, kind: 'source-reference', title: 'conversation reference', provenance: 'user-linked-source', availability: 'missing', availabilityReason: 'SOURCE_MISSING' },
    ],
    edges: [
      { from: pid, to: cid, kind: 'associates', evidence: { basis: 'local association; not native equality' } },
      { from: nid, to: pid, kind: 'comments_on', evidence: { basis: 'A margin note made by hand on this project' } },
      { from: oid, to: nid, kind: 'references', evidence: { basis: 'local association; not native equality' } },
    ],
    complete: false,
    truncated: true,
    inputLimitPerKind: 1000,
    edgeScanLimit: 10000,
    enumerationNote: 'Pagination bounds record projection, not directory enumeration.',
    lenses: ['WHAT', 'HOW', 'WHERE', 'WHEN', 'WHO'],
  });
  let releaseHeld;
  const held = { promise: new Promise((resolve) => { releaseHeld = resolve; }), taken: false, body: mapFor('p-stale'), release: () => releaseHeld() };
  const { fetchImpl, calls } = listStub(mapFor, { held });
  const { root, buttons } = mount(fetchImpl);
  await buttons.relations.click();
  assert.equal(byId(root, 'worldRelationShow').disabled, true);
  await byId(root, 'worldRelationShow').click();
  assert.equal(calls.some((path) => path.startsWith('/map?')), false);
  byId(root, 'worldRelationStart').value = pid;
  await byId(root, 'worldRelationStart').dispatch('change');
  const pending = byId(root, 'worldRelationShow').click();
  await flush();
  byId(root, 'worldRelationStart').value = nid;
  await byId(root, 'worldRelationStart').dispatch('change');
  await byId(root, 'worldRelationShow').click();
  held.release();
  await pending;
  assert.match(byId(root, 'worldRelationStatus').textContent, /Showing \d+, more exist/);
  assert.match(root.textContent, /Comments on/);
  assert.ok(byId(root, 'vivimRelationGraph'), 'the real map also renders a visual projection');
  assert.ok(all(root, (node) => node.tag === 'button' && String(node.className).includes('vivim-graph-node')).length >= 2,
    'graph nodes are keyboard-usable buttons, derived only from returned nodes');
  assert.equal(all(root, (node) => node.tag === 'button' && String(node.className).includes('vivim-graph-node')
    && node.disabled).length >= 1, true, 'unavailable source reference is not actionable from the graph');
  assert.match(root.textContent, /Yours/);
  assert.match(root.textContent, /SOURCE_MISSING/);
  assert.match(root.textContent, /not the same as deleted/i);
  assert.match(root.textContent, /A margin note made by hand on this project/, 'a recorded basis that is not the standard caveat is shown with its row');
  assert.doesNotMatch(root.textContent, /not native equality/, 'the standard local-association caveat is not repeated per row');
  const caveatParts = root.textContent.split('not proof that two records are the same thing');
  assert.equal(caveatParts.length - 1, 1, 'the local-association caveat appears once, not per row');
  assert.match(root.textContent, /records read per kind: up to 1000/, 'scan bounds from the map are shown');
  assert.match(root.textContent, /Pagination bounds record projection/, 'the enumeration note from the map is shown');
  assert.doesNotMatch(root.textContent, /p-stale/);
  const openProject = all(root, (node) => node.tag === 'button' && node.textContent.includes(pid))[0];
  await openProject.click();
  assert.equal(byId(root, 'worldTitle').value, 'Bag');
});

test('changing the starting record drops the pending response for the old focus', async () => {
  const mapFor = (focus) => ({
    namespaceId: 'w-1',
    nodes: [{ id: focus, kind: focus === pid ? 'project' : 'conversation', title: focus === pid ? 'Bag' : 'Observed chat',
      provenance: focus === pid ? 'user-authored' : 'source-observation' }],
    edges: [],
    truncated: true,
    complete: false,
  });
  const staleMap = {
    namespaceId: 'w-1',
    nodes: [
      { id: 'p-stale', kind: 'project', title: 'Stale bag', provenance: 'user-authored' },
      { id: cid, kind: 'conversation', title: 'Observed chat', provenance: 'source-observation' },
    ],
    edges: [{ from: 'p-stale', to: cid, kind: 'references', evidence: { basis: 'local association; not native equality' } }],
    truncated: true,
    complete: false,
  };
  let releaseHeld;
  const held = { promise: new Promise((resolve) => { releaseHeld = resolve; }), taken: false, body: staleMap, release: () => releaseHeld() };
  const { fetchImpl, calls } = listStub(mapFor, { held });
  const { root, buttons } = mount(fetchImpl);
  await buttons.relations.click();
  byId(root, 'worldRelationStart').value = pid;
  await byId(root, 'worldRelationStart').dispatch('change');
  const pending = byId(root, 'worldRelationShow').click();
  await flush();
  const mapCallsBefore = calls.filter((path) => path.startsWith('/map?')).length;
  byId(root, 'worldRelationStart').value = cid;
  await byId(root, 'worldRelationStart').dispatch('change');
  held.release();
  await pending;
  assert.equal(byId(root, 'worldRelationStatus').textContent, '');
  assert.doesNotMatch(root.textContent, /p-stale/);
  assert.equal(calls.filter((path) => path.startsWith('/map?')).length, mapCallsBefore, 'the focus change alone fires no new map request');
  const pending2 = byId(root, 'worldRelationShow').click();
  await flush();
  await pending2;
  assert.equal(byId(root, 'worldRelationError').textContent, '');
  assert.match(byId(root, 'worldRelationStatus').textContent, /Showing/);
  assert.doesNotMatch(root.textContent, /p-stale/, 'the replacement map is for the new focus only');
});

test('unresolved references are labelled not scanned, never called yours, and never openable', async () => {
  const mapFor = () => ({
    namespaceId: 'w-1',
    nodes: [
      { id: nid, kind: 'note', title: 'Margin', provenance: 'user-authored' },
      { id: unid, kind: 'unresolved-reference', availability: 'unresolved', availabilityReason: 'NOT_SCANNED' },
    ],
    edges: [{ from: nid, to: unid, kind: 'references', evidence: { basis: 'local association; not native equality' } }],
    complete: true,
    truncated: false,
  });
  const { fetchImpl } = listStub(mapFor);
  const { root, buttons } = mount(fetchImpl);
  await buttons.relations.click();
  byId(root, 'worldRelationStart').value = nid;
  await byId(root, 'worldRelationStart').dispatch('change');
  await byId(root, 'worldRelationShow').click();
  assert.match(root.textContent, /Not scanned \/ unresolved/);
  assert.doesNotMatch(root.textContent, /\bYours\b/, 'an unresolved placeholder is not presented as user-made');
  assert.doesNotMatch(root.textContent, /This is not evidence that it was deleted/, 'not scanned is not dressed up as unavailable');
  assert.match(root.textContent, /Linked but never read/);
  assert.match(root.textContent, /NOT_SCANNED/);
  assert.equal(all(root, (node) => node.tag === 'button' && node.textContent.includes(unid)).length, 0,
    'a not-scanned placeholder has no open button');
  assert.match(byId(root, 'worldRelationStatus').textContent, /^Showing 1\.$/, 'a reported-complete scan states the count plainly');
});

test('the starting picker offers saved local records and accepts a typed exact id', async () => {
  const mapFor = () => ({
    namespaceId: 'w-1',
    nodes: [
      { id: nid, kind: 'note', title: 'Margin', provenance: 'user-authored' },
      { id: cid, kind: 'conversation', title: 'Observed chat', provenance: 'source-observation' },
    ],
    edges: [{ from: nid, to: cid, kind: 'references', evidence: { basis: 'local association; not native equality' } }],
    complete: true,
    truncated: false,
  });
  const { fetchImpl, calls } = listStub(mapFor);
  const { root, buttons } = mount(fetchImpl);
  await buttons.relations.click();
  const select = byId(root, 'worldRelationStart');
  assert.ok(select.attrs.value ? false : true);
  const options = select.children.filter((node) => node.tag === 'option').map((node) => node.getAttribute('value'));
  assert.deepEqual(options.slice(1), [cid, pid, nid, oid, unid], 'conversations, projects, notes, objects and selections are all offered');
  const show = byId(root, 'worldRelationShow');
  const typed = byId(root, 'worldRelationId');
  typed.value = 'not-an-id';
  await typed.dispatch('change');
  const showTyped = byId(root, 'worldRelationShow');
  assert.equal(showTyped.disabled, false, 'a typed id enables the button when the picker is empty');
  await showTyped.click();
  const mapCalls = calls.filter((path) => path.startsWith('/map?')).length;
  assert.equal(mapCalls, 0, 'a malformed id is validated before any request');
  assert.match(byId(root, 'worldRelationError').textContent, /not an id this Studio recognizes/);
  assert.match(byId(root, 'worldRelationError').textContent, /Nothing was loaded/);
  const typed2 = byId(root, 'worldRelationId');
  typed2.value = nid;
  await typed2.dispatch('change');
  await byId(root, 'worldRelationShow').click();
  assert.match(byId(root, 'worldRelationStatus').textContent, /Showing/);
});

test('a truncated scan with no visible rows says more may exist instead of claiming none', async () => {
  const mapFor = () => ({
    namespaceId: 'w-1',
    nodes: [
      { id: nid, kind: 'note', title: 'Margin', provenance: 'user-authored' },
      { id: cid, kind: 'conversation', title: 'Observed chat', provenance: 'source-observation' },
    ],
    edges: [{ from: cid, to: pid, kind: 'associates', evidence: { basis: 'local association; not native equality' } }],
    truncated: true,
    complete: false,
  });
  const { fetchImpl } = listStub(mapFor);
  const { root, buttons } = mount(fetchImpl);
  await buttons.relations.click();
  byId(root, 'worldRelationStart').value = nid;
  await byId(root, 'worldRelationStart').dispatch('change');
  await byId(root, 'worldRelationShow').click();
  assert.match(byId(root, 'worldRelationStatus').textContent, /Showing 0, more exist/);
  assert.match(root.textContent, /the scan stopped early, so more may exist/);
  assert.doesNotMatch(root.textContent, /No local associations for this record\./);
});

test('a not-reported scan never claims completeness, even with rows', async () => {
  const mapFor = () => ({
    namespaceId: 'w-1',
    nodes: [
      { id: nid, kind: 'note', title: 'Margin', provenance: 'user-authored' },
      { id: cid, kind: 'conversation', title: 'Observed chat', provenance: 'source-observation' },
    ],
    edges: [{ from: nid, to: cid, kind: 'references', evidence: { basis: 'local association; not native equality' } }],
    // deliberately no complete/truncated flags
  });
  const { fetchImpl } = listStub(mapFor);
  const { root, buttons } = mount(fetchImpl);
  await buttons.relations.click();
  byId(root, 'worldRelationStart').value = nid;
  await byId(root, 'worldRelationStart').dispatch('change');
  await byId(root, 'worldRelationShow').click();
  assert.match(byId(root, 'worldRelationStatus').textContent, /Whether more exist was not reported/);
  assert.doesNotMatch(byId(root, 'worldRelationStatus').textContent, /Showing 1\.$/);
});

test('graph projection contains only reported nodes and edges and respects coverage bounds', () => {
  const map = {
    nodes: [
      { id: cid, kind: 'conversation', title: 'Observed' },
      { id: pid, kind: 'project', title: 'Local project' },
      { id: unid, kind: 'unresolved-reference', availability: 'unresolved', availabilityReason: 'NOT_SCANNED' },
    ],
    edges: [
      { from: pid, to: cid, kind: 'associates', evidence: { basis: 'local association' } },
      { from: pid, to: 'n-not-loaded', kind: 'references' },
    ],
    complete: false,
  };
  const graph = world.graphProjection(pid, map); // argument inversion should never generate an invented relation
  assert.deepEqual(graph.nodes, []);
  const actual = world.graphProjection(map, pid, 2);
  assert.deepEqual(actual.nodes.map(n => n.id), [pid, cid]);
  assert.equal(actual.nodes[0].isFocus, true);
  assert.equal(actual.nodes[0].x, 50);
  assert.equal(actual.nodes[0].y, 50);
  assert.equal(actual.edges.length, 1);
  assert.equal(actual.edges[0].from, pid);
  assert.equal(actual.edges[0].to, cid);
  assert.equal(actual.truncated, true);
  assert.equal(world.graphProjection(null, pid).edges.length, 0);
});
