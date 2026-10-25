import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createConversationRuntime } from '../../src/capture/conversation-runtime.mjs';
import { acquireDriveLease } from '../../src/capture/drive-lease.mjs';
import { createConversationBrowserAdapter, readUserTurns } from '../../src/capture/conversation-browser-adapter.mjs';
import { Recorder } from '../../src/capture/recorder.mjs';
import { RawLog } from '../../src/store/raw-log.mjs';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { canonicalThreadKey } from '../../src/capture/thread-turn-journal.mjs';
import { spawn } from 'node:child_process';

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

const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'conversation-runtime-'));
  const paths = { root, sessions: path.join(root, 'sessions') }, calls = [], adapters = [];
  const site = { id: 'chatgpt', url: 'https://chatgpt.com/' };
  let observe = true, releaseReply = deferred();
  let targets = [{ id: 'selected', type: 'page', url: 'https://chatgpt.com/c/11111111-1111-4111-8111-111111111111' }];
  const dependencies = {
    leaseRoot: path.join(root, 'leases'), listSessions: () => [],
    getAdapter: async (value) => value === 'chatgpt' || String(value).startsWith('https://chatgpt.com') ? site : null,
    // An existing ChatGPT tab must be a supported /c/<uuid> thread to be sendable (M1 thread identity).
    listTargets: async () => targets,
    createAdapter(options) {
      const adapter = {
        mayOwnResources: false, bytesWritten: 40, integrity: null,
        async connect(binding, hooks) { calls.push('connect'); adapter.mayOwnResources = true;
          if (options.freshTab) { binding.targetId = 'fresh'; hooks.bind(binding); }
          adapter.binding = binding; adapter.sessionId = `session-${adapters.length}`; hooks.ownSession(adapter.sessionId);
          return { binding, sessionId: adapter.sessionId }; },
        async preflight(binding) { calls.push('preflight'); return { binding, draft: { present: false, chars: 0 }, boundary: { sequence: 10, transcriptCount: 1 } }; },
        async type() { calls.push('type'); },
        async submit(args) { calls.push('submit'); return observe ? { binding: args.binding, evidence: { ...args, sessionId: adapter.sessionId, sequence: 11, kind: 'new-user-turn', source: 'page', identity: `user-${args.turnId}` } } : null; },
        async reconcile() { calls.push('reconcile'); return null; },
        async readReply(_, args) { calls.push('reply'); await releaseReply.promise; return qualifiedReply(adapter, args, 'private answer'); },
        stopWaiting() { calls.push('stop-wait'); releaseReply.resolve(); },
        async stop() { calls.push('stop'); adapter.mayOwnResources = false; adapter.integrity = { ok: true }; },
        async closeTab() { calls.push('close-tab'); },
      };
      adapters.push(adapter); return adapter;
    }, ...overrides,
  };
  const runtime = createConversationRuntime({ paths, port: 19222, dependencies });
  t.after(async () => { await runtime.close().catch(() => {}); fs.rmSync(root, { recursive: true, force: true }); });
  const connect = (body = {}) => runtime.connect({ site: 'chatgpt', targetId: 'selected', ...body });
  const submit = (c, body = {}) => runtime.submit(c.id, { key: 'one', prompt: 'private prompt', confirm: true, expectedRevision: c.revision, ...body });
  const settle = async (id) => { for (let n = 0; n < 200; n++) { const c = await runtime.get(id); if (c.reply.state === 'ready' || c.turn?.send.state === 'uncertain') return c; await new Promise(setImmediate); } throw new Error('Background job did not settle'); };
  return { runtime, paths, dependencies, calls, adapters, connect, submit, settle, releaseReply, setObserve: (v) => { observe = v; },
    setTargets: (v) => { targets = v; } };
}

test('§15 connect/submit promptly/poll/read-local/list-private/finish with lease', async (t) => {
  const f = fixture(t), c = await f.connect();
  assert.equal(c.site, 'chatgpt'); assert.equal(c.binding.targetId, 'selected'); assert.equal(c.capture.maxBytes, 256 * 1024 * 1024);
  assert.equal(f.runtime.isSessionActive(c.sessionId), true);
  const registered = await f.submit(c); assert.equal(registered.turn.phase, 'preparing');
  const readCalls = [...f.calls]; await f.runtime.get(c.id); await f.runtime.list(); assert.deepEqual(f.calls, readCalls);
  f.releaseReply.resolve(); const replied = await f.settle(c.id);
  assert.equal(replied.turn.send.state, 'observed'); assert.equal(replied.reply.text, 'private answer');
  assert.equal(replied.reply.source, 'page'); assert.equal(replied.reply.completion, 'unknown');
  const list = await f.runtime.list(); assert.equal(JSON.stringify(list).includes('private answer'), false); assert.equal(JSON.stringify(list).includes('private prompt'), false);
  const finished = await f.runtime.finish(c.id, { closeTab: true });
  assert.equal(finished.capture.state, 'incomplete'); assert.equal(finished.capture.integrity.ok, true);
  assert.equal(f.calls.includes('close-tab'), false); assert.equal(f.runtime.isSessionActive(c.sessionId), false);
  acquireDriveLease({ root: f.dependencies.leaseRoot, port: 19222 }).release();
});

test('concurrent duplicate keys register once; changed payload conflicts before stale revision', async (t) => {
  const f = fixture(t), c = await f.connect();
  const [a, b] = await Promise.all([f.submit(c), f.submit(c)]);
  assert.equal(a.turn.id, b.turn.id);
  await assert.rejects(f.submit(c, { prompt: 'changed' }), (e) => e.status === 409 && e.code === 'IDEMPOTENCY_CONFLICT');
  await f.runtime.finish(c.id);
  assert.equal(f.calls.filter((v) => v === 'submit').length, 1);
});

test('fresh tab can capture/finish but cannot submit without a tested exact creation identity', async (t) => {
  const f = fixture(t), c = await f.connect({ freshTab: true, targetId: undefined });
  assert.equal(c.binding.ownedByStudio, true); assert.equal(c.binding.targetId, 'fresh');
  // The driving lease covered only the fresh-tab creation window (tab + navigation); the idle
  // Studio-owned tab holds none between connect and the first send.
  acquireDriveLease({ root: f.dependencies.leaseRoot, port: 19222 }).release();
  await assert.rejects(f.submit(c), (e) => e.code === 'THREAD_IDENTITY_UNVERIFIED');
  await Promise.all([f.runtime.finish(c.id, { closeTab: true }), f.runtime.finish(c.id, { closeTab: true })]);
  assert.equal(f.calls.filter((v) => v === 'stop').length, 1); assert.equal(f.calls.filter((v) => v === 'close-tab').length, 1);
});

test('uncertain send does not retry/read reply/close own tab, persists through restart', async (t) => {
  const f = fixture(t); f.setObserve(false);
  const c = await f.connect(); await f.submit(c); await f.settle(c.id);
  await f.submit(c); const done = await f.runtime.finish(c.id, { closeTab: true });
  assert.equal(done.turn.send.state, 'uncertain'); assert.equal(f.calls.includes('close-tab'), false); assert.equal(f.calls.includes('reply'), false);
  assert.equal(f.calls.filter((v) => v === 'submit').length, 1);
  const before = [...f.calls], restarted = createConversationRuntime({ paths: f.paths, port: 19222, dependencies: f.dependencies });
  assert.equal((await restarted.get(c.id)).turn.send.state, 'uncertain'); assert.deepEqual(f.calls, before);
  await assert.rejects(restarted.submit(c.id, { key: 'different', prompt: 'x', confirm: true, expectedRevision: done.revision }), (e) => e.status === 409);
  await restarted.close();
});

test('invalid/stale/unknown resources return appropriate errors without actions', async (t) => {
  const f = fixture(t);
  await assert.rejects(f.connect({ site: 'unknown' }), (e) => e.status === 400);
  await assert.rejects(f.connect({ targetId: 'missing' }), (e) => e.status === 404);
  await assert.rejects(f.runtime.get('missing'), (e) => e.status === 404);
  const c = await f.connect();
  await assert.rejects(f.submit(c, { expectedRevision: -1 }), (e) => e.status === 409);
  await assert.rejects(f.submit(c, { confirm: false }), (e) => e.status === 400);
  assert.deepEqual(f.calls, ['connect']);
});

