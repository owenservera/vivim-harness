// Text-aware turn-group selection in page-agent turns(). Synthetic fake DOM only; no Chrome, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const pageAgentSrc = readFileSync(new URL('../../src/capture/page-agent.js', import.meta.url), 'utf8');

// ---- fake DOM ----------------------------------------------------------------------------
function el(tag, attrs = {}, children = [], opts = {}) {
  const node = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    parentElement: null,
    hidden: opts.hidden === true,
    attributes: Object.entries(attrs).map(([name, value]) => ({ name, value: String(value) })),
    childNodes: [],
    className: attrs.class || '',
    getAttribute(n) { const a = this.attributes.find((x) => x.name === n); return a ? a.value : null; },
    hasAttribute(n) { return this.getAttribute(n) !== null; },
    matches: () => false,
    querySelector: () => null,
    querySelectorAll: () => [],
    closest: () => null,
  };
  for (const c of children) {
    if (typeof c === 'string') node.childNodes.push({ nodeType: 3, nodeValue: c, textContent: c, parentElement: node });
    else { c.parentElement = node; node.childNodes.push(c); }
  }
  Object.defineProperty(node, 'children', { get: () => node.childNodes.filter((c) => c.nodeType === 1) });
  Object.defineProperty(node, 'childElementCount', { get: () => node.children.length });
  Object.defineProperty(node, 'textContent', { get: () => node.childNodes.map((c) => c.textContent).join('') });
  Object.defineProperty(node, 'innerText', { get: () => (opts.innerText !== undefined ? opts.innerText : node.textContent) });
  return node;
}

function descendants(node, out = []) {
  for (const c of node.childNodes) if (c.nodeType === 1) { out.push(c); descendants(c, out); }
  return out;
}

function loadPage(kids) {
  const body = el('body', {}, kids);
  const sandbox = {
    __aionBind: () => {},
    setInterval: () => 0,
    clearTimeout: () => {},
    setTimeout: () => 0,
    addEventListener: () => {},
    MutationObserver: class { observe() {} disconnect() {} },
    location: { href: 'https://synthetic.test/chat', host: 'synthetic.test' },
    document: {
      title: 'synthetic',
      visibilityState: 'visible',
      body,
      documentElement: body,
      scrollingElement: body,
      addEventListener: () => {},
      querySelector: () => null,
      querySelectorAll: (sel) => (sel === 'body *' ? descendants(body) : []),
    },
  };
  vm.createContext(sandbox);
  const src = pageAgentSrc.trim().replace(/;\s*$/, '') + '("__aionBind", {})';
  assert.equal(vm.runInContext(src, sandbox), 'started');
  return { cap: sandbox.__aionCapture, body };
}

// Clone out of the vm realm before comparing (deepStrictEqual is realm-sensitive).
const summarize = (turns) => turns.map((t) => ({ role: t.role, roleAttribute: t.roleAttribute, text: t.text }));
const newTurns = (cap) => summarize(JSON.parse(JSON.stringify(cap.turns())));

// ---- reference: the pre-change selection, copied verbatim in logic -----------------------
const ROLE_WORDS = new Set(['user', 'assistant', 'human', 'ai', 'model', 'bot', 'system', 'tool']);
const SKIP_ATTR = new Set(['class', 'id', 'style', 'href', 'src', 'type', 'name', 'value', 'placeholder', 'aria-label', 'title', 'alt']);
function oldReference(body) {
  const cands = [];
  for (const e of descendants(body)) {
    for (const a of e.attributes) {
      if (SKIP_ATTR.has(a.name)) continue;
      const v = a.value.trim().toLowerCase();
      if (ROLE_WORDS.has(v)) { cands.push({ el: e, attr: a.name, role: v }); break; }
    }
  }
  const set = new Set(cands.map((c) => c.el));
  const outer = cands.filter((c) => { for (let p = c.el.parentElement; p; p = p.parentElement) if (set.has(p) && cands.find((x) => x.el === p && x.attr === c.attr)) return false; return true; });
  const byAttr = new Map();
  for (const c of outer) { if (!byAttr.has(c.attr)) byAttr.set(c.attr, []); byAttr.get(c.attr).push(c); }
  const best = [...byAttr.values()].filter((g) => new Set(g.map((c) => c.role)).size >= 2 || g.length >= 2).sort((a, b) => b.length - a.length)[0] || [];
  return summarize(best.map((c) => ({ role: c.role, roleAttribute: c.attr, text: (c.el.innerText || c.el.textContent || '').trim() })));
}

