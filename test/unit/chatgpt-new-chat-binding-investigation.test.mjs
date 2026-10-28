// Offline investigation of the actual fresh-tab adapter seam. No browser, network, or recorder.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createConversationBrowserAdapter } from '../../src/capture/conversation-browser-adapter.mjs';

const origin = 'https://chatgpt.com';
const root = `${origin}/`;
const thread = `/c/11111111-1111-4111-8111-111111111111`;
const idle = { observed: true, state: 'idle', idleControlPresent: true, stopPresent: false, composerEnabled: true };

function fixture({ urls = [root], pageOrigin = origin, pathname = '/', draftChars = 0, controls = idle, messages = [] } = {}) {
  const calls = [], bound = [];
  let targetReads = 0, pagePath = pathname;
  const forbidden = (name) => () => { calls.push(name); throw new Error(`Forbidden ${name}`); };
  const adapter = createConversationBrowserAdapter({
    paths: { sessions: 'unused' }, profileStore: { load() {} }, port: 19222,
    siteAdapter: { id: 'chatgpt', url: root }, freshTab: true, conversationId: 'offline', ownerToken: 'fake',
    dependencies: {
      fetch: async (url, init) => { calls.push(['fetch', url, init.method]); return { ok: true, json: async () => ({ id: 'fresh' }) }; },
      attachIdlePage: async (id) => ({ send: async (method, params) => { calls.push(['page', id, method, params]); return {}; } }),
      listTargets: async () => [{ id: 'fresh', url: urls[Math.min(targetReads++, urls.length - 1)] }],
      evaluate: async (_, expression) => { assert.ok(['location.origin', 'location.pathname'].includes(expression)); return expression === 'location.origin' ? pageOrigin : pagePath; },
      findComposer: async () => ({ found: true }), detectAuthWall: async () => ({ blocked: false }),
      detectSiteFailure: async () => ({ failed: false }), sendState: async () => ({ evalOk: true, draftChars }),
      readTurnPage: async () => ({ origin: pageOrigin, pathname: pagePath, messages, draft: { chars: draftChars }, controls }),
      sleep: async () => {}, readinessTimeoutMs: 50, connectGraceMs: 100,
      Recorder: class { constructor() { forbidden('recorder')(); } },
      focusComposer: forbidden('focus'), typeText: forbidden('type'), sendMessage: forbidden('send'),
    },
  });
  return {
    adapter, setPagePath(value) { pagePath = value; },
    connect: () => adapter.connect({ targetId: 'pending', origin, ownedByStudio: true }, {
      bind: (binding) => bound.push(structuredClone(binding)), ownSession: forbidden('ownSession'),
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

test('second target sample reverting to about:blank throws rather than returning blocked', async () => {
  const f = fixture({ urls: [root, 'about:blank'] });
  try { await assert.rejects(f.connect(), (error) => error.code === 'BINDING_CHANGED'); }
  finally { f.verify(); }
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
