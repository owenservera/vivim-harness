// Child-process drivers for test/unit/world-t3p-durability.test.mjs (sprint gate L2 / tier T3p).
//
// Two INDEPENDENT OS processes share one disposable data root and prove that the world overlay is durable
// across the process boundary while the captured source evidence is untouched:
//   node t3p-worker.mjs edits  '<json>'   PROCESS A: real Studio on port 0, 4 durable edit types + link
//   node t3p-worker.mjs verify '<json>'   PROCESS B: separate process, same root, all durability assertions
//   node t3p-worker.mjs hold   '<json>'   lock holder spawned BY process B, killed by its parent
//
// Protocol: one JSON object per line on stdout (the parent parses them). Handshakes are file-free: the parent
// waits for the `result`/`holding` event. There is no copied lock, CAS or `io` logic here: the owner is
// src/store/versioned.mjs and only its documented `io` seam is used to inject faults (same precedent as
// test/unit/fixtures/p0-windows-worker.mjs). No browser, no CDP, no provider, no fixed port.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Session } from '../../../src/store/session.mjs';
import { domDigest } from '../../../src/capture/acceptance.mjs';
import { sha256Hex } from '../../../src/store/integrity.mjs';
import { VersionedStore } from '../../../src/store/versioned.mjs';
import { dataPaths, ensureDataDirs } from '../../../src/config.mjs';
import { startStudio } from '../../../src/studio/server.mjs';
import { ProfileStore } from '../../../src/profiles/profiles.mjs';

const SELF = fileURLToPath(import.meta.url);
const [, , mode, cfgJson] = process.argv;
const cfg = JSON.parse(cfgJson ?? '{}');
const sleepCell = new Int32Array(new SharedArrayBuffer(4));
const sleep = (ms) => { if (ms > 0) Atomics.wait(sleepCell, 0, 0, ms); };
const out = (o) => {
  const line = `${JSON.stringify({ pid: process.pid, ...o })}\n`;
  for (let i = 0; ; i++) { try { fs.writeSync(1, line); return; } catch (e) { if (e.code !== 'EAGAIN' || i > 2000) throw e; sleep(2); } }
};
function check(ok, message, detail) {
  if (ok) return;
  const err = new Error(`T3P_ASSERT ${message}${detail === undefined ? '' : ' :: ' + JSON.stringify(detail)}`);
  err.code = 'T3P_ASSERT';
  throw err;
}
const runtimeStub = () => ({ isSessionActive: () => false, close: async () => {}, list: async () => [] });
const ROUTES = { project: 'projects', note: 'notes', object: 'objects', selection: 'selections' };

function httpFor(port) {
  const base = `http://127.0.0.1:${port}/api/v1/world`;
  return async (method, url, body) => {
    const response = await fetch(base + url, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let data = null;
    try { data = await response.json(); } catch { data = null; }
    return { status: response.status, data };
  };
}

// Stable tree hash (relative POSIX paths + bytes) so a second process can prove nothing under a scope moved.
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
const residue = (dir, pattern) => {
  const hits = [];
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (pattern.test(e.name)) hits.push(path.relative(dir, p).replaceAll('\\', '/'));
    }
  };
  walk(dir);
  return hits.sort();
};

