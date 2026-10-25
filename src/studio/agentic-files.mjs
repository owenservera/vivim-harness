// C-11 agentic file library. Read-only inventory of instruction files under caller-supplied
// roots. It never executes, evaluates, imports, or follows instructions found in those files,
// never follows symlinks, and never reads outside a root. Untrusted roots cannot raise capability.
import { createHash } from 'node:crypto';
import {
  closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync,
} from 'node:fs';
import path from 'node:path';
import { integer, problem } from './http.mjs';

export const AGENTIC_FILE_KINDS = Object.freeze(['agents', 'claude', 'opencode-agent', 'skill', 'docs-agent']);
const PRECEDENCE_KINDS = Object.freeze(['agents', 'claude']);
const CLAIM_KEYS = new Set([
  'allow', 'autonomy', 'capabilities', 'capability', 'command', 'commands', 'exec', 'execute',
  'permissions', 'raisesCapability', 'shell', 'tools',
]);

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

const QUALIFICATION = 'Scan covers regular files matching AGENTS.md, CLAUDE.md, SKILL.md, .opencode/agents/*.md, and docs/agents/*.md under the explicit roots. .git and node_modules are excluded by policy. Symlinks are not followed. complete means every in-policy match was visited and hashed in full; it does not mean unread, excluded, or remote files do not exist. Precedence is not applied. trust stays untrusted-until-confirmed. A root flagged untrusted, and this library generally, cannot raise capability.';

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

function normalizeRoots(roots) {
  if (!Array.isArray(roots)) throw new TypeError('roots must be an explicit array of directories');
  if (roots.length > 32) throw new TypeError('roots exceeds 32');
  const seen = new Set();
  return roots.map((entry, index) => {
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
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) throw new TypeError(`roots[${index}] duplicates another root`);
    seen.add(key);
    const untrusted = spec.untrusted !== false;
    const id = spec.id ?? (`r${createHash('sha256').update(key).digest('hex').slice(0, 16)}`);
    return { id, resolved, untrusted };
  });
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
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._/:+-]{0,499}$/.test(raw)) return REJECT;
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
    if (!match || CLAIM_KEYS.has(match[1]) === false && (match[1] === '__proto__' || match[1] === 'prototype' || match[1] === 'constructor')) {
      return { frontmatter: null, status: 'rejected', body: text };
    }
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
  title = title.replace(/[\u0000-\u001f]/g, ' ').trim();
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

function claimsIgnored(frontmatter) {
  if (!frontmatter) return false;
  return Object.keys(frontmatter).some((key) => CLAIM_KEYS.has(key));
}

