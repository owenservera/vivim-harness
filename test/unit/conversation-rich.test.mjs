import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { boundTranscript, transcriptExpression } from '../../src/capture/conversation-thread.mjs';
import { boundRichParts, RICH_PART_KINDS } from '../../src/capture/conversation-rich.mjs';

const element = (tag, value = '', attrs = {}) => ({
  tagName: tag, innerText: value, textContent: value, className: attrs.className ?? '',
  parentElement: attrs.parentElement ?? null, getAttribute: (key) => attrs[key] ?? null,
  hasAttribute: (key) => Object.hasOwn(attrs, key),
  getBoundingClientRect: () => ({ width: 30, height: 30 }),
  contains: () => false, compareDocumentPosition: () => 4,
  querySelector: () => null, querySelectorAll: () => [],
});

function rendered({ busy = false } = {}) {
  const effects = [];
  const code = element('PRE'); code.querySelector = () => element('CODE', 'const x = 2;\n', { className: 'language-js' });
  const row = element('TR'), table = element('TABLE');
  row.querySelectorAll = () => [element('TH', 'Name'), element('TD', 'Value')];
  table.querySelectorAll = () => [row];
  const root = element('ARTICLE', 'The answer is 2.');
  root.querySelectorAll = () => [
    element('LI', 'First', { parentElement: element('OL') }), code, table,
    element('BLOCKQUOTE', 'Quoted'), element('A', 'Docs', { href: 'https://docs.example/path?private=token#secret' }),
    element('A', 'Unsafe', { href: 'javascript:alert(1)' }), element('IMG', '', { alt: 'diagram', src: 'blob:private' }),
    element('MATH', 'x=2', { 'data-math': 'x=2' }),
  ];
  const composer = element('TEXTAREA', 'private unsent draft');
  Object.assign(composer, { value: 'private unsent draft', focus: () => effects.push('focus') });
  const groups = {
    '.assistant-test': [root], '.composer-test': [composer],
    '.send-test': busy ? [] : [element('BUTTON', 'Send')],
    '.stop-test': busy ? [element('BUTTON', 'Stop')] : [],
  };
  const document = { querySelectorAll: (selector) => groups[selector] ?? [],
    querySelector: (selector) => (groups[selector] ?? [])[0] ?? null };
  const location = { origin: 'https://chatgpt.com',
    href: 'https://chatgpt.com/c/11111111-1111-4111-8111-111111111111',
    pathname: '/c/11111111-1111-4111-8111-111111111111' };
  const expression = transcriptExpression({ assistantSelectors: ['.assistant-test'], userSelectors: [],
    composerSelectors: ['.composer-test'], sendSelectors: ['.send-test'], streamingSelectors: ['.stop-test'] });
  const result = vm.runInNewContext(expression, { document, location, URL,
    getComputedStyle: () => ({ overflowY: 'visible' }) });
  return { result, effects };
}

test('live Read shape observation preserves code, tables, lists, quotes, links, math and images', () => {
  const { result, effects } = rendered();
  const output = boundTranscript(result, { maxMessages: 10, maxChars: 1000 });
  const message = output.messages[0];
  const parts = message.parts;
  assert.deepEqual(Array.from(parts, x => x.type), ['list-item', 'code', 'table', 'blockquote', 'link', 'image', 'math']);
  assert.equal(parts[0].ordered, true);
  assert.equal(parts[1].language, 'js');
  assert.equal(parts[1].text, 'const x = 2;\n');
  assert.equal(parts[2].rows[0][0].header, true);
  assert.equal(parts[2].rows[0][1].text, 'Value');
  assert.equal(parts[4].href, 'https://docs.example/path');
  assert.equal(parts[4].hrefSanitized, true);
  assert.equal(parts[5].alt, 'diagram');
  assert.equal(parts[6].latex, 'x=2');
  assert.equal(output.controls.state, 'idle');
  assert.equal(output.coverage.complete, false);
  assert.equal(message.partsCoverage.complete, false);
  assert.equal(JSON.stringify(output).includes('private unsent draft'), false);
  assert.deepEqual(effects, []);
});

test('Read controls distinguish visible generation from positive idle proof', () => {
  const busy = boundTranscript(rendered({ busy: true }).result);
  assert.equal(busy.controls.state, 'busy');
  assert.equal(busy.controls.stopPresent, true);
  const missing = boundTranscript({ messages: [] });
  assert.equal(missing.controls.state, 'unknown');
  assert.equal(missing.controls.observed, false);
});

test('maxChars and hostile shape inputs cannot bypass the transcript boundary', () => {
  const original = rendered().result;
  const short = boundTranscript(original, { maxMessages: 3, maxChars: 5, perMessageCap: 5 });
  assert.equal(short.messages[0].truncated, true);
  assert.deepEqual(short.messages[0].parts, []);
  assert.equal(short.messages[0].partsCoverage.excludedForTruncatedText, true);
  assert.equal(boundRichParts([{ type: 'script', text: 'do not run' }, { type: 'code', text: 'safe' }],
    { completeText: true, maxChars: 100 }).parts.length, 1);
  assert.equal(RICH_PART_KINDS.includes('script'), false);
});
