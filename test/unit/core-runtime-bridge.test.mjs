import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveAttachment,capabilityTruth,effectBoundary,reconcileLifecycle} from '../../src/studio/core-runtime-bridge.mjs';
import {scenario,exercise} from './fixtures/offline-fixture.mjs';
const clone=x=>structuredClone(x);
const base=()=>scenario();
const life=(s,other={})=>reconcileLifecycle({run:s.run,stepKey:'step-1',journal:s.journal,binding:s.binding,
  baseline:s.before,origin:s.origin,attachment:s.attachment,reconcileUncertainStep:s.reconcile,
  capture:s.capture,acceptance:s.acceptance,goal:s.goal,...other});
const denied=(s,more={})=>effectBoundary({attachment:s.attachment,capability:s.sendCapability,
  tool:'submit_conversation_turn',requestedEffect:'submit',...more});
test('unknown provider is data-only read adapter with native opaque identity',()=>{
 const s=base(),x=exercise();assert.equal(s.attachment.identity.conversation.nativeRef,'opaque-thread:fixture');
 assert.equal(x.read.availability,'supported');assert.equal(x.read.tier,'page-observed');
 assert.equal(x.effectBoundary.decision,'deny');assert.equal(x.lifecycle.readOnly,true);
});
test('registered ChatGPT semantics retain route key without assuming a second browser actor',()=>{
 const x=exercise('chatgpt',true);assert.equal(x.attachment.identity.conversation.nativeRef,'chatgpt-c:12345678-1234-1234-1234-123456789abc');
 assert.equal(x.lifecycle.delivery.state,'observed');assert.equal(x.lifecycle.userGoal.state,'unknown');
});
test('browser target and native conversation identity remain different',()=>{
 const s=base();assert.notEqual(s.attachment.attachment.targetId,s.attachment.identity.conversation.nativeRef);
});
test('native identity missing => explicit unverified, not title or text',()=>{
 const s=base();const a=resolveAttachment({adapter:s.adapter,page:{...s.page,title:'Same Chat'},resolved:{}});
 assert.equal(a.identity.conversation.state,'unverified');assert.equal(a.identity.task.state,'unverified');
});
test('untrusted title/position cannot become identity',()=>{
 const s=base();const resolved={conversation:{kind:'conversation',nativeRef:'some-id',origin:s.origin,verified:true,
 source:{kind:'title',captureRef:s.page.captureRef,sequence:10,reference:'title',evidenceClass:'synthetic-fixture'}}};
 assert.equal(resolveAttachment({adapter:s.adapter,page:s.page,resolved}).identity.conversation.state,'unverified');
});
test('unverified resolver capture and stale sequence do not bind',()=>{
 const s=base();for(const change of [{captureRef:'wrong'},{sequence:9},{evidenceClass:'unknown'}]){
 const native={kind:'conversation',nativeRef:'id',origin:s.origin,verified:true,source:{...s.attachment.identity.conversation.source,...change}};
 assert.equal(resolveAttachment({adapter:s.adapter,page:s.page,resolved:{conversation:native}}).identity.conversation.state,'unverified');}
});
test('wrong page origin and mismatched provider site refuse attachment',()=>{
 const s=base();assert.throws(()=>resolveAttachment({adapter:s.adapter,page:{...s.page,url:'https://evil.example/chat'},resolved:{}}),/TARGET_SCOPE_MISMATCH/);
 assert.throws(()=>resolveAttachment({adapter:s.adapter,page:{...s.page,siteId:'other'},resolved:{}}),/TARGET_SCOPE_MISMATCH/);
});
test('http and origin path cannot masquerade as canonical origin',()=>{
 const s=base();assert.throws(()=>resolveAttachment({adapter:{...s.adapter,origin:'http://lab.example'},page:s.page}),/INVALID_CANONICAL_ORIGIN/);
});
test('static hint cannot become page truth or send capability',()=>{
 const s=base();assert.equal(s.sendCapability.availability,'unverified');assert.equal(s.sendCapability.tier,'static-hint');
 assert.equal(denied(s).dispatch,false);
});
test('wrong target and stale page probe cannot elevate capability',()=>{
 const s=base();for (const probe of [{targetId:'wrong',sequence:11},{targetId:s.page.targetId,sequence:9}]){
 const c=capabilityTruth({attachment:s.attachment,feature:'send-control',staticHint:true,pageProbe:{source:'studio-page-observation',reference:'probe',state:'available',origin:s.origin,captureRef:s.page.captureRef,...probe}});
 assert.equal(c.availability,'unverified');}
});
test('verified-action tier never returns send permission',()=>{
 const s=base();const c=capabilityTruth({attachment:s.attachment,feature:'send-control',staticHint:true,pageProbe:{state:'available',targetId:s.page.targetId,origin:s.origin,captureRef:s.page.captureRef,sequence:11,source:'studio-page-observation',reference:'probe'},ownerEffectProof:{state:'effect-observed',source:'studio-effect-owner',feature:'send-control',targetId:s.page.targetId,captureRef:s.page.captureRef,sequence:12,reference:'owner'}});
 assert.equal(c.tier,'verified-action');assert.equal(c.sendAuthorized,false);
});
test('unsupported feature and unknown tool are denied',()=>{
 const s=base();assert.equal(denied(s,{requestedEffect:'delete'}).reason,'UNKNOWN_EFFECT');
 assert.equal(denied(s,{tool:'some_new_tool'}).reason,'UNREGISTERED_EFFECT_TOOL');
});
test('learned read-only adapter cannot pass effect boundary even with asserted positive gates',()=>{
 const s=base(), c=capabilityTruth({attachment:s.attachment,feature:'send-control',pageProbe:{state:'available',targetId:s.page.targetId,origin:s.origin,captureRef:s.page.captureRef,sequence:11,source:'studio-page-observation',reference:'probe'}});
 assert.equal(denied(s,{capability:c}).reason,'LEARNED_ADAPTER_NOT_EFFECT_AUTHORITY');
});
test('seed adapter clean advisory prerequisites defer but never dispatch',()=>{
 const s=scenario('chatgpt',true), c=capabilityTruth({attachment:s.attachment,feature:'send-control',pageProbe:{state:'available',targetId:s.page.targetId,origin:s.origin,captureRef:s.page.captureRef,sequence:11,source:'studio-page-observation',reference:'probe'}});
 const result=denied(s,{capability:c,owner:{id:'capture-studio',effectExecutor:'existing-conversation-runtime'},lease:{owner:'capture-studio',targetId:s.page.targetId,state:'held'},journal:{admitted:true,status:'pre-dispatch',intentBindingRef:'binding-1'},preflight:{state:'fresh',targetId:s.page.targetId,origin:s.origin,sequence:12,conversationRef:s.attachment.identity.conversation.nativeRef}});
 assert.equal(result.decision,'defer-to-studio');assert.equal(result.dispatch,false);assert.equal(result.retryAuthorized,false);
});
test('unsafe missing lease, stale preflight or missing binding denies',()=>{
 const s=scenario('chatgpt',true),c=capabilityTruth({attachment:s.attachment,feature:'send-control',pageProbe:{state:'available',targetId:s.page.targetId,origin:s.origin,captureRef:s.page.captureRef,sequence:11,source:'studio-page-observation',reference:'probe'}});
 const common={capability:c,owner:{id:'capture-studio',effectExecutor:'existing-conversation-runtime'},lease:{owner:'capture-studio',targetId:s.page.targetId,state:'held'},journal:{admitted:true,status:'pre-dispatch',intentBindingRef:'binding-1'},preflight:{state:'fresh',targetId:s.page.targetId,origin:s.origin,sequence:12,conversationRef:s.attachment.identity.conversation.nativeRef}};
 assert.equal(denied(s,{...common,lease:null}).decision,'deny');assert.equal(denied(s,{...common,preflight:{...common.preflight,sequence:8}}).decision,'deny');
 assert.equal(denied(s,{...common,journal:{...common.journal,admitted:false}}).decision,'deny');
});
test('complete synthetic lifecycle holds evidence acceptance and goal at unknown',()=>{
 const s=base(),r=life(s);for(const key of ['delivery','replyAttribution','networkTerminal','captureFinalized'])assert.equal(r[key].state,'observed',key);
 assert.equal(r.acceptedEvidence.state,'unknown');assert.equal(r.userGoal.state,'unknown');
 assert.equal(r.effect.verdict,'executed');assert.equal(r.dispatched,false);
});
test('missing durable binding fails closed',()=>{
 const s=base();assert.equal(life(s,{binding:null}).delivery.state,'unknown');
});
test('wrong run/key/tool/digest blocks journal linkage',()=>{
 const s=base();for(const field of ['runId','stepKey','stepTool','argsDigest']){
 const b={...s.binding,[field]:'altered'};assert.equal(life(s,{binding:b}).delivery.state,'unknown',field);}
});
test('wrong journal thread, payload or conversation rejects linkage',()=>{
 const s=base();assert.equal(life(s,{journal:{...s.journal,threadKey:'foreign'}}).delivery.state,'unknown');
 const j=clone(s.journal);j.turns[0].conversationId='other';assert.equal(life(s,{journal:j}).delivery.state,'unknown');
});
test('wrong origin and target or incorrect pre-send baseline abstains',()=>{
 const s=base();assert.equal(life(s,{origin:'https://other.example'}).delivery.state,'unknown');
 assert.equal(life(s,{baseline:{...s.before,targetId:'foreign'}}).delivery.state,'unknown');
 assert.equal(life(s,{baseline:{...s.before,sequence:99}}).delivery.state,'unknown');
});
test('reused old assistant identity refuses reply attribution',()=>{
 const s=base();const j=clone(s.journal);j.turns[0].reply.evidence.identity='reply-old';
 assert.equal(life(s,{journal:j}).replyAttribution.state,'unknown');
});
test('reply already attributed to another turn refuses duplicate',()=>{
 const s=base();const j=clone(s.journal);j.turns.push({reply:{evidence:{identity:'reply-new'}}});
 assert.equal(life(s,{journal:j}).replyAttribution.state,'unknown');
});
test('stale reply sequence cannot be presented as fresh',()=>{
 const s=base(),j=clone(s.journal);j.turns[0].reply.evidence.sequence=11;
 assert.equal(life(s,{journal:j}).replyAttribution.state,'unknown');
});
test('unresolved crash/contradictory reconciliation never elevates delivery or authorizes retry',()=>{
 const s=base();const x=life(s,{reconcileUncertainStep:()=>({verdict:'still_unknown',reason:'CONTRADICTORY_JOURNAL_PROOFS'})});
 assert.equal(x.delivery.state,'unknown');assert.equal(x.effect.retryAuthorized,false);
});
test('network terminal != reply attribution != capture finalized',()=>{
 const s=base(),j=clone(s.journal);j.turns[0].completion.state='unknown';j.turns[0].completion.evidence=null;
 let x=life(s,{journal:j,capture:null});assert.equal(x.replyAttribution.state,'observed');assert.equal(x.networkTerminal.state,'unknown');
 assert.equal(x.captureFinalized.state,'unknown');
});
test('G1-G7 require the verifier and all seven, not user self-report',()=>{
 const s=base();let a=clone(s.acceptance);a.gates.G4.state='unknown';assert.equal(life(s,{acceptance:a}).acceptedEvidence.state,'unknown');
 a=clone(s.acceptance);a.integrity='claimed';assert.equal(life(s,{acceptance:a}).acceptedEvidence.state,'unknown');
});
test('goal remains unknown despite seven accepted gates unless separately verified',()=>{
 const s=base();s.acceptance.evidenceClass='SAVED_REAL_CAPTURE';const x=life(s,{goal:null});assert.equal(x.acceptedEvidence.state,'observed');assert.equal(x.userGoal.state,'unknown');
});
test('no implicit execution or browser ownership in any exported module',()=>{
 const s=base();assert.equal(effectBoundary({attachment:s.attachment,capability:s.readCapability,requestedEffect:'read'}).dispatch,false);
 assert.equal(life(s).readOnly,true);
});

