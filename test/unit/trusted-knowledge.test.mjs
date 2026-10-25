// CORE-owned contract cases. Independent QA retains its own separate fixtures and receipts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveType } from '../../src/intel/identity.mjs';
import { buildGraph, TemporalGraph } from '../../src/intel/graph.mjs';
import { buildSiteContinuity } from '../../src/intel/continuity.mjs';

const type = { id: 'thing', name: 'Thing', key: { field: 'id', score: 0.95 },
  fields: [{ name: 'id', type: 'string' }, { name: 'label', type: 'string' }] };
const entity = (eid, key, label, t, overrides = {}) => ({
  eid, type: 'thing', typeName: 'Thing', method: 'key', scope: 'example.com',
  key, observations: 1, revisions: [{ t, seq: t, sid: 'one',
    values: { id: key, label }, changed: ['id', 'label'] }], ...overrides,
});
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'capture-core-trust-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const add = (id, host, entities, { outcome, model, rawEntities } = {}) => {
    const root = join(dir, id);
    mkdirSync(join(root, 'kv'), { recursive: true });
    mkdirSync(join(root, 'datasets'), { recursive: true });
    writeFileSync(join(root, 'session.json'), JSON.stringify({
      id, createdAt: '2026-10-21T00:00:00.000Z',
      target: { url: 'https://' + host + '/capture' },
    }));
    if (model !== null) writeFileSync(join(root, 'kv', 'MODEL.json'),
      JSON.stringify(model ?? { types: [type] }));
    if (outcome !== null) writeFileSync(join(root, 'kv', 'KNOWLEDGE_STATUS.json'),
      JSON.stringify(outcome ?? { status: 'complete', entityCount: entities?.length ?? 0 }));
    if (rawEntities !== undefined) writeFileSync(join(root, 'datasets', 'entities.jsonl'), rawEntities);
    else if (entities?.length) writeFileSync(join(root, 'datasets', 'entities.jsonl'),
      entities.map((x) => JSON.stringify(x)).join('\n') + '\n');
  };
  return { dir, add };
}

test('missing inferred identity values never collide in the same graph', () => {
  const inferred = { ...type, instances: [
    { obj: { label: 'A' }, prov: { site: 'example.com', session: 'session1', seq: 1, t: 100 } },
    { obj: { id: null, label: 'B' }, prov: { site: 'example.com', session: 'session1', seq: 2, t: 200 } },
    { obj: { id: 'valid', label: 'C' }, prov: { site: 'example.com', session: 'session1', seq: 3, t: 300 } },
    { obj: { id: 'valid', label: 'D' }, prov: { site: 'example.com', session: 'session1', seq: 4, t: 400 } },
  ] };
  const resolution = resolveType(inferred);
  assert.equal(resolution.entities.length, 3);
  assert.equal(new Set(resolution.entities.map((x) => x.eid)).size, 3);
  assert.equal(resolution.entities.filter((x) => x.method === 'provisional').length, 2);
  assert.ok(resolution.entities.filter((x) => x.method === 'provisional')
    .every((x) => x.key === null && x.confidence === null));
  const graph = buildGraph({ model: { types: [inferred], relationships: [] }, resolutions: [resolution] });
  assert.equal(graph.nodes.size, 3);
});

test('explicit field removal changes only later historical state', () => {
  const g = new TemporalGraph();
  g.upsertEntity({ eid: 'e', type: 'thing', attrs: { a: 1, b: 2 }, t: 100 });
  g.upsertEntity({ eid: 'e', type: 'thing', attrs: { a: 3 }, removed: ['b'], t: 200 });
  assert.deepEqual(g.stateAt(150).nodes[0].attrs, { a: 1, b: 2 });
  assert.deepEqual(g.stateAt(250).nodes[0].attrs, { a: 3 });
});

