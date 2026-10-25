import test from 'node:test';import assert from 'node:assert/strict';
import {qualifyIndependentEvidence,projectForUniversalChat,createGuardedStudioLearner} from '../../src/studio/four-lane-gates.mjs';
const scope={siteId:'example',origin:'https://example.test',accountRef:'acct-1',surface:'chat'};
const mk=(id,lineage,digit)=>({id,lineage,scope:{siteId:scope.siteId,origin:scope.origin,account:scope.accountRef,surface:scope.surface},
 sourceDigest:digit.repeat(64),coverage:'complete',coreAccepted:true,sourceQualified:true});
const ev=m=>({scope,source:{sessionId:m.id,rawDigest:m.sourceDigest,coverage:'complete',origin:scope.origin,accountRef:scope.accountRef}});
const train=[mk('a','line-a','a'),mk('b','line-b','b'),mk('c','line-c','c')],hold=[mk('d','line-d','d'),mk('e','line-e','e')];
const check=(t=train,h=hold,x=t.map(ev),y=h.map(ev))=>qualifyIndependentEvidence({scope,training:x,heldout:y,trainManifest:t,heldoutManifest:h});
test('independent evidence is qualified for shadow only',()=>{const r=check();assert.equal(r.ok,true);assert.equal(r.sendPermission,false)});
test('remounted evidence lineage rejected',()=>assert.equal(check(train,[{...hold[0],lineage:'line-a'},hold[1]]).reason,'EVIDENCE_LINEAGE_REUSED'));
test('mismatched raw digest rejected',()=>{const h=hold.map(ev);h[0].source.rawDigest='f'.repeat(64);assert.equal(check(train,hold,train.map(ev),h).reason,'EVENT_MANIFEST_MISMATCH')});
test('missing heldout record rejected',()=>assert.equal(check(train,hold,train.map(ev),hold.slice(0,1).map(ev)).reason,'UNACCOUNTED_SOURCE_SESSION'));
test('cross-account evidence rejected',()=>assert.equal(check(train,[{...hold[0],scope:{...hold[0].scope,account:'foreign'}},hold[1]]).reason,'SCOPE_MISMATCH'));
test('unbound identity not displayed as bound or sent',()=>{const view=projectForUniversalChat({attachment:{adapter:{providerId:'site'},attachment:{targetId:'tab'},identity:{conversation:{state:'unverified'}},account:{state:'unverified'}},
 studioBinding:{source:'trusted-studio-conversation-owner',id:'aion-1',nativeConversationRef:'native-1'}});
 assert.equal(view.snapshot.identity.state,'unverified');assert.equal(view.snapshot.id,null);assert.equal(view.outcome.captureAccepted,false);assert.equal(view.sendPermission,false)});
test('verified native binding visible but still no effect grant',()=>{const v=projectForUniversalChat({attachment:{identity:{conversation:{state:'bound',nativeRef:'native-1'}}},
studioBinding:{source:'trusted-studio-conversation-owner',id:'studio-1',nativeConversationRef:'native-1'}});
 assert.equal(v.snapshot.id,'studio-1');assert.equal(v.sendPermission,false)});
test('no manifest provider prevents learning',()=>assert.throws(()=>createGuardedStudioLearner({}),/TRUSTED_CORE_MANIFEST_PROVIDER_REQUIRED/));
