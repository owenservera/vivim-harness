// M1: exact-thread identity, bounded zero-send Read, pure snapshot reads, coded 503.
// Injected fakes only: no browser, no network. Real ChatGPT page behaviour is NOT covered here.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { createConversationRuntime } from '../../src/capture/conversation-runtime.mjs';
import { createConversationService } from '../../src/capture/conversation-service.mjs';
import { createConversationBrowserAdapter } from '../../src/capture/conversation-browser-adapter.mjs';
import { acquireDriveLease } from '../../src/capture/drive-lease.mjs';
import { parseThread, sameThread, threadSupported, boundTranscript, transcriptExpression } from '../../src/capture/conversation-thread.mjs';

const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
const urlA = `https://chatgpt.com/c/${A}`, urlB = `https://chatgpt.com/c/${B}`;
const sha = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const coded = (code) => Object.assign(new Error(code), { code, status: 409 });

// ---------------------------------------------------------------- thread identity helper
test('parseThread: only the observed /c/<uuid> form is a ChatGPT thread; everything else is null', () => {
  const ok = parseThread('chatgpt', `https://chatgpt.com/c/${A.toUpperCase()}/?model=x#frag`);
  assert.deepEqual(ok, { kind: 'chatgpt-c', id: A, ref: `chatgpt-c:${A}` });
  assert.equal(parseThread('chatgpt', `https://chat.openai.com/c/${A}`)?.ref, `chatgpt-c:${A}`);
  for (const url of ['https://chatgpt.com/', 'https://chatgpt.com/c/not-a-uuid', `https://chatgpt.com/c/${A}/extra`,
    `https://chatgpt.com/g/g-p-abc123/c/${A}`, `https://chatgpt.com/g/g-abc123/c/${A}`, 'https://chatgpt.com/g/g-p-abc123/project',
    `http://chatgpt.com/c/${A}`, 'about:blank', 'not a url', '', undefined, null]) assert.equal(parseThread('chatgpt', url), null, String(url));
  assert.equal(parseThread('claude', `https://claude.ai/chat/${A}`), null);
  assert.equal(threadSupported('chatgpt'), true); assert.equal(threadSupported('claude'), false);
});

test('sameThread: null equals null, different refs differ, a title is never an input', () => {
  assert.equal(sameThread(null, undefined), true);
  assert.equal(sameThread(parseThread('chatgpt', urlA), parseThread('chatgpt', urlA)), true);
  assert.equal(sameThread(parseThread('chatgpt', urlA), parseThread('chatgpt', urlB)), false);
  assert.equal(sameThread(parseThread('chatgpt', urlA), null), false);
  assert.equal(parseThread('chatgpt', urlA).title, undefined);
});

// ---------------------------------------------------------------- bounded transcript shaping
const raw = (over = {}) => ({ pathname: `/c/${A}`, origin: 'https://chatgpt.com', renderedTotal: 4, hiddenSkipped: 1, nestedDropped: 0, ambiguousSkipped: 0,
  scroll: { found: true, topReached: false, bottomReached: true }, draft: { present: true, chars: 5 },
  messages: [{ role: 'user', text: 'u1', chars: 2 }, { role: 'assistant', text: 'a1', chars: 2 }, { role: 'user', text: 'u2', chars: 2 }, { role: 'assistant', text: 'a2', chars: 2 }], ...over });

test('boundTranscript: source-labelled, never claims completeness, reports older history honestly', () => {
  const out = boundTranscript(raw(), { maxMessages: 10, maxChars: 1000, perMessageCap: 100 });
  assert.equal(out.source, 'page-visible-dom'); assert.equal(out.coverage.complete, false);
  assert.deepEqual(out.messages.map((m) => [m.index, m.role, m.text]), [[0, 'user', 'u1'], [1, 'assistant', 'a1'], [2, 'user', 'u2'], [3, 'assistant', 'a2']]);
  assert.equal(out.coverage.olderHistory, 'older-unrendered-likely'); assert.equal(out.coverage.newerHistory, 'bottom-reached');
  assert.equal(out.coverage.hiddenSkipped, 1); assert.equal(out.coverage.omittedMessages, 0);
  assert.deepEqual(out.draft, { present: true, chars: 5 }); assert.equal(JSON.stringify(out).includes('draft text'), false);
  assert.equal(boundTranscript(raw({ scroll: undefined }), {}).coverage.olderHistory, 'unknown');
  assert.equal(boundTranscript(raw({ scroll: { found: true, topReached: true, bottomReached: false } }), {}).coverage.olderHistory, 'top-reached');
});

