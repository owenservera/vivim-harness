// Offline investigation of the actual fresh-tab adapter seam. No browser, network, or recorder.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createConversationBrowserAdapter } from '../../src/capture/conversation-browser-adapter.mjs';

const origin = 'https://chatgpt.com';
const root = `${origin}/`;
const thread = `/c/11111111-1111-4111-8111-111111111111`;
const idle = { observed: true, state: 'idle', idleControlPresent: true, stopPresent: false, composerEnabled: true };

function fixture({ urls = [root], pageOrigin = origin, pageOriginAt = null, pathname = '/', draftChars = 0, controls = idle, messages = [], transcriptOverride = null, authWall = null, armable = false, missingTarget = false } = {}) {
  const calls = [], bound = [];
  let targetReads = 0, originReads = 0, pagePath = pathname;
  const forbidden = (name) => () => { calls.push(name); throw new Error(`Forbidden ${name}`); };
  // A deterministic (non-timed) recorder stub, so a race past check() can be scripted exactly.
  class StubRecorder {
    constructor() { this.state = 'idle'; this.session = null; this.page = { send: async () => ({}) }; }
    on() {}
    async start(options) {
      this.session = { id: 'cap-race', raw: { seq: 4, stats: { bytes: 1 } }, kv: { set() {}, get() {} }, saveMeta() {} };
      options.onSessionCreated(this.session); this.state = 'recording'; return this.session;
    }
    tap() { return { close() {} }; }
    async stop() { this.state = 'idle'; return { verify: { ok: true } }; }
  }
  const adapter = createConversationBrowserAdapter({
    paths: { sessions: 'unused' }, profileStore: { load() {} }, port: 19222,
    siteAdapter: { id: 'chatgpt', url: root }, freshTab: true, conversationId: 'offline', ownerToken: 'fake',
    dependencies: {
      fetch: async (url, init) => { calls.push(['fetch', url, init.method]); return { ok: true, json: async () => ({ id: 'fresh' }) }; },
      attachIdlePage: async (id) => ({ send: async (method, params) => { calls.push(['page', id, method, params]); return {}; } }),
      listTargets: async () => (missingTarget ? [] : [{ id: 'fresh', url: (typeof urls === 'function' ? urls(targetReads++) : urls[Math.min(targetReads++, urls.length - 1)]) }]),
      evaluate: async (_, expression) => { if (expression.startsWith('(() => {') && transcriptOverride) return transcriptOverride; assert.ok(['location.origin', 'location.pathname'].includes(expression)); if (expression === 'location.pathname') return pagePath; return pageOriginAt ? pageOriginAt(originReads++) : pageOrigin; },
      findComposer: async () => ({ found: true }), detectAuthWall: async () => authWall ?? { blocked: false },
      detectSiteFailure: async () => ({ failed: false }), sendState: async () => ({ evalOk: true, draftChars }),
      readTurnPage: async () => ({ origin: pageOrigin, pathname: pagePath, messages, draft: { chars: draftChars }, controls }),
      sleep: async () => {}, readinessTimeoutMs: 50, connectGraceMs: 100,
      Recorder: armable ? StubRecorder : class { constructor() { forbidden('recorder')(); } },
      focusComposer: forbidden('focus'), typeText: forbidden('type'), sendMessage: forbidden('send'),
    },
  });
  return {
    adapter, setPagePath(value) { pagePath = value; },
    connect: () => adapter.connect({ targetId: 'pending', origin, ownedByStudio: true }, {
      bind: (binding) => bound.push(structuredClone(binding)), ownSession: armable ? () => {} : forbidden('ownSession'),
    }),
    verify() {
      assert.deepEqual(bound, [{ targetId: 'fresh', origin, ownedByStudio: true }]);
      assert.deepEqual(calls, [
        ['fetch', 'http://127.0.0.1:19222/json/new?about:blank', 'PUT'],
        ['page', 'fresh', 'Page.navigate', { url: root }],
      ]);
    },
    get targetReads() { return targetReads; },
  };
}

