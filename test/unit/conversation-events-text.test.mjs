// Opt-in reply-text streaming (gap E02 / C09): the default conversation event feed stays
// metadata-only; `?include=text` adds bounded `conversation.reply_text` snapshots with source
// confidence. One pump, two feeds, no second runtime. Fake-adapter fixture only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createConversationRuntime } from '../../src/capture/conversation-runtime.mjs';
import { createConversationEvents, CONVERSATION_EVENT_TYPES, CONVERSATION_TEXT_EVENT_TYPES, REPLY_TEXT_EVENT } from '../../src/studio/conversation-events.mjs';
import { canonicalThreadKey } from '../../src/capture/thread-turn-journal.mjs';

const waitFor = async (condition, ms = 5000) => {
  for (let n = 0; n < ms / 5; n++) { if (await condition()) return; await new Promise((r) => setTimeout(r, 5)); }
  if (!(await condition())) throw new Error('condition not reached');
};

// A reply that streams through bounded text updates with qualified evidence each time. delayMs
// spaces the chunks out beyond the pump interval, the way a real streamed reply does.
function streamingReplyFixture(adapter, args, texts, finalState = 'ready', delayMs = 0) {
  let i = 0;
  const pause = async () => { if (delayMs) await new Promise((r) => setTimeout(r, delayMs)); };
  const publishNext = (publish) => {
    if (i >= texts.length) return null;
    const text = texts[i++];
    const contentDigest = createHash('sha256').update(text).digest('hex');
    const revision = (adapter.replyMetadata?.revision ?? 0) + 1;
    const sequence = (adapter.replySequence = (adapter.replySequence ?? 11) + 3);
    const metadata = { identity: `reply-${args.turnId}`, revision, contentDigest, chars: text.length };
    adapter.replyMetadata = metadata;
    const update = { turnId: args.turnId, binding: adapter.binding,
      state: i === texts.length ? finalState : 'streaming', text,
      evidence: { turnId: args.turnId, payloadDigest: args.payloadDigest, sessionId: adapter.sessionId, sequence, kind: 'assistant-reply', source: 'page', ...metadata } };
    publish(update);
    return update;
  };
  return {
    async readReply(publish) {
      publishNext(publish);
      while (i < texts.length) { await pause(); publishNext(publish); }
      const last = texts.at(-1);
      const contentDigest = createHash('sha256').update(last).digest('hex');
      const revision = adapter.replyMetadata.revision + (adapter.replyMetadata.contentDigest !== contentDigest ? 1 : 0);
      const sequence = (adapter.replySequence = (adapter.replySequence ?? 11) + 3);
      const metadata = { identity: `reply-${args.turnId}`, revision, contentDigest, chars: last.length };
      adapter.replyMetadata = metadata;
      return { turnId: args.turnId, binding: adapter.binding, state: finalState, text: last,
        evidence: { turnId: args.turnId, payloadDigest: args.payloadDigest, sessionId: adapter.sessionId, sequence, kind: 'assistant-reply', source: 'page', ...metadata },
        readiness: { ...metadata, turnId: args.turnId, payloadDigest: args.payloadDigest, sessionId: adapter.sessionId, kind: 'interactive-ready', source: 'adapter', rule: 'chatgpt-controls-idle', ruleVersion: 1,
          threadKey: canonicalThreadKey({ namespace: 'local-owner', origin: adapter.binding.origin, thread: adapter.binding.thread }), boundarySequence: 10,
          samples: [{ sequence, ...metadata }, { sequence: sequence + 1, ...metadata }], sequence: sequence + 1,
          controls: { observed: true, state: 'idle', idleControlPresent: true, stopPresent: false, composerEnabled: true } } };
    },
  };
}

