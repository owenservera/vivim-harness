import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createConversationRuntime } from '../../src/capture/conversation-runtime.mjs';
import { createConversationBrowserAdapter } from '../../src/capture/conversation-browser-adapter.mjs';
import { acquireDriveLease } from '../../src/capture/drive-lease.mjs';
import { Recorder } from '../../src/capture/recorder.mjs';

const OPEN = '11111111-1111-4111-8111-111111111111';
const FRESH = '22222222-2222-4222-8222-222222222222';
const STORED = '33333333-3333-4333-8333-333333333333';
const idle = () => ({ observed: true, state: 'idle', idleControlPresent: true, stopPresent: false, composerEnabled: true });
const tick = () => new Promise((resolve) => setImmediate(resolve));

function harness(t, { tabs = [], storedRef = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'conversation-create-'));
  const paths = { root, sessions: path.join(root, 'sessions') };
  const conversations = path.join(root, 'conversations');
  fs.mkdirSync(conversations, { recursive: true });
  if (storedRef) fs.writeFileSync(path.join(conversations, 'stored.conversation.json'), JSON.stringify({ binding: { thread: { ref: storedRef } } }));
  const state = { pathname: '/', targetUrl: 'https://chatgpt.com/', draft: '', messages: [], controls: idle(), insertions: 0, sends: 0, replyReads: 0, afterSend: null, records: [] };
  class FakeRecorder extends Recorder {
    constructor(options) { super(options); this.page = { send: async () => ({}) }; }
    async start(options) {
      this.session = { id: `cap-${state.sends + 1}-${state.insertions}`, raw: { seq: 4, stats: { bytes: 1 } }, kv: { set() {}, get() {} } };
      options.onSessionCreated(this.session); this.state = 'recording'; return this.session;
    }
    tap() { return { close() {} }; }
    recordConversationObservation(record) { state.records.push(record); return ++this.session.raw.seq; }
    async stop() { this.state = 'idle'; return { verify: { ok: true } }; }
  }
  const listTargets = async () => [...tabs, { id: 'created', type: 'page', url: state.targetUrl }];
  const runtime = createConversationRuntime({
    paths, port: 19231, profileStore: { load() { return {}; } },
    dependencies: {
      leaseRoot: path.join(root, 'leases'), listSessions: () => [], ownerIsAlive: () => false, listTargets,
      getAdapter: async (value) => (value === 'chatgpt' || String(value).startsWith('https://chatgpt.com')) ? { id: 'chatgpt', url: 'https://chatgpt.com/' } : null,
      createAdapter: (options) => {
        const adapter = createConversationBrowserAdapter({ ...options, dependencies: {
          Recorder: FakeRecorder, listTargets, listSessions: () => [],
          evaluate: async (_, expression) => expression === 'location.origin' ? 'https://chatgpt.com' : state.pathname,
          readTurnPage: async () => ({ origin: 'https://chatgpt.com', pathname: state.pathname, messages: structuredClone(state.messages),
            draft: { text: state.draft, chars: state.draft.length }, controls: structuredClone(state.controls) }),
          findComposer: async () => ({ found: true }), focusComposer: async () => ({ ok: true }),
          sendState: async () => ({ evalOk: true, draftChars: state.draft.length }),
          detectAuthWall: async () => ({ blocked: false }), detectSiteFailure: async () => ({ failed: false }),
          sleep: async () => {}, readinessTimeoutMs: 300, readinessPollMs: 1, fetchTimeoutMs: 300, connectGraceMs: 50, replyPollMs: 1, replyTimeoutMs: 200, replySettleMs: 0,
          fetch: async () => ({ ok: true, json: async () => ({ id: 'created' }) }),
          typeText: async (_page, prompt, opts) => { await opts.beforeInsert?.(); state.insertions++; state.draft = prompt; return { ok: true, typed: prompt }; },
          sendMessage: async (_page, _adapter, hooks) => { await hooks.beforeDispatch?.(); state.sends++; state.afterSend?.(); return { dispatched: true, uncertain: true }; },
        } });
        const readReply = adapter.readReply.bind(adapter);
        adapter.readReply = async (...args) => { state.replyReads++; return readReply(...args); };
        return adapter;
      },
    },
  });
  t.after(async () => { await runtime.close().catch(() => {}); fs.rmSync(root, { recursive: true, force: true }); });
  const file = (id) => path.join(conversations, `${id}.conversation.json`);
  const connectFresh = () => runtime.connect({ site: 'chatgpt', freshTab: true });
  const submit = (c, body = {}) => runtime.submit(c.id, { key: 'one', prompt: 'synthetic create', confirm: true, expectedRevision: c.revision, ...body });
  return { runtime, state, file, connectFresh, submit, leaseRoot: path.join(root, 'leases') };
}

