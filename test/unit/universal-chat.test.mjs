import test from 'node:test';
import assert from 'node:assert/strict';
import {createConversationStore,projectWorkspace,projectRail,projectCapability,projectAdapter,evidenceRef,projectOutcome,recoveryView,mountUniversalChat,renderNativeBlock} from '../../src/studio/ui/universal-chat.mjs';
import {snapshot,openTabs,accountChats,adapters,events,outcome} from './fixtures/ui-fixtures.mjs';
const e=(turnId,blockId,eventId,sequence,op,text='',kind='text',extra={})=>({turnId,blockId,eventId,sequence,op,text,kind,...extra});
class FakeNode {
 constructor(tag){this.tagName=tag;this.children=[];this.dataset={};this.attributes={};this.textContent='';this.listeners={};}
 appendChild(node){if(node.parent){node.parent.children=node.parent.children.filter(c=>c!==node);}this.children.push(node);node.parent=this;return node;}
 replaceChildren(...nodes){for(const c of this.children)c.parent=null;this.children=[];nodes.forEach(n=>this.appendChild(n));}
 setAttribute(k,v){this.attributes[k]=v;}
 addEventListener(k,cb){this.listeners[k]=cb;}
 remove(){if(this.parent)this.parent.children=this.parent.children.filter(c=>c!==this);}
 get firstChild(){return this.children[0];}
}
const doc={createElement:t=>new FakeNode(t)};
function flatten(n){return [n.textContent,...n.children.map(flatten)].join(' ');}
function select(n,tag){return [n,...n.children.flatMap(c=>select(c,tag))].filter(x=>x.tagName===tag);}
test('bound snapshot requires grounded native thread and studio conversation ID',()=>{const x=projectWorkspace(snapshot,{openTabs,accountChats});assert.equal(x.identity.exact,true);assert.equal(x.identity.threadRef,'fictional-native-thread-9');});
test('same named tab is not an account thread',()=>{const x=projectWorkspace(snapshot,{openTabs,accountChats});assert.equal(x.openTabs[0].kind,'browser-tab');assert.equal(x.accountChats[0].kind,'account-index');});
test('unknown native thread never inferred from title',()=>{const x=projectWorkspace({...snapshot,identity:{state:'unverified'},binding:{title:'Looks like a thread'}});assert.equal(x.identity.exact,false);assert.equal(x.identity.threadRef,null);});
test('bound without stable native thread remains not exact',()=>{const x=projectWorkspace({...snapshot,identity:{state:'bound'},binding:{title:'Same text'}});assert.equal(x.identity.exact,false);});
test('signed-out explicitly retained',()=>{const x=projectWorkspace({...snapshot,account:{state:'signed-out'}});assert.equal(x.accountState,'signed-out');});
test('unrecognized account state unknown',()=>{assert.equal(projectWorkspace({...snapshot,account:{state:'maybe'}}).accountState,'unknown');});
test('missing capability evidence stays unverified',()=>{assert.deepEqual([projectCapability({seedConfigured:true}).pageObserved,projectCapability({}).effectVerified],['unverified','unverified']);});
test('observed page is distinct from verified effect',()=>{const c=projectCapability({pageObserved:'supported',effectVerified:'unverified'});assert.equal(c.pageObserved,'supported');assert.equal(c.effectVerified,'unverified');});
test('ungrounded locator never gives SID/seq',()=>{assert.equal(evidenceRef({sid:'claim',seq:34}).grounded,false);assert.equal(evidenceRef({sid:'claim',seq:34}).sid,null);});
test('grounded SID and zero sequence retained',()=>{assert.deepEqual([evidenceRef({grounded:true,sid:'s1',seq:0}).sid,evidenceRef({grounded:true,sid:'s1',seq:0}).sequence],['s1',0]);});
test('invalid sequence never rounded to a real locator',()=>{assert.equal(evidenceRef({grounded:true,sid:'s',seq:3.14}).grounded,false);});
test('separate outcome booleans do not infer capture acceptance',()=>{const p=projectOutcome({networkEnded:true,pageStable:true,freshReply:true});assert.equal(p.captureAccepted,false);assert.equal(p.goalFulfilled,false);});
test('unknown effect blocks resend, only inspection',()=>{const r=recoveryView({effectState:'uncertain'});assert.equal(r.retryAuthorized,false);assert.deepEqual(r.actions,['inspect-read-only']);});
test('uncertain send marker blocks resend',()=>{assert.equal(recoveryView({sendState:'uncertain'}).blocked,true);});
test('learning candidate is never a send grant',()=>{const a=projectAdapter({...adapters[1],stage:'read-only-active'});assert.equal(a.effectEligible,false);assert.equal(a.stage,'read-only-active');});
test('held-out overlap not independent',()=>{const a=projectAdapter({...adapters[1],heldoutSessionIds:['train-a']});assert.equal(a.heldoutIndependent,false);});
test('missing complete training abstains from independence',()=>{const a=projectAdapter({...adapters[1],trainingComplete:false});assert.equal(a.heldoutIndependent,false);});
test('fixture rejected shadow candidate remains non-actionable',()=>{const a=projectAdapter({...adapters[1],stage:'rejected'});assert.equal(a.shadowResult,'mismatch');assert.equal(a.effectEligible,false);});
test('same text in two turns stays separate by ID',()=>{const s=createConversationStore();events.forEach(x=>s.accept(x));assert.equal(s.getTurn('user-1').blocks[0].text,s.getTurn('user-2').blocks[0].text);assert.notEqual(s.getTurn('user-1').blocks[0].id,s.getTurn('user-2').blocks[0].id);});
test('artifact revision retains old value without flattening',()=>{const s=createConversationStore();events.forEach(x=>s.accept(x));const b=s.getTurn('assistant-1').blocks[1];assert.equal(b.text,'Updated version');assert.equal(b.revisions[0].text,'Draft one');assert.equal(b.payload.version,2);});
test('unknown provider native block and payload retained',()=>{const s=createConversationStore();events.forEach(x=>s.accept(x));const b=s.getTurn('assistant-2').blocks[1];assert.equal(b.kind,'native-widget');assert.equal(b.payload.preview,'Untranslated native widget');});
test('partial stream visible and explicitly incomplete',()=>{const s=createConversationStore();s.accept(e('t','b','1',1,'open','Start'));s.accept(e('t','b','2',2,'append',' continuing'));assert.deepEqual([s.getTurn('t').blocks[0].text,s.getTurn('t').blocks[0].status],['Start continuing','streaming']);});
test('duplicate event id ignored',()=>{const s=createConversationStore();s.accept(e('t','b','1',1,'open','A'));assert.equal(s.accept(e('t','b','1',2,'append','B')).applied,false);});
test('out-of-order block sequence cannot rewind response',()=>{const s=createConversationStore();s.accept(e('t','b','2',2,'replace','Latest'));assert.equal(s.accept(e('t','b','1',1,'replace','Old')).reason,'stale-sequence');});
test('append without opened native block abstains',()=>{const s=createConversationStore();assert.equal(s.accept(e('t','b','1',1,'append','guess')).reason,'no-baseline');});
test('missing turn identity refuses to merge same text',()=>{const s=createConversationStore();assert.equal(s.accept(e(null,'b','1',1,'open','same')).reason,'unattributed-event');});
test('patch with no complete replacement refuses silent flatten',()=>{const s=createConversationStore();s.accept(e('t','b','1',1,'open','A'));assert.equal(s.accept({turnId:'t',blockId:'b',eventId:'2',sequence:2,op:'patch',kind:'text'}).reason,'patch-missing-replacement');assert.equal(s.getTurn('t').blocks[0].text,'A');});
test('closed response cannot receive new appended chunks',()=>{const s=createConversationStore();s.accept(e('t','b','1',1,'open','A'));s.accept(e('t','b','2',2,'close'));assert.equal(s.accept(e('t','b','3',3,'append','B')).reason,'not-streaming');});
test('stream replacement can reopen as new authoritative revision',()=>{const s=createConversationStore();s.accept(e('t','b','1',1,'open','A'));s.accept(e('t','b','2',2,'close'));s.accept(e('t','b','3',3,'replace','B','text',{revision:1}));assert.equal(s.getTurn('t').blocks[0].text,'B');});
test('1001 chunks append with one materialization and exact length',()=>{const s=createConversationStore();s.accept(e('t','b','start',0,'open',''));for(let i=1;i<=1001;i++) assert.equal(s.accept(e('t','b','c'+i,i,'append','x')).applied,true);assert.equal(s.getTurn('t').blocks[0].text.length,1001);assert.equal(s.changes,1002);});
test('code rendering uses literal text and never innerHTML',()=>{const root=doc.createElement('div');renderNativeBlock(doc,root,{kind:'code',text:'<script>alert(1)</script>',revision:1,status:'complete',payload:{language:'js'}});assert.match(flatten(root),/<script>alert\(1\)<\/script>/);assert.equal(select(root,'script').length,0);});
test('unsafe citation URL renders non-link span',()=>{const root=doc.createElement('div');renderNativeBlock(doc,root,{kind:'citation',payload:{url:'javascript:alert(1)',label:'Unsafe'}});assert.equal(select(root,'a').length,0);});
test('valid citation link is safe',()=>{const root=doc.createElement('div');renderNativeBlock(doc,root,{kind:'citation',payload:{url:'https://example.org/cite',label:'Source'}});assert.equal(select(root,'a')[0].rel,'noopener noreferrer');});
test('table renders actual cells without HTML parsing',()=>{const root=doc.createElement('div');renderNativeBlock(doc,root,{kind:'table',payload:{columns:['Name'],rows:[['<img>']]}});assert.equal(select(root,'td')[0].textContent,'<img>');assert.equal(select(root,'img').length,0);});
test('mount only under injected existing root, with no send control',()=>{const root=doc.createElement('aside');const ui=mountUniversalChat({document:doc,root});const v=ui.show({snapshot,openTabs,accountChats,adapters,events,turnIds:['assistant-1','assistant-2'],outcome});assert.equal(root.children.length,1);assert.equal(v.acceptedEvents,events.length);assert.equal(select(ui.element,'button').filter(b=>/send/i.test(b.textContent)).length,0);});
test('mount exposes inspect read-only and no resend button',()=>{const root=doc.createElement('aside'),called=[];const ui=mountUniversalChat({document:doc,root,onInspect:e=>called.push(e)});ui.show({snapshot:{...snapshot,turn:{send:{state:'uncertain'}}}});const buttons=select(ui.element,'button');assert.equal(buttons.length,1);buttons[0].listeners.click();assert.equal(called[0].conversationId,'studio-local-conversation-1');});
test('evidence drilldown only for grounded block evidence',()=>{const root=doc.createElement('aside'),hits=[];const ui=mountUniversalChat({document:doc,root,onEvidence:x=>hits.push(x)});ui.accept(e('a','b','1',1,'open','X','text',{evidence:{grounded:true,sid:'sid-5',seq:8}}));ui.show({snapshot,turnIds:['a']});const buttons=select(ui.element,'button');assert.equal(buttons.length,1);buttons[0].listeners.click();assert.deepEqual(hits[0],{sid:'sid-5',sequence:8,turnId:'a',blockId:'b'});});
test('read-only update caches unchanged native block DOM nodes',()=>{const root=doc.createElement('aside'),ui=mountUniversalChat({document:doc,root});ui.accept(e('a','b','1',1,'open','Stable'));ui.show({snapshot,turnIds:['a']});const before=select(ui.element,'section').find(n=>n.dataset.kind==='text');ui.show({snapshot,turnIds:['a']});const after=select(ui.element,'section').find(n=>n.dataset.kind==='text');assert.equal(before,after);});