// ------------------------------------------------------------------------------------------------ edits (PROCESS A)
async function runEdits() {
  const paths = ensureDataDirs(dataPaths(cfg.root));
  const studio = await startStudio({ paths, profileStore: new ProfileStore(paths.profiles), port: 0, conversationRuntime: runtimeStub() });
  try {
    const call = httpFor(studio.port);
    // The saved session is listed by THIS process from the shared root (no second store, no re-seed).
    const conversations = await call('GET', '/conversations');
    check(conversations.status === 200, 'GET /world/conversations', conversations.status);
    const conversation = conversations.data.items.find((i) => i.sessionId === cfg.sid);
    check(!!conversation, 'seeded saved conversation is listed', conversations.data.items.map((i) => i.id));
    const conversationId = conversation.id;

    // The world namespace is minted on first world-service init: process A creates it, B must agree.
    const namespace = await call('GET', '/namespace');
    check(namespace.status === 200 && /^w-[0-9a-f-]{36}$/.test(namespace.data.id ?? ''), 'GET /world/namespace', namespace);

    // edit 1: create + edit the project
    const project = await call('POST', '/projects', { title: 'T3P project', expectedVersion: null });
    check(project.status === 200 && project.data.version === 1, 'POST /projects', project);
    const projectEdit1 = await call('PUT', `/projects/${project.data.id}`, { title: 'T3P project (edit 1)', expectedVersion: 1 });
    check(projectEdit1.status === 200 && projectEdit1.data.version === 2, 'PUT project edit 1', projectEdit1);

    // edit 2: create + edit the note
    const note = await call('POST', '/notes', { title: 'T3P note', body: 'user note', expectedVersion: null });
    check(note.status === 200 && note.data.version === 1, 'POST /notes', note);
    const noteEdit2 = await call('PUT', `/notes/${note.data.id}`, { title: 'T3P note (edit 2)', body: 'user note edited', expectedVersion: 1 });
    check(noteEdit2.status === 200 && noteEdit2.data.version === 2, 'PUT note edit 2', noteEdit2);

    // edit 3: source-reference object pinned to the saved conversation
    const object = await call('POST', '/objects', { conversationId, expectedVersion: null });
    check(object.status === 200 && object.data.version === 1, 'POST /objects', object);

    // edit 4: selection pinned to the saved DOM_TURNS revision (opaque block of turn 1)
    const selection = await call('POST', '/selections', {
      objectId: object.data.id, selectionType: 'part', messageIndex: 1, partPath: [0], expectedVersion: null,
    });
    check(selection.status === 200 && selection.data.version === 1, 'POST /selections', selection);

    // link everything (project -> 3)
    const linked = await call('PUT', `/projects/${project.data.id}`, {
      conversationIds: [conversationId], noteIds: [note.data.id], memberIds: [object.data.id, selection.data.id], expectedVersion: 2,
    });
    check(linked.status === 200 && linked.data.version === 3, 'PUT project link', linked);
    check(Array.isArray(linked.data.noteIds) && linked.data.noteIds.includes(note.data.id), 'link kept the note', linked.data.noteIds);

    // Read back through THIS process: ids and versions as the durable result process B must reproduce.
    const ids = { project: project.data.id, note: note.data.id, object: object.data.id, selection: selection.data.id };
    const items = {};
    for (const kind of Object.keys(ids)) {
      const r = await call('GET', `/${ROUTES[kind]}/${ids[kind]}`);
      check(r.status === 200, `GET /${ROUTES[kind]}/{id}`, { kind, status: r.status });
      items[kind] = { id: r.data.id, version: r.data.version };
    }
    out({ event: 'result', ok: true, mode, conversationId, namespaceId: namespace.data.id, items, port: studio.port });
  } finally {
    await studio.close();
  }
}

