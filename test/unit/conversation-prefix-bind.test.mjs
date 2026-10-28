// Observed-prefix adoption — spec §4-§11, happy path, turn-2 admission and the API surface.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import { workspace, rawPage, PROMPT, REPLY, TURN2, THREAD, sha } from './conversation-prefix-fixture.mjs';
import { createConversationApi } from '../../src/studio/conversation-api.mjs';

test('bind writes a pending observed prefix and nothing sendable', async (t) => {
  const f = workspace(t);
  const before = fs.readFileSync(f.sourceFile);
  const c = await f.bind();
  assert.equal(c.prefix.state, 'pending');
  assert.equal(c.prefix.kind, 'observed-prefix');
  assert.equal(c.prefix.schema, 1);
  assert.equal(c.prefix.sendActor, 'unknown');
  assert.equal(c.prefix.dispatch, 'unknown');
  assert.equal(c.prefix.account, 'unknown');
  assert.equal(c.prefix.arrival, 'page-observed');
  assert.equal(c.prefix.prompt.source, 'capture-kv');
  assert.equal(c.prefix.prompt.digest, sha(PROMPT));
  assert.equal(c.prefix.userMessage.id, 'user-1');
  assert.equal(c.prefix.userMessage.index, 0);
  assert.equal(c.prefix.userMessage.digest, sha(PROMPT));
  assert.equal(c.prefix.assistant.id, 'assistant-1');
  assert.equal(c.prefix.assistant.index, 1);
  assert.equal(c.prefix.assistant.digest, sha(REPLY));
  assert.equal(c.prefix.assistant.chars, REPLY.length);
  assert.equal(c.prefix.assistant.completion, 'observed-complete');
  assert.equal(c.prefix.thread.ref, `chatgpt-c:${THREAD}`);
  assert.equal(c.prefix.target.targetId, 'tab-1');
  assert.equal(c.prefix.source.conversationId, f.conversationId);
  assert.equal(c.prefix.source.attemptId, f.attemptId);
  assert.equal(c.prefix.source.phase, 'uncertain');
  assert.equal(c.prefix.source.journalless, true);
  assert.equal(c.prefix.adoptedAt, null);
  assert.equal(c.prefix.reads.length >= 2, true);
  assert.equal(c.state, 'disconnected'); // pending is never an attached/sendable state
  assert.equal(c.turn, null);
  assert.deepEqual(c.turns, []);
  assert.equal(c.writer.active, false); // the bind window closed
  // Source evidence is immutable.
  assert.deepEqual(fs.readFileSync(f.sourceFile), before);
  // No prompt or reply body is stored anywhere in the new snapshot.
  const created = f.files().filter((name) => name !== `${f.conversationId}.conversation.json`);
  assert.equal(created.length, 1);
  const disk = fs.readFileSync(path.join(f.conversations, created[0]), 'utf8');
  assert.equal(disk.includes(PROMPT), false);
  assert.equal(disk.includes(REPLY), false);
  // The thread journal is still absent: adoption never created it.
  assert.equal(fs.existsSync(path.join(f.conversations, 'thread-turns')), false);
  // A pending prefix is not sendable.
  await assert.rejects(f.submit(c), (e) => e.code === 'PREFIX_NOT_ACTIVE');
  assert.equal(f.state.sends, 0);
});

test('connect with the matching prefixSource activates it and turn 2 is delivered on the same thread', async (t) => {
  const f = workspace(t, { appendOnSend: true, appendReply: true });
  const pending = await f.bind();
  const active = await f.connect();
  assert.equal(active.id, pending.id);
  assert.equal(active.prefix.state, 'active');
  assert.equal(active.prefix.adoptedAt !== null, true);
  assert.equal(active.binding.thread.ref, `chatgpt-c:${THREAD}`);
  assert.equal(active.binding.targetId, 'tab-1');
  assert.equal(active.identity.state, 'bound');
  assert.equal(active.turn, null); // turn 1 is never a journal turn
  assert.equal(fs.existsSync(path.join(f.conversations, 'thread-turns')), false);
  const sent = await f.submit(active);
  assert.equal(f.state.sends, 1);
  assert.equal(f.state.typed, TURN2);
  assert.equal(sent.turn.send.state, 'observed'); // admitted past every prefix gate
  const settled = await f.runtime.get(active.id);
  assert.equal(settled.turn.send.state, 'observed');
  assert.equal(settled.turns.length, 1); // only turn 2 exists; the prefix is not a turn
  assert.equal(settled.turns[0].key, 'two');
  assert.equal(settled.turns[0].send.state, 'observed');
  assert.notEqual(settled.reply.state, 'unknown');
});

