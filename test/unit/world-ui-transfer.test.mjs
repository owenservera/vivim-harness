// Transfer view and imported-custody labels. Synthetic DOM only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as ui from '../../src/studio/ui/chat.mjs';
import * as world from '../../src/studio/ui/world-view.mjs';

const html = readFileSync(new URL('../../src/studio/ui/chat.html', import.meta.url), 'utf8');
const cid = 'c-' + 'a'.repeat(40);
const importedId = 'c-i' + 'b'.repeat(38);
const pid = 'p-11111111-1111-4111-8111-111111111111';

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
  async click() { if (this.disabled) return; for (const fn of this.listeners.click ?? []) await fn({ preventDefault() {} }); }
  async dispatch(type, event = {}) { for (const fn of this.listeners[type] ?? []) await fn({ preventDefault() {}, ...event }); }
}
const walk = (node, fn) => { if (!node || node instanceof Txt) return; fn(node); for (const child of node.children ?? []) walk(child, fn); };
const all = (root, pred) => { const out = []; walk(root, (node) => { if (pred(node)) out.push(node); }); return out; };
const byId = (root, id) => all(root, (node) => node.id === id)[0] ?? null;
const answer = (status, data) => ({ status, json: async () => data });
const page = (items) => ({ items, total: items.length, offset: 0, limit: 50, nextOffset: null });

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

test('transfer is a peer view and does not treat a partial restore as success', () => {
  assert.match(html, /data-view="transfer"/);
  assert.match(html, /Local edits do not change provider content/);
  assert.doesNotMatch(html, /data-view="home"/);
  assert.equal(world.IMPORT_BYTE_CAP, 8 * 1024 * 1024);
  assert.equal(world.restoreSummary({ dryRun: true, pending: ['a'], applied: [], skipped: [], failed: [] }).success, false);
  assert.equal(world.restoreSummary({ dryRun: false, valid: true, partial: false, applied: [], skipped: ['a'], failed: [], pending: [], receipt: 'i-1' }).success, false);
  assert.equal(world.isExportBundle({ ok: true }), false);
  assert.match(world.restoreSummary({ dryRun: false, valid: true, partial: true, applied: ['a'], skipped: [], failed: [], pending: [], receipt: 'i-1' }).text, /partial/);
  assert.equal(world.restoreSummary({ dryRun: false, valid: true, partial: true, applied: ['a'], skipped: [], failed: [], pending: [], receipt: 'i-1' }).success, false);
  assert.match(world.coverageView({ state: 'imported-snapshot', fullNativeThread: 'unknown', richContent: 'imported-as-supplied' }).sentence, /not a recording/);
  assert.deepEqual(world.custodyChip({ custody: 'imported-snapshot' }), ['Imported snapshot', 't-warn']);
});

