import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NSP_SCHEMA, NSP_RULES, InvariantViolation, invariantReceipt,
  assertInvariant, observeInvariant } from '../../src/core/invariants.mjs';
import { foldRevision, RevisionAccumulator } from '../../src/intel/history.mjs';
import { TemporalGraph, buildGraph } from '../../src/intel/graph.mjs';

const type = { id: 'thing', name: 'Thing', fields: [{ name: 'id', type: 'string' }], key: { field: 'id' } };
const model = { types: [type], relationships: [] };
const entity = (eid, key, t, overrides = {}) => ({
  eid, type: 'thing', typeName: 'Thing', scope: 'example.org',
  key, keyType: 'string', method: 'key', attrs: { id: key },
  anchor: { session: 'session1', seq: 1, sid: 'stream1' },
  first: t, revisions: [{ t, seq: 1, sid: 'stream1', session: 'session1',
    values: { id: key }, changed: ['id'] }], ...overrides,
});

test('NSP has eight small correctness rules and no authorization service', () => {
  assert.equal(NSP_SCHEMA, 'capture-studio.nsp/1');
  assert.deepEqual(Object.keys(NSP_RULES), [
    'NSP-001', 'NSP-002', 'NSP-003', 'NSP-004',
    'NSP-005', 'NSP-006', 'NSP-007', 'NSP-008',
  ]);
  assert.equal(NSP_RULES['NSP-003'].phase, 'runtime');
  assert.equal(NSP_RULES['NSP-004'].phase, 'runtime');
});

test('NSP receipts whitelist metadata, never echo raw evidence or unknown keys', () => {
  const receipt = invariantReceipt('NSP-004', {
    boundary: 'build-graph', disposition: 'isolated', reason: 'entity-id-collision',
    session: 'capture1', entityId: 'thing:k:abcdef', count: 2,
    prompt: 'DO NOT LEAK MY PROMPT', headers: { Authorization: 'Bearer secret' },
    source: { session: 'session1', sid: 'stream1', seq: 17, body: 'secret body' },
  });
  assert.equal(receipt.schema, NSP_SCHEMA);
  assert.equal(receipt.code, 'NSP-004');
  assert.equal(receipt.entityId, 'thing:k:abcdef');
  assert.equal(receipt.source.seq, 17);
  assert.equal(receipt.count, 2);
  assert.doesNotMatch(JSON.stringify(receipt), /DO NOT LEAK|secret|Authorization|body/i);
  assert.deepEqual(observeInvariant(true, 'NSP-003'), null);
  assert.equal(assertInvariant(true, 'NSP-003'), true);
  assert.throws(() => invariantReceipt('FAKE-000'), RangeError);
});

test('NSP-003: missing field keeps its previous value; explicit removal changes it', () => {
  const state = { a: 1, b: 2 };
  foldRevision(state, { values: { a: 3 } });
  assert.deepEqual(state, { a: 3, b: 2 });
  foldRevision(state, { removed: ['b'], values: {} });
  assert.deepEqual(state, { a: 3 });
});

test('NSP-003: set-and-remove same field rejects atomically', () => {
  const state = { a: 1, b: 2 };
  let violation;
  try {
    foldRevision(state, { values: { a: 9 }, removed: ['a'], session: 'session1', seq: 4 });
  } catch (error) { violation = error; }
  assert.ok(violation instanceof InvariantViolation);
  assert.equal(violation.code, 'NSP-003');
  assert.equal(violation.receipt.disposition, 'rejected');
  assert.equal(violation.receipt.source.seq, 4);
  assert.deepEqual(state, { a: 1, b: 2 });
});

test('NSP-003: invalid append does not poison the accumulator or a new graph node', () => {
  const acc = new RevisionAccumulator();
  acc.append({ t: 100, values: { a: 1 } });
  assert.throws(() => acc.append({ t: 200, values: { a: 2 }, removed: ['a'] }),
    (error) => error.code === 'NSP-003');
  assert.equal(acc.size, 1);
  assert.deepEqual(acc.at(300), { a: 1 });

  const g = new TemporalGraph();
  assert.throws(() => g.upsertEntity({ eid: 'e1', type: 'thing', attrs: { a: 1 },
    removed: ['a'], t: 100 }), (error) => error.code === 'NSP-003');
  assert.equal(g.nodes.size, 0);
  assert.equal(g.changes.length, 0);
});

test('NSP-004: incompatible identities with the same EID are both excluded', () => {
  const g = buildGraph({ model, resolutions: [
    { type: 'thing', entities: [
      entity('thing:k:collision', 'alice', 100),
      entity('thing:k:good', 'safe', 100),
      entity('thing:k:collision', 'bob', 200),
    ] },
  ] });
  assert.equal(g.nodes.has('thing:k:collision'), false);
  assert.equal(g.nodes.has('thing:k:good'), true);
  assert.equal(g.quarantinedEntities, 2);
  const json = g.toJSON();
  assert.equal(json.invariants.schema, NSP_SCHEMA);
  assert.equal(json.invariants.violations[0].code, 'NSP-004');
  assert.equal(json.invariants.violations[0].disposition, 'isolated');
  assert.equal(json.stats.invariantViolations, 1);
  assert.equal(json.stats.quarantinedEntities, 2);
  assert.doesNotMatch(JSON.stringify(json.invariants), /alice|bob/);
});