test('duration budget stops waiting, finalizes incomplete and releases lease', async (t) => {
  const f = fixture(t, { maxDurationMs: 15 }); const c = await f.connect(); await f.submit(c);
  for (let i = 0; i < 100; i++) {
    const state = await f.runtime.get(c.id); if (state.state === 'closed') break;
    await new Promise((r) => setTimeout(r, 5));
  }
  const done = await f.runtime.get(c.id); assert.equal(done.state, 'closed'); assert.equal(done.capture.limitReason, 'duration-budget');
  assert.equal(done.capture.state, 'incomplete'); acquireDriveLease({ root: f.dependencies.leaseRoot, port: 19222 }).release();
});

test('failed capture stop preserves an open writer lease and prevents tab close', async (t) => {
  const f = fixture(t), c = await f.connect();
  f.setObserve(false); await f.submit(c); await f.settle(c.id); // Unknown delivery keeps the writer window open.
  f.adapters[0].stop = async () => { f.calls.push('stop'); throw new Error('failed'); };
  const done = await f.runtime.finish(c.id, { closeTab: true }); assert.equal(done.state, 'needs-reconciliation');
  assert.equal(f.calls.includes('close-tab'), false);
  assert.throws(() => acquireDriveLease({ root: f.dependencies.leaseRoot, port: 19222 }), /lease is held/);
});

test('failed attach with no effects releases lease', async (t) => {
  const f = fixture(t, { createAdapter: () => ({ mayOwnResources: false, async connect() { throw new Error('no effect'); } }) });
  await assert.rejects(f.connect(), /ATTACHMENT_FAILED/);
  acquireDriveLease({ root: f.dependencies.leaseRoot, port: 19222 }).release();
});

test('an idle connected conversation holds no driving lease; the window opens for the effect and closes on observed delivery', async (t) => {
  const f = fixture(t), c = await f.connect();
  assert.equal((await f.runtime.get(c.id)).writer.active, false);
  acquireDriveLease({ root: f.dependencies.leaseRoot, port: 19222 }).release(); // Free between turns.
  const typing = deferred();
  f.adapters[0].type = async () => { await typing.promise; };
  const sent = f.submit(c);
  for (let n = 0; n < 500 && !(await f.runtime.get(c.id)).writer.active; n++) await new Promise(setImmediate);
  assert.equal((await f.runtime.get(c.id)).writer.active, true);
  assert.throws(() => acquireDriveLease({ root: f.dependencies.leaseRoot, port: 19222 }), /lease is held/);
  typing.resolve();
  await sent;
  for (let n = 0; n < 500 && (await f.runtime.get(c.id)).writer.active; n++) await new Promise(setImmediate);
  assert.equal((await f.runtime.get(c.id)).writer.active, false); // Released once delivery is observed.
  f.releaseReply.resolve(); const replied = await f.settle(c.id);
  assert.equal(replied.turn.send.state, 'observed');
  acquireDriveLease({ root: f.dependencies.leaseRoot, port: 19222 }).release();
});

test('unknown delivery keeps the writer window until reconciliation resolves it', async (t) => {
  const f = fixture(t); f.setObserve(false);
  const c = await f.connect(); await f.submit(c); const uncertain = await f.settle(c.id);
  assert.equal(uncertain.turn.send.state, 'uncertain');
  assert.throws(() => acquireDriveLease({ root: f.dependencies.leaseRoot, port: 19222 }), /lease is held/);
  const disk = JSON.parse(fs.readFileSync(path.join(f.paths.root, 'conversations', `${c.id}.conversation.json`)));
  const a = disk.attempts.at(-1);
  f.adapters[0].reconcile = async () => ({ binding: uncertain.binding, evidence: { turnId: a.id, payloadDigest: a.payloadDigest,
    sessionId: c.sessionId, sequence: 11, kind: 'new-user-turn', source: 'page', identity: `user-${a.id}` } });
  const resolved = await f.runtime.reconcile(c.id, { expectedRevision: uncertain.revision });
  assert.equal(resolved.turn.send.state, 'observed');
  f.releaseReply.resolve();
  assert.equal((await f.runtime.get(c.id)).writer.active, false);
  acquireDriveLease({ root: f.dependencies.leaseRoot, port: 19222 }).release();
});

test('a second conversation attaches while the first is connected and collides only inside the effect window', async (t) => {
  const f = fixture(t);
  f.setTargets([
    { id: 'selected', type: 'page', url: 'https://chatgpt.com/c/11111111-1111-4111-8111-111111111111' },
    { id: 'other', type: 'page', url: 'https://chatgpt.com/c/22222222-2222-4222-8222-222222222222' }]);
  const a = await f.connect(), b = await f.connect({ targetId: 'other' });
  const typing = deferred();
  f.adapters[0].type = async () => { await typing.promise; };
  await f.submit(a);
  for (let n = 0; n < 500 && !(await f.runtime.get(a.id)).writer.active; n++) await new Promise(setImmediate);
  await assert.rejects(f.runtime.submit(b.id, { key: 'one', prompt: 'private prompt', confirm: true, expectedRevision: b.revision }),
    (e) => e.status === 409 && e.code === 'DRIVE_LEASE_BUSY');
  assert.equal((await f.runtime.get(b.id)).turns.length, 0); // Busy collision leaves no journal residue.
  typing.resolve();
  for (let n = 0; n < 500 && (await f.runtime.get(a.id)).writer.active; n++) await new Promise(setImmediate);
  const second = await f.runtime.submit(b.id, { key: 'one', prompt: 'private prompt', confirm: true, expectedRevision: (await f.runtime.get(b.id)).revision });
  assert.equal(second.turn.phase, 'preparing');
  f.releaseReply.resolve(); await f.settle(a.id);
});

test('a failed lease release stays accounted: active writer with releaseError, honest busy on the next window, cleared by a later proven window', async (t) => {
  let failRelease = true, failAcquire = false, releases = 0;
  const f = fixture(t, {
    acquireLease() {
      if (failAcquire) throw Object.assign(new Error('Browser driving lease is held by a live owner'), { code: 'DRIVE_LEASE_BUSY', status: 409, holder: { kind: 'conversation-writer', id: 'other-window' } });
      return { release() { if (failRelease) throw Object.assign(new Error('Lease ownership changed'), { code: 'LEASE_OWNER_CHANGED', status: 409 }); releases++; } };
    },
  });
  const c = await f.connect();
  assert.equal((await f.runtime.get(c.id)).writer.active, false);
  assert.equal((await f.runtime.get(c.id)).writer.releaseError, null);
  await f.submit(c);
  for (let n = 0; n < 500 && (await f.runtime.get(c.id)).turn.send.state !== 'observed'; n++) await new Promise(setImmediate);
  // Delivery was observed and the window tried to close, but the release could not be proven:
  // the view keeps reporting occupancy with the code instead of claiming a free host.
  const held = await f.runtime.get(c.id);
  assert.equal(held.writer.active, true);
  assert.equal(held.writer.releaseError.code, 'LEASE_OWNER_CHANGED');
  assert.ok(held.writer.releaseError.at);
  f.releaseReply.resolve(); await f.settle(c.id);
  // The next window open surfaces the busy host honestly and leaves no journal residue (no blind resend).
  failAcquire = true;
  const revision = (await f.runtime.get(c.id)).revision;
  await assert.rejects(f.submit(c, { key: 'two', expectedRevision: revision }), (e) => e.status === 409 && e.code === 'DRIVE_LEASE_BUSY');
  assert.equal((await f.runtime.get(c.id)).turns.length, 1);
  assert.equal((await f.runtime.get(c.id)).writer.active, true); // still accounted
  // Recovery is explicit and user-driven: the next successful enter proves a fresh window and clears the stale failure.
  failAcquire = false; failRelease = false;
  const second = await f.submit(c, { key: 'two', expectedRevision: (await f.runtime.get(c.id)).revision });
  assert.equal(second.turn.phase, 'preparing');
  assert.equal((await f.runtime.get(c.id)).writer.releaseError, null); // cleared by the proven re-entry
  for (let n = 0; n < 500 && (await f.runtime.get(c.id)).writer.active; n++) await new Promise(setImmediate);
  const settled = await f.runtime.get(c.id);
  assert.equal(settled.writer.active, false); assert.equal(settled.writer.releaseError, null);
  assert.equal(releases, 1);
});

test('a failed fresh-tab connect whose lease release cannot be proven reports it on the error and the listed entry', async (t) => {
  const f = fixture(t, {
    createAdapter: () => ({ mayOwnResources: false, async connect() { throw new Error('no effect'); } }),
    acquireLease: () => ({ release() { throw Object.assign(new Error('Lease ownership changed'), { code: 'LEASE_OWNER_CHANGED', status: 409 }); } }),
  });
  const e = await f.connect({ freshTab: true, targetId: undefined }).then(() => { throw new Error('expected connect rejection'); }, (err) => err);
  assert.equal(e.code, 'ATTACHMENT_FAILED');
  assert.equal(e.leaseReleaseError.code, 'LEASE_OWNER_CHANGED');
  assert.ok(e.conversationId);
  const listed = await f.runtime.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].writer.active, true);
  assert.equal(listed[0].writer.releaseError.code, 'LEASE_OWNER_CHANGED');
});

