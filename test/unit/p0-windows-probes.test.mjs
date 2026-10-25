// Issue #81 P0 Windows probes: real child processes against the REAL production owner (src/store/versioned.mjs and its
// factory / I1 callers). Disposable temp roots only; every child is bounded and killed on teardown. No copied lock logic,
// no provider, no browser, no Playwright, no installed-tool EULA prompts (handle.exe is deliberately NOT used: the OS
// handle count comes from Get-Process, which needs no acceptance).
// Each probe prints one `P0_METRICS {json}` line on stdout (and appends it to $AION_P0_METRICS_FILE when set) so a
// reviewer can read real numbers, not just pass/fail. These are developer probes; independent acceptance is separate.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { VersionedStore, STORE_LOCK_SCHEMA } from '../../src/store/versioned.mjs';
import { createCasVersionedStore } from '../../src/studio/adapter-learning-pipeline.mjs';
import { createAdapterFactory, AdapterFactoryError } from '../../src/studio/adapter-factory-service.mjs';

const WORKER = fileURLToPath(new URL('./fixtures/p0-windows-worker.mjs', import.meta.url));
const IS_WIN = process.platform === 'win32';
const ORIGIN = 'https://127.0.0.1:8443';

const tmp = (t, prefix = 'aion-p0-probe-') => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};
const i1Name = (scopeKey) => 'i1-' + createHash('sha256').update(String(scopeKey)).digest('hex').slice(0, 40);
const lockFiles = (dir) => { try { return fs.readdirSync(path.join(dir, '.locks')).sort(); } catch { return []; } };
const capture = (fn) => { try { fn(); return null; } catch (e) { return e; } };
const captureAsync = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
const ro = (n) => ({ schema: 'aion.learned-read-adapter/1', adapter: { n }, readFeatures: [], sendPermission: false });
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
function metrics(probe, data) {
  const line = `P0_METRICS ${JSON.stringify({ probe, utc: new Date().toISOString(), node: process.version, platform: process.platform, ...data })}\n`;
  process.stdout.write(line);
  if (process.env.AION_P0_METRICS_FILE) { try { fs.appendFileSync(process.env.AION_P0_METRICS_FILE, line); } catch { /* best effort */ } }
}
function fakeSession(id) {
  const url = `${ORIGIN}/chat?chatID=4a945005-1c2d-4e3f-8a9b-0c1d2e3f4a5b`;
  const turns = [
    { index: 0, domId: 'div.bubble[data-role=user]', role: 'user', roleAttribute: 'data-role', text: 'prompt text' },
    { index: 1, domId: 'div.bubble[data-role=assistant]', role: 'assistant', roleAttribute: 'data-role', text: 'reply text' },
  ];
  const kv = new Map(Object.entries({ DOM_TURNS: turns, ASSEMBLED: { a: { endpoint: 'POST /api/chat' } }, RECEIPT: { pageUrl: url } }));
  return { id, kv: { get: (k, d) => (kv.has(k) ? kv.get(k) : d) }, meta: { target: { url } } };
}
async function confirmDead(pid, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { process.kill(pid, 0); } catch (e) { if (e.code === 'ESRCH') return true; }
    await sleepMs(50);
  }
  return false;
}
// OS handle count of ANOTHER process (the worker), sampled from outside; null when the OS cannot tell us.
function handleCount(pid) {
  if (!IS_WIN) return null;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid}).HandleCount`], { encoding: 'utf8', timeout: 30000 });
  const n = Number(String(r.stdout ?? '').trim());
  return Number.isInteger(n) && n > 0 ? n : null;
}

function spawnWorker(t, mode, cfg, { onEvent } = {}) {
  const child = spawn(process.execPath, [WORKER, mode, JSON.stringify(cfg)], { stdio: ['ignore', 'pipe', 'pipe'] });
  const events = []; const waiters = []; let buf = ''; let stderr = '';
  child.stdout.on('data', (d) => {
    buf += d; let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      let ev; try { ev = JSON.parse(line); } catch { ev = { event: 'raw', line }; }
      events.push(ev); onEvent?.(ev, child);
      for (const w of waiters.slice()) w(ev);
    }
  });
  child.stderr.on('data', (d) => { stderr += d; });
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  const killer = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, cfg.killAfterMs ?? 240000);
  t.after(() => { clearTimeout(killer); if (child.exitCode === null) child.kill('SIGKILL'); });
  const waitEvent = (name, ms = 90000) => new Promise((resolve, reject) => {
    const found = events.find((e) => e.event === name);
    if (found) return resolve(found);
    const to = setTimeout(() => reject(new Error(`timeout waiting for "${name}" from ${mode}; stderr=${stderr.slice(0, 400)}`)), ms);
    const w = (ev) => { if (ev.event === name) { clearTimeout(to); waiters.splice(waiters.indexOf(w), 1); resolve(ev); } };
    waiters.push(w);
  });
  return { child, events, waitEvent, exited, stderr: () => stderr };
}

// Start N workers, wait until all are ready, release them together, collect their `result` events.
async function runBarrier(t, ackDir, configs, mode = 'race') {
  fs.mkdirSync(ackDir, { recursive: true });
  const ws = configs.map((c) => spawnWorker(t, mode, { ...c, ackDir }));
  await Promise.all(ws.map((w) => w.waitEvent('ready')));
  fs.writeFileSync(path.join(ackDir, 'go.json'), JSON.stringify({ startAt: Date.now() + 400 }));
  const results = await Promise.all(ws.map((w) => w.waitEvent('result')));
  const exits = await Promise.all(ws.map((w) => w.exited));
  return { results, exits, workers: ws };
}
const tally = (results) => {
  const by = {};
  for (const r of results) { const k = r.ok ? 'OK' : r.code; by[k] = (by[k] ?? 0) + 1; }
  return by;
};

// ============================================================================================ 1000 committed operations
test('P0 probe: 1000 COMMITTED operations keep OS handles and descriptors stable (worker PID sampled from outside after warmup)', { timeout: 420000 }, async (t) => {
  const root = tmp(t); const dir = path.join(root, 'store'); const ackDir = path.join(root, 'ack');
  fs.mkdirSync(ackDir, { recursive: true });
  const samples = [];
  const w = spawnWorker(t, 'ops', { dir, ackDir, total: 1000, warmup: 50, checkpointEvery: 250 }, {
    onEvent: (ev, child) => {
      if (ev.event !== 'checkpoint') return;
      const handles = [handleCount(child.pid), handleCount(child.pid), handleCount(child.pid)];
      samples.push({ n: ev.n, committed: ev.committed, handles, handleMax: handles.every((h) => h !== null) ? Math.max(...handles) : null, fd: ev.fd, locks: ev.locks });
      fs.writeFileSync(path.join(ackDir, `ack-${ev.n}`), '1');
    },
  });
  const done = await w.waitEvent('done', 400000);
  const exit = await w.exited;
  assert.equal(exit.code, 0, `worker exit: ${JSON.stringify(exit)} stderr=${w.stderr().slice(0, 300)}`);
  assert.equal(done.committed, 1000, 'exactly 1000 committed mutations (conflicts are not counted)');
  assert.equal(done.directVersions, 500); assert.equal(done.directCurrent, 500);
  assert.deepEqual(done.scopeVersions, [500]);
  assert.equal(done.fd.opens, done.fd.closes, `descriptor accounting: opens=${done.fd.opens} closes=${done.fd.closes}`);
  assert.equal(done.fd.openNow, 0); assert.equal(done.locks, 0);
  for (const s of samples) { assert.equal(s.fd.opens, s.fd.closes, `fd balance at checkpoint ${s.n}`); assert.equal(s.fd.openNow, 0); assert.equal(s.locks, 0); }
  assert.deepEqual(lockFiles(dir), []);
  assert.deepEqual(samples.map((s) => s.n), [50, 300, 550, 800, 1000]);
  const baseline = samples[0].handleMax;
  const deltas = samples.map((s) => (s.handleMax === null ? null : s.handleMax - baseline));
  if (IS_WIN) {
    for (const s of samples) assert.ok(s.handleMax !== null, `OS HandleCount sampled at n=${s.n}`);
    // A one-descriptor-per-operation leak would add ~950 by the end. Allow small allocator/GC/ETW jitter, and say so in the metrics.
    const worst = Math.max(...deltas);
    assert.ok(worst <= 12, `OS handle growth after warmup must stay within jitter (worst delta ${worst}, baseline ${baseline}, samples ${JSON.stringify(samples.map((s) => s.handles))})`);
  }
  metrics('handles-1000-committed', { total: done.committed, ms: done.ms, baselineHandleCount: baseline, samples: samples.map((s) => ({ n: s.n, handles: s.handles, max: s.handleMax, fd: s.fd })), deltasFromBaseline: deltas,
    maxDelta: IS_WIN ? Math.max(...deltas) : null, jitterToleranceAssertedAtMost: 12, finalFd: done.fd, note: 'tolerance is jitter, not a claim of exactly zero; a per-operation leak would be ~+950' });
});

// ============================================================================================ real killed holder
test('P0 probe: a child holds a REAL lock (after flush+close), is killed; stale lock is refused, wrong token refused, confirmed-dead recovery works', { timeout: 120000 }, async (t) => {
  const root = tmp(t); const dir = path.join(root, 'store'); const ackDir = path.join(root, 'ack');
  fs.mkdirSync(ackDir, { recursive: true });
  const h = spawnWorker(t, 'hold', { dir, name: 'held', ackDir });
  const holding = await h.waitEvent('holding');
  const parent = new VersionedStore(dir, { kind: 'learned adapter', lockWaitMs: 0 });
  // the lock the child holds was produced by the production owner: written, fsynced and closed before the critical section
  const lockPath = parent.lockPath('held');
  const raw = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  assert.equal(raw.schema, STORE_LOCK_SCHEMA); assert.equal(raw.pid, h.child.pid); assert.equal(raw.name, 'held'); assert.equal(raw.op, 'compareAndSave'); assert.match(raw.token, /^[0-9a-f]{32}$/);
  assert.equal(holding.fd.openNow, 0, 'at the pause point every descriptor is already closed: the lock is held by file existence, not by an open handle');
  const alive = parent.inspectLock('held');
  assert.equal(alive.present, true); assert.equal(alive.pid, h.child.pid); assert.equal(alive.pidAlive, true);
  assert.equal(parent.current('held'), null, 'CURRENT not yet written');
  assert.ok(fs.existsSync(path.join(dir, 'held', 'v0001.json')), 'version file already durable (becomes an orphan)');
  // busy: live holder
  assert.equal(capture(() => parent.compareAndSave('held', { x: 1 }, { expectedVersion: null }))?.code, 'CAS_LOCKED');
  // kill and CONFIRM death before reasoning about stale state
  h.child.kill('SIGKILL');
  const exit = await h.exited;
  assert.equal(await confirmDead(h.child.pid), true, 'child process is really gone (ESRCH)');
  const dead = parent.inspectLock('held');
  assert.equal(dead.present, true, 'the lock survives the crash'); assert.equal(dead.pidAlive, false); assert.equal(dead.token, raw.token);
  // stale refusal: nothing steals or ages it out
  const before = fs.readFileSync(lockPath, 'utf8');
  assert.equal(capture(() => parent.compareAndSave('held', { x: 1 }, { expectedVersion: null }))?.code, 'CAS_LOCKED', 'stale lock is still refused');
  assert.equal(fs.readFileSync(lockPath, 'utf8'), before); assert.equal(parent.current('held'), null);
  // ownership-checked recovery
  const flipped = (raw.token[0] === '0' ? '1' : '0') + raw.token.slice(1);
  for (const bad of [undefined, 'zz', flipped, raw.token.toUpperCase() === raw.token ? 'a'.repeat(32) : raw.token.toUpperCase()]) {
    assert.equal(capture(() => parent.releaseStaleLock('held', bad === undefined ? undefined : { token: bad }))?.code, 'CAS_LOCK_TOKEN_MISMATCH', 'every wrong or malformed token must be refused');
  }
  assert.equal(fs.existsSync(lockPath), true, 'wrong tokens removed nothing');
  const rel = parent.releaseStaleLock('held', { token: dead.token });
  assert.equal(rel.released, true); assert.equal(rel.pid, h.child.pid);
  assert.equal(fs.existsSync(lockPath), false);
  const rec = parent.compareAndSave('held', { recovered: true }, { expectedVersion: null });
  assert.equal(rec.version, 2, 'the orphan v1 left by the crash is skipped, never overwritten');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'held', 'v0001.json'), 'utf8')).held, true);
  assert.deepEqual(lockFiles(dir), []);
  metrics('killed-holder-recovery', { holderPid: h.child.pid, exit, confirmedDead: true, lockBefore: { pidAlive: alive.pidAlive }, afterKill: { pidAlive: dead.pidAlive, refusedWith: 'CAS_LOCKED' },
    wrongTokenRefusals: 4, recoveredVersion: rec.version, orphanKept: true });
});

// ============================================================================================ shared owner paths + namespaces
test('P0 probe: factory, I1 and the raw owner share ONE .locks namespace across processes; namespaces refuse each other', { timeout: 180000 }, async (t) => {
  const root = tmp(t); const dir = path.join(root, 'learned-adapters'); const ackDir = path.join(root, 'ack');
  fs.mkdirSync(ackDir, { recursive: true });
  const scopeName = i1Name('scope-x');
  const a = spawnWorker(t, 'hold', { dir, name: 'fixture-chat', ackDir });
  const b = spawnWorker(t, 'hold', { dir, name: scopeName, ackDir });
  await Promise.all([a.waitEvent('holding'), b.waitEvent('holding')]);
  const owner = new VersionedStore(dir, { kind: 'learned adapter', lockWaitMs: 0 });
  const factory = createAdapterFactory({ learnedStore: owner });
  const cas = createCasVersionedStore({ store: owner });
  const { candidate } = factory.synthesize({ siteId: 'fixture-chat', origin: ORIGIN, sessions: [fakeSession('t1'), fakeSession('t2'), fakeSession('t3')] });
  const promote = () => factory.promote({ candidate, sessions: [fakeSession('h1')], expectedVersion: null });
  // two different processes hold two locks in the one shared directory
  assert.deepEqual(lockFiles(dir), [`${scopeName}.lock`, 'fixture-chat.lock'].sort());
  // factory entry, legacy save entry and the direct owner entry all hit the SAME lock
  assert.equal(capture(promote)?.code, 'CAS_LOCKED', 'factory promote is blocked by a lock another process holds');
  assert.equal(capture(() => owner.save('fixture-chat', { x: 1 }))?.code, 'CAS_LOCKED', 'legacy save blocked by the same lock');
  assert.equal(capture(() => owner.compareAndRollback('fixture-chat', 1, { expectedVersion: 1 }))?.code, 'CAS_LOCKED');
  assert.equal((await captureAsync(() => cas.promote('scope-x', ro(1), null)))?.code, 'CAS_LOCKED', 'I1 promote blocked by the I1-name lock held by another process');
  // locks are per name: an unrelated I1 scope is not blocked
  assert.equal((await cas.promote('scope-other', ro(1), null)).version, 1);
  // namespace refusals (no fake same-name contest between the disjoint namespaces)
  const reserved = capture(() => factory.promote({ candidate: { ...candidate, siteId: scopeName }, sessions: [fakeSession('h1')], expectedVersion: null }));
  assert.ok(reserved instanceof AdapterFactoryError && reserved.code === 'RESERVED_NAMESPACE');
  const reservedRb = capture(() => factory.rollback(scopeName, 1, { expectedVersion: 1 }));
  assert.ok(reservedRb instanceof AdapterFactoryError && reservedRb.code === 'RESERVED_NAMESPACE');
  assert.equal(factory.loadLearned(scopeName), null);
  // crash both holders, confirm death, recover each by token, then every entry proceeds
  for (const h of [a, b]) { h.child.kill('SIGKILL'); await h.exited; assert.equal(await confirmDead(h.child.pid), true); }
  for (const name of ['fixture-chat', scopeName]) {
    const info = owner.inspectLock(name);
    assert.equal(info.pidAlive, false);
    assert.equal(capture(() => owner.releaseStaleLock(name, { token: 'a'.repeat(32) }))?.code, 'CAS_LOCK_TOKEN_MISMATCH');
    assert.equal(owner.releaseStaleLock(name, { token: info.token }).released, true);
  }
  assert.deepEqual(lockFiles(dir), []);
  assert.equal(promote().version, 2, 'factory proceeds after recovery; the crash orphan v1 is skipped');
  assert.equal((await cas.promote('scope-x', ro(2), null)).version, 2);
  assert.deepEqual(factory.list().map((x) => x.name), ['fixture-chat'], 'I1 names are not factory entries');
  assert.ok(owner.names().includes(scopeName) && owner.names().includes(i1Name('scope-other')));
  metrics('shared-owner-paths', { sharedLocksDuringHold: 2, blockedEntries: ['factory.promote', 'owner.save', 'owner.compareAndRollback', 'i1.promote'], unrelatedScopeNotBlocked: true,
    namespaceRefusals: ['RESERVED_NAMESPACE(promote)', 'RESERVED_NAMESPACE(rollback)'], recovered: true });
});

// ============================================================================================ barrier races, per entry
for (const entry of ['store', 'factory', 'i1']) {
  test(`P0 probe: ${entry} entry - 4 processes race a first-create behind a barrier: exactly one winner, losers classified, final version 1`, { timeout: 150000 }, async (t) => {
    const root = tmp(t); const dir = path.join(root, 'learned-adapters'); const ackDir = path.join(root, 'ack');
    const name = entry === 'i1' ? i1Name('scope-race') : 'race-name';
    const configs = [1, 2, 3, 4].map((id) => ({ dir, entry, id, name: entry === 'i1' ? undefined : name, scope: 'scope-race', lockWaitMs: 800 }));
    const { results, exits } = await runBarrier(t, ackDir, configs);
    for (const e of exits) assert.equal(e.code, 0);
    const by = tally(results);
    const ok = results.filter((r) => r.ok);
    const conflicts = results.filter((r) => r.code === 'CAS_VERSION_CONFLICT');
    const busy = results.filter((r) => r.code === 'CAS_LOCKED');
    assert.equal(ok.length, 1, `exactly one winner (${JSON.stringify(by)})`);
    assert.equal(ok.length + conflicts.length + busy.length, 4, `every loser is a conflict or a busy refusal, nothing else (${JSON.stringify(by)})`);
    for (const c of conflicts) { assert.equal(c.expected, null); assert.equal(c.actual, 1); }
    const verify = new VersionedStore(dir, { kind: 'learned adapter' });
    assert.equal(verify.current(name), 1); assert.equal(verify.versions(name).length, 1);
    assert.deepEqual(lockFiles(dir), []);
    for (const r of results) { assert.equal(r.fd.opens, r.fd.closes); assert.equal(r.fd.openNow, 0); }
    metrics(`race-${entry}`, { processes: 4, winners: ok.length, conflicts: conflicts.length, busy: busy.length, outcomes: by, ms: results.map((r) => r.ms), finalVersion: 1 });
  });
}

// ============================================================================================ busy vs stale vs conflict, counted separately
test('P0 probe: live holder => CAS_LOCKED (busy); dead holder => CAS_LOCKED (stale); after token recovery exactly one winner and the rest CAS_VERSION_CONFLICT', { timeout: 180000 }, async (t) => {
  const root = tmp(t); const dir = path.join(root, 'store'); const ackDir = path.join(root, 'ack');
  fs.mkdirSync(ackDir, { recursive: true });
  const h = spawnWorker(t, 'hold', { dir, name: 'contended', ackDir });
  await h.waitEvent('holding');
  const mkCfgs = (tag, n, extra = {}) => Array.from({ length: n }, (_, i) => ({ dir, entry: 'store', name: 'contended', id: `${tag}${i}`, lockWaitMs: 0, ...extra }));
  const busyRun = await runBarrier(t, path.join(root, 'ack-busy'), mkCfgs('busy', 3));
  const busyBy = tally(busyRun.results);
  assert.deepEqual(busyBy, { CAS_LOCKED: 3 }, `while the holder is alive every attempt is refused as busy (${JSON.stringify(busyBy)})`);
  h.child.kill('SIGKILL'); await h.exited; assert.equal(await confirmDead(h.child.pid), true);
  const staleRun = await runBarrier(t, path.join(root, 'ack-stale'), mkCfgs('stale', 3));
  const staleBy = tally(staleRun.results);
  assert.deepEqual(staleBy, { CAS_LOCKED: 3 }, `a dead holder's lock is still refused (stale), never stolen (${JSON.stringify(staleBy)})`);
  const owner = new VersionedStore(dir, { kind: 'learned adapter', lockWaitMs: 0 });
  const info = owner.inspectLock('contended');
  assert.equal(info.pidAlive, false);
  assert.equal(owner.releaseStaleLock('contended', { token: info.token }).released, true);
  const raceRun = await runBarrier(t, path.join(root, 'ack-race'), mkCfgs('race', 4, { lockWaitMs: 800 }));
  const raceBy = tally(raceRun.results);
  const winners = raceRun.results.filter((r) => r.ok);
  assert.equal(winners.length, 1, JSON.stringify(raceBy));
  assert.equal(winners[0].version, 2, 'the orphan v1 from the crash is skipped');
  assert.equal(raceRun.results.filter((r) => r.code === 'CAS_VERSION_CONFLICT').length + raceRun.results.filter((r) => r.code === 'CAS_LOCKED').length, 3);
  assert.equal(owner.current('contended'), 2);
  assert.deepEqual(lockFiles(dir), []);
  metrics('busy-stale-conflict', { busy: busyBy, stale: staleBy, afterRecovery: raceBy, winnerVersion: winners[0].version, classifiedSeparately: true });
});

