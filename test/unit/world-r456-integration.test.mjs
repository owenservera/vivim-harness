// R4/R5/R6 source-to-visible-action regression. T1 synthetic DOM, not a real browser or provider test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { savedInlineLinks, turnPlan, mountWorldView } from '../../src/studio/ui/world-view.mjs';

const cid = 'c-' + 'a'.repeat(40);
const pid = 'p-11111111-1111-4111-8111-111111111111';
const oid = 'o-22222222-2222-4222-8222-222222222222';
const sid = 's-33333333-3333-4333-8333-333333333333';
const newPid = 'p-44444444-4444-4444-8444-444444444444';

class TextNode {
  constructor(text) { this.data = String(text); }
}
class Node {
  constructor(tag = 'div') {
    Object.assign(this, { tag, id: '', children: [], attrs: {}, listeners: {}, hidden: false,
      disabled: false, checked: false, className: '', value: '', files: [] });
  }
  append(...children) { this.children.push(...children.filter((c) => c != null)); }
  replaceChildren(...children) { this.children = children.filter((c) => c != null); }
  setAttribute(key, value) { this.attrs[key] = String(value); }
  getAttribute(key) { return this.attrs[key] ?? null; }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  set textContent(value) { this.children = value == null || value === '' ? [] : [new TextNode(value)]; }
  get textContent() { return this.children.map((c) => c instanceof TextNode ? c.data : c.textContent ?? '').join(''); }
  focus() { this.focused = true; }
  scrollIntoView() { this.scrolled = true; }
  async click() { if (!this.disabled) for (const fn of this.listeners.click ?? []) await fn({ preventDefault() {} }); }
  async dispatch(type) { for (const fn of this.listeners[type] ?? []) await fn({ preventDefault() {} }); }
}
function collect(node, fn) {
  if (!node || node instanceof TextNode) return [];
  return [...(fn(node) ? [node] : []), ...(node.children ?? []).flatMap((c) => collect(c, fn))];
}
const findId = (node, id) => collect(node, (e) => e.id === id)[0] ?? null;
const answer = (status, data) => ({ status, json: async () => data });
const page = (items) => ({ items, total: items.length, offset: 0, limit: 50, nextOffset: null });

const paragraph = { type: 'paragraph', text: 'Read this reference.',
  inline: [
    { t: 'text', text: 'Read this ' },
    { t: 'citation', text: 'reference', href: 'https://example.org/article' },
    { t: 'link', text: 'bad', href: 'javascript:alert(1)' },
  ] };
const project = () => ({ id: pid, kind: 'project', version: 1, title: 'Research',
  conversationIds: [], noteIds: [], memberIds: [] });
