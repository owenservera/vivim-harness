// Chat workspace. Same-origin fetches only; the studio cookie authenticates every request.
// Everything that comes from a site or the service (titles, replies, reasons) is rendered with
// textContent and DOM nodes, never as HTML. The pure helpers below are exported for offline tests.

const API = '/api/v1';
const SELECTED_KEY = 'capture-studio.chat.selected';
const RAW_KEY = 'capture-studio.chat.plain-reply';


/* ---------------- pure helpers (no DOM, no network) ---------------- */
const CONVERSATION_STATES = {
  disconnected: ['Disconnected', 't-mute'], attaching: ['Connecting…', 't-live'], ready: ['Ready', 't-info'],
  busy: ['Busy', 't-live'], blocked: ['Blocked', 't-warn'], 'needs-reconciliation': ['Needs checking', 't-warn'],
  finalizing: ['Finishing…', 't-warn'], closed: ['Closed', 't-mute'],
};
const SEND_STATES = {
  'not-attempted': ['Not sent yet', 't-mute'], submitting: ['Submitting', 't-live'],
  observed: ['Send observed', 't-info'], uncertain: ['Send not confirmed', 't-warn'],
};
const REPLY_STATES = {
  waiting: ['Waiting for reply', 't-mute'], streaming: ['Reply streaming', 't-live'], ready: ['Reply ready', 't-info'],
  interrupted: ['Reply interrupted', 't-warn'], unknown: ['Reply state unknown', 't-warn'],
};
const CAPTURE_STATES = {
  recording: ['Recording', 't-rec'], idle: ['Not recording', 't-mute'], finalizing: ['Finishing capture…', 't-warn'], accepted: ['Capture accepted', 't-ok'],
  rejected: ['Capture rejected', 't-bad'], incomplete: ['Capture incomplete', 't-warn'],
};
const SOURCE_LABELS = {
  network: 'Source: network stream',
  page: 'Source: page text (network stream not matched)',
  differ: 'Source: network stream and page text differ',
  candidate: 'Source: unverified candidate',
};
const BLOCK_LABELS = {
  answer: 'Answer', reasoning: 'Reasoning shown by the site', tool: 'Tool activity', 'tool-activity': 'Tool activity',
  tool_activity: 'Tool activity', citations: 'Citations', citation: 'Citations',
};
const GATE_LABELS = {
  G1: 'New message observed (page, network or both)', G2: 'A new reply appeared', G3: 'Reply finished',
  G4: 'Recording stopped cleanly', G5: 'Recording integrity check', G6: 'Data extracted', G7: 'Page text and network data agree',
};
const GATE_VALUES = { passed: ['Passed', 't-ok'], failed: ['Failed', 't-bad'], 'not-checked': ['Not checked', 't-mute'], unknown: ['Unknown', 't-warn'] };

// Service reason codes -> plain sentences. Unknown codes are shown as words, never hidden.
const REASONS = {
  DRAFT_PRESENT: 'There’s text in the chat box.',
  DRAFT_OR_BINDING_NOT_READY: 'Studio couldn’t confirm that the chat box is empty and that this is still the tab you connected.',
  BINDING_CHANGED: 'This is no longer the tab you connected (different tab or site).',
  PREFLIGHT_FAILED: 'Studio couldn’t inspect the chat box.',
  NOT_CHECKED: 'Studio hasn’t checked the chat box yet.',
  SUBMISSION_STOPPED: 'Sending was stopped before it finished.',
  THREAD_IDENTITY_UNVERIFIED: 'Studio can’t tell which chat this tab is showing, so it won’t send.',
};
const UNCERTAINTY = {
  'runtime-restarted': 'Studio restarted. It never replays an earlier action.',
  'partial-draft-possible': 'Typing may have been interrupted, so partial text could be in the chat box. Nothing is known to have been sent.',
  'send-acknowledgement-lost': 'Studio lost the confirmation for the send.',
  'attachment-interrupted': 'Connecting to the tab didn’t finish cleanly.',
  'attachment-failed': 'Connecting to the tab didn’t finish cleanly.',
  'attachment-binding-mismatch': 'Connecting to the tab didn’t finish cleanly.',
};
const FINISH_ERRORS = {
  CAPTURE_STOP_FAILED: 'Studio couldn’t confirm that recording stopped.',
  TAB_CLOSE_UNCONFIRMED: 'Studio couldn’t confirm that the tab was closed.',
};
const ERROR_TEXT = {
  STALE_REVISION: 'This conversation changed since you last saw it, so nothing was sent. It has been refreshed.',
  ONE_TURN_LIMIT: 'This release sends one message per conversation.',
  THREAD_FENCED: 'The previous turn in this chat isn’t complete or confirmed yet, so Studio won’t send another. Nothing was sent.',
  PRIOR_TURN_CAPTURE_NOT_FINALIZED: 'The previous turn’s recording isn’t finished, so Studio won’t start the next turn. Nothing was sent.',
  THREAD_CHANGED_BETWEEN_TURNS: 'This chat changed since the last turn (an earlier message was edited, removed or regenerated). Nothing was sent.',
  NOT_READY: 'Studio isn’t ready to send. Use Check again (read-only) first.',
  CONFIRM_REQUIRED: 'Sending needs your explicit confirmation.',
  INVALID_SUBMISSION: 'The message is empty or longer than 250000 characters.',
  IDEMPOTENCY_CONFLICT: 'That request ID was already used for a different message.',
  CONVERSATION_FINISHED: 'This conversation has been finished.',
  CONVERSATION_NOT_WRITABLE: 'This conversation can’t send: it was recovered after a restart, or another Studio process owns it.',
  CONVERSATION_OWNED_BY_ANOTHER_RUNTIME: 'Another Studio process owns this conversation.',
  CONVERSATION_NOT_FOUND: 'That conversation no longer exists.',
  RECONCILIATION_UNAVAILABLE: 'Studio couldn’t read the page to check.',
  PERSISTENCE_FAILED_REOPEN_REQUIRED: 'Studio couldn’t save this conversation and stopped using it. Reopen it from Earlier conversations.',
  CORRUPT_OR_UNREADABLE_SNAPSHOT: 'The saved conversation couldn’t be read.',
  DRIVE_LEASE_BUSY: 'A Chat conversation or a drive job holds the browser. Finish it in Chat or in Live drive.',
  ATTACHMENT_FAILED: 'Studio couldn’t attach to that tab.',
  INVALID_ATTACHMENT: 'Studio couldn’t attach to that tab.',
  TARGET_NOT_FOUND: 'That tab is gone. Refresh tabs.',
  TARGET_SITE_MISMATCH: 'That tab isn’t on the site Studio expected.',
  SITE_ADAPTER_UNAVAILABLE: 'Studio has no adapter for that site.',
  INVALID_CONNECT: 'Studio didn’t accept that connection request.',
  INVALID_TARGET_SELECTION: 'Choose either a new tab or an existing tab, not both.',
  RUNTIME_CLOSED: 'Studio is shutting down.',
  BINDING_CHANGED: 'This tab is no longer on the chat Studio expected (a different tab or chat). Studio used nothing from it.',
  THREAD_IDENTITY_UNVERIFIED: 'Studio can’t tell which chat this tab is showing, so it won’t read or send. It did not pick another chat.',
  READ_REQUIRES_LIVE_CONVERSATION: 'Studio can only read a conversation it is connected to right now. This one was recovered after a restart or belongs to another Studio process.',
  READ_UNAVAILABLE: 'Reading the page isn’t available for this site yet.',
  READ_FAILED: 'Studio couldn’t read the page.',
  INVALID_READ: 'Studio didn’t accept that read request.',
  BROWSER_UNAVAILABLE: 'Studio can’t reach the capture browser. Check that it is open.',
};

const word = (s) => String(s ?? '').replace(/[-_]+/g, ' ').trim();
const pair = (table, key, prefix) => table[key] ?? [(prefix ? prefix + ': ' : '') + (key ? word(key) : 'unknown'), 't-warn'];
const isCode = (s) => typeof s === 'string' && /^[A-Z][A-Z0-9_]{2,}$/.test(s);

export const siteName = (site) => (typeof site === 'string' ? site : site?.id ?? '');
export const conversationChip = (state) => pair(CONVERSATION_STATES, state, 'State');
export const sendChip = (state) => pair(SEND_STATES, state, 'Send');
export const replyChip = (state) => pair(REPLY_STATES, state, 'Reply');
// "Accepted" appears only when the evaluator literally returned it; anything unrecognised is shown as such.
export const captureChip = (state) => pair(CAPTURE_STATES, state, 'Capture');
export const sourceLabel = (source) => SOURCE_LABELS[source] ?? 'Source: unknown';
export function completionLabel(completion) {
  if (completion == null || completion === '' || completion === 'unknown') return 'Completion unknown: the end of the reply was not confirmed on the network.';
  return 'Completion: ' + word(completion);
}
export function gateChip(value) { return GATE_VALUES[value] ?? GATE_VALUES.unknown; }
// Missing evidence is unknown, never passed.
export function gateValue(g) { return g?.state ?? g?.value ?? (g?.ok === true ? 'passed' : g?.ok === false ? 'failed' : 'unknown'); }
export function gateLabel(gate) { return gate?.label ?? GATE_LABELS[gate?.id] ?? word(gate?.id ?? 'Check'); }
export function integrityText(capture) {
  const i = capture?.integrity;
  if (i == null) return 'Not checked';
  if (typeof i === 'string') return word(i);
  if (typeof i === 'boolean') return i ? 'Passed' : 'Failed';
  if (typeof i === 'object' && typeof i.ok === 'boolean') return i.ok ? 'Passed' : 'Failed';
  return 'Reported, see session';
}
export function reasonText(code) {
  if (!code) return '';
  return REASONS[code] ?? (isCode(code) ? 'Studio reported: ' + word(code).toLowerCase() + '.' : String(code));
}
export function uncertaintyText(code) { return code ? (UNCERTAINTY[code] ?? 'Studio reported: ' + word(code) + '.') : ''; }
export function finishErrorText(err) { return err ? (FINISH_ERRORS[err] ?? String(err)) : ''; }
export function explainError({ status, code, message } = {}) {
  if (status === 401 || status === 403) return 'Local Studio refused this request. Check its address and Origin settings; if you enabled token mode, reopen the URL shown at startup.';
  const c = code ?? (isCode(message) ? message : null);
  if (c && ERROR_TEXT[c]) return ERROR_TEXT[c];
  if (c) return 'Studio reported: ' + word(c).toLowerCase() + '.';
  if (status === 404) return 'Not found. This Studio build may not include Chat yet, or the item no longer exists.';
  return message || 'Request failed';
}
// Some errors come with a place to go next. Text stays plain; the page adds the link as a DOM node.
export function errorLink(code) { return code === 'DRIVE_LEASE_BUSY' ? { href: '/drive', text: 'Open Live drive' } : null; }
// "Not sent" is only printed when the service itself said the send was not attempted.
export const notSentReported = (err) => [err?.data?.send?.state, err?.data?.sendState, err?.data?.turn?.send?.state, err?.data?.conversation?.turn?.send?.state].includes('not-attempted');
// A definite (4xx) rejection of the one explicit send. Only a stale revision suggests pressing Send again.
export function sendRejection(err) {
  const code = err?.data?.code ?? (isCode(err?.message) ? err.message : null);
  let text = (notSentReported(err) ? 'Not sent. ' : 'Studio rejected this request. ') + explainError({ status: err?.status, code, message: err?.message });
  if (err?.status === 409 && code === 'STALE_REVISION') text += ' Your message is still in the box. Press Send if you still want to send it.';
  return { text, code, link: errorLink(code) };
}

export const hasTurn = (snap) => !!snap?.turn;
// A turn rejected before anything was typed. The service keeps it as a blocked, not-attempted attempt.
export const isBlockedTurn = (snap) => snap?.turn?.phase === 'blocked' && snap?.turn?.send?.state === 'not-attempted';
// "Started" means the send action was at least begun. Preparing/typing and blocked turns have not sent anything.
export const messageStarted = (snap) => !!snap?.turn && snap.turn.send?.state !== 'not-attempted';
export const isPreparing = (snap) => snap?.turn?.phase === 'preparing';

/* ---- successive turns: one conversation, one native thread, one turn at a time ---- */
// Every turn of the conversation, oldest first. Older snapshots that only carry the latest turn still work.
export const turnsOf = (snap) => (Array.isArray(snap?.turns) && snap.turns.length ? snap.turns : snap?.turn ? [snap.turn] : []);
const turnBlockedBeforeTyping = (t) => t?.phase === 'blocked' && t?.send?.state === 'not-attempted';
// A turn is complete only when its send was observed, its reply is finalized and the reply's readiness is proven.
export const turnSettled = (t) => t?.send?.state === 'observed' && t?.reply?.state === 'ready' && t?.readiness?.state === 'ready';
// A turn that was started (or is being prepared/uncertain) and is not complete: it keeps the composer closed.
export const turnInFlight = (snap) => turnsOf(snap).some((t) => !turnBlockedBeforeTyping(t) && !turnSettled(t));
export const hasUncertainTurn = (snap) => turnsOf(snap).some((t) => t?.send?.state === 'uncertain' || t?.phase === 'needs-reconciliation');
export const turnCount = (snap) => turnsOf(snap).filter((t) => !turnBlockedBeforeTyping(t)).length;
// The composer is open for another turn once every started turn is complete (never while one is in flight).
export const composerOpen = (snap) => !!snap && !['closed', 'finalizing'].includes(snap.state) && !turnInFlight(snap);
// Per-turn rows for the turn list. `current` is the latest started/preparing turn (shown in full below the list).
export function turnRows(snap, prompts = {}) {
  const turns = turnsOf(snap);
  const detail = [...turns].reverse().find((t) => !turnBlockedBeforeTyping(t) || t?.phase === 'preparing');
  return turns.map((t, i) => {
    const blocked = turnBlockedBeforeTyping(t), reply = t?.reply ?? {};
    return { n: i + 1, id: t?.id ?? '', current: t === detail, blocked, settled: turnSettled(t),
      chips: [blocked ? ['Not sent yet', 't-mute'] : sendChip(t?.send?.state), ...(!blocked && t?.send?.state !== 'not-attempted' ? [replyChip(reply.state)] : [])],
      reason: blocked ? t.reason ?? null : null, sessionId: t?.sessionId ?? null,
      prompt: typeof prompts?.[t?.id] === 'string' ? prompts[t.id] : '', reply: typeof reply.text === 'string' ? reply.text : '' };
  });
}

// One row of "Earlier conversations": the tab title when the service has one, how many turns went through and whether it
// needs a look. Everything comes from the service's own list fields; nothing is guessed.
export function historyRow(c) {
  const n = turnCount(c), cs = c?.capture?.state, site = siteName(c?.site);
  const title = (typeof c?.binding?.title === 'string' && c.binding.title.trim()) || site || c?.id || 'Conversation';
  const meta = [site && title !== site ? site : null, n ? n + (n === 1 ? ' turn' : ' turns') : turnsOf(c).length ? 'Nothing sent' : null, cs ? captureChip(cs)[0] : null, threadRef(c?.binding) ? 'Chat thread saved' : null].filter(Boolean).join(' · ');
  return { id: c?.id ?? '', title: title.slice(0, 80), meta, chip: conversationChip(c?.state), attention: c?.state === 'needs-reconciliation' || hasUncertainTurn(c) };
}
export const HISTORY_PAGE = 20;
export const historyShown = (list, all) => (all ? list : list.slice(0, HISTORY_PAGE));

