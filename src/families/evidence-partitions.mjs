// Origin-aware evidence partitioning for gatherEvidence() integration.
//
// WHY: gatherEvidence() without a page context unions every reducer stream, delta document, event,
// sample and collection, so a family match can be supported by evidence fetched from a CDN, an
// analytics host or a socket to a different origin than the captured page. This module is the pure,
// dependency-free building block of the origin-aware path: it classifies stream rows by EXACT
// URL.origin relative to an explicit page URL and reports which rows may contribute payload
// evidence. families.mjs gatherEvidence({ pageUrl }) consumes it (offline derive supplies the page URL).
//
//   partitionEvidenceStreams(streams, { siteUrl, domTurns, roles, requireCoverage })
//
// INPUT
//   streams   any iterable of stream rows: reducer.streams.values() (live objects) or
//             reducer.summary().streams (plain rows). The Map itself is also accepted for
//             convenience (its [sid, row] entries are unwrapped). Rows are never copied: the
//             returned buckets hold the caller's references. Items that are not row objects are
//             skipped and counted in totals.skipped.
//   siteUrl   the captured page URL (elsewhere: session.meta.target.url). Only its origin is used.
//             http/https only; ws/wss or opaque URLs are not a page identity.
//   domTurns  optional page DOM turns from the primary page. Attributed to the site origin only.
//   roles     optional Map (or plain object) keyed by SID -> role string or { role, confidence }.
//             Use it for an already-computed classifier result; this module NEVER classifies.
//             Row-carried role / roleConfidence fields are honoured as per-row evidence.
//
// OUTPUT (see the return literal below)
//   site        canonical page identity: { input, url, origin, reason }.
//   buckets     site / other / unknown, each { kind, origin, streams, payloadEligible, payloadExcluded }.
//               Every bucket keeps ALL of its member references; payload eligibility is a separate
//               flag list, so config/telemetry streams remain available as control evidence.
//   streams     one flat entry per row, in input order, content-free:
//               { ref, sid, origin, originClass, originReason, role, roleConfidence, roleSource,
//                 roleMapIgnored, payloadEligible, exclusion }. originReason is one of
//               missing-url | unparseable-url | relative-url | opaque-origin | unsupported-scheme.
//   dom         { origin, attributed, provided, count, turns, unattributedCount, unattributedTurns,
//               reason }. Attributed DOM (`turns`) is the caller's array (no copy) and `count` its
//               length. Unattributed DOM keeps the same caller array by reference in
//               `unattributedTurns` (counted by `unattributedCount`), so no captured DOM is
//               discarded. At most one of the two lists is non-empty.
//   roles       { source, entries, applied, fromRow, missing, ambiguousSids, ignoredAmbiguous,
//                 unmatchedKeys }.
//   totals      stream and eligibility counts.
//
// RULES
//   * Origin means scheme + host + port, exactly (URL.origin). Hostnames and registrable domains are
//     never compared. URL canonicalisation only removes the DEFAULT port of its own scheme
//     (http/ws 80, https/wss 443); ws/wss origins stay explicit and are never merged with http/https
//     and never with each other.
//   * Invalid, opaque (origin "null"), non-network (file:, data:, blob:, chrome-extension:, ...),
//     relative or missing URLs are UNKNOWN. A relative URL is deliberately not resolved against
//     siteUrl: without explicit provenance a guess would silently rebind evidence, so it stays
//     unknown (`originReason: 'relative-url'`).
//   * Nothing is inferred from sid/tag prefixes. A stream is only "site" when its own URL parses to
//     the same origin as the page.
//   * Page DOM is attributed only to an explicit valid site origin. Without one it stays
//     unattributed evidence: `turns` is empty and `count` 0, while the raw caller array is retained
//     in `unattributedTurns` / `unattributedCount` for inspection. DOM never enters a bucket.
//     Without a usable page URL the site bucket is empty: a stream with a parseable origin is still
//     "other" (known, just not attributable), and only unparseable URLs are "unknown".
//   * Roles: a stream is payload-excluded only when its role is config or telemetry AND its
//     confidence is medium or high. Unknown, low, missing and unrecognised roles stay
//     payload-eligible. Exclusion never removes the stream from its bucket.
//   * SIDs are not globally unique evidence. If a SID occurs more than once in the input, a roles
//     map entry for it is ignored for every occurrence (`roleMapIgnored: 'ambiguous-sid'`) instead of
//     lending one origin's role to another; the rows fall back to their own role fields, if any.
//     Ambiguous SIDs, ignored entries and map keys matching no row are reported.
//   * No global state: all classification is per call, so an origin that is the site in one call is
//     "other" in the next without leakage.
//   * Cost: one pass over the rows plus O(k) role-map lookups; O(n) references retained, no payload,
//     event or document copying and no nested document scan. Sorting is bounded per subset, not
//     universal: other.origins, roles.ambiguousSids and roles.unmatchedKeys are O(k log k) in their
//     own subset size (distinct origins / duplicated or mapped SIDs), never O(n log n) in stream
//     count. No clock, no randomness, no I/O.
//
// INTEGRATION: gatherEvidence() in families.mjs calls this once (when given an explicit pageUrl), builds
// primary evidence from result.buckets.site only, keeps site config/telemetry streams as CONTROL evidence
// (transport / method / status / mime / url metadata) but skips their payload-derived fields, reports
// other/unknown streams separately and takes DOM signals only when result.dom.attributed is true.
// Unattributed DOM remains inspectable through result.dom.unattributedTurns; it has no page origin and is
// never folded into site or "other" evidence. FAMILY_EVIDENCE_VERSION (below) versions that behaviour.

