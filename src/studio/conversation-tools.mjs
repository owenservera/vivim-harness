// Registration only: every handler delegates to the Studio server's EXISTING runtime owner.
// This module never constructs a runtime, recorder, CDP connection, or MCP actor.
import { validateConversationBody } from './conversation-api.mjs';
import { object, problem } from './http.mjs';
import { TRANSCRIPT_LIMITS } from '../capture/conversation-thread.mjs';
import { CHAT_INDEX_LIMITS } from '../capture/chatgpt-chat-index.mjs';

const string = (maxLength, description) => ({ type: 'string', minLength: 1, maxLength, ...(description ? { description } : {}) });
const schema = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const conversation = { ...string(128), pattern: '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$' };
const revision = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const threadPattern = '^chatgpt-c:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$';
const bounds = (spec) => ({ type: 'integer', minimum: spec.min, maximum: spec.max, default: spec.default });
const indexBody = schema({ targetId: string(256), site: { type: 'string', enum: ['chatgpt'], default: 'chatgpt' },
  ...Object.fromEntries(Object.entries(CHAT_INDEX_LIMITS).map(([name, spec]) => [name, bounds(spec)])),
  containers: { type: 'array', maxItems: 8, items: schema({ label: { ...string(40), pattern: '^(?!unknown$)[a-z][a-z-]{0,39}$' }, selector: string(200) }, ['label', 'selector']) } }, ['targetId']);
const connectBody = schema({ site: { type: 'string', enum: ['chatgpt'] }, targetId: string(256),
  expectedThread: { ...string(200), pattern: threadPattern }, freshTab: { type: 'boolean', const: false } }, ['site', 'targetId', 'expectedThread']);
const readBody = schema({ maxMessages: bounds(TRANSCRIPT_LIMITS.maxMessages), maxChars: bounds(TRANSCRIPT_LIMITS.maxChars) });
const submitBody = schema({ key: string(200, 'Caller-owned durable request key. Never generate a replacement key on timeout/unknown effect.'),
  prompt: string(250000, 'Private prompt body; never included in diagnostic logs.'), confirm: { type: 'boolean', const: true }, expectedRevision: revision }, ['key', 'prompt', 'confirm', 'expectedRevision']);
const reconcileBody = schema({ expectedRevision: revision, turnId: string(200, 'Optional exact historical turn to inspect. No user delivery assertions accepted.') }, ['expectedRevision']);
const finishBody = schema({ closeTab: { type: 'boolean', default: false, description: 'Explicit optional close of a Studio-owned tab only; never an owner-selected tab.' } });
const withConversation = (body = schema()) => schema({ conversation, ...body.properties }, ['conversation', ...body.required]);
const annotations = (readOnlyHint, openWorldHint = true) => ({ readOnlyHint, destructiveHint: false, idempotentHint: readOnlyHint, openWorldHint });
const evidence = 'Page readiness, network protocol completion and capture acceptance are independent; no account or live capability availability is implied.';

export const CONVERSATION_TOOLS = Object.freeze([
  { name: 'conversation_targets', method: 'GET', path: '/conversation-targets', runtime: 'targets',
    description: 'Read available browser target metadata only; no attachment or account-availability assertion. Titles are not thread identities.',
    inputSchema: schema(), annotations: annotations(true) },
  { name: 'chat_index', method: 'POST', path: '/chat-index', runtime: 'chatIndex', kind: 'chatIndex', body: indexBody,
    description: 'Explicit read-only rendered ChatGPT link index from one canonical-origin target. candidatesOnly=true, complete=false; entries are NOT verified live bindings. No search, pagination, creation or click.',
    inputSchema: indexBody, annotations: annotations(true) },
  { name: 'list_conversations', method: 'GET', path: '/conversations', runtime: 'list',
    description: 'Read stored conversation summaries and turn metadata; strips reply bodies. No browser action or snapshot recovery.',
    inputSchema: schema(), annotations: annotations(true, false), wrapper: 'conversations' },
  { name: 'get_conversation', method: 'GET', path: '/conversations/{conversation}', runtime: 'get',
    description: `Read a stored conversation snapshot including current/historical turn replies. No browser action or recovery. ${evidence}`,
    inputSchema: withConversation(), annotations: annotations(true, false), wrapper: 'conversation' },
  { name: 'connect_conversation', method: 'POST', path: '/conversations', runtime: 'connect', kind: 'connect', body: connectBody, status: 201,
    description: 'Attach capture to the selected EXISTING exact /c/ thread, expectedThread required. Acquires resources/drive lease; never submits. Tool intentionally excludes fresh/root creation. No account readiness guarantee.',
    inputSchema: connectBody, annotations: annotations(false), wrapper: 'conversation' },
  { name: 'read_conversation', method: 'POST', path: '/conversations/{conversation}/read', runtime: 'read', kind: 'read', body: readBody,
    description: 'Read bounded currently rendered transcript from a live exact-bound conversation. Read-only: no focus, scrolling, insertion or send; coverage is incomplete and page-visible only.',
    inputSchema: withConversation(readBody), annotations: annotations(true), wrapper: 'transcript' },
  { name: 'submit_conversation_turn', method: 'POST', path: '/conversations/{conversation}/turns', runtime: 'submit', kind: 'submit', body: submitBody, status: 202,
    description: `EXTERNAL EFFECT: insert/submit one confirmed keyed turn, subject to durable exact-thread fencing and expectedRevision. Same key+payload replays read-only. NEVER automatically retry or replace the key after timeout/unknown delivery. ${evidence}`,
    inputSchema: withConversation(submitBody), annotations: annotations(false), wrapper: 'conversation' },
  { name: 'reconcile_conversation', method: 'POST', path: '/conversations/{conversation}/reconcile', runtime: 'reconcile', kind: 'reconcile', body: reconcileBody,
    description: 'Explicit reconciliation of the current or selected historical turn: may inspect browser and persist evidence; NEVER inserts or submits. Not-found/timeout/user assertions cannot clear unknown delivery.',
    inputSchema: withConversation(reconcileBody), annotations: annotations(false), wrapper: 'conversation' },
  { name: 'finish_conversation', method: 'POST', path: '/conversations/{conversation}/finish', runtime: 'finish', kind: 'finish', body: finishBody,
    description: `Stop/flush owned capture and release resources. Does not resend, erase unknown-delivery fences or assert capture acceptance. Optional closeTab is explicit and ownership checked. ${evidence}`,
    inputSchema: withConversation(finishBody), annotations: annotations(false), wrapper: 'conversation' },
]);

