// Sprint 2 UI recovery regression contracts; no website sends or browser automation.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext, Script} from 'node:vm';

const chat=readFileSync(new URL('../../src/studio/ui/chat.mjs',import.meta.url),'utf8');
const drive=readFileSync(new URL('../../src/studio/ui/drive.mjs',import.meta.url),'utf8');
const studio=readFileSync(new URL('../../src/studio/ui/index.html',import.meta.url),'utf8');

function between(s,first,last) {
  const a=s.indexOf(first), b=s.indexOf(last,a);
  assert.ok(a>=0&&b>a,'required UI function boundary absent: '+first);
  return s.slice(a,b);
}
function deferred() {
  let resolve,reject;
  const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});
  return {promise,resolve,reject};
}
function chatSelectionFixture() {
  const S={snap:{id:'original'},openSeq:0,failures:0},events=[],d=new Map();
  const save={del:(scope,key)=>events.push(['deleted',scope,key])};
  const ctx={S,api:(url)=>{const id=decodeURIComponent(url.split('/').pop());return d.get(id)?.promise??Promise.reject(new Error('No fixture '+id));},
    unwrapConversation:(x)=>x,unreadable:()=>new Error('Malformed'),store:save,SELECTED_KEY:'selected',
    applySnapshot:(c)=>{S.snap=c;events.push(['applied',c.id]);},showProblem:(msg)=>events.push(['message',msg]),
    stopPolling:()=>events.push(['stop']),closeStream:()=>events.push(['stream','close']),render:()=>events.push(['render']),describe:(e)=>e.message};
  const code=between(chat,'  async function openConversation(id) {','  /* ---- connect ---- */');
  const {openConversation}=runInNewContext(code+'\n({openConversation})',ctx,{timeout:1000});
  return {S,events,d,openConversation};
}
function driveSelectionFixture() {
  const S={job:null,jobs:[],jobRequestSeq:0,failures:0,progressSig:''},calls=[],d=new Map();
  const nodes=new Map(),$=id=>{if(!nodes.has(id))nodes.set(id,{textContent:'',hidden:true});return nodes.get(id)};
  const ctx={S,$,ACTIVE:new Set(['queued','running']),
    api:(url)=>{const id=decodeURIComponent(url.split('/').pop());return d.get(id)?.promise??Promise.reject(new Error('No job '+id));},
    stopPolling:()=>calls.push('stop'),renderJob:j=>calls.push('render:'+j.id),renderJobs:()=>calls.push('jobs'),
    updateControls:()=>calls.push('controls'),startPolling:id=>calls.push('poll:'+id),
    refreshAfterEnd:()=>calls.push('refresh'),describe:e=>e.message};
  const code=between(drive,'function showJob(job) {','function stopPolling() {');
  const {openJob}=runInNewContext(code+'\n({openJob})',ctx,{timeout:1000});
  return {S,calls,d,$,openJob};
}
function chatSendFixture() {
  const S={snap:{id:'old',revision:2},pending:null,submitting:false,checkedNote:'',unknownDetail:'',sentPrompt:''};
  const sent=[],writes=[],events=[],d=deferred(),nodes=new Map();
  const $=id=>{if(!nodes.has(id))nodes.set(id,{value:'hello',readOnly:false,focus:()=>{}});return nodes.get(id)};
  const store={set:(scope,key,value)=>writes.push(['set',scope,key,value]),del:(scope,key)=>writes.push(['del',scope,key])};
  const ctx={S,$,store,newKey:()=> 'attempt-old',canSend:()=>({ok:true}),savePending:()=>store.set('sessionStorage','chat.pending.'+S.pending.convId,S.pending.key),
    clearPending:()=>{const p=S.pending;if(p)store.del('sessionStorage','chat.pending.'+p.convId);S.pending=null;},
    render:()=>events.push('render'),renderComposer:()=>{},setError:(...a)=>events.push(['error',...a]),
    api:(path,opts)=>{sent.push({path,opts});return d.promise;},unwrapConversation:x=>x,
    stillOn:id=>S.snap?.id===id,applySnapshot:()=>events.push('apply'),isAmbiguous:e=>e.status===0,
    describe:e=>e.message,refresh:id=>events.push('refresh:'+id),sendRejection:e=>({text:e.message})};
  const code=between(chat,'  async function sendMessage() {','  // The user\'s own choice after an unknown outcome');
  const {sendMessage}=runInNewContext(code+'\n({sendMessage})',ctx,{timeout:1000});
  return {S,$,d,writes,events,sent,sendMessage};
}

