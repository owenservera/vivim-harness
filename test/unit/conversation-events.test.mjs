import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { createConversationRuntime } from '../../src/capture/conversation-runtime.mjs';
import { createConversationEvents } from '../../src/studio/conversation-events.mjs';
import { createConversationApi } from '../../src/studio/conversation-api.mjs';
import { startStudio } from '../../src/studio/server.mjs';
import { dataPaths, ensureDataDirs } from '../../src/config.mjs';
import { ProfileStore } from '../../src/profiles/profiles.mjs';
import { canonicalThreadKey } from '../../src/capture/thread-turn-journal.mjs';

const waitFor = async (condition, ms = 5000) => {
  for (let n = 0; n < ms / 5; n++) { if (await condition()) return; await new Promise((r) => setTimeout(r, 5)); }
  if (!(await condition())) throw new Error('condition not reached');
};

function qualifiedReply(adapter, args, text, state = 'ready') {
  const contentDigest = createHash('sha256').update(text).digest('hex'), previous = adapter.replyMetadata;
  const revision = previous ? previous.revision + (previous.contentDigest !== contentDigest ? 1 : 0) : 1;
  const sequence = (adapter.replySequence ?? 11) + 3; adapter.replySequence = sequence;
  const metadata = { identity: `reply-${args.turnId}`, revision, contentDigest, chars: text.length };
  adapter.replyMetadata = metadata;
  const evidence = { turnId: args.turnId, payloadDigest: args.payloadDigest, sessionId: adapter.sessionId, sequence,
    kind: 'assistant-reply', source: 'page', ...metadata };
  return { turnId: args.turnId, binding: adapter.binding, state, text, evidence,
    ...(state === 'ready' ? { readiness: { ...evidence, kind: 'interactive-ready', source: 'adapter', rule: 'chatgpt-controls-idle', ruleVersion: 1,
      threadKey: canonicalThreadKey({ namespace: 'local-owner', origin: adapter.binding.origin, thread: adapter.binding.thread }), boundarySequence: 10,
      samples: [{ sequence, ...metadata }, { sequence: sequence + 1, ...metadata }], sequence: sequence + 1,
      controls: { observed: true, state: 'idle', idleControlPresent: true, stopPresent: false, composerEnabled: true } } } : {}) };
}

// A minimal real runtime: the same fake-adapter seam the conversation tests use.
function runtimeFixture(t, overrides = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'conversation-events-'));
  const paths = { root, sessions: path.join(root, 'sessions') };
  const site = { id: 'chatgpt', url: 'https://chatgpt.com/' };
  let observe = true;
  const dependencies = {
    leaseRoot: path.join(root, 'leases'), listSessions: () => [],
    getAdapter: async (v) => v === 'chatgpt' || String(v).startsWith('https://chatgpt.com') ? site : null,
    listTargets: async () => [{ id: 'selected', type: 'page', url: 'https://chatgpt.com/c/11111111-1111-4111-8111-111111111111' }],
    createAdapter() {
      const adapter = { mayOwnResources: false, bytesWritten: 40, integrity: null,
        async connect(binding, hooks) { hooks.bind(binding); adapter.binding = binding; adapter.sessionId = 'session-0'; hooks.ownSession(adapter.sessionId); return { binding, sessionId: adapter.sessionId }; },
        async preflight(binding) { return { binding, draft: { present: false, chars: 0 }, boundary: { sequence: 10, transcriptCount: 1 } }; },
        async type() {},
        async submit(args) { return observe ? { binding: args.binding, evidence: { ...args, sessionId: adapter.sessionId, sequence: 11, kind: 'new-user-turn', source: 'page', identity: `user-${args.turnId}` } } : null; },
        async reconcile() { return null; },
        async readReply(_, args) {
          const text = 'reply body never in events';
          return qualifiedReply(adapter, args, text);
        },
        async stop() { adapter.integrity = { ok: true }; } };
      return adapter;
    }, ...overrides,
  };
  const runtime = createConversationRuntime({ paths, port: 19222, dependencies });
  t.after(async () => { await runtime.close().catch(() => {}); rmSync(root, { recursive: true, force: true }); });
  const connect = (body = {}) => runtime.connect({ site: 'chatgpt', targetId: 'selected', ...body });
  const submit = (c, body = {}) => runtime.submit(c.id, { key: 'one', prompt: 'a private prompt body', confirm: true, expectedRevision: c.revision, ...body });
  return { runtime, connect, submit, setObserve: (v) => { observe = v; } };
}

