// C-10 semantic command catalog. Preview and description only.
// This module does not read a store, open a browser, contact a provider, or perform a command.
// `executable: true` means a future authorized owner could accept the preview. This module never does.
import { problem } from './http.mjs';

const DEFERRED_EFFECT = 'deferred: no live provider/browser work';
const ID_SHAPE = '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$';
const CONVERSATION_SHAPE = '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$';
const SOURCE_SHAPE = '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$';
const COMMAND_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ROUTE_TOKEN_RE = /^[a-z0-9@+?!$%^*=~_.-]{1,64}$/i;
const LOCAL_KINDS = Object.freeze(['message', 'project', 'note', 'source-reference', 'selection']);
const IMPORT_FORMATS = Object.freeze(['json', 'jsonl']);

const stringField = (maxLength, extra = {}) => ({ type: 'string', minLength: 1, maxLength, ...extra });
const schema = (properties, required) => Object.freeze({ type: 'object', properties, required: Object.freeze(required), additionalProperties: false });

/** Explicit symbol -> command id. Lookup is exact after normalization. Unknown text is never coerced into one of these. */
export const COMMAND_SYMBOLS = Object.freeze({
  '/find': 'find',
  '?find': 'find',
  '?/find': 'find',
  '/open-conversation': 'open-conversation',
  '/conversation': 'open-conversation',
  '@project': 'add-to-project',
  '+project': 'add-to-project',
  '+/project': 'add-to-project',
  '+note': 'add-note',
  '+/note': 'add-note',
  '/export': 'export-selection',
  '/export-selection': 'export-selection',
  '/import-check': 'import-check',
  '?import': 'import-check',
  '/send': 'provider-send',
  // `!` names the command. It does not authorize it and cannot make an external effect executable.
  '!/send': 'provider-send',
});

