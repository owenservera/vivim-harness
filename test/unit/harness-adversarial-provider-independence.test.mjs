// Adversarial: provider independence and thread-identity scoping.
// Read-only unit diagnostics for the multi-turn lane. No browser, no network, no credentials.
//
// Findings encoded here (exact source lines):
//  F1 src/capture/conversation-thread.mjs parseThread() allowlists chatgpt.com and chat.openai.com.
//     Lookalike hosts, ports and foreign origins do not mint a thread. `sameThread` still compares
//     refs only, so two allowlisted hosts can share a ref; durable journal keys remain origin-scoped.
//  F2 src/capture/thread-identity.mjs:15-28 chatgptConversationClaim() mints a `verified` claim on
//     ANY https host whose path is /c/<uuid> (no hostname allowlist). Downstream scoping relies on
//     claim.origin === page.origin only.
//  F3 src/studio/core-runtime-bridge.mjs:19-26 slot() checks claim.kind, verified, origin and
//     local source metadata, but NOT adapter.providerId/siteId. A structurally valid conversation
//     claim therefore binds on a non-ChatGPT site (e.g. claude.ai with a /c/<uuid> path).
//  F4 src/capture/thread-turn-journal.mjs:62-70 canonicalThreadKey() hard-codes kind 'chatgpt-c'
//     and a UUID, so the durable multi-turn journal cannot represent any other provider's thread.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseThread, sameThread, threadSupported, validThread, THREAD_SITES } from '../../src/capture/conversation-thread.mjs';
import { chatgptConversationClaim, resolveConversationIdentity } from '../../src/capture/thread-identity.mjs';
import { canonicalThreadKey, createThreadTurnJournal } from '../../src/capture/thread-turn-journal.mjs';
import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';

const UUID = '11111111-1111-4111-8111-111111111111';
const REF = `chatgpt-c:${UUID}`;
const page = (overrides = {}) => ({
  targetId: 'target-1', captureRef: 'capture-1', sequence: 7, observedAt: '2026-10-25T00:00:00.000Z',
  url: `https://chatgpt.com/c/${UUID}`, origin: 'https://chatgpt.com', siteId: 'chatgpt', surface: 'chat', ...overrides,
});
const adapter = (overrides = {}) => ({ providerId: 'openai', siteId: 'chatgpt', surface: 'chat', origin: 'https://chatgpt.com', kind: 'seed', version: 'seed', ...overrides });
const claimAt = (origin) => chatgptConversationClaim({ url: `${origin}/c/${UUID}`, captureRef: 'capture-1', sequence: 7 });

test('F1: thread parse is host-allowlisted; sameThread still is not an origin check', () => {
  const real = parseThread('chatgpt', `https://chatgpt.com/c/${UUID}`);
  const legacy = parseThread('chatgpt', `https://chat.openai.com/c/${UUID}`);
  assert.equal(real?.ref, REF);
  assert.deepEqual(legacy, real);
  assert.equal(sameThread(real, legacy), true, 'allowlisted hosts can share a ref');
  // URL.hostname drops the port, so a non-default port still parses. Durable keys stay origin-scoped.
  assert.equal(parseThread('chatgpt', `https://chatgpt.com:8443/c/${UUID}`)?.ref, REF);
  for (const url of [`https://evil.example/c/${UUID}`, `https://chatgpt.com.evil.test/c/${UUID}`, `https://sub.chatgpt.com/c/${UUID}`]) {
    assert.equal(parseThread('chatgpt', url), null, url);
  }
  assert.notEqual(
    canonicalThreadKey({ namespace: 'ns', origin: 'https://chatgpt.com', thread: real }),
    canonicalThreadKey({ namespace: 'ns', origin: 'https://chat.openai.com', thread: real }));
  assert.notEqual(
    canonicalThreadKey({ namespace: 'ns', origin: 'https://chatgpt.com', thread: real }),
    canonicalThreadKey({ namespace: 'ns', origin: 'https://chatgpt.com:8443', thread: real }));
});

