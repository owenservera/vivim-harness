import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createConversationService } from '../../src/capture/conversation-service.mjs';

const thread = { kind: 'chatgpt-c', id: '11111111-1111-4111-8111-111111111111', ref: 'chatgpt-c:11111111-1111-4111-8111-111111111111' };
const binding = { targetId: 'exact-target', origin: 'https://example.test', ownedByStudio: true, thread };
function fixture(t, overrides = {}, io = fs) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conversation-offline-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const calls = [];
  let sendArgs;
  const observation = (args = sendArgs) => ({ binding: { ...binding }, evidence: {
    turnId: args.turnId, payloadDigest: args.payloadDigest, sessionId: 'session-1', sequence: 11, kind: 'outgoing-request', source: 'network', identity: 'request-1',
  } });
  const adapter = {
    async connect(b) { calls.push('connect'); return { binding: { ...b }, sessionId: 'session-1' }; },
    async preflight(b) { calls.push('preflight'); return { binding: { ...b }, draft: { present: false, chars: 0 }, boundary: { sequence: 10, transcriptCount: 3 } }; },
    async type() { calls.push('type'); },
    async submit(args) { calls.push('submit'); sendArgs = args; return observation(args); },
    async reconcile() { calls.push('reconcile'); return null; },
    async stop() { calls.push('stop'); },
    async closeTab() { calls.push('close'); },
    ...overrides,
  };
  const options = { dataDir, id: 'test-conversation', adapter, io };
  const service = createConversationService(options);
  const connect = (ownedByStudio = true) => service.connect({ ...binding, ownedByStudio, expectedRevision: service.read().revision });
  const submit = (extra = {}) => service.submit({ key: 'key-1', prompt: 'private prompt', confirm: true, expectedRevision: service.read().revision, ...extra });
  return { service, adapter, calls, options, connect, submit, observation };
}
const rejects = (promise, code) => assert.rejects(promise, (e) => e.code === code);

test('connect draft manually cleared then reconcile becomes ready without a turn, followed by one submit', async (t) => {
  let draft = true;
  const f = fixture(t, {
    async connect(b) { return { binding: b, sessionId: 'session-1', readiness: { ready: false, draft: { present: true, chars: 5 }, reason: 'DRAFT_PRESENT' } }; },
    async preflight(b) { return { binding: b, draft: { present: draft, chars: draft ? 5 : 0 }, boundary: { sequence: 10, transcriptCount: 3 } }; },
  });
  await f.connect(); assert.equal(f.service.read().state, 'blocked');
  draft = false;
  const checked = await f.service.reconcile({ expectedRevision: f.service.read().revision });
  assert.equal(checked.state, 'ready'); assert.equal(checked.readiness.ready, true); assert.equal(checked.readiness.draft.chars, 0);
  assert.equal(checked.attempts.length, 0); assert.deepEqual(f.calls, []);
  const turn = await f.submit(); assert.equal(turn.send.state, 'observed');
  assert.equal(f.calls.filter((c) => c === 'submit').length, 1);
});

test('blocked pretyping attempt reconciles readiness only; old key stays blocked and new key sends once', async (t) => {
  let draft = true;
  const f = fixture(t, { async preflight(b) { return { binding: b, draft: { present: draft, chars: draft ? 5 : 0 }, boundary: { sequence: 10, transcriptCount: 3 } }; } });
  await f.connect(); await rejects(f.submit(), 'DRAFT_OR_BINDING_NOT_READY');
  const original = f.service.read().attempts[0]; assert.equal(original.phase, 'blocked');
  draft = false;
  const checked = await f.service.reconcile({ expectedRevision: f.service.read().revision });
  assert.equal(checked.state, 'ready'); assert.equal(checked.readiness.ready, true);
  assert.deepEqual(checked.attempts[0], original); assert.equal(f.calls.includes('reconcile'), false);
  assert.deepEqual(await f.submit(), original); assert.equal(f.calls.includes('type'), false);
  assert.equal((await f.submit({ key: 'manually-resolved' })).send.state, 'observed');
  assert.equal(f.calls.filter((c) => c === 'submit').length, 1);
});

