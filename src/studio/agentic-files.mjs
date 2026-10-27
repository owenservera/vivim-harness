// C-11 agentic file library. Read-only inventory of instruction files under caller-supplied
// roots. The files are inert data; this library grants no capability; trust is always
// untrusted-until-confirmed. It never executes, evaluates, imports, or follows instructions
// found in those files, never follows links outside a verified real path, and never reads
// outside a root. get(id) resolves through a bounded id registry instead of rescanning the
// whole tree; its read stays live and recomputes integrity from the bytes actually returned.
import { createHash } from 'node:crypto';
import {
  closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, realpathSync, readSync,
} from 'node:fs';
import path from 'node:path';
import { integer, problem } from './http.mjs';

export const AGENTIC_FILE_KINDS = Object.freeze(['agents', 'claude', 'opencode-agent', 'skill', 'docs-agent']);
const PRECEDENCE_KINDS = Object.freeze(['agents', 'claude']);

export const AGENTIC_FILE_LIMITS = Object.freeze({
  maxFiles: 200,
  maxFileBytes: 262144,
  maxDepth: 8,
  maxEntries: 5000,
  maxFrontmatterBytes: 4096,
  maxFrontmatterKeys: 32,
  maxFrontmatterValue: 500,
  maxTitle: 200,
  maxContentBytes: 65536,
  maxSkipped: 200,
});

const LIMIT_BOUNDS = Object.freeze({
  maxFiles: [0, 10000],
  maxFileBytes: [0, 1048576],
  maxDepth: [0, 64],
  maxEntries: [0, 100000],
  maxFrontmatterBytes: [0, 65536],
  maxFrontmatterKeys: [0, 256],
  maxFrontmatterValue: [1, 4000],
  maxTitle: [1, 500],
  maxContentBytes: [1, 1048576],
  maxSkipped: [0, 5000],
});

export const AGENTIC_PRECEDENCE_RULE = Object.freeze({
  rule: 'nearest-to-root-wins',
  applied: false,
  scope: 'per-root, and only for kinds agents and claude',
  statement: 'A shallower file of the same kind in the same root outranks a deeper one. Equal depth is a tie and has no winner. Ranking is disclosed only: conflicts are listed and not resolved, and no file is selected as policy.',
});

// Canonical inertness statement for records and coverage; there is deliberately no
// raised/ceiling capability field anywhere because there is no capability to raise.
const INERT_STATEMENT = 'files are inert data; this library grants no capability; trust is always untrusted-until-confirmed';

const QUALIFICATION = `Scan covers regular files matching AGENTS.md, CLAUDE.md, SKILL.md, .opencode/agents/*.md, and docs/agents/*.md under the explicit roots. .git and node_modules are excluded by policy. Symlinks and junctions are not followed; every entry's real path must stay inside the root's own real path. complete means every in-policy match was visited and hashed in full; it does not mean unread, excluded, or remote files do not exist. Precedence is not applied. ${INERT_STATEMENT.charAt(0).toUpperCase() + INERT_STATEMENT.slice(1)}.`;

const NOT_FOUND = () => problem(404, 'Agentic file not found', 'AGENTIC_NOT_FOUND');

function boundsWith(overrides) {
  if (overrides !== undefined && (!overrides || typeof overrides !== 'object' || Array.isArray(overrides))) {
    throw new TypeError('limits must be an object');
  }
  const out = { ...AGENTIC_FILE_LIMITS };
  if (overrides) {
    for (const key of Object.keys(overrides)) {
      if (!Object.hasOwn(LIMIT_BOUNDS, key)) throw new TypeError(`limits.${key} is not a known bound`);
      const value = overrides[key];
      const [min, max] = LIMIT_BOUNDS[key];
      if (!Number.isSafeInteger(value) || value < min || value > max) throw new TypeError(`limits.${key} must be an integer between ${min} and ${max}`);
      out[key] = value;
    }
  }
  return out;
}

