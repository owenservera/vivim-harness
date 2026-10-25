// Issue #84 Round C: genuine multi-turn attribution at the real browser-adapter seam. Offline fixtures only:
// fake Recorder, fake CDP helpers and a scripted page transcript. No browser, no provider, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createConversationBrowserAdapter, turnCursor } from '../../src/capture/conversation-browser-adapter.mjs';

const sha = (v) => createHash('sha256').update(v).digest('hex');
const THREAD_ID = '11111111-1111-4111-8111-111111111111';
const THREAD = { kind: 'chatgpt-c', id: THREAD_ID, ref: `chatgpt-c:${THREAD_ID}` };
const IDLE = { observed: true, state: 'idle', idleControlPresent: true, stopPresent: false, composerEnabled: true };
const msg = (id, role, text) => ({ id, role, text });

function fixture({ startAt = 10, overrides = {} } = {}) {
  const calls = [], records = [];
  let messages = [msg('u0', 'user', 'first prompt'), msg('a0', 'assistant', 'first answer')];
  let draft = '', pathname = `/c/${THREAD_ID}`, sessions = 0, composer = true;
  const store = new Map();
  class FakeRecorder {
    constructor() { calls.push(['recorder']); this.state = 'idle'; this.page = { send: async (method) => { calls.push([method]); return {}; } }; }
    on() {}
    tap() { return { close() {} }; }
    async start(options) {
      sessions++;
      this.session = { id: `session-${sessions}`, raw: { seq: startAt, stats: { bytes: 1 } }, kv: { set: (k, v) => store.set(k, v) } };
      options.onSessionCreated(this.session); this.state = 'recording'; return this.session;
    }
    recordConversationObservation(record) { records.push(record); return ++this.session.raw.seq; }
    async stop() { calls.push(['stop']); this.state = 'idle'; return { verify: { ok: true } }; }
  }
  const binding = { targetId: 'selected', origin: 'https://chatgpt.com', ownedByStudio: false, thread: THREAD };
  const adapter = createConversationBrowserAdapter({ paths: { sessions: 'unused' }, profileStore: { load: () => ({}) }, port: 19222,
    siteAdapter: { id: 'chatgpt', url: 'https://chatgpt.com/' }, targetId: 'selected', freshTab: false, conversationId: 'conv', ownerToken: 'owner',
    dependencies: { Recorder: FakeRecorder, listSessions: () => [], replyPollMs: 1, replyTimeoutMs: 40, replySettleMs: 0, checkAgainTimeoutMs: 5, readinessPollMs: 1, sleep: async () => {},
      listTargets: async () => [{ id: 'selected', url: `https://chatgpt.com${pathname}` }],
      evaluate: async (_, expression) => expression === 'location.pathname' ? pathname : 'https://chatgpt.com',
      findComposer: async () => ({ found: composer }), focusComposer: async () => ({ ok: true }), tracePage: (m) => calls.push([m]),
      readTurnPage: async () => ({ origin: 'https://chatgpt.com', pathname, messages: structuredClone(messages), draft: { text: draft, chars: draft.length }, controls: IDLE }),
      sendState: async () => ({ evalOk: true, draftChars: draft.length }),
      typeText: async (_, prompt, options) => { await options.beforeInsert(); calls.push(['type', prompt]); draft = prompt; return { ok: true, typed: prompt }; },
      sendMessage: async () => { calls.push(['send']); draft = ''; return { uncertain: true }; }, // the real page empties its composer on send
      detectAuthWall: async () => ({ blocked: false }), detectSiteFailure: async () => ({ failed: false }), ...overrides } });
  const hooks = { bind() {}, ownSession(id) { calls.push(['own-session', id]); } };
  const digestOf = (prompt) => sha(prompt);
  return { adapter, binding, calls, records, hooks, digestOf, store,
    setMessages: (v) => { messages = v; }, getMessages: () => messages, setPathname: (v) => { pathname = v; }, setComposer: (v) => { composer = v; },
    clearDraft: () => { draft = ''; },
    async connectAndArm() { await adapter.connect({ ...binding }, hooks); return adapter.armCapture(); },
    // Drives one turn up to (not including) the reply: preflight -> type -> submit.
    async sendTurn(turnId, prompt, priorTurns = []) {
      const preflight = await adapter.preflight(undefined, { priorTurns });
      await adapter.type({ prompt, turnId });
      await adapter.submit({ turnId, payloadDigest: digestOf(prompt) });
      return preflight;
    },
    args: (turnId, prompt) => ({ binding: { ...binding }, turnId, payloadDigest: digestOf(prompt) }),
  };
}

