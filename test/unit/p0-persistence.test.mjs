// Issue #81 P0: ONE persistence owner (src/store/versioned.mjs) for factory + I1.
// Every test runs against disposable temp roots and the REAL production code. Faults are injected only
// through the owner's documented `io` seam. Multi-process / handle-count / crash acceptance is measured
// separately (test/unit/p0-windows-probes.test.mjs); nothing here claims it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { VersionedStore, validateStoreName, I1_NAMESPACE_RE, STORE_LOCK_SCHEMA, STORE_MAX_VERSION } from '../../src/store/versioned.mjs';
import { ProfileStore } from '../../src/profiles/profiles.mjs';
import { FamilyStore } from '../../src/families/families.mjs';
import { createCasVersionedStore } from '../../src/studio/adapter-learning-pipeline.mjs';
import { createAdapterFactory, AdapterFactoryError } from '../../src/studio/adapter-factory-service.mjs';
import { getAdapter, setLearnedAdapterProvider } from '../../src/profiles/sites/index.mjs';
import { startStudio } from '../../src/studio/server.mjs';
import { createIntegrationHub } from '../../src/studio/integration-hub.mjs';
import { storeProblem, storeFields, STORE_ERROR_STATUS } from '../../src/studio/http.mjs';
import { dataPaths, ensureDataDirs } from '../../src/config.mjs';

const SRC = fileURLToPath(new URL('../../src/', import.meta.url));
const tmp = (t, prefix = 'aion-p0-') => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};
const mk = (dir, o = {}) => new VersionedStore(dir, { kind: 'test item', ...o });
const ro = (n, readFeatures = []) => ({ schema: 'aion.learned-read-adapter/1', adapter: { n }, readFeatures, sendPermission: false });
const i1Name = (scopeKey) => 'i1-' + createHash('sha256').update(String(scopeKey)).digest('hex').slice(0, 40);
const lockFiles = (dir) => { try { return fs.readdirSync(path.join(dir, '.locks')); } catch { return []; } };
const injected = (code = 'EIO') => Object.assign(new Error(`injected ${code}`), { code, injected: true });
const capture = (fn) => { try { fn(); return null; } catch (e) { return e; } };
const captureAsync = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
const snapshot = (root) => {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      out.push(`${path.relative(root, p)}${e.isDirectory() ? '/' : `:${fs.statSync(p).size}`}`);
      if (e.isDirectory()) walk(p);
    }
  };
  walk(root);
  return out.sort();
};

// io wrapper that tracks open descriptors and lets a test throw at a precise call. Hooks run BEFORE the real
// call except `close`, which closes the real descriptor first (so a faulty close never leaks in the test).
function spyIo(hooks = {}) {
  const open = new Set();
  const fdPath = new Map();
  const log = [];
  const io = {
    openSync(p, flags, mode) { hooks.openBefore?.(String(p)); const fd = fs.openSync(p, flags, mode); open.add(fd); fdPath.set(fd, String(p)); log.push(['open', String(p)]); return fd; },
    writeFileSync(f, d, o) { const p = typeof f === 'number' ? fdPath.get(f) : String(f); log.push(['write', p]); hooks.write?.(p); return fs.writeFileSync(f, d, o); },
    fsyncSync(fd) { const p = fdPath.get(fd); log.push(['fsync', p]); hooks.fsync?.(p); return fs.fsyncSync(fd); },
    // close throws AFTER the real close (descriptor released, error still reported) = the realistic fault; closeBefore throws before it (descriptor stays open) = unrealistic, used only to prove there is NO retry
    closeSync(fd) { const p = fdPath.get(fd); log.push(['close', p]); hooks.closeBefore?.(p, fd); try { fs.closeSync(fd); } finally { open.delete(fd); } hooks.close?.(p); },
    renameSync(a, b) { log.push(['rename', String(a), String(b)]); hooks.rename?.(String(a), String(b)); return fs.renameSync(a, b); },
    unlinkSync(p) { log.push(['unlink', String(p)]); hooks.unlink?.(String(p)); return fs.unlinkSync(p); },
    // optional: lets a test make existsSync flicker (Windows delete-pending) for chosen paths; undefined = real answer
    existsSync(p) { const o = hooks.exists?.(String(p)); return o === undefined ? fs.existsSync(p) : o; },
  };
  return { io, open, log };
}
const isLock = (p) => /\.lock$/.test(p ?? '');
const isVersionFile = (p) => /v\d{4}\.json$/.test(p ?? '');
const isCurrentTmp = (p) => /CURRENT\.[0-9a-f]+\.tmp$/.test(p ?? '');

// ============================================================================================ B1
test('B1 compareAndSave: null is first-create only; exactly one first writer wins, the next conflicts', (t) => {
  const s = mk(path.join(tmp(t), 's'));
  const a = s.compareAndSave('n', { x: 1 }, { expectedVersion: null });
  assert.equal(a.version, 1);
  const e = capture(() => s.compareAndSave('n', { x: 2 }, { expectedVersion: null }));
  assert.equal(e?.code, 'CAS_VERSION_CONFLICT');
  assert.equal(e.expected, null);
  assert.equal(e.actual, 1);
  assert.equal(s.current('n'), 1);
  assert.equal(s.versions('n').length, 1);
});

test('B1 two store instances over one directory: one first-writer succeeds, the other conflicts (not lost)', (t) => {
  const dir = path.join(tmp(t), 's');
  const a = mk(dir); const b = mk(dir);
  assert.equal(a.compareAndSave('n', { w: 'a' }, { expectedVersion: null }).version, 1);
  assert.equal(capture(() => b.compareAndSave('n', { w: 'b' }, { expectedVersion: null }))?.code, 'CAS_VERSION_CONFLICT');
  assert.equal(b.load('n').w, 'a');
});

test('B1 invalid expectedVersion values are rejected BEFORE any lock or write (save and rollback)', (t) => {
  const root = tmp(t); const dir = path.join(root, 's');
  const s = mk(dir);
  const bad = [undefined, 0, '1', 1.5, NaN, -1, STORE_MAX_VERSION + 1, Infinity, true, {}, [1]];
  const before = snapshot(root);
  for (const v of bad) {
    assert.equal(capture(() => s.compareAndSave('n', { x: 1 }, { expectedVersion: v }))?.code, 'CAS_EXPECTED_VERSION_INVALID', `save expected=${String(v)}`);
    assert.equal(capture(() => s.compareAndRollback('n', 1, { expectedVersion: v }))?.code, 'CAS_EXPECTED_VERSION_INVALID', `rollback expected=${String(v)}`);
  }
  assert.equal(capture(() => s.compareAndRollback('n', 1, { expectedVersion: null }))?.code, 'CAS_EXPECTED_VERSION_INVALID', 'null is not a rollback expectation');
  for (const o of [undefined, {}, null, 'x']) assert.equal(capture(() => s.compareAndSave('n', { x: 1 }, o))?.code, 'CAS_EXPECTED_VERSION_INVALID');
  assert.deepEqual(snapshot(root), before, 'no directory, lock or file was created');
});

test('B1 stale and absent expectations conflict for both save and rollback', (t) => {
  const s = mk(path.join(tmp(t), 's'));
  assert.equal(s.compareAndSave('n', { v: 1 }, { expectedVersion: null }).version, 1);
  assert.equal(s.compareAndSave('n', { v: 2 }, { expectedVersion: 1 }).version, 2);
  assert.equal(s.compareAndSave('n', { v: 3 }, { expectedVersion: 2 }).version, 3);
  const stale = capture(() => s.compareAndSave('n', { v: 9 }, { expectedVersion: 1 }));
  assert.equal(stale?.code, 'CAS_VERSION_CONFLICT'); assert.equal(stale.expected, 1); assert.equal(stale.actual, 3);
  assert.equal(capture(() => s.compareAndRollback('n', 1, { expectedVersion: 2 }))?.code, 'CAS_VERSION_CONFLICT');
  const absent = capture(() => s.compareAndRollback('missing', 1, { expectedVersion: 1 }));
  assert.equal(absent?.code, 'CAS_VERSION_CONFLICT'); assert.equal(absent.actual, null);
  assert.equal(capture(() => s.compareAndRollback('n', 4, { expectedVersion: 3 }))?.code, 'STORE_NO_SUCH_VERSION');
  assert.equal(s.current('n'), 3);
});