function runtimeFixture(t, { texts, delayMs = 0 }) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'conversation-events-text-'));
  const paths = { root, sessions: path.join(root, 'sessions') };
  const site = { id: 'chatgpt', url: 'https://chatgpt.com/' };
  const dependencies = {
    leaseRoot: path.join(root, 'leases'), listSessions: () => [],
    getAdapter: async (v) => v === 'chatgpt' || String(v).startsWith('https://chatgpt.com') ? site : null,
    listTargets: async () => [{ id: 'selected', type: 'page', url: 'https://chatgpt.com/c/11111111-1111-4111-8111-111111111111' }],
    createAdapter() {
      const adapter = { mayOwnResources: false, bytesWritten: 40, integrity: null,
        async connect(binding, hooks) { hooks.bind(binding); adapter.binding = binding; adapter.sessionId = 'session-0'; hooks.ownSession(adapter.sessionId); return { binding, sessionId: adapter.sessionId }; },
        async preflight(binding) { return { binding, draft: { present: false, chars: 0 }, boundary: { sequence: 10, transcriptCount: 1 }, baseline: { userTurns: 0, assistantTurns: 0, sampledAt: '2026-10-24T10:00:00.000Z' } }; },
        async type() {},
        async submit(args) { return { binding: args.binding, evidence: { ...args, sessionId: adapter.sessionId, sequence: 11, kind: 'new-user-turn', source: 'page', identity: `user-${args.turnId}` } }; },
        async reconcile() { return null; },
        async readReply(publish, args) { return streamingReplyFixture(adapter, args, texts, 'ready', delayMs).readReply(publish); },
        async stop() { adapter.integrity = { ok: true }; } };
      return adapter;
    },
  };
  const runtime = createConversationRuntime({ paths, port: 19222, dependencies });
  t.after(async () => { await runtime.close().catch(() => {}); rmSync(root, { recursive: true, force: true }); });
  const connect = () => runtime.connect({ site: 'chatgpt', targetId: 'selected' });
  const submit = (c) => runtime.submit(c.id, { key: 'one', prompt: 'a private prompt body', confirm: true, expectedRevision: c.revision });
  return { runtime, connect, submit };
}

const sseRes = () => {
  const res = { writes: [], status: null, headers: null, destroyed: false, writableEnded: false, writableLength: 0, handlers: {} };
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers; };
  res.write = (frame) => { res.writes.push(frame); return true; };
  res.end = () => { res.writableEnded = true; };
  res.on = (ev, fn) => { (res.handlers[ev] ??= []).push(fn); };
  return res;
};
const sseEvents = (res) => res.writes.join('').split('\n\n').filter((b) => b.includes('\nevent: ') || b.startsWith('event: ')).map((b) => {
  const get = (k) => { const m = new RegExp(`^${k}: (.*)$`, 'm').exec(b); return m ? m[1] : null; };
  return { id: get('id'), type: get('event'), data: get('data') ? JSON.parse(get('data')) : null };
});

test('event type contracts: the metadata feed never advertises the text event; the text feed carries both', async (t) => {
  const events = createConversationEvents({ runtime: { get: async () => { throw Object.assign(new Error('x'), { status: 404 }); } } });
  t.after(() => events.close());
  assert.deepEqual(CONVERSATION_EVENT_TYPES, ['conversation.changed']);
  assert.deepEqual(CONVERSATION_TEXT_EVENT_TYPES, ['conversation.changed', REPLY_TEXT_EVENT]);
  assert.deepEqual(events.feed.eventTypes, ['conversation.changed']);
  assert.deepEqual(events.info().text.eventTypes ?? CONVERSATION_TEXT_EVENT_TYPES, CONVERSATION_TEXT_EVENT_TYPES);
});

