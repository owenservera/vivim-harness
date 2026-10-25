// Multi-target follow policy for one capture run.
//
// A run always starts on one user-selected tab (the "primary"). With { tabs: 'all' } every other
// web tab is recorded too; with { follow: true } the run also follows what the recorded pages
// spawn: popups / new tabs opened by a recorded page (CDP openerId chain) and service / shared
// workers of the sites being recorded. Dedicated workers and out-of-process iframes are not
// decided here: they arrive through Target.setAutoAttach on the recorded sessions.
//
// Decisions are pure so they are easy to reason about and reuse:
//   { follow: true,  role: 'tab' | 'popup' | 'worker' }
//   { follow: false, final: boolean, reason }   final=false -> re-evaluate when facts change
//                                               (a URL is assigned, a recorded page navigates)

export const FOLLOWABLE_WORKER_TYPES = Object.freeze(['service_worker', 'shared_worker']);
const WORKER_SET = new Set(FOLLOWABLE_WORKER_TYPES);
const INTERNAL_URL = /^(devtools|chrome|chrome-extension|chrome-untrusted|chrome-search|edge|brave|opera|vivaldi|moz-extension):/i;

export function hostOf(url) {
  try { const u = new URL(url); return /^(https?|wss?):$/.test(u.protocol) ? u.hostname : null; } catch { return null; }
}

// Same host, or one is a subdomain of the other (app.example.com <-> example.com).
export function sameSiteHost(a, b) {
  if (!a || !b) return false;
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

export function isInternalUrl(url) { return INTERNAL_URL.test(String(url ?? '')); }

export function followDecision(info, {
  tabs = 'one', follow = true, trackedIds = new Set(), trackedHosts = new Set(), count = 0, maxTargets = 32,
} = {}) {
  const type = info?.type;
  const url = String(info?.url ?? '');
  if (!info?.targetId) return { follow: false, final: true, reason: 'no_target_id' };
  if (trackedIds.has(info.targetId)) return { follow: false, final: false, reason: 'already_tracked' };
  if (type === 'page') {
    if (isInternalUrl(url)) return { follow: false, final: false, reason: 'internal_url' };
    if (follow && info.openerId && trackedIds.has(info.openerId)) {
      return count >= maxTargets ? { follow: false, final: false, reason: 'max_targets' } : { follow: true, role: 'popup' };
    }
    if (tabs === 'all') return count >= maxTargets ? { follow: false, final: false, reason: 'max_targets' } : { follow: true, role: 'tab' };
    return { follow: false, final: true, reason: 'tab_not_selected' };
  }
  if (WORKER_SET.has(type)) {
    if (!follow && tabs !== 'all') return { follow: false, final: true, reason: 'follow_disabled' };
    if (!url) return { follow: false, final: false, reason: 'url_pending' };
    const h = hostOf(url);
    if (!h) return { follow: false, final: true, reason: 'non_web_worker' };
    if (tabs !== 'all' && ![...trackedHosts].some((t) => sameSiteHost(t, h))) return { follow: false, final: false, reason: 'other_site' };
    return count >= maxTargets ? { follow: false, final: false, reason: 'max_targets' } : { follow: true, role: 'worker' };
  }
  return { follow: false, final: true, reason: 'type_not_followed' };
}
