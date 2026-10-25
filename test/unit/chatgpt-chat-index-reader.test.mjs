// Read-only rendered chat-index reader: explicit target, pre/post guards, one index expression.
// Fake CDP only: no browser, no network, no Recorder, no lease, no file writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { readChatIndex, createDefaultOpenSession } from '../../src/capture/chatgpt-chat-index-reader.mjs';
import { CHAT_INDEX_IDENTITY } from '../../src/capture/chatgpt-chat-index.mjs';

const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222', C = '33333333-3333-4333-8333-333333333333';
const ROOT = 'https://chatgpt.com/';
const codeOf = (code, status) => (e) => e.code === code && (status === undefined || e.status === status);

// ------------------------------------------------------------------ fixtures
const tripwires = [];
const anchor = (href, text, { visible = true, closest = () => null } = {}) => ({
  getAttribute: (name) => (name === 'href' ? href : null), innerText: text,
  getBoundingClientRect: () => (visible ? { width: 120, height: 24 } : { width: 0, height: 0 }), closest,
  focus: () => tripwires.push('focus'), click: () => tripwires.push('click'), scrollIntoView: () => tripwires.push('scrollIntoView'),
  dispatchEvent: () => tripwires.push('dispatchEvent'), scrollTo: () => tripwires.push('scrollTo'),
});

// One world: tabs (for /json/list), per-tab live page (for Runtime.evaluate), and a call log.
function world({ tabs, pages = {}, anchors = [], browserDown = false, attachError = null, closeError = null, flipPathAt = null, flipPathOn = null, listHook = null } = {}) {
  const log = { list: 0, opened: [], closed: [], sends: [], evals: [], closeTarget: 0 };
  tripwires.length = 0;
  const state = { tabs: tabs ?? [{ id: 'tabRoot', type: 'page', url: ROOT, title: 'PRIVATE TITLE' }], pages, anchors, pathReads: 0 };
  const pageOf = (targetId) => {
    const tab = state.tabs.find((t) => t.id === targetId);
    const url = new URL(state.pages[targetId] ?? tab?.url ?? 'about:blank');
    const loc = { get origin() { return url.origin; }, get pathname() {
      state.pathReads++;
      if (flipPathAt && state.pathReads >= flipPathAt) return `/c/${B}`;
      if (flipPathOn?.includes(state.pathReads)) return `/c/${B}`; // a transient change on exactly one read
      return url.pathname; } };
    return { document: { querySelectorAll: (sel) => (sel === 'a[href]' ? state.anchors : []) }, location: loc };
  };
  const deps = {
    port: 19222,
    async listTargets({ port }) {
      log.list++; assert.equal(port, 19222);
      if (browserDown) throw new TypeError('fetch failed');
      listHook?.(log.list, state);
      return state.tabs.map((t) => ({ ...t }));
    },
    async openSession({ targetId, port }) {
      assert.equal(port, 19222);
      if (attachError) throw attachError;
      log.opened.push(targetId);
      const sandbox = pageOf(targetId);
      const session = {
        sessionId: `s-${log.opened.length}`, targetId,
        async send(method, params) {
          log.sends.push([method, params]);
          if (method !== 'Runtime.evaluate') return {};
          log.evals.push(params.expression);
          const value = JSON.parse(JSON.stringify(vm.runInNewContext(params.expression, sandbox) ?? null));
          return { result: { value } };
        },
      };
      return { session, async close() { log.closed.push(targetId); if (closeError) throw closeError; } };
    },
  };
  return { deps, log, state };
}
const read = (w, request = {}) => readChatIndex({ targetId: 'tabRoot', ...request }, w.deps);
const idCalls = (log) => log.evals.filter((e) => !e.includes('ANCHORS'));
const indexCalls = (log) => log.evals.filter((e) => e.includes('ANCHORS'));