const COMMANDS = Object.freeze([
  {
    id: 'open-conversation',
    summary: 'Open a saved conversation for local reading.',
    inputs: schema({
      conversationId: stringField(128, { pattern: CONVERSATION_SHAPE, description: 'Saved conversation id. Shape only; not looked up.' }),
    }, ['conversationId']),
    scope: 'read',
    requiresConfirmation: false,
    effects: 'Would show one saved conversation. Would not attach a browser, send a message, or change the conversation.',
    preconditions: Object.freeze([
      'conversationId matches the saved conversation id shape.',
      'This preview does not check that the conversation exists.',
    ]),
    unavailableReason: null,
  },
  {
    id: 'find',
    summary: 'Find saved local records by text.',
    inputs: schema({
      q: stringField(200, { description: 'Bounded local query text.' }),
      kind: { type: 'string', enum: LOCAL_KINDS, description: 'Optional local record family.' },
    }, ['q']),
    scope: 'read',
    requiresConfirmation: false,
    effects: 'Would list saved local records that match the query. Would not search a provider or the network.',
    preconditions: Object.freeze([
      'q is a bounded nonempty string.',
      'kind, when present, is a known local record family.',
    ]),
    unavailableReason: null,
  },
  {
    id: 'add-to-project',
    summary: 'Add a local record to a local project.',
    inputs: schema({
      projectId: stringField(64, { pattern: ID_SHAPE, description: 'Local project id. Shape only; not looked up.' }),
      targetId: stringField(64, { pattern: ID_SHAPE, description: 'Local record id. Shape only; not looked up.' }),
    }, ['projectId', 'targetId']),
    scope: 'local-write',
    requiresConfirmation: true,
    effects: 'Would record a local project membership after confirmation. Would not publish, sync, or send anything.',
    preconditions: Object.freeze([
      'projectId and targetId match local id shape.',
      'Confirmation is required before any future write.',
      'This preview does not check that either id exists.',
    ]),
    unavailableReason: null,
  },
  {
    id: 'add-note',
    summary: 'Add a note to the local world.',
    inputs: schema({
      title: stringField(120),
      body: stringField(4000),
      projectId: stringField(64, { pattern: ID_SHAPE, description: 'Optional local project id. Shape only; not looked up.' }),
    }, ['title', 'body']),
    scope: 'local-write',
    requiresConfirmation: true,
    effects: 'Would store a note locally after confirmation. Would not send the note to a provider.',
    preconditions: Object.freeze([
      'title and body are bounded text.',
      'Confirmation is required before any future write.',
      'projectId, when present, is shape-checked only.',
    ]),
    unavailableReason: null,
  },
  {
    id: 'export-selection',
    summary: 'Export a local selection.',
    inputs: schema({
      selectionId: stringField(64, { pattern: ID_SHAPE, description: 'Local selection id. Shape only; not looked up.' }),
    }, ['selectionId']),
    scope: 'local-write',
    requiresConfirmation: true,
    effects: 'Would write a local export of one selection after confirmation. Would not upload it.',
    preconditions: Object.freeze([
      'selectionId matches local id shape.',
      'Confirmation is required before any future write.',
      'This preview does not check that the selection exists and does not write a file.',
    ]),
    unavailableReason: null,
  },
  {
    id: 'import-check',
    summary: 'Check a named local import source without importing it.',
    inputs: schema({
      source: stringField(128, { pattern: SOURCE_SHAPE, description: 'Local source name. Not a path or URL, and not opened.' }),
      format: { type: 'string', enum: IMPORT_FORMATS },
    }, ['source']),
    scope: 'read',
    requiresConfirmation: false,
    effects: 'Would check the name and format of a local import source. Would not read the file, import records, or contact a network.',
    preconditions: Object.freeze([
      'source is a bounded local name, not a path or URL.',
      'format, when present, is json or jsonl.',
      'This preview does not open the source.',
    ]),
    unavailableReason: null,
  },
  {
    id: 'provider-send',
    summary: 'Send a prompt to a live provider conversation.',
    inputs: schema({
      conversationId: stringField(128, { pattern: CONVERSATION_SHAPE, description: 'Conversation id. Shape only; not contacted.' }),
      prompt: stringField(4000, { description: 'Prompt text. Not sent.' }),
    }, ['conversationId', 'prompt']),
    scope: 'external-effect',
    requiresConfirmation: true,
    effects: 'Would send a prompt outside this machine. This command is not available.',
    preconditions: Object.freeze([
      'A live provider and browser owner would be required.',
      'Confirmation would be required.',
      'Neither is available in this catalog.',
    ]),
    unavailableReason: DEFERRED_EFFECT,
  },
]);

const SCOPES = new Set(['read', 'local-write', 'external-effect']);
for (const command of COMMANDS) {
  if (!COMMAND_ID_RE.test(command.id)) throw new Error(`Invalid command id: ${command.id}`);
  if (!SCOPES.has(command.scope)) throw new Error(`Invalid scope for ${command.id}`);
  if (command.scope === 'external-effect' && command.unavailableReason !== DEFERRED_EFFECT) throw new Error(`External command ${command.id} must stay deferred`);
  if (command.scope !== 'external-effect' && command.unavailableReason !== null) throw new Error(`Local command ${command.id} cannot be deferred`);
  if (command.scope === 'local-write' && command.requiresConfirmation !== true) throw new Error(`Local write ${command.id} requires confirmation`);
}
const symbolOwners = new Map();
for (const [symbol, id] of Object.entries(COMMAND_SYMBOLS)) {
  if (!COMMANDS.some((command) => command.id === id)) throw new Error(`Symbol ${symbol} points at unknown command ${id}`);
  const key = normalizeCommandInput(symbol);
  if (symbolOwners.has(key)) throw new Error(`Duplicate symbol: ${symbol}`);
  symbolOwners.set(key, id);
}

export function normalizeCommandInput(value) {
  return String(value ?? '').trim().replaceAll('Δ', '∆').replaceAll('✔', '✓').toLowerCase().replace(/[ \t]+/g, ' ');
}

function publicCommand(command) {
  const symbols = Object.freeze(Object.entries(COMMAND_SYMBOLS).filter(([, id]) => id === command.id).map(([symbol]) => symbol));
  return {
    id: command.id,
    summary: command.summary,
    inputs: command.inputs,
    scope: command.scope,
    requiresConfirmation: command.requiresConfirmation,
    effects: command.effects,
    preconditions: command.preconditions,
    unavailableReason: command.unavailableReason,
    symbols,
  };
}

