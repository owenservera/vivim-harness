// Unit tests for the verified stream-to-DOM join (src/intel/join.mjs). Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { joinStreamToDom, normalizeForJoin } from '../../src/intel/join.mjs';
import { NEAR_THRESHOLD, normalizeRole } from '../../src/intel/join.mjs';
import { readFileSync } from 'node:fs';

const msg = (o) => ({ key: null, messageId: null, role: 'assistant', text: '', final: true, blocks: [], ...o });
const turn = (o) => ({ index: 0, id: null, domId: null, role: 'assistant', text: '', blocks: [], ...o });
const linkAt = (r, messageIndex) => r.links.find((l) => l.messageIndex === messageIndex);
const domOnly = (r, turnIndex) => r.links.find((l) => l.messageIndex === null && l.turnIndex === turnIndex);

test('normalizeForJoin strips common markdown markers, unifies smart quotes and collapses whitespace', () => {
  assert.equal(normalizeForJoin('## Title\n- **bold** and `code`\n> quoted'), 'title bold and code quoted');
  assert.equal(normalizeForJoin('It\u2019s \u201Cfine\u201D'), 'it\'s "fine"');
  assert.equal(normalizeForJoin(undefined), '');
});

test('verified happy path: three alternating turns, markdown in stream and plain text in DOM', () => {
  const r = joinStreamToDom({
    messages: [
      msg({ key: 'm1:0', messageId: 'm1', role: 'user', text: 'Hello **there**, friend.' }),
      msg({ key: 'm2:0', messageId: 'm2', role: 'assistant', text: '## Harbour notes\n- lamp is lit\n- tide is `high`' }),
      msg({ key: 'm3:0', messageId: 'm3', role: 'user', text: 'Thanks \u201Ca lot\u201D.' }),
    ],
    turns: [
      turn({ index: 0, id: 't0', domId: 'd0', role: 'user', text: 'Hello there, friend.' }),
      turn({ index: 1, id: 't1', domId: 'd1', role: 'assistant', text: 'Harbour notes lamp is lit tide is high' }),
      turn({ index: 2, id: 't2', domId: 'd2', role: 'user', text: 'Thanks "a lot".' }),
    ],
  });
  assert.equal(r.links.length, 3);
  r.links.forEach((l, i) => {
    assert.equal(l.status, 'verified');
    assert.equal(l.textMatch, 'exact');
    assert.equal(l.turnIndex, i);
    assert.equal(l.evidence.rule, 'order+text');
  });
  assert.equal(r.links[1].turnId, 't1');
  assert.equal(r.links[1].domId, 'd1');
  assert.equal(r.summary.messageStatus.verified, 3);
  assert.equal(r.summary.rules['order+text'], 3);
});

test('partial: a streaming prefix of the rendered text, and an exact but non-final stream', () => {
  const prefix = joinStreamToDom({
    messages: [msg({ key: 's:0', messageId: 's', role: 'assistant', text: 'The lighthouse is', final: false })],
    turns: [turn({ index: 0, role: 'assistant', text: 'The lighthouse is lit every night.' })],
  });
  assert.equal(prefix.links[0].status, 'partial');
  assert.equal(prefix.links[0].textMatch, 'prefix');
  assert.equal(prefix.links[0].turnIndex, 0);
  assert.ok(prefix.links[0].evidence.notes.includes('stream_not_final'));

  const open = joinStreamToDom({
    messages: [msg({ key: 's:1', messageId: 's', role: 'assistant', text: 'Same text.', final: false })],
    turns: [turn({ index: 0, role: 'assistant', text: 'Same text.' })],
  });
  assert.equal(open.links[0].status, 'partial');
  assert.equal(open.links[0].textMatch, 'exact');
});

test('text_mismatch: aligned by order, text differs, nothing forced', () => {
  const r = joinStreamToDom({
    messages: [msg({ key: 'x:0', messageId: 'x', role: 'user', text: 'Hi there' })],
    turns: [turn({ index: 0, role: 'user', text: 'Completely different words' })],
  });
  assert.equal(r.links[0].status, 'text_mismatch');
  assert.equal(r.links[0].textMatch, 'differs');
  assert.equal(r.links[0].turnIndex, 0);
});

