import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ScopedLearner } from '../../src/intel/learn.mjs';

const d = { type: 'string', string: { avgLen: 19, uniqueness: 0.7, formats: {} } };
const A = { site: 'lab', origin: 'https://lab.test', account: 'A' };
const B = { ...A, account: 'B' };
function corpus() {
  return [A, B].flatMap((scope, i) =>
    Array.from({ length: 5 }, (_, j) => ({
      ctx: { ...scope, instanceId: 'heldout-' + j },
      positive: i === 0,
    })));
}
function confusion(learner) {
  let TP = 0, FP = 0, TN = 0, FN = 0;
  let positiveProbability = 0, negativeProbability = 0;
  for (const item of corpus()) {
    const probability = learner.predict('subject', d, item.ctx).dist.text;
    const predictsText = probability >= 0.5;
    if (item.positive) {
      positiveProbability += probability;
      if (predictsText) TP++; else FN++;
    } else {
      negativeProbability += probability;
      if (predictsText) FP++; else TN++;
    }
  }
  return { TP, FP, TN, FN, positiveProbability: positiveProbability / 5,
    negativeProbability: negativeProbability / 5 };
}

test('deterministic held-out confusion matrix improves without same-origin account leakage', () => {
  const learner = new ScopedLearner(), before = confusion(learner);
  assert.deepEqual([before.TP, before.FP, before.TN, before.FN], [0, 0, 5, 5]);
  const pending = learner.proposeCorrection({ scope: 'account', name: 'subject', role: 'text',
    d, ctx: A, actor: 'fixture', evidence: { kind: 'fixture', seq: 1 } });
  learner.reviewCorrection(pending.id, { action: 'accept', actor: 'fixture' });
  const after = confusion(learner);
  assert.deepEqual([after.TP, after.FP, after.TN, after.FN], [5, 0, 5, 0]);
  assert.ok(after.positiveProbability > before.positiveProbability);
  assert.equal(after.negativeProbability, before.negativeProbability);
});

test('out-of-order proposal approvals and a later reversal replay the same accepted evidence', () => {
  const learner = new ScopedLearner();
  const one = learner.proposeCorrection({ scope: 'account', name: 'subject', role: 'text', d, ctx: A });
  const two = learner.proposeCorrection({ scope: 'account', name: 'subject', role: 'title', d, ctx: B });
  learner.reviewCorrection(two.id, { action: 'accept', actor: 'two' });
  learner.reviewCorrection(one.id, { action: 'accept', actor: 'one' });
  const afterA = learner.predict('subject', d, A).dist.text;
  const afterB = learner.predict('subject', d, B).dist.title;
  assert.ok(afterA > 0);
  assert.ok(afterB > 0);
  learner.revert(two.id, { actor: 'two' });
  assert.equal(learner.predict('subject', d, A).dist.text, afterA);
  assert.ok(learner.predict('subject', d, B).dist.title !== afterB);
});

test('calibration state survives a versioned save/reload; metrics use only observed bins', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'l5-cal-'));
  try {
    const learner = new ScopedLearner(dir);
    for (let i = 0; i < 12; i++) learner.calibrator.observe('field_role', 0.8, i < 8);
    const before = learner.calibrator.ece('field_role');
    learner.save();
    const reloaded = new ScopedLearner(dir);
    assert.equal(reloaded.calibrator.ece('field_role'), before);
    assert.equal(reloaded.calibrator.calibrate('field_role', 0.8), learner.calibrator.calibrate('field_role', 0.8));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
