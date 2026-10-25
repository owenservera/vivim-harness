/**
 * AION Systems S1: pure, read-only contract probes for an integration candidate.
 * No CDP, filesystem writes, network, sending, acceptance mutation, or browser effects.
 * Node >=22. Synthetic diagnostics, NOT installed runtime safeguards.
 */
export const SCHEMA = 'aion.systems-s1/1';
const key = (v) => JSON.stringify(v);
const uniq = (items) => new Set(items);
const nonempty = (v) => typeof v === 'string' && v.length > 0;
const obj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
export const scopeKey = (s) => key([s?.siteId ?? null, s?.origin ?? null, s?.account ?? null, s?.surface ?? null]);
const deny = (reason, detail = {}) => ({ ok: false, decision: 'abstain', reason, ...detail });

/** Both sides must be SERVER-SOURCED immutable session manifests. IDs alone are inadequate
 * because reexports and remounts can have new IDs sharing the same evidence lineage.
 * There is no implicit cross-account or partial-capture fallback.
 */
export function qualifyHoldout({ train, heldout, expectedScope } = {}) {
  if (!Array.isArray(train) || !Array.isArray(heldout) || train.length === 0 || heldout.length === 0)
    return deny('MISSING_INDEPENDENT_SETS');
  const seenIds = new Set(), seenLineage = new Set();
  for (const [name, set] of [['train', train], ['heldout', heldout]]) {
    for (const s of set) {
      if (!obj(s) || !nonempty(s.id) || !nonempty(s.lineage) || !obj(s.scope) ||
          !nonempty(s.scope.origin) || !nonempty(s.scope.siteId) || !nonempty(s.scope.account) || !nonempty(s.scope.surface) ||
          !nonempty(s.sourceDigest) || s.coverage !== 'complete' || s.coreAccepted !== true || s.sourceQualified !== true)
        return deny('UNQUALIFIED_SESSION', { set: name });
      if (expectedScope && scopeKey(s.scope) !== scopeKey(expectedScope))
        return deny('SCOPE_MISMATCH', { set: name });
      if (seenIds.has(s.id)) return deny('SESSION_ID_REUSED', { set: name });
      if (seenLineage.has(s.lineage)) return deny('EVIDENCE_LINEAGE_REUSED', { set: name });
      seenIds.add(s.id); seenLineage.add(s.lineage);
    }
  }
  return { ok: true, decision: 'qualify-shadow-only', trainSessions: train.length,
    heldoutSessions: heldout.length, independentLineages: seenLineage.size, sendPermission: false };
}

/** A drift candidate earns read-only-review eligibility only when positive observations
 * span independent qualified sessions and consecutive windows, with old-selector negatives
 * qualified separately. This never promotes profiles or grants effects.
 */
export function assessDrift({ scope, incumbent, proposal, observations, minSessions = 3, minWindows = 2 } = {}) {
  if (!obj(scope) || !nonempty(incumbent) || !nonempty(proposal) || incumbent === proposal || !Array.isArray(observations))
    return deny('INVALID_DRIFT_INPUT');
  if (minSessions < 2 || minWindows < 2) return deny('INSUFFICIENT_INDEPENDENCE_POLICY');
  const sessions = new Map(), windows = new Map();
  for (const o of observations) {
    if (!obj(o) || !obj(o.scope) || scopeKey(o.scope) !== scopeKey(scope)) return deny('SCOPE_MISMATCH');
    if (!nonempty(o.session) || !nonempty(o.lineage) || !Number.isSafeInteger(o.window) || o.window < 0 ||
        !['present','absent','unknown'].includes(o.outcome) || ![incumbent,proposal].includes(o.candidate))
      return deny('INVALID_OBSERVATION');
    if (o.sourceQualified !== true || o.coreAccepted !== true || o.coverage !== 'complete')
      return deny('UNQUALIFIED_DRIFT_EVIDENCE');
    const id = key([o.lineage, o.candidate]);
    const prev = sessions.get(id);
    if (prev && (prev.outcome !== o.outcome || prev.window !== o.window || prev.session !== o.session))
      return deny('CONFLICTING_SESSION_EVIDENCE');
    sessions.set(id, o);
  }
  const positives = [...sessions.values()].filter(o => o.candidate === proposal && o.outcome === 'present');
  const negativeOld = [...sessions.values()].filter(o => o.candidate === incumbent && o.outcome === 'absent');
  for (const o of positives) windows.set(o.window, (windows.get(o.window) || 0) + 1);
  const ordered = [...windows.keys()].sort((a,b)=>a-b);
  let consecutive = 0, best = 0, prev = -2;
  for (const w of ordered) { consecutive = w === prev + 1 ? consecutive + 1 : 1; best = Math.max(best, consecutive); prev = w; }
  if (uniq(positives.map(x=>x.lineage)).size < minSessions || best < minWindows ||
      uniq(negativeOld.map(x=>x.lineage)).size < 2)
    return { ...deny('MORE_INDEPENDENT_EVIDENCE_REQUIRED'), proposalVotes: positives.length,
      incumbentNegativeVotes: negativeOld.length, consecutiveWindows: best };
  return { ok: true, decision: 'shadow-revalidate-read-only', proposalVotes: positives.length,
    incumbentNegativeVotes: negativeOld.length, consecutiveWindows: best,
    rollbackPointerRequired: true, sendPermission: false };
}