test('identical duplicate turns with an earlier mismatch are ambiguous, not forced', () => {
  const r = joinStreamToDom({
    messages: [
      msg({ key: 'a:0', messageId: 'a', role: 'assistant', text: 'Other reply.' }),
      msg({ key: 'a:1', messageId: 'a', role: 'assistant', text: 'Same reply.' }),
    ],
    turns: [
      turn({ index: 0, role: 'assistant', text: 'Same reply.' }),
      turn({ index: 1, role: 'assistant', text: 'Same reply.' }),
    ],
  });
  assert.equal(linkAt(r, 0).status, 'text_mismatch');
  const amb = linkAt(r, 1);
  assert.equal(amb.status, 'ambiguous');
  assert.equal(amb.turnIndex, null);
  assert.equal(amb.textMatch, 'none');
  assert.deepEqual(amb.evidence.candidates, [0, 1]);
  // The second duplicate is not claimed by anyone, so it is reported as an unlinked DOM turn.
  assert.equal(domOnly(r, 1).evidence.candidateOf[0], 1);
});

test('identical duplicate turns resolve by ordinal only when all earlier messages are aligned', () => {
  const r = joinStreamToDom({
    messages: [
      msg({ key: 'a:0', messageId: 'a', role: 'assistant', text: 'Same reply.' }),
      msg({ key: 'a:1', messageId: 'a', role: 'assistant', text: 'Same reply.' }),
    ],
    turns: [
      turn({ index: 0, role: 'assistant', text: 'Same reply.' }),
      turn({ index: 1, role: 'assistant', text: 'Same reply.' }),
    ],
  });
  assert.equal(linkAt(r, 0).status, 'verified');
  assert.equal(linkAt(r, 0).evidence.rule, 'ordinal');
  assert.equal(linkAt(r, 1).status, 'verified');
  assert.equal(linkAt(r, 1).turnIndex, 1);
  assert.equal(linkAt(r, 1).evidence.rule, 'ordinal');
});

test('identical duplicate turns with counts differing are ambiguous (text only, no ordering)', () => {
  const r = joinStreamToDom({
    messages: [msg({ key: 'x:0', messageId: 'x', role: 'assistant', text: 'Same reply.' })],
    turns: [
      turn({ index: 0, role: 'assistant', text: 'Same reply.' }),
      turn({ index: 1, role: 'assistant', text: 'Same reply.' }),
      turn({ index: 2, role: 'user', text: 'Question.' }),
    ],
  });
  const l = linkAt(r, 0);
  assert.equal(l.status, 'ambiguous');
  assert.equal(l.turnIndex, null);
  assert.equal(l.evidence.rule, 'text-only');
  assert.equal(l.evidence.ordering, 'text');
  assert.deepEqual(l.evidence.candidates, [0, 1]);
});

test('counts differ, stream message with no DOM turn -> unlinked_stream; text-free DOM turns stay unlinked', () => {
  const r = joinStreamToDom({
    messages: [
      msg({ key: 'q:0', messageId: 'q', role: 'user', text: 'Q1' }),
      msg({ key: 'a:0', messageId: 'a', role: 'assistant', text: 'A1' }),
      msg({ key: 'q:1', messageId: 'q', role: 'user', text: 'Q2' }),
    ],
    turns: [
      turn({ index: 0, role: 'user', text: 'Q1' }),
      turn({ index: 1, role: 'assistant', text: 'A1' }),
    ],
  });
  assert.equal(linkAt(r, 0).status, 'verified');
  assert.equal(linkAt(r, 1).status, 'verified');
  const orphan = linkAt(r, 2);
  assert.equal(orphan.status, 'unlinked_stream');
  assert.equal(orphan.turnIndex, null);
  assert.equal(orphan.evidence.rule, null);
  assert.equal(r.summary.messageStatus.unlinked_stream, 1);
});

