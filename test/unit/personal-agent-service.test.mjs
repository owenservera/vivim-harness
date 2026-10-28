import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, renameSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPersonalAgentService } from '../../src/agents/personal-agent-service.mjs';
import { registerPersonalAgentRoutes } from '../../src/studio/personal-agent-routes.mjs';
import { VersionedStore } from '../../src/store/versioned.mjs';

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'vivim-personal-agent-test-'));
  const skillsRoot = path.join(root, 'source');
  mkdirSync(path.join(skillsRoot, '.opencode', 'skills', 'example'), { recursive: true });
  writeFileSync(path.join(skillsRoot, 'AGENTS.md'), '# Local instructions\n');
  writeFileSync(path.join(skillsRoot, '.opencode', 'skills', 'example', 'SKILL.md'), '# Skill source\n');
  t.after(() => rmSync(root, { force: true, recursive: true }));
  return { paths: { root: path.join(root, 'data') }, skillsRoot };
}
const make = (f, extra = {}) => createPersonalAgentService({ ...f, clock: () => '2026-10-28T20:00:00.000Z', ...extra });

test('GET-style status does not create an agent or fabricate completion', t => {
  const agent = make(fixture(t));
  const result = agent.status();
  assert.equal(result.initialized, false);
  assert.equal(result.stages, null);
  assert.equal(result.nextStage, 'identity-and-sitrep');
});
test('one local bootstrap completes ordered stages and recovers after re-instantiation', t => {
  const f = fixture(t), agent = make(f, {
    getTools: () => [{ name: 'conversation_targets', http: { method: 'GET', path: '/api/v1/targets' }, annotations: { readOnlyHint: true } }],
  });
  const result = agent.bootstrap({ expectedVersion: null });
  assert.equal(result.initialized, true);
  assert.equal(result.agentId, 'primary');
  assert.equal(result.identityAssurance.includes('no remote account claim'), true);
  assert.equal(result.nextStage, null);
  assert.equal(Object.keys(result.stages).length, 4);
  for (const stage of Object.values(result.stages)) {
    assert.equal(stage.status, 'completed');
    assert.ok(stage.evidence.length);
  }
  assert.equal(result.observations['skills-and-capabilities'].registeredTools, 1);
  const reboot = make(f);
  assert.equal(reboot.status().version, result.version);
  assert.deepEqual(reboot.status().stages, result.stages);
  assert.equal(reboot.bootstrap({ expectedVersion: result.version }).version, result.version, 'reboot is idempotent');
});
test('version preconditions protect concurrent first-run and later writes', t => {
  const agent = make(fixture(t));
  assert.throws(() => agent.initialize({ expectedVersion: undefined }), /expectedVersion/);
  const initial = agent.initialize({ expectedVersion: null });
  assert.equal(initial.version, 1);
  assert.throws(() => agent.initialize({ expectedVersion: null }), e => e.code === 'CAS_VERSION_CONFLICT');
  const current = agent.bootstrap({ expectedVersion: initial.version });
  assert.throws(() => agent.bootstrap({ expectedVersion: initial.version }), e => e.code === 'PERSONAL_AGENT_VERSION_CONFLICT');
  assert.ok(current.version > initial.version);
});
test('memory updates are user-authored, CAS guarded, and absent from status projection', t => {
  const f = fixture(t), agent = make(f);
  const bootstrap = agent.bootstrap({ expectedVersion: null });
  const saved = agent.remember({ tier: 'Immediate', key: 'next_task', text: 'Investigate receipts', expectedVersion: bootstrap.version });
  assert.equal(saved.memoryCounts.Immediate, 1);
  assert.equal(JSON.stringify(saved).includes('Investigate receipts'), false);
  assert.equal(make(f).memories('Immediate').entries[0].text, 'Investigate receipts');
  assert.equal(make(f).memories('Immediate').entries[0].source, 'user-authored');
  const removed = agent.forget({ tier: 'Immediate', key: 'next_task', expectedVersion: saved.version });
  assert.equal(removed.memoryCounts.Immediate, 0);
  assert.deepEqual(make(f).memories('Immediate').entries, []);
  assert.throws(() => agent.forget({ tier: 'Immediate', key: 'next_task', expectedVersion: removed.version }),
    e => e.code === 'PERSONAL_AGENT_MEMORY_NOT_FOUND');
  assert.throws(() => agent.remember({ tier: 'CANON', key: 'other', text: 'stale', expectedVersion: bootstrap.version }),
    e => e.code === 'PERSONAL_AGENT_VERSION_CONFLICT');
  assert.throws(() => agent.remember({ tier: 'Curated', key: '../escape', text: 'bad', expectedVersion: removed.version }), /key/);
  const independent = make({ ...f, paths: { root: path.join(path.dirname(f.paths.root), 'other') } });
  assert.equal(independent.status().initialized, false, 'no cross-data-directory identity leakage');
});
test('capability inventory distinguishes source discovery from verified runtime execution', t => {
  const agent = make(fixture(t), { getTools: () => [
    { name: 'send', http: { method: 'POST', path: '/send' }, annotations: { readOnlyHint: false } },
  ] });
  const d = agent.capabilities();
  assert.equal(d.tools[0].availability, 'registered; runtime operation not tested');
  assert.equal(d.tools[0].readOnly, false);
  assert.equal(d.skills.items[0].availability, 'source-discovered-not-installed');
  assert.equal(d.skills.items[0].trust, 'untrusted-until-confirmed');
  assert.equal(d.skills.coverage.complete, true);
});
test('Studio routes expose read-only inspection, explicit mutation and private memory reads', t => {
  const f = fixture(t), routes = new Map();
  registerPersonalAgentRoutes({ add: (method, url, summary, handler, meta = {}) => {
    routes.set(`${method} ${url}`, { handler, meta });
  }, paths: f.paths, getTools: () => [] });
  const status = routes.get('GET /personal-agent/status').handler();
  assert.equal(status.initialized, false);
  assert.equal(routes.get('GET /personal-agent/status').meta.tool, 'personal_agent_status');
  assert.equal(routes.get('GET /personal-agent/memory/{tier}').meta.tool, undefined);
  const boot = routes.get('POST /personal-agent/bootstrap').handler({ body: { expectedVersion: null } });
  assert.equal(boot.initialized, true);
  assert.throws(() => routes.get('POST /personal-agent/bootstrap').handler({
    body: { expectedVersion: boot.version, unsafe: true },
  }), e => e.code === 'PERSONAL_AGENT_INVALID');
  const saved = routes.get('PUT /personal-agent/memory/{tier}/{key}').handler({
    p: { tier: 'Curated', key: 'ui_preference' }, body: { text: 'Readable', expectedVersion: boot.version },
  });
  assert.equal(saved.memoryCounts.Curated, 1);
});