test('fresh tab becomes unbound NEW_CHAT and does not treat /, query root, or a project URL as a thread', async (t) => {
  const f = harness(t, { storedRef: `chatgpt-c:${STORED}`, tabs: [
    { id: 'home', type: 'page', url: 'https://chatgpt.com/' },
    { id: 'query', type: 'page', url: 'https://chatgpt.com/?q=hello' },
    { id: 'project', type: 'page', url: `https://chatgpt.com/g/g-p-abc/c/${OPEN}` },
    { id: 'open', type: 'page', url: `https://chatgpt.com/c/${OPEN}` },
  ] });
  const c = await f.connectFresh();
  assert.equal(c.identity.state, 'unbound'); assert.equal(c.identity.reason, 'NEW_CHAT'); assert.equal(c.binding.thread, undefined);
  assert.equal(c.sessionId, null);
  const disk = JSON.parse(fs.readFileSync(f.file(c.id), 'utf8'));
  assert.deepEqual(disk.threadDenylist.sort(), [`chatgpt-c:${OPEN}`, `chatgpt-c:${STORED}`].sort());
  await assert.rejects(f.runtime.connect({ site: 'chatgpt', freshTab: true, expectedThread: `chatgpt-c:${OPEN}` }), (e) => e.status === 400);
});

test('existing home and project tabs stay unverified and cannot submit', async (t) => {
  for (const url of ['https://chatgpt.com/', 'https://chatgpt.com/?q=1', `https://chatgpt.com/g/g-p-abc/c/${OPEN}`]) {
    const f = harness(t, { tabs: [{ id: 'tab', type: 'page', url }] });
    const c = await f.runtime.connect({ site: 'chatgpt', targetId: 'tab', freshTab: false });
    assert.equal(c.identity.state, 'unverified'); assert.equal(c.identity.reason, 'UNSUPPORTED_PATH'); assert.equal(c.binding.thread, undefined);
    await assert.rejects(f.submit(c), (e) => e.status === 409 && e.code === 'THREAD_IDENTITY_UNVERIFIED');
    assert.equal(f.state.insertions, 0); assert.equal(f.state.sends, 0); assert.equal(f.state.replyReads, 0);
    await f.runtime.finish(c.id);
  }
});

test('navigation to a denylisted /c before send sends nothing and proves pre-effect', async (t) => {
  const f = harness(t, { tabs: [{ id: 'open', type: 'page', url: `https://chatgpt.com/c/${OPEN}` }] });
  const c = await f.connectFresh();
  f.state.pathname = `/c/${OPEN}`; f.state.targetUrl = `https://chatgpt.com/c/${OPEN}`;
  const blocked = await f.submit(c);
  assert.equal(blocked.turn.phase, 'blocked'); assert.equal(blocked.turn.reason, 'PREEXISTING_THREAD');
  assert.equal(f.state.insertions, 0); assert.equal(f.state.sends, 0); assert.equal(f.state.replyReads, 0);
  const disk = JSON.parse(fs.readFileSync(f.file(c.id), 'utf8'));
  assert.equal(disk.attempts[0].preEffect.typing, 'not-executed'); assert.equal(disk.attempts[0].preEffect.dispatch, 'not-executed');
  assert.equal(disk.binding.thread, undefined);
  assert.equal(fs.existsSync(path.join(path.dirname(f.file(c.id)), 'thread-turns')), false);
});

test('target/page mismatch does not pin or read a reply', async (t) => {
  const f = harness(t);
  const c = await f.connectFresh();
  f.state.afterSend = () => { f.state.targetUrl = `https://chatgpt.com/c/${FRESH}`; f.state.pathname = `/c/${OPEN}`; };
  const uncertain = await f.submit(c);
  assert.equal(uncertain.turn.send.state, 'uncertain'); assert.equal(uncertain.diagnostic.uncertainty, 'CREATION_UNPINNED');
  assert.equal(uncertain.binding.thread, undefined); assert.equal(uncertain.identity.state, 'unbound');
  assert.equal(f.state.sends, 1); assert.equal(f.state.replyReads, 0);
  assert.equal(JSON.parse(fs.readFileSync(f.file(c.id), 'utf8')).attempts[0].preEffect, null);
  await assert.rejects(f.submit(uncertain, { key: 'two', expectedRevision: uncertain.revision }), (e) => e.code === 'CREATION_UNCERTAIN');
  assert.equal(f.state.sends, 1);
});