function readRegular(full, limits) {
  let fd;
  try {
    const before = lstatSync(full);
    if (before.isSymbolicLink() || !before.isFile()) return { refused: 'symlink' };
    if (!Number.isSafeInteger(before.size) || before.size < 0) return { refused: 'unreadable' };
    if (before.size > limits.maxFileBytes) return { overCap: true, bytes: before.size, mtime: before.mtimeMs };
    const flags = constants.O_RDONLY | (process.platform === 'win32' ? 0 : (constants.O_NOFOLLOW || 0));
    fd = openSync(full, flags);
    const st = fstatSync(fd);
    if (!st.isFile() || st.isSymbolicLink?.()) return { refused: 'symlink' };
    if (!Number.isSafeInteger(st.size) || st.size < 0 || st.size > limits.maxFileBytes) return { overCap: true, bytes: st.size, mtime: st.mtimeMs };
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

  function considerFile(root, full, rel, stSizeKnown) {
    const kind = classify(rel);
    if (!kind) return;
    if (items.length >= limits.maxFiles) {
      stop = true;
      reasons.add('max-files');
      return;
    }
    const read = readRegular(full, limits);
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
      raisesCapability: false,
      capability: Object.freeze({
        raised: false,
        ceiling: 'none',
        reason: root.untrusted ? 'untrusted-root' : 'execution-free',
        claimsIgnored: false,
      }),
      text: false,
    };
    if (read.overCap) {
      reasons.add('over-cap');
      items.push(base);
      return;
    }
    const sha256 = createHash('sha256').update(read.buf).digest('hex');
    let text = null;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(read.buf); }
    catch { text = null; }
    if (text?.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    if (text?.includes('\0')) text = null;
    if (text === null) {
      items.push({ ...base, sha256, text: false });
      return;
    }
    const parsed = parseFrontmatter(text, limits);
    if (parsed.status === 'rejected') reasons.add('frontmatter-rejected');
    const ignored = claimsIgnored(parsed.frontmatter);
    items.push({
      ...base,
      sha256,
      frontmatter: parsed.frontmatter,
      title: titleOf(rel, parsed.frontmatter, parsed.body, limits.maxTitle),
      text: true,
      raisesCapability: false,
      capability: Object.freeze({
        raised: false,
        ceiling: 'none',
        reason: root.untrusted ? 'untrusted-root' : 'execution-free',
        claimsIgnored: ignored,
      }),
    });
    void stSizeKnown;
  }

  function walk(root, dir, relDir, depth) {
    if (stop) return;
    let dirents;
    try { dirents = readdirSync(dir, { withFileTypes: true }); }
    catch {
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
      if (dirent.name === 'node_modules' || dirent.name === '.git') {
        note(rel, dirent.name === '.git' ? 'git' : 'node_modules', root.id);
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
      if (st.isDirectory()) {
        if (depth >= limits.maxDepth) {
          note(rel, 'depth', root.id);
          continue;
        }
        walk(root, full, rel, depth + 1);
        continue;
      }
      if (!st.isFile()) {
        note(rel, 'special', root.id);
        continue;
      }
      considerFile(root, full, rel, st.size);
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
    rootReports.push({ id: root.id, untrusted: root.untrusted, status: 'scanned', skipReason: null });
    walk(root, root.resolved, '', 0);
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

export function createAgenticFileLibrary({ roots, limits } = {}) {
  const rootList = normalizeRoots(roots);
  const bounds = boundsWith(limits);

  function listed() {
    return scan(rootList, bounds);
  }

  function list(q = {}) {
    if (q !== undefined && (!q || typeof q !== 'object' || Array.isArray(q))) throw problem(400, 'query must be an object');
    const found = listed();
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
    const found = listed().items.find((item) => item.id === id);
    if (!found) throw problem(404, 'Agentic file not found', 'AGENTIC_NOT_FOUND');
    const root = rootList.find((entry) => entry.id === found.root);
    const full = path.resolve(root.resolved, ...found.path.split('/'));
    if (inside(root.resolved, full) !== found.path) throw problem(400, 'Agentic file path is outside its root');
    const read = readRegular(full, bounds);
    if (!read || read.refused || read.overCap || !read.buf) {
      return publicRecord(found, { content: null, contentTruncated: false, contentState: read?.overCap ? 'over-cap' : 'unreadable' });
    }
    const sha256 = createHash('sha256').update(read.buf).digest('hex');
    if (sha256 !== found.sha256) {
      return publicRecord({ ...found, sha256, bytes: read.bytes, mtime: isoTime(read.mtime) }, {
        content: null, contentTruncated: false, contentState: 'integrity-changed',
      });
    }
    let text = null;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(read.buf); }
    catch { text = null; }
    if (text?.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    if (text?.includes('\0')) text = null;
    if (text === null) return publicRecord(found, { content: null, contentTruncated: false, contentState: 'not-text' });
    const clipped = clipUtf8(text, bounds.maxContentBytes);
    return publicRecord(found, { ...clipped, contentState: clipped.contentTruncated ? 'truncated' : 'full' });
  }

  return { list, get };
}

function publicRecord(found, content) {
  const { depth, ...rest } = found;
  void depth;
  return {
    ...rest,
    source: 'local-file',
    trust: 'untrusted-until-confirmed',
    raisesCapability: false,
    capability: Object.freeze({
      raised: false,
      ceiling: 'none',
      reason: rest.capability?.reason === 'execution-free' ? 'execution-free' : 'untrusted-root',
      claimsIgnored: rest.capability?.claimsIgnored === true,
    }),
    ...content,
  };
}

// Optional routes for the existing Studio hub. The parent registers them; this module does not.
export function registerAgenticFileRoutes({ add, library, roots, limits } = {}) {
  if (typeof add !== 'function') throw new TypeError('registerAgenticFileRoutes requires the hub add() function');
  const lib = library ?? (roots ? createAgenticFileLibrary({ roots, limits }) : null);
  if (!lib) throw new TypeError('registerAgenticFileRoutes requires a library or explicit roots');
  add('GET', '/agentic-files', 'Bounded read-only inventory of local agentic instruction files', ({ q } = {}) => lib.list(q ?? {}));
  add('GET', '/agentic-files/{id}', 'Bounded text read of one inventoried agentic file', ({ p } = {}) => lib.get(p?.id));
}
