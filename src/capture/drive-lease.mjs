// Host-local exclusion for all foreground drivers, independent of their chosen data directory.
// Only a live owner blocks acquisition: dead-pid and missing/corrupt-owner leases are reclaimed on acquire.
import * as fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

export const defaultLeaseRoot = () => path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'AION', 'drive-leases');
const leaseError = (code) => Object.assign(new Error(code), { code, status: 409 });
function ownerState(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return 'unknown';
  try { process.kill(pid, 0); return 'alive'; } catch (e) { return e.code === 'ESRCH' ? 'dead' : 'unknown'; }
}
// Owner-file classification so callers (and acquire) know which case a lease dir is in:
//   ownerFile 'ok'          valid owner.json; ownerState alive|dead|unknown from its pid
//   ownerFile 'missing'     directory without owner.json (crashed/never-finished acquire)
//   ownerFile 'unparseable' owner.json is not valid JSON
//   ownerFile 'invalid'     JSON but not a version-1 owner for this port
// `reclaimable` is the single rule acquire uses: only a LIVE (or unprovable pid) owner blocks.
export function inspectDriveLease({ port = 9222, root = defaultLeaseRoot() } = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw leaseError('INVALID_PORT');
  const dir = path.join(root, String(port)), file = path.join(dir, 'owner.json');
  let raw, ageMs = null, dirId = null;
  try { const st = fs.statSync(dir); dirId = `${st.ino}:${st.birthtimeMs}`; const times = [st.mtimeMs]; try { times.push(fs.statSync(file).mtimeMs); } catch {} ageMs = Math.max(0, Date.now() - Math.max(...times)); } catch { return { exists: false, port }; }
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (e) { return { exists: true, port, ownerFile: 'missing', ownerState: 'unknown', ageMs, dirId, reclaimable: true }; }
  let owner; try { owner = JSON.parse(raw); } catch { return { exists: true, port, ownerFile: 'unparseable', ownerState: 'unknown', ageMs, dirId, reclaimable: true }; }
  if (!owner || typeof owner !== 'object' || owner.version !== 1 || owner.port !== port || typeof owner.token !== 'string' || !owner.token) {
    const hasPid = Number.isInteger(owner?.pid) && owner.pid > 0, state = hasPid ? ownerState(owner.pid) : 'unknown';
    return { exists: true, port, ownerFile: 'invalid', ownerState: state, ageMs, dirId, reclaimable: !hasPid || state === 'dead' };
  }
  const state = ownerState(owner.pid);
  return { exists: true, ...owner, ownerFile: 'ok', ownerState: state, ageMs, dirId, reclaimable: state === 'dead' };
}
export function recoverDriveLease({ port = 9222, root = defaultLeaseRoot(), token, pid } = {}) {
  const first = inspectDriveLease({ port, root });
  if (!first.exists || !token || token !== first.token || pid !== first.pid) throw leaseError('LEASE_RECOVERY_OWNER_MISMATCH');
  if (first.ownerState !== 'dead') throw leaseError('LEASE_RECOVERY_OWNER_NOT_PROVEN_DEAD');
  const dir = path.join(root, String(port)), marker = path.join(dir, 'recovering');
  fs.mkdirSync(marker); // Exclusive recovery attempt; never recursively remove owner directories.
  try {
    const current = inspectDriveLease({ port, root });
    if (current.token !== token || current.pid !== pid || current.ownerState !== 'dead') throw leaseError('LEASE_RECOVERY_OWNER_CHANGED');
    fs.unlinkSync(path.join(dir, 'owner.json'));
  } finally { fs.rmdirSync(marker); }
  fs.rmdirSync(dir);
  return { recovered: true, port, pid };
}

