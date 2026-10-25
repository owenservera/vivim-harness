// Round 7 product-level integration: the harness API records a durable pre-effect intent
// binding BEFORE the store dispatches a submit step, completes it from the OWNING journal
// after dispatch, and the read-only reconcile query classifies unresolved steps through the
// pure Agent 14 classifier. Proves: pre-effect ordering, journal-sourced completion, honest
// still_unknown on incomplete bindings, zero mutation, zero prompt persistence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHarnessRunStore } from '../../src/capture/harness-runs.mjs';
import { createThreadTurnJournal } from '../../src/capture/thread-turn-journal.mjs';
import { createHarnessApi } from '../../src/studio/harness-api.mjs';
import { createIntentBindingStore } from '../../src/studio/intent-bindings.mjs';

const THREAD = { kind: 'chatgpt-c', id: '1b2c3d4e-5f60-4a1b-8c2d-3e4f5a6b7c8d', ref: 'chatgpt-c:1b2c3d4e-5f60-4a1b-8c2d-3e4f5a6b7c8d' };
import { createHash } from 'node:crypto';
const sha = (s) => createHash('sha256').update(s).digest('hex');

function rig({ executor }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'aion-reconcile-'));
  const bindings = createIntentBindingStore({ dir: path.join(dir, 'intent-bindings') });
  const journal = createThreadTurnJournal({
    dataDir: path.join(dir, 'journal'), namespace: 'local-owner',
    origin: 'https://chatgpt.com', thread: THREAD,
  });
  const runtime = { journalSnapshot: () => journal.read() };
  const runs = createHarnessRunStore({ dir: path.join(dir, 'harness-runs'), toolExecutor: executor({ journal, bindings }) });
  const api = createHarnessApi({ runs, intentBindings: bindings, conversationRuntime: runtime });
  return { dir, bindings, journal, runs, api };
}

test('submit step: binding recorded pre-effect, completed from the journal, verdict executed on positive page delivery', async () => {
  let executorSawBinding = null;
  const { dir, journal, api, runs } = rig({
    executor: ({ journal: j }) => async ({ tool, args }) => {
      if (tool !== 'submit_conversation_turn') throw new Error('unexpected tool');
      // PRE-EFFECT PROOF: the binding file must already exist when the executor is invoked.
      executorSawBinding = bindingsExistFor(dir) ? 'recorded-before-dispatch' : 'MISSING';
      const payloadDigest = sha(`payload:${args.key}`);
      const reserved = j.reserve({ key: args.key, payloadDigest, conversationId: args.conversation });
      const typed = j.markTyping({ turnId: reserved.turn.id, expectedRevision: reserved.turn.revision, boundary: { sessionId: 'capture-1', sequence: 3, transcriptCount: 1 } });
      const dispatching = j.markDispatching({ turnId: reserved.turn.id, expectedRevision: typed.revision });
      j.observeDelivery({ turnId: reserved.turn.id, expectedRevision: dispatching.revision, evidence: { turnId: reserved.turn.id, payloadDigest, sessionId: 'capture-1', sequence: 4, kind: 'new-user-turn', source: 'page', identity: 'native-user-message' } });
      // The effect itself is "lost" (timeout with unknown delivery): the store must fence it.
      throw new Error('dispatch outcome unknown (simulated crash after effect)');
    },
  });
  const { run } = api.create({ task: 'two-turn contract probe', conversationId: 'convo42' });
  const out = await api.step(run.id, {
    key: 'send-key', tool: 'submit_conversation_turn',
    arguments: { conversation: 'convo42', key: 'send-key', prompt: 'SECRET PROMPT BODY', confirm: true, expectedRevision: 0 },
  }).catch((e) => ({ failed: String(e?.message ?? e) }));

  assert.equal(executorSawBinding, 'recorded-before-dispatch');
  const runView = api.get(run.id).run;
  const step = runView.steps.find((s) => s.key === 'send-key');
  assert.equal(step.status, 'uncertain'); // unknown effect is fenced, not failed

  // The binding was completed from the JOURNAL (key + payloadDigest), not from a summarized result.
  const binding = api.reconcileStep(run.id, 'send-key').reconciliation;
  assert.equal(binding.verdict, 'executed');
  assert.equal(binding.reason, 'JOURNAL_CONFIRMS_DELIVERY');
  assert.equal(binding.retryAuthorized, false);
  assert.equal(binding.mutates, false);
  assert.equal(binding.evidence[0].identity, 'native-user-message');

  // Reconciliation is read-only: the journal and the run are unchanged by the query.
  const before = journal.read();
  api.reconcileStep(run.id, 'send-key').reconciliation;
  assert.deepEqual(journal.read(), before);
  assert.equal(api.get(run.id).run.steps.find((s) => s.key === 'send-key').status, 'uncertain');

  // No prompt body anywhere in the durable binding store or the run ledger.
  for (const f of readdirSync(path.join(dir, 'intent-bindings'))) {
    assert.doesNotMatch(readFileSync(path.join(dir, 'intent-bindings', f), 'utf8'), /SECRET/);
  }
  assert.doesNotMatch(JSON.stringify(runView), /SECRET/);
});

