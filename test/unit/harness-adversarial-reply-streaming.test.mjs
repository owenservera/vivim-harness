// Adversarial: reply streaming attribution and persisted-observation amplification.
// Offline fixture only (fake Recorder/CDP/page). No browser, no provider, no network.
//
// Findings encoded here (exact source lines):
//  F10 src/capture/conversation-browser-adapter.mjs:193-205,511  sampleReply() is called on EVERY
//      reply poll and unconditionally persists a full observation (kind 'reply-sample',
//      recordConversationObservation) carrying the ENTIRE current reply text - even when the content
//      did not change since the previous poll. readReply() polls every replyPollMs (default 250ms) for
//      up to replyTimeoutMs (default 120s), so one 8 KB reply can persist ~480 identical full-text
//      records (~4 MB) and a changing reply persists each cumulative prefix (roughly n^2/2 bytes).
//      The journal's recordReply() de-duplicates equal revisions, but the raw capture log does not.
//  F11 src/capture/conversation-browser-adapter.mjs:508  readReply() re-checks the prefix but never
//      re-checks "no extra user message after this turn's own", which observation() does (line 185).
//      A duplicated/extra user message therefore makes readReply poll to timeout and return
//      state 'unknown' instead of an explicit boundary refusal; reconcile() then returns null.
//  F12 src/capture/conversation-browser-adapter.mjs:195  a mid-stream assistant id swap is refused
//      with REPLY_IDENTITY_CHANGED (good fail-closed behaviour, kept under regression here).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAdversarialFixture, msg, IDLE } from '../fixtures/harness-adversarial-adapter.mjs';

const PROMPT = 'adversarial prompt';
const replyRecords = (f) => f.observations.filter((o) => o.kind === 'reply-sample');

// Instantiating a fixture drives a real adapter through connect -> arm -> preflight -> type -> submit.
async function oneDeliveredTurn(t, options = {}) {
  const f = createAdversarialFixture({ replyTimeoutMs: 5000, replySettleMs: 60000, replySettlePolls: 1, ...options });
  t.after(async () => { try { await f.adapter.stop?.(); } catch {} });
  await f.sendTurn('turn-1', PROMPT);
  assert.equal(f.calls.filter((c) => c[0] === 'send').length, 1, 'exactly one dispatch attempt');
  const baseline = f.getMessages().slice();
  assert.equal(baseline.at(-1).id, 'u-new', 'the delivered user turn is attributed at submit time');
  return { f, baseline };
}

test('F10: a steady reply persists one full-text observation per poll (no change detection)', async (t) => {
  const { f, baseline } = await oneDeliveredTurn(t);
  const steady = 'steady reply text '.repeat(40).trim();
  f.setMessages([...baseline, msg('a-new', 'assistant', steady)]);
  const before = f.getReadTurnCalls();
  let polls = 0;
  f.setOnPoll(() => { polls = f.getReadTurnCalls() - before; if (polls >= 8) f.adapter.stopWaiting(); });
  const result = await f.adapter.readReply(null, f.args('turn-1', PROMPT));
  assert.equal(result.state, 'interrupted', 'stopWaiting is the deterministic poll bound');

  const records = replyRecords(f);
  assert.equal(records.length, polls, 'exactly one persisted observation per reply poll');
  assert.ok(records.length >= 8, `expected >=8 polls, saw ${records.length}`);
  assert.equal(new Set(records.map((r) => r.record.text)).size, 1, 'every record carries the identical full text');
  assert.equal(new Set(records.map((r) => r.record.contentDigest)).size, 1);
  assert.equal(new Set(records.map((r) => r.record.revision)).size, 1);
  assert.equal(new Set(records.map((r) => r.sequence)).size, records.length, 'sequences stay unique');
  const single = records[0].bytes, total = records.reduce((n, r) => n + r.bytes, 0);
  t.diagnostic(`steady reply: ${records.length} records x ${steady.length} chars = ${total}B persisted for one logical reply (${(total / single).toFixed(1)}x amplification)`);
  assert.ok(total > single * 7, 'the same reply content is written once per poll');
  assert.equal(f.calls.filter((c) => c[0] === 'send').length, 1, 'polling never re-sends');
});

