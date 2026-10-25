// Independent QA regression cases, pinned to Capture Studio C4 implementation 8218e6c.
// Run from the AION repository: node --test workspace/aion/qa/capture-studio/tests/sprint01-temporal-graph.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TemporalGraph, buildGraph } from '../../src/intel/graph.mjs';

const type = (id) => ({ id, name: id, confidence: 0.9, fields: [], key: null });
const entity = (eid, typeName, scope, t, attrs, session = 'capture-a') => ({
  eid, type: typeName, typeName, scope, key: attrs.id ?? null, first: t, last: t,
  attrs, confidence: 0.9, confidenceBasis: 'fixture', idBasis: 'key', anchor: null,
  revisions: [{ t, seq: 1, sid: 'stream-1', session, values: attrs, changed: Object.keys(attrs) }],
});

test('C2: references are scoped to the same site', () => {
  const model = { types: [type('A'), type('B')], relationships: [{ id: 'r', kind: 'references', from: 'A', to: 'B', field: 'ref', confidence: 0.9 }] };
  const resolutions = [
    { type: 'A', entities: [entity('a', 'A', 'site-1', 100, { ref: 'X' })] },
    { type: 'B', entities: [entity('b1', 'B', 'site-1', 100, { id: 'X' }), entity('b2', 'B', 'site-2', 100, { id: 'X' })] },
  ];
  const graph = buildGraph({ model, resolutions });
  assert.deepEqual([...graph.edges.values()].map((e) => e.to), ['b1']);
});

test('C2: contains does not connect otherwise equal observations from different sessions', () => {
  const model = { types: [type('P'), type('C')], relationships: [{ id: 'r2', kind: 'contains', from: 'P', to: 'C', confidence: 0.8 }] };
  const resolutions = [
    { type: 'P', entities: [entity('p1', 'P', 'site-1', 100, { id: 'P' }, 'capture-1')] },
    { type: 'C', entities: [entity('c1', 'C', 'site-1', 100, { id: 'C' }, 'capture-2')] },
  ];
  assert.equal(buildGraph({ model, resolutions }).edges.size, 0);
});

test('C2: action edge never claims proven causation', () => {
  const graph = buildGraph({ model: { types: [], relationships: [] }, resolutions: [], actionHyps: [
    { from: { actionSeq: 12 }, to: { sid: 's' }, score: 0.7, relation: 'causal', features: { latencyMs: 10 } },
  ] });
  const edge = [...graph.edges.values()][0];
  assert.equal(edge.kind, 'preceded');
  assert.equal(edge.evidence.scoredRelation, 'causal');
});

test('DEFECT: stateAt must not show rendered edge to an entity before it exists', () => {
  const model = { types: [type('A')], relationships: [] };
  const resolutions = [{ type: 'A', entities: [entity('e2000', 'A', 'site-1', 2000, { id: 'X' })] }];
  const graph = buildGraph({ model, resolutions, renderedHyps: [
    { from: { entity: 'e2000' }, to: { element: 'd2000' }, score: 0.75, status: 'likely', features: { activityOverlap: 1 } },
  ] });
  assert.equal(graph.stateAt(1000).nodes.length, 0, 'future entity should not exist');
  assert.equal(graph.stateAt(1000).edges.length, 0, 'future relationship should not exist either');
});

test('DEFECT: action-to-request edge must not exist at an earlier replay time', () => {
  const graph = buildGraph({ model: { types: [], relationships: [] }, resolutions: [], actionHyps: [
    { from: { actionSeq: 44 }, to: { sid: 'future-stream' }, score: 0.7, relation: 'temporal', features: { latencyMs: 7 } },
  ] });
  assert.equal(graph.stateAt(-1).edges.length, 0, 'an undated future event should not be assigned time zero');
  assert.equal(graph.stateAt(1000).edges.length, 0, 'a historical query must not include unbounded future edges');
});

test('KNOWN GAP: current rejection must not rewrite the status in past snapshots', () => {
  const graph = new TemporalGraph();
  graph.relate({ kind: 'references', from: 'a', to: 'b', confidence: 0.8, t: 100 });
  assert.equal(graph.stateAt(150).edges.length, 1);
  graph.setEdgeStatus('references:a->b', 'rejected');
  assert.equal(graph.stateAt(150).edges.length, 1, 'status changes require a validity/history model');
});