function samePath(a, b) {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** Containment on real (already realpath-resolved) paths: structural prefix, case-insensitive
 * on win32. Input segments must not contain navigation; callers pass realpath output only. */
export function realInside(realRoot, realPath) {
  if (typeof realRoot !== 'string' || typeof realPath !== 'string' || realRoot === '' || realPath === '') return false;
  const win32 = process.platform === 'win32';
  const norm = (value) => (win32 ? value.toLowerCase().replaceAll('\\', '/') : value);
  const root = norm(realRoot);
  const target = norm(realPath);
  if (root === target) return true;
  return target.startsWith(root.endsWith('/') ? root : `${root}/`);
}

/** Policy directory name ('git' or 'node_modules') or null. Case-insensitive on win32 where
 * the filesystem is case-insensitive by default. */
function policyDirName(name) {
  const key = process.platform === 'win32' ? name.toLowerCase() : name;
  if (key === '.git') return 'git';
  if (key === 'node_modules') return 'node_modules';
  return null;
}

function normalizeRoots(roots) {
  if (!Array.isArray(roots)) throw new TypeError('roots must be an explicit array of directories');
  if (roots.length > 32) throw new TypeError('roots exceeds 32');
  const accepted = [], acceptedIds = new Set();
  const out = [];
  for (const [index, entry] of roots.entries()) {
    const spec = typeof entry === 'string' ? { path: entry } : entry;
    if (!spec || typeof spec !== 'object' || Array.isArray(spec) || typeof spec.path !== 'string') {
      throw new TypeError(`roots[${index}] must be an absolute path or { path }`);
    }
    if (spec.path.length === 0 || spec.path.length > 1024 || spec.path.includes('\0')) throw new TypeError(`roots[${index}].path is not usable`);
    if (!path.isAbsolute(spec.path)) throw new TypeError(`roots[${index}] must be an absolute path`);
    if (spec.untrusted !== undefined && typeof spec.untrusted !== 'boolean') throw new TypeError(`roots[${index}].untrusted must be a boolean`);
    if (spec.id !== undefined && (typeof spec.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(spec.id))) {
      throw new TypeError(`roots[${index}].id must be a short token`);
    }
    const resolved = path.resolve(spec.path);
    // Realpath where the path exists; alias and containment checks compare real paths so a
    // junction or other link alias cannot smuggle in a duplicate or a nested root. A missing
    // path has no real path yet, so only lexical equality is checked for it.
    let real = null;
    try { real = realpathSync(resolved); } catch { real = null; }
    const canonical = real ?? resolved;
    const id = spec.id ?? (`r${createHash('sha256').update(canonical).digest('hex').slice(0, 16)}`);
    if (acceptedIds.has(id)) throw new TypeError(`roots[${index}] duplicates the root id '${id}'`);
    for (const prior of accepted) {
      if (samePath(prior.canonical, canonical)) {
        throw new TypeError(`roots[${index}] duplicates another root (same resolved path, or the same real path through a link alias)`);
      }
      if (real !== null && prior.real !== null && (realInside(prior.canonical, canonical) || realInside(canonical, prior.canonical))) {
        throw new TypeError(`roots[${index}] is contained in or contains another root`);
      }
    }
    acceptedIds.add(id);
    accepted.push({ canonical, real });
    const untrusted = spec.untrusted !== false;
    out.push({ id, resolved, untrusted });
  }
  return out;
}

function fileId(rootId, relPosix) {
  return createHash('sha256').update(String(rootId)).update('\0').update(relPosix).digest('hex');
}

function inside(root, full) {
  const rel = path.relative(root, full);
  if (rel === '') return '';
  if (rel.startsWith(`..${path.sep}`) || rel === '..' || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

function safeName(name) {
  return typeof name === 'string' && name.length > 0 && name !== '.' && name !== '..'
    && !name.includes('/') && !name.includes('\\') && !name.includes('\0') && !path.isAbsolute(name);
}

const REJECT = Symbol('reject');

function parseScalar(raw, limits) {
  if (raw.length > limits.maxFrontmatterValue) return REJECT;
  if (raw === '' || raw === '~' || raw === 'null') return null;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^-?\d+$/.test(raw)) {
    const n = Number(raw);
    return Number.isSafeInteger(n) ? n : REJECT;
  }
  if (raw.startsWith('"')) {
    if (!raw.endsWith('"') || raw.length < 2) return REJECT;
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const ch = raw[i];
      if (ch === '"') return REJECT;
      if (ch === '\\') {
        const esc = raw[++i];
        if (esc === '\\' || esc === '"') out += esc;
        else if (esc === 'n') out += '\n';
        else if (esc === 't') out += '\t';
        else return REJECT;
      } else if (ch === '\0') return REJECT;
      else out += ch;
      if (out.length > limits.maxFrontmatterValue) return REJECT;
    }
    return out;
  }
  if (raw.startsWith("'")) {
    if (!raw.endsWith("'") || raw.length < 2) return REJECT;
    const body = raw.slice(1, -1);
    if (body.includes("'") || body.includes('\0')) return REJECT;
    return body.length > limits.maxFrontmatterValue ? REJECT : body;
  }
  if (!new RegExp(`^[A-Za-z0-9][A-Za-z0-9 ._/:+-]{0,${Math.max(0, limits.maxFrontmatterValue - 1)}}$`).test(raw)) return REJECT;
  return raw;
}

function parseFrontmatter(text, limits) {
  if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) return { frontmatter: null, status: 'absent', body: text };
  const nl = text.startsWith('---\r\n') ? 5 : 4;
  const rest = text.slice(nl);
  const close = /\r?\n---[ \t]*(?:\r?\n|$)/.exec(rest);
  if (!close) return { frontmatter: null, status: 'rejected', body: text };
  const block = rest.slice(0, close.index);
  if (Buffer.byteLength(block) > limits.maxFrontmatterBytes) return { frontmatter: null, status: 'rejected', body: text };
  const out = {};
  let count = 0;
  for (const line of block.split(/\r?\n/)) {
    if (line === '' || line.startsWith('#')) continue;
    if (/^\s/.test(line)) return { frontmatter: null, status: 'rejected', body: text };
    const match = /^([A-Za-z_][A-Za-z0-9_-]{0,63}):[ \t]*(.*)$/.exec(line);
    if (!match) return { frontmatter: null, status: 'rejected', body: text };
    // A plain object stores these only via the literal key strings, so exact
    // case-sensitive names are exactly the ones that must be refused.
    if (match[1] === '__proto__' || match[1] === 'prototype' || match[1] === 'constructor') {
      return { frontmatter: null, status: 'rejected', body: text };
    }
    if (count >= limits.maxFrontmatterKeys || Object.hasOwn(out, match[1])) return { frontmatter: null, status: 'rejected', body: text };
    const value = parseScalar(match[2], limits);
    if (value === REJECT) return { frontmatter: null, status: 'rejected', body: text };
    out[match[1]] = value;
    count += 1;
  }
  return { frontmatter: out, status: 'parsed', body: text.slice(nl + close.index + close[0].length) };
}