export function draftInfo(snap) {
  const d = snap?.readiness?.draft ?? snap?.draft ?? snap?.binding?.draft ?? null;
  if (d === true) return { present: true, unknown: false, chars: null };
  if (d && typeof d === 'object') return { present: d.present === true, unknown: d.present == null, chars: Number.isFinite(d.chars) ? d.chars : null };
  const reason = snap?.readiness?.reason ?? snap?.blocked?.reason ?? snap?.blockedReason ?? snap?.reason;
  return { present: typeof reason === 'string' && /draft/i.test(reason), unknown: true, chars: null };
}
export const isUncertain = (snap) => snap?.turn?.send?.state === 'uncertain' || snap?.state === 'needs-reconciliation';
// pending=true: the send request got no usable answer (network loss, 5xx, unreadable reply), so no turn is known yet.
export function uncertainView(snap, { pending = false, detail = '' } = {}) {
  const sendUnsure = snap?.turn?.send?.state === 'uncertain' || snap?.diagnostic?.uncertainty === 'send-acknowledgement-lost';
  const lines = [uncertaintyText(snap?.diagnostic?.uncertainty), finishErrorText(snap?.diagnostic?.finishError), reasonText(snap?.turn?.reason)].filter(Boolean);
  if (pending) {
    lines.unshift('No confirmation came back for the send request.' + (detail ? ' ' + detail : ''),
      'Send again submits your message as a new one, so it can appear twice if the first one went through.');
    return { headline: 'We can’t confirm your message was sent. Studio will not send it again.', lines: [...new Set(lines)] };
  }
  return {
    headline: sendUnsure
      ? 'We can’t confirm your message was sent. Studio will not send it again.'
      : 'Studio needs you to check this conversation. Studio will not send anything by itself.',
    lines: [...new Set(lines)],
  };
}
// Plain guidance beside the uncertain banner. It is text, not a control: Studio cannot switch tabs yet.
export function chromeGuidance(snap, sendUnsure) {
  const tab = snap?.binding?.title || (snap?.binding?.url ? shortUrl(snap.binding.url) : '');
  const where = tab ? ' It’s the tab “' + tab + '”. Studio can’t switch to it for you yet.' : '';
  return (sendUnsure ? 'Open the tab in Chrome to see whether it was sent.' : 'Switch to the Chrome tab for this conversation and look at the chat.') + where;
}
export function readinessChip(snap) {
  if (!snap || snap.state === 'closed' || turnInFlight(snap)) return null;
  const r = snap.readiness, d = draftInfo(snap);
  if (!r || r.reason === 'NOT_CHECKED' && r.ready !== true) return ['Chat box not checked', 't-mute'];
  if (d.present) return ['Draft in chat box', 't-warn'];
  if (r.ready === true) return [d.present === false && d.chars === 0 ? 'Chat box empty' : 'Chat box ready', 't-info'];
  return ['Not ready to send', 't-warn'];
}
export function readinessText(snap) {
  const r = snap?.readiness;
  if (!r) return 'Not reported';
  if (r.ready === true) return 'Ready' + (draftInfo(snap).chars === 0 ? ': chat box is empty' : '');
  if (r.reason === 'NOT_CHECKED') return 'Not checked';
  const d = draftInfo(snap);
  return 'Not ready' + (d.present ? ': draft in chat box' + (d.chars != null ? ' (' + d.chars + ' characters)' : '') : r.reason ? ': ' + reasonText(r.reason) : '');
}
// The panel that explains why sending is off and offers the read-only "Check again". It also covers a
// turn that was blocked before typing, with or without a turn at all.
export function readinessPanel(snap) {
  const off = { show: false, draft: false, chars: null, heading: '', lines: [] };
  if (!snap || ['closed', 'finalizing', 'attaching', 'disconnected', 'busy', 'needs-reconciliation'].includes(snap.state)) return off;
  if (turnInFlight(snap)) return off;
  if (snap.state === 'ready' && snap.readiness?.ready === true) return off;
  const d = draftInfo(snap), lines = [], add = (t) => { if (t && !lines.includes(t)) lines.push(t); };
  const r = snap.readiness;
  if (!r) add('Studio hasn’t reported whether the chat box is ready.');
  else if (!d.present) add(r.reason ? reasonText(r.reason) : 'Studio couldn’t confirm that the chat box is ready.');
  if (isBlockedTurn(snap)) add(reasonText(snap.turn.reason));
  add(uncertaintyText(snap.diagnostic?.uncertainty));
  if (snap.identity?.state === 'unverified') add(identityReasonText(snap.identity));
  return { show: true, draft: d.present, chars: d.chars, heading: d.present ? 'Resolve draft in Chrome' : 'Studio can’t send yet', lines };
}
export function isActive(snap) {
  if (!snap) return false;
  if (['attaching', 'busy', 'finalizing'].includes(snap.state)) return true;
  if (snap.turn && ['preparing', 'dispatching'].includes(snap.turn.phase)) return true;
  if (snap.turn?.send?.state === 'submitting') return true;
  if (messageStarted(snap) && ['waiting', 'streaming'].includes(snap.reply?.state)) return true;
  return snap.capture?.state === 'finalizing';
}
export function canSend(snap, { prompt = '', busy = false } = {}) {
  if (!snap) return { ok: false, reason: 'Connect to a website first.' };
  if (busy) return { ok: false, reason: 'Working…' };
  if (snap.state === 'closed') return { ok: false, reason: 'This conversation is closed. Start a new one to send another message.' };
  if (snap.state === 'finalizing') return { ok: false, reason: 'Finishing the capture…' };
  // One turn at a time. Another message is allowed only after every started turn is complete (send observed, reply
  // finalized, readiness proven). A turn rejected before anything was typed never counts. An uncertain turn locks.
  if (turnInFlight(snap)) {
    return { ok: false, reason: isUncertain(snap) || hasUncertainTurn(snap) ? 'Sending is off until this conversation is checked.' : 'Wait for the current reply to finish. Studio sends one turn at a time in this chat.' };
  }
  if (isUncertain(snap) || hasUncertainTurn(snap)) return { ok: false, reason: 'Sending is off until this conversation is checked.' };
  if (snap.identity?.state === 'unverified') return { ok: false, reason: 'Sending is off: Studio can’t tell which chat this tab is showing, and it won’t send into a chat it can’t identify.' };
  if (draftInfo(snap).present) return { ok: false, reason: 'There’s a draft in the chat box. Resolve it in Chrome, then press Check again (read-only).' };
  if (snap.state === 'attaching') return { ok: false, reason: 'Connecting…' };
  if (snap.state === 'busy') return { ok: false, reason: 'Studio is working. Wait a moment.' };
  if (snap.state !== 'ready') return { ok: false, reason: snap.state === 'blocked' ? 'Studio can’t send yet. Use Check again (read-only).' : 'Not ready to send (' + word(snap.state) + ').' };
  if (snap.readiness?.ready !== true) return { ok: false, reason: 'Studio hasn’t confirmed the chat box is ready. Use Check again (read-only).' };
  // Capture starts with the send itself (deferred capture): an idle, ready, unblocked conversation may start a turn.
  // After an earlier turn the previous capture must be finished (idle), never still running or incomplete.
  // Any other capture state (incomplete, finalizing, rejected, unreported...) still blocks.
  const earlierTurn = turnCount(snap) > 0;
  if (earlierTurn ? snap.capture?.state !== 'idle' : !['recording', 'idle'].includes(snap.capture?.state)) {
    return { ok: false, reason: earlierTurn ? 'The previous turn’s recording isn’t finished, so Studio won’t start the next turn.' : 'Studio isn’t ready to record this tab, so it won’t send.' };
  }
  if (!String(prompt).trim()) return { ok: false, reason: 'Write a message to continue.' };
  return { ok: true, reason: '' };
}
// Stale responses never overwrite a newer snapshot of the same conversation.
export function pickSnapshot(current, incoming) {
  if (!incoming || typeof incoming.id !== 'string') return current ?? null;
  if (current && current.id === incoming.id && Number(incoming.revision) < Number(current.revision)) return current;
  if (current && current.id === incoming.id && Number(incoming.revision) === Number(current.revision)
    && typeof current.reply?.text === 'string' && typeof incoming.reply?.text === 'string'
    && current.reply.text.length > incoming.reply.text.length) {
    // An equal-revision refresh must never roll back reply text the live event stream delivered.
    return { ...incoming, reply: { ...incoming.reply, text: current.reply.text,
      chars: Math.max(incoming.reply.chars ?? 0, current.reply.chars ?? 0) } };
  }
  return incoming;
}
export function unwrapConversation(data) {
  const c = data?.conversation ?? data?.resource ?? data;
  return c && typeof c.id === 'string' && c.revision !== undefined ? c : null;
}
// A failed request is "ambiguous" when the server may have acted on it: network loss, 5xx, or a malformed reply.
export function isAmbiguous(err) { return !err || err.status === 0 || err.status === 408 || err.status >= 500 || err.malformed === true; }
// The pending request counts as registered once the service shows a turn that is not the one we already knew.
export const pendingRegistered = (pending, snap) => !!pending && !!snap && pending.convId === snap.id && !!snap.turn && snap.turn.id !== (pending.priorTurnId ?? null);
// A send request whose outcome is unknown: it was posted, nothing came back, and no new turn is visible yet.
export const pendingUnknown = (pending, snap, submitting = false) => !!pending && !!snap && !submitting && pending.convId === snap.id && !pendingRegistered(pending, snap);
// After a read-only check: no turn registered for the unknown request and nothing else blocks sending.
export const checkFoundNoMessage = (pending, snap) => pendingUnknown(pending, snap) && !isUncertain(snap) && !hasUncertainTurn(snap)
  && (!snap.turn || isBlockedTurn(snap) || (snap.turn.id === (pending.priorTurnId ?? null) && !turnInFlight(snap)));
export function ownedByStudio(snap) {
  const b = snap?.binding ?? {};
  return b.ownedByStudio === true || b.freshTab === true || b.owner === 'studio';
}
export const canCloseTab = (snap) => ownedByStudio(snap) && !isUncertain(snap) && !snap?.diagnostic?.uncertainty;
export function pollDelay(snap, { hidden = false, failures = 0 } = {}) {
  if (!snap) return null;
  if (snap.state === 'closed' && snap.capture?.state !== 'finalizing') return null;
  if (failures >= 5) return 5000;
  if (isActive(snap)) return hidden ? 3000 : 1000;
  return 5000;
}
export function replyBlocks(reply) {
  if (!reply) return [];
  const raw = Array.isArray(reply.blocks) && reply.blocks.length ? reply.blocks : null;
  const blocks = raw
    ? raw.map((b, i) => ({
      key: (b.kind ?? 'answer') + '-' + i, kind: b.kind ?? 'answer', label: BLOCK_LABELS[b.kind ?? 'answer'] ?? word(b.kind),
      text: typeof b.text === 'string' ? b.text : null, source: b.source ?? null,
    }))
    : typeof reply.text === 'string' && reply.text !== '' ? [{ key: 'answer-0', kind: 'answer', label: 'Answer', text: reply.text, source: reply.source ?? null }] : [];
  return blocks.sort((a, b) => (a.kind === 'answer' ? 0 : 1) - (b.kind === 'answer' ? 0 : 1));
}
export function shownChars(blocks) { return blocks.filter((b) => b.kind === 'answer').reduce((n, b) => n + (b.text?.length ?? 0), 0); }

// Merge one opt-in reply_text SSE event into the locally held reply. Snapshot semantics: text is
// monotonic — a capped event never shortens locally known text; state/source/completion follow
// the event (server truth). Returns a NEW reply object, or null when nothing changes.
export function mergeReplyText(reply, r) {
  if (!reply || !r || typeof r.text !== 'string') return null;
  const cur = typeof reply.text === 'string' ? reply.text : '';
  const curChars = Number.isFinite(reply.chars) ? reply.chars : cur.length;
  const evChars = Number.isFinite(r.chars) ? r.chars : r.text.length;
  const text = r.truncated && r.text.length < cur.length ? cur : (r.text.length > cur.length ? r.text : cur);
  if (text === cur && r.state === reply.state && r.source === reply.source && r.completion === reply.completion) return null;
  return { ...reply, text, chars: Math.max(curChars, evChars), state: r.state ?? reply.state,
    source: r.source ?? reply.source, completion: r.completion ?? reply.completion };
}

/* ---------------- rich reply text: structure as DOM nodes (pure parser + a DOM builder factory) ---------------- */
// What a site sends is data. The parser only reads structure (headings, lists, tables, code, quotes, links, source
// markers). The builder makes DOM nodes with textContent; it never builds markup from strings. Links are limited to
// http, https and mailto; remote images are shown as links and never fetched; nothing in a reply is run or previewed.
const PRIVATE_USE = /[\uE000-\uF8FF]/g;
export function safeHref(u) {
  try { const x = new URL(String(u ?? '').trim()); return ['http:', 'https:', 'mailto:'].includes(x.protocol) ? x.href : null; } catch { return null; }
}
export function hostOf(u) { try { const x = new URL(u); return x.protocol === 'mailto:' ? x.pathname : x.host; } catch { return ''; } }

