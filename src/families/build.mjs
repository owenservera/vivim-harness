// Family/shape consolidation: turn every derived session of one site into ONE normalised
// family shape set. Reuses the existing artifacts, never a second store or format:
//   - sessions and their kv      src/store/session.mjs  (listSessions, Session.open)
//   - derived shape report       src/shapes/infer.mjs   (SHAPES: endpoints[], groups[] written by derive)
//   - delta dialects             src/replay/derive.mjs  (ASSEMBLED: {sid: {endpoint, dialects}})
//   - family records + versions  src/families/families.mjs (FamilyStore -> VersionedStore vNNNN.json + CURRENT)
//   - profile draft              src/profiles/profiles.mjs + src/profiles/manage.mjs (buildProfile)
// Determinism: every collection is sorted and the signature hashes only the normalised shape set,
// so two runs over the same sessions produce byte-identical objects.
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Session, listSessions } from '../store/session.mjs';
import { FamilyStore } from './families.mjs';
import { siteOf, ProfileStore } from '../profiles/profiles.mjs';
import { buildProfile } from '../profiles/manage.mjs';
import { readAcceptance } from '../capture/acceptance.mjs';

const SIG_NOTE = 'family shape set v1';

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const sorted = (iterable) => [...iterable].sort(cmp);

// Endpoint string ("GET https://host/a/123", "WS wss://host/x") -> stable path pattern.
export function pathPattern(endpoint) {
  const s = String(endpoint ?? '');
  const i = s.indexOf(' ');
  const rest = i > 0 ? s.slice(i + 1) : s;
  let u = null;
  try { u = new URL(rest); } catch { if (rest.startsWith('//')) { try { u = new URL(`http:${rest}`); } catch { u = null; } } }
  let p = u ? u.pathname : rest.split('?')[0].split('#')[0];
  if (!u) p = /^\/\//.test(rest) ? p.replace(/^\/\/[^/]*/, '') : rest.startsWith('/') ? p : p.replace(/^[^/]*/, '');
  p = p
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=\/|$)/gi, '/{id}')
    .replace(/\/[0-9a-f]{16,}(?=\/|$)/gi, '/{id}')
    .replace(/\/\d+(?=\/|$)/g, '/{id}')
    .replace(/\/{2,}/g, '/');
  if (!p.startsWith('/')) p = `/${p}`;
  return p || '/';
}

// The transport that carried most of this endpoint's streams (ties broken by name).
function dominantTransport(ep) {
  const entries = Object.entries(ep?.transports ?? {});
  if (!entries.length) return 'UNKNOWN';
  entries.sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0) || cmp(a[0], b[0]));
  return entries[0][0];
}

function hostOf(session) {
  try { return new URL(session.meta?.target?.url).hostname.toLowerCase(); } catch { return ''; }
}

