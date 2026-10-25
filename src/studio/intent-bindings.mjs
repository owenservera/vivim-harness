// Agent 14 Round 9 — drop-in replacement for Z.ai Round 8 src/studio/intent-bindings.mjs.
// Same createIntentBindingStore({dir})/{record,complete,find,verify} contract.
// Record is exclusive and same-key SAME-intent replay is read-only, not a second effect grant.
// Existing harness run store is the sole effect-admission authority; this file never sends.
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, existsSync, openSync, writeFileSync, fsyncSync, closeSync, readFileSync, renameSync, unlinkSync, rmdirSync } from 'node:fs';
import path from 'node:path';

export const INTENT_BINDING_SCHEMA = 'aion.harness-intent-binding/1';
const err = (code) => Object.assign(new Error(code), { code });
const isHex64 = s => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s);
const nonempty = (s, n = 256) => typeof s === 'string' && s.length > 0 && s.length <= n && !/[\x00-\x1f\x7f]/.test(s);
const keyFileName = (runId, stepKey) => createHash('sha256').update(`${runId}\u0000${stepKey}`).digest('hex')+'.json';
const digest = x => createHash('sha256').update(JSON.stringify(x)).digest('hex');
const ident = r => [r.runId,r.stepKey,r.stepTool,r.argsDigest,r.conversationId,r.threadKey];
const identityEqual = (r, a) => ident(r).every((v,i)=>v===ident(a)[i]);
const shape = r => r && r.schema===INTENT_BINDING_SCHEMA && r.source==='trusted-pre-effect'
  && nonempty(r.runId,128) && nonempty(r.stepKey,200) && r.stepTool==='submit_conversation_turn'
  && isHex64(r.argsDigest) && nonempty(r.conversationId,128) && nonempty(r.threadKey,200)
  && nonempty(r.recordedAt,64) && (r.journalTurnKey===null || nonempty(r.journalTurnKey,200))
  && (r.journalPayloadDigest===null || isHex64(r.journalPayloadDigest))
  && (r.journalTurnKey===null)===(r.journalPayloadDigest===null);
const publicRecord = r => Object.fromEntries(Object.entries(r).filter(([k])=>k!=='integrity'));
const encode = r => JSON.stringify({...r,integrity:digest(r)})+'\n';

export function createIntentBindingStore({dir}={}) {
  if(typeof dir!=='string'||!dir)throw new TypeError('dir is required');
  mkdirSync(dir,{recursive:true});
  const fileFor=(runId,stepKey)=>path.join(dir,keyFileName(runId,stepKey));
  const load=file=>{
    let saved;
    try {saved=JSON.parse(readFileSync(file,'utf8'));} catch(e){if(e.code==='ENOENT')return null;throw err('INTENT_BINDING_UNREADABLE');}
    const rec=publicRecord(saved);
    if(!shape(rec)||!isHex64(saved.integrity)||digest(rec)!==saved.integrity)throw err('INTENT_BINDING_CORRUPT');
    return rec;
  };
  const writeNew=(file,record)=>{
    let fd;
    try {
      fd=openSync(file,'wx',0o600); // atomic exclusive create, even across separate processes
      writeFileSync(fd,encode(record)); fsyncSync(fd);
    } finally {if(fd!==undefined)closeSync(fd);}
  };
  const writeReplacement=(file,record)=>{
    const temp=`${file}.${randomUUID()}.tmp`;
    let fd;
    try {
      fd=openSync(temp,'wx',0o600);writeFileSync(fd,encode(record));fsyncSync(fd);closeSync(fd);fd=undefined;
      renameSync(temp,file);
      fd=openSync(file,'r+');fsyncSync(fd);closeSync(fd);fd=undefined; // 'r+': Windows fsync (FlushFileBuffers) needs a write-capable handle
    } finally {if(fd!==undefined)closeSync(fd);try{unlinkSync(temp);}catch{}}
  };
  const checkedArgs=a=>{
    const {runId,stepKey,stepTool,argsDigest,conversationId,threadKey}=a??{};
    if(!nonempty(runId,128)||!nonempty(stepKey,200)||stepTool!=='submit_conversation_turn'
      ||!isHex64(argsDigest)||!nonempty(conversationId,128)||!nonempty(threadKey,200))throw new TypeError('INVALID_INTENT_BINDING_FIELDS');
    return {runId,stepKey,stepTool,argsDigest,conversationId,threadKey};
  };
  return {
    record(args){
      const input=checkedArgs(args),file=fileFor(input.runId,input.stepKey);
      const record={schema:INTENT_BINDING_SCHEMA,source:'trusted-pre-effect',...input,
        recordedAt:new Date().toISOString(),journalTurnKey:null,journalPayloadDigest:null,completedAt:null};
      try {writeNew(file,record);return structuredClone(record);} catch(e){
        if(e.code!=='EEXIST')throw e;
        const existing=load(file); // unreadable in-flight or corrupt record: fail closed
        if(!identityEqual(existing,input))throw err('INTENT_BINDING_CONFLICT');
        return structuredClone(existing); // same intent, no effect authorization
      }
    },
    complete({runId,stepKey,journalTurnKey,journalPayloadDigest}={}){
      if(!nonempty(runId,128)||!nonempty(stepKey,200)||!nonempty(journalTurnKey,200)||!isHex64(journalPayloadDigest))
        throw new TypeError('INVALID_COMPLETION_FIELDS');
      const file=fileFor(runId,stepKey),lock=`${file}.lock`;
      // Short synchronous lock ONLY around read-modify-write. Unproven/dead locks fail closed;
      // no automatic stale-lock clearing or second executor permitted.
      try {mkdirSync(lock);}catch(e){if(e.code==='EEXIST')throw err('INTENT_BINDING_BUSY');throw e;}
      try {
        const record=load(file);if(!record)throw err('INTENT_BINDING_MISSING');
        if(record.journalTurnKey){
          if(record.journalTurnKey!==journalTurnKey||record.journalPayloadDigest!==journalPayloadDigest)throw err('INTENT_BINDING_CONFLICT');
          return structuredClone(record);
        }
        record.journalTurnKey=journalTurnKey;record.journalPayloadDigest=journalPayloadDigest;
        record.completedAt=new Date().toISOString();
        writeReplacement(file,record);return structuredClone(record);
      } finally {try{rmdirSync(lock);}catch{throw err('INTENT_BINDING_LOCK_RELEASE_UNVERIFIED');}}
    },
    find({runId,stepKey}={}){
      if(!nonempty(runId,128)||!nonempty(stepKey,200))return null;
      try{return structuredClone(load(fileFor(runId,stepKey)));}catch{return null;} // downstream reconciler returns still_unknown
    },
    verify(binding,{runId,stepKey,stepTool,argsDigest,conversationId}={}){
      return !!binding&&shape(binding)&&binding.runId===runId&&binding.stepKey===stepKey
        &&binding.stepTool===stepTool&&binding.argsDigest===argsDigest&&binding.conversationId===conversationId;
    }
  };
}