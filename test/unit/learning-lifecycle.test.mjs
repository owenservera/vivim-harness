import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ScopedLearner } from '../../src/intel/learn.mjs';

const desc = { type: 'string', string: { avgLen: 19, uniqueness: 0.7, formats: {} } };
const account = { site: 'example', origin: 'https://example.test', account: 'alice' };
const otherAccount = { ...account, account: 'bob' };
function fixture(run) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'capture-l5-'));
  try { return run(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}
const score = (l, ctx) => l.predict('subject', desc, ctx).dist.text;

test('review-only proposal and rejection never train the role model', () => fixture((dir) => {
  const learner = new ScopedLearner(dir), before = score(learner, account);
  const proposal = learner.proposeCorrection({ scope: 'account', name: 'subject', role: 'text',
    d: desc, ctx: account, actor: 'owner', evidence: { session: 'a1', seq: 10 } });
  assert.equal(score(learner, account), before);
  learner.reviewCorrection(proposal.id, { action: 'reject', actor: 'owner' });
  learner.save();
  const again = new ScopedLearner(dir);
  assert.equal(score(again, account), before);
  assert.equal(again.proposals[0].status, 'rejected');
  assert.equal(again.corrections.length, 0);
  assert.equal(again.audit.length, 2);
}));

test('accepted scoped feedback improves held-out instance and persists across restart', () => fixture((dir) => {
  const learner = new ScopedLearner(dir);
  const heldout = { ...account, instanceId: 'held-out-observation' };
  const prior = score(learner, heldout), unrelated = score(learner, otherAccount);
  const proposal = learner.proposeCorrection({ scope: 'account', name: 'subject', role: 'text',
    d: desc, ctx: account, actor: 'owner', evidence: { session: 'capture-A', seq: 4 } });
  learner.reviewCorrection(proposal.id, { action: 'accept', actor: 'owner' });
  const improved = score(learner, heldout);
  assert.ok(improved > prior, 'held-out same-account observation should benefit');
  assert.equal(score(learner, otherAccount), unrelated, 'different account must not change');
  const first = learner.save();
  assert.equal(first, 1);
  const restored = new ScopedLearner(dir);
  assert.equal(score(restored, heldout), improved);
  assert.equal(restored.corrections[0].status, 'accepted');
  assert.equal(restored.audit.find((e) => e.action === 'propose').evidence.session, 'capture-A');
}));

test('revert is durable and rollback restores old model as a NEW revision', () => fixture((dir) => {
  const learner = new ScopedLearner(dir), baseline = score(learner, account);
  const changed = learner.learn({ scope: 'account', name: 'subject', role: 'text', d: desc,
    ctx: account, actor: 'owner' });
  const trained = score(learner, account); assert.ok(trained > baseline);
  const initialVersion = learner.save();
  assert.ok(learner.revert(changed.id, { actor: 'owner' }));
  assert.equal(score(learner, account), baseline);
  const revertedVersion = learner.save();
  assert.ok(revertedVersion > initialVersion);
  const restoredVersion = learner.rollbackTo(initialVersion, { actor: 'owner', reason: 'restore correction' });
  assert.ok(restoredVersion > revertedVersion);
  assert.equal(score(learner, account), trained);
  const newProcess = new ScopedLearner(dir);
  assert.equal(score(newProcess, account), trained);
  assert.deepEqual(newProcess.versions(), [1, 2, 3]);
  assert.ok(newProcess.audit.some((e) => e.action === 'rollback'));
}));

test('two stale learners cannot silently lose accepted corrections', () => fixture((dir) => {
  const first = new ScopedLearner(dir), second = new ScopedLearner(dir);
  first.learn({ scope: 'account', name: 'subject', d: desc, ctx: account, role: 'text' });
  assert.equal(first.save(), 1);
  second.learn({ scope: 'account', name: 'subject', d: desc, ctx: otherAccount, role: 'count' });
  assert.throws(() => second.save(), (e) => e.code === 'LEARNER_REVISION_CONFLICT');
  const saved = new ScopedLearner(dir);
  assert.equal(saved.corrections.length, 1);
  assert.equal(saved.corrections[0].ctx.account, 'alice');
  assert.equal(score(saved, otherAccount), score(new ScopedLearner(null), otherAccount));
}));

test('site origins, account overrides and pages cannot cross-contaminate', () => {
  const learner = new ScopedLearner();
  const originTwo = { ...account, origin: 'https://other.example.test' };
  learner.learn({ scope: 'site', name: 'subject', role: 'text', d: desc, ctx: account });
  const siteAfter = score(learner, account);
  assert.notEqual(siteAfter, score(learner, originTwo));
  learner.learn({ scope: 'instance', name: 'subject', role: 'id', d: desc, ctx: { ...account, page: '/a', instanceId: 'i1' } });
  assert.equal(learner.predict('subject', desc, { ...account, page: '/a', instanceId: 'i1' }).role, 'id');
  assert.notEqual(learner.predict('subject', desc, { ...otherAccount, page: '/a', instanceId: 'i1' }).role, 'id');
});

test('reversed and rejected corrections do not become promotion candidates', () => {
  const learner = new ScopedLearner();
  const a = learner.learn({ scope: 'site', name: 'subject', role: 'text', ctx: { site: 'A' }, d: desc });
  learner.learn({ scope: 'site', name: 'subject', role: 'text', ctx: { site: 'B' }, d: desc });
  assert.ok(learner.promotionCandidates().length);
  assert.equal(learner.revert(a.id), true);
  assert.equal(learner.promotionCandidates().length, 0);
});

test('input validation protects learner and does not train invalid signals', () => {
  const learner = new ScopedLearner();
  assert.throws(() => learner.learn({ scope: 'account', name: 'subject', role: 'text', ctx: { site: 'a' } }), /Missing scope context/);
  assert.throws(() => learner.learn({ scope: 'global', name: 'subject', role: 'INVALID' }), /Invalid correction role/);
  assert.throws(() => learner.learn({ scope: 'global', name: 'subject', role: 'title', weight: Infinity }), /Invalid correction weight/);
  assert.equal(learner.corrections.length, 0);
});
