// Adversarial browser-adapter fixture (offline only). Fake Recorder, fake CDP helpers and a
// scripted page transcript, matching the real dependency contract used by
// createConversationBrowserAdapter. No browser, no network, no credentials, no provider.
//
// Differences from test/unit/conversation-multiturn-adapter.test.mjs's local fixture:
//  - every persisted observation is kept WITH its payload size, so write amplification is measurable;
//  - the page transcript can be mutated between polls from a script (including id swaps);
//  - readTurnPage calls are counted so a test can prove one persisted record per poll.
import { createHash } from 'node:crypto';
import { createConversationBrowserAdapter } from '../../src/capture/conversation-browser-adapter.mjs';

const sha = (v) => createHash('sha256').update(v).digest('hex');
export const THREAD_ID = '11111111-1111-4111-8111-111111111111';
export const THREAD = { kind: 'chatgpt-c', id: THREAD_ID, ref: `chatgpt-c:${THREAD_ID}` };
export const IDLE = { observed: true, state: 'idle', idleControlPresent: true, stopPresent: false, composerEnabled: true };
export const msg = (id, role, text) => ({ id, role, text });

export function createAdversarialFixture({ replyTimeoutMs = 40, replySettleMs = 0, replySettlePolls = 1 } = {}) {
  const calls = [];
  const observations = [];
  const store = new Map();
  let messages = [msg('u0', 'user', 'first prompt'), msg('a0', 'assistant', 'first answer')];
  let draft = '', pathname = `/c/${THREAD_ID}`, controls = IDLE, sessions = 0, readTurnCalls = 0;
  let onPoll = null;

  class FakeRecorder {
    constructor() { this.state = 'idle'; this.page = { send: async (method) => { calls.push([method]); return {}; } }; }
    on() {}
    tap() { return { close() {} }; }
    async start(options) {
      sessions++;
      this.session = { id: `session-${sessions}`, raw: { seq: 100, stats: { bytes: 1 } }, kv: { set: (k, v) => store.set(k, v) } };
      options.onSessionCreated(this.session); this.state = 'recording'; return this.session;
    }
    // Mirrors Recorder.recordConversationObservation's observable contract: durable sequence + the
    // full payload that would be written to the raw log.
    recordConversationObservation(record) {
      const sequence = ++this.session.raw.seq;
      const payload = { ...record, binding: record.binding, text: record.text };
      observations.push({ sequence, kind: record.kind, source: record.source, identity: record.identity,
        turnId: record.turnId, text: record.text, chars: record.text?.length ?? 0,
        bytes: Buffer.byteLength(JSON.stringify(payload), 'utf8'), record: payload });
      return sequence;
    }
    async stop() { this.state = 'idle'; return { verify: { ok: true } }; }
  }

  const binding = { targetId: 'selected', origin: 'https://chatgpt.com', ownedByStudio: false, thread: THREAD };
  const adapter = createConversationBrowserAdapter({
    paths: { sessions: 'unused' }, profileStore: { load: () => ({}) }, port: 19222,
    siteAdapter: { id: 'chatgpt', url: 'https://chatgpt.com/' }, targetId: 'selected', freshTab: false,
    conversationId: 'conv', ownerToken: 'owner',
    dependencies: {
      Recorder: FakeRecorder, listSessions: () => [], sleep: async () => {}, replyPollMs: 1,
      replyTimeoutMs, replySettleMs, replySettlePolls, checkAgainTimeoutMs: 5, readinessPollMs: 1,
      listTargets: async () => [{ id: 'selected', url: `https://chatgpt.com${pathname}` }],
      evaluate: async (_, expression) => expression === 'location.pathname' ? pathname : 'https://chatgpt.com',
      findComposer: async () => ({ found: true }), focusComposer: async () => ({ ok: true }),
      readTurnPage: async () => {
        readTurnCalls++;
        if (onPoll) onPoll(readTurnCalls);
        return { origin: 'https://chatgpt.com', pathname, messages: structuredClone(messages),
          draft: { text: draft, chars: draft.length }, controls: structuredClone(controls) };
      },
      sendState: async () => ({ evalOk: true, draftChars: draft.length }),
      typeText: async (_, prompt, options) => { await options.beforeInsert(); draft = prompt; return { ok: true, typed: prompt }; },
      sendMessage: async () => { calls.push(['send']); draft = '';
        messages = [...messages, msg('u-new', 'user', promptForSend)];
        return { dispatched: true, sendStatus: 'dispatched' }; },
      detectAuthWall: async () => ({ blocked: false }), detectSiteFailure: async () => ({ failed: false }),
    },
  });
  let promptForSend = '';
  const hooks = { bind() {}, ownSession() {} };

  return {
    adapter, binding, calls, observations, hooks,
    setMessages: (v) => { messages = v; }, getMessages: () => messages,
    setControls: (v) => { controls = v; }, setPathname: (v) => { pathname = v; },
    setOnPoll: (fn) => { onPoll = fn; },
    getReadTurnCalls: () => readTurnCalls,
    args: (turnId, prompt) => ({ binding: { ...binding }, turnId, payloadDigest: sha(prompt), threadKey: 'test-thread-key' }),
    async connectAndArm() { await adapter.connect({ ...binding }, hooks); return adapter.armCapture(); },
    async sendTurn(turnId, prompt, priorTurns = []) {
      await adapter.connect({ ...binding }, hooks);
      await adapter.armCapture();
      promptForSend = prompt;
      const preflight = await adapter.preflight(undefined, { priorTurns });
      await adapter.type({ prompt, turnId });
      const submitted = await adapter.submit({ turnId, payloadDigest: sha(prompt) });
      return { preflight, submitted };
    },
  };
}
