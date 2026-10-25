// UI-only integration contracts: shared selection, historical time and auth handling.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext, Script } from 'node:vm';

const html = readFileSync(new URL('../../src/studio/ui/index.html', import.meta.url), 'utf8');
const script = html.split('<script>')[1]?.split('</script>')[0] ?? '';
const start = script.indexOf('function updateInvestigationTrail()');
const end = script.indexOf('/* ---------------- layer strip', start);
const escape = script.split('\n').find((l) => l.startsWith('const esc = '));

function fixture() {
  const nodes = new Map(), S = { view:'knowledge', sessionId:'s1', sid:'stream1', sessions:[{id:'s1'},{id:'s2'}],
    knowledge:{sessionId:'s1'}, sessionRequestSeq:0, continuityRequestSeq:0, knowledgeRequestSeq:0,
    knowledgeDetailSeq:0, searchRequestSeq:0, historicalAsOfLocal:'', workflowStep:'' };
  const $ = (id) => { if (!nodes.has(id)) nodes.set(id,{value:'',innerHTML:'',textContent:'',onclick:null}); return nodes.get(id); };
  $('#knowledgeSession').value='s1'; $('#searchScope').value='selected';
  const code = escape + '\n' + script.slice(start,end) + '\n({selectSessionContext,updateHistoricalContext})';
  const out = runInNewContext(code, {$,S,src:()=>S.sessionId ? {kind:'session',id:S.sessionId} : null,
    knowledgeFallback:(v)=>'<div>'+v+'</div>',renderSessions:()=>{},guard:(fn)=>fn},{timeout:1500});
  return {...out,S,$};
}

test('entire integrated Studio inline script remains valid JavaScript', () => assert.doesNotThrow(()=>new Script(script)));

test('one recording selection drives breadcrumb, knowledge, and scoped Search', () => {
  const h=fixture();
  h.selectSessionContext('s2');
  assert.equal(h.S.sessionId,'s2');
  assert.equal(h.$('#knowledgeSession').value,'s2');
  assert.equal(h.S.sid,null);
  assert.equal(h.S.knowledge,null);
  assert.equal(h.S.sessionRequestSeq,1);
  assert.equal(h.S.knowledgeRequestSeq,1);
  assert.match(h.$('#hits tbody').innerHTML,/Recording changed/);
  assert.match(h.$('#srcNote').textContent,/s2/);
});

test('clearing a recording selection cannot silently reuse the previous one', () => {
  const h=fixture();
  h.selectSessionContext(null);
  assert.equal(h.S.sessionId,null);
  assert.equal(h.$('#knowledgeSession').value,'');
  assert.match(h.$('#sessionDetail').innerHTML,/No saved recording selected/);
  assert.match(script,/function knowledgeSessionId\(\) \{ return \$\('#knowledgeSession'\).value \|\| ''; \}/);
});

test('same recording selection does not invalidate in-flight requests', () => {
  const h=fixture(); h.selectSessionContext('s1');
  assert.equal(h.S.sessionRequestSeq,0);
  assert.equal(h.S.knowledgeRequestSeq,0);
});

test('as-of time syncs across history and knowledge and invalidates prior observations', () => {
  const h=fixture();
  h.updateHistoricalContext('2026-10-20T12:30');
  assert.equal(h.S.historicalAsOfLocal,'2026-10-20T12:30');
  assert.equal(h.$('#continuityAsOf').value,'2026-10-20T12:30');
  assert.equal(h.$('#knowledgeAt').value,'2026-10-20T12:30');
  assert.equal(h.S.knowledge,null);
  assert.match(h.$('#knowledgeState').textContent,/Historical time changed/);
});

test('recording context changes before new session-request epoch is captured', () => {
  assert.match(script,/async function openSession\(id\) \{\s*selectSessionContext\(id\);\s*const requestSeq = \+\+S\.sessionRequestSeq/);
});

test('401 gives local-mode-aware recovery, cleared after successful read', async () => {
  const S={authExpired:false}, map=new Map();
  const $=(id)=>{if(!map.has(id))map.set(id,{textContent:''});return map.get(id);};
  let response={ok:false,status:401,statusText:'Unauthorized',json:async()=>({error:'Unauthorized'})};
  const fetch=async()=>response;
  const code=script.slice(script.indexOf('async function api('),script.indexOf('function toast('))+'\napi';
  const api=runInNewContext(code,{S,$,fetch},{timeout:1500});
  await assert.rejects(api('sessions/s1/model'),(e)=>e.status===401);
  assert.match($('#connectionNote').textContent,/Local mode needs no token/);
  response={ok:true,status:200,json:async()=>({status:'complete'})};
  assert.equal((await api('sessions/s1/knowledge-status')).status,'complete');
  assert.equal(S.authExpired,false);
  assert.equal($('#connectionNote').textContent,'');
});
