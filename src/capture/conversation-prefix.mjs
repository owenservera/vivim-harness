/**
 * Observed-prefix recovery (spec: docs/product/OBSERVED-PREFIX-RECOVERY-SPEC-2026-10-27.md).
 *
 * Pure helpers only: refusal-code vocabulary, the prefix identity/preimage digests, strict prefix
 * record validation, prompt-tier resolution, page-evidence checks and the narrow §11.3 guard
 * predicate. No filesystem, browser, network, recorder or journal access here, and no dependency on
 * conversation-service (the service imports this module, never the other way round).
 *
 * A prefix records a turn that already existed on the page before adoption. It is page-observed,
 * never journal-attributed: sendActor/dispatch/account are permanently "unknown".
 */
import { createHash } from 'node:crypto';
import { validThread } from './conversation-thread.mjs';

const sha256 = (text) => createHash('sha256').update(String(text), 'utf8').digest('hex');
const hex64 = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const id = (value) => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value);
const int = (value) => Number.isSafeInteger(value) && value >= 0;
const date = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value));
const code = (value) => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(value);
const failure = (value) => Object.assign(new Error(value), { code: value });

export const PREFIX_ORIGINS = Object.freeze(['https://chatgpt.com', 'https://chat.openai.com']);
export const PREFIX_STATES = Object.freeze(['pending', 'active', 'invalidated']);
export const PREFIX_PROMPT_SOURCES = Object.freeze(['capture-kv', 'page+snapshot-digest', 'owner-attested']);
export const PREFIX_CORROBORATION = Object.freeze(['terminal-complete', 'terminal-incomplete']);
export const PREFIX_SEND_ACTOR = 'unknown';
export const PREFIX_DISPATCH = 'unknown';
export const PREFIX_ACCOUNT = 'unknown';
export const PREFIX_ARRIVAL = 'page-observed';
export const PREFIX_COMPLETION = 'observed-complete';

// §8 refusal vocabulary. Every helper in this module throws one of these; nothing else.
export const PREFIX_CODES = Object.freeze([
  // Target
  'PREFIX_TARGET_NOT_FOUND', 'PREFIX_TARGET_NOT_PAGE', 'PREFIX_TARGET_ORIGIN_MISMATCH', 'PREFIX_TARGET_URL_UNSUPPORTED',
  'PREFIX_TARGET_AMBIGUOUS', 'PREFIX_TARGET_CHANGED', 'PREFIX_PAGE_THREAD_MISMATCH', 'PREFIX_THREAD_ID_MISMATCH',
  // Source
  'PREFIX_SOURCE_MISSING', 'PREFIX_SOURCE_CORRUPT', 'PREFIX_SOURCE_ATTEMPT_MISSING', 'PREFIX_SOURCE_ATTEMPT_NOT_CREATION',
  'PREFIX_SOURCE_ATTEMPTS_AMBIGUOUS', 'PREFIX_SOURCE_DIGEST_INVALID', 'PREFIX_SOURCE_KV_MISMATCH', 'PREFIX_SOURCE_STATE_UNEXPECTED',
  'PREFIX_SOURCE_ALREADY_ADOPTED',
  // Session
  'PREFIX_SESSION_OWNER_MISMATCH', 'PREFIX_SESSION_STILL_RECORDING', 'PREFIX_SESSION_METADATA_INVALID',
  // Page
  'PREFIX_PAGE_UNREADABLE', 'PREFIX_PAGE_SHAPE_MISMATCH', 'PREFIX_PAGE_HISTORY_INCOMPLETE', 'PREFIX_USER_TURN_MISSING',
  'PREFIX_USER_TURN_ID_MISSING', 'PREFIX_REPLY_MISSING', 'PREFIX_PAGE_TEXT_MISMATCH', 'PREFIX_PROMPT_UNVERIFIED',
  'PREFIX_CONTROLS_NOT_IDLE', 'PREFIX_DRAFT_PRESENT', 'PREFIX_REPLY_UNSTABLE', 'PREFIX_THREAD_DENYLISTED',
  'PREFIX_THREAD_BOUND_ELSEWHERE',
  // Lifecycle
  'PREFIX_WRITER_BUSY', 'PREFIX_IDEMPOTENCY_CONFLICT', 'PREFIX_PENDING_UNRESOLVED', 'PREFIX_NOT_ACTIVE', 'PREFIX_INVALIDATED',
  'PREFIX_CORRUPT_OR_UNREADABLE_SNAPSHOT', 'PREFIX_PERSISTENCE_FAILED_REOPEN_REQUIRED',
  // Continuation
  'PREFIX_AUDIT_REQUIRED', 'PREFIX_AUDIT_FAILED', 'PREFIX_REPLY_CHANGED', 'PREFIX_USER_MESSAGE_MISSING',
]);
export const isPrefixCode = (value) => typeof value === 'string' && PREFIX_CODES.includes(value);
export const sha256Hex = sha256;

