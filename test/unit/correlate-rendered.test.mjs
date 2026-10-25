// Regression net for correlateRendered (src/intel/correlate.mjs) before the join rewrite.
// Asserts the CURRENT statuses and scores. Scores are compared with a small tolerance.
// Where current behaviour is surprising, the test name and comment say so; nothing is bent to
// match an intended design.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { correlateRendered } from '../../src/intel/correlate.mjs';

const TOL = 0.005;
const near = (actual, expected, msg) => assert.ok(Math.abs(actual - expected) <= TOL, `${msg ?? 'score'}: expected ~${expected}, got ${actual}`);

const LONG = 'The quick synthetic reply describes a made-up harbour lighthouse and its nightly tide tables in careful detail.';
const OTHER = 'Completely unrelated sentence about gardening tools and watering schedules for spring.';

test('(1) unique long text links to its DOM element with status likely', () => {
  const [h] = correlateRendered(
    [{ id: 'subj-1', kind: 'entity', text: LONG, t0: 1000, t1: 2000 }],
    [{ id: 'el-a', text: LONG, firstT: 1000, lastT: 2000 }, { id: 'el-b', text: OTHER, firstT: 1000, lastT: 2000 }],
  );
  assert.equal(h.kind, 'rendered_as');
  assert.equal(h.to.element, 'el-a');
  assert.equal(h.status, 'likely');
  near(h.score, 1, 'unique score');
  assert.equal(h.features.shingleContainment, 1);
  assert.equal(h.features.tfidf, 1);
  assert.equal(h.features.activityOverlap, 1);
  assert.equal(h.features.candidateCount, 1);
  assert.equal(h.alternatives.length, 0);
});

test('(2a) two elements sharing a repeated phrase with different tails yield ambiguous', () => {
  const PHRASE = 'Repeated synthetic phrase about the harbour lamp and the tide.';
  const [h] = correlateRendered(
    [{ id: 'subj-2', kind: 'entity', text: PHRASE, t0: 1000, t1: 2000 }],
    [
      { id: 'el-1', text: `${PHRASE} Extra words for block one.`, firstT: 1000, lastT: 2000 },
      { id: 'el-2', text: `${PHRASE} Different tail for block two.`, firstT: 1000, lastT: 2000 },
    ],
  );
  assert.equal(h.status, 'ambiguous');
  // Tie on score is broken toward the shorter text container (el-1 is shorter here).
  assert.equal(h.to.element, 'el-1');
  near(h.score, 1, 'tied score');
  near(h.features.scoreMargin, 0, 'scoreMargin');
  assert.equal(h.alternatives[0].element, 'el-2');
});

test('(2b) identical duplicate elements are ambiguous (margin 0), not likely', () => {
  // Previously this was a DEFECT: identical texts contain each other, so the containment filter
  // hid the second candidate, status came out 'likely' and scoreMargin read 1. An exact text tie
  // is a real competitor; the tie still resolves to the first id (el-1), but it is flagged.
  const PHRASE = 'Repeated synthetic phrase about the harbour lamp and the tide.';
  const [h] = correlateRendered(
    [{ id: 'subj-2b', kind: 'entity', text: PHRASE, t0: 1000, t1: 2000 }],
    [{ id: 'el-1', text: PHRASE, firstT: 1000, lastT: 2000 }, { id: 'el-2', text: PHRASE, firstT: 1000, lastT: 2000 }],
  );
  assert.equal(h.status, 'ambiguous');
  assert.equal(h.to.element, 'el-1');
  assert.equal(h.alternatives[0].element, 'el-2');
  near(h.features.scoreMargin, 0, 'scoreMargin (exact tie)');
});

test('(3) a streaming prefix of the final text still links by containment', () => {
  const cut = LONG.slice(0, 60).replace(/\s\S*$/, '');
  const [h] = correlateRendered(
    [{ id: 'stream-1', kind: 'stream', text: cut, t0: 1000, t1: 2000 }],
    [{ id: 'el-a', text: LONG, firstT: 1000, lastT: 2000 }, { id: 'el-b', text: OTHER, firstT: 1000, lastT: 2000 }],
  );
  assert.equal(h.to.element, 'el-a');
  assert.equal(h.status, 'likely');
  near(h.features.shingleContainment, 1, 'prefix containment');
  assert.ok(h.score >= 0.6);
});

test('(4) subject with no matching element returns no link, not a forced match', () => {
  const hyps = correlateRendered(
    [{ id: 'subj-4', kind: 'entity', text: 'Zebra quantum lattice migrates upward tonight.', t0: 1000, t1: 2000 }],
    [{ id: 'el-a', text: LONG, firstT: 1000, lastT: 2000 }],
  );
  assert.equal(hyps.length, 1);
  assert.equal(hyps[0].to, null);
  assert.equal(hyps[0].status, 'no_rendered_match');
  assert.equal(hyps[0].score, 0);
});

test('(5) missing times use the 0.5 neutral activity overlap', () => {
  const [h] = correlateRendered(
    [{ id: 'subj-5', kind: 'entity', text: LONG }],
    [{ id: 'el-a', text: LONG }],
  );
  assert.equal(h.to.element, 'el-a');
  assert.equal(h.features.activityOverlap, 0.5);
  // 0.5*tfidf(1) + 0.35*containment(1) + 0.15*0.5 = 0.925
  near(h.score, 0.925, 'neutral-overlap score');
  assert.equal(h.t, null);
});

test('(5b) with real overlapping times the same pair scores 1.0 (contrast for (5))', () => {
  const [h] = correlateRendered(
    [{ id: 'subj-5b', kind: 'entity', text: LONG, t0: 1000, t1: 2000 }],
    [{ id: 'el-a', text: LONG, firstT: 1000, lastT: 2000 }],
  );
  assert.equal(h.features.activityOverlap, 1);
  near(h.score, 1, 'overlapping-time score');
});