test('boundTranscript: message count bound keeps the newest and counts omissions', () => {
  const out = boundTranscript(raw(), { maxMessages: 2, maxChars: 1000, perMessageCap: 100 });
  assert.deepEqual(out.messages.map((m) => m.text), ['u2', 'a2']); assert.equal(out.coverage.omittedMessages, 2);
  assert.equal(out.coverage.omittedChars, 4); assert.equal(out.coverage.returnedMessages, 2);
});

test('boundTranscript: long text is cut by per-message and total character bounds with honest counts', () => {
  const long = 'x'.repeat(500);
  const out = boundTranscript(raw({ messages: [{ role: 'user', text: long, chars: 5000 }, { role: 'assistant', text: long, chars: 5000 }], renderedTotal: 2 }),
    { maxMessages: 10, maxChars: 120, perMessageCap: 100 });
  assert.equal(out.messages.reduce((n, m) => n + m.text.length, 0) <= 120, true);
  assert.equal(out.messages.at(-1).text.length, 100); assert.equal(out.messages.at(-1).truncated, true); assert.equal(out.messages.at(-1).chars, 5000);
  assert.equal(out.messages.length, 2); assert.equal(out.messages[0].text.length, 20); assert.equal(out.coverage.truncatedMessages, 2);
  assert.ok(out.coverage.omittedChars >= (5000 - 100) + (5000 - 20));
  assert.deepEqual(out.limits, { maxMessages: 10, maxChars: 120, perMessageCap: 100 });
});

test('boundTranscript: page-side scan limit is a virtualization-style omission, not hidden', () => {
  const out = boundTranscript(raw({ renderedTotal: 400, messages: [{ role: 'user', text: 'tail', chars: 4 }] }), { maxMessages: 5, maxChars: 100 });
  assert.equal(out.messages[0].index, 399); assert.equal(out.coverage.renderedMessages, 400); assert.equal(out.coverage.omittedMessages, 399);
});

test('boundTranscript: malformed or hostile page entries are dropped and counted, never returned', () => {
  const out = boundTranscript(raw({ messages: [{ role: 'system', text: 'x', chars: 1 }, { role: 'user', text: 5, chars: 1 }, { role: 'user', text: 'longer', chars: 2 },
    { role: 'user', text: 'ok', chars: 2 }, null], renderedTotal: 5 }), {});
  assert.deepEqual(out.messages.map((m) => m.text), ['ok']); assert.equal(out.coverage.invalidMessages, 4);
  assert.deepEqual(boundTranscript(null, {}).messages, []); assert.deepEqual(boundTranscript({ draft: { present: 'yes', chars: -3 } }, {}).draft, { present: null, chars: null });
});

// ---------------------------------------------------------------- in-page reader never mutates the page
function fakePage({ pathname = `/c/${A}`, draft = 'unsent draft text' } = {}) {
  const touched = [];
  const spy = (name) => () => { touched.push(name); };
  const rect = (w = 20, h = 20) => () => ({ width: w, height: h });
  const mk = (text, over = {}) => ({ innerText: text, getBoundingClientRect: rect(), contains: () => false, compareDocumentPosition: () => 4, parentElement: null,
    focus: spy('focus'), blur: spy('blur'), click: spy('click'), scrollIntoView: spy('scrollIntoView'), scrollTo: spy('scrollTo'), dispatchEvent: spy('dispatchEvent'), remove: spy('remove'), ...over });
  const order = [];
  const u1 = mk('hello'), a1 = mk('world'), hidden = mk('hidden', { getBoundingClientRect: rect(0, 0) }), outer = mk('outer'), inner = mk('inner');
  outer.contains = (el) => el === inner; const u2 = mk('x'.repeat(50));
  for (const el of [u1, a1, hidden, outer, inner, u2]) order.push(el);
  order.forEach((el, i) => { el.compareDocumentPosition = (other) => (order.indexOf(other) > i ? 4 : 2); });
  const composer = mk(draft); let valueWrites = 0;
  Object.defineProperty(composer, 'value', { get: () => draft, set() { valueWrites++; } });
  const scroller = { scrollTop: 300, scrollHeight: 2000, clientHeight: 500, parentElement: null };
  u1.parentElement = scroller;
  const groups = { '[data-message-author-role="user"]': [u1, hidden, outer, inner, u2], '[data-message-author-role="assistant"]': [a1], '#prompt-textarea': [composer] };
  const document = { querySelectorAll: (sel) => groups[sel] ?? [], querySelector: (sel) => (groups[sel] ?? [])[0] ?? null };
  const sandbox = { document, location: { pathname, origin: 'https://chatgpt.com' }, getComputedStyle: (el) => ({ overflowY: el === scroller ? 'auto' : 'visible' }),
    window: { scrollTo: spy('window.scrollTo') } };
  return { sandbox, touched, composer, get valueWrites() { return valueWrites; } };
}