test('export preview can be downloaded, import waits for a check, and imported rows stay labeled', async () => {
  const calls = [];
  const bundle = { schema: 'vivim.world-export/1', records: [{ id: pid, kind: 'project', custody: 'user-overlay' }], omitted: [{ id: cid, reason: 'SOURCES_NOT_REQUESTED' }], coverage: { complete: false, qualification: 'Selected content is not automatically redacted.' }, integrity: { sha256: 'abc123abc123', purpose: 'integrity only' } };
  const checked = { valid: true, digest: 'abc123abc123abcd', counts: { records: 1, unresolved: 1, omitted: 1, errors: 0 }, idMap: { [pid]: 'p-new' }, unresolved: [{ id: 'n-missing', reason: 'NOT_IN_BUNDLE' }], omitted: [{ id: cid, reason: 'SOURCES_NOT_REQUESTED' }], errors: [], extraNote: 'kept-detail' };
  const fetchImpl = async (url, init = {}) => {
    const path = String(url).replace(/^.*\/api\/v1\/world/, '');
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ path, body });
    if (path.startsWith('/conversations?')) {
      const custody = new URL(path, 'http://studio.local').searchParams.get('custody');
      if (custody === 'imported') return answer(200, page([{ id: importedId, title: 'Brought in', status: 'imported', custody: 'imported', importedFrom: { digest: 'abc123abc123abcd', originalId: cid }, identity: { state: 'unknown' } }]));
      return answer(200, page([{ id: cid, title: 'Observed chat', status: 'complete', custody: 'observed', identity: { state: 'unknown' } }]));
    }
    if (path.startsWith('/projects?')) return answer(200, page([{ id: pid, title: 'Bag', conversationIds: [], noteIds: [], memberIds: [] }]));
    if (path.startsWith('/namespace')) return answer(200, { id: 'w-1', kind: 'namespace' });
    if (path.startsWith('/notes?')) return answer(200, page([]));
    if (path === '/transfer/export') return answer(200, bundle);
    if (path === '/transfer/validate') return answer(200, checked);
    if (path === '/transfer/restore' && body.dryRun === true) return answer(200, { valid: true, digest: checked.digest, dryRun: true, applied: [], skipped: [], failed: [], pending: [pid], partial: false, receipt: null });
    if (path === '/transfer/restore') return answer(200, { valid: true, digest: checked.digest, dryRun: false, applied: [], skipped: [], failed: [{ id: pid, message: 'stopped' }], pending: [pid], partial: true, receipt: null });
    if (path === '/conversations/' + importedId) return answer(200, { id: importedId, title: 'Brought in', status: 'imported', custody: 'imported', importedFrom: { digest: 'abc123abc123abcd', originalId: cid }, identity: { nativeThreadId: null, accountId: null, state: 'unknown' }, source: { kind: 'imported-reference', sessionId: null, originSessionId: 'origin-session' }, messages: [], coverage: { state: 'imported-snapshot', fullNativeThread: 'unknown', richContent: 'imported-as-supplied' } });
    if (path.startsWith('/search?')) return answer(200, { items: [{ id: importedId, kind: 'message', title: 'imported message', snippet: 'hello', score: 1, custody: 'imported-snapshot', source: { index: 0 }, conversation: { id: importedId } }], total: 1, offset: 0, limit: 50, nextOffset: null, coverage: { complete: true, truncated: false, reasons: [], failures: [], absent: { conversations: 0 }, qualification: 'scan only' } });
    return answer(404, { error: 'missing', code: 'WORLD_NOT_FOUND' });
  };
  const { root, buttons } = mount(fetchImpl);
  await buttons.transfer.click();
  assert.equal(byId(root, 'worldImportDry').disabled, true);
  assert.equal(byId(root, 'worldImportRestore').disabled, true);
  const box = byId(root, 'export-' + pid);
  box.checked = true;
  await box.dispatch('change');
  await byId(root, 'worldExportPreview').click();
  const exported = calls.find((call) => call.path === '/transfer/export');
  assert.deepEqual(exported.body, { ids: [pid], includeSources: false });
  assert.match(root.textContent, /user-overlay/);
  assert.match(root.textContent, /SOURCES_NOT_REQUESTED/);
  assert.match(root.textContent, /not automatically redacted/i);
  assert.match(root.textContent, /does not mean message text is in the file/);
  const link = byId(root, 'worldExportDownload');
  assert.equal(link.getAttribute('download'), 'vivim-world.json');
  assert.match(link.getAttribute('href'), /^blob:/);

  const pasted = JSON.stringify({ schema: 'vivim.world-export/1' });
  byId(root, 'worldImportText').value = pasted;
  await byId(root, 'worldImportText').dispatch('input');
  await byId(root, 'worldImportCheck').click();
  assert.equal(calls.some((call) => call.path === '/transfer/restore'), false);
  assert.match(root.textContent, /kept-detail/);
  assert.match(root.textContent, /NOT_IN_BUNDLE/);
  assert.equal(byId(root, 'worldImportRestore').disabled, true);
  await byId(root, 'worldImportDry').click();
  assert.equal(calls.filter((call) => call.path === '/transfer/restore').at(-1).body.dryRun, true);
  assert.match(root.textContent, /Dry run only/);
  const writesBeforeConfirm = calls.filter((call) => call.path === '/transfer/restore' && call.body?.dryRun === false).length;
  await byId(root, 'worldImportRestore').click();
  assert.equal(calls.filter((call) => call.path === '/transfer/restore' && call.body?.dryRun === false).length, writesBeforeConfirm);
  byId(root, 'worldImportConfirm').checked = true;
  await byId(root, 'worldImportConfirm').dispatch('change');
  await byId(root, 'worldImportRestore').click();
  const wrote = calls.filter((call) => call.path === '/transfer/restore').at(-1).body;
  assert.equal(wrote.dryRun, false);
  assert.equal(wrote.confirm, true);
  assert.equal(wrote.digest, checked.digest);
  assert.match(root.textContent, /partial/);
  assert.doesNotMatch(byId(root, 'worldTransferStatus').textContent, /Restore finished/);

  byId(root, 'worldImportText').value = pasted + ' ';
  await byId(root, 'worldImportText').dispatch('input');
  assert.doesNotMatch(root.textContent, /Check passed/);
  assert.equal(byId(root, 'worldImportDry').disabled, true);
  const before = calls.filter((call) => call.path === '/transfer/restore').length;
  await byId(root, 'worldImportDry').click();
  assert.equal(calls.filter((call) => call.path === '/transfer/restore').length, before);
  await buttons.conversations.click();
  assert.match(calls.find((call) => call.path.startsWith('/conversations?')).path, /custody=observed/);
  byId(root, 'worldCustody').value = 'imported';
  await byId(root, 'worldCustody').dispatch('change');
  assert.match(calls.filter((call) => call.path.startsWith('/conversations?')).at(-1).path, /custody=imported/);
  assert.match(root.textContent, /Imported snapshot/);
  await all(root, (node) => node.tag === 'button' && node.textContent.includes('Brought in'))[0].click();
  assert.equal(all(root, (node) => node.className?.includes('pill') && node.textContent === 'Imported snapshot').length, 1);
  assert.match(root.textContent, /origin-session/);
  assert.match(root.textContent, /not a recording Studio observed/);
  assert.match(root.textContent, /abc123abc123/);
  assert.match(root.textContent, new RegExp(cid));

  await buttons.find.click();
  byId(root, 'worldFindQuery').value = 'hello';
  await byId(root, 'worldFindQuery').dispatch('input');
  await byId(root, 'worldFindSubmit').click();
  assert.match(root.textContent, /Imported snapshot/);
  assert.equal(calls.some((call) => call.path.includes('/map')), false);
});

