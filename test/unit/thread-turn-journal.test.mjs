import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { canonicalThreadKey, digestTurnPayload, createThreadTurnJournal } from '../../src/capture/thread-turn-journal.mjs';
import { acquireDriveLease } from '../../src/capture/drive-lease.mjs';

const thread = (suffix = '1') => ({ kind: 'chatgpt-c', id: `00000000-0000-0000-0000-${suffix.padStart(12, '0')}`, ref: `chatgpt-c:00000000-0000-0000-0000-${suffix.padStart(12, '0')}` });
const scope = { namespace: 'local-owner', origin: 'https://chatgpt.com', thread: thread() };
const request = (key = 'request-1', conversationId = 'conversation-1') => ({ key, conversationId, payloadDigest: digestTurnPayload('synthetic-fixture') });
const boundary = { sessionId: 'capture-1', sequence: 10, transcriptCount: 2 };
const args = (turn) => ({ turnId: turn.id, expectedRevision: turn.revision });
const delivery = (turn) => ({ turnId: turn.id, payloadDigest: turn.payloadDigest, sessionId: boundary.sessionId, sequence: 11, kind: 'outgoing-request', source: 'network', identity: 'outgoing-1' });
const reply = (turn, revision = 1) => ({ ...delivery(turn), sequence: 12, kind: 'assistant-reply', identity: 'reply-1', revision, contentDigest: digestTurnPayload(`synthetic-reply-${revision}`), chars: 17 });
const completion = (turn, revision = 1) => ({ ...reply(turn, revision), sequence: 13, kind: 'reply-complete' });
const proof = (turn) => ({ turnId: turn.id, payloadDigest: turn.payloadDigest, kind: 'pre-effect-blocked', source: 'actuator-audit', reference: 'audit-1', typing: 'not-executed', dispatch: 'not-executed' });
function readiness(turn) {
  const r = turn.reply.evidence;
  const metadata = { identity: r.identity, revision: r.revision, contentDigest: r.contentDigest, chars: r.chars };
  return { turnId: turn.id, payloadDigest: turn.payloadDigest, sessionId: turn.boundary.sessionId,
    boundarySequence: turn.boundary.sequence, threadKey: canonicalThreadKey(scope), ...metadata,
    sequence: r.sequence + 2, kind: 'interactive-ready', source: 'adapter', rule: 'chatgpt-controls-idle', ruleVersion: 1,
    samples: [{ ...metadata, sequence: r.sequence + 1 }, { ...metadata, sequence: r.sequence + 2 }],
    controls: { observed: true, state: 'idle', idleControlPresent: true, stopPresent: false, composerEnabled: true } };
}
function setup(t, options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'thread-journal-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return { dataDir, journal: createThreadTurnJournal({ dataDir, ...scope, ...options }) };
}
function dispatch(journal, turn) {
  turn = journal.markTyping({ ...args(turn), boundary });
  return journal.markDispatching(args(turn));
}
function pageReply(journal, observeDelivery = true) {
  let turn = dispatch(journal, journal.reserve(request()).turn);
  if (observeDelivery) turn = journal.observeDelivery({ ...args(turn), evidence: { ...delivery(turn), kind: 'new-user-turn', source: 'page' } });
  return journal.recordReply({ ...args(turn), evidence: { ...reply(turn), source: 'page' } });
}
const codeIs = (code) => (e) => e.code === code;

test('canonical exact thread scope includes namespace and origin, never conversation id', () => {
  assert.equal(canonicalThreadKey(scope), canonicalThreadKey({ ...scope, conversationId: 'different' }));
  assert.notEqual(canonicalThreadKey(scope), canonicalThreadKey({ ...scope, namespace: 'another-owner' }));
  assert.notEqual(canonicalThreadKey(scope), canonicalThreadKey({ ...scope, thread: thread('2') }));
  assert.notEqual(canonicalThreadKey(scope), canonicalThreadKey({ ...scope, origin: 'https://other.example' }));
  for (const input of [{ ...scope, thread: null }, { ...scope, thread: { ...thread(), ref: 'wrong' } }, { ...scope, origin: 'https://chatgpt.com/c/anything' }]) {
    assert.throws(() => canonicalThreadKey(input), codeIs('INVALID_THREAD_SCOPE'));
  }
});

test('durable key replay returns original turn read-only across conversation ids; collision conflicts', (t) => {
  const { journal } = setup(t);
  const admission = journal.reserve(request());
  assert.equal(admission.admitted, true);
  const original = admission.turn;
  const bytes = fs.readFileSync(journal.file, 'utf8'), before = fs.statSync(journal.file).mtimeMs;
  assert.deepEqual(journal.reserve(request('request-1', 'conversation-2')), { admitted: false, turn: original });
  assert.equal(fs.readFileSync(journal.file, 'utf8'), bytes);
  assert.equal(fs.statSync(journal.file).mtimeMs, before);
  assert.throws(() => journal.reserve({ ...request(), payloadDigest: digestTurnPayload('different-fixture') }), codeIs('IDEMPOTENCY_CONFLICT'));
  original.phase = 'blocked';
  assert.equal(journal.read().turns[0].phase, 'preparing');
  assert.equal(bytes.includes('synthetic-fixture'), false);
});

