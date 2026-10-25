// Rendered ChatGPT chat-index foundation: an in-page observation expression plus a bounded,
// deterministic normaliser. Rendered links only: never a complete account list, never a click,
// scroll, search, focus, navigation or network request. The page origin is validated first and must be
// the canonical ChatGPT origin. Only links that resolve to that exact origin become candidates, and a
// candidate is parsed from the rendered link. It is not a live M1 binding. A link title is untrusted
// display text and is never an identity input. Open browser tabs are not a chat index and are not read here.
import { parseThread } from './conversation-thread.mjs';

export const CHAT_INDEX_SOURCE = 'page-visible-dom';
export const CHAT_INDEX_SCOPE = 'currently-rendered-links';
export const CHATGPT_CANONICAL_ORIGIN = 'https://chatgpt.com';
export const CHAT_INDEX_LIMITS = Object.freeze({
  maxEntries: { min: 1, max: 500, default: 100 },
  maxTitleChars: { min: 1, max: 300, default: 120 },
  scanLimit: { min: 1, max: 2000, default: 500 },
});
// Page-level rejection: the whole observation is refused, so no candidate entries are produced.
export const CHAT_INDEX_PAGE_ORIGIN_CODES = Object.freeze(['PAGE_ORIGIN_MISSING', 'PAGE_ORIGIN_MALFORMED', 'PAGE_ORIGIN_NON_HTTPS',
  'PAGE_ORIGIN_FOREIGN', 'PAGE_ORIGIN_NONCANONICAL']);
// Link-level omissions, counted and never returned as candidates.
// FOREIGN_HOST: a different hostname (including www and legacy aliases). CROSS_ORIGIN_LINK: same host, different port or scheme.
export const CHAT_INDEX_SKIP_CODES = Object.freeze(['HIDDEN_LINK', 'MALFORMED_LINK', 'NO_HREF', 'MALFORMED_URL', 'NON_HTTPS',
  'CREDENTIALS_IN_URL', 'FOREIGN_HOST', 'CROSS_ORIGIN_LINK', 'ROOT_OR_HOME', 'PROJECT_PAGE_UNSUPPORTED', 'PROJECT_THREAD_UNSUPPORTED',
  'MALFORMED_THREAD_PATH', 'NOT_THREAD_PATH']);
export const CHAT_INDEX_IDENTITY = Object.freeze({ state: 'candidate', reason: 'RENDERED_LINK_NOT_LIVE_BOUND' });
export const CHAT_INDEX_LIVE_BINDING = Object.freeze({ state: 'not-established', reason: 'NO_M1_BINDING' });
export const CHAT_INDEX_LIMITATIONS = Object.freeze([
  'Rendered links only; not a complete account chat list (complete is always false).',
  'No pagination or virtualization is observed; older or unrendered threads may exist.',
  'Open browser tabs are not a chat index and are never read here.',
  'Entries are parsed candidates from rendered links; they are not a live binding to any tab.',
  'Link titles are untrusted display text; identity is the thread path on the canonical origin only.',
  'Project and workspace context is not observed and is reported as unknown.',
]);

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const PROJECT_THREAD = new RegExp(`^/g/[^/]+/c/${UUID}/?$`, 'i');
const LABEL = /^[a-z][a-z-]{0,39}$/;
const HREF_CAP = 600, TEXT_CAP = 2000, SELECTOR_CAP = 200;

const fail = (code) => Object.assign(new Error(code), { code, status: 400 });
const safeCount = (value, fallback) => (Number.isSafeInteger(value) && value >= 0 ? value : fallback);

function chatIndexOptions(options = {}) {
  const o = options ?? {};
  const pick = (value, spec) => (value === undefined ? spec.default : value);
  const maxEntries = pick(o.maxEntries, CHAT_INDEX_LIMITS.maxEntries);
  const maxTitleChars = pick(o.maxTitleChars, CHAT_INDEX_LIMITS.maxTitleChars);
  const scanLimit = pick(o.scanLimit, CHAT_INDEX_LIMITS.scanLimit);
  for (const [value, spec] of [[maxEntries, CHAT_INDEX_LIMITS.maxEntries], [maxTitleChars, CHAT_INDEX_LIMITS.maxTitleChars], [scanLimit, CHAT_INDEX_LIMITS.scanLimit]]) {
    if (!Number.isSafeInteger(value) || value < spec.min || value > spec.max) throw fail('INVALID_CHAT_INDEX_OPTIONS');
  }
  const containers = o.containers === undefined ? [] : o.containers;
  if (!Array.isArray(containers) || containers.length > 8) throw fail('INVALID_CHAT_INDEX_OPTIONS');
  for (const c of containers) {
    if (!c || typeof c !== 'object' || !LABEL.test(c.label ?? '') || c.label === 'unknown'
      || typeof c.selector !== 'string' || !c.selector || c.selector.length > SELECTOR_CAP) throw fail('INVALID_CHAT_INDEX_OPTIONS');
  }
  return { maxEntries, maxTitleChars, scanLimit, containers: containers.map((c) => ({ label: c.label, selector: c.selector })) };
}