function mount({ failStage = '' } = {}) {
  const calls = [];
  let savedProject = project(), conflictSeen = false, selectionReads = 0;
  const fetchImpl = async (url, init = {}) => {
    const path = String(url).replace('/api/v1/world', '');
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ path, method: init.method ?? 'GET', body });
    if (path === '/namespace') return answer(200, { id: 'w-local', kind: 'namespace' });
    if (path.startsWith('/conversations?')) return answer(200, page([{ id: cid, title: 'Saved work', custody: 'observed' }]));
    if (path.startsWith('/projects?')) return answer(200, page([savedProject]));
    if (path.startsWith('/notes?') || path.startsWith('/objects?') || path.startsWith('/selections?')) return answer(200, page([]));
    if (path === '/conversations/' + cid) return answer(200, {
      id: cid, title: 'Saved work', custody: 'observed',
      coverage: { state: 'partial', fullNativeThread: 'unknown', richContent: 'as-recorded' },
      messages: [{ role: 'assistant', text: 'Read this reference.', blocks: [paragraph],
        truncated: true, truncatedOriginalLength: 170000, source: { key: 'DOM_TURNS', index: 0 } }],
    });
    if (path.startsWith('/search?')) return answer(200, {
      items: [{ kind: 'selection', id: sid, title: 'Saved selection', snippet: 'recorded part' }],
      total: 1, offset: 0, limit: 50, nextOffset: null, coverage: { complete: true, truncated: false, reasons: [], failures: [] },
    });
    if (path === '/selections/' + sid) {
      selectionReads++;
      return answer(200, {
      id: sid, kind: 'selection', objectId: oid, selectionType: 'part',
        availability: failStage === 'stale' || (failStage === 'driftOnJump' && selectionReads > 1) ? 'stale' : 'locally-available',
        source: { messageIndex: 0, partPath: [0], revision: 'known-snapshot-fingerprint' },
      });
    }
    if (path === '/objects/' + oid) return answer(200, {
      id: oid, kind: 'source-reference', conversationId: cid, availability: 'locally-available',
    });
    if (path === '/projects' && init.method === 'POST') {
      savedProject = { ...project(), id: newPid, title: body.title };
      return answer(200, savedProject);
    }
    if (path === '/projects/' + savedProject.id && (init.method ?? 'GET') === 'GET') return answer(200, savedProject);
    if (path === '/objects' && init.method === 'POST') return failStage === 'object'
      ? answer(503, { code: 'ERROR' }) : answer(200, { id: oid, version: 1, kind: 'source-reference', conversationId: cid });
    if (path === '/selections' && init.method === 'POST') return failStage === 'selection'
      ? answer(400, { code: 'INVALID' }) : answer(200, { id: sid, version: 1, kind: 'selection', objectId: oid, source: { partPath: body.partPath, messageIndex: body.messageIndex } });
    if (path === '/projects/' + savedProject.id && init.method === 'PUT') {
      if (failStage === 'project') return answer(409, { code: 'CAS_VERSION_CONFLICT', expected: 1, actual: 2 });
      if (failStage === 'projectOnce' && !conflictSeen) {
        conflictSeen = true;
        savedProject = { ...savedProject, version: 2 };
        return answer(409, { code: 'CAS_VERSION_CONFLICT', expected: 1, actual: 2 });
      }
      if (failStage === 'projectAlready' && !conflictSeen) {
        conflictSeen = true;
        savedProject = { ...savedProject, ...body, version: 2 };
        return answer(503, { code: 'AMBIGUOUS_RESPONSE' });
      }
      savedProject = { ...savedProject, ...body, version: savedProject.version + 1 };
      return answer(200, savedProject);
    }
    return answer(404, { code: 'WORLD_NOT_FOUND' });
  };
  const doc = { createElement: (tag) => new Node(tag), createTextNode: (text) => new TextNode(text) };
  const root = new Node('section'), modes = new Node('nav');
  for (const view of ['capture', 'conversations', 'projects', 'notes', 'find', 'transfer', 'workspace']) {
    const btn = new Node('button'); btn.setAttribute('data-view', view); modes.append(btn);
  }
  modes.querySelectorAll = (q) => q === '[data-view]' ? modes.children : [];
  const controller = mountWorldView({ document: doc, root, modes, chat: new Node(),
    fetchImpl, storage: { getItem: () => null, setItem() {} }, announce() {} });
  return { root, calls, controller };
}
async function openSaved(root, controller) {
  await controller.choose('conversations');
  const buttons = collect(findId(root, 'worldItems'), (x) => x.tag === 'button');
  assert.ok(buttons.length);
  await buttons[0].click();
  assert.ok(findId(root, 'worldSelectionProject'), 'project picker exists in reading pane');
}
test('R4: saved inline semantics remain source-qualified; unsafe URLs are inert; exact truncation length visible', () => {
  const links = savedInlineLinks(paragraph);
  assert.deepEqual(links.map((link) => [link.kind, link.href]),
    [['citation', 'https://example.org/article'], ['link', null]]);
  assert.equal(savedInlineLinks({ type: 'future-native', inline: paragraph.inline }).length, 0);
  assert.equal(turnPlan({ blocks: [paragraph], truncated: true, truncatedOriginalLength: 170000 }).truncatedOriginalLength, 170000);
});
test('R5: save visible part using exact existing object→selection→project CAS APIs', async () => {
  const { root, calls, controller } = mount();
  await openSaved(root, controller);
  const picker = findId(root, 'worldSelectionProject');
  picker.value = pid; await picker.dispatch('change');
  assert.match(root.textContent, /Original text length observed before truncation: 170000/);
  const refs = collect(root, (x) => x.tag === 'a');
  assert.ok(refs.some((x) => x.getAttribute('href') === 'https://example.org/article'));
  assert.equal(refs.some((x) => String(x.getAttribute('href')).startsWith('javascript:')), false);
  await findId(root, 'worldSavePart-0-0').click();
  assert.deepEqual(calls.filter((c) => c.method === 'POST').map((c) => c.path), ['/objects', '/selections']);
  const source = calls.find((c) => c.path === '/objects' && c.method === 'POST');
  const part = calls.find((c) => c.path === '/selections' && c.method === 'POST');
  const put = calls.find((c) => c.method === 'PUT');
  assert.deepEqual(source.body, { conversationId: cid, expectedVersion: null });
  assert.deepEqual(part.body, { objectId: oid, selectionType: 'part', messageIndex: 0, partPath: [0], expectedVersion: null });
  assert.equal(put.path, '/projects/' + pid);
  assert.deepEqual(put.body.memberIds, [oid, sid]);
  assert.deepEqual(put.body.conversationIds, [cid]);
  assert.equal(put.body.expectedVersion, 1);
  assert.match(findId(root, 'worldSelectionStatus').textContent, /Saved this recorded part/);
  await findId(root, 'worldSavePart-0-0').click();
  assert.equal(calls.filter((c) => c.path === '/objects' && c.method === 'POST').length, 1, 'no accidental repeated write in this tab');
});
test('R6: failed project CAS never claims complete save or auto-retries a side effect', async () => {
  const { root, calls, controller } = mount({ failStage: 'project' });
  await openSaved(root, controller);
  const picker = findId(root, 'worldSelectionProject');
  picker.value = pid; await picker.dispatch('change');
  await findId(root, 'worldSaveMessage-0').click();
  const notice = findId(root, 'worldSelectionStatus').textContent;
  assert.match(notice, /project link was NOT confirmed/);
  assert.match(notice, /Selection s-/);
  assert.doesNotMatch(notice, /^Saved this recorded/);
  assert.equal(calls.filter((c) => c.method === 'PUT').length, 1, 'CAS failure cannot silently retry');
  const selection = calls.find((c) => c.path === '/selections');
  assert.deepEqual(selection.body.partPath, []);
  assert.equal(selection.body.selectionType, 'message');
});
test('R6: failed selection stage discloses orphan source reference without project mutation', async () => {
  const { root, calls, controller } = mount({ failStage: 'selection' });
  await openSaved(root, controller);
  const picker = findId(root, 'worldSelectionProject');
  picker.value = pid; await picker.dispatch('change');
  await findId(root, 'worldSavePart-0-0').click();
  assert.match(findId(root, 'worldSelectionStatus').textContent, /Source reference o-/);
  assert.match(findId(root, 'worldSelectionStatus').textContent, /NOT confirmed/);
  assert.equal(calls.some((c) => c.method === 'PUT'), false);
});


