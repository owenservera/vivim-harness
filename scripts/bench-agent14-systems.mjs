/** Deterministic synthetic S1 microbenchmarks: no live browser, DB or product imports. */
import { performance } from 'node:perf_hooks';
import { readFileSync } from 'node:fs';
import { qualifyHoldout, assessDrift, auditEffectTrace, createBoundedProjection, qualifyProvenance, scopeKey, exploreAdmissionSchedules } from '../src/studio/systems-probes.mjs';
const fixture = JSON.parse(readFileSync(new URL('../test/unit/fixtures/systems-fixtures.json', import.meta.url), 'utf8'));
const clone = structuredClone;
const env = {node:process.version,platform:process.platform,arch:process.arch,synthetic:true,
  isolation:'standalone S1 implementation; not production Studio or Windows accepted'};
function measure(name, fn, samples = 15) {
  const runs=[];let example, cpu=[];
  fn();
  for(let i=0;i<samples;i++) {
    const c=process.cpuUsage(), t=performance.now();
    example=fn();runs.push(performance.now()-t);
    const u=process.cpuUsage(c);cpu.push((u.user+u.system)/1000);
  }
  const sorted=runs.toSorted((a,b)=>a-b), cpuSorted=cpu.toSorted((a,b)=>a-b);
  const p=(a,n)=>+a[Math.ceil(a.length*n)-1].toFixed(3);
  return {name,samples,p50_ms:p(sorted,0.5),p95_ms:p(sorted,0.95),cpu_p50_ms:p(cpuSorted,0.5),example};
}
const base=clone(fixture.train[0]), scope=fixture.scope;
const train=Array.from({length:300},(_,i)=>({...clone(base),id:`train-${i}`,lineage:`raw-train-${i}`,sourceDigest:`sha256:${i}`}));
const heldout=Array.from({length:100},(_,i)=>({...clone(base),id:`test-${i}`,lineage:`raw-test-${i}`,sourceDigest:`sha256:h${i}`}));
const holdout=measure('heldout_lineage_300_train_100_validation',()=>qualifyHoldout({train,heldout,expectedScope:scope}));
const observations=Array.from({length:120},(_,i)=>({scope,session:`session-${i}`,lineage:`raw-${i}`,window:10+i%3,
  candidate:i%2?'.candidate':'.prior',outcome:i%2?'present':'absent',coverage:'complete',sourceQualified:true,coreAccepted:true}));
const drift=measure('drift_120_qualified_votes',()=>assessDrift({scope,incumbent:'.prior',proposal:'.candidate',observations}));
const binding=fixture.binding;
const events=['intent','dispatch','delivery'].map((type,i)=>({...binding,type,seq:i+1}));
const effect=measure('intent_trace_1000_reviews',()=>{let result;for(let i=0;i<1000;i++)result=auditEffectTrace({binding,events});return result;});
const provenance=measure('provenance_1000_reviewed_qualifications',()=>{let r;for(let i=0;i<1000;i++)r=qualifyProvenance({acceptance:fixture.acceptance,validatedByCore:true,source:fixture.source,expectedScope:scope,refs:fixture.refs});return r;});
const STREAMS=32, EVENTS=20000, text='a'.repeat(16384), sk=scopeKey(scope);
const stream=measure('long_stream_20000_updates_32_streams',()=>{
  const p=createBoundedProjection({maxStreams:STREAMS,maxChars:4096});
  for(let i=0;i<EVENTS;i++)p.offer({scopeKey:sk,streamId:`stream-${i%STREAMS}`,revision:Math.floor(i/STREAMS),text});
  const s=p.snapshot();return {rawUpdates:EVENTS,projectionItems:s.streams.length,
    retainedChars:s.streams.reduce((a,x)=>a+x.text.length,0),
    naiveEventTextChars:EVENTS*text.length,declaredUiGaps:s.metrics.uiGaps,cap:s.cap};
},9);
const races=exploreAdmissionSchedules();
const output={races,schema:'aion.systems-s1-bench/1',env,measurements:[holdout,drift,effect,provenance,stream],
  note:'Synthetic isolated probe speed, not Studio end-to-end throughput. UI preview truncations are explicit and raw log unaffected. Hardware and load determine timings.'};
console.log(JSON.stringify(output,null,2));
