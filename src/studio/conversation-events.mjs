// Incremental conversation state events for harness clients, over the studio's existing
// EventFeed SSE contract (epoch:sequence delivery cursors, bounded process-local replay,
// reset on cursor loss, heartbeats, slow-client disconnect).
//
// This is a DERIVED read-model, deliberately: a bounded diff pump re-reads the runtime's own
// conversation views and publishes events per observed change. There is no second state store
// to diverge, no browser logic, and no new write path — the durable truth stays the conversation
// snapshot + thread-turn journal. The snapshot revision carried in every event is the durable
// state cursor; the SSE `id:` is only a delivery cursor.
//
// Reconnect contract (no blind replay): a client reconnects with Last-Event-ID / after and is
// replayed the retained window exactly once; if the cursor predates the retained window or the
// server restarted (epoch change), the client receives a `reset` event and re-reads state with
// an ordinary authenticated conversation GET. Events never instruct a resend; submission stays
// gated by the runtime (journal fence + writer window), so no event can cause a duplicate send.
//
// TWO feeds, ONE pump. The default feed carries lifecycle metadata ONLY (phases, send/reply
// states, revisions, writer and diagnostic accounting) — prompts and reply text are never
// included, so existing metadata-only clients keep their exact contract. Clients that opt in
// with `?include=text` subscribe to a separate feed that ALSO publishes `conversation.reply_text`:
// bounded snapshot events carrying the newest turn's reply text with its source confidence
// (network/page/differ) and attribution identity. Snapshots (not deltas) make any single event
// self-sufficient under bounded replay: a client that missed earlier events renders the latest
// snapshot correctly and re-reads full text via the authenticated conversation GET. Text is
// head-capped (truncated flag set); full bodies remain in the durable snapshot and saved session.
import { createHash } from 'node:crypto';
import { EventFeed } from './event-feed.mjs';
import { problem } from './http.mjs';

export const CONVERSATION_EVENT_TYPES = ['conversation.changed'];
export const CONVERSATION_TEXT_EVENT_TYPES = [...CONVERSATION_EVENT_TYPES, 'conversation.reply_text'];
export const REPLY_TEXT_EVENT = 'conversation.reply_text';
const DEFAULT_TEXT_LIMITS = Object.freeze({ maxChars: 16000 });

const turnProjection = (t) => ({ id: t.id, key: t.key, phase: t.phase, reason: t.reason ?? null,
  send: { state: t.send?.state ?? null, observationSource: t.send?.observationSource ?? null },
  reply: { state: t.reply?.state ?? null, completion: t.reply?.completion ?? null,
    revision: t.reply?.evidence?.revision ?? null, identity: t.reply?.evidence?.identity ?? null },
  readiness: t.readiness?.state ?? null, completion: t.completion?.state ?? null });

const projection = (v) => ({ conversationId: v.id, revision: v.revision, state: v.state, site: v.site,
  identity: v.identity ?? null, readiness: v.readiness ?? null,
  writer: { active: v.writer?.active === true, releaseError: v.writer?.releaseError ?? null },
  diagnostic: v.diagnostic ?? null, turns: (v.turns ?? []).map(turnProjection) });

// Bounded self-sufficient reply snapshot for the newest turn. source/identity keep the separation
// of state, content and source confidence: a client can never mistake page text for a matched
// network stream, and identity points at the durable reply evidence behind the text.
const textProjection = (v, maxChars) => {
  const t = v.turn, r = t?.reply;
  if (!t || !r) return null;
  const raw = typeof r.text === 'string' ? r.text : '';
  const truncated = raw.length > maxChars;
  return { conversationId: v.id, turnId: t.id, revision: v.revision,
    reply: { state: r.state ?? null, source: r.source ?? null, completion: r.completion ?? null,
      chars: r.chars ?? raw.length, text: truncated ? raw.slice(0, maxChars) : raw, truncated,
      identity: r.evidence?.identity ?? null, evidenceRevision: r.evidence?.revision ?? null },
    at: new Date().toISOString() };
};
const textKey = (snap) => snap === null ? null
  : `${snap.turnId}:${snap.reply.state}:${snap.reply.chars}:${createHash('sha256').update(snap.reply.text).digest('hex').slice(0, 16)}`;

