// The L02->L03 seam of the webapp-native harness (roles/14-webapp-native-harness/CONTRACTS.md):
// a LOSS-AWARE common projection over Capture Studio's own derived session data. It never
// discards native structure to obtain a plain response.text, never fabricates identity
// (unverified stays null), and keeps DOM and network evidence separable when they disagree.
//
// Pure projection: the builder consumes already-derived artifacts (STREAM_COMPONENTS, DOM_TURNS,
// STREAM_DOM_JOIN, SHAPES, acceptance document) and an optional terminal-record scan. No browser
// logic, no new write path, no second parser; every node carries its source references so the
// original evidence stays authoritative.
//
// Identity rules (bench E03): a conversation reference is surfaced ONLY through the source-
// supported durable thread parser (ChatGPT /c/<uuid> today). Guest query-parameter identities
// (e.g. duck.ai ?chatID) and title/ordinal/timestamp/text heuristics are NEVER elevated; they
// stay binding 'unverified' with nativeRef null.
import { parseThread, threadSupported } from '../capture/conversation-thread.mjs';

export const OBSERVATION_SCHEMA = 'aion.web-observation/1';
export const OBSERVATION_VERSION = 1;
export const TEXT_PREVIEW_CAP = 240;
// Chat-surface detection uses the same endpoint heuristic as docs/AI-CHAT-SHAPES.md generation.
const CHAT_ENDPOINT_RE = /conversation|completion|chat|message|generate|stream|reply|timeline|response/i;

// SemanticPart vocabulary from the specialist contract, plus the native names the projection
// already knows. Anything outside the vocabulary is projected as 'unknown-native' with the raw
// component name retained — never silently coerced to text.
export const SEMANTIC_PARTS = Object.freeze(['text', 'markdown', 'code', 'table', 'chart', 'image', 'file',
  'citation', 'reference', 'visible-thinking-summary', 'progress', 'tool-activity-observed', 'artifact',
  'error', 'interactive-native', 'unknown']);

const PART_BY_NATIVE_COMPONENT = Object.freeze({
  paragraph: 'text', heading: 'markdown', list: 'markdown', table: 'table', code: 'code',
  quote: 'text', image: 'image', file: 'file', link: 'reference', citation: 'citation',
  equation: 'text', rule: 'text', tool: 'tool-activity-observed',
  message: 'text',
});

const preview = (text, cap = TEXT_PREVIEW_CAP) => {
  const full = typeof text === 'string' ? text : '';
  const truncated = full.length > cap;
  return { textPreview: truncated ? full.slice(0, cap) : full, textTruncated: truncated, textLength: full.length };
};

const projectPart = (c) => {
  const native = c.component ?? 'unknown';
  const partType = PART_BY_NATIVE_COMPONENT[native] ?? 'unknown-native';
  return {
    key: c.componentKey ?? null,
    partType,
    nativeType: native,
    ...(partType === 'unknown-native' ? { lossMarker: 'unknown-native-part' } : {}),
    state: c.opened === true && c.closed === true ? 'closed' : c.opened === true ? 'streaming' : 'unknown',
    ...preview(c.text),
  };
};

const projectTurn = (t, ord) => {
  const role = t?.role === 'user' || t?.role === 'assistant' ? t.role : 'unknown';
  return {
    ord,
    nativeRef: { carrier: 'dom', domId: t?.domId ?? t?.id ?? null, roleAttribute: t?.roleAttribute ?? null },
    partType: role === 'user' ? 'user-turn' : role === 'assistant' ? 'assistant-generation' : 'unknown-native',
    ...(role === 'unknown' ? { lossMarker: 'unknown-dom-role' } : {}),
    truncated: t?.truncated === true || undefined,
    ...preview(t?.text),
  };
};