// §10.4: one adoption identity per (source conversation, source attempt, thread, prompt digest).
export function prefixId({ conversationId, attemptId, threadRef, promptDigest } = {}) {
  if (!id(conversationId) || !id(attemptId) || !id(threadRef) || !hex64(promptDigest)) throw failure('PREFIX_SOURCE_DIGEST_INVALID');
  return sha256(`${conversationId}:${attemptId}:${threadRef}:${promptDigest}`);
}

// The immutable tuple that defines an adoption. Any drift between the staged record and a fresh
// read refuses continuation (PREFIX_PENDING_UNRESOLVED / PREFIX_INVALIDATED), never auto-activates.
const preimageParts = (p) => [p.source?.conversationId, p.source?.attemptId, p.prompt?.digest, p.thread?.ref,
  p.target?.targetId, p.target?.origin, p.userMessage?.id, p.userMessage?.digest, p.userMessage?.chars,
  p.assistant?.id, p.assistant?.digest, p.assistant?.chars];
export const preimageDigest = (prefix) => sha256(JSON.stringify(preimageParts(prefix)));

// The same tuple derived from one page read, so a read can be compared with a staged record.
export function readSignature(read) {
  const user = read?.messages?.[0], assistant = read?.messages?.[1];
  return { source: null, prompt: null,
    thread: { ref: read?.thread?.ref }, target: { targetId: read?.targetId, origin: read?.origin },
    userMessage: { id: user?.id, digest: sha256(user?.text ?? ''), chars: String(user?.text ?? '').length },
    assistant: { id: assistant?.id, digest: sha256(assistant?.text ?? ''), chars: String(assistant?.text ?? '').length } };
}

// null when the read still shows exactly the observed prefix; otherwise the specific refusal code.
export function comparePrefixRead(prefix, read) {
  if (read?.thread?.ref !== prefix?.thread?.ref || read?.targetId !== prefix?.target?.targetId || read?.origin !== prefix?.target?.origin) return 'PREFIX_TARGET_CHANGED';
  const user = read?.messages?.[0];
  if (!user || user.id !== prefix?.userMessage?.id || sha256(user.text ?? '') !== prefix?.userMessage?.digest || String(user.text ?? '').length !== prefix?.userMessage?.chars) return 'PREFIX_USER_MESSAGE_MISSING';
  const assistant = read?.messages?.[1];
  if (!assistant || assistant.id !== prefix?.assistant?.id || sha256(assistant.text ?? '') !== prefix?.assistant?.digest || String(assistant.text ?? '').length !== prefix?.assistant?.chars) return 'PREFIX_REPLY_CHANGED';
  return null;
}