export function validateConversationTool(name, args = {}) {
  const definition = CONVERSATION_TOOLS.find((tool) => tool.name === name);
  if (!definition) throw problem(404, 'Unknown conversation tool', 'UNKNOWN_CONVERSATION_TOOL');
  object(args, 'arguments');
  for (const required of definition.inputSchema.required) if (args[required] === undefined) throw problem(400, 'Missing tool argument', 'INVALID_TOOL_ARGUMENTS');
  if (Object.keys(args).some((key) => !Object.hasOwn(definition.inputSchema.properties, key))) throw problem(400, 'Unknown tool argument', 'INVALID_TOOL_ARGUMENTS');
  if (Object.hasOwn(definition.inputSchema.properties, 'conversation') && (typeof args.conversation !== 'string' || !new RegExp(conversation.pattern).test(args.conversation))) throw problem(400, 'Invalid conversation id', 'INVALID_TOOL_ARGUMENTS');
  const body = Object.fromEntries(Object.entries(args).filter(([key]) => key !== 'conversation'));
  if (definition.kind) validateConversationBody(definition.kind, body);
  if (definition.kind === 'connect' && (body.site !== 'chatgpt' || typeof body.targetId !== 'string' || !body.targetId.trim()
    || typeof body.expectedThread !== 'string' || !new RegExp(threadPattern).test(body.expectedThread) || body.freshTab !== undefined && body.freshTab !== false)) throw problem(400, 'An existing exact thread is required', 'INVALID_TOOL_ARGUMENTS');
  if (definition.kind === 'submit' && /[\u0000-\u001f\u007f]/.test(body.key)) throw problem(400, 'Invalid request key', 'INVALID_TOOL_ARGUMENTS');
  return { definition, body, conversation: args.conversation };
}

// One execution path for conversation tools, shared by the MCP/HTTP tool registry and the
// harness run executor: validate through the same schema, dispatch to the same runtime owner.
export async function executeConversationTool(conversationRuntime, name, args = {}) {
  const definition = CONVERSATION_TOOLS.find((tool) => tool.name === name);
  if (!definition) throw problem(404, 'Unknown conversation tool', 'UNKNOWN_CONVERSATION_TOOL');
  const valid = validateConversationTool(name, args);
  const handler = conversationRuntime[definition.runtime];
  if (typeof handler !== 'function') throw problem(501, 'Owning runtime capability unavailable', 'CONVERSATION_CAPABILITY_UNAVAILABLE');
  return handler.apply(conversationRuntime, valid.conversation !== undefined
    ? definition.kind ? [valid.conversation, valid.body] : [valid.conversation]
    : definition.kind ? [valid.body] : []);
}

export function registerConversationTools({ add, conversationRuntime }) {
  if (!conversationRuntime) return; // Do not advertise a missing owner or construct a replacement.
  for (const tool of CONVERSATION_TOOLS) add(tool.method, tool.path, tool.description, async ({ p = {}, body = {} }) => {
    const args = { ...body, ...(p.conversation !== undefined ? { conversation: p.conversation } : {}) };
    const value = await executeConversationTool(conversationRuntime, tool.name, args);
    return tool.wrapper ? { [tool.wrapper]: value } : value;
  }, { body: tool.body, tool: tool.name, annotations: tool.annotations, inputSchema: tool.inputSchema,
    pathParameters: { conversation }, successStatus: tool.status ?? 200 });
}
