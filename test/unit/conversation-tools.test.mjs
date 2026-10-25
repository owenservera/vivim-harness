import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startStudio } from '../../src/studio/server.mjs';
import { dataPaths, ensureDataDirs } from '../../src/config.mjs';
import { ProfileStore } from '../../src/profiles/profiles.mjs';
import { createStudioToolClient } from '../../src/studio/tool-client.mjs';
import { runToolsCall, runToolsList } from '../../bin/commands/tools.mjs';

const thread = 'chatgpt-c:11111111-1111-4111-8111-111111111111';
const names = ['conversation_targets', 'chat_index', 'list_conversations', 'get_conversation', 'connect_conversation', 'read_conversation', 'submit_conversation_turn', 'reconcile_conversation', 'finish_conversation'];
const submission = { conversation: 'conv-1', key: 'durable-key', prompt: 'synthetic prompt', expectedRevision: 3, confirm: true };
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'conversation-tools-'));
  const paths = dataPaths(root); ensureDataDirs(paths);
  const calls = [], snapshot = { id: 'conv-1', revision: 3, state: 'ready', reply: { text: 'synthetic private reply', completion: 'unknown' } };
  const runtime = { isSessionActive: () => false, close: async () => {}, snapshot };
  for (const method of ['targets', 'chatIndex', 'list', 'get', 'connect', 'read', 'submit', 'reconcile', 'finish']) runtime[method] = async (...args) => {
    calls.push([method, ...args]);
    if (method === 'targets') return { sites: [], targets: [] };
    if (method === 'chatIndex') return { targetId: args[0].targetId, index: { candidatesOnly: true, complete: false, entries: [{ title: 'synthetic title', identity: { state: 'candidate' } }] } };
    if (method === 'list') return [snapshot];
    if (method === 'read') return { conversationId: args[0], source: 'page-visible-dom', messages: [], coverage: { complete: false } };
    return snapshot;
  };
  let factories = 0;
  const studio = await startStudio({ paths, port: 0, profileStore: new ProfileStore(paths.profiles), token: 'synthetic-owner-token', accessMode: 'token',
    conversationRuntime: runtime, conversationRuntimeFactory() { factories++; throw new Error('Must not instantiate a second runtime'); } });
  t.after(async () => { await studio.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const client = createStudioToolClient({ port: studio.port, token: studio.token });
  const request = async (route, method = 'GET', body) => {
    const response = await fetch(`http://127.0.0.1:${studio.port}${route}`, { method, headers: { 'x-studio-token': studio.token, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  return { client, runtime, calls, request, studio, factories: () => factories };
}

test('registered conversation tool manifest/OpenAPI describe real routes, exact schemas and independent evidence/effects', async (t) => {
  const f = await fixture(t), manifest = await f.client.list();
  assert.deepEqual(manifest.tools.map((tool) => tool.name).sort(), [...names].sort());
  const tools = Object.fromEntries(manifest.tools.map((tool) => [tool.name, tool]));
  for (const tool of manifest.tools) assert.equal(tool.inputSchema.additionalProperties, false);
  assert.equal(tools.chat_index.http.path, '/api/v1/chat-index');
  assert.equal(tools.chat_index.annotations.readOnlyHint, true);
  assert.match(tools.chat_index.description, /candidate/i); assert.match(tools.chat_index.description, /not.*verified|not.*binding/i);
  assert.equal(tools.read_conversation.annotations.readOnlyHint, true);
  assert.equal(tools.submit_conversation_turn.annotations.readOnlyHint, false);
  assert.equal(tools.submit_conversation_turn.annotations.idempotentHint, false);
  assert.deepEqual(tools.submit_conversation_turn.inputSchema.required, ['conversation', 'key', 'prompt', 'confirm', 'expectedRevision']);
  assert.equal(tools.submit_conversation_turn.inputSchema.properties.confirm.const, true);
  assert.equal(tools.read_conversation.inputSchema.properties.maxMessages.maximum, 200);
  assert.equal(tools.chat_index.inputSchema.properties.scanLimit.maximum, 2000);
  assert.equal(tools.reconcile_conversation.inputSchema.properties.turnId.maxLength, 200);
  assert.equal(tools.connect_conversation.inputSchema.properties.freshTab.const, false);
  const api = (await f.request('/api/v1/openapi.json')).body;
  for (const tool of manifest.tools) assert.ok(api.paths[tool.http.path]?.[tool.http.method.toLowerCase()], tool.name);
  assert.ok(api.paths['/api/v1/conversations'].post.responses['201']);
  assert.ok(api.paths['/api/v1/conversations/{conversation}/turns'].post.responses['202']);
  assert.deepEqual(f.calls, []); assert.equal(f.factories(), 0);
});

test('each registered tool reaches the same injected Studio runtime owner exactly once', async (t) => {
  const f = await fixture(t);
  const cases = [
    ['conversation_targets', {}, ['targets']],
    ['chat_index', { targetId: 'selected', maxEntries: 5 }, ['chatIndex', { targetId: 'selected', maxEntries: 5 }]],
    ['list_conversations', {}, ['list']],
    ['get_conversation', { conversation: 'conv-1' }, ['get', 'conv-1']],
    ['connect_conversation', { site: 'chatgpt', targetId: 'selected', expectedThread: thread, freshTab: false }, ['connect', { site: 'chatgpt', targetId: 'selected', expectedThread: thread, freshTab: false }]],
    ['read_conversation', { conversation: 'conv-1', maxMessages: 5, maxChars: 1000 }, ['read', 'conv-1', { maxMessages: 5, maxChars: 1000 }]],
    ['submit_conversation_turn', submission, ['submit', 'conv-1', { key: submission.key, prompt: submission.prompt, expectedRevision: 3, confirm: true }]],
    ['reconcile_conversation', { conversation: 'conv-1', expectedRevision: 3, turnId: 'turn-1' }, ['reconcile', 'conv-1', { expectedRevision: 3, turnId: 'turn-1' }]],
    ['finish_conversation', { conversation: 'conv-1', closeTab: false }, ['finish', 'conv-1', { closeTab: false }]],
  ];
  for (const [name, args, expected] of cases) {
    const before = f.calls.length; await f.client.call(name, args);
    assert.equal(f.calls.length, before + 1); assert.deepEqual(f.calls.at(-1), expected);
  }
  assert.equal(f.factories(), 0);
});

test('validation is enforced by executable handlers, not just declared schemas', async (t) => {
  const f = await fixture(t);
  const invalid = [
    ['chat_index', { targetId: 'selected', scanLimit: 2001 }], ['chat_index', { targetId: 'selected', url: 'https://outside.example' }],
    ['connect_conversation', { site: 'chatgpt', targetId: 'selected' }], ['connect_conversation', { site: 'chatgpt', targetId: 'selected', expectedThread: thread, freshTab: true }],
    ['read_conversation', { conversation: 'conv-1', maxMessages: 201 }], ['read_conversation', { conversation: '../secret' }],
    ['submit_conversation_turn', { ...submission, confirm: false }], ['submit_conversation_turn', { ...submission, expectedRevision: -1 }],
    ['submit_conversation_turn', { ...submission, key: '' }], ['reconcile_conversation', { conversation: 'conv-1', expectedRevision: 3, assertion: true }],
  ];
  for (const [name, args] of invalid) {
    await assert.rejects(f.client.call(name, args));
    const direct = await f.request('/api/v1/integrations/tools/call', 'POST', { name, arguments: args });
    assert.equal(direct.status, 400, name);
  }
  assert.deepEqual(f.calls, []);
});

test('unknown send is returned once; coded server conflicts do not retry or echo private error text', async (t) => {
  const f = await fixture(t); let sends = 0;
  f.runtime.submit = async () => { sends++; return { id: 'conv-1', turn: { send: { state: 'uncertain' } } }; };
  const unknown = await f.client.call('submit_conversation_turn', submission);
  assert.equal(unknown.conversation.turn.send.state, 'uncertain'); assert.equal(sends, 1);
  f.runtime.submit = async () => { sends++; throw Object.assign(new Error('synthetic private prompt and reply'), { status: 409, code: 'THREAD_FENCED' }); };
  await assert.rejects(f.client.call('submit_conversation_turn', submission), (e) => e.status === 409 && e.code === 'THREAD_FENCED' && !e.message.includes('private'));
  assert.equal(sends, 2);
});

test('HTTP client is literal-loopback configured-port only, redirect-error, bounded and never retries uncertain transport', async () => {
  for (const options of [{ port: 0 }, { port: '7878' }, { port: 70000 }, { port: 7878, origin: 'https://outside.example' }, { port: 7878, token: 'x\r\ny' }]) {
    assert.throws(() => createStudioToolClient(options));
  }
  let requests = 0;
  const client = createStudioToolClient({ port: 7878, timeoutMs: 20, token: 'synthetic-secret', fetch: async (url, options) => {
    requests++; assert.equal(url, 'http://127.0.0.1:7878/api/v1/integrations/tools/call'); assert.equal(options.redirect, 'error');
    return new Promise(() => {});
  } });
  await assert.rejects(client.call('submit_conversation_turn', submission), (e) => e.code === 'STUDIO_REQUEST_UNKNOWN' && e.effect === 'unknown' && e.retry === false && !e.message.includes('synthetic'));
  assert.equal(requests, 1);
});

test('existing CLI registration executes the HTTP dispatcher and does not log private bodies by default', async () => {
  const outputs = [], calls = [];
  const fake = { list: async () => ({ tools: [] }), call: async (...args) => { calls.push(args); return { conversation: { reply: { text: 'synthetic private reply' } } }; } };
  const ctx = { args: ['submit_conversation_turn'], flags: { input: '-' }, settings: { studioPort: 7878 }, out: { emit: (value) => outputs.push(value) } };
  const dependencies = { client: () => fake, readInput: () => JSON.stringify(submission), env: {} };
  await runToolsCall(ctx, dependencies);
  assert.deepEqual(calls, [['submit_conversation_turn', submission]]);
  assert.equal(JSON.stringify(outputs).includes('synthetic private reply'), false);
  ctx.flags['include-content'] = true;
  await runToolsCall(ctx, dependencies);
  assert.equal(JSON.stringify(outputs.at(-1)).includes('synthetic private reply'), true);
  await runToolsList({ ...ctx, args: [] }, dependencies);
  assert.deepEqual(outputs.at(-1), { tools: [] });
});

test('actual bin/studio.mjs tools command reaches the running injected owner without creating a runtime', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const child = spawn(process.execPath, [fileURLToPath(new URL('../../bin/studio.mjs', import.meta.url)),
    'tools', 'call', 'conversation_targets', '--studio-port', String(f.studio.port), '--input', '-', '--json'],
  { env: { ...process.env, CAPTURE_STUDIO_TOKEN: f.studio.token }, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const result = new Promise((resolve, reject) => {
    let output = '', errors = '';
    child.on('error', reject); child.stdout.on('data', (chunk) => { output += chunk; }); child.stderr.on('data', (chunk) => { errors += chunk; });
    child.on('close', (code) => {
      if (code !== 0 || errors) return reject(new Error('Registered CLI failed against synthetic owner'));
      try { resolve(JSON.parse(output)); } catch { reject(new Error('Registered CLI did not return JSON')); }
    });
  });
  child.stdin.end('{}');
  assert.deepEqual(await result, { sites: [], targets: [] });
  assert.deepEqual(f.calls, [['targets']]); assert.equal(f.factories(), 0);
});

test('CLI preserves safe coded HTTP/unknown-effect diagnostics, never server text or retry guidance', async () => {
  const ctx = { args: ['submit_conversation_turn'], flags: {}, settings: { studioPort: 7878 }, out: { emit() { throw new Error('No success result expected'); } } };
  const error = Object.assign(new Error('synthetic private body'), { status: 504, code: 'STUDIO_REQUEST_UNKNOWN', effect: 'unknown', retry: false });
  await assert.rejects(runToolsCall(ctx, { env: {}, readInput: () => JSON.stringify(submission), client: () => ({ call: async () => { throw error; } }) }),
    (e) => e.message === 'STUDIO_REQUEST_UNKNOWN' && e.details.httpStatus === 504 && e.details.effect === 'unknown' && e.details.retry === false);
});