// A site slug / common hostname is not an identity or an account boundary.
// Only an exact HTTP(S) page origin can be used for a published family shape.
function pageOrigin(session) {
  try {
    const u = new URL(session.meta?.target?.url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : null;
  } catch { return null; }
}
function endpointOrigin(endpoint) {
  try {
    const raw = String(endpoint ?? '');
    const rest = raw.includes(' ') ? raw.slice(raw.indexOf(' ') + 1) : raw;
    const u = new URL(rest);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : null;
  } catch { return null; }
}

function groupOrigin(group) {
  const direct = endpointOrigin(group.endpoint);
  if (!Array.isArray(group.origins)) return direct; // Legacy absolute labels only.
  if (group.origins.length !== 1) return null;
  const observed = endpointOrigin(group.origins[0]);
  if (!observed || observed !== group.origins[0]) return null;
  if (direct) return direct === observed ? direct : null;
  const label = String(group.endpoint ?? '').replace(/^\S+\s+/, '');
  // Provenance supplies the scheme, not the page or an invented URL default.
  return label.split('/')[0] === new URL(observed).host ? observed : null;
}

// Sessions of one site (host or site slug), newest first, with the derived artifacts already
// written by derive: SHAPES (endpoints + groups), ASSEMBLED dialects, knowledge status.
export function collectSessions({ sessionsDir, host, site } = {}) {
  const wanted = [host, site].map((x) => String(x ?? '').toLowerCase().trim()).filter(Boolean);
  const out = [];
  for (const meta of listSessions(sessionsDir)) {
    const s = new Session(path.join(sessionsDir, meta.id));
    const h = hostOf(s);
    let slug = '';
    try { slug = siteOf(h); } catch { slug = ''; }
    const haystack = [h, slug, String(s.meta?.site ?? '').toLowerCase()];
    if (wanted.length && !wanted.some((w) => haystack.some((x) => x && (x === w || x.endsWith(`.${w}`) || x.includes(w))))) continue;
    const shapes = s.kv.get('SHAPES', null);
    const acceptance = readAcceptance(s); // Rechecks current raw digest and G1–G7 binding.
    const knowledge = s.kv.get('KNOWLEDGE_STATUS', null);
    const origin = pageOrigin(s);
    const eligible = !!shapes && origin !== null && knowledge?.status === 'complete'
      && acceptance.verdict === 'capture_accepted';
    const assembledKv = s.kv.get('ASSEMBLED', null) ?? {};
    const assembled = Object.fromEntries(Object.entries(assembledKv)
      .filter(([, a]) => a && typeof a === 'object' && a.endpoint)
      .map(([sid, a]) => [sid, { endpoint: a.endpoint, revisions: a.revisions ?? 0, dialects: sorted(a.dialects ?? []) }]));
    out.push({
      id: s.id,
      host: h,
      site: slug,
      origin,
      acceptance: acceptance.verdict,
      // Compact proof that downstream consumers can compare with the stored
      // acceptance.json; never copy raw payloads or large gate evidence here.
      acceptanceProof: acceptance.verdict === 'capture_accepted'
        ? { evaluatorVersion: acceptance.evaluator?.version ?? null,
            rawDigest: acceptance.binding?.rawDigest ?? null,
            seqRange: acceptance.binding?.seqRange ?? null,
            recipe: acceptance.binding?.recipe ?? null,
            // A consumer can verify which exact derived shape projection was
            // published without copying raw content into the family record.
            shapesDigest: shapes ? createHash('sha256')
              .update(JSON.stringify({ endpoints: shapes.endpoints ?? [], groups: shapes.groups ?? [] }))
              .digest('hex') : null }
        : null,
      eligible,
      ineligibleReason: !shapes ? 'no-derived-shapes' : !origin ? 'no-exact-page-origin'
        : knowledge?.status !== 'complete' ? 'knowledge-not-complete'
          : acceptance.verdict !== 'capture_accepted' ? acceptance.verdict : null,
      createdAt: s.meta?.createdAt ?? null,
      profile: s.meta?.profile?.name ?? null,
      hasDerived: !!shapes,
      endpoints: shapes?.endpoints ?? [],
      groups: shapes?.groups ?? [],
      familyDetection: shapes?.families ?? [],
      knowledge,
      assembled,
    });
  }
  return out; // listSessions is already newest-first (createdAt desc)
}

// Merge per-session groups into one family shape set, grouped by (transport, endpoint path).
function normaliseShapes(sessions) {
  const streams = new Map();
  let outOfOriginGroups = 0;
  for (const s of sessions) {
    if (!s.hasDerived) continue;
    const epIndex = new Map(s.endpoints.map((e) => [e.endpoint, e]));
    const dialects = new Map();
    for (const a of Object.values(s.assembled ?? {})) {
      const set = dialects.get(a.endpoint) ?? new Set();
      for (const d of a.dialects ?? []) set.add(d);
      dialects.set(a.endpoint, set);
    }
    for (const g of s.groups) {
      // SHAPES contains observations from all captured transports. Even a
      // passing session cannot lend an analytics/CDN/unknown stream to the
      // page's family. Retain the source SHAPES unchanged for investigation.
      if (groupOrigin(g) !== s.origin) { outOfOriginGroups++; continue; }
      const ep = epIndex.get(g.endpoint) ?? null;
      const transport = dominantTransport(ep);
      const endpoint = pathPattern(g.endpoint ?? ep?.endpoint ?? '');
      const key = `${transport} ${endpoint}`;
      let entry = streams.get(key);
      if (!entry) {
        entry = { transport, endpoint, sessions: new Set(), observations: 0, fields: new Map(), collections: new Map(), deltas: new Set(), resources: new Set() };
        streams.set(key, entry);
      }
      entry.sessions.add(s.id);
      entry.observations += Number(g.count ?? 0);
      for (const [p, f] of Object.entries(g.fields ?? {})) {
        const cur = entry.fields.get(p) ?? { path: p, count: 0, sessions: new Set() };
        cur.count += Number(f?.count ?? 0);
        cur.sessions.add(s.id);
        entry.fields.set(p, cur);
      }
      for (const c of g.collections ?? []) {
        if (!c?.path) continue;
        const cur = entry.collections.get(c.path) ?? { path: c.path, groups: 0, avgItems: 0, keys: new Set() };
        cur.groups++;
        cur.avgItems += Number(c.avgItems ?? 0);
        for (const k of c.keys ?? []) cur.keys.add(k.key);
        entry.collections.set(c.path, cur);
      }
      for (const d of dialects.get(g.endpoint) ?? []) entry.deltas.add(d);
      for (const r of ep?.resourceTypes ?? []) entry.resources.add(r);
    }
  }
  return { shapes: [...streams.values()]
    .sort((a, b) => cmp(a.transport, b.transport) || cmp(a.endpoint, b.endpoint))
    .map((e) => ({
      transport: e.transport,
      endpoint: e.endpoint,
      sessions: e.sessions.size,
      observations: e.observations,
      fields: [...e.fields.values()]
        .sort((a, b) => cmp(a.path, b.path))
        .map((f) => ({ path: f.path, count: f.count, sessions: f.sessions.size })),
      collections: [...e.collections.values()]
        .sort((a, b) => cmp(a.path, b.path))
        .map((c) => ({ path: c.path, groups: c.groups, avgItems: +(c.avgItems / Math.max(1, c.groups)).toFixed(1), keys: sorted(c.keys) })),
      deltas: sorted(e.deltas),
      resources: sorted(e.resources),
    })), outOfOriginGroups };

}

// Short stable hash over the normalised shape set. No timestamps, no session ids.
export function familySignature(input) {
  const shapes = Array.isArray(input) ? input : input?.shapes ?? [];
  const canon = JSON.stringify({
    note: SIG_NOTE,
    streams: shapes.map((s) => ({
      transport: s.transport ?? 'UNKNOWN',
      endpoint: s.endpoint ?? '/',
      fields: (s.fields ?? []).map((f) => [f.path, f.count]),
      collections: (s.collections ?? []).map((c) => [c.path, c.keys ?? []]),
      deltas: s.deltas ?? [],
      resources: s.resources ?? [],
    })),
  });
  return `sha256:${createHash('sha256').update(canon).digest('hex').slice(0, 16)}`;
}

const slugHost = (h) => String(h ?? '').toLowerCase().replace(/[^a-z0-9.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);

// Draft a profile for the family by reusing buildProfile over the store's "generic" base.
// Never saved here: it carries no timestamps so the build output stays byte-identical.
function draftProfile(profilesDir, id, hosts) {
  if (!profilesDir) return { profile: null, warning: 'no profiles directory supplied: profile draft skipped' };
  try {
    const store = new ProfileStore(profilesDir);
    const p = buildProfile(store.load('generic'), { name: id, hosts, family: id, description: `Site family consolidated from derived sessions (${hosts.join(', ')})` });
    for (const k of ['version', 'savedAt', 'changeNote']) delete p[k];
    return { profile: p, warning: null };
  } catch (e) {
    return { profile: null, warning: `profile draft failed: ${e?.message ?? e}` };
  }
}

// Build the family record + merged shape set for one site.
export function buildFamily({ sessionsDir, host, site, profilesDir = null, minSessions = 1 } = {}) {
  const ref = host ?? site;
  const sessions = collectSessions({ sessionsDir, host, site });
  const derived = sessions.filter((s) => s.hasDerived);
  const accepted = sessions.filter((s) => s.eligible);
  // A family publication is one EXACT browser origin at a time. Multiple
  // accepted origins remain inspectable but cannot silently pool account/site
  // evidence just because they share a registrable hostname.
  const origin = sorted(new Set(accepted.map((s) => s.origin)))[0] ?? null;
  const contributing = accepted.filter((s) => s.origin === origin);
  const { shapes, outOfOriginGroups } = normaliseShapes(contributing);
  const signature = familySignature(shapes);

  const hosts = sorted(new Set(contributing.map((s) => s.host).filter(Boolean)));
  const primary = hosts[0] ?? String(site ?? host ?? 'site').toLowerCase();
  const id = slugHost(primary) || 'site';
  const siteName = (() => { try { return siteOf(primary); } catch { return ''; } })();
  const family = {
    id, name: id, site: siteName, origin, hosts, members: contributing.map((s) => s.id), signature,
    // Source references survive versioning and disambiguate which accepted raw
    // evidence supported each inferred shape. No claim of account identity.
    sources: contributing.map((s) => ({ sessionId: s.id, origin: s.origin,
      verdict: s.acceptance, ...s.acceptanceProof })),
  };

  const warnings = [];
  if (!sessions.length) warnings.push(`no sessions for "${ref ?? '(any)'}" in ${sessionsDir}`);
  const noDerived = sessions.filter((s) => !s.hasDerived);
  for (const s of noDerived) warnings.push(`session ${s.id} has no SHAPES artifact (not derived)`);
  if (sessions.length && !derived.length) warnings.push(`none of the ${sessions.length} session(s) are derived`);
  if (sessions.length && !contributing.length) warnings.push('no G1–G7 capture_accepted session with complete derivation and exact page origin; nothing eligible to publish');
  if (outOfOriginGroups) warnings.push(`${outOfOriginGroups} derived groups withheld: endpoint origin differs from page origin or is unknown`);
  const differentOrigins = accepted.filter((s) => s.origin !== origin);
  if (differentOrigins.length) warnings.push(`${differentOrigins.length} accepted session(s) withheld from family: different exact page origin`);
  if (sessions.length && contributing.length < minSessions) warnings.push(`only ${contributing.length} eligible session(s), below --min ${minSessions}`);
  if (derived.length && !shapes.length && !warnings.some((w) => w.includes('no shape groups'))) warnings.push('no shape groups in the derived sessions');
  const draft = contributing.length && shapes.length ? draftProfile(profilesDir, id, hosts)
    : { profile: null, warning: null };
  if (draft.warning) warnings.push(draft.warning);

  const transports = sorted(new Set(shapes.map((s) => s.transport)));
  return {
    family,
    profile: draft.profile,
    shapes,
    coverage: { sessions: sessions.length, withDerived: derived.length,
      eligible: contributing.length, acceptedAcrossOrigins: accepted.length,
      withheld: sessions.length - contributing.length,
      outOfOriginGroups, streams: shapes.length, transports,
      inspected: sessions.map((s) => ({ id: s.id, origin: s.origin, verdict: s.acceptance,
        status: s.eligible && s.origin === origin ? 'included' : 'withheld',
        reason: !s.eligible ? s.ineligibleReason : s.origin !== origin ? 'different-exact-origin' : null })) },
    warnings,
  };
}

// Persist through the existing FamilyStore (versioned vNNNN.json + CURRENT). FamilyStore.save sets
// `name`, `version` and `savedAt`; everything else here is the built record verbatim.
export function writeFamily({ familiesDir, built, family, profile, shapes, coverage, warnings } = {}) {
  const b = built ?? null;
  const fam = family ?? b?.family;
  if (!fam?.id) throw new Error('writeFamily needs a family with an id');
  const c = coverage ?? b?.coverage;
  const groups = shapes ?? b?.shapes ?? [];
  if (!c || !(c.eligible > 0) || !fam.members?.length || !fam.origin || !groups.length) {
    const error = new Error('Family publication withheld: no accepted, exact-origin, source-linked shapes');
    error.code = 'FAMILY_NOT_ELIGIBLE';
    throw error;
  }
  const store = new FamilyStore(familiesDir);
  const rec = store.save(fam.id, {
    ...fam,
    kind: 'site-family',
    profile: profile ?? b?.profile ?? null,
    shapes: shapes ?? b?.shapes ?? [],
    coverage: coverage ?? b?.coverage ?? { sessions: 0, withDerived: 0, streams: 0, transports: [] },
    warnings: warnings ?? b?.warnings ?? [],
  }, `consolidated ${fam.members?.length ?? 0} session(s), signature ${fam.signature}`);
  return {
    store: 'src/families/families.mjs FamilyStore (VersionedStore: vNNNN.json + CURRENT)',
    dir: path.join(familiesDir, fam.id),
    version: rec.version,
    record: rec,
  };
}
