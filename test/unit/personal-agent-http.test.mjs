// Real same-owner loopback HTTP acceptance without Chrome/CDP or provider actions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { dataPaths, ensureDataDirs } from '../../src/config.mjs';
import { ProfileStore } from '../../src/profiles/profiles.mjs';
import { startStudio } from '../../src/studio/server.mjs';

test('personal agent survives a real Studio HTTP restart with local-only effects', { timeout: 20000 }, async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'vivim-agent-http-'));
  const paths = dataPaths(root); ensureDataDirs(paths);
  const runtime = () => ({
    isSessionActive: () => false, close: async () => {}, targets: async () => ({ sites: [], targets: [] }), list: async () => [],
  });
  const start = () => startStudio({ paths, profileStore: new ProfileStore(paths.profiles),
    port: 0, token: 'agent-test-token', accessMode: 'token', conversationRuntime: runtime() });
  let studio = await start();
  t.after(async () => { try { await studio?.close(); } finally { rmSync(root, { recursive: true, force: true }); } });
  const headers = { 'x-studio-token': 'agent-test-token', 'content-type': 'application/json' };
  const url = pathname => `http://127.0.0.1:${studio.port}${pathname}`;
  const api = async (pathname, method = 'GET', body, auth = true) => {
    const response = await fetch(url(pathname), { method,
      headers: auth ? headers : { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() };
  };
  try {
    assert.equal((await fetch(url('/personal-agent'))).status, 401);
    const ui = await fetch(url('/personal-agent'), { headers });
    assert.equal(ui.status, 200);
    assert.match(await ui.text(), /Your Personal Agent/);
    assert.match(ui.headers.get('content-security-policy'), /connect-src 'self'/);
    assert.equal((await fetch(url('/ui/personal-agent.mjs'), { headers })).status, 200);
    assert.equal((await fetch(url('/personal-agent'), { method: 'POST', headers })).status, 405);

    const uninitialized = await api('/api/v1/personal-agent/status');
    assert.equal(uninitialized.data.initialized, false);
    const unauthorized = await api('/api/v1/personal-agent/status', 'GET', undefined, false);
    assert.equal(unauthorized.status, 401);
    const crossOrigin = await fetch(url('/api/v1/personal-agent/bootstrap'), {
      method: 'POST', headers: { ...headers, origin: 'https://attacker.example' },
      body: JSON.stringify({ expectedVersion: null }),
    });
    assert.equal(crossOrigin.status, 403);
    assert.equal((await api('/api/v1/personal-agent/status')).data.initialized, false);

    const boot = await api('/api/v1/personal-agent/bootstrap', 'POST', { expectedVersion: null });
    assert.equal(boot.status, 200, JSON.stringify(boot.data));
    assert.equal(boot.data.initialized, true);
    const revision = boot.data.version;
    assert.ok(revision > 1);

    const saved = await api('/api/v1/personal-agent/memory/Immediate/task', 'PUT', {
      text: 'Resume local skill review', expectedVersion: revision,
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.data));
    assert.equal(saved.data.memoryCounts.Immediate, 1);
    assert.equal(JSON.stringify(saved.data).includes('Resume local skill review'), false);
    assert.equal((await api('/api/v1/personal-agent/memory/Immediate')).data.entries[0].text, 'Resume local skill review');
    const searched = await api('/api/v1/personal-agent/search-memory', 'POST', {
      query: 'skill', tier: 'Immediate', limit: 5,
    });
    assert.equal(searched.status, 200);
    assert.equal(searched.data.total, 1);
    assert.equal(searched.data.items[0].key, 'task');
    assert.equal(searched.data.items[0].match, 'text');
    assert.equal((await api('/api/v1/personal-agent/search-memory', 'POST', { query: 's' })).status, 400);
    assert.equal((await api('/api/v1/personal-agent/search-memory', 'POST', { query: 'skill', extra: true })).status, 400);
    assert.equal((await api('/api/v1/personal-agent/search-memory', 'POST', { query: 'skill' }, false)).status, 401);
    const badOriginSearch = await fetch(url('/api/v1/personal-agent/search-memory'), {
      method: 'POST', headers: { ...headers, origin: 'https://attacker.example' },
      body: JSON.stringify({ query: 'skill' }),
    });
    assert.equal(badOriginSearch.status, 403);
    const removed = await api('/api/v1/personal-agent/memory/Immediate/task/remove', 'POST', {
      expectedVersion: saved.data.version,
    });
    assert.equal(removed.status, 200);
    assert.equal(removed.data.memoryCounts.Immediate, 0);
    assert.equal((await api('/api/v1/personal-agent/memory/Immediate')).data.entries.length, 0);
    assert.equal((await api('/api/v1/personal-agent/search-memory', 'POST', { query: 'skill' })).data.total, 0);
    assert.equal((await api('/api/v1/personal-agent/memory/Immediate/task', 'PUT', {
      text: 'stale attempt', expectedVersion: revision,
    })).status, 409);
    const knowledge = await api('/api/v1/personal-agent/self-knowledge?topic=privacy');
    assert.equal(knowledge.status, 200);
    assert.equal(knowledge.data.answers.privacy.value.providerSendsDuringBootstrap, false);
    const beforeWork = await api('/api/v1/personal-agent/status');
    const workInputs = { expectedVersion: beforeWork.data.version, title: 'Local integration test',
      objective: 'No browser or provider dispatch', idempotencyKey: 'http_work_1234567' };
    const createdWork = await api('/api/v1/personal-agent/work', 'POST', workInputs);
    assert.equal(createdWork.status, 200);
    assert.equal(createdWork.data.work.byStatus.queued, 1);
    const duplicateWork = await api('/api/v1/personal-agent/work', 'POST', workInputs);
    assert.equal(duplicateWork.status, 200);
    assert.equal(duplicateWork.data.replayed, true);
    assert.equal(duplicateWork.data.version, createdWork.data.version);
    const listedWork = await api('/api/v1/personal-agent/work');
    assert.equal(listedWork.data.items[0].title, workInputs.title);
    const transitioned = await api('/api/v1/personal-agent/work/' + createdWork.data.item.id + '/transition',
      'POST', { expectedVersion: createdWork.data.version, to: 'active' });
    assert.equal(transitioned.status, 200);
    assert.equal(transitioned.data.work.byStatus.active, 1);
    const planned = await api('/api/v1/personal-agent/work/' + createdWork.data.item.id + '/next-action',
      'POST', { expectedVersion: transitioned.data.version, nextAction: 'Review local receipts' });
    assert.equal(planned.status, 200);
    assert.equal(planned.data.item.nextAction, 'Review local receipts');
    assert.equal(planned.data.replayed, false);
    const sameAction = await api('/api/v1/personal-agent/work/' + createdWork.data.item.id + '/next-action',
      'POST', { expectedVersion: planned.data.version, nextAction: 'Review local receipts' });
    assert.equal(sameAction.data.replayed, true);
    assert.equal(sameAction.data.version, planned.data.version);
    assert.equal((await api('/api/v1/personal-agent/work/' + createdWork.data.item.id + '/next-action',
      'POST', { expectedVersion: transitioned.data.version, nextAction: 'Stale action' })).status, 409);
    assert.equal((await api('/api/v1/personal-agent/work/' + createdWork.data.item.id + '/next-action',
      'POST', { expectedVersion: planned.data.version, nextAction: 'x'.repeat(1001) })).status, 400);
    const invalidCompletion = await api('/api/v1/personal-agent/work/' + createdWork.data.item.id + '/transition',
      'POST', { expectedVersion: planned.data.version, to: 'completed' });
    assert.equal(invalidCompletion.status, 400);
    assert.equal(invalidCompletion.data.code, 'PERSONAL_AGENT_WORK_EVIDENCE_REQUIRED');
    const sitrep = await api('/api/v1/personal-agent/sitrep');
    assert.equal(sitrep.status, 200);
    assert.equal(sitrep.data.communications.status, 'not-inspected');
    assert.equal(sitrep.data.workCoverage.openTotal, 1);
    const privateExportDefault = await api('/api/v1/personal-agent/export');
    assert.equal(privateExportDefault.status, 200);
    assert.equal(privateExportDefault.data.payload.work.detailsOmitted, true);
    assert.equal(privateExportDefault.data.payload.memory.detailsOmitted, true);
    assert.equal(JSON.stringify(privateExportDefault.data).includes('Local integration test'), false);
    const privateExportDetails = await api('/api/v1/personal-agent/export?includeWorkDetails=true');
    assert.equal(privateExportDetails.data.includesPrivateWorkDetails, true);
    assert.equal(privateExportDetails.data.payload.work[0].title, 'Local integration test');
    assert.equal((await api('/api/v1/personal-agent/export?includeMemory=yes')).status, 400);
    assert.equal((await api('/api/v1/personal-agent/export', 'GET', undefined, false)).status, 401);
    const toolList = await api('/api/v1/integrations/tools');
    const toolNames = toolList.data.tools.map(tool => tool.name);
    assert.ok(toolNames.includes('personal_agent_status'));
    assert.ok(toolNames.includes('personal_agent_capabilities'));
    assert.ok(toolNames.includes('personal_agent_self_knowledge'));
    assert.equal(toolNames.some(name => name.startsWith('personal_agent_work')), false);
    assert.equal(toolNames.some(name => name.includes('sitrep') || name.includes('export')), false);
    assert.equal(toolNames.some(name => name.includes('memory')), false);
    assert.equal(toolNames.some(name => name.includes('search-memory')), false);

    await studio.close(); studio = await start();
    const recovered = await api('/api/v1/personal-agent/status');
    assert.equal(recovered.status, 200);
    assert.equal(recovered.data.nextStage, null);
    assert.equal(recovered.data.memoryCounts.Immediate, 0);
    assert.equal(recovered.data.work.byStatus.active, 1);
    assert.equal((await api('/api/v1/personal-agent/work')).data.items.length, 1);
    const replay = await api('/api/v1/personal-agent/bootstrap', 'POST', { expectedVersion: recovered.data.version });
    assert.equal(replay.data.version, recovered.data.version, 'idempotent recovery does not append a revision');
  } finally { await studio.close(); studio = null; }
});
