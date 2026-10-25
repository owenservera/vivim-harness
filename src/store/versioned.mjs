// Generic versioned JSON store: every save is a new immutable vNNNN.json, CURRENT points at the
// active version. Used by site profiles, provider families and the learned read-only adapters.
//
// This file is the SINGLE OWNER of persistence for every store built on it (issue #81 P0):
//   - name and version grammar are validated on EVERY method (read and write), with containment;
//   - every mutation takes one per-name cross-process lock under <dir>/.locks (never stolen);
//   - compareAndSave / compareAndRollback give strict expected-version semantics
//     (null = must not exist, integer = must equal CURRENT, anything else is rejected);
//   - CAS rollback APPENDS a restoring version, so CURRENT only moves forward (no ABA);
//   - the optional `io` seam (same pattern as conversation-service / thread-turn-journal) lets
//     tests inject deterministic write/fsync/close/rename/unlink faults into THIS code.
// Legacy save()/rollback() keep their old meaning for profiles and families (no migration), but
// are validated, locked and atomic too. Locks are never auto-cleared: a crashed holder fails
// closed (CAS_LOCKED) until an operator inspects it (inspectLock) and releases it by token
// (releaseStaleLock). Critical sections are synchronous.
import {
  openSync, writeFileSync, fsyncSync, closeSync, renameSync, unlinkSync,
  readFileSync, existsSync, readdirSync, mkdirSync, lstatSync, realpathSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

export const STORE_MAX_VERSION = 9999;
export const STORE_LOCK_SCHEMA = 'aion.versioned-store-lock/1';
/** Names owned by the I1 learning pipeline in the shared learned-adapter store (`i1-` + 40 hex). */
export const I1_NAMESPACE_RE = /^i1-[0-9a-f]{40}$/;

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const DEVICE_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const VERSION_FILE_RE = /^v(\d{4})\.json$/;
const CURRENT_RE = /^[1-9][0-9]{0,3}$/;
const TOKEN_RE = /^[0-9a-f]{32}$/;
const TRANSIENT_FS = new Set(['EPERM', 'EBUSY', 'EACCES']); // Windows sharing / delete-pending / antivirus races
const IO_KEYS = ['openSync', 'writeFileSync', 'fsyncSync', 'closeSync', 'renameSync', 'unlinkSync',
  'readFileSync', 'existsSync', 'readdirSync', 'mkdirSync', 'lstatSync', 'realpathSync'];
const DEFAULT_IO = { openSync, writeFileSync, fsyncSync, closeSync, renameSync, unlinkSync,
  readFileSync, existsSync, readdirSync, mkdirSync, lstatSync, realpathSync };

const pad = (n) => String(n).padStart(4, '0');
const coded = (code, message, extra = {}) => Object.assign(new Error(message ?? code), { code, ...extra });
const brief = (x) => { const s = typeof x === 'string' ? x : JSON.stringify(x); return String(s).slice(0, 80); };
const sameFile = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
const sleepCell = new Int32Array(new SharedArrayBuffer(4));
const sleep = (ms) => { if (ms > 0) Atomics.wait(sleepCell, 0, 0, ms); };
const errInfo = (e) => ({ code: e?.code ?? null, message: String(e?.message ?? e).slice(0, 160) });
const attach = (err, key, value) => { if (err && typeof err === 'object') { try { err[key] = value; } catch { /* frozen */ } } };

/** Store-name grammar shared by every method that takes a name. */
export function validateStoreName(name, kind = 'item') {
  if (typeof name !== 'string' || !NAME_RE.test(name) || name.endsWith('.') || DEVICE_RE.test(name.split('.')[0])) {
    throw coded('STORE_NAME_INVALID', `invalid ${kind} name: ${brief(name)}`);
  }
  return name;
}

/** Versions are JS numbers that are integers in 1..9999 (strings, floats, NaN, 0, null are refused). */
export function validateStoreVersion(version, kind = 'item') {
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1 || version > STORE_MAX_VERSION) {
    throw coded('STORE_VERSION_INVALID', `invalid ${kind} version: ${brief(version)}`);
  }
  return version;
}

