import test from 'node:test';
import assert from 'node:assert/strict';
import {profileAdmission,profileEvidenceView,profileStructuralDrift} from '../../src/intel/profile-evidence.mjs';
const doc={ schema:'capture-studio.acceptance/1', verdict:'capture_accepted',
 gates:Object.fromEntries(['G1','G2','G3','G4','G5','G6','G7'].map(x=>[x,{value:'passed'}])),
 binding:{ rawDigest:'a'.repeat(64),seqRange:[1,9],recipe:{id:'default',version:1}}};
const partition={site:{origin:'https://a.test'},totals:{unknown:0,other:0},dom:{unattributedCount:0}};
const shapes={groups:[{endpoint:'POST /stream',fields:{'$.turns[*].parts[0].text':{count:5},'$.turns[*].parts[1].type':{count:3}}}],suggestions:[{id:'record-1',kind:'record_rule',confidence:.7,detail:'private payload',proposal:{secret:'private'}}]};
const view=(override={})=>profileEvidenceView({pageUrl:'https://a.test/room',sessionId:'s1',account:'A',shapes,partition,acceptance:doc,validatedByCore:true,...override});
test('requires Core verified G1-G7 binding, never derived-only acceptance',()=>{
 assert.equal(profileAdmission(doc).eligible,false);
 assert.equal(profileAdmission({...doc,verdict:'capture_incomplete'},{validatedByCore:true}).eligible,false);
 assert.equal(profileAdmission({...doc,gates:{...doc.gates,G7:{value:'unknown'}}},{validatedByCore:true}).eligible,false);
 assert.equal(profileAdmission(doc,{validatedByCore:true}).eligible,true);
});
test('origin partition mismatch fails closed and cannot borrow CDN evidence',()=>{
 const r=view({partition:{site:{origin:'https://cdn.a.test'}}});assert.equal(r.status,'unavailable');assert.deepEqual(r.fields,[]);
});
test('retains nested ordered paths and metadata but not private suggestions',()=>{
 const v=view();assert.equal(v.fields.length,2);assert.deepEqual(v.fields.map(f=>f.order),[0,1]);
 assert.match(v.fields[0].path,/turns\[\*\]/);assert.equal(v.fields[0].parentPath,'$.turns[*].parts[*]');
 assert.equal(v.suggestions[0].status,'inferred-review-only');assert.equal(v.suggestions[0].confidenceBasis,'heuristic-not-calibrated');
 assert.equal(JSON.stringify(v).includes('private payload'),false);assert.equal(JSON.stringify(v).includes('private'),false);
});
test('unknown account is not promotable; unaccepted raw still reviewable',()=>{
 const a=view({account:null});assert.equal(a.modelPromotion.allowed,false);
 const b=view({validatedByCore:false});assert.equal(b.admission.eligible,false);assert.ok(b.fields.length>0);assert.equal(b.modelPromotion.allowed,false);
});
test('same-account same-origin structural drift is review-only',()=>{
 const a=view(),b=view({shapes:{...shapes,groups:[{endpoint:'POST /stream',fields:{'$.turns[*].parts[1].type':{count:1},'$.other.kind':{count:1}}}]}});
 const d=profileStructuralDrift(a,b);assert.equal(d.state,'inferred-review-only');assert.equal(d.added.length,1);assert.equal(d.removed.length,1);
 assert.equal(profileStructuralDrift(a,view({account:'B'})).state,'unavailable');
 assert.equal(profileStructuralDrift(a,view({pageUrl:'https://other.test'})).state,'unavailable');
});
test('unknown origins and truncated budget are disclosed not mistaken for full profile',()=>{
 const a=view({partition:{...partition,totals:{unknown:1,other:2}},maxFields:1});assert.equal(a.status,'partial');
 assert.ok(a.limitations.includes('other-origin-evidence-excluded'));assert.ok(a.limitations.includes('field-budget-may-truncate'));
});