test('counts differ, extra DOM turn -> unlinked_dom; a stream message is never forced onto a non-matching turn', () => {
  const extra = joinStreamToDom({
    messages: [msg({ key: 'q:0', messageId: 'q', role: 'user', text: 'Q1' })],
    turns: [turn({ index: 0, role: 'user', text: 'Q1' }), turn({ index: 1, role: 'assistant', text: 'Extra reply' })],
  });
  assert.equal(linkAt(extra, 0).status, 'verified');
  const d = domOnly(extra, 1);
  assert.equal(d.status, 'unlinked_dom');
  assert.equal(d.messageKey, null);

  const forced = joinStreamToDom({
    messages: [msg({ key: 'q:9', messageId: 'q', role: 'user', text: 'Q9' })],
    turns: [turn({ index: 0, role: 'user', text: 'Q1' }), turn({ index: 1, role: 'user', text: 'Q2' })],
  });
  assert.equal(linkAt(forced, 0).status, 'unlinked_stream');
  assert.equal(forced.summary.messageStatus.unlinked_dom, 2);
});

test('block-level: matching counts link stream block index to DOM ord with compatible types', () => {
  const r = joinStreamToDom({
    messages: [msg({
      key: 'b:0', messageId: 'b', role: 'assistant', text: 'Intro line\n- one\n- two',
      blocks: [
        { key: 'b:0', index: 0, type: 'paragraph', text: 'Intro line' },
        { key: 'b:1', index: 1, type: 'list', text: '- one\n- two' },
      ],
    })],
    turns: [turn({
      index: 0, role: 'assistant', text: 'Intro line one two',
      blocks: [
        { ord: 0, type: 'paragraph', text: 'Intro line' },
        { ord: 1, type: 'list', text: 'one two' },
      ],
    })],
  });
  const l = linkAt(r, 0);
  assert.equal(l.status, 'verified');
  assert.equal(l.blockLinks.length, 2);
  assert.deepEqual(l.blockLinks.map((b) => [b.blockKey, b.ord, b.status, b.textMatch]), [
    ['b:0', 0, 'verified', 'exact'],
    ['b:1', 1, 'verified', 'exact'],
  ]);
  assert.equal(l.blockLinks[0].evidence.rule, 'order+text');
  assert.equal(r.summary.blockStatus.verified, 2);
});

test('block-level: counts disagree -> no ordinal link; incompatible type -> not linked', () => {
  const disagree = joinStreamToDom({
    messages: [msg({
      key: 'c:0', messageId: 'c', role: 'assistant', text: 'One two',
      blocks: [{ key: 'c:0', index: 0, type: 'paragraph', text: 'One' }, { key: 'c:1', index: 1, type: 'paragraph', text: 'two' }],
    })],
    turns: [turn({ index: 0, role: 'assistant', text: 'One two', blocks: [{ ord: 0, type: 'paragraph', text: 'One two' }] })],
  });
  const l = linkAt(disagree, 0);
  assert.equal(l.status, 'verified');
  assert.ok(l.blockLinks.every((b) => b.ord === null || b.status.startsWith('unlinked')));
  assert.ok(l.blockLinks.every((b) => b.status !== 'verified' && b.status !== 'partial'));
  assert.equal(l.blockLinks.filter((b) => b.status === 'unlinked_stream').length, 2);

  const typed = joinStreamToDom({
    messages: [msg({ key: 'd:0', messageId: 'd', role: 'assistant', text: 'print one', blocks: [{ key: 'd:0', index: 0, type: 'code', text: 'print one' }] })],
    turns: [turn({ index: 0, role: 'assistant', text: 'print one', blocks: [{ ord: 0, type: 'table', text: 'print one' }] })],
  });
  assert.equal(linkAt(typed, 0).blockLinks[0].status, 'unlinked_stream');
  assert.equal(linkAt(typed, 0).blockLinks[0].evidence.rule, null);
});

