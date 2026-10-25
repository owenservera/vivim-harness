// Reuses checked-in explicitly synthetic native-dialect evidence; adversarial identity
// counterexamples are test-only. Never exercises a browser or asserts capture acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { joinStreamToDom, verifiedContentRelations } from '../../src/intel/join.mjs';
import { correlateRendered } from '../../src/intel/correlate.mjs';
import { parseThread, boundTranscript } from '../../src/capture/conversation-thread.mjs';
import { ScopedLearner } from '../../src/intel/learn.mjs';

const saved = JSON.parse(readFileSync(new URL('../fixtures/ai-chat-dialects/chatgpt-pathops-v1.json', import.meta.url)));
const native = saved.frames.find((f) => f.json?.v?.message?.author?.role === 'assistant').json.v;
const original = saved.frames.filter((f) => f.json?.p === '/message/content/parts/0' && f.json?.o === 'append')
  .map((f) => f.json.v).join('') + saved.frames.find((f) => f.json?.v === 'made-up ')?.json.v;
const origin = 'https://chatgpt.com';
const S = (account, threadRef, sessionId = 'saved-fixture') => ({ origin, account, threadRef, sessionId });
const msg = (n, source, text = original) => {
  const id = n === 0 ? native.message.id : 'syn-followup-' + n;
  return { sid: 'stream-' + n, key: id, messageId: id, role: 'assistant', text, final: true, source,
    blocks: [{ key: id + ':0', index: 0, type: 'text', text }] };
};
const dom = (i, source, text = original) => ({ index: i, id: 'turn-' + i, role: 'assistant', text, source,
  blocks: [{ ord: 0, type: 'paragraph', text }] });

test('saved native message joins only exact scoped source among repeated same-text turns', () => {
  const first = S('alice', 'chatgpt-c:t-1'), other = S('bob', 'chatgpt-c:t-1');
  const messages = [msg(0, first)];
  const r = joinStreamToDom({ messages, turns: [dom(0, other), dom(1, first)] });
  assert.equal(r.links[0].status, 'verified');
  assert.equal(r.links[0].turnIndex, 1);
  assert.equal(r.summary.sourceQualifiedLinks, 1);
  const relationships = verifiedContentRelations({ messages, links: r.links });
  assert.equal(relationships.length, 1);
  assert.equal(relationships[0].from.messageId, native.message.id);
  assert.deepEqual(relationships[0].parts, [{ blockKey: native.message.id + ':0', domOrd: 0 }]);
  assert.equal(relationships[0].captureAccepted, false);
});

test('different thread, account, origin, session, and missing source may not match same text', () => {
  const source = S('alice', 'chatgpt-c:t-1');
  for (const other of [S('alice','chatgpt-c:t-2'), S('bob','chatgpt-c:t-1'),
    { ...source, origin: 'https://evil.example' }, { ...source, sessionId:'other' },
    { origin, account:'alice' }, null]) {
    const r = joinStreamToDom({ messages: [msg(0, source)], turns: [dom(0, other)] });
    assert.equal(r.links[0].status, 'unlinked_stream', JSON.stringify(other));
    assert.equal(verifiedContentRelations({ messages: [msg(0, source)], links: r.links }).length, 0);
  }
});

test('three alternating-context replies retain source ordering and separate native relationships', () => {
  const source = S('alice','chatgpt-c:t-1');
  const texts = [original, original + ' follow-up', original + ' third answer'];
  const messages = texts.map((text, i) => msg(i, source, text));
  const r = joinStreamToDom({ messages, turns: texts.map((text, i) => dom(i, source, text)) });
  assert.deepEqual(r.links.filter((x) => x.messageIndex !== null).map((x) => x.turnIndex), [0, 1, 2]);
  assert.equal(r.summary.messageStatus.verified, 3);
  assert.equal(verifiedContentRelations({ messages, links:r.links }).length, 3);
  const conflict = joinStreamToDom({ messages:[{ ...msg(0, source), nativeMessageId:'m-1' }],
    turns:[{ ...dom(0, source), nativeMessageId:'m-2' }] });
  assert.equal(conflict.links[0].status, 'unlinked_stream');
});

test('rendered correlation excludes another account even for identical text', () => {
  const source = S('alice','chatgpt-c:t-1');
  const subjects = [{ id:native.message.id,kind:'stream',text:original,source }];
  assert.equal(correlateRendered(subjects,[{ id:'other',text:original,source:S('bob','chatgpt-c:t-1') }])[0].status,'no_rendered_match');
  assert.equal(correlateRendered(subjects,[
    { id:'other',text:original,source:S('bob','chatgpt-c:t-1') },
    { id:'correct',text:original,source },
  ])[0].to.element,'correct');
});

test('lookalike HTTPS host cannot supply a ChatGPT thread', () => {
  const uuid='11111111-1111-4111-8111-111111111111';
  assert.equal(parseThread('chatgpt','https://evil.example/c/'+uuid),null);
  assert.ok(parseThread('chatgpt','https://chatgpt.com/c/'+uuid));
});

test('long transcript includes only observed native IDs and acknowledges unscanned content', () => {
  const r=boundTranscript({renderedTotal:500,messages:[
    {role:'assistant',text:'one',chars:3,id:'native-1',idSource:'data-message-id'},
    {role:'assistant',text:'two',chars:3,id:'invented'},
  ]});
  assert.equal(r.messages[0].id,'native-1');
  assert.equal(r.messages[1].id,undefined);
  assert.equal(r.coverage.unscannedRenderedMessages,498);
  assert.equal(r.coverage.omittedCharsUnknown,true);
  assert.equal(r.coverage.complete,false);
});

test('instance/page corrections need the real scoped identity and do not affect a second instance', () => {
  const learner=new ScopedLearner();
  const ctx={site:'chatgpt',origin,account:'alice',page:'/c/native'};
  const d={type:'string'};
  assert.throws(()=>learner.learn({scope:'instance',name:'text',role:'text',ctx,d}),/instanceId/);
  assert.throws(()=>learner.learn({scope:'page',name:'text',role:'text',ctx:{site:'chatgpt',page:'/c/native'},d}),/origin/);
  learner.learn({scope:'instance',name:'text',role:'text',ctx:{...ctx,instanceId:'native-1'},d});
  assert.equal(learner.predict('text',d,{...ctx,instanceId:'native-1'}).source,'instance-override');
  assert.notEqual(learner.predict('text',d,{...ctx,instanceId:'native-2'}).source,'instance-override');
});
