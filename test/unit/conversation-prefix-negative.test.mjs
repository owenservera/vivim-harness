// Observed-prefix adoption — spec §8 fail-closed refusals. Every case asserts the exact code and
// that a refusal writes nothing: no new conversation file, no journal, no prefix.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { workspace, rawPage, OTHER_THREAD, PROMPT, REPLY, THREAD, sha } from './conversation-prefix-fixture.mjs';
import { acquireDriveLease } from '../../src/capture/drive-lease.mjs';

const pageWith = (fn) => { const base = rawPage(); return fn(base); };
const userText = (text) => pageWith((p) => ({ ...p, messages: [{ ...p.messages[0], text, chars: text.length }, p.messages[1]] }));

const otherConversation = (id, threadRef) => ({ id, snapshot: { version: 1, id, revision: 1, state: 'closed', sessionId: null,
  binding: { targetId: 'tab-9', origin: 'https://chatgpt.com', ownedByStudio: true,
    thread: { kind: 'chatgpt-c', id: threadRef.slice('chatgpt-c:'.length), ref: threadRef } },
  identity: { state: 'bound', reason: null }, attempts: [], assertions: [], uncertainty: null,
  finish: { requested: true, phase: 'done', error: null }, createdAt: '2026-10-27T08:00:00.000Z', updatedAt: '2026-10-27T08:00:00.000Z' } });

const twoTargets = [{ id: 'tab-1', type: 'page', url: `https://chatgpt.com/c/${THREAD}` },
  { id: 'tab-2', type: 'page', url: `https://chatgpt.com/c/${OTHER_THREAD}` }];

