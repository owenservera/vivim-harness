// Thin authenticated-server surface over the shared lifecycle runtime. No browser logic here.
import { json, object, problem, storageName, text } from './http.mjs';
import { TRANSCRIPT_LIMITS } from '../capture/conversation-thread.mjs';
import { chatIndexExpression } from '../capture/chatgpt-chat-index.mjs';

export async function defaultConversationRuntime(options) {
  const { createConversationRuntime } = await import('../capture/conversation-runtime.mjs');
  return createConversationRuntime(options);
}

export function validateConversationBody(kind, body) {
  object(body);
  const fields = { connect: ['site', 'targetId', 'freshTab', 'expectedThread'], submit: ['key', 'prompt', 'confirm', 'expectedRevision'], reconcile: ['expectedRevision', 'turnId'], finish: ['closeTab'],
    chatIndex: ['targetId', 'site', 'maxEntries', 'maxTitleChars', 'scanLimit', 'containers'], read: ['maxMessages', 'maxChars'] }[kind];
  if (Object.keys(body).some((key) => !fields.includes(key))) throw problem(400, 'Unexpected request field');
  if (kind === 'connect') {
    text(body.site, 'site', 128);
    if (body.targetId !== undefined) text(body.targetId, 'targetId', 256);
    if (body.freshTab !== undefined && typeof body.freshTab !== 'boolean') throw problem(400, 'freshTab must be boolean');
    if (body.expectedThread !== undefined) text(body.expectedThread, 'expectedThread', 200);
  }
  if (kind === 'chatIndex') {
    text(body.targetId, 'targetId', 256);
    if (body.site !== undefined && body.site !== 'chatgpt') throw problem(400, 'site must be chatgpt');
    chatIndexExpression(body); // Reuse the canonical pure bounds/containers validator, not a second schema.
  }
  if (kind === 'read') {
    const L = TRANSCRIPT_LIMITS;
    for (const [name, spec] of [['maxMessages', L.maxMessages], ['maxChars', L.maxChars]]) {
      if (body[name] !== undefined && (!Number.isSafeInteger(body[name]) || body[name] < spec.min || body[name] > spec.max)) throw problem(400, `${name} must be an integer from ${spec.min} to ${spec.max}`);
    }
  }
  if (kind === 'submit') {
    text(body.key, 'key', 200); text(body.prompt, 'prompt', 250000);
    if (body.confirm !== true) throw problem(400, 'Explicit confirm:true required');
  }
  if (kind === 'submit' || kind === 'reconcile') {
    if (kind === 'reconcile' && body.turnId !== undefined) text(body.turnId, 'turnId', 200);
    if (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0) throw problem(400, 'expectedRevision must be a nonnegative integer');
  }
  if (kind === 'finish' && body.closeTab !== undefined && typeof body.closeTab !== 'boolean') throw problem(400, 'closeTab must be boolean');
  return body;
}

function throwUnavailable() { throw problem(501, 'Conversation event stream is not available', 'CONVERSATION_EVENTS_UNAVAILABLE'); }

export function createConversationApi({ runtime, events } = {}) {
  return { async handle(req, res, url, body = {}) {
    const p = url.pathname;
    if (p !== '/api/v1/chat-index' && p !== '/api/v1/conversation-targets' && p !== '/api/v1/conversations' && !p.startsWith('/api/v1/conversations/')) return false;
    let methods, run;
    if (p === '/api/v1/chat-index') {
      methods = ['POST']; run = async () => json(res, 200, await runtime.chatIndex(validateConversationBody('chatIndex', body)));
    } else if (p === '/api/v1/conversation-targets') {
      methods = ['GET']; run = async () => json(res, 200, await runtime.targets());
    } else if (p === '/api/v1/conversations') {
      methods = ['GET', 'POST'];
      run = async () => req.method === 'GET'
        ? json(res, 200, { conversations: await runtime.list() })
        : json(res, 201, { conversation: await runtime.connect(validateConversationBody('connect', body)) });
    } else {
      const match = /^\/api\/v1\/conversations\/([^/]+)(?:\/(turns|reconcile|finish|read|events|capsule))?$/.exec(p);
      if (!match) { json(res, 404, { error: 'Unknown conversation endpoint' }); return true; }
      let id;
      try { id = storageName(decodeURIComponent(match[1]), 'conversation'); } catch { throw problem(400, 'Invalid conversation id'); }
      const kind = match[2] === 'turns' ? 'submit' : match[2];
      methods = kind === 'events' || kind === 'capsule' ? ['GET'] : kind ? ['POST'] : ['GET'];
      // Read answers with a bounded transcript (a browser observation), never a conversation snapshot wrapper.
      // events is a resumable SSE stream of derived conversation state (no prompt/reply text; reconnect via
      // Last-Event-ID, reset on cursor loss — clients re-read state, never replay actions).
      run = async () => kind === 'read'
        ? json(res, 200, { transcript: await runtime.read(id, validateConversationBody('read', body)) })
        : kind === 'events'
          ? (events ?? throwUnavailable()).subscribe(req, res, id, Object.fromEntries(url.searchParams))
          : kind === 'capsule'
            ? json(res, 200, typeof runtime.capsule === 'function' ? await runtime.capsule(id) : throwUnavailable())
            : json(res, kind === 'submit' ? 202 : 200, { conversation: kind ? await runtime[kind](id, validateConversationBody(kind, body)) : await runtime.get(id) });
    }
    if (!methods.includes(req.method)) {
      res.setHeader('allow', methods.join(', ')); json(res, 405, { error: `${methods.join(' or ')} required` }); return true;
    }
    await run(); return true;
  } };
}
