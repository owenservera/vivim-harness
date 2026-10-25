// UI-only knowledge workspace contract tests; no browser driver or privileged local runtime.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Script, runInNewContext } from 'node:vm';

const html = readFileSync(new URL('../../src/studio/ui/index.html', import.meta.url), 'utf8');
const script = html.split('<script>')[1]?.split('</script>')[0] ?? '';
const begin = script.indexOf('/* ---------------- Knowledge workspace');
const end = script.indexOf('/* ---------------- profiles ---------------- */', begin);
const code = script.split('\n').find((line) => line.startsWith('const esc = ')) + '\n' + script.slice(begin, end);
const names = ['knowledgeSummary','knowledgeGraphMap','renderKnowledgeEntities','renderKnowledgeGraph','renderKnowledgeModel','renderKnowledgeDrift','openKnowledgeEntity','openKnowledgeNode','refreshKnowledge','knowledgeSourceLinks','wireKnowledgeSources','knowledgeOutcomeMarkup','knowledgeStatusPromise','openRecordedEvidence'];

function createHarness() {
  const dom = new Map(), S = { view:'knowledge', sessionId:'s1', knowledge:null, knowledgeRequestSeq:0, knowledgeDetailSeq:0 };
  let impl = async () => ({});
  let opened = '',streamOpened = '';
  function element(selector) {
    if (!dom.has(selector)) {
      const node = { value:'', textContent:'', innerHTML:'', hidden:false, isConnected:true, onclick:null,
        querySelectorAll(query) {
          const match = /button\[data-(ke|gn|drift|source)\]/.exec(query);
          if (!match) return [];
          const key = match[1], indices = [...this.innerHTML.matchAll(new RegExp('data-' + key + '="([0-9]+)"','g'))].map((m) => m[1]);
          if (!this._actions || this._actionsQuery !== query || this._actionsHtml !== this.innerHTML) {
            this._actions = indices.map((n) => ({ dataset:{ [key]:n }, onclick:null }));
            this._actionsHtml = this.innerHTML; this._actionsQuery = query;
          }
          return this._actions;
        }
      };
      dom.set(selector,node);
    }
    return dom.get(selector);
  }
  const ctx = { $:element, S, api:(url)=>impl(url), guard:(fn)=>fn,
    show:(v)=>{ S.view=v; }, openSession:async (id)=>{opened=id;},
    toast:()=>{}, openStream:async (sid)=>{streamOpened=sid;},
    selectSessionContext:(id)=>{if(id && S.sessionId!==id) {S.sessionId=id;S.knowledge=null;S.knowledgeRequestSeq++;}},
    updateHistoricalContext:(value)=>{S.historicalAsOfLocal=value;},
    updateInvestigationTrail:()=>{}, URLSearchParams };
  const out = runInNewContext(code + '\n({' + names.join(',') + '})', ctx, { timeout: 1500 });
  return { ...out, S, el:element, setApi:(fn)=>{impl=fn;}, opened:()=>opened,streamOpened:()=>streamOpened };
}

test('complete Studio script parses and Knowledge navigation exists', () => {
  assert.ok(begin > 0 && end > begin);
  assert.doesNotThrow(() => new Script(script));
  assert.match(html, /data-view="knowledge"/);
  assert.match(html, /id="v-knowledge"/);
  assert.match(script, /knowledge: loadKnowledge/);
  assert.match(script, /sessions\/' \+ encodeURIComponent\(id\) \+ '\/graph/);
  assert.match(script, /Promise\.allSettled/);
});

test('knowledge coverage distinguishes absent derivation, truncated entities, and drift omissions', () => {
  const h=createHarness();
  const out=h.knowledgeSummary({ stats:{ entitiesTotal:80, joinedEntities:5, sessionsDiscovered:8,
    sessionsWithDerivedKnowledge:6, sessionsWithoutKnowledge:['s7'], sessionsWithDerivationError:[{session:'s8'}],
    truncated:30,typeDriftHintsTruncated:2,typeDriftVariantsOmitted:3,
    sessionsSuccessfulEmpty:['s5'],sessionsLegacyUnverified:['s6'],legacyEidCollisions:2 }});
  assert.match(out, /2<\/b> incomplete/);
  assert.match(out, /incomplete evidence/);
  assert.match(out, /entities beyond this preview/);
  assert.match(out, /additional type-drift hints/);
  assert.match(out, /comparison variants not assessed/);
  assert.match(out,/1<\/b> successfully empty/);
  assert.match(out,/1<\/b> legacy-unverified/);
  assert.match(out,/2<\/b> legacy identity collisions isolated/);
});