test('turn cursor records count, role split, ordered ids, content digest and the stream cursor (metadata only)', () => {
  const a = turnCursor([msg('u0', 'user', 'x'), msg('a0', 'assistant', 'y')], 10);
  assert.equal(a.messageCount, 2); assert.equal(a.userCount, 1); assert.equal(a.assistantCount, 1); assert.equal(a.streamSequence, 10);
  assert.match(a.idsDigest, /^[a-f0-9]{64}$/); assert.match(a.contentDigest, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(a).includes('"x"'), false, 'no message bodies');
  const edited = turnCursor([msg('u0', 'user', 'x'), msg('a0', 'assistant', 'EDITED')], 10);
  assert.equal(edited.idsDigest, a.idsDigest); assert.notEqual(edited.contentDigest, a.contentDigest);
  assert.notEqual(turnCursor([msg('u0', 'user', 'x'), msg('a9', 'assistant', 'y')], 10).idsDigest, a.idsDigest);
  assert.deepEqual(turnCursor(null, 3), turnCursor([], 3));
});

test('preflight returns a per-turn cursor from the existing page and the prior stream cursor', async () => {
  const f = fixture(); await f.connectAndArm();
  const preflight = await f.adapter.preflight(undefined, { priorTurns: [] });
  assert.deepEqual(preflight.cursor, turnCursor(f.getMessages(), preflight.boundary.sequence));
  assert.equal(preflight.cursor.messageCount, 2); assert.equal(preflight.boundary.transcriptCount, 2);
  await f.adapter.stop();
});

test('identical text repeated across turns: only the NEW user message is attributed; the old one never is', async () => {
  const f = fixture(); await f.connectAndArm();
  const turn = 'turn-2', prompt = 'first prompt'; // same text as the already-present user turn u0
  await f.adapter.preflight(undefined, { priorTurns: [] }); await f.adapter.type({ prompt, turnId: turn });
  assert.equal(await f.adapter.submit({ turnId: turn, payloadDigest: f.digestOf(prompt) }), null, 'send heuristic alone proves nothing');
  assert.equal(await f.adapter.reconcile(f.args(turn, prompt)), null, 'old identical user message must not be re-attributed');
  assert.equal(f.records.length, 0);
  f.setMessages([...f.getMessages(), msg('u1', 'user', prompt)]);
  const observed = await f.adapter.reconcile(f.args(turn, prompt));
  assert.equal(observed.evidence.identity, 'u1'); assert.notEqual(observed.evidence.identity, 'u0');
  await f.adapter.stop();
});

test('a duplicate user message appearing twice is not attributable (ambiguous, fails closed)', async () => {
  const f = fixture(); await f.connectAndArm();
  await f.adapter.preflight(undefined, { priorTurns: [] }); await f.adapter.type({ prompt: 'again', turnId: 't' });
  f.setMessages([...f.getMessages(), msg('u1', 'user', 'again'), msg('u2', 'user', 'again')]);
  assert.equal(await f.adapter.reconcile(f.args('t', 'again')), null);
  await f.adapter.stop();
});

test('stale last-assistant message: an old reply with identical text is never attributed to the new turn', async () => {
  const f = fixture(); await f.connectAndArm();
  const prompt = 'second prompt';
  await f.sendTurn('turn-2', prompt);
  f.setMessages([...f.getMessages(), msg('u1', 'user', prompt)]); // new user shown, reply not yet rendered
  await f.adapter.reconcile(f.args('turn-2', prompt));
  const updates = [];
  const result = await f.adapter.readReply((u) => updates.push(u), { turnId: 'turn-2', payloadDigest: f.digestOf(prompt), threadKey: 'k' });
  assert.equal(result.state, 'unknown'); assert.equal(updates.length, 0, 'the stale a0 reply was not published');
  assert.equal(result.text, '');
  await f.adapter.stop();
});