test('R5: a Find selection record follows its object back to the exact saved part', async () => {
  const { root, calls, controller } = mount();
  await controller.choose('find');
  const query = findId(root, 'worldFindQuery');
  query.value = 'recorded';
  await query.dispatch('input');
  await findId(root, 'worldFindSubmit').click();
  const found = collect(root, (x) => x.tag === 'button' && x.getAttribute('aria-label') === 'Open selection ' + sid)[0];
  assert.ok(found, 'Find result for source-qualified selection exists');
  await found.click();
  const jump = findId(root, 'worldSourceJump-' + sid);
  assert.ok(jump, 'reference detail has an actionable original-source path');
  await jump.click();
  assert.equal(controller.view(), 'conversations');
  const frame = collect(root, (x) => x.getAttribute('data-part-path') === '0')[0];
  assert.ok(frame, 'opened exact recorded part');
  assert.equal(frame.getAttribute('aria-current'), 'true');
  assert.equal(calls.some((c) => c.path === '/objects/' + oid), true);
  assert.equal(calls.some((c) => c.path === '/conversations/' + cid), true);
});
test('R5/R6: a stale source selection cannot open another conversation or pretend it resolved', async () => {
  const { root, calls, controller } = mount({ failStage: 'stale' });
  await controller.choose('find');
  const query = findId(root, 'worldFindQuery'); query.value = 'recorded'; await query.dispatch('input');
  await findId(root, 'worldFindSubmit').click();
  const btn = collect(root, (x) => x.tag === 'button' && x.getAttribute('aria-label') === 'Open selection ' + sid)[0];
  await btn.click();
  // Direct source-return control is conservatively disabled on explicit stale status;
  // unknown content cannot become an arbitrarily selected provider conversation.
  const jump = findId(root, 'worldSourceJump-' + sid);
  assert.ok(jump);
  assert.equal(jump.disabled, true, 'stale pointer cannot navigate');
  await jump.click();
  assert.equal(calls.filter((c) => c.path === '/objects/' + oid).length, 0);
  assert.equal(calls.filter((c) => c.path === '/conversations/' + cid).length, 0);
});

