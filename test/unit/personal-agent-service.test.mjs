import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPersonalAgentService } from '../../src/agents/personal-agent-service.mjs';
import { registerPersonalAgentRoutes } from '../../src/studio/personal-agent-routes.mjs';

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
  assert.throws(() => agent.remember({ tier: 'CANON', key: 'other', text: 'stale', expectedVersion: bootstrap.version }),
    e => e.code === 'PERSONAL_AGENT_VERSION_CONFLICT');
  assert.throws(() => agent.remember({ tier: 'Curated', key: '../escape', text: 'bad', expectedVersion: saved.version }), /key/);
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