test('page reader returns visible ordered messages and draft presence only; mutates nothing', () => {
  const page = fakePage();
  const expression = transcriptExpression({ composerSelectors: ['#prompt-textarea'], perMessageCap: 20, scanLimit: 50,
    userSelectors: ['[data-message-author-role="user"]'], assistantSelectors: ['[data-message-author-role="assistant"]'] });
  const out = vm.runInNewContext(expression, page.sandbox);
  assert.deepEqual(page.touched, []); assert.equal(page.valueWrites, 0);
  assert.equal(out.pathname, `/c/${A}`); assert.equal(out.hiddenSkipped, 1); assert.equal(out.nestedDropped, 1);
  assert.deepEqual(Array.from(out.messages, (m) => [m.role, m.text.length <= 20]), [['user', true], ['assistant', true], ['user', true], ['user', true]]);
  assert.equal(out.messages.find((m) => m.chars === 50).text.length, 20);
  assert.deepEqual({ ...out.draft }, { present: true, chars: 'unsent draft text'.length }); assert.equal(JSON.stringify(out).includes('unsent draft'), false);
  assert.equal(out.scroll.found, true); assert.equal(out.scroll.topReached, false);
});

// ---------------------------------------------------------------- adapter: BINDING_CHANGED on same target+origin, different thread
function threadAdapter({ thread = parseThread('chatgpt', urlA), tabUrl = urlA, pathname, draftChars = 0, transcript } = {}) {
  const calls = [], state = { tabUrl, pathname: pathname ?? new URL(tabUrl).pathname, draftChars, duringRead: null };
  const store = new Map();
  class FakeRecorder {
    constructor() { calls.push(['recorder']); this.state = 'idle'; this.page = { send: async (method) => { calls.push([method]); return {}; } }; }
    on() {} tap() { return { close() {} }; }
    async start(options) { calls.push(['start']); this.session = { id: 'raw-session', raw: { seq: 10, stats: { bytes: 1 } }, kv: { get: (k) => store.get(k), set: (k, v) => store.set(k, v) } }; options.onSessionCreated(this.session); this.state = 'recording'; return this.session; }
    recordConversationObservation() { calls.push(['observe']); return 11; }
    async stop() { this.state = 'idle'; return { verify: { ok: true } }; }
  }
  const adapter = createConversationBrowserAdapter({ paths: { sessions: 'unused' }, profileStore: { load: () => ({}) }, port: 19222,
    siteAdapter: { id: 'chatgpt', url: 'https://chatgpt.com/', composer: { selectors: ['#prompt-textarea'] } }, targetId: 'selected', freshTab: false, conversationId: 'c', ownerToken: 't',
    dependencies: { Recorder: FakeRecorder, listSessions: () => [], listTargets: async () => [{ id: 'selected', url: state.tabUrl }],
      evaluate: async (page, expr) => { calls.push(['evaluate', expr === 'location.origin' || expr === 'location.pathname' ? expr : 'transcript']);
        if (expr === 'location.origin') return 'https://chatgpt.com';
        if (expr === 'location.pathname') return state.pathname;
        const result = transcript ?? raw({ pathname: state.pathname }); state.duringRead?.(); return result; },
      findComposer: async () => ({ found: true }), focusComposer: async () => ({ ok: true }), sendState: async () => ({ evalOk: true, draftChars: state.draftChars }),
      readUserTurns: async () => ['earlier'], readTranscript: async () => ({ last: '', count: 0 }),
      typeText: async (page, prompt) => { calls.push(['type', prompt]); return { ok: true, typed: prompt }; },
      sendMessage: async () => { calls.push(['send']); return { uncertain: true }; }, waitForCompletion: async () => ({ done: true, text: 'a' }),
      detectAuthWall: async () => ({ blocked: false }), detectSiteFailure: async () => ({ failed: false }) } });
  const binding = { targetId: 'selected', origin: 'https://chatgpt.com', ownedByStudio: false, ...(thread ? { thread } : {}) };
  const connect = () => adapter.connect(binding, { bind() {}, ownSession() {} });
  return { adapter, binding, calls, state, connect };
}
const names = (calls) => calls.map(([name]) => name);

test('adapter: connecting to a tab on a different thread than the binding fails with BINDING_CHANGED', async () => {
  const f = threadAdapter({ tabUrl: urlB, pathname: `/c/${B}` });
  await assert.rejects(f.connect(), /BINDING_CHANGED/);
});

