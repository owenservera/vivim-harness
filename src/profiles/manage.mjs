// Profile management helpers used by the CLI: summaries, URL matching explanation, linting,
// path-based edits, host editing and creation. Pure functions over profile objects plus thin
// readers over a ProfileStore; every mutation returns a new profile and leaves saving (which
// creates a new immutable version) to the caller.
import { normalizeProfile, hostMatchScore, siteOf } from './profiles.mjs';

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const DELTA_DIALECTS = ['auto', 'none', 'json-patch', 'typed-events', 'path-ops'];
const PROTECTED_KEYS = new Set(['name', 'version', 'savedAt', 'changeNote']);

export class ProfileError extends Error {
  constructor(message, code = 'PROFILE_ERROR') { super(message); this.name = 'ProfileError'; this.code = code; }
}

export const isValidProfileName = (n) => typeof n === 'string' && NAME_RE.test(n);

export function summarizeProfile(store, name) {
  const p = store.load(name);
  const versions = store.versions(name);
  return {
    name,
    current: store.current(name),
    versions: versions.length,
    updatedAt: versions.at(-1)?.savedAt ?? null,
    family: p.family ?? null,
    hosts: p.match?.hosts ?? [],
    records: (p.records ?? []).length,
    familyMappings: (p.familyMappings ?? []).length,
    accepted: (p.shapes?.accepted ?? []).length,
    rejected: (p.shapes?.excluded ?? []).length,
    description: p.description ?? '',
  };
}

export function listProfileSummaries(store) {
  return store.names().map((n) => summarizeProfile(store, n));
}

// Which profiles match a URL and how strongly; mirrors ProfileStore.selectFor so the answer is the same
// profile the recorder would pick.
export function explainMatch(store, url) {
  let host = '';
  try { host = new URL(url).hostname; } catch { throw new ProfileError(`"${url}" is not a valid URL (include http:// or https://).`, 'BAD_URL'); }
  const candidates = [];
  for (const name of store.names()) {
    const p = store.load(name);
    let best = null;
    for (const pattern of p.match?.hosts ?? []) {
      const score = hostMatchScore(host, pattern);
      if (score >= 0 && (!best || score > best.score)) best = { pattern, score };
    }
    if (best) candidates.push({ name, version: p.version, pattern: best.pattern, score: best.score });
  }
  candidates.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  const selected = store.selectFor(url);
  return { url, host, site: siteOf(host), selected: { name: selected.name, version: selected.version }, candidates };
}

