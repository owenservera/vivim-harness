// AION C1 provider-independent, data-only harness bridge (Node >=22).
// Pure decisions only. No browser actor, capture writer, journal writer or send authorization.
export const BRIDGE_SCHEMA = 'aion.webapp-harness-core/1';
const str = (x, n=256) => typeof x === 'string' && x.length > 0 && x.length <= n && !/[\x00-\x1f\x7f]/.test(x);
const seq = n => Number.isSafeInteger(n) && n >= 0;
const hex = x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
const fail = code => Object.assign(new Error(code), { code });
const same = (a,b) => a !== null && a !== undefined && a === b;
function origin(value) {
  try { const u = new URL(value); if (u.protocol === 'https:' && u.origin === value && !u.username && !u.password) return value; } catch {}
  throw fail('INVALID_CANONICAL_ORIGIN');
}
function localSource(s, captureRef, minSequence=0) {
  return !!s && ['native-route','native-message-id','provider-account-index','observed-task-id'].includes(s.kind)
    && str(s.captureRef,200) && s.captureRef === captureRef && seq(s.sequence) && s.sequence >= minSequence
    && str(s.reference,256) && ['saved-real-capture','live-browser-observation','synthetic-fixture'].includes(s.evidenceClass);
}
const unknown = (reason) => ({state:'unverified', nativeRef:null, source:null, reason});
function slot(claim, kind, page, at) {
  if (claim == null) return unknown('NO_DURABLE_IDENTITY');
  if (claim.kind !== kind || claim.verified !== true || !str(claim.nativeRef,256)
    || claim.origin !== page.origin || !localSource(claim.source, page.captureRef, at)) return unknown('IDENTITY_NOT_PROVEN');
  // Human-readable titles, text, ordinal positions and unqualified URL query fragments are not keys.
  if (['title','text','position','ordinal','url-query'].includes(claim.source?.kind)) return unknown('IDENTITY_NOT_PROVEN');
  return {state:'bound',kind,nativeRef:claim.nativeRef,source:structuredClone(claim.source),reason:null};
}

/** Only a trusted Capture Studio observation + provider-specific identity resolver may bind a native ID.
 * `resolved` comes from the existing selected adapter, never from caller-provided chat title/text.
 */
export function resolveAttachment({adapter,page,resolved={}}={}) {
  if (!adapter || !str(adapter.siteId,80) || !str(adapter.providerId,128) || !str(adapter.surface,80)
    || !['seed','learned-read-only'].includes(adapter.kind) || !str(adapter.version,80)) throw fail('INVALID_ADAPTER_CONTRACT');
  origin(adapter.origin);
  if (!page || !str(page.targetId,256) || !str(page.captureRef,200) || !seq(page.sequence)
    || !str(page.observedAt,64) || !Number.isFinite(Date.parse(page.observedAt))) throw fail('ATTACHMENT_EVIDENCE_MISSING');
  let pageOrigin;
  try { const u = new URL(page.url); pageOrigin = u.origin; if (u.protocol!=='https:') throw 0; }
  catch { throw fail('TARGET_URL_INVALID'); }
  if (pageOrigin !== adapter.origin || page.origin !== adapter.origin || page.siteId !== adapter.siteId
    || page.surface !== adapter.surface) throw fail('TARGET_SCOPE_MISMATCH');
  const identity = {};
  for (const kind of ['conversation','task','branch','generation']) identity[kind] = slot(resolved[kind],kind,page,page.sequence);
  const account = page.account?.state === 'authenticated' && localSource(page.account.source,page.captureRef,page.sequence)
    ? {state:'authenticated',ref:str(page.account.ref)?page.account.ref:null,source:structuredClone(page.account.source)}
    : {state:'unverified',ref:null,source:null};
  return Object.freeze({schema:BRIDGE_SCHEMA,adapter:{providerId:adapter.providerId,siteId:adapter.siteId,
    surface:adapter.surface,origin:adapter.origin,kind:adapter.kind,version:adapter.version},
    attachment:{targetId:page.targetId,url:page.url,origin:pageOrigin,captureRef:page.captureRef,sequence:page.sequence,
      observedAt:page.observedAt,verified:true},account,identity});
}