test('null message keys still join by text and report evidence rule text-only', () => {
  const r = joinStreamToDom({
    messages: [msg({ key: null, messageId: null, role: 'user', text: 'Plain question' })],
    turns: [turn({ index: 0, role: 'user', text: 'Plain question' })],
  });
  assert.equal(r.links[0].status, 'verified');
  assert.equal(r.links[0].textMatch, 'exact');
  assert.equal(r.links[0].messageKey, null);
  assert.equal(r.links[0].evidence.rule, 'text-only');
  assert.equal(r.summary.rules['text-only'], 1);
});

test('determinism: the same input gives deep-equal output and the input is not mutated', () => {
  const input = () => ({
    messages: [
      msg({ key: 'k:0', messageId: 'k', role: 'user', text: 'Hi **there**' }),
      msg({ key: 'k:1', messageId: 'k', role: 'assistant', text: 'Same reply.' }),
      msg({ key: 'k:2', messageId: 'k', role: 'assistant', text: 'Same reply.', final: false }),
    ],
    turns: [
      turn({ index: 0, role: 'user', text: 'Hi there' }),
      turn({ index: 1, role: 'assistant', text: 'Same reply.' }),
      turn({ index: 2, role: 'assistant', text: 'Same reply.' }),
    ],
  });
  const a = input();
  const snapshot = JSON.stringify(a);
  const first = joinStreamToDom(a);
  const second = joinStreamToDom(input());
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(JSON.stringify(a), snapshot);
});

test('empty inputs produce no links and zero counts', () => {
  for (const r of [joinStreamToDom({ messages: [], turns: [] }), joinStreamToDom()]) {
    assert.deepEqual(r.links, []);
    assert.equal(r.summary.messages, 0);
    assert.equal(r.summary.turns, 0);
    assert.ok(Object.values(r.summary.messageStatus).every((n) => n === 0));
    assert.ok(Object.values(r.summary.rules).every((n) => n === 0));
  }
});

// ---- roles ----

test('normalizeRole: synonyms and extras map to canonical roles; unknown roles stay lowercased', () => {
  for (const r of ['user', 'human', 'me', 'customer', 'HUMAN', ' Human ']) assert.equal(normalizeRole(r), 'user', r);
  for (const r of ['assistant', 'ai', 'model', 'bot', 'chatgpt', 'claude', 'gemini']) assert.equal(normalizeRole(r), 'assistant', r);
  assert.equal(normalizeRole('system'), 'system');
  for (const r of ['tool', 'function']) assert.equal(normalizeRole(r), 'tool', r);
  assert.equal(normalizeRole('Wizard '), 'wizard');
  assert.equal(normalizeRole(undefined), '');
  assert.equal(normalizeRole('constructor'), 'constructor');
});

test('normalizeRole mirrors families/ai-chat.json: every declared synonym and hint is handled identically', () => {
  const family = JSON.parse(readFileSync(new URL('../../families/ai-chat.json', import.meta.url), 'utf8'));
  const field = family.entities.message.fields.role;
  const canonical = new Set(field.values);
  assert.deepEqual([...canonical].sort(), ['assistant', 'system', 'tool', 'user']);
  for (const [from, to] of Object.entries(field.normalize)) {
    assert.equal(normalizeRole(from), to, `synonym ${from}`);
    assert.equal(normalizeRole(from.toUpperCase()), to, `case-insensitive ${from}`);
  }
  for (const v of field.values) assert.equal(normalizeRole(v), v, `canonical ${v}`);
  for (const h of field.valueHints) assert.ok(canonical.has(normalizeRole(h)), `hint ${h}`);
  const pairs = family.detect.find((d) => d.signal === 'role_pair').pairs.flat();
  const enumVals = family.detect.find((d) => d.signal === 'enum_field').values;
  for (const r of [...pairs, ...enumVals]) assert.ok(canonical.has(normalizeRole(r)), `detect ${r}`);
});