test('reservation is durable before an effect, pure reads neither create nor recover files', (t) => {
  const { journal, dataDir } = setup(t);
  assert.deepEqual(fs.readdirSync(dataDir), []);
  assert.equal(journal.read().revision, 0);
  assert.deepEqual(fs.readdirSync(dataDir), []);
  const { turn } = journal.reserve(request());
  assert.equal(turn.phase, 'preparing');
  assert.equal(JSON.parse(fs.readFileSync(journal.file, 'utf8')).snapshot.turns[0].id, turn.id);
  const bytes = fs.readFileSync(journal.file, 'utf8');
  const reopened = createThreadTurnJournal({ dataDir, ...scope });
  assert.equal(reopened.read().turns[0].phase, 'preparing');
  assert.equal(fs.readFileSync(journal.file, 'utf8'), bytes);
  assert.throws(() => reopened.reserve(request('new-key', 'new-conversation')), codeIs('THREAD_FENCED'));
});

test('typing, dispatching and unknown fence same thread across clients, new ids and restart', (t) => {
  for (const phase of ['typing', 'dispatching', 'unknown']) {
    const { journal, dataDir } = setup(t);
    let { turn } = journal.reserve(request());
    turn = journal.markTyping({ ...args(turn), boundary });
    if (phase !== 'typing') turn = journal.markDispatching(args(turn));
    if (phase === 'unknown') turn = journal.markUnknown({ ...args(turn), reason: 'ACK_LOST' });
    assert.equal(journal.read().turns[0].phase, phase);
    for (const client of [journal, createThreadTurnJournal({ dataDir, ...scope })]) {
      assert.throws(() => client.reserve(request('new-key', 'new-conversation')), codeIs('THREAD_FENCED'));
      assert.deepEqual(client.reserve(request()), { admitted: false, turn });
    }
  }
});

test('unrelated threads and namespaces remain independent while one thread is fenced', (t) => {
  const { journal, dataDir } = setup(t);
  journal.markUnknown({ ...args(dispatch(journal, journal.reserve(request()).turn)), reason: 'ACK_LOST' });
  const other = createThreadTurnJournal({ dataDir, ...scope, thread: thread('2') });
  const owner = createThreadTurnJournal({ dataDir, ...scope, namespace: 'another-owner' });
  assert.equal(other.reserve(request()).turn.phase, 'preparing');
  assert.equal(owner.reserve(request()).turn.phase, 'preparing');
  assert.notEqual(other.file, journal.file);
});

test('only explicit proven no-effects can allow a fresh key; not-found and dispatch-only refusal cannot', (t) => {
  const { journal } = setup(t);
  let turn = dispatch(journal, journal.reserve(request()).turn);
  turn = journal.markUnknown({ ...args(turn), reason: 'ACK_LOST' });
  const before = fs.readFileSync(journal.file, 'utf8');
  for (const evidence of [null, { found: false }, { ...proof(turn), kind: 'not-found' }, { ...proof(turn), typing: 'unknown' }, { ...proof(turn), source: 'page' }]) {
    assert.throws(() => journal.provePreEffect({ ...args(turn), evidence }), codeIs('INVALID_PRE_EFFECT_EVIDENCE'));
  }
  assert.equal(fs.readFileSync(journal.file, 'utf8'), before);
  assert.throws(() => journal.reserve(request('new')), codeIs('THREAD_FENCED'));
  const blocked = journal.provePreEffect({ ...args(turn), evidence: proof(turn) });
  assert.equal(blocked.phase, 'blocked');
  assert.deepEqual(journal.reserve(request()), { admitted: false, turn: blocked });
  assert.notEqual(journal.reserve(request('new')).turn.id, turn.id);
});

test('a preflight rejection may be proven before typing and never reuses the blocked key', (t) => {
  const { journal } = setup(t);
  const { turn } = journal.reserve(request());
  const blocked = journal.provePreEffect({ ...args(turn), evidence: proof(turn) });
  assert.throws(() => journal.markTyping({ ...args(blocked), boundary }), codeIs('INVALID_TURN_TRANSITION'));
  assert.deepEqual(journal.reserve(request()), { admitted: false, turn: blocked });
  assert.equal(journal.reserve(request('fresh')).turn.phase, 'preparing');
});

test('delivery requires positive post-boundary attempt-correlated evidence', (t) => {
  const { journal } = setup(t);
  let turn = dispatch(journal, journal.reserve(request()).turn);
  turn = journal.markUnknown({ ...args(turn), reason: 'ACK_LOST' });
  for (const evidence of [null, { found: false }, { ...delivery(turn), sequence: 10 }, { ...delivery(turn), turnId: 'another-turn' }, { ...delivery(turn), sessionId: 'another-capture' }, { ...delivery(turn), payloadDigest: digestTurnPayload('other') }, { ...delivery(turn), kind: 'text-match' }, { ...delivery(turn), source: 'user' }]) {
    assert.throws(() => journal.observeDelivery({ ...args(turn), evidence }), codeIs('INVALID_DELIVERY_EVIDENCE'));
  }
  turn = journal.observeDelivery({ ...args(turn), evidence: delivery(turn) });
  assert.equal(turn.delivery.state, 'observed');
  assert.equal(turn.phase, 'delivered');
  assert.equal(turn.completion.state, 'unknown');
  assert.equal(turn.reply.state, 'unknown');
  assert.throws(() => journal.provePreEffect({ ...args(turn), evidence: proof(turn) }), codeIs('INVALID_TURN_TRANSITION'));
  assert.throws(() => journal.reserve(request('new')), codeIs('THREAD_FENCED'));
});