test('a reply that finished before the baseline is excluded even when the new reply has identical text', async () => {
  const f = fixture(); await f.connectAndArm();
  const prompt = 'second prompt';
  await f.sendTurn('turn-2', prompt);
  f.setMessages([...f.getMessages(), msg('u1', 'user', prompt), msg('a1', 'assistant', 'first answer')]);
  await f.adapter.reconcile(f.args('turn-2', prompt));
  const updates = [];
  const result = await f.adapter.readReply((u) => updates.push(u), { turnId: 'turn-2', payloadDigest: f.digestOf(prompt), threadKey: 'k' });
  assert.equal(result.evidence.identity, 'a1'); assert.notEqual(result.evidence.identity, 'a0');
  assert.ok(updates.every((u) => u.evidence.identity === 'a1'));
  await f.adapter.stop();
});

test('regenerate/edit of an earlier reply while waiting is never attributed to the new turn', async () => {
  const f = fixture(); await f.connectAndArm();
  const prompt = 'second prompt';
  await f.sendTurn('turn-2', prompt);
  // The earlier assistant message is regenerated (same id, new text) and a "new" reply appears after the new user turn.
  f.setMessages([msg('u0', 'user', 'first prompt'), msg('a0', 'assistant', 'REGENERATED'), msg('u1', 'user', prompt), msg('a1', 'assistant', 'second answer')]);
  await assert.rejects(f.adapter.reconcile(f.args('turn-2', prompt)).then((o) => o ?? Promise.reject(new Error('NO_OBSERVATION'))), /NO_OBSERVATION/, 'prefix changed: no delivery evidence either');
  await assert.rejects(f.adapter.readReply(() => {}, { turnId: 'turn-2', payloadDigest: f.digestOf(prompt), threadKey: 'k' }), /ATTRIBUTABLE_DELIVERY_REQUIRED/);
  await f.adapter.stop();
});

test('history rewritten after delivery is refused mid-reply with TURN_BOUNDARY_CHANGED', async () => {
  const f = fixture(); await f.connectAndArm();
  const prompt = 'second prompt';
  await f.sendTurn('turn-2', prompt);
  f.setMessages([...f.getMessages(), msg('u1', 'user', prompt)]);
  assert.ok(await f.adapter.reconcile(f.args('turn-2', prompt)));
  f.setMessages([msg('u0', 'user', 'first prompt'), msg('a0', 'assistant', 'REGENERATED'), msg('u1', 'user', prompt), msg('a1', 'assistant', 'second answer')]);
  await assert.rejects(f.adapter.readReply(() => {}, { turnId: 'turn-2', payloadDigest: f.digestOf(prompt), threadKey: 'k' }), /TURN_BOUNDARY_CHANGED/);
  await f.adapter.stop();
});

test('an earlier user message edited/branched away blocks the next turn before anything is typed', async () => {
  const f = fixture(); await f.connectAndArm();
  const prior = { id: 'turn-1', delivery: { state: 'observed', evidence: { kind: 'new-user-turn', source: 'page', identity: 'u0' } }, reply: { state: 'unknown' } };
  f.setMessages([msg('u0-edited', 'user', 'first prompt EDITED'), msg('a0-new', 'assistant', 'other answer')]);
  await assert.rejects(f.adapter.preflight(undefined, { priorTurns: [prior] }), (e) => e.code === 'THREAD_CHANGED_BETWEEN_TURNS');
  assert.equal(f.calls.some(([n]) => n === 'type' || n === 'send'), false);
  assert.ok(f.records.some((r) => r.kind === 'prior-turn-missing' && r.turnIds.includes('turn-1')));
  await f.adapter.stop();
});

test('an earlier reply changed between turns invalidates it instead of silently reusing it', async () => {
  const f = fixture(); await f.connectAndArm();
  const prior = { id: 'turn-1', delivery: { state: 'observed', evidence: { kind: 'new-user-turn', source: 'page', identity: 'u0' } },
    reply: { state: 'observed', evidence: { identity: 'a0', contentDigest: sha('first answer'), chars: 'first answer'.length } } };
  assert.equal((await f.adapter.preflight(undefined, { priorTurns: [prior] })).ready, true, 'unchanged history is fine');
  f.setMessages([msg('u0', 'user', 'first prompt'), msg('a0', 'assistant', 'regenerated answer')]);
  await assert.rejects(f.adapter.preflight(undefined, { priorTurns: [prior] }), (e) => e.code === 'PRIOR_REPLY_CHANGED' && e.invalidatedTurnIds?.includes('turn-1'));
  assert.equal(f.calls.some(([n]) => n === 'type' || n === 'send'), false);
  await f.adapter.stop();
});

