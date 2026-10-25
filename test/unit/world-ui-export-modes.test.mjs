// Export mode picker for the Transfer view. Synthetic DOM only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as ui from '../../src/studio/ui/chat.mjs';
import * as world from '../../src/studio/ui/world-view.mjs';

const html = readFileSync(new URL('../../src/studio/ui/chat.html', import.meta.url), 'utf8');
const cid = 'c-' + 'a'.repeat(40);
const oid = 'o-55555555-5555-4555-8555-555555555555';
const cid2 = 'c-' + 'b'.repeat(40);
const pid = 'p-11111111-1111-4111-8111-111111111111';
const sid = 's-44444444-4444-8444-4444-444444444444';

class Txt { constructor(data) { this.data = String(data); } }
class Node {
  constructor(tag = 'div') { Object.assign(this, { tag, id: '', children: [], attrs: {}, listeners: {}, hidden: false, disabled: false, checked: false, value: '', files: [], className: '' }); }
  append(...kids) { this.children.push(...kids.filter((kid) => kid != null)); }
  replaceChildren(...kids) { this.children = kids.filter((kid) => kid != null); }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  getAttribute(name) { return Object.hasOwn(this.attrs, name) ? this.attrs[name] : null; }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  set textContent(value) { this.children = value === '' || value == null ? [] : [new Txt(value)]; }
  get textContent() { return this.children.map((child) => (child instanceof Txt ? child.data : child.textContent ?? '')).join(''); }
  focus() {}
  async click() { if (this.disabled) { return 'disabled'; } for (const fn of this.listeners.click ?? []) await fn({ preventDefault() {} }); return 'clicked'; }
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
  for (const [view, label] of [['capture', 'Capture'], ['conversations', 'Saved conversations'], ['projects', 'Projects'], ['notes', 'Notes'], ['find', 'Find'], ['transfer', 'Transfer']]) {
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

function listStub(exportHandler) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const path = String(url).replace(/^.*\/api\/v1\/world/, '');
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ path, body });
    if (path.startsWith('/conversations?')) return answer(200, page([{ id: cid, title: 'Observed chat', status: 'complete', custody: 'observed', identity: { state: 'unknown' } }]));
    if (path.startsWith('/projects?')) return answer(200, page([{ id: pid, title: 'Bag', conversationIds: [], noteIds: [], memberIds: [] }]));
    if (path.startsWith('/notes?')) return answer(200, page([]));
    if (path.startsWith('/namespace')) return answer(200, { id: 'w-1', kind: 'namespace' });
    if (path === '/transfer/export') return exportHandler(body);
    return answer(404, { error: 'missing', code: 'WORLD_NOT_FOUND' });
  };
  return { fetchImpl, calls };
}

async function openExport(root, buttons, { pid_on = true } = {}) {
  await buttons.transfer.click();
  if (pid_on) {
    const box = byId(root, 'export-' + pid);
    box.checked = true;
    await box.dispatch('change');
  }
}

const fullBundle = (mode, parts, extra = {}) => ({
  schema: 'vivim.world-export/1',
  namespace: { id: 'w-1', kind: 'namespace' },
  scope: { ids: [pid], includeSources: mode !== 'references', mode, parts, dependencyClosure: 'outgoing-world-references' },
  records: [{ id: pid, kind: 'project', custody: 'user-overlay', data: {}, sha256: 'x' }],
  omitted: [],
  coverage: { complete: true, declaredScope: 'selected local records', mode, parts, modeSemantics: 'stored record content only; see scope.parts',
    providerCompleteness: 'not-established', qualification: 'Selected content is not automatically redacted.' },
  integrity: { algorithm: 'sha256', sha256: 'abc123abc123', purpose: 'integrity only; never object identity or provider verification' },
  ...extra,
});

