// aion.capability-capsule/1 — page-local capability discovery from the runtime's own evidence.
// Bench E08: sign-in wall / unverified identity / unsupported control must read unavailable or
// unverified WITH the observed reason; the capsule can never fake success or bypass a gate.
// Synthetic views and profiles only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CAPSULE_SCHEMA, buildCapabilityCapsule, AVAILABILITY } from '../../src/capture/conversation-capsule.mjs';

const chatgptProfile = {
  id: 'chatgpt',
  composer: { selectors: ['form textarea', '#prompt-textarea'], kind: 'auto' },
  send: { strategy: 'both', buttonSelectors: ['button[data-testid="send-button"]'] },
  assistant: { containerSelectors: ['[data-message-author-role="assistant"]'] },
};
const bareProfile = { id: 'mystery', composer: { selectors: [] } };

const view = (over = {}) => ({
  id: 'conv-1', site: 'chatgpt', state: 'ready', revision: 3,
  identity: { state: 'bound', reason: null },
  binding: { ownedByStudio: false, origin: 'https://chatgpt.com' },
  readiness: { ready: true, draft: { present: false, chars: 0 }, reason: null },
  writer: { active: false, releaseError: null },
  diagnostic: {}, limitations: [],
  ...over,
});

test('capsule schema and availability vocabulary; a bound ready conversation can read and (advisory) send', () => {
  const c = buildCapabilityCapsule({ view: view(), profile: chatgptProfile });
  assert.equal(c.schema, CAPSULE_SCHEMA);
  assert.equal(c.site, 'chatgpt');
  for (const o of Object.values(c.operations)) assert.ok(AVAILABILITY.includes(o.availability), o.operation);
  assert.equal(c.operations.read_conversation.availability, 'supported');
  assert.equal(c.operations.submit_conversation_turn.availability, 'supported');
  assert.ok(c.operations.submit_conversation_turn.evidence.some((e) => e.includes('effect-time gates still apply')),
    'the capsule must say it does not bypass effect-time fencing');
  assert.equal(c.operations.finish_conversation.availability, 'supported');
  assert.equal(c.operations.close_tab.availability, 'unavailable');
  assert.equal(c.operations.close_tab.reason, 'TAB_NOT_STUDIO_OWNED');
});

test('E08: unverified thread identity refuses send AND read with the observed reason — never a guessed yes', () => {
  const c = buildCapabilityCapsule({ view: view({ identity: { state: 'unverified', reason: 'UNSUPPORTED_PATH' } }), profile: chatgptProfile });
  assert.equal(c.operations.submit_conversation_turn.availability, 'unavailable');
  assert.equal(c.operations.submit_conversation_turn.reason, 'THREAD_IDENTITY_UNVERIFIED');
  assert.equal(c.operations.read_conversation.availability, 'unavailable');
  assert.equal(c.operations.read_conversation.reason, 'THREAD_IDENTITY_UNVERIFIED');
});

test('E08: a site with no measured composer/send selectors reports unavailable, not supported', () => {
  const c = buildCapabilityCapsule({ view: view({ site: 'mystery' }), profile: bareProfile });
  assert.equal(c.operations.submit_conversation_turn.availability, 'unavailable');
  assert.equal(c.operations.submit_conversation_turn.reason, 'COMPOSER_UNAVAILABLE');
  const noSend = buildCapabilityCapsule({ view: view({ site: 'mystery' }), profile: { id: 'mystery', composer: { selectors: ['textarea'] } } });
  assert.equal(noSend.operations.submit_conversation_turn.availability, 'unavailable');
  assert.equal(noSend.operations.submit_conversation_turn.reason, 'SEND_CONTROL_UNAVAILABLE');
});

test('writer window busy and unfinished readiness gate the send honestly; stop_generation is never faked', () => {
  const busy = buildCapabilityCapsule({ view: view({ writer: { active: true, releaseError: null } }), profile: chatgptProfile });
  assert.equal(busy.operations.submit_conversation_turn.availability, 'unavailable');
  assert.equal(busy.operations.submit_conversation_turn.reason, 'WRITER_WINDOW_BUSY');
  const unchecked = buildCapabilityCapsule({ view: view({ readiness: { ready: false, reason: 'NOT_CHECKED' } }), profile: chatgptProfile });
  assert.equal(unchecked.operations.submit_conversation_turn.availability, 'unverified');
  assert.equal(unchecked.operations.submit_conversation_turn.reason, 'NOT_CHECKED');
  const c = buildCapabilityCapsule({ view: view(), profile: chatgptProfile });
  assert.equal(c.operations.stop_generation.availability, 'unavailable');
  assert.equal(c.operations.stop_generation.reason, 'NOT_IMPLEMENTED_IN_RUNTIME',
    'finish_conversation is capture finalization; claiming a provider stop would be a fabricated capability');
});

test('finished and recovered conversations refuse sends; model change stays unverified when only selectors exist', () => {
  const done = buildCapabilityCapsule({ view: view({ state: 'closed', diagnostic: { finishPhase: 'done' } }), profile: chatgptProfile });
  assert.equal(done.operations.submit_conversation_turn.availability, 'unavailable');
  assert.equal(done.operations.submit_conversation_turn.reason, 'CONVERSATION_FINISHED');
  const recovered = buildCapabilityCapsule({
    view: view({ limitations: ['Recovered snapshot only; interrupted capture ownership requires reconciliation, never automatic replay'] }),
    profile: chatgptProfile });
  assert.equal(recovered.operations.read_conversation.availability, 'unverified');
  assert.equal(recovered.operations.read_conversation.reason, 'READ_REQUIRES_LIVE_CONVERSATION');
  const model = buildCapabilityCapsule({ view: view(), profile: { id: 'chatgpt', composer: chatgptProfile.composer, send: chatgptProfile.send, preflight: { modelSelectors: ['buttonModel'] } } });
  assert.equal(model.operations.change_model.availability, 'unverified');
  assert.equal(model.operations.change_model.reason, 'CONTROL_OBSERVED_BUT_SELECTION_READBACK_UNVERIFIED');
});

test('no profile at all: read honestly unverified (no selector evidence), send refuses on missing composer evidence', () => {
  const c = buildCapabilityCapsule({ view: view(), profile: null });
  assert.equal(c.operations.read_conversation.availability, 'unverified');
  assert.equal(c.operations.read_conversation.reason, 'READ_UNAVAILABLE');
  assert.equal(c.operations.submit_conversation_turn.availability, 'unavailable');
  assert.equal(c.operations.submit_conversation_turn.reason, 'COMPOSER_UNAVAILABLE');
  assert.throws(() => buildCapabilityCapsule({ view: null }), TypeError);
});