test('F10: a growing reply persists every cumulative prefix (super-linear bytes)', async (t) => {
  const { f, baseline } = await oneDeliveredTurn(t);
  const chunk = 'x'.repeat(200);
  let text = chunk;
  f.setMessages([...baseline, msg('a-new', 'assistant', text)]);
  const before = f.getReadTurnCalls();
  let polls = 0;
  // Each poll grows the reply, so each poll must both persist and bump the revision.
  f.setOnPoll(() => {
    polls = f.getReadTurnCalls() - before;
    if (polls >= 9) { f.adapter.stopWaiting(); return; }
    text += chunk;
    f.setMessages([...baseline, msg('a-new', 'assistant', text)]);
  });
  await f.adapter.readReply(() => {}, f.args('turn-1', PROMPT));

  const records = replyRecords(f);
  const revisions = records.map((r) => r.record.revision);
  assert.deepEqual(revisions, [...revisions].sort((a, b) => a - b), 'revisions never regress');
  assert.ok(new Set(revisions).size >= 5, `distinct streaming revisions observed: ${new Set(revisions).size}`);
  const lengths = records.map((r) => r.chars);
  const persisted = lengths.reduce((a, b) => a + b, 0);
  const finalLength = lengths.at(-1);
  t.diagnostic(`streaming: ${records.length} records, final ${finalLength} chars, ${persisted} chars persisted (${(persisted / finalLength).toFixed(1)}x)`);
  assert.ok(persisted > finalLength * 3, 'cumulative prefixes cost far more than the final reply');
  assert.equal(f.calls.filter((c) => c[0] === 'send').length, 1, 'streaming never re-sends');
});

test('F12: an assistant identity swap mid-stream is refused, not silently re-attributed', async (t) => {
  const { f, baseline } = await oneDeliveredTurn(t);
  let text = 'first chunk';
  f.setMessages([...baseline, msg('a-new', 'assistant', text)]);
  const before = f.getReadTurnCalls();
  f.setOnPoll(() => {
    const polls = f.getReadTurnCalls() - before;
    if (polls === 3) f.setMessages([...baseline, msg('a-swapped', 'assistant', `${text} more`)]);
    if (polls >= 8) f.adapter.stopWaiting();
  });
  await assert.rejects(() => f.adapter.readReply(null, f.args('turn-1', PROMPT)),
    (e) => e.code === 'REPLY_IDENTITY_CHANGED', 'identity swap must fail closed');
  assert.equal(f.calls.filter((c) => c[0] === 'send').length, 1);
});

test('F11: an extra user message after this turn is a silent timeout, not an explicit refusal', async (t) => {
  const { f, baseline } = await oneDeliveredTurn(t);
  // A duplicated user node after the turn's own message: observation() refuses this shape outright
  // (line 185), but readReply() has no equivalent check.
  f.setMessages([...baseline, msg('u-dup', 'user', PROMPT), msg('a-new', 'assistant', 'unrelated reply')]);
  const before = f.getReadTurnCalls();
  f.setOnPoll(() => { if (f.getReadTurnCalls() - before >= 6) f.adapter.stopWaiting(); });
  const result = await f.adapter.readReply(null, f.args('turn-1', PROMPT));
  assert.equal(result.state, 'interrupted');
  assert.equal(replyRecords(f).length, 0, 'no reply was attributed to the turn');
  // Reconcile has the stricter shape check, so it refuses attribution (null), never guesses.
  assert.equal(await f.adapter.reconcile(f.args('turn-1', PROMPT)), null);
  // Delivery evidence was already durable and is not retracted by the ambiguity.
  assert.equal(f.observations.filter((o) => o.kind === 'new-user-turn').length, 1);
  t.diagnostic('readReply has no explicit "extra user message" refusal: it times out with state unknown');
});

test('readReply guards: wrong payload digest and unarmed capture cannot attribute', async (t) => {
  const { f } = await oneDeliveredTurn(t);
  await assert.rejects(() => f.adapter.readReply(null, { ...f.args('turn-1', PROMPT), payloadDigest: 'f'.repeat(64) }),
    (e) => e.code === 'ATTRIBUTABLE_DELIVERY_REQUIRED');
  await assert.rejects(() => f.adapter.readReply(null, f.args('turn-missing', PROMPT)),
    (e) => e.code === 'ATTRIBUTABLE_DELIVERY_REQUIRED');
  // A busy control state is never published as ready even after settlement.
  const baseline = f.getMessages().slice();
  f.setMessages([...baseline, msg('a-new', 'assistant', 'settled text')]);
  f.setControls({ ...IDLE, stopPresent: true, state: 'busy' });
  const before = f.getReadTurnCalls();
  f.setOnPoll(() => { if (f.getReadTurnCalls() - before >= 6) f.adapter.stopWaiting(); });
  const result = await f.adapter.readReply(null, f.args('turn-1', PROMPT));
  assert.equal(result.state, 'interrupted', 'busy controls never yield ready');
  assert.equal(f.observations.some((o) => o.kind === 'interactive-ready'), false);
});