// ------------------------------------------------------------------ happy paths
test('root page lists rendered thread links without any /c tab, capture, lease or write', async () => {
  const w = world({ anchors: [anchor(`/c/${A}`, 'First chat'), anchor(`/c/${B}`, 'Second chat'), anchor('/', 'Home'), anchor(`/c/${A}`, 'First chat')] });
  const out = await read(w);
  assert.equal(out.targetId, 'tabRoot'); assert.equal(out.origin, 'https://chatgpt.com'); assert.ok(Date.parse(out.readAt));
  assert.equal(out.index.complete, false); assert.equal(out.index.scope, 'currently-rendered-links'); assert.equal(out.index.source, 'page-visible-dom');
  assert.deepEqual(out.index.entries.map((e) => e.threadRef), [`chatgpt-c:${A}`, `chatgpt-c:${B}`]);
  assert.equal(out.index.entries[0].occurrences, 2); assert.equal(out.index.entries[0].displayTitle.untrusted, true);
  assert.deepEqual(out.context.page, { origin: 'https://chatgpt.com', pathKind: 'root', threadRef: null });
  assert.equal(out.context.sideEffects, 'none'); assert.equal(out.context.source, 'local-studio-cdp-reader');
  assert.equal(JSON.stringify(out).includes('PRIVATE TITLE'), false); // the tab title is never read or returned
  assert.equal(w.log.list, 2); assert.deepEqual(w.log.opened, ['tabRoot']); assert.deepEqual(w.log.closed, ['tabRoot']);
  assert.equal(indexCalls(w.log).length, 1); assert.equal(idCalls(w.log).length, 2);
  assert.deepEqual([...new Set(w.log.sends.map(([m]) => m))], ['Runtime.evaluate']); assert.deepEqual(tripwires, []);
});