/** An intent trace is a diagnostic cross-layer consistency check, not journal ownership.
 * Never infer not-dispatched from absence of a delivery, or successful reply from a send.
 */
export function auditEffectTrace({ binding, events = [] } = {}) {
  if (!obj(binding) || !['runId','stepKey','tool','argsDigest','conversationId','threadKey','journalTurnKey','journalPayloadDigest']
    .every(f => nonempty(binding[f])) || binding.source !== 'trusted-pre-effect') return deny('MISSING_PRE_EFFECT_BINDING');
  if (!Array.isArray(events)) return deny('INVALID_EVENT_LOG');
  let dispatched = 0, delivered = 0, blocked = 0, completed = 0;
  let lastSeq = -1;
  for (const e of events) {
    if (!obj(e) || !Number.isSafeInteger(e.seq) || e.seq <= lastSeq ||
      !['intent','dispatch','delivery','pre-effect-blocked','complete'].includes(e.type)) return deny('INVALID_EVENT_ORDER');
    lastSeq = e.seq;
    if (['runId','stepKey','tool','argsDigest','conversationId','threadKey','journalTurnKey','journalPayloadDigest']
      .some(f=>e[f] !== binding[f])) return deny('INTENT_OR_IDENTITY_CONFLICT');
    if (e.type === 'dispatch') dispatched++;
    if (e.type === 'delivery') delivered++;
    if (e.type === 'pre-effect-blocked') blocked++;
    if (e.type === 'complete') completed++;
  }
  if (dispatched > 1 || delivered > 1 || blocked > 1 || completed > 1 ||
      (blocked && (dispatched || delivered)) || (delivered && !dispatched) ||
      (completed && !delivered)) return deny('INCONSISTENT_EFFECT_TRACE');
  if (delivered) return { ok: true, decision: 'delivery-observed-not-outcome-accepted',
    retryAuthorized: false, sendPermission: false };
  if (blocked) return { ok: true, decision: 'pre-effect-blocked-needs-owner-reconciliation',
    retryAuthorized: false, sendPermission: false };
  return { ok: false, decision: 'reconcile-read-only', reason: 'EFFECT_UNCERTAIN',
    dispatched, retryAuthorized: false, sendPermission: false };
}

/** A bounded UI projection of updates; never a replacement for the durable raw log.
 * Overflow reports a declared UI projection gap; no silent loss or synthetic coverage.
 */
export function createBoundedProjection({ maxStreams = 64, maxChars = 8192 } = {}) {
  if (!Number.isSafeInteger(maxStreams) || maxStreams < 1 || !Number.isSafeInteger(maxChars) || maxChars < 1)
    throw new TypeError('INVALID_PROJECTION_LIMIT');
  const state = new Map();
  const metrics = { accepted: 0, stale: 0, overflow: 0, uiGaps: 0, maxTracked: 0 };
  return {
    offer(e) {
      if (!obj(e) || !nonempty(e.scopeKey) || !nonempty(e.streamId) ||
          !Number.isSafeInteger(e.revision) || e.revision < 0 || typeof e.text !== 'string')
        return { ok: false, reason: 'INVALID_EVENT' };
      const id = key([e.scopeKey, e.streamId]);
      const old = state.get(id);
      if (old && e.revision <= old.revision) { metrics.stale++; return { ok: false, reason: 'STALE_REVISION' }; }
      if (!old && state.size >= maxStreams) { metrics.overflow++; metrics.uiGaps++; return { ok: false, reason: 'UI_PROJECTION_OVERFLOW', rawCaptureUnchanged: true }; }
      const clipped = e.text.length > maxChars;
      if (clipped) metrics.uiGaps++;
      state.set(id, { revision: e.revision, text: clipped ? e.text.slice(-maxChars) : e.text,
        truncated: clipped, originalChars: e.text.length });
      metrics.accepted++;
      metrics.maxTracked = Math.max(metrics.maxTracked, state.size);
      return { ok: true, truncated: clipped, rawCaptureUnchanged: true };
    },
    snapshot() { return { schema: SCHEMA, streams: [...state.entries()].map(([id, v]) => ({ id, ...v })),
      metrics: { ...metrics }, cap: { maxStreams, maxChars }, effectAuthority: false }; },
    clear() { state.clear(); },
  };
}