test('the writer window is host-wide: a second runtime instance is fenced by the first one open window', async (t) => {
  const f = fixture(t);
  f.setTargets([
    { id: 'selected', type: 'page', url: 'https://chatgpt.com/c/11111111-1111-4111-8111-111111111111' },
    { id: 'other', type: 'page', url: 'https://chatgpt.com/c/22222222-2222-4222-8222-222222222222' }]);
  const a = await f.connect();
  const typing = deferred();
  f.adapters[0].type = async () => { await typing.promise; };
  await f.submit(a);
  for (let n = 0; n < 500 && !(await f.runtime.get(a.id)).writer.active; n++) await new Promise(setImmediate);
  const second = createConversationRuntime({ paths: f.paths, port: 19222, dependencies: f.dependencies });
  t.after(() => second.close().catch(() => {}));
  const b = await second.connect({ site: 'chatgpt', targetId: 'other' });
  // The interlock is the physical lease directory, not in-runtime state: the second runtime's
  // window open hits DRIVE_LEASE_BUSY with the live holder, and no journal residue appears.
  await assert.rejects(second.submit(b.id, { key: 'one', prompt: 'private prompt', confirm: true, expectedRevision: b.revision }),
    (e) => e.status === 409 && e.code === 'DRIVE_LEASE_BUSY' && e.holder?.kind === 'conversation-writer');
  assert.equal((await second.get(b.id)).turns.length, 0);
  typing.resolve();
  for (let n = 0; n < 500 && (await f.runtime.get(a.id)).writer.active; n++) await new Promise(setImmediate);
  const admitted = await second.submit(b.id, { key: 'one', prompt: 'private prompt', confirm: true, expectedRevision: (await second.get(b.id)).revision });
  assert.equal(admitted.turn.phase, 'preparing');
  f.releaseReply.resolve(); await f.settle(a.id);
});

test('restart: a loaded snapshot holds no lease and stays replay-only; a stale crashed lease is reclaimed by the next real window; the thread stays fenced with no blind resend', async (t) => {
  const f = fixture(t, { ownerIsAlive: () => false });
  f.setObserve(false);
  const c = await f.connect(); await f.submit(c); await f.settle(c.id); // uncertain delivery, window held
  await f.runtime.close(); // finalize: capture stopped, window released, journal keeps the unresolved turn
  acquireDriveLease({ root: f.dependencies.leaseRoot, port: 19222 }).release(); // host is free after close
  // Reshape the snapshot to crash-state (no clean finish), as a killed process would leave it.
  const crashedFile = path.join(f.paths.root, 'conversations', `${c.id}.conversation.json`);
  const crashed = JSON.parse(fs.readFileSync(crashedFile, 'utf8'));
  crashed.finish = { requested: false, phase: 'idle', error: null };
  crashed.state = 'needs-reconciliation';
  fs.writeFileSync(crashedFile, JSON.stringify(crashed));
  // A crashed process left a stale lease in the same slot: a child acquired it and exited without releasing.
  const moduleUrl = new URL('../../src/capture/drive-lease.mjs', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e',
    `import {acquireDriveLease} from ${JSON.stringify(moduleUrl)}; acquireDriveLease(${JSON.stringify({ root: f.dependencies.leaseRoot, port: 19222 })});`], { stdio: 'ignore' });
  await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', (code) => code === 0 ? resolve() : reject(new Error('child failed'))); });
  const restarted = createConversationRuntime({ paths: f.paths, port: 19222, dependencies: f.dependencies });
  t.after(() => restarted.close().catch(() => {}));
  const before = await restarted.get(c.id);
  assert.equal(before.turn.send.state, 'uncertain');
  assert.equal(before.writer.active, false); // honest restart accounting: this process holds nothing
  assert.equal(before.writer.releaseError, null);
  assert.equal(before.recovery.pending, true); // the owning process is gone and the snapshot is unfinished: stale until an explicit mutation
  // A restarted conversation is replay-only: a new key is refused before any window opens, no residue.
  await assert.rejects(restarted.submit(c.id, { key: 'different', prompt: 'private prompt', confirm: true, expectedRevision: before.revision }),
    (e) => e.status === 409 && e.code === 'CONVERSATION_NOT_WRITABLE');
  assert.equal((await restarted.get(c.id)).writer.active, false); // the refused submit opened no window
  assert.equal((await restarted.get(c.id)).turns.length, 1);
  // The stale dead-owner lease is reclaimed by the next REAL window open: a new live conversation on the same thread.
  const c2 = await restarted.connect({ site: 'chatgpt', targetId: 'selected' });
  // Same thread: the durable thread journal still fences the crashed unresolved turn — no blind resend across restart.
  await assert.rejects(restarted.submit(c2.id, { key: 'two', prompt: 'private prompt', confirm: true, expectedRevision: c2.revision }),
    (e) => e.status === 409 && e.code === 'THREAD_FENCED');
  const fenced = await restarted.get(c2.id);
  assert.equal(fenced.turns.length, 0); // the fence admitted nothing
  assert.equal(fenced.writer.active, true); // the window this submit opened stays held on the fenced thread
  assert.throws(() => acquireDriveLease({ root: f.dependencies.leaseRoot, port: 19222 }), /lease is held/); // stale lease was replaced by a live window
  await restarted.finish(c2.id); // teardown closes the window
  acquireDriveLease({ root: f.dependencies.leaseRoot, port: 19222 }).release(); // the host is free again
  const journalDir = path.join(f.paths.root, 'conversations', 'thread-turns');
  const journalFile = fs.readdirSync(journalDir).find((n) => n.endsWith('.turn-journal.json'));
  const journal = JSON.parse(fs.readFileSync(path.join(journalDir, journalFile), 'utf8'));
  assert.equal(journal.snapshot.turns.length, 1);
  assert.equal(journal.snapshot.turns[0].phase, 'unknown'); // the crashed turn stays unresolved: the fence is durable
  f.releaseReply.resolve();
});

test('partial typing keeps the window held, is never promoted by page observation, and stays fenced until teardown', async (t) => {
  const f = fixture(t);
  const c = await f.connect();
  f.adapters[0].type = async () => { throw new Error('interrupted mid-draft'); };
  await f.submit(c); // the runtime ack resolves at admission; the typing failure surfaces in the view
  for (let n = 0; n < 500 && (await f.runtime.get(c.id)).state !== 'needs-reconciliation'; n++) await new Promise(setImmediate);
  const v = await f.runtime.get(c.id);
  assert.equal(v.state, 'needs-reconciliation');
  assert.equal(v.diagnostic.uncertainty, 'partial-draft-possible');
  assert.equal(v.turn.send.state, 'not-attempted'); // typing began, dispatch never did
  assert.equal(v.writer.active, true); // the window stays with the partial draft
  assert.throws(() => acquireDriveLease({ root: f.dependencies.leaseRoot, port: 19222 }), /lease is held/);
  await assert.rejects(f.submit(c, { key: 'two', expectedRevision: v.revision }), (e) => e.code === 'THREAD_FENCED'); // no resend past a partial draft
  // A page observation that claims the user turn is delivered cannot promote a partial draft
  // (the same rule as a preparing crash): the attempt stays not-attempted and the fence holds.
  f.adapters[0].reconcile = async () => ({ binding: v.binding, evidence: { turnId: v.turn.id, payloadDigest: v.turn.payloadDigest,
    sessionId: c.sessionId, sequence: 11, kind: 'new-user-turn', source: 'page', identity: `user-${v.turn.id}` } });
  const checked = await f.runtime.reconcile(c.id, { expectedRevision: (await f.runtime.get(c.id)).revision });
  assert.equal(checked.turn.send.state, 'not-attempted');
  assert.equal((await f.runtime.get(c.id)).writer.active, true); // still fenced, window still held
  const journalDir = path.join(f.paths.root, 'conversations', 'thread-turns');
  const journalFile = fs.readdirSync(journalDir).find((n) => n.endsWith('.turn-journal.json'));
  const journal = JSON.parse(fs.readFileSync(path.join(journalDir, journalFile), 'utf8'));
  assert.equal(journal.snapshot.turns[0].phase, 'unknown'); // the durable thread fence
  // Teardown is the only exit: finish stops the capture, releases the window, and keeps the uncertainty honest.
  const done = await f.runtime.finish(c.id);
  assert.equal(done.diagnostic.uncertainty, 'partial-draft-possible');
  assert.equal((await f.runtime.get(c.id)).writer.active, false);
  acquireDriveLease({ root: f.dependencies.leaseRoot, port: 19222 }).release();
  f.releaseReply.resolve();
});