test('entity list shows origin-matching caveat and escapes captured labels', () => {
  const h=createHarness();
  h.S.knowledge = { continuity:{entities:[{id:'origin::id',typeName:'<img src=x onerror=evil()>',key:'k',
    identityBasis:'exact-site-type-key',sessionCount:2,revisions:3}]} };
  h.renderKnowledgeEntities();
  const s=h.el('#knowledgeEntities').innerHTML;
  assert.match(s,/Linked by key/);
  assert.match(s,/not verified account/);
  assert.match(s,/&lt;img/);
  assert.doesNotMatch(s,/<img/);
});

test('graph preview is bounded, accessible, and treats dashed links as unconfirmed', () => {
  const h=createHarness();
  const graph={nodes:Array.from({length:24},(_,i)=>({eid:'e'+i,typeName:'Object',key:'<node '+i+'>'})),
    edges:[{from:'e0',to:'e1',status:'hypothesis'},{from:'e1',to:'e2',status:'confirmed'}]};
  const out=h.knowledgeGraphMap(graph);
  assert.match(out,/viewBox="0 0 800 360"/);
  assert.match(out,/role="img"/);
  assert.match(out,/stroke-dasharray=/);
  assert.match(out,/16 of 24/);
  assert.match(out,/&lt;node/);
  assert.doesNotMatch(out,/<node/);
});

test('graph selection exposes only recorded relation status and provenance', () => {
  const h=createHarness();
  const node={eid:'a',typeName:'<script>x</script>', attrs:{key:'ok'},history:[{evidence:{session:'s1'}}]};
  h.openKnowledgeNode(node,[{from:'a',to:'b',kind:'references',status:'hypothesis',confidence:0.35,t:1000}]);
  const out=h.el('#knowledgeDetail').innerHTML;
  assert.match(out,/hypothesis/);
  assert.match(out,/Inferred score/);
  assert.match(out,/Open source recording/);
  assert.match(out,/&lt;script&gt;/);
  assert.doesNotMatch(out,/<script>/);
});

test('model distinguishes saved-empty, missing and derivation failure', () => {
  const h=createHarness();
  h.S.knowledge={model:{data:{types:[]}}};
  h.renderKnowledgeModel(); assert.match(h.el('#knowledgeModel').innerHTML,/no inferred record types/i);
  h.S.knowledge={model:{data:null}};
  h.renderKnowledgeModel(); assert.match(h.el('#knowledgeModel').innerHTML,/No derived model saved/);
  h.S.knowledge={model:{data:{error:'boom',stage:'discover'}}};
  h.renderKnowledgeModel(); assert.match(h.el('#knowledgeModel').innerHTML,/Derivation failed at discover/);
});

test('type-drift review is non-mutating and links each origin-qualified evidence candidate', async () => {
  const h=createHarness();
  const c={id:'https://one.example::e1',typeName:'<img>',type:'t1'};
  h.S.knowledge={sessionId:'s1',at:'',continuity:{typeDriftHints:[{origin:'https://one.example',keyField:'id',key:'a',
    structuralFieldOverlap:0.8,candidates:[c,{id:'https://one.example::e2',typeName:'Other',type:'t2'}]}]}};
  h.renderKnowledgeDrift();
  const out=h.el('#knowledgeDrift').innerHTML;
  assert.match(out,/Unconfirmed possible same record type/);
  assert.match(out,/No merge or correction performed/);
  assert.match(out,/80% \(structural, not confidence\)/);
  assert.match(out,/&lt;img&gt;/); assert.doesNotMatch(out,/<img>/);
  const buttons=h.el('#knowledgeDrift').querySelectorAll('button[data-drift]');
  assert.equal(buttons.length,2);
  h.setApi(async()=>({entities:[{...c,attrs:{},history:[]}]}));
  await buttons[0].onclick();
  assert.match(h.el('#knowledgeDetail').innerHTML,/https:\/\/one.example::e1/);
});