const cases = [
  ['a target that is not in the live target list', 'PREFIX_TARGET_NOT_FOUND', (t) => workspace(t), (f) => f.bind({ targetId: 'missing' })],
  ['a matching target id that is not a page', 'PREFIX_TARGET_NOT_PAGE', (t) => workspace(t, {
    targets: [{ id: 'tab-1', type: 'service_worker', url: `https://chatgpt.com/c/${THREAD}` }] }), (f) => f.bind()],
  ['a target on another origin', 'PREFIX_TARGET_ORIGIN_MISMATCH', (t) => workspace(t, {
    targets: [{ id: 'tab-1', type: 'page', url: `https://example.com/c/${THREAD}` }] }), (f) => f.bind()],
  ['a target whose path is not a supported thread', 'PREFIX_TARGET_URL_UNSUPPORTED', (t) => workspace(t, {
    targets: [{ id: 'tab-1', type: 'page', url: 'https://chatgpt.com/g/abc-project' }] }), (f) => f.bind()],
  ['an expectedThread that names another thread', 'PREFIX_THREAD_ID_MISMATCH', (t) => workspace(t),
    (f) => f.bind({ expectedThread: `chatgpt-c:${OTHER_THREAD}` })],
  ['a target URL with query junk after the thread id', 'PREFIX_THREAD_ID_MISMATCH', (t) => workspace(t, {
    targets: [{ id: 'tab-1', type: 'page', url: `https://chatgpt.com/c/${THREAD}?model=gpt-5` }] }), (f) => f.bind()],
  ['two page targets that parse to the same thread', 'PREFIX_TARGET_AMBIGUOUS', (t) => workspace(t, {
    targets: [{ id: 'tab-1', type: 'page', url: `https://chatgpt.com/c/${THREAD}` },
      { id: 'tab-copy', type: 'page', url: `https://chatgpt.com/c/${THREAD}` }] }), (f) => f.bind()],
  ['a page whose own location is another thread', 'PREFIX_PAGE_THREAD_MISMATCH', (t) => workspace(t, {
    page: rawPage({ pathname: `/c/${OTHER_THREAD}` }) }), (f) => f.bind()],
  ['a page read that returns no transcript', 'PREFIX_PAGE_UNREADABLE', (t) => workspace(t, { pages: [{}] }), (f) => f.bind()],
  ['a page that renders one message instead of the observed two', 'PREFIX_PAGE_SHAPE_MISMATCH', (t) => workspace(t, {
    page: pageWith((p) => ({ ...p, renderedTotal: 1, messages: [p.messages[0]] })) }), (f) => f.bind()],
  ['a page where older history may exist', 'PREFIX_PAGE_HISTORY_INCOMPLETE', (t) => workspace(t, {
    page: rawPage({ scroll: { found: true, topReached: false, bottomReached: true } }) }), (f) => f.bind()],
  ['a page whose first message is not the user turn', 'PREFIX_USER_TURN_MISSING', (t) => workspace(t, {
    page: pageWith((p) => ({ ...p, messages: [{ ...p.messages[0], role: 'assistant' }, p.messages[1]] })) }), (f) => f.bind()],
  ['a user turn without a native message id', 'PREFIX_USER_TURN_ID_MISSING', (t) => workspace(t, {
    page: pageWith((p) => ({ ...p, messages: [{ role: 'user', text: PROMPT, chars: PROMPT.length }, p.messages[1]] })) }), (f) => f.bind()],
  ['a second message that is not the assistant reply', 'PREFIX_REPLY_MISSING', (t) => workspace(t, {
    page: pageWith((p) => ({ ...p, messages: [p.messages[0], { ...p.messages[1], role: 'user' }] })) }), (f) => f.bind()],
  ['a page user text that contradicts the corroborated prompt digest', 'PREFIX_PAGE_TEXT_MISMATCH', (t) => workspace(t, {
    page: userText('a different prompt') }), (f) => f.bind()],
  ['no KV, no attestation and a page text that cannot be proven', 'PREFIX_PROMPT_UNVERIFIED', (t) => workspace(t, {
    kv: 'absent', page: userText('a different prompt') }), (f) => f.bind()],
  ['generation controls that are not positively idle', 'PREFIX_CONTROLS_NOT_IDLE', (t) => workspace(t, {
    page: rawPage({ controls: { observed: true, state: 'busy', idleControlPresent: false, stopPresent: true, composerEnabled: true } }) }), (f) => f.bind()],
  ['a composer that still holds a draft', 'PREFIX_DRAFT_PRESENT', (t) => workspace(t, {
    page: rawPage({ draft: { present: true, chars: 3 } }) }), (f) => f.bind()],
  // `chars` must equal the rendered length: a shape-invalid read is refused as unreadable before the
  // stability comparison, so the changed reply has to stay a well-formed page.
  ['an assistant reply that changes inside the stability window', 'PREFIX_REPLY_UNSTABLE', (t) => workspace(t, {
    pages: [rawPage(), pageWith((p) => { const text = `${REPLY} Also: no cloud.`;
      return { ...p, messages: [p.messages[0], { ...p.messages[1], text, chars: text.length }] }; })] }), (f) => f.bind()],
  ['a target that changes between the two reads', 'PREFIX_TARGET_CHANGED', (t) => workspace(t, {
    afterRead: (n, state) => { if (n === 1) state.targets = [{ id: 'tab-1', type: 'page', url: 'https://chatgpt.com/' }]; } }), (f) => f.bind()],
  ['a thread named in a snapshot denylist', 'PREFIX_THREAD_DENYLISTED', (t) => workspace(t, {
    sourcePatch: { threadDenylist: [`chatgpt-c:${THREAD}`] } }), (f) => f.bind()],
  ['a thread already bound by another conversation', 'PREFIX_THREAD_BOUND_ELSEWHERE', (t) => workspace(t, {
    extraConversations: [otherConversation('other-conv', `chatgpt-c:${THREAD}`)] }), (f) => f.bind()],
  ['a missing source conversation', 'PREFIX_SOURCE_MISSING', (t) => workspace(t, { bound: false }), (f) => f.bind()],
  ['a corrupt source conversation', 'PREFIX_SOURCE_CORRUPT', (t) => workspace(t, { corruptSource: true }), (f) => f.bind()],
  ['an attempt id the source does not contain', 'PREFIX_SOURCE_ATTEMPT_MISSING', (t) => workspace(t),
    (f) => f.bind({ source: { conversationId: f.conversationId, attemptId: '00000000-0000-4000-8000-00000000000b' } })],
  ['an attempt that is not the creation attempt', 'PREFIX_SOURCE_ATTEMPT_NOT_CREATION', (t) => workspace(t, {
    attemptPatch: { creation: false } }), (f) => f.bind()],
  ['a source holding more than one attempt', 'PREFIX_SOURCE_ATTEMPTS_AMBIGUOUS', (t) => workspace(t, {
    sourcePatch: { attempts: [{ id: '00000000-0000-4000-8000-00000000000a', key: 'one', payloadDigest: sha(PROMPT), phase: 'uncertain',
      createdAt: '2026-10-27T09:00:00.000Z', updatedAt: '2026-10-27T09:00:00.000Z', creation: true, boundary: { sequence: 3, transcriptCount: 0 },
      send: { state: 'uncertain', observationSource: null }, reply: { state: 'unknown', source: 'page', text: '', completion: 'unknown' },
      evidence: { state: 'recording' }, preEffect: null },
    { id: '00000000-0000-4000-8000-00000000000c', key: 'two', payloadDigest: sha('x'), phase: 'blocked',
      createdAt: '2026-10-27T09:00:00.000Z', updatedAt: '2026-10-27T09:00:00.000Z', creation: false, boundary: null,
      send: { state: 'not-attempted', observationSource: null }, reply: { state: 'unknown', source: 'page', text: '', completion: 'unknown' },
      evidence: { state: 'recording' }, preEffect: null }] } }), (f) => f.bind()],
  ['a KV record that contradicts the snapshot attempt', 'PREFIX_SOURCE_KV_MISMATCH', (t) => workspace(t, { kv: 'mismatch' }), (f) => f.bind()],
  ['an unreadable KV record', 'PREFIX_SOURCE_KV_MISMATCH', (t) => workspace(t, { kv: 'corrupt' }), (f) => f.bind()],
  ['an attempt whose recorded phase is not uncertain', 'PREFIX_SOURCE_STATE_UNEXPECTED', (t) => workspace(t, {
    attemptPatch: { phase: 'observed' } }), (f) => f.bind()],
  ['a settled capture owned by another conversation', 'PREFIX_SESSION_OWNER_MISMATCH', (t) => workspace(t, {
    sessionPatch: { conversationOwner: { conversationId: 'other', pid: 1, token: null, port: 1 } } }), (f) => f.bind()],
  ['a capture session that is still recording', 'PREFIX_SESSION_STILL_RECORDING', (t) => workspace(t, { sourceStatus: 'recording' }), (f) => f.bind()],
  ['a capture session that is stopping', 'PREFIX_SESSION_STILL_RECORDING', (t) => workspace(t, { sourceStatus: 'stopping' }), (f) => f.bind()],
  ['a settled session without terminal metadata', 'PREFIX_SESSION_METADATA_INVALID', (t) => workspace(t, {
    sessionPatch: { endedAt: undefined } }), (f) => f.bind()],
  ['a source whose capture session file is missing', 'PREFIX_SOURCE_MISSING', (t) => workspace(t, { session: 'absent' }), (f) => f.bind()],
  ['a writer window already held by another host operation', 'PREFIX_WRITER_BUSY', (t) => workspace(t), async (f) => {
    const lease = acquireDriveLease({ root: f.leaseRoot, port: 19271, holder: { kind: 'test', id: 'other' } });
    try { return await f.bind(); } finally { lease.release(); }
  }],

];

