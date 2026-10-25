// Rich reply output, sources, artifacts, history rows and manual retry for /chat.
// Frontend only: no browser, no CDP, no network, no live data. DOM is a tiny in-file stand-in.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const lf = (s) => s.replace(/\r\n/g, '\n');
const html = lf(readFileSync(new URL('../../src/studio/ui/chat.html', import.meta.url), 'utf8'));
const source = lf(readFileSync(new URL('../../src/studio/ui/chat.mjs', import.meta.url), 'utf8'));
const ui = await import('../../src/studio/ui/chat.mjs');

/* ---------------- a minimal DOM that honours createTextNode(text) ---------------- */
class Txt { constructor(data) { this.data = data; this.nodeType = 3; } appendData(s) { this.data += s; } }
class Node {
  constructor(tag = 'div', id = '') {
    Object.assign(this, { tag, id, children: [], dataset: {}, listeners: {}, attrs: {}, hidden: false, disabled: false, readOnly: false, value: '', open: false, checked: false, className: '' });
  }
  append(...kids) { this.children.push(...kids); }
  replaceChildren(...kids) { this.children = kids; }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  set textContent(v) { this.children = v === '' ? [] : [new Txt(String(v))]; }
  get textContent() { return this.children.map((c) => (typeof c === 'string' ? c : c instanceof Txt ? c.data : c.textContent)).join(''); }
  focus() {}
  async click() { for (const fn of this.listeners.click ?? []) await fn({ preventDefault() {} }); }
  async dispatch(type) { for (const fn of this.listeners[type] ?? []) await fn({ preventDefault() {} }); }
}
const fakeDoc = () => ({ createElement: (tag) => new Node(tag), createTextNode: (s) => new Txt(String(s)) });
const walk = (n, fn) => { if (!n || typeof n === 'string' || n instanceof Txt) return; fn(n); n.children.forEach((c) => walk(c, fn)); };
const all = (root, pred) => { const out = []; walk(root, (n) => { if (pred(n)) out.push(n); }); return out; };
const byTag = (root, tag) => all(root, (n) => n.tag === tag);
const flush = () => new Promise((r) => setImmediate(r));

const MD = [
  '# Plan', '', 'Use **bold**, *italic*, `inline code` and ~~old~~ text. See [the docs](https://docs.studio.example.test/start) now[1].', '',
  '- first', '  - nested one', '- [x] done item', '- [ ] open item', '', '3. third', '4. fourth', '',
  '| Name | Count | Note |', '| :--- | ---: | :---: |', '| alpha | 12 | ok |', '| beta | 7 | later |', '',
  '> quoted **line**', '', '```js', 'const a = 1;', 'console.log(a);', '```', '', '---', '[1]: https://docs.studio.example.test/ref "Ref"',
].join('\n');

test('parser: headings, lists with nesting and tasks, tables with alignment, quotes, rules, fenced code and link definitions', () => {
  const blocks = ui.parseBlocks(MD);
  assert.deepEqual(blocks.map((b) => b.type), ['heading', 'paragraph', 'list', 'list', 'table', 'quote', 'code', 'rule', 'linkdef']);
  assert.equal(blocks[0].level, 1);
  const list = blocks[2];
  assert.deepEqual(list.items.map((i) => [i.depth, i.task]), [[0, null], [1, null], [0, true], [0, false]]);
  assert.equal(blocks[3].items[0].start, 3, 'an ordered list keeps its starting number');
  const table = blocks[4];
  assert.deepEqual(table.head, ['Name', 'Count', 'Note']);
  assert.deepEqual(table.align, ['left', 'right', 'center']);
  assert.deepEqual(table.rows, [['alpha', '12', 'ok'], ['beta', '7', 'later']]);
  assert.equal(blocks[6].lang, 'js'); assert.equal(blocks[6].closed, true); assert.equal(blocks[6].text, 'const a = 1;\nconsole.log(a);');
  assert.deepEqual(blocks[8], { type: 'linkdef', label: '1', url: 'https://docs.studio.example.test/ref' });
});