const ESCAPABLE = '\\`*_{}[]()#+-.!|~>';
function matchClose(s, open, a, b) {
  let depth = 0;
  for (let k = open; k < s.length && k < open + 600; k++) {
    if (s[k] === '\\') { k++; continue; }
    if (s[k] === a) depth++; else if (s[k] === b && --depth === 0) return k;
  }
  return -1;
}
// Inline structure of one run of text. Unclosed markers stay plain text, so half-streamed text never breaks the page.
export function parseInline(src, depth = 0) {
  const s = String(src ?? ''), out = [];
  let buf = '', i = 0;
  const flush = () => { if (buf) { out.push({ t: 'text', s: buf.replace(PRIVATE_USE, '') }); buf = ''; } };
  while (i < s.length) {
    const ch = s[i];
    if (ch === '\\' && i + 1 < s.length && ESCAPABLE.includes(s[i + 1])) { buf += s[i + 1]; i += 2; continue; }
    if (ch === '\uE200') { // the site's own source marker: cite, then one or more reference ids
      const m = /^\uE200cite((?:\uE202[^\uE200-\uE2FF]*)+)\uE201/.exec(s.slice(i, i + 400));
      if (m) { flush(); out.push({ t: 'cite', refs: m[1].split('\uE202').filter(Boolean) }); i += m[0].length; continue; }
    }
    if (ch === '`') {
      let n = 1; while (s[i + n] === '`') n++;
      const fence = '`'.repeat(n), end = s.indexOf(fence, i + n);
      if (end > i + n) {
        flush(); let code = s.slice(i + n, end);
        if (code.length > 2 && code.startsWith(' ') && code.endsWith(' ') && code.trim()) code = code.slice(1, -1);
        out.push({ t: 'code', s: code }); i = end + n; continue;
      }
      buf += fence; i += n; continue;
    }
    if (depth < 4) {
      const two = s.substr(i, 2);
      if (two === '**' || two === '~~') {
        const end = s.indexOf(two, i + 2);
        if (end > i + 2 && !/\s/.test(s[i + 2]) && !/\s/.test(s[end - 1])) {
          flush(); out.push({ t: two === '**' ? 'strong' : 'del', c: parseInline(s.slice(i + 2, end), depth + 1) }); i = end + 2; continue;
        }
      }
      if ((ch === '*' && s[i + 1] !== '*' || ch === '_') && s[i + 1] && !/\s/.test(s[i + 1]) && (ch === '*' || i === 0 || /[\s([{>"'*]/.test(s[i - 1]))) {
        let end = s.indexOf(ch, i + 1);
        const bad = (e) => /\s/.test(s[e - 1]) || s[e + 1] === ch || s[e - 1] === ch || (ch === '_' && /[A-Za-z0-9]/.test(s[e + 1] ?? ''));
        while (end !== -1 && bad(end)) end = s.indexOf(ch, end + 1);
        if (end > i + 1) { flush(); out.push({ t: 'em', c: parseInline(s.slice(i + 1, end), depth + 1) }); i = end + 1; continue; }
      }
      if (ch === '[' || (ch === '!' && s[i + 1] === '[')) {
        const image = ch === '!', open = image ? i + 1 : i, close = matchClose(s, open, '[', ']');
        if (close > 0) {
          const label = s.slice(open + 1, close);
          if (s[close + 1] === '(') {
            const p = matchClose(s, close + 1, '(', ')');
            if (p > 0) {
              const um = /^<([^>]*)>|^(\S+)/.exec(s.slice(close + 2, p).trim()), url = um ? (um[1] ?? um[2]) : '';
              flush(); out.push({ t: 'link', image, url, href: safeHref(url), c: parseInline(label || url, 4) }); i = p + 1; continue;
            }
          }
          const num = /^\^?(\d{1,3})$/.exec(label);
          if (!image && num) { flush(); out.push({ t: 'cite', n: Number(num[1]), raw: s.slice(i, close + 1) }); i = close + 1; continue; }
        }
      }
      if (ch === 'h' && /^https?:\/\//i.test(s.substr(i, 8)) && (i === 0 || !/[\w/]/.test(s[i - 1]))) {
        let url = /^https?:\/\/[^\s<>\u0000]+/i.exec(s.slice(i))[0];
        const count = (c) => url.split(c).length - 1;
        while (/[.,;:!?'"*\])]$/.test(url) && !(url.endsWith(')') && count('(') >= count(')'))) url = url.slice(0, -1);
        if (url.length > 8) { flush(); out.push({ t: 'link', image: false, url, href: safeHref(url), auto: true, c: [{ t: 'text', s: url }] }); i += url.length; continue; }
      }
    }
    buf += ch; i++;
  }
  flush();
  return out;
}

const FENCE = /^\s*(`{3,}|~{3,})\s*([^\s`]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/;
const QUOTE = /^ {0,3}>[ \t]?(.*)$/;
const LINK_DEF = /^ {0,3}\[\^?([^\]\s][^\]]{0,60})\]:[ \t]*<?(\S+?)>?(?:[ \t]+["'(].*["')])?[ \t]*$/;
const TABLE_DELIM = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
const splitRow = (line) => {
  const t = line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '');
  return t.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
};
const indentOf = (s) => s.replace(/\t/g, '    ').length;
const isTableStart = (lines, k) => k + 1 < lines.length && lines[k].includes('|') && lines[k + 1].includes('|') && TABLE_DELIM.test(lines[k + 1])
  && splitRow(lines[k]).length === splitRow(lines[k + 1]).length;
const startsBlock = (lines, k) => FENCE.test(lines[k]) || HEADING.test(lines[k]) || RULE.test(lines[k]) || QUOTE.test(lines[k]) || LIST_ITEM.test(lines[k]) || isTableStart(lines, k);

export function parseBlocks(text, depth = 0) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n'), out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    let m;
    if ((m = FENCE.exec(line))) {
      const mark = m[1], body = []; let closed = false; i++;
      while (i < lines.length) {
        const t = lines[i].trim();
        if (t.length >= mark.length && t === mark[0].repeat(t.length)) { closed = true; i++; break; }
        body.push(lines[i]); i++;
      }
      out.push({ type: 'code', lang: (m[2] || '').toLowerCase(), text: body.join('\n'), closed, artifact: null });
      continue;
    }
    if ((m = HEADING.exec(line))) { out.push({ type: 'heading', level: m[1].length, text: m[2] }); i++; continue; }
    if (RULE.test(line)) { out.push({ type: 'rule' }); i++; continue; }
    if ((m = LINK_DEF.exec(line))) { out.push({ type: 'linkdef', label: m[1], url: m[2] }); i++; continue; }
    if (QUOTE.test(line)) {
      const inner = [];
      while (i < lines.length && QUOTE.test(lines[i])) { inner.push(QUOTE.exec(lines[i])[1]); i++; }
      out.push({ type: 'quote', children: depth < 3 ? parseBlocks(inner.join('\n'), depth + 1) : [{ type: 'paragraph', text: inner.join('\n') }] });
      continue;
    }
    if (isTableStart(lines, i)) {
      const head = splitRow(line), align = splitRow(lines[i + 1]).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : null));
      const rows = []; i += 2;
      while (i < lines.length && lines[i].trim() && lines[i].includes('|') && !FENCE.test(lines[i])) {
        const cells = splitRow(lines[i]); while (cells.length < head.length) cells.push('');
        rows.push(cells.slice(0, head.length)); i++;
      }
      out.push({ type: 'table', head, align, rows });
      continue;
    }
    if ((m = LIST_ITEM.exec(line))) {
      const items = [], stack = [], base = indentOf(m[1]), topOrdered = /\d/.test(m[2]);
      // At the list's own level a change between bullets and numbers starts a new list; nested items may differ.
      const sameList = (x) => indentOf(x[1]) > base || /\d/.test(x[2]) === topOrdered;
      const depthFor = (ind) => { while (stack.length && stack.at(-1) > ind) stack.pop(); if (!stack.length || stack.at(-1) < ind) stack.push(ind); return Math.min(stack.length - 1, 4); };
      while (i < lines.length) {
        const l = lines[i];
        if (!l.trim()) {
          let k = i; while (k < lines.length && !lines[k].trim()) k++;
          const nm = k < lines.length ? LIST_ITEM.exec(lines[k]) : null;
          if (nm && indentOf(nm[1]) >= base && !RULE.test(lines[k]) && sameList(nm)) { i = k; continue; }
          if (k < lines.length && /^\s{2,}\S/.test(lines[k]) && !FENCE.test(lines[k]) && items.length) { i = k; continue; }
          break;
        }
        const im = LIST_ITEM.exec(l);
        if (im && !RULE.test(l)) {
          const ind = indentOf(im[1]); if (ind < base || !sameList(im)) break;
          let t = im[3], task = null; const tm = /^\[([ xX])\][ \t]+(.*)$/.exec(t); if (tm) { task = tm[1] !== ' '; t = tm[2]; }
          items.push({ depth: depthFor(ind), ordered: /\d/.test(im[2]), start: /\d/.test(im[2]) ? parseInt(im[2], 10) : 1, text: t, task }); i++; continue;
        }
        if (/^\s+\S/.test(l) && items.length && !FENCE.test(l)) { items.at(-1).text += '\n' + l.trim(); i++; continue; }
        break;
      }
      out.push({ type: 'list', items });
      continue;
    }
    const para = [line.trimEnd()]; i++;
    while (i < lines.length && lines[i].trim() && !startsBlock(lines, i)) { para.push(lines[i].trimEnd()); i++; }
    out.push({ type: 'paragraph', text: para.join('\n') });
  }
  return out;
}

// Code that stands alone as a document (a page, a diagram, a long file) is called an artifact: it gets a download.
const FILE_EXT = { html: 'html', svg: 'svg', xml: 'xml', mermaid: 'mmd', markdown: 'md', md: 'md', tex: 'tex', latex: 'tex', csv: 'csv', javascript: 'js', js: 'js', jsx: 'jsx', typescript: 'ts',
  ts: 'ts', tsx: 'tsx', python: 'py', py: 'py', json: 'json', css: 'css', bash: 'sh', sh: 'sh', shell: 'sh', powershell: 'ps1', rust: 'rs', go: 'go', java: 'java', c: 'c', cpp: 'cpp', sql: 'sql', yaml: 'yaml', yml: 'yml' };
const DOCUMENT_LANGS = new Set(['html', 'svg', 'xml', 'mermaid', 'markdown', 'md', 'tex', 'latex', 'csv']);
export function artifactInfo(block) {
  if (block?.type !== 'code' || !block.closed) return null;
  const lines = block.text.split('\n').length;
  if (!((DOCUMENT_LANGS.has(block.lang) && lines >= 3) || lines >= 30)) return null;
  return { ext: FILE_EXT[block.lang] ?? 'txt', lines, chars: block.text.length };
}
export function parseRich(text) {
  const blocks = parseBlocks(text);
  let n = 0;
  for (const b of blocks) { const a = artifactInfo(b); if (a) b.artifact = { ...a, n: ++n }; }
  return { blocks };
}

function eachInline(blocks, fn) {
  for (const b of blocks) {
    if (b.type === 'paragraph' || b.type === 'heading') fn(parseInline(b.text));
    else if (b.type === 'list') b.items.forEach((it) => fn(parseInline(it.text)));
    else if (b.type === 'table') { b.head.forEach((c) => fn(parseInline(c))); b.rows.forEach((r) => r.forEach((c) => fn(parseInline(c)))); }
    else if (b.type === 'quote') eachInline(b.children, fn);
  }
}
function eachBlock(blocks, fn) { for (const b of blocks) { fn(b); if (b.type === 'quote') eachBlock(b.children, fn); } }
function walkLinks(nodes, fn) { for (const n of nodes) { if (n.t === 'link') fn(n); else if (n.c) walkLinks(n.c, fn); } }

// Sources for one reply, in order of trust: what the site reported with the reply, reference lines written in the text,
// then plain links in the text. The origin travels with each source so the page can say where it came from.
export function replySources(reply, blocks = []) {
  const out = [], seen = new Set(), numbers = new Set();
  const add = (url, title, extra) => {
    const href = safeHref(url); if (!href || seen.has(href)) return;
    seen.add(href);
    // Each source has its own number: the one the site/text gave when free, otherwise the lowest unused one.
    let n = Number.isFinite(extra.n) && extra.n > 0 ? extra.n : 1;
    while (numbers.has(n)) n++;
    numbers.add(n);
    out.push({ n, key: extra.key ?? null, title: String(title || '').trim() || hostOf(href) || href, url: href, host: hostOf(href), snippet: extra.snippet ?? '', origin: extra.origin });
  };
  const reported = [];
  for (const k of ['citations', 'sources']) if (Array.isArray(reply?.[k])) reported.push(...reply[k]);
  for (const b of Array.isArray(reply?.blocks) ? reply.blocks : []) {
    if (!/^citations?$/.test(b?.kind ?? '')) continue;
    const items = b.items ?? b.payload?.items ?? b.payload?.citations; if (Array.isArray(items)) reported.push(...items);
  }
  reported.forEach((c) => {
    if (typeof c === 'string') add(c, '', { origin: 'site' });
    else if (c && typeof c === 'object') add(c.url ?? c.href ?? c.link, c.title ?? c.name, { origin: 'site', n: Number(c.n), snippet: typeof c.snippet === 'string' ? c.snippet.slice(0, 240) : '' });
  });
  eachBlock(blocks, (b) => { if (b.type === 'linkdef') add(b.url, '', { origin: 'text', key: b.label.toLowerCase(), n: /^\d+$/.test(b.label) ? Number(b.label) : NaN }); });
  if (!out.length) eachInline(blocks, (nodes) => walkLinks(nodes, (l) => { if (!l.image && l.href && /^https?:/.test(l.href)) add(l.href, l.auto ? '' : inlineText(l.c), { origin: 'links' }); }));
  return out;
}
const inlineText = (nodes) => (nodes ?? []).map((n) => n.s ?? inlineText(n.c)).join('');
export const sourcesSig = (sources) => sources.map((s) => s.n + ':' + s.url).join('|');
export function sourcesNote(sources) {
  if (!sources.length) return '';
  if (sources.every((s) => s.origin === 'site')) return 'Reported by the site with this reply.';
  if (sources.some((s) => s.origin === 'site')) return 'Some were reported by the site; the rest come from the reply text. Studio can’t tell whether the site checked them.';
  if (sources.some((s) => s.origin === 'text')) return 'Taken from reference lines in the reply text. Studio can’t tell whether the site checked them.';
  return 'Links found in the reply text. The site didn’t report a separate source list.';
}
// Artifacts the site itself reported next to the reply. Only text or a safe address is kept; the rest is ignored.
export function replyArtifacts(reply) {
  const raw = Array.isArray(reply?.artifacts) ? reply.artifacts : [];
  return raw.map((a, idx) => {
    if (!a || typeof a !== 'object') return null;
    const text = typeof a.text === 'string' ? a.text : typeof a.content === 'string' ? a.content : null, href = safeHref(a.url ?? a.href);
    if (text == null && !href) return null;
    const lang = String(a.language ?? a.lang ?? a.kind ?? '').toLowerCase().replace(/^.*\//, '');
    return { n: idx + 1, title: String(a.title ?? a.name ?? 'Artifact ' + (idx + 1)).slice(0, 120), lang, text, href, ext: FILE_EXT[lang] ?? 'txt' };
  }).filter(Boolean);
}
export function artifactFileName(n, ext, title = '') {
  const base = String(title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return (base || 'reply-artifact-' + n) + '.' + (ext || 'txt');
}
export function tableToTsv(head, rows) {
  const cell = (c) => String(c).replace(/[\t\r\n]+/g, ' ');
  return [head, ...rows].map((r) => r.map(cell).join('\t')).join('\n');
}

// DOM side. `doc` is the page document (or a stand-in in tests). Copy and download are injected so tests need no clipboard.
export function createRichRenderer(doc, { copy = async () => false, download = () => false, notice = () => {} } = {}) {
  const t = (s) => doc.createTextNode(s);
  const h = (tag, props = {}, kids = []) => {
    const n = doc.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v === false || v == null) continue;
      if (k === 'class') n.className = v; else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : String(v));
    }
    for (const kid of [].concat(kids)) if (kid != null) n.append(typeof kid === 'string' ? t(kid) : kid);
    return n;
  };
  const flash = (btn, base, ok) => {
    btn.textContent = ok ? 'Copied' : 'Couldn’t copy. Select the text instead';
    notice(ok ? 'Copied.' : 'Couldn’t copy. Select the text instead.');
    const timer = setTimeout(() => { btn.textContent = base; }, 1800); timer?.unref?.();
  };
  const copyButton = (label, getText, aria) => {
    const btn = h('button', { type: 'button', class: 'mini', text: label, 'aria-label': aria });
    btn.addEventListener('click', async () => { let ok = false; try { ok = (await copy(getText())) === true; } catch { ok = false; } flash(btn, label, ok); });
    return btn;
  };
  const sup = (n, title, link) => h('sup', { class: 'cite', title }, link ? [h('a', { href: link, target: '_blank', rel: 'noopener noreferrer' }, ['[' + n + ']', h('span', { class: 'sr', text: ' (opens in a new tab)' })])] : ['[' + n + ']']);

  function inline(nodes, ctx) {
    return nodes.map((n) => {
      if (n.t === 'text') return t(n.s);
      if (n.t === 'code') return h('code', { class: 'ic', text: n.s });
      if (n.t === 'strong' || n.t === 'em' || n.t === 'del') return h(n.t, {}, inline(n.c, ctx));
      if (n.t === 'link') {
        const label = inline(n.c, ctx);
        if (!n.href) return h('span', { class: 'deadlink', title: 'This address type isn’t allowed, so Studio shows it as text.' }, label);
        return h('a', { href: n.href, target: '_blank', rel: 'noopener noreferrer nofollow', title: hostOf(n.href) || null },
          [...(n.image ? [t('Image: ')] : []), ...label, h('span', { class: 'sr', text: ' (opens in a new tab)' })]);
      }
      if (n.t === 'cite') {
        if (n.refs) {
          const nums = n.refs.map((r) => { if (!ctx.refs.has(r)) ctx.refs.set(r, ctx.refs.size + 1); return ctx.refs.get(r); });
          return h('span', {}, nums.map((num, k) => sup(num, 'Source marker from the site (' + n.refs[k] + '). Its details weren’t captured.', null)));
        }
        const src = ctx.sources.find((s) => s.n === n.n);
        return src ? sup(n.n, src.title + (src.host ? ' · ' + src.host : ''), src.url) : t(n.raw ?? '[' + n.n + ']');
      }
      return t('');
    });
  }
  const align = (a) => (a === 'right' ? 'al-r' : a === 'center' ? 'al-c' : null);

  function codeBlock(blk, ctx) {
    const art = blk.artifact;
    const textNode = t(blk.text), code = h('code', {}, [textNode]), pre = h('pre', { tabindex: 0, 'aria-label': (art ? 'Artifact ' + art.n + ' ' : 'Code ') + (blk.lang || 'text') }, [code]);
    const meta = h('span', { class: 'codeblk-meta' });
    let cur = blk, now = ctx;
    const describe = () => {
      const lines = cur.text ? cur.text.split('\n').length : 0;
      meta.textContent = lines + (lines === 1 ? ' line' : ' lines') + (cur.closed ? '' : now.streaming ? ' so far' : ' · block not closed in the reply');
    };
    describe();
    const buttons = [copyButton('Copy', () => cur.text, (art ? 'Copy artifact ' + art.n : 'Copy code') + (cur.lang ? ' (' + cur.lang + ')' : ''))];
    if (art) {
      const dl = h('button', { type: 'button', class: 'mini', text: 'Download', 'aria-label': 'Download artifact ' + art.n });
      dl.addEventListener('click', () => { const ok = download(cur.text, artifactFileName(art.n, art.ext)); notice(ok ? 'Download started.' : 'Couldn’t start the download. Copy the text instead.'); });
      buttons.push(dl);
    }
    const head = h('div', { class: 'codeblk-head' }, [h('span', { class: 'codeblk-lang', text: (art ? 'Artifact ' + art.n + ' · ' : '') + (blk.lang || 'text') }), meta, h('span', { class: 'codeblk-actions' }, buttons)]);
    const root = h('figure', { class: 'codeblk' + (art ? ' artifact' : ''), role: 'group' }, [head, pre]);
    if (art) root.append(h('p', { class: 'note codeblk-note', text: 'Shown as text only. Studio never runs or previews it.' }));
    return { node: root, type: 'code', lang: blk.lang, artifact: !!art, update(next, nextCtx) { cur = next; now = nextCtx; describe(); if (textNode.data !== next.text) { if (next.text.startsWith(textNode.data)) textNode.appendData(next.text.slice(textNode.data.length)); else textNode.data = next.text; } } };
  }
  function tableBlock(blk, ctx) {
    const cells = (tag, row) => row.map((c, i) => h(tag, { class: align(blk.align[i]), scope: tag === 'th' ? 'col' : null }, inline(parseInline(c), ctx)));
    const table = h('table', {}, [h('thead', {}, [h('tr', {}, cells('th', blk.head))]), h('tbody', {}, blk.rows.map((r) => h('tr', {}, cells('td', r))))]);
    const label = 'Table, ' + blk.rows.length + (blk.rows.length === 1 ? ' row, ' : ' rows, ') + blk.head.length + (blk.head.length === 1 ? ' column' : ' columns') + '. Scroll sideways if it is wide.';
    const wrap = h('div', { class: 'tablewrap', role: 'region', tabindex: 0, 'aria-label': label }, [table]);
    return { node: h('div', { class: 'tablebox' }, [wrap, h('div', { class: 'tablebar' }, [copyButton('Copy table', () => tableToTsv(blk.head, blk.rows), 'Copy table as tab-separated text')])]), type: 'table' };
  }
  function listBlock(blk, ctx) {
    const root = h(blk.items[0]?.ordered ? 'ol' : 'ul', { start: blk.items[0]?.ordered && blk.items[0].start !== 1 ? blk.items[0].start : null });
    const levels = [{ list: root, li: null }];
    for (const it of blk.items) {
      while (levels.length - 1 > it.depth) levels.pop();
      while (levels.length - 1 < it.depth) {
        const top = levels.at(-1);
        if (!top.li) { top.li = h('li'); top.list.append(top.li); } // a nested item whose parent line is missing
        const sub = h(it.ordered ? 'ol' : 'ul'); top.li.append(sub);
        levels.push({ list: sub, li: null });
      }
      const body = inline(parseInline(it.text), ctx);
      const li = h('li', { class: it.task == null ? null : 'task' }, [...(it.task == null ? [] : [h('span', { class: 'taskbox', text: it.task ? '☑ ' : '☐ ', 'aria-label': it.task ? 'Done: ' : 'Not done: ' })]), ...body]);
      levels.at(-1).list.append(li); levels.at(-1).li = li;
    }
    return { node: root, type: 'list' };
  }
  function build(blk, ctx) {
    if (blk.type === 'code') return codeBlock(blk, ctx);
    if (blk.type === 'table') return tableBlock(blk, ctx);
    if (blk.type === 'list') return listBlock(blk, ctx);
    if (blk.type === 'heading') return { node: h('h' + Math.min(6, blk.level + 3), { class: 'rh rh' + blk.level }, inline(parseInline(blk.text), ctx)), type: 'heading' };
    if (blk.type === 'rule') return { node: h('hr'), type: 'rule' };
    if (blk.type === 'quote') return { node: h('blockquote', {}, blk.children.map((c) => build(c, ctx).node)), type: 'quote' };
    if (blk.type === 'linkdef') return { node: null, type: 'linkdef' };
    return { node: h('p', {}, inline(parseInline(blk.text), ctx)), type: 'paragraph' };
  }
  // Incremental sync for a streaming reply: a block whose content did not change keeps its DOM node (so a text selection
  // survives each update) and an open code block grows in place.
  function sync(root, state, parsed, ctx) {
    state.refs ??= new Map(); state.items ??= [];
    const full = { sources: ctx.sources ?? [], streaming: !!ctx.streaming, refs: state.refs };
    const base = sourcesSig(full.sources);
    parsed.forEach((blk, i) => {
      const sig = base + (blk.type === 'code' ? (full.streaming ? '~' : '=') : '') + JSON.stringify(blk), cur = state.items[i];
      if (cur && cur.sig === sig) return;
      if (cur && cur.update && blk.type === 'code' && cur.type === 'code' && cur.lang === blk.lang && cur.artifact === !!blk.artifact) { cur.update(blk, full); cur.sig = sig; return; }
      state.items[i] = { ...build(blk, full), sig };
    });
    state.items.length = parsed.length;
    const want = state.items.map((x) => x.node).filter(Boolean), have = Array.from(root.children);
    if (want.length !== have.length || want.some((n, k) => n !== have[k])) root.replaceChildren(...want);
  }
  function sourceRow(src) {
    return h('li', { class: 'source' }, [
      h('span', { class: 'source-n', text: '[' + src.n + ']' }), ' ',
      h('a', { href: src.url, target: '_blank', rel: 'noopener noreferrer nofollow' }, [src.title, h('span', { class: 'sr', text: ' (opens in a new tab)' })]),
      src.host && src.host !== src.title ? h('span', { class: 'source-host', text: ' · ' + src.host }) : null,
      src.snippet ? h('p', { class: 'note', text: src.snippet }) : null,
    ]);
  }
  function artifactCard(a) {
    const kids = [h('div', { class: 'codeblk-head' }, [h('span', { class: 'codeblk-lang', text: 'Artifact · ' + a.title + (a.lang ? ' · ' + a.lang : '') }),
      h('span', { class: 'codeblk-actions' }, [
        ...(a.text != null ? [copyButton('Copy', () => a.text, 'Copy artifact ' + a.title)] : []),
        ...(a.text != null ? [(() => { const b = h('button', { type: 'button', class: 'mini', text: 'Download', 'aria-label': 'Download artifact ' + a.title }); b.addEventListener('click', () => { const ok = download(a.text, artifactFileName(a.n, a.ext, a.title)); notice(ok ? 'Download started.' : 'Couldn’t start the download. Copy the text instead.'); }); return b; })()] : []),
        ...(a.href ? [h('a', { class: 'hit', href: a.href, target: '_blank', rel: 'noopener noreferrer nofollow' }, ['Open', h('span', { class: 'sr', text: ' ' + a.title + ' (new tab)' })])] : []),
      ])])];
    if (a.text != null) kids.push(h('pre', { tabindex: 0, 'aria-label': 'Artifact ' + a.title }, [h('code', { text: a.text })]));
    return h('figure', { class: 'codeblk artifact', role: 'group' }, kids);
  }
  // One-shot build for static content such as the reply to an earlier turn.
  function renderStatic(root, text, ctx = {}) { const state = {}; sync(root, state, parseRich(text).blocks, ctx); return state; }
  return { sync, build, inline, renderStatic, sourceRow, artifactCard };
}