test('B1 ABA: rollback appends a restoring version so a stale base can never become valid again', (t) => {
  const s = mk(path.join(tmp(t), 's'));
  s.compareAndSave('n', { v: 1 }, { expectedVersion: null });
  s.compareAndSave('n', { v: 2 }, { expectedVersion: 1 });
  const v1Bytes = fs.readFileSync(path.join(s.dir, 'n', 'v0001.json'), 'utf8');
  const v2Bytes = fs.readFileSync(path.join(s.dir, 'n', 'v0002.json'), 'utf8');
  const rb = s.compareAndRollback('n', 1, { expectedVersion: 2 });
  assert.equal(rb.version, 3); assert.equal(rb.restoredFrom, 1); assert.equal(rb.v, 1);
  assert.equal(s.current('n'), 3, 'CURRENT moved forward, not back to 1');
  assert.equal(fs.readFileSync(path.join(s.dir, 'n', 'v0001.json'), 'utf8'), v1Bytes, 'history is immutable');
  assert.equal(fs.readFileSync(path.join(s.dir, 'n', 'v0002.json'), 'utf8'), v2Bytes);
  for (const stale of [1, 2]) {
    const e = capture(() => s.compareAndSave('n', { v: 99 }, { expectedVersion: stale }));
    assert.equal(e?.code, 'CAS_VERSION_CONFLICT', `stale base ${stale} stays stale`);
  }
  assert.equal(s.compareAndSave('n', { v: 4 }, { expectedVersion: 3 }).version, 4);
  // restoring a restored version does not nest restoredFrom
  const again = s.compareAndRollback('n', 3, { expectedVersion: 4 });
  assert.equal(again.restoredFrom, 3); assert.equal(again.version, 5);
});

test('B1 legacy save()/rollback() keep profile/family pointer semantics (no migration)', (t) => {
  const s = mk(path.join(tmp(t), 's'));
  s.save('p', { v: 1 }); s.save('p', { v: 2 });
  assert.equal(s.current('p'), 2);
  const rb = s.rollback('p', 1);
  assert.equal(rb.v, 1); assert.equal(s.current('p'), 1, 'legacy rollback is a pointer move');
  assert.equal(s.versions('p').length, 2, 'no restoring version appended');
  assert.equal(capture(() => s.rollback('p', 7))?.code, 'STORE_NO_SUCH_VERSION');
  assert.equal(s.save('p', { v: 3 }).version, 3, 'next version = highest existing + 1, never reuses 2');
});

test('B1 raw CURRENT is the head: a corrupt/unselectable record never looks absent', (t) => {
  const root = tmp(t); const dir = path.join(root, 's');
  const s = mk(dir);
  s.compareAndSave('n', { v: 1 }, { expectedVersion: null });
  fs.writeFileSync(path.join(dir, 'n', 'v0001.json'), '{not json');
  const e = capture(() => s.compareAndSave('n', { v: 2 }, { expectedVersion: null }));
  assert.equal(e?.code, 'CAS_VERSION_CONFLICT'); assert.equal(e.actual, 1);
  assert.equal(capture(() => s.load('n'))?.code, 'STORE_RECORD_CORRUPT');
  assert.equal(capture(() => s.compareAndRollback('n', 1, { expectedVersion: 1 }))?.code, 'STORE_RECORD_CORRUPT', 'a corrupt target cannot be restored');
  assert.equal(s.versions('n')[0].corrupt, true, 'listing survives a corrupt record');
  // CURRENT corrupt => fail closed, never "absent"
  fs.writeFileSync(path.join(dir, 'n', 'CURRENT'), 'abc');
  assert.equal(capture(() => s.current('n'))?.code, 'STORE_CURRENT_CORRUPT');
  assert.equal(capture(() => s.compareAndSave('n', { v: 2 }, { expectedVersion: null }))?.code, 'STORE_CURRENT_CORRUPT');
  for (const junk of ['0', '01', '12345', '-1', '1.5', '', ' 7x']) {
    fs.writeFileSync(path.join(dir, 'n', 'CURRENT'), junk);
    assert.equal(capture(() => s.current('n'))?.code, 'STORE_CURRENT_CORRUPT', `CURRENT=${JSON.stringify(junk)}`);
  }
  // CURRENT names a version whose file is missing
  fs.writeFileSync(path.join(dir, 'n', 'CURRENT'), '5');
  assert.equal(capture(() => s.compareAndSave('n', { v: 2 }, { expectedVersion: 5 }))?.code, 'STORE_CURRENT_CORRUPT');
  assert.equal(capture(() => s.compareAndSave('n', { v: 2 }, { expectedVersion: null }))?.code, 'STORE_CURRENT_CORRUPT');
});

test('B1 an orphan version (no CURRENT) counts as absent for first-create, is skipped and never overwritten', (t) => {
  const dir = path.join(tmp(t), 's');
  const s = mk(dir);
  fs.mkdirSync(path.join(dir, 'n'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'n', 'v0001.json'), JSON.stringify({ orphan: true }));
  assert.equal(s.current('n'), null);
  const rec = s.compareAndSave('n', { v: 2 }, { expectedVersion: null });
  assert.equal(rec.version, 2);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'n', 'v0001.json'), 'utf8')), { orphan: true });
  assert.equal(s.current('n'), 2);
});

test('B1 version limit is a coded refusal, not a silent overwrite', (t) => {
  const dir = path.join(tmp(t), 's');
  const s = mk(dir);
  fs.mkdirSync(path.join(dir, 'n'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'n', 'v9999.json'), JSON.stringify({ v: 9999 }));
  fs.writeFileSync(path.join(dir, 'n', 'CURRENT'), '9999');
  assert.equal(capture(() => s.compareAndSave('n', { v: 1 }, { expectedVersion: 9999 }))?.code, 'STORE_VERSION_LIMIT');
  assert.equal(s.current('n'), 9999);
});

test('B1 I1 wrapper: strict null/integer expectations, rollback integer-only, unselectable head never looks absent', async (t) => {
  const dir = path.join(tmp(t), 's');
  const store = mk(dir);
  const cas = createCasVersionedStore({ store });
  assert.equal((await cas.promote('scope', ro(1), null)).version, 1);
  for (const bad of [undefined, 0, '1', NaN, 1.5]) {
    assert.equal((await captureAsync(() => cas.promote('scope', ro(2), bad)))?.code, 'CAS_EXPECTED_VERSION_INVALID');
  }
  for (const bad of [undefined, null, 0, '1']) {
    assert.equal((await captureAsync(() => cas.rollback('scope', 1, bad)))?.code, 'CAS_EXPECTED_VERSION_INVALID');
  }
  assert.equal((await captureAsync(() => cas.rollback('scope', 0, 1)))?.code, 'INVALID_ROLLBACK_VERSION');
  assert.equal((await captureAsync(() => cas.promote('scope', ro(3), null)))?.code, 'CAS_VERSION_CONFLICT');
  assert.equal((await captureAsync(() => cas.promote('scope', { schema: 'x', adapter: {} }, 1)))?.code, 'CAS_PAYLOAD_MUST_BE_READ_ONLY');
  // head becomes unreadable: the read view returns null, but a first-create must still conflict
  fs.writeFileSync(path.join(dir, i1Name('scope'), 'v0001.json'), 'garbage');
  assert.equal(await cas.current('scope'), null);
  const e = await captureAsync(() => cas.promote('scope', ro(4), null));
  assert.equal(e?.code, 'CAS_VERSION_CONFLICT'); assert.equal(e.actual, 1);
  // a never-promoted scope reads as absent and accepts the first write
  assert.equal(await cas.current('other'), null);
  assert.equal((await cas.promote('other', ro(1), null)).version, 1);
});

// ============================================================================================ B2
test('B2 descriptors are balanced and no lock remains after 200 mixed operations', (t) => {
  const dir = path.join(tmp(t), 's');
  const spy = spyIo();
  const s = mk(dir, { io: spy.io });
  let cur = null;
  for (let i = 0; i < 200; i++) {
    if (i % 5 === 4) { s.compareAndRollback('n', 1, { expectedVersion: cur }); cur += 1; }
    else { s.compareAndSave('n', { i }, { expectedVersion: cur }); cur = (cur ?? 0) + 1; }
  }
  assert.equal(s.current('n'), cur);
  assert.equal(spy.open.size, 0, 'every descriptor opened by the owner was closed');
  assert.deepEqual(lockFiles(dir), []);
  assert.equal(spy.log.filter((l) => l[0] === 'open').length, spy.log.filter((l) => l[0] === 'close').length);
});

for (const stage of ['write', 'fsync', 'close']) {
  test(`B2 lock acquire ${stage} fault: descriptor closed, creation-owned lock removed, original error preserved`, (t) => {
    const dir = path.join(tmp(t), 's');
    const err = injected();
    const spy = spyIo({ [stage]: (p) => { if (isLock(p)) throw err; } });
    const s = mk(dir, { io: spy.io, lockWaitMs: 0 });
    const e = capture(() => s.compareAndSave('n', { v: 1 }, { expectedVersion: null }));
    assert.equal(e, err, 'the injected error itself is thrown, unchanged');
    assert.equal(spy.open.size, 0);
    assert.deepEqual(lockFiles(dir), []);
    assert.equal(s.current('n'), null, 'nothing was written');
    assert.equal(mk(dir, { lockWaitMs: 0 }).compareAndSave('n', { v: 1 }, { expectedVersion: null }).version, 1, 'store stays usable (no CAS_LOCKED residue)');
  });
}

