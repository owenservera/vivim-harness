// Shared disposable fixture for the observed-prefix tests (spec:
// docs/product/OBSERVED-PREFIX-RECOVERY-SPEC-2026-10-27.md §13.2). Not a test file itself.
//
// Everything here is synthetic: a temporary root, a settled source capture with one journal-less
// uncertain creation attempt, a fake DevTools target list and a fake page. No browser, no CDP, no
// network, no provider, and nothing under C:\VIVIM is read or written.
//
// Adoption is exercised as the three-step product flow:
//   1. bindObservedPrefix  -> T/O/P reads, then a NEW conversation snapshot with prefix.state='pending'
//   2. connect({prefixSource}) -> narrow §11.3 admission, page re-read, prefix.state='active'
//   3. submit              -> ordinary turn 2 through the existing journal path
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createConversationRuntime } from '../../src/capture/conversation-runtime.mjs';
import { createConversationBrowserAdapter } from '../../src/capture/conversation-browser-adapter.mjs';

export const THREAD = '44444444-4444-4444-8444-444444444444';
export const OTHER_THREAD = '55555555-5555-4555-8555-555555555555';
export const PROMPT = 'For a fictional project called Harbor, remember two requirements: local-first storage and JSON export. Briefly confirm them.';
export const REPLY = 'Confirmed: local-first storage and JSON export.';
export const TURN2 = 'Second turn: keep both requirements, then add a one-line summary.';
export const REPLY2 = 'Both requirements kept: local-first storage and JSON export.';
export const sha = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
export const idle = () => ({ observed: true, state: 'idle', idleControlPresent: true, stopPresent: false, composerEnabled: true });

// The raw shape `transcriptExpression` returns for a fresh two-message thread.
export const rawPage = (overrides = {}) => ({
  origin: 'https://chatgpt.com', pathname: `/c/${THREAD}`, renderedTotal: 2,
  messages: [
    { role: 'user', id: 'user-1', text: PROMPT, chars: PROMPT.length, idSource: 'data-message-id' },
    { role: 'assistant', id: 'assistant-1', text: REPLY, chars: REPLY.length, idSource: 'data-message-id' },
  ],
  hiddenSkipped: 0, nestedDropped: 0, ambiguousSkipped: 0,
  scroll: { found: true, topReached: true, bottomReached: true },
  draft: { present: false, chars: 0 }, controls: idle(), ...overrides,
});

