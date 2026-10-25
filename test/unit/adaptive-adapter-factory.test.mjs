import test from 'node:test';
import assert from 'node:assert/strict';
import { synthesizeWebappAdapter, shadowEvaluateAdapter } from '../../src/studio/adaptive-adapter-factory.mjs';
const ctx = {siteId:'example',origin:'https://example.test',surface:'chat'};
const probe = ({feature='composer',candidate='#prompt',captureId='s1',sequence=1,outcome='present',coverage='complete',evidenceClass='SAVED_REAL_CAPTURE'}={})=>({
  ...ctx,feature,type:feature==='thread-route'?'route':feature==='stream-component'?'stream-map':'selector',candidate,captureId,sequence,outcome,coverage,evidenceClass,
  carrier: feature==='thread-route'?'dom':feature==='stream-component'?'network':'dom',
});
const make = (o=[])=>synthesizeWebappAdapter({...ctx,observations:o});

test('no observations means no invented capabilities or send authority',()=>{
  const r=make();assert.equal(r.features.composer.selected,null);assert.equal(r.coverage['assistant-turn'],'unverified');
  assert.equal(r.authority.sendPermission,false);assert.equal(r.authority.autoExecution,false);
});
test('one positive observation is provisional, never automatically executes',()=>{
  const r=make([probe()]);assert.equal(r.features.composer.selected.status,'provisional');assert.equal(r.authority.sendPermission,false);
});
test('three distinct captures and two real observations produce shadow-ready candidate',()=>{
  const o=[probe({captureId:'s1'}),probe({captureId:'s2'}),probe({captureId:'s3',evidenceClass:'SYNTHETIC_TEST'})];
  const r=make(o);assert.equal(r.features.composer.selected.status,'shadow-ready');assert.equal(r.features.composer.selected.provenance.sessions,3);
});
test('three synthetic captures cannot become shadow-ready',()=>{
  const o=['s1','s2','s3','s4'].map(captureId=>probe({captureId,evidenceClass:'SYNTHETIC_TEST'}));
  assert.equal(make(o).features.composer.selected.status,'provisional');
});
test('multiple samples from same capture do not inflate support',()=>{
  const o=[probe({sequence:1}),probe({sequence:2}),probe({sequence:3})];
  assert.equal(make(o).features.composer.selected.provenance.positive,1);
});
test('conflict in same capture is inconclusive, not counted as two votes',()=>{
  const o=[probe({sequence:1}),probe({sequence:2,outcome:'absent'})];
  const r=make(o);assert.equal(r.features.composer.selected,null);assert.equal(r.features.composer.proposals[0].provenance.unknown,1);
});
test('negative observations require complete coverage: virtualized DOM absence is unknown',()=>{
  assert.throws(()=>make([probe({outcome:'absent',coverage:'partial'})]),/INVALID_OBSERVATION/);
});
test('wrong site, surface and origin cannot teach an adapter',()=>{
  assert.throws(()=>make([{...probe(),siteId:'other'}]),/INVALID_OBSERVATION/);
  assert.throws(()=>make([{...probe(),surface:'work'}]),/INVALID_OBSERVATION/);
  assert.throws(()=>make([{...probe(),origin:'https://wrong.test'}]),/INVALID_OBSERVATION/);
});
test('reject unsafe origin and arbitrary or oversized payload',()=>{
  assert.throws(()=>synthesizeWebappAdapter({...ctx,origin:'http://example.test'}),/INVALID_ORIGIN/);
  assert.throws(()=>make([probe({candidate:'X'.repeat(350)})]),/INVALID_OBSERVATION/);
});
test('thread route must use route type, stream component requires network carrier',()=>{
  assert.throws(()=>make([{...probe({feature:'thread-route',candidate:'/c/:id',sequence:4}),type:'selector'}]),/INVALID_OBSERVATION/);
  assert.throws(()=>make([{...probe({feature:'stream-component'}),carrier:'dom'}]),/INVALID_OBSERVATION/);
});
test('baseline disagreement flagged as drift; promotion is not automatic',()=>{
  const base=make(['s1','s2','s3'].map(captureId=>probe({captureId})));
  const now=synthesizeWebappAdapter({...ctx,prior:base,observations:[
    probe({captureId:'s4',outcome:'absent'}),
    ...['s5','s6','s7'].map(captureId=>probe({captureId,candidate:'[role=textbox]',sequence:2})),
  ]});
  assert.equal(now.features.composer.selected.candidate,'[role=textbox]');assert.ok(now.drift.some(x=>x.reason==='PREVIOUS_CANDIDATE_NEGATIVE_OBSERVATION'));
  assert.ok(now.drift.some(x=>x.reason==='PROPOSED_REPLACEMENT_REQUIRES_SHADOW_VALIDATION'));
  assert.equal(now.authority.autoExecution,false);
});
test('prior adapter cannot leak between provider scopes',()=>{
  const prior=make([probe()]);assert.throws(()=>synthesizeWebappAdapter({...ctx,siteId:'other',prior}),/PRIOR_SCOPE_MISMATCH/);
});
test('held-out negative fixture quarantines candidate',()=>{
  const candidate=make(['s1','s2','s3'].map(captureId=>probe({feature:'assistant-turn',candidate:'article[role=assistant]',captureId})));
  const result=shadowEvaluateAdapter(candidate,[probe({feature:'assistant-turn',candidate:'article[role=assistant]',captureId:'s4',outcome:'absent'})]);
  assert.equal(result.recommendation,'quarantine');assert.equal(result.contradicted,1);assert.equal(result.sendPermission,false);
});
test('held-out positives permit read-only preview only',()=>{
  const candidate=make(['s1','s2','s3'].map(captureId=>probe({feature:'user-turn',candidate:'[role=human]',captureId})));
  const result=shadowEvaluateAdapter(candidate,[probe({feature:'user-turn',candidate:'[role=human]',captureId:'s4'})]);
  assert.equal(result.recommendation,'candidate-read-only-preview');assert.equal(result.publishExecuted,false);
});
test('shadow inference without distinct evidence cannot grant any action',()=>{
  const candidate=make([probe()]);const r=shadowEvaluateAdapter(candidate,[]);assert.equal(r.recommendation,'collect-more-evidence');
});
test('shadow rejects cross-site fixture',()=>{
  const candidate=make([probe()]);assert.throws(()=>shadowEvaluateAdapter(candidate,[{...probe(),origin:'https://other.test'}]),/INVALID_SHADOW_OBSERVATION/);
});
test('output deterministic under reordered input and contains no body values',()=>{
  const o=[probe({captureId:'s3'}),probe({captureId:'s1'}),probe({captureId:'s2'})];
  assert.deepEqual(make(o),make([...o].reverse()));
  assert.equal(JSON.stringify(make(o)).includes('rawPrompt'),false);
});