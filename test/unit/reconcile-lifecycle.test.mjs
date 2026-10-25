// Four-lane C1 integration: the harness reconcile query now returns BOTH the Round 7
// verdict and the independent six-stage reconcileLifecycle projection built from the same
// verified snapshots. Provenance the harness cannot prove yet (pre-send baseline, recorder
// capture reference, accepted evidence, goal) is passed as null, so those stages must come
// out honestly unknown — never inferred.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createHarnessApi } from '../../src/studio/harness-api.mjs';
import { createIntentBindingStore } from '../../src/studio/intent-bindings.mjs';
import { createThreadTurnJournal } from '../../src/capture/thread-turn-journal.mjs';
import { createHarnessRunStore } from '../../src/capture/harness-runs.mjs';

const THREAD = { kind: 'chatgpt-c', id: '1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e', ref: 'chatgpt-c:1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e' };

function rig({ executor }) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'aion-lifecycle-'));
  const bindings = createIntentBindingStore({ dir: path.join(dir, 'intent-bindings') });
  const journal = createThreadTurnJournal({ dataDir: path.join(dir, 'journal'), namespace: 'local-owner', origin: 'https://chatgpt.com', thread: THREAD });
  const runtime = { journalSnapshot: () => journal.read() };
  const runs = createHarnessRunStore({ dir: path.join(dir, 'harness-runs'), toolExecutor: executor({ journal, bindings }) });
  const api = createHarnessApi({ runs, intentBindings: bindings, conversationRuntime: runtime });
  return { dir, journal, runs, api };
}

const sha = (x) => createHash('sha256').update(x).digest('hex');
const executedExecutor = ({ journal: j }) => async ({ tool, args }) => {
  assert.equal(tool, 'submit_conversation_turn');
  const payloadDigest = sha(`payload:${args.key}`);
  const reserved = j.reserve({ key: args.key, payloadDigest, conversationId: args.conversation });
  const typed = j.markTyping({ turnId: reserved.turn.id, expectedRevision: reserved.turn.revision, boundary: { sessionId: 'capture-1', sequence: 3, transcriptCount: 1 } });
  const dispatching = j.markDispatching({ turnId: reserved.turn.id, expectedRevision: typed.revision });
  j.observeDelivery({ turnId: reserved.turn.id, expectedRevision: dispatching.revision, evidence: { turnId: reserved.turn.id, payloadDigest, sessionId: 'capture-1', sequence: 4, kind: 'new-user-turn', source: 'page', identity: 'native-user-message' } });
  throw new Error('dispatch outcome unknown (simulated crash after delivery)');
};

test('executed step: lifecycle projects the effect verdict and keeps unprovable stages honestly unknown', async () => {
  const { dir, api, journal } = rig({ executor: executedExecutor });
  try {
    const run = api.create({ task: { description: 'lifecycle projection check' }, conversationId: 'convo-lc' }).run;
    await api.step(run.id, { key: 'send-key', tool: 'submit_conversation_turn', arguments: { conversation: 'convo-lc', key: 'send-key', prompt: 'hello SECRET', confirm: true, expectedRevision: 0 } }).catch(() => {});
    const before = JSON.stringify(journal.read());
    const out = api.reconcileStep(run.id, 'send-key');
    // Round 7 verdict unchanged
    assert.equal(out.reconciliation.verdict, 'executed');
    assert.equal(out.reconciliation.retryAuthorized, false);
    // C1 six-stage projection from the same verified snapshots
    const lc = out.lifecycle;
    assert.equal(lc.schema, 'aion.webapp-harness-core/1');
    assert.equal(lc.effect.verdict, 'executed');
    assert.equal(lc.readOnly, true);
    assert.equal(lc.dispatched, false);
    assert.equal(lc.effect.retryAuthorized, false);
    // without a verified attachment/baseline/acceptance the evidence stages must NOT be claimed
    assert.equal(lc.delivery.state, 'unknown');
    assert.equal(lc.replyAttribution.state, 'unknown');
    assert.equal(lc.captureFinalized.state, 'unknown');
    assert.equal(lc.acceptedEvidence.state, 'unknown');
    assert.equal(lc.userGoal.state, 'unknown');
    // the projection read the journal through the owner only and mutated nothing
    assert.equal(JSON.stringify(journal.read()), before);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('missing durable join: lifecycle abstains with the same reason as the classifier', async () => {
  const { dir, api } = rig({ executor: () => async () => { throw Object.assign(new Error('pre-reserve crash'), { effectState: 'not_dispatched' }); } });
  try {
    const run = api.create({ task: { description: 'missing join' }, conversationId: 'convo-mj' }).run;
    await assert.rejects(() => api.step(run.id, { key: 'k1', tool: 'submit_conversation_turn', arguments: { conversation: 'convo-mj', key: 'k1', prompt: 'x', confirm: true, expectedRevision: 0 } }), /not_dispatched|failed|STEP_/);
    const out = api.reconcileStep(run.id, 'k1');
    assert.equal(out.reconciliation.verdict, 'still_unknown');
    assert.equal(out.lifecycle.effect.verdict, 'still_unknown');
    assert.equal(out.lifecycle.effect.reason, 'DURABLE_JOIN_MISSING_OR_MISMATCHED');
    assert.equal(out.lifecycle.dispatched, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('lifecycle never re-dispatches a not_executed step and never grants retry', async () => {
  const { dir, api } = rig({ executor: ({ journal: j }) => async ({ tool, args }) => {
    const payloadDigest = sha(`payload:${args.key}`);
    const reserved = j.reserve({ key: args.key, payloadDigest, conversationId: args.conversation });
    j.provePreEffect({ turnId: reserved.turn.id, expectedRevision: reserved.turn.revision, evidence: { turnId: reserved.turn.id, payloadDigest, kind: 'pre-effect-blocked', source: 'actuator-audit', typing: 'not-executed', dispatch: 'not-executed', reference: 'audit-ref-1' } });
    throw new Error('dispatch blocked pre-effect');
  } });
  try {
    const run = api.create({ task: { description: 'blocked send' }, conversationId: 'convo-blk' }).run;
    await api.step(run.id, { key: 'blk-key', tool: 'submit_conversation_turn', arguments: { conversation: 'convo-blk', key: 'blk-key', prompt: 'x', confirm: true, expectedRevision: 0 } }).catch(() => {});
    const out = api.reconcileStep(run.id, 'blk-key');
    assert.equal(out.reconciliation.verdict, 'not_executed');
    assert.equal(out.lifecycle.effect.verdict, 'not_executed');
    assert.equal(out.lifecycle.effect.retryAuthorized, false);
    assert.equal(out.lifecycle.dispatched, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