for (const [name, code, make, run] of cases) {
  test(`refuses ${code}: ${name}`, async (t) => {
    const f = make(t);
    const before = f.files();
    await assert.rejects(run(f), (e) => e.code === code);
    assert.deepEqual(f.files(), before); // a refusal writes nothing
    assert.equal(f.state.sends, 0);
  });
}

// These three refusals intentionally follow a SUCCESSFUL first-stage bind. Snapshot after
// staging, not before: a rejected second action must leave existing stored bytes unchanged.
const storedFiles = (f) => Object.fromEntries(f.files().map((name) =>
  [name, fs.readFileSync(f.conversations + '/' + name, 'utf8')]));

test('refuses PREFIX_IDEMPOTENCY_CONFLICT without mutating the staged prefix', async (t) => {
  const f = workspace(t);
  await f.bind();
  const before = storedFiles(f);
  await assert.rejects(f.bind({ promptAttestation: PROMPT + ' ' }), (e) => e.code === 'PREFIX_IDEMPOTENCY_CONFLICT');
  assert.deepEqual(storedFiles(f), before);
  assert.equal(f.state.sends, 0);
});

test('refuses PREFIX_PENDING_UNRESOLVED without mutating an already-corrupt staged record', async (t) => {
  const f = workspace(t);
  const pending = await f.bind();
  const file = f.conversations + '/' + pending.id + '.conversation.json';
  const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
  disk.prefix.preimageDigest = 'f'.repeat(64);
  fs.writeFileSync(file, JSON.stringify(disk));
  const before = storedFiles(f);
  await assert.rejects(f.bind(), (e) => e.code === 'PREFIX_PENDING_UNRESOLVED');
  assert.deepEqual(storedFiles(f), before);
  assert.equal(f.state.sends, 0);
});

