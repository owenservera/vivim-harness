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
    assert.equal((await api('/api/v1/personal-agent/memory/Immediate/task', 'PUT', {
      text: 'stale attempt', expectedVersion: revision,
    })).status, 409);
    const toolList = await api('/api/v1/integrations/tools');
    const toolNames = toolList.data.tools.map(tool => tool.name);
    assert.ok(toolNames.includes('personal_agent_status'));
    assert.ok(toolNames.includes('personal_agent_capabilities'));
    assert.equal(toolNames.some(name => name.includes('memory')), false);

    await studio.close(); studio = await start();
    const recovered = await api('/api/v1/personal-agent/status');
    assert.equal(recovered.status, 200);
    assert.equal(recovered.data.nextStage, null);
    assert.equal(recovered.data.memoryCounts.Immediate, 1);
    const replay = await api('/api/v1/personal-agent/bootstrap', 'POST', { expectedVersion: recovered.data.version });
    assert.equal(replay.data.version, recovered.data.version, 'idempotent recovery does not append a revision');
  } finally { await studio.close(); studio = null; }
});