test('B2 lock acquire fault whose cleanup also fails keeps the primary error and reports the cleanup cause', (t) => {
  const dir = path.join(tmp(t), 's');
  const err = injected();
  const spy = spyIo({ write: (p) => { if (isLock(p)) throw err; }, unlink: (p) => { if (isLock(p)) throw injected('EPERM'); } });
  const s = mk(dir, { io: spy.io, lockWaitMs: 0 });
  const e = capture(() => s.compareAndSave('n', { v: 1 }, { expectedVersion: null }));
  assert.equal(e, err);
  assert.equal(e.releaseError.code, 'EPERM');
  assert.equal(spy.open.size, 0);
});

const CLOSE_TARGETS = { lock: isLock, version: isVersionFile, 'CURRENT temp': isCurrentTmp };
for (const [label, match] of Object.entries(CLOSE_TARGETS)) {
  const rig = (t, hooks) => {
    const dir = path.join(tmp(t), 's');
    const spy = spyIo(hooks);
    const s = mk(dir, { io: spy.io, lockWaitMs: 0 });
    const count = (kind) => spy.log.filter((l) => l[0] === kind && match(l[1])).length;
    return { dir, spy, s, count };
  };
  test(`B2 ${label}: a close that reports an error AFTER releasing the descriptor is called exactly once, never retried, nothing leaks`, (t) => {
    const err = injected();
    const { dir, spy, s, count } = rig(t, { close: (p) => { if (match(p)) throw err; } });
    const e = capture(() => s.compareAndSave('n', { v: 1 }, { expectedVersion: null }));
    assert.equal(e, err, 'the close error is the reported failure');
    assert.equal(count('close'), 1, 'closeSync called exactly once for that file (no retry, no probe)');
    assert.equal(count('open'), 1);
    assert.equal(spy.open.size, 0, 'no descriptor remains open');
    const all = (k) => spy.log.filter((l) => l[0] === k).length;
    assert.equal(all('open'), all('close'), `every open was matched by exactly one close (opens=${all('open')}, closes=${all('close')})`);
    assert.deepEqual(lockFiles(dir), []);
  });
  test(`B2 ${label}: a close that fails BEFORE releasing is still attempted only once (no retry on a number that may be reused)`, (t) => {
    const errors = [];
    const { spy, s, count } = rig(t, { closeBefore: (p) => { if (match(p)) { const e = injected('EIO'); errors.push(e); throw e; } } });
    const e = capture(() => s.compareAndSave('n', { v: 1 }, { expectedVersion: null }));
    try {
      assert.equal(e, errors[0]);
      assert.equal(errors.length, 1, 'exactly one close attempt');
      assert.equal(count('close'), 1);
      assert.equal(e.closeRetried, undefined);
      assert.equal(spy.open.size, 1, 'the (mock-induced) unreleased descriptor is the only open one: the owner did not guess');
    } finally { for (const fd of spy.open) { try { fs.closeSync(fd); } catch { /* test hygiene */ } } }
  });
}
for (const stage of ['write', 'fsync', 'close']) {
  test(`B2 version-file ${stage} fault: partial file removed, lock released, CURRENT unchanged, fds balanced`, (t) => {
    const dir = path.join(tmp(t), 's');
    const err = injected();
    let armed = false;
    const spy = spyIo({ [stage]: (p) => { if (armed && isVersionFile(p)) throw err; } });
    const s = mk(dir, { io: spy.io, lockWaitMs: 0 });
    s.compareAndSave('n', { v: 1 }, { expectedVersion: null });
    armed = true;
    const e = capture(() => s.compareAndSave('n', { v: 2 }, { expectedVersion: 1 }));
    armed = false;
    assert.equal(e, err);
    assert.equal(spy.open.size, 0);
    assert.deepEqual(lockFiles(dir), []);
    assert.equal(s.current('n'), 1);
    assert.deepEqual(fs.readdirSync(path.join(dir, 'n')).sort(), ['CURRENT', 'v0001.json']);
    assert.equal(s.compareAndSave('n', { v: 2 }, { expectedVersion: 1 }).version, 2);
  });
}

for (const stage of ['write', 'fsync', 'close']) {
  test(`B2 CURRENT-temp ${stage} fault leaves an orphan version only; pointer, lock and fds stay consistent`, (t) => {
    const dir = path.join(tmp(t), 's');
    const err = injected();
    let armed = false;
    const spy = spyIo({ [stage]: (p) => { if (armed && isCurrentTmp(p)) throw err; } });
    const s = mk(dir, { io: spy.io, lockWaitMs: 0 });
    s.compareAndSave('n', { v: 1 }, { expectedVersion: null });
    armed = true;
    const e = capture(() => s.compareAndSave('n', { v: 2 }, { expectedVersion: 1 }));
    armed = false;
    assert.equal(e, err);
    assert.equal(spy.open.size, 0);
    assert.deepEqual(lockFiles(dir), []);
    assert.equal(s.current('n'), 1, 'pointer unchanged');
    assert.ok(!fs.readdirSync(path.join(dir, 'n')).some((f) => f.endsWith('.tmp')), 'temp pointer removed');
    assert.ok(fs.existsSync(path.join(dir, 'n', 'v0002.json')), 'orphan version is retained, not deleted');
    assert.equal(s.compareAndSave('n', { v: 3 }, { expectedVersion: 1 }).version, 3, 'orphan v2 is skipped, never overwritten');
    assert.equal(s.load('n', 2).v, 2);
  });
}

test('B2 CURRENT rename: transient EPERM is retried, persistent EPERM fails closed with cleanup', (t) => {
  const dir = path.join(tmp(t), 's');
  let fails = 0; let always = false;
  const spy = spyIo({ rename: (a) => { if (isCurrentTmp(a) && (always || fails-- > 0)) throw injected('EPERM'); } });
  const s = mk(dir, { io: spy.io, lockWaitMs: 0 });
  fails = 2;
  assert.equal(s.compareAndSave('n', { v: 1 }, { expectedVersion: null }).version, 1, 'two transient failures are absorbed');
  always = true;
  const e = capture(() => s.compareAndSave('n', { v: 2 }, { expectedVersion: 1 }));
  assert.equal(e?.code, 'EPERM');
  assert.equal(spy.open.size, 0);
  assert.deepEqual(lockFiles(dir), []);
  assert.equal(s.current('n'), 1);
  assert.ok(!fs.readdirSync(path.join(dir, 'n')).some((f) => f.endsWith('.tmp')));
});

test('B2 committed change + unlink fault: CAS_LOCK_RELEASE_UNVERIFIED carries committed/committedVersion; operator recovery is token-checked', (t) => {
  const dir = path.join(tmp(t), 's');
  const spy = spyIo({ unlink: (p) => { if (isLock(p)) throw injected('EPERM'); } });
  const faulty = mk(dir, { io: spy.io, lockWaitMs: 0 });
  const e = capture(() => faulty.compareAndSave('n', { v: 1 }, { expectedVersion: null }));
  assert.equal(e?.code, 'CAS_LOCK_RELEASE_UNVERIFIED');
  assert.equal(e.committed, true); assert.equal(e.committedVersion, 1);
  assert.equal(e.releaseError.code, 'CAS_LOCK_RELEASE_UNVERIFIED');
  assert.equal(spy.open.size, 0);
  const plain = mk(dir, { lockWaitMs: 0 });
  assert.equal(plain.current('n'), 1, 'the mutation IS durable');
  // stale-lock refusal: nothing steals the lock
  assert.equal(capture(() => plain.compareAndSave('n', { v: 2 }, { expectedVersion: 1 }))?.code, 'CAS_LOCKED');
  assert.equal(plain.current('n'), 1);
  const info = plain.inspectLock('n');
  assert.equal(info.present, true); assert.equal(info.malformed, false);
  assert.equal(info.pid, process.pid); assert.equal(info.pidAlive, true); assert.equal(info.op, 'compareAndSave'); assert.match(info.token, /^[0-9a-f]{32}$/);
  // wrong token / garbage token never remove it
  assert.equal(capture(() => plain.releaseStaleLock('n', { token: randomBytes(16).toString('hex') }))?.code, 'CAS_LOCK_TOKEN_MISMATCH');
  assert.equal(capture(() => plain.releaseStaleLock('n', { token: 'nope' }))?.code, 'CAS_LOCK_TOKEN_MISMATCH');
  assert.equal(capture(() => plain.releaseStaleLock('n'))?.code, 'CAS_LOCK_TOKEN_MISMATCH');
  assert.equal(plain.inspectLock('n').present, true);
  assert.equal(plain.releaseStaleLock('n', { token: info.token }).released, true);
  assert.equal(plain.inspectLock('n').present, false);
  assert.equal(capture(() => plain.releaseStaleLock('n', { token: info.token }))?.code, 'CAS_LOCK_ABSENT');
  assert.equal(plain.compareAndSave('n', { v: 2 }, { expectedVersion: 1 }).version, 2);
});

