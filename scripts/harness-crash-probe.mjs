#!/usr/bin/env node
// Capture Studio — harness-run store crash / lock / cross-process recovery probe.
//
//   node scripts/harness-crash-probe.mjs [dataDir]
//
// Proves, with REAL child processes (no injected io faults):
//   P1  cross-process same-key contention: while process A's executor runs, a second
//       process sees the durable in_flight reservation and refuses with STEP_UNCERTAIN;
//       after A completes, the recorded outcome replays without re-execution.
//   P2  real SIGKILL mid-executor: after restart the step is still in_flight, the same
//       key is refused with STEP_UNCERTAIN, finish refuses with RUN_HAS_UNRESOLVED_EFFECT,
//       and the executor ran exactly once. No automatic replay, no key replacement.
//   P3  owner-verified stale-lock recovery: recoverAbandonedLock with the verified dead
//       pid releases ONLY the state-write lock; the run stays usable afterwards.
//
// This probe is the standing local test for Windows/NTFS lock and crash semantics too:
// run the same command on the owner machine and keep the console receipt.
// Exit code 0 = every invariant held; 1 = a named invariant failed.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHarnessRunStore } from '../src/capture/harness-runs.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.argv[2] ?? fs.mkdtempSync(path.join(os.tmpdir(), 'harness-crash-probe-'));
const runsDir = path.join(dataDir, 'harness-runs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(fn, what, timeoutMs = 15000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await sleep(50);
  }
  throw new Error(`timeout waiting for ${what}`);
}

// Child mode: one phase, one process, real fs, real exit.
if (process.env.PROBE_CHILD) {
  const phase = process.env.PROBE_CHILD;
  const executed = () => fs.appendFileSync(path.join(dataDir, 'executor-runs'), `${phase}\n`);
  const store = createHarnessRunStore({ dir: runsDir, toolExecutor: async () => {
    executed();
    if (phase === 'contention') await waitUntil(() => fs.existsSync(path.join(dataDir, 'release')), 'release marker', 30000);
    if (phase === 'crash') await waitUntil(() => fs.existsSync(path.join(dataDir, 'unreachable')), 'never marker', 30000);
    return { ok: true, phase };
  } });
  if (phase === 'contention' || phase === 'crash') {
    const run = store.create({ task: `probe ${phase}` });
    const pending = store.step(run.id, { key: 'effect-1', tool: 'read', args: { phase } }).catch((e) => ({ fencedError: e.code }));
    await waitUntil(() => { try { return store.get(run.id).steps.some((s) => s.status === 'in_flight'); } catch { return false; } }, 'in_flight claim', 10000);
    await waitUntil(() => fs.existsSync(path.join(dataDir, 'executor-runs')), 'executor entry', 10000);
    console.log(JSON.stringify({ child: phase, runId: run.id, pid: process.pid }));
    if (phase === 'contention') {
      const out = await pending;
      console.log(JSON.stringify({ child: 'contention-done', step: out.step?.status ?? null, fenced: out.fencedError ?? null }));
    }
    if (phase === 'crash') await sleep(60000); // parent SIGKILLs us here; exit code irrelevant
  }
  if (phase === 'noop') {
    const run = store.create({ task: 'probe dead pid' });
    console.log(JSON.stringify({ child: phase, runId: run.id, pid: process.pid }));
  }
  process.exit(0);
}

// Parent mode.
const failures = [];
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); if (!ok) failures.push(name); };
const spawnChild = (phase) => {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), dataDir], {
    env: { ...process.env, PROBE_CHILD: phase }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const handle = { child, phase, out: '', code: null, exitError: null,
    exited: new Promise((resolve) => child.on('exit', (code) => { handle.code = code; resolve(code); }).on('error', (e) => { handle.exitError = e; resolve(null); })) };
  child.stdout.on('data', (d) => { handle.out += d; });
  child.stderr.on('data', (d) => { handle.out += d; });
  return handle;
};
const awaitJson = async (handle, marker, timeoutMs = 30000) => waitUntil(() => {
  const line = handle.out.split('\n').filter((l) => l.includes(`"child":"${marker}"`)).at(-1);
  return line ? JSON.parse(line) : null;
}, `child json ${marker}`, timeoutMs);
const readRun = (id) => JSON.parse(fs.readFileSync(path.join(runsDir, `${id}.run.json`), 'utf8'));
const lockPathOf = (id) => `${path.join(runsDir, `${id}.run.json`)}.lock`;
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

console.log(`harness crash probe — data dir ${dataDir}`);

