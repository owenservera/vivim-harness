import test from 'node:test';
import assert from 'node:assert/strict';
import {captureToAdapterEvents} from '../../src/studio/adapter-capture-to-signals.mjs';
import {intakeEvents} from '../../src/studio/adapter-evidence-intake.mjs';
const scope={siteId:'never-registered',origin:'https://never.example',accountRef:'acct-a',surface:'chat'};
const cap={scope,source:{captureId:'cap-1',sessionId:'session-1',sequence:1,rawDigest:'a'.repeat(64),origin:scope.origin,accountRef:scope.accountRef,carrier:'dom',coverage:'complete',evidenceClass:'SYNTHETIC_TEST',evidenceRef:'dom-1'},dom:[
 {attributes:{'data-actor':'assistant','data-testid':'msg-assistant',innerText:'SECRET'},outcome:'present',identity:{verified:true,role:'assistant',ref:'role-1',evidenceRef:'dom-1'}},
 {attributes:{'data-actor':'user','data-testid':'msg-user'},outcome:'present',identity:{verified:true,role:'user',ref:'role-2',evidenceRef:'dom-1'}}]};
test('never-registered host derives assistant/user from structural DOM without provider code',async()=>{const events=captureToAdapterEvents([cap]);const probes=await intakeEvents(events,{verifyCapture:async()=>true});assert.deepEqual(probes.probes.map(p=>p.feature),['assistant-turn','user-turn']);assert.equal(probes.probes.every(x=>x.outcome==='present'),true);assert.ok(!JSON.stringify(probes).includes('SECRET'))});
test('unverified inferred DOM roles remain unknown',async()=>{const x=structuredClone(cap);x.dom[0].identity.verified=false;const y=await intakeEvents(captureToAdapterEvents([x]),{verifyCapture:async()=>true});assert.equal(y.probes[0].outcome,'unknown')});
test('wrong identity source cannot qualify a role',async()=>{const x=structuredClone(cap);x.dom[0].identity.evidenceRef='different';const y=await intakeEvents(captureToAdapterEvents([x]),{verifyCapture:async()=>true});assert.equal(y.probes[0].outcome,'unknown')});
test('unknown site never exposes raw content as a selector',()=>{const x=captureToAdapterEvents([cap]);assert.ok(!JSON.stringify(x).includes('SECRET'))});
test('missing stable attribute skips node rather than learning text',()=>{const x=structuredClone(cap);x.dom=[{text:'hidden thought',a11yRole:'article'}];assert.equal(captureToAdapterEvents([x])[0].observations.length,0)});
test('schema-only structural suggestions are not semantic role proof',()=>{const x=structuredClone(cap);x.dom=[];x.intelligence={streamComponents:[{path:'$.parts[*].kind',sourceKind:'CORE_DECODED',outcome:'present',evidenceRef:'wrong'}]};assert.equal(captureToAdapterEvents([x])[0].observations.length,0)});
