// Join keys between stream blocks and DOM blocks. Synthetic data only; no Chrome, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { DeltaAssembler } from '../../src/decode/delta.mjs';
import { DomObserver } from '../../src/capture/dom.mjs';
import { capturePrivacy } from '../../src/capture/privacy.mjs';

const pageAgentSrc = readFileSync(new URL('../../src/capture/page-agent.js', import.meta.url), 'utf8');

// ---- stream side: typed-events -----------------------------------------------------------

const typedWithId = [
  { type: 'message_start', message: { id: 'msg_SYN_1', role: 'assistant' } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'World' } },
  { type: 'content_block_stop', index: 1 },
];

const typedNoId = [
  { type: 'message_start', message: { role: 'assistant' } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Alpha' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Beta' } },
  { type: 'content_block_stop', index: 1 },
];

function run(events) {
  const a = new DeltaAssembler();
  for (const e of events) a.apply(e);
  return a;
}

test('typed-events with message_start id gives "<id>:<index>" keys on every block', () => {
  const a = run(typedWithId);
  const blocks = a.blocks();
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].key, 'msg_SYN_1:0');
  assert.equal(blocks[1].key, 'msg_SYN_1:1');
  assert.equal(blocks[0].text, 'Hello');
  assert.equal(blocks[1].text, 'World');
  assert.equal(a.doc.meta.messageId, 'msg_SYN_1');
});

test('typed-events with message id also accepts a top-level id on message_start', () => {
  const a = run([{ type: 'message_start', id: 'msg_TOP' }, ...typedWithId.slice(1)]);
  assert.equal(a.doc.meta.messageId, 'msg_TOP');
  assert.equal(a.blocks()[0].key, 'msg_TOP:0');
});

test('typed-events with no message id gives null keys and no invented meta', () => {
  const a = run(typedNoId);
  const blocks = a.blocks();
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].key, null);
  assert.equal(blocks[1].key, null);
  assert.equal(a.doc.meta, undefined);
  assert.equal(a.messageId, null);
});

test('typed-events with no message_start at all gives null keys', () => {
  const a = run(typedNoId.slice(1));
  assert.deepEqual(a.blocks().map((b) => b.key), [null, null]);
});

test('unindexed text delta after message_start never lands in doc.meta', () => {
  const a = run([
    { type: 'message_start', message: { id: 'msg_SYN_2' } },
    { type: 'content_block_delta', delta: { text: 'hi' } },
  ]);
  assert.equal(a.doc.meta.text, undefined);
  assert.equal(a.doc.meta.messageId, 'msg_SYN_2');
  assert.equal(a.doc.message.text, 'hi');
});

// ---- stream side: path-ops ----------------------------------------------------------------

test('path-ops stream gives JSON-pointer keys for each text part', () => {
  const a = run([
    { p: '/content', o: 'append', v: 'Hel' },
    { v: 'lo' },
    { p: '/meta/title', o: 'replace', v: 'T' },
    { p: '/a~1b', o: 'replace', v: 'slash' },
  ]);
  assert.equal(a.detected.has('path-ops'), true);
  const parts = a.texts();
  const byText = Object.fromEntries(parts.map((p) => [p.text, p]));
  assert.equal(byText.Hello.key, '/content');
  assert.equal(byText.Hello.path, '/content');
  assert.equal(byText.T.key, '/meta/title');
  assert.equal(byText.slash.key, '/a~1b');
  assert.equal(byText.slash.path, '/a/b');
});

test('path-ops texts never invent a key for parts that have no pointer', () => {
  const a = run([{ p: '/x', o: 'replace', v: 'only' }]);
  for (const part of a.texts()) assert.equal(typeof part.key, 'string');
});

// ---- stream side: Responses-style typed events --------------------------------------------

