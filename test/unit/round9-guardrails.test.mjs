import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {createIntentBindingStore} from '../../src/studio/intent-bindings.mjs';
import {assertIndependentAdapterHoldout} from '../../src/studio/adapter-holdout-gate.mjs';
const base={runId:'r1',stepKey:'k1',stepTool:'submit_conversation_turn',argsDigest:'a'.repeat(64),conversationId:'conv1',threadKey:'thread1'};
const tmp=fn=>{const dir=mkdtempSync(path.join(os.tmpdir(),'aion-round9-'));try{return fn(dir)}finally{rmSync(dir,{recursive:true,force:true})}};
test('record is idempotent for exactly the same durable intent before execution',()=>tmp(dir=>{
 const s=createIntentBindingStore({dir});const a=s.record(base),b=s.record(base);assert.deepEqual(b,a);assert.equal(s.verify(b,base),true);
}));
test('record remains idempotent across independent instances',()=>tmp(dir=>{
 const a=createIntentBindingStore({dir}),b=createIntentBindingStore({dir});assert.deepEqual(a.record(base),b.record(base));
}));
test('same key but different tool/args/conversation/thread cannot be treated as replay',()=>tmp(dir=>{
 const s=createIntentBindingStore({dir});s.record(base);
 for(const v of [{argsDigest:'b'.repeat(64)},{conversationId:'conv2'},{threadKey:'thread2'}])
  assert.throws(()=>s.record({...base,...v}),e=>e.code==='INTENT_BINDING_CONFLICT');
 assert.throws(()=>s.record({...base,stepTool:'other'}),/INVALID_INTENT_BINDING_FIELDS/);
}));
test('completion is idempotent and exact, with journal key and payload digest',()=>tmp(dir=>{
 const s=createIntentBindingStore({dir});s.record(base);
 const args={runId:'r1',stepKey:'k1',journalTurnKey:'turnkey',journalPayloadDigest:'c'.repeat(64)};
 const first=s.complete(args);assert.deepEqual(first,s.complete(args));assert.deepEqual(first,s.record(base));
 assert.throws(()=>s.complete({...args,journalTurnKey:'other'}),e=>e.code==='INTENT_BINDING_CONFLICT');
 const reopened=createIntentBindingStore({dir}).find({runId:'r1',stepKey:'k1'}); // fresh instance reads the durable completion
 assert.equal(reopened.journalTurnKey,'turnkey');assert.equal(reopened.journalPayloadDigest,'c'.repeat(64));
}));
test('an incomplete pre-effect binding does not claim delivered or not-executed',()=>tmp(dir=>{
 const s=createIntentBindingStore({dir});const b=s.record(base);assert.equal(b.journalTurnKey,null);assert.equal(b.journalPayloadDigest,null);
}));
test('corrupt or partially written record is never overwritten or accepted as replay',()=>tmp(dir=>{
 const s=createIntentBindingStore({dir});s.record(base);
 const name=readFileSync(path.join(dir,requireFileName(dir)),'utf8');
 const f=path.join(dir,requireFileName(dir));writeFileSync(f,name.slice(0,42));
 assert.throws(()=>s.record(base),e=>['INTENT_BINDING_UNREADABLE','INTENT_BINDING_CORRUPT'].includes(e.code));
 assert.equal(s.find(base),null);
}));
function requireFileName(dir){return (awaitlessReadDir(dir)).find(x=>x.endsWith('.json'))}
import {readdirSync as awaitlessReadDir} from 'node:fs';
test('preexisting exclusive lock prevents conflicting completion and leaves prior intact',()=>tmp(dir=>{
 const s=createIntentBindingStore({dir});s.record(base);const f=requireFileName(dir);
 importSyncMkdir(path.join(dir,f+'.lock'));
 assert.throws(()=>s.complete({runId:'r1',stepKey:'k1',journalTurnKey:'j',journalPayloadDigest:'d'.repeat(64)}),e=>e.code==='INTENT_BINDING_BUSY');
 assert.equal(s.find(base).journalTurnKey,null);
}));
import {mkdirSync as importSyncMkdir} from 'node:fs';
const candidate=(ids,truncated=false)=>({schema:'aion.adaptive-webapp-adapter/1',evidence:{captureRefs:ids,capturesTruncated:truncated}});
test('independent held-out evidence is accepted',()=>assert.equal(assertIndependentAdapterHoldout(candidate(['a','b']),['c']).independent,true));
test('training sessions cannot be reused as validation',()=>assert.throws(()=>assertIndependentAdapterHoldout(candidate(['a','b']),['b']),e=>e.code==='HELDOUT_OVERLAPS_TRAINING'));
test('truncated training ledger fails closed',()=>assert.throws(()=>assertIndependentAdapterHoldout(candidate(['a','b'],true),['c']),e=>e.code==='TRAINING_EVIDENCE_TRUNCATED'));
test('missing or empty heldout set cannot promote',()=>{
 assert.throws(()=>assertIndependentAdapterHoldout(candidate(['a']),[]),e=>e.code==='HELDOUT_EVIDENCE_MISSING');
 assert.throws(()=>assertIndependentAdapterHoldout({},['x']),e=>e.code==='TRAINING_EVIDENCE_MISSING');
});

test('two real child processes concurrently recording the identical intent converge to one record',async()=>{
 const {spawn} = await import('node:child_process');
 const {fileURLToPath}=await import('node:url');
 const script=fileURLToPath(new URL('../../src/studio/intent-bindings.mjs',import.meta.url));
 const dir=mkdtempSync(path.join(os.tmpdir(),'aion-round9-procs-'));
 const code=`import {createIntentBindingStore} from ${JSON.stringify('file://'+script)};const s=createIntentBindingStore({dir:process.argv[1]});const a=${JSON.stringify(base)};try{const r=s.record(a);process.stdout.write(r.stepKey)}catch(e){process.stderr.write(e.code||e.message);process.exitCode=1}`;
 const run=()=>new Promise(resolve=>{
   const proc=spawn(process.execPath,['--input-type=module','-e',code,dir],{stdio:['ignore','pipe','pipe']});
   let stdout='',stderr='';proc.stdout.on('data',x=>stdout+=x);proc.stderr.on('data',x=>stderr+=x);
   proc.on('close',code=>resolve({code,stdout,stderr}));
 });
 try {
  const res=await Promise.all([run(),run()]);
  assert.deepEqual(res.map(x=>x.code),[0,0],JSON.stringify(res));
  assert.deepEqual(res.map(x=>x.stdout),['k1','k1']);
  assert.deepEqual(awaitlessReadDir(dir).filter(x=>x.endsWith('.json')).length,1);
 }finally{rmSync(dir,{recursive:true,force:true});}
});