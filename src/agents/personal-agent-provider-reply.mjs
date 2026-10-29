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
const digestOf = text => createHash('sha256').update(text, 'utf8').digest('hex');

// First meaningful line, stripped of markdown decoration, bounded to the Work title limit.
function titleFrom(replyText) {
  const line = replyText.split(/\r?\n/).map(row => row.replace(/^[\s>#*\-+`\d.)]+/, '').replace(/[*_`]+/g, '').trim())
    .find(row => row.length > 0) ?? 'Provider reply';
  return line.length > TITLE_MAX ? line.slice(0, TITLE_MAX - 1).trimEnd() + '…' : line;
}

function objectiveFrom(replyText, provenance) {
  const header = `[AI-proposed, unverified · tags: ${PROVIDER_REPLY_TAGS.join(', ')}] From stored provider reply ` +
    `${provenance.conversationId}/${provenance.turnId} (sha256 ${provenance.replyDigest.slice(0, 16)}). ` +
    'Not human-authored; no provider request was made.\n\n';
  const room = OBJECTIVE_MAX - header.length;
  const body = replyText.trim();
  return header + (body.length <= room ? body : body.slice(0, room - TRUNCATED.length) + TRUNCATED);
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
    if (typeof turnId !== 'string' || !turnId || turnId.length > 200) {
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
    return {
      source: PROVIDER_REPLY_SOURCE, provenance, proposal, effects: 'none', approvalRequired: true,
      canApply: current.initialized === true, baseVersion: current.initialized ? current.version : null,
      note: current.initialized ? 'Preview only: nothing was saved. Apply requires explicit approval.' : 'Initialize the Personal Agent before applying.',
    };
  }
  async function apply({ conversation, turnId, replyDigest, expectedVersion, approval } = {}) {
    if (approval !== 'user-confirmed') {
      throw problem(400, 'Explicit user-confirmed approval required', 'PROVIDER_REPLY_APPROVAL_REQUIRED');
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