test('parser: half-streamed text never breaks: open fence, header row without delimiter, unclosed markers', () => {
  const open = ui.parseBlocks('intro\n\n```python\nprint(1)\nprint(2');
  assert.equal(open[1].type, 'code'); assert.equal(open[1].closed, false); assert.equal(open[1].text, 'print(1)\nprint(2');
  assert.equal(ui.parseBlocks('| a | b |')[0].type, 'paragraph', 'no delimiter row yet: still text');
  assert.deepEqual(ui.parseInline('2 * 3 and **half'), [{ t: 'text', s: '2 * 3 and **half' }]);
  assert.deepEqual(ui.parseInline('a snake_case_name stays'), [{ t: 'text', s: 'a snake_case_name stays' }]);
  assert.deepEqual(ui.parseBlocks('').length, 0);
  assert.deepEqual(ui.parseBlocks(null).length, 0);
});

test('links: only http, https and mailto become links; script-like and data addresses are plain text; images are never fetched', () => {
  assert.equal(ui.safeHref('https://docs.studio.example.test/a'), 'https://docs.studio.example.test/a');
  assert.equal(ui.safeHref('mailto:a@studio.example.test'), 'mailto:a@studio.example.test');
  for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<b>x', 'file:///c:/x', 'vbscript:x', '', null, 'not a url']) assert.equal(ui.safeHref(bad), null, String(bad));
  const [bad] = ui.parseInline('[click](javascript:alert(1))');
  assert.equal(bad.t, 'link'); assert.equal(bad.href, null);
  const [img] = ui.parseInline('![logo](https://img.studio.example.test/x.png)');
  assert.equal(img.image, true);
  const doc = fakeDoc(), r = ui.createRichRenderer(doc), root = doc.createElement('div');
  r.sync(root, {}, ui.parseBlocks('[click](javascript:alert(1)) ![logo](https://img.studio.example.test/x.png) https://docs.studio.example.test/p.'), { sources: [] });
  assert.equal(byTag(root, 'img').length, 0, 'no image element is ever created');
  const anchors = byTag(root, 'a');
  assert.equal(anchors.length, 2);
  assert.ok(anchors.every((a) => /^https:/.test(a.attrs.href) && a.attrs.rel === 'noopener noreferrer nofollow' && a.attrs.target === '_blank'));
  assert.equal(all(root, (n) => n.attrs.href?.startsWith('javascript')).length, 0);
  assert.equal(all(root, (n) => n.className === 'deadlink').length, 1, 'the blocked address is shown as text with a reason');
  assert.equal(anchors.at(-1).attrs.href, 'https://docs.studio.example.test/p', 'trailing sentence punctuation is not part of the address');
});