test('roles are normalized on both sides: stream human/ai link to DOM user/model', () => {
  const r = joinStreamToDom({
    messages: [
      msg({ key: 'r:0', messageId: 'r', role: 'human', text: 'Ping?' }),
      msg({ key: 'r:1', messageId: 'r', role: 'ai', text: 'Pong.' }),
    ],
    turns: [
      turn({ index: 0, id: 'u0', role: 'user', text: 'Ping?' }),
      turn({ index: 1, id: 'm1', role: 'model', text: 'Pong.' }),
    ],
  });
  assert.equal(linkAt(r, 0).status, 'verified');
  assert.equal(linkAt(r, 0).role, 'user');
  assert.equal(linkAt(r, 0).turnIndex, 0);
  assert.equal(linkAt(r, 1).status, 'verified');
  assert.equal(linkAt(r, 1).role, 'assistant');
  assert.equal(linkAt(r, 1).turnId, 'm1');
  assert.equal(r.summary.messageStatus.verified, 2);
});

test('an unknown role is not forced onto another role', () => {
  const r = joinStreamToDom({
    messages: [msg({ key: 'w:0', messageId: 'w', role: 'Wizard', text: 'Spell' })],
    turns: [turn({ index: 0, role: 'assistant', text: 'Spell' })],
  });
  assert.equal(linkAt(r, 0).status, 'unlinked_stream');
  assert.equal(linkAt(r, 0).role, 'wizard');
  assert.equal(domOnly(r, 0).status, 'unlinked_dom');
});

// ---- normalization rules: each with a realistic sample and a false-positive sample ----

test('normalizeForJoin: inline, image, reference links reduce to label text; false positive kept', () => {
  assert.equal(normalizeForJoin('See [the setup guide](https://example.com/setup) and [the FAQ][faq-1] first.'), 'see the setup guide and the faq first.');
  assert.equal(normalizeForJoin('Here: ![Revenue by quarter](https://cdn.example.com/q.png) today.'), 'here: revenue by quarter today.');
  // Subscript-like call syntax is not a link: no whitespace/word boundary before "[".
  assert.equal(normalizeForJoin('Call handlers[key](event) inside the loop.'), 'call handlers[key](event) inside the loop.');
  // Two bracketed numbers are citations, not reference links (label has no letters).
  assert.equal(normalizeForJoin('matrix[1][2] is zero'), 'matrix[1][2] is zero');
});

test('normalizeForJoin: autolinks reduce to the URL; a plain tag is not an autolink', () => {
  assert.equal(normalizeForJoin('Source: <https://example.com/a?b=1&c=2> noted.'), 'source: https://example.com/a?b=1&c=2 noted.');
  assert.equal(normalizeForJoin('Cross the <bridge> at dawn.'), 'cross the <bridge> at dawn.');
});

test('normalizeForJoin: HTML entities decode exactly once; bare ampersand kept', () => {
  assert.equal(normalizeForJoin('Tom &amp; Jerry &lt;3 &quot;hi&quot; &#39;ok&#39; &#x41;B'), 'tom & jerry <3 "hi" \'ok\' ab');
  assert.equal(normalizeForJoin('It&#8217;s a&nbsp;b'), "it's a b");
  assert.equal(normalizeForJoin('AT&amp;amp;T'), 'at&amp;t');
  assert.equal(normalizeForJoin('Q&A and R&D'), 'q&a and r&d');
});

test('normalizeForJoin: citation markers removed; bracketed values in code-like prose kept', () => {
  assert.equal(
    normalizeForJoin('The bridge opened in 1937 [1] and was repaired.[12] Crews worked [3].'),
    'the bridge opened in 1937 and was repaired. crews worked.',
  );
  assert.equal(normalizeForJoin('Claims hold.[^2] Sales rose 4% 【3†source】 this quarter.'), 'claims hold. sales rose 4% this quarter.');
  // matrix[1] has no space before the bracket; f(a, [1]) is followed by ")"; x = [1] follows "=".
  assert.equal(
    normalizeForJoin('Set matrix[1] and matrix[2][3]; call f(a, [1]) and x = [1].'),
    'set matrix[1] and matrix[2][3]; call f(a, [1]) and x = [1].',
  );
});