const sseRes = () => {
  const res = { writes: [], status: null, headers: null, destroyed: false, writableEnded: false, writableLength: 0, handlers: {} };
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers; };
  res.write = (frame) => { res.writes.push(frame); return true; };
  res.end = () => { res.writableEnded = true; };
  res.on = (ev, fn) => { (res.handlers[ev] ??= []).push(fn); };
  return res;
};
const sseEvents = (res) => res.writes.join('').split('\n\n').filter((b) => b.includes('\nevent: ') || b.startsWith('event: ')).map((b) => {
  const get = (k) => { const m = new RegExp(`^${k}: (.*)$`, 'm').exec(b); return m ? m[1] : null; };
  return { id: get('id'), type: get('event'), data: get('data') ? JSON.parse(get('data')) : null };
});

test('turn lifecycle publishes incremental metadata events: monotonic cursors, honest writer accounting, no bodies', async (t) => {
  const f = runtimeFixture(t);
  const events = createConversationEvents({ runtime: f.runtime, intervalMs: 10 });
  t.after(() => events.close());
  const delivered = [];
  events.feed.on('delivery', (e) => delivered.push(e));
  const c = await f.connect();
  events.watch(c.id);
  await waitFor(() => delivered.length > 0); // baseline projection for the fresh watcher
  await f.submit(c);
  await waitFor(() => delivered.some((e) => e.data.turns?.[0]?.send.state === 'observed' && e.data.writer.active === false));
  await waitFor(() => delivered.some((e) => e.data.turns?.[0]?.reply.state === 'ready'));
  // Privacy: prompts and reply text never appear in event payloads — bodies stay behind GET/read.
  const payloads = delivered.map((e) => JSON.stringify(e.data));
  assert.ok(payloads.every((p) => !p.includes('a private prompt body')));
  assert.ok(payloads.every((p) => !p.includes('reply body never in events')));
  // Delivery cursors are unique and monotonically increasing within the feed epoch.
  const seqs = delivered.map((e) => Number(e.id.split(':')[1]));
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
  assert.equal(new Set(delivered.map((e) => e.id)).size, delivered.length);
  // Session scoping and durable state cursor: every event carries its conversation and a revision.
  assert.ok(delivered.every((e) => e.session === c.id && e.type === 'conversation.changed'));
  const revs = delivered.filter((e) => e.data.revision !== undefined).map((e) => e.data.revision);
  assert.deepEqual(revs, [...revs].sort((a, b) => a - b));
  // Lifecycle honesty is visible in the projections: writer accounting and diagnostic uncertainty.
  const last = delivered.at(-1).data;
  assert.equal(last.conversationId, c.id);
  assert.equal(last.turns[0].send.state, 'observed');
  assert.equal(last.turns[0].reply.state, 'ready');
  assert.equal(last.writer.active, false);
  assert.equal(last.writer.releaseError, null);
  assert.equal(events.info().watched.includes(c.id), true);
});