test('site text is data: tags stay text, and the module builds nodes only', () => {
  const doc = fakeDoc(), r = ui.createRichRenderer(doc), root = doc.createElement('div');
  r.sync(root, {}, ui.parseBlocks('<script>alert(1)</script> <img src=x onerror=alert(1)>\n\n```html\n<b onclick="x()">hi</b>\n```'), { sources: [] });
  assert.equal(byTag(root, 'script').length, 0); assert.equal(byTag(root, 'img').length, 0);
  assert.match(root.textContent, /<script>alert\(1\)<\/script>/);
  assert.match(byTag(root, 'code').at(-1).textContent, /<b onclick="x\(\)">hi<\/b>/);
  assert.doesNotMatch(source, /innerHTML|insertAdjacentHTML|outerHTML|document\.write/);
  assert.doesNotMatch(source, /\.style\b|setAttribute\('style'/, 'no inline styles (the page CSP forbids them)');
});

test('renderer: code block copies its exact text; a table copies as tab-separated text; headings stay below the page headings', async () => {
  const copied = [], downloads = [], notes = [];
  const doc = fakeDoc(), r = ui.createRichRenderer(doc, { copy: async (t) => { copied.push(t); return true; }, download: (t, n) => { downloads.push([t, n]); return true; }, notice: (m) => notes.push(m) });
  const root = doc.createElement('div');
  r.sync(root, {}, ui.parseRich(MD).blocks, { sources: ui.replySources(null, ui.parseBlocks(MD)) });
  assert.deepEqual(byTag(root, 'h4').map((n) => n.textContent), ['Plan'], 'an h1 in a reply is an h4 on the page');
  assert.equal(byTag(root, 'strong').length >= 1, true); assert.equal(byTag(root, 'del').length, 1);
  const fig = byTag(root, 'figure')[0];
  assert.equal(fig.className, 'codeblk', 'a 2-line js block is code, not an artifact');
  assert.match(fig.children[0].textContent, /js/); assert.match(fig.children[0].textContent, /2 lines/);
  await byTag(fig, 'button')[0].click(); await flush();
  assert.deepEqual(copied, ['const a = 1;\nconsole.log(a);']);
  assert.equal(notes.at(-1), 'Copied.');
  const table = byTag(root, 'table')[0];
  assert.equal(byTag(table, 'th').length, 3); assert.equal(byTag(table, 'td').length, 6);
  assert.deepEqual(byTag(table, 'th').map((n) => n.className), ['', 'al-r', 'al-c'], 'left alignment is the default');
  assert.equal(all(root, (n) => n.attrs.role === 'region')[0].attrs.tabindex, '0', 'a wide table scrolls by keyboard');
  const tableCopy = byTag(all(root, (n) => n.className === 'tablebar')[0], 'button')[0];
  await tableCopy.click(); await flush();
  assert.equal(copied.at(-1), 'Name\tCount\tNote\nalpha\t12\tok\nbeta\t7\tlater');
  assert.equal(byTag(root, 'ol')[0].attrs.start, '3');
  assert.equal(all(root, (n) => n.className === 'task').length, 2);
});

test('artifacts: documents and long files get Download and a "never run" note; short snippets do not', async () => {
  const downloads = [];
  const doc = fakeDoc(), r = ui.createRichRenderer(doc, { download: (t, n) => { downloads.push([t, n]); return true; }, copy: async () => true });
  const page = '<!doctype html>\n<html>\n<body>hi</body>\n</html>';
  const long = Array.from({ length: 31 }, (_, i) => 'line ' + i).join('\n');
  const parsed = ui.parseRich('```html\n' + page + '\n```\n\n```py\nprint(1)\n```\n\n```python\n' + long + '\n```\n\n```svg\n<svg/>\n```').blocks;
  assert.deepEqual(parsed.map((b) => b.artifact && [b.artifact.n, b.artifact.ext]), [[1, 'html'], null, [2, 'py'], null], 'svg with one line is not an artifact');
  const root = doc.createElement('div'); r.sync(root, {}, parsed, { sources: [] });
  const arts = all(root, (n) => /artifact/.test(n.className) && n.tag === 'figure');
  assert.equal(arts.length, 2);
  assert.match(arts[0].textContent, /Shown as text only\. Studio never runs or previews it\./);
  await byTag(arts[0], 'button').find((b) => b.textContent === 'Download').click();
  assert.deepEqual(downloads, [[page, 'reply-artifact-1.html']]);
  assert.equal(ui.artifactFileName(2, 'py'), 'reply-artifact-2.py'); assert.equal(ui.artifactFileName(1, 'md', 'My Plan!'), 'my-plan.md');
  assert.deepEqual(ui.replyArtifacts({ artifacts: [{ title: 'Doc', language: 'text/markdown', text: '# x' }, { url: 'javascript:1' }, { url: 'https://docs.studio.example.test/f' }, null, 5] }).map((a) => [a.title, a.ext, a.text, a.href]),
    [['Doc', 'md', '# x', null], ['Artifact 3', 'txt', null, 'https://docs.studio.example.test/f']]);
});

test('streaming: untouched blocks keep their DOM node and an open code block grows in place (a selection survives)', () => {
  const doc = fakeDoc(), r = ui.createRichRenderer(doc), root = doc.createElement('div'), state = {};
  const step = (text, streaming = true) => r.sync(root, state, ui.parseRich(text).blocks, { sources: [], streaming });
  step('Hello **wor');
  const para = root.children[0];
  step('Hello **world**\n\n```js\nlet a');
  assert.notEqual(root.children[0], para, 'the paragraph changed, so it was rebuilt');
  const first = root.children[0], code = root.children[1], textNode = byTag(code, 'code')[0].children[0];
  assert.match(code.children[0].textContent, /so far/);
  step('Hello **world**\n\n```js\nlet a = 1;\nlet b');
  assert.equal(root.children[0], first, 'the finished paragraph kept its node');
  assert.equal(root.children[1], code, 'the code block kept its node');
  assert.equal(byTag(code, 'code')[0].children[0], textNode, 'the text node itself grew');
  assert.equal(textNode.data, 'let a = 1;\nlet b');
  step('Hello **world**\n\n```js\nlet a = 1;\nlet b = 2;\n```', false);
  assert.equal(root.children[1], code); assert.doesNotMatch(code.children[0].textContent, /so far|not closed/);
  step('Hello **world**\n\n```js\nlet a = 1;\nlet b = 2;', false);
  assert.match(root.children[1].children[0].textContent, /block not closed in the reply/, 'a finished reply with an open fence says so');
});

test('sources: reported by the site first, then reference lines, then plain links; the origin is always stated', () => {
  const reported = { citations: [{ title: 'Spec', url: 'https://docs.studio.example.test/spec', n: 2, snippet: 'x'.repeat(500) }, 'https://docs.studio.example.test/b', { url: 'javascript:1' }],
    blocks: [{ kind: 'citations', items: [{ title: 'Dup', url: 'https://docs.studio.example.test/b' }, { name: 'Third', href: 'https://docs.studio.example.test/c' }] }] };
  const a = ui.replySources(reported, []);
  // The site's own number is kept when free; others take the lowest unused number, so no two sources share one.
  assert.deepEqual(a.map((s) => [s.n, s.title, s.origin]), [[2, 'Spec', 'site'], [1, 'docs.studio.example.test', 'site'], [3, 'Third', 'site']]);
  assert.equal(a[0].snippet.length, 240);
  assert.equal(ui.sourcesNote(a), 'Reported by the site with this reply.');
  const defs = ui.replySources(null, ui.parseBlocks('text [1]\n\n[1]: https://docs.studio.example.test/one\n[note]: https://docs.studio.example.test/two'));
  assert.deepEqual(defs.map((s) => [s.n, s.key, s.origin]), [[1, '1', 'text'], [2, 'note', 'text']]);
  assert.match(ui.sourcesNote(defs), /reference lines in the reply text/);
  const links = ui.replySources(null, ui.parseBlocks('See [one](https://docs.studio.example.test/1) and https://docs.studio.example.test/2, [mail](mailto:a@studio.example.test) ![img](https://docs.studio.example.test/i.png)'));
  assert.deepEqual(links.map((s) => [s.title, s.origin]), [['one', 'links'], ['docs.studio.example.test', 'links']], 'mail and images are not sources');
  assert.match(ui.sourcesNote(links), /didn’t report a separate source list/);
  assert.equal(ui.sourcesNote([]), '');
});

test('citation markers: [n] links only to a source that exists; the site’s private-use markers become numbered, non-linked marks', () => {
  const doc = fakeDoc(), r = ui.createRichRenderer(doc), root = doc.createElement('div');
  const sources = ui.replySources(null, ui.parseBlocks('[1]: https://docs.studio.example.test/one'));
  const text = 'Claim[1] and unknown[7] and site marker \uE200cite\uE202turn0search0\uE202turn0news1\uE201 again \uE200cite\uE202turn0search0\uE201.';
  r.sync(root, {}, ui.parseBlocks(text), { sources });
  const sups = byTag(root, 'sup');
  assert.equal(sups[0].children[0].attrs.href, 'https://docs.studio.example.test/one', '[1] resolves to its source');
  assert.match(root.textContent, /unknown\[7\]/, 'an unknown [7] stays as typed');
  assert.deepEqual(sups.slice(1).map((s) => s.textContent), ['[1]', '[2]', '[1]'], 'the same site marker keeps its number');
  assert.ok(sups.slice(1).every((s) => byTag(s, 'a').length === 0), 'site markers are not links');
  assert.doesNotMatch(root.textContent, /[\uE000-\uF8FF]/, 'no private-use characters reach the page');
});

test('history rows use the tab title, turn count, capture state and thread; needs-checking is flagged; show-all is bounded', () => {
  const t = (id, extra = {}) => ({ id, phase: 'delivered', send: { state: 'observed' }, reply: { state: 'ready' }, readiness: { state: 'ready' }, ...extra });
  const row = ui.historyRow({ id: 'c1', state: 'ready', site: 'chatgpt', binding: { title: 'Trip plan', thread: { ref: 'chatgpt-c:abc' } }, capture: { state: 'idle' }, turns: [t('a'), t('b'), { id: 'c', phase: 'blocked', send: { state: 'not-attempted' } }] });
  assert.equal(row.title, 'Trip plan'); assert.equal(row.meta, 'chatgpt · 2 turns · Not recording · Chat thread saved');
  assert.deepEqual(row.chip, ['Ready', 't-info']); assert.equal(row.attention, false);
  const odd = ui.historyRow({ id: 'c2', state: 'needs-reconciliation', site: { id: 'claude' }, turns: [t('a', { send: { state: 'uncertain' } })] });
  assert.equal(odd.title, 'claude'); assert.equal(odd.attention, true);
  assert.equal(ui.historyRow({ id: 'c3', state: 'ready', site: 'gemini', turns: [] }).meta, '', 'no turn data: nothing is claimed');
  assert.equal(ui.historyRow({ id: 'c3', state: 'ready', site: 'gemini', turns: [{ id: 'x', phase: 'blocked', send: { state: 'not-attempted' } }] }).meta, 'Nothing sent');
  assert.equal(ui.historyRow({ id: 'c4' }).title, 'c4'); assert.equal(ui.historyRow(null).title, 'Conversation');
  assert.equal(ui.historyShown(Array.from({ length: 45 }, (_, i) => i), false).length, 20);
  assert.equal(ui.historyShown(Array.from({ length: 45 }, (_, i) => i), true).length, 45);
  assert.equal(ui.historyRow({ id: 'c5', state: 'closed', site: 'chatgpt', binding: { title: '   ' } }).title, 'chatgpt', 'a blank title falls back to the site');
});

test('markup: reply tools, sources, artifacts, retry and history controls exist; live region and 44px rule are unchanged', () => {
  for (const id of ['btnCopyReply', 'btnRawToggle', 'replyArtifacts', 'replySources', 'sourcesHead', 'sourcesNote', 'sourcesList', 'btnRetry', 'btnListRefresh', 'btnListMore'])
    assert.ok(html.includes('id="' + id + '"'), id);
  assert.equal((html.match(/aria-live="polite"/g) ?? []).length, 1, 'still one polite live region');
  assert.match(html, /button, select, input\[type=text\], textarea, summary, a\.hit \{ min-height: 44px; \}/);
  assert.match(html, /button\.mini \{ padding: 2px 10px; font-size: 12\.5px; \}/, 'compact buttons keep the 44px minimum height');
  assert.doesNotMatch(source, /aria-pressed/);
  assert.match(html, /follow up in the same chat, one turn at a time/);
  assert.doesNotMatch(html, /send one message,/);
});

/* ---------------- the page, against the same stand-in ---------------- */
const READY = { ready: true, draft: { present: false, chars: 0 }, reason: null };
const ready = (extra = {}) => ({ id: 'c1', revision: 3, state: 'ready', site: 'chatgpt', binding: { targetId: 't1', origin: 'https://studio.example.test', ownedByStudio: false, title: 'Trip plan' },
  sessionId: 's1', turn: null, readiness: READY, diagnostic: { finishPhase: 'idle', finishError: null, uncertainty: null },
  reply: { state: 'unknown', source: 'page', text: '', chars: 0, completion: 'unknown' }, capture: { state: 'recording', integrity: null }, limitations: [], ...extra });
const settled = (n, text) => ({ id: 't' + n, key: 'k' + n, phase: 'delivered', sessionId: 's' + n, send: { state: 'observed' }, reply: { state: 'ready', text }, readiness: { state: 'ready' }, completion: { state: 'unknown' } });

let boot = 0;
async function withPage({ initial, getsFail = () => false, turnFails = false, clipboard } = {}, body) {
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  const byId = new Map(ids.map((id) => [id, new Node('div', id)]));
  const mem = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m }; };
  const local = mem(), session = mem(), calls = [], winListeners = {}, writes = [];
  const answer = (status, bodyObj) => ({ ok: status < 400, status, statusText: '', text: async () => JSON.stringify(bodyObj) });
  const state = { gets: 0 };
  const fetchStub = async (url, init = {}) => {
    const method = init.method ?? 'GET', p = String(url).replace(/^\/api\/v1/, '');
    calls.push(method + ' ' + p);
    if (p === '/conversation-targets') return answer(200, { sites: [{ id: 'chatgpt' }], targets: [] });
    if (p === '/conversations' && method === 'GET') return answer(200, { conversations: [{ id: 'c1', state: 'ready', site: 'chatgpt', revision: 3, binding: { title: 'Trip plan' }, capture: { state: 'idle' }, turns: initial.turns ?? [] }] });
    if (p === '/conversations/c1' && method === 'GET') { state.gets++; if (getsFail(state.gets)) throw new TypeError('network down'); return answer(200, { conversation: initial }); }
    if (p === '/conversations/c1/turns') { if (turnFails) throw new TypeError('network down'); return answer(200, { conversation: initial }); }
    return answer(404, { error: 'not found' });
  };
  const fakeDocument = { hidden: false, getElementById: (id) => byId.get(id) ?? null, querySelector: (s) => (s.startsWith('#') ? byId.get(s.slice(1)) ?? null : null),
    querySelectorAll: (s) => (s === 'input[name=mode]' ? ['modeNew', 'modeExisting'].map((id) => byId.get(id)) : []), createElement: (t) => new Node(t), createTextNode: (s) => new Txt(String(s)), addEventListener() {} };
  const keys = ['document', 'window', 'fetch', 'sessionStorage', 'localStorage', 'navigator'];
  const saved = Object.fromEntries(keys.map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  const realWarn = console.warn, warnings = [];
  Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: { clipboard: clipboard ?? { writeText: async (t) => { writes.push(t); } } } });
  Object.assign(globalThis, { document: fakeDocument, fetch: fetchStub, sessionStorage: session, localStorage: local,
    window: { matchMedia: () => ({ matches: false, addEventListener() {} }), addEventListener: (t, f) => { winListeners[t] = f; } } });
  console.warn = (...a) => warnings.push(a.join(' '));
  try {
    await import(new URL('../../src/studio/ui/chat.mjs?rich=' + (++boot), import.meta.url).href);
    for (let i = 0; i < 25; i++) await flush();
    return await body({ el: (id) => byId.get(id), local, calls, writes, warnings, settle: async () => { for (let i = 0; i < 25; i++) await flush(); }, state });
  } finally {
    winListeners.pagehide?.(); console.warn = realWarn;
    for (const [k, d] of Object.entries(saved)) { if (d) Object.defineProperty(globalThis, k, d); else delete globalThis[k]; }
  }
}

