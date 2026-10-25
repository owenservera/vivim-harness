// Four-lane C1 seam: provider-specific conversation identity resolution.
// ChatGPT keeps its strict /c/<uuid> native-route contract; every unknown provider stays
// fail-closed (identity slots unverified) and scope violations throw the bridge's coded errors.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chatgptConversationClaim, resolveConversationIdentity } from '../../src/capture/thread-identity.mjs';

const UUID = '1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e';
const PAGE = {
  targetId: 'tab-9', captureRef: 'capture-1', sequence: 5,
  observedAt: '2026-10-24T12:00:00.000Z', url: 'https://chatgpt.com/c/' + UUID,
  origin: 'https://chatgpt.com', siteId: 'chatgpt', surface: 'chat',
};

test('ChatGPT native route mints a verified conversation claim only for exact /c/<uuid>', () => {
  const claim = chatgptConversationClaim({ url: PAGE.url, captureRef: 'capture-1', sequence: 5 });
  assert.equal(claim.kind, 'conversation');
  assert.equal(claim.verified, true);
  assert.equal(claim.nativeRef, UUID);
  assert.equal(claim.source.kind, 'native-route');
  assert.equal(claim.source.reference, '/c/' + UUID);
  // query strings do not change the conversation identity: pathname decides
  const withQuery = chatgptConversationClaim({ url: 'https://chatgpt.com/c/' + UUID + '?model=x', captureRef: 'capture-1', sequence: 5 });
  assert.equal(withQuery.nativeRef, UUID);
  // home, share, search and admin routes never mint a conversation identity
  for (const bad of ['https://chatgpt.com/', 'https://chatgpt.com/g/g-123', 'https://chatgpt.com/c/',
    'https://chatgpt.com/c/not-a-uuid', 'https://chatgpt.com/c/' + UUID + '/share',
    'http://chatgpt.com/c/' + UUID]) {
    assert.equal(chatgptConversationClaim({ url: bad, captureRef: 'capture-1', sequence: 5 }), null, bad);
  }
  assert.equal(chatgptConversationClaim({ url: PAGE.url, captureRef: 'capture-1', sequence: 5, evidenceClass: 'title' }), null);
});

test('resolveConversationIdentity binds the verified conversation and keeps everything else unverified', () => {
  const claim = chatgptConversationClaim({ url: PAGE.url, captureRef: 'capture-1', sequence: 5 });
  const a = resolveConversationIdentity({
    providerId: 'openai-chatgpt', siteId: 'chatgpt', origin: 'https://chatgpt.com',
    surface: 'chat', adapterKind: 'seed', adapterVersion: 'seed-1',
    page: PAGE, claims: { conversation: claim },
  });
  assert.equal(a.schema, 'aion.webapp-harness-core/1');
  assert.equal(a.identity.conversation.state, 'bound');
  assert.equal(a.identity.conversation.nativeRef, UUID);
  assert.equal(a.identity.task.state, 'unverified');
  assert.equal(a.identity.branch.state, 'unverified');
  assert.equal(a.identity.generation.state, 'unverified');
  assert.equal(a.account.state, 'unverified');
  assert.equal(a.attachment.verified, true);
  // unknown provider with no claims: every slot fails closed
  const u = resolveConversationIdentity({
    providerId: 'unknown-provider', siteId: 'unknown-lab', origin: 'https://lab.test',
    page: { ...PAGE, url: 'https://lab.test/chat', origin: 'https://lab.test', siteId: 'unknown-lab' },
    claims: {},
  });
  assert.equal(u.identity.conversation.state, 'unverified');
  assert.equal(u.identity.conversation.reason, 'NO_DURABLE_IDENTITY');
});

test('scope violations are refused, never coerced', () => {
  const claim = chatgptConversationClaim({ url: PAGE.url, captureRef: 'capture-1', sequence: 5 });
  // page origin differs from adapter origin
  assert.throws(() => resolveConversationIdentity({
    providerId: 'openai-chatgpt', siteId: 'chatgpt', origin: 'https://chatgpt.com',
    page: { ...PAGE, url: 'https://evil.test/c/' + UUID, origin: 'https://evil.test' },
    claims: { conversation: claim },
  }), (e) => e.code === 'TARGET_SCOPE_MISMATCH');
  // a claim minted against a different origin cannot be bound on this page: it is refused
  // as unproven (no exception, but the slot stays unverified)
  const foreign = resolveConversationIdentity({
    providerId: 'openai-chatgpt', siteId: 'chatgpt', origin: 'https://chatgpt.com',
    page: PAGE,
    claims: { conversation: { ...claim, origin: 'https://other.test' } },
  });
  assert.equal(foreign.identity.conversation.state, 'unverified');
  assert.equal(foreign.identity.conversation.reason, 'IDENTITY_NOT_PROVEN');
  // non-https adapter origin is rejected outright
  assert.throws(() => resolveConversationIdentity({
    providerId: 'x', siteId: 'x', origin: 'http://insecure.test', page: { ...PAGE, origin: 'http://insecure.test', url: 'http://insecure.test/c/' + UUID },
    claims: {},
  }), (e) => e.code === 'INVALID_CANONICAL_ORIGIN');
  // learned-read-only adapters are a legal kind; unknown kinds are not
  assert.doesNotThrow(() => resolveConversationIdentity({
    providerId: 'openai-chatgpt', siteId: 'chatgpt', origin: 'https://chatgpt.com',
    adapterKind: 'learned-read-only', adapterVersion: 'v3', page: PAGE, claims: { conversation: claim },
  }));
  assert.throws(() => resolveConversationIdentity({
    providerId: 'openai-chatgpt', siteId: 'chatgpt', origin: 'https://chatgpt.com',
    adapterKind: 'full-effect', page: PAGE, claims: {},
  }), (e) => e.code === 'INVALID_ADAPTER_CONTRACT');
});
