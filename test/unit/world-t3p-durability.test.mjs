// Sprint gate L2 / tier T3p: a TWO-INDEPENDENT-OS-PROCESS durability proof for the offline personal world.
//
// What this proves (and what it does not):
//   process A (real Studio, real HTTP, port 0) performs the four durable edit types + one link, then exits;
//   process B is a SEPARATE `node` process on the SAME data root, and asserts from scratch that
//     * the project/note/object/selection ids AND versions survived the process boundary (3/2/1/1);
//     * the captured source evidence is byte-identical: raw DOM_TURNS.json bytes (H0) and the canonical
//       DOM_TURNS digest (D0, src/capture/acceptance.mjs) did not move, and sessions/** has the same tree hash;
//     * a cross-process stale expectedVersion is refused (HTTP 409 CAS_VERSION_CONFLICT) and writes nothing;
//     * an interrupted save cannot corrupt committed state: a torn commit (version file written, CURRENT rename
//       failed) leaves CURRENT on the old version with an unreachable orphan, and a REAL holder process killed
//       mid-critical-section leaves a stale lock that is refused as HTTP 423 until an operator releases it by
//       token; the identical body resubmitted after re-reading the version commits EXACTLY once, and only then.
// What it does NOT claim: nothing about browsers, tabs or draft text surviving anything. "Draft retention" is
// deliberately expressed as the durable facts above, because tab/browser state cannot cross an OS process
// boundary and no UI claim is made here. No browser, no Chrome, no CDP, no provider, no network beyond loopback.
//
// Format markers read from the product code, not re-implemented here:
//   src/config.mjs:18,32 dataPaths/ensureDataDirs   src/store/session.mjs:143 Session.create/open
//   src/capture/acceptance.mjs:50 domDigest        src/store/integrity.mjs:22-69 canonicalJson/sha256Hex
//   src/studio/server.mjs:72 startStudio, :461 close   src/studio/world-service.mjs:174-191 routes
//   src/store/versioned.mjs:290-302 CURRENT rename (io seam :76-83), :225 CAS_LOCKED, :365 inspectLock, :380 releaseStaleLock
//   src/studio/http.mjs:7-23 STORE_ERROR_STATUS (CAS_VERSION_CONFLICT 409, CAS_LOCKED 423) + storeFields operands
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Session } from '../../src/store/session.mjs';
import { domDigest } from '../../src/capture/acceptance.mjs';
import { sha256Hex } from '../../src/store/integrity.mjs';
import { VersionedStore } from '../../src/store/versioned.mjs';
import { dataPaths, ensureDataDirs } from '../../src/config.mjs';

const WORKER = fileURLToPath(new URL('./fixtures/t3p-worker.mjs', import.meta.url));

function treeHash(dir) {
  const readBytes = (p) => { try { return fs.readFileSync(p); } catch { return Buffer.alloc(0); } };
  const files = [];
  const walk = (d, rel) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else files.push([r, readBytes(path.join(d, e.name))]);
    }
  };
  walk(dir, '');
  const h = [];
  for (const [rel, bytes] of files) h.push(`${rel}:${sha256Hex(bytes)}`);
  return { hash: sha256Hex(h.join('\n')), files: files.length };
}

function spawnWorker(t, mode, cfg, { timeoutMs = 170000, onEvent } = {}) {
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
  const killer = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, timeoutMs);
  t.after(() => { clearTimeout(killer); if (child.exitCode === null) child.kill('SIGKILL'); });
  const waitEvent = (name, ms = timeoutMs) => new Promise((resolve, reject) => {
    const found = events.find((e) => e.event === name);
    if (found) return resolve(found);
    const failure = events.find((e) => e.event === 'fail');
    if (failure) return reject(new Error(`worker ${mode} failed: ${failure.message}`));
    const to = setTimeout(() => reject(new Error(`timeout waiting for "${name}" from ${mode}; stderr=${stderr.slice(0, 600)}`)), ms);
    waiters.push((ev) => {
      if (ev.event === 'fail') { clearTimeout(to); reject(new Error(`worker ${mode} failed: ${ev.message}`)); }
      else if (ev.event === name) { clearTimeout(to); resolve(ev); }
    });
  });
  return { child, events, waitEvent, exited, stderr: () => stderr };
}

