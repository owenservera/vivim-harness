import test from 'node:test';
import assert from 'node:assert/strict';
import {intakeEvents} from '../../src/studio/adapter-evidence-intake.mjs';
import {createAdapterImprovementPipeline} from '../../src/studio/adapter-improvement-pipeline.mjs';
const scope={siteId:'unknown',origin:'https://unknown.example',accountRef:'a',surface:'chat'};
const e=(n,override={})=>{
 const s={...scope,...override.scope};
 return {scope:s,source:{captureId:'c'+n,sessionId:'s'+n,rawDigest:n.toString(16).padStart(64,'0'),sequence:n,origin:s.origin,accountRef:s.accountRef,carrier:'dom',coverage:override.coverage??'complete',evidenceClass:override.evidenceClass??'SYNTHETIC_TEST',evidenceRef:'r'+n},
 observations:['assistant-turn','user-turn'].map(f=>({feature:f,outcome:override.outcome??'present',attributes:{'data-testid':override.shared?'shared':f+'-v2'},identityRole:f==='assistant-turn'?'assistant':'user',identityVerdict:override.identityVerdict??'verified',identityRef:'independent-binding',evidenceRef:'r'+n}))};
};
const train=[e(1),e(2),e(3)],hold=[e(4),e(5)];
const factory=({siteId,origin,surface,observations,prior})=>{
 const features={};
 for(const feature of new Set(observations.map(x=>x.feature))){
  const rows=observations.filter(x=>x.feature===feature);
  features[feature]={selected:{candidate:rows[0].candidate,status:rows[0].evidenceClass==='SYNTHETIC_TEST'?'provisional':'shadow-ready',confidence:.8}};
 }
 return {schema:'aion.adaptive-webapp-adapter/1',siteId,origin,surface,features,
  evidence:{captureRefs:[...new Set(observations.map(x=>x.captureId))],capturesTruncated:false},drift:prior?[]:[{feature:'assistant-turn',reason:'new'}]};
};
const independent=(c,ids)=>{if(c.evidence.capturesTruncated||ids.some(i=>c.evidence.captureRefs.includes(i)))throw Error('overlap');return {independent:true,heldoutCount:ids.length}};
const shadow=(c,probes)=>({contradicted:probes.filter(x=>x.outcome==='absent'&&c.features[x.feature]?.selected?.candidate===x.candidate).length});
const seed={features:{'assistant-turn':{selected:{candidate:'[data-testid="old"]'}}}};
const store=()=>{
 const m=new Map();return {
  current:async k=>m.get(k)?.active??null,
  promote:async(k,v,expected)=>{const r=m.get(k)??{all:[],active:null};if((r.active?.version??null)!==expected)throw Error('STALE_VERSION');r.active={...structuredClone(v),version:r.all.length+1,status:'active'};r.all.push(r.active);m.set(k,r);return r.active},
  rollback:async(k,v,expected)=>{const r=m.get(k);if(r?.active?.version!==expected)throw Error('STALE_VERSION');const old=r.all.find(x=>x.version===v);if(!old)throw Error('VERSION_UNKNOWN');r.active={...old,version:r.all.length+1,rollbackOf:v};r.all.push(r.active);return r.active}
 };
};
const create=(override={})=>createAdapterImprovementPipeline({synthesize:factory,shadowEvaluate:shadow,assertIndependentHoldout:independent,verifyCapture:async()=>true,store:override.store??store()});
const propose=(p,opts={})=>p.propose({scope,training:train,heldout:hold,seed,testOnly:true,...opts});