/** Truth levels are NOT capabilities inferred from selectors or product marketing. */
export function capabilityTruth({attachment,feature,staticHint=false,pageProbe=null,ownerEffectProof=null}={}) {
  if (attachment?.schema!==BRIDGE_SCHEMA || !str(feature,80)) throw fail('INVALID_CAPABILITY_REQUEST');
  const a=attachment.attachment;
  const observed = !!pageProbe && pageProbe.targetId===a.targetId && pageProbe.origin===a.origin
    && pageProbe.captureRef===a.captureRef && seq(pageProbe.sequence) && pageProbe.sequence>=a.sequence
    && str(pageProbe.reference) && pageProbe.source==='studio-page-observation'
    && ['available','unavailable'].includes(pageProbe.state);
  const verifiedAction = observed && pageProbe.state==='available' && ownerEffectProof?.source==='studio-effect-owner'
    && ownerEffectProof?.feature===feature && ownerEffectProof?.targetId===a.targetId
    && ownerEffectProof?.captureRef===a.captureRef && ownerEffectProof?.reference && ownerEffectProof?.state==='effect-observed'
    && seq(ownerEffectProof.sequence) && ownerEffectProof.sequence>=pageProbe.sequence;
  const tier=verifiedAction?'verified-action':observed?'page-observed':staticHint?'static-hint':'unknown';
  const availability=observed?(pageProbe.state==='available'?'supported':'unavailable'):'unverified';
  return Object.freeze({schema:BRIDGE_SCHEMA,feature,availability,tier,
    scope:{providerId:attachment.adapter.providerId,siteId:attachment.adapter.siteId,surface:attachment.adapter.surface,origin:a.origin,targetId:a.targetId,captureRef:a.captureRef,attachmentSequence:a.sequence},
    evidence:verifiedAction?[pageProbe.reference,ownerEffectProof.reference]:observed?[pageProbe.reference]:[],
    // These are read-only claims; no discovered adapter gains execution authority.
    executionAuthority:'existing-studio-effect-owner-only',sendAuthorized:false});
}

/** Pre-dispatch advisory: returning defer-to-studio is NOT a grant or an effect. */
export function effectBoundary({attachment,capability,tool,requestedEffect,preflight,lease,journal,owner}={}) {
  const deny = reason => Object.freeze({schema:BRIDGE_SCHEMA,decision:'deny',reason,dispatch:false,retryAuthorized:false});
  if (attachment?.schema!==BRIDGE_SCHEMA || capability?.schema!==BRIDGE_SCHEMA) return deny('UNVERIFIED_CONTRACT');
  if (requestedEffect!=='read' && requestedEffect!=='submit') return deny('UNKNOWN_EFFECT');
  const scope=capability.scope, target=attachment.attachment;
  if (!scope || scope.providerId!==attachment.adapter.providerId || scope.siteId!==attachment.adapter.siteId
    || scope.surface!==attachment.adapter.surface || scope.origin!==target.origin
    || scope.targetId!==target.targetId || scope.captureRef!==target.captureRef
    || scope.attachmentSequence!==target.sequence) return deny('CAPABILITY_SCOPE_MISMATCH');
  if (requestedEffect==='read') return Object.freeze({schema:BRIDGE_SCHEMA,decision:'read-only-consumer',reason:'NO_BROWSER_EFFECT',dispatch:false,retryAuthorized:false});
  if (tool!=='submit_conversation_turn') return deny('UNREGISTERED_EFFECT_TOOL');
  if (attachment.identity.conversation.state!=='bound' && attachment.identity.task.state!=='bound') return deny('NATIVE_IDENTITY_UNVERIFIED');
  if (attachment.adapter.kind==='learned-read-only') return deny('LEARNED_ADAPTER_NOT_EFFECT_AUTHORITY');
  if (capability.feature!=='send-control' || capability.availability!=='supported' || !['page-observed','verified-action'].includes(capability.tier))
    return deny('SEND_CAPABILITY_NOT_PAGE_OBSERVED');
  const a=attachment.attachment;
  if (owner?.id!=='capture-studio' || owner.effectExecutor!=='existing-conversation-runtime') return deny('EFFECT_OWNER_MISMATCH');
  if (lease?.owner!=='capture-studio' || lease.targetId!==a.targetId || lease.state!=='held') return deny('STUDIO_LEASE_NOT_PROVEN');
  if (journal?.admitted!==true || journal?.status!=='pre-dispatch' || !str(journal.intentBindingRef)) return deny('JOURNAL_NOT_ADMITTED');
  if (preflight?.state!=='fresh' || preflight.targetId!==a.targetId || preflight.origin!==a.origin
    || !seq(preflight.sequence) || preflight.sequence < a.sequence)
    return deny('PREFLIGHT_STALE_OR_WRONG_TARGET');
  for (const [kind, field] of [['conversation','conversationRef'],['task','taskRef'],['branch','branchRef'],['generation','generationRef']]) {
    const bound=attachment.identity[kind];
    if(bound.state==='bound' && preflight[field]!==bound.nativeRef) return deny('PREFLIGHT_NATIVE_IDENTITY_MISMATCH');
  }
  return Object.freeze({schema:BRIDGE_SCHEMA,decision:'defer-to-studio',reason:'ALL_ADVISORY_PREDICATES_MET',dispatch:false,retryAuthorized:false});
}