test('page: a finished reply is shown formatted with sources; plain text shows the exact received text and is remembered; Copy reply copies the exact text', async () => {
  const text = ['## Result', '', 'Done[1].', '', '```bash', 'echo hi', '```', '', '| a | b |', '| - | - |', '| 1 | 2 |', '', '[1]: https://docs.studio.example.test/one'].join('\n');
  const initial = ready({ revision: 9, turn: settled(1, text), turns: [settled(1, text)], capture: { state: 'idle' }, reply: { state: 'ready', text, chars: text.length, source: 'network', completion: 'complete' } });
  await withPage({ initial }, async ({ el, local, writes, warnings, settle }) => {
    const holder = el('replyBlocks');
    assert.equal(holder.children.length, 1);
    assert.equal(holder.children[0].className, 'rich', 'answer is formatted by default');
    assert.deepEqual(byTag(holder, 'h5').map((n) => n.textContent), ['Result']);
    assert.equal(byTag(holder, 'figure').length, 1); assert.equal(byTag(holder, 'table').length, 1);
    assert.equal(el('replySources').hidden, false);
    assert.equal(el('sourcesHead').textContent, 'Sources (1)');
    assert.equal(byTag(el('sourcesList'), 'a')[0].attrs.href, 'https://docs.studio.example.test/one');
    assert.equal(el('btnRawToggle').textContent, 'Show plain text'); assert.equal(el('btnCopyReply').disabled, false);
    await el('btnCopyReply').click(); await settle();
    assert.deepEqual(writes, [text], 'the copy is the exact text received, not the formatted view');
    assert.equal(el('btnCopyReply').textContent, 'Reply copied');
    await el('btnRawToggle').click(); await settle();
    assert.notEqual(holder.children[0].className, 'rich');
    assert.equal(holder.textContent, text, 'plain view is byte-for-byte the received text');
    assert.equal(byTag(holder, 'figure').length, 0);
    assert.equal(el('replySources').hidden, false, 'sources stay listed in the plain view');
    assert.equal(el('btnRawToggle').textContent, 'Show formatted'); assert.equal(local.m.get('capture-studio.chat.plain-reply'), '1');
    await el('btnRawToggle').click(); await settle();
    assert.equal(holder.children[0].className, 'rich'); assert.equal(local.m.get('capture-studio.chat.plain-reply'), '0');
    assert.deepEqual(warnings, []);
  });
});