test('F1: query/fragment/case variants collapse to one ref; malformed routes stay unverified', () => {
  const base = parseThread('chatgpt', `https://chatgpt.com/c/${UUID}`);
  for (const url of [`https://chatgpt.com/c/${UUID}?model=gpt-5`, `https://chatgpt.com/c/${UUID}#frag`,
    `https://chatgpt.com/C/${UUID.toUpperCase()}/`, `https://chatgpt.com/c/${UUID.toLowerCase()}`]) {
    assert.deepEqual(parseThread('chatgpt', url), base, url);
  }
  for (const url of [`https://chatgpt.com/c/${UUID}/x`, `https://chatgpt.com/c/${UUID}x`, `https://chatgpt.com/share/${UUID}`,
    `https://chatgpt.com/c/not-a-uuid`, `https://chatgpt.com/c/`, `http://chatgpt.com/c/${UUID}`, 'about:blank', 'not a url', '']) {
    assert.equal(parseThread('chatgpt', url), null, url);
  }
  assert.equal(validThread({ kind: 'chatgpt-c', id: 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE', ref: 'chatgpt-c:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }), false,
    'validThread only accepts the lower-case canonical id form');
  assert.equal(validThread({ kind: 'chatgpt-c', id: UUID, ref: REF }), true);
  assert.equal(validThread(null), true, 'no thread is a valid unbound state');
});

test('F2: only ChatGPT is a supported multi-turn thread; every other provider stays unverified', () => {
  assert.deepEqual([...THREAD_SITES], ['chatgpt']);
  const others = {
    claude: `https://claude.ai/chat/${UUID}`, gemini: `https://gemini.google.com/app/${UUID}`,
    deepseek: `https://chat.deepseek.com/a/chat/s/${UUID}`, qwen: `https://chat.qwen.ai/c/${UUID}`,
    kimi: `https://www.kimi.com/chat/${UUID}`, zai: `https://chat.z.ai/c/${UUID}`,
  };
  for (const [siteId, url] of Object.entries(others)) {
    assert.equal(threadSupported(siteId), false, siteId);
    assert.equal(parseThread(siteId, url), null, `${siteId} must not mint a thread`);
  }
  // With siteId 'chatgpt' the path alone decides: claude's /chat/<uuid> does not bind...
  assert.equal(parseThread('chatgpt', others.claude), null);
  assert.equal(parseThread('chatgpt', others.gemini), null);
  assert.equal(parseThread('chatgpt', others.deepseek), null);
  // qwen/zai share the /c/<uuid> path, but the host allowlist still refuses them even when
  // the caller passes siteId 'chatgpt'.
  assert.equal(parseThread('chatgpt', others.qwen), null);
  assert.equal(parseThread('chatgpt', others.zai), null);
  assert.equal(parseThread('qwen', others.qwen), null, 'the selected site gate still refuses it');
});

test('F2: claim minting is hostname-agnostic but evidence-scoped', () => {
  const foreign = claimAt('https://evil.example');
  assert.equal(foreign.verified, true);
  assert.equal(foreign.origin, 'https://evil.example');
  assert.equal(foreign.nativeRef, UUID);
  for (const bad of [null, '', 'https://chatgpt.com/c/not-a-uuid', 'http://chatgpt.com/c/' + UUID, 'about:blank']) {
    assert.equal(chatgptConversationClaim({ url: bad, captureRef: 'capture-1', sequence: 1 }), null, String(bad));
  }
  assert.equal(chatgptConversationClaim({ url: `https://chatgpt.com/c/${UUID}`, captureRef: 'capture-1', sequence: 1, evidenceClass: 'self-asserted' }), null);
});