// The five completion facts are DISTINCT (CONTRACTS lifecycle semantics): a single boolean done
// is never enough. Each fact names the evidence class it came from.
function completionFacts({ terminal, join, acceptance, sessionStatus }) {
  const streams = terminal?.streams ?? 0, done = terminal?.done ?? 0, failed = terminal?.fail ?? 0;
  const chatStreams = terminal?.chatStreams ?? null;
  const withoutTerminal = chatStreams === null ? null : Math.max(0, chatStreams - done - failed);
  return {
    providerNetworkEnded: streams === 0 ? 'unknown'
      : failed > 0 ? 'no' : withoutTerminal === 0 && done > 0 ? 'yes' : done > 0 ? 'partial' : 'no',
    pageStable: acceptance?.gates?.G3 ? acceptance.gates.G3.value : 'unassessed',
    turnAttribution: {
      domObserved: (terminal?.domTurns ?? 0) > 0,
      joinStatus: join && !join.error ? join.status ?? null : join?.error ? 'join-error' : 'not-derived',
      freshness: acceptance?.gates?.G1?.evidence?.freshness ?? 'unassessed',
    },
    captureFinalized: sessionStatus === 'complete' ? 'yes' : sessionStatus ? 'no' : 'unknown',
    captureAccepted: acceptance?.verdict ?? 'unassessed',
  };
}

function lossMarkers({ componentsDoc, domTurns, terminal, join }) {
  const out = [];
  const streams = Array.isArray(componentsDoc?.streams) ? componentsDoc.streams : [];
  const unmapped = streams.reduce((a, s) => a + (s.unmappedCount ?? 0), 0);
  if (unmapped) out.push({ kind: 'unmapped-stream-events', count: unmapped });
  if (componentsDoc?.totals?.eventsOmitted) out.push({ kind: 'events-omitted-from-window', count: componentsDoc.totals.eventsOmitted });
  const unknownParts = streams.reduce((a, s) => a + (s.components ?? []).filter((c) => !(c.component in PART_BY_NATIVE_COMPONENT)).length, 0);
  if (unknownParts) out.push({ kind: 'unknown-native-parts', count: unknownParts });
  const unknownRoles = (Array.isArray(domTurns) ? domTurns : []).filter((t) => t?.role !== 'user' && t?.role !== 'assistant').length;
  if (unknownRoles) out.push({ kind: 'unknown-dom-roles', count: unknownRoles });
  if (terminal && terminal.withoutTerminal > 0) out.push({ kind: 'streams-without-terminal-record', count: terminal.withoutTerminal });
  if (join?.error) out.push({ kind: 'join-error', detail: String(join.error).slice(0, 200) });
  return out;
}

/**
 * Build one `aion.web-observation/1` projection.
 * @param {{session: object, profile?: object|null, components?: object|null, domTurns?: Array|null,
 *          join?: object|null, shapes?: object|null, acceptance?: object|null,
 *          terminal?: {streams:number, done:number, fail:number, chatStreams:number|null, domTurns:number}|null}} input
 *   Every argument is optional; missing derive artifacts project as absent ('not-derived'), never guessed.
 */
