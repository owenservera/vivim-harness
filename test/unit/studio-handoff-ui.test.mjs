// Cross-page saved-session handoff: pure URL parsing and simulated navigation only.
// No live browser, capture, authenticated requests, or website sends.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Script, runInNewContext } from 'node:vm';

const src = (name) => readFileSync(new URL('../../src/studio/ui/' + name, import.meta.url), 'utf8');
const html = src('index.html');
const script = html.split('<script>')[1]?.split('</script>')[0] || '';
const chat = src('chat.mjs');
const drive = src('drive.mjs');
const start = script.indexOf('function parseSessionDeepLink(hash)');
const end = script.indexOf("if (location.hash.startsWith('#session='))", start);
const helperStart = script.indexOf('function recordedEvidenceHref(source)');
const helperEnd = script.indexOf('function knowledgeSourceLinks(history)', helperStart);
const navigation = start > 0 && end > start ? script.slice(start, end) : '';
const sourceHref = helperStart > 0 && helperEnd > helperStart ? script.slice(helperStart, helperEnd) : '';

function harness() {
  const states = [], reads = [], selection = {sessionId:null};
  let read = async () => true;
  let streamRows = [{sid:'stream-42'}], openError = null;
  const streamOpens = [], notifications = [];
  const nodes = new Map();
  const $ = (s) => {
    if (!nodes.has(s)) nodes.set(s, {hidden:true,textContent:'',querySelectorAll:()=>[]});
    return nodes.get(s);
  };
  const show = (v) => states.push(v);
  const apiRead = (id) => {reads.push(id);selection.sessionId=id;return read(id);};
  const selectSessionContext = (id) => {selection.sessionId=id || null;};
  const loadStreams = async () => streamRows;
  const openStream = async (sid) => { streamOpens.push(sid); if (openError) throw openError; return true; };
  const functions = runInNewContext(sourceHref + navigation + '\n({parseSessionDeepLink,openSessionDeepLink,recordedEvidenceHref})',
    { URLSearchParams, show, $, openSession:apiRead, selectSessionContext, S:selection, loadStreams, openStream, toast:(message)=>notifications.push(message) }, { timeout:1000 });
  return {...functions,$,states,reads,notifications,streamOpens,selected:()=>selection.sessionId,
    setRead:(fn)=>{read=fn;},setStreams:(rows)=>{streamRows=rows;},setStreamError:(err)=>{openError=err;}};
}

test('the Studio script compiles and provides the session handoff', () => {
  assert.ok(start > 0 && end > start);
  assert.doesNotThrow(()=>new Script(script));
  assert.match(html,/id="deepLinkNotice" role="status" aria-live="polite"/);
  assert.match(script,/window\.addEventListener\('hashchange'/);
  assert.match(script,/async function openSession\(id\)[\s\S]*?return true;\s*\}/);
});

test('legacy Chat/Drive links open precisely the saved recording', async () => {
  const h=harness();
  const result=await h.openSessionDeepLink('#session=stored-123');
  assert.equal(result,true);
  assert.deepEqual(h.reads,['stored-123']);
  assert.deepEqual(h.states,['sessions']);
  assert.equal(h.$('#deepLinkNotice').hidden,true);
});

test('knowledge link resolves the recording before showing derived content', async () => {
  const h=harness();
  const result=await h.openSessionDeepLink('#session=site%2Frecord%201&view=knowledge');
  assert.equal(result,true);
  assert.deepEqual(h.reads,['site/record 1']);
  assert.deepEqual(h.states,['sessions','knowledge']);
  assert.match(h.$('#knowledgeState').textContent,/may be incomplete or unverified/);
});

test('a missing/unauthorized recording never switches to Knowledge', async () => {
  const h=harness();
  h.setRead(async()=>false);
  const ok=await h.openSessionDeepLink('#session=removed&view=knowledge');
  assert.equal(ok,false);
  assert.deepEqual(h.states,['sessions']);
  assert.match(h.$('#deepLinkNotice').textContent,/Could not open/);
  assert.equal(h.selected(),null,'failed link cannot leave unverified recording selected');
});

test('invalid, duplicate or unknown fields do not trigger source fetch', async () => {
  for (const fragment of ['#session=', '#session=abc&view=send', '#session=a&session=b', '#session=a&view=sessions&view=knowledge',
    '#session=a&delete=1', '#session=broken%z', '#session=%00', '#session='+'a'.repeat(129)]) {
    const h=harness();
    assert.equal(h.parseSessionDeepLink(fragment),null,fragment);
    assert.equal(await h.openSessionDeepLink(fragment),false,fragment);
    assert.equal(h.reads.length,0,fragment);
    assert.equal(h.selected(),null,fragment);
    assert.match(h.$('#deepLinkNotice').textContent,/Invalid recording link/);
  }
});