test('B2 cleanup never masks the primary failure (conflict + unlink fault keeps CAS_VERSION_CONFLICT)', (t) => {
  const dir = path.join(tmp(t), 's');
  mk(dir).compareAndSave('n', { v: 1 }, { expectedVersion: null });
  const spy = spyIo({ unlink: (p) => { if (isLock(p)) throw injected('EPERM'); } });
  const faulty = mk(dir, { io: spy.io, lockWaitMs: 0 });
  const e = capture(() => faulty.compareAndSave('n', { v: 2 }, { expectedVersion: null }));
  assert.equal(e?.code, 'CAS_VERSION_CONFLICT');
  assert.equal(e.releaseError?.code, 'CAS_LOCK_RELEASE_UNVERIFIED');
  assert.equal(e.committed, undefined);
  assert.equal(mk(dir).current('n'), 1);
});

test('B2 release only removes the lock this operation owns (foreign nonce is left intact)', (t) => {
  const dir = path.join(tmp(t), 's');
  const foreign = JSON.stringify({ schema: STORE_LOCK_SCHEMA, token: 'f'.repeat(32), pid: 1, name: 'n', op: 'save', at: new Date().toISOString() });
  const lockPath = path.join(dir, '.locks', 'n.lock');
  const spy = spyIo({ rename: (a) => { if (isCurrentTmp(a)) fs.writeFileSync(lockPath, foreign); } });
  const s = mk(dir, { io: spy.io, lockWaitMs: 0 });
  const e = capture(() => s.compareAndSave('n', { v: 1 }, { expectedVersion: null }));
  assert.equal(e?.code, 'CAS_LOCK_RELEASE_UNVERIFIED');
  assert.equal(e.committed, true); assert.equal(e.committedVersion, 1);
  assert.equal(fs.readFileSync(lockPath, 'utf8'), foreign, 'foreign lock untouched');
  // unparsable lock content is also never removed
  fs.writeFileSync(lockPath, 'not json');
  assert.equal(capture(() => mk(dir, { lockWaitMs: 0 }).compareAndSave('n', { v: 2 }, { expectedVersion: 1 }))?.code, 'CAS_LOCKED');
  assert.equal(fs.readFileSync(lockPath, 'utf8'), 'not json');
  assert.equal(mk(dir).inspectLock('n').malformed, true);
});

test('B2 lock file schema and case-insensitive key canonicalisation', (t) => {
  const dir = path.join(tmp(t), 's');
  let seen = null; const spy = spyIo({ rename: (a) => { if (isCurrentTmp(a)) seen = JSON.parse(fs.readFileSync(path.join(dir, '.locks', 'case.lock'), 'utf8')); } });
  const s = mk(dir, { io: spy.io });
  s.compareAndSave('Case', { v: 1 }, { expectedVersion: null });
  assert.equal(seen.schema, STORE_LOCK_SCHEMA); assert.match(seen.token, /^[0-9a-f]{32}$/);
  assert.equal(seen.pid, process.pid); assert.equal(seen.name, 'Case'); assert.equal(seen.op, 'compareAndSave'); assert.ok(!Number.isNaN(Date.parse(seen.at)));
  assert.equal(s.lockPath('Case'), s.lockPath('cASE'));
  assert.deepEqual(lockFiles(dir), []);
});

test('B2 inspectLock reports a dead holder pid without touching the lock', (t) => {
  const dir = path.join(tmp(t), 's');
  const s = mk(dir, { lockWaitMs: 0 });
  const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  const deadPid = Number(child.stdout);
  fs.mkdirSync(path.join(dir, '.locks'), { recursive: true });
  const body = { schema: STORE_LOCK_SCHEMA, token: 'a'.repeat(32), pid: deadPid, name: 'n', op: 'compareAndSave', at: '2020-01-01T00:00:00.000Z' };
  fs.writeFileSync(path.join(dir, '.locks', 'n.lock'), JSON.stringify(body));
  assert.equal(capture(() => s.compareAndSave('n', {}, { expectedVersion: null }))?.code, 'CAS_LOCKED');
  const info = s.inspectLock('n');
  assert.equal(info.pid, deadPid); assert.equal(info.pidAlive, false); assert.equal(info.at, body.at);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, '.locks', 'n.lock'), 'utf8')), body, 'age/dead pid never triggers automatic removal');
});

// ============================================================================================ B3
const BAD_NAMES = ['../profiles/chatgpt', '..', '.', '', 'a/b', 'a\\b', '/abs', 'C:\\x', 'C:x', '.hidden', '.locks', 'trailing.', 'con', 'NUL.txt', 'com1', 'LPT9.log',
  'a'.repeat(65), ' x', 'x ', 'a\0b', '%2e%2e', 'a:b', 'a*b', 'a?b', null, undefined, 5, {}, ['a']];
const NAME_CALLS = {
  has: (s, n) => s.has(n), current: (s, n) => s.current(n), versions: (s, n) => s.versions(n), load: (s, n) => s.load(n), loadV: (s, n) => s.load(n, 1),
  save: (s, n) => s.save(n, {}), compareAndSave: (s, n) => s.compareAndSave(n, {}, { expectedVersion: null }), rollback: (s, n) => s.rollback(n, 1),
  compareAndRollback: (s, n) => s.compareAndRollback(n, 1, { expectedVersion: 1 }), inspectLock: (s, n) => s.inspectLock(n),
  releaseStaleLock: (s, n) => s.releaseStaleLock(n, { token: 'a'.repeat(32) }), lockPath: (s, n) => s.lockPath(n),
};

test('B3 every method validates the store name (read and write); nothing is created anywhere', (t) => {
  const root = tmp(t);
  const s = mk(path.join(root, 'learned-adapters'));
  mk(path.join(root, 'profiles')).save('chatgpt', { a: 1 });
  fs.writeFileSync(path.join(root, 'learned-adapters', 'x.json'), '{}');
  const before = snapshot(root);
  for (const [method, call] of Object.entries(NAME_CALLS)) {
    for (const name of BAD_NAMES) {
      const e = capture(() => call(s, name));
      assert.equal(e?.code, 'STORE_NAME_INVALID', `${method}(${JSON.stringify(name)}) must be STORE_NAME_INVALID, got ${e?.code}`);
    }
  }
  assert.deepEqual(snapshot(root), before, 'rejected names touch nothing');
  assert.equal(validateStoreName('claude.ai'), 'claude.ai');
});

test('B3 traversal can no longer move or read another store (rollback/current/versions/load)', (t) => {
  const root = tmp(t);
  const learned = mk(path.join(root, 'learned-adapters'));
  const profiles = mk(path.join(root, 'profiles'));
  profiles.save('chatgpt', { a: 1 }); profiles.save('chatgpt', { a: 2 });
  for (const call of [() => learned.rollback('../profiles/chatgpt', 1), () => learned.compareAndRollback('../profiles/chatgpt', 1, { expectedVersion: 2 }),
    () => learned.current('../profiles/chatgpt'), () => learned.versions('../profiles/chatgpt'), () => learned.load('../profiles/chatgpt'),
    () => learned.save('../profiles/chatgpt', {}), () => learned.rollback(path.join(root, 'profiles', 'chatgpt'), 1)]) {
    assert.equal(capture(call)?.code, 'STORE_NAME_INVALID');
  }
  assert.equal(profiles.current('chatgpt'), 2, 'the other store pointer is unchanged');
  assert.equal(profiles.versions('chatgpt').length, 2);
});

test('B3 version grammar: integers 1..9999 only; forged version strings cannot leave the version directory', (t) => {
  const root = tmp(t);
  const s = mk(path.join(root, 'learned-adapters'));
  s.save('valid', { v: 1 });
  fs.writeFileSync(path.join(root, 'learned-adapters', 'x.json'), JSON.stringify({ leaked: 'outside-version-file' }));
  const badVersions = ['1', '1.5', 1.5, NaN, 0, -1, STORE_MAX_VERSION + 1, null, '1/../../x', '../x', Infinity, {}, [1], true, 1e21];
  for (const v of badVersions) {
    assert.equal(capture(() => s.load('valid', v))?.code, 'STORE_VERSION_INVALID', `load(${String(v)})`);
    assert.equal(capture(() => s.rollback('valid', v))?.code, 'STORE_VERSION_INVALID', `rollback(${String(v)})`);
    assert.equal(capture(() => s.compareAndRollback('valid', v, { expectedVersion: 1 }))?.code, 'STORE_VERSION_INVALID', `compareAndRollback(${String(v)})`);
  }
  assert.equal(s.load('valid', 1).v, 1);
  assert.equal(s.load('valid').v, 1);
});

