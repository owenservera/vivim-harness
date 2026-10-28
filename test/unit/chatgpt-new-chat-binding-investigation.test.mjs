// Offline investigation of the actual fresh-tab adapter seam. No browser, network, or recorder.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createConversationBrowserAdapter } from '../../src/capture/conversation-browser-adapter.mjs';

const origin = 'https://chatgpt.com';
const root = `${origin}/`;
const thread = `/c/11111111-1111-4111-8111-111111111111`;
const idle = { observed: true, state: 'idle', idleControlPresent: true, stopPresent: false, composerEnabled: true };

function fixture({ urls = [root], pageOrigin = origin, pathname = '/', draftChars = 0 } = {}) {
  const calls = [], bound = [];
  let targetReads = 0;
  const forbidden = (name) => () => { calls.push(name); throw new Error(`Forbidden ${name}`); };
  const adapter = createConversationBrowserAdapter({
    paths: { sessions: 'unused' }, profileStore: { load() {} }, port: 19222,
    siteAdapter: { id: 'chatgpt', url: root }, freshTab: true, conversationId: 'offline', ownerToken: 'fake',
    dependencies: {
      fetch: async (url, init) => { calls.push(['fetch', url, init.method]); return { ok: true, json: async () => ({ id: 'fresh' }) }; },
      attachIdlePage: async (id) => ({ send: async (method, params) => { calls.push(['page', id, method, params]); return {}; } }),
      listTargets: async () => [{ id: 'fresh', url: urls[Math.min(targetReads++, urls.length - 1)] }],
      evaluate: async (_, expression) => { assert.ok(['location.origin', 'location.pathname'].includes(expression)); return expression === 'location.origin' ? pageOrigin : pathname; },
      findComposer: async () => ({ found: true }), detectAuthWall: async () => ({ blocked: false }),
      detectSiteFailure: async () => ({ failed: false }), sendState: async () => ({ evalOk: true, draftChars }),
      readTurnPage: async () => ({ pathname, draft: { chars: draftChars }, controls: idle }),
      sleep: async () => {}, readinessTimeoutMs: 1000, connectGraceMs: 100,
      Recorder: class { constructor() { forbidden('recorder')(); } },
      focusComposer: forbidden('focus'), typeText: forbidden('type'), sendMessage: forbidden('send'),
    },
  });
  return {
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