// ============================================================================================ cross-entry contention on one name
test('P0 probe: legacy save() and compareAndSave() processes contend on ONE name: no lost, duplicated or torn versions', { timeout: 240000 }, async (t) => {
  const root = tmp(t); const dir = path.join(root, 'store'); const ackDir = path.join(root, 'ack');
  const K = 15;
  const configs = [...[1, 2, 3].map((n) => ({ entry: 'save', id: `s${n}` })), ...[1, 2, 3].map((n) => ({ entry: 'cas', id: `c${n}` }))]
    .map((c) => ({ ...c, dir, name: 'shared', iterations: K, lockWaitMs: 8000 }));
  const { results, exits } = await runBarrier(t, ackDir, configs, 'loop');
  for (const e of exits) assert.equal(e.code, 0);
  const totals = results.reduce((a, r) => ({ ok: a.ok + r.counts.ok, conflict: a.conflict + r.counts.conflict, locked: a.locked + r.counts.locked, other: a.other + r.counts.other }), { ok: 0, conflict: 0, locked: 0, other: 0 });
  const others = results.map((r) => r.others);
  assert.equal(totals.other, 0, `no EPERM/ENOENT/torn-read class errors: ${JSON.stringify(others)}`);
  assert.equal(totals.ok + totals.conflict + totals.locked, 6 * K, 'every attempt is accounted for');
  const files = fs.readdirSync(path.join(dir, 'shared')).filter((f) => /^v\d{4}\.json$/.test(f)).sort();
  assert.equal(files.length, totals.ok, 'one version file per successful operation: nothing lost, nothing duplicated');
  const written = results.flatMap((r) => r.written);
  assert.equal(new Set(written.map((w) => w.version)).size, written.length, 'no two successes share a version number');
  for (const w of written) {
    const rec = JSON.parse(fs.readFileSync(path.join(dir, 'shared', `v${String(w.version).padStart(4, '0')}.json`), 'utf8'));
    assert.equal(rec.w, w.w); assert.equal(rec.i, w.i); assert.equal(rec.version, w.version);
  }
  const store = new VersionedStore(dir, { kind: 'learned adapter' });
  assert.equal(store.current('shared'), Math.max(...written.map((w) => w.version)));
  assert.deepEqual(lockFiles(dir), []);
  metrics('cross-entry-contention', { processes: 6, attemptsEach: K, totals, versionFilesOnDisk: files.length, current: store.current('shared'), lostUpdates: totals.ok - files.length });
});

