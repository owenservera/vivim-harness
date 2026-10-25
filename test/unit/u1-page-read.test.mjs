import test from 'node:test';
import assert from 'node:assert/strict';
import { projectObservedPageRead, mountUniversalChat } from '../../src/studio/ui/universal-chat.mjs';

const snap = (id='conversation-1', ref='native-thread-1') => ({ id, identity:{state:'bound'}, binding:{thread:{ref}} });
const read = (convId='conversation-1', threadRef='native-thread-1') => ({
  convId, threadRef, seq:1, view:{ok:true, messages:[
    {role:'user',text:'Question',n:1},
    {role:'assistant',text:'Answer <script>not HTML</script>',n:2,cut:true}
  ],lines:['Showing 2 of 3 page messages','Older messages may be unloaded'],chips:[['Not a complete copy','t-warn']]}
});
class FakeNode {
  constructor(tag){this.tagName=tag;this.children=[];this.dataset={};this.attributes={};this.textContent='';this.listeners={};}
  appendChild(node){if(node.parent)node.parent.children=node.parent.children.filter(x=>x!==node);this.children.push(node);node.parent=this;return node;}
  replaceChildren(...nodes){for(const c of this.children)c.parent=null;this.children=[];nodes.forEach(n=>this.appendChild(n));}
  setAttribute(k,v){this.attributes[k]=v;}
  addEventListener(k,fn){this.listeners[k]=fn;}
  remove(){if(this.parent)this.parent.children=this.parent.children.filter(x=>x!==this);}
  get firstChild(){return this.children[0];}
}
const doc={createElement:t=>new FakeNode(t)};
const select=(node,tag)=>[node,...node.children.flatMap(c=>select(c,tag))].filter(x=>x.tagName===tag);
const flatten=node=>[node.textContent,...node.children.map(flatten)].join(' ');

test('real page read stays explicitly ungrounded and does not invent native IDs',()=>{
  const p=projectObservedPageRead(snap(),read());
  assert.equal(p.state,'observed');assert.equal(p.messages.length,2);
  assert.equal(p.grounded,false);assert.equal(p.nativeIds,false);assert.equal(p.accepted,false);
  assert.equal(p.messages[1].cut,true);assert.match(p.coverage[0],/Showing 2/);
});
test('same conversation id with changed thread refuses stale text',()=>{
  assert.equal(projectObservedPageRead(snap('conversation-1','new-thread'),read()).reason,'thread-mismatch');
});
test('different conversation refuses cross-conversation read',()=>{
  assert.equal(projectObservedPageRead(snap('conversation-2'),read()).reason,'conversation-mismatch');
});
test('missing saved thread binding refuses ambiguous read',()=>{
  const r=read();delete r.threadRef;
  assert.equal(projectObservedPageRead(snap(),r).reason,'thread-mismatch');
});
test('missing read, failed validation and malformed sequence abstain',()=>{
  assert.equal(projectObservedPageRead(snap(),null).state,'unavailable');
  assert.equal(projectObservedPageRead(snap(),{...read(),seq:0}).reason,'invalid-read');
  assert.equal(projectObservedPageRead(snap(),{...read(),view:{ok:false,messages:[]}}).reason,'invalid-read');
});
test('unsupported roles cannot be smuggled into observed page text',()=>{
  const r=read();r.view.messages.push({role:'system',text:'fake authority',n:3});
  const p=projectObservedPageRead(snap(),r);
  assert.equal(p.messages.length,2);assert.doesNotMatch(JSON.stringify(p),/fake authority/);
});
test('unknown thread may display page observation but cannot claim exact identity',()=>{
  const r=read('conversation-1',null),s={id:'conversation-1',identity:{state:'unverified'},binding:{}};
  assert.equal(projectObservedPageRead(s,r).identity,'unverified');
});
test('mounted U1 renders observed text literally, no send control or HTML injection',()=>{
  const root=doc.createElement('aside'),ui=mountUniversalChat({document:doc,root});
  const result=ui.show({snapshot:snap(),pageRead:read()});
  assert.equal(result.pageReadState,'observed');
  assert.match(flatten(ui.element),/Answer <script>not HTML<\/script>/);
  assert.equal(select(ui.element,'script').length,0);
  assert.equal(select(ui.element,'button').filter(b=>/send/i.test(b.textContent)).length,0);
});
test('mount clears prior conversation page text on snapshot switch',()=>{
  const root=doc.createElement('aside'),ui=mountUniversalChat({document:doc,root});
  ui.show({snapshot:snap(),pageRead:read()});
  const v=ui.show({snapshot:snap('conversation-2'),pageRead:read()});
  assert.equal(v.pageReadState,'unavailable');
  assert.doesNotMatch(flatten(ui.element),/Answer <script>/);
  assert.match(flatten(ui.element),/conversation-mismatch/);
});
test('200k character budget and 200 row bound prevent runaway rendering',()=>{
  const r=read();r.view.messages=Array.from({length:400},(_,i)=>({role:'assistant',text:'x'.repeat(2000),n:i+1}));
  const p=projectObservedPageRead(snap(),r);
  assert.ok(p.messages.length<=200);
  assert.ok(p.messages.reduce((n,m)=>n+m.text.length,0)<=200000);
});

test('native block state is erased when conversation changes even if turn ID collides',()=>{
  const root=doc.createElement('aside'),ui=mountUniversalChat({document:doc,root});
  ui.show({snapshot:snap(),events:[{turnId:'turn-1',blockId:'b',eventId:'e',sequence:1,op:'open',text:'PRIVATE OLD',kind:'text'}],turnIds:['turn-1']});
  assert.match(flatten(ui.element),/PRIVATE OLD/);
  const next=ui.show({snapshot:snap('conversation-2','native-thread-2'),turnIds:['turn-1']});
  assert.equal(next.acceptedEvents,0);
  assert.doesNotMatch(flatten(ui.element),/PRIVATE OLD/);
});
test('changed browser attachment resets cached native blocks even for same conversation id',()=>{
  const root=doc.createElement('aside'),ui=mountUniversalChat({document:doc,root});
  const old={...snap(),binding:{thread:{ref:'native-thread-1'},targetId:'tab-a'}};
  const newer={...snap(),binding:{thread:{ref:'native-thread-1'},targetId:'tab-b'}};
  ui.show({snapshot:old,events:[{turnId:'turn-1',blockId:'b',eventId:'e',sequence:1,op:'open',text:'Tab A only',kind:'text'}],turnIds:['turn-1']});
  ui.show({snapshot:newer,turnIds:['turn-1']});
  assert.doesNotMatch(flatten(ui.element),/Tab A only/);
});