test('two authorized turns in one thread: separate correlation, per-turn attributed replies, window per turn, no blind resend', async (t) => {
  const f = fixture(t), c = await f.connect();
  const first = await f.submit(c, { key: 'one', prompt: 'first private prompt' });
  assert.equal(first.turn.phase, 'preparing');
  f.releaseReply.resolve();
  const one = await f.settle(c.id);
  assert.equal(one.turn.send.state, 'observed');
  assert.equal(one.reply.state, 'ready');
  assert.equal(one.writer.active, false); // idle between turns: the window closed with turn one
  acquireDriveLease({ root: f.dependencies.leaseRoot, port: 19222 }).release(); // host free between turns
  // Turn two: its own window opens for the effect and closes on its own observed delivery.
  const typing = deferred();
  f.adapters[0].type = async () => { await typing.promise; };
  const second = f.submit(c, { key: 'two', prompt: 'second private prompt', expectedRevision: (await f.runtime.get(c.id)).revision });
  for (let n = 0; n < 500 && !(await f.runtime.get(c.id)).writer.active; n++) await new Promise(setImmediate);
  assert.throws(() => acquireDriveLease({ root: f.dependencies.leaseRoot, port: 19222 }), /lease is held/);
  typing.resolve();
  await second;
  const two = await f.settle(c.id);
  assert.equal(two.turn.send.state, 'observed');
  assert.equal(two.reply.state, 'ready');
  for (let n = 0; n < 500 && (await f.runtime.get(c.id)).writer.active; n++) await new Promise(setImmediate);
  assert.equal((await f.runtime.get(c.id)).writer.active, false);
  // Separate correlation: distinct turn ids, keys, delivery identities and reply identities.
  assert.notEqual(one.turn.id, two.turn.id);
  assert.notEqual(one.turn.key, two.turn.key);
  assert.notEqual(one.turn.send.evidence.identity, two.turn.send.evidence.identity);
  assert.notEqual(one.reply.evidence.identity, two.reply.evidence.identity);
  // An idempotent replay of turn one is a pure read: same attempt, no second dispatch.
  const dispatches = f.calls.filter((v) => v === 'submit').length;
  const replay = await f.submit(c, { key: 'one', prompt: 'first private prompt', expectedRevision: (await f.runtime.get(c.id)).revision });
  assert.equal(replay.turn.id, one.turn.id);
  assert.equal(f.calls.filter((v) => v === 'submit').length, dispatches);
  // The durable thread journal holds both turns fully resolved (delivered + attributed reply + readiness).
  const journalDir = path.join(f.paths.root, 'conversations', 'thread-turns');
  const journalFile = fs.readdirSync(journalDir).find((n) => n.endsWith('.turn-journal.json'));
  const journal = JSON.parse(fs.readFileSync(path.join(journalDir, journalFile), 'utf8'));
  assert.equal(journal.snapshot.turns.length, 2);
  for (const turn of journal.snapshot.turns) {
    assert.equal(turn.delivery.state, 'observed');
    assert.equal(turn.reply.state, 'observed');
    assert.equal(turn.readiness.state, 'ready');
  }
});

test('owner metadata recovers attach/save window without reattaching or dispatching', async (t) => {
  let owner;
  const f = fixture(t, { ownerIsAlive: () => false, listSessions: () => owner ? [{ id: 'recoverable-session', conversationOwner: { conversationId: owner } }] : [] });
  const c = await f.connect(); owner = c.id; await f.runtime.finish(c.id);
  const file = path.join(f.paths.root, 'conversations', `${c.id}.conversation.json`), disk = JSON.parse(fs.readFileSync(file));
  disk.sessionId = null; disk.state = 'attaching'; disk.finish = { requested: false, phase: 'idle', error: null };
  fs.writeFileSync(file, JSON.stringify(disk));
  const before = [...f.calls], restarted = createConversationRuntime({ paths: f.paths, dependencies: f.dependencies });
  const recovered = await restarted.recover(c.id); // get/list are pure reads now; recovery is the explicit mutation
  assert.equal(recovered.sessionId, 'recoverable-session'); assert.equal(recovered.state, 'needs-reconciliation'); assert.equal(recovered.capture.state, 'incomplete');
  assert.deepEqual(f.calls, before); await restarted.close();
});

test('another runtime can read a live owner snapshot without rewriting it or finishing its capture', async (t) => {
  const f = fixture(t), c = await f.connect();
  const file = path.join(f.paths.root, 'conversations', `${c.id}.conversation.json`), before = fs.readFileSync(file, 'utf8');
  const second = createConversationRuntime({ paths: f.paths, port: 19222, dependencies: f.dependencies });
  assert.equal((await second.get(c.id)).id, c.id);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  await assert.rejects(second.finish(c.id), (e) => e.status === 409);
  await assert.rejects(second.reconcile(c.id, { expectedRevision: c.revision }), (e) => e.status === 409);
  assert.equal(fs.readFileSync(file, 'utf8'), before); await second.close();
});

function browserFixture({ freshTab = false, readinessDependencies = {} } = {}) {
  const calls = [], records = [], store = new Map(); let users = ['earlier prompt'], origin = 'https://chatgpt.com', draftChars = 0, draft = '', rec;
  const id = '11111111-1111-4111-8111-111111111111';
  const thread = freshTab ? null : { kind: 'chatgpt-c', id, ref: `chatgpt-c:${id}` };
  const binding = { targetId: freshTab ? 'pending' : 'selected', origin, ownedByStudio: freshTab, ...(thread ? { thread } : {}) };
  class FakeRecorder {
    constructor(options) {
      calls.push(['recorder', options]); rec = this; this.state = 'idle';
      this.page = { send: async (method, params) => { calls.push([method, params]); return {}; } };
    }
    on() {}
    tap() { return { close() { calls.push(['tap-close']); } }; }
    async start(options) {
      calls.push(['start', options]); this.session = { id: 'raw-session', raw: { seq: 10, stats: { bytes: 10 } }, kv: { get: (k) => store.get(k), set: (k, v) => store.set(k, v) } };
      options.onSessionCreated(this.session); this.state = 'recording'; return this.session;
    }
    recordConversationObservation(record) { records.push(record); return ++this.session.raw.seq; }
    async stop() { calls.push(['stop']); this.state = 'idle'; return { verify: { ok: true } }; }
  }
  const adapter = createConversationBrowserAdapter({ paths: { sessions: 'unused' }, profileStore: { load: () => ({}) }, port: 19222,
    siteAdapter: { id: 'chatgpt', url: `${origin}/` }, targetId: 'selected', freshTab, conversationId: 'conversation', ownerToken: 'owner-token',
    dependencies: {
      Recorder: FakeRecorder, listSessions: () => [], listTargets: async () => [{ id: freshTab ? 'created' : 'selected', url: `${origin}${freshTab ? '/' : `/c/${id}`}` }],
      fetch: async (url, options) => { calls.push(['fetch', url, options]); return { ok: true, json: async () => ({ id: 'created' }) }; },
      evaluate: async (_, expression) => expression === 'location.pathname' ? (freshTab ? '/' : `/c/${id}`) : origin, findComposer: async () => ({ found: true }), focusComposer: async () => ({ ok: true }),
      tracePage: (method, params) => calls.push([method, params]),
      readTurnPage: async () => ({ origin, pathname: freshTab ? '/' : `/c/${id}`, messages: users.flatMap((text, index) => [
        { id: `fixture-user-${index}`, role: 'user', text }, { id: `fixture-reply-${index}`, role: 'assistant', text: index ? 'page answer' : 'old answer' }]),
        draft: { text: draft, chars: draftChars }, controls: { observed: true, state: 'idle', idleControlPresent: true, stopPresent: false, composerEnabled: true } }),
      sendState: async () => ({ evalOk: true, draftChars }), readUserTurns: async () => [...users],
      readTranscript: async () => ({ last: 'old answer', count: 1 }),
      typeText: async (page, prompt, options) => { await options.beforeInsert(); calls.push(['type', prompt]); draft = prompt; draftChars = prompt.length; return { ok: true, typed: prompt }; },
      sendMessage: async () => { calls.push(['send']); return { uncertain: true }; },
      waitForCompletion: async () => ({ done: true, text: 'page answer' }), replySettleMs: 0,
      detectAuthWall: async () => ({ blocked: false }), detectSiteFailure: async () => ({ failed: false }),
      ...readinessDependencies,
    } });
  const connect = async () => {
    const result = await adapter.connect(binding, { bind: (b) => calls.push(['bind', b]), ownSession: (id) => calls.push(['own-session', id]) });
    if (result.deferredCapture) await adapter.armCapture();
    return result;
  };
  const args = { binding, turnId: 'turn', payloadDigest: createHash('sha256').update('new prompt').digest('hex') };
  return { adapter, connect, calls, records, args, get recorder() { return rec; },
    setUsers: (v) => { users = v; }, setOrigin: (v) => { origin = v; }, setDraft: (v) => { draftChars = v; draft = 'x'.repeat(v); } };
}