test('a finished restore must be checked again, a skipped write is not success, and a huge file clears the check', async () => {
  const calls = [];
  const checked = { valid: true, digest: 'fff123fff123ffff', counts: { records: 1, unresolved: 0, omitted: 0, errors: 0 }, idMap: {}, unresolved: [], omitted: [], errors: [] };
  let writes = 0;
  const fetchImpl = async (url, init = {}) => {
    const path = String(url).replace(/^.*\/api\/v1\/world/, '');
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ path, body });
    if (path.startsWith('/conversations?')) return answer(200, page([]));
    if (path.startsWith('/projects?')) return answer(200, page([{ id: pid, title: 'Bag', conversationIds: [], noteIds: [], memberIds: [] }]));
    if (path.startsWith('/notes?') || path.startsWith('/namespace')) return answer(200, path.startsWith('/namespace') ? { id: 'w-1', kind: 'namespace' } : page([]));
    if (path === '/transfer/validate') return answer(200, checked);
    if (path === '/transfer/restore' && body?.dryRun === true) return answer(200, { valid: true, digest: checked.digest, dryRun: true, applied: [], skipped: [], failed: [], pending: [pid], partial: false, receipt: null });
    if (path === '/transfer/restore' && writes === 0) { writes += 1; return answer(200, { valid: true, digest: checked.digest, dryRun: false, applied: [], skipped: [pid], failed: [], pending: [], partial: false, receipt: 'i-skip' }); }
    if (path === '/transfer/restore') { writes += 1; return answer(200, { valid: true, digest: checked.digest, dryRun: false, applied: [pid], skipped: [], failed: [], pending: [], partial: false, receipt: 'i-done' }); }
    if (path === '/transfer/export') return answer(200, { ok: true });
    return answer(404, { error: 'missing', code: 'WORLD_NOT_FOUND' });
  };
  const { root, buttons } = mount(fetchImpl);
  await buttons.transfer.click();
  const box = byId(root, 'export-' + pid);
  box.checked = true;
  await box.dispatch('change');
  await byId(root, 'worldExportPreview').click();
  assert.equal(byId(root, 'worldExportDownload'), null);
  assert.match(root.textContent, /did not return an export bundle/);

  const pasted = JSON.stringify({ schema: 'vivim.world-export/1' });
  byId(root, 'worldImportText').value = pasted;
  await byId(root, 'worldImportText').dispatch('input');
  await byId(root, 'worldImportCheck').click();
  await byId(root, 'worldImportDry').click();
  byId(root, 'worldImportConfirm').checked = true;
  await byId(root, 'worldImportConfirm').dispatch('change');
  await byId(root, 'worldImportRestore').click();
  assert.match(root.textContent, /Nothing new was written/);
  assert.doesNotMatch(root.textContent, /Restore finished/);
  assert.equal(byId(root, 'worldImportRestore').disabled, false);

  await byId(root, 'worldImportCheck').click();
  await byId(root, 'worldImportDry').click();
  byId(root, 'worldImportConfirm').checked = true;
  await byId(root, 'worldImportConfirm').dispatch('change');
  await byId(root, 'worldImportRestore').click();
  assert.match(root.textContent, /Restore finished/);
  assert.match(root.textContent, /i-done/);
  assert.equal(byId(root, 'worldImportRestore').disabled, true);
  assert.equal(byId(root, 'worldImportDry').disabled, true);
  const doneWrites = calls.filter((call) => call.path === '/transfer/restore' && call.body?.dryRun === false).length;
  await byId(root, 'worldImportRestore').click();
  assert.equal(calls.filter((call) => call.path === '/transfer/restore' && call.body?.dryRun === false).length, doneWrites);

  byId(root, 'worldImportText').value = pasted;
  await byId(root, 'worldImportText').dispatch('input');
  await byId(root, 'worldImportCheck').click();
  assert.match(root.textContent, /Check passed/);
  const file = byId(root, 'worldImportFile');
  file.files = [{ size: world.IMPORT_BYTE_CAP + 1 }];
  await file.dispatch('change');
  assert.equal(byId(root, 'worldImportText').value, '');
  assert.doesNotMatch(root.textContent, /Check passed/);
  assert.match(root.textContent, /larger than 8 MB/);
  assert.equal(byId(root, 'worldImportDry').disabled, true);
});