test('native thread changed between turns: preflight and typing are refused with BINDING_CHANGED', async () => {
  const f = fixture(); await f.connectAndArm();
  assert.equal((await f.adapter.preflight(undefined, { priorTurns: [] })).ready, true);
  f.setPathname('/c/22222222-2222-4222-8222-222222222222');
  await assert.rejects(f.adapter.preflight(undefined, { priorTurns: [] }), /BINDING_CHANGED/);
  await assert.rejects(f.adapter.type({ prompt: 'x', turnId: 't' }), /BINDING_CHANGED/);
  assert.equal(f.calls.some(([n]) => n === 'type' || n === 'send'), false);
  await f.adapter.stop();
});

test('each turn arms its own capture session; turn 2 is attributed in its own session and never reuses turn 1 evidence', async () => {
  const f = fixture();
  const session1 = await f.connectAndArm(); assert.equal(session1, 'session-1');
  await f.sendTurn('turn-1', 'one');
  f.setMessages([...f.getMessages(), msg('u1', 'user', 'one'), msg('a1', 'assistant', 'answer one')]);
  const first = await f.adapter.reconcile(f.args('turn-1', 'one'));
  assert.equal(first.evidence.sessionId, 'session-1');
  await f.adapter.stopTurnCapture();
  const session2 = await f.adapter.armCapture(); assert.equal(session2, 'session-2');
  await f.sendTurn('turn-2', 'two');
  f.setMessages([...f.getMessages(), msg('u2', 'user', 'two')]);
  const second = await f.adapter.reconcile(f.args('turn-2', 'two'));
  assert.equal(second.evidence.sessionId, 'session-2'); assert.equal(second.evidence.identity, 'u2'); assert.notEqual(second.evidence.identity, first.evidence.identity);
  // Turn 1 evidence cannot be replayed under turn 2.
  assert.equal(await f.adapter.reconcile({ ...f.args('turn-2', 'one') }), null);
  await f.adapter.stop();
});

test('read-only readiness check with no armed capture constructs no recorder and does not type or send', async () => {
  const f = fixture();
  await f.adapter.connect({ ...f.binding }, f.hooks); // deferred idle connect: nothing armed
  const before = f.calls.length;
  const ok = await f.adapter.preflight(undefined, { readOnly: true });
  assert.equal(ok.ready, true); assert.equal(ok.readOnly, true); assert.deepEqual(ok.draft, { present: false, chars: 0 });
  f.setComposer(false);
  const blocked = await f.adapter.preflight(undefined, { readOnly: true });
  assert.equal(blocked.ready, false); assert.equal(blocked.reason, 'READINESS_TIMEOUT');
  f.setComposer(true); f.setPathname('/c/22222222-2222-4222-8222-222222222222');
  assert.equal((await f.adapter.preflight(undefined, { readOnly: true })).reason, 'BINDING_CHANGED');
  assert.equal(f.calls.slice(before).some(([n]) => ['recorder', 'type', 'send', 'own-session', 'Page.bringToFront'].includes(n)), false);
  await f.adapter.stop();
});

// Regression for the measured 49-char premature completion: ChatGPT renders a table header,
// reports an idle send control between chunks, then adds the rows later. Two fast identical
// samples must not be enough.
const HEADER = 'ChatGPT said:\nInput Output\nBound Applied';
const RICH = `${HEADER}\n\n| Bound | Applied |\n| --- | --- |\n| 10 | yes |\n| 20 | yes |\n| 30 | yes |\nThe rows above show three bound values.`;
const BUSY = { observed: true, state: 'busy', idleControlPresent: false, stopPresent: true, composerEnabled: false };

function replyFixture(t, { rowsAt = 5, controls = () => IDLE, settleMs = 1600 } = {}) {
  const clock = { t: 0 };
  const script = { polls: 0, messages: [msg('u0', 'user', 'first prompt'), msg('a0', 'assistant', 'first answer')],
    showReply: false, rowsAt, controls, draft: '', phase: 'send' };
  const f = fixture({ overrides: {
    readTurnPage: async () => { script.polls++;
      const messages = structuredClone(script.messages);
      if (script.showReply) messages.push(msg('a1', 'assistant', script.polls >= script.rowsAt ? RICH : HEADER));
      return { origin: 'https://chatgpt.com', pathname: `/c/${THREAD_ID}`, messages,
        draft: { text: script.draft, chars: script.draft.length }, controls: structuredClone(script.controls()) }; },
    typeText: async (_, prompt, options) => { await options.beforeInsert(); script.draft = prompt; return { ok: true, typed: prompt }; },
    sendState: async () => ({ evalOk: true, draftChars: script.draft.length }),
    sendMessage: async () => { script.draft = ''; return { dispatched: true }; },
    sleep: async () => { clock.t += 400; }, now: () => clock.t,
    replySettleMs: settleMs, replyTimeoutMs: 60000, replyPollMs: 1,
  } });
  return { f, script, clock };
}