// Structural lint: returns [{ level: 'error'|'warn', path, message }].
export function lintProfile(profile) {
  const issues = [];
  const add = (level, path, message) => issues.push({ level, path, message });
  const p = profile ?? {};
  if (!isValidProfileName(p.name)) add('error', 'name', `invalid profile name "${p.name}" (letters, digits, . _ -; max 64)`);
  const hosts = p.match?.hosts;
  if (!Array.isArray(hosts) || !hosts.length) add('error', 'match.hosts', 'at least one host pattern is required (use "*" for any site)');
  else for (const [i, h] of hosts.entries()) {
    if (typeof h !== 'string' || !h.trim()) add('error', `match.hosts[${i}]`, 'host pattern must be a non-empty string');
    else if (/[\s/:]/.test(h)) add('error', `match.hosts[${i}]`, `"${h}" must be a bare hostname or "*.domain" pattern (no scheme, port or path)`);
    else if (h !== '*' && h.includes('*') && !h.startsWith('*.')) add('error', `match.hosts[${i}]`, `"${h}": wildcards are only supported as "*" or a leading "*."`);
  }
  for (const key of ['include', 'exclude', 'sensitive']) {
    for (const [i, pat] of (p.capture?.[key] ?? []).entries()) {
      try { new RegExp(pat); } catch (e) { add('error', `capture.${key}[${i}]`, `invalid regular expression: ${e.message}`); }
    }
  }
  if (p.decode?.delta !== undefined && !DELTA_DIALECTS.includes(p.decode.delta)) add('warn', 'decode.delta', `unknown dialect "${p.decode.delta}" (known: ${DELTA_DIALECTS.join(', ')})`);
  if (!Array.isArray(p.scope?.origins) || !p.scope.origins.length) add('warn', 'scope.origins', 'no scope origins: nothing will be captured');
  const names = new Set();
  for (const [i, r] of (p.records ?? []).entries()) {
    const at = `records[${i}]`;
    if (!r?.name) add('error', `${at}.name`, 'record rule needs a name');
    else if (names.has(r.name)) add('error', `${at}.name`, `duplicate record rule "${r.name}"`);
    else names.add(r.name);
    if (r?.name && !/^[A-Za-z0-9._-]+$/.test(r.name)) add('error', `${at}.name`, `"${r.name}": record names become dataset file names (letters, digits, . _ -)`);
    if (r?.endpoint) { try { new RegExp(r.endpoint); } catch (e) { add('error', `${at}.endpoint`, `invalid regular expression: ${e.message}`); } }
    else if (r?.source !== 'assembled') add('warn', `${at}.endpoint`, 'no endpoint pattern: rule will match every stream');
    if (!r?.fields || !Object.keys(r.fields).length) add('warn', `${at}.fields`, 'rule extracts no fields');
    if (r?.revisions === 'final' && !r.key) add('warn', `${at}.key`, 'revisions "final" needs a key to know which observations are the same record');
  }
  if ((p.familyMappings ?? []).length && !p.family) add('warn', 'family', 'familyMappings are set but no family is linked');
  if (p.family && !(p.familyMappings ?? []).length) add('warn', 'familyMappings', `family "${p.family}" is linked but nothing maps into it yet (accept a link_family suggestion)`);
  if ((hosts ?? []).length === 1 && hosts[0] === '*' && (p.records ?? []).length) add('warn', 'match.hosts', 'record rules on a wildcard-host profile apply to every site');
  return issues;
}

// ---------------------------------------------------------------------------------------------
// Path-based edits:  capture.websockets=false   capture.exclude+=\.png   match.hosts-=old.example
// ---------------------------------------------------------------------------------------------
export function parseAssignment(text) {
  const m = /^([A-Za-z0-9_.\[\]-]+?)(\+=|-=|=)([\s\S]*)$/.exec(String(text));
  if (!m) throw new ProfileError(`"${text}" is not an assignment; use path=value, path+=value or path-=value`, 'BAD_ASSIGNMENT');
  const [, p, op, raw] = m;
  let value = raw;
  try { value = JSON.parse(raw); } catch { /* plain string */ }
  return { path: p, op, value };
}

const splitPath = (p) => p.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);

function walkTo(root, parts, create) {
  let cur = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (cur[part] === undefined || cur[part] === null) { if (!create) return null; cur[part] = /^\d+$/.test(parts[i + 1] ?? '') ? [] : {}; }
    if (typeof cur[part] !== 'object') throw new ProfileError(`"${part}" is not an object; cannot descend into it`, 'BAD_PATH');
    cur = cur[part];
  }
  return cur;
}

function assertEditable(parts) {
  if (!parts.length) throw new ProfileError('Empty path', 'BAD_PATH');
  if (PROTECTED_KEYS.has(parts[0]) && parts.length === 1) throw new ProfileError(`"${parts[0]}" is managed by the store and cannot be edited`, 'PROTECTED');
  if (parts.some((x) => x === '__proto__' || x === 'constructor' || x === 'prototype')) throw new ProfileError('Refusing to edit prototype keys', 'BAD_PATH');
}