try {
  // P1 — cross-process same-key contention (child A vs this parent process).
  {
    fs.rmSync(path.join(dataDir, 'release'), { force: true });
    fs.rmSync(path.join(dataDir, 'executor-runs'), { force: true });
    const a = spawnChild('contention');
    const { runId } = await awaitJson(a, 'contention');
    await waitUntil(() => readRun(runId).steps.some((s) => s.key === 'effect-1' && s.status === 'in_flight'), 'P1 in_flight claim');
    const parent = createHarnessRunStore({ dir: runsDir, toolExecutor: async () => ({ ok: true }) });
    let bError = null;
    await parent.step(runId, { key: 'effect-1', tool: 'read', args: { phase: 'contention' } }).catch((e) => { bError = e; });
    check('P1 second process refused while first is in flight', bError?.code === 'STEP_UNCERTAIN', `code=${bError?.code ?? 'none'}`);
    check('P1 executor ran exactly once so far', (fs.readFileSync(path.join(dataDir, 'executor-runs'), 'utf8').match(/contention/g) ?? []).length === 1);
    fs.writeFileSync(path.join(dataDir, 'release'), '1');
    const done = await awaitJson(a, 'contention-done');
    await Promise.race([a.exited, waitUntil(() => false, 'child exit', 10000).catch(() => {})]);
    check('P1 first process completed its step after release', done?.step === 'succeeded' && readRun(runId).steps.at(-1)?.status === 'succeeded', `step=${done?.step ?? 'none'}`);
    const replay = await parent.step(runId, { key: 'effect-1', tool: 'read', args: { phase: 'contention' } });
    check('P1 completed step replays recorded outcome, no re-execution',
      replay.replayed === true && replay.step.status === 'succeeded'
      && (fs.readFileSync(path.join(dataDir, 'executor-runs'), 'utf8').match(/contention/g) ?? []).length === 1);
  }

  // P2 — real SIGKILL mid-executor, then restart semantics.
  {
    fs.rmSync(path.join(dataDir, 'executor-runs'), { force: true });
    const c = spawnChild('crash');
    const { runId, pid } = await awaitJson(c, 'crash');
    const lockPath = lockPathOf(runId);
    const hadLock = fs.existsSync(lockPath);
    process.kill(pid, 'SIGKILL');
    await waitUntil(() => !alive(pid), 'P2 child death', 10000);
    const store = createHarnessRunStore({ dir: runsDir, toolExecutor: async () => ({ ok: true }) });
    const run = store.get(runId);
    check('P2 step still in_flight after real process kill', run.steps.at(-1)?.status === 'in_flight', `status=${run.steps.at(-1)?.status}`);
    check('P2 executor ran exactly once before the kill', (fs.readFileSync(path.join(dataDir, 'executor-runs'), 'utf8').match(/crash/g) ?? []).length === 1);
    let retryError = null;
    await store.step(runId, { key: 'effect-1', tool: 'read', args: { phase: 'crash' } }).catch((e) => { retryError = e; });
    check('P2 same key refused with STEP_UNCERTAIN after restart', retryError?.code === 'STEP_UNCERTAIN', `code=${retryError?.code ?? 'none'}`);
    let finishError = null;
    try { store.finish(runId, { status: 'succeeded' }); } catch (e) { finishError = e; }
    check('P2 finish refused while the unresolved effect stands', finishError?.code === 'RUN_HAS_UNRESOLVED_EFFECT', `code=${finishError?.code ?? 'none'}`);
    check('P2 executor did not run again', !fs.existsSync(path.join(dataDir, 'executor-runs'))
      || (fs.readFileSync(path.join(dataDir, 'executor-runs'), 'utf8').match(/crash/g) ?? []).length === 1);
    if (hadLock && fs.existsSync(lockPath)) {
      const owner = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      const rec = store.recoverAbandonedLock(runId, { expectedPid: owner.pid });
      check('P2 owner-verified lock recovery releases only the lock', rec.released === true);
    } else {
      check('P2 no state-write lock left after an executor-phase kill', true, 'lock is released before the effect, as designed');
    }
  }

  // P3 — verified dead-pid stale lock recovery.
  {
    const d = spawnChild('noop');
    const { runId, pid } = await awaitJson(d, 'noop');
    await d.exited;
    await waitUntil(() => !alive(pid), 'P3 dead pid', 10000);
    fs.writeFileSync(lockPathOf(runId), `${JSON.stringify({ pid, at: 'probe' })}\n`);
    const store = createHarnessRunStore({ dir: runsDir, toolExecutor: async () => ({ ok: true }) });
    let mismatch = null;
    try { store.recoverAbandonedLock(runId, { expectedPid: process.pid }); } catch (e) { mismatch = e; }
    check('P3 wrong expected pid refused (LOCK_OWNER_MISMATCH)', mismatch?.code === 'LOCK_OWNER_MISMATCH', `code=${mismatch?.code ?? 'none'}`);
    let stillAlive = null;
    const live = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { windowsHide: true });
    fs.writeFileSync(lockPathOf(runId), `${JSON.stringify({ pid: live.pid, at: 'probe-live' })}\n`);
    try { store.recoverAbandonedLock(runId, { expectedPid: live.pid }); } catch (e) { stillAlive = e; }
    live.kill('SIGKILL');
    check('P3 living owner pid refused (LOCK_OWNER_STILL_ALIVE)', stillAlive?.code === 'LOCK_OWNER_STILL_ALIVE', `code=${stillAlive?.code ?? 'none'}`);
    fs.writeFileSync(lockPathOf(runId), `${JSON.stringify({ pid, at: 'probe' })}\n`); // restore the stale-owner scenario
    const rec = store.recoverAbandonedLock(runId, { expectedPid: pid });
    check('P3 verified dead-pid lock recovered', rec.released === true);
    const out = await store.step(runId, { key: 'after-recovery', tool: 'read', args: {} });
    check('P3 run usable after lock recovery', out.step.status === 'succeeded');
  }
} catch (e) {
  failures.push(`unexpected: ${e.message}`);
  console.log(`FAIL  unexpected — ${e.stack}`);
}

console.log(failures.length ? `\n${failures.length} invariant(s) FAILED: ${failures.join('; ')}` : '\nALL INVARIANTS HELD');
process.exit(failures.length ? 1 : 0);