test('readiness refresh fails closed on changed binding or invalid boundary without creating a turn', async (t) => {
  const f = fixture(t); await f.connect();
  for (const preflight of [
    { binding: { ...binding, targetId: 'other' }, draft: { present: false, chars: 0 }, boundary: { sequence: 10, transcriptCount: 3 } },
    { binding, draft: { present: false, chars: 0 }, boundary: { sequence: -1, transcriptCount: 3 } },
    { binding, draft: { present: false, chars: 7 }, boundary: { sequence: 10, transcriptCount: 3 } },
  ]) {
    f.adapter.preflight = async () => preflight;
    const state = await f.service.reconcile({ expectedRevision: f.service.read().revision });
    assert.equal(state.state, 'blocked'); assert.equal(state.readiness.ready, false); assert.equal(state.attempts.length, 0);
  }
  assert.deepEqual(f.calls, ['connect']);
});

test('connect and one turn use named actions; read is local and summary contains no content', async (t) => {
  const f = fixture(t); await f.connect();
  const turn = await f.submit();
  assert.equal(turn.send.state, 'observed');
  assert.deepEqual(f.calls, ['connect', 'preflight', 'type', 'submit']);
  const before = [...f.calls], summary = f.service.read();
  summary.binding.targetId = 'mutated';
  assert.equal(f.service.read().binding.targetId, binding.targetId);
  assert.deepEqual(f.calls, before);
  const persisted = fs.readFileSync(f.service.file, 'utf8');
  assert.equal(persisted.includes('private prompt'), false);
  assert.equal('prompt' in turn, false); assert.equal('reply' in turn && typeof turn.reply === 'string', false);
});

test('concurrent identical submissions return original before stale revision check', async (t) => {
  const f = fixture(t); await f.connect(); const revision = f.service.read().revision;
  const [a, b] = await Promise.all([f.submit({ expectedRevision: revision }), f.submit({ expectedRevision: revision })]);
  assert.deepEqual(a, b); assert.equal(f.calls.filter((v) => v === 'submit').length, 1);
  assert.deepEqual(await f.submit({ expectedRevision: -1 }), a);
});

test('same key changed payload conflicts even with stale revision', async (t) => {
  const f = fixture(t); await f.connect(); await f.submit();
  await rejects(f.submit({ prompt: 'different', expectedRevision: -1 }), 'IDEMPOTENCY_CONFLICT');
  assert.equal(f.calls.filter((v) => v === 'submit').length, 1);
});

test('stale revision and missing confirmation perform no actions', async (t) => {
  const f = fixture(t); await f.connect();
  await rejects(f.submit({ expectedRevision: -1 }), 'STALE_REVISION');
  await rejects(f.submit({ confirm: false }), 'CONFIRM_REQUIRED');
  assert.deepEqual(f.calls, ['connect']); assert.equal(f.service.read().attempts.length, 0);
});

