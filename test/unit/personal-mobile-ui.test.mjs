// Browserless UI acceptance: real mobile renderer module, fake DOM + local service responses.
// This never uses Playwright/Puppeteer, Chrome, CDP or a provider account.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mountMobile, validateMobileScaffold } from '../../src/studio/ui/mobile.mjs';

const html = readFileSync(new URL('../../src/studio/ui/mobile.html', import.meta.url), 'utf8');
const id = 'app-' + 'a'.repeat(32);
const screens = [
  ['home', 'Home', 'home'], ['agent', 'My Agent', 'agent'],
  ['builder', 'Build', 'builder'], ['custom-notes', 'Private Notes', 'notes'],
  ['custom-tasks', 'My Tasks', 'tasks'], ['custom-dashboard', 'Insights', 'dashboard'],
].map(([key, label, kind]) => ({ key, label, kind }));
const scaffold = () => ({ version: 2, scaffold: {
  schema: 'vivim.personal-mobile-scaffold/1', appId: id, name: 'My AI World',
  screens, runnableCode: false, intelligence: { dispatch: 'disabled' },
  connection: { paired: false },
} });
class Node {
  constructor(tag) {
    Object.assign(this, { tag, children: [], attrs: {}, listeners: {}, className: '',
      value: '', disabled: false, type: '' });
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  addEventListener(k, fn) { (this.listeners[k] ??= []).push(fn); }
  append(...kids) { this.children.push(...kids); }
  replaceChildren(...kids) { this.children = kids; }
  set textContent(v) { this.children = [String(v)]; }
  get textContent() {
    return this.children.map(node => typeof node === 'string' ? node : node.textContent).join('');
  }
  async fire(type) {
    for (const fn of this.listeners[type] ?? []) await fn({ preventDefault() {} });
    await settle();
  }
  async click() { if (!this.disabled) await this.fire('click'); }
}
const all = (root, filter) => {
  const result = [];
  const walk = node => {
    if (!node || typeof node === 'string') return;
    if (filter(node)) result.push(node);
    for (const kid of node.children ?? []) walk(kid);
  };
  walk(root); return result;
};
const settle = () => new Promise(resolve => setImmediate(resolve));
const button = (root, label) => all(root, n => n.tag === 'button' && n.textContent === label)[0];
function fixture(search = '?app=' + id) {
  const calls = [], content = { schema: 'vivim.personal-app-content/1', appId: id,
    version: 0, items: [] };
  const state = { lost: false }, copy = value => structuredClone(value);
  const reply = (status, data) => ({ status, json: async () => data });
  const fetchImpl = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url, method: options.method ?? 'GET', body });
    if (url === '/api/v1/personal-apps') {
      return reply(200, { items: [{ id, title: 'My AI World', screenCount: screens.length }] });
    }
    if (url.endsWith('/scaffold')) return reply(200, scaffold());
    if (url.endsWith('/content') && !body) return reply(200, copy(content));
    if (url.endsWith('/content/items') && body) {
      const prior = content.items.find(item => item.key === body.idempotencyKey);
      if (prior) return reply(200, { item: prior, content: copy(content), replayed: true });
      if (body.expectedVersion !== content.version) return reply(409, { code: 'PERSONAL_APP_CONTENT_VERSION_CONFLICT' });
      const item = { id: 'item-' + String(content.items.length + 1).repeat(32),
        key: body.idempotencyKey, kind: body.kind, title: body.title,
        body: body.body ?? '', completed: false };
      content.items.push(item); content.version++;
      if (state.lost) { state.lost = false; return reply(503, { code: 'LOST_LOCAL_REPLY' }); }
      return reply(200, { item, content: copy(content), replayed: false });
    }
    if (url.endsWith('/completion') && body) {
      if (body.expectedVersion !== content.version) return reply(409, { code: 'PERSONAL_APP_CONTENT_VERSION_CONFLICT' });
      const item = content.items.find(row => url.includes(row.id));
      if (!item) return reply(404, { code: 'PERSONAL_APP_CONTENT_NOT_FOUND' });
      item.completed = body.completed; content.version++;
      return reply(200, { item, content: copy(content) });
    }
    return reply(404, { code: 'NOT_FOUND' });
  };
  const root = new Node('main'), doc = { createElement: tag => new Node(tag) };
  const mobile = mountMobile({ document: doc, root, search, fetchImpl,
    uuid: () => 'fixed-uuid-' + String(content.items.length).padStart(5, '0') });
  return { root, mobile, calls, content, state };
}
async function type(node, value) { node.value = value; await node.fire('input'); }