test('delivery/reply/completion are independent, per-turn evidence; completion alone cannot release fence', (t) => {
  const { journal, dataDir } = setup(t);
  let first = dispatch(journal, journal.reserve(request()).turn);
  first = journal.recordCompletion({ ...args(first), evidence: completion(first) });
  assert.equal(first.completion.state, 'complete');
  assert.equal(first.delivery.state, 'unknown');
  assert.equal(first.reply.state, 'unknown');
  assert.throws(() => journal.reserve(request('new')), codeIs('THREAD_FENCED'));
  first = journal.recordReply({ ...args(first), evidence: reply(first) });
  first = journal.observeDelivery({ ...args(first), evidence: delivery(first) });
  assert.throws(() => journal.reserve(request('new')), codeIs('THREAD_FENCED'));
  first = journal.recordReadiness({ ...args(first), evidence: readiness(first) });
  const { turn: second } = journal.reserve(request('new', 'another-conversation'));
  assert.equal(second.boundary, null);
  assert.equal(second.reply.state, 'unknown');
  assert.equal(second.completion.state, 'unknown');
  const saved = createThreadTurnJournal({ dataDir, ...scope }).read();
  assert.deepEqual(saved.turns[0], first);
  assert.deepEqual(saved.turns[1], second);
  assert.equal('reply' in saved, false);
});

test('reply revisions and outgoing identities cannot migrate between turns or regress', (t) => {
  const { journal } = setup(t);
  let turn = dispatch(journal, journal.reserve(request()).turn);
  turn = journal.recordReply({ ...args(turn), evidence: reply(turn, 2) });
  assert.throws(() => journal.recordReply({ ...args(turn), evidence: reply(turn, 1) }), codeIs('REPLY_REVISION_CONFLICT'));
  assert.throws(() => journal.recordReply({ ...args(turn), evidence: { ...reply(turn, 3), identity: 'another-reply' } }), codeIs('REPLY_IDENTITY_CONFLICT'));
  assert.throws(() => journal.recordCompletion({ ...args(turn), evidence: completion(turn, 1) }), codeIs('REPLY_REVISION_CONFLICT'));
  turn = journal.recordCompletion({ ...args(turn), evidence: completion(turn, 2) });
  assert.throws(() => journal.recordReply({ ...args(turn), evidence: reply(turn, 3) }), codeIs('REPLY_REVISION_CONFLICT'));
  turn = journal.observeDelivery({ ...args(turn), evidence: delivery(turn) });
  assert.throws(() => journal.observeDelivery({ ...args(turn), evidence: { ...delivery(turn), identity: 'another-outgoing' } }), codeIs('DELIVERY_IDENTITY_CONFLICT'));
});

test('outgoing and reply identities already owned by a prior turn cannot be reassigned', (t) => {
  const { journal } = setup(t);
  let first = dispatch(journal, journal.reserve(request()).turn);
  first = journal.observeDelivery({ ...args(first), evidence: delivery(first) });
  first = journal.recordCompletion({ ...args(first), evidence: completion(first) });
  first = journal.recordReply({ ...args(first), evidence: reply(first) });
  journal.recordReadiness({ ...args(first), evidence: readiness(first) });
  const second = dispatch(journal, journal.reserve(request('second')).turn);
  assert.throws(() => journal.observeDelivery({ ...args(second), evidence: delivery(second) }), codeIs('EVIDENCE_IDENTITY_ALREADY_OWNED'));
  assert.throws(() => journal.recordReply({ ...args(second), evidence: reply(second) }), codeIs('EVIDENCE_IDENTITY_ALREADY_OWNED'));
  assert.throws(() => journal.recordCompletion({ ...args(second), evidence: completion(second) }), codeIs('EVIDENCE_IDENTITY_ALREADY_OWNED'));
  assert.equal(journal.read().turns[1].delivery.state, 'unknown');
  assert.throws(() => journal.recordCompletion({ ...args(second), evidence: { ...completion(second), source: 'page', identity: 'new-reply' } }), codeIs('INVALID_COMPLETION_EVIDENCE'));
});

test('stale per-turn revisions and invalid phase changes cannot authorize effects', (t) => {
  const { journal } = setup(t);
  const { turn: old } = journal.reserve(request());
  assert.throws(() => journal.markDispatching(args(old)), codeIs('INVALID_TURN_TRANSITION'));
  assert.throws(() => journal.markTyping({ ...args(old), boundary: { ...boundary, sessionId: '' } }), codeIs('INVALID_BOUNDARY'));
  const current = journal.markTyping({ ...args(old), boundary });
  assert.throws(() => journal.markDispatching(args(old)), codeIs('STALE_REVISION'));
  assert.throws(() => journal.markTyping({ ...args(current), boundary }), codeIs('INVALID_TURN_TRANSITION'));
});

