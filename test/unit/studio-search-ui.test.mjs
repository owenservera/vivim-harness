// Search is a user-facing read-only evidence finder. Isolated interface tests; no browser automation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Script, runInNewContext } from 'node:vm';

const html=readFileSync(new URL('../../src/studio/ui/index.html',import.meta.url),'utf8');
const source=html.split('<script>')[1]?.split('</script>')[0] ?? '';
const esc=source.split('\n').find(x=>x.startsWith('const esc = '));
const knowledge=source.slice(source.indexOf('/* ---------------- Knowledge workspace'),source.indexOf('/* ---------------- profiles ---------------- */'));
const search=source.slice(source.indexOf('/* ---------------- search ---------------- */'),source.indexOf('\nconnectLive();'));

function harness() {
  const dom=new Map(), calls=[];
  const S={view:'search',sessionId:null,searchRequestSeq:0,knowledgeRequestSeq:0,knowledgeDetailSeq:0};
  let impl=async()=>[],opened='';
  function el(id) {
    if (!dom.has(id)) {
      dom.set(id, {value:'',innerHTML:'',textContent:'',isConnected:true,
        querySelectorAll(selector) {
          const key=/data-(search-hit)/.exec(selector)?.[1];
          if(!key)return [];
          const raw=[...this.innerHTML.matchAll(new RegExp('data-' + key + '="([0-9]+)"','g'))].map(m=>m[1]);
          if(this._markup!==this.innerHTML || this._key!==key) {
            this._buttons=raw.map(n=>({dataset:{searchHit:n},onclick:null}));
            this._markup=this.innerHTML; this._key=key;
          }
          return this._buttons;
        }
      });
    }
    return dom.get(id);
  }
  const context={
    $:el,S,api:(url)=>{calls.push(url);return impl(url);},guard:(fn)=>fn,
    show:(v)=>{S.view=v;},openSession:async(id)=>{opened=id;},
    toast:()=>{},URLSearchParams,
  };
  const funcs=runInNewContext(esc+'\n'+knowledge+'\n'+search+'\n({renderSearchHits})',context,{timeout:1000});
  return { ...funcs, S, el, calls, setApi:(f)=>{impl=f;}, submit:()=>el('#searchForm').onsubmit({preventDefault(){}}), opened:()=>opened };
}
test('search UI script parses with declared scope controls',()=>{
  assert.doesNotThrow(()=>new Script(source));
  assert.match(html,/id="searchScope"/);
  assert.match(html,/id="searchStatus"/);
  assert.match(source,/function renderSearchHits/);
  assert.match(source,/Search captured text for this key\/type/);
});
test('recent search escapes source snippets and opens correct recording',async()=>{
  const h=harness();
  h.el('#q').value='example';
  h.el('#searchScope').value='recent';
  h.setApi(async()=>[{session:'actual-session-1',layer:'L2',sid:'stream-1',snippet:'<img onerror=evil()>'}]);
  await h.submit();
  assert.match(h.calls[0],/search\?q=example&sessions=20/);
  const content=h.el('#hits tbody').innerHTML;
  assert.match(content,/&lt;img/);
  assert.doesNotMatch(content,/<img/);
  assert.match(content,/Recorded event/);
  const b=h.el('#hits tbody').querySelectorAll('button[data-search-hit]');
  assert.equal(b.length,1);await b[0].onclick();
  assert.equal(h.opened(),'actual-session-1');
  assert.equal(h.S.view,'sessions');
});
test('selected scope requires a selected saved recording',async()=>{
  const h=harness();
  h.el('#q').value='entity';h.el('#searchScope').value='selected';
  await h.submit();
  assert.equal(h.calls.length,0);
  assert.match(h.el('#searchStatus').innerHTML,/No saved recording is selected/);
});
test('selected scope uses the verified selected session identifier',async()=>{
  const h=harness();
  h.S.sessionId='session abc';
  h.el('#q').value='revenue';h.el('#searchScope').value='selected';
  h.setApi(async()=>[]);
  await h.submit();
  assert.match(h.calls[0],/session=session%20abc/);
  assert.match(h.el('#hits tbody').innerHTML,/not evidence that the subject did not exist/);
});
test('API rejection is not presented as a successful empty search',async()=>{
  const h=harness();
  h.el('#q').value='term';h.el('#searchScope').value='recent';
  h.setApi(async()=>{throw new Error('401 unauthorized');});
  await h.submit();
  assert.match(h.el('#searchStatus').innerHTML,/Search unavailable: 401 unauthorized/);
  assert.match(h.el('#hits tbody').innerHTML,/No results loaded due to an error/);
});
test('latest search wins when two requests resolve in reverse order',async()=>{
  const h=harness();
  h.el('#searchScope').value='recent';
  let oldResolve,newResolve;
  h.setApi((url)=>new Promise(resolve=>{if(url.includes('q=first')) oldResolve=resolve;else newResolve=resolve;}));
  h.el('#q').value='first';const a=h.submit();
  h.el('#q').value='second';const b=h.submit();
  newResolve([{session:'s2',layer:'L3',snippet:'second result'}]);
  await b;
  oldResolve([{session:'s1',layer:'L3',snippet:'first result'}]);
  await a;
  assert.match(h.el('#hits tbody').innerHTML,/second result/);
  assert.doesNotMatch(h.el('#hits tbody').innerHTML,/first result/);
});
