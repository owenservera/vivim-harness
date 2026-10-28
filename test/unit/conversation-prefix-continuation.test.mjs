// Observed-prefix continuation — spec §11.2: turns 2–3 are ordinary submits, gated by prefix state
// and by the adapter's same-read prefix audit. A failed audit blocks pre-effect and invalidates.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import { workspace, REPLY, TURN2 } from './conversation-prefix-fixture.mjs';

const wrapPreflight = (adapter, mutate) => {
  const real = adapter.preflight.bind(adapter);
  adapter.preflight = async (binding, options = {}) => mutate(await real(binding, options), options);
};

test('a pending prefix refuses submit before any browser work; activation admits the same submit', async (t) => {
  const f = workspace(t, { appendOnSend: true, appendReply: true });
  const pending = await f.bind();
  await assert.rejects(f.submit(pending), (e) => e.code === 'PREFIX_NOT_ACTIVE');
  assert.equal(f.state.adapters.length, 1);
  assert.equal(f.state.sends, 0);
  const active = await f.connect();
  const sent = await f.submit(active);
  assert.equal(f.state.sends, 1);
  assert.equal(sent.turn.send.state, 'observed');
});

test('the adapter receives the prefix descriptor in the same preflight read it audits', async (t) => {
  const f = workspace(t, { appendOnSend: true, appendReply: true });
  await f.bind();
  const active = await f.connect();
  let seen;
  wrapPreflight(f.state.adapters[0], (result, options) => { seen = options.prefix; return result; });
  await f.submit(active);
  assert.deepEqual(seen, { userMessageId: 'user-1', userMessageDigest: active.prefix.userMessage.digest,
    assistantMessageId: 'assistant-1', assistantDigest: active.prefix.assistant.digest, assistantChars: REPLY.length });
});

test('a missing prefix audit is refused before effect (PREFIX_AUDIT_REQUIRED), never dispatched', async (t) => {
  const f = workspace(t);
  await f.bind();
  const active = await f.connect();
  wrapPreflight(f.state.adapters[0], (result) => { delete result.prefixAudit; return result; });
  await assert.rejects(f.submit(active), (e) => e.code === 'PREFIX_AUDIT_REQUIRED');
  assert.equal(f.state.sends, 0);
  assert.equal(f.state.insertions, 0);
  const disk = JSON.parse(fs.readFileSync(path.join(f.conversations, `${active.id}.conversation.json`), 'utf8'));
  assert.equal(disk.attempts.at(-1).phase, 'blocked');
  assert.equal(disk.attempts.at(-1).send.state, 'not-attempted');
  assert.equal(disk.prefix.state, 'active'); // an adapter omission is not evidence the page changed
});

test('a changed reply blocks pre-effect with PREFIX_REPLY_CHANGED, invalidates the prefix and stops every later send', async (t) => {
  const f = workspace(t);
  await f.bind();
  const active = await f.connect();
  f.state.messages[1] = { ...f.state.messages[1], text: `${REPLY} edited later` };
  await assert.rejects(f.submit(active), (e) => e.code === 'PREFIX_AUDIT_FAILED' && e.reason === 'PREFIX_REPLY_CHANGED');
  assert.equal(f.state.sends, 0);
  assert.equal(f.state.insertions, 0);
  const invalid = await f.runtime.get(active.id);
  assert.equal(invalid.prefix.state, 'invalidated');
  assert.equal(invalid.prefix.reason, 'PREFIX_REPLY_CHANGED');
  assert.equal(invalid.turn.phase, 'blocked');
  await assert.rejects(f.submit(invalid, { key: 'three' }), (e) => e.code === 'PREFIX_INVALIDATED');
  assert.equal(f.state.sends, 0);
});

test('a deleted user turn blocks pre-effect with PREFIX_USER_MESSAGE_MISSING', async (t) => {
  const f = workspace(t);
  await f.bind();
  const active = await f.connect();
  f.state.messages.splice(0, 1); // the observed turn-1 user message is gone
  await assert.rejects(f.submit(active), (e) => e.code === 'PREFIX_AUDIT_FAILED' && e.reason === 'PREFIX_USER_MESSAGE_MISSING');
  assert.equal(f.state.sends, 0);
  assert.equal((await f.runtime.get(active.id)).prefix.state, 'invalidated');
});

test('turn 1 is never a journal turn: the journal holds exactly the delivered turn 2', async (t) => {
  const f = workspace(t, { appendOnSend: true, appendReply: true });
  await f.bind();
  const active = await f.connect();
  await f.submit(active);
  const journalDir = path.join(f.conversations, 'thread-turns');
  // The journal directory also holds the lock subdirectory; count only durable journal snapshots.
  const files = fs.readdirSync(journalDir).filter((name) => name.endsWith('.turn-journal.json'));
  assert.equal(files.length, 1);
  const journal = JSON.parse(fs.readFileSync(path.join(journalDir, files[0]), 'utf8'));
  // Durable journal files are a checksummed envelope: the turn log lives in `snapshot`.
  const { snapshot } = journal;
  assert.equal(snapshot.turns.length, 1);
  assert.equal(snapshot.turns[0].key, 'two');
  assert.equal(snapshot.turns[0].delivery.state, 'observed');
  assert.notEqual(snapshot.turns[0].payloadDigest, active.prefix.prompt.digest); // it is turn 2, not turn 1
  assert.equal(JSON.stringify(snapshot).includes('user-1'), false); // the prefix message id is not journal evidence
  assert.equal(JSON.stringify(snapshot).includes(TURN2), false); // no prompt bodies in the journal
});