export const EVIDENCE_PARTITIONS_SCHEMA = 'capture-studio.evidence-partitions/1';

// Family-evidence contract of the derive / report path that CONSUMES these partitions (gatherEvidence in
// families.mjs). Bump FAMILY_EVIDENCE_VERSION whenever how primary evidence is gathered changes: derive-all and
// derive --missing treat a session whose SHAPES lack this exact version as stale, independent of STREAM_ROLES.
export const FAMILY_EVIDENCE_SCHEMA = 'capture-studio.family-evidence/1';
export const FAMILY_EVIDENCE_VERSION = 1;

const PAGE_SCHEMES = new Set(['http:', 'https:']);
const NETWORK_SCHEMES = new Set(['http:', 'https:', 'ws:', 'wss:']);
const EXCLUDABLE_ROLES = new Set(['config', 'telemetry']);
const EXCLUDING_CONFIDENCE = new Set(['medium', 'high']);

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const norm = (v) => (typeof v === 'string' ? v.trim().toLowerCase() || null : null);
const sidOf = (row) => (row.sid === undefined || row.sid === null || row.sid === '' ? null : row.sid);

function parseSite(siteUrl) {
  if (typeof siteUrl !== 'string' || !siteUrl.trim()) {
    return { input: null, url: null, origin: null, reason: 'missing-site-url' };
  }
  const input = siteUrl.trim();
  let u;
  try { u = new URL(input); } catch { return { input, url: null, origin: null, reason: 'invalid-site-url' }; }
  if (!u.hostname || u.origin === 'null') return { input, url: null, origin: null, reason: 'opaque-site-origin' };
  if (!PAGE_SCHEMES.has(u.protocol)) return { input, url: null, origin: null, reason: 'site-not-page-scheme' };
  return { input, url: u.href, origin: u.origin, reason: null };
}

// Exact origin, or an explicit refusal. Reasons are content-free enums suitable for receipts.
function classifyUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return { origin: null, reason: 'missing-url' };
  const text = rawUrl.trim();
  let u;
  try { u = new URL(text); } catch {
    return { origin: null, reason: /^(\/|\.\/|\.\.\/)/.test(text) ? 'relative-url' : 'unparseable-url' };
  }
  // An opaque origin ("null") is never a comparable page origin, whichever scheme produced it.
  if (u.origin === 'null') return { origin: null, reason: 'opaque-origin' };
  if (!NETWORK_SCHEMES.has(u.protocol)) return { origin: null, reason: 'unsupported-scheme' };
  if (!u.hostname) return { origin: null, reason: 'opaque-origin' };
  return { origin: u.origin, reason: null };
}