test('landing on an already-open or stored UUID does not pin or start reply attribution', async (t) => {
  for (const ref of [OPEN, STORED]) {
    const f = harness(t, { tabs: [{ id: 'open', type: 'page', url: `https://chatgpt.com/c/${OPEN}` }], storedRef: `chatgpt-c:${STORED}` });
    const c = await f.connectFresh();
    f.state.afterSend = () => { f.state.targetUrl = `https://chatgpt.com/c/${ref}`; f.state.pathname = `/c/${ref}`; f.state.messages.push({ id: 'user-1', role: 'user', text: 'synthetic create' }); };
    const uncertain = await f.submit(c);
    assert.equal(uncertain.binding.thread, undefined, ref); assert.equal(uncertain.identity.reason, 'NEW_CHAT');
    assert.equal(uncertain.turn.send.state, 'uncertain'); assert.equal(f.state.replyReads, 0); assert.equal(f.state.sends, 1);
    await f.runtime.finish(c.id);
    await tick();
  }
});

test('/, query root, and /g/.../c/<uuid> never become binding.thread', async (t) => {
  const landings = [
    { targetUrl: 'https://chatgpt.com/', pathname: '/' },
    { targetUrl: 'https://chatgpt.com/?q=hello', pathname: '/' },
    { targetUrl: `https://chatgpt.com/g/g-p-abc/c/${FRESH}`, pathname: `/g/g-p-abc/c/${FRESH}` },
  ];
  for (const landing of landings) {
    const f = harness(t);
    const c = await f.connectFresh();
    f.state.afterSend = () => { Object.assign(f.state, landing); };
    const uncertain = await f.submit(c);
    assert.equal(uncertain.binding.thread, undefined, landing.targetUrl);
    assert.equal(uncertain.identity.state, 'unbound'); assert.equal(uncertain.turn.send.state, 'uncertain');
    assert.equal(f.state.replyReads, 0); assert.equal(JSON.parse(fs.readFileSync(f.file(c.id), 'utf8')).binding.thread, undefined);
    await f.runtime.finish(c.id);
  }
});

test('a new /c UUID absent from the denylist pins and only then attributes the reply', async (t) => {
  const f = harness(t, { tabs: [{ id: 'open', type: 'page', url: `https://chatgpt.com/c/${OPEN}` }] });
  const c = await f.connectFresh();
  f.state.afterSend = () => {
    f.state.targetUrl = `https://chatgpt.com/c/${FRESH}`; f.state.pathname = `/c/${FRESH}`;
    f.state.messages.push({ id: 'user-1', role: 'user', text: f.state.draft }, { id: 'reply-1', role: 'assistant', text: 'synthetic answer' });
    f.state.draft = '';
  };
  const ack = await f.submit(c);
  assert.equal(ack.binding.thread.ref, `chatgpt-c:${FRESH}`); assert.equal(ack.identity.state, 'bound'); assert.equal(ack.turn.send.state, 'observed');
  for (let n = 0; n < 50 && f.state.replyReads < 1; n++) await tick();
  assert.equal(f.state.sends, 1); assert.ok(f.state.replyReads >= 1);
});

test('the driving lease covers only the fresh-tab creation window, not the idle tab between connect and send', async (t) => {
  const f = harness(t, { tabs: [{ id: 'open', type: 'page', url: `https://chatgpt.com/c/${OPEN}` }] });
  const c = await f.connectFresh();
  assert.equal(c.identity.state, 'unbound'); assert.equal(c.writer.active, false);
  acquireDriveLease({ root: f.leaseRoot, port: 19231 }).release(); // Free after the creation window closed.
  f.state.afterSend = () => {
    f.state.targetUrl = `https://chatgpt.com/c/${FRESH}`; f.state.pathname = `/c/${FRESH}`;
    f.state.messages.push({ id: 'user-1', role: 'user', text: f.state.draft }, { id: 'reply-1', role: 'assistant', text: 'synthetic answer' });
    f.state.draft = '';
  };
  const ack = await f.submit(c);
  assert.equal(ack.turn.send.state, 'observed'); assert.equal(ack.binding.thread.ref, `chatgpt-c:${FRESH}`);
  assert.equal((await f.runtime.get(c.id)).writer.active, false); // Released once the creation delivery is observed.
  acquireDriveLease({ root: f.leaseRoot, port: 19231 }).release();
});
