// Issue #84 first-turn blocker: idle connect defers capture (sessionId null). Offline fixtures only:
// no browser, no provider, no actuator. Read-only Check again must re-inspect readiness without
// typing, sending or arming capture, and Chat must admit a ready first turn while capture is deferred.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createConversationService } from '../../src/capture/conversation-service.mjs';
import { canSend } from '../../src/studio/ui/chat.mjs';

const FRESH = { identity: { state: 'unbound', reason: 'NEW_CHAT' }, threadDenylist: [] };
function deferredFixture(t, { connectReadiness, preflight } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deferred-readiness-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const calls = [];
  const adapter = {
    async connect(binding) {
      return { binding, deferredCapture: true, sessionId: null,
        readiness: connectReadiness ?? { ready: false, draft: { present: null, chars: null }, reason: 'BINDING_CHANGED' } };
    },
    async preflight(binding, options) {
      calls.push(['preflight', options]);
      return preflight ? preflight(binding) : { binding, ready: true, draft: { present: false, chars: 0 }, boundary: { sequence: 0, transcriptCount: 0 }, creation: { threadless: true } };
    },
    async type() { calls.push(['type']); },
    async submit() { calls.push(['submit']); return null; },
    async armCapture() { calls.push(['armCapture']); return 'never'; },
    async reconcile() { calls.push(['reconcile']); return null; },
  };
  const service = createConversationService({ dataDir, id: 'deferred', adapter });
  const connect = () => service.connect({ targetId: 'fixture-tab', origin: 'https://chatgpt.com', ownedByStudio: true, ...FRESH, expectedRevision: service.read().revision });
  return { service, calls, connect };
}

test('Check again re-inspects a blocked idle connection before any capture exists (read-only)', async (t) => {
  const f = deferredFixture(t);
  const connected = await f.connect();
  assert.equal(connected.sessionId, null); assert.equal(connected.capture.state, 'idle'); assert.equal(connected.state, 'blocked');
  const checked = await f.service.reconcile({ expectedRevision: connected.revision });
  assert.equal(f.calls.filter(([n]) => n === 'preflight').length, 1, 'Check again consulted the adapter exactly once');
  assert.deepEqual(f.calls[0][1], { readOnly: true });
  for (const forbidden of ['type', 'submit', 'armCapture', 'reconcile']) assert.equal(f.calls.some(([n]) => n === forbidden), false, forbidden + ' is never called by a read-only check');
  assert.equal(checked.state, 'ready'); assert.equal(checked.readiness.ready, true);
  assert.equal(checked.sessionId, null, 'no capture was armed'); assert.equal(checked.capture.state, 'idle'); assert.equal(checked.attempts.length, 0);
});

test('Check again on a deferred idle connection stays blocked with the adapter coded reason', async (t) => {
  const f = deferredFixture(t, { preflight: (binding) => ({ binding, ready: false, reason: 'AUTH_WALL', draft: { present: null, chars: null }, boundary: { sequence: 0, transcriptCount: 0 } }) });
  const connected = await f.connect();
  const checked = await f.service.reconcile({ expectedRevision: connected.revision });
  assert.equal(checked.state, 'blocked'); assert.equal(checked.readiness.ready, false); assert.equal(checked.readiness.reason, 'AUTH_WALL');
});

test('Check again on a deferred idle connection fails closed on a changed binding or an adapter error', async (t) => {
  const changed = deferredFixture(t, { preflight: (binding) => ({ binding: { ...binding, targetId: 'other-tab' }, ready: true, draft: { present: false, chars: 0 }, boundary: { sequence: 0, transcriptCount: 0 } }) });
  const a = await changed.connect();
  const checkedChanged = await changed.service.reconcile({ expectedRevision: a.revision });
  assert.equal(checkedChanged.state, 'blocked'); assert.equal(checkedChanged.readiness.reason, 'BINDING_CHANGED');
  const failing = deferredFixture(t, { preflight: () => { throw Object.assign(new Error('x'), { code: 'COMPOSER_UNAVAILABLE' }); } });
  const b = await failing.connect();
  const checkedFailing = await failing.service.reconcile({ expectedRevision: b.revision });
  assert.equal(checkedFailing.state, 'blocked'); assert.equal(checkedFailing.readiness.reason, 'COMPOSER_UNAVAILABLE');
});

test('a failed attachment is never cleared by a read-only readiness check', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deferred-readiness-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let preflights = 0;
  const adapter = { async connect() { throw Object.assign(new Error('boom'), { code: 'TAB_OPEN_FAILED' }); }, async preflight(b) { preflights++; return { binding: b, ready: true, draft: { present: false, chars: 0 }, boundary: { sequence: 0, transcriptCount: 0 } }; } };
  const service = createConversationService({ dataDir, id: 'failed', adapter });
  await assert.rejects(service.connect({ targetId: 'fixture-tab', origin: 'https://chatgpt.com', ownedByStudio: true, ...FRESH, expectedRevision: 0 }), (e) => e.code === 'ATTACHMENT_FAILED');
  const after = await service.reconcile({ expectedRevision: service.read().revision });
  assert.equal(preflights, 0); assert.equal(after.state, 'needs-reconciliation'); assert.equal(after.diagnostic?.uncertainty ?? after.uncertainty, 'attachment-failed');
});

const FIRST_TURN = { state: 'ready', identity: { state: 'unbound', reason: 'NEW_CHAT' }, readiness: { ready: true, draft: { present: false, chars: 0 } }, capture: { state: 'idle' }, turn: null };
test('Chat admits a ready first turn while full capture is deferred to submit', () => {
  const result = canSend(FIRST_TURN, { prompt: 'harmless fixture' });
  assert.equal(result.ok, true, result.reason);
});

test('Chat still blocks a deferred first turn when binding changed, unready, uncertain or unknown-effect', () => {
  const send = (extra) => canSend({ ...FIRST_TURN, ...extra }, { prompt: 'harmless fixture' });
  assert.equal(send({ state: 'blocked', readiness: { ready: false, draft: { present: null, chars: null }, reason: 'BINDING_CHANGED' } }).ok, false, 'binding changed');
  assert.equal(send({ readiness: { ready: false, draft: { present: null, chars: null }, reason: 'NOT_CHECKED' } }).ok, false, 'unready');
  assert.equal(send({ readiness: undefined }).ok, false, 'readiness unreported');
  assert.equal(send({ state: 'needs-reconciliation' }).ok, false, 'uncertain');
  assert.equal(send({ turn: { id: 't', phase: 'uncertain', send: { state: 'uncertain' } } }).ok, false, 'unknown effect');
  assert.equal(send({ identity: { state: 'unverified', reason: 'UNSUPPORTED_PATH' } }).ok, false, 'identity unverified');
  for (const state of ['incomplete', 'finalizing', 'rejected', 'accepted', undefined]) assert.equal(send({ capture: { state } }).ok, false, 'capture ' + state);
  assert.equal(send({ capture: undefined }).ok, false, 'capture unreported');
});