test('page delivery + page reply + qualified adapter readiness admits a distinct follow-up without protocol completion', (t) => {
  const { journal } = setup(t);
  let turn = pageReply(journal);
  assert.throws(() => journal.reserve(request('follow-up')), codeIs('THREAD_FENCED'));
  turn = journal.recordReadiness({ ...args(turn), evidence: readiness(turn) });
  assert.equal(turn.readiness.state, 'ready');
  assert.equal(turn.completion.state, 'unknown');
  assert.equal(turn.reply.evidence.source, 'page');
  const followUp = journal.reserve(request('follow-up', 'another-conversation'));
  assert.equal(followUp.admitted, true);
  assert.notEqual(followUp.turn.id, turn.id);
  assert.deepEqual(followUp.turn.readiness, { state: 'unknown', evidence: null });
});

test('readiness requires versioned rule, exact attribution, stable content metadata and positively observed idle controls', (t) => {
  const { journal } = setup(t);
  const turn = pageReply(journal), valid = readiness(turn);
  const invalid = [null, { found: false }, { ...valid, source: 'user' }, { ...valid, source: 'page' },
    { ...valid, rule: 'dom-quiet' }, { ...valid, ruleVersion: 2 }, { ...valid, threadKey: canonicalThreadKey({ ...scope, thread: thread('2') }) },
    { ...valid, turnId: 'another-turn' }, { ...valid, payloadDigest: digestTurnPayload('other') },
    { ...valid, sessionId: 'another-session' }, { ...valid, boundarySequence: 0 }, { ...valid, identity: 'another-reply' },
    { ...valid, revision: 2 }, { ...valid, contentDigest: digestTurnPayload('other') }, { ...valid, chars: 99 },
    { ...valid, controls: null }, { ...valid, controls: {} }, { ...valid, controls: { ...valid.controls, state: 'busy' } },
    { ...valid, controls: { ...valid.controls, observed: false } }, { ...valid, controls: { ...valid.controls, idleControlPresent: false } },
    { ...valid, controls: { ...valid.controls, stopPresent: true } }, { ...valid, controls: { ...valid.controls, composerEnabled: false } },
    { ...valid, samples: [] }, { ...valid, samples: [valid.samples[0]] },
    { ...valid, samples: [valid.samples[0], { ...valid.samples[1], contentDigest: digestTurnPayload('unstable') }] },
    { ...valid, samples: [valid.samples[0], { ...valid.samples[1], identity: 'unstable' }] },
    { ...valid, samples: [valid.samples[0], { ...valid.samples[1], revision: 2 }] },
    { ...valid, samples: [valid.samples[0], { ...valid.samples[1], chars: 99 }] },
    { ...valid, samples: [valid.samples[0], valid.samples[0]] }, { ...valid, sequence: turn.reply.evidence.sequence }];
  const before = fs.readFileSync(journal.file, 'utf8');
  for (const evidence of invalid) {
    assert.throws(() => journal.recordReadiness({ ...args(turn), evidence }), codeIs('INVALID_READINESS_EVIDENCE'));
    assert.throws(() => journal.reserve(request('follow-up')), codeIs('THREAD_FENCED'));
  }
  assert.equal(fs.readFileSync(journal.file, 'utf8'), before);
  assert.equal(journal.recordReadiness({ ...args(turn), evidence: { ...valid, controls: { ...valid.controls, state: 'terminal' } } }).readiness.state, 'ready');
});

test('unknown delivery refuses readiness and remains fenced despite reply/completion and restart', (t) => {
  const { journal, dataDir } = setup(t);
  let turn = pageReply(journal, false);
  turn = journal.markUnknown({ ...args(turn), reason: 'ACK_LOST' });
  assert.throws(() => journal.recordReadiness({ ...args(turn), evidence: readiness(turn) }), codeIs('INVALID_READINESS_EVIDENCE'));
  turn = journal.recordCompletion({ ...args(turn), evidence: completion(turn) });
  assert.equal(turn.delivery.state, 'unknown');
  assert.equal(turn.readiness.state, 'unknown');
  for (const client of [journal, createThreadTurnJournal({ dataDir, ...scope })]) {
    assert.throws(() => client.reserve(request('follow-up', 'new-conversation')), codeIs('THREAD_FENCED'));
  }
});

test('readiness cannot precede delivery; late delivery requires new post-delivery reply samples', (t) => {
  const { journal } = setup(t);
  let turn = pageReply(journal, false);
  const tooEarly = readiness(turn);
  assert.throws(() => journal.recordReadiness({ ...args(turn), evidence: tooEarly }), codeIs('INVALID_READINESS_EVIDENCE'));
  turn = journal.observeDelivery({ ...args(turn), evidence: { ...delivery(turn), sequence: 20 } });
  assert.equal(turn.readiness.state, 'unknown');
  assert.throws(() => journal.recordReadiness({ ...args(turn), evidence: tooEarly }), codeIs('INVALID_READINESS_EVIDENCE'));
  const late = { ...tooEarly, sequence: 22, samples: tooEarly.samples.map((sample, index) => ({ ...sample, sequence: 21 + index })) };
  assert.throws(() => journal.recordReadiness({ ...args(turn), evidence: { ...late, samples: [{ ...late.samples[0], sequence: 20 }, late.samples[1]] } }), codeIs('INVALID_READINESS_EVIDENCE'));
  turn = journal.recordReadiness({ ...args(turn), evidence: late });
  assert.equal(turn.readiness.state, 'ready');
  assert.equal(journal.reserve(request('follow-up')).admitted, true);
});