test('browser seam existing target never navigates/clears, foregrounds exact recorder page before type', async () => {
  const f = browserFixture(); await f.connect(); await f.adapter.preflight(); await f.adapter.type({ prompt: 'new prompt', turnId: 'turn' });
  assert.ok(f.calls.find(([name]) => name === 'start')[1].exactTarget);
  assert.deepEqual(f.calls.filter(([name]) => name.startsWith('Page.')).map(([name]) => name), ['Page.bringToFront']);
  assert.equal(f.calls.some(([name]) => name === 'fetch'), false);
  assert.ok(f.calls.findIndex(([name]) => name === 'Page.bringToFront') < f.calls.findIndex(([name]) => name === 'type'));
  await f.adapter.stop();
});

test('browser seam fresh tab navigates its own tab before any recorder arm', async () => {
  const f = browserFixture({ freshTab: true }); const result = await f.connect();
  assert.equal(result.binding.targetId, 'created'); assert.equal(result.deferredCapture, true); assert.equal(result.sessionId, null);
  const names = f.calls.map(([name]) => name);
  assert.ok(names.indexOf('bind') < names.indexOf('Page.navigate'));
  assert.ok(names.indexOf('Page.navigate') < names.indexOf('start'));
  const started = f.calls.find(([name]) => name === 'start')[1];
  assert.equal(started.exactTarget, true); assert.equal(started.follow, false); assert.equal(started.profile, 'chatgpt');
  assert.equal(f.calls.find(([name]) => name === 'fetch')[1].endsWith('/json/new?about:blank'), true);
  await f.adapter.stopTurnCapture(); await f.adapter.stop();
});

test('browser seam only records exact newly added user prompt as page evidence, never timing/network proof', async () => {
  const f = browserFixture(); await f.connect(); await f.adapter.preflight(); await f.adapter.type({ prompt: 'new prompt', turnId: 'turn' });
  assert.equal(await f.adapter.submit(f.args), null); // sendMessage heuristic/ack alone is insufficient.
  for (const users of [['earlier prompt'], ['unrelated', 'new prompt'], ['earlier prompt', 'different prompt'],
    ['earlier prompt', 'new  prompt'], ['earlier prompt', 'new prompt', 'extra turn']]) {
    f.setUsers(users); assert.equal(await f.adapter.reconcile(f.args), null);
  }
  assert.equal(f.records.length, 0);
  f.setUsers(['earlier prompt', 'new prompt']); const observed = await f.adapter.reconcile(f.args);
  assert.equal(observed.evidence.kind, 'new-user-turn'); assert.equal(observed.evidence.source, 'page');
  assert.equal(observed.evidence.sessionId, 'raw-session'); assert.ok(observed.evidence.sequence > 10);
  assert.equal(f.records[0].text, 'new prompt'); assert.equal(f.records[0].baselineSequence, 10);
  assert.equal(f.calls.filter(([name]) => name === 'send').length, 1);
  const reply = await f.adapter.readReply(null, { ...f.args, threadKey: canonicalThreadKey({ namespace: 'local-owner', origin: f.args.binding.origin, thread: f.args.binding.thread }) }); assert.equal(reply.text, 'page answer'); await f.adapter.stop();
});

test('browser seam binding/draft change blocks typing; observation persistence failure cannot prove send', async () => {
  const f = browserFixture(); await f.connect(); await f.adapter.preflight();
  f.setDraft(2); await assert.rejects(f.adapter.type({ prompt: 'new prompt', turnId: 'turn' }), /DRAFT_PRESENT/);
  assert.equal(f.calls.some(([name]) => name === 'type'), false);
  f.setDraft(0); await f.adapter.type({ prompt: 'new prompt', turnId: 'turn' });
  f.setUsers(['earlier prompt', 'new prompt']); f.recorder.recordConversationObservation = () => { throw new Error('disk failed'); };
  await assert.rejects(f.adapter.reconcile(f.args), /disk failed/);
  f.setOrigin('https://other.test'); await assert.rejects(f.adapter.reconcile(f.args), /BINDING_CHANGED/);
  await f.adapter.stop();
});

test('real evaluated user-turn reader ignores hidden/nested duplicates, retains repeated prompt turns', async () => {
  const node = (text, width = 20) => ({ innerText: text, getBoundingClientRect: () => ({ width, height: 20 }), contains: () => false });
  const outer = node('same prompt'), inner = node('same prompt'), repeated = node('same prompt'), hidden = node('hidden', 0);
  outer.contains = (el) => el === inner;
  const page = { async send(method, params) { return { result: { value: vm.runInNewContext(params.expression, { document: { querySelectorAll: () => [outer, inner, repeated, hidden] } }) } }; } };
  assert.deepEqual(Array.from(await readUserTurns(page)), ['same prompt', 'same prompt']);
});

test('Recorder observation uses the same real raw log and returns a flushed sequence', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'conversation-observation-'));
  const raw = new RawLog(root); t.after(async () => { await raw.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const recorder = new Recorder({ sessionsDir: root }); recorder.state = 'recording'; recorder.session = { raw };
  recorder.reducer = { ingest: () => [] };
  const sequence = recorder.recordConversationObservation({ source: 'page', kind: 'new-user-turn', text: 'local evidence', turnId: 'turn' });
  assert.ok(sequence > 0); assert.equal(raw.queue.length, 0);
  const line = JSON.parse(fs.readFileSync(path.join(root, raw.segName), 'utf8').trim());
  assert.equal(line.seq, sequence); assert.equal(line.k, 'conversation.observation'); assert.equal(line.text, 'local evidence');
});

test('real Recorder persists recoverable owner before failed journal callback and never attaches', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'conversation-owner-'));
  const oldFetch = globalThis.fetch;
  let requests = 0, created;
  globalThis.fetch = async (url) => {
    requests++;
    assert.ok(String(url).endsWith('/json/version') || String(url).endsWith('/json/list'));
    return { ok: true, json: async () => String(url).endsWith('/json/version') ? { Browser: 'fake', 'Protocol-Version': 'fake' }
      : [{ id: 'exact', type: 'page', url: 'about:blank' }] };
  };
  t.after(async () => { globalThis.fetch = oldFetch; if (created) await created.raw.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const recorder = new Recorder({ sessionsDir: root, profileStore: { load: () => ({ name: 'explicit-profile', version: 1 }) } });
  await assert.rejects(recorder.start({ target: 'exact', exactTarget: true, profile: 'explicit-profile',
    owner: { conversationId: 'recover-me', pid: process.pid, token: 'owner-token' },
    onSessionCreated(session) { created = session; throw new Error('journal save failed'); } }), /journal save failed/);
  const meta = JSON.parse(fs.readFileSync(path.join(created.dir, 'session.json'), 'utf8'));
  assert.equal(meta.conversationOwner.conversationId, 'recover-me'); assert.equal(meta.profile.name, 'explicit-profile');
  assert.equal(meta.target.id, 'exact'); assert.equal(recorder.conn, undefined); assert.equal(requests, 2);
});

test('Finish during deferred typing prevents submit and preserves partial draft uncertainty', async (t) => {
  const f = fixture(t), c = await f.connect();
  const entered = deferred(), release = deferred();
  f.adapters[0].type = async () => { entered.resolve(); await release.promise; };
  await f.submit(c); await entered.promise;
  const finish = f.runtime.finish(c.id, { closeTab: true }); release.resolve();
  const done = await finish;
  assert.equal(f.calls.includes('submit'), false); assert.equal(f.calls.includes('close-tab'), false);
  assert.equal(done.turn.send.state, 'not-attempted'); assert.equal(done.diagnostic.uncertainty, 'partial-draft-possible');
});

