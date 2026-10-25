// Server-only bridge from Core-accepted saved sessions into the existing I1 adapter events.
// Only DOM_TURNS is covered by acceptance.domDigest. No unbound SHAPES/route evidence,
// browser effects, text, or guessed account/native-conversation identity is admitted.
import { createHash } from 'node:crypto';
import { profileAdmission } from '../intel/profile-evidence.mjs';
import { scopeKey } from './adapter-evidence-intake.mjs';
import { captureToAdapterEvents } from './adapter-capture-to-signals.mjs';

export const ACCEPTED_SESSION_PRODUCER = 'accepted-session-dom-turns/1';
const ROLE_ATTRIBUTE = /^data-[a-zA-Z0-9-]{1,94}$/;
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = code => { throw Object.assign(new Error(code), { code }); };
const bounded = (s, cap = 320) => typeof s === 'string' && s.length > 0 && s.length <= cap && !/[\x00-\x1f\x7f]/.test(s);

export function domEvidenceRef(sessionId, digest) {
  if (!bounded(sessionId, 128) || !/^[a-f0-9]{64}$/.test(digest ?? '')) fail('DOM_EVIDENCE_ID_INVALID');
  return 'DOM_TURNS:' + hash(JSON.stringify([sessionId, digest]));
}

export function acceptedSessionToAdapterEvents({ scope, verified } = {}) {
  scopeKey(scope);
  const session = verified?.session, acceptance = verified?.acceptance;
  const admission = profileAdmission(acceptance, { validatedByCore: true });
  if (!session?.kv?.get || !bounded(session.id, 128) || !admission.eligible ||
      verified.rawDigest !== acceptance.binding.rawDigest || verified.domDigest !== acceptance.binding.domDigest)
    fail('SESSION_NOT_CORE_ACCEPTED');
  const range = acceptance.binding.seqRange;
  if (!Array.isArray(range) || range.length !== 2 || !range.every(Number.isSafeInteger) || range[0] > range[1])
    fail('ACCEPTANCE_SEQUENCE_UNBOUND');
  // The attached target is the session origin. Receipt/DOM_INSPECT are not acceptance-bound.
  let observedOrigin;
  try { observedOrigin = new URL(session.meta?.target?.url).origin; } catch { fail('SESSION_ORIGIN_UNBOUND'); }
  if (observedOrigin !== scope.origin || (session.meta?.site && session.meta.site !== scope.siteId))
    fail('SESSION_SCOPE_MISMATCH');
  const turns = session.kv.get('DOM_TURNS', null);
  if (!Array.isArray(turns) || turns.length > 10000) fail('DOM_TURNS_INVALID');
  const ref = domEvidenceRef(session.id, verified.domDigest), dom = [], seen = new Set();
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i], role = t?.role, attr = t?.roleAttribute;
    // Respect the observer's exact/suffix match contract (including ChatGPT's
    // data-content-search-unit-key), without disclosing DOM handles or raw text.
    if (!['user', 'assistant'].includes(role) || !ROLE_ATTRIBUTE.test(attr ?? '') ||
        (t.roleMatch != null && !['exact', 'suffix'].includes(t.roleMatch)) || !bounded(t.domId)) continue;
    const key = attr + ':' + role + ':' + (t.roleMatch === 'suffix' ? 'suffix' : 'exact');
    if (seen.has(key)) continue;
    seen.add(key);
    dom.push({ attributes: { [attr]: role }, role, roleAttribute: attr,
      roleMatch: t.roleMatch === 'suffix' ? 'suffix' : 'exact', outcome: 'present',
      identity: { verified: true, role, evidenceRef: ref,
        ref: 'bound-dom-turn:' + hash(JSON.stringify([verified.domDigest, i, t.domId])) } });
  }
  const source = { producer: ACCEPTED_SESSION_PRODUCER, captureId: session.id,
    sessionId: session.id, sequence: range[1], rawDigest: verified.rawDigest,
    domDigest: verified.domDigest, origin: scope.origin, accountRef: scope.accountRef,
    accountBinding: 'caller-scoped-unverified', carrier: 'dom', coverage: 'complete',
    evidenceClass: 'SAVED_REAL_CAPTURE', evidenceRef: ref,
    provenance: { artifact: 'DOM_TURNS', acceptanceSchema: acceptance.schema,
      sequenceRange: [...range], rawDigest: verified.rawDigest, domDigest: verified.domDigest } };
  return captureToAdapterEvents([{ scope: { ...scope }, source, dom }]);
}