// ---- builders ----------------------------------------------------------------------------
// Distinct synthetic text of an exact length (no trailing whitespace, so trim() keeps the length).
function text(seed, len) {
  let s = '';
  for (let i = 0; s.length < len; i++) s += `${seed}${i} `;
  return s.slice(0, len).replace(/\s+$/, 'x');
}
// A group: one element per text, roles alternating user/assistant starting with `first`.
function group(attr, texts, first = 'user') {
  const roles = [first, first === 'user' ? 'assistant' : 'user'];
  return texts.map((t, i) => el('div', { [attr]: roles[i % 2] }, [t]));
}

// ---- tests -------------------------------------------------------------------------------

test('(1) ChatGPT-like: real message containers beat a group of identical hidden headings', () => {
  const turns = [
    ['user', text('question', 70)],
    ['assistant', text('answer', 120)],
    ['user', text('followup', 60)],
    ['assistant', text('reply', 150)],
  ];
  const kids = turns.map(([role, body]) => el('section', { class: 'turn' }, [
    // Hidden accessibility heading: same text every turn, always role assistant, precedes the body.
    el('h5', { 'data-conversation-role': 'assistant', class: 'sr-only' }, ['Assistant said:'], { hidden: true }),
    el('div', { 'data-message-author-role': role }, [body]),
  ]));
  const { cap, body } = loadPage(kids);
  // The fixture really exercises the bug: the old rule picks the heading attribute here.
  assert.equal(oldReference(body)[0].roleAttribute, 'data-conversation-role');
  const got = newTurns(cap);
  assert.equal(got.length, 4);
  assert.ok(got.every((t) => t.roleAttribute === 'data-message-author-role'));
  assert.deepEqual(got.map((t) => t.role), ['user', 'assistant', 'user', 'assistant']);
  assert.deepEqual(got.map((t) => t.text), turns.map(([, b]) => b));
  for (const t of got) assert.ok(t.text.length >= 40 && t.text.length <= 200);
});

test('(2) simple single-attribute pages give exactly the old selection', () => {
  const pages = [
    () => group('data-author', [text('a', 50), text('b', 60)]),
    () => group('data-author', ['Short question about the synthetic plan?', 'Yes, here is a longer synthetic answer.', 'Thanks.', 'Another synthetic reply for the thread.', 'ok, noted here.']),
    () => [el('div', { 'data-author': 'assistant' }, [el('p', {}, [el('span', { 'data-author': 'assistant' }, [text('nested', 45)])]), el('p', {}, [text('second', 30)])]), el('div', { 'data-author': 'user' }, [text('q', 25)])],
    () => [el('div', { 'data-author': 'assistant' }, [text('lonely', 40)])],
    () => [],
  ];
  for (const make of pages) {
    const { cap, body } = loadPage(make());
    assert.deepEqual(newTurns(cap), oldReference(body));
  }
});

test('(3) all candidates tiny: falls back to the old selection', () => {
  const kids = [
    el('div', { 'data-a': 'user' }, ['hi']),
    el('div', { 'data-a': 'assistant' }, ['ok']),
    el('div', { 'data-b': 'assistant' }, ['yo']),
    el('div', { 'data-b': 'assistant' }, ['no']),
    el('div', { 'data-b': 'assistant' }, ['go']),
  ];
  const { cap, body } = loadPage(kids);
  const got = newTurns(cap);
  assert.deepEqual(got, oldReference(body));
  assert.ok(got.every((t) => t.roleAttribute === 'data-b'));
});

test('(4a) more substantive candidates win, even against a bigger group of mostly tiny ones', () => {
  const kids = [
    ...group('data-x', [text('x1', 60), text('x2', 70), text('x3', 80)]),
    ...group('data-y', [text('y1', 60), text('y2', 70), 'hi', 'ok']),
  ];
  const { cap, body } = loadPage(kids);
  assert.equal(oldReference(body)[0].roleAttribute, 'data-y'); // old: count 4 beats 3
  const got = newTurns(cap);
  assert.equal(got.length, 3);
  assert.ok(got.every((t) => t.roleAttribute === 'data-x'));
});

test('(4b) equal substantive count: higher uniqueTextRatio beats a longer median', () => {
  const kids = [
    ...group('data-x', [text('same', 150), text('same', 150)]), // ratio 0.5, median 150
    ...group('data-y', [text('y1', 40), text('y2', 40)]), // ratio 1, median 40
  ];
  const { cap } = loadPage(kids);
  const got = newTurns(cap);
  assert.ok(got.every((t) => t.roleAttribute === 'data-y'));
});

test('(4c) equal substantive and ratio: longer median wins', () => {
  const kids = [
    ...group('data-p', [text('p1', 40), text('p2', 40)]),
    ...group('data-q', [text('q1', 120), text('q2', 120)]),
  ];
  const { cap } = loadPage(kids);
  assert.ok(newTurns(cap).every((t) => t.roleAttribute === 'data-q'));
});

