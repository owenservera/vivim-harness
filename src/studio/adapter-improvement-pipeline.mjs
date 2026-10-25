// I1 reusable event-driven, read-only intelligence -> adapter proposal lifecycle.
// Inject Agent 14 Round 8/9 and Core's existing transactional VersionedStore bridge.
import { createHash } from 'node:crypto';
import { intakeEvents, scopeKey } from './adapter-evidence-intake.mjs';

export const PIPELINE_SCHEMA = 'aion.adapter-improvement-proposal/1';
const READ = ['user-turn','assistant-turn','thread-route','citation','artifact','task-progress','stream-component'];
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sourceRefs = receipts => [...new Map(receipts.map(r => [r.evidenceRef, {
  captureId:r.captureId,sessionId:r.sessionId,sequence:r.sequence,rawDigest:r.rawDigest,
  domDigest:r.domDigest,evidenceRef:r.evidenceRef,carrier:r.carrier,
  evidenceClass:r.evidenceClass,accountBinding:r.accountBinding,sourceProducer:r.sourceProducer,
}])).values()];
const err = code => { throw Object.assign(new Error(code),{code}); };
function deepFreeze(value) { if(value && typeof value==='object' && !Object.isFrozen(value)){Object.freeze(value);for(const x of Object.values(value))deepFreeze(x);} return value; }
const id = e => e.source.captureId;
const sessions = events => [...new Set(events.map(e=>e.source.sessionId))];
function assertDistinct(training, heldout, scope) {
  if(training.length===0||heldout.length===0) err('TRAIN_OR_HOLDOUT_MISSING');
  const all = [...training,...heldout];
  for(const e of all) if(scopeKey(e.scope)!==scopeKey(scope)) err('SCOPE_CROSSED');
  const trainIds=new Set(training.map(id)), trainSessions=new Set(sessions(training));
  const trainDigests=new Set(training.map(e=>e.source.rawDigest));
  if(heldout.some(e=>trainIds.has(id(e))||trainSessions.has(e.source.sessionId)||trainDigests.has(e.source.rawDigest))) err('HOLDOUT_NOT_INDEPENDENT');
  // Multiple captures in one session are not genuinely independent training votes.
  const check = records => {
    const bySession=new Map(), byDigest=new Map();
    for(const e of records){
      if(bySession.has(e.source.sessionId) && bySession.get(e.source.sessionId)!==e.source.captureId) err('SESSION_CAPTURE_ALIAS');
      bySession.set(e.source.sessionId,e.source.captureId);
      if(byDigest.has(e.source.rawDigest) && byDigest.get(e.source.rawDigest)!==e.source.captureId) err('DUPLICATE_SOURCE_RELABELED');
      byDigest.set(e.source.rawDigest,e.source.captureId);
    }
  };
  check(training);check(heldout);
  if(new Set(training.map(id)).size<3 || new Set(heldout.map(id)).size<2) err('INSUFFICIENT_INDEPENDENT_SESSIONS');
}
function selected(candidate, feature) {return candidate?.features?.[feature]?.selected?.candidate??null;}
// Compare against actual provider seed read rules, not an empty invented baseline.
// Seed rules are score-only and can never become learned or browser authority.
function readRules(adapter, feature) {
  const rule=selected(adapter,feature);
  if(rule)return [rule];
  const legacy=feature==='assistant-turn'?adapter?.assistant?.containerSelectors
    :feature==='user-turn'?adapter?.userTurn?.selectors
    :feature==='thread-route'?(adapter?.threadRoute?.pattern?[adapter.threadRoute.pattern]:null)
    :feature==='stream-component'?adapter?.streamHints?.urlPatterns:null;
  return Array.isArray(legacy)?legacy.filter(x=>typeof x==='string'&&x.length>0):[];
}
function qualifiedReadFeatures(candidate, probes, receipts, testOnly=false) {
  return READ.filter(feature=>{
    const slot=candidate?.features?.[feature],rule=slot?.selected;
    if(!rule||slot.inherited===true||(!testOnly&&rule.status!=='shadow-ready'))return false;
    const byCapture=new Map();
    for(let i=0;i<probes.length;i++){
      const p=probes[i],r=receipts[i];
      if(p.feature!==feature||r?.identityVerified!==true)continue;
      const entry=byCapture.get(p.captureId)??{present:new Set(),absent:new Set()};
      byCapture.set(p.captureId,entry);
      if(p.outcome==='present')entry.present.add(p.candidate);
      else if(p.outcome==='absent')entry.absent.add(p.candidate);
    }
    const records=[...byCapture.values()];
    return records.filter(v=>v.present.size===1&&v.present.has(rule.candidate)&&!v.absent.has(rule.candidate)).length>=2
      &&!records.some(v=>v.absent.has(rule.candidate)||v.present.size>1||
        (v.present.size===1&&!v.present.has(rule.candidate)));
  });
}
function quality(candidate, probes, receipts) {
  const byCapture=new Map();
  for(let i=0;i<probes.length;i++) {
    const p=probes[i],r=receipts[i];
    if(!READ.includes(p.feature)) continue;
    const key=JSON.stringify([p.captureId,p.feature]);
    if(!byCapture.has(key)) byCapture.set(key,{feature:p.feature,captureId:p.captureId,observations:[]});
    byCapture.get(key).observations.push({probe:p,receipt:r});
  }
  const result={total:0,TP:0,FP:0,FN:0,TN:0,unknown:0,identityRoleErrors:0,coverage:0,
    observed:[],calibration:{bins:[],brier:null}};
  let sq=0, predictions=0;
  for(const rec of byCapture.values()) {
    const rules=readRules(candidate,rec.feature);
    const valid=rec.observations.filter(({probe,receipt})=>probe.outcome!=='unknown' && receipt.identityVerified);
    if(!valid.length){result.unknown++;continue;}
    const present=valid.filter(x=>x.probe.outcome==='present');
    // Multiple distinct positive targets for same role are inherently ambiguous: fail closed.
    const truths=new Set(present.map(x=>x.probe.candidate));
    if(truths.size>1){result.unknown++;continue;}
    const expected=[...truths][0]??null;
    const prediction=rules.length>0, matched=!!expected&&rules.includes(expected);
    if(expected&&matched)result.TP++;
    else if(expected){result.FN++;if(prediction)result.FP++;}
    else if(prediction)result.FP++;
    else result.TN++;
    if(rules.some(rule=>rec.observations.some(x=>x.probe.candidate===rule&&x.probe.outcome==='absent')))result.identityRoleErrors++;
    const probability=candidate?.features?.[rec.feature]?.selected?.confidence;
    if(prediction&&typeof probability==='number'&&probability>=0&&probability<=1){sq+=(probability-(matched?1:0))**2;predictions++;}
    result.total++;
    result.observed.push({captureId:rec.captureId,feature:rec.feature,matched,known:!!expected});
  }
  result.coverage=+(result.total/(result.total+result.unknown||1)).toFixed(4);
  result.calibration.brier=predictions?+(sq/predictions).toFixed(4):null;
  result.falseMatches=result.FP;
  result.readSuccess=result.TP;
  return result;
}
const invalidDualRole = candidate => {
  const a=selected(candidate,'assistant-turn'),u=selected(candidate,'user-turn');
  return !!a&&a===u;
};
const diff = (oldv,newv) => ({newReadSuccess:newv.TP,baselineReadSuccess:oldv.TP,
  gain:newv.TP-oldv.TP,falseMatchDelta:newv.FP-oldv.FP,coverage:newv.coverage,
  brier:newv.calibration.brier});
