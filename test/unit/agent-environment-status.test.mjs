import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { runAgentStatus } from '../../bin/commands/recipes.mjs';
import { createStudioToolClient } from '../../src/studio/tool-client.mjs';

test('agent status reports the existing server real data root and dedicated Chrome profile', async () => {
  let seen; let result;
  const ctx = { args: [], flags: { 'studio-port': 38703 },
    settings: { studioPort: 7878 }, out: { emit: (value) => { result = value; } } };
  await runAgentStatus(ctx, { request: async (_ctx, method, route) => {
    seen = { method, route };
    return { version: '0.1.0', dataDir: path.join('C:', 'VIVIM'),
      cdpPort: 38702, chrome: 'Chrome/Test', recorder: { state: 'idle' } };
  } });
  assert.deepEqual(seen, { method: 'GET', route: '/status' });
  assert.equal(result.studioPort, 38703);
  assert.equal(result.cdpPort, 38702);
  assert.equal(result.chromeProfile, path.join(result.dataDir, 'chrome-profile'));
  assert.equal(result.browserProfileVerified, 'not-proven-by-status');
  assert.equal(result.browserAccountState, 'unverified');
  assert.equal('token' in result, false);
});

test('native tool-client owner status is exactly one GET to loopback, with no browser actions', async () => {
  const requests = [];
  const client = createStudioToolClient({ port: 38703, fetch: async (url, options) => {
    requests.push({ url, method: options.method }); return {
      ok: true, redirected: false, json: async () => ({dataDir:'/tmp/vivim', cdpPort:38702})
    };
  }});
  await client.recipeRequest('GET', '/api/status');
  assert.deepEqual(requests, [{url:'http://127.0.0.1:38703/api/status', method:'GET'}]);
  await assert.rejects(client.recipeRequest('POST','/api/status',{}), e => e.code==='INVALID_RECIPE_REQUEST');
  await assert.rejects(client.recipeRequest('GET','/api/status/../admin'), e => e.code==='INVALID_RECIPE_REQUEST');
});
