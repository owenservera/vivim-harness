import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { startStudio } from '../../src/studio/server.mjs';
import { dataPaths, ensureDataDirs } from '../../src/config.mjs';
import { ProfileStore } from '../../src/profiles/profiles.mjs';
import { Session } from '../../src/store/session.mjs';
import { runChat } from '../../bin/commands/chat.mjs';

function fake() {
  const calls = [];
  const snapshot = { id: 'conv-1', revision: 1, reply: { state: 'ready', source: 'page', text: 'fixture', completion: 'unknown' }, turn: { send: { state: 'observed' } } };
  const runtime = { calls, isSessionActive: () => false };
  for (const name of ['targets', 'chatIndex', 'list', 'connect', 'get', 'submit', 'reconcile', 'finish', 'close']) runtime[name] = async (...args) => {
    calls.push([name, ...args]);
    if (name === 'targets') return { sites: [], targets: [] };
    if (name === 'list') return [snapshot];
    if (name === 'chatIndex') return { targetId: args[0].targetId, origin: 'https://chatgpt.com', index: { candidatesOnly: true, complete: false, entries: [] } };
    return snapshot;
  };
  return runtime;
}

async function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'conversation-api-'));
  const paths = dataPaths(root); ensureDataDirs(paths);
  const runtime = fake();
  const studio = await startStudio({ paths, profileStore: new ProfileStore(paths.profiles), port: 0, token: 'fixture-token', accessMode: 'token', conversationRuntime: runtime });
  t.after(async () => { await studio.close(); rmSync(root, { recursive: true, force: true }); });
  async function request(route, method = 'GET', body, headers = {}) {
    if (headers.host) {
      return new Promise((resolve, reject) => {
        const req = http.request({ hostname: '127.0.0.1', port: studio.port, path: route, method, headers: { 'x-studio-token': studio.token, ...headers } }, (res) => {
          let text = ''; res.setEncoding('utf8'); res.on('data', (chunk) => { text += chunk; });
          res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(text) }));
        });
        req.on('error', reject); req.end();
      });
    }
    const response = await fetch(`http://127.0.0.1:${studio.port}${route}`, { method, headers: { 'x-studio-token': studio.token, 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) });
    return { status: response.status, headers: response.headers, body: await response.json() };
  }
  return { runtime, paths, request, studio };
}

test('conversation routes preserve runtime resources and status codes', async (t) => {
  const { request, runtime } = await fixture(t);
  assert.deepEqual((await request('/api/v1/conversation-targets')).body, { sites: [], targets: [] });
  assert.equal((await request('/api/v1/conversations')).body.conversations.length, 1);
  assert.equal((await request('/api/v1/conversations', 'POST', { site: 'chatgpt' })).status, 201);
  assert.equal((await request('/api/v1/conversations/conv-1')).body.conversation.id, 'conv-1');
  const turn = { key: 'once', prompt: 'hello', confirm: true, expectedRevision: 1 };
  assert.equal((await request('/api/v1/conversations/conv-1/turns', 'POST', turn)).status, 202);
  assert.deepEqual(runtime.calls.find(([name]) => name === 'submit'), ['submit', 'conv-1', turn]);
  assert.equal((await request('/api/v1/conversations/conv-1/reconcile', 'POST', { expectedRevision: 1 })).status, 200);
  assert.equal((await request('/api/v1/conversations/conv-1/finish', 'POST', { closeTab: false })).status, 200);
});

test('explicit POST /chat-index delegates once through the existing runtime and preserves candidate-only semantics', async (t) => {
  const { request, runtime } = await fixture(t);
  const body = { targetId: 'selected', site: 'chatgpt', maxEntries: 10, maxTitleChars: 40, scanLimit: 100 };
  const result = await request('/api/v1/chat-index', 'POST', body);
  assert.equal(result.status, 200); assert.equal(result.body.targetId, 'selected');
  assert.equal(result.body.index.candidatesOnly, true); assert.equal(result.body.index.complete, false);
  assert.deepEqual(runtime.calls, [['chatIndex', body]]);
  const method = await request('/api/v1/chat-index'); assert.equal(method.status, 405); assert.equal(method.headers.get('allow'), 'POST');
  assert.equal((await request('/api/v1/chat-index', 'POST', body, { 'x-studio-token': '' })).status, 401);
  assert.equal((await request('/api/v1/chat-index', 'POST', body, { origin: 'https://outside.example' })).status, 403);
  assert.equal(runtime.calls.length, 1);
});

