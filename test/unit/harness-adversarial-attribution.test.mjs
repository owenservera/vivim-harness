// Adversarial: multi-turn source attribution primitives (no browser, deterministic).
//
// Findings encoded here (exact source lines):
//  F5: cursor IDs must use an unambiguous canonical field encoding.\n//  F6 src/capture/conversation-thread.mjs:50-75  turnObservationExpression() returns the FULL text
//     of every rendered message, unbounded, while the read-only transcriptExpression() (lines 77-117)
//     applies CAP and SCAN. readReply() (adapter lines 504-527) calls pageState() every replyPollMs,
//     so per-poll cost and CDP payload grow with the whole conversation, not with the last turn.
import test from 'node:test';
import assert from 'node:assert/strict';
import { turnCursor } from '../../src/capture/conversation-browser-adapter.mjs';
import { boundTranscript, transcriptExpression, turnObservationExpression } from '../../src/capture/conversation-thread.mjs';

const msg = (id, role, text) => ({ id, role, text });
const sha64 = /^[a-f0-9]{64}$/;

test('F5: turnCursor is metadata-only, order-sensitive and role-sensitive', () => {
  const a = turnCursor([msg('u0', 'user', 'hello'), msg('a0', 'assistant', 'hi')], 12);
  assert.equal(a.messageCount, 2); assert.equal(a.userCount, 1); assert.equal(a.assistantCount, 1);
  assert.equal(a.streamSequence, 12); assert.match(a.idsDigest, sha64); assert.match(a.contentDigest, sha64);
  assert.equal(JSON.stringify(a).includes('hello'), false);
  // Order and role both move identity; a swapped pair is a different transcript.
  assert.notEqual(turnCursor([msg('a0', 'assistant', 'hi'), msg('u0', 'user', 'hello')], 12).idsDigest, a.idsDigest);
  assert.notEqual(turnCursor([msg('u0', 'assistant', 'hello'), msg('a0', 'assistant', 'hi')], 12).idsDigest, a.idsDigest);
  // Text edits move content only; id edits move identity only.
  assert.equal(turnCursor([msg('u0', 'user', 'HELLO'), msg('a0', 'assistant', 'hi')], 12).idsDigest, a.idsDigest);
  assert.notEqual(turnCursor([msg('u0', 'user', 'HELLO'), msg('a0', 'assistant', 'hi')], 12).contentDigest, a.contentDigest);
  // Empty, null and non-array inputs are the same cursor, with any stream sequence preserved.
  assert.deepEqual(turnCursor(null, 3), turnCursor([], 3));
  assert.equal(turnCursor(undefined, 0).messageCount, 0);
});

test('F5: cursor digest distinguishes newline IDs, different counts and missing ID', () => {
  const oneMessageWithNewline = turnCursor([msg('a\\nassistant:b', 'user', 'one')], 1);
  const twoMessages = turnCursor([msg('a', 'user', 'one'), msg('b', 'assistant', '')], 1);
  assert.notEqual(oneMessageWithNewline.idsDigest, twoMessages.idsDigest);
  assert.notEqual(oneMessageWithNewline.contentDigest, twoMessages.contentDigest);
  assert.notEqual(turnCursor([msg(undefined, 'user', 'x')], 1).idsDigest,
    turnCursor([msg('undefined', 'user', 'x')], 1).idsDigest);
  assert.notEqual(turnCursor([msg('a:b', 'user', 'one')], 1).idsDigest,
    turnCursor([msg('a', 'user:b', 'one')], 1).idsDigest);
});