// Reply chips. Unknown network completion is a visible warning chip, never a quiet footnote.
const SOURCE_TONES = { network: 't-info', page: 't-mute', differ: 't-warn', candidate: 't-warn' };
export const sourceChip = (source) => [sourceLabel(source), SOURCE_TONES[source] ?? 't-warn'];
export const completionKnown = (c) => !(c == null || c === '' || c === 'unknown');
export const completionChip = (c) => (completionKnown(c) ? ['Network completion: ' + word(c), 't-info'] : ['Network completion: unknown', 't-warn']);
export const PARTIAL_TEXT = 'Text may be partial. Finish capture to keep what was recorded.';
export const replyMayBePartial = (reply) => ['interrupted', 'unknown'].includes(reply?.state);
export function ago(ms) { const s = Math.max(0, Math.floor(ms / 1000)); return s < 2 ? 'just now' : s < 60 ? s + 's ago' : Math.floor(s / 60) + ' min ago'; }
export function replyCountText(chars, ageMs = null) {
  const n = Number.isFinite(chars) ? chars : 0;
  return n + (n === 1 ? ' char' : ' chars') + (ageMs == null ? '' : ', updated ' + ago(ageMs));
}
// One sentence for the polite live region when the reply becomes ready. Never announces streaming text.
export function replyReadyText(snap) {
  const r = snap?.reply;
  return r?.state === 'ready' && messageStarted(snap) ? 'Reply ready. ' + sourceLabel(r.source) + '. ' + completionChip(r.completion)[0] : '';
}

// One-line "where am I" headline.
export function stageInfo(snap, { pending = false, submitting = false } = {}) {
  const total = 5, at = (n, label) => ({ n, total, label, text: 'Step ' + n + ' of ' + total + ': ' + label });
  if (!snap) return at(1, 'Connect to a site');
  if (snap.state === 'closed' || ['accepted', 'rejected', 'incomplete'].includes(snap.capture?.state)) return at(5, 'Capture finished');
  if (snap.state === 'finalizing' || snap.capture?.state === 'finalizing') return at(5, 'Finishing capture');
  if (['attaching', 'disconnected'].includes(snap.state)) return at(1, snap.state === 'attaching' ? 'Connecting' : 'Disconnected');
  if (submitting || isPreparing(snap) || snap.turn?.send?.state === 'submitting') return at(3, 'Sending your message');
  if (pending || snap.turn?.send?.state === 'uncertain') return at(3, 'Send not confirmed');
  if (messageStarted(snap)) {
    const r = snap.reply?.state;
    if (r === 'ready' && turnSettled(snap.turn) && canSend(snap, { prompt: 'x' }).ok) return at(3, 'Turn ' + turnCount(snap) + ' complete. Write your next message');
    if (r === 'ready') return at(5, snap.capture?.state === 'recording' ? 'Reply ready. Still recording' : 'Reply ready');
    return at(4, { waiting: 'Waiting for the reply', streaming: 'Reply streaming', interrupted: 'Reply interrupted' }[r] ?? 'Reply state unknown');
  }
  if (snap.state === 'needs-reconciliation') return at(2, 'Needs checking');
  return canSend(snap, { prompt: 'x' }).ok ? at(3, 'Write your message') : at(2, 'Chat box not ready');
}

// Finish button: one click. While the reply is still coming the label says what you give up.
export function finishControl(snap, { working = false } = {}) {
  if (!snap) return { label: 'Finish capture', early: false, disabled: true };
  const closed = snap.state === 'closed', fin = snap.state === 'finalizing' || snap.capture?.state === 'finalizing';
  const early = !closed && !fin && messageStarted(snap) && ['waiting', 'streaming'].includes(snap.reply?.state);
  return {
    label: fin ? 'Finishing…' : early ? 'Finish anyway (capture will be incomplete)' : 'Finish capture', early,
    disabled: working || fin || closed || ['disconnected', 'attaching'].includes(snap.state),
  };
}
export const evidenceOf = (snap) => snap?.evidence ?? snap?.turn?.evidence ?? snap?.capture?.evidence ?? null;
// Outcome chip and the reasons taken from failed or unknown evidence checks. Null until the capture has finished.
export function finishOutcome(snap) {
  if (!snap) return null;
  const cs = snap.capture?.state;
  if (!(snap.state === 'closed' || ['accepted', 'rejected', 'incomplete'].includes(cs))) return null;
  const gates = Array.isArray(evidenceOf(snap)?.gates) ? evidenceOf(snap).gates : [];
  const reasons = gates.filter((g) => ['failed', 'unknown'].includes(gateValue(g))).map((g) => {
    const note = typeof g?.reason === 'string' && g.reason ? ' (' + reasonText(g.reason).replace(/\.$/, '') + ')' : '';
    return gateLabel(g) + ': ' + gateChip(gateValue(g))[0].toLowerCase() + note;
  });
  if (cs !== 'accepted' && !reasons.length) reasons.push('Studio didn’t report which check caused this. See Details.');
  return { chip: captureChip(cs), reasons, accepted: cs === 'accepted' };
}
export function limitStatus(capture, now = Date.now()) {
  const lines = []; let warn = false;
  if (!capture) return { lines, warn, stopped: null };
  const max = Number(capture.maxBytes), used = Number(capture.bytesWritten);
  if (Number.isFinite(max) && max > 0 && Number.isFinite(used)) {
    lines.push('Recorded ' + mib(used) + ' of ' + mib(max) + '.');
    if (used / max >= 0.8) warn = true;
  }
  const ends = typeof capture.endsAt === 'number' ? capture.endsAt : Date.parse(capture.endsAt ?? '');
  if (Number.isFinite(ends)) {
    const left = Math.max(0, Math.round((ends - now) / 60000));
    lines.push('Time left in the recording budget: about ' + left + ' min.');
    if (ends - now <= 3 * 60000) warn = true;
  }
  return { lines, warn, stopped: capture.limitReason ? word(capture.limitReason) : null };
}
function mib(n) { return (n / 1048576).toFixed(n >= 10485760 ? 0 : 1) + ' MiB'; }
export function shortUrl(u) { try { const x = new URL(u); return x.host + x.pathname + (x.search ? '?…' : ''); } catch { return String(u ?? ''); } }
export function newKey() {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  const b = new Uint8Array(16); c?.getRandomValues?.(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('') || String(Date.now()) + Math.random().toString(16).slice(2);
}
export function limitationText(l) { return typeof l === 'string' ? l : l?.message ?? l?.text ?? l?.reason ?? JSON.stringify(l); }
export function targetHint(t) {
  if (t?.recorderOwner) return t.recorderOwner.kind === 'conversation' ? 'Already used by a Studio conversation — can’t use' : 'Already being recorded — can’t use';
  if (!t?.site) return 'Studio doesn’t support this site yet';
  if (t.visibility === 'hidden') return 'In the background — bring it to the front before sending';
  return t.ownedByStudio ? 'Opened by Studio' : '';
}

/* ---------------- chat thread identity and the zero-send page read (pure) ---------------- */
// The service tells us which chat a tab is on from its address only (never from a title). The UI shows that
// answer as given: identified, not identified for this site, or not verified. It never picks a chat for the user.
const IDENTITY_CHIPS = {
  bound: ['Thread identified', 't-info'], unbound: ['No thread identity', 't-mute'], unverified: ['Thread not verified', 't-warn'],
};
const IDENTITY_REASONS = {
  UNSUPPORTED_PATH: 'This tab isn’t on a saved chat that Studio can identify, so it can’t tell which chat it is.',
  LEGACY_SNAPSHOT: 'This conversation was saved before Studio checked chat identity, so it can’t tell which chat it was.',
  SITE_UNSUPPORTED: 'Studio doesn’t identify individual chats on this site yet.',
  NEW_CHAT: 'A new chat has no thread yet. Studio doesn’t tie it to an earlier chat.',
  NOT_CONNECTED: 'Studio hasn’t recorded which chat this is.',
  NOT_PROVIDED: 'Studio hasn’t recorded which chat this is.',
};
export const READ_MAX = Object.freeze({ maxMessages: 200, maxChars: 200000 });

// Local thread reference such as "chatgpt-c:<uuid>". Accepts a binding or target (object form) or a transcript binding (string form).
export function threadRef(x) {
  const t = x?.thread;
  if (typeof t === 'string') return t || null;
  return typeof t?.ref === 'string' && t.ref ? t.ref : null;
}
export const identityState = (identity) => (identity && typeof identity === 'object' && typeof identity.state === 'string' ? identity.state : null);
export const identityChip = (identity) => pair(IDENTITY_CHIPS, identityState(identity), 'Thread');
export function identityReasonText(identity) {
  const reason = identity?.reason;
  if (!reason) return identityState(identity) === 'unverified' ? 'Studio couldn’t confirm which chat this is.' : '';
  return IDENTITY_REASONS[reason] ?? (isCode(reason) ? 'Studio reported: ' + word(reason).toLowerCase() + '.' : String(reason));
}
// What the current identity means for this conversation, in words. Nothing here is a control.
export function identityView(snap) {
  const identity = snap?.identity, state = identityState(identity);
  if (!snap || !state) return { show: false, state: null, chip: null, ref: null, lines: [] };
  const ref = threadRef(snap.binding), lines = [identityReasonText(identity)];
  if (state === 'bound') lines.push('Studio checks that the tab is still on this exact chat before each read and send.');
  else if (state === 'unverified') lines.push('Reading and sending are off. Studio won’t switch to another chat for you. Finish this capture, open the chat you want in Chrome, then connect to it again.');
  else lines.push('Reads and sends are not tied to one particular chat.');
  return { show: true, state, chip: identityChip(identity), ref, lines: lines.filter(Boolean) };
}
export const isRecovered = (snap) => snap?.recovery?.pending === true || snap?.diagnostic?.uncertainty === 'runtime-restarted'
  || (Array.isArray(snap?.limitations) && snap.limitations.some((l) => /^Recovered snapshot/.test(limitationText(l))));

// Tab list row and the note under it. A tab that Studio can't identify is still listed, with the reason.
export function targetThread(t) {
  const ref = threadRef(t), state = identityState(t?.identity);
  if (!state) return { state: null, ref, line: '', note: '' };
  const line = state === 'bound' ? (ref ? 'Chat thread ' + ref : 'Chat thread identified')
    : state === 'unverified' ? 'Chat thread not verified' : 'Chat thread not identified on this site';
  const why = identityReasonText(t.identity);
  const note = state === 'bound' ? 'Studio will connect only if this tab is still on this exact chat. If it has moved to another chat, nothing is connected.'
    : state === 'unverified' ? why + ' Studio can connect and record this tab, but reading and sending stay off, and it won’t switch to a different chat for you.'
      : why;
  return { state, ref, line, note };
}

export function canRead(snap, { reading = false, submitting = false, working = false } = {}) {
  if (!snap) return { ok: false, reason: 'Connect to a website first.' };
  if (snap.state === 'closed') return { ok: false, reason: 'This conversation is finished, so Studio no longer has its tab to read.' };
  if (snap.state === 'finalizing') return { ok: false, reason: 'Finishing the capture…' };
  if (['attaching', 'disconnected'].includes(snap.state)) return { ok: false, reason: 'Studio isn’t connected to the tab right now.' };
  if (isRecovered(snap)) return { ok: false, reason: 'This conversation was recovered after a restart, so there is no live page to read.' };
  if (snap.identity?.state === 'unverified') return { ok: false, reason: 'Reading is off: Studio can’t tell which chat this tab is showing, and it won’t read a chat it can’t identify.' };
  if (reading) return { ok: false, reason: 'Reading…' };
  if (submitting || working) return { ok: false, reason: 'Studio is busy with another step. Wait a moment.' };
  return { ok: true, reason: '' };
}

const count = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);
const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);
export const roleLabel = (role) => (role === 'user' ? 'You' : role === 'assistant' ? 'Assistant' : word(role) || 'Unknown role');
export function sourceText(source) {
  return source === 'page-visible-dom' ? 'Source: text visible on the page right now (not the network recording)' : 'Source: ' + (source ? word(source) : 'unknown');
}
export function readAtText(iso, fmt = (d) => d.toISOString().slice(11, 19) + ' UTC') {
  const d = new Date(typeof iso === 'string' ? iso : NaN);
  return Number.isNaN(d.getTime()) ? 'Read time not reported' : 'Read at ' + fmt(d);
}
export function draftReadText(draft) {
  if (draft?.present === true) return 'The chat box has text' + (count(draft.chars) != null ? ' (' + draft.chars + ' characters)' : '') + '. Studio left it untouched and doesn’t show it here.';
  if (draft?.present === false) return 'The chat box looked empty. Studio left it untouched.';
  return 'Studio couldn’t tell whether the chat box has text. It left the box untouched.';
}
export function limitsText(l) {
  const m = count(l?.maxMessages), c = count(l?.maxChars);
  return m != null && c != null ? 'Limits used: up to ' + m + ' messages and ' + c + ' characters in total.' : '';
}
// Plain sentences about what a read did and did not cover. A read is never described as the whole chat.
export function coverageLines(cov) {
  if (!cov || typeof cov !== 'object') return ['Studio didn’t report how much of the chat this covers. Treat it as partial.'];
  const lines = [];
  if (cov.complete === true) lines.push('Studio reports this read as complete.'); else lines.push('This is not a complete copy of the chat.');
  const rendered = count(cov.renderedMessages), returned = count(cov.returnedMessages), omitted = count(cov.omittedMessages), omittedChars = count(cov.omittedChars);
  if (rendered != null && returned != null) lines.push('Showing ' + returned + ' of ' + plural(rendered, 'message', 'messages') + ' the page is displaying now.');
  if (omitted) lines.push(plural(omitted, 'message was', 'messages were') + ' left out (size limits or items Studio couldn’t read)' + (omittedChars ? ', about ' + omittedChars + ' characters' : '') + '.');
  const cut = count(cov.truncatedMessages);
  if (cut) lines.push(plural(cut, 'message was', 'messages were') + ' cut short. The end of their text is missing.');
  const skipped = [['hiddenSkipped', 'hidden'], ['nestedDropped', 'nested duplicate'], ['ambiguousSkipped', 'of unclear author'], ['invalidMessages', 'unreadable']]
    .map(([k, label]) => [count(cov[k]), label]).filter(([n]) => n).map(([n, label]) => n + ' ' + label);
  if (skipped.length) lines.push('Skipped on the page: ' + skipped.join(', ') + '.');
  const older = cov.olderHistory, newer = cov.newerHistory;
  lines.push(older === 'older-unrendered-likely' ? 'Older messages are probably above what the page has loaded. They aren’t included.'
    : older === 'top-reached' ? 'The page is at the top of the messages it has loaded. Older history may still not be loaded.'
      : older === 'unknown' || older == null ? 'Studio can’t tell whether older messages exist above what the page has loaded.' : 'Older history: ' + word(older) + '.');
  lines.push(newer === 'newer-unrendered-likely' ? 'Newer messages may be below what the page has loaded. They aren’t included.'
    : newer === 'bottom-reached' ? 'The page is at the bottom of the messages it has loaded.'
      : newer === 'unknown' || newer == null ? 'Studio can’t tell whether newer messages exist below what the page has loaded.' : 'Newer history: ' + word(newer) + '.');
  if (cov.preAttachHistory === 'not-captured-by-this-read') lines.push('Messages still rendered on the page can predate this connection. Earlier network traffic was not captured, and history the page hasn’t loaded is not included.');
  return lines;
}
// Turns the service's transcript into plain, ordered rows. Returns { ok: false, text } when it can't be trusted for this conversation.
export function readView(t, snap = null) {
  if (!t || typeof t !== 'object' || !Array.isArray(t.messages)) return { ok: false, text: 'The Studio sent a page read we couldn’t understand. Nothing was shown.' };
  if (snap && t.conversationId !== snap.id) return { ok: false, text: 'The page read belongs to a different conversation, so Studio did not show it.' };
  if (snap && (threadRef(t.binding) ?? null) !== (threadRef(snap.binding) ?? null)) return { ok: false, text: 'The page read came from a different chat than the one you connected, so Studio did not show it.' };
  let unreadable = 0;
  const rows = [];
  t.messages.forEach((m, i) => {
    if (!m || typeof m.text !== 'string' || typeof m.role !== 'string') { unreadable++; return; }
    const n = count(m.index);
    rows.push({ key: 'm' + (n ?? 'x' + i) + '-' + i, order: n ?? i, n: n == null ? null : n + 1, role: m.role, label: roleLabel(m.role), text: m.text,
      chars: count(m.chars), cut: m.truncated === true || (count(m.chars) != null && m.chars > m.text.length) });
  });
  const messages = rows.sort((a, b) => a.order - b.order);
  const cov = t.coverage, rendered = count(cov?.renderedMessages);
  const headline = !messages.length ? 'Studio found no messages on the page.'
    : 'Read ' + plural(messages.length, 'message', 'messages') + (rendered != null && rendered >= messages.length ? ' of ' + rendered + ' the page is showing now' : '') + ', oldest first.';
  const lim = t.limits && typeof t.limits === 'object' ? t.limits : null;
  const more = (count(cov?.omittedMessages) ?? 0) > 0 && !!lim && (lim.maxMessages < READ_MAX.maxMessages || lim.maxChars < READ_MAX.maxChars);
  const lines = coverageLines(cov);
  if (unreadable) lines.push(plural(unreadable, 'item', 'items') + ' in the reply couldn’t be read and were not shown.');
  const lim2 = limitsText(lim); if (lim2) lines.push(lim2);
  return {
    ok: true, messages, headline, lines, more, empty: !messages.length, revision: count(t.revision), readAt: t.readAt ?? null,
    chips: [[sourceText(t.source), 't-mute'], ...(cov?.complete === true ? [] : [['Not a complete copy', 't-warn']])],
    draft: draftReadText(t.draft),
    announce: messages.length ? 'Read ' + plural(messages.length, 'message', 'messages') + ' from the page. This is not a complete copy of the chat.' : 'Read finished. No messages found on the page.',
  };
}
// A failed read. Reading never types, sends, clears or navigates, and the text says so.
export function readFailure(err) {
  const code = err?.data?.code ?? (isCode(err?.message) ? err.message : null);
  const text = 'Couldn’t read the page: ' + explainError({ status: err?.status, code, message: err?.message }) + ' Nothing was sent, typed or changed.';
  return { text, code, link: errorLink(code) };
}

