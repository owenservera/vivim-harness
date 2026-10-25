// Four small, synthetic, source-owned QA handoff cases for Windows L4.
// These fixtures contain no user's real recordings, prompts, credentials or accounts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TemporalGraph } from '../../src/intel/graph.mjs';
import { buildSiteContinuity } from '../../src/intel/continuity.mjs';
import { ScopedLearner } from '../../src/intel/learn.mjs';
import { LearnerJournal } from '../../src/intel/learner-journal.mjs';
import { observationBoundary } from '../../src/intel/temporal-truth.mjs';

const fixture = (id) => JSON.parse(readFileSync(new URL('../fixtures/knowledge-handoff/' + id + '.json', import.meta.url), 'utf8'));
const withTemp = async (t, callback) => {
  const dir = mkdtempSync(join(tmpdir(), 'aion-knowledge-handoff-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return callback(dir);
};

test('KH-01 as-of truth: late observation, explicit removal, edge status and future cutoff', () => {
  const f = fixture('01-as-of-truth');
  const g = new TemporalGraph();
  for (const r of f.entity.revisions) {
    g.upsertEntity({ ...f.entity, attrs: r.attrs, t: r.t, removed: r.removed ?? [],
      evidence: { session: 'synthetic-KH-01', seq: r.seq }, revisions: undefined });
  }
  g.relate(f.relation);
  const edge = f.relation.kind + ':' + f.relation.from + '->' + f.relation.to;
  g.setEdgeStatus(edge, 'rejected', f.relation.rejectAt);
  for (const q of f.queries) {
    const snapshot = g.stateAt(q.asOf);
    assert.deepEqual(snapshot.nodes[0].attrs, q.attrs, 'asOf=' + q.asOf);
    assert.equal(snapshot.edges.length, q.edges, 'edge evidence leaked at ' + q.asOf);
  }
  assert.equal(observationBoundary(f.observation, f.futureCutoff).state, 'not-yet-observed');
});

test('KH-02 exact-origin + typed-key join, no number/string/keyless/host conflation', async (t) => withTemp(t, async (dir) => {
  const f = fixture('02-identity-exclusion');
  for (const s of f.sessions) {
    const folder = join(dir, s.id);
    mkdirSync(join(folder, 'kv'), { recursive: true });
    mkdirSync(join(folder, 'datasets'), { recursive: true });
    writeFileSync(join(folder, 'session.json'), JSON.stringify({
      id: s.id, createdAt: '2026-10-22T10:00:00.000Z',
      target: { url: 'https://' + s.host + '/view' },
    }));
    writeFileSync(join(folder, 'kv', 'MODEL.json'), JSON.stringify({ types: [f.type] }));
    writeFileSync(join(folder, 'kv', 'KNOWLEDGE_STATUS.json'), JSON.stringify({ status: 'complete', entityCount: 1 }));
    const e = s.entity;
    const record = { eid: e.eid, type: f.type.id, typeName: f.type.name, method: e.method,
      scope: f.site, key: e.key, ...(e.keyType ? { keyType: e.keyType } : {}),
      observations: 1, revisions: [{ t: e.t, seq: 1, sid: 'fixture', values: { id: e.key, label: e.label },
        changed: ['id','label'] }] };
    writeFileSync(join(folder, 'datasets', 'entities.jsonl'), JSON.stringify(record) + '\n');
  }
  const result = await buildSiteContinuity(dir, { site: f.site, origin: f.origin, includeHistory: true });
  assert.equal(result.stats.joinedEntities, f.expected.joinedEntities);
  const linked = result.entities.find((e) => e.sessionCount === 2 && e.keyType === 'string');
  assert.ok(linked, 'same-origin string-key observations should join');
  assert.deepEqual([...linked.sessions].sort(), f.expected.sameTypedStringSessions);
  assert.ok(result.entities.some((e) => e.keyType === 'number' && e.sessionCount === 1));
  assert.ok(result.entities.some((e) => e.identityBasis === 'session-local' || e.identityBasis === 'provisional-missing-key'));
  assert.ok(result.entities.every((e) => e.sessions.every((id) => id !== 'kh02-d')));
  // Account identity is deliberately not asserted; this API verifies origin+typed key, not account.
}));

test('KH-03 versioned correction: rejected proposal, scoped accept, immutable rollback', async (t) => withTemp(t, async (dir) => {
  const f = fixture('03-correction-version');
  const learner = new ScopedLearner(dir);
  const other = { ...f.ctx, account: f.otherAccount };
  const score = (ctx) => learner.predict(f.field, f.description, ctx).dist[f.role];
  const baseline = score(f.ctx), unrelated = score(other);
  const rejected = learner.proposeCorrection({ scope: 'account', ctx: f.ctx, name: f.field,
    d: f.description, role: f.role, evidence: f.events[0].evidence });
  learner.reviewCorrection(rejected.id, { action: 'reject', actor: 'synthetic-owner' });
  assert.equal(score(f.ctx), baseline);
  assert.equal(learner.save(), f.expected.rejectedRevision);
  const accepted = learner.proposeCorrection({ scope: 'account', ctx: f.ctx, name: f.field,
    d: f.description, role: f.role, evidence: f.events[1].evidence });
  learner.reviewCorrection(accepted.id, { action: 'accept', actor: 'synthetic-owner' });
  assert.ok(score(f.ctx) > baseline);
  assert.equal(score(other), unrelated, 'correcting Alice must not change Bob');
  assert.equal(learner.save(), f.expected.acceptedRevision);
  assert.equal(learner.rollbackTo(f.events[2].toRevision, { actor: 'synthetic-owner' }),
    f.expected.rollbackRevision);
  assert.equal(score(f.ctx), baseline);
  assert.deepEqual(new ScopedLearner(dir).versions(), f.expected.versions);
  assert.ok(new LearnerJournal(dir).at(f.expected.acceptedRevision).corrections.some((c) => c.id === accepted.id));
  assert.ok(new ScopedLearner(dir).audit.some((a) => a.action === 'rollback'));
}));

test('KH-04 eligibility input cases: only explicitly verified accepted derived evidence may train', () => {
  const f = fixture('04-evidence-eligibility');
  const allowed = (c) => c.derivedShapes === true && c.knowledgeStatus === 'complete'
    && c.acceptance?.status === 'accepted' && c.acceptance?.verified === true;
  assert.equal(f.cases.filter((c) => c.expectedEligible).length, 1);
  for (const c of f.cases) assert.equal(allowed(c), c.expectedEligible, c.session);
  // This checks fixture/admission *requirements*, NOT a Core family-builder enforcement.
  // The current collectSessions() uses hasDerived=!!shapes; acceptance gate is pending.
});

test.todo('KH-04 Core integration: family-builder must enforce verified accepted capture sidecar before shape promotion');