test('adapter: same target+origin on another thread blocks input and read with BINDING_CHANGED (tab url source)', async () => {
  const f = threadAdapter(); const connected = await f.connect(); assert.equal(connected.readiness.ready, true);
  f.state.tabUrl = urlB; f.state.pathname = `/c/${B}`;
  await assert.rejects(f.adapter.preflight(), /BINDING_CHANGED/);
  await assert.rejects(f.adapter.type({ prompt: 'p', turnId: 't' }), /BINDING_CHANGED/);
  await assert.rejects(f.adapter.submit({ binding: f.binding, turnId: 't', payloadDigest: 'd' }), /BINDING_CHANGED/);
  await assert.rejects(f.adapter.reconcile({ binding: f.binding, turnId: 't', payloadDigest: 'd' }), /BINDING_CHANGED/);
  await assert.rejects(f.adapter.readTranscript({ maxMessages: 5, maxChars: 100 }), /BINDING_CHANGED/);
  assert.equal(names(f.calls).some((n) => ['type', 'send', 'Page.bringToFront', 'observe'].includes(n)), false);
  assert.equal(f.calls.filter(([n, what]) => n === 'evaluate' && what === 'transcript').length, 0);
});

test('adapter: the page location alone moving to another thread is also BINDING_CHANGED (second source)', async () => {
  const f = threadAdapter(); await f.connect(); f.state.pathname = `/c/${B}`;
  await assert.rejects(f.adapter.preflight(), /BINDING_CHANGED/); await assert.rejects(f.adapter.readTranscript({ maxMessages: 5, maxChars: 100 }), /BINDING_CHANGED/);
  f.state.pathname = '/'; await assert.rejects(f.adapter.preflight(), /BINDING_CHANGED/);
});

test('adapter: navigation during a Read discards the result with BINDING_CHANGED', async () => {
  const f = threadAdapter(); await f.connect();
  f.state.duringRead = () => { f.state.tabUrl = urlB; f.state.pathname = `/c/${B}`; };
  await assert.rejects(f.adapter.readTranscript({ maxMessages: 5, maxChars: 100 }), /BINDING_CHANGED/);
  const g = threadAdapter({ transcript: raw({ pathname: `/c/${B}` }) }); await g.connect();
  await assert.rejects(g.adapter.readTranscript({ maxMessages: 5, maxChars: 100 }), /BINDING_CHANGED/); // page reported another thread inside the same evaluation
});

test('adapter: Read preserves a present draft and performs no focus, scroll, type, send, navigation or recording', async () => {
  const f = threadAdapter({ draftChars: 7 }); await f.connect(); const before = f.calls.length;
  const out = await f.adapter.readTranscript({ maxMessages: 10, maxChars: 1000 });
  assert.equal(out.transcript.source, 'page-visible-dom'); assert.deepEqual(out.transcript.draft, { present: true, chars: 5 });
  assert.deepEqual(names(f.calls.slice(before)).filter((n) => n !== 'evaluate'), []);
  assert.equal(f.state.draftChars, 7); assert.deepEqual(out.binding.thread, f.binding.thread);
  assert.equal(names(f.calls).some((n) => /^Page\.|^Input\.|^type$|^send$|^observe$/.test(n)), false);
});