function commandById(id) {
  return COMMANDS.find((command) => command.id === id) ?? null;
}

function exactCommand(input) {
  if (typeof input !== 'string') return null;
  const normalized = normalizeCommandInput(input);
  if (!normalized || normalized.length > 64) return null;
  return commandById(normalized) ?? commandById(symbolOwners.get(normalized)) ?? null;
}

function scoreCommand(normalized, command) {
  let score = 0;
  if (command.id === normalized) score += 100;
  if (symbolOwners.get(normalized) === command.id) score += 100;
  if (normalized.length >= 2 && (command.id.startsWith(normalized) || normalized.startsWith(command.id))) score += 10;
  const tokens = normalized.split(/[^a-z0-9]+/).filter((token) => token.length >= 2);
  for (const token of tokens) {
    if (command.id.includes(token)) score += 5;
    if (command.summary.toLowerCase().includes(token)) score += 2;
  }
  return score;
}

function candidatesFor(input) {
  const normalized = typeof input === 'string' ? normalizeCommandInput(input) : '';
  const scored = COMMANDS.map((command) => ({ id: command.id, summary: command.summary, score: scoreCommand(normalized, command) }))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const list = scored.length > 0 ? scored : COMMANDS.map((command) => ({ id: command.id, summary: command.summary, score: 0 }));
  return list.slice(0, 8);
}

function controlChars(value) {
  return /[\u0000-\u001f\u007f]/.test(value);
}

function checkValue(key, spec, value, errors, uncertain) {
  if (spec.enum) {
    if (typeof value !== 'string' || !spec.enum.includes(value)) errors.push(`${key} must be one of: ${spec.enum.join(', ')}`);
    return;
  }
  if (spec.type === 'string') {
    if (typeof value !== 'string') { errors.push(`${key} must be a string`); return; }
    if (controlChars(value)) errors.push(`${key} contains control characters`);
    if (value.length < (spec.minLength ?? 0)) errors.push(`${key} must be at least ${spec.minLength} characters`);
    if (value.length > spec.maxLength) errors.push(`${key} exceeds ${spec.maxLength} characters`);
    if (spec.pattern && !new RegExp(spec.pattern).test(value)) errors.push(`${key} does not match the required shape`);
    else if (spec.pattern) uncertain.push(`${key} matched an id shape only; it was not resolved in a store.`);
  } else errors.push(`${key} has an unsupported type`);
}

function validateArgs(command, args) {
  const errors = [];
  const uncertain = [];
  if (args === undefined) args = {};
  if (!args || typeof args !== 'object' || Array.isArray(args)) return { errors: ['arguments must be a JSON object'], uncertain };
  const properties = command.inputs.properties;
  const keys = Object.keys(args);
  if (keys.length > 16) errors.push('too many arguments');
  for (const key of keys) if (!Object.hasOwn(properties, key)) errors.push(`unknown argument: ${key}`);
  for (const key of command.inputs.required) {
    if (args[key] === undefined || args[key] === null || args[key] === '') errors.push(`missing argument: ${key}`);
  }
  for (const [key, spec] of Object.entries(properties)) {
    if (args[key] === undefined) continue;
    checkValue(key, spec, args[key], errors, uncertain);
  }
  return { errors, uncertain };
}

function previewOf(command, args) {
  const checked = validateArgs(command, args);
  const external = command.scope === 'external-effect';
  const errors = external ? [command.unavailableReason, ...checked.errors] : checked.errors;
  const valid = errors.length === 0;
  const uncertain = external
    ? [command.unavailableReason, 'No outcome can be known because no provider or browser work is in scope.', ...checked.uncertain]
    : [...checked.uncertain];
  if (!external && valid) uncertain.push('Preview did not perform the command.');
  const wouldDo = external
    ? ['Would not contact a provider or browser.', 'Nothing was performed.']
    : valid
      ? [command.effects, command.requiresConfirmation ? 'Would wait for confirmation before any write.' : 'Would stay read-only.', 'Nothing was performed.']
      : ['Nothing was performed.'];
  return {
    valid,
    errors,
    wouldDo,
    scope: command.scope,
    requiresConfirmation: command.requiresConfirmation,
    uncertain,
    executable: valid && !external,
    candidates: [],
  };
}