function titleOf(relPosix, frontmatter, body, max) {
  const named = frontmatter && typeof frontmatter.title === 'string' ? frontmatter.title.trim() : '';
  let title = named;
  if (!title) {
    const heading = /^#{1,6}[ \t]+([^\r\n]+)$/m.exec(body ?? '');
    title = heading ? heading[1].trim() : '';
  }
  if (!title && frontmatter && typeof frontmatter.name === 'string') title = frontmatter.name.trim();
  if (!title) title = relPosix.split('/').pop();
  // Strip bidi/zero-width control shapes, then plain control characters.
  title = title.replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return title.length > max ? title.slice(0, max) : title;
}

function classify(relPosix) {
  const base = relPosix.split('/').pop();
  if (base === 'AGENTS.md') return 'agents';
  if (base === 'CLAUDE.md') return 'claude';
  if (base === 'SKILL.md') return 'skill';
  const parts = relPosix.split('/');
  if (parts.length === 3 && parts[0] === '.opencode' && parts[1] === 'agents' && base.endsWith('.md')) return 'opencode-agent';
  if (parts.length === 3 && parts[0] === 'docs' && parts[1] === 'agents' && base.endsWith('.md')) return 'docs-agent';
  return null;
}

// The opened regular file must still present itself with the metadata we inventoried where
// both sides report comparable dev/ino (Windows does; platforms without it skip the check).
function sameMeta(before, after) {
  const comparable = (st) => Number.isSafeInteger(st?.dev) && st.dev > 0 && Number.isSafeInteger(st?.ino) && st.ino > 0;
  if (!comparable(before) || !comparable(after)) return true;
  return before.dev === after.dev && before.ino === after.ino;
}