// Pure in-page reader. Returns raw observations only; it never focuses, scrolls, clicks, navigates,
// writes a property or reads attributes other than href. Container labels exist only when the caller
// supplies a verified selector; by default every link's container is reported as unknown.
export function chatIndexExpression(options = {}) {
  const o = chatIndexOptions(options);
  const selectors = options?.anchorSelectors ?? ['a[href]'];
  if (!Array.isArray(selectors) || selectors.length === 0 || selectors.length > 8
    || selectors.some((s) => typeof s !== 'string' || !s || s.length > SELECTOR_CAP)) throw fail('INVALID_CHAT_INDEX_OPTIONS');
  return `(() => {
    const ANCHORS = ${JSON.stringify(selectors)}, CONTAINERS = ${JSON.stringify(o.containers.map((c) => c.selector))};
    const SCAN = ${o.scanLimit}, HREF_CAP = ${HREF_CAP}, TEXT_CAP = ${TEXT_CAP};
    const seen = new Set();
    for (const sel of ANCHORS) {
      let list = [];
      try { list = Array.from(document.querySelectorAll(sel)); } catch (e) { list = []; }
      for (const el of list) seen.add(el);
    }
    const all = Array.from(seen);
    const slice = all.slice(0, SCAN);
    const visible = (el) => { try { const r = el.getBoundingClientRect(); return r.width > 1 && r.height > 1; } catch (e) { return false; } };
    const containerOf = (el) => {
      for (let i = 0; i < CONTAINERS.length; i++) {
        try { if (el.closest && el.closest(CONTAINERS[i])) return i; } catch (e) { /* invalid selector: not a match */ }
      }
      return -1;
    };
    const links = slice.map((el) => {
      const raw = el.getAttribute ? el.getAttribute('href') : null;
      const text = String(el.innerText ?? el.textContent ?? '').replace(/\\s+/g, ' ').trim();
      return { href: typeof raw === 'string' ? raw.slice(0, HREF_CAP) : null, text: text.slice(0, TEXT_CAP), visible: visible(el), container: containerOf(el) };
    });
    return { origin: String(location.origin), renderedLinks: all.length, truncatedScan: all.length > slice.length, links };
  })()`;
}

// Strips control and invisible characters, collapses whitespace and caps length by code point.
function cleanTitle(raw, cap) {
  const text = String(raw ?? '').slice(0, TEXT_CAP)
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\ufeff]/g, ' ')
    .replace(/\s+/g, ' ').trim();
  const chars = [...text];
  const truncated = chars.length > cap;
  return { text: truncated ? chars.slice(0, cap).join('') : text, truncated };
}

// Validates the page origin first. Only the exact canonical origin passes; anything else is a
// page-level rejection, so no candidate is produced from it.
export function pageOriginCode(origin) {
  if (origin === undefined || origin === null || origin === '') return 'PAGE_ORIGIN_MISSING';
  if (typeof origin !== 'string') return 'PAGE_ORIGIN_MALFORMED';
  if (origin === CHATGPT_CANONICAL_ORIGIN) return null;
  let url;
  try { url = new URL(origin); } catch { return 'PAGE_ORIGIN_MALFORMED'; }
  if (url.protocol !== 'https:') return 'PAGE_ORIGIN_NON_HTTPS';
  if (url.hostname !== 'chatgpt.com') return 'PAGE_ORIGIN_FOREIGN';
  return 'PAGE_ORIGIN_NONCANONICAL';
}

// Resolves one link against the canonical origin only. A link must resolve to exactly that origin,
// with no credentials; otherwise it is a coded omission. The base is always the canonical origin,
// never a value taken from the page, so a relative link cannot be placed on a guessed host.
function classify(href) {
  if (typeof href !== 'string' || href.trim() === '') return { code: 'NO_HREF' };
  let url;
  try { url = new URL(href.trim(), `${CHATGPT_CANONICAL_ORIGIN}/`); } catch { return { code: 'MALFORMED_URL' }; }
  if (url.protocol !== 'https:') return { code: 'NON_HTTPS' };
  if (url.username || url.password) return { code: 'CREDENTIALS_IN_URL' };
  if (url.origin !== CHATGPT_CANONICAL_ORIGIN) return { code: url.hostname === 'chatgpt.com' ? 'CROSS_ORIGIN_LINK' : 'FOREIGN_HOST' };
  const p = url.pathname;
  if (p === '/' || /^\/new\/?$/.test(p)) return { code: 'ROOT_OR_HOME' };
  if (p.startsWith('/g/')) return { code: PROJECT_THREAD.test(p) ? 'PROJECT_THREAD_UNSUPPORTED' : 'PROJECT_PAGE_UNSUPPORTED' };
  if (p.startsWith('/c/')) {
    const thread = parseThread('chatgpt', url.href);
    return thread ? { thread } : { code: 'MALFORMED_THREAD_PATH' };
  }
  return { code: 'NOT_THREAD_PATH' };
}