// A directory whose owner is gone is removed under an exclusive `recovering` marker, so two
// concurrent acquirers reclaim at most once. Unreadable/missing owner files are only reclaimed after
// a short grace so a lease that is being written right now is never taken. Returns true when the
// directory is gone (reclaimed by us or someone else) and a fresh mkdir may be attempted.
function reclaimStale(dir, staleGraceMs, port, root) {
  const marker = path.join(dir, 'recovering');
  const reclaimable = () => { const i = inspectDriveLease({ port, root }); return i.exists ? i : null; };
  const eligible = (i) => i.reclaimable && (i.ownerFile === 'ok' || i.ownerState === 'dead' || i.ageMs >= staleGraceMs);
  const first = reclaimable();
  if (!first) return true;
  if (!eligible(first)) return false;
  try { fs.mkdirSync(marker); }
  catch (e) {
    if (e.code === 'ENOENT') return true;
    if (e.code === 'EEXIST') { // a crashed reclaimer must not wedge the port forever
      try { if (Date.now() - fs.statSync(marker).mtimeMs > 30_000) fs.rmdirSync(marker); } catch {}
    }
    return false;
  }
  try {
    const current = reclaimable();
    if (!current) return true;
    // Same directory instance (a racer may have reclaimed and re-created it, mid-write, since `first`).
    // Age was proven on `first`; our own marker has since refreshed the directory mtime.
    if (!current.reclaimable || current.dirId !== first.dirId || current.token !== first.token || current.ownerFile !== first.ownerFile) return false;
    try { fs.unlinkSync(path.join(dir, 'owner.json')); } catch (e) { if (e.code !== 'ENOENT') return false; }
  } finally { try { fs.rmdirSync(marker); } catch {} }
  try { fs.rmdirSync(dir); } catch (e) { return e.code === 'ENOENT'; }
  return true;
}

export function acquireDriveLease({ port = 9222, holder, root = defaultLeaseRoot(), staleGraceMs = 2000 } = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Object.assign(new Error('Invalid CDP port'), { status: 400, code: 'INVALID_PORT' });
  const dir = path.join(root, String(port)), file = path.join(dir, 'owner.json');
  fs.mkdirSync(root, { recursive: true });
  const busy = () => {
    let owner; try { owner = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
    return Object.assign(new Error('Browser driving lease is held by a live owner'), {
      status: 409, code: 'DRIVE_LEASE_BUSY', holder: owner?.holder ?? { kind: 'unknown', id: null },
    });
  };
  try { fs.mkdirSync(dir); }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    // Only a live (or unprovable) pid blocks; missing/corrupt owner files and dead pids are reclaimed.
    if (!reclaimStale(dir, staleGraceMs, port, root)) throw busy();
    try { fs.mkdirSync(dir); } catch (e2) { if (e2.code === 'EEXIST') throw busy(); throw e2; }
  }  const token = randomUUID(), metadata = { version: 1, token, pid: process.pid, port, holder, createdAt: new Date().toISOString() };
  let fd;
  try {
    fd = fs.openSync(file, 'wx', 0o600); fs.writeFileSync(fd, JSON.stringify(metadata)); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
  } catch (e) {
    if (fd !== undefined) fs.closeSync(fd);
    // Our directory was reclaimed from under us (or someone else's owner.json is there): we lost, and
    // must not remove what the other party now holds.
    if (e.code === 'ENOENT' || e.code === 'EEXIST') throw busy();
    try { fs.unlinkSync(file); fs.rmdirSync(dir); } catch {}
    throw e;
  }
  let released = false;
  return {
    token, holder, pid: process.pid,
    release() {
      if (released) return;
      let owner;
      try { owner = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw Object.assign(new Error('Lease ownership is unreadable'), { code: 'LEASE_OWNER_UNKNOWN', status: 409 }); }
      if (owner.token !== token || owner.pid !== process.pid) throw Object.assign(new Error('Lease ownership changed'), { code: 'LEASE_OWNER_CHANGED', status: 409 });
      fs.unlinkSync(file); fs.rmdirSync(dir); released = true;
    },
  };
}