test('R5 leapfrog: create and select a new project inside Saved, preserving open conversation context', async () => {
  const { root, calls, controller } = mount();
  await openSaved(root, controller);
  const title = findId(root, 'worldSelectionNewTitle');
  title.value = 'Native references';
  await title.dispatch('input');
  await findId(root, 'worldSelectionNewProject').click();
  assert.equal(controller.view(), 'conversations', 'project creation never abandons the saved reader');
  assert.ok(findId(root, 'worldSavePart-0-0'));
  assert.equal(findId(root, 'worldSelectionProject').value, newPid);
  assert.equal(calls.find((c) => c.path === '/projects' && c.method === 'POST').body.title, 'Native references');
  await findId(root, 'worldSavePart-0-0').click();
  const put = calls.filter((c) => c.path === '/projects/' + newPid && c.method === 'PUT')[0];
  assert.ok(put);
  assert.deepEqual(put.body.memberIds, [oid, sid]);
  assert.match(findId(root, 'worldSelectionStatus').textContent, /Saved this recorded part/);
});
test('R6 leapfrog: retry a CAS-conflicted project link with the SAME confirmed selection, never duplicate writes', async () => {
  const { root, calls, controller } = mount({ failStage: 'projectOnce' });
  await openSaved(root, controller);
  const picker = findId(root, 'worldSelectionProject'); picker.value = pid; await picker.dispatch('change');
  await findId(root, 'worldSavePart-0-0').click();
  assert.match(findId(root, 'worldSelectionStatus').textContent, /project link was NOT confirmed/);
  assert.ok(findId(root, 'worldFinishSelectionLink'), 'explicit recovery control available');
  await findId(root, 'worldFinishSelectionLink').click();
  assert.match(findId(root, 'worldSelectionStatus').textContent, /Existing saved selection linked/);
  assert.equal(calls.filter((c) => c.path === '/objects' && c.method === 'POST').length, 1);
  assert.equal(calls.filter((c) => c.path === '/selections' && c.method === 'POST').length, 1);
  assert.deepEqual(calls.filter((c) => c.path === '/projects/' + pid && c.method === 'PUT').map((c) => c.body.expectedVersion), [1, 2]);
  assert.equal(findId(root, 'worldFinishSelectionLink'), null, 'successful completion clears pending prompt');
});
test('R6 leapfrog: uncertain first project response rechecks already-applied links without any second PUT', async () => {
  const { root, calls, controller } = mount({ failStage: 'projectAlready' });
  await openSaved(root, controller);
  const picker = findId(root, 'worldSelectionProject'); picker.value = pid; await picker.dispatch('change');
  await findId(root, 'worldSaveMessage-0').click();
  assert.ok(findId(root, 'worldFinishSelectionLink'));
  await findId(root, 'worldFinishSelectionLink').click();
  assert.match(findId(root, 'worldSelectionStatus').textContent, /already linked/);
  assert.equal(calls.filter((c) => c.method === 'PUT').length, 1, 'no additional mutation on ambiguous already-saved result');
  assert.equal(calls.filter((c) => c.path === '/objects' && c.method === 'POST').length, 1);
  assert.equal(calls.filter((c) => c.path === '/selections' && c.method === 'POST').length, 1);
});
test('R6 leapfrog: a selection revised after Find listing is refused on fresh source-read', async () => {
  const { root, calls, controller } = mount({ failStage: 'driftOnJump' });
  await controller.choose('find');
  const q = findId(root, 'worldFindQuery'); q.value = 'recorded'; await q.dispatch('input');
  await findId(root, 'worldFindSubmit').click();
  const hit = collect(root, (x) => x.tag === 'button' && x.getAttribute('aria-label') === 'Open selection ' + sid)[0];
  assert.ok(hit);
  await hit.click();
  assert.equal(findId(root, 'worldSourceJump-' + sid).disabled, false, 'the first read was valid');
  await findId(root, 'worldSourceJump-' + sid).click();
  assert.equal(controller.view(), 'find');
  assert.match(findId(root, 'worldFindError').textContent, /stale, missing or unavailable/);
  assert.equal(calls.filter((c) => c.path === '/selections/' + sid).length, 2);
  assert.equal(calls.filter((c) => c.path === '/conversations/' + cid).length, 0);
});