// ---------------------------------------------------------------- service: identity gate and legacy snapshots
function memoryService(t, { binding, identity, adapter = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conversation-thread-service-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = [];
  const base = { async connect(b) { calls.push('connect'); return { binding: b, sessionId: 's1' }; },
    async preflight(b) { calls.push('preflight'); return { binding: b, draft: { present: false, chars: 0 }, boundary: { sequence: 1, transcriptCount: 0 } }; },
    async type() { calls.push('type'); }, async submit() { calls.push('submit'); return null; }, async reconcile() { return null; }, async stop() {}, async closeTab() {} };
  const service = createConversationService({ dataDir: dir, id: 'svc', adapter: { ...base, ...adapter } });
  return { service, dir, calls, file: path.join(dir, 'svc.conversation.json') };
}

test('service: an unverified identity fails closed before any browser action, but browse and finish still work', async (t) => {
  const f = memoryService(t);
  await f.service.connect({ targetId: 'tab', origin: 'https://chatgpt.com', ownedByStudio: false, identity: { state: 'unverified', reason: 'UNSUPPORTED_PATH' }, expectedRevision: 0 });
  const s = f.service.read(); assert.equal(s.identity.state, 'unverified'); assert.equal(s.readiness.ready, false); assert.equal(s.readiness.reason, 'THREAD_IDENTITY_UNVERIFIED'); assert.equal(s.state, 'blocked');
  await assert.rejects(f.service.submit({ key: 'k', prompt: 'p', confirm: true, expectedRevision: s.revision }), (e) => e.code === 'THREAD_IDENTITY_UNVERIFIED');
  assert.deepEqual(f.calls, ['connect']);
  const checked = await f.service.reconcile({ expectedRevision: s.revision }); assert.equal(checked.readiness.ready, false); assert.equal(checked.readiness.reason, 'THREAD_IDENTITY_UNVERIFIED');
  await f.service.finish({}); assert.equal(f.service.read().state, 'closed');
});

test('service: a bound identity requires an exact thread match from the adapter, preflight and observation', async (t) => {
  const thread = parseThread('chatgpt', urlA), other = parseThread('chatgpt', urlB);
  const f = memoryService(t, { adapter: { async connect(b) { return { binding: { ...b, thread: other }, sessionId: 's1' }; } } });
  await assert.rejects(f.service.connect({ targetId: 'tab', origin: 'https://chatgpt.com', thread, expectedRevision: 0 }), /INVALID_ATTACHMENT/);
  const g = memoryService(t, { adapter: { async preflight(b) { return { binding: { ...b, thread: other }, draft: { present: false, chars: 0 }, boundary: { sequence: 1, transcriptCount: 0 } }; } } });
  await g.service.connect({ targetId: 'tab', origin: 'https://chatgpt.com', thread, expectedRevision: 0 });
  assert.equal(g.service.read().identity.state, 'bound'); assert.equal(g.service.read().binding.thread.ref, thread.ref);
  await assert.rejects(g.service.submit({ key: 'k', prompt: 'p', confirm: true, expectedRevision: g.service.read().revision }), /PREFLIGHT_FAILED|DRAFT_OR_BINDING_NOT_READY/);
  assert.equal(g.calls.includes('type'), false);
});

test('service: invalid thread or inconsistent identity is refused at connect', async (t) => {
  const f = memoryService(t);
  await assert.rejects(f.service.connect({ targetId: 'tab', origin: 'https://chatgpt.com', thread: { kind: 'chatgpt-c', id: 'x', ref: 'chatgpt-c:x' }, expectedRevision: 0 }), /INVALID_BINDING/);
  await assert.rejects(f.service.connect({ targetId: 'tab', origin: 'https://chatgpt.com', identity: { state: 'bound' }, expectedRevision: 0 }), /INVALID_BINDING/);
  await assert.rejects(f.service.connect({ targetId: 'tab', origin: 'https://chatgpt.com', thread: parseThread('chatgpt', urlA), identity: { state: 'unverified', reason: 'X' }, expectedRevision: 0 }), /INVALID_BINDING/);
  assert.deepEqual(f.calls, []);
});

test('service: a legacy snapshot without identity is browseable but never silently verified for sends', async (t) => {
  const f = memoryService(t);
  await f.service.connect({ targetId: 'tab', origin: 'https://chatgpt.com', expectedRevision: 0 });
  const disk = JSON.parse(fs.readFileSync(f.file, 'utf8')); delete disk.identity; fs.writeFileSync(f.file, JSON.stringify(disk, null, 2));
  const before = sha(f.file);
  const calls = [];
  const reopened = createConversationService({ dataDir: f.dir, id: 'svc', recover: false, adapter: { async preflight() { calls.push('preflight'); }, async type() { calls.push('type'); }, async submit() { calls.push('submit'); } } });
  assert.equal(sha(f.file), before); assert.equal(reopened.read().identity.state, 'unverified'); assert.equal(reopened.read().identity.reason, 'LEGACY_SNAPSHOT');
  await assert.rejects(reopened.submit({ key: 'k', prompt: 'p', confirm: true, expectedRevision: reopened.read().revision }), (e) => e.code === 'THREAD_IDENTITY_UNVERIFIED');
  assert.deepEqual(calls, []); assert.equal(sha(f.file), before);
});

// ---------------------------------------------------------------- runtime
function fixture(t, { tabs, overrides = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'conversation-thread-runtime-')); const paths = { root, sessions: path.join(root, 'sessions') };
  const calls = [], adapters = [], site = { id: 'chatgpt', url: 'https://chatgpt.com/' };
  const live = { tabs: tabs ?? [{ id: 'tabA', type: 'page', url: urlA, title: 'PRIVATE TITLE' }], nav: null, reject: null };
  const dependencies = {
    leaseRoot: path.join(root, 'leases'), listSessions: () => [], ownerIsAlive: () => false,
    getAdapter: async (v) => (v === 'chatgpt' || String(v).startsWith('https://chatgpt.com') ? site : null),
    listTargets: async () => { if (live.reject) throw live.reject; return live.tabs; },
    createAdapter(options) {
      const adapter = { mayOwnResources: false, bytesWritten: 1, integrity: null,
        async connect(binding, hooks) { calls.push('connect'); adapter.binding = binding; if (options.freshTab) { binding.targetId = 'fresh'; hooks.bind(binding); }
          adapter.sessionId = `s-${adapters.length}`; hooks.ownSession(adapter.sessionId); return { binding, sessionId: adapter.sessionId }; },
        async preflight(binding) { calls.push('preflight'); if (live.nav) throw coded('BINDING_CHANGED'); return { binding, draft: { present: false, chars: 0 }, boundary: { sequence: 10, transcriptCount: 1 } }; },
        async type() { calls.push('type'); }, async submit(args) { calls.push('submit'); return { binding: args.binding, evidence: { ...args, sessionId: adapter.sessionId, sequence: 11, kind: 'new-user-turn', source: 'page' } }; },
        async reconcile() { return null; }, async readReply() { calls.push('reply'); return { state: 'ready', text: 'answer' }; }, stopWaiting() {},
        async readTranscript(limits) { calls.push('read'); if (live.nav) throw coded('BINDING_CHANGED');
          return { binding: adapter.binding, transcript: boundTranscript(raw(), { ...limits, perMessageCap: 100 }) }; },
        async stop() { calls.push('stop'); adapter.mayOwnResources = false; }, async closeTab() {} };
      adapters.push(adapter); return adapter;
    }, ...overrides };
  const runtime = createConversationRuntime({ paths, port: 19222, dependencies });
  t.after(async () => { await runtime.close().catch(() => {}); fs.rmSync(root, { recursive: true, force: true }); });
  const file = (id) => path.join(root, 'conversations', `${id}.conversation.json`);
  const leaseFree = () => acquireDriveLease({ root: dependencies.leaseRoot, port: 19222 }).release();
  return { runtime, paths, dependencies, calls, adapters, live, file, leaseFree, root,
    connect: (body = {}) => runtime.connect({ site: 'chatgpt', targetId: 'tabA', ...body }),
    submit: (c, body = {}) => runtime.submit(c.id, { key: 'one', prompt: 'prompt', confirm: true, expectedRevision: c.revision, ...body }) };
}