function unknownPreview(input) {
  return {
    valid: false,
    errors: ['Unknown command or symbol; no command was selected.'],
    wouldDo: ['Nothing was performed.'],
    scope: null,
    requiresConfirmation: null,
    uncertain: ['Input did not exactly match a command id or an explicit symbol.'],
    executable: false,
    candidates: candidatesFor(input),
  };
}

function gateRouteId(id) {
  if (typeof id !== 'string' || id.length < 1 || id.length > 64 || id.includes('..') || id.includes('/') || id.includes('\\') || /\s/u.test(id) || controlChars(id) || (!COMMAND_ID_RE.test(id) && !ROUTE_TOKEN_RE.test(id))) {
    throw problem(400, 'Command id is malformed', 'MALFORMED_COMMAND');
  }
  return id;
}

function gateBody(body) {
  if (body === undefined) return {};
  const prototype = body && typeof body === 'object' ? Object.getPrototypeOf(body) : false;
  if (!body || typeof body !== 'object' || Array.isArray(body) || (prototype !== Object.prototype && prototype !== null)) {
    throw problem(400, 'Preview body must be a JSON object', 'MALFORMED_COMMAND');
  }
  let encoded;
  try { encoded = JSON.stringify(body); } catch { throw problem(400, 'Preview body must be a JSON object', 'MALFORMED_COMMAND'); }
  if (encoded.length > 8192) throw problem(400, 'Preview body exceeds 8192 characters', 'MALFORMED_COMMAND');
  if (Object.keys(body).length > 16) throw problem(400, 'Preview body has too many fields', 'MALFORMED_COMMAND');
  return body;
}

function gateInput(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 128 || controlChars(value)) {
    throw problem(400, 'input must be a string of 1 to 128 characters without control characters', 'MALFORMED_COMMAND');
  }
  return value;
}

export function createCommandCatalog() {
  return Object.freeze({
    list() {
      return COMMANDS.map((command) => publicCommand(command));
    },
    describe(id) {
      const command = exactCommand(id);
      return command ? publicCommand(command) : null;
    },
    resolve(input) {
      const command = exactCommand(input);
      const normalized = typeof input === 'string' ? normalizeCommandInput(input) : '';
      if (command) return { input: normalized, exact: true, id: command.id, candidates: [{ id: command.id, summary: command.summary, score: 100 }] };
      return { input: normalized, exact: false, id: null, candidates: candidatesFor(input) };
    },
    preview(id, args) {
      const command = exactCommand(id);
      if (!command) return unknownPreview(id);
      return previewOf(command, args);
    },
  });
}

// Optional routes for a router-like `{ add }`. Not wired into the Studio hub.
export function registerCommandRoutes(router) {
  const add = router?.add;
  if (typeof add !== 'function') throw new TypeError('registerCommandRoutes requires the router add() function');
  const catalog = createCommandCatalog();
  add('GET', '/commands', 'List semantic commands. Catalog only; nothing is performed.', ({ q } = {}) => {
    if (q?.input !== undefined) return catalog.resolve(gateInput(q.input));
    return { commands: catalog.list() };
  });
  add('GET', '/commands/{id}', 'Describe one semantic command. Catalog only; nothing is performed.', ({ p } = {}) => {
    const id = gateRouteId(p?.id);
    const command = catalog.describe(id);
    if (!command) {
      const error = problem(404, 'Unknown command', 'UNKNOWN_COMMAND');
      error.candidates = catalog.resolve(id).candidates;
      throw error;
    }
    return { command };
  });
  add('POST', '/commands/{id}/preview', 'Preview one semantic command. Validates and explains; nothing is performed.', ({ p, body } = {}) => {
    const id = gateRouteId(p?.id);
    return catalog.preview(id, gateBody(body));
  });
  return catalog;
}