test('Finish after dispatch boundary cannot claim no send', async (t) => {
  const f = fixture(t), c = await f.connect();
  const entered = deferred(), release = deferred();
  f.adapters[0].submit = async () => { entered.resolve(); await release.promise; return null; };
  await f.submit(c); await entered.promise;
  const finish = f.runtime.finish(c.id, { closeTab: true }); release.resolve();
  assert.equal((await finish).turn.send.state, 'uncertain'); assert.equal(f.calls.includes('close-tab'), false);
});

test('draft rejection is idempotent but manual draft resolution permits a new key', async (t) => {
  const f = fixture(t), c = await f.connect(); let draft = true;
  f.adapters[0].preflight = async (binding) => ({ binding, draft: { present: draft, chars: draft ? 4 : 0 }, boundary: { sequence: 10, transcriptCount: 1 } });
  await f.submit(c);
  let blocked;
  for (let n = 0; n < 100; n++) { blocked = await f.runtime.get(c.id); if (blocked.turn.phase === 'blocked') break; await new Promise(setImmediate); }
  assert.equal(blocked.readiness.reason, 'DRAFT_PRESENT'); assert.equal(blocked.readiness.draft.chars, 4);
  draft = false;
  assert.equal((await f.submit(c)).turn.phase, 'blocked');
  const registered = await f.submit(blocked, { key: 'resolved' }); assert.notEqual(registered.turn.id, blocked.turn.id);
  f.releaseReply.resolve(); const reply = await f.settle(c.id); assert.equal(reply.turn.send.state, 'observed');
  assert.equal(f.calls.filter((name) => name === 'submit').length, 1);
});

test('reconciliation starts one shared reply observer without a second send', async (t) => {
  const f = fixture(t); f.setObserve(false); const c = await f.connect(); await f.submit(c); const uncertain = await f.settle(c.id);
  const disk = JSON.parse(fs.readFileSync(path.join(f.paths.root, 'conversations', `${c.id}.conversation.json`)));
  const a = disk.attempts.at(-1);
  f.adapters[0].reconcile = async () => ({ binding: uncertain.binding, evidence: { turnId: a.id, payloadDigest: a.payloadDigest,
    sessionId: c.sessionId, sequence: 11, kind: 'new-user-turn', source: 'page', identity: `user-${a.id}` } });
  await f.runtime.reconcile(c.id, { expectedRevision: uncertain.revision });
  for (let n = 0; n < 50 && !f.calls.includes('reply'); n++) await new Promise(setImmediate);
  await f.runtime.reconcile(c.id, { expectedRevision: (await f.runtime.get(c.id)).revision });
  assert.equal(f.calls.filter((name) => name === 'reply').length, 1); assert.equal(f.calls.filter((name) => name === 'submit').length, 1);
  f.releaseReply.resolve(); assert.equal((await f.settle(c.id)).reply.text, 'private answer');
});

test('optional close failure releases stopped capture lease without closure retry', async (t) => {
  const f = fixture(t), c = await f.connect({ freshTab: true, targetId: undefined });
  let closes = 0; f.adapters[0].closeTab = async () => { closes++; throw new Error('ack lost'); };
  const done = await f.runtime.finish(c.id, { closeTab: true });
  assert.equal(done.diagnostic.finishError, 'TAB_CLOSE_UNCONFIRMED'); assert.equal(f.runtime.isSessionActive(c.sessionId), false);
  acquireDriveLease({ root: f.dependencies.leaseRoot, port: 19222 }).release();
  await f.runtime.finish(c.id, { closeTab: true }); assert.equal(closes, 1);
});

test('page reply updates are full replacements, visible while streaming, then ready', async (t) => {
  const f = fixture(t, { replyUpdateMs: 1 }), c = await f.connect(); const observed = deferred(), completion = deferred(); let publish;
  f.adapters[0].readReply = async (onUpdate, args) => { publish = (update) => onUpdate(qualifiedReply(f.adapters[0], args, update.text, 'streaming')); observed.resolve(); await completion.promise; return qualifiedReply(f.adapters[0], args, 'final replacement'); };
  f.adapters[0].stopWaiting = () => completion.resolve();
  await f.submit(c); await observed.promise;
  publish({ text: 'partial first' }); await new Promise((r) => setTimeout(r, 20));
  assert.equal((await f.runtime.get(c.id)).reply.text, 'partial first');
  publish({ text: 'replacement' }); await new Promise((r) => setTimeout(r, 20));
  const stream = await f.runtime.get(c.id); assert.equal(stream.reply.state, 'streaming'); assert.equal(stream.reply.text, 'replacement');
  completion.resolve(); assert.equal((await f.settle(c.id)).reply.text, 'final replacement');
  publish({ text: 'late stale update' }); await new Promise((r) => setTimeout(r, 20));
  assert.equal((await f.runtime.get(c.id)).reply.text, 'final replacement');
});

test('Finish freezes latest partial reply and ignores later completion/update', async (t) => {
  const f = fixture(t, { replyUpdateMs: 1 }), c = await f.connect(); const observed = deferred(), completion = deferred(); let publish;
  f.adapters[0].readReply = async (onUpdate, args) => { publish = (update) => onUpdate(qualifiedReply(f.adapters[0], args, update.text, 'streaming')); observed.resolve(); await completion.promise; return qualifiedReply(f.adapters[0], args, 'too late'); };
  f.adapters[0].stopWaiting = () => completion.resolve();
  await f.submit(c); await observed.promise; publish({ text: 'preserved partial' });
  const done = await f.runtime.finish(c.id); assert.equal(done.reply.state, 'interrupted'); assert.equal(done.reply.text, 'preserved partial');
  publish({ text: 'late' }); await new Promise((r) => setTimeout(r, 20));
  assert.equal((await f.runtime.get(c.id)).reply.text, 'preserved partial');
});

test('fresh readiness waits read-only for exact origin and composer before ready', async () => {
  let checks = 0, composers = 0;
  const f = browserFixture({ freshTab: true, readinessDependencies: {
    listTargets: async () => [{ id: 'created', url: ++checks < 3 ? 'about:blank' : 'https://chatgpt.com/' }],
    findComposer: async () => ({ found: ++composers >= 3 }), sleep: async () => {},
  } });
  const connected = await f.connect(); assert.equal(connected.readiness.ready, true); assert.ok(checks >= 5);
  assert.equal(f.calls.some(([name]) => name === 'type' || name === 'send'), false); await f.adapter.stop();
});

test('fresh readiness reports outside redirect and auth gate safely as blocked', async () => {
  const redirect = browserFixture({ freshTab: true, readinessDependencies: { listTargets: async () => [{ id: 'created', url: 'https://outside.test/private?token=secret' }] } });
  const result = await redirect.connect(); assert.equal(result.readiness.reason, 'BINDING_CHANGED'); assert.equal(result.readiness.ready, false);
  assert.equal(JSON.stringify(result).includes('secret'), false); await redirect.adapter.stop();
  const auth = browserFixture({ freshTab: true, readinessDependencies: { detectAuthWall: async () => ({ blocked: true, reason: 'private raw URL' }) } });
  assert.equal((await auth.connect()).readiness.reason, 'AUTH_WALL'); await auth.adapter.stop();
});

// ---- F1/F3/F4/F5/F6/F7 coverage: injected fakes only, no browser, no network, no long timers ----
const sha = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const leaseFree = (f) => { acquireDriveLease({ root: f.dependencies.leaseRoot, port: 19222 }).release(); };

test('F1 adapter: proven not-dispatched send throws SEND_NOT_DISPATCHED; ambiguous results stay unobserved (uncertain path)', async () => {
  const refusal = { ok: false, sent: false, dispatched: false, sendStatus: 'not-attempted', uncertain: false, reason: 'no draft' };
  const f = browserFixture({ readinessDependencies: { sendMessage: async () => { f.calls.push(['send']); return refusal; } } });
  await f.connect(); await f.adapter.preflight(); await f.adapter.type({ prompt: 'new prompt', turnId: 'turn' });
  await assert.rejects(f.adapter.submit(f.args), (e) => e.code === 'SEND_NOT_DISPATCHED' && e.notDispatched === true);
  await f.adapter.stop();
  for (const ambiguous of [{ dispatched: false }, { dispatched: false, sendStatus: 'not-attempted' }, { dispatched: false, uncertain: true, sendStatus: 'not-attempted' },
    { dispatched: true, sendStatus: 'uncertain', uncertain: true }, { uncertain: true }, undefined]) {
    const g = browserFixture({ readinessDependencies: { sendMessage: async () => ambiguous } });
    await g.connect(); await g.adapter.preflight(); await g.adapter.type({ prompt: 'new prompt', turnId: 'turn' });
    assert.equal(await g.adapter.submit(g.args), null, JSON.stringify(ambiguous)); // no coded notDispatched error => service records uncertain
    await g.adapter.stop();
  }
});