test('runtime targets: same-origin tabs carry distinct thread refs; titles and urls are never exposed or used', async (t) => {
  const f = fixture(t, { tabs: [{ id: 'tabA', type: 'page', url: urlA, title: 'PRIVATE TITLE' }, { id: 'tabB', type: 'page', url: urlB, title: 'PRIVATE TITLE' },
    { id: 'tabHome', type: 'page', url: 'https://chatgpt.com/', title: 'ChatGPT' }, { id: 'tabProject', type: 'page', url: `https://chatgpt.com/g/g-p-abc/c/${A}`, title: 'x' }] });
  const { targets } = await f.runtime.targets(); const by = Object.fromEntries(targets.map((x) => [x.id, x]));
  assert.equal(by.tabA.thread.ref, `chatgpt-c:${A}`); assert.equal(by.tabB.thread.ref, `chatgpt-c:${B}`); assert.equal(by.tabA.identity.state, 'bound');
  assert.equal(by.tabHome.thread, null); assert.equal(by.tabHome.identity.state, 'unverified'); assert.equal(by.tabProject.thread, null);
  assert.equal(JSON.stringify(targets).includes('PRIVATE TITLE'), false); assert.equal(targets.every((x) => x.title === 'chatgpt'), true);
});

test('runtime connect: existing /c tab is bound to its thread; carried through binding and identity', async (t) => {
  const f = fixture(t), c = await f.connect();
  assert.equal(c.binding.thread.ref, `chatgpt-c:${A}`); assert.equal(c.identity.state, 'bound');
  const disk = JSON.parse(fs.readFileSync(f.file(c.id), 'utf8')); assert.equal(disk.binding.thread.ref, `chatgpt-c:${A}`); assert.equal(disk.identity.state, 'bound');
  const x = await f.runtime.targets(); assert.equal(x.targets.find((v) => v.id === 'tabA').recorderOwner, null);
});

test('runtime connect: expectedThread must match the live tab; mismatch/unverified never holds the lease', async (t) => {
  const f = fixture(t);
  await assert.rejects(f.connect({ expectedThread: `chatgpt-c:${B}` }), (e) => e.status === 409 && e.code === 'BINDING_CHANGED'); f.leaseFree();
  f.live.tabs = [{ id: 'tabA', type: 'page', url: 'https://chatgpt.com/', title: 'x' }];
  await assert.rejects(f.connect({ expectedThread: `chatgpt-c:${A}` }), (e) => e.status === 409 && e.code === 'THREAD_IDENTITY_UNVERIFIED'); f.leaseFree();
  await assert.rejects(f.connect({ targetId: undefined, freshTab: true, expectedThread: `chatgpt-c:${A}` }), (e) => e.status === 400); f.leaseFree();
  assert.deepEqual(f.calls, []);
});