test('same-origin keyed history joins but another host and keyless do not', async (t) => {
  const { dir, add } = fixture(t);
  add('s1', 'app.example.com', [entity('thing:k:same', 'x', 'Old', 100)]);
  add('s2', 'app.example.com', [entity('thing:k:same', 'x', 'New', 200)]);
  add('s3', 'other.example.com', [entity('thing:k:same', 'x', 'Other host', 200)]);
  add('s4', 'app.example.com', [entity('thing:e:local', null, 'Only here', 100, { method: 'linkage' })]);
  const latest = await buildSiteContinuity(dir, { site: 'example.com', includeHistory: true });
  assert.equal(latest.stats.joinedEntities, 1);
  assert.equal(latest.entities.filter((e) => e.eid === 'thing:k:same').length, 2);
  assert.ok(latest.entities.some((e) => e.sessionCount === 2 && e.attrs.label === 'New'));
  const past = await buildSiteContinuity(dir, { site: 'example.com', asOf: 150 });
  assert.ok(past.entities.some((e) => e.eid === 'thing:k:same' && e.sessionCount === 1));
});

test('successful zero entities is distinct from failed and incomplete knowledge', async (t) => {
  const { dir, add } = fixture(t);
  add('empty', 'app.example.com', [], { outcome: { status: 'complete', entityCount: 0 } });
  add('pending', 'app.example.com', [], { outcome: { status: 'deriving' } });
  add('failed', 'app.example.com', [], { outcome: { status: 'failed', stage: 'graph' } });
  add('truncated', 'app.example.com', [entity('thing:k:truncated', 't', 'T', 100)],
    { outcome: { status: 'complete', entityCount: 2 } });
  const x = await buildSiteContinuity(dir, { site: 'example.com' });
  assert.ok(x.stats.sessionsSuccessfulEmpty.includes('empty'));
  assert.ok(x.stats.sessionsWithDerivationError.some((r) => r.session === 'failed'));
  assert.ok(x.stats.sessionsIncompleteKnowledge.some((r) => r.session === 'pending'));
  assert.ok(x.stats.sessionsIncompleteKnowledge.some((r) => r.session === 'truncated'));
  assert.ok(x.stats.sessionsWithoutKnowledge.includes('pending'));
  assert.equal(x.stats.sessionsWithDerivedKnowledge, 1);
  assert.equal(x.entities.length, 0);
});

test('legacy missing-key EID aliases remain separate in continuity', async (t) => {
  const { dir, add } = fixture(t);
  add('old', 'app.example.com', [
    entity('thing:k:broken', null, 'A', 100),
    entity('thing:k:broken', null, 'B', 200),
  ], { outcome: null });
  const x = await buildSiteContinuity(dir, { site: 'example.com' });
  assert.equal(x.stats.legacyEidCollisions, 2);
  assert.equal(x.entities.length, 2);
  assert.equal(new Set(x.entities.map((e) => e.id)).size, 2);
  assert.deepEqual(x.stats.sessionsLegacyUnverified, ['old']);
});

test('an explicitly removed field disappears from longitudinal as-of state', async (t) => {
  const { dir, add } = fixture(t);
  const e = entity('thing:k:removal', 'x', 'One', 100);
  e.revisions.push({ t: 200, seq: 2, sid: 'one', changed: ['label'], values: {},
    removed: ['label'] });
  add('s1', 'app.example.com', [e]);
  const before = await buildSiteContinuity(dir, { site: 'example.com', asOf: 150 });
  const after = await buildSiteContinuity(dir, { site: 'example.com', asOf: 250, includeHistory: true });
  assert.equal(before.entities[0].attrs.label, 'One');
  assert.equal(Object.hasOwn(after.entities[0].attrs, 'label'), false);
  assert.deepEqual(after.entities[0].history[1].removed, ['label']);
});

test('corrupt derived JSONL is excluded and counted as incomplete', async (t) => {
  const { dir, add } = fixture(t);
  add('corrupt', 'app.example.com', [], {
    outcome: { status: 'complete', entityCount: 1 },
    rawEntities: '{invalid-json-line\n',
  });
  const x = await buildSiteContinuity(dir, { site: 'example.com' });
  assert.equal(x.entities.length, 0);
  assert.ok(x.stats.sessionsIncompleteKnowledge.some((r) =>
    r.session === 'corrupt' && r.reason === 'unreadable-entities-dataset'));
  assert.ok(x.stats.sessionsWithoutKnowledge.includes('corrupt'));
});