// ------------------------------------------------------------------------------------------------ verify (PROCESS B)
async function runVerify() {
  const paths = ensureDataDirs(dataPaths(cfg.root));
  const worldDir = path.join(cfg.root, 'world');
  const projectId = cfg.expect.items.project.id;
  const sessionFile = path.join(paths.sessions, cfg.sid, 'kv', 'DOM_TURNS.json');
  const turnsNow = () => ({ bytes: sha256Hex(fs.readFileSync(sessionFile)), digest: domDigest(Session.open(paths.sessions, cfg.sid)) });
  const sameTurns = (label) => {
    const now = turnsNow();
    check(now.bytes === cfg.expect.H0, `DOM_TURNS raw bytes changed after ${label}`, { now: now.bytes, expect: cfg.expect.H0 });
    check(now.digest === cfg.expect.D0, `DOM_TURNS canonical digest changed after ${label}`, { now: now.digest, expect: cfg.expect.D0 });
    return now;
  };
  const operator = new VersionedStore(worldDir, { kind: 'world item' });
  const versionFiles = (name) => fs.readdirSync(path.join(worldDir, name.toLowerCase())).filter((f) => /^v\d{4}\.json$/.test(f)).sort();
  const currentBytes = (name) => fs.readFileSync(path.join(worldDir, name.toLowerCase(), 'CURRENT'), 'utf8').trim();

  check(process.pid !== cfg.aPid, 'process B is a distinct OS process from process A', { a: cfg.aPid, b: process.pid });

  const studio = await startStudio({ paths, profileStore: new ProfileStore(paths.profiles), port: 0, conversationRuntime: runtimeStub() });
  const evidence = { hashesBefore: null, hashesAfter: null, sessionsScope: null, casStale: {}, torn: {}, transientRetry: {}, killed: {}, recovery: {} };
  try {
    const call = httpFor(studio.port);
    evidence.hashesBefore = sameTurns('restart into process B');
    evidence.sessionsScope = treeHash(paths.sessions);
    check(evidence.sessionsScope.hash === cfg.expect.sessionsHash, 'sessions/** bytes are identical across the process boundary', { now: evidence.sessionsScope, expect: cfg.expect.sessionsHash });

    // ---- 1. the durable edits survive the process boundary, ids AND versions
    const conversations = await call('GET', '/conversations');
    check(conversations.status === 200, 'GET /world/conversations', conversations.status);
    const listed = conversations.data.items.filter((i) => i.sessionId === cfg.sid);
    check(listed.length === 1 && listed[0].id === cfg.expect.conversationId, 'the conversation id is the same in process B', listed.map((i) => i.id));
    const namespace = await call('GET', '/namespace');
    check(namespace.status === 200 && namespace.data.id === cfg.expect.namespaceId, 'world namespace id is the same in process B', { now: namespace.data.id, expect: cfg.expect.namespaceId });

    const designVersions = { project: 3, note: 2, object: 1, selection: 1 };
    for (const kind of Object.keys(designVersions)) {
      check(cfg.expect.versions[kind] === designVersions[kind], `design version for ${kind} is the observed one`, cfg.expect.versions);
    }
    const readBack = {};
    for (const kind of Object.keys(ROUTES)) {
      const r = await call('GET', `/${ROUTES[kind]}/${cfg.expect.items[kind].id}`);
      check(r.status === 200, `GET /${ROUTES[kind]}/{id} in process B`, { kind, status: r.status, data: r.data });
      check(r.data.id === cfg.expect.items[kind].id, `${kind} id survives the restart`, { now: r.data.id, expect: cfg.expect.items[kind].id });
      check(r.data.version === designVersions[kind], `${kind} version survives the restart`, { now: r.data.version, expect: designVersions[kind] });
      readBack[kind] = { id: r.data.id, version: r.data.version };
    }
    sameTurns('read-back of the 4 edit types');

    // ---- 2. cross-process CAS: a stale expectedVersion from the other process writes nothing
    for (const [kind, stale, actual] of [['project', 2, 3], ['note', 1, 2]]) {
      const body = kind === 'project'
        ? { title: 'stale write from process B', expectedVersion: stale }
        : { title: 'stale note write from process B', body: 'stale', expectedVersion: stale };
      const before = versionFiles(cfg.expect.items[kind].id).length;
      const r = await call('PUT', `/${ROUTES[kind]}/${cfg.expect.items[kind].id}`, body);
      check(r.status === 409, `${kind}: stale expectedVersion is refused with HTTP 409`, { status: r.status, data: r.data });
      check(r.data?.code === 'CAS_VERSION_CONFLICT', `${kind}: refusal code is CAS_VERSION_CONFLICT`, r.data);
      check(r.data?.expected === stale && r.data?.actual === actual, `${kind}: refusal carries the expected/actual operands`, r.data);
      check(operator.current(cfg.expect.items[kind].id) === actual, `${kind}: CURRENT still names ${actual}`, operator.current(cfg.expect.items[kind].id));
      check(versionFiles(cfg.expect.items[kind].id).length === before, `${kind}: a refused write appended no version`, { before, now: versionFiles(cfg.expect.items[kind].id) });
      evidence.casStale[kind] = { status: r.status, code: r.data.code, expected: r.data.expected, actual: r.data.actual };
    }
    sameTurns('two rejected CAS writes');

    // ---- 3 (i) interrupted save: a torn commit (version file written, CURRENT rename fails)
    // `EBUSY` is a TRANSIENT_FS code (src/store/versioned.mjs:33) so ONE throw is retried at :296-297 and cannot
    // tear anything: that is asserted first, on a scratch store outside the world namespace. The torn state needs
    // the fault to outlast the owner's 4 retries, which is what a delete-pending/AV share violation does.
    let transientAttempts = 0;
    const scratch = new VersionedStore(path.join(cfg.root, 't3p-scratch'), {
      kind: 't3p fixture', lockWaitMs: 0,
      io: { renameSync(a, b) {
        if (path.basename(String(b)) === 'CURRENT') { transientAttempts++; if (transientAttempts === 1) throw Object.assign(new Error('injected CURRENT rename EBUSY (once)'), { code: 'EBUSY' }); }
        return fs.renameSync(a, b);
      } },
    });
    const retried = scratch.compareAndSave('transient', { v: 1 }, { expectedVersion: null });
    check(retried.version === 1 && scratch.current('transient') === 1, 'one EBUSY on the CURRENT rename is retried by the owner and commits', retried);
    check(transientAttempts === 2, 'exactly one retry was spent on the single EBUSY', transientAttempts);
    evidence.transientRetry = { attempts: transientAttempts, version: retried.version };

    const beforeTornVersion = operator.current(projectId);
    const beforeTornRecord = operator.load(projectId);
    const orphanVersion = Number(versionFiles(projectId).at(-1).slice(1, 5)) + 1;
    let tornAttempts = 0;
    const tornStore = new VersionedStore(worldDir, {
      kind: 'world item', lockWaitMs: 0,
      io: { renameSync(a, b) {
        if (path.basename(String(b)) === 'CURRENT') { tornAttempts++; throw Object.assign(new Error('injected persistent CURRENT rename EBUSY'), { code: 'EBUSY' }); }
        return fs.renameSync(a, b);
      } },
    });
    let tornError = null;
    try { tornStore.compareAndSave(projectId, { ...beforeTornRecord, title: 'torn commit body' }, { expectedVersion: beforeTornVersion }); }
    catch (e) { tornError = e; }
    check(tornError?.code === 'EBUSY', 'the torn commit surfaces the injected EBUSY', { code: tornError?.code, message: tornError?.message });
    check(tornAttempts === 5, 'a persisting EBUSY costs the owner 4 retries before it is surfaced', tornAttempts);
    check(operator.current(projectId) === beforeTornVersion, 'CURRENT still names the pre-crash version', { now: operator.current(projectId), expect: beforeTornVersion });
    check(currentBytes(projectId) === String(beforeTornVersion), 'CURRENT bytes were never rewritten', currentBytes(projectId));
    const afterTornRecord = operator.load(projectId);
    check(afterTornRecord.version === beforeTornVersion, 'load() still returns the old version', afterTornRecord.version);
    check(afterTornRecord.title === beforeTornRecord.title, 'load() still returns the old content', { now: afterTornRecord.title, expect: beforeTornRecord.title });
    const orphanFile = path.join(worldDir, projectId.toLowerCase(), `v${String(orphanVersion).padStart(4, '0')}.json`);
    check(fs.existsSync(orphanFile), 'the version file written before the failed rename is an orphan on disk', orphanFile);
    check(JSON.parse(fs.readFileSync(orphanFile, 'utf8')).title === 'torn commit body', 'the orphan carries the rejected body');
    check(operator.load(projectId).title !== 'torn commit body', 'the orphan is unreachable through the owner (CURRENT only)', orphanFile);
    check(residue(worldDir, /\.tmp$/).length === 0, 'a failed CURRENT rename leaves no *.tmp residue', residue(worldDir, /\.tmp$/));
    check(fs.existsSync(path.join(worldDir, '.locks', `${projectId.toLowerCase()}.lock`)) === false, 'a failed commit releases its lock', fs.readdirSync(path.join(worldDir, '.locks')));
    sameTurns('a torn commit');
    evidence.torn = { attempts: tornAttempts, errorCode: tornError.code, current: operator.current(projectId), orphanVersion,
      orphanExists: true, unreachable: true, tmpResidue: residue(worldDir, /\.tmp$/).length, locks: fs.readdirSync(path.join(worldDir, '.locks')) };

    // ---- 3 (ii) interrupted save: a REAL holder process is killed mid-critical-section
    const holder = spawn(process.execPath, [SELF, 'hold', JSON.stringify({
      dir: worldDir, name: projectId, expectedVersion: beforeTornVersion, patch: { title: 'held by a killed writer' },
    })], { stdio: ['ignore', 'pipe', 'pipe'] });
    const holderEvents = [];
    const holderWaiters = [];
    let holderBuf = ''; let holderErr = '';
    holder.stdout.on('data', (d) => {
      holderBuf += d; let i;
      while ((i = holderBuf.indexOf('\n')) >= 0) {
        const line = holderBuf.slice(0, i); holderBuf = holderBuf.slice(i + 1);
        let ev; try { ev = JSON.parse(line); } catch { ev = { event: 'raw', line }; }
        holderEvents.push(ev); for (const w of holderWaiters.slice()) w(ev);
      }
    });
    holder.stderr.on('data', (d) => { holderErr += d; });
    const holderExited = new Promise((resolve) => holder.on('exit', (code, signal) => resolve({ code, signal })));
    const waitHolder = (name, ms = 60000) => new Promise((resolve, reject) => {
      const found = holderEvents.find((e) => e.event === name); if (found) return resolve(found);
      const to = setTimeout(() => reject(new Error(`timeout waiting for holder "${name}"; stderr=${holderErr.slice(0, 400)}`)), ms);
      holderWaiters.push((ev) => { if (ev.event === name) { clearTimeout(to); resolve(ev); } });
    });
    const holding = await waitHolder('holding');
    const holderPid = holding.pid ?? holder.pid;
    check(Number.isInteger(holderPid) && holderPid !== process.pid && holderPid !== cfg.aPid, 'the holder is a third independent OS process', { holderPid, b: process.pid, a: cfg.aPid });
    // busy while the holder is alive: HTTP 423 from the persistence owner's status map
    const busy = await call('PUT', `/projects/${projectId}`, { title: 'blocked behind a live holder', expectedVersion: beforeTornVersion });
    check(busy.status === 423 && busy.data?.code === 'CAS_LOCKED', 'a live cross-process holder blocks the write with HTTP 423 CAS_LOCKED', { status: busy.status, data: busy.data });
    // kill from OUTSIDE the holder (its parent is this process)
    process.kill(holderPid, 'SIGKILL');
    const holderExit = await holderExited;
    const dead = await (async (pid, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { try { process.kill(pid, 0); } catch (e) { if (e.code === 'ESRCH') return true; } await new Promise((r) => setTimeout(r, 50)); } return false; })(holderPid);
    check(dead === true, 'the killed holder is confirmed gone (ESRCH)', { holderPid, holderExit });
    check(fs.existsSync(path.join(worldDir, '.locks', `${projectId.toLowerCase()}.lock`)), 'the lock survives the crash', fs.readdirSync(path.join(worldDir, '.locks')));
    const holderVersionFile = versionFiles(projectId).at(-1);
    const holderVersion = Number(holderVersionFile.slice(1, 5));
    check(holderVersion === 5, 'the killed holder had written v5 before it was killed', holderVersionFile);
    check(JSON.parse(fs.readFileSync(path.join(worldDir, projectId.toLowerCase(), holderVersionFile), 'utf8')).title === 'held by a killed writer', 'the interrupted write left a COMPLETE orphan version file');
    check(operator.current(projectId) === beforeTornVersion, 'the killed holder never moved CURRENT', { now: operator.current(projectId), expect: beforeTornVersion });
    check(residue(worldDir, /\.tmp$/).length === 0, 'the interrupted save left no half-written CURRENT temp', residue(worldDir, /\.tmp$/));
    // stale is still refused, never stolen
    const staleAfterDeath = await call('PUT', `/projects/${projectId}`, { title: 'blocked behind a dead holder', expectedVersion: beforeTornVersion });
    check(staleAfterDeath.status === 423 && staleAfterDeath.data?.code === 'CAS_LOCKED', 'a dead holder\'s lock is still refused (stale, not stolen)', { status: staleAfterDeath.status, data: staleAfterDeath.data });

    // ---- recovery: operator inspection + token-checked release, then the SAME body with a freshly read version
    const info = operator.inspectLock(projectId);
    check(info.present === true && info.pidAlive === false && info.pid === holderPid, 'inspectLock reports the dead holder by pid', info);
    check(typeof info.token === 'string' && /^[0-9a-f]{32}$/.test(info.token), 'inspectLock exposes the production lock token', info.token);
    let wrongToken = null;
    try { operator.releaseStaleLock(projectId, { token: 'a'.repeat(32) }); } catch (e) { wrongToken = e; }
    check(wrongToken?.code === 'CAS_LOCK_TOKEN_MISMATCH', 'a wrong token removes nothing', wrongToken?.code);
    check(fs.existsSync(info.lockPath), 'the lock file is untouched after the wrong token', info.lockPath);
    const released = operator.releaseStaleLock(projectId, { token: info.token });
    check(released.released === true && released.pid === holderPid, 'the stale lock is released by token', released);
    check(fs.existsSync(info.lockPath) === false, 'the lock file is gone after recovery', info.lockPath);

    const fresh = await call('GET', `/projects/${projectId}`);
    check(fresh.status === 200 && fresh.data.version === beforeTornVersion, 'the freshly read version is still the pre-crash one', { status: fresh.status, version: fresh.data?.version });
    const filesBeforeRetry = versionFiles(projectId).length;
    const retryBody = { title: 'T3P project (recovered)', expectedVersion: fresh.data.version };
    const retry = await call('PUT', `/projects/${projectId}`, retryBody);
    check(retry.status === 200, 'the resubmitted body commits after recovery', { status: retry.status, data: retry.data });
    check(retry.data.version === (Number(versionFiles(projectId).at(-1).slice(1, 5))), 'the commit version is the version CURRENT now names', retry.data.version);
    check(operator.current(projectId) === retry.data.version, 'CURRENT names the recovered commit', { now: operator.current(projectId), expect: retry.data.version });
    check(versionFiles(projectId).length === filesBeforeRetry + 1, 'recovery appended exactly one version', { before: filesBeforeRetry, after: versionFiles(projectId) });
    check(retry.data.version > beforeTornVersion + 1, 'version numbering SKIPS the orphans left by the two interrupted saves', { beforeTornVersion, version: retry.data.version });
    check(operator.load(projectId).title === 'T3P project (recovered)', 'the recovered body is the CURRENT record', operator.load(projectId).title);
    // exactly once: repeating the identical body with the same expectedVersion is a conflict, not a second write
    const repeat = await call('PUT', `/projects/${projectId}`, retryBody);
    check(repeat.status === 409 && repeat.data?.code === 'CAS_VERSION_CONFLICT', 'repeating the identical body is refused with 409', { status: repeat.status, data: repeat.data });
    check(repeat.data.expected === beforeTornVersion && repeat.data.actual === retry.data.version, 'the repeat refusal reports the operands', repeat.data);
    check(versionFiles(projectId).length === filesBeforeRetry + 1, 'the repeat wrote nothing', versionFiles(projectId));
    evidence.killed = { holderPid, holderExit, confirmedDead: dead, busyWhileHolding: { status: busy.status, code: busy.data.code },
      staleAfterDeath: { status: staleAfterDeath.status, code: staleAfterDeath.data.code }, lockAfterCrash: true, pidAlive: info.pidAlive,
      wrongTokenCode: wrongToken.code, released: released.released };
    evidence.recovery = { freshVersion: fresh.data.version, retryVersion: retry.data.version, repeat: { status: repeat.status, code: repeat.data.code, expected: repeat.data.expected, actual: repeat.data.actual },
      versionFiles: versionFiles(projectId), orphansKept: true };

    // ---- 4. final state: source evidence untouched, scope unchanged, no residue
    evidence.hashesAfter = sameTurns('every durability scenario');
    evidence.sessionsScopeAfter = treeHash(paths.sessions);
    check(evidence.sessionsScopeAfter.hash === cfg.expect.sessionsHash, 'sessions/** is still byte-identical at the end', evidence.sessionsScopeAfter);
    evidence.finalVersions = Object.fromEntries(Object.keys(ROUTES).map((kind) => [kind, operator.current(cfg.expect.items[kind].id)]));
    check(evidence.finalVersions.note === 2 && evidence.finalVersions.object === 1 && evidence.finalVersions.selection === 1, 'the untouched items keep their versions', evidence.finalVersions);
    check(evidence.finalVersions.project === retry.data.version, 'the project CURRENT is the recovered commit', evidence.finalVersions);
    evidence.tmpResidue = { world: residue(worldDir, /\.tmp$/), sessions: residue(paths.sessions, /\.tmp$/) };
    check(evidence.tmpResidue.world.length === 0 && evidence.tmpResidue.sessions.length === 0, 'no *.tmp residue anywhere in the durable scopes', evidence.tmpResidue);
    evidence.locksAfter = fs.readdirSync(path.join(worldDir, '.locks')).sort();
    check(evidence.locksAfter.length === 0, 'no lock residue', evidence.locksAfter);

    out({ event: 'result', ok: true, mode, namespaceId: namespace.data.id, items: readBack, ...evidence });
  } finally {
    await studio.close();
  }
}