test('last-moment effect permit rechecks an earlier-turn fence even after dispatch intent was persisted', (t) => {
  const { journal, dataDir } = setup(t);
  let first = pageReply(journal);
  first = journal.recordReadiness({ ...args(first), evidence: readiness(first) });
  const second = dispatch(journal, journal.reserve(request('follow-up')).turn);
  assert.equal(journal.assertEffectAllowed({ ...args(second), phase: 'dispatching' }).id, second.id);
  const other = createThreadTurnJournal({ dataDir, ...scope });
  other.recordReply({ ...args(first), evidence: { ...reply(first, 2), sequence: 20 } });
  assert.throws(() => journal.assertEffectAllowed({ ...args(second), phase: 'dispatching' }), codeIs('THREAD_FENCED'));
  assert.throws(() => other.assertEffectAllowed({ ...args(second), phase: 'dispatching' }), codeIs('TURN_NOT_ADMITTED_BY_THIS_CLIENT'));
});

test('persisted readiness predating delivery is corrupt even with a valid checksum', (t) => {
  const { journal } = setup(t);
  let turn = pageReply(journal);
  journal.recordReadiness({ ...args(turn), evidence: readiness(turn) });
  const envelope = JSON.parse(fs.readFileSync(journal.file, 'utf8'));
  envelope.snapshot.turns[0].delivery.evidence.sequence = 20;
  envelope.checksum = digestTurnPayload(JSON.stringify(envelope.snapshot));
  fs.writeFileSync(journal.file, JSON.stringify(envelope));
  assert.throws(() => journal.read(), codeIs('CORRUPT_OR_UNREADABLE_JOURNAL'));
});

test('newer reply revision invalidates readiness; stale readiness and same-revision content changes are refused', (t) => {
  const { journal } = setup(t);
  let turn = pageReply(journal);
  const oldEvidence = readiness(turn);
  turn = journal.recordReadiness({ ...args(turn), evidence: oldEvidence });
  assert.throws(() => journal.recordReply({ ...args(turn), evidence: { ...reply(turn), contentDigest: digestTurnPayload('changed-without-revision') } }), codeIs('REPLY_REVISION_CONFLICT'));
  turn = journal.recordReply({ ...args(turn), evidence: { ...reply(turn, 2), source: 'page', sequence: 20 } });
  assert.deepEqual(turn.readiness, { state: 'unknown', evidence: null });
  assert.throws(() => journal.reserve(request('follow-up')), codeIs('THREAD_FENCED'));
  assert.throws(() => journal.recordReadiness({ ...args(turn), evidence: oldEvidence }), codeIs('INVALID_READINESS_EVIDENCE'));
  turn = journal.recordReadiness({ ...args(turn), evidence: readiness(turn) });
  assert.equal(turn.readiness.evidence.revision, 2);
  assert.equal(journal.reserve(request('follow-up')).admitted, true);
});

test('late earlier-turn reply revision re-fences reserved follow-up effect transitions until requalified', (t) => {
  for (const nextPhase of ['preparing', 'typing']) {
    const { journal } = setup(t);
    let prior = pageReply(journal);
    prior = journal.recordReadiness({ ...args(prior), evidence: readiness(prior) });
    let { turn: next } = journal.reserve(request('follow-up'));
    if (nextPhase === 'typing') next = journal.markTyping({ ...args(next), boundary: { ...boundary, sequence: 30 } });
    prior = journal.recordReply({ ...args(prior), evidence: { ...reply(prior, 2), source: 'page', sequence: 20 } });
    assert.equal(journal.read().turns[0].readiness.state, 'unknown');
    assert.throws(() => nextPhase === 'preparing' ? journal.markTyping({ ...args(next), boundary: { ...boundary, sequence: 30 } }) : journal.markDispatching(args(next)), codeIs('THREAD_FENCED'));
    prior = journal.recordReadiness({ ...args(prior), evidence: readiness(prior) });
    assert.equal(prior.readiness.state, 'ready');
  }
});