// ============================================================================================ fault matrix + primary/committed integrity
function spyIo(hooks = {}) {
  const open = new Set(); const fdPath = new Map(); const c = { opens: 0, closes: 0 };
  const io = {
    openSync(p, flags, mode) { const fd = fs.openSync(p, flags, mode); open.add(fd); fdPath.set(fd, String(p)); c.opens++; return fd; },
    writeFileSync(f, d, o) { hooks.write?.(typeof f === 'number' ? fdPath.get(f) : String(f)); return fs.writeFileSync(f, d, o); },
    fsyncSync(fd) { hooks.fsync?.(fdPath.get(fd)); return fs.fsyncSync(fd); },
    closeSync(fd) { const p = fdPath.get(fd); c.closes++; try { fs.closeSync(fd); } finally { open.delete(fd); } hooks.close?.(p); },
    renameSync(a, b) { hooks.rename?.(String(a), String(b)); return fs.renameSync(a, b); },
    unlinkSync(p) { hooks.unlink?.(String(p)); return fs.unlinkSync(p); },
  };
  return { io, open, counts: () => ({ ...c, openNow: open.size }) };
}
test('P0 probe: write/fsync/close/unlink faults on the real owner: primary error preserved, descriptors balanced, no lock residue, committed facts exact', (t) => {
  const targets = { lock: (p) => /\.lock$/.test(p ?? ''), version: (p) => /v\d{4}\.json$/.test(p ?? ''), 'CURRENT temp': (p) => /CURRENT\.[0-9a-f]+\.tmp$/.test(p ?? '') };
  const rows = [];
  for (const [label, match] of Object.entries(targets)) {
    for (const stage of ['write', 'fsync', 'close']) {
      const dir = path.join(tmp(t), 's');
      const err = Object.assign(new Error(`injected ${stage}`), { code: 'EIO', injected: true });
      const spy = spyIo({ [stage]: (p) => { if (match(p)) throw err; } });
      const s = new VersionedStore(dir, { kind: 'probe', io: spy.io, lockWaitMs: 0 });
      const e = capture(() => s.compareAndSave('n', { v: 1 }, { expectedVersion: null }));
      const c = spy.counts();
      assert.equal(e, err, `${label}/${stage}: the injected error itself`);
      assert.equal(c.opens, c.closes, `${label}/${stage}: opens=${c.opens} closes=${c.closes}`);
      assert.equal(c.openNow, 0);
      assert.deepEqual(lockFiles(dir), []);
      assert.equal(new VersionedStore(dir, { kind: 'probe' }).current('n'), null, 'no pointer was published');
      rows.push({ target: label, stage, opens: c.opens, closes: c.closes, openNow: c.openNow, primaryPreserved: e === err, lockResidue: 0 });
    }
  }
  // unlink faults on the lock: (a) the critical section already failed -> primary kept; (b) it committed -> committed facts exact
  const dirA = path.join(tmp(t), 's');
  new VersionedStore(dirA, { kind: 'probe' }).compareAndSave('n', { v: 1 }, { expectedVersion: null });
  const spyA = spyIo({ unlink: (p) => { if (/\.lock$/.test(p)) throw Object.assign(new Error('injected unlink'), { code: 'EPERM' }); } });
  const conflict = capture(() => new VersionedStore(dirA, { kind: 'probe', io: spyA.io, lockWaitMs: 0 }).compareAndSave('n', { v: 2 }, { expectedVersion: null }));
  assert.equal(conflict?.code, 'CAS_VERSION_CONFLICT'); assert.equal(conflict.releaseError?.code, 'CAS_LOCK_RELEASE_UNVERIFIED'); assert.equal(conflict.committed, undefined);
  const dirB = path.join(tmp(t), 's');
  const spyB = spyIo({ unlink: (p) => { if (/\.lock$/.test(p)) throw Object.assign(new Error('injected unlink'), { code: 'EPERM' }); } });
  const committed = capture(() => new VersionedStore(dirB, { kind: 'probe', io: spyB.io, lockWaitMs: 0 }).compareAndSave('n', { v: 1 }, { expectedVersion: null }));
  assert.equal(committed?.code, 'CAS_LOCK_RELEASE_UNVERIFIED'); assert.equal(committed.committed, true); assert.equal(committed.committedVersion, 1);
  assert.equal(new VersionedStore(dirB, { kind: 'probe' }).current('n'), 1, 'the committed change is durable');
  const cb = spyB.counts(); assert.equal(cb.opens, cb.closes); assert.equal(cb.openNow, 0);
  metrics('fault-matrix', { rows, primaryOverConflict: { code: conflict.code, releaseError: conflict.releaseError.code },
    committedOnUnlinkFault: { code: committed.code, committed: committed.committed, committedVersion: committed.committedVersion, fd: cb } });
});