/* ---------------- browser app ---------------- */
function boot() {
  // Set once the U1 panel is mounted (bottom of boot); render() stays safe before that.
  let universalRender = () => {};

  // `$` is for required controls: a missing one throws here, and the unit test fails first (every id looked up with `$` must exist in chat.html).
  const $ = (sel) => document.querySelector(sel);
  // `opt*` is for purely informational notes only: a missing one is skipped and logged once, never thrown.
  const warnedMissing = new Set();
  const opt = (sel) => {
    const n = document.querySelector(sel);
    if (!n && !warnedMissing.has(sel)) { warnedMissing.add(sel); console.warn('Chat page: optional element ' + sel + ' is missing.'); }
    return n;
  };
  const optText = (sel, text) => { const n = opt(sel); if (n && n.textContent !== text) n.textContent = text; };
  const optHidden = (sel, hidden) => { const n = opt(sel); if (n) n.hidden = hidden; };
  const el = (tag, props = {}, kids = []) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v === false || v == null) continue;
      if (k === 'class') node.className = v; else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : String(v));
    }
    for (const kid of [].concat(kids)) if (kid != null) node.append(kid);
    return node;
  };
  const chip = ([label, tone]) => el('span', { class: 'pill ' + tone }, [tone === 't-rec' || tone === 't-live' ? el('span', { class: 'dot', 'aria-hidden': 'true' }) : null, label]);
  // Polling re-renders often. Anything the reader may be selecting is updated in place, never rebuilt.
  const setText = (node, text) => { if (node.textContent !== text) node.textContent = text; };
  const syncChips = (node, list) => {
    const sig = list.map(([l, t]) => t + ':' + l).join('|');
    if (node.dataset.sig === sig) return;
    node.dataset.sig = sig; node.replaceChildren(...list.map(chip));
  };
  const syncList = (node, lines) => {
    const sig = lines.join('\n');
    if (node.dataset.sig === sig) return;
    node.dataset.sig = sig; node.replaceChildren(...lines.map((l) => el('li', { text: l })));
  };
  const newTabLink = (href, label) => el('a', { class: 'hit', href, target: '_blank', rel: 'noopener' }, [label, el('span', { class: 'sr', text: ' (new tab)' })]);
  const textBlocks = new Map(); // reply block key -> { root, textNode }
  const store = {
    get(area, k) { try { return globalThis[area].getItem(k); } catch { return null; } },
    set(area, k, v) { try { globalThis[area].setItem(k, v); } catch { /* storage unavailable */ } },
    del(area, k) { try { globalThis[area].removeItem(k); } catch { /* storage unavailable */ } },
  };

  async function copyText(text) {
    const clip = globalThis.navigator?.clipboard;
    try { if (!clip?.writeText) return false; await clip.writeText(String(text)); return true; } catch { return false; }
  }
  // Saves text the user asked for as a local file. Nothing is uploaded and the text is never run.
  function downloadText(text, name) {
    try {
      const url = URL.createObjectURL(new Blob([String(text)], { type: 'text/plain;charset=utf-8' }));
      const a = document.createElement('a'); a.href = url; a.download = name; a.rel = 'noopener';
      document.body.append(a); a.click(); a.remove();
      const timer = setTimeout(() => URL.revokeObjectURL(url), 4000); timer?.unref?.();
      return true;
    } catch { return false; }
  }
  const rich = createRichRenderer(document, { copy: copyText, download: downloadText, notice: (m) => { $('#announce').textContent = m; } });

  const S = {
    targets: { sites: [], targets: [] }, targetsState: 'loading', targetsError: '', list: [], listState: 'loading', listAll: false,
    // Reply view: formatted (default) or the exact plain text. The choice is remembered in this browser only.
    rawView: store.get('localStorage', RAW_KEY) === '1',
    snap: null, mode: 'new', site: '', targetId: '', connecting: false, submitting: false, working: false,
    openSeq: 0,
    pending: null, timer: null, failures: 0, announced: '', bannerFocus: '',
    focusMessage: false, openBlocks: {}, sentPrompt: '', authExpired: false,
    // Prompt text per turn id (kept in this browser tab's sessionStorage only; the service never returns prompt bodies).
    prompts: {}, clearedTurn: null,
    unknownDetail: '', checkedNote: '', copyState: '', replyTrack: null, finishFocus: false,
    // Exact thread reference seen when the tab was chosen; sent as expectedThread so a moved tab is refused, not followed.
    pickRef: null, pickNote: '',
    // Page read: kept in memory only (never stored in the browser), always tied to the conversation it came from.
    reading: false, readSeq: 0, transcript: null,
    // Opt-in live reply stream (SSE). The poll loop stays the owner of state; events only make
    // streaming text and state changes appear sooner. Never sends, never replays actions.
    stream: null, streamTimer: null,
  };

  /* ---- api ---- */
  async function api(path, { method = 'GET', body } = {}) {
    let res;
    try {
      res = await fetch(API + path, { method, credentials: 'same-origin', headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    } catch {
      const e = new Error('Could not reach the Studio. Check that it is still running.'); e.status = 0; throw e;
    }
    let data = {}, malformed = false;
    const text = await res.text();
    if (text) { try { data = JSON.parse(text); } catch { malformed = true; data = { error: 'The Studio sent a reply that was not JSON.' }; } }
    if (res.status === 401 || res.status === 403) setAuth(true); else if (res.ok && S.authExpired) setAuth(false);
    if (!res.ok || malformed) {
      const e = new Error(data?.error || res.statusText || 'Request failed');
      e.status = res.ok ? 200 : res.status; e.data = data; e.malformed = malformed; throw e;
    }
    return data;
  }
  function setAuth(on) {
    S.authExpired = on;
    $('#connectionNote').textContent = on ? 'Studio request rejected. Local mode needs no token; if token mode is enabled, reopen the URL shown at startup.' : '';
  }
  const describe = (e) => explainError({ status: e.status, code: e.data?.code, message: e.message });
  // Plain text, plus a link node when the error has somewhere to go (for example the busy browser -> /drive).
  function setError(sel, text, link = null) {
    const n = $(sel); n.textContent = text || '';
    if (text && link) n.append(' ', el('a', { href: link.href, text: link.text }));
  }
  const unreadable = () => Object.assign(new Error('The Studio sent a conversation we couldn’t read.'), { status: 200, malformed: true });

  /* ---- snapshot handling ---- */
  function applySnapshot(next) {
    const prevId = S.snap?.id;
    const picked = pickSnapshot(S.snap, next);
    if (picked !== S.snap) {
      if (!S.snap || S.snap.id !== picked.id) {
        S.bannerFocus = ''; S.openBlocks = {}; textBlocks.clear(); S.replyTrack = null;
        S.unknownDetail = ''; S.checkedNote = ''; S.copyState = ''; S.finishFocus = false;
        S.transcript = null; S.reading = false; ++S.readSeq; setError('#readError', '');
        S.sentPrompt = store.get('sessionStorage', 'chat.sent.' + picked.id) ?? ''; loadPending(picked.id); loadPrompts(picked.id);
        S.clearedTurn = picked.turn?.id ?? null; // an already-sent turn never wipes a draft typed for the next one
        openStream(picked.id);
        // The user's own unsent text is kept; only a different conversation gets its own saved draft.
        const saved = store.get('sessionStorage', 'chat.draft.' + picked.id) ?? '';
        if (prevId && prevId !== picked.id) $('#prompt').value = saved; else if (!$('#prompt').value) $('#prompt').value = saved;
      }
      S.snap = picked;
      store.set('localStorage', SELECTED_KEY, picked.id);
    }
    if (pendingRegistered(S.pending, S.snap)) {
      S.sentPrompt = S.pending.prompt; store.set('sessionStorage', 'chat.sent.' + S.snap.id, S.sentPrompt);
      rememberPrompt(S.snap.id, S.snap.turn.id, S.pending.prompt);
      store.del('sessionStorage', 'chat.draft.' + S.snap.id);
      clearPending(); S.unknownDetail = '';
    }
    const i = S.list.findIndex((c) => c.id === S.snap.id);
    // Same fields the service's list returns (without reply text), so the history row stays accurate after each refresh.
    const summary = { id: S.snap.id, site: S.snap.site, state: S.snap.state, revision: S.snap.revision, binding: S.snap.binding, capture: S.snap.capture,
      turns: turnsOf(S.snap).map((t) => ({ ...t, reply: { ...t.reply, text: undefined } })) };
    if (i >= 0) S.list[i] = { ...S.list[i], ...summary }; else S.list.unshift(summary);
    render(); schedulePoll();
  }
  function loadPending(id) {
    try { const p = JSON.parse(store.get('sessionStorage', 'chat.pending.' + id) ?? 'null'); S.pending = p && p.key ? p : null; } catch { S.pending = null; }
  }
  function loadPrompts(id) {
    try { const p = JSON.parse(store.get('sessionStorage', 'chat.prompts.' + id) ?? 'null'); S.prompts = p && typeof p === 'object' && !Array.isArray(p) ? p : {}; } catch { S.prompts = {}; }
  }
  function rememberPrompt(convId, turnId, text) {
    if (!turnId || typeof text !== 'string' || (S.snap && S.snap.id !== convId)) return;
    S.prompts = { ...S.prompts, [turnId]: text };
    store.set('sessionStorage', 'chat.prompts.' + convId, JSON.stringify(S.prompts));
  }
  function savePending() { if (S.pending) store.set('sessionStorage', 'chat.pending.' + S.pending.convId, JSON.stringify(S.pending)); }
  function clearPending() { if (S.pending) store.del('sessionStorage', 'chat.pending.' + S.pending.convId); S.pending = null; }

  // A response for a conversation the user has since left is dropped.
  const stillOn = (id) => S.snap?.id === id;
  async function refresh(id = S.snap?.id) {
    if (!id) return;
    try {
      const data = await api('/conversations/' + encodeURIComponent(id));
      if (!stillOn(id)) return;
      const c = unwrapConversation(data);
      if (!c) throw unreadable();
      S.failures = 0; showProblem('');
      applySnapshot(c);
    } catch (e) {
      if (!stillOn(id)) return;
      if (e.status === 404) {
        stopPolling(); closeStream();
        if (S.snap?.id === id) { ++S.openSeq; S.snap = null; store.del('localStorage', SELECTED_KEY); }
        showProblem('That conversation is no longer available on the Studio.'); render(); return;
      }
      S.failures++;
      showProblem('Lost contact with the Studio (' + describe(e) + '). Retrying. What you see may be out of date.');
      $('#btnRetry').hidden = false;
      schedulePoll();
    }
  }
  function stopPolling() { clearTimeout(S.timer); S.timer = null; }
  function schedulePoll() {
    stopPolling();
    const delay = pollDelay(S.snap, { hidden: document.hidden, failures: S.failures });
    if (delay == null) return;
    const id = S.snap.id;
    S.timer = setTimeout(() => { if (S.snap?.id === id) refresh(id); }, delay);
  }
  function showProblem(text) { const p = $('#problem'); p.textContent = text; p.hidden = !text; }

  /* ---- live reply stream (opt-in SSE; poll loop remains the owner of state) ---- */
  function closeStream() {
    clearTimeout(S.streamTimer); S.streamTimer = null;
    if (S.stream) { S.stream.close(); S.stream = null; }
  }
  function openStream(id) {
    closeStream();
    if (!id || typeof EventSource !== 'function') return;
    let source;
    try { source = new EventSource(API + '/conversations/' + encodeURIComponent(id) + '/events?include=text'); }
    catch { return; }
    source.addEventListener('conversation.reply_text', (ev) => {
      let data; try { data = JSON.parse(ev.data); } catch { return; }
      if (!stillOn(data.conversationId) || !S.snap || data.turnId !== S.snap.turn?.id) return;
      const merged = mergeReplyText(S.snap.reply, data.reply);
      if (!merged) return;
      S.snap.reply = merged;
      if (S.snap.turn && S.snap.turn.id === data.turnId && S.snap.turn.reply) S.snap.turn.reply = merged;
      render();
    });
    source.addEventListener('conversation.changed', () => {
      // The poll loop owns snapshots; events only accelerate the next refresh.
      if (S.streamTimer || !S.snap || S.snap.id !== id) return;
      S.streamTimer = setTimeout(() => { S.streamTimer = null; if (stillOn(id)) refresh(id); }, 250);
    });
    source.addEventListener('reset', () => { if (stillOn(id)) refresh(id); });
    source.onerror = () => { /* EventSource reconnects on its own; polling remains the fallback. */ };
    S.stream = source;
  }

  /* ---- targets and list ---- */
  async function loadTargets() {
    S.targetsState = 'loading'; S.targetsError = ''; renderConnect();
    try {
      const data = await api('/conversation-targets');
      S.targets = { sites: Array.isArray(data.sites) ? data.sites : [], targets: Array.isArray(data.targets) ? data.targets : [] };
      S.targetsState = 'ok';
      if (!S.targets.sites.some((s) => s.id === S.site)) S.site = S.targets.sites[0]?.id ?? '';
      // A refreshed list never moves a choice to another chat: if the tab is gone or now shows a different thread, the choice is cleared.
      if (S.targetId) {
        const t = selectedTarget();
        if (!t) { S.pickNote = 'The tab you chose is no longer open. Choose a tab again.'; S.targetId = ''; S.pickRef = null; }
        else if ((threadRef(t) ?? null) !== S.pickRef) { S.pickNote = 'The tab you chose is now on a different chat. Nothing is selected; choose a tab again.'; S.targetId = ''; S.pickRef = null; }
      }
    } catch (e) { S.targetsState = 'error'; S.targetsError = describe(e); }
    renderConnect(); renderChrome();
  }
  async function loadList() {
    S.listState = 'loading'; renderList();
    try {
      const data = await api('/conversations');
      S.list = Array.isArray(data.conversations) ? data.conversations : [];
      S.listState = 'ok';
    } catch (e) { S.listState = 'error:' + describe(e); }
    renderList();
  }
  async function openConversation(id) {
    const requestSeq = ++S.openSeq;
    try {
      const c = unwrapConversation(await api('/conversations/' + encodeURIComponent(id)));
      if (requestSeq !== S.openSeq) return;
      if (!c || c.id !== id) throw unreadable();
      S.failures = 0; showProblem(''); applySnapshot(c);
    } catch (e) {
      if (requestSeq !== S.openSeq) return;
      if (e.status === 404) {
        // An unavailable list entry does not invalidate the different conversation currently on screen.
        if (S.snap?.id === id) {
          stopPolling(); closeStream(); S.snap = null;
          store.del('localStorage', SELECTED_KEY);
          showProblem('That conversation is no longer available. Choose an earlier conversation or connect again.');
        } else showProblem('The requested conversation is unavailable. The previously selected conversation remains visible; no new send was attempted.');
      } else showProblem('Could not open that conversation: ' + describe(e) + '. No new send was attempted.');
      render();
    }
  }

  /* ---- connect ---- */
  const selectedTarget = () => S.targets.targets.find((t) => t.id === S.targetId) ?? null;
  const targetUsable = (t) => !!t?.site && !t.recorderOwner;
  function connectReady() {
    if (S.connecting) return { ok: false, reason: 'Connecting…' };
    if (S.snap && S.snap.state !== 'closed') return { ok: false, reason: 'Finish the current conversation before connecting another.' };
    if (S.targetsState !== 'ok') return { ok: false, reason: S.targetsState === 'loading' ? 'Loading sites and tabs…' : 'Sites and tabs didn’t load. Try Refresh tabs.' };
    if (S.mode === 'new') return S.site ? { ok: true, reason: '' } : { ok: false, reason: 'No known sites are available.' };
    const t = selectedTarget();
    if (!t) return { ok: false, reason: 'Choose a tab to continue.' };
    if (!targetUsable(t)) return { ok: false, reason: targetHint(t) + '.' };
    return { ok: true, reason: '' };
  }
  async function connect() {
    const ready = connectReady(); if (!ready.ok) { renderConnect(); return; }
    // For an existing tab the thread reference seen at selection goes along as expectedThread (when the tab had one).
    const body = S.mode === 'new' ? { site: S.site, freshTab: true }
      : { site: selectedTarget().site, targetId: S.targetId, ...(S.pickRef ? { expectedThread: S.pickRef } : {}) };
    const known = new Set(S.list.map((c) => c.id));
    S.connecting = true; $('#connectError').textContent = ''; renderConnect();
    try {
      const c = unwrapConversation(await api('/conversations', { method: 'POST', body }));
      if (!c) throw unreadable();
      S.focusMessage = true; showProblem('');
      applySnapshot(c); loadList();
    } catch (e) {
      let msg = (isAmbiguous(e) ? 'We couldn’t confirm the connection: ' : 'Couldn’t connect: ') + describe(e) + ' Studio does not retry by itself.';
      // The service refused the exact chat that was chosen. Nothing is connected and nothing else is picked for the user:
      // the choice is cleared and the tab list is reloaded so the next choice is deliberate.
      const code = e.data?.code ?? (isCode(e.message) ? e.message : null);
      if (S.mode === 'existing' && ['BINDING_CHANGED', 'THREAD_IDENTITY_UNVERIFIED', 'TARGET_NOT_FOUND', 'TARGET_SITE_MISMATCH'].includes(code)) {
        S.targetId = ''; S.pickRef = null; S.pickNote = 'Nothing was connected, and no other tab was chosen for you. Choose a tab again.';
        await loadTargets();
      }
      // A failed attach can still leave a conversation that owns the browser. Surface it so it can be finished.
      await loadList();
      const created = S.list.filter((c) => !known.has(c.id) && c.state !== 'closed');
      if (created.length === 1) { await openConversation(created[0].id); msg += ' A conversation was left open. Check it or finish it from the notice below.'; }
      else if (created.length > 1) msg += ' Check “Earlier conversations”.';
      $('#connectError').textContent = msg;
    } finally { S.connecting = false; renderConnect(); renderChrome(); }
  }

  /* ---- send ---- */
  // The only place a turn is posted. One click on Send, always a NEW key (never the key of an earlier attempt),
  // and never from a timer, a poll or a recovery button.
  async function sendMessage() {
    const snap = S.snap; if (!snap || S.submitting || S.pending) return;
    const check = canSend(snap, { prompt: $('#prompt').value, busy: false });
    if (!check.ok) { renderComposer(); return; }
    const prompt = $('#prompt').value.replace(/\s+$/, '');
    S.pending = { convId: snap.id, key: newKey(), prompt, expectedRevision: Number(snap.revision), priorTurnId: snap.turn?.id ?? null };
    const attempt = S.pending;
    savePending();
    const body = { key: attempt.key, prompt, confirm: true, expectedRevision: attempt.expectedRevision };
    S.submitting = true; S.checkedNote = ''; S.unknownDetail = '';
    setError('#sendError', ''); render();
    $('#transcript').focus();
    try {
      const c = unwrapConversation(await api('/conversations/' + encodeURIComponent(snap.id) + '/turns', { method: 'POST', body }));
      if (!c || c.id !== snap.id) throw Object.assign(new Error('The Studio accepted the request but returned an unreadable or mismatched conversation.'), { status: 200, malformed: true });
      // Persist the result for the original conversation, never for a different one now on screen.
      store.set('sessionStorage', 'chat.sent.' + snap.id, attempt.prompt);
      if (c.turn?.id && c.turn.id !== (attempt.priorTurnId ?? null)) rememberPrompt(snap.id, c.turn.id, attempt.prompt);
      if (S.pending?.convId === snap.id && S.pending.key === attempt.key) clearPending();
      else store.del('sessionStorage', 'chat.pending.' + snap.id);
      if (stillOn(snap.id)) { S.sentPrompt = attempt.prompt; applySnapshot(c); }
    } catch (e) {
      if (isAmbiguous(e)) {
        // The original attempt remains persisted. Switching conversations must not unlock/retry it.
        if (stillOn(snap.id)) { S.unknownDetail = describe(e); refresh(snap.id); }
      } else {
        if (S.pending?.convId === snap.id && S.pending.key === attempt.key) clearPending();
        else store.del('sessionStorage', 'chat.pending.' + snap.id);
        if (stillOn(snap.id)) {
          const r = sendRejection(e); setError('#sendError', r.text, r.link);
          refresh(snap.id);
        }
      }
    } finally { S.submitting = false; render(); }
  }
  // The user's own choice after an unknown outcome: one click, a new key, the same text.
  function sendAgain() {
    if (!pendingUnknown(S.pending, S.snap, S.submitting) || isUncertain(S.snap)) return;
    const text = S.pending.prompt;
    clearPending(); S.unknownDetail = '';
    const box = $('#prompt'); box.readOnly = false; box.value = text;
    sendMessage();
  }
  async function copyMine() {
    const text = S.pending?.prompt || S.sentPrompt || ''; if (!text) return;
    const clip = globalThis.navigator?.clipboard;
    try { if (!clip?.writeText) throw new Error('no clipboard'); await clip.writeText(text); S.copyState = 'copied'; } catch { S.copyState = 'failed'; }
    $('#announce').textContent = S.copyState === 'copied' ? 'Message copied.' : 'Couldn’t copy the message.';
    render();
  }

  /* ---- reconcile and finish ---- */
  // Read-only: refreshes readiness when nothing was sent, or looks for the earlier send. Never types or sends.
  async function reconcile(errorSel = '#reconcileError') {
    if (!S.snap || S.working) return;
    const id = S.snap.id;
    S.working = true; setError(errorSel, ''); $('#readyChecked').textContent = ''; S.checkedNote = ''; render();
    let released = false;
    try {
      const c = unwrapConversation(await api('/conversations/' + encodeURIComponent(id) + '/reconcile', { method: 'POST', body: { expectedRevision: Number(S.snap.revision) } }));
      if (!stillOn(id)) return;
      if (c) applySnapshot(c); else await refresh(id);
      if (S.snap && checkFoundNoMessage(S.pending, S.snap)) {
        // Read-only evidence: the chat shows no new message from this request. Release the lock; the text stays in the box.
        clearPending(); S.unknownDetail = ''; released = true;
        S.checkedNote = 'Checked: Studio found no new message from you in this chat. You can send it now.';
        $('#announce').textContent = S.checkedNote;
      } else if (S.snap && readinessPanel(S.snap).show) $('#readyChecked').textContent = 'Checked again just now. Studio still can’t send.';
      else if (S.snap && pendingUnknown(S.pending, S.snap)) $('#announce').textContent = 'Checked again. Studio still can’t confirm the message was sent.';
      else if (S.snap && canSend(S.snap, { prompt: 'x' }).ok) $('#announce').textContent = 'Checked. Ready to send.';
    } catch (e) {
      setError(errorSel, e.status === 409 && e.data?.code === 'STALE_REVISION'
        ? 'The conversation changed while checking. It has been refreshed. Press Check again.' : 'Could not check: ' + describe(e), errorLink(e.data?.code));
      if (e.status === 409) refresh(id);
    } finally { S.working = false; render(); if (released) $('#prompt').focus(); }
  }
  async function finish() {
    if (!S.snap || S.working) return;
    const id = S.snap.id;
    const closeTab = !$('#closeTabField').hidden && $('#closeTab').checked && canCloseTab(S.snap);
    S.working = true; S.finishFocus = true; setError('#finishError', ''); render();
    try {
      const c = unwrapConversation(await api('/conversations/' + encodeURIComponent(id) + '/finish', { method: 'POST', body: { closeTab } }));
      if (!stillOn(id)) return;
      if (c) applySnapshot(c); else await refresh(id);
    } catch (e) {
      S.finishFocus = false;
      setError('#finishError', isAmbiguous(e)
        ? 'We couldn’t confirm the capture was finished (' + describe(e) + '). Check status before trying again.'
        : 'Could not finish: ' + describe(e), errorLink(e.data?.code));
      refresh(id);
    } finally { S.working = false; render(); }
  }
  function newConversation() {
    ++S.openSeq;
    S.transcript = null; S.reading = false; ++S.readSeq; setError('#readError', '');
    stopPolling(); S.snap = null; S.pending = null; S.sentPrompt = ''; S.prompts = {}; S.clearedTurn = null; S.failures = 0;
    S.unknownDetail = ''; S.checkedNote = ''; S.copyState = ''; S.replyTrack = null; S.finishFocus = false; textBlocks.clear();
    store.del('localStorage', SELECTED_KEY); $('#prompt').value = ''; $('#prompt').readOnly = false;
    $('#detailsKv').replaceChildren(); showProblem(''); render(); loadTargets(); $('#connectBox').open = true;
  }

  /* ---- rendering ---- */
  function renderConnect() {
    const sel = $('#site');
    sel.replaceChildren(...(S.targets.sites.length ? S.targets.sites.map((s) => el('option', { value: s.id, text: s.id, selected: s.id === S.site })) : [el('option', { value: '', text: S.targetsState === 'loading' ? 'Loading sites…' : 'No sites available' })]));
    sel.value = S.site;
    const site = S.targets.sites.find((s) => s.id === S.site);
    $('#siteNote').textContent = site?.url ? 'Opens ' + shortUrl(site.url) : '';
    $('#siteField').hidden = S.mode !== 'new'; $('#existingField').hidden = S.mode !== 'existing';
    const list = $('#targetList');
    if (S.mode === 'existing') {
      if (S.targetsState === 'loading') list.replaceChildren(el('div', { class: 'empty', text: 'Loading tabs…' }));
      else if (S.targetsState === 'error') list.replaceChildren(el('div', { class: 'err pad', text: 'Could not load tabs: ' + S.targetsError }));
      else if (!S.targets.targets.length) list.replaceChildren(el('div', { class: 'empty' }, [
        'No supported tabs found. Open a supported site in the capture browser, then Refresh tabs. ', el('a', { class: 'hit', href: '/', text: 'Open Studio' }),
      ]));
      else list.replaceChildren(...S.targets.targets.map((t, i) => {
        const usable = targetUsable(t), id = 'tg-' + i, hint = targetHint(t);
        const input = el('input', { type: 'radio', name: 'target', id, value: t.id, checked: t.id === S.targetId, disabled: !usable, onchange: () => { S.targetId = t.id; S.pickRef = threadRef(t); S.pickNote = ''; renderConnect(); } });
        const th = targetThread(t);
        return el('label', { class: 'pick target' + (usable ? '' : ' off'), for: id }, [input, el('span', {}, [
          el('span', { class: 't-title', text: t.title || '(untitled)' }), el('br'),
          el('span', { class: 't-sub', text: [t.site, shortUrl(t.url)].filter(Boolean).join(' · ') + (hint ? ' — ' + hint : '') }),
          th.line ? el('br') : null,
          th.line ? el('span', { class: 't-sub ' + (th.state === 'unverified' ? 't-warn' : ''), text: th.line }) : null,
        ])]);
      }));
    }
    // Why the chosen tab can or can't be read and sent, or why the last choice was cleared. Never picks for the user.
    const chosen = S.mode === 'existing' ? selectedTarget() : null;
    optText('#targetNote', S.mode === 'existing' ? (S.pickNote || (chosen ? targetThread(chosen).note : '')) : '');
    const ready = connectReady();
    $('#btnConnect').disabled = !ready.ok;
    $('#btnConnect').textContent = S.connecting ? 'Connecting…' : 'Connect and start recording';
    $('#connectHint').textContent = ready.ok ? '' : ready.reason;
    $('#btnTabs').disabled = S.targetsState === 'loading';
  }
  function renderChrome() {
    const snap = S.snap, box = $('#connectBox');
    $('#connectSummary').textContent = snap && snap.state !== 'closed'
      ? 'Connected: ' + siteName(snap.site) + ' · ' + (ownedByStudio(snap) ? 'Studio’s tab' : 'your tab') + ' · ' + conversationChip(snap.state)[0]
      : 'Connection';
    if (snap && snap.state !== 'closed' && box.dataset.autoClosed !== snap.id) { box.open = false; box.dataset.autoClosed = snap.id; }
    if (!snap) { delete box.dataset.autoClosed; }
  }
  function renderStage(snap) {
    setText($('#stageLine'), stageInfo(snap, { pending: pendingUnknown(S.pending, snap, S.submitting), submitting: S.submitting }).text);
  }
  function renderChips(snap) {
    if (!snap) { syncChips($('#chips'), []); return; }
    const out = [conversationChip(snap.state)];
    const ready = readinessChip(snap);
    if (ready) out.push(ready);
    if (snap.turn) {
      out.push(isPreparing(snap) ? ['Preparing to send', 't-live'] : sendChip(snap.turn.send?.state));
      if (messageStarted(snap) && snap.reply) {
        out.push(replyChip(snap.reply.state));
        // A ready reply with unknown network completion is only interactive readiness. Say so beside the reply chip.
        if (snap.reply.state === 'ready' && !completionKnown(snap.reply.completion)) out.push(completionChip(snap.reply.completion));
      }
    }
    if (snap.capture) out.push(captureChip(snap.capture.state));
    syncChips($('#chips'), out);
  }
  // Reply text nodes are kept and appended to, so a selection inside a streaming reply survives each poll.
  function setNodeText(textNode, next) {
    const prev = textNode.data;
    if (prev === next) return;
    if (next.startsWith(prev)) textNode.appendData(next.slice(prev.length)); else textNode.data = next;
  }
  function makeBlock(b, formatted = false) {
    if (formatted) return { root: el('div', { class: 'rich' }), state: {} };
    const textNode = document.createTextNode('');
    const body = el('p', { class: 'body' }, [textNode]);
    if (b.kind === 'answer') return { root: el('div', {}, [body]), textNode };
    const d = el('details', { class: 'blk' }, [el('summary', { text: b.label }), body]);
    d.open = !!S.openBlocks[b.key];
    d.addEventListener('toggle', () => { S.openBlocks[b.key] = d.open; });
    return { root: d, textNode };
  }
  function syncReplyBlocks(blocks, reply) {
    const holder = $('#replyBlocks'), want = [];
    if (!blocks.length) {
      let ph = textBlocks.get('placeholder');
      if (!ph) { ph = { root: el('p', { class: 'note' }) }; textBlocks.set('placeholder', ph); }
      setText(ph.root, reply.state === 'waiting' || reply.state === 'streaming' ? 'Waiting for the reply…' : 'No reply text yet.');
      want.push(ph.root);
    }
    // The answer is shown formatted (code, tables, lists, links) unless the reader chose plain text. Reasoning and tool
    // activity from the site always stay plain text. Both views are built from the same text, never from markup.
    const parsed = new Map(blocks.filter((b) => b.kind === 'answer' && typeof b.text === 'string').map((b) => [b.key, parseRich(b.text).blocks]));
    const formatted = S.rawView ? new Map() : parsed; // sources are listed in both views
    const sources = replySources(reply, [...parsed.values()].flat()), live = ['waiting', 'streaming'].includes(reply.state);
    const keep = new Set();
    for (const b of blocks) {
      const isRich = formatted.has(b.key), rk = b.key + (isRich ? '~formatted' : '');
      let rec = textBlocks.get(rk);
      if (!rec) { rec = makeBlock(b, isRich); textBlocks.set(rk, rec); }
      if (isRich) rich.sync(rec.root, rec.state, formatted.get(b.key), { sources, streaming: live });
      else setNodeText(rec.textNode, b.text ?? 'This content is stored in the saved session. Open the session to read it.');
      keep.add(rk); want.push(rec.root);
    }
    for (const k of [...textBlocks.keys()]) if (k !== 'placeholder' ? !keep.has(k) : blocks.length) textBlocks.delete(k);
    const have = Array.from(holder.children);
    if (have.length !== want.length || want.some((n, i) => n !== have[i])) holder.replaceChildren(...want);
    renderSources(sources, replyArtifacts(reply));
    const answerText = blocks.filter((b) => b.kind === 'answer' && typeof b.text === 'string').map((b) => b.text).join('\n\n');
    $('#btnCopyReply').disabled = !answerText;
    setText($('#btnRawToggle'), S.rawView ? 'Show formatted' : 'Show plain text');
  }
  // Sources and artifacts the site reported, or links the reply text itself contains. Rebuilt only when they change.
  function renderSources(sources, artifacts) {
    const box = $('#replySources'), sig = sourcesSig(sources);
    box.hidden = !sources.length;
    setText($('#sourcesHead'), 'Sources (' + sources.length + ')'); setText($('#sourcesNote'), sourcesNote(sources));
    const list = $('#sourcesList');
    if (list.dataset.sig !== sig) { list.dataset.sig = sig; list.replaceChildren(...sources.map(rich.sourceRow)); }
    const abox = $('#replyArtifacts'), asig = artifacts.map((a) => a.n + ':' + a.title + ':' + (a.text?.length ?? a.href)).join('|');
    abox.hidden = !artifacts.length;
    if (abox.dataset.sig !== asig) { abox.dataset.sig = asig; abox.replaceChildren(el('h4', { class: 'rh', text: 'Artifacts reported by the site (' + artifacts.length + ')' }), ...artifacts.map(rich.artifactCard)); }
  }
  async function copyReply() {
    const reply = S.snap?.reply, text = replyBlocks(reply).filter((b) => b.kind === 'answer' && typeof b.text === 'string').map((b) => b.text).join('\n\n');
    if (!text) return;
    const ok = await copyText(text);
    setText($('#btnCopyReply'), ok ? 'Reply copied' : 'Couldn’t copy. Select the text instead');
    $('#announce').textContent = ok ? 'Reply copied.' : 'Couldn’t copy the reply.';
    const timer = setTimeout(() => setText($('#btnCopyReply'), 'Copy reply'), 1800); timer?.unref?.();
  }
  function toggleRaw() {
    S.rawView = !S.rawView; store.set('localStorage', RAW_KEY, S.rawView ? '1' : '0');
    $('#turnList').dataset.sig = ''; // earlier-turn replies follow the same view
    render();
  }
  // One row per turn (Turn 1, 2, 3 ...), each with its own send/reply state, never merged into one blob. The latest
  // started turn is shown in full below the list; earlier turns keep their own message and reply here.
  function renderTurns(snap) {
    const list = $('#turnList'), rows = snap ? turnRows(snap, S.prompts) : [];
    list.hidden = rows.length < 2;
    const sig = JSON.stringify([S.rawView, rows.map((r) => [r.n, r.id, r.current, r.blocked, r.chips, r.reason, r.sessionId, r.prompt, r.current ? '' : r.reply])]);
    if (list.dataset.sig === sig) return;
    list.dataset.sig = sig;
    // An earlier reply keeps its own formatting (code, tables, links), or the plain text when the reader chose that.
    const earlierReply = (text) => {
      if (S.rawView) return el('p', { class: 'body', text });
      const holder = el('div', { class: 'rich' });
      rich.renderStatic(holder, text, { sources: replySources(null, parseRich(text).blocks) });
      return holder;
    };
    list.replaceChildren(...rows.map((r) => el('li', { class: 'turn' }, [
      el('p', { class: 'note' }, [el('b', { text: 'Turn ' + r.n + (r.current ? ' (shown in full below)' : '') }), ' ', ...r.chips.map(chip)]),
      r.reason ? el('p', { class: 'note', text: reasonText(r.reason) }) : null,
      !r.current && r.prompt ? el('p', { class: 'body', text: 'You: ' + r.prompt }) : null,
      !r.current && r.reply ? el('details', { class: 'blk' }, [el('summary', { text: 'Reply to turn ' + r.n }), earlierReply(r.reply)]) : null,
    ])));
  }
  function renderTranscript(snap) {
    const started = messageStarted(snap), preparing = isPreparing(snap);
    renderTurns(snap);
    const empty = $('#emptyState');
    empty.hidden = !!snap && (started || preparing);
    setText(empty, !snap ? 'No conversation yet. Connect to a site above.'
      : 'Connected. Earlier messages in this chat aren’t shown here. Write your message below.');
    $('#youMsg').hidden = !(started || preparing); $('#phaseLine').hidden = !started; $('#replyMsg').hidden = !started || !snap?.reply;
    if (!(started || preparing)) return;
    const n = turnCount(snap), own = S.prompts[snap.turn.id];
    const fallback = preparing && !started ? (S.pending?.prompt || $('#prompt').value) : n <= 1 ? (S.sentPrompt || $('#prompt').value) : S.sentPrompt;
    setText($('#youHead'), n > 1 ? 'Turn ' + n + ': You' : 'You');
    setText($('#youText'), own || fallback || 'Your message isn’t kept in this browser tab.');
    setText($('#youNote'), preparing ? 'Not sent yet. Studio is checking the chat box and typing.'
      : (snap.turn.send?.observationSource ? 'Send seen in: ' + word(snap.turn.send.observationSource) + '. ' : '') + 'Studio can’t prove the site received it only once.');
    const copy = $('#btnCopy');
    copy.hidden = !(own || S.sentPrompt);
    setText(copy, S.copyState === 'copied' ? 'Message copied' : S.copyState === 'failed' ? 'Couldn’t copy. Select the text instead' : 'Copy my message');
    if (!started) return;
    syncChips($('#phaseLine'), [sendChip(snap.turn.send?.state), ...(snap.reply ? [replyChip(snap.reply.state)] : [])]);
    const reply = snap.reply; if (!reply) return;
    setText($('#replyHead'), (n > 1 ? 'Turn ' + n + ': ' : '') + 'Reply from ' + siteName(snap.site));
    const blocks = replyBlocks(reply);
    syncReplyBlocks(blocks, reply);
    syncChips($('#replyChips'), [sourceChip(reply.source), completionChip(reply.completion)]);
    const total = Number(reply.chars), shown = shownChars(blocks), chars = Number.isFinite(total) ? total : shown;
    const now = Date.now(), live = ['waiting', 'streaming'].includes(reply.state);
    if (!S.replyTrack) S.replyTrack = { chars, at: now, changed: false };
    else if (S.replyTrack.chars !== chars) { S.replyTrack.chars = chars; S.replyTrack.at = now; S.replyTrack.changed = true; }
    optText('#replyCount', chars > 0 || shown > 0 ? replyCountText(chars, live || S.replyTrack.changed ? now - S.replyTrack.at : null) : '');
    const partial = replyMayBePartial(reply);
    $('#replyPartial').hidden = !partial; setText($('#replyPartial'), partial ? PARTIAL_TEXT : '');
    optText('#replyTrunc', Number.isFinite(total) && total > shown && blocks.some((b) => b.kind === 'answer' && b.text != null)
      ? 'Showing ' + shown + ' of ' + total + ' characters. The full text is in the saved session.' : '');
  }
  function renderBanners(snap) {
    // One banner for both kinds of "not sure it was sent": the service says so, or our own send request got no answer.
    const pend = pendingUnknown(S.pending, snap, S.submitting), server = !!snap && isUncertain(snap);
    const unc = !!snap && (server || pend);
    const banner = $('#uncertain');
    banner.hidden = !unc;
    if (unc) {
      const sendUnsure = pend || snap.turn?.send?.state === 'uncertain' || snap.diagnostic?.uncertainty === 'send-acknowledgement-lost';
      const v = uncertainView(snap, { pending: pend && !server, detail: S.unknownDetail });
      setText($('#uncertainHead'), v.headline);
      syncList($('#uncertainLines'), v.lines);
      setText($('#chromeGuide'), chromeGuidance(snap, sendUnsure));
    }
    $('#btnReconcile').disabled = S.working;
    // Send again exists only for our own unanswered request. A service-side uncertain turn is never re-sent.
    $('#btnSendAgain').hidden = !(pend && !server); $('#btnSendAgain').disabled = S.working || S.submitting;
    setText($('#checkedNote'), S.checkedNote);
    // The banner takes focus once per transition, not on every poll.
    const focusKey = unc ? snap.id + ':' + (pend ? 'pending:' + S.pending.key : snap.turn?.id ?? '') : '';
    if (unc && S.bannerFocus !== focusKey) { S.bannerFocus = focusKey; banner.focus(); }
    if (!unc) S.bannerFocus = '';
    // Readiness: why sending is off, with a read-only Check again even when no message exists.
    const rp = readinessPanel(snap);
    $('#readyPanel').hidden = !rp.show || pend;
    if (rp.show) {
      $('#readyHead').textContent = rp.heading;
      $('#readyNote').textContent = rp.draft
        ? 'There’s text in the chat box' + (rp.chars != null ? ' (' + rp.chars + ' characters)' : '') + '. Studio never clears it for you. Send or clear it yourself in the Chrome tab, then press Check again (read-only).'
        : 'Fix it in Chrome if needed, then press Check again (read-only).';
      $('#readyReasons').replaceChildren(...rp.lines.map((l) => el('li', { text: l })));
      $('#btnCheck').disabled = S.working;
    } else $('#readyChecked').textContent = '';
  }
  function renderComposer() {
    const snap = S.snap, prompt = $('#prompt');
    const locked = !!S.pending && !!snap && S.pending.convId === snap.id && !pendingRegistered(S.pending, snap);
    // While a started turn is in flight the composer steps aside; once it is complete the composer is back for the next turn.
    $('#composer').hidden = messageStarted(snap) && !composerOpen(snap);
    if (locked) prompt.value = S.pending.prompt;
    // The text leaves the box once, when a send was actually started; a blocked or interrupted attempt keeps it,
    // and a message typed for the NEXT turn is never wiped by a later refresh of an already-sent turn.
    if (messageStarted(snap) && S.clearedTurn !== snap.turn.id) { prompt.value = ''; S.clearedTurn = snap.turn.id; }
    prompt.disabled = !!snap && (snap.state === 'closed' || turnInFlight(snap));
    prompt.readOnly = locked || S.submitting;
    const check = canSend(snap, { prompt: prompt.value, busy: S.submitting || locked });
    $('#btnSend').disabled = !check.ok;
    $('#sendHint').textContent = check.ok ? (isBlockedTurn(snap) ? 'Your earlier attempt was stopped before anything was typed or sent.'
      : turnCount(snap) > 0 ? 'Turn ' + turnCount(snap) + ' is complete. This message becomes turn ' + (turnCount(snap) + 1) + ' in the same chat.' : '')
      : locked && !S.submitting ? 'Locked: Studio can’t confirm your last message was sent. Use Check again or Send again in the notice above.' : check.reason;
  }
  function renderFinish(snap) {
    const bar = $('#finishBar');
    bar.hidden = !snap;
    if (!snap) return;
    const closed = snap.state === 'closed';
    const ctl = finishControl(snap, { working: S.working }), out = finishOutcome(snap);
    const bits = [];
    if (!out) {
      if (snap.reply?.state === 'ready' && messageStarted(snap) && snap.capture?.state === 'recording') bits.push('Reply ready. Still recording.');
      else if (snap.capture?.state === 'idle' && turnCount(snap) > 0) bits.push('Turn ' + turnCount(snap) + ' is recorded and its recording is stopped. Finish when you are done with this chat.');
      else if (snap.capture) bits.push(captureChip(snap.capture.state)[0] + '.');
      if (ctl.early) bits.push('The reply isn’t finished. Finishing now will probably leave the capture incomplete.');
      if (snap.capture?.state === 'recording' && !(snap.reply?.state === 'ready' && messageStarted(snap))) bits.push('Recording continues until you finish it' + (limitStatus(snap.capture).lines.length ? ' or the recording budget runs out.' : '.'));
      if (limitStatus(snap.capture).warn) bits.push('The recording limit is close. Finish soon.');
    }
    const fe = finishErrorText(snap.diagnostic?.finishError);
    if (fe) bits.push(fe);
    const showClose = !closed && canCloseTab(snap);
    $('#closeTabField').hidden = !showClose;
    if (!showClose) $('#closeTab').checked = false;
    if (!closed && !showClose) bits.push(isUncertain(snap) || snap.diagnostic?.uncertainty ? 'The tab stays open because the state isn’t confirmed.' : 'Studio won’t close this tab.');
    setText($('#finishNote'), bits.join(' '));
    optHidden('#turnNote', !(messageStarted(snap) && !closed));
    // Outcome: chip, the failed or unknown checks behind it, and the saved session, all in the bar itself.
    setText($('#finishHeading'), out ? 'Result: ' + out.chip[0] : 'Capture');
    $('#finishOutcome').hidden = !out; syncChips($('#finishOutcome'), out ? [out.chip] : []);
    syncList($('#finishReasons'), out ? out.reasons : []);
    const sid = snap.sessionId, links = $('#finishLinks'), linkSig = out && sid ? sid : '';
    if (links.dataset.sig !== linkSig) { links.dataset.sig = linkSig; links.replaceChildren(...(linkSig ? [newTabLink('/#session=' + encodeURIComponent(sid), 'Open saved session'), newTabLink('/#session=' + encodeURIComponent(sid) + '&view=knowledge', 'Explore derived knowledge (may be incomplete)')] : [])); }
    $('#btnFinish').disabled = ctl.disabled;
    setText($('#btnFinish'), ctl.label);
    $('#btnFinish').className = snap.reply?.state === 'ready' && messageStarted(snap) && !closed ? 'primary' : '';
    $('#btnNew').hidden = !closed;
    if (out && S.finishFocus) { S.finishFocus = false; $('#finishHeading').focus(); }
  }
  function renderDetails(snap) {
    const kv = $('#detailsKv');
    if (!snap) kv.replaceChildren(el('dt', { text: 'Status' }), el('dd', { text: 'No conversation selected.' }));
    else {
      const rows = [
        ['Site', siteName(snap.site)], ['State', conversationChip(snap.state)[0]], ['Revision', String(snap.revision)],
        ['Tab', snap.binding?.title || shortUrl(snap.binding?.origin ?? snap.binding?.url) || 'Not reported'],
        ['Tab owner', ownedByStudio(snap) ? 'Studio opened it' : 'You (Studio never closes it)'],
        ['Chat box', readinessText(snap)],
        ['Step', snap.turn?.phase ? word(snap.turn.phase) : '—'],
        ['Integrity check', integrityText(snap.capture)],
      ];
      const idv = identityView(snap);
      if (idv.show) rows.splice(4, 0, ['Chat thread', idv.ref ?? 'Not tied to a thread'], ['Thread check', idv.chip[0]]);
      if (snap.turn?.reason) rows.push(['Turn note', reasonText(snap.turn.reason)]);
      if (snap.diagnostic?.uncertainty) rows.push(['Needs checking', uncertaintyText(snap.diagnostic.uncertainty)]);
      if (snap.diagnostic?.finishPhase && snap.diagnostic.finishPhase !== 'idle') rows.push(['Finish step', word(snap.diagnostic.finishPhase)]);
      if (snap.diagnostic?.finishError) rows.push(['Finish problem', finishErrorText(snap.diagnostic.finishError)]);
      kv.replaceChildren(...rows.flatMap(([k, v]) => [el('dt', { text: k }), el('dd', { text: v })]));
    }
    const ev = snap?.evidence ?? snap?.turn?.evidence ?? snap?.capture?.evidence ?? null;
    const gates = Array.isArray(ev?.gates) ? ev.gates : [];
    $('#gates').replaceChildren(...(gates.length ? gates.map((g) => {
      const [label, tone] = gateChip(gateValue(g));
      return el('li', {}, [gateLabel(g) + ': ', el('b', { class: tone, text: label })]);
    }) : [el('li', { class: 'muted', text: 'Not checked yet. No evidence checks have run.' })]));
    const unknowns = Array.isArray(ev?.unknowns) ? ev.unknowns : [];
    optText('#unknowns', unknowns.length ? 'Still unknown: ' + unknowns.map(word).join(', ') + '.' : '');
    const lim = limitStatus(snap?.capture);
    optText('#limits', lim.stopped ? 'Capture stopped: ' + lim.stopped + '.' : lim.lines.length ? lim.lines.join(' ') + (lim.warn ? ' The limit is close.' : '') : 'No limits reported.');
    const lims = Array.isArray(snap?.limitations) ? snap.limitations : [];
    $('#limitations').replaceChildren(...(lims.length ? lims.map((l) => el('li', { text: limitationText(l) })) : [el('li', { class: 'muted', text: 'Nothing reported. Traffic from before you connected is never captured.' })]));
    const sid = snap?.sessionId;
    $('#sessionLinks').replaceChildren(...(sid ? [
      newTabLink('/#session=' + encodeURIComponent(sid), 'Open session'),
      newTabLink('/#session=' + encodeURIComponent(sid) + '&view=knowledge', 'Explore derived knowledge (may be incomplete)'),
      el('a', { class: 'hit', href: '/api/sessions/' + encodeURIComponent(sid) + '/transcript', text: 'Download transcript' }),
    ] : []));
  }
  function renderList() {
    const ul = $('#convList'), state = $('#listState');
    if (S.listState === 'loading') { state.textContent = 'Loading…'; ul.replaceChildren(); return; }
    if (S.listState.startsWith('error:')) { state.textContent = 'Could not load conversations: ' + S.listState.slice(6); ul.replaceChildren(); return; }
    const shown = historyShown(S.list, S.listAll), hidden = S.list.length - shown.length;
    state.textContent = S.list.length ? (hidden > 0 ? 'Showing ' + shown.length + ' of ' + S.list.length + '.' : '') : 'No conversations yet.';
    $('#btnListMore').hidden = !(hidden > 0 || (S.listAll && S.list.length > HISTORY_PAGE));
    setText($('#btnListMore'), S.listAll ? 'Show fewer' : 'Show all ' + S.list.length);
    ul.replaceChildren(...shown.map((c) => {
      const row = historyRow(c), [label, tone] = row.chip;
      const b = el('button', { type: 'button', onclick: () => openConversation(c.id) }, [
        el('span', { class: 'conv-title', text: row.title }), el('span', { class: 'pill ' + (row.attention ? 't-warn' : tone), text: row.attention && label !== 'Needs checking' ? label + ' · needs checking' : label }),
        row.meta ? el('span', { class: 'note conv-meta', text: row.meta }) : null]);
      if (S.snap?.id === c.id) b.setAttribute('aria-current', 'true');
      return el('li', {}, [b]);
    }));
  }
  function announce(snap) {
    // Phase changes only. Streaming text is never announced; a ready reply adds its source and completion once.
    const unsure = pendingUnknown(S.pending, snap, S.submitting);
    const ready = replyReadyText(snap);
    const key = snap ? [snap.state, snap.turn?.phase, snap.turn?.send?.state, snap.reply?.state, snap.capture?.state, snap.readiness?.ready, unsure, ready, turnCount(snap), composerOpen(snap)].join('|') : '';
    if (key === S.announced) return;
    S.announced = key;
    if (!snap) { $('#announce').textContent = ''; return; }
    const parts = [conversationChip(snap.state)[0]];
    const rc = readinessChip(snap); if (rc) parts.push(rc[0]);
    if (unsure) parts.push('Send not confirmed');
    if (snap.turn) { parts.push(isPreparing(snap) ? 'Preparing to send' : sendChip(snap.turn.send?.state)[0]); if (messageStarted(snap) && snap.reply) parts.push(ready || replyChip(snap.reply.state)[0]); }
    if (snap.reply?.state === 'ready' && messageStarted(snap) && snap.capture?.state === 'recording') parts.push('Still recording');
    else if (snap.capture) parts.push(captureChip(snap.capture.state)[0]);
    $('#announce').textContent = parts.join('. ') + '.';
  }
  /* ---- chat thread and page read ---- */
  function renderThread(snap) {
    const v = identityView(snap), strip = $('#threadStrip');
    strip.hidden = !v.show;
    if (!v.show) return;
    strip.className = 'panel thread ' + (['bound', 'unbound', 'unverified'].includes(v.state) ? v.state : 'other');
    syncChips($('#identityChips'), [v.chip]);
    $('#threadRef').hidden = !v.ref; setText($('#threadRef'), v.ref ?? '');
    syncList($('#identityLines'), v.lines);
  }
  // Rows are rebuilt only when a new read arrives (not on every poll), so selecting text in a read survives.
  function renderRead() {
    const snap = S.snap, box = $('#readBox');
    box.hidden = !snap;
    if (!snap) return;
    const chk = canRead(snap, { reading: S.reading, submitting: S.submitting, working: S.working });
    $('#btnRead').disabled = !chk.ok; setText($('#btnRead'), S.reading ? 'Reading…' : 'Read what’s on the page');
    setText($('#readHint'), chk.ok ? '' : chk.reason);
    box.setAttribute('aria-busy', S.reading ? 'true' : 'false');
    const t = S.transcript && S.transcript.convId === snap.id ? S.transcript : null, v = t?.view ?? null;
    $('#readEmpty').hidden = !!v; $('#readResult').hidden = !v;
    $('#btnReadMore').hidden = !(v?.more); $('#btnReadMore').disabled = !chk.ok;
    if (!v || $('#readResult').dataset.shown === String(t.seq)) return;
    $('#readResult').dataset.shown = String(t.seq);
    setText($('#readHeadline'), v.headline);
    syncChips($('#readChips'), v.chips);
    setText($('#readMeta'), [readAtText(v.readAt, (d) => d.toLocaleTimeString()), v.revision != null ? 'conversation revision ' + v.revision : '', 'This is what the page showed at that moment. It doesn’t update by itself.'].filter(Boolean).join(' · '));
    setText($('#readDraft'), v.draft);
    $('#readMessages').replaceChildren(...v.messages.map((m) => el('li', { class: 'rd ' + (m.role === 'user' ? 'user' : m.role === 'assistant' ? 'assistant' : 'other') }, [
      el('div', { class: 'rd-head' }, [el('b', { text: m.label }), m.n != null ? el('span', { class: 'rd-n', text: 'message ' + m.n }) : null,
        m.cut ? el('span', { class: 'pill t-warn', text: 'Cut short' + (m.chars != null ? ': showing ' + m.text.length + ' of ' + m.chars + ' characters' : '') }) : null]),
      el('p', { class: 'body', text: m.text === '' ? '(no text)' : m.text }),
    ])));
    syncList($('#readCoverage'), v.lines);
  }
  // Zero-send. This posts only to the read route and never touches the composer, the draft, the snapshot or any send state.
  async function readPage(limits = null) {
    const snap = S.snap; if (!snap) return;
    const chk = canRead(snap, { reading: S.reading, submitting: S.submitting, working: S.working });
    if (!chk.ok) { renderRead(); return; }
    const id = snap.id, seq = ++S.readSeq;
    S.reading = true; setError('#readError', ''); renderRead();
    try {
      const data = await api('/conversations/' + encodeURIComponent(id) + '/read', { method: 'POST', body: limits ?? {} });
      if (!stillOn(id) || seq !== S.readSeq) return;
      const view = readView(data?.transcript, S.snap);
      if (!view.ok) { setError('#readError', view.text); return; }
      S.transcript = { convId: id, seq, view, threadRef: threadRef(S.snap?.binding) };
      $('#announce').textContent = view.announce;
    } catch (e) {
      if (!stillOn(id) || seq !== S.readSeq) return;
      const r = readFailure(e); setError('#readError', r.text, r.link);
      if (e.status === 409) refresh(id);
    } finally { if (seq === S.readSeq) S.reading = false; renderRead(); }
  }
  function render() {
    const snap = S.snap;
    renderChrome(); renderStage(snap); renderChips(snap); renderThread(snap); renderBanners(snap); renderTranscript(snap); renderRead(); renderComposer(); renderFinish(snap);
    renderDetails(snap); renderList(); renderConnect(); announce(snap);
    $('#btnRetry').hidden = !(snap && S.failures > 0);
    universalRender(snap);
    if (S.focusMessage && snap?.state === 'ready' && !$('#prompt').disabled) { S.focusMessage = false; $('#prompt').focus(); }
  }

  /* ---- wiring ---- */
  document.querySelectorAll('input[name=mode]').forEach((r) => r.addEventListener('change', () => { if (r.checked) { S.mode = r.value; $('#connectError').textContent = ''; renderConnect(); } }));
  $('#site').addEventListener('change', () => { S.site = $('#site').value; renderConnect(); });
  $('#btnTabs').addEventListener('click', loadTargets);
  $('#btnConnect').addEventListener('click', connect);
  // Enter is a plain newline and there is no keyboard shortcut that sends: Send is one deliberate click.
  $('#btnSend').addEventListener('click', sendMessage);
  $('#btnSendAgain').addEventListener('click', sendAgain);
  $('#btnCopy').addEventListener('click', copyMine);
  // Read is its own explicit button. Choosing or opening a conversation never reads, and Read never sends.
  $('#btnRead').addEventListener('click', () => readPage());
  $('#btnReadMore').addEventListener('click', () => readPage({ maxMessages: READ_MAX.maxMessages, maxChars: READ_MAX.maxChars }));
  $('#composer').addEventListener('submit', (e) => e.preventDefault());
  $('#prompt').addEventListener('input', () => {
    if (S.snap && !S.pending) store.set('sessionStorage', 'chat.draft.' + S.snap.id, $('#prompt').value);
    renderComposer();
  });
  $('#btnReconcile').addEventListener('click', () => reconcile('#reconcileError'));
  $('#btnCheck').addEventListener('click', () => reconcile('#readyError'));
  $('#btnFinish').addEventListener('click', finish);
  $('#btnNew').addEventListener('click', newConversation);
  $('#btnCopyReply').addEventListener('click', copyReply);
  $('#btnRawToggle').addEventListener('click', toggleRaw);
  $('#btnListRefresh').addEventListener('click', loadList);
  $('#btnListMore').addEventListener('click', () => { S.listAll = !S.listAll; renderList(); });
  // Manual retry after the Studio stopped answering. It only re-reads the conversation; it never sends or re-posts anything.
  $('#btnRetry').addEventListener('click', async () => { const btn = $('#btnRetry'); btn.disabled = true; try { await refresh(); } finally { btn.disabled = false; render(); } });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) schedulePoll(); });
  const wide = window.matchMedia?.('(min-width: 1100px)');
  const syncDetails = () => { if (wide?.matches) $('#detailsBox').open = true; };
  wide?.addEventListener?.('change', syncDetails); syncDetails();
  window.addEventListener('pagehide', stopPolling);

  // U1 panel: one additive section under #detailsBody, loaded via a CSP-safe dynamic import
  // ('self' only). chat.mjs stays statically import-free on purpose: the offline UI tests
  // compile this file in a bare vm context where module imports are unavailable. If the
  // module cannot load, the panel simply stays off; the rest of /chat is unaffected.
  const renderUniversal = (snap) => {
    if (!universal) return;
    try { universal.show({ snapshot: snap, openTabs: S.targets?.targets ?? [], pageRead: S.transcript }); } catch (err) { console.warn('universal panel render skipped', err); }
  };
  let universal = null;
  universalRender = renderUniversal;
  // Only attempt the load in a real browser document (http/https origin). The offline test
  // harness compiles this file in a vm context where module resolution cannot work; there
  // the panel stays off without any warning or side effect.
  const inBrowser = typeof location !== 'undefined' && /^https?:$/.test(location?.protocol ?? '');
  if (inBrowser) try {
    import('./universal-chat.mjs').then((mod) => {
      const u1root = document.createElement('div');
      u1root.id = 'universalIntelligence';
      $('#detailsBody')?.appendChild(u1root);
      universal = mod.mountUniversalChat({ document, root: u1root,
        onInspect: ({ conversationId } = {}) => { if (conversationId && conversationId === S.snap?.id) reconcile('#reconcileError'); },
        onEvidence: () => { /* no verified evidence explorer yet: never navigate on unproven SID/seq */ },
        onReviewAdapter: () => { /* read-only adapter review has no verified producer yet */ },
      });
      renderUniversal(S.snap);
    }).catch((err) => console.warn('universal intelligence panel unavailable', err));
  } catch (err) { console.warn('universal intelligence panel unavailable', err); }

  render(); renderConnect();
  (async () => {
    await Promise.allSettled([loadTargets(), loadList()]);
    const saved = store.get('localStorage', SELECTED_KEY);
    const open = S.list.find((c) => c.id === saved)
      ?? S.list.find((c) => c.state === 'needs-reconciliation') ?? S.list.find((c) => c.state && c.state !== 'closed');
    const id = open?.id ?? (S.listState !== 'ok' ? saved : null);
    if (id) await openConversation(id);
    render();
  })();
}

if (typeof document !== 'undefined' && document.getElementById('chatApp')) boot();