test('missing skill root blocks Stage 04 and resumes after restoring its real source', t => {
  const f = fixture(t), missing = f.skillsRoot + '-moved';
  renameSync(f.skillsRoot, missing);
  const agent = make(f), partial = agent.bootstrap({ expectedVersion: null });
  assert.equal(partial.nextStage, 'skills-and-capabilities');
  assert.equal(partial.stages['skills-and-capabilities'].status, 'blocked');
  assert.equal(partial.stages['personal-memory'].status, 'completed');
  const unchanged = make(f).bootstrap({ expectedVersion: partial.version });
  assert.equal(unchanged.version, partial.version, 'unchanged blockers do not create repeated versions');
  renameSync(missing, f.skillsRoot);
  const resumed = make(f).bootstrap({ expectedVersion: partial.version });
  assert.equal(resumed.nextStage, null);
  assert.equal(resumed.stages['skills-and-capabilities'].status, 'completed');
  assert.equal(resumed.stages['identity-and-sitrep'].updatedAt, partial.stages['identity-and-sitrep'].updatedAt);
});

test('user-directed Work survives restart, replays lost-response creation safely, and never dispatches', t => {
  const f = fixture(t), agent = make(f), boot = agent.bootstrap({ expectedVersion: null });
  const inputs = { expectedVersion: boot.version, title: 'Investigate local tools',
    objective: 'Enumerate registered capabilities without external calls', idempotencyKey: 'case_1234567890' };
  const created = agent.createWorkItem(inputs);
  assert.equal(created.item.status, 'queued');
  assert.equal(created.work.byStatus.queued, 1);
  assert.equal(created.replayed, false);
  const again = make(f).createWorkItem(inputs); // retry with stale version after a lost success response
  assert.equal(again.replayed, true);
  assert.equal(again.version, created.version);
  assert.equal(again.item.id, created.item.id);
  assert.throws(() => agent.createWorkItem({ ...inputs, title: 'Changed' }),
    e => e.code === 'PERSONAL_AGENT_WORK_IDEMPOTENCY_CONFLICT');
  const activated = agent.transitionWorkItem({
    expectedVersion: created.version, id: created.item.id, to: 'active',
  });
  assert.equal(activated.work.byStatus.active, 1);
  assert.throws(() => agent.transitionWorkItem({
    expectedVersion: created.version, id: created.item.id, to: 'completed',
    evidence: ['local:result/1'],
  }), e => e.code === 'PERSONAL_AGENT_VERSION_CONFLICT');
  assert.throws(() => agent.transitionWorkItem({
    expectedVersion: activated.version, id: created.item.id, to: 'completed',
  }), e => e.code === 'PERSONAL_AGENT_WORK_EVIDENCE_REQUIRED');
  const completed = agent.transitionWorkItem({
    expectedVersion: activated.version, id: created.item.id, to: 'completed',
    evidence: ['local:receipt/manual-acceptance'],
  });
  assert.equal(completed.work.byStatus.completed, 1);
  const restarted = make(f);
  assert.equal(restarted.workList().items[0].evidence[0].basis,
    'user-attested; unverified-for-live-execution');
  assert.equal(restarted.workList().items[0].status, 'completed');
  assert.equal(restarted.status().work.total, 1);
  assert.equal(restarted.selfKnowledge('work').answers.work.value.total, 1);
  assert.equal(restarted.selfKnowledge('identity').answers.identity.value.providerAccountVerified, false);
  assert.equal(restarted.selfKnowledge('capabilities').answers.capabilities.value.sourceCoverageComplete, true);
});
test('Work and memory text are not exposed by default status or global self-knowledge', t => {
  const f = fixture(t), agent = make(f), boot = agent.bootstrap({ expectedVersion: null });
  const created = agent.createWorkItem({ expectedVersion: boot.version,
    title: 'PRIVATE_WORK_TITLE', objective: 'PRIVATE_WORK_OBJECTIVE', idempotencyKey: 'private_key_12345' });
  const saved = agent.remember({ tier: 'CANON', key: 'private_note',
    text: 'PRIVATE_MEMORY_CONTENT', expectedVersion: created.version });
  const publicView = JSON.stringify({ status: agent.status(), self: agent.selfKnowledge('all') });
  assert.equal(publicView.includes('PRIVATE_WORK_TITLE'), false);
  assert.equal(publicView.includes('PRIVATE_WORK_OBJECTIVE'), false);
  assert.equal(publicView.includes('PRIVATE_MEMORY_CONTENT'), false);
  assert.equal(saved.memoryCounts.CANON, 1);
});