test('T3p: four durable edit types + interrupted saves survive a two-independent-OS-process restart while DOM_TURNS stays byte-identical', { timeout: 180000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aion-t3p-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = ensureDataDirs(dataPaths(root));

  // ---- setup (PARENT): one saved capture session with a user turn and an opaque/unknown assistant block.
  // DOM_TURNS is written only by src/capture/recorder.mjs:790 during capture, so it is seeded directly here
  // (the capture path is deliberately not started: no browser, no CDP).
  const session = Session.create(paths.sessions, { site: 'fixture' });
  session.meta.status = 'complete';
  session.saveMeta();
  session.kv.set('DOM_TURNS', [
    { id: 't3p-turn-0', role: 'user', text: 'question that must never be rewritten', blocks: [{ type: 'text', text: 'ask the topic' }] },
    { id: 't3p-turn-1', role: 'assistant', text: 'answer that must never be rewritten', blocks: [{ type: 'future-native', opaque: { x: 1 } }] },
  ]);
  const sid = session.id;
  const turnsFile = path.join(paths.sessions, sid, 'kv', 'DOM_TURNS.json');
  const H0 = sha256Hex(fs.readFileSync(turnsFile));
  const D0 = domDigest(Session.open(paths.sessions, sid));
  const sessionsHash = treeHash(paths.sessions).hash;
  const expectedConversationId = 'c-' + createHash('sha256').update(sid).digest('hex').slice(0, 40);

  // ---- PROCESS A: real Studio, real HTTP, real commits, then exit.
  const a = spawnWorker(t, 'edits', { root, sid });
  const aResult = await a.waitEvent('result');
  const aExit = await a.exited;
  const aFail = a.events.find((e) => e.event === 'fail');
  assert.equal(aFail, undefined, `process A reported a failure: ${JSON.stringify(aFail ?? {})} stderr=${a.stderr().slice(0, 600)}`);
  assert.equal(aExit.code, 0, `process A must exit 0: ${JSON.stringify(aExit)} stderr=${a.stderr().slice(0, 600)}`);
  assert.equal(aResult.ok, true);
  assert.equal(aResult.conversationId, expectedConversationId, 'the saved conversation id is the source-derived one');
  assert.match(aResult.namespaceId, /^w-[0-9a-f-]{36}$/, 'process A minted the world namespace');
  assert.deepEqual(
    { project: aResult.items.project.version, note: aResult.items.note.version, object: aResult.items.object.version, selection: aResult.items.selection.version },
    { project: 3, note: 2, object: 1, selection: 1 },
    'process A committed 4 edit types (project v3 after create+edit+link, note v2, object v1, selection v1)',
  );
  assert.match(aResult.items.project.id, /^p-[a-z0-9-]{1,60}$/);
  assert.match(aResult.items.note.id, /^n-[a-z0-9-]{1,60}$/);
  assert.match(aResult.items.object.id, /^o-[a-z0-9-]{1,60}$/);
  assert.match(aResult.items.selection.id, /^s-[a-z0-9-]{1,60}$/);

  // ---- PROCESS B: a SEPARATE OS process on the same root asserts all durability properties itself.
  const b = spawnWorker(t, 'verify', {
    root, sid, aPid: aResult.pid,
    expect: {
      conversationId: aResult.conversationId,
      namespaceId: aResult.namespaceId,
      items: aResult.items,
      versions: { project: 3, note: 2, object: 1, selection: 1 },
      H0, D0, sessionsHash,
    },
  });
  const bResult = await b.waitEvent('result');
  const bExit = await b.exited;
  const bFail = b.events.find((e) => e.event === 'fail');
  assert.equal(bFail, undefined, `process B reported a failure: ${JSON.stringify(bFail ?? {})}`);
  assert.equal(bExit.code, 0, `process B must exit 0: ${JSON.stringify(bExit)} stderr=${b.stderr().slice(0, 600)}`);
  assert.equal(bResult.ok, true);

  // ---- distinct OS processes, all exited
  const pids = [aResult.pid, bResult.pid, bResult.killed.holderPid];
  assert.equal(new Set(pids).size, 3, `three distinct OS processes: ${JSON.stringify(pids)}`);
  for (const pid of pids) assert.equal(Number.isInteger(pid) && pid > 0, true, `recorded pid ${pid}`);
  assert.equal(aExit.code, 0); assert.equal(bExit.code, 0);
  assert.notEqual(bResult.killed.holderExit.code, 0, `the holder did not exit on its own: ${JSON.stringify(bResult.killed.holderExit)}`);

  // ---- ids and versions reproduced from scratch by process B
  assert.deepEqual(bResult.items, aResult.items, 'process B read back the same ids and versions');
  assert.equal(bResult.items.project.version, 3);
  assert.equal(bResult.items.note.version, 2);
  assert.equal(bResult.items.object.version, 1);
  assert.equal(bResult.items.selection.version, 1);
  assert.equal(bResult.namespaceId, aResult.namespaceId, 'the world namespace is the same record across processes');

  // ---- source evidence untouched (raw bytes AND canonical digest)
  assert.equal(bResult.hashesBefore.bytes, H0, 'DOM_TURNS.json raw bytes are identical after the restart');
  assert.equal(bResult.hashesBefore.digest, D0, 'canonical DOM_TURNS digest is identical after the restart');
  assert.equal(bResult.hashesAfter.bytes, H0, 'DOM_TURNS.json raw bytes survived every durability scenario');
  assert.equal(bResult.hashesAfter.digest, D0, 'canonical DOM_TURNS digest survived every durability scenario');
  assert.equal(bResult.sessionsScope.hash, sessionsHash, 'sessions/** is byte-identical across the process boundary');
  assert.equal(bResult.sessionsScopeAfter.hash, sessionsHash, 'sessions/** is still byte-identical at the end');

  // ---- cross-process CAS refusal (409 + operands), nothing written
  assert.deepEqual(bResult.casStale.project, { status: 409, code: 'CAS_VERSION_CONFLICT', expected: 2, actual: 3 });
  assert.deepEqual(bResult.casStale.note, { status: 409, code: 'CAS_VERSION_CONFLICT', expected: 1, actual: 2 });

  // ---- interrupted save (i): torn commit -> CURRENT unchanged, orphan unreachable, numbering skips it
  assert.equal(bResult.torn.errorCode, 'EBUSY');
  assert.equal(bResult.torn.current, 3, 'a torn commit never moves CURRENT');
  assert.equal(bResult.torn.orphanVersion, 4, 'the version file written before the failed CURRENT rename is v0004');
  assert.equal(bResult.torn.orphanExists, true);
  assert.equal(bResult.torn.tmpResidue, 0);
  assert.deepEqual(bResult.torn.locks, [], 'a failed commit leaves no lock');
  assert.equal(bResult.transientRetry.attempts, 2, 'a single EBUSY is retried once by the owner (it cannot tear)');

  // ---- interrupted save (ii): real killed holder -> 423 while alive AND after death (stale, never stolen)
  assert.equal(bResult.killed.confirmedDead, true);
  assert.deepEqual(bResult.killed.busyWhileHolding, { status: 423, code: 'CAS_LOCKED' });
  assert.deepEqual(bResult.killed.staleAfterDeath, { status: 423, code: 'CAS_LOCKED' });
  assert.equal(bResult.killed.pidAlive, false, 'inspectLock reports the killed pid as dead');
  assert.equal(bResult.killed.wrongTokenCode, 'CAS_LOCK_TOKEN_MISMATCH', 'only the recorded token releases the lock');
  assert.equal(bResult.killed.released, true);

  // ---- recovery: the same body re-read + resubmitted commits exactly once, skipping the two orphans
  assert.equal(bResult.recovery.freshVersion, 3);
  assert.equal(bResult.recovery.retryVersion, 6, 'recovery appends v6: v4 (torn) and v5 (killed holder) are unreachable orphans');
  assert.match(JSON.stringify(bResult.recovery.versionFiles), /v0004\.json.*v0005\.json.*v0006\.json/, 'both orphans stay on disk with their commits');
  assert.deepEqual(bResult.recovery.repeat, { status: 409, code: 'CAS_VERSION_CONFLICT', expected: 3, actual: 6 }, 'the identical body is accepted exactly once');
  assert.equal(bResult.finalVersions.project, 6);
  assert.equal(bResult.finalVersions.note, 2);
  assert.equal(bResult.finalVersions.object, 1);
  assert.equal(bResult.finalVersions.selection, 1);
  assert.deepEqual(bResult.tmpResidue, { world: [], sessions: [] });
  assert.deepEqual(bResult.locksAfter, []);

  // ---- parent-side independent re-check after both children have exited
  assert.notEqual(aResult.pid, process.pid); assert.notEqual(bResult.pid, process.pid);
  assert.equal(sha256Hex(fs.readFileSync(turnsFile)), H0, 'parent re-read: DOM_TURNS.json bytes are still H0');
  assert.equal(domDigest(Session.open(paths.sessions, sid)), D0, 'parent re-read: canonical digest is still D0');
  assert.equal(treeHash(paths.sessions).hash, sessionsHash, 'parent re-read: sessions/** tree hash is unchanged');
  const world = new VersionedStore(path.join(root, 'world'), { kind: 'world item' });
  assert.equal(world.current(aResult.items.project.id), bResult.recovery.retryVersion, 'parent re-read: project CURRENT is the recovered commit');
  assert.equal(world.current(aResult.items.note.id), 2);
  assert.equal(world.current(aResult.items.object.id), 1);
  assert.equal(world.current(aResult.items.selection.id), 1);
  assert.equal(world.current('world-namespace'), 1, 'exactly one world namespace, minted by process A');
  assert.equal(world.load(aResult.items.project.id).title, 'T3P project (recovered)');
  assert.equal(world.load(aResult.items.project.id, 4).title, 'torn commit body', 'v4 is readable only by explicit version, never by CURRENT');
  assert.equal(world.load(aResult.items.note.id).title, 'T3P note (edit 2)', 'the note edit survived the process boundary');

  const metrics = {
    probe: 't3p-two-process-durability', utc: new Date().toISOString(), node: process.version, platform: process.platform,
    pids: { parent: process.pid, a: aResult.pid, b: bResult.pid, holder: bResult.killed.holderPid },
    distinctProcesses: new Set(pids).size, versions: bResult.items, finalVersions: bResult.finalVersions,
    hashes: { H0_Before: H0, D0_Before: D0, H0_AfterB: bResult.hashesAfter.bytes, D0_AfterB: bResult.hashesAfter.digest, sessionsBefore: sessionsHash, sessionsAfter: bResult.sessionsScopeAfter.hash },
    cas: bResult.casStale, torn: bResult.torn, transientRetry: bResult.transientRetry, killed: bResult.killed, recovery: bResult.recovery,
    note: 'durable claims only; no tab/draft/browser state crossed a process boundary',
  };
  process.stdout.write(`T3P_METRICS ${JSON.stringify(metrics)}\n`);
});
