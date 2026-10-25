// Page-local capability capsule (CONTRACTS Availability semantics; bench E08): what THIS bound
// conversation can do RIGHT NOW, derived only from the runtime's own evidence — never from
// product marketing, a static command catalog, or another provider's contract.
//
// Availability values: 'supported' (the runtime's own gates would admit the operation on the
// current evidence), 'unavailable' (a gate visibly refuses, with the exact reason), 'unverified'
// (the evidence needed to decide has not been observed). The capsule is ADVISORY evidence for
// agents and the UI: the runtime re-checks every gate at effect time, so the capsule cannot
// bypass fencing — it can only describe it.
//
// Pure function over the conversation view + the site profile's measured selectors (the caller
// supplies the profile via the sites registry). No I/O, no registry import: this stays a pure
// projection so tests can feed synthetic views and profiles.
export const CAPSULE_SCHEMA = 'aion.capability-capsule/1';
export const CAPSULE_VERSION = 1;
export const AVAILABILITY = Object.freeze(['supported', 'unavailable', 'unverified']);

const op = (name, availability, { reason = null, evidence = [] } = {}) =>
  ({ operation: name, availability, ...(reason ? { reason } : {}), evidence });

export function buildCapabilityCapsule({ view, profile = null } = {}) {
  if (!view || typeof view !== 'object') throw new TypeError('buildCapabilityCapsule: view is required');
  const site = view.site ?? null;
  const adapter = profile ?? null;
  const identity = view.identity ?? { state: 'unknown' };
  const readiness = view.readiness ?? { ready: false };
  const state = view.state ?? 'disconnected';
  const finished = state === 'closed' || view.diagnostic?.finishPhase === 'done';
  const recovered = (view.limitations ?? []).some((l) => String(l).includes('Recovered snapshot'));
  const capturedAt = new Date().toISOString();

  const read = (() => {
    if (state === 'disconnected') return op('read_conversation', 'unavailable', { reason: 'NOT_CONNECTED', evidence: ['conversation state is disconnected'] });
    if (identity.state === 'unverified') return op('read_conversation', 'unavailable', { reason: 'THREAD_IDENTITY_UNVERIFIED', evidence: [`identity reason: ${identity.reason ?? 'unknown'}`] });
    if (recovered || identity.state === 'unknown') return op('read_conversation', 'unverified', { reason: 'READ_REQUIRES_LIVE_CONVERSATION', evidence: ['snapshot is recovered; no live page is attached'] });
    // A live, verified conversation can be read by the runtime (bounded transcript, zero send).
    // Whether the ADAPTER exposes a transcript reader is effect-time knowledge; unverified beats a guess.
    if (adapter?.assistant?.containerSelectors?.length || adapter?.composer?.selectors?.length) {
      return op('read_conversation', 'supported', { evidence: ['live conversation attached', `identity ${identity.state}`, 'site profile carries measured turn/composer selectors'] });
    }
    return op('read_conversation', 'unverified', { reason: 'READ_UNAVAILABLE', evidence: ['no measured turn selectors in the site profile'] });
  })();

  const submit = (() => {
    if (finished) return op('submit_conversation_turn', 'unavailable', { reason: 'CONVERSATION_FINISHED', evidence: [`state ${state}`] });
    if (identity.state !== 'bound') return op('submit_conversation_turn', 'unavailable', { reason: 'THREAD_IDENTITY_UNVERIFIED', evidence: [`identity ${identity.state}${identity.reason ? ` (${identity.reason})` : ''}`] });
    if (!adapter?.composer?.selectors?.length) return op('submit_conversation_turn', 'unavailable', { reason: 'COMPOSER_UNAVAILABLE', evidence: [`no measured composer selectors for ${site}`] });
    if (!adapter?.send) return op('submit_conversation_turn', 'unavailable', { reason: 'SEND_CONTROL_UNAVAILABLE', evidence: [`no measured send strategy for ${site}`] });
    if (view.writer?.active === true) return op('submit_conversation_turn', 'unavailable', { reason: 'WRITER_WINDOW_BUSY', evidence: ['an unresolved turn holds the writer window'] });
    if (readiness?.ready !== true) return op('submit_conversation_turn', 'unverified', { reason: readiness?.reason ?? 'NOT_CHECKED', evidence: ['run an explicit read-only readiness check first'] });
    return op('submit_conversation_turn', 'supported', {
      evidence: ['exact thread bound', `measured composer selectors: ${adapter.composer.selectors.length}`, 'writer window idle',
        'effect-time gates still apply: confirm:true, expectedRevision, durable key, per-turn capture'],
    });
  })();

  const stop = (() => {
    // Generation stop is a provider control; the runtime has no stop-generation operation today.
    // Report honestly instead of pretending finish_conversation stops the model.
    return op('stop_generation', 'unavailable', { reason: 'NOT_IMPLEMENTED_IN_RUNTIME', evidence: ['finish_conversation finalizes capture; it does not stop provider generation'] });
  })();

  const reconcile = (() => {
    if (state === 'disconnected') return op('reconcile_conversation', 'unavailable', { reason: 'NOT_CONNECTED' });
    if (view.writer?.active === true) return op('reconcile_conversation', 'supported', { evidence: ['writer window held; explicit reconciliation may resolve an unknown delivery'] });
    return op('reconcile_conversation', 'supported', { evidence: ['reconciliation is read-only and always available on a loaded conversation'] });
  })();

  const finish = (() => {
    if (finished) return op('finish_conversation', 'unavailable', { reason: 'CONVERSATION_FINISHED' });
    return op('finish_conversation', 'supported', { evidence: ['stops owned capture and releases resources; never resends'] });
  })();

  const closeTab = (() => {
    const owned = view.binding?.ownedByStudio === true;
    if (!owned) return op('close_tab', 'unavailable', { reason: 'TAB_NOT_STUDIO_OWNED', evidence: ['Studio never closes an owner-selected tab'] });
    if (view.writer?.active === true) return op('close_tab', 'unavailable', { reason: 'WRITER_WINDOW_BUSY', evidence: ['never close a tab while a turn effect is unresolved'] });
    return op('close_tab', 'supported', { evidence: ['Studio-owned tab; ownership-checked at effect time'] });
  })();

  const modelSelection = (() => {
    const hasControl = Array.isArray(adapter?.preflight?.modelSelectors) && adapter.preflight.modelSelectors.length > 0;
    return op('change_model', hasControl ? 'unverified' : 'unavailable', {
      reason: hasControl ? 'CONTROL_OBSERVED_BUT_SELECTION_READBACK_UNVERIFIED' : 'NO_OBSERVED_MODEL_CONTROL',
      evidence: hasControl ? ['selectors present in the profile; selection readback never verified'] : [`no model control selectors measured for ${site ?? 'this site'}`],
    });
  })();

  return {
    schema: CAPSULE_SCHEMA, version: CAPSULE_VERSION,
    conversationId: view.id ?? null,
    site,
    capturedAt,
    // What the capsule is: a page-evidence summary. What it is not: an entitlement, an effect
    // bypass, or a promise about provider-side features.
    scope: 'current conversation evidence only; the runtime re-checks every gate at effect time',
    operations: { read_conversation: read, read_transcript: read, submit_conversation_turn: submit,
      stop_generation: stop, reconcile_conversation: reconcile, finish_conversation: finish,
      close_tab: closeTab, change_model: modelSelection },
  };
}