test('B3 valid existing names, built-in profiles and families are preserved', (t) => {
  const dir = tmp(t);
  const s = mk(path.join(dir, 'names'));
  const good = ['chatgpt', 'claude.ai', 'a-b_c.1', 'A1', 'x', 'site.example.com', i1Name('k'), '0abc', 'a'.repeat(64)];
  for (const n of good) assert.equal(s.compareAndSave(n, { n }, { expectedVersion: null }).name, n);
  assert.deepEqual(s.names().sort(), [...good].sort());
  assert.ok(I1_NAMESPACE_RE.test(i1Name('k')));
  const profiles = new ProfileStore(path.join(dir, 'profiles'));
  const families = new FamilyStore(path.join(dir, 'families'));
  assert.ok(profiles.names().length > 0 && profiles.names().includes('generic') || profiles.names().length > 0, 'built-in profiles seeded');
  assert.ok(families.names().length > 0, 'built-in families seeded');
  for (const n of profiles.names()) assert.equal(profiles.current(n) >= 1, true);
  // re-opening does not re-seed or duplicate versions
  const before = profiles.names().map((n) => [n, profiles.versions(n).length]);
  const again = new ProfileStore(path.join(dir, 'profiles'));
  assert.deepEqual(again.names().map((n) => [n, again.versions(n).length]), before);
});

test('B3 names() lists only valid stores and ignores .locks, temp files and invalid directories', (t) => {
  const dir = path.join(tmp(t), 's');
  const s = mk(dir);
  s.compareAndSave('ok', {}, { expectedVersion: null });
  for (const bad of ['bad name', 'con', 'trail.', '.hidden']) { fs.mkdirSync(path.join(dir, bad), { recursive: true }); fs.writeFileSync(path.join(dir, bad, 'CURRENT'), '1'); }
  assert.deepEqual(s.names(), ['ok']);
});

test('B3 a directory junction/symlink named like a store is refused (STORE_PATH_ESCAPE)', (t) => {
  const root = tmp(t);
  const dir = path.join(root, 's');
  const s = mk(dir);
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'CURRENT'), '1');
  fs.writeFileSync(path.join(outside, 'v0001.json'), JSON.stringify({ secret: 'outside' }));
  try { fs.symlinkSync(outside, path.join(dir, 'linked'), 'junction'); }
  catch (e) { t.skip(`cannot create a junction here (${e.code})`); return; }
  for (const name of ['linked']) {
    for (const call of [() => s.current(name), () => s.load(name), () => s.versions(name), () => s.rollback(name, 1), () => s.save(name, {}), () => s.compareAndSave(name, {}, { expectedVersion: 1 })]) {
      assert.equal(capture(call)?.code, 'STORE_PATH_ESCAPE');
    }
  }
  assert.deepEqual(fs.readdirSync(outside).sort(), ['CURRENT', 'v0001.json'], 'nothing was written through the junction');
});

// -------- real HTTP reachability (disposable root, ephemeral loopback port, token mode) --------
async function studioFixture(t, seed) {
  const root = tmp(t, 'aion-p0-http-');
  const paths = dataPaths(root); ensureDataDirs(paths);
  const profileStore = new ProfileStore(paths.profiles);
  profileStore.save('chatgpt', { note: 'v2 for the P0 test' }, 'p0 v2');
  seed?.({ root, paths, profileStore });
  const runtime = { isSessionActive: () => false, close: async () => {}, targets: async () => ({ sites: [], targets: [] }), list: async () => [] };
  const studio = await startStudio({ paths, profileStore, conversationRuntime: runtime, port: 0, accessMode: 'token' });
  t.after(async () => { await studio.close(); });
  const call = async (method, p, body) => {
    const r = await fetch(`http://127.0.0.1:${studio.port}${p}`, { method, headers: { 'content-type': 'application/json', 'x-studio-token': studio.token }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: r.status, json, text };
  };
  return { root, paths, profileStore, studio, call };
}

test('B3 HTTP: encoded traversal through the learned-adapter and profile rollback routes is rejected and moves nothing', async (t) => {
  const f = await studioFixture(t);
  assert.equal(f.profileStore.current('chatgpt'), 2);
  for (const enc of [encodeURIComponent('../profiles/chatgpt'), '%2e%2e%2fprofiles%2fchatgpt', encodeURIComponent('..\\profiles\\chatgpt')]) {
    const r = await f.call('POST', `/api/v1/adapters/learned/${enc}/rollback`, { version: 1, confirm: true, expectedVersion: 2 });
    assert.equal(r.status, 400, `learned rollback ${enc}: ${r.text}`);
    assert.equal(r.json.code, 'STORE_NAME_INVALID');
    const noExpectation = await f.call('POST', `/api/v1/adapters/learned/${enc}/rollback`, { version: 1, confirm: true });
    assert.equal(noExpectation.status, 400); assert.equal(noExpectation.json.code, 'CAS_EXPECTED_VERSION_INVALID', 'the strict expectation is checked before anything else');
  }
  const p = await f.call('POST', `/api/profiles/${encodeURIComponent('../learned-adapters/x')}/rollback`, { version: 1 });
  assert.equal(p.status, 400); assert.equal(p.json.code, 'STORE_NAME_INVALID');
  assert.equal(f.profileStore.current('chatgpt'), 2, 'profile pointer unchanged');
  // legacy profile rollback keeps its pointer-move meaning for valid names
  const ok = await f.call('POST', '/api/profiles/chatgpt/rollback', { version: 1 });
  assert.equal(ok.status, 200);
  assert.equal(f.profileStore.current('chatgpt'), 1);
});

test('B1/B3 HTTP: strict expectedVersion, stale conflict, restore-rollback appends, missing/null expectation is a 400', async (t) => {
  const f = await studioFixture(t, ({ root }) => {
    const seedStore = mk(path.join(root, 'learned-adapters'), { kind: 'learned adapter' });
    const rec = (n) => ({ schema: 'aion.adaptive-webapp-adapter/1', candidate: { siteId: 'site-x', origin: 'https://site-x.test', surface: 'chat' }, adapter: { id: 'site-x', learned: true, readOnly: true, hosts: ['site-x.test'], send: { strategy: 'learned-readonly' }, authority: { sendPermission: false, autoExecution: false }, n }, shadow: {} });
    seedStore.compareAndSave('site-x', rec(1), { expectedVersion: null });
    seedStore.compareAndSave('site-x', rec(2), { expectedVersion: 1 });
  });
  const stale = await f.call('POST', '/api/v1/adapters/learned/site-x/rollback', { version: 1, confirm: true, expectedVersion: 1 });
  assert.equal(stale.status, 409); assert.equal(stale.json.code, 'CAS_VERSION_CONFLICT');
  assert.equal(stale.json.expected, 1, 'LIVE HTTP: the conflict operands reach the client'); assert.equal(stale.json.actual, 2);
  assert.equal('committed' in stale.json, false, 'a conflict is not a committed change');
  const bad = await f.call('POST', '/api/v1/adapters/learned/site-x/rollback', { version: 1, confirm: true, expectedVersion: 'x' });
  assert.equal(bad.status, 400); assert.equal(bad.json.code, 'CAS_EXPECTED_VERSION_INVALID');
  const ok = await f.call('POST', '/api/v1/adapters/learned/site-x/rollback', { version: 1, confirm: true, expectedVersion: 2 });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.version, 3); assert.equal(ok.json.restoredFrom, 1);
  // adversarial: a missing / null / zero / string / float / negative expectation is refused and NOTHING is inferred or written
  for (const body of [{ version: 2, confirm: true }, { version: 2, confirm: true, expectedVersion: null }, { version: 2, confirm: true, expectedVersion: 0 },
    { version: 2, confirm: true, expectedVersion: '3' }, { version: 2, confirm: true, expectedVersion: 3.5 }, { version: 2, confirm: true, expectedVersion: -1 }]) {
    const r = await f.call('POST', '/api/v1/adapters/learned/site-x/rollback', body);
    assert.equal(r.status, 400, JSON.stringify(body) + ' => ' + r.text);
    assert.equal(r.json.code, 'CAS_EXPECTED_VERSION_INVALID');
  }
  const still = await f.call('POST', '/api/v1/adapters/learned/site-x/rollback', { version: 2, confirm: true, expectedVersion: 3 });
  assert.equal(still.status, 200, still.text); assert.equal(still.json.version, 4, 'CURRENT was still 3: no refused call wrote anything');
  // promote: expectedVersion is REQUIRED (null = first create). Refused before any session/evidence work.
  const cand = { candidate: { schema: 'aion.adaptive-webapp-adapter/1' }, sessionIds: [] };
  for (const extra of [{}, { expectedVersion: 0 }, { expectedVersion: '1' }, { expectedVersion: 1.5 }, { expectedVersion: -2 }, { expectedVersion: [] }]) {
    const r = await f.call('POST', '/api/v1/adapters/learned/promote', { ...cand, ...extra });
    assert.equal(r.status, 400, JSON.stringify(extra) + ' => ' + r.text);
    assert.equal(r.json.code, 'CAS_EXPECTED_VERSION_INVALID');
  }
  const passesExpectation = await f.call('POST', '/api/v1/adapters/learned/promote', { candidate: {}, sessionIds: [], expectedVersion: null });
  assert.equal(passesExpectation.status, 400);
  assert.notEqual(passesExpectation.json.code, 'CAS_EXPECTED_VERSION_INVALID', 'null is a valid expectation; it fails later on the candidate, proving the check order');  const missing = await f.call('POST', '/api/v1/adapters/learned/nope/rollback', { version: 1, confirm: true, expectedVersion: 1 });
  assert.equal(missing.status, 409); assert.equal(missing.json.code, 'CAS_VERSION_CONFLICT'); // absent head vs an explicit integer expectation
  assert.equal(missing.json.expected, 1); assert.equal(missing.json.actual, null, 'LIVE HTTP: absent head is reported as actual:null');
  // intelligence rollback: expectedVersion is REQUIRED (missing / null / 0 / string => 400), never coerced
  const scope = { siteId: 'site-y', origin: 'https://site-y.test', targetVersion: 1 };
  for (const body of [scope, { ...scope, expectedVersion: null }, { ...scope, expectedVersion: 0 }, { ...scope, expectedVersion: '1' }]) {
    const r = await f.call('POST', '/api/v1/adapters/intelligence/rollback', body);
    assert.equal(r.status, 400, JSON.stringify(body) + ' => ' + r.text);
    assert.equal(r.json.code, 'CAS_EXPECTED_VERSION_INVALID');
  }
  const noSuch = await f.call('POST', '/api/v1/adapters/intelligence/rollback', { ...scope, expectedVersion: 1 });
  assert.equal(noSuch.status, 409); assert.equal(noSuch.json.code, 'CAS_VERSION_CONFLICT'); // absent head, integer expectation
});