test('a later navigation wins even when old reads finish last', async () => {
  const h=harness();let resolveFirst;
  h.setRead((id)=>id==='old'?new Promise((resolve)=>{resolveFirst=resolve;}):Promise.resolve(true));
  const first=h.openSessionDeepLink('#session=old&view=knowledge');
  const second=h.openSessionDeepLink('#session=new&view=knowledge');
  assert.equal(await second,true);
  resolveFirst(true);
  assert.equal(await first,false);
  assert.deepEqual(h.reads,['old','new']);
  assert.equal(h.states.filter((s)=>s==='knowledge').length,1);
});

test('Chat exposes recorded source and cautious knowledge actions only for saved session ID', () => {
  assert.match(chat,/linkSig = out && sid \? sid : ''/);
  assert.match(chat,/newTabLink\('\/#session=' \+ encodeURIComponent\(sid\), 'Open saved session'\)/);
  assert.match(chat,/&view=knowledge', 'Explore derived knowledge \(may be incomplete\)'/);
  assert.match(chat,/const sid = snap\?\.sessionId/);
  assert.doesNotMatch(chat,/newTabLink\('\/#session=' \+ snap\.binding/, 'never link a tab as a saved recording');
});

test('Drive provides the same session/knowledge route without claiming capture acceptance', () => {
  assert.match(drive,/if \(!id\) return null;/);
  assert.match(drive,/href: '\/#session=' \+ encodeURIComponent\(id\) \+ '&view=knowledge'/);
  assert.match(drive,/Explore derived knowledge \(may be incomplete\)/);
  assert.match(drive,/Capture acceptance not checked\./);
});

test('the handoff has no send, mutation or auto-derive operations', () => {
  assert.doesNotMatch(navigation,/\b(?:api|fetch|sendAgain|derive)\s*\(/);
  assert.doesNotMatch(navigation,/method:\s*['\"]POST/);
  assert.match(script,/const loaded = await openSession\(request\.id\)/);
});


test('exact source link encodes session, SID and numeric sequence without inventing absent locators',()=>{
  const h=harness();
  const url=h.recordedEvidenceHref({session:'site / recording',sid:'ws/stream &1',seq:17});
  assert.equal(url,'/#session=site%20%2F%20recording&view=streams&sid=ws%2Fstream%20%261&seq=17');
  assert.equal(h.parseSessionDeepLink(url.slice(1)).seq,17);
  assert.equal(h.recordedEvidenceHref({session:'s1'}),null);
  assert.equal(h.recordedEvidenceHref({session:'s1',sid:'x',seq:'invalid'}),'/#session=s1&view=streams&sid=x');
  assert.equal(h.recordedEvidenceHref({session:'s1',sid:'\u0000'}),null);
  assert.match(script,/href="' \+ esc\(recordedEvidenceHref\(r\)\)/);
  assert.match(script,/Open exact stream/);
});

test('exact SID permalink verifies saved recording and stream membership before opening evidence',async()=>{
  const h=harness();
  const ok=await h.openSessionDeepLink('#session=s1&view=streams&sid=stream-42&seq=17');
  assert.equal(ok,true);
  assert.deepEqual(h.reads,['s1']);
  assert.deepEqual(h.streamOpens,['stream-42']);
  assert.deepEqual(h.states,['sessions','streams']);
  assert.match(h.$('#evMeta').textContent,/sequence #17 not present in this bounded preview/);
  assert.match(h.notifications[0],/exact sequence is unavailable/);
});
test('missing exact stream never substitutes an unrelated stream or marks link success',async()=>{
  const h=harness();h.setStreams([{sid:'other-stream'}]);
  const ok=await h.openSessionDeepLink('#session=s1&view=streams&sid=unavailable&seq=3');
  assert.equal(ok,false);
  assert.deepEqual(h.streamOpens,[]);
  assert.deepEqual(h.states,['sessions']);
  assert.match(h.$('#deepLinkNotice').textContent,/stream is missing/);
});
test('unavailable stream bodies return to saved-recording view with explicit diagnostics',async()=>{
  const h=harness();h.setStreamError(new Error('saved stream read failed'));
  const ok=await h.openSessionDeepLink('#session=s1&view=streams&sid=stream-42');
  assert.equal(ok,false);
  assert.deepEqual(h.states,['sessions','streams','sessions']);
  assert.match(h.$('#deepLinkNotice').textContent,/could not be loaded/);
});
test('malformed deep stream/sequence locators do not fetch or send',async()=>{
  for(const bad of ['#session=a&sid=x','#session=a&view=knowledge&sid=x',
    '#session=a&view=streams&seq=2','#session=a&view=streams&sid=x&seq=NaN',
    '#session=a&view=streams&sid=x&seq=-1','#session=a&view=streams&sid=x&seq=9007199254740992',
    '#session=a&view=streams&sid=x&sid=y','#session=a&view=streams&sid=x&seq=1&seq=2',
    '#session=a&view=streams&sid=']) {
    const h=harness();
    assert.equal(h.parseSessionDeepLink(bad),null,bad);
    assert.equal(await h.openSessionDeepLink(bad),false,bad);
    assert.equal(h.reads.length,0,bad);
  }
});