test('late entity-detail response cannot override a newer selection', async () => {
  const h=createHarness();
  h.S.knowledge={sessionId:'s1',at:'',continuity:{entities:[]}};
  let resolveA, resolveB;
  h.setApi((url)=>new Promise((resolve)=>{ if(url.includes('eid=a'))resolveA=resolve; else resolveB=resolve; }));
  const first=h.openKnowledgeEntity({id:'a'}), second=h.openKnowledgeEntity({id:'b'});
  resolveB({entities:[{id:'b',typeName:'newest',attrs:{tag:'new choice'},history:[]}]});
  await second;
  resolveA({entities:[{id:'a',typeName:'oldest',attrs:{tag:'old choice'},history:[]}]});
  await first;
  const out=h.el('#knowledgeDetail').innerHTML;
  assert.match(out,/new choice/);
  assert.doesNotMatch(out,/old choice/);
});

test('partial Core read-only API failure leaves successful sections visible', async () => {
  const h=createHarness();
  h.el('#knowledgeSession').value='s1';
  h.setApi(async(url)=>{
    if(url.includes('continuity'))throw new Error('backend failed');
    if(url.endsWith('/graph')) return { nodes:[],edges:[] };
    return {types:[]};
  });
  await h.refreshKnowledge();
  assert.match(h.el('#knowledgeState').innerHTML,/1 of 3/);
  assert.match(h.el('#knowledgeEntities').innerHTML,/Continuity unavailable/);
  assert.match(h.el('#knowledgeModel').innerHTML,/no inferred record types/i);
  assert.match(h.el('#knowledgeGraph').innerHTML,/has no nodes/);
});

test('source navigation switches to the chosen recording, not an inferred identity', async () => {
  const h=createHarness();
  const history=[{session:'actual-source-01'},{evidence:{session:'actual-source-02'}}];
  h.el('#knowledgeDetail').innerHTML=h.knowledgeSourceLinks(history);
  h.wireKnowledgeSources(history);
  const buttons=h.el('#knowledgeDetail').querySelectorAll('button[data-source]');
  assert.equal(buttons.length,2);
  await buttons[1].onclick();
  assert.equal(h.opened(),'actual-source-02');
  assert.equal(h.S.view,'sessions');
});

test('rejected relationships never appear as active links in the map', () => {
  const h=createHarness();
  const out=h.knowledgeGraphMap({nodes:[{eid:'a'},{eid:'b'}],
    edges:[{from:'a',to:'b',status:'rejected',kind:'references'}]});
  assert.match(out,/rejected edges are omitted/);
  assert.doesNotMatch(out,/<line /);
});

test('late workspace load cannot replace selection from a newer recording', async () => {
  const h=createHarness();
  h.el('#knowledgeSession').value='old';
  let resolveOld;
  h.setApi(async (url) => {
    if(url.includes('/old/continuity')) return new Promise((resolve) => { resolveOld=resolve; });
    if(url.includes('/new/continuity')) return {site:'new',entities:[],stats:{}};
    return url.endsWith('/graph') ? {nodes:[],edges:[]} : {types:[]};
  });
  const old=h.refreshKnowledge();
  h.el('#knowledgeSession').value='new';
  const newer=h.refreshKnowledge();
  await newer;
  resolveOld({site:'old',entities:[],stats:{}});
  await old;
  assert.equal(h.S.knowledge.sessionId,'new');
  assert.equal(h.S.knowledge.continuity.site,'new');
});

test('Core knowledge-outcome states distinguish successful-empty, deriving, failed and legacy', () => {
  const h=createHarness();
  assert.match(h.knowledgeOutcomeMarkup({schema:'capture-studio.knowledge-status/1',status:'complete',entityCount:0,typeCount:0}),/Derived successfully: zero entities/);
  assert.match(h.knowledgeOutcomeMarkup({status:'complete',entityCount:3,typeCount:2}),/3 entities/);
  assert.match(h.knowledgeOutcomeMarkup({status:'deriving'}),/Do not trust older model\/graph/);
  assert.match(h.knowledgeOutcomeMarkup({status:'failed',stage:'identity',error:'<bad>'}),/Derivation failed during identity/);
  assert.doesNotMatch(h.knowledgeOutcomeMarkup({status:'failed',error:'<bad>'}),/<bad>/);
  assert.match(h.knowledgeOutcomeMarkup({status:'legacy-unverified'}),/Missing outcome metadata is not proof/);
  assert.match(h.knowledgeOutcomeMarkup({status:'status-unavailable',error:'401 unauthorized'}),/Could not verify derivation outcome/);
});