test('strict network-completion admission requires readiness plus protocol completion and cannot downgrade on reopen', (t) => {
  const admissionMode = 'network-completion';
  const { journal, dataDir } = setup(t, { admissionMode });
  let turn = pageReply(journal);
  turn = journal.recordReadiness({ ...args(turn), evidence: readiness(turn) });
  assert.throws(() => journal.reserve(request('follow-up')), codeIs('THREAD_FENCED'));
  assert.throws(() => journal.recordCompletion({ ...args(turn), evidence: { ...completion(turn), source: 'page' } }), codeIs('INVALID_COMPLETION_EVIDENCE'));
  const before = fs.readFileSync(journal.file, 'utf8');
  assert.throws(() => createThreadTurnJournal({ dataDir, ...scope }), codeIs('ADMISSION_MODE_MISMATCH'));
  assert.equal(fs.readFileSync(journal.file, 'utf8'), before);
  const reopened = createThreadTurnJournal({ dataDir, ...scope, admissionMode });
  assert.throws(() => reopened.reserve(request('follow-up')), codeIs('THREAD_FENCED'));
  turn = reopened.recordCompletion({ ...args(turn), evidence: completion(turn) });
  assert.equal(turn.readiness.state, 'ready');
  assert.equal(reopened.reserve(request('follow-up')).admitted, true);
});

test('readiness evidence sequence cannot regress within the current reply revision', (t) => {
  const { journal } = setup(t);
  let turn = pageReply(journal);
  const earlier = readiness(turn);
  const later = { ...earlier, sequence: 22, samples: earlier.samples.map((sample, index) => ({ ...sample, sequence: 21 + index })) };
  turn = journal.recordReadiness({ ...args(turn), evidence: later });
  const before = fs.readFileSync(journal.file, 'utf8');
  assert.throws(() => journal.recordReadiness({ ...args(turn), evidence: earlier }), codeIs('INVALID_READINESS_EVIDENCE'));
  assert.equal(fs.readFileSync(journal.file, 'utf8'), before);
});

test('unsupported admission policy and pre-readiness schema are rejected without implicit migration', (t) => {
  const { journal, dataDir } = setup(t);
  assert.throws(() => createThreadTurnJournal({ dataDir, ...scope, admissionMode: 'reply-observed' }), codeIs('INVALID_ADMISSION_MODE'));
  journal.reserve(request());
  const envelope = JSON.parse(fs.readFileSync(journal.file, 'utf8'));
  assert.equal(envelope.snapshot.version, 2);
  envelope.snapshot.version = 1;
  delete envelope.snapshot.admissionMode;
  delete envelope.snapshot.turns[0].readiness;
  envelope.checksum = digestTurnPayload(JSON.stringify(envelope.snapshot));
  const bytes = JSON.stringify(envelope);
  fs.writeFileSync(journal.file, bytes);
  assert.throws(() => createThreadTurnJournal({ dataDir, ...scope }), codeIs('CORRUPT_OR_UNREADABLE_JOURNAL'));
  assert.equal(fs.readFileSync(journal.file, 'utf8'), bytes);
});

test('readiness snapshots/replays are read-only across restart and never restore old effect permits', (t) => {
  const { journal, dataDir } = setup(t);
  let turn = pageReply(journal);
  turn = journal.recordReadiness({ ...args(turn), evidence: { ...readiness(turn), text: 'synthetic-readiness-body' } });
  const before = fs.readFileSync(journal.file, 'utf8'), mtime = fs.statSync(journal.file).mtimeMs;
  const reopened = createThreadTurnJournal({ dataDir, ...scope });
  assert.deepEqual(reopened.reserve(request()), { admitted: false, turn });
  const snapshot = reopened.read();
  snapshot.turns[0].readiness.evidence.controls.state = 'busy';
  assert.equal(reopened.read().turns[0].readiness.evidence.controls.state, 'idle');
  assert.equal(fs.readFileSync(journal.file, 'utf8'), before);
  assert.equal(fs.statSync(journal.file).mtimeMs, mtime);
  assert.equal(before.includes('synthetic-readiness-body'), false);
  assert.throws(() => reopened.markTyping({ ...args(turn), boundary }), codeIs('TURN_NOT_ADMITTED_BY_THIS_CLIENT'));
  const next = reopened.reserve(request('follow-up'));
  const another = createThreadTurnJournal({ dataDir, ...scope });
  assert.equal(another.reserve(request('follow-up')).admitted, false);
  assert.throws(() => another.markTyping({ ...args(next.turn), boundary }), codeIs('TURN_NOT_ADMITTED_BY_THIS_CLIENT'));
});

test('corrupt readiness schema/attribution/policy fails closed even with recomputed checksum, without read-side repair', (t) => {
  const damage = [(s) => { delete s.turns[0].readiness; }, (s) => { s.turns[0].readiness.state = 'ready-from-dom-quiet'; },
    (s) => { s.turns[0].readiness.evidence.ruleVersion = 99; }, (s) => { s.turns[0].readiness.evidence.revision = 2; },
    (s) => { s.turns[0].readiness.evidence.controls.state = 'busy'; }, (s) => { s.turns[0].readiness.evidence.threadKey = 'different-thread'; },
    (s) => { s.admissionMode = 'anything-goes'; }];
  for (const corrupt of damage) {
    const { journal, dataDir } = setup(t);
    const turn = pageReply(journal);
    journal.recordReadiness({ ...args(turn), evidence: readiness(turn) });
    const envelope = JSON.parse(fs.readFileSync(journal.file, 'utf8'));
    corrupt(envelope.snapshot);
    envelope.checksum = digestTurnPayload(JSON.stringify(envelope.snapshot));
    const bytes = JSON.stringify(envelope);
    fs.writeFileSync(journal.file, bytes);
    assert.throws(() => journal.read(), codeIs('CORRUPT_OR_UNREADABLE_JOURNAL'));
    assert.throws(() => journal.reserve(request('follow-up')), codeIs('CORRUPT_OR_UNREADABLE_JOURNAL'));
    assert.throws(() => createThreadTurnJournal({ dataDir, ...scope }), codeIs('CORRUPT_OR_UNREADABLE_JOURNAL'));
    assert.equal(fs.readFileSync(journal.file, 'utf8'), bytes);
  }
});

