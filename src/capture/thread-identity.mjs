// Provider-specific conversation identity resolution (four-lane C1 seam).
// Binds native conversation identity ONLY from the existing selected site adapter's genuinely
// resolved claims plus Capture Studio observation provenance — never from chat titles, text,
// tab labels or URL query fragments. Unknown providers keep every identity slot `unverified`
// (fail-closed), while ChatGPT's strict `/c/<uuid>` native-route contract stays exactly as
// strict as the canonical parser. Pure module: no browser, no effects, no storage.
import { resolveAttachment } from '../studio/core-runtime-bridge.mjs';

export const THREAD_IDENTITY_SCHEMA = 'aion.thread-identity/1';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const EVIDENCE_CLASSES = ['saved-real-capture', 'live-browser-observation', 'synthetic-fixture'];

/** ChatGPT native-route claim: only an exact https origin + strict `/c/<uuid>` path binds. */
export function chatgptConversationClaim({ url, captureRef, sequence, evidenceClass = 'live-browser-observation' } = {}) {
  if (typeof url !== 'string' || !captureRef || !Number.isSafeInteger(sequence) || sequence < 0) return null;
  if (!EVIDENCE_CLASSES.includes(evidenceClass)) return null;
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'https:' || !u.hostname) return null;
  const m = new RegExp(`^/c/(${UUID})/?$`).exec(u.pathname);
  if (!m) return null; // home, search, share or future routes never mint a conversation claim
  return {
    kind: 'conversation', verified: true, nativeRef: m[1],
    origin: u.origin,
    source: { kind: 'native-route', captureRef, sequence, reference: `/c/${m[1]}`, evidenceClass },
  };
}

/** Resolve a provider-scoped attachment with exact identity slots. `claims` come ONLY from the
 * selected adapter / parser (see chatgptConversationClaim); everything unproven stays
 * `unverified`. Throws the bridge's coded errors for scope/evidence violations. */
export function resolveConversationIdentity({ providerId, siteId, origin, surface = 'chat',
  adapterKind = 'seed', adapterVersion = 'seed', page, claims = {} } = {}) {
  return resolveAttachment({
    adapter: { providerId, siteId, surface, origin, kind: adapterKind, version: adapterVersion },
    page,
    resolved: claims,
  });
}