test('valid rows surrounding corrupt JSONL never leak partial continuity, including legacy datasets', async (t) => {
  const { dir, add } = fixture(t);
  const row = JSON.stringify(entity('thing:k:partial', 'p', 'Partial', 100));
  const rawEntities = row + '\n{broken\n' + row + '\n';
  add('marked', 'app.example.com', [], { outcome: { status: 'complete', entityCount: 2 }, rawEntities });
  add('legacy', 'app.example.com', [], { outcome: null, rawEntities });
  const x = await buildSiteContinuity(dir, { site: 'example.com' });
  assert.equal(x.entities.length, 0); assert.equal(x.stats.sessionsWithDerivedKnowledge, 0);
  assert.equal(x.stats.sessionsIncompleteKnowledge.length, 2);
  assert.ok(x.stats.sessionsIncompleteKnowledge.every((r) => r.reason === 'unreadable-entities-dataset'));
});

test('type drift is review-only and does not invent an identity merge', async (t) => {
  const { dir, add } = fixture(t);
  add('first', 'app.example.com', [entity('thing:k:x', 'x', 'Earlier', 100)]);
  const newer = entity('changed:k:x', 'x', 'Later', 200, {
    type: 'changed', typeName: 'Thing' });
  add('later', 'app.example.com', [newer], {
    model: { types: [{ ...type, id: 'changed' }] },
  });
  const x = await buildSiteContinuity(dir, { site: 'example.com' });
  assert.equal(x.stats.joinedEntities, 0);
  assert.equal(x.entities.length, 2);
  assert.equal(x.typeDriftHints.length, 1);
  assert.equal(x.typeDriftHints[0].identityMerged, false);
  assert.equal(x.typeDriftHints[0].status, 'unconfirmed');
});

test('user-facing origin filter does not expose unrelated hosted subdomains', async (t) => {
  const { dir, add } = fixture(t);
  add('alice', 'alice.github.io', [entity('one', 'x', 'Alice', 100)]);
  add('bob', 'bob.github.io', [entity('two', 'x', 'Bob', 100)]);
  const narrowed = await buildSiteContinuity(dir, {
    site: 'github.io', origin: 'https://alice.github.io',
  });
  assert.equal(narrowed.origin, 'https://alice.github.io');
  assert.equal(narrowed.stats.sessionsDiscovered, 1);
  assert.equal(narrowed.entities.length, 1);
  assert.deepEqual(narrowed.entities[0].sessions, ['alice']);
  const audit = await buildSiteContinuity(dir, { site: 'github.io' });
  assert.equal(audit.stats.sessionsDiscovered, 2);
});

test('number and string key identities remain separate in continuity and drift review', async (t) => {
  const { dir, add } = fixture(t);
  for (const [id, keyType, eid, label, ts] of [
    ['num-a', 'number', 'thing:k:n:42', 'Number A', 100],
    ['num-b', 'number', 'thing:k:n:42', 'Number B', 200],
    ['text-a', 'string', 'thing:k:text42', 'Text A', 100],
    ['text-b', 'string', 'thing:k:text42', 'Text B', 200],
    ['legacy', null, 'thing:k:legacy42', 'Old ambiguous', 150],
  ]) {
    add(id, 'app.example.com', [entity(eid, '42', label, ts, {
      ...(keyType ? { keyType } : {}),
    })]);
  }
  const result = await buildSiteContinuity(dir, {
    site: 'example.com', origin: 'https://app.example.com',
  });
  assert.equal(result.entities.length, 3);
  assert.equal(result.stats.joinedEntities, 2);
  const types = result.entities.map((item) => item.keyType).sort();
  assert.deepEqual(types, ['legacy-untyped', 'number', 'string']);
  assert.equal(result.entities.filter((item) => item.sessionCount === 2).length, 2);
  assert.equal(result.typeDriftHints.length, 0, 'typed key groups must not generate cross-type drift');
});

test('type drift review never compares number and string key cohorts', async (t) => {
  const { dir, add } = fixture(t);
  add('num', 'app.example.com', [entity('thing:k:n:42', '42', 'Number', 100, {
    keyType: 'number', type: 'thing', typeName: 'Thing',
  })], { model: { types: [type] } });
  add('text', 'app.example.com', [entity('other:k:42', '42', 'Text', 200, {
    keyType: 'string', type: 'other', typeName: 'Thing',
  })], { model: { types: [{ ...type, id: 'other' }] } });
  const result = await buildSiteContinuity(dir, {
    site: 'example.com', origin: 'https://app.example.com',
  });
  assert.equal(result.entities.length, 2);
  assert.equal(result.stats.joinedEntities, 0);
  assert.deepEqual(result.typeDriftHints, [], 'same display text is not cross-type evidence');
});