test('F3: identity binds only for the exact page origin/site/surface', () => {
  const bound = resolveConversationIdentity({ ...adapter(), page: page(), claims: { conversation: claimAt('https://chatgpt.com') } });
  assert.equal(bound.identity.conversation.state, 'bound');
  assert.equal(bound.identity.conversation.nativeRef, UUID);
  // No claims at all: every slot fails closed with a stable reason (provider-independent default).
  const none = resolveConversationIdentity({ ...adapter(), page: page() });
  for (const kind of ['conversation', 'task', 'branch', 'generation']) {
    assert.equal(none.identity[kind].state, 'unverified');
    assert.equal(none.identity[kind].reason, 'NO_DURABLE_IDENTITY');
  }
  // A claim minted at another origin must never bind to this page.
  const crossOrigin = resolveConversationIdentity({ ...adapter(), page: page(), claims: { conversation: claimAt('https://evil.example') } });
  assert.equal(crossOrigin.identity.conversation.state, 'unverified');
  assert.equal(crossOrigin.identity.conversation.reason, 'IDENTITY_NOT_PROVEN');
  // Site/surface mismatch is a hard scope error, not a silent downgrade.
  assert.throws(() => resolveConversationIdentity({ ...adapter(), page: page({ siteId: 'claude' }) }), /TARGET_SCOPE_MISMATCH/);
  assert.throws(() => resolveConversationIdentity({ ...adapter(), page: page({ surface: 'canvas' }) }), /TARGET_SCOPE_MISMATCH/);
  assert.throws(() => resolveConversationIdentity({ ...adapter(), page: page({ origin: 'https://evil.example', url: `https://evil.example/c/${UUID}` }) }), /TARGET_SCOPE_MISMATCH/);
});

test('F3: a structurally valid conversation claim binds on a non-ChatGPT site (no provider scoping)', () => {
  // Diagnostic of current behaviour, not an endorsement: slot() never compares the claim against
  // adapter.providerId/siteId, so trust rests entirely on the selected adapter's minting discipline.
  const claudePage = page({ siteId: 'claude', origin: 'https://claude.ai', url: `https://claude.ai/chat/${UUID}` });
  const claudeAdapter = adapter({ providerId: 'anthropic', siteId: 'claude', origin: 'https://claude.ai' });
  const claim = {
    kind: 'conversation', verified: true, nativeRef: UUID, origin: 'https://claude.ai',
    source: { kind: 'native-route', captureRef: 'capture-1', sequence: 7, reference: `/chat/${UUID}`, evidenceClass: 'live-browser-observation' },
  };
  const resolved = resolveConversationIdentity({ ...claudeAdapter, page: claudePage, claims: { conversation: claim } });
  assert.equal(resolved.identity.conversation.state, 'bound');
  assert.equal(resolved.adapter.siteId, 'claude');
  // Title/text/ordinal/url-query sources can never become identity keys, on any provider.
  for (const kind of ['title', 'text', 'position', 'ordinal', 'url-query']) {
    const rejected = resolveConversationIdentity({
      ...claudeAdapter, page: claudePage,
      claims: { conversation: { ...claim, source: { ...claim.source, kind } } },
    });
    assert.equal(rejected.identity.conversation.state, 'unverified', kind);
  }
});

test('F4: the durable multi-turn journal cannot represent a non-ChatGPT thread', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-provider-'));
  try {
    for (const thread of [
      { kind: 'claude-chat', id: UUID, ref: `claude-chat:${UUID}` },
      { kind: 'chatgpt-c', id: 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE', ref: 'chatgpt-c:AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE' },
      { kind: 'chatgpt-c', id: UUID, ref: `chatgpt-c:${UUID}x` },
      null,
    ]) {
      assert.throws(() => canonicalThreadKey({ namespace: 'ns', origin: 'https://claude.ai', thread }), /INVALID_THREAD_SCOPE/);
      assert.throws(() => createThreadTurnJournal({ dataDir: dir, namespace: 'ns', origin: 'https://claude.ai', thread }), /INVALID_THREAD_SCOPE/);
    }
    // Non-canonical origins are refused for every provider, including chatgpt.com with a path/trailing slash.
    for (const origin of ['https://chatgpt.com/', 'http://chatgpt.com', 'https://chatgpt.com:443', 'https://user:pass@chatgpt.com', 'chatgpt.com']) {
      assert.throws(() => canonicalThreadKey({ namespace: 'ns', origin, thread: { kind: 'chatgpt-c', id: UUID, ref: REF } }), /INVALID_THREAD_SCOPE/, origin);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
