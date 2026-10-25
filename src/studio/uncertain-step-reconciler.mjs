// AION Agent 14 / Round 7. Pure, read-only classification; NEVER dispatches or mutates.
// Contract source: Capture Studio src/capture/thread-turn-journal.mjs schema v2,
// Z.ai Round 6 src/capture/harness-runs.mjs schema capture-studio.harness-run/1.
// A caller MUST supply an independently persisted, trustworthy exact intentBinding.
// Neither run/step timestamps nor prompt text nor matching conversation IDs are a join key.
export const RECONCILER_SCHEMA = 'aion.harness-step-reconciliation/1';
const hex64 = (s) => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s);
const nonempty = (s) => typeof s === 'string' && s.length > 0;
const action = {
  executed: 'Inspect journal evidence and current page; do not resend the effect. Qualify downstream response separately.',
  not_executed: 'Reconcile the owning journal and effect owner first; this read-only verdict is not authorization to retry.',
  still_unknown: 'Keep the existing run and journal effect fences. Collect authoritative evidence; never auto-resend.'
};
const outcome = (verdict, reason, evidence = []) => Object.freeze({
  schema: RECONCILER_SCHEMA, verdict, reason,
  evidence: evidence.map(x => ({ ...x })), operatorAction: action[verdict],
  mutates: false, retryAuthorized: false
});

// Inputs are parsed snapshots; journal's checksum/shape verification belongs to its owner.
// Binding MUST have been durably recorded before effect dispatch, not reconstructed afterward.
// Bindings marked `trusted-pre-effect` are a claimed trust boundary; the caller must verify
// their provenance from local durable effect-owner records before invoking this function.
export function reconcileUncertainStep({ run, stepKey, journal, intentBinding } = {}) {
  if (run?.schema !== 'capture-studio.harness-run/1' || !Array.isArray(run.steps))
    return outcome('still_unknown', 'RUN_INVALID_OR_UNAVAILABLE');
  const steps = run.steps.filter(x => x?.key === stepKey);
  if (steps.length !== 1) return outcome('still_unknown', steps.length ? 'MULTIPLE_STEP_ATTEMPTS' : 'STEP_NOT_FOUND');
  const step = steps[0];
  if (!['in_flight', 'uncertain'].includes(step.status))
    return outcome('still_unknown', 'STEP_NOT_UNRESOLVED');
  if (step.tool !== 'submit_conversation_turn')
    return outcome('still_unknown', 'TOOL_NOT_SUPPORTED');
  if (!hex64(step.argsDigest) || !nonempty(run.id) || !nonempty(run.conversationId))
    return outcome('still_unknown', 'STEP_IDENTITY_INCOMPLETE');

  const b = intentBinding;
  if (b?.source !== 'trusted-pre-effect' || b?.runId !== run.id || b?.stepKey !== step.key ||
      b?.stepTool !== step.tool || b?.argsDigest !== step.argsDigest ||
      b?.conversationId !== run.conversationId || !nonempty(b?.threadKey) ||
      !nonempty(b?.journalTurnKey) || !hex64(b?.journalPayloadDigest))
    return outcome('still_unknown', 'DURABLE_INTENT_BINDING_MISSING_OR_MISMATCHED');

  if (journal?.version !== 2 || journal?.threadKey !== b.threadKey || !Array.isArray(journal.turns))
    return outcome('still_unknown', 'JOURNAL_MISSING_OR_WRONG_THREAD');
  const matches = journal.turns.filter(t => t?.key === b.journalTurnKey);
  if (matches.length !== 1) return outcome('still_unknown', 'JOURNAL_TURN_NOT_UNIQUE_OR_MISSING');
  const t = matches[0];
  if (t.payloadDigest !== b.journalPayloadDigest || t.conversationId !== b.conversationId || !nonempty(t.id))
    return outcome('still_unknown', 'JOURNAL_INTENT_MISMATCH');

  const d = t.delivery, e = d?.evidence, boundary = t.boundary;
  const positiveDelivery = d?.state === 'observed' && e && boundary &&
    e.turnId === t.id && e.payloadDigest === t.payloadDigest && e.sessionId === boundary.sessionId &&
    Number.isSafeInteger(e.sequence) && Number.isSafeInteger(boundary.sequence) && e.sequence > boundary.sequence &&
    nonempty(e.identity) && ((e.source === 'network' && e.kind === 'outgoing-request') ||
    (e.source === 'page' && e.kind === 'new-user-turn'));
  const proof = t.preEffect;
  const positiveNoEffect = t.phase === 'blocked' && proof?.kind === 'pre-effect-blocked' &&
    proof?.source === 'actuator-audit' && proof?.turnId === t.id && proof?.payloadDigest === t.payloadDigest &&
    proof?.typing === 'not-executed' && proof?.dispatch === 'not-executed' && nonempty(proof?.reference);
  if (positiveDelivery && positiveNoEffect) return outcome('still_unknown', 'CONTRADICTORY_JOURNAL_PROOFS');
  if (positiveDelivery) return outcome('executed', 'JOURNAL_CONFIRMS_DELIVERY', [
    { source: e.source, kind: e.kind, sessionId: e.sessionId, sequence: e.sequence, identity: e.identity,
      journalTurnId: t.id, journalKey: t.key }
  ]);
  if (positiveNoEffect && d?.state !== 'observed') return outcome('not_executed', 'TRUSTED_PRE_EFFECT_AUDIT', [
    { source: proof.source, kind: proof.kind, reference: proof.reference, journalTurnId: t.id, journalKey: t.key }
  ]);
  return outcome('still_unknown', 'NO_POSITIVE_DISPATCH_OR_PRE_EFFECT_PROOF');
}