// Versioned site profiles: generic core + per-site overrides. Every save creates a new immutable
// version; CURRENT points at the active one, so a bad change is a one-command rollback.
import path from 'node:path';
import { TOOL_ROOT } from '../config.mjs';
import { VersionedStore } from '../store/versioned.mjs';

export const DEFAULT_PROFILE = {
  name: 'generic',
  version: 1,
  description: 'Site-agnostic defaults: same-site scope, stream all API-like responses, observe DOM.',
  match: { hosts: ['*'] },
  scope: { origins: ['same-site'], thirdParty: 'ignore' },
  capture: {
    bodyResourceTypes: ['Fetch', 'XHR', 'EventSource', 'Document', 'Other'],
    include: [],
    exclude: [],
    sensitive: [],
    websockets: true,
    wsSentFrames: false,
    requestBodies: false,
    retrospectiveFallback: true,
  },
  dom: { enabled: true, roots: ['main', 'body'], ignoreTags: ['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'], maxBlockTextBytes: 262144, flushMs: 100 },
  decode: { delta: 'auto', overrides: [] },
  shapes: { renames: {}, excluded: [], accepted: [] },
  records: [],
  family: null,
  familyMappings: [],
  notes: [],
};

function deepMerge(base, over) {
  if (Array.isArray(over) || typeof over !== 'object' || over === null) return over === undefined ? base : over;
  const out = { ...(base ?? {}) };
  for (const [k, v] of Object.entries(over)) out[k] = (v && typeof v === 'object' && !Array.isArray(v)) ? deepMerge(base?.[k], v) : v;
  return out;
}

export function normalizeProfile(p) { return deepMerge(structuredClone(DEFAULT_PROFILE), p ?? {}); }

export class ProfileStore extends VersionedStore {
  constructor(dir) { super(dir, { builtinDir: path.join(TOOL_ROOT, 'profiles'), normalize: normalizeProfile, kind: 'profile' }); }

  // Pick the most specific profile whose host patterns match the URL; fallback "generic".
  selectFor(url) {
    let host = '';
    try { host = new URL(url).hostname; } catch { /* ignore */ }
    let best = null, bestScore = -1;
    for (const n of this.names()) {
      const p = this.load(n);
      for (const pat of p.match?.hosts ?? []) {
        const score = hostMatchScore(host, pat);
        if (score > bestScore) { best = p; bestScore = score; }
      }
    }
    return best ?? normalizeProfile({});
  }
}

export function hostMatchScore(host, pattern) {
  if (pattern === '*') return 0;
  if (pattern.startsWith('*.')) { const base = pattern.slice(2); return host === base || host.endsWith('.' + base) ? base.length : -1; }
  return host === pattern ? pattern.length + 1000 : -1;
}

const MULTI_SUFFIX = new Set(['co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'co.jp', 'com.br', 'com.mx', 'co.nz', 'com.es', 'com.ar', 'co.in', 'com.cn', 'com.tr']);
export function siteOf(host) {
  const parts = host.split('.').filter(Boolean);
  if (parts.length <= 2 || /^\d+$/.test(parts.at(-1))) return host;
  const last2 = parts.slice(-2).join('.');
  return MULTI_SUFFIX.has(last2) ? parts.slice(-3).join('.') : last2;
}

// Is a request URL inside the profile scope, relative to the page URL?
export function inScope(profile, requestUrl, pageUrl) {
  let rh, ph;
  try { rh = new URL(requestUrl).hostname; } catch { return false; }
  try { ph = new URL(pageUrl).hostname; } catch { ph = ''; }
  for (const o of profile.scope?.origins ?? ['same-site']) {
    if (o === 'same-site' && ph && siteOf(rh) === siteOf(ph)) return true;
    if (o === 'same-origin' && rh === ph) return true;
    if (o === '*') return true;
    if (o !== 'same-site' && o !== 'same-origin' && hostMatchScore(rh, o) >= 0) return true;
  }
  return false;
}

export function profileDiff(a, b, prefix = '') {
  const out = [];
  const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
  for (const k of keys) {
    if (['savedAt', 'version', 'changeNote'].includes(k) && !prefix) continue;
    const p = prefix ? `${prefix}.${k}` : k;
    const x = a?.[k], y = b?.[k];
    if (x && y && typeof x === 'object' && typeof y === 'object' && !Array.isArray(x) && !Array.isArray(y)) out.push(...profileDiff(x, y, p));
    else if (JSON.stringify(x) !== JSON.stringify(y)) out.push({ path: p, from: x, to: y });
  }
  return out;
}