test('runtime: existing ChatGPT tab without a supported thread path is unverified and cannot send', async (t) => {
  const f = fixture(t, { tabs: [{ id: 'tabA', type: 'page', url: `https://chatgpt.com/g/g-p-abc/c/${A}`, title: 'x' }] });
  const c = await f.connect(); assert.equal(c.identity.state, 'unverified'); assert.equal(c.identity.reason, 'UNSUPPORTED_PATH'); assert.equal(c.state, 'blocked'); assert.equal(c.readiness.reason, 'THREAD_IDENTITY_UNVERIFIED');
  await assert.rejects(f.submit(c), (e) => e.status === 409 && e.code === 'THREAD_IDENTITY_UNVERIFIED');
  await assert.rejects(f.runtime.read(c.id, {}), (e) => e.status === 409 && e.code === 'THREAD_IDENTITY_UNVERIFIED');
  assert.equal(f.calls.some((n) => ['preflight', 'type', 'submit', 'read'].includes(n)), false);
});

test('runtime: fresh Studio-owned tab is unbound NEW_CHAT and cannot send until creation preflight proves no thread', async (t) => {
  const f = fixture(t), c = await f.connect({ targetId: undefined, freshTab: true });
  assert.equal(c.identity.state, 'unbound'); assert.equal(c.identity.reason, 'NEW_CHAT'); assert.equal(c.binding.thread, undefined);
  await assert.rejects(f.submit(c), (e) => e.code === 'THREAD_IDENTITY_UNVERIFIED'); await f.runtime.finish(c.id);
  assert.equal(f.calls.filter((n) => n === 'submit').length, 0);
});

test('runtime: same-tab navigation to another thread blocks the send before typing', async (t) => {
  const f = fixture(t), c = await f.connect(); f.live.nav = urlB;
  const ack = await f.submit(c); assert.equal(ack.turn.phase, 'preparing'); // registration is acknowledged before the preflight runs
  for (let n = 0; n < 200 && (await f.runtime.get(c.id)).turn?.phase !== 'blocked'; n++) await new Promise(setImmediate);
  const after = await f.runtime.get(c.id);
  assert.equal(after.state, 'blocked'); assert.equal(after.turn.phase, 'blocked'); assert.equal(after.readiness.reason, 'BINDING_CHANGED');
  assert.equal(f.calls.includes('type'), false); assert.equal(f.calls.includes('submit'), false);
});

test('runtime Read: bounded transcript, source-labelled, no snapshot write, no send path touched', async (t) => {
  const f = fixture(t), c = await f.connect(); const file = f.file(c.id), before = sha(file), calls = [...f.calls];
  const r = await f.runtime.read(c.id, { maxMessages: 2, maxChars: 500 });
  assert.equal(r.source, 'page-visible-dom'); assert.equal(r.messages.length, 2); assert.equal(r.coverage.complete, false); assert.equal(r.coverage.omittedMessages, 2);
  assert.equal(r.conversationId, c.id); assert.equal(r.revision, c.revision); assert.equal(r.binding.thread, `chatgpt-c:${A}`); assert.equal(r.identity.state, 'bound');
  assert.equal(r.limits.maxMessages, 2); assert.equal(r.limits.maxChars, 500);
  assert.equal(sha(file), before); assert.deepEqual(f.calls.slice(calls.length), ['read']);
  const defaults = await f.runtime.read(c.id, {}); assert.ok(defaults.limits.maxMessages >= 1 && defaults.limits.maxChars >= 1);
});

