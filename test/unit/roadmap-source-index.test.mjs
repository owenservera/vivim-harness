import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRoadmapSourceIndex } from '../../scripts/roadmap-source-index.mjs';

const key = 'src/studio/world-service.mjs#createWorldService';
const index = { keys: { [key]: { line: 27, kind: 'function', exported: true } } };
const fixture = () => Array.from({ length: 10 }, (_, section) => {
  const start = 101 + section * 10;
  return '## ' + (11 + section) + ' — Stage ' + (11 + section) + '\n*Pillar: ' + (section === 9 ? 'Share / Evolve' : 'Own') + '*\n' +
    Array.from({ length: 10 }, (_, i) => '**' + (start + i) + '.** Outcome ' + (start + i)).join('\n');
}).join('\n\n');

test('indexes 100 roadmap goals in 10 sections without claiming support', () => {
  const data = buildRoadmapSourceIndex(fixture(), index, { '101': { sourceKeys: [key], gap: 'No live receipt' } });
  assert.deepEqual(data.counts, { objectives: 100, sections: 10, candidateOnly: 1, unassessed: 99 });
  assert.equal(data.objectives[0].id, '101');
  assert.equal(data.objectives[99].id, '200');
  assert.equal(data.objectives[99].pillar, 'Share / Evolve');
  assert.equal(data.objectives[0].sourceReviewState, 'candidate-only');
  assert.match(data.evidence, /does not establish complete implementation/);
});

test('rejects missing, duplicate and out-of-section roadmap objectives', () => {
  assert.throws(() => buildRoadmapSourceIndex(fixture().replace('**200.** Outcome 200', ''), index), /Missing roadmap objectives: 200/);
  assert.throws(() => buildRoadmapSourceIndex(fixture().replace('**102.**', '**101.**'), index), /duplicate roadmap objective 101/);
  assert.throws(() => buildRoadmapSourceIndex(fixture().replace('**111.**', '**112.**'), index), /duplicate roadmap objective 112/);
  assert.throws(() => buildRoadmapSourceIndex(fixture().replace('**101.**', '**201.**'), index), /Out-of-range/);
});

test('rejects invalid source candidates and candidate IDs that are not in roadmap', () => {
  assert.throws(() => buildRoadmapSourceIndex(fixture(), index, { '101': { sourceKeys: ['no-such-file#fn'], gap: 'Unverified' } }), /Unresolved candidate source key/);
  assert.throws(() => buildRoadmapSourceIndex(fixture(), index, { '101': { sourceKeys: [key] } }), /Invalid candidate entry/);
  assert.throws(() => buildRoadmapSourceIndex(fixture(), index, { '001': { sourceKeys: [key], gap: 'Unverified' } }), /Unknown candidate IDs: 001/);
});
