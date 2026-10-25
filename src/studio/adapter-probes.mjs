// Probe production for the adaptive webapp adapter factory (Agent 14 Round 8).
//
// This module is the "capture to normalized probes" seam: it turns Capture Studio's OWN derived
// evidence (DOM_TURNS, ASSEMBLED stream endpoints, saved page URLs) and bounded READ-ONLY live
// page measurements into the source-qualified observation probes that
// src/studio/adaptive-adapter-factory.mjs consumes.
//
// Hard rules carried over from the factory contract and the webapp-native harness:
//   - Probes are evidence, not authority: nothing here grants a send, installs an adapter,
//     touches a browser write path, or fabricates identity.
//   - A thread route is only proposed when the page URL actually carries an identity-shaped
//     token (uuid / long id). Titles, positions, reply text and timestamps are never used.
//   - Absence is only claimed by a complete, whole-document measurement (the live probe); saved
//     captures only ever contribute presence votes, because the raw DOM is not re-queryable.
//   - Every probe keeps its capture reference (captureId:sequence) so the raw evidence stays
//     authoritative and auditable.
import { parseThread, threadSupported } from '../capture/conversation-thread.mjs';
import chatgptSeed from '../profiles/sites/chatgpt.mjs';

export const PROBE_SCHEMA = 'aion.adapter-probe/1';
export const TEXT_PREVIEW_CAP = 240;
export const MAX_LIVE_TURNS = 200;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDENTITY_TOKEN_RE = /^[0-9a-f]{16,}$/i; // long hex token
const DIGITS_RE = /^\d{6,}$/;

// The two DOM features the factory knows that a saved capture can prove. Any other generic
// role word ('human', 'ai', 'bot', ...) is honestly skipped rather than coerced.
const FEATURE_BY_ROLE = { user: 'user-turn', assistant: 'assistant-turn' };

const isString = (s, n) => typeof s === 'string' && !!s.length && s.length <= n;

const ATTR_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_:.-]{0,99}$/;
const ROLE_VALUE_RE = /^[a-z]{1,40}$/;
// The one selector form for a recorded role attribute, shared by saved and live probes and by
// transcript matching. `match` is the page agent's roleMatch ('suffix' | 'exact').
export function selectorForRole(attr, role, match = 'exact') {
  if (!ATTR_NAME_RE.test(String(attr ?? '')) || !ROLE_VALUE_RE.test(String(role ?? ''))) return null;
  return match === 'suffix' ? `[${attr}$="${role}"]` : `[${attr}="${role}"]`;
}

function classifySegment(seg) {
  if (UUID_RE.test(seg)) return ':uuid';
  if (DIGITS_RE.test(seg) || IDENTITY_TOKEN_RE.test(seg)) return ':id';
  return null;
}

// Long opaque segments that carry digits (project/custom-assistant ids with a user-chosen slug,
// e.g. `g-p-67e1a2b3c4d5-my-private-project`, base62 share keys) are generalized to `:token`.
// They are NOT identity evidence (only uuid/:id count), but a learned, persisted route template
// must never retain account-specific or user-named path content. Percent-encoded segments are
// treated the same way.
function opaqueSegment(seg) {
  if (seg.includes('%')) return ':token';
  if (seg.length >= 12 && /\d/.test(seg) && /[a-z]/i.test(seg) && /^[A-Za-z0-9_.~-]+$/.test(seg)) return ':token';
  // Provider route words are short (`c`, `chat`, `app`, `backend-api`); multi-hyphen or long
  // literal segments are slugs (often user-named) and are generalized too.
  if (seg.length > 24 || (seg.match(/-/g)?.length ?? 0) >= 2) return ':token';
  return null;
}

function classifyQueryValue(v) {
  if (UUID_RE.test(v)) return ':uuid';
  if (DIGITS_RE.test(v) || IDENTITY_TOKEN_RE.test(v)) return ':id';
  return null;
}

/**
 * Generalize a page URL into a thread-route candidate template. Returns null unless the URL
 * carries at least one identity-shaped token — a URL without identity evidence never becomes
 * a thread route (no fabrication from titles, ordinals or reply text).
 */