export function createConversationEvents({ runtime, intervalMs = 200, feedOptions = {}, textFeedOptions = {}, textLimits = {} } = {}) {
  const maxChars = Number.isSafeInteger(textLimits.maxChars) && textLimits.maxChars > 0 && textLimits.maxChars <= 128000
    ? textLimits.maxChars : DEFAULT_TEXT_LIMITS.maxChars;
  const feed = new EventFeed({ eventTypes: CONVERSATION_EVENT_TYPES, ...feedOptions });
  // The opt-in text feed carries the metadata events too, so one subscription is sufficient.
  const textFeed = new EventFeed({ eventTypes: CONVERSATION_TEXT_EVENT_TYPES, ...textFeedOptions });
  const watched = new Map(); // conversation id -> { last: string|null, lastTextKey: string|null, missing: boolean }
  let timer = null;
  const start = () => { if (timer || watched.size === 0) return; timer = setInterval(() => { pump().catch(() => {}); }, intervalMs); timer.unref?.(); };
  const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
  async function pump() {
    for (const [id, state] of watched) {
      let view;
      try { view = await runtime.get(id); }
      catch (e) {
        // A vanished conversation is announced once; transient errors (closing, recovery,
        // corruption) are skipped and retried on the next tick — never guessed around.
        if (e?.status === 404 && !state.missing) {
          state.missing = true;
          feed.publish('conversation.changed', { conversationId: id, missing: true }, id);
          textFeed.publish('conversation.changed', { conversationId: id, missing: true }, id);
        }
        continue;
      }
      state.missing = false;
      const next = JSON.stringify(projection(view));
      if (next !== state.last) {
        state.last = next;
        const payload = JSON.parse(next);
        feed.publish('conversation.changed', payload, id);
        textFeed.publish('conversation.changed', payload, id);
      }
      const snap = textProjection(view, maxChars), key = textKey(snap);
      if (key !== state.lastTextKey) {
        state.lastTextKey = key;
        if (snap) textFeed.publish(REPLY_TEXT_EVENT, snap, id);
      }
    }
    if (watched.size === 0) stop();
  }
  return {
    feed,
    // Start (or idempotently keep) diffing a conversation. The first observation publishes a
    // baseline event so a fresh subscriber does not have to guess the current state.
    watch(id) {
      if (!watched.has(id)) watched.set(id, { last: null, lastTextKey: null, missing: false });
      start();
    },
    async subscribe(req, res, id, q = {}) {
      if (feed.closed || textFeed.closed) throw problem(503, 'Conversation event feed is closing');
      try { await runtime.get(id); } // Existence check: never stream an unknown conversation.
      catch (e) { throw e?.status ? e : problem(404, 'Conversation not found', 'CONVERSATION_NOT_FOUND'); }
      this.watch(id);
      // The session filter is forced to this conversation; clients cannot eavesdrop on others.
      // Default remains the metadata-only feed. `include=text` opts into bounded reply text.
      if (q.include !== undefined && q.include !== 'text') throw problem(400, 'Unknown include value; only "text" is supported');
      const withText = q.include === 'text';
      return (withText ? textFeed : feed).subscribe(req, res, { ...q, session: id }, {
        status: { conversationId: id, derived: 'conversation snapshot diff; reply text only on the include=text feed, bounded and snapshot-based', durable: false },
      });
    },
    info() { return { ...feed.info(), text: textFeed.info(), textLimits: { maxChars }, watched: [...watched.keys()] }; },
    close() { stop(); feed.close(); textFeed.close(); },
  };
}
