import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { qualifyHoldout, assessDrift, auditEffectTrace, createBoundedProjection, qualifyProvenance, scopeKey } from '../../src/studio/systems-probes.mjs';
const f = JSON.parse(readFileSync(new URL('./fixtures/systems-fixtures.json', import.meta.url),'utf8'));
const clone = (v) => structuredClone(v);
const evt = (seq, type, b=f.binding) => ({...clone(b), seq, type});
const opt = (w, lineage, candidate, outcome) => ({scope:clone(f.scope),session:lineage,lineage,window:w,candidate,outcome,coverage:'complete',sourceQualified:true,coreAccepted:true});

for (const c of f.adversarialCases) test('adversarial fixture: '+c.id, ()=>{
  let got;
  if (c.probe==='holdout') {
    const train=clone(f.train), heldout=clone(f.heldout);
    if(c.mutation==='reuseTrainId')heldout[0].id=train[0].id;
    if(c.mutation==='reuseTrainLineage')heldout[0].lineage=train[0].lineage;
    if(c.mutation==='otherAccount')heldout[0].scope.account='test-account-B';
    if(c.mutation==='partialCoverage')heldout[0].coverage='partial';
    if(c.mutation==='unaccepted')heldout[0].coreAccepted=false;
    got=qualifyHoldout({train,heldout,expectedScope:f.scope});
  } else if (c.probe==='intent') {
    const binding=clone(f.binding);
    let events=[evt(1,'intent'),evt(2,'dispatch'),evt(3,'delivery')];
    if(['argsDigest','threadKey','journalTurnKey'].includes(c.mutation))events[1][c.mutation]='mismatched';
    if(c.mutation==='duplicateDispatch')events.splice(2,0,evt(3,'dispatch'));
    if(c.mutation==='duplicateDispatch')events[3].seq=4;
    if(c.mutation==='unattributedDelivery')events=[evt(1,'delivery')];
    if(c.mutation==='outOfOrder')events=[evt(2,'intent'),evt(1,'dispatch')];
    got=auditEffectTrace({binding,events});
  } else {
    const acceptance=clone(f.acceptance), source=clone(f.source), refs=clone(f.refs);
    if(c.mutation==='otherOrigin')source.scope.origin='https://other.invalid';
    if(c.mutation==='otherAccount')source.scope.account='test-account-B';
    if(c.mutation==='otherDigest')source.rawDigest='different';
    if(c.mutation==='captureGap')source.gaps=1;
    if(c.mutation==='notAccepted')acceptance.verdict='capture_incomplete';
    if(c.mutation==='badSeq')refs[0].seq=-1;
    got=qualifyProvenance({acceptance,validatedByCore:true,source,refs,expectedScope:f.scope});
  }
  assert.equal(got.ok,false);
  assert.equal(got.reason,c.expect);
});