test('the reader module imports no Recorder, lease, session store, filesystem or HTTP client', () => {
  const source = readFileSync(new URL('../../src/capture/chatgpt-chat-index-reader.mjs', import.meta.url), 'utf8');
  const imports = [...source.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1]);
  for (const forbidden of [/recorder/i, /drive-lease/, /store\//, /^node:(fs|http|https|net|child_process)/, /actions\.mjs/, /conversation-(runtime|service|browser-adapter|api)/]) {
    assert.equal(imports.some((i) => forbidden.test(i)), false, `${forbidden} in ${imports.join(',')}`);
  }
  assert.equal(/\bfetch\(|XMLHttpRequest|closeTarget|Page\.|Input\.|Network\./.test(source.replace(/\/\/.*$/gm, '')), false);
});

test('an explicit target among many tabs: only that session is opened, other tabs are never touched', async () => {
  const tabs = [{ id: 'other', type: 'page', url: `https://chatgpt.com/c/${C}`, title: 'x' }, { id: 'tabSidebar', type: 'page', url: `https://chatgpt.com/c/${A}`, title: 'y' },
    { id: 'foreign', type: 'page', url: 'https://example.com/', title: 'z' }];
  const w = world({ tabs, anchors: [anchor(`/c/${B}`, 'B chat')] });
  const out = await readChatIndex({ targetId: 'tabSidebar' }, w.deps);
  assert.deepEqual(w.log.opened, ['tabSidebar']); assert.equal(out.context.page.pathKind, 'thread'); assert.equal(out.context.page.threadRef, `chatgpt-c:${A}`);
  assert.deepEqual(out.index.entries.map((e) => e.threadRef), [`chatgpt-c:${B}`]);
});

test('the same containers option feeds the expression and the normaliser', async () => {
  const sidebarLink = anchor(`/c/${A}`, 'In sidebar', { closest: (sel) => (sel === 'nav' ? {} : null) });
  const w = world({ anchors: [sidebarLink, anchor(`/c/${B}`, 'Elsewhere')] });
  const withContainers = await read(w, { containers: [{ label: 'sidebar', selector: 'nav' }] });
  assert.deepEqual(withContainers.index.entries.map((e) => e.container), ['sidebar', 'unknown']);
  assert.ok(indexCalls(w.log)[0].includes('"nav"'));
  const plain = await read(world({ anchors: [sidebarLink] }));
  assert.equal(plain.index.entries[0].container, 'unknown');
});

test('hostile links and titles are omitted or neutralised and counted, never thrown or leaked as identity', async () => {
  const w = world({ anchors: [anchor('javascript:alert(1)', 'x'), anchor('data:text/html,hi', 'x'), anchor('https://evil.example/c/' + A, 'x'), anchor('file:///etc/passwd', 'x'),
    anchor(`/c/${A}/extra`, 'x'), anchor(`/g/g-p-abc/c/${A}`, 'project'), anchor(`/c/${B}`, 'bad\u0000\u200btitle\n'.padEnd(400, 'z')), anchor('/c/' + 'x'.repeat(900), 'long'), anchor(`/c/${C}`, 'hidden', { visible: false }), null]
    .filter(Boolean) });
  const out = await read(w, { maxTitleChars: 20 });
  assert.deepEqual(out.index.entries.map((e) => e.threadRef), [`chatgpt-c:${B}`]);
  assert.ok([...out.index.entries[0].displayTitle.text].length <= 20); assert.equal(/[\u0000\u200b]/.test(out.index.entries[0].displayTitle.text), false);
  const skippedTotal = Object.values(out.index.skipped).reduce((n, v) => n + v, 0); // code names belong to the shared module; only the total is asserted
  assert.ok(skippedTotal >= 7); assert.equal(out.index.complete, false);
});

test('index identity is a candidate only: nothing is bound, foreign or alias origins never merge into the page origin', async () => {
  const w = world({ anchors: [anchor(`/c/${A}`, 'Mine'), anchor(`https://www.chatgpt.com/c/${A}`, 'Alias origin'), anchor(`https://chat.openai.com/c/${A}`, 'Other alias'),
    anchor(`https://chatgpt.com:8443/c/${C}`, 'Other port'), anchor(`https://user:pw@chatgpt.com/c/${C}`, 'Credentials'), anchor(`https://evil.example/c/${A}`, 'Foreign'), anchor(`/c/${B}`, 'Second')] });
  const out = await read(w);
  assert.deepEqual(out.index.entries.map((e) => e.threadRef), [`chatgpt-c:${A}`, `chatgpt-c:${B}`]);
  assert.equal(out.index.entries.every((e) => e.identity.state === 'candidate' && e.identity.reason === CHAT_INDEX_IDENTITY.reason), true);
  assert.equal(out.index.entries.every((e) => e.liveBinding.state === 'not-established'), true); assert.equal(out.index.candidatesOnly, true);
  assert.equal(JSON.stringify(out).includes('"state":"bound"'), false);
  assert.equal(out.index.entries.every((e) => e.origin === undefined || e.origin === 'https://chatgpt.com'), true);
  assert.equal(out.context.identityPolicy, 'rendered-links-are-candidates-not-verified-bindings');
});

test('the reader itself enforces the origin: a result claiming another origin is refused, a missing or evil origin cannot rebind relative links', async () => {
  for (const claimed of ['https://evil.example', 'https://www.chatgpt.com']) {
    const w = world({ anchors: [anchor(`/c/${A}`, 'x')] }); const open = w.deps.openSession;
    w.deps.openSession = async (args) => { const s = await open(args); const send = s.session.send;
      s.session.send = async (m, p) => { const r = await send(m, p); if (p.expression.includes('ANCHORS')) r.result.value.result.origin = claimed; return r; }; return s; };
    await assert.rejects(read(w), codeOf('BINDING_CHANGED', 409), claimed);
  }
  const w = world({ anchors: [anchor(`/c/${A}`, 'x')] }); const open = w.deps.openSession;
  w.deps.openSession = async (args) => { const s = await open(args); const send = s.session.send;
    s.session.send = async (m, p) => { const r = await send(m, p); if (p.expression.includes('ANCHORS')) delete r.result.value.result.origin; return r; }; return s; };
  const out = await read(w);
  assert.deepEqual(out.index.entries.map((e) => e.threadRef), [`chatgpt-c:${A}`]); assert.equal(out.origin, 'https://chatgpt.com');
});

test('bounds hold: maxEntries and scanLimit truncate honestly', async () => {
  const many = Array.from({ length: 30 }, (_, i) => anchor(`/c/aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, '0')}`, `Chat ${i}`));
  const out = await read(world({ anchors: many }), { maxEntries: 5, scanLimit: 20 });
  assert.equal(out.index.entries.length, 5); assert.equal(out.index.coverage.truncatedScan, true); assert.ok(out.index.coverage.omittedEntries > 0);
});

// ------------------------------------------------------------------ validation before any browser action
test('invalid requests and options are 400 before any listing, attach or evaluation', async () => {
  const bad = [{ maxEntries: 0 }, { maxEntries: 501 }, { maxEntries: 1.5 }, { maxTitleChars: 0 }, { maxTitleChars: 301 }, { scanLimit: 0 }, { scanLimit: 2001 }, { maxEntries: '5' },
    { containers: 'nav' }, { containers: [{ label: 'unknown', selector: 'nav' }] }, { containers: [{ label: 'ok', selector: '' }] }, { containers: Array.from({ length: 9 }, () => ({ label: 'ok', selector: 'nav' })) },
    { anchorSelectors: ['a'] }, { extra: 1 }, { site: 'claude' }, { targetId: '' }, { targetId: 5 }, { targetId: 'x'.repeat(257) }];
  for (const patch of bad) {
    const w = world();
    await assert.rejects(readChatIndex({ targetId: 'tabRoot', ...patch }, w.deps), (e) => e.status === 400 && /^INVALID_CHAT_INDEX_(OPTIONS|REQUEST)$/.test(e.code), JSON.stringify(patch));
    assert.equal(w.log.list + w.log.opened.length + w.log.evals.length, 0, JSON.stringify(patch));
  }
  const w = world(); w.deps.port = 'nope';
  await assert.rejects(readChatIndex({ targetId: 'tabRoot' }, w.deps), codeOf('INVALID_CHAT_INDEX_REQUEST', 400)); assert.equal(w.log.list, 0);
  await assert.rejects(readChatIndex(null, world().deps), codeOf('INVALID_CHAT_INDEX_REQUEST', 400));
});

// ------------------------------------------------------------------ target and site checks
test('unknown target is 404 and a non-ChatGPT or spoofed tab is 409, with no session attached', async () => {
  const w = world(); await assert.rejects(readChatIndex({ targetId: 'missing' }, w.deps), codeOf('TARGET_NOT_FOUND', 404)); assert.deepEqual(w.log.opened, []);
  for (const url of ['https://example.com/', 'about:blank', 'chrome://newtab/', 'http://chatgpt.com/', 'https://chatgpt.com.evil.test/', 'https://evilchatgpt.com/', 'https://sub.chatgpt.com/', 'not a url',
    'https://www.chatgpt.com/', 'https://chat.openai.com/', 'https://user:pw@chatgpt.com/', 'https://chatgpt.com:8443/']) { // only the exact canonical origin passes the preflight
    const x = world({ tabs: [{ id: 'tabRoot', type: 'page', url }] });
    await assert.rejects(read(x), codeOf('TARGET_SITE_MISMATCH', 409), url); assert.deepEqual(x.log.opened, [], url);
  }
  const y = world({ tabs: [{ id: 'tabRoot', type: 'service_worker', url: ROOT }] });
  await assert.rejects(read(y), codeOf('TARGET_SITE_MISMATCH', 409));
});

test('browser down is 503 BROWSER_UNAVAILABLE at listing and at attach; a vanished target at attach is 404', async () => {
  const down = world({ browserDown: true }); await assert.rejects(read(down), (e) => e.status === 503 && e.code === 'BROWSER_UNAVAILABLE' && !/fetch/.test(e.message));
  const noWs = world({ attachError: new Error('CDP connect failed: ws://127.0.0.1:19222') });
  await assert.rejects(read(noWs), (e) => e.status === 503 && e.code === 'BROWSER_UNAVAILABLE' && !/ws:/.test(e.message));
  const gone = world({ attachError: Object.assign(new Error('Target.attachToTarget: No target with given id found'), { code: -32602 }) });
  await assert.rejects(read(gone), codeOf('TARGET_NOT_FOUND', 404));
});

// ------------------------------------------------------------------ navigation / swaps around the one read
test('page already moved since the listing: BINDING_CHANGED and the index is never evaluated', async () => {
  const w = world({ pages: { tabRoot: `https://chatgpt.com/c/${B}` } });
  await assert.rejects(read(w), codeOf('BINDING_CHANGED', 409)); assert.equal(indexCalls(w.log).length, 0); assert.deepEqual(w.log.closed, ['tabRoot']);
});

test('same hostname family is not enough: an alias or foreign page origin behind an exact-origin tab is refused before the index runs', async () => {
  for (const alias of ['https://www.chatgpt.com/', 'https://chat.openai.com/', 'https://chatgpt.com:8443/']) {
    const swapped = world({ pages: { tabRoot: alias } });
    await assert.rejects(read(swapped), codeOf('TARGET_SITE_MISMATCH', 409), alias); assert.equal(indexCalls(swapped.log).length, 0, alias);
  }
  const foreign = world({ pages: { tabRoot: 'https://example.com/' } });
  await assert.rejects(read(foreign), codeOf('TARGET_SITE_MISMATCH', 409)); assert.equal(indexCalls(foreign.log).length, 0);
});

test('navigation during the read (inside the same evaluation) discards the result', async () => {
  const w = world({ anchors: [anchor(`/c/${A}`, 'x')], flipPathAt: 3 }); // reads: pre-identity, wrapper before, wrapper after
  await assert.rejects(read(w), codeOf('BINDING_CHANGED', 409)); assert.equal(indexCalls(w.log).length, 1); assert.deepEqual(w.log.closed, ['tabRoot']);
});

test('a transient path change on exactly one side of the index expression is still caught (each side has its own guard)', async () => {
  for (const read of [2, 3]) { // 1 = pre-identity, 2 = index before, 3 = index after, 4 = post-identity
    const w = world({ anchors: [anchor(`/c/${A}`, 'x')], flipPathOn: [read] });
    await assert.rejects(readChatIndex({ targetId: 'tabRoot' }, w.deps), codeOf('BINDING_CHANGED', 409), `read ${read}`); assert.deepEqual(w.log.closed, ['tabRoot']);
  }
});

test('navigation after the read (post target check or post page identity) discards the result', async () => {
  const afterList = world({ anchors: [anchor(`/c/${A}`, 'x')], listHook: (n, state) => { if (n === 2) state.tabs[0].url = `https://chatgpt.com/c/${B}`; } });
  await assert.rejects(read(afterList), codeOf('BINDING_CHANGED', 409));
  const afterPage = world({ anchors: [anchor(`/c/${A}`, 'x')], flipPathAt: 4 }); // the final identity read
  await assert.rejects(read(afterPage), codeOf('BINDING_CHANGED', 409));
});

test('target disappears or changes kind after the read: 404 / 409, no result', async () => {
  const gone = world({ anchors: [anchor(`/c/${A}`, 'x')], listHook: (n, state) => { if (n === 2) state.tabs = []; } });
  await assert.rejects(read(gone), codeOf('TARGET_NOT_FOUND', 404)); assert.deepEqual(gone.log.closed, ['tabRoot']);
  const swapped = world({ anchors: [anchor(`/c/${A}`, 'x')], listHook: (n, state) => { if (n === 2) state.tabs[0].url = 'https://example.com/'; } });
  await assert.rejects(read(swapped), (e) => e.status === 409 && ['TARGET_SITE_MISMATCH', 'BINDING_CHANGED'].includes(e.code));
});

// ------------------------------------------------------------------ failure handling and cleanup
test('a failing or malformed evaluation is a coded error, the self-owned session is closed once, no target is closed', async () => {
  const w = world({ anchors: [anchor(`/c/${A}`, 'x')] });
  const original = w.deps.openSession;
  w.deps.openSession = async (args) => { const s = await original(args); const send = s.session.send; s.session.send = async (m, p) => (p.expression.includes('ANCHORS') ? { exceptionDetails: { text: 'boom with private text' } } : send(m, p)); return s; };
  await assert.rejects(read(w), (e) => e.status === 409 && e.code === 'INDEX_EVAL_FAILED' && !/private/.test(e.message));
  assert.deepEqual(w.log.closed, ['tabRoot']); assert.equal(w.log.closeTarget, 0);
  const odd = world({ anchors: [] }); const o = odd.deps.openSession;
  odd.deps.openSession = async (args) => { const s = await o(args); const send = s.session.send; s.session.send = async (m, p) => (p.expression.includes('ANCHORS') ? { result: { value: 'not an object' } } : send(m, p)); return s; };
  await assert.rejects(read(odd), codeOf('INDEX_READ_FAILED', 409)); assert.deepEqual(odd.log.closed, ['tabRoot']);
});

test('a failing cleanup never masks the real outcome', async () => {
  const ok = world({ anchors: [anchor(`/c/${A}`, 'x')], closeError: new Error('detach failed') });
  assert.equal((await read(ok)).index.entries.length, 1);
  const bad = world({ pages: { tabRoot: `https://chatgpt.com/c/${B}` }, closeError: new Error('detach failed') });
  await assert.rejects(read(bad), codeOf('BINDING_CHANGED', 409));
});

test('concurrent reads of different targets use separate sessions and each cleans up its own', async () => {
  const tabs = [{ id: 't1', type: 'page', url: ROOT }, { id: 't2', type: 'page', url: `https://chatgpt.com/c/${A}` }];
  const w = world({ tabs, anchors: [anchor(`/c/${B}`, 'x')] });
  const [r1, r2] = await Promise.all([readChatIndex({ targetId: 't1' }, w.deps), readChatIndex({ targetId: 't2' }, w.deps)]);
  assert.equal(r1.targetId, 't1'); assert.equal(r2.targetId, 't2'); assert.deepEqual([...w.log.opened].sort(), ['t1', 't2']); assert.deepEqual([...w.log.closed].sort(), ['t1', 't2']);
});

// ------------------------------------------------------------------ no unsafe operation
test('only read-only Runtime.evaluate is sent, without gesture or promise awaiting, and the page code has no unsafe verbs', async () => {
  const w = world({ anchors: [anchor(`/c/${A}`, 'x')] }); await read(w);
  for (const [method, params] of w.log.sends) {
    assert.equal(method, 'Runtime.evaluate'); assert.equal(params.returnByValue, true);
    assert.notEqual(params.userGesture, true); assert.notEqual(params.awaitPromise, true); assert.ok(Number.isInteger(params.timeout) && params.timeout > 0);
  }
  for (const expr of w.log.evals) assert.equal(/scroll|click|focus|fetch\(|XMLHttpRequest|navigate|location\s*=|location\.(href|assign|replace)\s*=|submit\(|dispatchEvent|\.value\s*=|innerHTML\s*=/.test(expr.replace(/scrollIntoView/g, '')), false, expr.slice(0, 80));
  assert.deepEqual(tripwires, []);
});

// ------------------------------------------------------------------ default session opener uses the existing CDP client API
test('default openSession: exact-target flatten attach, then detach only its own session and close its own socket', async () => {
  const sent = [], attached = [], detached = [], closed = [];
  const connection = { async attach(targetId, opts) { attached.push([targetId, opts]); return { sessionId: 'sess-1', send: async (m) => { sent.push(m); return {}; } }; },
    async detach(sessionId) { detached.push(sessionId); }, close() { closed.push('socket'); }, async send(m) { sent.push(m); return {} } };
  const calls = [];
  const open = createDefaultOpenSession({ browserWsUrl: async (o) => { calls.push(['ws', o.port]); return 'ws://127.0.0.1:19222/devtools/browser/x'; }, connect: async (url, o) => { calls.push(['connect', url, o.requestTimeoutMs > 0]); return connection; } });
  const handle = await open({ targetId: 'tabRoot', port: 19222 });
  assert.deepEqual(attached.map(([id]) => id), ['tabRoot']); assert.equal(handle.session.sessionId, 'sess-1');
  await handle.close(); await handle.close();
  assert.deepEqual(detached, ['sess-1']); assert.deepEqual(closed, ['socket', 'socket'].slice(0, closed.length)); assert.ok(closed.length >= 1);
  assert.equal(sent.some((m) => /closeTarget|Page\.|Input\./.test(m)), false);
  const failing = createDefaultOpenSession({ browserWsUrl: async () => 'ws://127.0.0.1:19222/x', connect: async () => ({ async attach() { throw new Error('No target with given id found'); }, close() { closed.push('failed-attach'); } }) });
  await assert.rejects(failing({ targetId: 'gone', port: 19222 }), /No target/); assert.ok(closed.includes('failed-attach'));
});