test('corrupt, malformed and identity-swapped stores fail closed, with no recovery writes', (t) => {
  for (const damage of ['null', '{broken', '{}', JSON.stringify({ checksum: '0'.repeat(64), snapshot: {} })]) {
    const { journal } = setup(t);
    journal.reserve(request());
    fs.writeFileSync(journal.file, damage);
    assert.throws(() => journal.read(), codeIs('CORRUPT_OR_UNREADABLE_JOURNAL'));
    assert.throws(() => journal.reserve(request('new')), codeIs('CORRUPT_OR_UNREADABLE_JOURNAL'));
    assert.equal(fs.readFileSync(journal.file, 'utf8'), damage);
  }
  const { journal, dataDir } = setup(t);
  journal.reserve(request());
  const other = createThreadTurnJournal({ dataDir, ...scope, thread: thread('2') });
  fs.copyFileSync(journal.file, other.file);
  assert.throws(() => other.read(), codeIs('CORRUPT_OR_UNREADABLE_JOURNAL'));
});

test('checksummed but semantically malformed journal state also fails closed', (t) => {
  const { journal } = setup(t);
  journal.reserve(request());
  const envelope = JSON.parse(fs.readFileSync(journal.file, 'utf8'));
  envelope.snapshot.turns[0].phase = 'blocked'; // Missing positive no-effects proof, even with a matching checksum.
  envelope.checksum = digestTurnPayload(JSON.stringify(envelope.snapshot));
  fs.writeFileSync(journal.file, JSON.stringify(envelope));
  assert.throws(() => journal.read(), codeIs('CORRUPT_OR_UNREADABLE_JOURNAL'));
  assert.throws(() => journal.reserve(request('new')), codeIs('CORRUPT_OR_UNREADABLE_JOURNAL'));
});

test('crash boundary before rename admits no action and poisons handle; after rename remains fenced', (t) => {
  for (const afterRename of [false, true]) {
    let fail = false;
    const io = { ...fs, renameSync(from, to) { if (fail && !afterRename) throw new Error('synthetic-fault'); fs.renameSync(from, to); if (fail) throw new Error('synthetic-fault'); } };
    const { journal, dataDir } = setup(t, { io });
    fail = true;
    assert.throws(() => journal.reserve(request()), codeIs('JOURNAL_PERSISTENCE_FAILED_REOPEN_REQUIRED'));
    assert.throws(() => journal.reserve(request()), codeIs('JOURNAL_PERSISTENCE_FAILED_REOPEN_REQUIRED'));
    const reopened = createThreadTurnJournal({ dataDir, ...scope });
    if (afterRename) assert.throws(() => reopened.reserve(request('new')), codeIs('THREAD_FENCED'));
    else assert.equal(reopened.reserve(request('new')).turn.phase, 'preparing');
  }
});

test('failed typing/dispatch persistence never returns an effect permit; persisted prior phase fences', (t) => {
  for (const phase of ['typing', 'dispatching']) {
    let fail = false;
    const io = { ...fs, fsyncSync(fd) { if (fail) throw new Error('synthetic-fault'); fs.fsyncSync(fd); } };
    const { journal, dataDir } = setup(t, { io });
    let { turn } = journal.reserve(request());
    if (phase === 'dispatching') turn = journal.markTyping({ ...args(turn), boundary });
    fail = true;
    assert.throws(() => phase === 'typing' ? journal.markTyping({ ...args(turn), boundary }) : journal.markDispatching(args(turn)), codeIs('JOURNAL_PERSISTENCE_FAILED_REOPEN_REQUIRED'));
    const reopened = createThreadTurnJournal({ dataDir, ...scope });
    assert.throws(() => reopened.reserve(request('new')), codeIs('THREAD_FENCED'));
  }
});

test('multiple already-open clients reread durable state instead of admitting twice', (t) => {
  const { journal, dataDir } = setup(t);
  const second = createThreadTurnJournal({ dataDir, ...scope });
  journal.reserve(request());
  assert.throws(() => second.reserve(request('new', 'different-conversation')), codeIs('THREAD_FENCED'));
  assert.equal(second.read().turns.length, 1);
});

test('replay/restart clients cannot resume browser-effect transitions on persisted attempts', (t) => {
  const { journal, dataDir } = setup(t);
  let { turn } = journal.reserve(request());
  const second = createThreadTurnJournal({ dataDir, ...scope });
  assert.equal(second.reserve(request()).admitted, false);
  assert.throws(() => second.markTyping({ ...args(turn), boundary }), codeIs('TURN_NOT_ADMITTED_BY_THIS_CLIENT'));
  turn = journal.markTyping({ ...args(turn), boundary });
  assert.throws(() => second.markDispatching(args(turn)), codeIs('TURN_NOT_ADMITTED_BY_THIS_CLIENT'));
  turn = journal.markDispatching(args(turn));
  turn = second.markUnknown({ ...args(turn), reason: 'RUNTIME_RESTARTED' });
  assert.equal(second.observeDelivery({ ...args(turn), evidence: delivery(turn) }).delivery.state, 'observed');
});