test('a second identical bind after activation is a read-only replay: no page access, no write', async (t) => {
  const f = workspace(t);
  const pending = await f.bind();
  const active = await f.connect();
  const file = path.join(f.conversations, `${active.id}.conversation.json`);
  const before = fs.readFileSync(file, 'utf8');
  const reads = f.state.pageReads;
  const second = await f.bind();
  assert.equal(second.id, active.id);
  assert.equal(second.prefix.prefixId, active.prefix.prefixId);
  assert.equal(f.state.pageReads, reads); // pure local read
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(f.files().length, 2); // source + adopted only
  assert.equal(pending.prefix.state, 'pending'); // the returned earlier view is a snapshot
});

test('exactly two messages are required: a third rendered message never adopts', async (t) => {
  const base = rawPage();
  const extra = { role: 'user', id: 'user-2', text: 'second prompt', chars: 13, idSource: 'data-message-id' };
  const f = workspace(t, { page: { ...base, renderedTotal: 3, messages: [...base.messages, extra] } });
  await assert.rejects(f.bind(), (e) => e.code === 'PREFIX_PAGE_SHAPE_MISMATCH');
  assert.equal(f.files().length, 1); // only the source snapshot exists: nothing was adopted
});

test('a home tab that does not parse to the thread is not an ambiguous twin; two parsing tabs are', async (t) => {
  // Live shape: one /c/<uuid> tab (identity bound) plus the chatgpt home tab (UNSUPPORTED_PATH).
  const threadTab = { id: 'tab-1', type: 'page', url: `https://chatgpt.com/c/${THREAD}` };
  const homeTab = { id: 'tab-home', type: 'page', url: 'https://chatgpt.com/' };
  const ok = workspace(t, { targets: [threadTab, homeTab] });
  const pending = await ok.bind();
  assert.equal(pending.prefix.target.targetId, 'tab-1');
  assert.equal((await ok.connect()).prefix.state, 'active');
  // Two page targets that parse to the SAME thread ref are the ambiguity the guard refuses.
  const twin = workspace(t, { targets: [threadTab, { ...threadTab, id: 'tab-copy' }] });
  await assert.rejects(twin.bind(), (e) => e.code === 'PREFIX_TARGET_AMBIGUOUS');
  assert.equal(twin.files().length, 1);
});

test('the API route forwards the validated prefix request to the runtime', async (t) => {
  const calls = [];
  const runtime = { async bindObservedPrefix(body) { calls.push(body); return { id: 'adopted', prefix: { state: 'pending' } }; } };
  const api = createConversationApi({ runtime });
  const res = { headers: {}, written: null, setHeader() {}, writeHead(status, headers) { this.status = status; this.headers = headers; }, end(value) { this.written = value; } };
  const body = { site: 'chatgpt', targetId: 'tab-1', expectedThread: `chatgpt-c:${THREAD}`, source: { conversationId: 'harbor-source', attemptId: 'a-1' } };
  const handled = await api.handle({ method: 'POST' }, res, new URL('http://127.0.0.1/api/v1/conversations/prefix'), body);
  assert.equal(handled, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], body);
  assert.equal(JSON.parse(res.written).conversation.id, 'adopted');
  // Unknown fields and a missing source are refused at the boundary, before any runtime call.
  await assert.rejects(api.handle({ method: 'POST' }, res, new URL('http://127.0.0.1/api/v1/conversations/prefix'),
    { ...body, unexpected: true }), (e) => e.status === 400);
  await assert.rejects(api.handle({ method: 'POST' }, res, new URL('http://127.0.0.1/api/v1/conversations/prefix'),
    { site: 'chatgpt', targetId: 'tab-1', expectedThread: `chatgpt-c:${THREAD}` }), (e) => e.status === 400);
  // A wrong method is a normal HTTP refusal written by the route (405 + Allow), not a thrown error:
  // the same contract every other conversation route uses. It must not reach the runtime.
  assert.equal(await api.handle({ method: 'GET' }, res, new URL('http://127.0.0.1/api/v1/conversations/prefix'), {}), true);
  assert.equal(res.status, 405);
  assert.match(JSON.parse(res.written).error, /POST/);
  assert.equal(calls.length, 1);
});