test('unregistered site learned 2 roles on independent 3+2 fixtures; before-after +2',async()=>{const p=await propose(create());assert.equal(p.status,'test-only-preview');assert.equal(p.learned.TP,4);assert.equal(p.baseline.TP,0);assert.equal(p.metrics.gain,4);assert.equal(p.independent.heldoutCount,2)});
test('synthetic never activates or grants browser effects',async()=>{const p=create(),r=await propose(p);await assert.rejects(()=>p.promote(r),/PROMOTION_NOT_ELIGIBLE/);assert.equal((await p.resolveRead(scope,seed)).source,'seed');assert.equal(r.authority.sendPermission,false)});
test('simulated known provider redesign promotes read-only and rolls back',async()=>{const s={...scope,siteId:'chatgpt',origin:'https://chatgpt.com'};const r=n=>e(n,{scope:s,evidenceClass:'SANDBOX_REAL_BROWSER'});const p=create();const x=await p.propose({scope:s,training:[r(1),r(2),r(3)],heldout:[r(4),r(5)],seed});assert.equal(x.status,'ready-for-read-only-promotion');assert.equal((await p.promote(x)).version,1);assert.equal((await p.resolveRead(s,seed)).source,'learned');assert.equal((await p.rollback(s,1,1)).version,2)});
test('source acceptance callback is authoritative for real class',async()=>{await assert.rejects(()=>intakeEvents([e(1,{evidenceClass:'SAVED_REAL_CAPTURE'})],{verifyCapture:async()=>false}),/CAPTURE_NOT_CORE_VERIFIED/)});
test('no production proof from synthetic',async()=>{await assert.rejects(()=>propose(create(),{testOnly:false}),/SYNTHETIC_NOT_PRODUCTION_PROOF/)});
test('overlapping captures cannot be held out',async()=>{await assert.rejects(()=>propose(create(),{heldout:[e(3),e(4)]}),/HOLDOUT_NOT_INDEPENDENT/)});
test('overlapping sessions with relabeled capture cannot be held out',async()=>{const x=e(6);x.source.sessionId='s1';await assert.rejects(()=>propose(create(),{heldout:[x,e(5)]}),/HOLDOUT_NOT_INDEPENDENT/)});
test('overlapping digests cannot be held out',async()=>{const x=e(6);x.source.rawDigest=train[0].source.rawDigest;await assert.rejects(()=>propose(create(),{heldout:[x,e(5)]}),/HOLDOUT_NOT_INDEPENDENT/)});
test('cross site, origin and account are rejected',async()=>{for(const change of [{siteId:'wrong'},{origin:'https://wrong.example'},{accountRef:'b'}])await assert.rejects(()=>propose(create(),{heldout:[e(4,{scope:change}),e(5)]}),/SCOPE_CROSSED/)});
test('unknown account is not silently a site-wide profile',async()=>{await assert.rejects(()=>intakeEvents([e(1,{scope:{accountRef:null}})],{verifyCapture:async()=>true}),/SCOPE_UNVERIFIED/)});
test('wrong evidence ref rejected',async()=>{const x=e(1);x.observations[0].evidenceRef='wrong';await assert.rejects(()=>intakeEvents([x],{verifyCapture:async()=>true}),/OBSERVATION_SOURCE_MISMATCH/)});
test('incomplete absence remains unknown',async()=>{const x=await intakeEvents([e(1,{coverage:'partial',outcome:'absent'})],{verifyCapture:async()=>true});assert.ok(x.probes.every(o=>o.outcome==='unknown'))});
test('inferred role is not treated as verified identity',async()=>{const x=await intakeEvents([e(1,{identityVerdict:'inferred'})],{verifyCapture:async()=>true});assert.ok(x.probes.every(o=>o.outcome==='unknown'))});
test('identical assistant/user selector is quarantined',async()=>{const p=await propose(create(),{training:[e(1,{shared:true}),e(2,{shared:true}),e(3,{shared:true})],heldout:[e(4,{shared:true}),e(5,{shared:true})]});assert.equal(p.status,'quarantined')});
test('disappeared read targets quarantine instead of false success',async()=>{const p=await propose(create(),{heldout:[e(4,{outcome:'absent'}),e(5,{outcome:'absent'})]});assert.equal(p.status,'quarantined')});
test('duplicate event batch is no-op, not an autonomous recapture loop',async()=>{const p=create();await propose(p);assert.equal((await propose(p)).status,'duplicate-noop')});
test('timer trigger cannot force polling',async()=>{await assert.rejects(()=>propose(create(),{trigger:'timer'}),/INVALID_EVENT_TRIGGER/)});
test('caller-forged proposal cannot be promoted',async()=>{const p=create(),q=await propose(p);await assert.rejects(()=>p.promote({...q,status:'ready-for-read-only-promotion',evidenceClass:'SAVED_REAL_CAPTURE'}),/PROMOTION_NOT_ELIGIBLE/)});
test('read profile remains seed fallback without fresh current page proof',async()=>{const s={...scope,siteId:'claude'};const r=n=>e(n,{scope:s,evidenceClass:'SANDBOX_REAL_BROWSER'});const p=create();await p.promote(await p.propose({scope:s,training:[r(1),r(2),r(3)],heldout:[r(4),r(5)],seed}));assert.equal((await p.selectReadRule(s,'assistant-turn','old')).source,'seed-fallback');const good={origin:s.origin,accountRef:s.accountRef,feature:'assistant-turn',candidate:'[data-testid="assistant-turn-v2"]',outcome:'present',fresh:true,identityConfirmed:true,source:'observed-current-page'};assert.equal((await p.selectReadRule(s,'assistant-turn','old',{pageEvidence:good})).source,'learned-proven');assert.equal((await p.selectReadRule(s,'assistant-turn','old',{pageEvidence:{...good,accountRef:'b'}})).source,'seed-fallback')});
test('optimistic concurrency rejects stale profile promotion',async()=>{const s=store(),p=create({store:s}),q=await p.propose({scope,training:[e(1,{evidenceClass:'SANDBOX_REAL_BROWSER'}),e(2,{evidenceClass:'SANDBOX_REAL_BROWSER'}),e(3,{evidenceClass:'SANDBOX_REAL_BROWSER'})],heldout:[e(4,{evidenceClass:'SANDBOX_REAL_BROWSER'}),e(5,{evidenceClass:'SANDBOX_REAL_BROWSER'})],seed});await s.promote(q.scopeKey,{adapter:seed},null);await assert.rejects(()=>p.promote(q),/STALE_VERSION/)});
