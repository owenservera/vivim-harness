// Opt-in bridge: an ALREADY-STORED, ALREADY-OBSERVED provider reply -> the existing personal app compiler.
// Pure consumption: the only conversation capability received is a stored-snapshot reader
// (the same read-only seam as get_conversation). This module never submits, reads a live page,
// reconciles, resends, opens a browser, or touches the network. It never auto-applies:
// apply requires the same explicit 'user-confirmed' approval and CAS version as human proposals.
import { createHash } from 'node:crypto';
import { problem } from './http.mjs';

export const PROVIDER_REPLY_SOURCE = 'provider-reply';
const CONVERSATION_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const FENCE = /```[ \t]*([A-Za-z0-9_-]*)[ \t]*\r?\n([\s\S]*?)\r?\n?```/g;
const digestOf = text => createHash('sha256').update(text, 'utf8').digest('hex');

// Providers usually wrap JSON in a markdown fence. Accept exactly one bare/json fence, else the
// whole reply. The result is only a candidate string: the compiler remains the sole judge.
export function extractProposalText(replyText) {
  const blocks = [...replyText.matchAll(FENCE)]
    .filter(match => ['', 'json'].includes(match[1].toLowerCase())).map(match => match[2].trim());
  if (blocks.length > 1) {
    throw problem(400, 'Provider reply contains more than one JSON block; refusing to guess', 'PROVIDER_REPLY_AMBIGUOUS');
  }
  return blocks.length === 1 ? blocks[0] : replyText.trim();
}

export function createProviderReplyBuilder({ apps, readStoredConversation } = {}) {
  if (!apps || typeof apps.previewChange !== 'function' || typeof apps.applyChange !== 'function') {
    throw new TypeError('personal app service required');
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
    if (reply?.state !== 'ready') {
      throw problem(409, 'Stored reply is not settled', 'PROVIDER_REPLY_NOT_READY');
    }
    if (typeof reply.text !== 'string' || !reply.text.trim()) {
      throw problem(409, 'Stored reply has no text', 'PROVIDER_REPLY_EMPTY');
    }
    const replyDigest = digestOf(reply.text);
    return {
      proposal: extractProposalText(reply.text),
      provenance: {
        source: PROVIDER_REPLY_SOURCE, conversationId: conversation, turnId,
        replyState: reply.state, replyChars: reply.text.length, replyDigest,
        humanAuthored: false, providerCalled: false, trust: 'untrusted-until-user-approves',
        qualification: 'Text of a reply already stored by the Harness. Not human-authored; authenticity not verified; no new provider request was made.',
      },
    };
  }
  async function preview({ id, conversation, turnId } = {}) {
    const { proposal, provenance } = await observedReply({ conversation, turnId });
    const result = apps.previewChange({ id, proposal });
    return { ...result, source: PROVIDER_REPLY_SOURCE, provenance };
  }
  async function apply({ id, conversation, turnId, replyDigest, expectedVersion, approval } = {}) {
    const { proposal, provenance } = await observedReply({ conversation, turnId });
    if (replyDigest !== provenance.replyDigest) {
      throw problem(409, 'Stored reply changed since it was previewed; preview again', 'PROVIDER_REPLY_CHANGED');
    }
    const result = apps.applyChange({ id, expectedVersion, proposal, approval });
    return { ...result, source: PROVIDER_REPLY_SOURCE, provenance };
  }
  return { preview, apply };
}