test('F1 runtime: adapter notDispatched => turn not-attempted/needs-reconciliation, never uncertain; ambiguous failure => uncertain', async (t) => {
  const f = fixture(t), c = await f.connect();
  f.adapters[0].submit = async () => { f.calls.push('submit'); throw Object.assign(new Error('SEND_NOT_DISPATCHED'), { code: 'SEND_NOT_DISPATCHED', notDispatched: true }); };
  await f.submit(c);
  let s; for (let n = 0; n < 200; n++) { s = await f.runtime.get(c.id); if (s.turn?.phase === 'needs-reconciliation') break; await new Promise(setImmediate); }
  assert.equal(s.turn.send.state, 'not-attempted'); assert.equal(s.turn.phase, 'needs-reconciliation'); assert.equal(s.state, 'needs-reconciliation');
  assert.equal(s.turn.reason, 'SEND_NOT_DISPATCHED'); assert.notEqual(s.turn.send.state, 'uncertain'); assert.equal(f.calls.filter((v) => v === 'submit').length, 1);
  const g = fixture(t), d = await g.connect();
  g.adapters[0].submit = async () => { g.calls.push('submit'); throw new Error('transport lost'); };
  await g.submit(d); const u = await g.settle(d.id);
  assert.equal(u.turn.send.state, 'uncertain'); assert.equal(g.calls.filter((v) => v === 'submit').length, 1);
});

class FailingRecorder {
  constructor(shared) { Object.assign(this, { state: 'idle', conn: null }); this.shared = shared; this.page = { send: async (method, params) => { shared.calls.push([method, params]); return {}; } }; }
  on() {}
  tap() { return { close() {} }; }
  async start(options) {
    if (this.shared.createSession) {
      this.session = { id: 'half-created', raw: { seq: 0, stats: { bytes: 0 }, close: async () => { this.shared.rawClosed++; } }, kv: new Map(),
        meta: { status: 'recording' }, saveMeta: () => { this.shared.metas.push({ ...this.session.meta }); } };
      options.onSessionCreated(this.session);
    }
    throw new Error('attach failed');
  }
}
// Runtime + REAL adapter + real lease; only Recorder, fetch and CDP helpers are fake.
function attachFixture(t, { fresh = true, createSession = true, closeOk = true } = {}) {
  const shared = { calls: [], metas: [], rawClosed: 0, createSession };
  const f = fixture(t, {
    listTargets: async () => [{ id: 'owner-tab', type: 'page', url: 'https://chatgpt.com/' }],
    createAdapter: (o) => createConversationBrowserAdapter({ ...o, profileStore: { load: () => ({}) }, dependencies: {
      Recorder: class extends FailingRecorder { constructor() { super(shared); } },
      listSessions: () => [], listTargets: async () => [{ id: 'owner-tab', url: 'https://chatgpt.com/' }],
      fetch: async (url, init) => { shared.calls.push(['fetch', String(url), init?.method ?? 'GET']);
        return String(url).includes('/json/new') ? { ok: true, json: async () => ({ id: 'created' }) } : { ok: closeOk }; },
      readinessTimeoutMs: 200, connectGraceMs: 200, fetchTimeoutMs: 100 } }),
  });
  const body = fresh ? { freshTab: true, targetId: undefined } : {};
  return { f, shared, body, fetches: () => shared.calls.filter(([n]) => n === 'fetch').map(([, u, m]) => `${m} ${u.replace(/^http:\/\/127\.0\.0\.1:\d+/, '')}`) };
}
const failedConnect = async (f, body) => { try { await f.connect(body); } catch (e) { return e; } assert.fail('connect should have failed'); };

test('F3 failed attach after Studio tab creation: session incomplete, ONLY that tab closed, lease released, two failures leave no lease', async (t) => {
  const a = attachFixture(t);
  for (let round = 0; round < 2; round++) {
    const e = await failedConnect(a.f, a.body);
    assert.equal(e.code, 'ATTACHMENT_FAILED'); assert.ok(e.conversationId);
    const s = await a.f.runtime.get(e.conversationId);
    assert.equal(s.capture.state, 'incomplete'); assert.equal(s.state, 'needs-reconciliation');
    assert.equal(s.limitations.some((l) => /left open/.test(l)), false); // tab confirmed closed => nothing to warn about
    leaseFree(a.f); // no lease survived this failure (a DRIVE_LEASE_BUSY would throw here and on the next round)
  }
  assert.deepEqual(a.fetches().filter((l) => l.includes('/json/close')), ['GET /json/close/created', 'GET /json/close/created']);
  assert.equal(a.fetches().some((l) => /owner-tab/.test(l)), false);
  assert.equal(a.shared.metas.length, 0); assert.equal(a.shared.rawClosed, 0); // idle connect never armed the recorder
  assert.equal(a.shared.calls.some(([n]) => n === 'Page.navigate'), false);
});

test('F3 lease is still held while the adapter cleans up, and released only afterwards', async (t) => {
  const f = fixture(t, { createAdapter: () => {
    const adapter = { mayOwnResources: true, async connect() { throw new Error('boom'); },
      async abortConnect() { f.calls.push('abort'); assert.throws(() => acquireDriveLease({ root: f.dependencies.leaseRoot, port: 19222 }), /lease is held/); return { captureFinalized: true, tab: 'closed' }; } };
    return adapter; } });
  const e = await failedConnect(f, { freshTab: true, targetId: undefined });
  assert.equal(e.code, 'ATTACHMENT_FAILED'); assert.deepEqual(f.calls, ['abort']); leaseFree(f);
});

test('F3 unconfirmed tab close keeps the tab, still releases the lease and tells the user via limitation', async (t) => {
  const a = attachFixture(t, { closeOk: false });
  const e = await failedConnect(a.f, a.body); leaseFree(a.f);
  const s = await a.f.runtime.get(e.conversationId);
  assert.ok(s.limitations.some((l) => /left open/.test(l) && /manually/.test(l)));
  assert.equal(s.capture.state, 'incomplete');
  assert.deepEqual(a.fetches().filter((l) => l.includes('/json/close')), ['GET /json/close/created']);
  assert.equal((await failedConnect(a.f, a.body)).code, 'ATTACHMENT_FAILED'); // lease was free for the next attempt
});

test('F3 owner/selected tab: failed attach never closes, navigates or clears it, still finalizes and frees the lease', async (t) => {
  const a = attachFixture(t, { fresh: false });
  const e = await failedConnect(a.f, { targetId: 'owner-tab' }); leaseFree(a.f);
  assert.equal(a.fetches().length, 0); assert.equal(a.shared.calls.length, 0);
  assert.equal(a.shared.metas.length, 0); assert.equal(a.shared.rawClosed, 0);
  const s = await a.f.runtime.get(e.conversationId); assert.equal(s.capture.state, 'incomplete');
  assert.equal(s.limitations.some((l) => /left open/.test(l)), false);
});

test('F3 fresh tab failure before any session exists still closes the created tab and frees the lease', async (t) => {
  const a = attachFixture(t, { createSession: false });
  await failedConnect(a.f, a.body); leaseFree(a.f);
  assert.deepEqual(a.fetches(), ['PUT /json/new?about:blank', 'GET /json/close/created']); assert.equal(a.shared.metas.length, 0);
});

test('F4 never-resolving tab-create fetch fails fast with BROWSER_HTTP_TIMEOUT and reports an unconfirmed tab', async () => {
  const f = browserFixture({ freshTab: true, readinessDependencies: { fetch: () => new Promise(() => {}), fetchTimeoutMs: 50 } });
  const started = Date.now();
  await assert.rejects(f.connect(), (e) => e.code === 'BROWSER_HTTP_TIMEOUT');
  assert.ok(Date.now() - started < 1500);
  assert.deepEqual(await f.adapter.abortConnect(), { captureFinalized: true, tab: 'unconfirmed', targetId: null });
});

test('F4 hung attach step hits total CONNECT_TIMEOUT and the Studio-created tab is closed', async () => {
  const closes = [];
  class HungRecorder { constructor() { this.state = 'idle'; } on() {} start() { return new Promise(() => {}); } }
  const f = browserFixture({ freshTab: true, readinessDependencies: { Recorder: HungRecorder, readinessTimeoutMs: 30, connectGraceMs: 20, fetchTimeoutMs: 50,
    fetch: async (url) => { if (String(url).includes('/json/close/')) closes.push(String(url)); return { ok: true, json: async () => ({ id: 'created' }) }; } } });
  const started = Date.now();
  await assert.rejects(f.connect(), (e) => e.code === 'CONNECT_TIMEOUT');
  assert.ok(Date.now() - started < 1500);
  assert.equal((await f.adapter.abortConnect()).tab, 'closed');
  assert.ok(closes.length >= 1 && closes.every((u) => u.endsWith('/json/close/created')));
});