test('the export mode choice replaces includeSources and always names the mode in the request', async () => {
  assert.match(html, /worldExportModes|data-view="transfer"/);
  assert.doesNotMatch(html, /worldIncludeSources/);
  const bundle = fullBundle('transcript', { reasoning: true, toolActivity: false });
  const { fetchImpl, calls } = listStub(() => answer(200, bundle));
  const { root, buttons } = mount(fetchImpl);
  await openExport(root, buttons);
  // Default is References only.
  assert.equal(byId(root, 'worldExportMode-references').checked, true);
  assert.equal(byId(root, 'worldIncludeSources'), null);
  await byId(root, 'worldExportPreview').click();
  let exported = calls.find((call) => call.path === '/transfer/export');
  assert.deepEqual(exported.body, { ids: [pid], mode: 'references' });
  assert.equal('includeSources' in exported.body, false);
  await flush();
  // Switch to Transcript and turn reasoning on.
  const radio = byId(root, 'worldExportMode-transcript');
  radio.checked = true;
  await radio.dispatch('change');
  const part = byId(root, 'worldExportPart-reasoning');
  part.checked = true;
  await part.dispatch('change');
  await byId(root, 'worldExportPreview').click();
  exported = calls.filter((call) => call.path === '/transfer/export').at(-1);
  assert.deepEqual(exported.body, { ids: [pid], mode: 'transcript', parts: { reasoning: true, toolActivity: false } });
  assert.equal(calls.some((call) => call.body && 'includeSources' in call.body), false, 'includeSources is never sent');
});

test('References only disables the part boxes with a reason; Transcript and Full saved enable them', async () => {
  const { fetchImpl } = listStub(() => answer(200, fullBundle('references', { reasoning: false, toolActivity: false })));
  const { root, buttons } = mount(fetchImpl);
  await openExport(root, buttons);
  const reasoning = byId(root, 'worldExportPart-reasoning');
  const activity = byId(root, 'worldExportPart-toolActivity');
  assert.equal(reasoning.disabled, true);
  assert.equal(activity.disabled, true);
  assert.match(root.textContent, /nothing to turn on here/);
  // A disabled toggle stays off: dispatching on the disabled control is ignored by the fixture.
  const bundle = fullBundle('transcript', { reasoning: false, toolActivity: false });
  const { fetchImpl: impl2, calls } = listStub(() => answer(200, bundle));
  const second = mount(impl2);
  await openExport(second.root, second.buttons);
  const radio = byId(second.root, 'worldExportMode-transcript');
  radio.checked = true;
  await radio.dispatch('change');
  assert.equal(byId(second.root, 'worldExportPart-reasoning').disabled, false);
  assert.equal(byId(second.root, 'worldExportPart-toolActivity').disabled, false);
  const activity2 = byId(second.root, 'worldExportPart-toolActivity');
  activity2.checked = true;
  await activity2.dispatch('change');
  await byId(second.root, 'worldExportPreview').click();
  const exported = calls.filter((call) => call.path === '/transfer/export').at(-1);
  assert.equal(exported.body.mode, 'transcript');
  assert.deepEqual(exported.body.parts, { reasoning: false, toolActivity: true });
});