test('chat-index strict body/bounds reject before runtime; reader failures keep coded status', async (t) => {
  const { request, runtime } = await fixture(t);
  for (const body of [null, [], {}, { targetId: '' }, { targetId: 'x', site: 'other' }, { targetId: 'x', prompt: 'x' },
    { targetId: 'x', port: 9222 }, { targetId: 'x', maxEntries: 0 }, { targetId: 'x', maxTitleChars: 301 },
    { targetId: 'x', scanLimit: 2001 }, { targetId: 'x', containers: [{}] }]) {
    assert.equal((await request('/api/v1/chat-index', 'POST', body)).status, 400);
  }
  assert.equal(runtime.calls.length, 0);
  runtime.chatIndex = async () => { throw Object.assign(new Error('BINDING_CHANGED'), { status: 409, code: 'BINDING_CHANGED' }); };
  const failure = await request('/api/v1/chat-index', 'POST', { targetId: 'selected' });
  assert.equal(failure.status, 409); assert.equal(failure.body.code, 'BINDING_CHANGED');
});

test('auth, origin, host, methods, strict bodies and runtime conflicts', async (t) => {
  const { request, runtime } = await fixture(t);
  assert.equal((await request('/api/v1/conversations', 'GET', undefined, { 'x-studio-token': '' })).status, 401);
  assert.equal((await request('/api/v1/conversations', 'GET', undefined, { origin: 'https://example.com' })).status, 403);
  assert.equal((await request('/api/v1/conversations', 'GET', undefined, { host: 'example.com' })).status, 421);
  for (const [route, method] of [['/api/v1/conversation-targets', 'POST'], ['/api/v1/conversations', 'DELETE'], ['/api/v1/conversations/conv-1', 'POST'], ['/api/v1/conversations/conv-1/finish', 'GET']]) {
    const result = await request(route, method); assert.equal(result.status, 405); assert.ok(result.headers.get('allow'));
  }
  for (const body of [null, [], '{', { site: 'chatgpt', extra: true }, { site: 'chatgpt', freshTab: 'yes' }]) assert.equal((await request('/api/v1/conversations', 'POST', body)).status, 400);
  const valid = { key: 'once', prompt: 'hello', confirm: true, expectedRevision: 1 };
  for (const body of [{ ...valid, confirm: false }, { ...valid, key: '' }, { ...valid, prompt: 'x'.repeat(250000 + 1) }, { ...valid, expectedRevision: '1' }, { ...valid, unknown: true }]) assert.equal((await request('/api/v1/conversations/conv-1/turns', 'POST', body)).status, 400);
  runtime.submit = async () => { throw Object.assign(new Error('Revision conflict'), { status: 409, code: 'REVISION_CONFLICT', holder: { kind: 'conversation', id: 'other', token: 'must-not-leak' } }); };
  const conflict = await request('/api/v1/conversations/conv-1/turns', 'POST', valid);
  assert.equal(conflict.status, 409); assert.equal(conflict.body.code, 'REVISION_CONFLICT');
  assert.deepEqual(conflict.body.holder, { kind: 'conversation', id: 'other' });
});

test('failed connect exposes only a valid recovery conversation id and keeps holder diagnostics', async (t) => {
  const { runtime, request } = await fixture(t);
  const id = 'e0a67492-d2e0-4fd7-9a53-b2d23285e610';
  for (const conversationId of [id, 'conv-1', '../private', 'bad/id', '', 'x'.repeat(129), null, { id }]) {
    runtime.connect = async () => {
      throw Object.assign(new Error('Attachment failed'), {
        status: 409, code: 'ATTACHMENT_FAILED', conversationId,
        holder: { kind: 'conversation', id, token: 'private-holder-token' },
        token: 'private-runtime-token', internal: { recorder: 'private' },
      });
    };
    const result = await request('/api/v1/conversations', 'POST', { site: 'chatgpt' });
    assert.equal(result.status, 409);
    assert.deepEqual(result.body, {
      error: 'Attachment failed', code: 'ATTACHMENT_FAILED',
      ...(conversationId === id || conversationId === 'conv-1' ? { conversationId } : {}),
      holder: { kind: 'conversation', id },
    });
  }
});

test('Chat static files are authenticated, GET-only and use external-script CSP', async (t) => {
  const { studio } = await fixture(t);
  for (const route of ['/chat', '/ui/chat.mjs']) {
    const url = `http://127.0.0.1:${studio.port}${route}`;
    assert.equal((await fetch(url)).status, 401);
    const headers = { 'x-studio-token': studio.token };
    const res = await fetch(url, { headers });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    const csp = res.headers.get('content-security-policy');
    assert.ok(csp.includes("script-src 'self';")); assert.ok(csp.includes("frame-ancestors 'none'"));
    const content = await res.text();
    assert.ok(content.length > 0);
    assert.equal((await fetch(url, { method: 'POST', headers })).status, 405);
  }
});