test('refuses PREFIX_SOURCE_ALREADY_ADOPTED without mutating the first valid adoption', async (t) => {
  const f = workspace(t, { targets: twoTargets });
  await f.bind();
  const before = storedFiles(f);
  await assert.rejects(f.bind({ targetId: 'tab-2', expectedThread: 'chatgpt-c:' + OTHER_THREAD }),
    (e) => e.code === 'PREFIX_SOURCE_ALREADY_ADOPTED');
  assert.deepEqual(storedFiles(f), before);
  assert.equal(f.state.sends, 0);
});

test('a pending prefix is never sendable; activation drift invalidates it and refuses every later submit', async (t) => {
  const f = workspace(t);
  const pending = await f.bind();
  await assert.rejects(f.submit(pending), (e) => e.code === 'PREFIX_NOT_ACTIVE');
  assert.equal(f.state.sends, 0);
  // The page changes between the pending write and the activation re-read.
  f.state.readPage = () => ({ ...rawPage(), messages: [rawPage().messages[0], { ...rawPage().messages[1], text: `${REPLY} edited`, chars: REPLY.length + 7 }] });
  await assert.rejects(f.connect(), (e) => e.code === 'PREFIX_INVALIDATED');
  const disk = JSON.parse((await import('node:fs')).readFileSync(`${f.conversations}\\${pending.id}.conversation.json`, 'utf8'));
  assert.equal(disk.prefix.state, 'invalidated');
  assert.equal(disk.prefix.reason, 'PREFIX_INVALIDATED');
  assert.equal(disk.prefix.adoptedAt, null);
  const invalid = await f.runtime.get(pending.id);
  assert.equal(invalid.prefix.state, 'invalidated');
  await assert.rejects(f.submit(invalid), (e) => e.code === 'PREFIX_INVALIDATED');
  assert.equal(f.state.sends, 0);
});

test('a prefix snapshot that admits a known sender is corrupt, never trusted', async (t) => {
  const f = workspace(t);
  await f.bind();
  const active = await f.connect();
  const fsMod = await import('node:fs');
  const file = `${f.conversations}\\${active.id}.conversation.json`;
  for (const [field, value] of [['sendActor', 'studio'], ['account', 'owner@example.com'], ['dispatch', 'studio']]) {
    const disk = JSON.parse(fsMod.readFileSync(file, 'utf8'));
    disk.prefix[field] = value;
    fsMod.writeFileSync(file, JSON.stringify(disk));
    await assert.rejects(f.runtime.get(active.id), (e) => e.code === 'PREFIX_CORRUPT_OR_UNREADABLE_SNAPSHOT');
  }
  // A missing prefix on an ordinary conversation stays exactly as before.
  const plain = JSON.parse(fsMod.readFileSync(f.sourceFile, 'utf8'));
  assert.equal(plain.prefix, undefined);
});