test('normalizeForJoin: table separator rows dropped, remaining pipes become spaces', () => {
  assert.equal(normalizeForJoin('| Name | Score |\n|---|:--:|\n| Ana | 9 |'), 'name score ana 9');
  // A dashed flag without a pipe is not a table row.
  assert.equal(normalizeForJoin('Use --verbose for logs.'), 'use --verbose for logs.');
});

test('normalizeForJoin: horizontal rules removed when alone on a line; dash runs inside text kept', () => {
  assert.equal(normalizeForJoin('Intro line.\n\n---\n\nNext section.\n***\nEnd\n___'), 'intro line. next section. end');
  assert.equal(normalizeForJoin('Wait -- what --- really?'), 'wait -- what --- really?');
});

test('normalizeForJoin: strikethrough markers removed, struck text kept; single tilde kept', () => {
  assert.equal(normalizeForJoin('Use ~~the old tool~~ the new tool.'), 'use the old tool the new tool.');
  assert.equal(normalizeForJoin('It takes ~5 minutes or ~10.'), 'it takes ~5 minutes or ~10.');
});

test('normalizeForJoin: single emphasis around a word run removed; snake_case and math kept', () => {
  assert.equal(normalizeForJoin('It is *really* good and _quite_ nice.'), 'it is really good and quite nice.');
  assert.equal(normalizeForJoin('Compute 2*3*4 and call my_var_name.'), 'compute 2*3*4 and call my_var_name.');
  assert.equal(normalizeForJoin('Use a * b * c here.'), 'use a * b * c here.');
});

test('normalizeForJoin: fence lines and language labels dropped, code body kept; inline triple backticks are not a fence', () => {
  assert.equal(normalizeForJoin('Run this:\n```python\nprint("hi")\n```\nDone.'), 'run this: print("hi") done.');
  assert.equal(normalizeForJoin('Install:\n~~~bash\nls -la\n~~~'), 'install: ls -la');
  assert.equal(normalizeForJoin('Use ```npm i``` to install.'), 'use npm i to install.');
});

test('normalizeForJoin: zero-width and soft-hyphen characters removed; NBSP becomes a space', () => {
  assert.equal(normalizeForJoin('soft\u00ADhy\u200Bphen and zero\u2060width\uFEFF.'), 'softhyphen and zerowidth.');
  assert.equal(normalizeForJoin('a\u00A0b'), 'a b');
});

test('normalizeForJoin: br tags collapse to a space; a tag named bridge is not a br', () => {
  assert.equal(normalizeForJoin('Line one<br>Line two<br/>Line three'), 'line one line two line three');
  assert.equal(normalizeForJoin('Cross the <bridge> at dawn'), 'cross the <bridge> at dawn');
});

// ---- near-match tier ----

// 22 tokens. "is really lit" inserts one token mid-sentence: Dice = 44 / 45 = 0.978 (near).
const NEAR_BASE = 'the lamp in the tower is lit every single night for the sailors who row home past the reef and the rocks';
const NEAR_ONE_EXTRA = NEAR_BASE.replace('is lit', 'is really lit');
// Two replaced words: Dice = 40 / 44 = 0.909 (not near, below the 0.8 ceiling for text-only too).
const NEAR_TWO_CHANGED = NEAR_BASE.replace('sailors', 'pirates').replace('rocks', 'shoals');

test('NEAR_THRESHOLD is 0.95', () => {
  assert.equal(NEAR_THRESHOLD, 0.95);
});

test('near_match positional: one extra token in a long sentence is near, never verified, no block links', () => {
  const r = joinStreamToDom({
    messages: [msg({
      key: 'n:0', messageId: 'n', role: 'assistant', text: NEAR_BASE,
      blocks: [{ key: 'n:0', index: 0, type: 'paragraph', text: NEAR_BASE }],
    })],
    turns: [turn({
      index: 0, id: 'tn', domId: 'dn', role: 'assistant', text: NEAR_ONE_EXTRA,
      blocks: [{ ord: 0, type: 'paragraph', text: NEAR_ONE_EXTRA }],
    })],
  });
  const l = linkAt(r, 0);
  assert.equal(l.status, 'near_match');
  assert.equal(l.textMatch, 'near');
  assert.equal(l.turnIndex, 0);
  assert.equal(l.turnId, 'tn');
  assert.equal(l.domId, 'dn');
  assert.equal(l.evidence.rule, 'order+text');
  assert.equal(l.evidence.ordering, 'position');
  assert.ok(l.evidence.notes.some((n) => n.startsWith('near_match') && n.includes('0.978')), l.evidence.notes.join(' | '));
  assert.deepEqual(l.blockLinks, []);
  assert.equal(r.summary.messageStatus.near_match, 1);
  assert.equal(r.summary.messageStatus.verified, 0);
  assert.equal(r.summary.messageStatus.text_mismatch, 0);
});