/** A proof-carrying knowledge eligibility check. Caller must independently verify hashes.
 * Do not promote derived, inferred or UI-complete material into accepted learning.
 */
export function qualifyProvenance({ acceptance, validatedByCore = false, source, expectedScope, refs } = {}) {
  if (!obj(acceptance) || acceptance.schema !== 'capture-studio.acceptance/1' ||
      acceptance.verdict !== 'capture_accepted' || validatedByCore !== true ||
      !['G1','G2','G3','G4','G5','G6','G7'].every(g => acceptance.gates?.[g]?.value === 'passed'))
    return deny('ACCEPTANCE_NOT_INDEPENDENTLY_VERIFIED');
  if (!obj(source) || !obj(source.scope) || !nonempty(source.rawDigest) ||
      !nonempty(source.sessionId) || source.coverage !== 'complete' || source.gaps !== 0)
    return deny('INCOMPLETE_OR_UNKNOWN_SOURCE');
  if (!obj(expectedScope) || scopeKey(expectedScope) !== scopeKey(source.scope))
    return deny('EVIDENCE_SCOPE_MISMATCH');
  if (acceptance.binding?.rawDigest !== source.rawDigest || !nonempty(acceptance.binding?.domDigest) ||
      !Array.isArray(acceptance.binding?.seqRange) || acceptance.binding.seqRange.length !== 2)
    return deny('SOURCE_DIGEST_MISMATCH');
  if (!Array.isArray(refs) || !refs.length) return deny('MISSING_SOURCE_LOCATORS');
  for (const r of refs) {
    if (!obj(r) || r.sessionId !== source.sessionId || r.rawDigest !== source.rawDigest ||
        r.origin !== source.scope.origin || r.account !== source.scope.account ||
        !Number.isSafeInteger(r.seq) || r.seq < acceptance.binding.seqRange[0] ||
        r.seq > acceptance.binding.seqRange[1]) return deny('INVALID_SOURCE_LOCATOR');
  }
  return { ok: true, decision: 'eligible-for-scoped-review-only', refs: refs.length,
    autoLearn: false, effectAuthority: false };
}

/** Exhaustively enumerates two three-phase contenders (read, reserve, dispatch).
 * Contrasts an unsafe read-then-write model with atomic admission. Pure state-model,
 * NOT a filesystem test; this catches dangerous scheduling assumptions early.
 */
export function exploreAdmissionSchedules({ conflictingIntent = false } = {}) {
  const orders=[];
  function enumerate(a,b,out) {
    if(a===3 && b===3){orders.push(out);return;}
    if(a<3)enumerate(a+1,b,[...out,`A${a}`]);
    if(b<3)enumerate(a,b+1,[...out,`B${b}`]);
  }
  enumerate(0,0,[]);
  const simulate=(schedule, atomic)=>{
    let owner=null, dispatch=0, conflicts=0;
    const sawEmpty={A:false,B:false},admitted={A:false,B:false};
    for(const instruction of schedule) {
      const who=instruction[0], step=Number(instruction[1]);
      if(step===0)sawEmpty[who]=owner===null;
      else if(step===1) {
        if(atomic){
          if(owner===null){owner=who;admitted[who]=true;}
          else if(conflictingIntent) conflicts++;
        } else if(sawEmpty[who]) {owner=who;admitted[who]=true;}
      } else if(admitted[who]) dispatch++;
    }
    return { dispatch, conflicts };
  };
  const count=(atomic)=>{
    const a=orders.map(x=>simulate(x,atomic));
    return { schedules:a.length, multipleDispatchSchedules:a.filter(x=>x.dispatch>1).length,
      maxDispatch:Math.max(...a.map(x=>x.dispatch)), conflictSchedules:a.filter(x=>x.conflicts).length };
  };
  return { schema:SCHEMA, evidence:'synthetic-schedule-exploration', competingWriters:2,
    totalSchedules:orders.length, unsafeReadThenWrite:count(false), atomicAdmission:count(true),
    effectAuthority:false };
}