// fullyInspected: true / false when the classifier's coverage said so, null when there is no coverage.
function roleOfRow(row) {
  const role = norm(row.role);
  const fi = isObj(row.roleCoverage) && typeof row.roleCoverage.fullyInspected === 'boolean' ? row.roleCoverage.fullyInspected : null;
  return role ? { role, confidence: norm(row.roleConfidence) ?? 'none', fullyInspected: fi } : null;
}

// Map values may be a bare role string (no confidence) or { role, confidence | roleConfidence }.
function roleOfInput(input) {
  if (typeof input === 'string') { const role = norm(input); return role ? { role, confidence: 'none', fullyInspected: null } : null; }
  if (!isObj(input)) return null;
  const role = norm(input.role);
  if (!role) return null;
  const raw = input.fullyInspected ?? (isObj(input.coverage) ? input.coverage.fullyInspected : isObj(input.roleCoverage) ? input.roleCoverage.fullyInspected : undefined);
  return { role, confidence: norm(input.confidence ?? input.roleConfidence) ?? 'none', fullyInspected: typeof raw === 'boolean' ? raw : null };
}

function lookupRole(roles, sid) {
  const key = String(sid);
  if (roles instanceof Map) {
    if (roles.has(sid)) return roles.get(sid);
    if (roles.has(key)) return roles.get(key);
    return undefined;
  }
  if (Object.prototype.hasOwnProperty.call(roles, sid)) return roles[sid];
  if (Object.prototype.hasOwnProperty.call(roles, key)) return roles[key];
  return undefined;
}