test('near_match negative: two replaced words in a long sentence stay text_mismatch', () => {
  const r = joinStreamToDom({
    messages: [msg({ key: 'n:0', messageId: 'n', role: 'assistant', text: NEAR_BASE })],
    turns: [turn({ index: 0, role: 'assistant', text: NEAR_TWO_CHANGED })],
  });
  assert.equal(linkAt(r, 0).status, 'text_mismatch');
  assert.equal(linkAt(r, 0).textMatch, 'differs');
  assert.equal(r.summary.messageStatus.near_match, 0);
});

test('near_match negative: short texts with one changed word are not near (Dice 0.5)', () => {
  const r = joinStreamToDom({
    messages: [msg({ key: 'g:0', messageId: 'g', role: 'assistant', text: 'Go left' })],
    turns: [turn({ index: 0, role: 'assistant', text: 'Go right' })],
  });
  assert.equal(linkAt(r, 0).status, 'text_mismatch');
  assert.equal(linkAt(r, 0).textMatch, 'differs');
});

test('near_match text-only: exactly one near free turn and the rest far below 0.8 links as near', () => {
  const r = joinStreamToDom({
    messages: [msg({ key: null, messageId: null, role: 'assistant', text: NEAR_BASE })],
    turns: [
      turn({ index: 0, role: 'assistant', text: 'Something entirely unrelated about boats and gulls' }),
      turn({ index: 1, id: 't1', role: 'assistant', text: NEAR_ONE_EXTRA }),
    ],
  });
  const l = linkAt(r, 0);
  assert.equal(l.status, 'near_match');
  assert.equal(l.textMatch, 'near');
  assert.equal(l.turnIndex, 1);
  assert.equal(l.turnId, 't1');
  assert.equal(l.evidence.rule, 'text-only');
  assert.deepEqual(l.evidence.candidates, [1]);
  assert.ok(l.evidence.notes.some((n) => n.includes('exactly one free turn')));
  assert.equal(domOnly(r, 0).status, 'unlinked_dom');
});

test('near_match text-only negative: two near free turns are not decisive', () => {
  const r = joinStreamToDom({
    messages: [msg({ key: null, messageId: null, role: 'assistant', text: NEAR_BASE })],
    turns: [
      turn({ index: 0, role: 'assistant', text: NEAR_BASE.replace('is lit', 'is really lit') }),
      turn({ index: 1, role: 'assistant', text: NEAR_BASE.replace('is lit', 'is truly lit') }),
    ],
  });
  assert.equal(linkAt(r, 0).status, 'unlinked_stream');
  assert.equal(linkAt(r, 0).turnIndex, null);
  assert.ok(linkAt(r, 0).evidence.notes.some((n) => n.includes('not used: 2 free turns')));
});

test('near_match text-only negative: a second free turn in the 0.8..0.95 band blocks the near link', () => {
  const r = joinStreamToDom({
    messages: [msg({ key: null, messageId: null, role: 'assistant', text: NEAR_BASE })],
    turns: [
      turn({ index: 0, role: 'assistant', text: NEAR_ONE_EXTRA }),
      turn({ index: 1, role: 'assistant', text: NEAR_TWO_CHANGED }),
    ],
  });
  assert.equal(linkAt(r, 0).status, 'unlinked_stream');
  assert.equal(linkAt(r, 0).turnIndex, null);
});