export function applyAssignments(profile, assignments) {
  const p = structuredClone(profile);
  const changes = [];
  for (const a of assignments) {
    const { path, op, value } = typeof a === 'string' ? parseAssignment(a) : a;
    const parts = splitPath(path);
    assertEditable(parts);
    const parent = walkTo(p, parts, true);
    const key = parts.at(-1);
    const before = parent[key];
    if (op === '=') parent[key] = value;
    else if (op === '+=') {
      const arr = before === undefined ? [] : before;
      if (!Array.isArray(arr)) throw new ProfileError(`${path} is not a list; use ${path}=value`, 'NOT_A_LIST');
      parent[key] = arr.includes(value) ? arr : [...arr, value];
    } else {
      if (!Array.isArray(before)) throw new ProfileError(`${path} is not a list; use unset`, 'NOT_A_LIST');
      parent[key] = before.filter((x) => JSON.stringify(x) !== JSON.stringify(value));
    }
    changes.push({ path, op, from: before, to: parent[key] });
  }
  return { profile: p, changes };
}

export function unsetPaths(profile, paths) {
  const p = structuredClone(profile);
  const changes = [];
  for (const path of paths) {
    const parts = splitPath(path);
    assertEditable(parts);
    const parent = walkTo(p, parts, false);
    const key = parts.at(-1);
    if (!parent || !(key in parent)) { changes.push({ path, op: 'unset', from: undefined, to: undefined, noop: true }); continue; }
    const before = parent[key];
    if (Array.isArray(parent)) parent.splice(Number(key), 1); else delete parent[key];
    changes.push({ path, op: 'unset', from: before, to: undefined });
  }
  return { profile: p, changes };
}

// ---------------------------------------------------------------------------------------------
// Hosts, creation
// ---------------------------------------------------------------------------------------------
export function editHosts(profile, { add = [], remove = [] } = {}) {
  const p = structuredClone(profile);
  p.match ??= {};
  const set = new Set(p.match.hosts ?? []);
  for (const h of add) set.add(h);
  for (const h of remove) set.delete(h);
  p.match.hosts = [...set];
  return { profile: p, note: `hosts: ${[add.length ? `+${add.join(', +')}` : '', remove.length ? `-${remove.join(', -')}` : ''].filter(Boolean).join(' ') || 'unchanged'}` };
}

// New profile derived from a base (default "generic"), with its own hosts and optional family link.
export function buildProfile(base, { name, hosts, description, family }) {
  if (!isValidProfileName(name)) throw new ProfileError(`Invalid profile name "${name}" (letters, digits, . _ -; max 64)`, 'BAD_NAME');
  const hostList = (hosts ?? []).filter(Boolean);
  if (!hostList.length) throw new ProfileError('At least one host is required (e.g. --hosts example.com,*.example.com).', 'NO_HOSTS');
  const p = normalizeProfile(structuredClone(base));
  p.name = name;
  p.description = description ?? `Site profile created from ${base.name}`;
  p.match = { ...p.match, hosts: hostList };
  // Scope is inherited from the base (generic = same-site), which already covers sibling API hosts.
  p.family = family ?? p.family ?? null;
  p.shapes = { renames: {}, excluded: [], accepted: [] };
  return p;
}

// Validate an imported profile object before it is saved as a new version.
export function validateImport(obj, { requireName = true } = {}) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new ProfileError('Profile file must contain a JSON object.', 'BAD_IMPORT');
  if (requireName && !obj.name) throw new ProfileError('Profile file has no "name" (pass --name to choose one).', 'BAD_IMPORT');
  const issues = lintProfile(normalizeProfile(obj));
  const errors = issues.filter((i) => i.level === 'error');
  if (errors.length) throw new ProfileError(`Profile has ${errors.length} error(s):\n  ${errors.map((e) => `${e.path}: ${e.message}`).join('\n  ')}`, 'BAD_IMPORT');
  return issues;
}

// How many saved sessions were captured with each profile (from session metadata only).
export function profileUsage(sessions) {
  const out = {};
  for (const s of sessions) { const n = s.profile?.name; if (n) out[n] = (out[n] ?? 0) + 1; }
  return out;
}
