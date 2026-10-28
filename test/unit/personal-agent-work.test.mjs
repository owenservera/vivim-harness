import test from 'node:test';
import assert from 'node:assert/strict';
import { createWork, transitionWork, workSummary, WORK_STATES, MAX_WORK_ITEMS } from '../../src/agents/personal-agent-work.mjs';

const now = '2026-10-28T21:00:00.000Z';
const start = () => ({ schemaVersion: 1, version: 5, work: [], updatedAt: now });
const add = (state = start(), key = 'customer_task_000001') =>
  createWork(state, { title: 'Explore local providers', objective: 'Inventory only; no send', idempotencyKey: key, now });

test('Work creation persists as a queued local record with no dispatch claim', () => {
  const { state, item, changed } = add();
  assert.equal(changed, true);
  assert.equal(item.status, 'queued');
  assert.equal(item.source, 'user-authored');
  assert.deepEqual(item.evidence, []);
  assert.equal(state.work.length, 1);
  assert.equal(workSummary(state).byStatus.queued, 1);
  assert.equal(workSummary(state).authority.includes('not provider execution'), true);
});
test('idempotency reuses exact prior payload without a state mutation', () => {
  const first = add();
  const repeated = add(first.state);
  assert.equal(repeated.changed, false);
  assert.equal(repeated.state, first.state);
  assert.equal(repeated.item.id, first.item.id);
  assert.throws(() => createWork(first.state, {
    title: 'Different payload', objective: 'Inventory only; no send',
    idempotencyKey: 'customer_task_000001', now,
  }), e => e.code === 'PERSONAL_AGENT_WORK_IDEMPOTENCY_CONFLICT');
});
test('different keys produce unique records and bounded id format', () => {
  const first = add(), second = add(first.state, 'customer_task_000002');
  assert.match(first.item.id, /^work-[a-f0-9]{32}$/);
  assert.notEqual(first.item.id, second.item.id);
});
test('cannot complete queued Work directly or complete without receipts', () => {
  const first = add();
  assert.throws(() => transitionWork(first.state, { id: first.item.id, to: 'completed', now, evidence: ['local:test'] }),
    e => e.code === 'PERSONAL_AGENT_WORK_TRANSITION');
  const active = transitionWork(first.state, { id: first.item.id, to: 'active', now });
  assert.throws(() => transitionWork(active.state, { id: first.item.id, to: 'completed', now }),
    e => e.code === 'PERSONAL_AGENT_WORK_EVIDENCE_REQUIRED');
  const done = transitionWork(active.state, { id: first.item.id, to: 'completed', now, evidence: ['source:github/commit/abc'] });
  assert.equal(done.item.status, 'completed');
  assert.equal(done.item.evidence[0].basis, 'user-attested; unverified-for-live-execution');
  assert.equal(workSummary(done.state).byStatus.completed, 1);
  assert.throws(() => transitionWork(done.state, { id: first.item.id, to: 'active', now }),
    e => e.code === 'PERSONAL_AGENT_WORK_TRANSITION');
});
test('blocked Work requires reason, can resume, cannot skip into completed', () => {
  const first = add();
  assert.throws(() => transitionWork(first.state, { id: first.item.id, to: 'blocked', now }),
    e => e.code === 'PERSONAL_AGENT_WORK_INVALID');
  const blocked = transitionWork(first.state, { id: first.item.id, to: 'blocked', note: 'Needs verified identity', now });
  assert.equal(blocked.item.nextAction, 'Needs verified identity');
  const resumed = transitionWork(blocked.state, { id: first.item.id, to: 'active', now });
  assert.equal(resumed.item.nextAction, null);
  assert.equal(resumed.item.events.length, 3);
});
test('refuses invalid keys and unbounded evidence or text', () => {
  assert.throws(() => add(start(), '../escape'), e => e.code === 'PERSONAL_AGENT_WORK_INVALID');
  const first = add();
  assert.throws(() => transitionWork(first.state, { id: first.item.id, to: 'active', evidence: ['../../etc/passwd?x=1&y=2'], now }),
    e => e.code === 'PERSONAL_AGENT_WORK_INVALID');
  assert.throws(() => createWork(start(), { title: ' ', objective: 'objective', idempotencyKey: 'customer_task_000001', now }),
    e => e.code === 'PERSONAL_AGENT_WORK_INVALID');
});
test('states are closed and Work counts use a read-only projection', () => {
  assert.deepEqual(WORK_STATES, ['queued', 'active', 'blocked', 'completed', 'cancelled']);
  assert.equal(MAX_WORK_ITEMS, 200);
  const state = add().state, summary = workSummary(state);
  summary.byStatus.queued = 2000;
  assert.equal(workSummary(state).byStatus.queued, 1);
});