const absent = reason => ({state:'unknown',reason,evidence:[]});
const checked = (reason, evidence) => ({state:'observed',reason,evidence});
function evidenceMatches(e,turn, sessionId,after) {
  return !!e && e.turnId===turn.id && e.payloadDigest===turn.payloadDigest && e.sessionId===sessionId
    && seq(e.sequence) && e.sequence>after && str(e.identity);
}
const stage = (state, reason, evidence=[]) => ({state,reason,evidence});
/**
 * Consumes VERIFIED snapshots from existing owners only. It NEVER reads their on-disk files itself.
 * The Round 7 reconciler is injected rather than forked, and is authoritative for unresolved effect uncertainty.
 */
export function reconcileLifecycle({run,stepKey,journal,binding,baseline,origin:expectedOrigin,
  attachment,reconcileUncertainStep,capture,acceptance,goal}={}) {
  const result={schema:BRIDGE_SCHEMA,stepKey,delivery:absent('UNVERIFIED_INTENT'),replyAttribution:absent('NO_FRESH_REPLY'),
    networkTerminal:absent('NO_NETWORK_TERMINAL'),captureFinalized:absent('CAPTURE_NOT_FINALIZED'),
    acceptedEvidence:absent('G1_G7_NOT_ACCEPTED'),userGoal:absent('GOAL_NOT_VERIFIED'),
    effect:{verdict:'still_unknown',reason:'RECONCILIATION_UNAVAILABLE',retryAuthorized:false},
    readOnly:true,dispatched:false};
  if(typeof reconcileUncertainStep!=='function' || !run || !Array.isArray(run.steps)) return result;
  const step=run.steps.filter(s=>s.key===stepKey);
  if(step.length!==1 || !str(stepKey)) return {...result,effect:{...result.effect,reason:'STEP_NOT_UNIQUE'}};
  const effect=reconcileUncertainStep({run,stepKey,journal,intentBinding:binding});
  result.effect={verdict:effect.verdict,reason:effect.reason,retryAuthorized:false};
  // If the step is already succeeded, Round 7 correctly abstains. Journal evidence must still
  // be verified in the canonical owner; this bridge only projects explicitly proven correlation.
  const s=step[0], b=binding;
  const bound=b?.source==='trusted-pre-effect' && b?.runId===run.id && b?.stepKey===stepKey
    && b?.stepTool===s.tool && b?.argsDigest===s.argsDigest && hex(s.argsDigest)
    && b?.conversationId===run.conversationId && str(b?.threadKey) && str(b?.journalTurnKey)
    && hex(b?.journalPayloadDigest) && journal?.version===2 && journal.threadKey===b.threadKey;
  if (!bound) return {...result,effect:{...result.effect,reason:'DURABLE_JOIN_MISSING_OR_MISMATCHED'}};
  if (['uncertain','in_flight'].includes(s.status) && effect.verdict!=='executed')
    return {...result,effect:{...result.effect,reason:'UNRESOLVED_EFFECT_NOT_POSITIVELY_RECONCILED'}};
  const matches=journal.turns?.filter(t=>t.key===b.journalTurnKey)??[];
  if(matches.length!==1) return {...result,effect:{...result.effect,reason:'JOURNAL_TURN_MISSING_OR_DUPLICATED'}};
  const t=matches[0];
  if(t.conversationId!==b.conversationId || t.payloadDigest!==b.journalPayloadDigest || !str(t.id) || !t.boundary)
    return {...result,effect:{...result.effect,reason:'JOURNAL_INTENT_OR_BOUNDARY_MISMATCH'}};
  // Foreign origin, target or remounted thread cannot be accepted by the projection.
  if(attachment?.schema!==BRIDGE_SCHEMA || attachment.adapter.origin!==expectedOrigin
    || attachment.attachment.origin!==expectedOrigin || baseline?.origin!==expectedOrigin
    || baseline?.targetId!==attachment.attachment.targetId || baseline?.captureRef!==t.boundary.sessionId
    || baseline?.sequence!==t.boundary.sequence || !Array.isArray(baseline.assistantIdentities))
    return {...result,effect:{...result.effect,reason:'ORIGIN_TARGET_OR_BASELINE_UNVERIFIED'}};
  if (attachment.identity.conversation.state==='bound' && baseline.conversationRef!==attachment.identity.conversation.nativeRef)
    return {...result,effect:{...result.effect,reason:'NATIVE_THREAD_MISMATCH'}};
  const d=t.delivery?.evidence;
  if (t.delivery?.state!=='observed' || !evidenceMatches(d,t,t.boundary.sessionId,t.boundary.sequence)
    || !((d.source==='network'&&d.kind==='outgoing-request')||(d.source==='page'&&d.kind==='new-user-turn')))
    return result;
  result.delivery=checked('BOUND_FRESH_DELIVERY',[{source:d.source,identity:d.identity,sequence:d.sequence,sessionId:d.sessionId}]);
  const r=t.reply?.evidence;
  const duplicate=(journal.turns??[]).some(other=>other!==t && (other.reply?.evidence?.identity===r?.identity || other.completion?.evidence?.identity===r?.identity));
  if(t.reply?.state==='observed' && evidenceMatches(r,t,t.boundary.sessionId,d.sequence)
    && (r.source==='page'||r.source==='network') && r.kind==='assistant-reply'
    && seq(r.revision) && r.revision>0 && hex(r.contentDigest) && seq(r.chars)
    && !baseline.assistantIdentities.includes(r.identity) && !duplicate) {
    result.replyAttribution=checked('FRESH_SAME_TURN_REPLY',[{source:r.source,identity:r.identity,revision:r.revision,sequence:r.sequence,contentDigest:r.contentDigest}]);
  }
  const n=t.completion?.evidence;
  if(result.replyAttribution.state==='observed' && t.completion?.state==='complete' && evidenceMatches(n,t,t.boundary.sessionId,r.sequence)
    && n.kind==='reply-complete' && n.source==='network' && n.identity===r.identity && n.revision===r.revision)
    result.networkTerminal=checked('BOUND_NETWORK_TERMINAL',[{identity:n.identity,sequence:n.sequence}]);
  if(capture?.source==='studio-recorder' && capture.state==='finalized' && capture.sessionId===t.boundary.sessionId
    && str(capture.reference) && capture.origin===expectedOrigin)
    result.captureFinalized=checked('STUDIO_CAPTURE_FINALIZED',[{reference:capture.reference,sessionId:capture.sessionId}]);
  const gates=acceptance?.gates;
  if(result.replyAttribution.state==='observed' && result.captureFinalized.state==='observed'
    && ['SAVED_REAL_CAPTURE','WINDOWS_LIVE_ACCEPTED'].includes(acceptance?.evidenceClass)
    && acceptance?.source==='studio-acceptance-verifier' && acceptance?.integrity==='verified'
    && acceptance?.sessionId===t.boundary.sessionId && acceptance?.origin===expectedOrigin
    && gates && Array.from({length:7},(_,i)=>`G${i+1}`).every(k=>gates[k]?.state==='accepted' && str(gates[k]?.reference)))
    result.acceptedEvidence=checked('G1_G7_VERIFIED',Array.from({length:7},(_,i)=>({gate:`G${i+1}`,reference:gates[`G${i+1}`].reference})));
  if(result.acceptedEvidence.state==='observed' && ['SAVED_REAL_CAPTURE','WINDOWS_LIVE_ACCEPTED'].includes(goal?.evidenceClass) && goal?.source==='existing-outcome-verifier'
    && goal?.state==='fulfilled' && goal?.sessionId===t.boundary.sessionId && str(goal.reference))
    result.userGoal=checked('GOAL_EXPLICITLY_VERIFIED',[{reference:goal.reference}]);
  return result;
}
