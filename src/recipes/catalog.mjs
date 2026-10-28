// Agent recipe catalogue V1: read-only declarations, NOT an execution engine.
// Exact command/tool bindings must be verified before a recipe can be executable.
// No filesystem, provider, network, browser or durable-write effects.
import { CONVERSATION_TOOLS } from '../studio/conversation-tools.mjs';

const toolNames = new Set(CONVERSATION_TOOLS.map((tool) => tool.name));
const turnInput = CONVERSATION_TOOLS.find((tool) => tool.name === 'submit_conversation_turn').inputSchema;
export const RECIPE_FAMILIES = Object.freeze([
  'bootstrap', 'provider', 'conversation', 'capture', 'world',
  'knowledge', 'recovery', 'diagnostics', 'verification',
]);
export const EFFECT_CLASSES = Object.freeze([
  'read', 'browser-navigation', 'provider-send', 'local-write', 'import', 'delete',
]);

// Eligibility is transport-specific. Registered tool != live provider/account availability.
const definitions = [
  { id: 'provider.targets', title: 'Discover attached provider tabs', family: 'provider',
    tool: 'conversation_targets', effects: ['read'], requires: ['studio.running'], evidence: 'target-metadata',
    description: 'Report visible provider targets without inferring user accounts or native thread continuity' },
  { id: 'conversation.list', title: 'List locally recorded conversations', family: 'conversation',
    tool: 'list_conversations', effects: ['read'], requires: ['studio.running'], evidence: 'stored-snapshot',
    description: 'Read stored conversation summaries without browser attachment' },
  { id: 'conversation.read', title: 'Read a bounded live conversation transcript', family: 'conversation',
    tool: 'read_conversation', effects: ['read'], requires: ['studio.running', 'conversation.live-bound'], evidence: 'visible-dom-partial',
    description: 'Observe the current rendered transcript, not an entire native archive' },
  { id: 'conversation.inspect', title: 'Inspect conversation journal state', family: 'conversation',
    tool: 'get_conversation', effects: ['read'], requires: ['studio.running'], evidence: 'stored-snapshot',
    description: 'Inspect revision, binding, reply, readiness and uncertainty without recovering or sending' },
  { id: 'conversation.capabilities', title: 'Inspect current per-conversation capability evidence', family: 'conversation',
    tool: 'conversation_capsule', effects: ['read'], requires: ['studio.running', 'conversation.existing'],
    evidence: 'capability-capsule', description: 'Read existing runtime advisory gates; not an authorization or guaranteed provider operation' },
  { id: 'conversation.create', title: 'Create a fresh ChatGPT conversation without sending', family: 'conversation',
    tool: 'create_conversation', effects: ['browser-navigation', 'local-write'],
    requires: ['studio.running', 'browser.owner-verified'], evidence: 'studio-owned-new-chat',
    description: 'Create a new Studio-owned tab in the existing Chrome owner; no send and no second browser controller' },
  { id: 'conversation.connect-existing', title: 'Attach to an exact ChatGPT thread', family: 'conversation',
    tool: 'connect_conversation', effects: ['local-write'], requires: ['studio.running', 'browser.owner-verified', 'thread.chatgpt-exact'],
    evidence: 'native-thread-binding', description: 'Existing exact ChatGPT UUID thread only; not fresh-tab creation' },
  { id: 'conversation.ask', title: 'One-command follow-up on a bound conversation', family: 'conversation',
    tool: 'submit_conversation_turn', effects: ['provider-send', 'local-write'],
    requires: ['studio.running', 'conversation.live-bound', 'conversation.writable'],
    evidence: 'send-and-journal', autoRevision: true,
    inputSchema: { type: 'object', additionalProperties: false,
      properties: Object.fromEntries(['conversation', 'key', 'prompt'].map((name) => [name, turnInput.properties[name]])),
      required: ['conversation', 'key', 'prompt'] },
    description: 'Agent supplies exact conversation, original key and prompt; owner reads revision and supplies confirm:true only after explicit provider-send authorization' },
  { id: 'conversation.continue', title: 'Send exactly one confirmed turn', family: 'conversation',
    tool: 'submit_conversation_turn', effects: ['provider-send', 'local-write'],
    requires: ['studio.running', 'conversation.live-bound', 'conversation.writable', 'turn.expected-revision'],
    evidence: 'send-and-journal', description: 'One keyed turn with explicit send authorization; never auto-retry after an unknown effect' },
  { id: 'recovery.reconcile-turn', title: 'Reconcile uncertain turn', family: 'recovery',
    tool: 'reconcile_conversation', effects: ['local-write'], requires: ['studio.running', 'conversation.existing'],
    evidence: 'journal-reconciliation', description: 'Read provider state and persist evidence without attempting a resend' },
  { id: 'conversation.finish', title: 'Finish recording and release writer', family: 'conversation',
    tool: 'finish_conversation', effects: ['local-write'], requires: ['studio.running', 'conversation.existing'],
    evidence: 'capture-finish', description: 'Finalize existing owned capture without erasing unknown-delivery fence' },
  { id: 'provider.chat-index', title: 'Inspect rendered ChatGPT chat links', family: 'provider',
    tool: 'chat_index', effects: ['read'], requires: ['studio.running', 'provider.chatgpt-target'],
    evidence: 'candidate-links', description: 'Read candidate links; not proof of live bindings or full historical archive' },
];

function validated(def) {
  if (!RECIPE_FAMILIES.includes(def.family) || !def.id.startsWith(def.family + '.')
    || !toolNames.has(def.tool) || !def.effects.length || def.effects.some((e) => !EFFECT_CLASSES.includes(e))
    || !Array.isArray(def.requires) || !def.requires.length) throw new Error('INVALID_RECIPE_DECLARATION: ' + def.id);
  const tool = CONVERSATION_TOOLS.find((item) => item.name === def.tool);
  if (tool.annotations?.readOnlyHint === true && def.effects.some((effect) => effect !== 'read'))
    throw new Error('INVALID_RECIPE_EFFECT: ' + def.id);
  if (def.effects.includes('provider-send') && def.tool !== 'submit_conversation_turn')
    throw new Error('INVALID_RECIPE_SEND_TOOL: ' + def.id);
  return Object.freeze({ ...def, version: 1, transport: 'studio-tool',
    inputSchema: def.inputSchema ?? tool.inputSchema, toolReadOnly: tool.annotations.readOnlyHint === true,
    executionReady: true, maxUserCommands: 1,
    onUnknownEffect: 'halt-and-reconcile' });
}
export const RECIPE_CATALOG = Object.freeze(definitions.map(validated));
if (new Set(RECIPE_CATALOG.map((r) => r.id)).size !== RECIPE_CATALOG.length)
  throw new Error('DUPLICATE_RECIPE_ID');

export function listRecipes({ family } = {}) {
  if (family !== undefined && !RECIPE_FAMILIES.includes(family)) throw new Error('UNKNOWN_RECIPE_FAMILY');
  return RECIPE_CATALOG.filter((recipe) => family === undefined || recipe.family === family);
}
export function recipeDefinition(id) {
  return RECIPE_CATALOG.find((recipe) => recipe.id === id) ?? null;
}