function readRegular(full, realRoot, limits) {
  let fd;
  try {
    const before = lstatSync(full);
    if (before.isSymbolicLink() || !before.isFile()) return { refused: 'symlink' };
    let real;
    try { real = realpathSync(full); } catch { return { refused: 'unreadable' }; }
    if (!realInside(realRoot, real)) return { refused: 'escaped-root' };
    if (!Number.isSafeInteger(before.size) || before.size < 0) return { refused: 'unreadable' };
    if (before.size > limits.maxFileBytes) return { overCap: true, bytes: before.size, mtime: before.mtimeMs };
    // Capability probe, not an OS check: O_NOFOLLOW is simply absent where the concept does not
    // exist (Windows), and the surrounding catch already treats ELOOP/EINVAL as a symlink refusal.
    const flags = constants.O_RDONLY | (constants.O_NOFOLLOW || 0);
    fd = openSync(full, flags);
    const st = fstatSync(fd);
    if (!st.isFile() || !sameMeta(before, st)) return { refused: 'swapped' };
    if (!Number.isSafeInteger(st.size) || st.size < 0 || st.size > limits.maxFileBytes) return { overCap: true, bytes: st.size, mtime: st.mtimeMs };
    // After open, the path must still resolve to the same real path inside the root.
    try {
      const after = realpathSync(full);
      if (!samePath(after, real)) return { refused: 'swapped' };
    } catch { return { refused: 'unreadable' }; }
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = readSync(fd, buf, off, st.size - off, off);
      if (n <= 0) return { refused: 'unreadable' };
      off += n;
    }
    return { bytes: st.size, mtime: st.mtimeMs, buf };
  } catch (error) {
    const code = error?.code;
    if (code === 'ELOOP' || code === 'EINVAL') return { refused: 'symlink' };
    return { refused: 'unreadable' };
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* the read already failed closed */ }
    }
  }
}

function isoTime(ms) {
  if (!Number.isFinite(ms)) return null;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function clipUtf8(text, maxBytes) {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return { content: text, contentTruncated: false };
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0b11000000) === 0b10000000) end -= 1;
  return { content: buf.subarray(0, end).toString('utf8'), contentTruncated: true };
}

// Strict bounded UTF-8; embedded NULs mean this is not text under review. A leading BOM is
// already removed by the decoder, so there is nothing left to strip here.
function utf8Text(buf) {
  let text = null;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { text = null; }
  if (text === null || text.includes('\0')) return null;
  return text;
}