test('NSP-004: provisional EID reuse is never assumed to be the same entity', () => {
  const a = entity('thing:p:same', null, 100, { method: 'provisional', keyType: null });
  const b = entity('thing:p:same', null, 200, { method: 'provisional', keyType: null });
  const g = buildGraph({ model, resolutions: [{ type: 'thing', entities: [a, b] }] });
  assert.equal(g.nodes.has('thing:p:same'), false);
  assert.equal(g.quarantinedEntities, 2);
  assert.equal(g.invariants[0].code, 'NSP-004');
});

test('compatible keyed duplicate identities still fold normally', () => {
  const a = entity('thing:k:stable', 'same', 100);
  const b = entity('thing:k:stable', 'same', 200);
  const g = buildGraph({ model, resolutions: [{ type: 'thing', entities: [a, b] }] });
  assert.equal(g.invariants.length, 0);
  assert.equal(g.nodes.size, 1);
  assert.equal(g.nodes.get('thing:k:stable').history.length, 2);
});

test('invalid temporal revision is excluded, not silently restored from final attrs', () => {
  const e = entity('thing:k:history', 'safe', 100, {
    attrs: { id: 'safe', status: 'bad final state' },
    revisions: [
      { t: 100, seq: 1, session: 'session1', values: { id: 'safe', status: 'observed' } },
      { t: 200, seq: 2, session: 'session1', values: { status: 'bad final state' },
        removed: ['status'] },
    ],
  });
  const g = buildGraph({ model, resolutions: [{ type: 'thing', entities: [e] }] });
  assert.equal(g.invariants.length, 1);
  assert.equal(g.invariants[0].code, 'NSP-003');
  assert.equal(g.nodes.get(e.eid).attrs.status, 'observed');
  assert.equal(g.stateAt(300).nodes[0].attrs.status, 'observed');
  assert.equal(g.nodes.get(e.eid).history.length, 1);
  assert.equal(g.toJSON().stats.invariantViolations, 1);
});

test('NSP-004: quarantine remains complete after a third matching observation', () => {
  const entities = [
    entity('thing:k:collision3', 'alice', 100),
    entity('thing:k:collision3', 'bob', 200),
    entity('thing:k:collision3', 'alice', 300),
    entity('thing:k:other', 'clear', 400),
  ];
  const g = buildGraph({ model, resolutions: [{ type: 'thing', entities }] });
  assert.equal(g.nodes.size, 1);
  assert.equal(g.nodes.has('thing:k:collision3'), false);
  assert.equal(g.quarantinedEntities, 3);
  assert.equal(g.invariants[0].count, 3);
});

test('NSP-004: graph never creates a relation from quarantined identity', () => {
  const modelWithReference = {
    types: [
      { id: 'author', name: 'Author', fields: [{ name: 'id', type: 'string' }], key: { field: 'id' } },
      { id: 'post', name: 'Post', fields: [{ name: 'id', type: 'string' }], key: { field: 'id' } },
    ],
    relationships: [{ id: 'post-author', kind: 'references', from: 'post', to: 'author',
      field: 'authorId', confidence: 0.99 }],
  };
  const author = entity('author:k:collision', 'alice', 100, { type: 'author', typeName: 'Author' });
  const conflictingAuthor = entity('author:k:collision', 'bob', 200, { type: 'author', typeName: 'Author' });
  const post = entity('post:k:safe', 'post1', 300, {
    type: 'post', typeName: 'Post', attrs: { id: 'post1', authorId: 'alice' },
    revisions: [{ t: 300, session: 'session1', values: { id: 'post1', authorId: 'alice' } }],
  });
  const g = buildGraph({ model: modelWithReference, resolutions: [
    { type: 'author', entities: [author, conflictingAuthor] },
    { type: 'post', entities: [post] },
  ] });
  assert.equal(g.nodes.has(author.eid), false);
  assert.equal(g.nodes.has(post.eid), true);
  assert.equal(g.edges.size, 0);
});

test('NSP-004: direct graph upsert rejects incompatible typed key without partial mutation', () => {
  const g = new TemporalGraph();
  g.upsertEntity({ eid: 'shared', type: 'thing', key: 42,
    attrs: { value: 'observed' }, t: 100 });
  assert.throws(() => g.upsertEntity({ eid: 'shared', type: 'thing', key: '42',
    attrs: { value: 'wrong' }, t: 200, evidence: { session: 'session1', seq: 42 } }),
    (error) => error.code === 'NSP-004' && error.receipt.source.seq === 42);
  assert.equal(g.nodes.get('shared').key, 42);
  assert.equal(g.nodes.get('shared').attrs.value, 'observed');
  assert.equal(g.nodes.get('shared').history.length, 1);
  assert.equal(g.changes.length, 1);
});