function containerState(labels) {
  const known = [...labels].filter((l) => l !== 'unknown');
  if (known.length === 1) return known[0];
  if (known.length > 1) return 'ambiguous';
  return 'unknown';
}

// Applies the caller's bounds to the raw page result. The page origin is checked before anything else.
// Deterministic: DOM-first-seen candidate order; identical input always yields identical output.
// Never throws on hostile page data.
export function normalizeChatIndex(raw, options = {}) {
  const o = chatIndexOptions(options);
  const skipped = Object.fromEntries(CHAT_INDEX_SKIP_CODES.map((code) => [code, 0]));
  const limits = { maxEntries: o.maxEntries, maxTitleChars: o.maxTitleChars, scanLimit: o.scanLimit };
  const base = { source: CHAT_INDEX_SOURCE, scope: CHAT_INDEX_SCOPE, complete: false, candidatesOnly: true, pagination: 'not-observed',
    virtualization: 'unknown', limitations: [...CHAT_INDEX_LIMITATIONS], limits };
  const rejected = (code) => ({ ...base, invalidResult: true, code, entries: [], skipped,
    coverage: { renderedLinks: 0, scannedLinks: 0, truncatedScan: false, visibleThreadLinks: 0, uniqueThreads: 0, duplicatesMerged: 0, returnedEntries: 0, omittedEntries: 0, titleTruncated: 0 } });
  if (!raw || typeof raw !== 'object') return rejected('INVALID_RESULT');
  const originCode = pageOriginCode(raw.origin);
  if (originCode) return rejected(originCode);
  if (!Array.isArray(raw.links)) return rejected('INVALID_RESULT');
  const renderedLinks = safeCount(raw.renderedLinks, raw.links.length);
  const links = raw.links.slice(0, o.scanLimit);
  const truncatedScan = raw.truncatedScan === true || raw.links.length > links.length || renderedLinks > links.length;
  const order = [], byKey = new Map();
  let visibleThreadLinks = 0, titleTruncated = 0;
  for (const link of links) {
    if (!link || typeof link !== 'object') { skipped.MALFORMED_LINK++; continue; }
    if (link.visible !== true) { skipped.HIDDEN_LINK++; continue; }
    const c = classify(link.href);
    if (c.code) { skipped[c.code]++; continue; }
    visibleThreadLinks++;
    const title = cleanTitle(link.text, o.maxTitleChars);
    if (title.truncated) titleTruncated++;
    const label = Number.isSafeInteger(link.container) && link.container >= 0 && link.container < o.containers.length ? o.containers[link.container].label : 'unknown';
    const key = `${CHATGPT_CANONICAL_ORIGIN}|${c.thread.ref}`;
    let entry = byKey.get(key);
    if (!entry) {
      entry = { threadRef: c.thread.ref, id: c.thread.id, path: `/c/${c.thread.id}`, origin: CHATGPT_CANONICAL_ORIGIN, titles: new Set(), firstTitle: null,
        containerLabels: new Set(), occurrences: 0 };
      byKey.set(key, entry); order.push(entry);
    }
    entry.occurrences++;
    entry.containerLabels.add(label);
    if (title.text) { entry.titles.add(title.text); if (entry.firstTitle === null) entry.firstTitle = { text: title.text, truncated: title.truncated }; }
  }
  const returned = order.slice(0, o.maxEntries);
  const entries = returned.map((e) => ({
    threadRef: e.threadRef, id: e.id, path: e.path, origin: e.origin,
    displayTitle: e.firstTitle ? { untrusted: true, text: e.firstTitle.text, truncated: e.firstTitle.truncated } : null,
    titleVariants: e.titles.size, container: containerState(e.containerLabels), occurrences: e.occurrences,
    project: { state: 'unknown', reason: 'NOT_OBSERVED' }, identity: { ...CHAT_INDEX_IDENTITY }, liveBinding: { ...CHAT_INDEX_LIVE_BINDING },
  }));
  return { ...base, invalidResult: false, entries, skipped,
    coverage: { renderedLinks, scannedLinks: links.length, truncatedScan, visibleThreadLinks, uniqueThreads: order.length,
      duplicatesMerged: visibleThreadLinks - order.length, returnedEntries: entries.length, omittedEntries: order.length - entries.length, titleTruncated } };
}
