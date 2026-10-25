// Issue #70: builder integration receipt using actual learner journal + Core-compatible
// SHAPES / acceptance data shapes, with synthetic private-free records.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ScopedLearner} from '../../src/intel/learn.mjs';
import {LearnerJournal} from '../../src/intel/learner-journal.mjs';
import {profileEvidenceView} from '../../src/intel/profile-evidence.mjs';
const desc={type:'string',string:{avgLen:19,uniqueness:0.7,formats:{}}};
const A={site:'lab',origin:'https://lab.test',account:'A'};
const B={...A,account:'B'};
const partition={site:{origin:A.origin},totals:{site:1,other:1,unknown:0},dom:{unattributedCount:0}};
const accepted={schema:'capture-studio.acceptance/1',verdict:'capture_accepted',
  gates:Object.fromEntries(['G1','G2','G3','G4','G5','G6','G7'].map(k=>[k,{value:'passed'}])),
  binding:{rawDigest:'0'.repeat(64),seqRange:[1,12],recipe:{id:'fixture',version:1}}};
const shapes=(n)=>({groups:[{endpoint:'POST /conversation',count:1,fields:{
  '$.messages[*].content.parts[*].text':{count: n},
  '$.messages[*].metadata.role':{count:2}}}],suggestions:[
  {id:'message-content',kind:'record_rule',confidence:.8,proposal:{op:'record_rule',privateSourceText:'never export this'}}]});
function view(session, account, verified=true) {return profileEvidenceView({pageUrl:A.origin+'/chat',
  sessionId:session, account, partition, shapes:shapes(session==='s1'?1:3),
  acceptance:accepted,validatedByCore:verified});}
const predict=(model, ctx) => model.predict('subject',desc,ctx).dist.text;
const evaluate=(model)=>{let TP=0,FP=0,TN=0,FN=0;for(const [ctx,positive] of [[A,true],[B,false]])
  for(let i=0;i<5;i++){const p=predict(model,{...ctx,instanceId:'heldout-'+i})>=.5;if(p&&positive)TP++;else if(p)FP++;else if(positive)FN++;else TN++;}
  return {TP,FP,TN,FN};};
test('two saved-session profile suggestions keep observed fields but not private raw text',()=>{
  const before=view('s1','A'),after=view('s2','A');
  assert.equal(before.admission.eligible,true);assert.equal(before.modelPromotion.allowed,false);
  assert.equal(after.fields[0].observations,3);
  assert.equal(before.fields[0].observations,1);
  for(const p of [before,after]){assert.equal(p.scope.origin,A.origin);
    assert.equal(JSON.stringify(p).includes('never export this'),false);
    assert.ok(p.suggestions.every(s=>s.status==='inferred-review-only'));}
  assert.equal(view('s2',null).modelPromotion.eligibleForReview,false);
  assert.equal(view('s2','A',false).admission.eligible,false);
});
test('corrected model version changes future held-out inference, isolates account B and rollbacks', (t)=>{
  const dir=mkdtempSync(join(tmpdir(),'aion70-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const learner=new ScopedLearner(dir), journal=new LearnerJournal(dir);
  assert.deepEqual(evaluate(learner),{TP:0,FP:0,TN:5,FN:5});
  learner.save(); // revision 1: baseline
  const source=view('s2','A');
  assert.equal(source.admission.eligible,true);
  const item=learner.proposeCorrection({scope:'account',name:'subject',d:desc,ctx:A,role:'text',actor:'synthetic-owner',
    evidence:{session:'s2',seq:8,sid:'fixture',acceptanceDigest:source.admission.sourceDigest}});
  assert.deepEqual(evaluate(learner),{TP:0,FP:0,TN:5,FN:5},'unreviewed proposal never trains');
  learner.reviewCorrection(item.id,{action:'accept',actor:'synthetic-owner',evidence:{session:'s2',seq:8}});
  assert.deepEqual(evaluate(learner),{TP:5,FP:0,TN:5,FN:0});
  learner.save(); // revision 2: approved correction
  const detached=new ScopedLearner(null);
  detached._load(journal.at(1)); // read-only revision model, not current state
  assert.deepEqual(evaluate(detached),{TP:0,FP:0,TN:5,FN:5});
  assert.equal(learner.rollbackTo(1,{actor:'synthetic-owner',reason:'undo corrected profile'}),3);
  assert.deepEqual(evaluate(new ScopedLearner(dir)),{TP:0,FP:0,TN:5,FN:5});
  assert.equal(journal.at(2).corrections[0].id,item.id);
  assert.deepEqual(journal.versions(),[1,2,3]);
  assert.equal(journal.at(3).audit.at(-1).action,'rollback');
});
