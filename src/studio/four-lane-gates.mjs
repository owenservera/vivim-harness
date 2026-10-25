// Four-lane server-only advisory glue, integrated from the CONSOLIDATED bundle
// (integration-gates.mjs, only import seams relocated to product paths).
// Never a browser/lease/effect authority.
import { qualifyHoldout, assessDrift } from './systems-probes.mjs';
import { createStudioAdapterLearner } from './adapter-studio-bridge.mjs';
export const SCHEMA = 'aion.four-lane-gates/1';
const deny = reason => ({ ok: false, decision: 'abstain', reason, sendPermission: false });
const scopeOf = s => ({ siteId: s?.siteId, origin: s?.origin, account: s?.accountRef, surface: s?.surface });
function match(events, manifest, scope) {
  if (!Array.isArray(events) || !events.length || !Array.isArray(manifest) || !manifest.length) return deny('MISSING_SOURCE');
  const byId = new Map(manifest.map(x => [x.id, x])), seen = new Set();
  if (byId.size !== manifest.length) return deny('DUPLICATE_SOURCE_ID');
  for (const e of events) { const s = e?.source, m = byId.get(s?.sessionId);
    if (!m || m.sourceDigest !== s.rawDigest || s.origin !== scope.origin || s.accountRef !== scope.accountRef ||
      s.coverage !== 'complete' || m.scope?.origin !== scope.origin || m.scope?.account !== scope.accountRef)
      return deny('EVENT_MANIFEST_MISMATCH');
    seen.add(s.sessionId);
  }
  return seen.size === byId.size ? { ok: true } : deny('UNACCOUNTED_SOURCE_SESSION');
}
export function qualifyIndependentEvidence({ scope, training, heldout, trainManifest, heldoutManifest } = {}) {
  const r = qualifyHoldout({ train: trainManifest, heldout: heldoutManifest, expectedScope: scopeOf(scope) });
  if (!r.ok) return deny(r.reason);
  const a = match(training, trainManifest, scope), b = match(heldout, heldoutManifest, scope);
  return !a.ok ? a : !b.ok ? b : { ok: true, decision: 'qualified-shadow-only', trainSessions: r.trainSessions,
    heldoutSessions: r.heldoutSessions, sendPermission: false };
}
// All three callbacks must be internal existing Studio code: source acceptance, immutable lineage, atomic profile CAS.
// A user-supplied JSON object is NEVER a trusted source manifest.
export function createGuardedStudioLearner({ verifyCapture, store, getTrustedManifests } = {}) {
  if (typeof getTrustedManifests !== 'function') throw new TypeError('TRUSTED_CORE_MANIFEST_PROVIDER_REQUIRED');
  const learner = createStudioAdapterLearner({ verifyCapture, store });
  async function propose(args = {}) {
    const m = await getTrustedManifests({ scope: args.scope, training: args.training, heldout: args.heldout });
    const q = qualifyIndependentEvidence({ scope: args.scope, training: args.training, heldout: args.heldout,
      trainManifest: m?.training, heldoutManifest: m?.heldout });
    if (!q.ok) throw Object.assign(new Error(q.reason), { code: q.reason });
    if (args.trigger === 'drift') {
      const d = assessDrift({ scope: scopeOf(args.scope), incumbent: args.incumbent,
        proposal: args.newSelector, observations: args.driftEvidence });
      if (!d.ok) throw Object.assign(new Error(d.reason), { code: d.reason });
    }
    return learner.propose(args); // retains I1/Round8/9 independent checks
  }
  return { ...learner, propose };
}
// Server-derived conservative projection for the ONE existing /chat shell.
export function projectForUniversalChat({ attachment, lifecycle, studioBinding, capability, proposal } = {}) {
  const identity = attachment?.identity?.conversation;
  const exact = studioBinding?.source === 'trusted-studio-conversation-owner' &&
    typeof studioBinding.id === 'string' && studioBinding.id.length > 0 &&
    identity?.state === 'bound' && studioBinding.nativeConversationRef === identity.nativeRef;
  const seen = x => x?.state === 'observed';
  const snapshot = { id: exact ? studioBinding.id : null, site: { id: attachment?.adapter?.providerId ?? 'unknown' },
    identity: { state: exact ? 'bound' : 'unverified', threadKey: exact ? identity.nativeRef : null },
    binding: { targetId: attachment?.attachment?.targetId ?? null, threadKey: exact ? identity.nativeRef : null },
    account: { state: attachment?.account?.state === 'authenticated' && attachment.account.ref ? 'signed-in' : 'unknown' },
    effectState: lifecycle?.effect?.verdict === 'still_unknown' ? 'needs-reconciliation' : 'unknown' };
  const outcome = { send: seen(lifecycle?.delivery) ? 'delivered' : 'unknown',
    reply: seen(lifecycle?.replyAttribution) ? 'fresh-attributed' : 'unknown',
    networkEnded: seen(lifecycle?.networkTerminal), pageStable: false,
    freshReply: seen(lifecycle?.replyAttribution), captureFinalized: seen(lifecycle?.captureFinalized),
    captureAccepted: seen(lifecycle?.acceptedEvidence), goalFulfilled: seen(lifecycle?.userGoal) };
  const capabilities = capability ? [{ name: capability.feature, seedConfigured: false,
    pageObserved: ['page-observed', 'verified-action'].includes(capability.tier) ? capability.availability : 'unverified',
    gateEligible: 'unverified', effectVerified: capability.tier === 'verified-action' ? 'supported' : 'unverified' }] : [];
  const adapters = proposal ? [{ site: proposal.scope?.siteId, surface: proposal.scope?.surface, source: 'unknown',
    stage: ['ready-for-read-only-promotion', 'test-only-preview'].includes(proposal.status) ? 'shadow' : 'rejected',
    candidate: true, coverage: proposal.learned?.coverage ?? null, shadowResult: proposal.status,
    trainingComplete: false, drift: proposal.drift?.length ? proposal.drift.map(x => x.reason).join(',') : 'unknown' }] : [];
  return { snapshot, outcome, capabilities, adapters, readOnly: true, sendPermission: false };
}
