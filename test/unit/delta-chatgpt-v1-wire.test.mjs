// Regression (issue #84, found live on real ChatGPT 2026-10-24): ChatGPT `delta_encoding: v1`.
// 1) After a first {o:"patch",v:[ops]}, later batches arrive as a bare {v:[ops]} which used to be
//    appended as one array value, silently dropping every later token of the reply.
// 2) A trailing typed side event (conversation_detail_metadata, title_generation) used to replace
//    the whole assembled document, so the "reply" became a model slug.
// 3) The message's own /metadata/ subtree (UI render code, fallback markdown) outranked
//    content/parts as the "longest text".
// Wire shapes below are reduced from a real capture; no account data or prompts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DeltaAssembler } from '../../src/decode/delta.mjs';

const message = (role, parts) => ({ v: { message: { id: `${role}-1`, author: { role }, content: { content_type: 'text', parts }, metadata: {}, status: 'in_progress' } }, c: 1 });
const code = 'DIL.render(__dil.jsx(()=>{const x=DIL.useConstants();return __dil.jsx("table",{},__dil.jsx("text",null,"long render code that is longer than the reply text itself"))}))';
const batch = (text) => [{ p: '/message/content/parts/0', o: 'append', v: text }, { p: '/message/metadata/model_dil_v2/code', o: 'replace', v: code }];

function replay(extra = []) {
  const da = new DeltaAssembler('auto');
  da.apply(message('assistant', ['']));
  da.apply({ o: 'patch', v: batch('| Step | What |\n|---|---|\n| A | one') });
  da.apply({ v: batch(' and two |\n| B | three') });   // bare batch: the bug
  da.apply({ v: batch(' and four |') });
  for (const e of extra) da.apply(e);
  return da;
}

test('a bare {v:[ops]} batch is applied op by op, so the whole reply is assembled', () => {
  const da = replay();
  assert.equal(da.doc.message.content.parts[0], '| Step | What |\n|---|---|\n| A | one and two |\n| B | three and four |');
});

test('a trailing typed side event never replaces the assembled document', () => {
  const da = replay([
    { type: 'title_generation', title: 'T', conversation_id: 'c' },
    { type: 'conversation_detail_metadata', banner_info: null, blocked_features: [], default_model_slug: 'gpt-x', conversation_id: 'c' },
  ]);
  assert.ok(da.doc.message, 'the message document is still the document');
  assert.match(da.doc.message.content.parts[0], /four \|$/);
  assert.ok(da.errors.some((e) => e.reason === 'side_channel_event_ignored'), 'the ignored event is accounted, not hidden');
});

test('primary text is the reply under content/parts, not the message metadata render code', () => {
  const da = replay();
  assert.ok(code.length > da.doc.message.content.parts[0].length, 'fixture: render code is longer than the reply');
  assert.equal(da.primaryText(), da.doc.message.content.parts[0]);
});

test('a bare array that is not a batch of path-ops is still a value, not a batch', () => {
  const da = new DeltaAssembler('auto');
  da.apply({ p: '/items', o: 'add', v: [] });
  da.apply({ v: [1, 2, 3] });
  assert.ok(da.revisions >= 2);
});