// §10.1 schema, additive to the conversation snapshot. A prefix that cannot be proven field by
// field is corrupt state, never a partially trusted record.
export function validPrefixRecord(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return false;
  if (p.kind !== 'observed-prefix' || p.schema !== 1 || !PREFIX_STATES.includes(p.state)) return false;
  if (!hex64(p.prefixId) || !hex64(p.preimageDigest) || !date(p.observedAt)) return false;
  if (!p.source || !id(p.source.conversationId) || !id(p.source.attemptId) || !id(p.source.sessionId)
    || p.source.phase !== 'uncertain' || p.source.journalless !== true) return false;
  if (!validThread(p.thread) || !p.thread) return false;
  if (!p.target || !id(p.target.targetId) || !PREFIX_ORIGINS.includes(p.target.origin)) return false;
  if (!p.prompt || !hex64(p.prompt.digest) || !int(p.prompt.chars) || !PREFIX_PROMPT_SOURCES.includes(p.prompt.source)) return false;
  if (!p.userMessage || !id(p.userMessage.id) || p.userMessage.index !== 0 || !hex64(p.userMessage.digest) || !int(p.userMessage.chars)) return false;
  if (!p.assistant || !id(p.assistant.id) || p.assistant.index !== 1 || !hex64(p.assistant.digest)
    || !int(p.assistant.chars) || p.assistant.chars <= 0 || p.assistant.completion !== PREFIX_COMPLETION) return false;
  // §7: these four fields are not free text. A snapshot that says anything else is rejected.
  if (p.sendActor !== PREFIX_SEND_ACTOR || p.dispatch !== PREFIX_DISPATCH || p.account !== PREFIX_ACCOUNT || p.arrival !== PREFIX_ARRIVAL) return false;
  if (!p.capture || !id(p.capture.sessionId) || !id(p.capture.status) || !id(p.capture.endReason)
    || typeof p.capture.integrityOk !== 'boolean' || !PREFIX_CORROBORATION.includes(p.capture.corroboration)) return false;
  if (!Array.isArray(p.reads) || p.reads.length < 2 || p.reads.length > 8) return false;
  if (!p.reads.every((r) => r && date(r.at) && hex64(r.assistantDigest) && r.controls === 'idle')) return false;
  if (p.state === 'pending' && p.adoptedAt !== null) return false;
  if (p.state === 'active' && !date(p.adoptedAt)) return false;
  if (p.state === 'invalidated' && (!code(p.reason) || !date(p.invalidatedAt) || !(p.adoptedAt === null || date(p.adoptedAt)))) return false;
  return true;
}

// §5.3 tiers A-D. `kv` is the persisted CONVERSATION_ATTEMPT record (final file only; a .tmp
// remnant is never evidence) and `corroboration` says whether the capture session is settled clean.
export function resolvePromptTier({ digest, kv = null, pageUserText = '', attestation = null, corroboration = 'terminal-complete' } = {}) {
  if (!hex64(digest)) throw failure('PREFIX_SOURCE_DIGEST_INVALID');
  const text = String(pageUserText ?? '');
  const pageMatches = sha256(text) === digest;
  const kvMatches = !!kv && kv.payloadDigest === digest;
  if (kvMatches && corroboration === 'terminal-complete' && pageMatches) return { source: 'capture-kv', digest, chars: String(kv.prompt ?? '').length };
  if (attestation !== null && (typeof attestation !== 'string' || sha256(attestation) !== digest)) throw failure('PREFIX_PROMPT_UNVERIFIED');
  if (pageMatches && (!kvMatches || corroboration !== 'terminal-complete')) return { source: 'page+snapshot-digest', digest, chars: text.length };
  if (typeof attestation === 'string' && sha256(attestation) === digest && text === attestation.replace(/\r\n/g, '\n')) {
    return { source: 'owner-attested', digest, chars: attestation.length };
  }
  // A corroborated digest that the page contradicts is a page change, not an unverified prompt.
  throw failure(kvMatches && !pageMatches ? 'PREFIX_PAGE_TEXT_MISMATCH' : 'PREFIX_PROMPT_UNVERIFIED');
}