test('evidence stores only allowlisted metadata, never caller-supplied transcript fields', (t) => {
  const { journal } = setup(t);
  let turn = dispatch(journal, journal.reserve(request()).turn);
  turn = journal.observeDelivery({ ...args(turn), evidence: { ...delivery(turn), text: 'synthetic-body-marker' } });
  turn = journal.recordReply({ ...args(turn), evidence: { ...reply(turn), text: 'synthetic-body-marker' } });
  journal.recordCompletion({ ...args(turn), evidence: { ...completion(turn), transcript: 'synthetic-body-marker' } });
  assert.equal(fs.readFileSync(journal.file, 'utf8').includes('synthetic-body-marker'), false);
});

test('a held per-thread write lease blocks only that thread, never pure reads or unrelated threads', (t) => {
  const { journal, dataDir } = setup(t);
  const root = path.join(dataDir, '.thread-turn-locks', path.basename(journal.file, '.turn-journal.json'));
  const lease = acquireDriveLease({ root, port: 1 });
  try {
    assert.equal(journal.read().turns.length, 0);
    assert.throws(() => journal.reserve(request()), codeIs('THREAD_JOURNAL_BUSY'));
    const other = createThreadTurnJournal({ dataDir, ...scope, thread: thread('2') });
    assert.equal(other.reserve(request()).admitted, true);
  } finally { lease.release(); }
});

for (const sharedKey of [false, true]) test(`concurrent process writers admit once (${sharedKey ? 'same key' : 'distinct keys'}) with existing lease exclusion`, { timeout: 20000 }, async (t) => {
  const { journal, dataDir } = setup(t);
  const moduleUrl = new URL('../../src/capture/thread-turn-journal.mjs', import.meta.url).href;
  const startAt = Date.now() + 1000;
  const children = [0, 1, 2, 3].map((index) => {
    const source = `import {createThreadTurnJournal} from ${JSON.stringify(moduleUrl)};
      const journal=createThreadTurnJournal(${JSON.stringify({ dataDir, ...scope })});
      while(Date.now()<${startAt}) {}
      try {const result=journal.reserve(${JSON.stringify(request(sharedKey ? 'shared-key' : `key-${index}`, `conversation-${index}`))});console.log(JSON.stringify({admitted:result.admitted,replayed:!result.admitted}));}
      catch(e){console.log(JSON.stringify({admitted:false,code:e.code}));}`;
    return spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'pipe'] });
  });
  t.after(() => { for (const child of children) if (child.exitCode === null) child.kill(); });
  const outputs = await Promise.all(children.map((child) => new Promise((resolve, reject) => {
    let output = '', errors = '';
    child.on('error', reject);
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { errors += chunk; });
    child.on('close', (code) => {
      if (code !== 0 || errors) return reject(new Error('synthetic child failed'));
      try { resolve(JSON.parse(output.trim())); } catch { reject(new Error('invalid synthetic child receipt')); }
    });
  })));
  assert.equal(outputs.filter((o) => o.admitted).length, 1);
  assert.ok(outputs.filter((o) => !o.admitted).every((o) => sharedKey && o.replayed || ['THREAD_FENCED', 'THREAD_JOURNAL_BUSY'].includes(o.code)));
  assert.equal(journal.read().turns.length, 1);
});

test('abrupt process death after dispatch intent preserves fence and reclaims only the dead file lock', { timeout: 15000 }, async (t) => {
  const { journal, dataDir } = setup(t);
  const moduleUrl = new URL('../../src/capture/thread-turn-journal.mjs', import.meta.url).href;
  const source = `import * as fs from 'node:fs';import {createThreadTurnJournal} from ${JSON.stringify(moduleUrl)};
    const io={...fs,renameSync(from,to){fs.renameSync(from,to);
      if(JSON.parse(fs.readFileSync(to,'utf8')).snapshot.turns[0].phase==='dispatching'){
        console.log('durable');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);
      }}};
    const j=createThreadTurnJournal({...${JSON.stringify({ dataDir, ...scope })},io});
    let {turn}=j.reserve(${JSON.stringify(request())});
    turn=j.markTyping({turnId:turn.id,expectedRevision:turn.revision,boundary:${JSON.stringify(boundary)}});
    j.markDispatching({turnId:turn.id,expectedRevision:turn.revision});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  await new Promise((resolve, reject) => { child.on('error', reject); child.stdout.once('data', resolve); child.stderr.once('data', () => reject(new Error('synthetic child failed'))); });
  const closed = new Promise((resolve) => child.once('close', resolve)); child.kill(); await closed;
  assert.equal(journal.read().turns[0].phase, 'dispatching');
  assert.throws(() => journal.reserve(request('new', 'new-conversation')), codeIs('THREAD_FENCED'));
});