/** The single expectedVersion rule: null (only when allowNull) = must not exist; integer 1..9999 = must equal CURRENT; everything else, including undefined, is refused. */
export function validateExpectedVersion(expectedVersion, { allowNull }) {
  const ok = (allowNull && expectedVersion === null) ||
    (typeof expectedVersion === 'number' && Number.isSafeInteger(expectedVersion) && expectedVersion >= 1 && expectedVersion <= STORE_MAX_VERSION);
  if (!ok) {
    throw coded('CAS_EXPECTED_VERSION_INVALID',
      `expectedVersion must be ${allowNull ? 'null (must not exist) or ' : ''}an integer 1..${STORE_MAX_VERSION}; got ${brief(expectedVersion === undefined ? 'undefined' : expectedVersion)}`);
  }
  return expectedVersion;
}

export class VersionedStore {
  constructor(dir, { builtinDir, normalize = (x) => x, kind = 'item', io, lockWaitMs = 500, lockRetryMs = 5 } = {}) {
    this.dir = dir;
    this.normalize = normalize;
    this.kind = kind;
    this.io = { ...DEFAULT_IO };
    for (const k of IO_KEYS) if (io && typeof io[k] === 'function') this.io[k] = io[k];
    this.lockWaitMs = Number.isFinite(lockWaitMs) && lockWaitMs >= 0 ? lockWaitMs : 500;
    this.lockRetryMs = Number.isFinite(lockRetryMs) && lockRetryMs > 0 ? lockRetryMs : 5;
    this.io.mkdirSync(dir, { recursive: true });
    if (builtinDir && this.io.existsSync(builtinDir)) {
      for (const f of this.io.readdirSync(builtinDir).filter((x) => x.endsWith('.json'))) {
        const p = JSON.parse(this.io.readFileSync(path.join(builtinDir, f), 'utf8'));
        validateStoreName(p.name, kind);
        if (this.io.existsSync(path.join(this.dir, p.name))) continue;
        try { this.compareAndSave(p.name, p, { expectedVersion: null, changeNote: `seeded from built-in ${f}` }); }
        catch (e) { if (e?.code !== 'CAS_VERSION_CONFLICT') throw e; } // another process seeded it first
      }
    }
  }