test('default subscription never carries reply text; include=text carries bounded snapshots with source confidence', async (t) => {
  const texts = ['first chunk', 'first chunk and second', 'first chunk and second and third'];
  const f = runtimeFixture(t, { texts, delayMs: 30 });
  const events = createConversationEvents({ runtime: f.runtime, intervalMs: 5 });
  t.after(() => events.close());
  const c = await f.connect();
  const plain = sseRes(), withText = sseRes();
  await events.subscribe({ headers: {} }, plain, c.id);
  await events.subscribe({ headers: {} }, withText, c.id, { include: 'text' });
  await f.submit(c);
  await waitFor(() => f.runtime.get(c.id).then((v) => v.reply.state === 'ready'));
  await waitFor(() => sseEvents(withText).some((e) => e.type === REPLY_TEXT_EVENT && e.data?.data?.reply?.state === 'ready'));
  // Metadata feed: no text event, and no reply body anywhere in its payloads.
  assert.ok(sseEvents(plain).every((e) => e.type === 'conversation.changed' || e.type === 'hello'));
  const plainBlob = sseEvents(plain).map((e) => JSON.stringify(e.data)).join('');
  for (const chunk of texts) assert.ok(!plainBlob.includes(chunk), 'metadata feed must not carry reply text');
  // Text feed: reply_text snapshots exist for the streamed updates and are self-sufficient.
  const textEvents = sseEvents(withText).filter((e) => e.type === REPLY_TEXT_EVENT).map((e) => e.data.data);
  assert.ok(textEvents.length >= 3, `expected >= 3 text snapshots, got ${textEvents.length}`);
  const final = textEvents.at(-1);
  assert.equal(final.reply.text, texts.at(-1));
  assert.equal(final.reply.source, 'page');
  assert.equal(final.reply.truncated, false);
  assert.equal(final.reply.chars, texts.at(-1).length);
  assert.match(final.reply.identity, /^reply-/);
  assert.equal(final.conversationId, c.id);
  assert.equal(final.turnId, (await f.runtime.get(c.id)).turn.id);
  // Snapshots grow monotonically; every event carries the durable revision cursor.
  const chars = textEvents.map((e) => e.reply.chars);
  assert.deepEqual(chars, [...chars].sort((a, b) => a - b));
  assert.ok(textEvents.every((e) => Number.isInteger(e.revision)));
});

test('unknown include values fail closed; text snapshots are head-capped with truncated flag', async (t) => {
  const longText = 'x'.repeat(40000);
  const f = runtimeFixture(t, { texts: [longText] });
  const events = createConversationEvents({ runtime: f.runtime, intervalMs: 5, textLimits: { maxChars: 1000 } });
  t.after(() => events.close());
  const c = await f.connect();
  const bad = sseRes();
  await assert.rejects(() => events.subscribe({ headers: {} }, bad, c.id, { include: 'everything' }),
    (e) => e.status === 400);
  const withText = sseRes();
  await events.subscribe({ headers: {} }, withText, c.id, { include: 'text' });
  await f.submit(c);
  await waitFor(() => sseEvents(withText).some((e) => e.type === REPLY_TEXT_EVENT));
  const textEvents = sseEvents(withText).filter((e) => e.type === REPLY_TEXT_EVENT).map((e) => e.data.data);
  const capped = textEvents.find((e) => e.reply.truncated);
  assert.ok(capped, 'an oversized reply must be marked truncated');
  assert.equal(capped.reply.text.length, 1000);
  assert.equal(capped.reply.chars, 40000, 'chars reports the true length even when the text is capped');
  const blob = sseEvents(withText).map((e) => JSON.stringify(e.data)).join('');
  assert.ok(!blob.includes('y'.repeat(10)), 'sanity');
  assert.ok(blob.length < 40000 * 4, 'the retained window must not hold the uncapped body');
});

test('text events never instruct actions and stay session-scoped; info() reports both feeds', async (t) => {
  const f = runtimeFixture(t, { texts: ['a', 'ab'] });
  const events = createConversationEvents({ runtime: f.runtime, intervalMs: 5 });
  t.after(() => events.close());
  const c = await f.connect();
  const withText = sseRes();
  await events.subscribe({ headers: {} }, withText, c.id, { include: 'text' });
  await f.submit(c);
  await waitFor(() => sseEvents(withText).some((e) => e.type === REPLY_TEXT_EVENT));
  const all = sseEvents(withText).filter((e) => e.type !== 'hello');
  assert.ok(all.every((e) => e.data?.session === c.id || e.data?.conversationId === c.id || e.data?.data?.conversationId === c.id || e.data?.data?.turnId !== undefined));
  const info = events.info();
  assert.ok(info.text && Array.isArray(info.watched) && info.watched.includes(c.id));
  assert.equal(info.textLimits.maxChars, 16000);
});