for (const [name, options, reason] of [
  ['stable root becomes ready', {}, null],
  ['initial about:blank polls until root is ready', { urls: ['about:blank', root] }, null],
  ['foreign target origin blocks', { urls: ['https://example.com/'] }, 'BINDING_CHANGED'],
  ['foreign page origin blocks', { pageOrigin: 'https://example.com' }, 'BINDING_CHANGED'],
  ['different target and page paths block', { pathname: '/different' }, 'BINDING_CHANGED'],
  ['preexisting exact thread blocks', { urls: [`${origin}${thread}`], pathname: thread }, 'PREEXISTING_THREAD'],
  ['draft present blocks', { draftChars: 3 }, 'DRAFT_PRESENT'],
  ['blank composer with disabled Send is ready for typing (not delivery)', {
    controls: { observed: false, state: 'unknown', idleControlPresent: false, stopPresent: false, composerEnabled: true }
  }, null],
  ['unexpected root transcript does not prove blank creation', {
    messages: [{ role: 'assistant', id: 'existing', text: 'old' }]
  }, 'READINESS_TIMEOUT'],
  ['observed stop control prevents new-chat readiness', {
    controls: { observed: true, state: 'busy', idleControlPresent: false, stopPresent: true, composerEnabled: true }
  }, 'READINESS_TIMEOUT'],
  ['disabled composer prevents new-chat readiness', {
    controls: { observed: false, state: 'unknown', idleControlPresent: false, stopPresent: false, composerEnabled: false }
  }, 'READINESS_TIMEOUT'],
  ['contradictory busy state cannot be admitted as a blank composer', {
    controls: { observed: false, state: 'busy', idleControlPresent: false, stopPresent: false, composerEnabled: true }
  }, 'READINESS_TIMEOUT'],
  ['non-home route even with matching target/page paths is refused', {
    urls: [`${origin}/g/custom-gpt`], pathname: '/g/custom-gpt'
  }, 'BINDING_CHANGED'],
]) {
  test(name, async () => {
    const f = fixture(options);
    try {
      const result = await f.connect();
      assert.equal(result.readiness.ready, reason === null);
      assert.equal(result.readiness.reason, reason);
      assert.equal(result.deferredCapture, true);
      assert.equal(result.sessionId, null);
      assert.equal(result.binding.targetId, 'fresh');
      if (!reason) assert.deepEqual(result.readiness.creation, { threadless: true });
      if (name.startsWith('initial')) assert.ok(f.targetReads >= 3);
    } finally { f.verify(); }
  });
}

test('a fresh tab whose target reports an uncommitted null origin then settles becomes ready', async () => {
  // Mirrors the live shape: the first target sample has origin 'null' but is NOT about:blank
  // (`chrome://newtab/`), which previously returned blocked('BINDING_CHANGED') at the :123 guard
  // before the catch could ever run. It must poll through and settle on the real origin.
  const f = fixture({ urls: ['chrome://newtab/', root] });
  const result = await f.connect();
  assert.equal(result.readiness.ready, true);
  assert.equal(result.readiness.reason, null);
  assert.equal(result.binding.targetId, 'fresh');
});

test('a fresh tab transiently reporting about:blank mid-connect retries instead of aborting', async () => {
  // Deterministic sample script: home, about:blank, about:blank, home. The uncommitted target is
  // transient here, exactly as :123/:127 already tolerate it, so readiness must recover.
  let reads = 0;
  const f = fixture({ urls: () => { const n = ++reads; return (n === 2 || n === 3) ? 'about:blank' : root; } });
  const result = await f.connect();
  assert.equal(result.readiness.ready, true);
  assert.equal(result.readiness.reason, null);
});

test('a target pinned to chrome://newtab/ for the whole window can never report ready', async () => {
  // FIX 3b tolerates a null target origin, so this is the fail-open fence: with the target stuck on a
  // null-origin scheme for the entire window, the tolerance may only defer. `ready: true` is reachable
  // from one place, the `loc` branch (:158), and `loc` exists only when creationLocation() matched the
  // binding origin (:106) on a `/` route (:161). A null-origin target fails :106, so the composer probe
  // and its ready return (:174) are never reached; the loop must end at the deadline instead.
  const f = fixture({ urls: ['chrome://newtab/'] });
  try {
    const result = await f.connect();
    assert.equal(result.readiness.ready, false);
    assert.equal(result.readiness.reason, 'READINESS_TIMEOUT');
    assert.equal(result.deferredCapture, true);
    assert.equal(result.sessionId, null);
    assert.equal(result.binding.targetId, 'fresh');
  } finally { f.verify(); }
});

test('a target pinned to about:blank resolves blocked rather than throwing', async () => {
  // Never committed, so never a binding change: the connect ends at the deadline instead of throwing.
  const f = fixture({ urls: [root, 'about:blank'] });
  const result = await f.connect();
  assert.equal(result.readiness.ready, false);
  assert.equal(result.readiness.reason, 'READINESS_TIMEOUT');
  assert.equal(result.deferredCapture, true);
});