  // ---------------------------------------------------------------- paths and validation
  #dirFor(name) {
    validateStoreName(name, this.kind);
    const root = path.resolve(this.dir);
    const d = path.join(root, name);
    if (!sameFile(path.dirname(d), root)) throw coded('STORE_PATH_ESCAPE', `${this.kind} name escapes the store: ${brief(name)}`);
    let st = null;
    try { st = this.io.lstatSync(d); } catch (e) { if (e?.code !== 'ENOENT') throw e; }
    if (st) {
      if (st.isSymbolicLink() || !st.isDirectory()) throw coded('STORE_PATH_ESCAPE', `${this.kind} directory is not a plain directory: ${brief(name)}`);
      const real = this.io.realpathSync(d);
      const realRoot = this.io.realpathSync(root);
      if (!sameFile(path.dirname(real), realRoot)) throw coded('STORE_PATH_ESCAPE', `${this.kind} directory resolves outside the store: ${brief(name)}`);
    }
    return d;
  }

  #versionFile(d, version) { return path.join(d, `v${pad(version)}.json`); }

  #versionFileNumbers(d) {
    if (!this.io.existsSync(d)) return [];
    return this.io.readdirSync(d).map((f) => VERSION_FILE_RE.exec(f)).filter(Boolean).map((m) => Number(m[1])).sort((a, b) => a - b);
  }

  #readCurrent(d, name) {
    const c = path.join(d, 'CURRENT');
    if (!this.io.existsSync(c)) return null;
    const raw = String(this.io.readFileSync(c, 'utf8')).trim();
    if (!CURRENT_RE.test(raw)) throw coded('STORE_CURRENT_CORRUPT', `${this.kind} ${name} has an invalid CURRENT pointer`, { name });
    return Number(raw);
  }

  /** Raw CURRENT integer (never the parsed record) with a consistency check on its version file. */
  #head(d, name) {
    const v = this.#readCurrent(d, name);
    if (v !== null && !this.io.existsSync(this.#versionFile(d, v))) {
      throw coded('STORE_CURRENT_CORRUPT', `${this.kind} ${name} CURRENT names missing version ${v}`, { name, current: v });
    }
    return v;
  }

  #readRaw(d, name, version) {
    const p = this.#versionFile(d, version);
    if (!this.io.existsSync(p)) throw coded('STORE_NO_SUCH_VERSION', `${this.kind} ${name} has no version ${version}.`, { name, version });
    let rec;
    try { rec = JSON.parse(this.io.readFileSync(p, 'utf8')); }
    catch { throw coded('STORE_RECORD_CORRUPT', `${this.kind} ${name} version ${version} is unreadable`, { name, version }); }
    // A record must belong to the (name, version) it is stored under (NTFS names are case-insensitive).
    if (!rec || typeof rec !== 'object' || typeof rec.name !== 'string' || rec.name.toLowerCase() !== name.toLowerCase() || rec.version !== version) {
      throw coded('STORE_RECORD_CORRUPT', `${this.kind} ${name} version ${version} carries a foreign or inconsistent identity`, { name, version });
    }
    return rec;
  }

  // ---------------------------------------------------------------- reads (all validated)
  names() {
    return this.io.readdirSync(this.dir)
      .filter((d) => !d.startsWith('.') && NAME_RE.test(d) && !d.endsWith('.') && !DEVICE_RE.test(d.split('.')[0]) && this.io.existsSync(path.join(this.dir, d, 'CURRENT')))
      .sort();
  }

  versions(name) {
    const d = this.#dirFor(name);
    return this.#versionFileNumbers(d).map((version) => {
      try {
        const p = JSON.parse(this.io.readFileSync(this.#versionFile(d, version), 'utf8'));
        return { version, savedAt: p.savedAt, note: p.changeNote };
      } catch { return { version, savedAt: null, note: null, corrupt: true }; }
    });
  }

  current(name) {
    const d = this.#dirFor(name);
    return this.#readCurrent(d, name);
  }

  has(name) { return this.current(name) !== null; }

  load(name, version) {
    const d = this.#dirFor(name);
    let v;
    if (version === undefined) {
      v = this.#readCurrent(d, name);
      if (v === null) throw coded('STORE_NO_SUCH_ITEM', `No ${this.kind} "${name}".`, { name });
    } else {
      v = validateStoreVersion(version, this.kind);
    }
    return this.normalize(this.#readRaw(d, name, v));
  }

  // ---------------------------------------------------------------- lock (one owner)
  lockPath(name) {
    validateStoreName(name, this.kind);
    return path.join(path.resolve(this.dir), '.locks', `${name.toLowerCase()}.lock`);
  }

  /** Close a descriptor EXACTLY ONCE. Returns null, or the close error (never throws, never retries):
   *  after a failed close(2)/CloseHandle the descriptor number is already released (or must be assumed so) and may be
   *  reused by another open in this process, so a second close or an fstat probe could hit someone else's
   *  descriptor - a worse failure than the bounded leak of a descriptor the OS could not close. The error is
   *  reported to the caller as a failure of the operation (fail closed). */
  #closeOnce(fd) {
    try { this.io.closeSync(fd); return null; } catch (e) { return e; }
  }
  #acquire(name, op) {
    const lock = this.lockPath(name);
    const lockDir = path.dirname(lock);
    this.io.mkdirSync(lockDir, { recursive: true });
    if (this.io.lstatSync(lockDir).isSymbolicLink()) throw coded('STORE_PATH_ESCAPE', 'the lock directory is a symlink/junction', { name });
    const token = randomBytes(16).toString('hex');
    const body = JSON.stringify({ schema: STORE_LOCK_SCHEMA, token, pid: process.pid, name, op, at: new Date().toISOString() });
    const deadline = Date.now() + this.lockWaitMs;
    let attempts = 0;
    for (;;) {
      let fd;
      attempts++;
      try { fd = this.io.openSync(lock, 'wx', 0o600); }
      catch (e) {
        // EEXIST = a live lock. On Windows a lock another process is deleting (delete-pending) or briefly sharing-violating
        // surfaces as EPERM/EBUSY/EACCES while existsSync flickers true/false, so those codes are retried unconditionally
        // (they are NOT judged by an independent existsSync). We only ever retry the SAME exclusive create: an existing
        // lock is never deleted, replaced or rewritten.
        const transient = TRANSIENT_FS.has(e?.code);
        if (e?.code !== 'EEXIST' && !transient) throw e;
        if (Date.now() >= deadline) {
          // Out of time. A lock that is there (or a plain EEXIST) is busy => CAS_LOCKED, keeping the OS cause. A transient
          // code that never cleared while NO lock exists looks like a real permission/sharing fault: surface the ORIGINAL
          // error (annotated), so it is never disguised as a busy lock.
          if (e.code === 'EEXIST' || this.io.existsSync(lock)) {
            throw coded('CAS_LOCKED', `${this.kind} "${name}" is locked by another operation`, { name, lockPath: lock, attempts, cause: errInfo(e) });
          }
          attach(e, 'lockAttempts', attempts);
          throw e;
        }
        sleep(this.lockRetryMs);
        continue;
      }
      // The lock file now exists and was created by THIS operation. Close the descriptor on every path.
      let failure;
      try { this.io.writeFileSync(fd, body); this.io.fsyncSync(fd); } catch (e) { failure = e; }
      const closeErr = this.#closeOnce(fd); // ALWAYS close (once), even after a write/fsync failure
      failure ??= closeErr ?? undefined;
      if (failure) {
        try { this.io.unlinkSync(lock); } catch (u) { attach(failure, 'releaseError', errInfo(u)); } // creation-owned cleanup
        throw failure; // original error, never replaced by cleanup problems
      }
      return { token, lock, name };
    }
  }

  /** Remove the lock only if it still carries OUR token. Returns null when released, else a reason. */
  #release(h) {
    let rec;
    try { rec = JSON.parse(this.io.readFileSync(h.lock, 'utf8')); }
    catch (e) { return { code: 'CAS_LOCK_RELEASE_UNVERIFIED', message: `lock file unreadable (${e?.code ?? 'parse'}); left in place` }; }
    if (rec?.token !== h.token) return { code: 'CAS_LOCK_RELEASE_UNVERIFIED', message: 'lock token mismatch (not owned by this operation); left in place' };
    try { this.io.unlinkSync(h.lock); } catch (e) { return { code: 'CAS_LOCK_RELEASE_UNVERIFIED', message: `unlink failed (${e?.code ?? 'error'})` }; }
    return null;
  }

  #withLock(name, op, fn) {
    const h = this.#acquire(name, op);
    let result; let threw = false; let primary;
    try { result = fn(); } catch (e) { threw = true; primary = e; }
    const released = this.#release(h);
    if (threw) {
      if (released) attach(primary, 'releaseError', released);
      throw primary;
    }
    if (released) {
      throw coded('CAS_LOCK_RELEASE_UNVERIFIED', `lock release unverified after a committed change: ${released.message}`,
        { name, lockPath: h.lock, committed: true, committedVersion: result?.version ?? null, releaseError: released });
    }
    return result;
  }

  // ---------------------------------------------------------------- atomic file writes
  #writeNew(file, text) {
    let fd;
    try { fd = this.io.openSync(file, 'wx', 0o600); }
    catch (e) {
      if (e?.code === 'EEXIST') throw coded('STORE_VERSION_EXISTS', `refusing to overwrite ${path.basename(file)}`);
      throw e;
    }
    let failure;
    try { this.io.writeFileSync(fd, text); this.io.fsyncSync(fd); } catch (e) { failure = e; }
    const closeErr = this.#closeOnce(fd); // ALWAYS close (once), even after a write/fsync failure
      failure ??= closeErr ?? undefined;
    if (failure) {
      try { this.io.unlinkSync(file); } catch (u) { attach(failure, 'cleanupError', errInfo(u)); }
      throw failure;
    }
  }

  #setCurrent(d, version) {
    const tmp = path.join(d, `CURRENT.${randomBytes(8).toString('hex')}.tmp`);
    this.#writeNew(tmp, String(version));
    const cur = path.join(d, 'CURRENT');
    for (let attempt = 0; ; attempt++) {
      try { this.io.renameSync(tmp, cur); return; }
      catch (e) {
        if (TRANSIENT_FS.has(e?.code) && attempt < 4) { sleep(10); continue; }
        try { this.io.unlinkSync(tmp); } catch (u) { attach(e, 'cleanupError', errInfo(u)); }
        throw e;
      }
    }
  }

  #commit(name, d, value, changeNote, extra = {}) {
    this.io.mkdirSync(d, { recursive: true });
    const nums = this.#versionFileNumbers(d);
    const version = (nums.at(-1) ?? 0) + 1;
    if (version > STORE_MAX_VERSION) throw coded('STORE_VERSION_LIMIT', `${this.kind} ${name} reached ${STORE_MAX_VERSION} versions`, { name });
    const rec = { ...this.normalize(value), name, version, savedAt: new Date().toISOString(), changeNote, ...extra };
    this.#writeNew(this.#versionFile(d, version), JSON.stringify(rec, null, 2));
    this.#setCurrent(d, version);
    return rec;
  }

  // ---------------------------------------------------------------- mutations
  /** Legacy append (profiles, families, built-in seeding): validated, locked, atomic; not compare-and-save. */
  save(name, value, changeNote = '') {
    const d = this.#dirFor(name);
    return this.#withLock(name, 'save', () => this.#commit(name, d, value, changeNote));
  }

  /** Strict compare-and-save. expectedVersion: null = must not exist; integer = must equal CURRENT. */
  compareAndSave(name, value, options) {
    const { expectedVersion, changeNote = '' } = options ?? {};
    const d = this.#dirFor(name);
    validateExpectedVersion(expectedVersion, { allowNull: true });
    return this.#withLock(name, 'compareAndSave', () => {
      const actual = this.#head(d, name);
      if (actual !== expectedVersion) {
        throw coded('CAS_VERSION_CONFLICT', `CAS_VERSION_CONFLICT: expected ${expectedVersion === null ? 'absent' : expectedVersion}, found ${actual === null ? 'absent' : actual}`, { name, expected: expectedVersion, actual });
      }
      return this.#commit(name, d, value, changeNote);
    });
  }

  /** Legacy pointer move (profiles, families): validated, locked, atomic; not compare-and-save. */
  rollback(name, version) {
    const d = this.#dirFor(name);
    const v = validateStoreVersion(version, this.kind);
    this.#withLock(name, 'rollback', () => {
      this.#readRaw(d, name, v); // target must exist and be readable
      this.#setCurrent(d, v);
    });
    return this.load(name);
  }

  /** Strict CAS rollback: APPENDS a new version restoring the target's content so CURRENT never moves backwards. */
  compareAndRollback(name, version, options) {
    const { expectedVersion } = options ?? {};
    const d = this.#dirFor(name);
    const target = validateStoreVersion(version, this.kind);
    validateExpectedVersion(expectedVersion, { allowNull: false });
    return this.#withLock(name, 'compareAndRollback', () => {
      const actual = this.#head(d, name);
      if (actual !== expectedVersion) {
        throw coded('CAS_VERSION_CONFLICT', `CAS_VERSION_CONFLICT: expected ${expectedVersion}, found ${actual === null ? 'absent' : actual}`, { name, expected: expectedVersion, actual });
      }
      // eslint-disable-next-line no-unused-vars
      const { name: _n, version: _v, savedAt: _s, changeNote: _c, restoredFrom: _r, ...content } = this.#readRaw(d, name, target);
      return this.#commit(name, d, content, `rollback: restores v${target}`, { restoredFrom: target });
    });
  }

  // ---------------------------------------------------------------- operator tools (never called automatically)
  inspectLock(name) {
    const lock = this.lockPath(name);
    if (!this.io.existsSync(lock)) return { present: false };
    let rec = null;
    try { rec = JSON.parse(this.io.readFileSync(lock, 'utf8')); } catch { /* malformed */ }
    const wellFormed = !!rec && rec.schema === STORE_LOCK_SCHEMA && typeof rec.token === 'string' && TOKEN_RE.test(rec.token);
    let pidAlive = null;
    if (wellFormed && Number.isSafeInteger(rec.pid) && rec.pid > 0) {
      try { process.kill(rec.pid, 0); pidAlive = true; } catch (e) { pidAlive = e?.code === 'EPERM' ? true : e?.code === 'ESRCH' ? false : null; }
    }
    return { present: true, malformed: !wellFormed, token: wellFormed ? rec.token : null, pid: wellFormed ? rec.pid : null,
      pidAlive, name: wellFormed ? rec.name : null, op: wellFormed ? rec.op : null, at: wellFormed ? rec.at : null, lockPath: lock };
  }

  /** Operator-guided recovery: removes the lock only if its recorded token equals the supplied token. */
  releaseStaleLock(name, options) {
    const lock = this.lockPath(name);
    const { token } = options ?? {};
    if (!this.io.existsSync(lock)) throw coded('CAS_LOCK_ABSENT', `no lock present for "${name}"`, { name });
    let rec = null;
    try { rec = JSON.parse(this.io.readFileSync(lock, 'utf8')); } catch { /* unparsable */ }
    if (typeof token !== 'string' || !TOKEN_RE.test(token) || !rec || rec.token !== token) {
      throw coded('CAS_LOCK_TOKEN_MISMATCH', `lock token for "${name}" does not match; nothing removed`, { name });
    }
    this.io.unlinkSync(lock);
    return { released: true, name, token, pid: rec.pid ?? null, at: rec.at ?? null };
  }
}