test('native and binding thread conflict never treated as exact',()=>{const x=projectWorkspace({...snapshot,identity:{state:'bound',threadKey:'thread-A'},binding:{thread:{key:'thread-B'}}});assert.equal(x.identity.exact,false);});

test('provider rail preserves distinct read/send truth and signed-out',()=>{const r=projectRail([{id:'fictional.webapp',accountState:'signed-out',readState:'supported',sendState:'unverified'}]);assert.equal(r.providers[0].accountState,'signed-out');assert.equal(r.providers[0].sendState,'unverified');});
test('task index remains separate from chat identity',()=>{const r=projectRail([],[{id:'task-1',title:'Investigate',provider:'fictional.webapp',status:'running'}]);assert.equal(r.tasks[0].conversationId,null);});
test('mounted adapter rollback review has injected callback only',()=>{const root=doc.createElement('aside'),calls=[];const ui=mountUniversalChat({document:doc,root,onReviewAdapter:x=>calls.push(x)});ui.show({adapters:[adapters[1]]});const b=select(ui.element,'button');assert.equal(b.length,1);b[0].listeners.click();assert.equal(calls[0].rollbackVersion,'seed-1');});
test('account index and tab list render independently',()=>{const root=doc.createElement('aside'),ui=mountUniversalChat({document:doc,root});ui.show({snapshot,openTabs,accountChats});assert.equal(select(ui.element,'ul').length,2);});