export function buildObservation({ session, profile = null, components = null, domTurns = null,
  join = null, shapes = null, acceptance = null, terminal = null } = {}) {
  if (!session) throw new TypeError('buildObservation: session is required');
  const meta = session.meta ?? {};
  const site = meta.site ?? null;
  const targetUrl = meta.target?.url ?? null;
  // Identity: only the source-supported durable parser may surface a nativeRef. Everything else
  // is explicitly unverified — a title, an ordinal, a timestamp or a query parameter is not identity.
  let conversation = { binding: 'unverified', nativeRef: null, identitySource: null };
  if (site && threadSupported(site) && targetUrl) {
    const thread = parseThread(site, targetUrl);
    if (thread) conversation = { binding: 'url-parser-verified', nativeRef: thread.ref, identitySource: 'conversation-thread.mjs' };
  }
  const endpoints = Array.isArray(shapes?.endpoints) ? shapes.endpoints : [];
  const chatEndpoints = endpoints.filter((e) => CHAT_ENDPOINT_RE.test(e.endpoint ?? ''));
  const surface = chatEndpoints.length > 0 ? 'chat' : endpoints.length > 0 ? 'unknown' : 'unknown';

  const componentsDoc = components && components.schema === 'capture-studio.stream-components/1' ? components : null;
  const streams = (componentsDoc?.streams ?? []).map((s) => ({
    sid: s.sid,
    carrier: 'network-stream',
    native: { mapId: s.mapId ?? null, mapVerified: s.mapId !== null, eventsOmitted: s.eventsOmitted ?? 0 },
    partType: 'assistant-generation-parts',
    components: (s.components ?? []).map(projectPart),
    unmapped: { count: s.unmappedCount ?? 0, sample: s.unmappedSample ?? [] },
    errorSignals: s.signals?.errorCount ?? null,
  }));

  const turns = (Array.isArray(domTurns) ? domTurns : []).map(projectTurn);
  const joinSummary = join?.summary?.messageStatus ?? null;

  return {
    schema: OBSERVATION_SCHEMA, version: OBSERVATION_VERSION,
    provider: site,
    surface,
    account: { state: 'unknown', ref: null },
    conversation,
    browserAttachment: { state: 'not-attached', ref: null },
    turn: null,
    native: {
      shape: profile?.name ?? meta.profile?.name ?? 'generic',
      carriersObserved: [...new Set([...streams.map(() => 'network-stream'), ...(turns.length ? ['dom'] : [])])],
      maps: [...new Set(streams.map((s) => s.native.mapId).filter(Boolean))],
    },
    turns,
    streams,
    endpoints: { chat: chatEndpoints.length, total: endpoints.length,
      chatEndpointList: chatEndpoints.map((e) => ({ endpoint: e.endpoint, transports: Object.keys(e.transports ?? {}) })) },
    reconciliation: {
      dom: turns.length ? 'observed' : 'absent',
      network: streams.length ? 'observed' : 'absent',
      join: joinSummary ? { verified: joinSummary.verified ?? null, partial: joinSummary.partial ?? null,
        ambiguous: joinSummary.ambiguous ?? null, unlinkedStream: joinSummary.unlinked_stream ?? null, unlinkedDom: joinSummary.unlinked_dom ?? null }
        : { status: join?.status ?? (join?.error ? 'join-error' : 'not-derived') },
    },
    completion: completionFacts({ terminal, join, acceptance, sessionStatus: meta.status ?? null }),
    evidence: {
      capture: { session: session.id, ...(terminal?.seqRange ? { seqRange: terminal.seqRange } : {}) },
      acceptanceVerdict: acceptance?.verdict ?? 'unassessed',
      coverage: 'partial',
    },
    lossMarkers: lossMarkers({ componentsDoc, domTurns, terminal, join }),
  };
}

// Terminal-record scan over the raw log: which streams ended with done/fail. Bounded and honest:
// a stream with neither stays "without terminal" rather than being declared complete.
export async function scanTerminalRecords(session, { chatEndpointRe = CHAT_ENDPOINT_RE } = {}) {
  const shapes = session.kv.get('SHAPES', null);
  const chatSids = new Set();
  if (Array.isArray(shapes?.endpoints)) {
    // Endpoint->sid association is not stored per record; chat-ness is therefore reported as a
    // count of streams whose scan came from any terminal state, and chatStreams stays null unless
    // the caller supplies a role document. Never guessed per stream.
    for (const e of shapes.endpoints) if (chatEndpointRe.test(e.endpoint ?? '')) chatSids.add(e.endpoint);
  }
  const state = new Map(); // sid -> { done, fail }
  let firstSeq = null, lastSeq = null, count = 0;
  for await (const r of session.records()) {
    count++;
    if (typeof r.seq === 'number') { firstSeq ??= r.seq; lastSeq = r.seqTo ?? r.seq; }
    if ((r.k === 'done' || r.k === 'fail') && r.sid) {
      const e = state.get(r.sid) ?? { done: 0, fail: 0 };
      e[r.k]++; state.set(r.sid, e);
    }
  }
  let streams = 0, done = 0, fail = 0;
  for (const e of state.values()) { streams++; done += e.done; fail += e.fail; }
  return { streams, done, fail, chatStreams: null, domTurns: (session.kv.get('DOM_TURNS', null) ?? []).length,
    seqRange: count ? [firstSeq, lastSeq] : null, chatEndpointCount: chatSids.size };
}

/** Convenience: gather every derived artifact from a saved session and build the projection. */
export async function observeSession(session, { profile = null, acceptance = null, scanImpl = scanTerminalRecords } = {}) {
  const [terminal] = await Promise.all([scanImpl(session)]);
  // Acceptance lives in <session>/acceptance.json, not KV: callers pass readAcceptance(session).
  return buildObservation({
    session, profile,
    components: session.kv.get('STREAM_COMPONENTS', null),
    domTurns: session.kv.get('DOM_TURNS', null),
    join: session.kv.get('STREAM_DOM_JOIN', null),
    shapes: session.kv.get('SHAPES', null),
    acceptance: acceptance ?? null,
    terminal,
  });
}