const responsesWithId = [
  { type: 'response.created', response: { id: 'resp_SYN_1', object: 'response', status: 'in_progress', output: [] } },
  { type: 'response.output_item.added', output_index: 0, item: { id: 'item_SYN_1', type: 'message', role: 'assistant', content: [] } },
  { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'Hel' },
  { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'lo' },
  { type: 'response.output_text.done', output_index: 0, content_index: 0, text: 'Hello' },
  { type: 'response.completed', response: { id: 'resp_SYN_1', object: 'response', status: 'completed' } },
];

test('Responses: response.created id gives "<id>:0" for the item and "<id>:0.0" for its text', () => {
  const a = run(responsesWithId);
  const blocks = a.blocks();
  assert.deepEqual(blocks.map((b) => b.index), ['0', '0.0']);
  assert.deepEqual(blocks.map((b) => b.key), ['resp_SYN_1:0', 'resp_SYN_1:0.0']);
  assert.equal(blocks[1].text, 'Hello');
  assert.equal(blocks[1].done, true);
  assert.equal(a.messageIdSource, 'response');
  assert.equal(a.doc.meta.messageId, 'resp_SYN_1');
});

test('Responses: text block exposes parentIndex "0"; item block and Claude-style indexes get null', () => {
  const a = run(responsesWithId);
  const [item, text] = a.blocks();
  assert.equal(text.parentIndex, '0');
  assert.equal(item.parentIndex, null);
  assert.deepEqual(run(typedWithId).blocks().map((b) => b.parentIndex), [null, null]);
});

test('Responses: no response id and no item_id gives null keys (nothing invented)', () => {
  const a = run([
    { type: 'response.created', response: { object: 'response', status: 'in_progress' } },
    { type: 'response.output_item.added', output_index: 0, item: { id: 'item_SYN_3', type: 'message' } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'Nope' },
  ]);
  assert.deepEqual(a.blocks().map((b) => b.key), [null, null]);
  assert.equal(a.messageId, null);
  assert.equal(a.doc.meta, undefined);
});

test('Responses: an empty-string response id is not usable and gives null keys', () => {
  const a = run([
    { type: 'response.created', response: { id: '', status: 'in_progress' } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'x' },
  ]);
  assert.equal(a.blocks()[0].key, null);
});

test('Responses: item_id fallback gives "<item_id>:<index>" only when no response id was seen', () => {
  const a = run([
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: 'item_SYN_2', delta: 'Fallback' },
  ]);
  assert.equal(a.messageIdSource, 'item');
  assert.equal(a.blocks()[0].key, 'item_SYN_2:0.0');
});

test('Responses: a response id seen first wins over item_id on later events', () => {
  const a = run([
    { type: 'response.created', response: { id: 'resp_SYN_4', status: 'in_progress' } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: 'item_SYN_4', delta: 'Win' },
  ]);
  assert.equal(a.messageId, 'resp_SYN_4');
  assert.equal(a.blocks()[0].key, 'resp_SYN_4:0.0');
});

test('Responses: item_id is ignored when a message_start id is already present (Claude-style path unchanged)', () => {
  const a = run([
    { type: 'message_start', message: { id: 'msg_SYN_5' } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: 'item_SYN_5', delta: 'Keep' },
  ]);
  assert.equal(a.messageId, 'msg_SYN_5');
  assert.equal(a.messageIdSource, 'message');
});

// ---- DOM side: page-agent ord ------------------------------------------------------------

function makeEl(tag, attrs, kids) {
  const node = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    attributes: Object.entries(attrs || {}).map(([name, value]) => ({ name, value })),
    childNodes: kids || [],
    className: (attrs && attrs.class) || '',
    getAttribute: (n) => (attrs && n in attrs ? attrs[n] : null),
    hasAttribute: (n) => !!(attrs && n in attrs),
    matches: () => false,
    querySelector: () => null,
    querySelectorAll: () => [],
    closest: () => null,
  };
  Object.defineProperty(node, 'children', { get: () => node.childNodes.filter((c) => c.nodeType === 1) });
  Object.defineProperty(node, 'childElementCount', { get: () => node.children.length });
  Object.defineProperty(node, 'textContent', { get: () => node.childNodes.map((c) => c.textContent).join('') });
  Object.defineProperty(node, 'innerText', { get: () => node.textContent });
  return node;
}
const txt = (s) => ({ nodeType: 3, nodeValue: s, textContent: s });
const P = (s) => makeEl('p', {}, [txt(s)]);

