import test from 'node:test';
import assert from 'node:assert/strict';
import { createStudioToolClient } from '../../src/studio/tool-client.mjs';

test('recipe HTTP and conversation tools share a single-attempt localhost client', async () => {
  const requests = [];
  const client = createStudioToolClient({ port: 7878, timeoutMs: 2000,
    fetch: async (url, options) => {
      requests.push({ url, method: options.method, credentials: options.credentials,
        redirected: options.redirect, body: options.body });
      return { ok: true, redirected: false, json: async () => ({ ok: true }) };
    },
  });
  await client.recipeRequest('GET', '/api/v1/recipes');
  await client.recipeRequest('POST', '/api/v1/recipes/conversation.ask/plan', { input: {} });
  await client.recipeRequest('POST', '/api/v1/recipes/conversation.ask/run', { input: {}, execute: true });
  assert.equal(requests.length, 3);
  assert.ok(requests.every((r) => r.url.startsWith('http://127.0.0.1:7878/api/v1/')));
  assert.deepEqual(requests.map((r) => r.method), ['GET', 'POST', 'POST']);
  assert.ok(requests.every((r) => r.credentials === 'omit' && r.redirected === 'error'));
});
test('recipe client refuses arbitrary sites, traversal, method mismatch and invalid bodies', async () => {
  const client = createStudioToolClient({ port: 7878, fetch: () => { throw new Error('must not network'); } });
  await assert.rejects(client.recipeRequest('GET', 'https://evil.example/x'), (e) => e.code === 'INVALID_RECIPE_REQUEST');
  await assert.rejects(client.recipeRequest('GET', '/api/v1/recipes/../health'), (e) => e.code === 'INVALID_RECIPE_REQUEST');
  await assert.rejects(client.recipeRequest('DELETE', '/api/v1/recipes'), (e) => e.code === 'INVALID_RECIPE_REQUEST');
  await assert.rejects(client.recipeRequest('GET', '/api/v1/recipes', {}), (e) => e.code === 'INVALID_RECIPE_REQUEST');
  await assert.rejects(client.recipeRequest('POST', '/api/v1/recipes/conversation.ask/run'), (e) => e.code === 'INVALID_RECIPE_REQUEST');
});
test('recipe request failures preserve bounded effect uncertainty and never retry', async () => {
  let calls = 0;
  const client = createStudioToolClient({ port: 7878,
    fetch: async () => { calls++; throw new Error('private upstream connection details'); },
  });
  await assert.rejects(client.recipeRequest('POST', '/api/v1/recipes/conversation.ask/run', { input: {} }),
    (e) => e.code === 'STUDIO_REQUEST_UNKNOWN' && e.effect === 'unknown' && e.retry === false);
  assert.equal(calls, 1);
  await assert.rejects(client.recipeRequest('POST', '/api/v1/recipes/conversation.ask/plan', { input: {} }),
    (e) => e.code === 'STUDIO_REQUEST_UNKNOWN' && e.effect === 'none');
  assert.equal(calls, 2);
});