test('a target that commits a foreign origin inside creationLocation stays a terminal throw', async () => {
  // Catch-path coverage for the surviving terminal case: https://example.com is parseable, is not
  // 'null', and is not the binding origin, so it must re-throw rather than poll to the deadline.
  const f = fixture({ urls: [root, 'https://example.com/'] });
  await assert.rejects(f.connect(), (error) => error.code === 'BINDING_CHANGED');
});

test('an unreadable auth check is unknown: readiness does not report AUTH_WALL and keeps polling', async () => {
  const f = fixture({ authWall: { blocked: null, reason: 'auth check unavailable: synthetic' } });
  try {
    const result = await f.connect();
    assert.notEqual(result.readiness.reason, 'AUTH_WALL');
    assert.equal(result.deferredCapture, true);
  } finally { f.verify(); }
});

test('a /c/<uuid> landing after a passing home check is refused by preflight as PREEXISTING_THREAD', async () => {
  // Deterministic race: check() samples the home route, creationLocation() then sees an /c/ thread.
  // Without this test the preflight PREEXISTING_THREAD throw is permanently dark behind check():179.
  let raced = false, racedReads = 0;
  const f = fixture({ armable: true, urls: () => (raced ? (racedReads++ === 0 ? root : `${origin}${thread}`) : root) });
  const connected = await f.connect();
  assert.equal(connected.readiness.ready, true);
  assert.equal(await f.adapter.armCapture(), 'cap-race');
  raced = true;
  try {
    await assert.rejects(f.adapter.preflight({}, {}), (e) =>
      e.code === 'PREEXISTING_THREAD' && e.notDispatched === true && e.notTyped === true);
  } finally { f.verify(); }
});

test('a transient unreadable location sample during creation connect is not a terminal binding change', async () => {
  // Scenario A: the second target read (creationLocation) returns a URL that cannot be parsed once.
  // Polling must tolerate it and reach readiness on the next sample instead of failing the connect.
  let reads = 0;
  const f = fixture({ urls: () => (++reads === 2 ? '' : root) });
  const result = await f.connect();
  assert.equal(result.readiness.ready, true);
  assert.equal(result.readiness.reason, null);
});

test('a non-transient page sample keeps the connect honest: no throw, no ready, recorded reason', async () => {
  // Scenario C: the target stays correct, but every page-level origin sample is uncommitted
  // ('null') so creationLocation keeps raising BINDING_CHANGED. The deadline verdict carries the
  // recorded reason rather than READINESS_TIMEOUT, the connect does not reject, and the composer
  // probe is never reached, so the conversation can never read as ready.
  const f = fixture({ pageOriginAt: (n) => (n % 2 === 0 ? origin : 'null') });
  const result = await f.connect();
  assert.equal(result.readiness.ready, false);
  assert.equal(result.readiness.reason, 'BINDING_CHANGED');
  assert.deepEqual(result.readiness.draft, { present: null, chars: null });
});

test('a missing target stays a hard TARGET_DISAPPEARED, never a transient', async () => {
  const f = fixture({ missingTarget: true });
  const result = await f.connect();
  assert.equal(result.readiness.ready, false);
  assert.equal(result.readiness.reason, 'TARGET_DISAPPEARED');
});

test('unbound Read refuses target and page drift without any typing or send', async () => {
  const urls = [root], f = fixture({ urls });
  await f.connect();
  urls[0] = `${origin}${thread}`;
  await assert.rejects(f.adapter.readTranscript({ maxMessages: 5, maxChars: 100 }),
    (error) => error.code === 'BINDING_CHANGED');
  urls[0] = root;
  f.setPagePath(thread);
  await assert.rejects(f.adapter.readTranscript({ maxMessages: 5, maxChars: 100 }),
    (error) => error.code === 'BINDING_CHANGED');
  f.verify(); // Only one owned tab, one navigation; no recorder or send.
});

test('unbound Read rejects a transient non-home evaluated snapshot even when pre/post checks agree', async () => {
  const f = fixture({ transcriptOverride: {
    origin, pathname: thread, messages: [], controls: idle,
    renderedTotal: 0, scannedCount: 0, scroll: { found: false }
  } });
  await f.connect();
  await assert.rejects(f.adapter.readTranscript({ maxMessages: 5, maxChars: 100 }),
    (error) => error.code === 'BINDING_CHANGED');
  f.verify();
});
