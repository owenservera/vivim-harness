// Adversarial tests for discovery and identity resolution.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discoverModel } from '../../src/intel/discover.mjs';
import { resolveType, linkage } from '../../src/intel/identity.mjs';
import { modelSignature } from '../../eval/run.mjs';

const ev = (group, value, extra = {}) => ({ value, source: { kind: 'event', group, ...extra } });
function lcg(seed) { let s = seed; return () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648; }
const shuffle = (a, r) => { const x = a.slice(); for (let i = x.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [x[i], x[j]] = [x[j], x[i]]; } return x; };

test('key = revision-stable identifier, not a per-observation-unique measure or timestamp', () => {
  const s = [];
  for (let n = 0; n < 40; n++) s.push(ev('WS x :: q', { pair: ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD'][n % 4], bid: 1 + n / 1000, ts: 1792500000000 + n }, { seq: n, t: n }));
  const m = discoverModel(s);
  assert.equal(m.types[0].key.field, 'pair');
  assert.equal(resolveType(m.types[0]).entities.length, 4);
});

test('model is identical under 20 random permutations of the observations', () => {
  const s = [];
  for (let p = 0; p < 3; p++) s.push(ev('GET a/api/users :: (object)', { users: [1, 2, 3, 4].map((i) => ({ id: `u${i}`, name: `N${i}`, team: i % 2 ? 't1' : 't2' })) }, { seq: p }));
  s.push(ev('GET a/api/teams :: (object)', { teams: [{ id: 't1', label: 'One' }, { id: 't2', label: 'Two' }] }, { seq: 10 }));
  for (let p = 0; p < 4; p++) s.push(ev('GET a/api/users/{id} :: (object)', { id: `u${p + 1}`, name: `N${p + 1}x`, team: 't1', bio: 'long bio text here for the user' }, { seq: 20 + p }));
  const base = modelSignature(discoverModel(s));
  const r = lcg(42);
  for (let i = 0; i < 20; i++) assert.equal(modelSignature(discoverModel(shuffle(s, r))), base, `permutation ${i}`);
});

test('a rare variant deep in a large array is still discovered (shape-aware sampling)', () => {
  const items = Array.from({ length: 5000 }, (_, i) => ({ id: `i${i}`, kind: 'row', v: i }));
  items[4321] = { id: 'i4321', kind: 'note', author: 'a', body: 'rare body text' };
  items[4999] = { id: 'i4999', kind: 'note', author: 'b', body: 'another rare body' };
  const m = discoverModel([ev('GET l :: (object)', { items }, { seq: 1 })]);
  const t = m.types.find((x) => x.fields.some((f) => f.name === 'body'));
  assert.ok(t, 'note fields present');
  assert.equal(t.tagged?.field, 'kind');
});

test('mutual inclusion: the pointer field is demoted, the owning type keeps its key', () => {
  const s = [];
  const steps = ['s_aaa111', 's_bbb222', 's_ccc333'];
  for (let p = 0; p < 3; p++) s.push(ev('GET f/api/app/{id} :: (object)', { app: { app_ref: 'A-1', current_step: steps[p], status: p ? 'open' : 'new' }, steps: steps.map((id, i) => ({ step_id: id, name: `n${i}`, state: i < p ? 'done' : 'todo' })) }, { seq: p }));
  const m = discoverModel(s);
  const step = m.types.find((t) => t.fields.some((f) => f.name === 'step_id'));
  const app = m.types.find((t) => t.fields.some((f) => f.name === 'current_step'));
  assert.equal(step.key.field, 'step_id');
  assert.notEqual(app.key?.weak ? null : app.key?.field, 'current_step');
  assert.ok(m.relationships.some((r) => r.kind === 'references' && r.field === 'current_step' && r.to === step.id));
});

test('linkage never chains distinct entities through a partial observation', () => {
  // Two distinct turns share a long prefix; a partial render of B looks like both.
  const stem = 'the quick brown fox jumps over the lazy dog near the river bank today';
  const A = `${stem} and then went home to sleep`, B = `${stem} but stopped to drink some water`;
  const mk = (role, text, dom, t) => ({ obj: { role, text }, prov: { domId: dom, t } });
  const type = { id: 't', name: 'turn', key: null, fields: [{ name: 'role', type: 'string', presence: 1 }, { name: 'text', type: 'string', presence: 1 }], instances: [
    mk('assistant', `${stem} but stopped`, 1, 0), mk('assistant', A, 2, 1000), mk('assistant', B, 3, 1001), mk('assistant', A, 4, 2000), mk('assistant', B, 5, 2001),
  ] };
  const res = linkage(type);
  const clusterOf = (dom) => res.entities.findIndex((e) => e.revisions.some((r) => r.domId === dom) || (e.observations > e.revisions.length && false));
  assert.equal(res.entities.length >= 2, true);
  // A and B (same snapshot) are never in one entity.
  for (const e of res.entities) { const doms = new Set(e.revisions.map((r) => r.domId)); assert.ok(!(doms.has(2) && doms.has(3)) && !(doms.has(4) && doms.has(5))); }
  assert.ok(clusterOf(1) >= 0);
});

test('keyed resolution separates revisions from exact duplicates', () => {
  const inst = [{ id: 'x', v: 1 }, { id: 'x', v: 1 }, { id: 'x', v: 2 }, { id: 'y', v: 1 }].map((o, i) => ({ obj: o, prov: { t: i, seq: i } }));
  const r = resolveType({ id: 't', name: 't', key: { field: 'id', score: 0.9 }, fields: [], instances: inst });
  const x = r.entities.find((e) => e.key === 'x');
  assert.equal(x.observations, 3);
  assert.equal(x.duplicates, 1);
  assert.equal(x.revisions.length, 2);
  assert.deepEqual(x.revisions[1].changed, ['v']);
});

test('unknown pipe-delimited protocol frames still yield a keyed entity type', () => {
  const s = [];
  for (let n = 0; n < 20; n++) s.push(ev('WS z :: EVT|job.progress', { job: `J${n % 3}`, pct: n * 5, eta_s: 100 - n }, { seq: n }));
  const m = discoverModel(s);
  assert.equal(m.types[0].key.field, 'job');
});