// requireCoverage (default false: legacy callers unchanged): payload exclusion by role additionally needs the
// classifier's own statement that the stream was fully inspected (coverage.fullyInspected === true).
// Without it (or with false) a config / telemetry label is NOT trusted to remove payload evidence. With the
// default, only an explicit fullyInspected === false blocks exclusion.
export function partitionEvidenceStreams(streams, { siteUrl = null, domTurns = null, roles = null, requireCoverage = false } = {}) {
  if (streams === null || streams === undefined || typeof streams[Symbol.iterator] !== 'function') {
    throw new TypeError('partitionEvidenceStreams: streams must be a row iterable (reducer.streams / reducer.streams.values() / summary().streams)');
  }
  const site = parseSite(siteUrl);

  // Pass 1: normalise the iterable to row references (unwrapping [sid, row] pairs from a bare Map).
  const rows = [];
  let skipped = 0;
  for (const item of streams) {
    const candidate = Array.isArray(item) && item.length === 2 && isObj(item[1]) ? item[1] : item;
    if (!isObj(candidate)) { skipped++; continue; }
    rows.push(candidate);
  }

  // A SID shared by several rows is not a trustworthy role channel: count before applying the map.
  const sidCounts = new Map();
  for (const row of rows) {
    const sid = sidOf(row);
    if (sid === null) continue;
    const key = String(sid);
    sidCounts.set(key, (sidCounts.get(key) ?? 0) + 1);
  }
  const ambiguousSids = [...sidCounts].filter(([, n]) => n > 1).map(([key]) => key).sort();
  const ambiguous = new Set(ambiguousSids);

  const roleSourceKind = roles instanceof Map ? 'map' : isObj(roles) ? 'object' : 'none';
  const mapKeys = roleSourceKind === 'map' ? [...roles.keys()].map(String)
    : roleSourceKind === 'object' ? Object.keys(roles) : [];
  const mapKeySet = new Set(mapKeys);

  const buckets = {
    site: { kind: 'site', origin: site.origin, streams: [], payloadEligible: [], payloadExcluded: [] },
    other: { kind: 'other', origin: null, origins: [], streams: [], payloadEligible: [], payloadExcluded: [] },
    unknown: { kind: 'unknown', origin: null, streams: [], payloadEligible: [], payloadExcluded: [], reasons: [] },
  };
  const otherOrigins = new Set();
  const entries = [];
  const knownSids = new Set();

  for (const row of rows) {
    const sid = sidOf(row);
    if (sid !== null) knownSids.add(String(sid));
    const { origin, reason } = classifyUrl(row.url);
    const originClass = origin === null ? 'unknown' : site.origin !== null && origin === site.origin ? 'site' : 'other';

    // Map entry first, but never across an ambiguous SID; the row's own role fields remain usable.
    let role = null;
    let confidence = 'none';
    let fullyInspected = null;
    let roleSource = null;
    let roleMapIgnored = null;
    if (sid !== null && roleSourceKind !== 'none') {
      const mapped = lookupRole(roles, sid);
      if (mapped !== undefined) {
        if (ambiguous.has(String(sid))) {
          roleMapIgnored = 'ambiguous-sid';
        } else {
          const parsed = roleOfInput(mapped);
          if (parsed) { role = parsed.role; confidence = parsed.confidence; fullyInspected = parsed.fullyInspected; roleSource = 'map'; }
        }
      }
    }
    if (roleSource === null) {
      const own = roleOfRow(row);
      if (own) { role = own.role; confidence = own.confidence; fullyInspected = own.fullyInspected; roleSource = 'row'; }
    }

    // A config / telemetry label removes payload evidence only when it is trusted: medium or high confidence AND
    // not contradicted by (or, with requireCoverage, positively backed by) the classifier's inspection coverage.
    const labelled = EXCLUDABLE_ROLES.has(role) && EXCLUDING_CONFIDENCE.has(confidence);
    const trusted = fullyInspected === true || (fullyInspected === null && !requireCoverage);
    const excluded = labelled && trusted;
    const entry = {
      ref: row, sid, origin, originClass, originReason: reason,
      role, roleConfidence: confidence, fullyInspected, roleSource, roleMapIgnored,
      payloadEligible: !excluded, exclusion: excluded ? `${role}:${confidence}` : null,
      exclusionBlocked: labelled && !trusted ? 'not-fully-inspected' : null,
    };
    entries.push(entry);

    const bucket = buckets[originClass];
    bucket.streams.push(row);
    (excluded ? bucket.payloadExcluded : bucket.payloadEligible).push(row);
    if (originClass === 'other') otherOrigins.add(origin);
    if (originClass === 'unknown') bucket.reasons.push({ sid, reason });
  }

  buckets.other.origins = [...otherOrigins].sort();

  const provided = Array.isArray(domTurns) ? domTurns.length : 0;
  const attributed = provided > 0 && site.origin !== null;
  const dom = {
    origin: site.origin,
    attributed,
    provided,
    count: attributed ? provided : 0,
    turns: attributed ? domTurns : [],
    // Unattributed DOM is not discarded: it is retained by reference, outside every bucket.
    unattributedCount: attributed ? 0 : provided,
    unattributedTurns: attributed || provided === 0 ? [] : domTurns,
    reason: site.origin === null ? site.reason : provided > 0 ? null : 'no-dom',
  };

  const applied = entries.filter((e) => e.roleSource === 'map').length;
  const fromRow = entries.filter((e) => e.roleSource === 'row').length;
  const missing = entries.filter((e) => e.roleSource === null).length;
  const ignoredAmbiguous = ambiguousSids.filter((key) => mapKeySet.has(key));
  const unmatchedKeys = mapKeys.filter((key) => !knownSids.has(key));
  const rolesSummary = {
    source: roleSourceKind,
    entries: roleSourceKind === 'map' ? roles.size : roleSourceKind === 'object' ? Object.keys(roles).length : 0,
    applied, fromRow, missing,
    ambiguousSids,
    ignoredAmbiguous,
    unmatchedKeys: [...new Set(unmatchedKeys)].sort(),
  };

  return {
    schema: EVIDENCE_PARTITIONS_SCHEMA,
    site,
    buckets,
    streams: entries,
    dom,
    roles: rolesSummary,
    totals: {
      streams: entries.length,
      site: buckets.site.streams.length,
      other: buckets.other.streams.length,
      unknown: buckets.unknown.streams.length,
      payloadEligible: entries.filter((e) => e.payloadEligible).length,
      payloadExcluded: entries.filter((e) => !e.payloadEligible).length,
      otherOrigins: otherOrigins.size,
      payloadKeptNotFullyInspected: entries.filter((e) => e.exclusionBlocked !== null).length,
      skipped,
    },
  };
}
