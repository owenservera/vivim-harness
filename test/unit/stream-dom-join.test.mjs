// Stream-to-DOM join wired into derive: synthetic raw SSE chat stream + synthetic DOM turns.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startStudio } from '../../src/studio/server.mjs';
import { dataPaths, ensureDataDirs } from '../../src/config.mjs';
import { ProfileStore } from '../../src/profiles/profiles.mjs';
import { Session } from '../../src/store/session.mjs';
import { derive } from '../../src/replay/derive.mjs';
import { ScopedLearner } from '../../src/intel/learn.mjs';

const STREAM = 's-chat';

// One typed-events SSE reply with a message id. Without `terminal`, both the message_stop event and
// the [DONE] marker are omitted, so the stream never shows a terminal marker.
function sse(terminal) {
  const lines = [
    'data: {"type":"message_start","message":{"id":"msg_join_01"}}', '',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}', '',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello there"}}', '',
    'data: {"type":"content_block_stop","index":0}', '',
  ];
  if (terminal) lines.push('data: {"type":"message_stop"}', '', 'data: [DONE]', '');
  return lines.join('\n') + '\n';
}

async function seed(paths, { terminal = true, turns } = {}) {
  const s = Session.create(paths.sessions, { site: 'join-test' });
  s.raw.append({ k: 'req', sid: STREAM, url: 'https://chat.example.test/api/chat', method: 'POST', type: 'Fetch' });
  s.raw.append({ k: 'res', sid: STREAM, status: 200, mime: 'text/event-stream' });
  s.raw.append({ k: 'chunk', sid: STREAM, b64: Buffer.from(sse(terminal)).toString('base64') });
  s.raw.append({ k: 'done', sid: STREAM, encodedDataLength: 1 });
  await s.raw.close();
  if (turns !== undefined) s.kv.set('DOM_TURNS', turns);
  return s;
}

function env(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'stream-dom-join-'));
  const paths = dataPaths(root); ensureDataDirs(paths);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const profile = new ProfileStore(paths.profiles).load('generic');
  const learner = new ScopedLearner(path.join(root, 'learner'));
  return { root, paths, profile, learner };
}

const userTurn = { index: 0, id: 'u1', domId: 'dom-u1', role: 'user', text: 'Say hello',
  blocks: [{ ord: 0, type: 'paragraph', text: 'Say hello' }] };
const assistantTurn = (id, index) => ({ index, id, domId: `dom-${id}`, role: 'assistant', text: 'Hello there',
  blocks: [{ ord: 0, type: 'paragraph', text: 'Hello there' }] });

test('one SSE chat stream + matching DOM assistant turn -> verified link; user turn unlinked_dom', async (t) => {
  const e = env(t);
  const s = await seed(e.paths, { turns: [userTurn, assistantTurn('a1', 1)] });
  await derive(s, e.profile, { learner: e.learner });
  const j = s.kv.get('STREAM_DOM_JOIN');
  assert.equal(j.schema, 'capture-studio.stream-dom-join/1');
  assert.equal(j.summary.messageStatus.verified, 1);
  assert.deepEqual(j.sources, { streams: [STREAM], domTurns: 2 });
  const link = j.links.find((l) => l.messageKey === 'msg_join_01');
  assert.equal(link.status, 'verified');
  assert.equal(link.turnId, 'a1');
  assert.equal(link.role, 'assistant');
  assert.equal(link.blockLinks[0].status, 'verified');
  const user = j.links.find((l) => l.turnId === 'u1');
  assert.equal(user.status, 'unlinked_dom');
  assert.equal(user.messageKey, null);
  assert.match(s.kv.get('RECEIPT').stream_dom_join, /^1 verified, 0 partial, 0 ambiguous, 0 unlinked stream, 1 unlinked DOM$/);
});

test('no DOM turns -> status no_dom_turns', async (t) => {
  const e = env(t);
  const s = await seed(e.paths);
  await derive(s, e.profile, { learner: e.learner });
  assert.deepEqual(s.kv.get('STREAM_DOM_JOIN'), { schema: 'capture-studio.stream-dom-join/1', status: 'no_dom_turns' });
  assert.equal(s.kv.get('RECEIPT').stream_dom_join, 'no_dom_turns');
});

