import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createConversationRuntime } from '../../src/capture/conversation-runtime.mjs';
import { createConversationBrowserAdapter } from '../../src/capture/conversation-browser-adapter.mjs';
import { Recorder } from '../../src/capture/recorder.mjs';
import { RawLog } from '../../src/store/raw-log.mjs';
import site from '../../src/profiles/sites/chatgpt.mjs';
import vm from 'node:vm';
import { turnObservationExpression } from '../../src/capture/conversation-thread.mjs';

const ref = '11111111-1111-4111-8111-111111111111';
const idle = () => ({ observed: true, state: 'idle', idleControlPresent: true, stopPresent: false, composerEnabled: true });
const tick = () => new Promise(setImmediate);
async function until(fn) { for (let i = 0; i < 500; i++) { const result = await fn(); if (result) return result; await tick(); } throw new Error('Synthetic job did not settle'); }
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'conversation-m2-'));
  const paths = { root, sessions: path.join(root, 'sessions') };
  const state = { pathname: `/c/${ref}`, draft: '', messages: [], controls: idle(), insertions: 0, sends: 0, records: [], mode: 'normal', recorders: [] };
  let sessionNo = 0;
  class FakeRecorder extends Recorder {
    constructor(options) {
      super(options);
      this.page = { send: async (method, params) => {
        if (method === 'Runtime.evaluate') {
          const focus = /return \{ ok:|ok: !!/.test(params.expression);
          return { result: { value: focus ? { ok: true } : state.draft } };
        }
        if (method === 'Input.insertText') {
          state.insertions++;
          state.draft += state.mode === 'partial' ? params.text.slice(0, 2) : params.text;
          if (state.mode === 'nav-typing') state.pathname = `/c/${'22222222-2222-4222-8222-222222222222'}`;
        }
        return {};
      } };
      this.reducer = { ingest: () => [] };
    }
    async start(options) {
      const dir = path.join(paths.sessions, `capture-${++sessionNo}`); fs.mkdirSync(dir, { recursive: true });
      this.session = { id: `capture-${sessionNo}`, raw: new RawLog(dir), kv: new Map() };
      options.onSessionCreated(this.session); this.state = 'recording'; state.recorders.push(this); return this.session;
    }
    tap() { return { close() {} }; }
    recordConversationObservation(record) { const sequence = super.recordConversationObservation(record); state.records.push({ ...record, sequence }); return sequence; }
    async stop() { await this.session.raw.close(); this.state = 'idle'; return { verify: { ok: true } }; }
  }
  const targets = async () => [{ id: 'tab', type: 'page', url: `https://chatgpt.com${state.pathname}` }];
  const dependencies = {
    leaseRoot: path.join(root, 'leases'), listTargets: targets, listSessions: () => [],
    getAdapter: async () => site, ownerIsAlive: () => false,
    createAdapter: (options) => createConversationBrowserAdapter({ ...options, dependencies: {
      Recorder: FakeRecorder, listTargets: targets, listSessions: () => [],
      evaluate: async (_, expression) => expression === 'location.origin' ? 'https://chatgpt.com' : state.pathname,
      readTurnPage: async () => ({ origin: 'https://chatgpt.com', pathname: state.pathname,
        messages: structuredClone(state.messages), draft: { text: state.draft, chars: state.draft.length }, controls: structuredClone(state.controls) }),
      findComposer: async () => ({ found: true }), focusComposer: async () => ({ ok: true }),
      sendState: async () => ({ evalOk: true, draftChars: state.draft.length }),
      detectAuthWall: async () => ({ blocked: false }), detectSiteFailure: async () => ({ failed: false }),
      sleep: tick, replyPollMs: 1, replyTimeoutMs: 500, replySettleMs: 0,
      sendMessage: async (_, __, hooks) => {
        if (state.mode === 'nav-submit') state.pathname = '/';
        await hooks.beforeDispatch();
        state.sends++;
        if (state.mode === 'lost-ack') throw new Error('synthetic-lost-ack');
        const n = state.sends;
        state.messages.push({ id: `user-${n}`, role: 'user', text: state.draft }); state.draft = '';
        if (state.mode !== 'stale-reply') state.messages.push({ id: `reply-${n}`, role: 'assistant', text: `synthetic answer ${n}` });
        return { dispatched: true };
      },
    } }),
  };
  const runtime = createConversationRuntime({ paths, port: 19224, profileStore: { load: () => ({}) }, dependencies });
  t.after(async () => { await runtime.close().catch(() => {}); for (const rec of state.recorders) if (!rec.session.raw.closed) await rec.session.raw.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const connect = () => runtime.connect({ site: 'chatgpt', targetId: 'tab', freshTab: false });
  const submit = (c, key = 'sitrep') => runtime.submit(c.id, { key, prompt: `synthetic ${key}`, confirm: true, expectedRevision: c.revision });
  const settled = (id) => until(async () => { const c = await runtime.get(id); return c.turn?.readiness?.state === 'ready' || ['uncertain', 'needs-reconciliation', 'blocked'].includes(c.turn?.phase) ? c : null; });
  return { runtime, paths, state, dependencies, connect, submit, settled };
}

test('M2 actual adapter + actual fast insertion + flushed recorder evidence: SITREP and distinct follow-up replies', async (t) => {
  const f = fixture(t), c = await f.connect();
  await f.submit(c); const first = await f.settled(c.id);
  assert.equal(first.turn.send.state, 'observed'); assert.equal(first.reply.text, 'synthetic answer 1');
  assert.equal(first.turn.completion.state, 'unknown'); assert.equal(first.capture.state, 'idle');
  assert.ok(first.turn.readiness.evidence.samples.every((sample) => sample.sequence > first.turn.send.evidence.sequence));
  await f.submit(first, 'follow-up'); const second = await f.settled(c.id);
  assert.equal(second.reply.text, 'synthetic answer 2'); assert.notEqual(first.turn.id, second.turn.id);
  assert.deepEqual(second.turns.map((turn) => turn.reply.text), ['synthetic answer 1', 'synthetic answer 2']);
  assert.deepEqual(second.turns.map((turn) => turn.reply.evidence.identity), ['reply-1', 'reply-2']);
  assert.equal(f.state.insertions, 2); assert.equal(f.state.sends, 2);
  assert.ok(f.state.records.every((record) => Number.isSafeInteger(record.sequence) && record.sequence > 0));
  const before = f.state.records.length;
  assert.equal((await f.submit(c)).turn.id, first.turn.id);
  assert.equal(f.state.records.length, before); assert.equal(f.state.insertions, 2);
  assert.equal(JSON.stringify(await f.runtime.list()).includes('synthetic answer'), false);
});

test('M2 stale old assistant identity/text cannot become a new turn reply', async (t) => {
  const f = fixture(t);
  f.state.messages.push({ id: 'old-user', role: 'user', text: 'old' }, { id: 'old-reply', role: 'assistant', text: 'synthetic answer 1' });
  f.state.mode = 'stale-reply';
  const c = await f.connect(); await f.submit(c);
  await until(async () => (await f.runtime.get(c.id)).turn?.send.state === 'observed');
  const current = await f.runtime.get(c.id);
  assert.notEqual(current.reply.text, 'synthetic answer 1');
  await assert.rejects(f.submit(current, 'follow-up'), (e) => e.code === 'THREAD_FENCED');
});

test('M2 unknown send fences new records after finish and runtime restart; replay is read-only', async (t) => {
  const f = fixture(t); f.state.mode = 'lost-ack';
  const c = await f.connect(); await f.submit(c); const unknown = await f.settled(c.id);
  assert.equal(unknown.turn.send.state, 'uncertain'); await f.runtime.finish(c.id);
  const next = await f.connect();
  assert.equal((await f.submit(next)).turn.id, unknown.turn.id);
  await assert.rejects(f.submit(next, 'new-key'), (e) => e.code === 'THREAD_FENCED');
  await f.runtime.finish(next.id);
  const restarted = createConversationRuntime({ paths: f.paths, port: 19224, dependencies: f.dependencies, profileStore: { load: () => ({}) } });
  const after = await restarted.connect({ site: 'chatgpt', targetId: 'tab' });
  await assert.rejects(restarted.submit(after.id, { key: 'after-restart', prompt: 'synthetic after-restart', confirm: true, expectedRevision: after.revision }), (e) => e.code === 'THREAD_FENCED');
  await restarted.close(); assert.equal(f.state.insertions, 1); assert.equal(f.state.sends, 1);
});

for (const mode of ['partial', 'nav-typing', 'nav-submit']) test(`M2 ${mode}: preserve draft, no retry, no accidental dispatch`, async (t) => {
  const f = fixture(t); f.state.mode = mode;
  const c = await f.connect(); await f.submit(c); const end = await f.settled(c.id);
  assert.equal(f.state.insertions, 1); assert.equal(f.state.sends, 0); assert.ok(f.state.draft.length > 0);
  assert.equal(end.turn.readiness.state, 'unknown');
  await assert.rejects(f.submit(end, 'fresh-key'), (e) => ['THREAD_FENCED', 'NOT_READY'].includes(e.code));
});

test('M2 concurrent fresh keys cannot both insert; root/fresh path cannot escape the thread fence', async (t) => {
  const f = fixture(t), c = await f.connect(); f.state.mode = 'lost-ack';
  const results = await Promise.allSettled([f.submit(c), f.submit(c, 'competing')]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  await f.settled(c.id); await f.runtime.finish(c.id);
  f.state.pathname = '/';
  const root = await f.connect();
  await assert.rejects(f.submit(root, 'root-key'), (e) => e.code === 'THREAD_IDENTITY_UNVERIFIED');
  assert.equal(f.state.insertions, 1);
});

test('M2 late old reply revision detected by fresh preflight invalidates readiness before follow-up insertion', async (t) => {
  const f = fixture(t), c = await f.connect(); await f.submit(c); const first = await f.settled(c.id);
  f.state.messages.find((m) => m.id === 'reply-1').text = 'synthetic revised answer';
  await f.submit(first, 'follow-up');
  const blocked = await until(async () => { const state = await f.runtime.get(c.id); return state.turn?.phase === 'blocked' ? state : null; });
  assert.equal(blocked.turns[0].readiness.state, 'unknown');
  assert.equal(blocked.turns[0].reply.text, 'synthetic answer 1'); // the closed turn log is not rewritten after its capture stops
  assert.equal(f.state.insertions, 1); assert.equal(f.state.sends, 1);
});

test('M2 missing stable message identity or idle controls fails closed before insertion', async (t) => {
  for (const missing of ['identity', 'controls']) {
    const f = fixture(t);
    if (missing === 'identity') f.state.messages.push({ id: null, role: 'assistant', text: 'synthetic old' });
    else f.state.controls = { observed: false, state: 'unknown' };
    const c = await f.connect(); await f.submit(c); const blocked = await f.settled(c.id);
    assert.equal(blocked.turn.phase, 'blocked'); assert.equal(f.state.insertions, 0); assert.equal(f.state.sends, 0);
  }
});

test('M2 restarted same-key POST is pure even without an explicit recover beforehand', async (t) => {
  const f = fixture(t), c = await f.connect(); await f.submit(c); const first = await f.settled(c.id);
  await f.runtime.finish(c.id);
  const file = path.join(f.paths.root, 'conversations', `${c.id}.conversation.json`), before = fs.readFileSync(file, 'utf8');
  const restarted = createConversationRuntime({ paths: f.paths, port: 19224, dependencies: f.dependencies });
  const replay = await restarted.submit(c.id, { key: 'sitrep', prompt: 'synthetic sitrep', expectedRevision: -1 });
  assert.equal(replay.turn.id, first.turn.id); assert.equal(replay.reply.text, first.reply.text);
  assert.equal(fs.readFileSync(file, 'utf8'), before); assert.equal(f.state.insertions, 1); assert.equal(f.state.sends, 1);
  await restarted.close();
});

test('M2 reconnect permits an unchanged attributable reply, but changed historical reply invalidates persisted readiness', async (t) => {
  for (const changed of [false, true]) {
    const f = fixture(t), c = await f.connect(); await f.submit(c); await f.settled(c.id); await f.runtime.finish(c.id);
    if (changed) f.state.messages.find((m) => m.id === 'reply-1').text = 'synthetic late change';
    const next = await f.connect(); await f.submit(next, 'follow-up'); const done = await f.settled(next.id);
    if (changed) {
      assert.equal(done.turn.phase, 'blocked'); assert.equal(f.state.insertions, 1);
      assert.equal((await f.runtime.get(c.id)).turn.readiness.state, 'unknown');
    } else {
      assert.equal(done.reply.text, 'synthetic answer 2'); assert.equal(f.state.insertions, 2);
    }
  }
});

test('M2 real read-only page expression reports observed message IDs and positively present idle control, never positional identities', () => {
  const make = (id, text, order) => ({ innerText: text, disabled: false, getBoundingClientRect: () => ({ width: 20, height: 20 }),
    getAttribute: (name) => name === 'data-message-id' ? id : null, closest() { return id ? this : null; },
    querySelector: () => null, contains: () => false, compareDocumentPosition: (other) => order < other.order ? 4 : 2, order });
  const user = make('observed-user-id', 'synthetic input', 0), assistant = make('observed-reply-id', 'synthetic reply', 1);
  const composer = make(null, '', 2), button = make(null, '', 3);
  let idlePresent = true;
  const document = { querySelectorAll: (selector) => selector === '[data-message-author-role="user"]' ? [user]
    : selector === '[data-message-author-role="assistant"]' ? [assistant] : selector === '#prompt-textarea' ? [composer]
      : selector === 'button[data-testid="send-button"]' && idlePresent ? [button] : [] };
  const evaluate = () => vm.runInNewContext(turnObservationExpression(site), { document, location: { origin: 'https://chatgpt.com', pathname: `/c/${ref}` } });
  const measured = evaluate();
  assert.deepEqual(Array.from(measured.messages, (m) => m.id), ['observed-user-id', 'observed-reply-id']);
  assert.equal(measured.controls.state, 'idle'); assert.equal(measured.controls.idleControlPresent, true);
  idlePresent = false;
  // ChatGPT renders no send button while the composer is empty: empty composer + no stop control is idle.
  assert.equal(evaluate().controls.state, 'idle');
  // A non-empty composer without a send button is still not positively idle.
  composer.innerText = 'half-typed draft';
  assert.equal(evaluate().controls.state, 'unknown');
  composer.innerText = '';
  assistant.closest = () => null;
  assert.equal(evaluate().messages[1].id, null);
});

test('M2 message ids come from the current ChatGPT DOM (search-message-ids unit attribute and selection ids), never positional', () => {
  const make = (attrs, inner, order) => ({ innerText: 'text', disabled: false, getBoundingClientRect: () => ({ width: 20, height: 20 }),
    getAttribute: (n) => attrs[n] ?? null, closest: () => null, querySelector: () => inner,
    contains: () => false, compareDocumentPosition: (other) => order < other.order ? 4 : 2, order });
  const user = make({ 'data-chatgpt-search-message-ids': 'user-msg-1' }, null, 0);
  const innerSel = { getAttribute: (n) => n === 'data-chatgpt-selection-message-id' ? 'asst-msg-1' : null };
  const assistant = make({ 'data-chatgpt-search-message-ids': '  ' }, innerSel, 1);
  const composer = make({}, null, 2); composer.innerText = '';
  const document = { querySelectorAll: (s) => s === '[data-message-author-role="user"]' ? [user]
    : s === '[data-message-author-role="assistant"]' ? [assistant] : s === '#prompt-textarea' ? [composer] : [] };
  const out = vm.runInNewContext(turnObservationExpression(site), { document, location: { origin: 'https://chatgpt.com', pathname: `/c/${ref}` } });
  assert.deepEqual(Array.from(out.messages, (m) => m.id), ['user-msg-1', 'asst-msg-1']);
});
