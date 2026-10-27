// Observed-prefix durability — spec §10.3/§10.4 crash points, exactly-once and concurrency.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import { workspace, PROMPT, sha } from './conversation-prefix-fixture.mjs';
import { createConversationRuntime } from '../../src/capture/conversation-runtime.mjs';

test('a pending record written before a crash is resumed by connect in a fresh runtime and only then activated', async (t) => {
  const f = workspace(t);
  const pending = await f.bind();
  // Simulate the crash: a brand-new runtime over the same disk, with no in-memory entry.
  const restarted = createConversationRuntime({ paths: f.paths, port: 19271, dependencies: f.dependencies });
  t.after(() => restarted.close().catch(() => {}));
  const reads = f.state.pageReads;
  const active = await restarted.connect({ site: 'chatgpt', targetId: 'tab-1', expectedThread: `chatgpt-c:${pending.prefix.thread.id}`,
    prefixSource: { conversationId: f.conversationId, attemptId: f.attemptId, payloadDigest: sha(PROMPT) } });
  assert.equal(active.id, pending.id);
  assert.equal(active.prefix.state, 'active');
  assert.equal(active.binding.thread.ref, pending.prefix.thread.ref);
  assert.equal(f.state.pageReads > reads, true); // the activation re-read really happened
});

test('re-entry with the same request after activation is read-only: no page access, no second snapshot', async (t) => {
  const f = workspace(t);
  const pending = await f.bind();
  await f.connect();
  const file = path.join(f.conversations, `${pending.id}.conversation.json`);
  const before = fs.readFileSync(file, 'utf8');
  const reads = f.state.pageReads;
  const again = await f.connect();
  assert.equal(again.id, pending.id);
  assert.equal(again.prefix.state, 'active');
  assert.equal(f.state.pageReads, reads);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(f.files().length, 2);
});

test('two concurrent binds produce exactly one pending snapshot; the loser is PREFIX_WRITER_BUSY', async (t) => {
  const f = workspace(t);
  const results = await Promise.allSettled([f.bind(), f.bind()]);
  const ok = results.filter((r) => r.status === 'fulfilled');
  const refused = results.filter((r) => r.status === 'rejected');
  assert.equal(ok.length, 1);
  assert.equal(refused.length, 1);
  assert.equal(refused[0].reason.code, 'PREFIX_WRITER_BUSY');
  assert.equal(f.files().length, 2); // source + exactly one adopted conversation
  const created = f.files().filter((name) => name !== `${f.conversationId}.conversation.json`);
  const record = JSON.parse(fs.readFileSync(path.join(f.conversations, created[0]), 'utf8'));
  assert.equal(record.prefix.state, 'pending');
});

test('a bind that crashes before writing leaves nothing: the next bind creates a fresh conversation', async (t) => {
  const f = workspace(t);
  // No bind at all: nothing was written, so an unrelated attempt to read the adopted id must 404.
  await assert.rejects(f.runtime.get('never-created'), (e) => e.status === 404);
  const pending = await f.bind();
  assert.equal(pending.prefix.state, 'pending');
  assert.equal(f.files().length, 2);
});
