// Local-first product contract tests; no Chrome, network, or captured credentials.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { capturePrivacy } from '../../src/capture/privacy.mjs';
import { DomObserver } from '../../src/capture/dom.mjs';
import { validateConversationBody } from '../../src/studio/conversation-api.mjs';

const read = (p) => readFileSync(new URL('../../'+p, import.meta.url), 'utf8');
const recorder = read('src/capture/recorder.mjs');
const domSource = read('src/capture/dom.mjs');
const tap = read('src/capture/live-tap.mjs');
const network = read('src/capture/network.mjs');
const server = read('src/studio/server.mjs');
const hub = read('src/studio/integration-hub.mjs');
const chat = read('src/studio/ui/chat.mjs');
const chatHtml = read('src/studio/ui/chat.html');
const drive = read('src/studio/ui/drive.mjs');
const driveHtml = read('src/studio/ui/drive.html');
const driveApi = read('src/studio/drive-api.mjs');
const runtime = read('src/capture/conversation-runtime.mjs');
const service = read('src/capture/conversation-service.mjs');

test('default capture keeps exact local URL, response headers, text and bytes', () => {
  const p = capturePrivacy({capture:{}}, {});
  assert.equal(p.mode, 'local-raw');
  const url='https://example.test/path?token=private-local-test';
  assert.equal(p.url(url),url);
  assert.equal(p.headers({cookie:'local-only-fixture',authorization:'Bearer local-fixture'}).cookie,'local-only-fixture');
  assert.equal(p.text('{"access_token":"local-test-secret"}').text,'{"access_token":"local-test-secret"}');
  const bytes=Buffer.from('local-only-fixture');
  assert.equal(p.bytes(bytes).bytes,bytes);
});
test('filtered mode remains opt-in for users who choose it', () => {
  const p=capturePrivacy({capture:{}},{CAPTURE_STUDIO_CAPTURE_MODE:'filtered'});
  assert.equal(p.mode,'filtered');
  assert.match(p.url('https://example.test/?token=local-test-secret'),/redacted/);
  assert.notEqual(p.headers({cookie:'local-only-fixture'}).cookie,'local-only-fixture');
});
test('recorder URL lifecycle and network use matching capture mode',()=>{
  assert.match(recorder,/this\.privacy = capturePrivacy\(profile\)/);
  assert.match(recorder,/this\.privacy\.url\(target\.url\)/);
  assert.match(recorder,/this\.privacy\.url\(frame\.url\)/);
  assert.doesNotMatch(recorder,/\bredactUrl\(/);
  assert.match(network,/this\.privacy = capturePrivacy\(profile\)/);
  assert.match(network,/if \(this\.privacy\.localRaw\)/);
  assert.match(domSource,/this\.privacy = capturePrivacy\(profile\)/);
  assert.match(tap,/this\.source\?\.privacy\?\.url/);
});
test('local UI has zero token sign-in by default while remaining loopback bound',()=>{
  assert.match(server,/CAPTURE_STUDIO_ACCESS_MODE \?\? \(token === undefined \? 'local' : 'token'\)/);
  assert.match(server,/if \(accessMode === 'local'\) return true/);
  assert.match(server,/server\.listen\(port, '127\.0\.0\.1', resolve\)/);
  assert.match(server,/bad host/); assert.match(server,/bad origin/);
});
test('Live Drive uses one explicit action with no duplicate confirmation checkbox',()=>{
  assert.match(driveHtml,/id="btnLive"[^>]*>Send to selected sites<\/button>/);
  assert.doesNotMatch(driveHtml,/id="confirmLive"/);
  assert.doesNotMatch(drive,/confirmLive/);
  assert.match(drive,/if \(!dryRun\) body\.confirm = true/);
  assert.match(drive,/btnLive'\)\.addEventListener\('click', \(\) => launch\(false\)\)/);
});
test('prompt cap is no longer arbitrary 2000 characters and all layers agree',()=>{
  const prompt='X'.repeat(3000);
  assert.doesNotThrow(()=>validateConversationBody('submit',{key:'abc',prompt,confirm:true,expectedRevision:1}));
  assert.throws(()=>validateConversationBody('submit',{key:'abc',prompt:'X'.repeat(250001),confirm:true,expectedRevision:1}));
  assert.match(chatHtml,/maxlength="250000"/);
  assert.match(runtime,/body\.prompt\.length > 250000/);
  assert.match(service,/prompt\.length > 250000/);
  assert.match(driveApi,/body\.prompt\.length > 250000/);
});
test('Drive accepts ordinary URLs with query/fragment without forced stripping',()=>{
  assert.doesNotMatch(driveApi,/url\.username \|\| url\.password \|\| url\.search \|\| url\.hash/);
  assert.match(driveApi,/url\.username \|\| url\.password/);
});
test('local mode auth messages do not insist on nonexistent token as default',()=>{
  for(const ui of [chat,drive]) {
    assert.doesNotMatch(ui,/reopen the original tokenized Studio URL/);
    assert.match(ui,/Local mode needs no token/);
  }
});

test('local raw DOM mutation records preserve full original text and URL',()=>{
  const log=[];
  const obs=new DomObserver({append:r=>log.push(r),profile:{capture:{}}});
  obs.privacy=capturePrivacy({capture:{}},{});
  const text='Visible {"access_token":"local-fixture-token"}';
  const url='https://example.test/page?token=local-fixture-token';
  obs._onMessage(JSON.stringify({type:'dom.batch',url,items:[{text}]}));
  assert.equal(log[0].url,url);
  assert.equal(log[0].items[0].text,text);
  assert.equal(log[0].items[0].redactions,undefined);
});
test('local raw DOM snapshot and turns do not hide source content',async()=>{
  const obs=new DomObserver({append:()=>{},profile:{capture:{}}});
  obs.privacy=capturePrivacy({capture:{}},{});
  const html='<section>Access token: {"access_token":"local-fixture-token"}</section>';
  obs._evalInMain=async()=>({value:{html}});
  assert.equal((await obs.snapshot()).html,html);
  obs._evalInMain=async()=>({value:[{text:'{"access_token":"local-fixture-token"}',
    blocks:[{text:'secret local',inline:[{text:'local'}]}]}]});
  const turns=await obs.turns();
  assert.equal(turns[0].text,'{"access_token":"local-fixture-token"}');
  assert.equal(turns[0].blocks[0].text,'secret local');
});

test('OpenAPI declares no token requirement for localhost default mode',()=>{
  assert.match(server,/getAccessMode: \(\) => accessMode/);
  assert.match(hub,/security: getAccessMode\(\) === 'local' \? \[\]/);
  assert.match(hub,/getAccessMode = \(\) => 'local'/);
});
