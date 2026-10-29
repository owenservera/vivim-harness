// Machine-wide single-owner lock per CDP port.
//
// Two Studio processes driving the same Chrome kill/relaunch each other's browser and corrupt each
// other's in-flight turns. The first Studio to own a CDP port records `<root>/locks/cdp-<port>.json`;
// any later `serve`/`start` against the same port refuses fast and names the existing owner.
//
// Liveness: a lock is stale (and taken over) when its pid is dead, or when the pid is alive but the
// recorded Studio port refuses connections after the startup grace (pid reuse by an unrelated process;
// Node cannot read another process's start time on Windows without spawning, so the port is the proof).
//
// Races: the lock file is published complete with an atomic hard link (never seen half written), and
// a stale lock is only removed while holding `<lock>.takeover` (exclusive create), after re-reading it
// and confirming it is still the exact record that was judged stale.
import { randomBytes } from 'node:crypto';
import { linkSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const STARTUP_GRACE_MS = 30_000;
const TAKEOVER_STALE_MS = 10_000; // a takeover guard left by a crashed process
const PARTIAL_GRACE_MS = 5_000; // an unreadable lock younger than this may still be being written
const RETRY_MS = 50;
const MAX_ATTEMPTS = 100; // ~5 s of contention before giving up

export const lockPath = (root, cdpPort) => path.join(root, 'locks', `cdp-${cdpPort}.json`);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const validPort = (p) => Number.isSafeInteger(p) && p > 0 && p < 65536;

const pidAlive = (pid) => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  // EPERM: the process exists but belongs to another user - still alive.
  try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; }
};

const accepts = (port, timeoutMs = 1500) => new Promise((resolve) => {
  const socket = net.connect({ port, host: '127.0.0.1' });
  const done = (ok) => { socket.destroy(); resolve(ok); };
  socket.setTimeout(timeoutMs, () => done(false));
  socket.once('connect', () => done(true));
  socket.once('error', () => done(false));
});

// { lock, age } - lock is null when missing (age null) or unreadable (age = file age in ms).
function readLock(file) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { return { lock: null, age: null } }
  try {
    const lock = JSON.parse(text);
    if (lock && typeof lock === 'object' && Number.isSafeInteger(lock.pid)) return { lock, age: 0 };
  } catch { /* fall through */ }
  let age = Infinity;
  try { age = Date.now() - statSync(file).mtimeMs; } catch { return { lock: null, age: null }; }
  return { lock: null, age };
}

const sameRecord = (a, b) => !!a && !!b && a.pid === b.pid && a.startedAt === b.startedAt && a.nonce === b.nonce;

const ownerUrl = (owner) => validPort(owner?.studioPort) ? `http://127.0.0.1:${owner.studioPort}` : null;

export class CdpOwnedError extends Error {
  constructor(owner, cdpPort) {
    const url = ownerUrl(owner);
    super(url
      ? `VIVIM is already running at ${url} - open that window, or close it first. (It is using browser port ${cdpPort}, process ${owner.pid}.)`
      : `VIVIM is already running and using browser port ${cdpPort} (process ${owner.pid}) - use that window, or close it first.`);
    this.name = 'CdpOwnedError';
    this.code = 'CDP_OWNED';
    this.owner = { pid: owner.pid, studioPort: owner.studioPort ?? null, url, startedAt: owner.startedAt ?? null };
  }
}

async function ownerIsLive(lock, { isAlive, probe, now }) {
  if (!isAlive(lock.pid)) return false;
  if (!validPort(lock.studioPort)) return true; // nothing to probe: trust the live pid
  const age = now() - Date.parse(lock.startedAt ?? '');
  if (!(age >= STARTUP_GRACE_MS)) return true; // starting up (or unparseable/future clock): trust the pid
  return probe(lock.studioPort);
}

// Guard for code that would START a browser (chat/drive): when another live process owns this CDP
// port, a non-owner must never spawn a second Chrome on the same profile. Async (probes the owner).
export async function assertNoForeignCdpOwner(root, cdpPort, { pid = process.pid, isAlive = pidAlive, probe = accepts, now = Date.now } = {}) {
  if (!root) return;
  const { lock } = readLock(lockPath(root, cdpPort));
  if (lock && lock.pid !== pid && await ownerIsLive(lock, { isAlive, probe, now })) throw new CdpOwnedError(lock, cdpPort);
}

function unique(file) { return `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`; }