// One assistant turn:
//   <p>Intro</p>
//   <ul><li><p>a</p><p>b</p></li><li><p>c</p></li></ul>
//   <blockquote><p>q1</p><p>q2</p></blockquote>
//   <p>Outro</p>
function fixtureTurn() {
  const turnRoot = makeEl('div', { 'data-author': 'assistant' }, [
    P('Intro'),
    makeEl('ul', {}, [
      makeEl('li', {}, [P('a'), P('b')]),
      makeEl('li', {}, [P('c')]),
    ]),
    makeEl('blockquote', {}, [P('q1'), P('q2')]),
    P('Outro'),
  ]);
  return turnRoot;
}

function descendants(node, out = []) {
  for (const c of node.childNodes) if (c.nodeType === 1) { out.push(c); descendants(c, out); }
  return out;
}

// Clone out of the vm realm so array prototypes match this module's (deepStrictEqual is realm-sensitive).
function assistantBlocks(cap) {
  const turn = JSON.parse(JSON.stringify(cap.turns())).find((t) => t.role === 'assistant');
  assert.ok(turn, 'assistant turn detected');
  return turn.blocks;
}

function loadPageAgent() {
  // Two role-tagged turns so the generic turn detector reports them (it needs >= 2 candidates).
  const userTurn = makeEl('div', { 'data-author': 'user' }, [P('Question')]);
  const body = makeEl('body', {}, [fixtureTurn(), userTurn]);
  const messages = [];
  const sandbox = {
    __aionBind: (s) => messages.push(s),
    setInterval: () => 0,
    clearTimeout: () => {},
    setTimeout: () => 0,
    addEventListener: () => {},
    MutationObserver: class { constructor() {} observe() {} disconnect() {} },
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
  // Same wrapping as src/capture/dom.mjs: strip the trailing ';' and invoke with (BINDING, CONFIG).
  const src = pageAgentSrc.trim().replace(/;\s*$/, '') + '("__aionBind", {})';
  const result = vm.runInContext(src, sandbox);
  assert.equal(result, 'started');
  return sandbox.__aionCapture;
}

test('page-agent emits consecutive ord for top-level blocks of a turn', () => {
  const cap = loadPageAgent();
  assert.equal(cap.turns().length, 2);
  const top = assistantBlocks(cap);
  assert.deepEqual(top.map((b) => b.type), ['paragraph', 'list', 'quote', 'paragraph']);
  assert.deepEqual(top.map((b) => b.ord), [0, 1, 2, 3]);
});

test('page-agent nested blocks restart ord at 0 under their parent', () => {
  const cap = loadPageAgent();
  const top = assistantBlocks(cap);
  const list = top[1];
  assert.deepEqual(list.items[0].blocks.map((b) => b.ord), [0, 1]);
  assert.deepEqual(list.items[1].blocks.map((b) => b.ord), [0]);
  const quote = top[2];
  assert.deepEqual(quote.blocks.map((b) => b.ord), [0, 1]);
});

test('page-agent keeps existing block fields intact next to ord', () => {
  const cap = loadPageAgent();
  const p = assistantBlocks(cap)[0];
  assert.equal(p.type, 'paragraph');
  assert.equal(p.text, 'Intro');
  assert.equal(typeof p.id, 'number');
  assert.ok(Array.isArray(p.inline));
});

// ---- DOM side: dom.mjs pass-through ------------------------------------------------------

test('dom.mjs turns() passes ord through unchanged and does not drop it', async () => {
  const obs = new DomObserver({ append: () => {}, profile: { capture: {} } });
  obs.privacy = capturePrivacy({ capture: {} }, {});
  obs._evalInMain = async () => ({
    value: [{
      index: 0, id: 'synthetic-1', domId: 7, role: 'assistant', text: 'Intro a b c',
      blocks: [
        { type: 'paragraph', id: 1, ord: 0, text: 'Intro', inline: [{ t: 'text', text: 'Intro' }] },
        { type: 'list', id: 2, ord: 1, items: [{ id: 3, blocks: [{ type: 'paragraph', id: 4, ord: 0, text: 'a', inline: [] }] }] },
      ],
    }],
  });
  const turns = await obs.turns();
  assert.deepEqual(turns[0].blocks.map((b) => b.ord), [0, 1]);
  assert.equal(turns[0].blocks[1].items[0].blocks[0].ord, 0);
  assert.equal(turns[0].blocks[0].text, 'Intro');
});

// ---- ChatGPT-style snapshot id (found by QA native-shape fidelity) ----
test('snapshot frame with message.id gives the assembler a message id without touching doc.meta', () => {
  const a = new DeltaAssembler();
  a.apply({ message: { id: 'msg-snap-1', author: { role: 'assistant' }, content: { parts: [''] } }, conversation_id: 'c1' });
  assert.equal(a.messageId, 'msg-snap-1');
  assert.equal(a.messageIdSource, 'snapshot');
  assert.equal(a.doc.meta, undefined, 'snapshot documents are the site content: no meta key is injected');
});

test('snapshot id never overrides an id from message_start, and absent ids stay null', () => {
  const b = new DeltaAssembler();
  b.apply({ type: 'message_start', message: { id: 'msg-start-1' } });
  b.apply({ message: { id: 'msg-snap-2' }, a: 1, b: 2, c: 3 });
  assert.equal(b.messageId, 'msg-start-1');
  const c = new DeltaAssembler();
  c.apply({ message: { author: 'x' }, other: 1 });
  assert.equal(c.messageId, null);
  assert.equal(c.messageIdSource, null);
});

// ---- reply ranking: identifiers must never outrank a short reply (found by the acceptance lane) ----
test('texts() ranks reply content before identifiers even when the id is longer than the reply (typed events)', () => {
  const a = new DeltaAssembler();
  a.apply({ type: 'message_start', message: { id: 'msg_0123456789abcdef0123456789abcdef', model: 'claude-synthetic-model-with-a-long-name', role: 'assistant' } });
  a.apply({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  a.apply({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Sure!' } });
  const t = a.texts(1);
  assert.equal(t[0].text, 'Sure!');
  assert.equal(a.primaryText(), 'Sure!');
  // metadata leaves are still reported, only demoted
  assert.ok(t.some((x) => x.path === '/meta/messageId'));
  assert.ok(t.some((x) => x.path === '/message/id'));
  assert.ok(t.some((x) => x.path === '/message/model'));
});

test('texts() ranks reply content before identifiers (path-ops snapshot with a long message id)', () => {
  const a = new DeltaAssembler();
  a.apply({ message: { id: 'syn-msg-chatgpt-with-a-very-long-identifier-0001', author: { role: 'assistant' }, content: { content_type: 'text', parts: [''] }, status: 'in_progress' }, conversation_id: 'syn-conv-0001' });
  a.apply({ p: '/message/content/parts/0', o: 'append', v: 'Hi.' });
  const t = a.texts(1);
  assert.equal(t[0].text, 'Hi.');
  assert.equal(a.primaryText(), 'Hi.');
});

test('texts() still orders content leaves by length and keeps every leaf', () => {
  const a = new DeltaAssembler();
  a.apply({ type: 'message_start', message: { id: 'm1' } });
  a.apply({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  a.apply({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'short' } });
  a.apply({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } });
  a.apply({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'a much longer second block of text' } });
  const content = a.texts(1).filter((x) => x.path.startsWith('/blocks/') && x.path.endsWith('/text'));
  assert.deepEqual(content.map((x) => x.text), ['a much longer second block of text', 'short']);
});
