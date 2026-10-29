// Machine-wide single-owner lock per CDP port.
//
// Two Studio processes driving the same Chrome kill/relaunch each other's browser and corrupt each
// other's in-flight turns. The first Studio to own a CDP port records `<root>/locks/cdp-<port>.json`;
// any later `serve`/`start` against the same port refuses fast and names the existing owner.
// A lock is stale (and taken over) when its pid is dead, or when the pid is alive but the recorded
// Studio port refuses connections after the startup grace (pid reuse by an unrelated process).
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const STARTUP_GRACE_MS = 30_000;

export const lockPath = (root, cdpPort) => path.join(root, 'locks', `cdp-${cdpPort}.json`);

const pidAlive = (pid) => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; }
};

const accepts = (port, timeoutMs = 1500) => new Promise((resolve) => {
  const socket = net.connect({ port, host: '127.0.0.1' });
  const done = (ok) => { socket.destroy(); resolve(ok); };
  socket.setTimeout(timeoutMs, () => done(false));
  socket.once('connect', () => done(true));
  socket.once('error', () => done(false));
});

function readLock(file) {
  try {
    const lock = JSON.parse(readFileSync(file, 'utf8'));
    return lock && typeof lock === 'object' ? lock : null;
  } catch { return null; }
}

// Synchronous guard for code that would START a browser (chat/drive): when another live process owns
// this CDP port, a non-owner must never spawn a second Chrome on the same profile.
export function assertNoForeignCdpOwner(root, cdpPort, { pid = process.pid, isAlive = pidAlive } = {}) {
  if (!root) return;
  const lock = readLock(lockPath(root, cdpPort));
  if (lock && lock.pid !== pid && isAlive(lock.pid)) throw new CdpOwnedError(lock, cdpPort);
}

export class CdpOwnedError extends Error {
  constructor(owner, cdpPort) {
    const url = `http://127.0.0.1:${owner.studioPort}`;
    super(`VIVIM is already running at ${url} (pid ${owner.pid}, using browser port ${cdpPort}) — open that, or stop it first.`);
    this.name = 'CdpOwnedError';
    this.code = 'CDP_OWNED';
    this.owner = { pid: owner.pid, studioPort: owner.studioPort, url, startedAt: owner.startedAt };
  }
}

async function ownerIsLive(lock, { isAlive, probe, now }) {
  if (!isAlive(lock.pid)) return false;
  if (!Number.isSafeInteger(lock.studioPort)) return true;
  const age = now() - Date.parse(lock.startedAt ?? 0);
  if (age >= 0 && age < STARTUP_GRACE_MS) return true;
  return probe(lock.studioPort);
}

// Acquire or throw CdpOwnedError. Returns { file, update(studioPort), release() }.
export async function acquireCdpOwnerLock({ root, cdpPort, studioPort, pid = process.pid, isAlive = pidAlive, probe = accepts, now = Date.now }) {
  if (!root) throw new TypeError('data root required for the CDP owner lock');
  const file = lockPath(root, cdpPort);
  mkdirSync(path.dirname(file), { recursive: true });
  const record = () => JSON.stringify({ pid, cdpPort, studioPort, startedAt: new Date(now()).toISOString() }, null, 1);
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      writeFileSync(file, record(), { flag: 'wx' });
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const lock = readLock(file);
      if (lock && lock.pid !== pid && await ownerIsLive(lock, { isAlive, probe, now })) throw new CdpOwnedError(lock, cdpPort);
      // Stale, corrupt, or our own leftover: take it over. A racing process re-creates it with `wx`.
      try { unlinkSync(file); } catch { /* another process already did */ }
      if (attempt === 4) throw new Error(`Could not take the CDP owner lock ${file}`);
    }
  }
  let released = false;
  const mine = () => readLock(file)?.pid === pid;
  const release = () => {
    if (released) return;
    released = true;
    try { if (mine()) unlinkSync(file); } catch { /* already gone */ }
  };
  process.once('exit', release);
  return {
    file,
    update(port) { if (!released && mine()) writeFileSync(file, JSON.stringify({ pid, cdpPort, studioPort: port, startedAt: new Date(now()).toISOString() }, null, 1)); },
    release,
  };
}