test('determinism: near-match, role and normalization output is identical across runs', () => {
  const input = () => ({
    messages: [
      msg({ key: 'z:0', messageId: 'z', role: 'human', text: 'Ping **now**' }),
      msg({ key: 'z:1', messageId: 'z', role: 'ai', text: NEAR_BASE }),
    ],
    turns: [
      turn({ index: 0, role: 'user', text: 'Ping now' }),
      turn({ index: 1, role: 'model', text: NEAR_ONE_EXTRA }),
    ],
  });
  const a = JSON.stringify(joinStreamToDom(input()));
  const b = JSON.stringify(joinStreamToDom(input()));
  assert.equal(a, b);
  assert.equal(normalizeForJoin('See [x](https://a.b) *y* &amp; z'), normalizeForJoin('See [x](https://a.b) *y* &amp; z'));
  assert.equal(linkAt(joinStreamToDom(input()), 1).status, 'near_match');
});

// ---- block pairing by rank, and block finality (found by QA native-shape fidelity) ----
const oneBlockJoin = (index, final = true, text = 'Hello world') => joinStreamToDom({
  messages: [{ key: 'm1', messageId: 'm1', role: 'assistant', text, final,
    blocks: [{ key: 'm1:' + index, index, type: 'paragraph', text }] }],
  turns: [{ index: 0, id: 't0', domId: 'd0', role: 'assistant', text,
    blocks: [{ ord: 0, type: 'paragraph', text }] }],
}).links.find((l) => l.messageKey === 'm1');

test('block pairing is by rank: composite and string stream indexes link to DOM ordinals', () => {
  for (const index of ['0', '0.0', 0, '3']) {
    const l = oneBlockJoin(index);
    assert.equal(l.status, 'verified', 'message index ' + index);
    assert.deepEqual(l.blockLinks.map((b) => [b.ord, b.status]), [[0, 'verified']], 'block index ' + index);
    assert.equal(l.blockLinks[0].evidence.ordering, 'rank');
  }
});

test('non-contiguous stream block indexes pair by rank with ascending DOM ords', () => {
  const r = joinStreamToDom({
    messages: [{ key: 'm1', messageId: 'm1', role: 'assistant', text: 'one two', final: true,
      blocks: [{ key: 'm1:0', index: '0', type: 'paragraph', text: 'one' }, { key: 'm1:2', index: '2', type: 'paragraph', text: 'two' }] }],
    turns: [{ index: 0, id: 't0', domId: 'd0', role: 'assistant', text: 'one two',
      blocks: [{ ord: 0, type: 'paragraph', text: 'one' }, { ord: 1, type: 'paragraph', text: 'two' }] }],
  });
  const l = r.links.find((x) => x.messageKey === 'm1');
  assert.deepEqual(l.blockLinks.map((b) => [b.blockKey, b.ord, b.status]), [['m1:0', 0, 'verified'], ['m1:2', 1, 'verified']]);
});

test('a mispaired block is text_mismatch, never verified', () => {
  const r = joinStreamToDom({
    messages: [{ key: 'm1', messageId: 'm1', role: 'assistant', text: 'one two', final: true,
      blocks: [{ key: 'm1:0', index: '0', type: 'paragraph', text: 'one' }, { key: 'm1:1', index: '1', type: 'paragraph', text: 'two' }] }],
    turns: [{ index: 0, id: 't0', domId: 'd0', role: 'assistant', text: 'one two',
      blocks: [{ ord: 0, type: 'paragraph', text: 'two' }, { ord: 1, type: 'paragraph', text: 'one' }] }],
  });
  const l = r.links.find((x) => x.messageKey === 'm1');
  assert.ok(l.blockLinks.every((b) => b.status !== 'verified'));
});

test('blocks inherit message finality: a non-final stream never yields a verified block', () => {
  const l = oneBlockJoin('0', false);
  assert.equal(l.status, 'partial');
  assert.equal(l.blockLinks[0].status, 'partial');
  assert.ok(l.blockLinks[0].evidence.notes.includes('stream_not_final'));
});