test('knowledge status adapter reads Core endpoint without interpreting missing status as verified', async () => {
  const h=createHarness();
  h.setApi(async(path)=>{ assert.match(path,/sessions\/s1\/knowledge-status/);return {status:'complete',entityCount:0}; });
  const r=await h.knowledgeStatusPromise('s1');
  assert.equal(r.data.status,'complete');
  const n=createHarness();
  n.setApi(async()=>{ const e=new Error('not found');e.status=404;throw e; });
  const missing=await n.knowledgeStatusPromise('s1');
  assert.equal(missing.status,404);
  assert.equal(missing.error,'not found');
});

test('integrated graph and model suppress prior derived data during Core derivation', async () => {
  const h=createHarness();
  h.el('#knowledgeSession').value='s1';
  h.setApi(async(path)=>{
    if(path.endsWith('/knowledge-status'))return {status:'deriving'};
    if(path.endsWith('/graph'))return {nodes:[{eid:'old',typeName:'STALE'}],edges:[]};
    if(path.endsWith('/model'))return {types:[{name:'STALE'}]};
    return {entities:[{id:'old',typeName:'STALE'}],stats:{}};
  });
  await h.refreshKnowledge();
  assert.match(h.el('#knowledgeGraph').innerHTML,/old graph results are not shown as current/);
  assert.match(h.el('#knowledgeModel').innerHTML,/old model results are not shown as current/);
  assert.match(h.el('#knowledgeEntities').innerHTML,/not shown while the current derivation is deriving/);
  assert.doesNotMatch(h.el('#knowledgeGraph').innerHTML,/STALE/);
});

test('integrated knowledge loads zero-entity successful derivation without presenting it as failed', async () => {
  const h=createHarness();
  h.el('#knowledgeSession').value='s1';
  h.setApi(async(path)=>{
    if(path.endsWith('/knowledge-status'))return {status:'complete',entityCount:0,typeCount:0};
    if(path.endsWith('/graph'))return {nodes:[],edges:[]};
    if(path.endsWith('/model'))return {types:[]};
    return {entities:[],stats:{sessionsDiscovered:1,sessionsWithDerivedKnowledge:1,entitiesTotal:0,joinedEntities:0}};
  });
  await h.refreshKnowledge();
  assert.match(h.el('#knowledgeMetrics').innerHTML,/Derived successfully: zero entities/);
  assert.match(h.el('#knowledgeEntities').innerHTML,/No derived entities are visible/);
  assert.doesNotMatch(h.el('#knowledgeMetrics').innerHTML,/Derivation failed/);
});

test('exact source navigation preserves session and sid when available', async () => {
  const h=createHarness();
  h.el('#evBody').querySelectorAll=()=>[];
  await h.openRecordedEvidence({session:'s1',sid:'stream-42',seq:17,t:1700000000000});
  assert.equal(h.opened(),'s1');
  assert.equal(h.streamOpened(),'stream-42');
  assert.equal(h.S.workflowStep,'Original recorded evidence');
  assert.equal(h.S.view,'streams');
});

test('Core explicit field removal is identified as an operation, not inferred from absence', async () => {
  const h=createHarness();
  h.S.knowledge={sessionId:'s1',at:'',continuity:{entities:[]}};
  h.setApi(async()=>({entities:[{id:'e1',typeName:'Record',attrs:{kept:'yes'},
    history:[{session:'s1',sid:'stream1',seq:4,t:1234,changed:[],removed:['legacyField'],values:{},provenanceBasis:'recorded-revision'}]}]}));
  await h.openKnowledgeEntity({id:'e1'});
  const output=h.el('#knowledgeDetail').innerHTML;
  assert.match(output,/Explicitly removed: legacyField/);
  assert.match(output,/Original evidence/);
  assert.match(output,/Open stream/);
  assert.doesNotMatch(output,/deleted because absent/i);
});