test('different keys cannot bypass unresolved thread admission under concurrency', async (t) => {
  const f = fixture(t); await f.connect();
  const results = await Promise.allSettled([f.submit(), f.submit({ key: 'key-2' })]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  await rejects(f.submit({ key: 'key-3' }), 'THREAD_FENCED');
  assert.equal(f.calls.filter((v) => v === 'type').length, 1);
});

test('intent is synced before connect, typing and dispatch', async (t) => {
  let syncs = 0, f;
  const io = { ...fs, fsyncSync(fd) { syncs++; fs.fsyncSync(fd); } };
  f = fixture(t, {
    async connect(b) { assert.ok(syncs >= 2); assert.equal(JSON.parse(fs.readFileSync(f.service.file)).state, 'attaching'); return { binding: b, sessionId: 'session-1' }; },
    async type() { assert.ok(syncs >= 8); assert.equal(JSON.parse(fs.readFileSync(f.service.file)).attempts[0].phase, 'preparing'); },
    async submit(args) { assert.ok(syncs >= 10); assert.equal(JSON.parse(fs.readFileSync(f.service.file)).attempts[0].phase, 'dispatching'); return f.observation(args); },
  }, io);
  await f.connect(); await f.submit();
});

test('persistence failure before connect causes zero adapter actions and poisons instance', async (t) => {
  const f = fixture(t, {}, { ...fs, fsyncSync() { throw new Error('disk unavailable'); } });
  await rejects(f.connect(), 'PERSISTENCE_FAILED_REOPEN_REQUIRED');
  assert.deepEqual(f.calls, []);
  await rejects(f.connect(), 'PERSISTENCE_FAILED_REOPEN_REQUIRED');
});

test('persistence failure preparing prevents every submission adapter action', async (t) => {
  let fail = false;
  const f = fixture(t, {}, { ...fs, renameSync(...args) { if (fail) throw new Error('disk'); fs.renameSync(...args); } });
  await f.connect(); fail = true;
  await rejects(f.submit(), 'JOURNAL_PERSISTENCE_FAILED_REOPEN_REQUIRED');
  assert.deepEqual(f.calls, ['connect']);
});

test('dispatch persistence failure after typing never invokes send', async (t) => {
  let fail = false;
  const f = fixture(t, { async type() { fail = true; } }, { ...fs, fsyncSync(fd) { if (fail) throw new Error('disk'); fs.fsyncSync(fd); } });
  await f.connect(); await rejects(f.submit(), 'PERSISTENCE_FAILED_REOPEN_REQUIRED');
  assert.equal(f.calls.includes('submit'), false);
  const restarted = createConversationService({ ...f.options, io: fs });
  assert.equal(restarted.read().uncertainty, 'partial-draft-possible');
});

for (const content of ['{broken', 'null', 'false', '{}', '{"version":2}']) {
  test(`corrupt existing journal fails closed: ${content}`, (t) => {
    const f = fixture(t); fs.writeFileSync(f.service.file, content);
    assert.throws(() => createConversationService(f.options), (e) => e.code === 'CORRUPT_OR_UNREADABLE_SNAPSHOT');
    assert.deepEqual(f.calls, []);
  });
}

test('unreadable snapshot is not treated as a fresh conversation', (t) => {
  const f = fixture(t);
  assert.throws(() => createConversationService({ ...f.options, io: { ...fs, readFileSync() { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } } }), /CORRUPT_OR_UNREADABLE/);
  assert.deepEqual(f.calls, []);
});

test('malformed attempt journal and finalization fields fail closed', async (t) => {
  const f = fixture(t); await f.connect(); await f.submit();
  const disk = f.service.read(); f.calls.length = 0;
  for (const mutate of [
    (s) => { s.attempts[0].payloadDigest = 'bad'; },
    (s) => { s.attempts[0].phase = 'invented'; },
    (s) => { s.attempts[0].boundary.sequence = -1; },
    (s) => { delete s.finish.requested; },
  ]) {
    const corrupt = structuredClone(disk); mutate(corrupt); fs.writeFileSync(f.service.file, JSON.stringify(corrupt));
    assert.throws(() => createConversationService(f.options), /CORRUPT_OR_UNREADABLE/);
  }
  assert.deepEqual(f.calls, []);
});

for (const phase of ['preparing', 'dispatching']) {
  test(`restart recovers ${phase} without replay`, async (t) => {
    const f = fixture(t); await f.connect(); await f.submit();
    const disk = f.service.read(); disk.attempts[0].phase = phase; disk.state = 'busy';
    fs.writeFileSync(f.service.file, JSON.stringify(disk));
    f.calls.length = 0;
    const recovered = createConversationService(f.options), state = recovered.read();
    assert.equal(state.state, 'needs-reconciliation');
    assert.equal(state.attempts[0].phase, phase === 'preparing' ? 'needs-reconciliation' : 'uncertain');
    assert.deepEqual(f.calls, []);
    await rejects(recovered.submit({ key: 'different', prompt: 'x', confirm: true, expectedRevision: state.revision }), 'THREAD_FENCED');
    assert.deepEqual(f.calls, []);
  });
}

for (const change of ['draft', 'target', 'origin', 'unknown-draft']) {
  test(`immediate preflight ${change} change prevents typing and send`, async (t) => {
    const f = fixture(t, { async preflight(b) {
      return { binding: { ...b, ...(change === 'target' ? { targetId: 'other-target' } : change === 'origin' ? { origin: 'https://other.test' } : {}) },
        draft: change === 'unknown-draft' ? {} : { present: change === 'draft', chars: change === 'draft' ? 4 : 0 }, boundary: { sequence: 1, transcriptCount: 0 } };
    } });
    await f.connect(); await rejects(f.submit(), 'DRAFT_OR_BINDING_NOT_READY');
    assert.equal(f.calls.includes('type'), false); assert.equal(f.calls.includes('submit'), false);
  });
}

test('lost ack stays uncertain, duplicate never retries, finish preserves Studio tab and restart uncertainty', async (t) => {
  let sends = 0;
  const f = fixture(t, { async submit() { sends++; throw new Error('lost acknowledgement SECRET'); } });
  await f.connect(); const result = await f.submit();
  assert.equal(result.send.state, 'uncertain');
  assert.deepEqual(await f.submit(), result); assert.equal(sends, 1);
  await f.service.finish({ closeTab: true });
  assert.equal(f.calls.includes('close'), false);
  const restarted = createConversationService(f.options);
  assert.equal(restarted.read().attempts[0].send.state, 'uncertain');
  assert.equal(restarted.read().uncertainty, 'send-acknowledgement-lost');
  assert.equal(fs.readFileSync(f.service.file, 'utf8').includes('SECRET'), false);
});

test('uncertain send blocks fresh keys even after a read-only check finds no confirmation', async (t) => {
  let sends = 0;
  const f = fixture(t, { async submit() { sends++; return null; }, async reconcile() { return null; } });
  await f.connect();
  const uncertain = await f.submit();
  assert.equal(uncertain.send.state, 'uncertain');
  await rejects(f.submit({ key: 'deliberate-new-key' }), 'THREAD_FENCED');
  const observed = await f.service.reconcile({ expectedRevision: f.service.read().revision });
  assert.equal(observed.attempts[0].send.state, 'uncertain');
  await rejects(f.submit({ key: 'another-key' }), 'THREAD_FENCED');
  assert.equal(sends, 1, 'no second external dispatch');
});

test('partial typing failure requires reconciliation and never sends or closes', async (t) => {
  const f = fixture(t, { async type() { throw new Error('partial'); } });
  await f.connect(); await rejects(f.submit(), 'TYPING_INTERRUPTED');
  await f.service.finish({ closeTab: true });
  assert.equal(f.calls.includes('submit'), false); assert.equal(f.calls.includes('close'), false);
  assert.equal(f.service.read().uncertainty, 'partial-draft-possible');
});

test('assertions, old DOM, unrelated streams and mismatched bindings cannot prove a send', async (t) => {
  let candidate;
  const f = fixture(t, { async submit() { return null; }, async reconcile() { return candidate; } });
  await f.connect(); const a = await f.submit();
  const good = f.observation({ turnId: a.id, payloadDigest: a.payloadDigest });
  const invalid = [null,
    { ...good, binding: { ...binding, targetId: 'other' } },
    { ...good, binding: { ...binding, origin: 'https://other.test' } },
    ...[{ sequence: 10 }, { turnId: 'old-turn' }, { payloadDigest: 'bad' }, { sessionId: 'other-session' },
      { kind: 'response-stream' }, { source: 'user-asserted' }].map((patch) => ({ ...good, evidence: { ...good.evidence, ...patch } })),
  ];
  for (candidate of invalid) {
    const state = await f.service.reconcile({ expectedRevision: f.service.read().revision, assertion: true });
    assert.equal(state.attempts[0].send.state, 'uncertain');
  }
  candidate = good;
  const state = await f.service.reconcile({ expectedRevision: f.service.read().revision });
  assert.equal(state.attempts[0].send.state, 'observed');
  assert.equal(state.uncertainty, null);
  assert.ok(state.assertions.every((a) => a.provenance === 'user-asserted'));
});

test('preparing crash cannot be promoted even by a fabricated matching send observation', async (t) => {
  const f = fixture(t); await f.connect(); const a = await f.submit();
  const disk = f.service.read(); disk.attempts[0].phase = 'preparing'; fs.writeFileSync(f.service.file, JSON.stringify(disk));
  f.adapter.reconcile = async () => f.observation({ turnId: a.id, payloadDigest: a.payloadDigest });
  const restarted = createConversationService(f.options);
  const state = await restarted.reconcile({ expectedRevision: restarted.read().revision });
  assert.equal(state.attempts[0].send.state, 'not-attempted');
});

test('failed stop prevents close and finish shares one promise/outcome without retry', async (t) => {
  let stops = 0;
  const f = fixture(t, { async stop() { stops++; throw new Error('stop failed'); } });
  await f.connect();
  const a = f.service.finish({ closeTab: true }), b = f.service.finish({ closeTab: true });
  assert.equal(a, b);
  const result = await a;
  assert.equal(result.finish.error, 'CAPTURE_STOP_FAILED'); assert.equal(stops, 1);
  assert.equal(f.calls.includes('close'), false);
  await f.service.finish({ closeTab: true }); assert.equal(stops, 1);
  const restarted = createConversationService(f.options); await restarted.finish({ closeTab: true }); assert.equal(stops, 1);
});

test('finish stops once before closing safe Studio tab; blocks submit after finish', async (t) => {
  const f = fixture(t); await f.connect(); await f.submit();
  const a = f.service.finish({ closeTab: true }); assert.equal(a, f.service.finish({ closeTab: true })); await a;
  assert.deepEqual(f.calls.slice(-2), ['stop', 'close']);
  await rejects(f.submit({ key: 'new-key' }), 'CONVERSATION_FINISHED');
  const replay = await f.submit(); // same key + payload: original turn, read-only, no second dispatch
  assert.equal(replay.id, f.service.read().attempts[0].id); assert.equal(f.calls.filter((c) => c === 'submit').length, 1);
  await rejects(f.submit({ prompt: 'different payload' }), 'IDEMPOTENCY_CONFLICT');
  assert.equal(f.service.read().attempts[0].evidence.state, 'incomplete');
  const restarted = createConversationService(f.options); await restarted.finish({ closeTab: true });
  assert.equal(f.calls.filter((c) => c === 'stop').length, 1); assert.equal(f.calls.filter((c) => c === 'close').length, 1);
});

test('owner tab is never closed, even on explicit finish close request', async (t) => {
  const f = fixture(t); await f.connect(false); await f.submit(); await f.service.finish({ closeTab: true });
  assert.equal(f.calls.includes('close'), false); assert.equal(f.calls.includes('stop'), true);
});

test('attachment ownership mismatch cannot authorize closing owner tab', async (t) => {
  const f = fixture(t, { async connect(b) { return { binding: { ...b, ownedByStudio: false }, sessionId: 'session-1' }; } });
  await rejects(f.connect(), 'INVALID_ATTACHMENT'); await f.service.finish({ closeTab: true });
  assert.equal(f.calls.includes('close'), false);
});

test('restart during stop or close never repeats either action', async (t) => {
  for (const phase of ['stopping', 'stopped', 'closing']) {
    const f = fixture(t); await f.connect();
    const disk = f.service.read(); disk.finish = { requested: true, phase, error: null }; disk.state = 'finalizing';
    fs.writeFileSync(f.service.file, JSON.stringify(disk)); f.calls.length = 0;
    const restarted = createConversationService(f.options); await restarted.finish({ closeTab: true });
    assert.deepEqual(f.calls, []); assert.equal(restarted.read().finish.phase, 'interrupted');
    await rejects(restarted.submit({ key: 'k', prompt: 'x', confirm: true, expectedRevision: restarted.read().revision }), 'CONVERSATION_FINISHED');
  }
});

test('F1 service: coded notDispatched error records not-attempted, never uncertain; uncoded/ambiguous errors stay uncertain; one dispatch each', async (t) => {
  for (const [error, send, phase] of [
    [Object.assign(new Error('x'), { code: 'SEND_NOT_DISPATCHED', notDispatched: true }), 'not-attempted', 'needs-reconciliation'],
    [Object.assign(new Error('x'), { notDispatched: true }), 'uncertain', 'uncertain'],
    [Object.assign(new Error('x'), { code: 'SEND_NOT_DISPATCHED' }), 'uncertain', 'uncertain'],
    [new Error('transport lost'), 'uncertain', 'uncertain'],
  ]) {
    const f = fixture(t, { async submit() { f.calls.push('submit'); throw error; } });
    await f.connect(); const turn = await f.submit();
    assert.equal(turn.send.state, send); assert.equal(turn.phase, phase); assert.equal(f.service.read().state, 'needs-reconciliation');
    assert.equal(f.calls.filter((c) => c === 'submit').length, 1);
    if (send === 'not-attempted') assert.equal(f.service.read().attempts[0].reason, 'SEND_NOT_DISPATCHED');
  }
});

for (const stopAt of ['registered', 'awaiting-preflight']) test(`stop at ${stopAt} positively proves no effects and permits a new conversation/key after finish`, async (t) => {
  let entered, release;
  const entering = new Promise((resolve) => { entered = resolve; });
  const waiting = new Promise((resolve) => { release = resolve; });
  const f = fixture(t, stopAt === 'awaiting-preflight' ? { async preflight(b) {
    f.calls.push('preflight'); entered(); await waiting;
    return { binding: b, draft: { present: false, chars: 0 }, boundary: { sequence: 10, transcriptCount: 3 } };
  } } : {});
  await f.connect();
  const pending = f.service.submit({ key: 'stopped-key', prompt: 'synthetic stopped', confirm: true, expectedRevision: f.service.read().revision },
    { registered: () => { if (stopAt === 'registered') f.service.stopSubmission(); } });
  if (stopAt === 'awaiting-preflight') { await entering; f.service.stopSubmission(); release(); }
  const stopped = await pending;
  assert.equal(stopped.journal.phase, 'blocked');
  assert.equal(stopped.journal.preEffect.typing, 'not-executed');
  assert.equal(stopped.journal.preEffect.dispatch, 'not-executed');
  assert.equal(stopped.send.state, 'not-attempted'); assert.equal(stopped.typingStartedAt, undefined);
  assert.equal(f.calls.includes('type'), false); assert.equal(f.calls.includes('submit'), false);
  await f.service.finish();
  const next = createConversationService({ ...f.options, id: `after-${stopAt}` });
  await next.connect({ ...binding, expectedRevision: 0 });
  const sent = await next.submit({ key: 'genuinely-new-key', prompt: 'synthetic follow-up', confirm: true, expectedRevision: next.read().revision });
  assert.equal(sent.send.state, 'observed');
  assert.equal(f.calls.filter((c) => c === 'type').length, 1); assert.equal(f.calls.filter((c) => c === 'submit').length, 1);
});

test('stop after typing intent/effect never receives pre-effect proof and remains fenced after finish/new record', async (t) => {
  const f = fixture(t, { async type() { f.calls.push('type'); f.service.stopSubmission(); } });
  await f.connect(); const stopped = await f.submit();
  assert.equal(stopped.phase, 'needs-reconciliation'); assert.ok(stopped.typingStartedAt);
  assert.equal(stopped.journal.preEffect, null); assert.notEqual(stopped.journal.phase, 'blocked');
  assert.equal(f.service.read().uncertainty, 'partial-draft-possible');
  assert.equal(f.calls.includes('submit'), false);
  await f.service.finish();
  const next = createConversationService({ ...f.options, id: 'after-posttyping-stop' });
  await next.connect({ ...binding, expectedRevision: 0 });
  await rejects(next.submit({ key: 'new-key', prompt: 'synthetic follow-up', confirm: true, expectedRevision: next.read().revision }), 'THREAD_FENCED');
  assert.equal(f.calls.filter((c) => c === 'type').length, 1); assert.equal(f.calls.includes('submit'), false);
});