// Publish `text` at `file` only if `file` does not exist, never visible half written. false = EEXIST.
function createExclusive(file, text) {
  const tmp = unique(file);
  writeFileSync(tmp, text);
  try { linkSync(tmp, file); return true; }
  catch (e) {
    if (e.code === 'EEXIST') return false;
    // File systems without hard links (FAT/exFAT, some shares): plain exclusive create. A reader that
    // races the write sees an unreadable young file and waits (PARTIAL_GRACE_MS) instead of taking over.
    if (['EPERM', 'ENOTSUP', 'ENOSYS', 'EXDEV', 'EINVAL'].includes(e.code)) {
      try { writeFileSync(file, text, { flag: 'wx' }); return true; }
      catch (e2) { if (e2.code === 'EEXIST') return false; throw e2; }
    }
    throw e;
  } finally { try { unlinkSync(tmp); } catch { /* already gone */ } }
}

function replaceAtomic(file, text) {
  const tmp = unique(file);
  writeFileSync(tmp, text);
  try { renameSync(tmp, file); } catch (e) { try { unlinkSync(tmp); } catch { /* gone */ } throw e; }
}

// Run `fn` holding `<file>.takeover`; null when another process holds it right now.
function withTakeoverGuard(file, fn) {
  const guard = `${file}.takeover`;
  try { writeFileSync(guard, String(process.pid), { flag: 'wx' }); }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    try { if (Date.now() - statSync(guard).mtimeMs > TAKEOVER_STALE_MS) unlinkSync(guard); } catch { /* gone */ }
    return null;
  }
  try { return fn(); } finally { try { unlinkSync(guard); } catch { /* gone */ } }
}

// Acquire or throw CdpOwnedError. Returns { file, update(studioPort), release() }.
export async function acquireCdpOwnerLock({ root, cdpPort, studioPort, pid = process.pid, isAlive = pidAlive, probe = accepts, now = Date.now }) {
  if (!root) throw new TypeError('data root required for the CDP owner lock');
  const file = lockPath(root, cdpPort);
  try { mkdirSync(path.dirname(file), { recursive: true }); }
  catch (e) { throw Object.assign(new Error(`VIVIM cannot write to its data folder (${path.dirname(file)}): ${e.message}`), { code: e.code }); }
  const mineRecord = { schema: 'vivim.cdp-owner-lock.v2', pid, cdpPort, studioPort: validPort(studioPort) ? studioPort : null,
    startedAt: new Date(now()).toISOString(), nonce: randomBytes(8).toString('hex') };
  const serialize = (r) => JSON.stringify(r, null, 1);
  let acquired = false;
  for (let attempt = 0; attempt < MAX_ATTEMPTS && !acquired; attempt++) {
    if (createExclusive(file, serialize(mineRecord))) { acquired = true; break; }
    const seen = readLock(file);
    if (!seen.lock) {
      if (seen.age === null) continue; // vanished between create and read: just retry
      if (seen.age < PARTIAL_GRACE_MS) { await sleep(RETRY_MS); continue; } // probably still being written
    } else if (seen.lock.pid !== pid && await ownerIsLive(seen.lock, { isAlive, probe, now })) {
      throw new CdpOwnedError(seen.lock, cdpPort);
    }
    // Stale, corrupt, or a leftover of this same pid: remove it - but only if it is still that record.
    const removed = withTakeoverGuard(file, () => {
      const again = readLock(file);
      const unchanged = seen.lock ? sameRecord(again.lock, seen.lock) : (!again.lock && again.age !== null);
      if (unchanged) { try { unlinkSync(file); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
      return true;
    });
    if (removed === null) await sleep(RETRY_MS); // another process is taking over; re-evaluate after it
  }
  if (!acquired) throw new Error(`VIVIM could not claim browser port ${cdpPort} (lock ${file} stayed busy). Try again in a moment.`);

  let released = false;
  const mine = () => sameRecord(readLock(file).lock, mineRecord);
  const release = () => {
    if (released) return;
    released = true;
    process.removeListener('exit', release);
    try { if (mine()) unlinkSync(file); } catch { /* already gone */ }
  };
  // 'exit' also runs after process.exit() and an uncaught exception. A hard kill leaves a dead pid,
  // which the next acquirer takes over.
  process.once('exit', release);
  return {
    file,
    // Record the port the Studio actually listens on (it can differ from the requested one, e.g. 0).
    update(port) {
      if (released || !mine() || !validPort(port) || port === mineRecord.studioPort) return;
      const next = { ...mineRecord, studioPort: port };
      try { replaceAtomic(file, serialize(next)); mineRecord.studioPort = port; } catch { /* keep the previous record; still ours */ }
    },
    release,
  };
}