test('page: a failed copy says so, and earlier turns keep their own formatting', async () => {
  const t1 = settled(1, 'first:\n\n```py\nprint(1)\n```'), t2 = settled(2, 'second **answer**');
  const initial = ready({ revision: 9, turn: t2, turns: [t1, t2], capture: { state: 'idle' }, reply: { state: 'ready', text: t2.reply.text, source: 'network', completion: 'complete' } });
  await withPage({ initial, clipboard: { writeText: async () => { throw new Error('denied'); } } }, async ({ el, settle }) => {
    await el('btnCopyReply').click(); await settle();
    assert.match(el('btnCopyReply').textContent, /Couldn’t copy/);
    assert.match(el('announce').textContent, /Couldn’t copy the reply/);
    const list = el('turnList');
    assert.equal(list.hidden, false);
    assert.equal(byTag(list, 'figure').length, 1, 'turn 1 reply keeps its code block');
    assert.equal(byTag(el('replyBlocks'), 'strong')[0].textContent, 'answer');
  });
});

test('page: after the Studio stops answering, Retry now appears; it only re-reads, and a good answer clears it', async () => {
  const initial = ready();
  await withPage({ initial, turnFails: true, getsFail: (n) => n >= 2 && n <= 3 }, async ({ el, calls, settle, state }) => {
    assert.equal(el('btnRetry').hidden, true, 'hidden while everything works');
    el('prompt').value = 'hello'; await el('prompt').dispatch('input');
    await el('btnSend').click(); await settle();
    assert.equal(el('btnRetry').hidden, false, 'the refresh after the unknown send failed, so the page offers a retry');
    assert.match(el('problem').textContent, /Lost contact with the Studio/);
    const posts = () => calls.filter((c) => c === 'POST /conversations/c1/turns').length;
    assert.equal(posts(), 1);
    await el('btnRetry').click(); await settle();
    assert.equal(state.gets >= 3, true);
    assert.equal(posts(), 1, 'Retry never sends or re-posts');
    assert.equal(calls.filter((c) => c.startsWith('POST') && !c.endsWith('/turns')).length, 0, 'Retry posts nothing at all');
    assert.equal(el('btnRetry').hidden, false, 'still failing: still offered');
    await el('btnRetry').click(); await settle();
    assert.equal(el('btnRetry').hidden, true, 'a good answer clears it');
    assert.equal(el('problem').hidden, true);
    assert.equal(posts(), 1, 'still exactly one send');
  });
});

test('page: the history list shows real titles and turn counts, refreshes on demand, and offers show-all only when needed', async () => {
  const done = settled(1, 'a');
  const initial = ready({ revision: 9, turn: done, turns: [done], capture: { state: 'idle' }, reply: { state: 'ready', text: 'a', source: 'network', completion: 'complete' } });
  await withPage({ initial: { ...initial, turns: [done] } }, async ({ el, calls, settle }) => {
    const rows = el('convList').children;
    assert.equal(rows.length, 1);
    const btn = rows[0].children[0];
    assert.match(btn.textContent, /Trip plan/); assert.match(btn.textContent, /1 turn/); assert.match(btn.textContent, /Not recording/);
    assert.equal(el('btnListMore').hidden, true);
    const before = calls.filter((c) => c === 'GET /conversations').length;
    await el('btnListRefresh').click(); await settle();
    assert.equal(calls.filter((c) => c === 'GET /conversations').length, before + 1);
    assert.equal(calls.some((c) => c.startsWith('POST')), false, 'refreshing the list posts nothing');
  });
});
