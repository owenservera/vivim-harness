/**
 * Directory integrity manifests and byte-identical snapshots.
 *
 * Format marker: 'aion-integrity/1'. Everything is sorted + canonical so two
 * runs over identical input produce identical bytes.
 */

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

export const FORMAT = 'aion-integrity/1';
const MANIFEST_NAME = 'MANIFEST.json';

/** Stable, whitespace-free JSON. Rejects NaN/Infinity and cycles. */
export function canonicalJson(value) {
  const seen = new Set();

  function walk(v) {
    if (v === null) return 'null';
    const t = typeof v;
    if (t === 'number') {
      if (!Number.isFinite(v)) throw new TypeError('canonicalJson: non-finite number');
      return JSON.stringify(v);
    }
    if (t === 'string' || t === 'boolean') return JSON.stringify(v);
    if (t === 'bigint') throw new TypeError('canonicalJson: bigint is not JSON-safe');
    if (t === 'undefined' || t === 'function' || t === 'symbol') return undefined;
    if (t !== 'object') throw new TypeError(`canonicalJson: unsupported type ${t}`);

    if (seen.has(v)) throw new TypeError('canonicalJson: circular reference');
    seen.add(v);
    try {
      if (typeof v.toJSON === 'function') return walk(v.toJSON());
      if (Array.isArray(v)) {
        const items = v.map((item) => {
          const encoded = walk(item);
          return encoded === undefined ? 'null' : encoded;
        });
        return `[${items.join(',')}]`;
      }
      const keys = Object.keys(v).sort();
      const parts = [];
      for (const key of keys) {
        const encoded = walk(v[key]);
        if (encoded === undefined) continue;
        parts.push(`${JSON.stringify(key)}:${encoded}`);
      }
      return `{${parts.join(',')}}`;
    } finally {
      seen.delete(v);
    }
  }

  const out = walk(value);
  if (out === undefined) throw new TypeError('canonicalJson: value is not JSON-serialisable');
  return out;
}

/** sha256 hex digest of a Buffer / Uint8Array / string (utf8). */
export function sha256Hex(input) {
  return createHash('sha256').update(input).digest('hex');
}

function toPosix(p) {
  return String(p).replace(/\\/g, '/');
}