test('Chat and Drive frontends compile independently without sending or connecting',()=>{
  assert.doesNotThrow(()=>new Script(chat.replace(/^export /gm,'')));
  assert.doesNotThrow(()=>new Script(drive));
});
test('Chat latest requested conversation wins out-of-order load responses',async()=>{
  const h=chatSelectionFixture();
  const first=deferred(),second=deferred();
  h.d.set('a',first);h.d.set('b',second);
  const a=h.openConversation('a'),b=h.openConversation('b');
  second.resolve({id:'b'});await b;
  first.resolve({id:'a'});await a;
  assert.equal(JSON.stringify(h.events.filter(x=>x[0]==='applied')),JSON.stringify([['applied','b']]));
  assert.equal(h.S.snap.id,'b');
});
test('Chat missing other conversation retains the actual current selection and warns',async()=>{
  const h=chatSelectionFixture(),missing=deferred();h.d.set('missing',missing);
  const run=h.openConversation('missing');missing.reject(Object.assign(new Error('not found'),{status:404}));await run;
  assert.equal(h.S.snap.id,'original');
  assert.equal(h.events.filter(x=>x[0]==='deleted').length,0);
  assert.match(h.events.find(x=>x[0]==='message')[1],/previously selected conversation remains visible/);
});
test('Chat missing current conversation clears the stale selection',async()=>{
  const h=chatSelectionFixture(),missing=deferred();h.d.set('original',missing);
  const run=h.openConversation('original');missing.reject(Object.assign(new Error('gone'),{status:404}));await run;
  assert.equal(h.S.snap,null);
  assert.ok(h.events.some(x=>x[0]==='deleted'&&x[2]==='selected'));
});
test('Chat starting new selection invalidates pending late selection reads',()=>{
  assert.match(chat,/function newConversation\(\) \{\s*\+\+S\.openSeq;/);
  assert.match(chat,/const stillOn = \(id\) => S\.snap\?\.id === id/);
});
test('late successful send updates only the original conversation, never the newly selected one',async()=>{
  const h=chatSendFixture(),old=h.sendMessage();
  h.S.snap={id:'new',revision:9};h.S.pending={convId:'new',key:'pending-new',prompt:'not sent'};
  h.S.sentPrompt='new selection';
  h.d.resolve({id:'old'});await old;
  assert.equal(h.S.pending.convId,'new');
  assert.equal(h.S.sentPrompt,'new selection');
  assert.ok(h.writes.some(x=>x[0]==='set'&&x[2]==='chat.sent.old'&&x[3]==='hello'));
  assert.ok(h.writes.some(x=>x[0]==='del'&&x[2]==='chat.pending.old'));
  assert.equal(h.events.includes('apply'),false);
  assert.equal(h.sent.length,1);
});
test('ambiguous late send cannot unlock or retry a different Chat conversation',async()=>{
  const h=chatSendFixture(),old=h.sendMessage();
  h.S.snap={id:'new',revision:9};h.S.pending={convId:'new',key:'pending-new'};
  h.d.reject(Object.assign(new Error('connection lost'),{status:0}));await old;
  assert.equal(h.S.pending.convId,'new');
  assert.ok(h.writes.some(x=>x[2]==='chat.pending.old'&&x[0]==='set'));
  assert.equal(h.events.some(x=>typeof x==='string'&&x.startsWith('refresh:')),false);
  assert.equal(h.sent.length,1);
});
test('Drive job selections reject late older result',async()=>{
  const h=driveSelectionFixture(),old=deferred(),newer=deferred();
  h.d.set('old',old);h.d.set('new',newer);
  const a=h.openJob('old'),b=h.openJob('new');
  newer.resolve({job:{id:'new',state:'done'}});await b;
  old.resolve({job:{id:'old',state:'running'}});await a;
  assert.equal(h.S.job.id,'new');
  assert.equal(h.calls.includes('render:old'),false);
});
test('Drive wrong job identity does not silently replace the selected job',async()=>{
  const h=driveSelectionFixture(),response=deferred();h.d.set('wanted',response);
  const pending=h.openJob('wanted');
  response.resolve({job:{id:'other',state:'done'}});await pending;
  assert.equal(h.S.job,null);
  assert.match(h.$('#jobEmpty').textContent,/different job/);
  assert.equal(h.calls.some(c=>c==='render:other'),false);
});
test('Drive stale failed request does not overwrite a newer selected job error area',async()=>{
  const h=driveSelectionFixture(),old=deferred(),newer=deferred();h.d.set('old',old);h.d.set('new',newer);
  const a=h.openJob('old'),b=h.openJob('new');
  newer.resolve({job:{id:'new',state:'done'}});await b;
  old.reject(new Error('network failure'));await a;
  assert.equal(h.S.job.id,'new');
  assert.doesNotMatch(h.$('#jobError').textContent,/network failure/);
});
test('Drive polling 404 does not imply the job stopped and no auto-run begins',()=>{
  assert.match(drive,/The last displayed state is stale; do not assume the job stopped/);
  assert.match(drive,/No new live run was started/);
  assert.match(drive,/function activeJobId\(\)/);
  assert.match(drive,/if \(ACTIVE\.has\(next\.state\)\) S\.stopRequested = next\.id;/);
});
test('Home, Chat and Drive use explicit authorization recovery and no automatic resend on missing status',()=>{
  assert.match(studio,/Local mode needs no token/);
  assert.match(chat,/Local mode needs no token/);
  assert.match(drive,/Local mode needs no token/);
  assert.match(chat,/const stillOn = \(id\) => S\.snap\?\.id === id/);
  assert.match(drive,/The last displayed state is stale/);
});


function driveLeaseFixture(data) {
  const S={mode:'drive',busy:false,job:null,jobs:[]},calls=[],dom=new Map();
  const $=id=>{if(!dom.has(id))dom.set(id,{checked:false,value:id==='#prompt'?'hello':'',textContent:'',
    replaceChildren(...children){this.children=children;this.textContent=children.map(x=>typeof x==='string'?x:x.text??'').join('');}});
    return dom.get(id);};
  const ctx={S,$,currentTargets:()=>({sites:['chatgpt']}),activeJobId:()=>null,updateControls:()=>{},numberField:()=>undefined,
    api:async(path,opts)=>{calls.push({path,opts});throw Object.assign(new Error('busy'),{status:409,data});},
    el:(tag,props)=>({tag,...props}),showJob:()=>{throw Error('Must never show unconfirmed job')},
    openJob:async(id)=>{calls.push({openJob:id});},describe:e=>e.message};
  const code=between(drive,'async function launch(dryRun) {','/* ---------------- job panel ---------------- */');
  const {launch}=runInNewContext(code+'\n({launch})',ctx,{timeout:1000});
  return {S,$,calls,launch};
}

test('Drive 409 Chat lease names its holder and links to Chat without retrying',async()=>{
  const h=driveLeaseFixture({holder:{kind:'conversation',id:'c1'}});
  await h.launch(false);
  assert.equal(h.calls.filter(x=>x.path).length,1);
  assert.equal(h.calls.some(x=>x.openJob),false);
  const error=h.$('#formError');
  assert.match(error.textContent,/Chat conversation holds the browser/);
  assert.equal(error.children[1].href,'/chat');
  assert.doesNotMatch(drive,/confirmLive/,'Live Drive uses only its explicit click, not a separate checkbox');
});
test('Drive 409 unknown lease holder does not claim another Drive job or auto-queue',async()=>{
  const h=driveLeaseFixture({holder:{kind:'unknown'}});
  await h.launch(false);
  assert.match(h.$('#formError').textContent,/owner could not be confirmed/);
  assert.doesNotMatch(h.$('#formError').textContent,/Another Drive job/);
  assert.equal(h.calls.filter(x=>x.path).length,1);
  assert.doesNotMatch(drive,/confirmLive/,'Live Drive uses only its explicit click, not a separate checkbox');
});
test('Home selected-recording change clears old Knowledge before any replacement is loaded',()=>{
  const script=studio.split('<script>')[1]?.split('</script>')[0]??'';
  const code=between(script,'function selectSessionContext(id) {','function updateHistoricalContext(value) {');
  const dom=new Map();
  const $=id=>{if(!dom.has(id))dom.set(id,{value:'',textContent:'old derived evidence',innerHTML:'<b>old derived evidence</b>'});return dom.get(id)};
  const S={sessionId:'old',sid:'sid',knowledge:{entities:[1]},sessions:[],sessionRequestSeq:0,continuityRequestSeq:0,
    knowledgeRequestSeq:0,knowledgeDetailSeq:0,searchRequestSeq:0};
  const {selectSessionContext}=runInNewContext(code+'\n({selectSessionContext})',
    {S,$,updateSrcNote:()=>{},renderSessions:()=>{},knowledgeFallback:x=>'<div>'+x+'</div>'},{timeout:1000});
  selectSessionContext('new');
  assert.equal(S.sessionId,'new');
  assert.equal(S.knowledge,null);
  for(const id of ['#knowledgeEntities','#knowledgeDetail','#knowledgeGraph','#knowledgeModel','#knowledgeDrift']) {
    assert.doesNotMatch($(id).innerHTML,/old derived evidence/);
    assert.match($(id).innerHTML,/Select a saved recording/);
  }
  assert.match($('#knowledgeState').textContent,/Recording changed/);
});
test('Home network failure distinguishes unreachable Studio from failed or accepted evidence',async()=>{
  const script=studio.split('<script>')[1]?.split('</script>')[0]??'';
  const code=between(script,'async function api(path, opts = {}) {','function toast(');
  const note={textContent:''},S={authExpired:false};
  const {api}=runInNewContext(code+'\n({api})',
    {S,$:()=>note,fetch:async()=>{throw new Error('offline')}},{timeout:1000});
  await assert.rejects(api('sessions'),e=>e.status===0&&/no request was automatically retried/.test(e.message));
  assert.match(note.textContent,/Previously loaded details may be stale/);
  assert.doesNotMatch(note.textContent,/Capture accepted|Verified/);
});