// ------------------------------------------------------------------------------------------------ hold (grandchild)
// Takes the REAL lock through a real compareAndSave, then blocks inside the critical section at the exact
// interrupted-save point: the new version file is fully written (durable bytes, an orphan-to-be) and CURRENT has
// not been touched yet. The parent kills this process from outside. Blocking there keeps the crash artifact
// honest - a complete orphan version file plus the surviving lock, and no half-written CURRENT temp file.
if (mode === 'hold') {
  const dir = cfg.dir;
  const lockPath = path.join(dir, '.locks', `${String(cfg.name).toLowerCase()}.lock`);
  const opened = new Map();
  const blockingIo = {
    openSync(p, flags, mode2) { const fd = fs.openSync(p, flags, mode2); opened.set(fd, String(p)); return fd; },
    writeFileSync(f, data, o) {
      const result = fs.writeFileSync(f, data, o);
      const written = typeof f === 'number' ? opened.get(f) : String(f);
      if (written && /[\\/]v\d{4}\.json$/.test(written)) {
        out({ event: 'holding', lockPath, holderName: cfg.name, expectedVersion: cfg.expectedVersion,
          pauseAt: 'version file written, CURRENT untouched', versionFile: path.basename(written), versionBytes: fs.statSync(written).size });
        for (;;) sleep(1000);
      }
      return result;
    },
    closeSync(fd) { opened.delete(fd); return fs.closeSync(fd); },
  };
  const store = new VersionedStore(dir, { kind: 'world item', lockWaitMs: 0, io: blockingIo });
  try {
    const current = store.load(cfg.name);
    store.compareAndSave(cfg.name, { ...current, ...(cfg.patch ?? {}) }, { expectedVersion: cfg.expectedVersion });
    out({ event: 'unexpected-completion' });
  } catch (e) {
    out({ event: 'hold-error', code: e?.code ?? 'UNCODED', message: String(e?.message ?? e).slice(0, 160) });
  }
}

// ------------------------------------------------------------------------------------------------ dispatch
try {
  if (mode === 'edits') await runEdits();
  else if (mode === 'verify') await runVerify();
  else if (mode !== 'hold') throw new Error(`unknown mode ${mode}`);
  process.exit(0);
} catch (e) {
  out({ event: 'fail', mode, code: e?.code ?? 'UNCODED', message: String(e?.message ?? e).slice(0, 2000), stack: String(e?.stack ?? '').split('\n').slice(0, 12).join('\n') });
  process.exit(3);
}
