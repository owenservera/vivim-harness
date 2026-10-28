import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSelfKnowledge, SELF_KNOWLEDGE_TOPICS } from '../../src/agents/personal-agent-self-knowledge.mjs';

const agent = {
  initialized: true, agentId: 'primary', version: 7, nextStage: null,
  stages: { 'identity-and-sitrep': { status: 'completed', evidence: ['local:identity'] } },
  memoryCounts: { CANON: 1, Immediate: 2, Curated: 0 },
  work: { total: 1, byStatus: { queued: 1, active: 0, blocked: 0, completed: 0, cancelled: 0 } },
};
const at = '2026-10-28T21:02:00.000Z';
const args = { agent, world: { state: 'enumerated', projects: 2, notes: 3, evidence: ['local:world/abc'] }, skills: {
  skillsDiscovered: 2, toolsRegistered: 8, readOnlyToolsRegistered: 6,
  sourceCoverageComplete: true, evidence: ['local:agentic-files/abc'],
}, at };
test('all seven self-knowledge domains have grounded claims and fresh observation labels', () => {
  const report = buildSelfKnowledge(args);
  assert.equal(report.schema, 'vivim.personal-agent.self-knowledge/1');
  assert.deepEqual(Object.keys(report.answers), SELF_KNOWLEDGE_TOPICS);
  for (const answer of Object.values(report.answers)) {
    assert.equal(answer.observedAt, at);
    assert.ok(answer.basis);
    assert.ok(answer.qualification);
    assert.ok(Array.isArray(answer.evidence));
    assert.equal(answer.trust.includes('not provider confirmation'), true);
  }
});
test('sensitive content and execution claims are not invented by self-knowledge', () => {
  const result = buildSelfKnowledge({ ...args, topic: 'all' });
  assert.equal(result.answers.identity.value.providerAccountVerified, false);
  assert.equal(result.answers.memory.value.tiers.Immediate, 2);
  assert.equal(result.answers.privacy.value.memoryVersionHistory.includes('not secure erasure'), true);
  assert.equal(JSON.stringify(result).includes('secret personal note'), false);
  assert.equal(result.answers.capabilities.qualification.includes('do not prove'), true);
});
test('scoped query does not include unrelated domains or inspectable private memory', () => {
  const result = buildSelfKnowledge({ ...args, topic: 'work' });
  assert.deepEqual(Object.keys(result.answers), ['work']);
  assert.equal(result.answers.work.value.total, 1);
  assert.equal(result.answers.work.qualification.includes('do not independently prove'), true);
});
test('unknown topics fail explicitly instead of silently returning an ungrounded answer', () => {
  assert.throws(() => buildSelfKnowledge({ ...args, topic: 'passwords' }), e => e.code === 'PERSONAL_AGENT_TOPIC_INVALID');
});

test('an uninitialized agent does not claim a grounded zero Work or memory index', () => {
  // Regression: `agent.work ?? { total: 0, byStatus: {} }` fabricated a confident zero-count claim for an
  // agent that has no local state at all.
  const uninitialized = { initialized: false, agentId: 'primary', nextStage: 'identity-and-sitrep', stages: null };
  const report = buildSelfKnowledge({ agent: uninitialized, world: { state: 'not-inspected' }, at });
  assert.deepEqual(report.answers.work.value, { initialized: false, total: null, byStatus: null });
  assert.deepEqual(report.answers.memory.value, { initialized: false, tiers: null });
  assert.equal(report.answers.work.evidence.length, 0);
  assert.equal(report.answers.work.sourceUpdatedAt, null, 'freshness has no local revision to point at');
});

test('freshness is anchored to the real local state revision time, and identity carries the local scope', () => {
  const grounded = { ...agent, updatedAt: '2026-10-28T20:59:00.000Z', scopeFingerprint: 'local-dir-sha256:0123456789abcdef0123' };
  const report = buildSelfKnowledge({ ...args, agent: grounded });
  for (const topic of ['identity', 'bootstrap', 'memory', 'work']) {
    assert.equal(report.answers[topic].sourceUpdatedAt, '2026-10-28T20:59:00.000Z');
    assert.equal(report.answers[topic].observedAt, at);
  }
  assert.equal(report.answers.world.sourceUpdatedAt, at, 'request-time projections are observed now');
  assert.equal(report.answers.identity.value.scopeFingerprint, 'local-dir-sha256:0123456789abcdef0123');
  assert.equal(report.answers.identity.value.scope, 'local-data-directory');
  assert.equal(report.answers.work.value.initialized, true);
  assert.equal(report.answers.work.value.total, 1);
});