test('runtime Read: rejects unsafe limits, finished, non-live and navigated conversations without writing', async (t) => {
  const f = fixture(t), c = await f.connect(), file = f.file(c.id), before = sha(file);
  for (const body of [{ maxMessages: 0 }, { maxMessages: 201 }, { maxMessages: 1.5 }, { maxChars: 0 }, { maxChars: 200001 }, { maxChars: '10' }, { extra: 1 }])
    await assert.rejects(f.runtime.read(c.id, body), (e) => e.status === 400 && e.code === 'INVALID_READ', JSON.stringify(body));
  await assert.rejects(f.runtime.read('missing', {}), (e) => e.status === 404);
  f.live.nav = urlB; await assert.rejects(f.runtime.read(c.id, {}), (e) => e.status === 409 && e.code === 'BINDING_CHANGED'); f.live.nav = null;
  assert.equal(sha(file), before);
  const other = createConversationRuntime({ paths: f.paths, port: 19222, dependencies: f.dependencies }); t.after(() => other.close());
  await assert.rejects(other.read(c.id, {}), (e) => e.status === 409 && e.code === 'READ_REQUIRES_LIVE_CONVERSATION'); assert.equal(sha(file), before);
  f.adapters[0].readTranscript = undefined; await assert.rejects(f.runtime.read(c.id, {}), (e) => e.status === 501 && e.code === 'READ_UNAVAILABLE');
  await f.runtime.finish(c.id); await assert.rejects(f.runtime.read(c.id, {}), (e) => e.status === 409 && e.code === 'CONVERSATION_FINISHED');
});

test('runtime snapshot reads are pure: unfinished snapshot bytes are unchanged by list/get; recover is the explicit mutation', async (t) => {
  const f = fixture(t), c = await f.connect(); const file = f.file(c.id);
  const disk = JSON.parse(fs.readFileSync(file, 'utf8')); disk.state = 'attaching'; disk.owner = { pid: 2147483646 }; fs.writeFileSync(file, JSON.stringify(disk, null, 2));
  const before = sha(file), reader = createConversationRuntime({ paths: f.paths, port: 19222, dependencies: f.dependencies }); t.after(() => reader.close());
  const got = await reader.get(c.id), listed = await reader.list();
  assert.equal(sha(file), before); assert.equal(got.state, 'attaching'); assert.equal(got.recovery.pending, true); assert.equal(listed.find((x) => x.id === c.id).recovery.pending, true);
  assert.equal(got.reply.text, ''); assert.equal(await reader.get(c.id).then((x) => x.revision), got.revision);
  const recovered = await reader.recover(c.id); assert.notEqual(sha(file), before); assert.equal(recovered.state, 'needs-reconciliation');
  assert.equal((await reader.get(c.id)).recovery.pending, false);
});

test('runtime snapshot reads: a live-owner snapshot, a finished one and a corrupt one are all read without rewriting', async (t) => {
  const f = fixture(t, { overrides: { ownerIsAlive: () => true } }), c = await f.connect(), file = f.file(c.id), before = sha(file);
  const reader = createConversationRuntime({ paths: f.paths, port: 19222, dependencies: f.dependencies }); t.after(() => reader.close());
  const got = await reader.get(c.id); assert.equal(got.recovery.pending, false); assert.equal(sha(file), before);
  fs.writeFileSync(path.join(f.root, 'conversations', 'broken.conversation.json'), '{ not json'); const brokenBefore = sha(path.join(f.root, 'conversations', 'broken.conversation.json'));
  await assert.rejects(reader.get('broken'), (e) => e.status === 409); assert.equal(sha(path.join(f.root, 'conversations', 'broken.conversation.json')), brokenBefore);
});

test('runtime: legacy on-disk snapshot is browseable, reports unverified identity, and cannot send after explicit recovery', async (t) => {
  const f = fixture(t), c = await f.connect(), file = f.file(c.id);
  const disk = JSON.parse(fs.readFileSync(file, 'utf8')); delete disk.identity; delete disk.binding.thread; fs.writeFileSync(file, JSON.stringify(disk, null, 2));
  const before = sha(file), reader = createConversationRuntime({ paths: f.paths, port: 19222, dependencies: f.dependencies }); t.after(() => reader.close());
  const got = await reader.get(c.id); assert.equal(got.identity.state, 'unverified'); assert.equal(got.identity.reason, 'LEGACY_SNAPSHOT'); assert.equal(sha(file), before);
  await assert.rejects(reader.submit(c.id, { key: 'new', prompt: 'p', confirm: true, expectedRevision: got.revision }), (e) => e.status === 409);
  assert.equal(f.calls.filter((n) => n === 'type' || n === 'submit').length, 0);
});

test('runtime coded 503: CDP unavailable is BROWSER_UNAVAILABLE for targets and connect, not 500, and holds no lease', async (t) => {
  const f = fixture(t); f.live.reject = new TypeError('fetch failed');
  await assert.rejects(f.runtime.targets(), (e) => e.status === 503 && e.code === 'BROWSER_UNAVAILABLE' && !/fetch/.test(e.message));
  await assert.rejects(f.connect(), (e) => e.status === 503 && e.code === 'BROWSER_UNAVAILABLE'); f.leaseFree();
  assert.deepEqual(f.calls, []);
  f.live.reject = null; assert.equal((await f.runtime.targets()).targets.length, 1);
});
