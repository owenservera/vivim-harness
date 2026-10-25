// The learned-readonly send fence: a data-only adapter from the adapter factory can never
// reach a dispatch, even if wiring ever handed it to the send path (defense in depth).
import test from 'node:test';
import assert from 'node:assert/strict';
import { sendMessage } from '../../src/capture/actions.mjs';

function untouchablePage() {
  return { async send() { throw new Error('learned adapter reached the browser: send must refuse before any CDP traffic'); } };
}

test('learned-readonly strategy refuses before preflight and before any CDP traffic', async () => {
  const result = await sendMessage(untouchablePage(), {
    id: 'fixture-chat', learned: true, readOnly: true,
    send: { strategy: 'learned-readonly' },
    composer: { selectors: ['textarea'] }, // even a matching composer changes nothing
  }, {
    // spies that would fail the test if the dispatch path were ever reached
    pressEnter: async () => { throw new Error('pressEnter must never be called for a learned adapter'); },
    clickSendButton: async () => { throw new Error('clickSendButton must never be called for a learned adapter'); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.sent, false);
  assert.equal(result.dispatched, false);
  assert.equal(result.sendStatus, 'not-attempted');
  assert.equal(result.method, 'preflight');
  assert.match(result.reason, /learned data-only adapter does not grant send permission/);
});

test('a learned adapter object without the strategy is still fenced by its missing composer', async () => {
  // Belt: strategy fence. Suspenders: a data-only adapter has no composer, so preflight
  // itself reports the composer unreadable and nothing is dispatched.
  const calls = [];
  const page = { async send(method, params) { calls.push(params?.expression ?? method); return { result: { value: { evalOk: false, reason: 'no composer found' } } }; } };
  const result = await sendMessage(page, { id: 'fixture-chat', learned: true, readOnly: true });
  assert.equal(result.ok, false);
  assert.equal(result.sent, false);
  assert.equal(result.sendStatus, 'not-attempted');
});