// ============================================================================================ B4
test('B4 wiring: one VersionedStore instance serves the factory and I1; no direct save/rollback or lock code outside the owner', () => {
  const server = fs.readFileSync(path.join(SRC, 'studio/server.mjs'), 'utf8');
  assert.equal((server.match(/new VersionedStore\(/g) ?? []).length, 1, 'exactly one VersionedStore is constructed in server.mjs');
  assert.match(server, /createAdapterFactory\(\{ learnedStore \}\)/);
  assert.match(server, /createStudioLearningPipeline\(\{[^}]*store: learnedStore/);
  const factory = fs.readFileSync(path.join(SRC, 'studio/adapter-factory-service.mjs'), 'utf8');
  assert.equal(/learnedStore\.(save|rollback)\(/.test(factory), false, 'the factory has no direct save/rollback bypass');
  assert.match(factory, /learnedStore\.compareAndSave\(/); assert.match(factory, /learnedStore\.compareAndRollback\(/);
  const pipeline = fs.readFileSync(path.join(SRC, 'studio/adapter-learning-pipeline.mjs'), 'utf8');
  assert.equal(/\b(openSync|unlinkSync|fsyncSync|closeSync|renameSync)\b/.test(pipeline), false, 'I1 has no lock/file code of its own');
  assert.match(pipeline, /store\.compareAndSave\(/); assert.match(pipeline, /store\.compareAndRollback\(/);
});

test('B4 factory and I1 share one lock namespace: a concurrent writer on the same name gets CAS_LOCKED, never a corrupt write', async (t) => {
  const dir = path.join(tmp(t), 'learned-adapters');
  const name = i1Name('scope-k');
  let inner = 'not-run';
  const other = mk(dir, { lockWaitMs: 0 }); // a second owner instance (e.g. another process) over the same directory
  const spy = spyIo({ rename: (a) => { if (isCurrentTmp(a)) inner = capture(() => other.compareAndSave(name, ro(99), { expectedVersion: null })); } });
  const first = mk(dir, { io: spy.io });
  assert.equal(first.compareAndSave(name, ro(1), { expectedVersion: null }).version, 1);
  assert.equal(inner?.code, 'CAS_LOCKED', 'concurrent writer is refused while the lock is held (distinct from a version conflict)');
  const cas = createCasVersionedStore({ store: other });
  assert.equal((await captureAsync(() => cas.promote('scope-k', ro(2), null)))?.code, 'CAS_VERSION_CONFLICT', 'after release the loser classifies as a stale conflict');
  assert.equal((await cas.promote('scope-k', ro(2), 1)).version, 2);
  assert.deepEqual(lockFiles(dir), []);
  assert.equal(other.versions(name).length, 2);
});

function fakeSession(id) {
  const url = 'https://127.0.0.1:8443/chat?chatID=4a945005-1c2d-4e3f-8a9b-0c1d2e3f4a5b';
  const turns = [
    { index: 0, domId: 'div.bubble[data-role=user]', role: 'user', roleAttribute: 'data-role', text: 'prompt text' },
    { index: 1, domId: 'div.bubble[data-role=assistant]', role: 'assistant', roleAttribute: 'data-role', text: 'reply text' },
  ];
  const kv = new Map(Object.entries({ DOM_TURNS: turns, ASSEMBLED: { a: { endpoint: 'POST /api/chat' } }, RECEIPT: { pageUrl: url } }));
  return { id, kv: { get: (k, d) => (kv.has(k) ? kv.get(k) : d) }, meta: { target: { url } } };
}

test('B4 factory promote/rollback use the shared owner: strict, restore-style, restart-safe, data-only and read-only', async (t) => {
  const dir = path.join(tmp(t), 'learned-adapters');
  const store = new VersionedStore(dir, { kind: 'learned adapter' });
  const factory = createAdapterFactory({ learnedStore: store });
  const ORIGIN = 'https://127.0.0.1:8443';
  const training = [fakeSession('t1'), fakeSession('t2'), fakeSession('t3')]; const heldout = [fakeSession('h1')];
  const { candidate } = factory.synthesize({ siteId: 'fixture-chat', origin: ORIGIN, sessions: training });

  // promote: expectedVersion is REQUIRED and strict (null = first create, integer = must equal CURRENT); never inferred
  const v1 = factory.promote({ candidate, sessions: heldout, expectedVersion: null });
  assert.equal(v1.version, 1);
  assert.equal(capture(() => factory.promote({ candidate, sessions: heldout, expectedVersion: null }))?.code, 'CAS_VERSION_CONFLICT');
  assert.equal(capture(() => factory.promote({ candidate, sessions: heldout }))?.code, 'CAS_EXPECTED_VERSION_INVALID', 'omitted expectation is refused, not inferred');
  for (const bad of [undefined, 0, '1', NaN, 1.5, -1, STORE_MAX_VERSION + 1, [], {}]) {
    assert.equal(capture(() => factory.promote({ candidate, sessions: heldout, expectedVersion: bad }))?.code, 'CAS_EXPECTED_VERSION_INVALID', `promote expected=${String(bad)}`);
  }
  assert.equal(capture(() => factory.promote({ candidate: null, sessions: [] }))?.code, 'CAS_EXPECTED_VERSION_INVALID', 'checked before any candidate/evidence work');
  assert.equal(store.current('fixture-chat'), 1, 'refused calls wrote nothing');
  assert.equal(factory.promote({ candidate, sessions: heldout, expectedVersion: 1 }).version, 2);
  assert.equal(capture(() => factory.promote({ candidate, sessions: heldout, expectedVersion: 1 }))?.code, 'CAS_VERSION_CONFLICT', 'stale explicit expectation');

  // rollback: integer expectedVersion REQUIRED; appends a restoring version; stale conflicts; ABA closed
  for (const bad of [undefined, null, 0, '2', NaN, 1.5, -1]) {
    assert.equal(capture(() => factory.rollback('fixture-chat', 1, { expectedVersion: bad }))?.code, 'CAS_EXPECTED_VERSION_INVALID', `rollback expected=${String(bad)}`);
  }
  assert.equal(capture(() => factory.rollback('fixture-chat', 1))?.code, 'CAS_EXPECTED_VERSION_INVALID', 'omitted options refused');
  assert.equal(capture(() => factory.rollback('fixture-chat', 1, { expectedVersion: 1 }))?.code, 'CAS_VERSION_CONFLICT');
  assert.equal(store.current('fixture-chat'), 2);
  const rb = factory.rollback('fixture-chat', 1, { expectedVersion: 2 });
  assert.equal(rb.version, 3); assert.equal(rb.restoredFrom, 1);
  assert.equal(capture(() => factory.promote({ candidate, sessions: heldout, expectedVersion: 1 }))?.code, 'CAS_VERSION_CONFLICT', 'stale base 1 stays stale after the rollback');
  const absent = capture(() => factory.rollback('nope', 1, { expectedVersion: 1 }));
  assert.equal(absent?.code, 'CAS_VERSION_CONFLICT'); assert.equal(absent.actual, null);
  assert.equal(capture(() => factory.rollback('../profiles/chatgpt', 1, { expectedVersion: 1 }))?.code, 'STORE_NAME_INVALID');
  // restart: a new store + factory over the same directory continues from disk, stale expectations still fail closed
  const factory2 = createAdapterFactory({ learnedStore: new VersionedStore(dir, { kind: 'learned adapter' }) });
  assert.equal(factory2.loadRecord('fixture-chat').version, 3);
  assert.equal(capture(() => factory2.promote({ candidate, sessions: heldout, expectedVersion: 2 }))?.code, 'CAS_VERSION_CONFLICT');
  assert.equal(capture(() => factory2.promote({ candidate, sessions: heldout }))?.code, 'CAS_EXPECTED_VERSION_INVALID', 'a restart does not make an omitted expectation acceptable');
  assert.equal(factory2.promote({ candidate, sessions: heldout, expectedVersion: 3 }).version, 4);

  // learned adapters are data-only, read-only, never a send grant
  const loaded = factory2.loadLearned('fixture-chat');
  assert.equal(loaded.readOnly, true); assert.equal(loaded.send.strategy, 'learned-readonly');
  assert.equal(loaded.authority.sendPermission, false); assert.equal(loaded.authority.autoExecution, false); assert.equal(loaded.composer, undefined);
  setLearnedAdapterProvider(factory2.registryProvider());
  t.after(() => setLearnedAdapterProvider(null));
  const writable = await getAdapter('fixture-chat');
  assert.ok(!writable || writable.learned !== true, 'the writable getAdapter never returns a learned adapter');
  assert.equal(fs.existsSync(path.join(dir, '.locks')) ? fs.readdirSync(path.join(dir, '.locks')).length : 0, 0);
});

test('B4 namespaces stay separate: the factory refuses, skips and never reads I1-owned names; I1 never touches factory ids', async (t) => {
  const dir = path.join(tmp(t), 'learned-adapters');
  const store = new VersionedStore(dir, { kind: 'learned adapter' });
  const factory = createAdapterFactory({ learnedStore: store });
  const cas = createCasVersionedStore({ store });
  await cas.promote('scope-k', ro(1), null);
  const reservedName = i1Name('scope-k');
  const { candidate } = factory.synthesize({ siteId: 'fixture-chat', origin: 'https://127.0.0.1:8443', sessions: [fakeSession('t1'), fakeSession('t2'), fakeSession('t3')] });
  factory.promote({ candidate, sessions: [fakeSession('h1')], expectedVersion: null });
  assert.deepEqual(factory.list().map((x) => x.name), ['fixture-chat'], 'I1 records are not in the factory list');
  assert.equal(factory.loadLearned(reservedName), null);
  assert.equal(factory.loadRecord(reservedName), null);
  assert.equal(capture(() => factory.rollback(reservedName, 1))?.code, 'CAS_EXPECTED_VERSION_INVALID', 'strict expectation is checked first');
  const e1 = capture(() => factory.rollback(reservedName, 1, { expectedVersion: 1 }));
  assert.ok(e1 instanceof AdapterFactoryError && e1.code === 'RESERVED_NAMESPACE');
  const e2 = capture(() => factory.promote({ candidate: { ...candidate, siteId: reservedName }, sessions: [fakeSession('h1')], expectedVersion: null }));
  assert.ok(e2 instanceof AdapterFactoryError && e2.code === 'RESERVED_NAMESPACE');
  const e3 = capture(() => factory.promote({ candidate: { ...candidate, siteId: '../evil' }, sessions: [fakeSession('h1')], expectedVersion: null }));
  assert.equal(e3?.code, 'STORE_NAME_INVALID');
  assert.equal(store.current(reservedName), 1, 'I1 record untouched by the factory');
  assert.deepEqual(store.names().sort(), ['fixture-chat', reservedName].sort());
  // a corrupt factory head is "not available" on the read view but still blocks a first-create
  fs.writeFileSync(path.join(dir, 'fixture-chat', 'v0001.json'), 'garbage');
  assert.equal(factory.loadLearned('fixture-chat'), null);
  assert.equal(capture(() => factory.promote({ candidate, sessions: [fakeSession('h1')], expectedVersion: null }))?.code, 'CAS_VERSION_CONFLICT');
  assert.equal(factory.list().find((x) => x.name === 'fixture-chat').summary, null);
});

// ============================================================================================ reviewer-driven safety corrections
test('S1 a record must belong to the (name, version) it is stored under; NTFS name case is tolerated', (t) => {
  const dir = path.join(tmp(t), 's');
  const s = mk(dir);
  s.compareAndSave('Case', { v: 1 }, { expectedVersion: null });
  assert.equal(s.load('case').v, 1, 'case-insensitive access to a stored record still works');
  s.compareAndSave('n', { v: 1 }, { expectedVersion: null });
  s.compareAndSave('n', { v: 2 }, { expectedVersion: 1 });
  const v2 = path.join(dir, 'n', 'v0002.json');
  const original = fs.readFileSync(v2, 'utf8');
  for (const forged of [{ ...JSON.parse(original), name: 'other' }, { ...JSON.parse(original), version: 1 }, { ...JSON.parse(original), version: '2' }, [], 'str', null, { v: 2 }]) {
    fs.writeFileSync(v2, JSON.stringify(forged));
    assert.equal(capture(() => s.load('n'))?.code, 'STORE_RECORD_CORRUPT', JSON.stringify(forged)?.slice(0, 50));
    assert.equal(capture(() => s.compareAndRollback('n', 2, { expectedVersion: 2 }))?.code, 'STORE_RECORD_CORRUPT');
    assert.equal(capture(() => s.rollback('n', 2))?.code, 'STORE_RECORD_CORRUPT');
  }
  assert.equal(s.current('n'), 2, 'a refused read never moves the pointer');
});

test('S3 durable-commit and CAS facts survive the HTTP error mapping', () => {
  const committed = Object.assign(new Error('lock release unverified'), { code: 'CAS_LOCK_RELEASE_UNVERIFIED', committed: true, committedVersion: 7, releaseError: { code: 'EPERM' } });
  const p = storeProblem(committed);
  assert.equal(p.status, 500); assert.equal(p.code, 'CAS_LOCK_RELEASE_UNVERIFIED'); assert.equal(p.committed, true); assert.equal(p.committedVersion, 7);
  assert.deepEqual(storeFields(committed), { committed: true, committedVersion: 7 });
  const conflict = Object.assign(new Error('c'), { code: 'CAS_VERSION_CONFLICT', expected: null, actual: 3 });
  assert.deepEqual(storeFields(conflict), { expected: null, actual: 3 });
  assert.equal(storeProblem(conflict).status, 409);
  assert.equal(storeProblem(Object.assign(new Error('x'), { code: 'CAS_LOCKED' })).status, 423);
  const plain = new Error('boom'); assert.equal(storeProblem(plain), plain, 'unrelated errors pass through untouched');
  const withStatus = Object.assign(new Error('s'), { status: 418, code: 'CAS_LOCKED' }); assert.equal(storeProblem(withStatus), withStatus);
  assert.deepEqual(storeFields(Object.assign(new Error('x'), { committed: 'yes' })), {}, 'only a literal true counts as committed');
  for (const code of Object.keys(STORE_ERROR_STATUS)) assert.ok(Number.isInteger(STORE_ERROR_STATUS[code]));
  const server = fs.readFileSync(path.join(SRC, 'studio/server.mjs'), 'utf8');
  assert.match(server, /storeFields\(e\)/, 'the top-level (non /api/v1) error body also carries them; /api/v1 is covered by the hub tests below and the live HTTP test');
});

test('S4 a symlinked/junctioned .locks directory is refused', (t) => {
  const root = tmp(t); const dir = path.join(root, 's');
  const s = mk(dir);
  const elsewhere = path.join(root, 'elsewhere'); fs.mkdirSync(elsewhere, { recursive: true });
  try { fs.symlinkSync(elsewhere, path.join(dir, '.locks'), 'junction'); }
  catch (e) { t.skip(`cannot create a junction here (${e.code})`); return; }
  assert.equal(capture(() => s.compareAndSave('n', {}, { expectedVersion: null }))?.code, 'STORE_PATH_ESCAPE');
  assert.deepEqual(fs.readdirSync(elsewhere), [], 'no lock was written through the junction');
  assert.equal(s.current('n'), null);
});

test('S3 the REAL hub response writer carries committed/CAS facts (hub-level: errors are INJECTED through a stub factory; this is not a live committed failure)', async (t) => {
  const root = tmp(t, 'aion-p0-hub-');
  const paths = dataPaths(root); ensureDataDirs(paths);
  let thrown;
  const adapterFactory = { rollback() { throw thrown; }, list() { return []; } };
  const recorder = { on() {}, off() {}, state: 'idle' };
  const hub = createIntegrationHub({ paths, profileStore: new ProfileStore(paths.profiles), recorder, getPort: () => 0, adapterFactory });
  t.after(() => hub.close());
  const call = async () => {
    const sent = {};
    const res = { headersSent: false, destroyed: false, writableEnded: false, setHeader() {}, writeHead(s) { sent.status = s; }, end(b) { sent.body = JSON.parse(b); this.writableEnded = true; } };
    const handled = await hub.handle({ method: 'POST' }, res, new URL('http://127.0.0.1:1/api/v1/adapters/learned/site-x/rollback'), { version: 1, confirm: true, expectedVersion: 2 });
    assert.equal(handled, true);
    return sent;
  };
  thrown = Object.assign(new Error('lock release unverified after a committed change'), { code: 'CAS_LOCK_RELEASE_UNVERIFIED', committed: true, committedVersion: 4, releaseError: { code: 'EPERM', message: 'private detail' } });
  const durable = await call();
  assert.equal(durable.status, 500);
  assert.equal(durable.body.code, 'CAS_LOCK_RELEASE_UNVERIFIED');
  assert.equal(durable.body.committed, true, 'the client is told the change is durable');
  assert.equal(durable.body.committedVersion, 4);
  assert.equal('releaseError' in durable.body, false, 'internal cleanup detail is not exposed');
  thrown = Object.assign(new Error('CAS_VERSION_CONFLICT'), { code: 'CAS_VERSION_CONFLICT', expected: 2, actual: 5 });
  const conflict = await call();
  assert.equal(conflict.status, 409); assert.equal(conflict.body.expected, 2); assert.equal(conflict.body.actual, 5); assert.equal('committed' in conflict.body, false);
  thrown = Object.assign(new Error('boom'), { code: 'SOMETHING_ELSE', committed: 'yes' });
  const other = await call();
  assert.equal(other.status, 500); assert.equal('committed' in other.body, false, 'only a literal committed:true counts');
  const hubSource = fs.readFileSync(path.join(SRC, 'studio/integration-hub.mjs'), 'utf8');
  assert.match(hubSource, /\.\.\.storeFields\(e\)/, 'the hub error writer spreads storeFields');
});

// ---- lock acquisition under Windows sharing races (issue #81, independent run: raw EPERM in the cross-entry probe)
for (const code of ['EPERM', 'EBUSY', 'EACCES']) {
  test(`B2 acquire: a transient ${code} on the exclusive create (existsSync flickering FALSE) is retried within the wait and then succeeds`, (t) => {
    const dir = path.join(tmp(t), 's'); let failures = 3; let attempts = 0;
    const spy = spyIo({ openBefore: (p) => { if (isLock(p)) { attempts++; if (failures-- > 0) throw injected(code); } }, exists: (p) => (isLock(p) ? false : undefined) });
    const s = mk(dir, { io: spy.io, lockWaitMs: 2000, lockRetryMs: 1 });
    const rec = s.compareAndSave('n', { v: 1 }, { expectedVersion: null });
    assert.equal(rec.version, 1);
    assert.equal(attempts, 4, '3 transient refusals + 1 success; judged by the error code, not by existsSync');
    assert.equal(spy.open.size, 0);
    assert.deepEqual(lockFiles(dir), [], 'the lock this operation created was released');
  });
}

test('B2 acquire: a transient code that never clears while NO lock exists surfaces the ORIGINAL error (annotated, bounded), never disguised as busy', (t) => {
  const dir = path.join(tmp(t), 's'); let attempts = 0;
  const spy = spyIo({ openBefore: (p) => { if (isLock(p)) { attempts++; throw injected('EPERM'); } }, exists: (p) => (isLock(p) ? false : undefined) });
  const s = mk(dir, { io: spy.io, lockWaitMs: 40, lockRetryMs: 1 });
  const e = capture(() => s.compareAndSave('n', { v: 1 }, { expectedVersion: null }));
  assert.equal(e?.code, 'EPERM'); assert.equal(e.injected, true, 'the original error object');
  assert.ok(e.lockAttempts >= 2 && e.lockAttempts === attempts, `retried before giving up (attempts=${attempts})`);
  assert.ok(attempts <= 60, `bounded by lockWaitMs/lockRetryMs, not unbounded (attempts=${attempts})`);
  assert.equal(s.current('n'), null, 'nothing written');
  assert.equal(spy.open.size, 0);
  assert.deepEqual(lockFiles(dir), []);
});

test('B2 acquire: a persistent transient code while a REAL foreign lock exists => CAS_LOCKED with the OS cause; the foreign lock is never touched', (t) => {
  const dir = path.join(tmp(t), 's');
  const lockPath = mk(dir).lockPath('n');
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const foreign = JSON.stringify({ schema: STORE_LOCK_SCHEMA, token: 'e'.repeat(32), pid: 1, name: 'n', op: 'save', at: '2020-01-01T00:00:00.000Z' });
  fs.writeFileSync(lockPath, foreign);
  const spy = spyIo({ openBefore: (p) => { if (isLock(p)) throw injected('EPERM'); } });
  const s = mk(dir, { io: spy.io, lockWaitMs: 40, lockRetryMs: 1 });
  const e = capture(() => s.compareAndSave('n', { v: 1 }, { expectedVersion: null }));
  assert.equal(e?.code, 'CAS_LOCKED'); assert.equal(e.cause?.code, 'EPERM'); assert.ok(e.attempts >= 2);
  assert.equal(fs.readFileSync(lockPath, 'utf8'), foreign, 'never deleted, replaced or rewritten');
  // plain EEXIST keeps its meaning and now also reports the cause and attempts
  const plain = mk(dir, { lockWaitMs: 20, lockRetryMs: 1 });
  const busy = capture(() => plain.compareAndSave('n', { v: 1 }, { expectedVersion: null }));
  assert.equal(busy?.code, 'CAS_LOCKED'); assert.equal(busy.cause?.code, 'EEXIST'); assert.ok(busy.attempts >= 2);
  assert.equal(fs.readFileSync(lockPath, 'utf8'), foreign);
});

test('B2 acquire: lockWaitMs 0 is a single attempt; non-transient open errors are never retried', (t) => {
  for (const [code, expectCode, expectAttempts] of [['EPERM', 'EPERM', 1], ['EEXIST', 'CAS_LOCKED', 1], ['ENOSPC', 'ENOSPC', 1], ['EIO', 'EIO', 1], ['ENOENT', 'ENOENT', 1]]) {
    const dir = path.join(tmp(t), 's'); let attempts = 0;
    const spy = spyIo({ openBefore: (p) => { if (isLock(p)) { attempts++; throw injected(code); } }, exists: (p) => (isLock(p) ? false : undefined) });
    const e = capture(() => mk(dir, { io: spy.io, lockWaitMs: 0 }).compareAndSave('n', { v: 1 }, { expectedVersion: null }));
    assert.equal(e?.code, expectCode, `${code} -> ${expectCode}`);
    assert.equal(attempts, expectAttempts, `${code}: exactly one attempt`);
  }
  for (const code of ['ENOSPC', 'EIO', 'ENOENT']) {
    const dir = path.join(tmp(t), 's'); let attempts = 0;
    const spy = spyIo({ openBefore: (p) => { if (isLock(p)) { attempts++; throw injected(code); } } });
    const e = capture(() => mk(dir, { io: spy.io, lockWaitMs: 500, lockRetryMs: 1 }).compareAndSave('n', { v: 1 }, { expectedVersion: null }));
    assert.equal(e?.code, code); assert.equal(attempts, 1, `${code} is permanent: not retried even with a long wait`);
  }
});