test('(4d) equal substantive, ratio and median: more candidates wins', () => {
  // E: lengths [2, 30, 40] -> lower median 30, ratio 1, 2 substantive, 3 candidates.
  // F: lengths [30, 40]    -> lower median 30, ratio 1, 2 substantive, 2 candidates.
  const kids = [
    ...group('data-f', [text('f1', 30), text('f2', 40)]),
    ...group('data-e', [text('e1', 30), text('e2', 40), 'hi']),
  ];
  const { cap } = loadPage(kids);
  const got = newTurns(cap);
  assert.equal(got.length, 3);
  assert.ok(got.every((t) => t.roleAttribute === 'data-e'));
});

test('(5) identical-text group loses to a distinct-text group with the same substantive count', () => {
  // G: 2 substantive identical texts plus one tiny text (count 3, ratio 2/3).
  // H: 2 substantive distinct texts (count 2, ratio 1). Ratio decides before count.
  const kids = [
    ...group('data-g', [text('dup', 120), text('dup', 120), 'ok']),
    ...group('data-h', [text('h1', 50), text('h2', 50)]),
  ];
  const { cap } = loadPage(kids);
  const got = newTurns(cap);
  assert.equal(got.length, 2);
  assert.ok(got.every((t) => t.roleAttribute === 'data-h'));
});

test('(6) deterministic: repeated calls match, and a full tie is broken by attribute name not DOM order', () => {
  const kids = [
    ...group('data-zeta', [text('z1', 60), text('z2', 60)]),
    ...group('data-alpha', [text('a1', 60), text('a2', 60)]),
  ];
  const { cap } = loadPage(kids);
  const first = newTurns(cap);
  assert.deepEqual(newTurns(cap), first);
  assert.deepEqual(newTurns(cap), first);
  assert.ok(first.every((t) => t.roleAttribute === 'data-alpha'));
  // Fresh load of the same page gives the same answer.
  assert.deepEqual(newTurns(loadPage(kids).cap), first);
});

test('(7a) hidden decoration: tiny text repeated under a different role is dropped from the winning group', () => {
  const kids = [
    el('div', { 'data-msg': 'user' }, [text('q', 60)]),
    el('div', { 'data-msg': 'assistant' }, ['ok']),
    el('div', { 'data-msg': 'user' }, ['ok']),
    el('div', { 'data-msg': 'assistant' }, [text('r', 90)]),
  ];
  const { cap, body } = loadPage(kids);
  assert.equal(oldReference(body).length, 4);
  const got = newTurns(cap);
  assert.deepEqual(got.map((t) => t.text), [text('q', 60), text('r', 90)]);
});

test('(7b) text of exactly 3 characters is not decoration and is kept', () => {
  const kids = [
    el('div', { 'data-msg': 'user' }, [text('q', 60)]),
    el('div', { 'data-msg': 'assistant' }, ['yes']),
    el('div', { 'data-msg': 'user' }, ['yes']),
    el('div', { 'data-msg': 'assistant' }, [text('r', 90)]),
  ];
  const { cap } = loadPage(kids);
  assert.equal(newTurns(cap).length, 4);
});

test('(7c) tiny duplicates under the same role are kept (filter needs a different role)', () => {
  const kids = [
    el('div', { 'data-msg': 'user' }, [text('q', 60)]),
    el('div', { 'data-msg': 'user' }, ['ok']),
    el('div', { 'data-msg': 'user' }, ['ok']),
    el('div', { 'data-msg': 'assistant' }, [text('r', 90)]),
  ];
  const { cap } = loadPage(kids);
  assert.equal(newTurns(cap).length, 4);
});

test('(8) empty innerText: hidden elements are not scored from textContent, visible ones are', () => {
  const hiddenLong = (role) => el('div', { 'data-hidden-group': role }, [text('hid', 90)], { hidden: true, innerText: '' });
  const shown = (role, s) => el('div', { 'data-shown-group': role }, [s]);
  const kids = [
    hiddenLong('user'), hiddenLong('assistant'), // first in document order, count 2, nothing scoreable
    shown('user', text('s1', 45)), shown('assistant', text('s2', 45)),
  ];
  const { cap } = loadPage(kids);
  const got = newTurns(cap);
  assert.ok(got.every((t) => t.roleAttribute === 'data-shown-group'));
  // Non-hidden with empty innerText: textContent is used for the returned text as before.
  const raw = [
    el('div', { 'data-raw': 'user' }, [text('raw1', 80)], { innerText: '' }),
    el('div', { 'data-raw': 'assistant' }, [text('raw2', 80)], { innerText: '' }),
  ];
  const r = newTurns(loadPage(raw).cap);
  assert.deepEqual(r.map((t) => t.text), [text('raw1', 80), text('raw2', 80)]);
});