export function routeCandidateFromUrl(urlStr) {
  if (!isString(urlStr, 2048)) return null;
  let u;
  try { u = new URL(urlStr); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;

  const path = u.pathname.split('/').map((seg) => seg ? (classifySegment(seg) ?? opaqueSegment(seg) ?? seg) : seg).join('/');
  const query = [];
  let identityHits = 0;
  for (const [k, v] of u.searchParams.entries()) {
    const cls = classifyQueryValue(v);
    if (cls) { query.push(`${k}=${cls}`); identityHits++; }
    else query.push(k); // non-identity params are kept as bare keys, values never trusted as identity
  }
  const segHit = u.pathname.split('/').some((seg) => seg && classifySegment(seg) !== null);
  if (!segHit && identityHits === 0) return null;
  const qs = query.length ? `?${query.join('&')}` : '';
  const candidate = `${u.origin}${path}${qs}`;
  return isString(candidate, 320) ? candidate : null;
}

let seqCounter = 0;
function probe({ feature, type, candidate, outcome = 'present', coverage = 'complete', carrier, captureId, evidenceClass, evidenceRef = null }) {
  if (!isString(candidate, 320)) return null;
  return {
    schema: PROBE_SCHEMA,
    feature, type, candidate, outcome, coverage, carrier,
    captureId, sequence: seqCounter++, evidenceClass, evidenceRef,
  };
}

/**
 * Probes from one saved, derived session. Evidence class: SAVED_REAL_CAPTURE.
 * Sources (all produced by the existing derive pipeline — no new parsing):
 *   - DOM_TURNS: user/assistant turn attribute selectors (stable) + one specific domId per role
 *   - ASSEMBLED: stream endpoint paths (stream-map probes, network carrier)
 *   - RECEIPT.pageUrl / session meta: generalized thread-route candidate
 * Only presence votes are emitted: a saved capture cannot re-query its DOM, so absence here
 * would be a guess.
 */
export function probesFromSession(session, { evidenceClass = 'SAVED_REAL_CAPTURE', maxStreamEndpoints = 8 } = {}) {
  if (!session || typeof session !== 'object' || !isString(session.id, 128)) throw new TypeError('INVALID_SESSION');
  const captureId = session.id;
  const out = [];
  seqCounter = 0;

  const turns = session.kv?.get?.('DOM_TURNS') ?? [];
  if (Array.isArray(turns)) {
    const domIdSeen = new Set();
    for (const [turnIndex, t] of turns.entries()) {
      const feature = FEATURE_BY_ROLE[t?.role];
      if (!feature) continue;
      const attr = typeof t.roleAttribute === 'string' ? t.roleAttribute : null;
      const roleSelector = attr ? selectorForRole(attr, t.role, t.roleMatch) : null;
      if (roleSelector) {
        const p = probe({ feature, type: 'selector', candidate: roleSelector, carrier: 'dom', captureId, evidenceClass, evidenceRef: `KV:DOM_TURNS[${turnIndex}]` });
        if (p) out.push(p);
      }
      // A specific per-turn selector is noisy by construction; at most one per role per capture
      // is emitted so it can only ever act as a bounded provisional proposal, never as the
      // ranked selection (the stable attribute selector always has equal-or-better support).
      if (isString(t.domId, 320) && !domIdSeen.has(feature)) {
        domIdSeen.add(feature);
        const p = probe({ feature, type: 'selector', candidate: t.domId, carrier: 'dom', captureId, evidenceClass, evidenceRef: `KV:DOM_TURNS[${turnIndex}].domId` });
        if (p) out.push(p);
      }
    }
  }

  const assembled = session.kv?.get?.('ASSEMBLED') ?? {};
  if (assembled && typeof assembled === 'object') {
    const seen = new Set();
    for (const [streamIndex, a] of Object.values(assembled).entries()) {
      const endpoint = typeof a?.endpoint === 'string' ? a.endpoint : null;
      if (!endpoint || seen.has(endpoint)) continue;
      seen.add(endpoint);
      if (seen.size > maxStreamEndpoints) break;
      // endpoint shape is `METHOD /path`; the path is the stream-map candidate.
      const path = endpoint.includes(' ') ? endpoint.slice(endpoint.indexOf(' ') + 1) : endpoint;
      const p = probe({ feature: 'stream-component', type: 'stream-map', candidate: path, carrier: 'network', captureId, evidenceClass, evidenceRef: `KV:ASSEMBLED[${streamIndex}].endpoint` });
      if (p) out.push(p);
    }
  }

  // Thread-identity evidence: the receipt's final page URL when present; else the last DOM
  // inspection URL (records post-dispatch pushState identities); else the initial target URL.
  const url = session.kv?.get?.('RECEIPT')?.pageUrl ?? session.kv?.get?.('DOM_INSPECT')?.url
    ?? session.meta?.target?.url ?? null;
  const route = routeCandidateFromUrl(url);
  if (route) {
    const p = probe({ feature: 'thread-route', type: 'route', candidate: route, carrier: 'dom', captureId, evidenceClass, evidenceRef: session.kv?.get?.('RECEIPT')?.pageUrl ? 'KV:RECEIPT.pageUrl' : session.kv?.get?.('DOM_INSPECT')?.url ? 'KV:DOM_INSPECT.url' : 'META:target.url' });
    if (p) out.push(p);
  }

  for (const p of out) p.captureId = captureId; // defensive: sequence is global, captureId is per session
  return out;
}

/**
 * Stamp scope fields (siteId/origin/surface) onto probes and verify every probe's session
 * actually belongs to that origin. Cross-origin teaching fails closed.
 */
export function scopeProbes(probes, { siteId, origin, surface = 'chat', sessionOrigins }) {
  for (const p of probes) {
    const probeOrigin = sessionOrigins.get(p.captureId);
    if (!probeOrigin) throw new TypeError(`PROBE_ORIGIN_UNKNOWN: ${p.captureId}`);
    if (probeOrigin !== origin) {
      throw new TypeError(`PROBE_ORIGIN_MISMATCH: session ${p.captureId} is ${probeOrigin}, not ${origin}`);
    }
    if (p.feature === 'thread-route') {
      let routeOrigin;
      try { routeOrigin = new URL(p.candidate).origin; } catch { throw new TypeError('PROBE_ROUTE_INVALID'); }
      if (routeOrigin !== origin) throw new TypeError('PROBE_ROUTE_ORIGIN_MISMATCH');
    }
    p.siteId = siteId; p.origin = origin; p.surface = surface;
  }
  return probes;
}

// Bounded generic candidate battery for live measurement. These mirror the generic fallbacks
// already used by src/capture/actions.mjs — the battery never invents a provider-specific
// integration, it only measures what a generic chat UI tends to expose.
export const LIVE_BATTERY = Object.freeze({
  'composer': Object.freeze(['textarea', '[contenteditable="true"]', '[role="textbox"]', 'form textarea']),
  'send-control': Object.freeze(['form button[type="submit"]', 'button[type="submit"]', 'button[aria-label*="send" i]']),
  'stop-control': Object.freeze(['button[aria-label*="stop" i]', '[aria-label*="stop" i]']),
  'assistant-turn': Object.freeze(['[data-message-author-role]', 'article', '[class*="markdown" i]', '[class*="prose" i]']),
  'user-turn': Object.freeze(['[data-message-author-role="user"]', '[data-testid*="user" i]']),
});

const BATTERY_FEATURES = Object.freeze([...Object.keys(LIVE_BATTERY), 'citation', 'artifact', 'task-progress']);

/**
 * The in-page measurement expression. READ-ONLY: querySelectorAll + innerText reads only.
 * Bounded: counts capped, at most 40 role entries, no network, no dispatch, no storage writes.
 * `priorSelectors` (previous candidate's selectors, feature-keyed) are measured raw so a
 * changed site UI can produce honest ABSENCE evidence for drift detection.
 */
export function liveMeasurementExpression({ priorSelectors = {} } = {}) {
  const batteryJson = JSON.stringify(LIVE_BATTERY);
  const priorJson = JSON.stringify(Object.fromEntries(Object.entries(priorSelectors).slice(0, 8).map(([k, v]) => [k, Array.isArray(v) ? v.slice(0, 8).map(String) : []])));
  return `(async () => {
  const out = { readyState: document.readyState, startUrl: location.href, url: location.href, battery: {}, prior: {}, roles: null, injected: false };
  const q = (sel) => { try { const n = document.querySelectorAll(sel).length; return n > 255 ? 255 : n; } catch { return -1; } };
  const battery = ${batteryJson};
  for (const f of Object.keys(battery)) out.battery[f] = battery[f].map(q);
  const prior = ${priorJson};
  for (const f of Object.keys(prior)) out.prior[f] = prior[f].map(q);
  // After a navigation the capture agent re-injects asynchronously; wait briefly (bounded 4s)
  // so the site-specific role scan is measured on the SAME document as the raw battery.
  for (let i = 0; i < 40 && !(globalThis.__aionCapture && typeof globalThis.__aionCapture.turns === 'function'); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  try {
    const t = globalThis.__aionCapture && typeof globalThis.__aionCapture.turns === 'function' ? globalThis.__aionCapture.turns() : null;
    out.injected = !!t;
    if (Array.isArray(t)) out.roles = t.slice(0, 40).map((x) => {
      const attr = String(x.roleAttribute ?? ''), role = String(x.role ?? '');
      const sel = /^[a-zA-Z_][a-zA-Z0-9_:.-]{0,99}$/.test(attr) && /^[a-z]{1,40}$/.test(role)
        ? '[' + attr + (x.roleMatch === 'suffix' ? '$' : '') + '="' + role + '"]' : null;
      return { attr, role, match: x.roleMatch === 'suffix' ? 'suffix' : 'exact', count: sel ? q(sel) : -1 };
    });
  } catch { out.roles = null; }
  out.readyState = document.readyState;
  out.url = location.href;
  return out;
})()`;
}

/**
 * Map a live measurement into probes. Evidence class: SANDBOX_REAL_BROWSER.
 * A live whole-document querySelectorAll IS a complete bounded probe, so absence is provable —
 * but only when the document was actually loaded; otherwise everything is reported unknown.
 */
export function probesFromLiveMeasurement({ measurement, origin, url, captureId, evidenceClass = 'SANDBOX_REAL_BROWSER' }) {
  if (!measurement || typeof measurement !== 'object') throw new TypeError('INVALID_MEASUREMENT');
  const out = [];
  seqCounter = 0;
  const pageUrl = measurement.url ?? url;
  if (pageUrl) {
    let measuredOrigin;
    try { measuredOrigin = new URL(pageUrl).origin; } catch { throw new TypeError('LIVE_URL_INVALID'); }
    if (measuredOrigin !== origin) throw new TypeError('LIVE_ORIGIN_MISMATCH');
  }
  // A navigation between the first battery read and the role scan cannot prove absence.
  const sameDocument = !measurement.startUrl || measurement.startUrl === measurement.url;
  const complete = measurement.readyState === 'complete' && sameDocument;
  const coverage = complete ? 'complete' : 'partial';
  const outcomeFor = (count) => !complete ? 'unknown' : count > 0 ? 'present' : count === 0 ? 'absent' : 'unknown';

  for (const [feature, counts] of Object.entries(measurement.battery ?? {})) {
    if (!BATTERY_FEATURES.includes(feature)) continue;
    counts.forEach((n, i) => {
      const candidate = LIVE_BATTERY[feature]?.[i];
      if (!candidate) return;
      const p = probe({ feature, type: 'selector', candidate, outcome: outcomeFor(n), coverage, carrier: 'dom', captureId, evidenceClass });
      if (p && (p.outcome !== 'absent' || complete)) out.push(p);
    });
  }

  // The live role scan is the freshest site-specific evidence; when it already produced a
  // presence probe for a candidate, a raw prior-absence measurement of the SAME selector is
  // a self-contradiction inside one capture and is never emitted (the factory counts
  // within-capture contradictions as unknown, which would poison the vote).
  const presentCandidates = new Set();

  if (Array.isArray(measurement.roles)) {
    const seen = new Set();
    for (const r of measurement.roles) {
      if (!r?.attr || !r?.role) continue;
      const feature = FEATURE_BY_ROLE[r.role];
      if (!feature) continue;
      // Same selector form as saved captures (probesFromSession): a suffix-matched role key
      // (e.g. data-content-search-unit-key="turn-0:2:assistant") must never be reported present
      // as an exact `[attr="assistant"]` selector that matches nothing on the page.
      const candidate = selectorForRole(r.attr, r.role, r.match);
      // The capture agent's role label is a *proposal*, not proof that its selector still matches.
      // Only the separate bounded querySelectorAll count qualifies a presence observation.
      if (!candidate || seen.has(candidate) || !Number.isInteger(r.count) || r.count <= 0) continue;
      seen.add(candidate);
      presentCandidates.add(`${feature}:${candidate}`);
      // Presence from the live role scan is complete for the current document.
      const p = probe({ feature, type: 'selector', candidate, outcome: complete ? 'present' : 'unknown', coverage, carrier: 'dom', captureId, evidenceClass });
      if (p) out.push(p);
    }
  }

  for (const [feature, counts] of Object.entries(measurement.prior ?? {})) {
    counts.forEach((n, i) => {
      const candidate = measurement.priorCandidates?.[feature]?.[i];
      if (!isString(candidate, 320)) return;
      if (presentCandidates.has(`${feature}:${candidate}`)) return;
      const p = probe({ feature, type: feature === 'thread-route' ? 'route' : 'selector', candidate, outcome: outcomeFor(n), coverage, carrier: 'dom', captureId, evidenceClass });
      if (p && (p.outcome !== 'absent' || complete)) out.push(p);
    });
  }

  const route = routeCandidateFromUrl(measurement.url ?? url);
  if (route) {
    const p = probe({ feature: 'thread-route', type: 'route', candidate: route, outcome: complete ? 'present' : 'unknown', coverage, carrier: 'dom', captureId, evidenceClass });
    if (p) out.push(p);
  }

  for (const p of out) { p.siteId = null; p.origin = origin; p.surface = 'chat'; }
  return out;
}

/**
 * Run the live measurement through the EXISTING DomObserver (the same in-page agent capture
 * uses — no second browser actor, no direct CDP session). Returns probes.
 */
export async function probesFromLivePage({ dom, origin, captureId, priorSelectors = {} }) {
  if (!dom || typeof dom._evalInMain !== 'function') throw new TypeError('INVALID_DOM_OBSERVER');
  const r = await dom._evalInMain(liveMeasurementExpression({ priorSelectors }));
  const measurement = r?.value ?? r;
  if (!measurement || typeof measurement !== 'object') throw new TypeError('LIVE_MEASUREMENT_UNAVAILABLE');
  measurement.priorCandidates = Object.fromEntries(Object.entries(priorSelectors).map(([k, v]) => [k, Array.isArray(v) ? v : []]));
  return probesFromLiveMeasurement({ measurement, origin, captureId });
}

const previewOf = (text) => {
  const full = typeof text === 'string' ? text : '';
  return { text: full.slice(0, TEXT_PREVIEW_CAP), truncated: full.length > TEXT_PREVIEW_CAP, length: full.length };
};

/**
 * Read-only transcript of a saved session under a learned adapter candidate.
 * Applies the candidate's user-turn/assistant-turn selectors to the session's own DOM_TURNS
 * evidence (attribute-selector matching against the recorded roleAttribute/role pair), and
 * reports thread identity ONLY through the source-supported parser (never fabricated).
 */
// A saved turn matches an attribute selector only when the attribute name, role value AND
// match form recorded for that turn reproduce the selector exactly — a [data-msg-author="user"]
// candidate must never claim turns recorded under a different attribute, and a suffix
// candidate only claims suffix-recorded turns (and vice versa).
function turnMatchesSelector(t, selector) {
  if (typeof selector !== 'string' || !selector) return false;
  return selectorForRole(t.roleAttribute, t.role, t.roleMatch) === selector;
}

// Thread identity is provider-native: only the provider whose parser owns this origin may bind
// it. The parser itself is path-only, so it must never be applied to another site's URL.
// Hosts come from the handwritten seed adapters (the one site registry), not a second list.
const THREAD_PROVIDER_HOSTS = Object.freeze({ chatgpt: Object.freeze([...(chatgptSeed?.hosts ?? [])].map((h) => String(h).toLowerCase())) });
export function threadProviderForOrigin(origin) {
  let host;
  try { const u = new URL(String(origin)); if (u.protocol !== 'https:' || u.port) return null; host = u.hostname.toLowerCase(); } catch { return null; }
  for (const [provider, hosts] of Object.entries(THREAD_PROVIDER_HOSTS)) {
    if (hosts.includes(host) && threadSupported(provider)) return provider;
  }
  return null;
}
function threadBinding(candidateOrigin, url) {
  const unverified = { binding: 'unverified', nativeRef: null, url: typeof url === 'string' ? url : null };
  if (typeof url !== 'string' || !url) return unverified;
  let pageOrigin;
  try { pageOrigin = new URL(url).origin; } catch { return unverified; }
  if (pageOrigin !== candidateOrigin) return unverified;
  const provider = threadProviderForOrigin(candidateOrigin);
  if (!provider) return unverified;
  const parsed = parseThread(provider, url);
  return parsed?.id ? { binding: 'verified', provider, nativeRef: parsed.ref ?? parsed.id, url } : unverified;
}

export function transcriptFromSession(session, candidate, { cap = MAX_LIVE_TURNS } = {}) {
  if (!session || typeof session !== 'object' || !isString(session.id, 128)) throw new TypeError('INVALID_SESSION');
  if (!candidate || candidate.schema !== 'aion.adaptive-webapp-adapter/1') throw new TypeError('INVALID_CANDIDATE');
  const selectors = {
    'user-turn': candidate.features?.['user-turn']?.selected?.candidate ?? null,
    'assistant-turn': candidate.features?.['assistant-turn']?.selected?.candidate ?? null,
  };
  const turns = session.kv?.get?.('DOM_TURNS') ?? [];
  const items = [];
  if (Array.isArray(turns)) {
    for (const t of turns) {
      const feature = FEATURE_BY_ROLE[t?.role];
      if (!feature || !selectors[feature]) continue;
      if (!turnMatchesSelector(t, selectors[feature])) continue;
      const pv = previewOf(t.text);
      items.push({
        ord: items.length, role: t.role, feature,
        text: pv.text, truncated: pv.truncated, textLength: pv.length,
        evidence: { session: session.id, turnIndex: t.index ?? items.length, domId: t.domId ?? null, selector: selectors[feature] },
      });
      if (items.length >= cap) break;
    }
  }
  const url = session.kv?.get?.('RECEIPT')?.pageUrl ?? session.meta?.target?.url ?? null;
  const thread = threadBinding(candidate.origin, url);
  return { schema: 'aion.learned-transcript/1', siteId: candidate.siteId, origin: candidate.origin, source: 'saved-session', sessionId: session.id, items, thread, cap };
}

/**
 * Live read-only transcript through the existing DomObserver: applies the candidate's selectors
 * with querySelectorAll, reads bounded innerText, orders by document position. No typing, no
 * dispatch, no network. `scrub` (optional) is the capture privacy text scrubber.
 */
export function liveTranscriptExpression({ userSelector, assistantSelector, cap = MAX_LIVE_TURNS, textCap = TEXT_PREVIEW_CAP }) {
  return `(() => {
  const cap = ${Number(cap)}, textCap = ${Number(textCap)};
  const grab = (sel, role) => {
    if (!sel) return [];
    try { return [...document.querySelectorAll(sel)].slice(0, cap).map((el) => ({ el, role })); } catch { return []; }
  };
  const items = [...grab(${JSON.stringify(userSelector)}, 'user'), ...grab(${JSON.stringify(assistantSelector)}, 'assistant')];
  items.sort((a, b) => (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1);
  return {
    readyState: document.readyState, url: location.href,
    items: items.slice(0, cap).map((x, i) => ({
      ord: i, role: x.role,
      text: String(x.el.innerText ?? x.el.textContent ?? '').slice(0, textCap),
      sig: (x.el.tagName || '').toLowerCase() + (x.el.getAttribute('role') ? '[role=' + x.el.getAttribute('role') + ']' : ''),
    })),
  };
})()`;
}

export async function transcriptFromLivePage({ dom, candidate, scrub, cap = MAX_LIVE_TURNS }) {
  if (!dom || typeof dom._evalInMain !== 'function') throw new TypeError('INVALID_DOM_OBSERVER');
  if (!candidate || candidate.schema !== 'aion.adaptive-webapp-adapter/1') throw new TypeError('INVALID_CANDIDATE');
  const userSelector = candidate.features?.['user-turn']?.selected?.candidate ?? null;
  const assistantSelector = candidate.features?.['assistant-turn']?.selected?.candidate ?? null;
  if (!userSelector && !assistantSelector) throw new TypeError('CANDIDATE_HAS_NO_READ_FEATURES');
  const r = await dom._evalInMain(liveTranscriptExpression({ userSelector, assistantSelector, cap }));
  const m = r?.value ?? r;
  if (!m || typeof m !== 'object') throw new TypeError('LIVE_TRANSCRIPT_UNAVAILABLE');
  const items = (Array.isArray(m.items) ? m.items : []).slice(0, cap).map((x, i) => {
    const raw = typeof x?.text === 'string' ? x.text : '';
    const scrubbed = typeof scrub === 'function' ? scrub(raw) : { text: raw, redactions: [] };
    return {
      ord: i, role: x?.role === 'user' ? 'user' : 'assistant',
      text: scrubbed.text, redactions: scrubbed.redactions?.length ?? 0,
      sig: typeof x?.sig === 'string' ? x.sig : null,
      evidence: { selector: x?.role === 'user' ? userSelector : assistantSelector, source: 'live-page' },
    };
  });
  const thread = threadBinding(candidate.origin, m.url);
  return { schema: 'aion.learned-transcript/1', siteId: candidate.siteId, origin: candidate.origin, source: 'live-page', live: true, pageReady: m.readyState, items, thread, cap };
}

// Read-only native response-part evidence from the EXISTING derived KV records. These are
// structural observations, not adapter selectors or verified message/conversation identity.
// No text, URLs, file names, account refs or content-derived identifiers are persisted here.
// A missing part in a saved snapshot does NOT establish absence or drift.
export const NATIVE_PART_EVIDENCE_SCHEMA = 'aion.native-part-evidence/1';
export function nativePartsFromSession(session, { maxParts = 256 } = {}) {
  if (!session || typeof session !== 'object' || !isString(session.id, 128)) throw new TypeError('INVALID_SESSION');
  const limit = Number.isSafeInteger(maxParts) ? Math.max(0, Math.min(256, maxParts)) : 256;
  const parts = [];
  const add = (part) => { if (parts.length < limit) parts.push(part); };
  const safeType = (v) => typeof v === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(v) ? v : 'unknown-native';
  const walk = (blocks, ref, turnOrd, role, depth = 0) => {
    if (!Array.isArray(blocks) || depth > 8 || parts.length >= limit) return;
    for (const [i, b] of blocks.entries()) {
      if (!b || typeof b !== 'object' || parts.length >= limit) continue;
      const pointer = `${ref}[${i}]`;
      add({ captureId: session.id, carrier: 'dom', sourceRef: pointer,
        turnOrd, role, nativeType: safeType(b.type), state: 'observed' });
      if (Array.isArray(b.inline)) for (const [j, inline] of b.inline.entries()) {
        if (parts.length >= limit) break;
        if (inline?.t === 'citation') add({ captureId: session.id, carrier: 'dom',
          sourceRef: `${pointer}.inline[${j}]`, turnOrd, role, nativeType: 'citation', state: 'observed' });
      }
      walk(b.blocks, `${pointer}.blocks`, turnOrd, role, depth + 1);
      if (Array.isArray(b.items)) for (const [j, item] of b.items.entries())
        walk(item?.blocks, `${pointer}.items[${j}].blocks`, turnOrd, role, depth + 1);
    }
  };
  const turns = session.kv?.get?.('DOM_TURNS');
  if (Array.isArray(turns)) turns.slice(0, 500).forEach((t, i) => {
    if (t?.role === 'user' || t?.role === 'assistant')
      walk(t.blocks, `KV:DOM_TURNS[${i}].blocks`, i, t.role);
  });
  const doc = session.kv?.get?.('STREAM_COMPONENTS');
  if (doc?.schema === 'capture-studio.stream-components/1' && Array.isArray(doc.streams)) {
    for (const [i, stream] of doc.streams.slice(0, 200).entries()) {
      if (!isString(stream?.mapId, 128) || !Array.isArray(stream.components)) continue;
      for (const [j, component] of stream.components.entries()) {
        if (parts.length >= limit) break;
        if (!component || typeof component !== 'object') continue;
        add({ captureId: session.id, carrier: 'network',
          sourceRef: `KV:STREAM_COMPONENTS.streams[${i}].components[${j}]`,
          turnOrd: null, role: 'unverified', nativeType: safeType(component.component),
          state: (stream.eventsOmitted ?? 0) > 0 || (stream.unmappedCount ?? 0) > 0
            ? 'incomplete' : component.opened === true && component.closed === false ? 'streaming' : 'observed',
          mapId: stream.mapId });
      }
    }
  }
  return { schema: NATIVE_PART_EVIDENCE_SCHEMA, captureId: session.id,
    parts, truncated: parts.length >= limit && limit > 0,
    // Absence, cross-carrier joins, semantic correctness and authorization are not asserted.
    completeness: 'presence-only' };
}


/**
 * Compare source-qualified saved structures without treating a missing saved part as an
 * absence vote. Each side remains traceable to its own capture and KV pointer.
 * This is diagnostic drift evidence only; the adapter factory still owns promotion.
 */
export function compareNativePartEvidence(before, after) {
  if (before?.schema !== NATIVE_PART_EVIDENCE_SCHEMA || after?.schema !== NATIVE_PART_EVIDENCE_SCHEMA)
    throw new TypeError('INVALID_NATIVE_PART_EVIDENCE');
  if (!isString(before.captureId, 128) || !isString(after.captureId, 128) ||
      before.captureId === after.captureId) throw new TypeError('NATIVE_PART_SOURCE_NOT_INDEPENDENT');
  const groups = (doc) => {
    const out = new Map();
    for (const p of doc.parts ?? []) {
      if (!['dom', 'network'].includes(p.carrier) || !isString(p.nativeType, 64)) continue;
      const key = JSON.stringify([p.carrier, p.role, p.nativeType]);
      if (!out.has(key)) out.set(key, { carrier: p.carrier, role: p.role, nativeType: p.nativeType, sources: [] });
      if (out.get(key).sources.length < 5 && isString(p.sourceRef, 200)) out.get(key).sources.push(p.sourceRef);
    }
    return out;
  };
  const old = groups(before), now = groups(after);
  const added = [...now].filter(([key]) => !old.has(key)).map(([, v]) => v);
  const notObserved = [...old].filter(([key]) => !now.has(key)).map(([, v]) => v);
  return { schema: 'aion.native-structural-change/1',
    baselineCaptureId: before.captureId, currentCaptureId: after.captureId,
    added, notObserved, // notObserved is NEVER negative evidence from a saved capture
    outcome: added.length ? 'new-structure-observed' : 'no-new-structure-observed',
    coverage: 'presence-only',
    adapterPromotionAuthorized: false };
}