test('real classified acceptance still needs independently verified goal class',()=>{
 const s=base();s.acceptance.evidenceClass='SAVED_REAL_CAPTURE';let x=life(s);
 assert.equal(x.acceptedEvidence.state,'observed');assert.equal(x.userGoal.state,'unknown');
 s.goal.evidenceClass='SAVED_REAL_CAPTURE';x=life(s);assert.equal(x.userGoal.state,'observed');
});

test('capability from another attachment cannot be borrowed to send',()=>{
 const s=scenario('chatgpt',true), other=scenario('chatgpt',true);
 const capability=capabilityTruth({attachment:other.attachment,feature:'send-control',pageProbe:{state:'available',targetId:other.page.targetId,origin:other.origin,captureRef:other.page.captureRef,sequence:11,source:'studio-page-observation',reference:'probe'}});
 const foreign={...capability,scope:{...capability.scope,captureRef:'another-session'}};
 assert.equal(denied(s,{capability:foreign}).reason,'CAPABILITY_SCOPE_MISMATCH');
});
test('task/branch/generation identities also require exact fresh preflight',()=>{
 const s=scenario('chatgpt',true), c=capabilityTruth({attachment:s.attachment,feature:'send-control',pageProbe:{state:'available',targetId:s.page.targetId,origin:s.origin,captureRef:s.page.captureRef,sequence:11,source:'studio-page-observation',reference:'probe'}});
 const attachment={...s.attachment,identity:{...s.attachment.identity,task:{state:'bound',nativeRef:'task-native-1'},branch:{state:'bound',nativeRef:'branch-native-1'},generation:{state:'bound',nativeRef:'gen-native-1'}}};
 const common={attachment,capability:c,tool:'submit_conversation_turn',requestedEffect:'submit',owner:{id:'capture-studio',effectExecutor:'existing-conversation-runtime'},lease:{owner:'capture-studio',targetId:s.page.targetId,state:'held'},journal:{admitted:true,status:'pre-dispatch',intentBindingRef:'binding'},preflight:{state:'fresh',targetId:s.page.targetId,origin:s.origin,sequence:12,conversationRef:s.attachment.identity.conversation.nativeRef,taskRef:'task-native-1',branchRef:'branch-native-1',generationRef:'gen-native-1'}};
 assert.equal(effectBoundary(common).decision,'defer-to-studio');
 assert.equal(effectBoundary({...common,preflight:{...common.preflight,generationRef:'wrong'}}).reason,'PREFLIGHT_NATIVE_IDENTITY_MISMATCH');
 assert.equal(effectBoundary({...common,preflight:{...common.preflight,taskRef:null}}).reason,'PREFLIGHT_NATIVE_IDENTITY_MISMATCH');
});

test('registered provider fixture route is the actual strict /c/ UUID specialization',()=>{
 const s=scenario('chatgpt',true);assert.equal(new URL(s.page.url).pathname,'/c/12345678-1234-1234-1234-123456789abc');
});
