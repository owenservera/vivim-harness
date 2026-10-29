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
const CONTROL = /[\u0000-\u001f\u007f]/;
const DIGEST = /^[a-f0-9]{64}$/;
const digestOf = text => createHash('sha256').update(text, 'utf8').digest('hex');
const ambiguous = () => problem(400, 'Provider reply contains more than one JSON block; refusing to guess', 'PROVIDER_REPLY_AMBIGUOUS');

// Top-level {...} spans of prose that parse as JSON objects. Quotes are only tracked INSIDE a brace span,
// so apostrophes/quotes in the surrounding prose cannot desynchronise the scan.
function jsonObjectsIn(text) {
  const found = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    let depth = 0, inString = false, end = -1;
    for (let j = i; j < text.length && end < 0; j++) {
      const c = text[j];
      if (inString) { if (c === '\\') j++; else if (c === '"') inString = false; }
      else if (c === '"') inString = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) end = j;
    }
    if (end < 0) break; // unbalanced from here on: nothing further can close
    const slice = text.slice(i, end + 1);
    try {
      const value = JSON.parse(slice);
      if (value && typeof value === 'object' && !Array.isArray(value) && !found.includes(slice)) found.push(slice);
      i = end; // a valid object's inner braces are never separate candidates
    } catch { /* not JSON: keep scanning from the next brace (it may open the real object) */ }
  }
  return found;
}

// Providers usually wrap JSON in a markdown fence. A ```json fence always counts; a bare ``` fence counts
// only when it holds an object (so an extra shell/code snippet next to the JSON is not "ambiguous").
// More than one candidate is refused rather than guessed. Without fences: a reply that starts with '{' is
// passed whole (so the compiler reports the real JSON error); otherwise exactly one embedded JSON object
// (page-captured replies render a code block as "json Copy code {...}"). The compiler stays the sole judge.
export function extractProposalText(replyText) {
  const text = String(replyText ?? '');
  const blocks = [...text.matchAll(FENCE)]
    .filter(([, tag, body]) => (tag ? tag.toLowerCase() === 'json' : body.trim().startsWith('{')))
    .map(match => match[2].trim());
  if (blocks.length > 1) throw ambiguous();
  if (blocks.length === 1) return blocks[0];
  const whole = text.trim();
  if (whole.startsWith('{')) return whole;
  const objects = whole.length <= 100_000 ? jsonObjectsIn(whole) : []; // bounded scan; huge replies fail the compiler size cap anyway
  if (objects.length > 1) throw ambiguous();
  return objects[0] ?? whole;
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
    if (typeof turnId !== 'string' || !turnId || turnId.length > 200 || CONTROL.test(turnId)) {
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
    if (typeof replyDigest !== 'string' || !DIGEST.test(replyDigest)) {
      throw problem(400, 'replyDigest from the preview is required; preview the reply first', 'PROVIDER_REPLY_INVALID');
    }
    const { proposal, provenance } = await observedReply({ conversation, turnId });
    if (replyDigest !== provenance.replyDigest) {
      throw problem(409, 'Stored reply changed since it was previewed; preview again', 'PROVIDER_REPLY_CHANGED');
    }
    const result = apps.applyChange({ id, expectedVersion, proposal, approval });
    return { ...result, source: PROVIDER_REPLY_SOURCE, provenance };
  }
  return { preview, apply };
}
