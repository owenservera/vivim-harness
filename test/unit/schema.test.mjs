import { test } from 'node:test';
import assert from 'node:assert/strict';
import { induce, alignFields, schemaSimilarity, schemaDiff, nameSimilarity } from '../../src/intel/schema.mjs';

const uuid = (i) => `${String(i).padStart(8, '0')}-aaaa-4bbb-8ccc-${String(i).padStart(12, '0')}`;

test('formats, enums, optionality and nullability are inferred with their evidence', () => {
  const vals = Array.from({ length: 20 }, (_, i) => ({ id: uuid(i), status: ['open', 'closed'][i % 2], created: 1792500000 + i, at: `2026-10-${String(1 + i).padStart(2, '0')}T10:00:00Z`, link: `https://x.org/${i}`, note: i % 4 ? null : 'n', body: `# Title ${i}\n\n- point one\n- point two that is long enough` }));
  const d = induce(vals);
  assert.equal(d.type, 'object');
  assert.ok(d.fields.id.string.formats.uuid);
  assert.equal(d.fields.id.string.uniqueness, 1);
  assert.deepEqual(d.fields.status.string.enum.map((e) => e.value).sort(), ['closed', 'open']);
  assert.equal(d.fields.created.number.format, 'epoch_s');
  assert.ok(d.fields.at.string.formats.iso_time);
  assert.ok(d.fields.link.string.formats.url);
  assert.ok(d.fields.note.nullable);
  assert.ok(d.fields.body.string.formats.markdown);
  assert.equal(d.fields.id.required, true);
});

test('dynamic keys become a map, not hundreds of fields', () => {
  const v = [{ byId: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [uuid(i), { name: `n${i}`, n: i }])) }];
  const d = induce(v);
  assert.equal(d.fields.byId.type, 'map');
  assert.equal(d.fields.byId.map.values.type, 'object');
  assert.deepEqual(Object.keys(d.fields.byId.map.values.fields).sort(), ['n', 'name']);
  const idx = induce([{ blocks: { 0: { t: 'a' }, 1: { t: 'b' }, 2: { t: 'c' }, 3: { t: 'd' }, 4: { t: 'e' }, 5: { t: 'f' } } }]);
  assert.equal(idx.fields.blocks.type, 'map');
});

test('tagged unions are detected from discriminator-conditioned field sets', () => {
  const blocks = [];
  for (let i = 0; i < 10; i++) {
    blocks.push({ kind: 'text', text: `t${i}`, style: 'p' });
    blocks.push({ kind: 'image', src: `/i/${i}.png`, alt: 'a', width: 10 });
    blocks.push({ kind: 'table', rows: [[1]], columns: ['a'] });
  }
  const d = induce(blocks);
  assert.equal(d.tagged.field, 'kind');
  assert.deepEqual(d.tagged.variants.map((v) => v.value).sort(), ['image', 'table', 'text']);
  assert.ok(d.tagged.variants.find((v) => v.value === 'image').fields.includes('src'));
  // A low-cardinality field that does NOT condition structure is not a tag.
  const same = Array.from({ length: 20 }, (_, i) => ({ color: ['red', 'blue'][i % 2], a: 1, b: 2 }));
  assert.equal(induce(same).tagged, undefined);
});

test('mixed types become explicit unions rather than silently choosing one', () => {
  const d = induce([{ v: 1 }, { v: 'x' }, { v: { a: 1 } }, { v: 2 }]);
  assert.equal(d.fields.v.type, 'union');
  assert.equal(d.fields.v.union.length, 3);
});

test('fields align across sites with different naming conventions', () => {
  const a = induce(Array.from({ length: 10 }, (_, i) => ({ id: uuid(i), title: `Task ${i} title`, due_date: `2026-11-0${1 + (i % 9)}`, assignee_name: `Ann ${i}`, done: i % 2 === 0 })));
  const b = induce(Array.from({ length: 10 }, (_, i) => ({ uuid: uuid(100 + i), name: `Item ${i} label`, dueAt: `2026-12-0${1 + (i % 9)}T00:00:00Z`, owner: `Bob ${i}`, completed: i % 3 === 0 })));
  const al = alignFields(a, b);
  const m = Object.fromEntries(al.pairs.map((p) => [p.a, p.b]));
  assert.equal(m.id, 'uuid');
  assert.equal(m.title, 'name');
  assert.equal(m.due_date, 'dueAt');
  assert.equal(m.done, 'completed');
  assert.equal(m.assignee_name, 'owner');
  assert.ok(schemaSimilarity(a, b) > 0.6);
  const unrelated = induce(Array.from({ length: 10 }, (_, i) => ({ cpu: i * 1.5, mem: i * 2.5, host: 'h' })));
  assert.ok(schemaSimilarity(a, unrelated) < 0.35, String(schemaSimilarity(a, unrelated)));
  assert.ok(nameSimilarity('createdAt', 'created_at') > 0.9);
});

test('schema drift: removed+added fields with similar values are proposed as a rename', () => {
  const v1 = induce(Array.from({ length: 12 }, (_, i) => ({ id: uuid(i), title: `Post ${i} about things`, views: i * 10 })));
  const v2 = induce(Array.from({ length: 12 }, (_, i) => ({ id: uuid(i), headline: `Post ${i} about other things`, views: i * 10, tags: ['a'] })));
  const diff = schemaDiff(v1, v2);
  assert.equal(diff.drifted, true);
  assert.deepEqual(diff.removed, ['title']);
  assert.ok(diff.added.includes('headline'));
  assert.equal(diff.repairs[0].from, 'title');
  assert.equal(diff.repairs[0].to, 'headline');
});