export function createAdapterImprovementPipeline({synthesize,shadowEvaluate,assertIndependentHoldout,
  verifyCapture,store}={}) {
  if([synthesize,shadowEvaluate,assertIndependentHoldout,verifyCapture].some(f=>typeof f!=='function') || !store ||
    ['current','promote','rollback'].some(k=>typeof store[k]!=='function')) err('MISSING_STUDIO_BRIDGE');
  const observed=new Map(); // volatile dedupe cache only, not site registry or durable store.
  const minted=new WeakSet(); // only server-produced, immutable proposals may be promoted
  async function propose({scope,training,heldout,seed=null,testOnly=false,trigger='new-evidence'}={}) {
    const key=scopeKey(scope);
    if(!['new-evidence','drift','reviewed-correction'].includes(trigger)) err('INVALID_EVENT_TRIGGER');
    assertDistinct(training,heldout,scope);
    const a=await intakeEvents(training,{verifyCapture});
    const b=await intakeEvents(heldout,{verifyCapture});
    const sourceClasses=new Set([...a.receipts,...b.receipts].map(r=>r.evidenceClass));
    const synthetic=sourceClasses.has('SYNTHETIC_TEST');
    if(synthetic && !testOnly) err('SYNTHETIC_NOT_PRODUCTION_PROOF');
    if(sourceClasses.size!==1) err('MIXED_EVIDENCE_CLASS');
    const active=await store.current(key);
    const prior=active?.adapter??null;
    const candidate=synthesize({siteId:scope.siteId,origin:scope.origin,surface:scope.surface,observations:a.probes,prior});
    const holdoutIds=[...new Set(b.probes.map(x=>x.captureId))];
    if(holdoutIds.length<2) err('UNUSABLE_HOLDOUT');
    const independent=assertIndependentHoldout(candidate,holdoutIds);
    const shadow=shadowEvaluate(candidate,b.probes);
    const learnedScore=quality(candidate,b.probes,b.receipts);
    const baseline=quality(prior??seed,b.probes,b.receipts);
    const metrics=diff(baseline,learnedScore);
    const eligible=qualifiedReadFeatures(candidate,b.probes,b.receipts,testOnly);
    const drifted=(candidate.drift??[]).map(d=>({feature:d.feature,reason:d.reason}));
    const digest=hash([key,training.map(e=>[id(e),e.source.rawDigest,e.source.sequence]),
      heldout.map(e=>[id(e),e.source.rawDigest,e.source.sequence]),active?.version??null,
      hash(a.probes),hash(b.probes)]);
    const noGain=metrics.gain<=0 && !drifted.length;
    const regression=learnedScore.TP<baseline.TP||learnedScore.FP>baseline.FP||
      learnedScore.identityRoleErrors>baseline.identityRoleErrors;
    const quarantine=invalidDualRole(candidate)||regression||
      shadow.contradicted>0||eligible.length===0;
    const status=quarantine?'quarantined':noGain?'no-improvement':testOnly?'test-only-preview':'ready-for-read-only-promotion';
    const proposal={schema:PIPELINE_SCHEMA,scope:{...scope},scopeKey:key,
      candidate,baseline:baseline,learned:learnedScore,metrics,shadow,independent,
      status,eligibleFeatures:eligible,drift:drifted,trigger,trainingCount:sessions(training).length,
      heldoutCount:sessions(heldout).length,evidenceClass:[...sourceClasses][0],
      baseVersion:active?.version??null,proposalDigest:digest,
      authority:{readOnly:true,sendPermission:false,browserEffectGrant:false,autoExecute:false},
      evidence:{trainingRefs:a.summary,heldoutRefs:b.summary,accountRef:scope.accountRef,
        trainingSources:sourceRefs(a.receipts),heldoutSources:sourceRefs(b.receipts)}};
    if(observed.get(key)===digest) return {...proposal,status:'duplicate-noop',duplicateOf:status};
    observed.set(key,digest);
    deepFreeze(proposal); minted.add(proposal);
    return proposal;
  }
  async function promote(proposal) {
    if(!proposal || !minted.has(proposal) || proposal.schema!==PIPELINE_SCHEMA || proposal.status!=='ready-for-read-only-promotion' ||
      proposal.evidenceClass==='SYNTHETIC_TEST'||!proposal.independent?.independent||
      proposal.authority.sendPermission!==false) err('PROMOTION_NOT_ELIGIBLE');
    const key=scopeKey(proposal.scope);
    if(key!==proposal.scopeKey) err('SCOPE_TAMPERED');
    // Existing Core publisher MUST implement atomic compare-and-save at the expected version.
    return store.promote(key,{schema:'aion.learned-read-adapter/1',adapter:proposal.candidate,
      readFeatures:proposal.eligibleFeatures,metrics:proposal.metrics,proposalDigest:proposal.proposalDigest,
      evidenceClass:proposal.evidenceClass,sendPermission:false},proposal.baseVersion);
  }
  async function rollback(scope,targetVersion,expectedVersion) {
    const key=scopeKey(scope);
    if(!Number.isSafeInteger(targetVersion)||targetVersion<1) err('INVALID_ROLLBACK_VERSION');
    return store.rollback(key,targetVersion,expectedVersion);
  }
  async function resolveRead(scope,seed,{simulation=false,proposal=null}={}) {
    const key=scopeKey(scope);
    const active=await store.current(key);
    if(active?.status==='active' && active.adapter && active.sendPermission===false && active.readFeatures?.length)
      return {source:'learned',adapter:active.adapter,version:active.version,
        fallback:seed,readFeatures:active.readFeatures,sendPermission:false};
    if(simulation && proposal?.status==='test-only-preview' && proposal.scopeKey===key)
      return {source:'synthetic-preview',adapter:proposal.candidate,version:null,fallback:seed,
        readFeatures:proposal.eligibleFeatures,sendPermission:false};
    return {source:'seed',adapter:seed,version:null,fallback:null,readFeatures:[],sendPermission:false};
  }
  // Pure read selection; pageEvidence comes only from the current Core page observer.
  // No profile selector grants a browser effect or proves a current capability.
  async function selectReadRule(scope,feature,seedRule,{pageEvidence}={}) {
    if(!READ.includes(feature))err('NOT_A_READ_FEATURE');
    const read=await resolveRead(scope,null);
    const choice=selected(read.adapter,feature);
    const proof=pageEvidence && pageEvidence.origin===scope.origin &&
      pageEvidence.accountRef===scope.accountRef && pageEvidence.feature===feature &&
      pageEvidence.candidate===choice && pageEvidence.outcome==='present' &&
      pageEvidence.fresh===true && pageEvidence.source==='observed-current-page' &&
      (!['assistant-turn','user-turn','thread-route'].includes(feature) || pageEvidence.identityConfirmed===true);
    if(read.source==='learned' && read.readFeatures.includes(feature) && proof)
      return {source:'learned-proven',candidate:choice,version:read.version,sendPermission:false};
    return {source:'seed-fallback',candidate:seedRule??null,version:null,
      reason:read.source==='learned'?'FRESH_PAGE_PROOF_MISSING':'LEARNED_RULE_UNAVAILABLE',sendPermission:false};
  }
  return {propose,promote,rollback,resolveRead,selectReadRule};
}