test('incomplete binding (dispatch never reached the journal) classifies honestly as still_unknown', async () => {
  const { dir, api } = rig({
    executor: () => async () => {
      // Crash BEFORE the journal reserve: no journal turn exists under the request key.
      throw new Error('crashed before reserve');
    },
  });
  const { run } = api.create({ task: 'pre-reserve crash', conversationId: 'convo42' });
  await api.step(run.id, {
    key: 'lost-step', tool: 'submit_conversation_turn',
    arguments: { conversation: 'convo42', key: 'lost-key', prompt: 'x', confirm: true, expectedRevision: 0 },
  }).catch(() => {});
  const verdict = api.reconcileStep(run.id, 'lost-step').reconciliation;
  assert.equal(verdict.verdict, 'still_unknown');
  assert.equal(verdict.reason, 'DURABLE_INTENT_BINDING_MISSING_OR_MISMATCHED'); // journal fields absent
  assert.equal(verdict.retryAuthorized, false);
});

test('no observable thread identity pre-effect => no binding recorded, reconcile stays unknown', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'aion-reconcile-nobind-'));
  try {
    const bindings = createIntentBindingStore({ dir: path.join(dir, 'intent-bindings') });
    const runs = createHarnessRunStore({ dir: path.join(dir, 'harness-runs'), toolExecutor: async () => { throw new Error('dispatch outcome unknown'); } });
    const brokenRuntime = { journalSnapshot: () => { throw new Error('journal unavailable'); } };
    const api = createHarnessApi({ runs, intentBindings: bindings, conversationRuntime: brokenRuntime });
    const { run } = api.create({ task: 'no thread identity', conversationId: 'convo42' });
    await api.step(run.id, {
      key: 's1', tool: 'submit_conversation_turn',
      arguments: { conversation: 'convo42', key: 'k1', prompt: 'x', confirm: true, expectedRevision: 0 },
    }).catch(() => {}); // uncertain step: the reconcile path is exactly for these
    const verdict = api.reconcileStep(run.id, 's1').reconciliation;
    assert.equal(verdict.verdict, 'still_unknown');
    assert.equal(verdict.reason, 'DURABLE_INTENT_BINDING_MISSING_OR_MISMATCHED');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('not_executed only from a trusted pre-effect audit, and still never a resend permit', async () => {
  const { dir, journal, api } = rig({
    executor: ({ journal: j }) => async ({ args }) => {
      const payloadDigest = sha(`payload:${args.key}`);
      const reserved = j.reserve({ key: args.key, payloadDigest, conversationId: args.conversation });
      // The actuator audit proves typing AND dispatch never executed; the turn blocks.
      j.provePreEffect({ turnId: reserved.turn.id, expectedRevision: reserved.turn.revision, evidence: { turnId: reserved.turn.id, payloadDigest, kind: 'pre-effect-blocked', source: 'actuator-audit', typing: 'not-executed', dispatch: 'not-executed', reference: 'audit-ref-1' } });
      throw new Error('blocked pre-effect');
    },
  });
  const { run } = api.create({ task: 'blocked probe', conversationId: 'convo42' });
  await api.step(run.id, {
    key: 'blocked-key', tool: 'submit_conversation_turn',
    arguments: { conversation: 'convo42', key: 'blocked-key', prompt: 'x', confirm: true, expectedRevision: 0 },
  }).catch(() => {});
  const verdict = api.reconcileStep(run.id, 'blocked-key').reconciliation;
  assert.equal(verdict.verdict, 'not_executed');
  assert.equal(verdict.reason, 'TRUSTED_PRE_EFFECT_AUDIT');
  assert.equal(verdict.retryAuthorized, false); // not a new send permit — the journal owner reconciles
  assert.equal(verdict.operatorAction.includes('not authorization to retry'), true);
  rmSync(dir, { recursive: true, force: true });
});

function bindingsExistFor(dir) {
  const bdir = path.join(dir, 'intent-bindings');
  try { return readdirSync(bdir).some((f) => f.endsWith('.json') && !f.includes('.tmp')); } catch { return false; }
}
