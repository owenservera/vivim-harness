// DevTools HTTP discovery on loopback only.
// Read-only: only /json/version and /json/list are used. Nothing here creates, activates or
// closes tabs, so discovery can never change what the person is looking at.
import { assertLoopbackUrl, sleep } from './client.mjs';

export function endpointBase({ host = '127.0.0.1', port = 9222 } = {}) {
  const base = `http://${host}:${port}`;
  assertLoopbackUrl(base);
  return base;
}

async function getJson(url, timeoutMs = 3000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

// Same request, retried briefly: Chrome's HTTP endpoint answers a moment after the port opens.
async function getJsonRetry(url, { timeoutMs = 3000, attempts = 3, delayMs = 150 } = {}) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try { return await getJson(url, timeoutMs); } catch (e) { last = e; if (i + 1 < attempts) await sleep(delayMs * (i + 1)); }
  }
  throw last;
}

export async function browserVersion(opts) {
  return getJson(`${endpointBase(opts)}/json/version`);
}

export async function listTargets(opts) {
  const all = await getJson(`${endpointBase(opts)}/json/list`);
  return all.filter((t) => t.type === 'page');
}

// Everything DevTools reports, including workers, iframes, service workers and extensions.
export async function listAllTargets(opts) {
  return getJson(`${endpointBase(opts)}/json/list`);
}

export async function isReachable(opts) {
  try { await browserVersion(opts); return true; } catch { return false; }
}

// The browser-level WebSocket endpoint, re-resolved on every call. Pass this (bound) as the
// `discover` function of ResilientCdpConnection so a Chrome restart is survivable.
export async function browserWsUrl(opts) {
  const v = await getJsonRetry(`${endpointBase(opts)}/json/version`);
  if (!v.webSocketDebuggerUrl) throw new Error('DevTools did not report a webSocketDebuggerUrl');
  assertLoopbackUrl(v.webSocketDebuggerUrl);
  return v.webSocketDebuggerUrl;
}

// Full discovery probe used by the studio health view.
export async function discoveryProbe(opts = {}) {
  const started = Date.now();
  try {
    const version = await getJsonRetry(`${endpointBase(opts)}/json/version`);
    const targets = await listAllTargets(opts);
    return {
      reachable: true, latencyMs: Date.now() - started,
      browser: version.Browser, protocol: version['Protocol-Version'], userAgent: version['User-Agent'],
      webSocketDebuggerUrl: version.webSocketDebuggerUrl,
      targets: targets.map(targetSummary),
      counts: targets.reduce((a, t) => { a[t.type] = (a[t.type] ?? 0) + 1; return a; }, {}),
    };
  } catch (e) {
    return { reachable: false, latencyMs: Date.now() - started, error: String(e?.message ?? e) };
  }
}

export function targetSummary(t) {
  let host = '';
  try { host = new URL(t.url).host; } catch { /* about:, chrome-extension:, ... */ }
  return { id: t.id, type: t.type, host, title: t.title, attached: !!t.attached, scheme: String(t.url ?? '').split(':')[0] };
}

// Wait until the DevTools endpoint answers (used after launching Chrome).
export async function waitForReachable(opts = {}, { timeoutMs = 15_000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await isReachable(opts)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(intervalMs);
  }
}

// Wait until a target matching the selector exists (a tab the person is about to open).
export async function waitForTarget(selector, opts = {}, { timeoutMs = 30_000, intervalMs = 400 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  for (;;) {
    try { return pickTarget(await listTargets(opts), selector); } catch (e) { lastError = e; }
    if (Date.now() >= deadline) throw lastError ?? new Error(`No tab matched "${selector}" within ${timeoutMs} ms.`);
    await sleep(intervalMs);
  }
}

// Resolve a user-supplied target selector: exact id, id prefix, index, or URL/title substring.
export function pickTarget(targets, selector) {
  if (selector === undefined || selector === null || selector === '') {
    if (targets.length === 1) return targets[0];
    if (targets.length === 0) {
      throw new Error('No recordable tabs are open in the browser on this DevTools port. Open a page, or run "studio launch".');
    }
    throw new Error(`Several tabs are open; choose one with --target (run "studio targets").`);
  }
  const s = String(selector);
  const exact = targets.find((t) => t.id === s);
  if (exact) return exact;
  if (/^\d+$/.test(s) && Number(s) < targets.length) return targets[Number(s)];
  const prefix = targets.filter((t) => t.id.startsWith(s));
  if (prefix.length === 1) return prefix[0];
  const sub = targets.filter((t) => t.url.includes(s) || (t.title ?? '').toLowerCase().includes(s.toLowerCase()));
  if (sub.length === 1) return sub[0];
  if (sub.length > 1) throw new Error(`"${s}" matches ${sub.length} tabs; be more specific.`);
  throw new Error(`No tab matches "${s}".`);
}

// All targets a selector matches, ranked (exact id first). For multi-tab capture UIs.
export function pickTargets(targets, selector) {
  if (!selector) return [...targets];
  const s = String(selector).toLowerCase();
  const scored = targets.map((t) => {
    let score = -1;
    if (t.id === selector) score = 100;
    else if (t.id.startsWith(selector)) score = 80;
    else if ((t.url ?? '').toLowerCase().includes(s)) score = 50;
    else if ((t.title ?? '').toLowerCase().includes(s)) score = 40;
    return { target: t, score };
  }).filter((x) => x.score >= 0).sort((a, b) => b.score - a.score);
  return scored.map((x) => x.target);
}

// Has the tab we were recording gone away or navigated to a different origin?
export async function targetStillPresent(targetId, opts = {}) {
  try {
    const all = await listAllTargets(opts);
    const hit = all.find((t) => t.id === targetId);
    return hit ? { present: true, url: hit.url, title: hit.title, type: hit.type } : { present: false };
  } catch (e) { return { present: false, error: String(e?.message ?? e) }; }
}