function precedenceFor(items, truncated) {
  const conflicts = [];
  const byGroup = new Map();
  for (const item of items) {
    if (!PRECEDENCE_KINDS.includes(item.kind)) continue;
    const key = `${item.root}\0${item.kind}`;
    if (!byGroup.has(key)) byGroup.set(key, []);
    byGroup.get(key).push(item);
  }
  for (const group of byGroup.values()) {
    if (group.length < 2) continue;
    const candidates = group
      .map((item) => ({ id: item.id, path: item.path, depth: item.depth }))
      .sort((a, b) => a.depth - b.depth || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const tie = candidates[0].depth === candidates[1].depth;
    conflicts.push({
      root: group[0].root,
      kind: group[0].kind,
      rule: 'nearest-to-root-wins',
      resolved: false,
      tie,
      winnerId: tie ? null : candidates[0].id,
      candidates,
    });
  }
  return {
    ...AGENTIC_PRECEDENCE_RULE,
    incomplete: truncated,
    conflicts,
  };
}

function scan(roots, limits) {
  const items = [];
  const skipped = [];
  const reasons = new Set();
  let scanned = 0;
  let stop = false;
  let skippedTruncated = false;

  function note(rel, reason, rootId) {
    reasons.add(reason);
    if (skipped.length >= limits.maxSkipped) {
      skippedTruncated = true;
      reasons.add('skipped-list-capped');
      return;
    }
    skipped.push({ path: rel, reason, root: rootId });
  }

  function considerFile(root, realRoot, full, rel) {
    const kind = classify(rel);
    if (!kind) return;
    if (items.length >= limits.maxFiles) {
      stop = true;
      reasons.add('max-files');
      return;
    }
    const read = readRegular(full, realRoot, limits);
    if (read.refused) {
      note(rel, read.refused, root.id);
      return;
    }
    const depth = rel.split('/').length - 1;
    const base = {
      id: fileId(root.id, rel),
      kind,
      path: rel,
      root: root.id,
      depth,
      bytes: read.bytes,
      sha256: null,
      mtime: isoTime(read.mtime),
      frontmatter: null,
      title: rel.split('/').pop(),
      source: 'local-file',
      trust: 'untrusted-until-confirmed',
      text: false,
    };
    if (read.overCap) {
      reasons.add('over-cap');
      items.push(base);
      return;
    }
    const sha256 = createHash('sha256').update(read.buf).digest('hex');
    const text = utf8Text(read.buf);
    if (text === null) {
      items.push({ ...base, sha256, text: false });
      return;
    }
    const parsed = parseFrontmatter(text, limits);
    if (parsed.status === 'rejected') reasons.add('frontmatter-rejected');
    items.push({
      ...base,
      sha256,
      frontmatter: parsed.frontmatter,
      title: titleOf(rel, parsed.frontmatter, parsed.body, limits.maxTitle),
      text: true,
    });
  }

  function walk(root, realRoot, dir, relDir, depth, report) {
    if (stop) return;
    let dirents;
    try { dirents = readdirSync(dir, { withFileTypes: true }); }
    catch {
      if (samePath(dir, root.resolved)) report.status = 'unreadable';
      note(relDir || '.', 'unreadable', root.id);
      return;
    }
    dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const dirent of dirents) {
      if (stop) return;
      if (scanned >= limits.maxEntries) {
        stop = true;
        reasons.add('max-entries');
        return;
      }
      scanned += 1;
      if (!safeName(dirent.name)) {
        note(relDir || '.', 'rejected-name', root.id);
        continue;
      }
      const full = path.resolve(dir, dirent.name);
      const rel = inside(root.resolved, full);
      if (rel === null) {
        note(relDir || '.', 'outside-root', root.id);
        continue;
      }
      const policy = policyDirName(dirent.name);
      if (policy) {
        note(rel, policy, root.id);
        continue;
      }
      let st;
      try { st = lstatSync(full); }
      catch {
        note(rel, 'unreadable', root.id);
        continue;
      }
      if (st.isSymbolicLink()) {
        note(rel, 'symlink', root.id);
        continue;
      }
      // No-follow beyond lstat: the entry's own real path must stay inside the root's real
      // path, so a junctioned ancestor or aliased layout cannot move the tree outside.
      let real;
      try { real = realpathSync(full); }
      catch {
        note(rel, 'unreadable', root.id);
        continue;
      }
      if (!realInside(realRoot, real)) {
        note(rel, 'escaped-root', root.id);
        continue;
      }
      if (st.isDirectory()) {
        if (depth >= limits.maxDepth) {
          note(rel, 'depth', root.id);
          continue;
        }
        walk(root, realRoot, full, rel, depth + 1, report);
        continue;
      }
      if (!st.isFile()) {
        note(rel, 'special', root.id);
        continue;
      }
      considerFile(root, realRoot, full, rel);
    }
  }

  const rootReports = [];
  for (const root of roots) {
    if (stop) {
      rootReports.push({ id: root.id, untrusted: root.untrusted, status: 'not-scanned', skipReason: 'truncated' });
      reasons.add('max-files');
      continue;
    }
    let st;
    try { st = lstatSync(root.resolved); }
    catch {
      note('.', 'root-missing', root.id);
      rootReports.push({ id: root.id, untrusted: root.untrusted, status: 'skipped', skipReason: 'root-missing' });
      continue;
    }
    if (st.isSymbolicLink()) {
      note('.', 'symlink', root.id);
      rootReports.push({ id: root.id, untrusted: root.untrusted, status: 'skipped', skipReason: 'symlink' });
      continue;
    }
    if (!st.isDirectory()) {
      note('.', 'not-a-directory', root.id);
      rootReports.push({ id: root.id, untrusted: root.untrusted, status: 'skipped', skipReason: 'not-a-directory' });
      continue;
    }
    let realRoot;
    try { realRoot = realpathSync(root.resolved); }
    catch {
      note('.', 'unreadable', root.id);
      rootReports.push({ id: root.id, untrusted: root.untrusted, status: 'unreadable', skipReason: null });
      continue;
    }
    // Status lands here only after the walk: 'scanned' means it really finished.
    const report = { id: root.id, untrusted: root.untrusted, status: 'scanned', skipReason: null };
    walk(root, realRoot, root.resolved, '', 0, report);
    if (report.status === 'scanned' && stop) report.status = 'partial';
    rootReports.push(report);
  }

  const policy = new Set(['git', 'node_modules']);
  const hiding = [...reasons].filter((reason) => !policy.has(reason) && reason !== 'frontmatter-rejected');
  const truncated = hiding.length > 0;
  const precedence = precedenceFor(items, truncated);
  const coverage = {
    complete: hiding.length === 0 && !skippedTruncated,
    scanned,
    matched: items.length,
    skipped,
    skippedTruncated,
    truncated,
    reasons: [...reasons].sort(),
    limits: { ...limits },
    roots: rootReports,
    excludedByPolicy: ['.git', 'node_modules'],
    qualification: QUALIFICATION,
  };
  return { items, coverage, precedence };
}