test('initialize returns the same status projection as status() and first-run bootstrap resumes with null', t => {
  const f = fixture(t), agent = make(f);
  // Regression: initialize used to return the raw store record (no nextStage/memoryCounts/work summary),
  // so the first-run HTTP response had a different shape from every other lifecycle response.
  const initialized = agent.initialize({ expectedVersion: null });
  assert.deepEqual(initialized, agent.status());
  assert.equal(initialized.initialized, true);
  assert.equal(initialized.nextStage, 'identity-and-sitrep');
  assert.equal(initialized.memoryCounts.Immediate, 0);
  assert.equal(initialized.work.total, 0);
  assert.equal('savedAt' in initialized, false, 'store metadata is not part of the public projection');
  // Regression: an interrupted first run (identity committed, crash before stage 0) could not be resumed with the
  // documented expectedVersion:null - it returned 409 and forced a separate status read first.
  const resumed = make(f).bootstrap({ expectedVersion: null });
  assert.equal(resumed.nextStage, null);
  assert.ok(resumed.version > initialized.version);
  for (const stage of Object.values(resumed.stages)) assert.equal(stage.status, 'completed');
  assert.throws(() => make(f).bootstrap({ expectedVersion: initialized.version }),
    e => e.code === 'PERSONAL_AGENT_VERSION_CONFLICT', 'a stale integer revision still refuses');
});

test('identity is fingerprinted to this local data directory only', t => {
  const first = fixture(t), second = fixture(t);
  const a = make(first).status(), b = make(second).status();
  assert.match(a.scopeFingerprint, /^local-dir-sha256:[0-9a-f]{20}$/);
  assert.equal(a.scope, 'local-data-directory');
  assert.notEqual(a.scopeFingerprint, b.scopeFingerprint, 'separate data directories are distinguishable');
  const booted = make(first).bootstrap({ expectedVersion: null });
  assert.equal(booted.scopeFingerprint, a.scopeFingerprint, 'same directory keeps a stable fingerprint');
  assert.equal(make(first).continuity().identity.scopeFingerprint, a.scopeFingerprint);
  assert.equal(make(first).exportSnapshot().payload.identity.scopeFingerprint, a.scopeFingerprint);
  const identity = make(first).selfKnowledge('identity').answers.identity;
  assert.equal(identity.value.scopeFingerprint, a.scopeFingerprint);
  assert.equal(identity.value.providerAccountVerified, false);
  assert.match(identity.qualification, /not a device or cross-device principal/);
  assert.equal(JSON.stringify(booted).includes(first.paths.root), false, 'the local path itself is not exposed');
});

test('corrupt stored state and memory tiers fail with a stable code, never a raw TypeError', t => {
  const f = fixture(t);
  make(f).bootstrap({ expectedVersion: null });
  const store = new VersionedStore(path.join(f.paths.root, 'personal-agent'), { kind: 'personal agent' });
  const stored = store.load('primary');
  const corrupt = (value) => store.compareAndSave('primary', { ...stored, ...value },
    { expectedVersion: store.current('primary'), changeNote: 'corrupt fixture' });

  corrupt({ memory: { ...stored.memory, CANON: 'not-an-array' } });
  const version = store.current('primary');
  for (const call of [
    () => make(f).memories('CANON'),
    () => make(f).remember({ tier: 'CANON', key: 'note', text: 'x', expectedVersion: version }),
    () => make(f).forget({ tier: 'CANON', key: 'note', expectedVersion: version }),
    () => make(f).continuity(),
    () => make(f).exportSnapshot(),
  ]) {
    assert.throws(call, e => e.code === 'PERSONAL_AGENT_STATE_CORRUPT' && e.status === 500);
  }
  // A schema-invalid snapshot is reported as corrupt local state, not an uncaught validation TypeError.
  corrupt({ memory: { CANON: [], Immediate: [], Curated: [] }, stages: {} });
  assert.throws(() => make(f).status(), e => e.code === 'PERSONAL_AGENT_STATE_CORRUPT');
});