test('mobile HTML has responsive viewport and external same-origin module only', () => {
  assert.match(html, /name="viewport"/);
  assert.match(html, /src="\/ui\/mobile.mjs"/);
  assert.match(html, /id="mobileRoot"/);
  assert.doesNotMatch(html, /<iframe|<script[^>]*\bsrc="http/i);
});
test('unsafe app manifests and executable screen claims never reach the DOM', () => {
  const payload = scaffold();
  assert.equal(validateMobileScaffold(payload, id).appId, id);
  for (const value of [
    { ...payload, scaffold: { ...payload.scaffold, runnableCode: true } },
    { ...payload, scaffold: { ...payload.scaffold, connection: { paired: true } } },
    { ...payload, scaffold: { ...payload.scaffold, screens: [...screens, {
      key: 'custom-run', kind: 'script', label: 'Execute' }] } },
  ]) assert.throws(() => validateMobileScaffold(value, id));
  assert.throws(() => validateMobileScaffold(payload, 'app-' + 'b'.repeat(32)));
});
test('mobile view navigates original blueprint and truly persists local notes/tasks via owner API', async () => {
  const f = fixture(); await settle();
  assert.match(f.root.textContent, /My AI World/);
  assert.match(f.root.textContent, /PC-hosted and local only/);
  await button(f.root, 'Private Notes').click();
  assert.equal(f.mobile.state.content.version, 0);
  const noteForm = all(f.root, n => n.tag === 'form')[0];
  const noteTitle = all(noteForm, n => n.tag === 'input')[0];
  await type(noteTitle, 'Private <img onerror=attack()>');
  assert.equal(button(f.root, 'Save note locally').disabled, false);
  await type(all(noteForm, n => n.tag === 'textarea')[0], 'My own text');
  await noteForm.fire('submit');
  assert.equal(f.content.version, 1);
  assert.equal(f.content.items[0].kind, 'note');
  assert.match(f.root.textContent, /Private <img onerror=attack\(\)>/);
  assert.equal(all(f.root, node => node.tag === 'img').length, 0);
  await button(f.root, 'My Tasks').click();
  const taskForm = all(f.root, n => n.tag === 'form')[0];
  await type(all(taskForm, n => n.tag === 'input')[0], 'Finish VIVIM mobile');
  await taskForm.fire('submit');
  assert.equal(f.content.version, 2);
  await button(f.root, 'Mark done').click();
  assert.equal(f.content.version, 3);
  assert.equal(f.content.items[1].completed, true);
  await button(f.root, 'Insights').click();
  assert.match(f.root.textContent, /Notes: 1/);
  assert.match(f.root.textContent, /Tasks completed: 1/);
  assert.equal(f.calls.some(call => /chatgpt\.com|claude\.ai|api\.openai/.test(call.url)), false);
  assert.ok(f.calls.every(call => call.url.startsWith('/api/v1/personal-apps')));
});
test('lost local response reuses a stable key, retains draft, and never auto-resends', async () => {
  const f = fixture(); await settle();
  await button(f.root, 'My Tasks').click();
  const form = all(f.root, n => n.tag === 'form')[0];
  await type(all(form, n => n.tag === 'input')[0], 'Once only');
  f.state.lost = true;
  await form.fire('submit');
  assert.equal(f.content.items.length, 1);
  assert.match(f.root.textContent, /LOST_LOCAL_REPLY/);
  assert.equal(f.mobile.state.draftTitle, 'Once only');
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
  await all(f.root, n => n.tag === 'form')[0].fire('submit');
  assert.equal(f.content.items.length, 1);
  assert.equal(f.mobile.state.draftTitle, '');
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 2);
  const keys = f.calls.filter(call => call.method === 'POST').map(call => call.body.idempotencyKey);
  assert.deepEqual(keys, [keys[0], keys[0]]);
});
test('invalid app id triggers no API read, and library selection loads a legitimate app', async () => {
  const invalid = fixture('?app=../../secrets');
  await settle();
  assert.equal(invalid.calls.length, 0);
  assert.match(invalid.root.textContent, /Invalid local app reference/);
  const library = fixture('');
  await settle();
  assert.equal(library.calls.length, 1);
  await button(library.root, 'My AI World · 6 screens').click();
  assert.equal(library.mobile.state.scaffold.appId, id);
});