export function createAgenticFileLibrary({ roots, limits, idCacheTtlMs } = {}) {
  const rootList = normalizeRoots(roots);
  const bounds = boundsWith(limits);
  const ttlMs = idCacheTtlMs === undefined ? 1000 : integer(idCacheTtlMs, 1000, 60000, 0);
  // Bounded id registry: one scan mints id -> {rootId, rel, kind}; list() rebuilds it, get()
  // reuses it until the TTL expires, then rebuilds at most once per call on a miss.
  let registry = null;
  let registryAt = 0;

  function ensureRegistry(force = false) {
    const now = Date.now();
    if (!force && registry && now - registryAt <= ttlMs) return registry;
    const found = scan(rootList, bounds);
    const map = new Map();
    for (const item of found.items) map.set(item.id, { rootId: item.root, rel: item.path, kind: item.kind });
    registry = map;
    registryAt = now;
    return map;
  }

  function list(q = {}) {
    if (q !== undefined && (!q || typeof q !== 'object' || Array.isArray(q))) throw problem(400, 'query must be an object');
    const found = scan(rootList, bounds);
    const map = new Map();
    for (const item of found.items) map.set(item.id, { rootId: item.root, rel: item.path, kind: item.kind });
    registry = map;
    registryAt = Date.now();
    let items = found.items.map((item) => {
      const { depth, ...rest } = item;
      void depth;
      return rest;
    });
    if (q.kind !== undefined) {
      if (!AGENTIC_FILE_KINDS.includes(q.kind)) throw problem(400, 'kind is not a known agentic file kind');
      items = items.filter((item) => item.kind === q.kind);
    }
    if (q.offset !== undefined || q.limit !== undefined) {
      const offset = integer(q.offset, 0, 100000);
      const limit = integer(q.limit, 100, 1000, 1);
      return {
        items: items.slice(offset, offset + limit),
        total: items.length,
        offset,
        limit,
        nextOffset: offset + limit < items.length ? offset + limit : null,
        coverage: found.coverage,
        precedence: found.precedence,
      };
    }
    return { items, total: items.length, coverage: found.coverage, precedence: found.precedence };
  }

  function get(id) {
    if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw problem(400, 'id must be a sha256 hex digest');
    let entry = ensureRegistry().get(id);
    if (!entry) entry = ensureRegistry(true).get(id);
    if (!entry) throw NOT_FOUND();
    const root = rootList.find((candidate) => candidate.id === entry.rootId);
    if (!root) throw NOT_FOUND();
    const full = path.resolve(root.resolved, ...entry.rel.split('/'));
    if (inside(root.resolved, full) !== entry.rel) throw NOT_FOUND();
    let realRoot;
    try { realRoot = realpathSync(root.resolved); } catch { throw NOT_FOUND(); }
    const read = readRegular(full, realRoot, bounds);
    if (!read || read.refused) {
      // A listed file that vanished, moved through a link, or lost its reason is the same
      // not-found as an unknown id: the registry never leaks whether a path taxon exists.
      throw NOT_FOUND();
    }
    const record = {
      id,
      kind: entry.kind,
      path: entry.rel,
      root: entry.rootId,
      bytes: read.bytes,
      sha256: read.overCap ? null : createHash('sha256').update(read.buf).digest('hex'),
      mtime: isoTime(read.mtime),
      title: entry.rel.split('/').pop(),
      source: 'local-file',
      trust: 'untrusted-until-confirmed',
      text: false,
    };
    if (read.overCap) {
      return { ...record, frontmatter: null, content: null, contentTruncated: false, contentState: 'over-cap' };
    }
    const text = utf8Text(read.buf);
    if (text === null) {
      return { ...record, frontmatter: null, content: null, contentTruncated: false, contentState: 'not-text' };
    }
    const parsed = parseFrontmatter(text, bounds);
    record.frontmatter = parsed.frontmatter;
    record.title = titleOf(entry.rel, parsed.frontmatter, parsed.body, bounds.maxTitle);
    record.text = true;
    const clipped = clipUtf8(text, bounds.maxContentBytes);
    return {
      ...record,
      ...clipped,
      contentState: clipped.contentTruncated ? 'truncated' : 'full',
    };
  }

  return { list, get };
}

// Mounting is an explicit caller action: registerAgenticFileRoutes must be invoked by a
// parent that owns a router; nothing in this module mounts routes by itself.
export function registerAgenticFileRoutes({ add, library, roots, limits } = {}) {
  if (typeof add !== 'function') throw new TypeError('registerAgenticFileRoutes requires the hub add() function');
  const lib = library ?? (roots ? createAgenticFileLibrary({ roots, limits }) : null);
  if (!lib) throw new TypeError('registerAgenticFileRoutes requires a library or explicit roots');
  add('GET', '/agentic-files', 'Bounded read-only inventory of local agentic instruction files', ({ q } = {}) => lib.list(q ?? {}));
  add('GET', '/agentic-files/{id}', 'Bounded text read of one inventoried agentic file', ({ p } = {}) => lib.get(p?.id));
}