test('the preview shows the mode and parts the server applied, per-reason omission counts and what completeness means', async () => {
  const bundle = fullBundle('transcript', { reasoning: true, toolActivity: false }, {
    records: [
      { id: cid, kind: 'conversation', custody: 'saved-observation', data: {}, sha256: 'x' },
      { id: pid, kind: 'project', custody: 'user-overlay', data: {}, sha256: 'y' },
    ],
    omitted: [
      { id: cid, reason: 'tool-activity-blocks-excluded', aspect: 'content', expected: true, count: 5 },
      { id: cid, reason: 'non-transcript-blocks-excluded', aspect: 'content', expected: true, count: 2 },
      { id: oid, reason: 'SELECTION_SOURCE_NOT_REQUESTED', aspect: 'record', expected: false },
    ],
    coverage: { complete: true, declaredScope: 'selected local records', mode: 'transcript',
      modeSemantics: 'stored record content only; see scope.parts and omitted for what the mode did not include',
      providerCompleteness: 'not-established', qualification: 'Selected content is not automatically redacted.' },
  });
  const { fetchImpl } = listStub(() => answer(200, bundle));
  const { root, buttons } = mount(fetchImpl);
  await openExport(root, buttons);
  const radio = byId(root, 'worldExportMode-transcript');
  radio.checked = true;
  await radio.dispatch('change');
  await byId(root, 'worldExportPreview').click();
  await flush();
  assert.match(root.textContent, /Export used this mode: Transcript/);
  assert.match(root.textContent, /Saved reasoning included: yes/);
  assert.match(root.textContent, /Tool and status activity included: no/);
  assert.match(root.textContent, /stored record content only; see scope\.parts/);
  assert.match(root.textContent, /Tool and status activity blocks left out: 5/);
  assert.match(root.textContent, /Blocks Studio does not recognize left out: 2/);
  assert.match(root.textContent, /SELECTION_SOURCE_NOT_REQUESTED/);
  assert.match(root.textContent, /calls its declared scope complete/);
  assert.doesNotMatch(root.textContent, /message text is in the file/, 'the references-only caveat must not appear for a transcript export');
  assert.match(root.textContent, /not automatically redacted/);
  assert.match(root.textContent, /did not mean to share/, 'reasoning parts on means stronger redaction wording');
  assert.match(root.textContent, /integrity only/);
});

test('changing the mode or a part box clears the preview, revokes the blob URL, and removes the download', async (t) => {
  const revoked = [];
  const originalRevoke = URL.revokeObjectURL;
  URL.revokeObjectURL = (url) => { revoked.push(String(url)); originalRevoke?.call(URL, url); };
  t.after(() => { URL.revokeObjectURL = originalRevoke; });
  const { fetchImpl } = listStub((body) => answer(200, fullBundle(body.mode, body.parts ?? { reasoning: false, toolActivity: false })));
  const { root, buttons } = mount(fetchImpl);
  await openExport(root, buttons);
  const radio = byId(root, 'worldExportMode-transcript');
  radio.checked = true;
  await radio.dispatch('change');
  await byId(root, 'worldExportPreview').click();
  await flush();
  assert.ok(byId(root, 'worldExportDownload'), 'a transcript bundle is downloadable after preview');
  const before = revoked.length;
  // Switching back to References clears the bundle and revokes the blob URL.
  const references = byId(root, 'worldExportMode-references');
  references.checked = true;
  await references.dispatch('change');
  assert.equal(byId(root, 'worldExportDownload'), null, 'no download can survive a different mode label');
  assert.equal(byId(root, 'worldExportPreviewOut').textContent, '');
  assert.ok(revoked.length > before, 'the old blob URL was revoked');
  // Toggling a part also clears an existing preview.
  const shared = listStub(() => answer(200, fullBundle('transcript', { reasoning: false, toolActivity: false })));
  const second = mount(shared.fetchImpl);
  await openExport(second.root, second.buttons);
  const radio2 = byId(second.root, 'worldExportMode-transcript');
  radio2.checked = true;
  await radio2.dispatch('change');
  await byId(second.root, 'worldExportPreview').click();
  await flush();
  const part = byId(second.root, 'worldExportPart-reasoning');
  part.checked = true;
  await part.dispatch('change');
  assert.equal(byId(second.root, 'worldExportDownload'), null);
  assert.equal(byId(second.root, 'worldExportPreviewOut').textContent, '');
});

test('a 400 export answer names the problem, keeps no bundle and no download', async () => {
  const { fetchImpl } = listStub(() => answer(400, { error: 'Expected 1..100 exact world IDs and optional boolean includeSources, export mode and parts flags', code: 'WORLD_EXPORT_INVALID_INPUT' }));
  const { root, buttons } = mount(fetchImpl);
  await openExport(root, buttons);
  await byId(root, 'worldExportPreview').click();
  await flush();
  assert.match(byId(root, 'worldExportError').textContent, /export mode and parts flags/);
  assert.equal(byId(root, 'worldExportPreviewOut').textContent, '');
  assert.equal(byId(root, 'worldExportDownload'), null);
  assert.equal(byId(root, 'worldTransferStatus').textContent, '', 'no success wording after a rejected request');
});
