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
const oid = 'o-' + 'b'.repeat(36);

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

test('saved reasoning, status and tool parts are labelled, and unknown payloads stay hidden', () => {
  assert.match(html, /data-view="relations"/);
  const plan = world.turnPlan({
    blocks: [
      { type: 'thinking', text: 'weigh the options' },
      { type: 'progress', text: 'still working' },
      { kind: 'tool-call', text: 'read file', opaque: { secret: [4242] } },
      { type: 'future-native-part', opaque: { bytes: [9991] } },
    ],
  });
  assert.match(plan.markdown, /Reasoning \(saved\)/);
  assert.match(plan.markdown, /weigh the options/);
  assert.match(plan.markdown, /Status/);
  assert.match(plan.markdown, /still working/);
  assert.match(plan.markdown, /Tool call: stage as recorded/);
  assert.match(plan.markdown, /read file/);
  assert.match(plan.unknowns.map((item) => item.note).join('\n'), /future-native-part/);
  assert.doesNotMatch(JSON.stringify(plan), /4242|9991|opaque|secret/);
  const parsed = ui.parseRich(plan.markdown);
  assert.ok(parsed.blocks.some((block) => block.type === 'paragraph'));
});

test('relations lists neighbours from one record, ignores a stale map, and does not call the result deleted', async () => {
  const calls = [];
  let releaseFirst;
  const first = new Promise((resolve) => { releaseFirst = resolve; });
  let heldPid = false;
  const mapFor = (focus) => ({
    namespaceId: 'w-1',
    nodes: [
      { id: focus, kind: focus === nid ? 'note' : 'project', title: focus === nid ? 'Margin' : 'Bag', provenance: 'user-authored' },
      { id: cid, kind: 'conversation', title: 'Observed chat', provenance: 'source-observation' },
      { id: pid, kind: 'project', title: 'Bag', provenance: 'user-authored' },
      { id: oid, kind: 'source-reference', title: 'conversation reference', provenance: 'source-observation', availability: 'missing', availabilityReason: 'SOURCE_MISSING' },
    ],
    edges: [
      { from: pid, to: cid, kind: 'associates', evidence: { basis: 'local association; not native equality' } },
      { from: nid, to: pid, kind: 'comments_on', evidence: { basis: 'local association; not native equality' } },
      { from: oid, to: nid, kind: 'references', evidence: { basis: 'local association; not native equality' } },
    ],
    complete: false,
    truncated: true,
    lenses: ['WHAT', 'HOW', 'WHERE', 'WHEN', 'WHO'],
  });
  const fetchImpl = async (url, init = {}) => {
    const path = String(url).replace(/^.*\/api\/v1\/world/, '');
    calls.push(path);
    if (path.startsWith('/conversations?')) return answer(200, page([{ id: cid, title: 'Observed chat' }]));
    if (path.startsWith('/projects?')) return answer(200, page([{ id: pid, title: 'Bag', conversationIds: [], noteIds: [], memberIds: [] }]));
    if (path.startsWith('/notes?')) return answer(200, page([{ id: nid, title: 'Margin' }]));
    if (path.startsWith('/namespace')) return answer(200, { id: 'w-1', kind: 'namespace' });
    if (path.startsWith('/map?')) {
      const params = new URL(path, 'http://studio.local').searchParams;
      assert.equal(params.get('offset'), null);
      const id = params.get('id');
      if (id === pid && !heldPid) {
        heldPid = true;
        await first;
        if (init.signal?.aborted) { const error = new Error('aborted'); error.name = 'AbortError'; throw error; }
        return answer(200, mapFor('p-stale'));
      }
      return answer(200, mapFor(id));
    }
    if (path === '/projects/' + pid) return answer(200, { id: pid, kind: 'project', title: 'Bag', conversationIds: [cid], noteIds: [], memberIds: [], version: 1 });
    if (path === '/notes/' + nid) return answer(200, { id: nid, kind: 'note', title: 'Margin', body: '', commentsOn: [], version: 1, provenance: 'user-authored' });
    return answer(404, { error: 'missing', code: 'WORLD_NOT_FOUND' });
  };
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
  releaseFirst();
  await pending;
  assert.match(byId(root, 'worldRelationStatus').textContent, /Showing \d+, more exist/);
  assert.match(root.textContent, /Associates/);
  assert.match(root.textContent, /Comments on/);
  assert.match(root.textContent, /Observed/);
  assert.match(root.textContent, /Yours/);
  assert.match(root.textContent, /SOURCE_MISSING/);
  assert.match(root.textContent, /not the same as deleted/i);
  assert.doesNotMatch(root.textContent, /WHAT/);
  assert.doesNotMatch(root.textContent, /p-stale/);
  assert.match(root.textContent, /local associations/i);
  const openProject = all(root, (node) => node.tag === 'button' && node.textContent.includes(pid))[0];
  await openProject.click();
  assert.equal(byId(root, 'worldTitle').value, 'Bag');
});
