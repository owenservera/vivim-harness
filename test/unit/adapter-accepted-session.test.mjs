import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptedSessionToAdapterEvents, domEvidenceRef } from '../../src/studio/adapter-accepted-session.mjs';
import { intakeEvents } from '../../src/studio/adapter-evidence-intake.mjs';
const scope = {siteId:'webapp-x',origin:'https://webapp-x.test',accountRef:'acct-1',surface:'chat'};
const raw = 'a'.repeat(64), digest = 'b'.repeat(64);
function verified() {
  const turns = [{role:'user',roleAttribute:'data-role',domId:'div.user',text:'PRIVATE_INPUT'},
    {role:'assistant',roleAttribute:'data-role',domId:'div.assistant',text:'PRIVATE_REPLY'}];
  const session = {id:'session-a',meta:{site:'webapp-x',target:{url:'https://webapp-x.test/chat'}},
    kv:{get:key=>key==='DOM_TURNS'?turns:null}};
  const acceptance = {schema:'capture-studio.acceptance/1',verdict:'capture_accepted',
    gates:Object.fromEntries(['G1','G2','G3','G4','G5','G6','G7'].map(k=>[k,{value:'passed'}])),
    binding:{rawDigest:raw,domDigest:digest,seqRange:[1,22],recipe:{id:'clean-data-gate',version:1}}};
  return {session,acceptance,rawDigest:raw,domDigest:digest};
}
test('accepted DOM projection retains cryptographic source provenance without text or DOM handles', async () => {
  const events = acceptedSessionToAdapterEvents({scope, verified: verified()});
  const x=events[0];
  assert.equal(x.observations.length,2);
  assert.equal(x.observations[1].feature,'assistant-turn');
  assert.equal(x.observations[1].identityVerdict,'verified');
  assert.equal(x.source.evidenceRef,domEvidenceRef('session-a',digest));
  assert.equal(x.source.provenance.domDigest,digest);
  assert.equal(x.source.sequence,22);
  assert.equal(x.source.accountBinding,'caller-scoped-unverified');
  assert.doesNotMatch(JSON.stringify(x),/PRIVATE|div\\.assistant|div\\.user/);
  const result=await intakeEvents(events,{verifyCapture:async()=>true});
  assert.deepEqual(result.probes.map(p=>p.feature).sort(),['assistant-turn','user-turn']);
  assert.ok(result.receipts.every(r=>r.domDigest===digest&&r.sequence===22&&r.evidenceRef===x.source.evidenceRef));
});
test('unbound shapes, guessed routes, and suffix-match selectors are not promoted to DOM evidence', () => {
  const v=verified();
  v.session.kv.get=key=>key==='DOM_TURNS'?
    [{role:'assistant',roleAttribute:'class',domId:'div',text:'SECRET'},
     {role:'assistant',roleAttribute:'data-role',roleMatch:'prefix',domId:'div',text:'SECRET'}]:
    {routes:[{verifiedNativeRef:true}],streamComponents:[{path:'$.secret'}]};
  assert.equal(acceptedSessionToAdapterEvents({scope,verified:v})[0].observations.length,0);
});
test('Core acceptance, digest, origin and site mismatches all fail closed', () => {
  const v=verified();v.acceptance.gates.G7.value='failed';
  assert.throws(()=>acceptedSessionToAdapterEvents({scope,verified:v}),/SESSION_NOT_CORE_ACCEPTED/);
  const d=verified();d.domDigest='c'.repeat(64);
  assert.throws(()=>acceptedSessionToAdapterEvents({scope,verified:d}),/SESSION_NOT_CORE_ACCEPTED/);
  assert.throws(()=>acceptedSessionToAdapterEvents({scope:{...scope,origin:'https://other.test'},verified:verified()}),/SESSION_SCOPE_MISMATCH/);
  assert.throws(()=>acceptedSessionToAdapterEvents({scope:{...scope,siteId:'other'},verified:verified()}),/SESSION_SCOPE_MISMATCH/);
});
test('duplicate roles collapse to one provenance-qualified vote and missing DOM handles abstain', () => {
  const v=verified();
  v.session.kv.get=()=>[{role:'assistant',roleAttribute:'data-role',domId:'a'},
    {role:'assistant',roleAttribute:'data-role',domId:'b'},
    {role:'user',roleAttribute:'data-role'}];
  const obs=acceptedSessionToAdapterEvents({scope,verified:v})[0].observations;
  assert.equal(obs.length,1);
  assert.equal(obs[0].feature,'assistant-turn');
});

test('actual suffix-match role attribute flows through capture-to-signals and existing selectorForRole', async () => {
  const v=verified();
  v.session.kv.get=()=>[{role:'assistant',roleAttribute:'data-content-search-unit-key',
    roleMatch:'suffix',domId:'div[role=assistant]',text:'PRIVATE_SUFFIX'}];
  const events=acceptedSessionToAdapterEvents({scope,verified:v});
  assert.equal(events[0].observations[0].roleMatch,'suffix');
  const out=await intakeEvents(events,{verifyCapture:async()=>true});
  assert.equal(out.probes[0].candidate,'[data-content-search-unit-key$="assistant"]');
  assert.equal(out.probes[0].outcome,'present');
  assert.ok(!JSON.stringify(out).includes('PRIVATE_SUFFIX'));
  assert.ok(!JSON.stringify(out).includes('div[role'));
});