test('a stream with no terminal marker -> link status partial, message not final', async (t) => {
  const e = env(t);
  const s = await seed(e.paths, { terminal: false, turns: [assistantTurn('a1', 0)] });
  await derive(s, e.profile, { learner: e.learner });
  const link = s.kv.get('STREAM_DOM_JOIN').links.find((l) => l.messageKey === 'msg_join_01');
  assert.equal(link.status, 'partial');
  assert.equal(link.turnId, 'a1');
  assert.ok(link.evidence.notes.includes('stream_not_final'));
});

test('two identical assistant turns -> ambiguous, no forced link', async (t) => {
  const e = env(t);
  const s = await seed(e.paths, { turns: [assistantTurn('a1', 0), assistantTurn('a2', 1)] });
  await derive(s, e.profile, { learner: e.learner });
  const j = s.kv.get('STREAM_DOM_JOIN');
  assert.equal(j.summary.messageStatus.ambiguous, 1);
  const msg = j.links.find((l) => l.messageKey === 'msg_join_01');
  assert.equal(msg.status, 'ambiguous');
  assert.equal(msg.turnId, null);
  assert.equal(msg.blockLinks.length, 0);
  const turnLinks = j.links.filter((x) => x.messageKey === null);
  assert.deepEqual(turnLinks.map((l) => l.status), ['unlinked_dom', 'unlinked_dom']);
});

test('re-deriving the same raw log writes identical STREAM_DOM_JOIN content', async (t) => {
  const e = env(t);
  const s = await seed(e.paths, { turns: [userTurn, assistantTurn('a1', 1)] });
  await derive(s, e.profile, { learner: e.learner });
  const first = JSON.stringify(s.kv.get('STREAM_DOM_JOIN'));
  await derive(s, e.profile, { learner: e.learner });
  const second = JSON.stringify(s.kv.get('STREAM_DOM_JOIN'));
  assert.equal(second, first);
  assert.equal(s.kv.get('STREAM_DOM_JOIN').links.length > 0, true);
});

test('derive still succeeds when the join throws; the failure is recorded in STREAM_DOM_JOIN', async (t) => {
  const e = env(t);
  const s = await seed(e.paths, { turns: [assistantTurn('a1', 0)] });
  const result = await derive(s, e.profile, {
    learner: e.learner,
    joinImpl: () => { throw new Error('injected join failure'); },
  });
  assert.equal(s.kv.get('STREAM_DOM_JOIN').schema, 'capture-studio.stream-dom-join/1');
  assert.equal(s.kv.get('STREAM_DOM_JOIN').error, 'injected join failure');
  assert.equal(s.kv.get('RECEIPT').stream_dom_join, 'error');
  assert.ok(result.receipt, 'derive returns its receipt');
  assert.ok(s.kv.get('KNOWLEDGE_STATUS'), 'the knowledge layer still ran and recorded its outcome');
});

test('GET /api/sessions/:id/join returns the kv value, or not_derived for an underived session', async (t) => {
  const e = env(t);
  const derived = await seed(e.paths, { turns: [assistantTurn('a1', 0)] });
  await derive(derived, e.profile, { learner: e.learner });
  const bare = Session.create(e.paths.sessions, { site: 'join-test' });
  await bare.raw.close();
  const runtime = {
    isSessionActive: () => false, close: async () => {},
    targets: async () => ({ sites: [], targets: [] }), list: async () => [],
  };
  const studio = await startStudio({ paths: e.paths, profileStore: new ProfileStore(e.paths.profiles),
    conversationRuntime: runtime, port: 0, accessMode: 'local' });
  t.after(() => studio.close());
  const get = async (id) => {
    const r = await fetch(`http://127.0.0.1:${studio.port}/api/sessions/${id}/join`);
    return { status: r.status, body: await r.json() };
  };
  const got = await get(derived.id);
  assert.equal(got.status, 200);
  assert.deepEqual(got.body, derived.kv.get('STREAM_DOM_JOIN'));
  const none = await get(bare.id);
  assert.equal(none.status, 200);
  assert.deepEqual(none.body, { status: 'not_derived' });
  const post = await fetch(`http://127.0.0.1:${studio.port}/api/sessions/${derived.id}/join`, { method: 'POST', body: '{}' });
  assert.equal(post.status, 405);
});