test('Studio awaits runtime shutdown exactly once across duplicate close calls', async (t) => {
  const { studio, runtime } = await fixture(t);
  let release, closed = false, calls = 0;
  runtime.close = async () => { calls++; await new Promise((resolve) => { release = resolve; }); closed = true; };
  const a = studio.close(), b = studio.close();
  assert.equal(a, b); assert.equal(calls, 1); assert.equal(closed, false);
  release(); await a; assert.equal(closed, true); assert.equal(calls, 1);
});

test('both derive entrypoints reject conversation-owned active sessions', async (t) => {
  const { paths, runtime, request } = await fixture(t);
  const session = Session.create(paths.sessions, { site: 'fixture' }); await session.raw.close();
  runtime.isSessionActive = (id) => id === session.id;
  for (const prefix of ['/api/sessions', '/api/v1/sessions']) {
    const result = await request(`${prefix}/${session.id}/derive`, 'POST', {});
    assert.equal(result.status, 409); assert.equal(result.body.code, 'SESSION_ACTIVE');
  }
  const replay = await request(`/api/v1/sessions/${session.id}/replay/records`);
  assert.equal(replay.status, 409); assert.equal(replay.body.code, 'SESSION_ACTIVE');
});

function cli(flags = {}) {
  const results = [];
  return { args: ['chatgpt'], flags: { prompt: 'hello', ...flags }, paths: {}, profiles: () => ({}), families: () => ({}), port: 9222, out: { emit: (value) => results.push(value) }, results };
}

test('CLI defaults offline and execute performs exactly one lifecycle with tab preserved', async () => {
  const preview = cli(); await runChat(preview, { factory: () => { throw new Error('Must not construct runtime'); } });
  assert.equal(preview.results[0].browserAction, false);
  assert.equal(preview.results[0].freshTab, true);
  const runtime = fake(), execution = cli({ execute: true });
  await runChat(execution, { factory: async () => runtime });
  assert.deepEqual(runtime.calls.map(([name]) => name), ['connect', 'submit', 'finish', 'close']);
  assert.deepEqual(runtime.calls.find(([name]) => name === 'finish')[2], { closeTab: false });
});

test('CLI bounded polls snapshots only and never resubmits uncertain turns', async () => {
  const originalExitCode = process.exitCode;
  const runtime = fake(); let clock = 0;
  runtime.submit = async (id, body) => { runtime.calls.push(['submit', id, body]); return { id, revision: 2, reply: { state: 'waiting' }, turn: { send: { state: 'observed' } } }; };
  const execution = cli({ execute: true, timeout: 1 });
  await runChat(execution, { factory: async () => runtime, now: () => clock, sleep: async (ms) => { clock += ms; } });
  assert.equal(runtime.calls.filter(([name]) => name === 'submit').length, 1);
  assert.ok(runtime.calls.some(([name]) => name === 'get'));
  runtime.calls.length = 0;
  runtime.submit = async (id) => { runtime.calls.push(['submit']); return { id, reply: { state: 'waiting' }, turn: { send: { state: 'uncertain' } } }; };
  await runChat(cli({ execute: true }), { factory: async () => runtime });
  assert.deepEqual(runtime.calls.map(([name]) => name), ['connect', 'submit', 'finish', 'close']);
  process.exitCode = originalExitCode;
});

test('CLI polls accepted preparing/not-attempted but stops promptly on blocked/not-attempted', async () => {
  const originalExitCode = process.exitCode;
  try {
    const runtime = fake(); let waits = 0;
    runtime.submit = async (id) => ({ id, state: 'busy', turn: { phase: 'preparing', send: { state: 'not-attempted' } }, reply: { state: 'empty' } });
    runtime.get = async (id) => ({ id, state: 'blocked', turn: { phase: 'blocked', send: { state: 'not-attempted' } }, reply: { state: 'unknown' } });
    const ctx = cli({ execute: true });
    await runChat(ctx, { factory: async () => runtime, sleep: async () => { waits++; if (waits > 1) throw new Error('Polling blocked operation'); } });
    assert.equal(waits, 1); assert.equal(ctx.results[0].error.code, 'TURN_BLOCKED'); assert.equal(ctx.results[0].timedOut, false);
    assert.equal(runtime.calls.filter(([name]) => name === 'finish').length, 1);
  } finally { process.exitCode = originalExitCode; }
});
