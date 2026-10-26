// R5/Q04: actual Studio HTTP-produced partPath through the one saved-world UI controller.
// Evidence: T2 loopback HTTP + T1 synthetic DOM; NOT a real browser, OS-process restart or provider.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Session } from '../../src/store/session.mjs';
import { dataPaths, ensureDataDirs } from '../../src/config.mjs';
import { startStudio } from '../../src/studio/server.mjs';
import { ProfileStore } from '../../src/profiles/profiles.mjs';
import { mountWorldView } from '../../src/studio/ui/world-view.mjs';

class Txt { constructor(s) { this.data = String(s); } }
class Node {
  constructor(tag = 'div') { Object.assign(this, { tag, id: '', children: [], attrs: {}, listeners: {}, className: '', hidden: false,
    disabled: false, checked: false, value: '' }); }
  append(...kids) { this.children.push(...kids.filter((x) => x != null)); }
  replaceChildren(...kids) { this.children = kids.filter((x) => x != null); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  set textContent(t) { this.children = t ? [new Txt(t)] : []; }
  get textContent() { return this.children.map((n) => n instanceof Txt ? n.data : n.textContent ?? '').join(''); }
  focus() { this.focused = true; }
  scrollIntoView() { this.scrolled = true; }
  async click() { if (!this.disabled) for (const fn of this.listeners.click ?? []) await fn({ preventDefault() {} }); }
  async dispatch(type) { for (const fn of this.listeners[type] ?? []) await fn({ preventDefault() {} }); }
}
const all = (root, pred) => root instanceof Txt ? [] : [...(pred(root) ? [root] : []), ...root.children.flatMap((x) => all(x, pred))];
const byId = (root, id) => all(root, (x) => x.id === id)[0] ?? null;

async function fixture(t) {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'world-r456-http-ui-'));
  // A single ordered cleanup keeps the ephemeral test root available until the Studio listener closes.
  const paths = dataPaths(rootDir);
  ensureDataDirs(paths);
  const session = Session.create(paths.sessions, { site: 'fixture' });
  session.meta.status = 'complete'; session.saveMeta();
  session.kv.set('DOM_TURNS', [
    { id: 'turn-source-1', role: 'assistant', text: 'The message itself does not include the exact block token.',
      blocks: [{ type: 'code', language: 'text', text: 'uniquer456needle' }, { type: 'paragraph', text: 'sharedr456term' }] },
    { id: 'turn-source-2', role: 'assistant', text: 'Another message, no native account claim',
      blocks: [{ type: 'paragraph', text: 'sharedr456term' }, { type: 'paragraph', text: 'sharedr456term' }] },
  ]);
  const runtime = { isSessionActive: () => false, close: async () => {}, list: async () => [] };
  const studio = await startStudio({ paths, profileStore: new ProfileStore(paths.profiles), port: 0, conversationRuntime: runtime });
  t.after(async () => { try { await studio.close(); } finally { rmSync(rootDir, { recursive: true, force: true }); } });
  const base = 'http://127.0.0.1:' + studio.port;
  const fetchImpl = (url, opts = {}) => fetch(base + url, opts);
  const doc = { createElement: (tag) => new Node(tag), createTextNode: (text) => new Txt(text) };
  const root = new Node('section'), nav = new Node('nav');
  for (const kind of ['capture','conversations','projects','notes','find']) {
    const n = new Node('button'); n.setAttribute('data-view', kind); nav.append(n);
  }
  nav.querySelectorAll = () => nav.children;
  const controller = mountWorldView({ document: doc, root, modes: nav, chat: new Node(), fetchImpl,
    storage: { getItem: () => null, setItem() {} }, announce() {} });
  const first = await fetch(base + '/api/v1/world/conversations');
  assert.equal(first.status, 200);
  const listing = await first.json();
  assert.equal(listing.items.length, 1);
  return { root, controller, base, cid: listing.items[0].id };
}
async function find(root, controller, text) {
  await controller.choose('find');
  const q = byId(root, 'worldFindQuery'); q.value = text; await q.dispatch('input');
  await byId(root, 'worldFindSubmit').click();
  return all(root, (n) => n.tag === 'button' && (n.getAttribute('aria-label') ?? '').startsWith('Open message '))[0];
}

test('HTTP search partPath produced from saved code is the exact frame the UI marks, not a fabricated source', async (t) => {
  const f = await fixture(t);
  const hitResp = await fetch(f.base + '/api/v1/world/search?q=uniquer456needle');
  assert.equal(hitResp.status, 200);
  const search = await hitResp.json();
  const hit = search.items.find((x) => x.kind === 'message');
  assert.deepEqual(hit.source.partPath, [0]);
  assert.equal(hit.conversation.id, f.cid);
  const button = await find(f.root, f.controller, 'uniquer456needle');
  assert.ok(button);
  await button.click();
  assert.equal(f.controller.view(), 'conversations');
  const frame = all(f.root, (x) => x.getAttribute('data-part-path') === '0')[0];
  assert.ok(frame && frame.focused && frame.scrolled);
  assert.equal(frame.getAttribute('aria-current'), 'true');
  assert.match(frame.textContent, /Matched part/);
});
test('ambiguous block-level search returns no partPath and focuses message without invented part markers', async (t) => {
  const f = await fixture(t);
  const hitResp = await fetch(f.base + '/api/v1/world/search?q=sharedr456term');
  const search = await hitResp.json();
  const ambiguous = search.items.find((x) => x.kind === 'message' && x.source?.index === 1);
  assert.ok(ambiguous);
  assert.equal(ambiguous.source.partPath ?? null, null);
  await find(f.root, f.controller, 'sharedr456term');
  const button = all(f.root, (x) => x.tag === 'button' && x.getAttribute('aria-label') === 'Open message ' + ambiguous.id)[0];
  assert.ok(button);
  await button.click();
  assert.equal(f.controller.view(), 'conversations');
  assert.equal(all(f.root, (x) => x.getAttribute('data-part-path') !== null && x.getAttribute('aria-current') === 'true').length, 0);
});