function walkFiles(dir, ignore = []) {
  const skip = new Set(ignore.map(toPosix));
  const out = [];

  function visit(absDir, relDir) {
    const entries = readdirSync(absDir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    for (const entry of entries) {
      const childAbs = join(absDir, entry.name);
      const childRel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (skip.has(childRel) || skip.has(entry.name)) continue;
      if (entry.isDirectory()) visit(childAbs, childRel);
      else if (entry.isFile()) out.push(childRel);
    }
  }

  visit(dir, '');
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function readRel(root, rel) {
  return readFileSync(join(root, ...rel.split('/')));
}

/**
 * Hash every file under `dir` and write `dir/MANIFEST.json`.
 * @param {string} dir
 * @param {{ignore?: string[]}} [opts]
 */
export function buildManifest(dir, { ignore = [MANIFEST_NAME] } = {}) {
  const root = resolve(dir);
  const files = walkFiles(root, ignore).map((path) => {
    const buf = readRel(root, path);
    return { path, bytes: buf.length, sha256: sha256Hex(buf) };
  });
  const manifest = {
    format: FORMAT,
    files,
    rootSha256: sha256Hex(canonicalJson(files)),
  };
  writeFileSync(join(root, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifest;
}

/**
 * @param {string} dir
 * @returns {{ok: boolean, checked: number, missing: string[], changed: string[], extra: string[]}}
 */
export function verifyManifest(dir) {
  const root = resolve(dir);
  const manifestPath = join(root, MANIFEST_NAME);
  if (!existsSync(manifestPath)) {
    throw new Error(`verifyManifest: no ${MANIFEST_NAME} in ${root}`);
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error(`verifyManifest: unreadable manifest (${error && error.message})`);
  }
  if (!manifest || manifest.format !== FORMAT || !Array.isArray(manifest.files)) {
    throw new Error('verifyManifest: unsupported manifest format');
  }

  const listed = new Set();
  const missing = [];
  const changed = [];
  let checked = 0;

  for (const entry of manifest.files) {
    const path = toPosix(entry && entry.path);
    if (!path) continue;
    listed.add(path);
    const abs = join(root, ...path.split('/'));
    if (!existsSync(abs)) {
      missing.push(path);
      continue;
    }
    checked += 1;
    const buf = readFileSync(abs);
    if (sha256Hex(buf) !== entry.sha256 || buf.length !== entry.bytes) changed.push(path);
  }

  const extra = walkFiles(root, [MANIFEST_NAME]).filter((path) => !listed.has(path));
  const rootOk = sha256Hex(canonicalJson(manifest.files)) === manifest.rootSha256;

  missing.sort();
  changed.sort();
  extra.sort();

  return {
    ok: rootOk && missing.length === 0 && changed.length === 0 && extra.length === 0,
    checked,
    missing,
    changed,
    extra,
  };
}

/**
 * Byte-identical JSON snapshot of a directory tree.
 * @param {string} dir
 * @returns {string}
 */
export function exportSnapshot(dir) {
  const root = resolve(dir);
  const files = walkFiles(root, [MANIFEST_NAME]).map((path) => {
    const buf = readRel(root, path);
    return { path, b64: buf.toString('base64'), sha256: sha256Hex(buf) };
  });
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return canonicalJson({ format: FORMAT, files });
}

function assertSafeRelPath(value) {
  const raw = String(value ?? '');
  if (raw.length === 0) throw new Error('importSnapshot: empty path');
  if (raw.includes('\\')) throw new Error(`importSnapshot: backslash path refused: ${raw}`);
  if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) {
    throw new Error(`importSnapshot: absolute path refused: ${raw}`);
  }
  const segments = raw.split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new Error(`importSnapshot: unsafe path segment in ${raw}`);
    }
  }
  return segments.join('/');
}

/**
 * Verify every sha256 before writing a single byte.
 * @param {string|object} json
 * @param {string} destDir
 * @param {{overwrite?: boolean}} [opts]
 * @returns {{written: number, skipped: number}}
 */
export function importSnapshot(json, destDir, { overwrite = false } = {}) {
  const snapshot = typeof json === 'string' ? JSON.parse(json) : json;
  if (!snapshot || snapshot.format !== FORMAT || !Array.isArray(snapshot.files)) {
    throw new Error('importSnapshot: unsupported snapshot format');
  }
  const dest = resolve(destDir);
  const plan = [];

  for (const entry of snapshot.files) {
    const rel = assertSafeRelPath(entry && entry.path);
    if (typeof entry.sha256 !== 'string' || entry.sha256.length === 0) {
      throw new Error(`importSnapshot: missing sha256 for ${rel}`);
    }
    const buf = Buffer.from(String(entry.b64 ?? ''), 'base64');
    if (sha256Hex(buf) !== entry.sha256) {
      throw new Error(`importSnapshot: checksum mismatch for ${rel}`);
    }
    const abs = join(dest, ...rel.split('/'));
    const relFromDest = relative(dest, abs);
    if (relFromDest.startsWith('..') || isAbsolute(relFromDest)) {
      throw new Error(`importSnapshot: path escapes destination: ${rel}`);
    }
    plan.push({ abs, buf });
  }

  let written = 0;
  let skipped = 0;
  for (const item of plan) {
    if (existsSync(item.abs) && !overwrite) {
      skipped += 1;
      continue;
    }
    mkdirSync(dirname(item.abs), { recursive: true });
    writeFileSync(item.abs, item.buf);
    written += 1;
  }

  return { written, skipped };
}

export default buildManifest;