test('F6: the reply-poll observation is unbounded while the read-only transcript is capped', () => {
  const observation = turnObservationExpression({ composer: { selectors: [] }, assistant: { streamingSelectors: [] }, send: { buttonSelectors: [] } });
  const transcript = transcriptExpression({});
  assert.match(transcript, /CAP = \d+/, 'transcriptExpression caps per-message chars');
  assert.match(transcript, /SCAN = \d+/, 'transcriptExpression caps scanned messages');
  assert.equal(/const CAP =/.test(observation), false, 'turn observation has no per-message cap');
  assert.equal(/\.slice\(/.test(observation), false, 'turn observation never truncates message text');
  assert.match(observation, /text:String\(el\.innerText\?\?el\.textContent\?\?''\)/,
    'every poll returns the full rendered text of every message');
});

test('F6: measured cursor cost and payload grow with the whole transcript (per poll, 4 Hz)', (t) => {
  const build = (n, chars) => Array.from({ length: n }, (_, i) => msg(`m-${i}`, i % 2 ? 'assistant' : 'user', 'x'.repeat(chars)));
  const cases = [[40, 2000], [100, 5000], [200, 20000]];
  const measured = [];
  for (const [n, chars] of cases) {
    const messages = build(n, chars);
    const started = performance.now();
    for (let i = 0; i < 5; i++) turnCursor(messages, 1);
    const perCall = (performance.now() - started) / 5;
    measured.push({ n, chars, perCallMs: +perCall.toFixed(2), payloadBytes: JSON.stringify(messages).length });
  }
  for (const row of measured) t.diagnostic(`turnCursor ${row.n}x${row.chars} chars: ${row.perCallMs}ms, payload ${row.payloadBytes}B`);
  // The payload assertion is deterministic: no cap means a long chat ships multi-MB per poll.
  assert.ok(measured[2].payloadBytes > 3_500_000, 'a 200-message/20k-char chat is >3.5MB per poll');
  assert.ok(measured[1].payloadBytes > 500_000, 'a 100-message/5k-char chat is >500KB per poll');
  // Generous wall-clock ceiling only as a regression tripwire (measured ~2ms and ~11ms here).
  assert.ok(measured[1].perCallMs < 250, `turnCursor 100x5000 took ${measured[1].perCallMs}ms`);
  assert.ok(measured[2].perCallMs < 750, `turnCursor 200x20000 took ${measured[2].perCallMs}ms`);
});

test('boundTranscript: exact byte budget, tail truncation and honest omission counts', () => {
  const raw = { renderedTotal: 3, messages: [
    { role: 'user', text: 'aaaa', chars: 4 },
    { role: 'assistant', text: 'bbbbbb', chars: 6 },
    { role: 'assistant', text: 'cc', chars: 2 },
  ] };
  const one = boundTranscript(raw, { maxChars: 1, perMessageCap: 20000 });
  assert.equal(one.messages.length, 1);
  assert.deepEqual(one.messages[0], { index: 2, role: 'assistant', text: 'c', chars: 2, truncated: true });
  assert.equal(one.coverage.returnedMessages, 1); assert.equal(one.coverage.omittedMessages, 2);
  assert.equal(one.coverage.omittedChars, 4 + 6 + 1, 'omittedChars includes the truncated tail');
  assert.equal(one.coverage.truncatedMessages, 1);

  const exact = boundTranscript(raw, { maxChars: 12 });
  assert.deepEqual(exact.messages.map((m) => m.text), ['aaaa', 'bbbbbb', 'cc']);
  assert.equal(exact.coverage.omittedChars, 0); assert.equal(exact.coverage.truncatedMessages, 0);

  const budgetStops = boundTranscript(raw, { maxChars: 7 });
  assert.deepEqual(budgetStops.messages.map((m) => m.text), ['bbbbb', 'cc'],
    'newest messages are kept first, then the budget clamps the older one');
  assert.equal(budgetStops.coverage.omittedChars, 4 + 1);

  const many = boundTranscript(raw, { maxMessages: 2 });
  assert.deepEqual(many.messages.map((m) => m.index), [1, 2], 'maxMessages keeps the newest window');
  assert.equal(many.coverage.omittedMessages, 1);
});

test('boundTranscript: index offsets, invalid entries and garbage input fail closed', () => {
  const scrolled = boundTranscript({ renderedTotal: 9, messages: [{ role: 'user', text: 'z', chars: 1 }] }, { maxChars: 10 });
  assert.equal(scrolled.messages[0].index, 8, 'index is reconstructed from renderedTotal - source.length');
  assert.equal(scrolled.coverage.renderedMessages, 9);
  // renderedTotal smaller than the returned slice is clamped, never negative.
  const clamped = boundTranscript({ renderedTotal: 1, messages: [{ role: 'user', text: 'z', chars: 1 }] }, {});
  assert.equal(clamped.coverage.renderedMessages, 1); assert.equal(clamped.coverage.omittedMessages, 0);

  const invalid = boundTranscript({ renderedTotal: 4, messages: [
    { role: 'system', text: 'x', chars: 0 }, { role: 'user', text: 'abc', chars: 2 }, { role: 'user', text: 5, chars: 1 },
    { role: 'assistant', text: 'ok', chars: 2 },
  ] }, { maxChars: 100 });
  assert.deepEqual(invalid.messages.map((m) => m.text), ['ok']);
  assert.equal(invalid.coverage.invalidMessages, 3);
  assert.equal(invalid.coverage.omittedMessages, 3, 'invalid entries are omitted, never silently counted as returned');

  assert.deepEqual(boundTranscript({}, {}).messages, []);
  assert.deepEqual(boundTranscript(null, {}).coverage.present, undefined);
  assert.equal(boundTranscript({ messages: 'nope' }, {}).coverage.renderedMessages, 0);
});

test('boundTranscript: coverage never claims completeness and draft text is length-only', () => {
  const withScroll = boundTranscript({
    renderedTotal: 2, messages: [{ role: 'user', text: 'a', chars: 1 }, { role: 'assistant', text: 'b', chars: 1 }],
    scroll: { found: true, topReached: false, bottomReached: true },
    draft: { present: true, chars: 3 }, hiddenSkipped: -1, nestedDropped: 1.5, ambiguousSkipped: 'x',
  }, {});
  assert.equal(withScroll.coverage.complete, false);
  assert.equal(withScroll.coverage.scope, 'currently-rendered-messages');
  assert.equal(withScroll.coverage.preAttachHistory, 'not-captured-by-this-read');
  assert.equal(withScroll.coverage.olderHistory, 'older-unrendered-likely');
  assert.equal(withScroll.coverage.newerHistory, 'bottom-reached');
  assert.deepEqual(withScroll.draft, { present: true, chars: 3 });
  // Negative/float/string counters are normalized to 0, never passed through.
  assert.equal(withScroll.coverage.hiddenSkipped, 0);
  assert.equal(withScroll.coverage.nestedDropped, 0);
  assert.equal(withScroll.coverage.ambiguousSkipped, 0);
  // A malformed draft is unknown, not "empty".
  assert.deepEqual(boundTranscript({ draft: { present: 'yes', chars: -1 } }, {}).draft, { present: null, chars: null });
  assert.deepEqual(boundTranscript({ scroll: { found: false } }, {}).coverage.olderHistory, 'unknown');
});
