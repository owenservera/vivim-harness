// Opt-in bridge: an ALREADY-STORED, ALREADY-OBSERVED provider reply -> a PROPOSED local Work item.
// Pure consumption: the only conversation capability received is a stored-snapshot reader (the same
// read-only seam as get_conversation). This module never submits, reads a live page, reconciles,
// resends, opens a browser, or touches the network. Preview writes nothing. Apply never happens
// implicitly: it needs explicit 'user-confirmed' approval, a matching reply digest and the CAS version,
// and then persists through the unchanged Work CRUD (agent.createWorkItem).
import { createHash } from 'node:crypto';
import { problem } from '../studio/http.mjs';

export const PROVIDER_REPLY_SOURCE = 'provider-reply';
// The stored Work shape has no tag field (title/objective only), so tags are proposal metadata that is
// also written into the objective header; the stored record itself is produced by createWork unchanged.
export const PROVIDER_REPLY_TAGS = Object.freeze(['ai-proposed', 'provider-reply', 'unverified']);
const CONVERSATION_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const TITLE_MAX = 160, OBJECTIVE_MAX = 4000, TRUNCATED = '\n…[truncated]';
const CONTROL = /[\u0000-\u001f\u007f]/;
const DIGEST = /^[a-f0-9]{64}$/;
const digestOf = text => createHash('sha256').update(text, 'utf8').digest('hex');
// Cut to at most `max` UTF-16 units without leaving a lone high surrogate (a split emoji) at the end.
const cut = (text, max) => {
  const head = text.slice(0, Math.max(0, max));
  return /[\uD800-\uDBFF]$/.test(head) ? head.slice(0, -1) : head;
};

// First meaningful line with markdown decoration removed (quote/heading/list markers, emphasis, code
// ticks), bounded to the Work title limit. Code-fence lines and rules are skipped, and a title that
// merely starts with a number ("3 ideas for…", "2027 plan") keeps it; only "1." / "2)" list markers go.
function titleFrom(replyText) {
  const line = replyText.split(/\r?\n/)
    .filter(row => !/^\s*(```|~~~)/.test(row))
    .map(row => row.replace(/^\s*(?:>\s*)*(?:#{1,6}\s+|[-*+]\s+|\d{1,3}[.)]\s+)?/, '')
      .replace(/\*\*|__|[*`]/g, '').replace(/\s+/g, ' ').trim())
    .find(row => row.length > 0 && !/^[-=_*\s]+$/.test(row)) ?? 'Provider reply';
  return line.length > TITLE_MAX ? cut(line, TITLE_MAX - 1).trimEnd() + '…' : line;
}

function objectiveFrom(replyText, provenance) {
  const header = `[AI-proposed, unverified · tags: ${PROVIDER_REPLY_TAGS.join(', ')}] From stored provider reply ` +
    `${provenance.conversationId}/${provenance.turnId} (sha256 ${provenance.replyDigest.slice(0, 16)}). ` +
    'Not human-authored; no provider request was made.\n\n';
  const room = OBJECTIVE_MAX - header.length;
  const body = replyText.trim();
  return header + (body.length <= room ? body : cut(body, room - TRUNCATED.length).trimEnd() + TRUNCATED);
}

export function createProviderReplyWork({ agent, readStoredConversation } = {}) {
  if (!agent || typeof agent.status !== 'function' || typeof agent.createWorkItem !== 'function') {
    throw new TypeError('personal agent service required');
  }
  async function observedReply({ conversation, turnId }) {
    if (typeof readStoredConversation !== 'function') {
      throw problem(501, 'Stored conversation reader unavailable', 'PROVIDER_REPLY_UNAVAILABLE');
    }
    if (typeof conversation !== 'string' || !CONVERSATION_ID.test(conversation)) {
      throw problem(400, 'Invalid conversation id', 'PROVIDER_REPLY_INVALID');
    }
    // Control characters would forge extra lines in the objective header that cites this turn.
    if (typeof turnId !== 'string' || !turnId || turnId.length > 200 || CONTROL.test(turnId)) {
      throw problem(400, 'An explicit turn id is required', 'PROVIDER_REPLY_INVALID');
    }
    const stored = await readStoredConversation(conversation);
    const turn = Array.isArray(stored?.turns) ? stored.turns.find(item => item?.id === turnId) : null;
    if (!turn) throw problem(404, 'Stored turn not found', 'PROVIDER_REPLY_NOT_FOUND');
    const reply = turn.reply;
    if (reply?.state !== 'ready') throw problem(409, 'Stored reply is not settled', 'PROVIDER_REPLY_NOT_READY');
    if (typeof reply.text !== 'string' || !reply.text.trim()) {
      throw problem(409, 'Stored reply has no text', 'PROVIDER_REPLY_EMPTY');
    }
    const provenance = {
      source: PROVIDER_REPLY_SOURCE, conversationId: conversation, turnId,
      replyState: reply.state, replyChars: reply.text.length, replyDigest: digestOf(reply.text),
      humanAuthored: false, providerCalled: false, trust: 'untrusted-until-user-approves',
      qualification: 'Text of a reply already stored by the Harness. Not human-authored; authenticity not verified; no new provider request was made.',
    };
    return {
      provenance,
      proposal: { title: titleFrom(reply.text), objective: objectiveFrom(reply.text, provenance), tags: [...PROVIDER_REPLY_TAGS] },
      // Same conversation+turn+content always maps to the same Work id, so a retry never duplicates.
      idempotencyKey: 'pr-' + digestOf(`${conversation}\0${turnId}\0${provenance.replyDigest}`).slice(0, 40),
    };
  }
  async function preview({ conversation, turnId } = {}) {
    const { proposal, provenance } = await observedReply({ conversation, turnId });
    const current = agent.status();
    const ready = current.initialized === true;
    // Re-previewing an already-saved reply should say so (apply would just replay the same item).
    const saved = ready && typeof agent.workList === 'function'
      ? (agent.workList().items ?? []).find(item => item?.title === proposal.title && item?.objective === proposal.objective) ?? null
      : null;
    return {
      source: PROVIDER_REPLY_SOURCE, provenance, proposal, effects: 'none', approvalRequired: true,
      canApply: ready, baseVersion: ready ? current.version : null,
      alreadySaved: saved ? { id: saved.id, status: saved.status } : null,
      note: !ready ? 'Initialize the Personal Agent before applying.'
        : saved ? 'This reply is already saved as Work; applying again changes nothing.'
          : 'Preview only: nothing was saved. Apply requires explicit approval.',
    };
  }
  async function apply({ conversation, turnId, replyDigest, expectedVersion, approval } = {}) {
    if (approval !== 'user-confirmed') {
      throw problem(400, 'Explicit user-confirmed approval required', 'PROVIDER_REPLY_APPROVAL_REQUIRED');
    }
    if (typeof replyDigest !== 'string' || !DIGEST.test(replyDigest)) {
      throw problem(400, 'replyDigest from the preview is required; preview the reply first', 'PROVIDER_REPLY_INVALID');
    }
    const { proposal, provenance, idempotencyKey } = await observedReply({ conversation, turnId });
    if (replyDigest !== provenance.replyDigest) {
      throw problem(409, 'Stored reply changed since it was previewed; preview again', 'PROVIDER_REPLY_CHANGED');
    }
    const result = agent.createWorkItem({ expectedVersion, title: proposal.title, objective: proposal.objective, idempotencyKey });
    return { ...result, source: PROVIDER_REPLY_SOURCE, provenance };
  }
  return { preview, apply };
}