test('delayed table rows after an early idle header are never published as ready (real quiet window)', async (t) => {
  const { f, script } = replyFixture(t, { rowsAt: 5 });
  await f.connectAndArm();
  const prompt = 'table prompt';
  await f.sendTurn('turn-table', prompt);
  script.messages = [...script.messages, msg('u1', 'user', prompt)];
  await f.adapter.reconcile(f.args('turn-table', prompt));
  script.polls = 0; script.showReply = true; script.phase = 'reply';
  const updates = [];
  const result = await f.adapter.readReply((u) => updates.push(u), { turnId: 'turn-table', payloadDigest: f.digestOf(prompt), threadKey: 'k' });
  assert.equal(result.state, 'ready');
  assert.equal(result.text, RICH, 'rows and the explanatory sentence are kept');
  assert.equal(result.evidence.chars, RICH.length);
  assert.ok(updates.some((u) => u.state === 'streaming' && u.text === HEADER), 'the early header was observed but not finalized');
  assert.equal(updates.filter((u) => u.state === 'ready').length, 1);
  assert.equal(updates.find((u) => u.state === 'ready').text, RICH);
  assert.equal(updates.some((u) => u.state === 'ready' && u.text === HEADER), false, 'no ready checkpoint on the header');
  await f.adapter.stop();
});

test('idle control transition after stable content still has to complete the quiet window', async (t) => {
  const { f, script, clock } = replyFixture(t, { rowsAt: 1, controls: () => (script.phase !== 'reply' || script.polls >= 6 ? IDLE : BUSY) });
  await f.connectAndArm();
  const prompt = 'late idle prompt';
  await f.sendTurn('turn-idle', prompt);
  script.messages = [...script.messages, msg('u1', 'user', prompt)];
  await f.adapter.reconcile(f.args('turn-idle', prompt));
  script.showReply = true; script.polls = 0; script.phase = 'reply';
  const updates = [];
  const result = await f.adapter.readReply((u) => updates.push(u), { turnId: 'turn-idle', payloadDigest: f.digestOf(prompt), threadKey: 'k' });
  assert.equal(result.state, 'ready'); assert.equal(result.text, RICH);
  const ready = updates.filter((u) => u.state === 'ready');
  assert.equal(ready.length, 1); assert.equal(ready[0].text, RICH);
  assert.equal(ready[0].readiness.controls.state, 'idle');
  assert.equal(updates.some((u) => u.state === 'ready' && u.readiness.controls.state !== 'idle'), false);
  assert.ok(updates.filter((u) => u.state === 'streaming').length >= 4, 'busy controls kept the reply streaming, not ready');
  assert.ok(clock.t >= 3600, 'the 1600ms quiet window starts when idle is first observed at 2000ms, not during generation');
  await f.adapter.stop();
});

test('a busy control between idle samples restarts the entire reply quiet window', async (t) => {
  const { f, script, clock } = replyFixture(t, { rowsAt: 1, controls: () => script.phase === 'reply' && script.polls === 3 ? BUSY : IDLE });
  await f.connectAndArm();
  const prompt = 'interrupted idle prompt';
  await f.sendTurn('turn-interrupted-idle', prompt);
  script.messages = [...script.messages, msg('u1', 'user', prompt)];
  await f.adapter.reconcile(f.args('turn-interrupted-idle', prompt));
  script.showReply = true; script.polls = 0; script.phase = 'reply';
  const result = await f.adapter.readReply(() => {}, { turnId: 'turn-interrupted-idle', payloadDigest: f.digestOf(prompt), threadKey: 'k' });
  assert.equal(result.state, 'ready'); assert.equal(result.text, RICH);
  assert.ok(clock.t >= 2800, 'busy at 800ms breaks continuity; idle resumes at 1200ms and must remain quiet for 1600ms');
  await f.adapter.stop();
});