export function workspace(t, options = {}) {
  const {
    sourceStatus = 'complete', kv = 'present', prompt = PROMPT, digest = sha(PROMPT), bound = true,
    attemptPatch = {}, sourcePatch = {}, sessionPatch = {}, session = 'present', page = rawPage(),
    targets, extraConversations = [], appendOnSend = false, appendReply = false, corruptSource = false,
    evaluatePage = null, prefixStabilityMs = 0, replySettleMs = 0, afterRead = null,
  } = options;
  const pages = options.pages ?? [page];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'conversation-prefix-'));
  const paths = { root, sessions: path.join(root, 'sessions') };
  const conversations = path.join(root, 'conversations');
  fs.mkdirSync(conversations, { recursive: true });
  const conversationId = 'harbor-source';
  const attemptId = '00000000-0000-4000-8000-00000000000a';
  const sessionId = '20261027-120000-chatgpt-abcdef';
  const at = '2026-10-27T09:00:00.000Z';
  const attempt = { id: attemptId, key: 'one', payloadDigest: digest, phase: 'uncertain', createdAt: at, updatedAt: at,
    creation: true, boundary: { sequence: 3, transcriptCount: 0 }, send: { state: 'uncertain', observationSource: null },
    reply: { state: 'unknown', source: 'page', text: '', completion: 'unknown' }, evidence: { state: 'recording' },
    preEffect: null, reason: 'CREATION_UNPINNED', ...attemptPatch };
  const source = { version: 1, id: conversationId, revision: 2, state: 'needs-reconciliation',
    binding: { targetId: 'tab-1', origin: 'https://chatgpt.com', ownedByStudio: true }, sessionId,
    identity: { state: 'unbound', reason: 'NEW_CHAT' }, site: 'chatgpt', owner: null,
    attempts: [attempt], assertions: [], uncertainty: 'CREATION_UNPINNED',
    finish: { requested: false, phase: 'idle', error: null }, createdAt: at, updatedAt: at,
    reply: { state: 'unknown', source: 'page', text: '', chars: 0, completion: 'unknown' },
    capture: { state: 'incomplete', integrity: null }, limitations: [],
    readiness: { ready: false, draft: { present: null, chars: null }, reason: 'CREATION_UNPINNED' },
    ...sourcePatch };
  if (bound) fs.writeFileSync(path.join(conversations, `${conversationId}.conversation.json`), corruptSource ? '{"version":1,' : JSON.stringify(source));
  for (const extra of extraConversations) fs.writeFileSync(path.join(conversations, `${extra.id}.conversation.json`), JSON.stringify(extra.snapshot));
  const sessionDir = path.join(paths.sessions, sessionId);
  fs.mkdirSync(path.join(sessionDir, 'kv'), { recursive: true });
  if (session === 'present') fs.writeFileSync(path.join(sessionDir, 'session.json'), JSON.stringify({ id: sessionId, site: 'chatgpt', createdAt: at,
    status: sourceStatus, endedAt: at, endReason: 'conversation_turn',
    integrity: { ok: true, records: 12, gapRecords: 0, droppedRecords: 0 },
    conversationOwner: { conversationId, pid: 4242, token: null, port: 1 },
    target: { id: 'tab-1', url: `https://chatgpt.com/c/${THREAD}` }, ...sessionPatch }));
  if (session === 'corrupt') fs.writeFileSync(path.join(sessionDir, 'session.json'), '{"id":');
  const kvRecord = { baseline: [], boundary: { sessionId, sequence: 3, transcriptCount: 0 }, creation: true,
    turnId: attemptId, prompt, payloadDigest: digest, samples: [] };
  const kvFile = path.join(sessionDir, 'kv', `CONVERSATION_ATTEMPT_${attemptId}.json`);
  if (kv === 'present' || kv === 'tmp') fs.writeFileSync(kvFile + (kv === 'tmp' ? '.tmp' : ''), JSON.stringify(kvRecord));
  if (kv === 'corrupt') fs.writeFileSync(kvFile, '{"prompt":');
  if (kv === 'mismatch') fs.writeFileSync(kvFile, JSON.stringify({ ...kvRecord, payloadDigest: sha('other prompt'),
    boundary: { sessionId, sequence: 9, transcriptCount: 0 } }));

  const state = {
    targets: targets ?? [{ id: 'tab-1', type: 'page', url: `https://chatgpt.com/c/${THREAD}` }],
    messages: page.messages.map((m) => ({ id: m.id, role: m.role, text: m.text })),
    draft: '', sends: 0, insertions: 0, pageReads: 0, typed: null, prefixAudits: 0, preflights: 0, adapters: [],
    readPage: () => pages[Math.min(state.pageReads - 1, pages.length - 1)] ?? page,
  };
  const listTargets = async () => state.targets;
  class FakeRecorder {
    constructor() { this.state = 'idle'; this.page = { send: async () => ({}) }; }
    on() {}
    tap() { return { close() {} }; }
    async start({ onSessionCreated }) {
      this.session = { id: `cap-${state.sends + 1}-${state.insertions}`, raw: { seq: 10, stats: { bytes: 1 } }, kv: { set() {}, get() {} } };
      onSessionCreated(this.session); this.state = 'recording'; return this.session;
    }
    recordConversationObservation() { return ++this.session.raw.seq; }
    async stop() { this.state = 'idle'; return { verify: { ok: true } }; }
  }
  const adapterDependencies = {
    Recorder: FakeRecorder, listTargets, listSessions: () => [],
    evaluate: async (_, expression) => (expression === 'location.origin' ? 'https://chatgpt.com' : `/c/${THREAD}`),
    readPrefixPage: async () => { state.pageReads++; const out = structuredClone(state.readPage()); await afterRead?.(state.pageReads, state); return out; },
    readTurnPage: async () => ({ origin: 'https://chatgpt.com', pathname: `/c/${THREAD}`,
      messages: structuredClone(state.messages), draft: { text: state.draft, chars: state.draft.length }, controls: idle() }),
    findComposer: async () => ({ found: true }), focusComposer: async () => ({ ok: true }),
    sendState: async () => ({ evalOk: true, draftChars: state.draft.length }),
    detectAuthWall: async () => ({ blocked: false }), detectSiteFailure: async () => ({ failed: false }),
    sleep: async () => {}, readinessTimeoutMs: 200, readinessPollMs: 1, replySettleMs,
    fetchTimeoutMs: 200, connectGraceMs: 20, replyPollMs: 1, replyTimeoutMs: 200,
    typeText: async (_page, value, opts) => { await opts.beforeInsert?.(); state.insertions++; state.draft = value; state.typed = value; return { ok: true, typed: value }; },
    sendMessage: async () => {
      state.sends++; state.draft = '';
      if (appendOnSend && state.typed) state.messages.push({ id: `user-${state.messages.length + 1}`, role: 'user', text: state.typed });
      if (appendReply) state.messages.push({ id: `assistant-${state.messages.length + 1}`, role: 'assistant', text: REPLY2 });
      return { dispatched: true, uncertain: true };
    },
    ...(evaluatePage ? { evaluate: evaluatePage } : {}),
  };
  const dependencies = {
    leaseRoot: path.join(root, 'leases'), listSessions: () => [], ownerIsAlive: () => false, listTargets,
    sleep: async () => {}, prefixStabilityMs,
    getAdapter: async (value) => (value === 'chatgpt' || String(value).startsWith('https://chatgpt.com'))
      ? { id: 'chatgpt', url: 'https://chatgpt.com/' } : null,
    createAdapter: (options) => { const adapter = createConversationBrowserAdapter({ ...options, dependencies: adapterDependencies }); state.adapters.push(adapter); return adapter; },
  };
  const runtime = createConversationRuntime({ paths, port: 19271, profileStore: { load() { return {}; } }, dependencies });
  t.after(async () => { await runtime.close().catch(() => {}); fs.rmSync(root, { recursive: true, force: true }); });
  const sourceFile = path.join(conversations, `${conversationId}.conversation.json`);
  const files = () => fs.readdirSync(conversations).sort();
  const prefixSource = (extra = {}) => ({ conversationId, attemptId, payloadDigest: digest, ...extra });
  const bind = (body = {}) => runtime.bindObservedPrefix({ site: 'chatgpt', targetId: 'tab-1',
    expectedThread: `chatgpt-c:${THREAD}`, source: { conversationId, attemptId }, ...body });
  const connect = (body = {}) => runtime.connect({ site: 'chatgpt', targetId: 'tab-1',
    expectedThread: `chatgpt-c:${THREAD}`, prefixSource: prefixSource(), ...body });
  const submit = (c, body = {}) => runtime.submit(c.id, { key: 'two', prompt: TURN2, confirm: true, expectedRevision: c.revision, ...body });
  return { runtime, paths, dependencies, state, conversations, sourceFile, files, bind, connect, submit,
    conversationId, attemptId, sessionId, sourceSnapshot: source, leaseRoot: path.join(root, 'leases'), digest, prefixSource };}