test('independent session manifests qualify shadow but never send',()=>{
 const r=qualifyHoldout({train:f.train,heldout:f.heldout,expectedScope:f.scope});
 assert.equal(r.ok,true);assert.equal(r.sendPermission,false);assert.equal(r.independentLineages,3);
});
test('empty heldout and unknown account abstain',()=>{
 assert.equal(qualifyHoldout({train:f.train,heldout:[],expectedScope:f.scope}).ok,false);
 const h=clone(f.heldout);h[0].scope.account=null;
 assert.equal(qualifyHoldout({train:f.train,heldout:h,expectedScope:f.scope}).reason,'UNQUALIFIED_SESSION');
});
test('drift repair needs two consecutive windows and old negative evidence',()=>{
 const observations=[opt(10,'a','.new','present'),opt(11,'b','.new','present'),opt(11,'c','.new','present'),opt(10,'d','.old','absent'),opt(11,'e','.old','absent')];
 const r=assessDrift({scope:f.scope,incumbent:'.old',proposal:'.new',observations});
 assert.equal(r.decision,'shadow-revalidate-read-only');assert.equal(r.sendPermission,false);
 const one=assessDrift({scope:f.scope,incumbent:'.old',proposal:'.new',observations:observations.filter(o=>o.lineage!=='c')});
 assert.equal(one.decision,'abstain');
});
test('flapping drift across nonconsecutive windows must abstain',()=>{
 const observations=[opt(10,'a','.new','present'),opt(12,'b','.new','present'),opt(14,'c','.new','present'),opt(10,'d','.old','absent'),opt(12,'e','.old','absent')];
 assert.equal(assessDrift({scope:f.scope,incumbent:'.old',proposal:'.new',observations}).reason,'MORE_INDEPENDENT_EVIDENCE_REQUIRED');
});
test('duplicate same-lineage conflict cannot manufacture independent votes',()=>{
 const observations=[opt(10,'a','.new','present'),opt(11,'a','.new','absent')];
 assert.equal(assessDrift({scope:f.scope,incumbent:'.old',proposal:'.new',observations}).reason,'CONFLICTING_SESSION_EVIDENCE');
});
test('drift from mismatched origin abstains',()=>{
 const o=opt(10,'a','.new','present');o.scope.origin='https://malicious.invalid';
 assert.equal(assessDrift({scope:f.scope,incumbent:'.old',proposal:'.new',observations:[o]}).reason,'SCOPE_MISMATCH');
});
test('effect with no delivery is UNKNOWN, not retryable',()=>{
 const r=auditEffectTrace({binding:f.binding,events:[evt(1,'intent'),evt(2,'dispatch')]});
 assert.equal(r.decision,'reconcile-read-only');assert.equal(r.retryAuthorized,false);
});
test('pre-effect blocked requires owner reconciliation and no authorization',()=>{
 const r=auditEffectTrace({binding:f.binding,events:[evt(1,'intent'),evt(2,'pre-effect-blocked')]});
 assert.equal(r.decision,'pre-effect-blocked-needs-owner-reconciliation');assert.equal(r.retryAuthorized,false);
});
test('missing independently verified pre-effect binding abstains',()=>{
 const b=clone(f.binding);delete b.journalPayloadDigest;
 assert.equal(auditEffectTrace({binding:b,events:[]}).reason,'MISSING_PRE_EFFECT_BINDING');
});
test('bounded projection coalesces latest revision while preserving raw-authority distinction',()=>{
 const p=createBoundedProjection({maxStreams:2,maxChars:10});
 assert.equal(p.offer({scopeKey:scopeKey(f.scope),streamId:'s1',revision:1,text:'1234567890123'}).truncated,true);
 assert.equal(p.offer({scopeKey:scopeKey(f.scope),streamId:'s1',revision:1,text:'older'}).reason,'STALE_REVISION');
 assert.equal(p.offer({scopeKey:scopeKey(f.scope),streamId:'s1',revision:2,text:'abc'}).ok,true);
 p.offer({scopeKey:scopeKey(f.scope),streamId:'s2',revision:1,text:'ok'});
 assert.equal(p.offer({scopeKey:scopeKey(f.scope),streamId:'s3',revision:1,text:'x'}).reason,'UI_PROJECTION_OVERFLOW');
 const s=p.snapshot();assert.equal(s.streams.length,2);assert.equal(s.streams[0].text,'abc');
 assert.equal(s.metrics.uiGaps,2);assert.equal(s.effectAuthority,false);
});
test('bounded projection rejects malformed updates and caps streams',()=>{
 const p=createBoundedProjection({maxStreams:1,maxChars:5});
 assert.equal(p.offer({scopeKey:'x',streamId:'s',revision:-1,text:'hello'}).ok,false);
 assert.equal(p.snapshot().metrics.maxTracked,0);
 assert.throws(()=>createBoundedProjection({maxStreams:0}),/INVALID_PROJECTION_LIMIT/);
});
test('valid accepted source only eligible for scoped review, not autolearn',()=>{
 const r=qualifyProvenance({acceptance:f.acceptance,validatedByCore:true,source:f.source,expectedScope:f.scope,refs:f.refs});
 assert.equal(r.ok,true);assert.equal(r.autoLearn,false);assert.equal(r.effectAuthority,false);
});
test('provenance cannot manufacture acceptance from UI completeness',()=>{
 const a=clone(f.acceptance);a.verdict='derived';a.uiComplete=true;
 assert.equal(qualifyProvenance({acceptance:a,validatedByCore:true,source:f.source,expectedScope:f.scope,refs:f.refs}).ok,false);
});
import { exploreAdmissionSchedules } from '../../src/studio/systems-probes.mjs';
test('20 deterministic concurrency interleavings exhibit unsafe double effect, fenced model none',()=>{
  const r=exploreAdmissionSchedules();
  assert.equal(r.totalSchedules,20);
  assert.ok(r.unsafeReadThenWrite.multipleDispatchSchedules>0);
  assert.equal(r.atomicAdmission.multipleDispatchSchedules,0);
  assert.equal(r.atomicAdmission.maxDispatch,1);
});
test('even conflicting intents cannot both dispatch in atomic admission model',()=>{
  const r=exploreAdmissionSchedules({conflictingIntent:true});
  assert.equal(r.atomicAdmission.multipleDispatchSchedules,0);
  assert.ok(r.atomicAdmission.conflictSchedules>0);
});
