// M1 HTTP surface: bounded Read route, expectedThread connect field, coded 503 pass-through. Injected runtime only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startStudio } from '../../src/studio/server.mjs';
import { dataPaths, ensureDataDirs } from '../../src/config.mjs';
import { ProfileStore } from '../../src/profiles/profiles.mjs';
import { validateConversationBody } from '../../src/studio/conversation-api.mjs';

function fake() {
  const calls = [];
  const transcript = { conversationId: 'conv-1', revision: 3, source: 'page-visible-dom', messages: [], coverage: { complete: false } };
  const runtime = { calls, isSessionActive: () => false, failTargets: null };
  for (const name of ['targets', 'list', 'connect', 'get', 'submit', 'reconcile', 'finish', 'read', 'close']) runtime[name] = async (...args) => {
    calls.push([name, ...args]);
    if (name === 'targets') { if (runtime.failTargets) throw runtime.failTargets; return { sites: [], targets: [] }; }
    if (name === 'read') return transcript;
    return { id: 'conv-1', revision: 3 };
  };
  return runtime;
}

async function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'conversation-read-api-')); const paths = dataPaths(root); ensureDataDirs(paths);
  const runtime = fake();
  const studio = await startStudio({ paths, profileStore: new ProfileStore(paths.profiles), port: 0, token: 'fixture-token', accessMode: 'token', conversationRuntime: runtime });
  t.after(async () => { await studio.close(); rmSync(root, { recursive: true, force: true }); });
  const request = async (route, method = 'GET', body) => {
    const response = await fetch(`http://127.0.0.1:${studio.port}${route}`, { method, headers: { 'x-studio-token': studio.token, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, headers: response.headers, body: await response.json() };
  };
  return { runtime, request };
}

test('POST /read returns a transcript, never a conversation wrapper, and only reads', async (t) => {
  const { request, runtime } = await fixture(t);
  const res = await request('/api/v1/conversations/conv-1/read', 'POST', { maxMessages: 5, maxChars: 4000 });
  assert.equal(res.status, 200); assert.equal(res.body.transcript.source, 'page-visible-dom'); assert.equal(res.body.conversation, undefined);
  assert.deepEqual(runtime.calls.find(([n]) => n === 'read'), ['read', 'conv-1', { maxMessages: 5, maxChars: 4000 }]);
  assert.equal((await request('/api/v1/conversations/conv-1/read', 'POST', {})).status, 200);
  assert.deepEqual(runtime.calls.map(([n]) => n).filter((n) => ['submit', 'connect', 'finish', 'reconcile'].includes(n)), []);
});

test('Read route: GET is refused, unknown/invalid body fields are 400 before the runtime is called', async (t) => {
  const { request, runtime } = await fixture(t);
  const get = await request('/api/v1/conversations/conv-1/read'); assert.equal(get.status, 405); assert.equal(get.headers.get('allow'), 'POST');
  for (const body of [{ prompt: 'x' }, { maxMessages: 0 }, { maxMessages: 201 }, { maxMessages: 1.5 }, { maxChars: 0 }, { maxChars: 200001 }, { maxChars: '9' }, { confirm: true }])
    assert.equal((await request('/api/v1/conversations/conv-1/read', 'POST', body)).status, 400, JSON.stringify(body));
  assert.equal(runtime.calls.some(([n]) => n === 'read'), false);
});

test('connect accepts an optional expectedThread string and refuses other types or extra fields', async (t) => {
  const { request, runtime } = await fixture(t);
  assert.equal((await request('/api/v1/conversations', 'POST', { site: 'chatgpt', targetId: 'tab', freshTab: false, expectedThread: 'chatgpt-c:11111111-1111-4111-8111-111111111111' })).status, 201);
  assert.equal(runtime.calls.at(-1)[1].expectedThread, 'chatgpt-c:11111111-1111-4111-8111-111111111111');
  for (const body of [{ site: 'chatgpt', expectedThread: 5 }, { site: 'chatgpt', expectedThread: '' }, { site: 'chatgpt', expectedThread: 'x'.repeat(201) }, { site: 'chatgpt', title: 'my chat' }])
    assert.equal((await request('/api/v1/conversations', 'POST', body)).status, 400, JSON.stringify(body));
  assert.throws(() => validateConversationBody('read', { maxMessages: 'a' }), /400|maxMessages/i);
});

test('browser-unavailable is HTTP 503 with a stable code, not 500', async (t) => {
  const { request, runtime } = await fixture(t);
  runtime.failTargets = Object.assign(new Error('BROWSER_UNAVAILABLE'), { status: 503, code: 'BROWSER_UNAVAILABLE' });
  const res = await request('/api/v1/conversation-targets'); assert.equal(res.status, 503); assert.equal(res.body.code, 'BROWSER_UNAVAILABLE');
});