test('SSE reconnect replays missed events exactly once; a lost cursor gets reset, never a blind replay', async (t) => {
  const f = runtimeFixture(t);
  const events = createConversationEvents({ runtime: f.runtime, intervalMs: 10 });
  t.after(() => events.close());
  const c = await f.connect();
  const req = { headers: {} };
  const first = sseRes();
  await events.subscribe(req, first, c.id);
  assert.equal(first.status, 200);
  assert.ok(String(first.headers['content-type']).includes('text/event-stream'));
  const hello = sseEvents(first).find((e) => e.type === 'hello');
  assert.ok(hello && hello.data.cursor); // control frames carry the payload directly
  assert.equal(hello.data.status.conversationId, c.id);
  assert.equal(hello.data.status.durable, false);
  f.setObserve(false);
  const sent = f.submit(c);
  // Data frames carry the full event envelope: the projection lives under .data.data.
  await waitFor(() => sseEvents(first).some((e) => e.type === 'conversation.changed' && e.data?.data?.turns?.[0]?.send.state === 'uncertain'));
  const seen = sseEvents(first).filter((e) => e.type === 'conversation.changed');
  const second = sseRes();
  await events.subscribe(req, second, c.id, { after: seen[0].id });
  const replayed = sseEvents(second).filter((e) => e.type === 'conversation.changed').map((e) => e.id);
  assert.deepEqual(replayed, seen.slice(1).map((e) => e.id)); // missed events replayed in order, each exactly once
  const third = sseRes();
  await events.subscribe(req, third, c.id, { after: '0000000000000000:1' });
  assert.ok(sseEvents(third).some((e) => e.type === 'reset')); // lost cursor: explicit reset, client re-reads state via GET
  await sent;
});
test('unknown conversations are announced once and transient read errors are retried, never guessed', async (t) => {
  const f = runtimeFixture(t);
  let fail = false;
  const events = createConversationEvents({
    runtime: { get: async (id) => { if (fail) throw Object.assign(new Error('RUNTIME_CLOSED'), { status: 503 }); return f.runtime.get(id); } },
    intervalMs: 10 });
  t.after(() => events.close());
  const c = await f.connect();
  const delivered = [];
  events.feed.on('delivery', (e) => delivered.push(e));
  events.watch(c.id);
  await waitFor(() => delivered.length > 0);
  fail = true;
  await new Promise((r) => setTimeout(r, 40)); // skipped ticks publish nothing
  assert.equal(delivered.filter((e) => e.data.missing).length, 0);
  fail = false;
  const missing = { status: 404 };
  const gone = createConversationEvents({ runtime: { get: async () => { throw missing; } }, intervalMs: 10 });
  t.after(() => gone.close());
  const announced = [];
  gone.feed.on('delivery', (e) => announced.push(e));
  gone.watch('nonexistent');
  await waitFor(() => announced.length > 0);
  assert.deepEqual(announced[0].data, { conversationId: 'nonexistent', missing: true });
  assert.deepEqual(announced.filter((e) => e.data.missing).length, 1); // exactly once
});

test('the studio API serves the stream with auth and methods; unknown ids and unwired events fail closed', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'conversation-events-api-'));
  const paths = dataPaths(root); ensureDataDirs(paths);
  const snapshot = { id: 'conv-1', revision: 1, state: 'ready', site: 'chatgpt', identity: { state: 'bound', reason: null },
    writer: { active: false }, diagnostic: {}, turns: [], reply: {}, readiness: {} };
  const runtime = { isSessionActive: () => false, get: async () => snapshot, list: async () => [snapshot], close: async () => {} };
  const studio = await startStudio({ paths, profileStore: new ProfileStore(paths.profiles), port: 0, token: 'fixture-token', accessMode: 'token', conversationRuntime: runtime });
  t.after(async () => { await studio.close(); rmSync(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${studio.port}`;
  const stream = await new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: studio.port, path: '/api/v1/conversations/conv-1/events', headers: { 'x-studio-token': studio.token } }, (res) => {
      let text = ''; res.setEncoding('utf8');
      res.on('error', () => {}); // the stream is destroyed on purpose once hello arrives
      res.on('data', (chunk) => { text += chunk; if (text.includes('event: hello')) { req.destroy(); resolve({ status: res.statusCode, headers: res.headers, text }); } });
    });
    req.on('error', () => {}); req.end();
  });
  assert.equal(stream.status, 200);
  assert.ok(String(stream.headers['content-type']).includes('text/event-stream'));
  assert.ok(stream.text.includes('"conversationId":"conv-1"'));
  const method = await fetch(`${base}/api/v1/conversations/conv-1/events`, { method: 'POST', headers: { 'x-studio-token': studio.token } });
  assert.equal(method.status, 405); assert.equal(method.headers.get('allow'), 'GET');
  const unauth = await fetch(`${base}/api/v1/conversations/conv-1/events`);
  assert.equal(unauth.status, 401);
  runtime.get = async (id) => { if (id === 'unknown') throw Object.assign(new Error('CONVERSATION_NOT_FOUND'), { status: 404, code: 'CONVERSATION_NOT_FOUND' }); return snapshot; };
  const missing = await fetch(`${base}/api/v1/conversations/unknown/events`, { headers: { 'x-studio-token': studio.token } });
  assert.equal(missing.status, 404);
});

test('the events route fails closed with 501 when the event module is not wired', async () => {
  const api = createConversationApi({ runtime: { get: async () => ({}) } });
  await assert.rejects(api.handle({ method: 'GET' }, sseRes(), new URL('/api/v1/conversations/x/events', 'http://localhost')),
    (e) => e.status === 501 && e.code === 'CONVERSATION_EVENTS_UNAVAILABLE');
});
