// Synthetic, private-data-free, offline scenario. This script never opens a browser or sends.
import {resolveAttachment,capabilityTruth,effectBoundary,reconcileLifecycle} from '../../../src/studio/core-runtime-bridge.mjs';
const digest='a'.repeat(64), when='2026-10-24T14:00:00.000Z';
export const source=(captureRef, sequence=10)=>({kind:'native-route',captureRef,sequence,reference:`fixture:${captureRef}:${sequence}`,evidenceClass:'synthetic-fixture'});
export function scenario(siteId='unknown-lab', registered=false){
  const origin=registered?'https://chatgpt.com':'https://lab.example';
  const captureRef='fixture-session-1';
  const adapter={siteId,providerId:registered?'openai.chatgpt.web':'lab.unknown.web',origin,surface:'chat',version:'fixture-v1',kind:registered?'seed':'learned-read-only'};
  const page={targetId:'fixture-target-1',captureRef,sequence:10,observedAt:when,url:registered?`${origin}/c/12345678-1234-1234-1234-123456789abc`:`${origin}/chat/example`,origin,siteId,surface:'chat',account:{state:'unknown'}};
  const nativeRef=registered?'chatgpt-c:12345678-1234-1234-1234-123456789abc':'opaque-thread:fixture';
  const attachment=resolveAttachment({adapter,page,resolved:{conversation:{kind:'conversation',nativeRef,origin,verified:true,source:source(captureRef)}}});
  const readCapability=capabilityTruth({attachment,feature:'assistant-turn',staticHint:true,pageProbe:{state:'available',targetId:page.targetId,origin,captureRef,sequence:11,source:'studio-page-observation',reference:'probe:read'}});
  const sendCapability=capabilityTruth({attachment,feature:'send-control',staticHint:true});
  const before={origin,targetId:page.targetId,captureRef,sequence:10,conversationRef:nativeRef,assistantIdentities:['reply-old']};
  const run={schema:'capture-studio.harness-run/1',id:'run-1',conversationId:'local-conversation-1',steps:[{key:'step-1',tool:'submit_conversation_turn',argsDigest:digest,status:'uncertain'}]};
  const binding={source:'trusted-pre-effect',runId:run.id,stepKey:'step-1',stepTool:'submit_conversation_turn',argsDigest:digest,conversationId:run.conversationId,threadKey:`thread-${siteId}`,journalTurnKey:'turn-key-1',journalPayloadDigest:digest};
  const boundary={sessionId:captureRef,sequence:10,transcriptCount:2};
  const e=(sequence,identity,kind,from,extra={})=>({turnId:'turn-id-1',payloadDigest:digest,sessionId:captureRef,sequence,identity,kind,source:from,...extra});
  const turn={id:'turn-id-1',key:binding.journalTurnKey,payloadDigest:digest,conversationId:run.conversationId,boundary,
    delivery:{state:'observed',evidence:e(11,'outbound-1','outgoing-request','network')},
    reply:{state:'observed',evidence:e(12,'reply-new','assistant-reply','page',{revision:1,contentDigest:digest,chars:52})},
    completion:{state:'complete',evidence:e(13,'reply-new','reply-complete','network',{revision:1})}};
  const journal={version:2,threadKey:binding.threadKey,turns:[turn]};
  const reconcile=()=>({schema:'aion.harness-step-reconciliation/1',verdict:'executed',reason:'JOURNAL_CONFIRMS_DELIVERY',mutates:false,retryAuthorized:false});
  const capture={source:'studio-recorder',state:'finalized',reference:'capture:finalized',sessionId:captureRef,origin};
  const gates=Object.fromEntries(Array.from({length:7},(_,i)=>[`G${i+1}`,{state:'accepted',reference:`fixture:G${i+1}`} ]));
  const acceptance={source:'studio-acceptance-verifier',integrity:'verified',evidenceClass:'SYNTHETIC_TEST',gates,sessionId:captureRef,origin};
  const goal={source:'existing-outcome-verifier',state:'fulfilled',evidenceClass:'SYNTHETIC_TEST',reference:'fixture:goal',sessionId:captureRef};
  return {adapter,page,origin,attachment,readCapability,sendCapability,before,run,binding,journal,reconcile,capture,acceptance,goal};
}
export function exercise(siteId='unknown-lab',registered=false){
  const s=scenario(siteId,registered);
  return {schema:'aion.c1-offline-fixture/1',scenario:registered?'registered-seed':'unknown-learned',
    attachment:s.attachment,read:s.readCapability,
    effectBoundary:effectBoundary({attachment:s.attachment,capability:s.sendCapability,tool:'submit_conversation_turn',requestedEffect:'submit'}),
    lifecycle:reconcileLifecycle({run:s.run,stepKey:'step-1',journal:s.journal,binding:s.binding,baseline:s.before,
      origin:s.origin,attachment:s.attachment,reconcileUncertainStep:s.reconcile,capture:s.capture,acceptance:s.acceptance,goal:s.goal}),
    evidenceClass:'SYNTHETIC_TEST',liveAcceptance:false};
}
if(process.argv[1] && import.meta.url===new URL(`file://${process.argv[1]}`).href) console.log(JSON.stringify({unknown:exercise(),registered:exercise('chatgpt',true)},null,2));
