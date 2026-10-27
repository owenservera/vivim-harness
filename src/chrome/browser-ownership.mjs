// Local browser ownership continuity: the reachable CDP port is NOT evidence of a VIVIM world.
// This marker is created only after this launcher starts an isolated profile and sees its
// DevTools browser identity. Subsequent attaches fail closed if port/profile/identity drift.
// It is an operational continuity check, NOT OS-level isolation or an authentication mechanism.
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { browserVersion } from '../cdp/discovery.mjs';

const MARKER = '.vivim-cdp-owner.json';
const error = (code, detail) => Object.assign(new Error(`${code}: ${detail}`), { code });

export function browserIdentity(version, port) {
  const raw = version?.webSocketDebuggerUrl;
  if (typeof raw !== 'string') throw error('BROWSER_IDENTITY_UNAVAILABLE', 'DevTools did not provide a browser identity');
  let url;
  try { url = new URL(raw); } catch { throw error('BROWSER_IDENTITY_UNAVAILABLE', 'Invalid DevTools identity'); }
  if (url.protocol !== 'ws:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || Number(url.port) !== Number(port) || !/^\/devtools\/browser\/[a-zA-Z0-9-]{8,128}$/.test(url.pathname))
    throw error('BROWSER_IDENTITY_UNAVAILABLE', 'DevTools identity is not the expected loopback browser endpoint');
  return url.pathname;
}

export function browserMarkerPath(profileDir) {
  if (typeof profileDir !== 'string' || !profileDir.trim())
    throw error('BROWSER_PROFILE_REQUIRED', 'A dedicated VIVIM Chrome profile directory is required');
  return path.join(path.resolve(profileDir), MARKER);
}

export function checkBrowserOwner({ profileDir, port, version, marker } = {}) {
  browserMarkerPath(profileDir);
  const profilePath = existsSync(profileDir) ? realpathSync(profileDir) : path.resolve(profileDir);
  const expected = browserIdentity(version, port);
  if (!marker || marker.schema !== 'vivim.chrome-owner/1'
    || marker.profilePath !== profilePath || marker.port !== Number(port) || marker.browserIdentity !== expected)
    throw error('BROWSER_PROFILE_UNVERIFIED',
      'A Chrome endpoint is reachable but its identity is not verified for this VIVIM profile. ' +
      'Do not attach or send; close only the dedicated VIVIM Chrome after saving your work, then relaunch with studio start.');
  return { verified: true, profilePath, browserIdentity: expected };
}

export async function verifyBrowserOwner({ profileDir, port, version } = {}) {
  const markerPath = browserMarkerPath(profileDir);
  let marker = null;
  try { marker = JSON.parse(readFileSync(markerPath, 'utf8')); } catch { /* no marker or malformed => deny */ }
  const observed = version ?? await browserVersion({ port });
  return checkBrowserOwner({ profileDir, port, version: observed, marker });
}

export function recordBrowserOwner({ profileDir, port, version, pid } = {}) {
  const markerPath = browserMarkerPath(profileDir);
  const dir = path.dirname(markerPath);
  mkdirSync(dir, { recursive: true });
  const profilePath = realpathSync(dir);
  const marker = { schema: 'vivim.chrome-owner/1', profilePath, port: Number(port),
    browserIdentity: browserIdentity(version, port), launchedPid: pid ?? null, createdAt: new Date().toISOString() };
  const temp = markerPath + '.' + randomUUID() + '.tmp';
  try {
    writeFileSync(temp, JSON.stringify(marker, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    renameSync(temp, markerPath);
  } finally { if (existsSync(temp)) rmSync(temp, { force: true }); }
  return { verified: true, profilePath, browserIdentity: marker.browserIdentity };
}