// §6 P1-P5, P7, P8 and the N5 truncation rule. P6 (digest) and P9 (stability) are resolved by the
// caller so the specific refusal code can be chosen from the evidence.
export function checkPrefixPage(read) {
  const messages = read?.messages;
  if (!read || typeof read !== 'object' || !Array.isArray(messages) || messages.length === 0
    || !read.draft || typeof read.draft.present !== 'boolean' || !int(read.draft.chars)
    || !read.controls || typeof read.controls.observed !== 'boolean' || typeof read.controls.state !== 'string'
    || typeof read.controls.idleControlPresent !== 'boolean' || typeof read.controls.stopPresent !== 'boolean'
    || typeof read.controls.composerEnabled !== 'boolean') throw failure('PREFIX_PAGE_UNREADABLE');
  // N5: a bounded read can never prove the full message; the caller must re-run with a larger cap.
  if (messages.some((m) => !m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.text !== 'string'
    || !int(m.chars) || m.chars !== m.text.length)) throw failure('PREFIX_PAGE_UNREADABLE');
  if (read.renderedTotal !== 2 || messages.length !== 2
    || read.hiddenSkipped !== 0 || read.nestedDropped !== 0 || read.ambiguousSkipped !== 0) throw failure('PREFIX_PAGE_SHAPE_MISMATCH');
  if (read.scroll?.found !== true || read.scroll?.topReached !== true) throw failure('PREFIX_PAGE_HISTORY_INCOMPLETE');
  const [user, assistant] = messages;
  if (user.role !== 'user') throw failure('PREFIX_USER_TURN_MISSING');
  if (!id(user.id) || user.idSource !== 'data-message-id') throw failure('PREFIX_USER_TURN_ID_MISSING');
  if (assistant.role !== 'assistant' || !id(assistant.id) || assistant.idSource !== 'data-message-id' || assistant.id === user.id || assistant.text.length === 0) throw failure('PREFIX_REPLY_MISSING');
  const c = read.controls;
  if (!(c.observed === true && c.state === 'idle' && c.idleControlPresent === true && c.stopPresent === false && c.composerEnabled === true)) throw failure('PREFIX_CONTROLS_NOT_IDLE');
  if (read.draft.present !== false || read.draft.chars !== 0) throw failure('PREFIX_DRAFT_PRESENT');
  return { user, assistant };
}

// §6 P9: the repeat read must show the same assistant message, byte for byte and character for
// character, and the same target/thread/user message.
export function comparePrefixReads(first, second) {
  const a = readSignature(first), b = readSignature(second);
  if (a.thread.ref !== b.thread.ref || a.target.targetId !== b.target.targetId || a.target.origin !== b.target.origin) return 'PREFIX_TARGET_CHANGED';
  if (a.userMessage.id !== b.userMessage.id || a.userMessage.digest !== b.userMessage.digest) return 'PREFIX_USER_MESSAGE_MISSING';
  if (a.assistant.id !== b.assistant.id || a.assistant.digest !== b.assistant.digest || a.assistant.chars !== b.assistant.chars) return 'PREFIX_REPLY_UNSTABLE';
  return null;
}

// §11.2: the descriptor the adapter audits inside its one pre-send page read. Metadata only.
export const prefixDescriptor = (p) => ({ userMessageId: p?.userMessage?.id, userMessageDigest: p?.userMessage?.digest,
  assistantMessageId: p?.assistant?.id, assistantDigest: p?.assistant?.digest, assistantChars: p?.assistant?.chars });

// §11.3(b)-(e): the ONLY case in which the legacy journal-less attempt stops fencing the thread.
// Returns the source conversation id whose guard entry may be skipped, or null.
export function prefixGuardSource({ prefixSource = null, sourceSnapshot = null, prefixRecords = [], origin, threadRef } = {}) {
  if (!prefixSource || !id(prefixSource.conversationId) || !id(prefixSource.attemptId) || !id(threadRef)) return null;
  const snapshot = sourceSnapshot;
  if (!snapshot || snapshot.id !== prefixSource.conversationId || !Array.isArray(snapshot.attempts) || snapshot.attempts.length !== 1) return null;
  const attempt = snapshot.attempts[0];
  if (attempt?.id !== prefixSource.attemptId || attempt?.creation !== true || attempt?.phase !== 'uncertain' || attempt?.journal) return null;
  if (!hex64(attempt.payloadDigest)) return null;
  if (prefixSource.payloadDigest !== undefined && prefixSource.payloadDigest !== attempt.payloadDigest) return null;
  const record = prefixRecords.find((r) => r?.prefix?.state === 'pending'
    && r.prefix.source?.conversationId === prefixSource.conversationId
    && r.prefix.source?.attemptId === prefixSource.attemptId
    && r.prefix.thread?.ref === threadRef
    && r.prefix.target?.origin === origin
    && r.prefix.prompt?.digest === attempt.payloadDigest);
  return record ? prefixSource.conversationId : null;
}

export { sha256 };