test('F5 recorder stop failure: meta incomplete with endReason, not stuck at stopping, second stop() really retries', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'conversation-stop-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const recorder = new Recorder({ sessionsDir: root }), saved = [];
  recorder.state = 'recording';
  recorder.session = { meta: { status: 'recording' }, saveMeta() { saved.push({ ...this.meta }); } };
  let underlying = 0;
  recorder._stop = async function () { underlying++; this.state = 'stopping'; if (underlying === 1) throw new Error('flush failed'); this.state = 'idle'; return { id: 'done' }; };
  await assert.rejects(recorder.stop({ reason: 'conversation_finish' }), /flush failed/);
  assert.equal(recorder.state, 'stop_failed'); assert.notEqual(recorder.state, 'stopping');
  assert.equal(recorder.session.meta.status, 'incomplete'); assert.equal(recorder.session.meta.endReason, 'stop_failed:conversation_finish');
  assert.equal(saved.at(-1).status, 'incomplete');
  assert.deepEqual(await recorder.stop({ reason: 'conversation_finish' }), { id: 'done' });
  assert.equal(underlying, 2); assert.equal(recorder.state, 'idle');
});

test('F5 adapter stop() after a failed recorder stop retries the recorder instead of caching the failure', async () => {
  let stops = 0;
  class StoppyRecorder extends FailingRecorder {
    async start(options) { this.session = { id: 'ok-session', raw: { seq: 10, stats: { bytes: 1 }, close: async () => {} }, kv: new Map(), meta: {}, saveMeta() {} };
      options.onSessionCreated(this.session); this.state = 'recording'; return this.session; }
    async stop() { stops++; if (stops === 1) { this.state = 'stop_failed'; throw new Error('stop failed'); } this.state = 'idle'; return { verify: { ok: true } }; }
  }
  const f = browserFixture({ readinessDependencies: { Recorder: class extends StoppyRecorder { constructor() { super({ calls: [] }); } } } });
  await f.connect();
  await assert.rejects(f.adapter.stop(), /stop failed/);
  assert.equal(f.adapter.mayOwnResources, true); // still owned: a failed stop must not look finalized
  await f.adapter.stop();
  assert.equal(stops, 2); assert.equal(f.adapter.mayOwnResources, false); assert.deepEqual(f.adapter.integrity, { ok: true });
});

test('F6 finished conversation: same key + payload returns the original turn read-only; other key/payload rejected', async (t) => {
  const f = fixture(t), c = await f.connect(); const first = await f.submit(c); f.releaseReply.resolve(); await f.settle(c.id);
  await f.runtime.finish(c.id);
  const file = path.join(f.paths.root, 'conversations', `${c.id}.conversation.json`), before = sha(file), calls = [...f.calls];
  const replay = await f.submit(c); // key 'one' / 'private prompt'
  assert.equal(replay.turn.id, first.turn.id); assert.equal(replay.turn.send.state, 'observed');
  await assert.rejects(f.submit(c, { prompt: 'changed' }), (e) => e.status === 409 && e.code === 'IDEMPOTENCY_CONFLICT');
  await assert.rejects(f.submit(c, { key: 'two' }), (e) => e.status === 409 && e.code === 'CONVERSATION_FINISHED');
  assert.equal(sha(file), before); assert.deepEqual(f.calls, calls); assert.equal(f.calls.filter((v) => v === 'submit').length, 1);
});

test('F6 restart-recovered conversation: same key replays original read-only, new keys stay non-writable, nothing written or dispatched', async (t) => {
  const f = fixture(t, { ownerIsAlive: () => false }), c = await f.connect(); const first = await f.submit(c); f.releaseReply.resolve(); await f.settle(c.id);
  const restarted = createConversationRuntime({ paths: f.paths, port: 19222, dependencies: f.dependencies });
  t.after(() => restarted.close());
  const recovered = await restarted.recover(c.id); assert.equal(recovered.state, 'needs-reconciliation');
  const file = path.join(f.paths.root, 'conversations', `${c.id}.conversation.json`), before = sha(file), calls = [...f.calls];
  const replay = await restarted.submit(c.id, { key: 'one', prompt: 'private prompt', confirm: true, expectedRevision: recovered.revision });
  assert.equal(replay.turn.id, first.turn.id);
  await assert.rejects(restarted.submit(c.id, { key: 'one', prompt: 'changed', confirm: true, expectedRevision: recovered.revision }), (e) => e.code === 'IDEMPOTENCY_CONFLICT' && e.status === 409);
  await assert.rejects(restarted.submit(c.id, { key: 'fresh', prompt: 'x', confirm: true, expectedRevision: recovered.revision }), (e) => e.code === 'CONVERSATION_NOT_WRITABLE' && e.status === 409);
  assert.equal(sha(file), before); assert.deepEqual(f.calls, calls);
});

test('F7 isSessionActive is a pure read: file bytes unchanged even when load() would have rewritten the snapshot', async (t) => {
  const f = fixture(t, { ownerIsAlive: () => false }), c = await f.connect();
  const file = path.join(f.paths.root, 'conversations', `${c.id}.conversation.json`);
  const disk = JSON.parse(fs.readFileSync(file, 'utf8')); disk.state = 'attaching'; fs.writeFileSync(file, JSON.stringify(disk, null, 2));
  const fresh = () => createConversationRuntime({ paths: f.paths, port: 19222, dependencies: f.dependencies });
  const before = sha(file), reader = fresh();
  assert.equal(reader.isSessionActive(c.sessionId), true); assert.equal(reader.isSessionActive('unrelated-session'), false);
  assert.equal(reader.isSessionActive(''), false); assert.equal(sha(file), before);
  assert.equal(sha(file), before); await fresh().get(c.id); assert.equal(sha(file), before); // get is pure now
  await fresh().recover(c.id); assert.notEqual(sha(file), before); // control: the explicit recovery path really does rewrite
});

test('F7 corrupt or unreadable snapshot counts as active (never stolen), is not rewritten and does not throw', async (t) => {
  const f = fixture(t), directory = path.join(f.paths.root, 'conversations');
  for (const content of ['{ not json', 'null', '{}', '[]']) {
    const file = path.join(directory, 'broken.conversation.json'); fs.writeFileSync(file, content);
    const reader = createConversationRuntime({ paths: f.paths, port: 19222, dependencies: f.dependencies }), before = sha(file);
    assert.doesNotThrow(() => reader.isSessionActive('any-session'));
    assert.equal(reader.isSessionActive('any-session'), true, content); assert.equal(sha(file), before);
  }
  fs.rmSync(path.join(directory, 'broken.conversation.json'));
  const reader = createConversationRuntime({ paths: f.paths, port: 19222, dependencies: f.dependencies });
  assert.equal(reader.isSessionActive('any-session'), false);
});

test('runtime chatIndex uses accepted reader with its own exact read-only session, no recorder/drive lease/snapshot', async (t) => {
  let opens = 0, closes = 0, evaluations = 0;
  const identity = { origin: 'https://chatgpt.com', path: '/' };
  const f = fixture(t, {
    listTargets: async () => [{ id: 'index-tab', type: 'page', url: 'https://chatgpt.com/' }],
    acquireLease() { throw new Error('Index must not acquire a driving lease'); },
    createAdapter() { throw new Error('Index must not create a capture adapter'); },
    openIndexSession: async (args) => { opens++; assert.deepEqual(args, { targetId: 'index-tab', port: 19222 }); return { session: {}, async close() { closes++; } }; },
    evaluateIndex: async (_, expression) => {
      evaluations++;
      return expression.includes('const before = id()') ? { before: identity, after: identity,
        result: { origin: identity.origin, renderedLinks: 0, links: [] } } : identity;
    },
  });
  const before = fs.readdirSync(path.join(f.paths.root, 'conversations'));
  const result = await f.runtime.chatIndex({ targetId: 'index-tab' });
  assert.equal(result.index.candidatesOnly, true); assert.equal(result.index.complete, false);
  assert.equal(opens, 1); assert.equal(closes, 1); assert.equal(evaluations, 3);
  assert.deepEqual(fs.readdirSync(path.join(f.paths.root, 'conversations')), before);
  assert.deepEqual(f.calls, []);
  await f.runtime.close();
  await assert.rejects(f.runtime.chatIndex({ targetId: 'index-tab' }), (e) => e.code === 'RUNTIME_CLOSED');
});
