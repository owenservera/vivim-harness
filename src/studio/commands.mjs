// C-10 semantic command catalog. Preview and description only.
// This module does not read a store, open a browser, contact a provider, or perform a command.
//
// A preview response never carries a run-now claim:
//   - valid / canProceed only mean the arguments passed the catalog schema (never permission to run);
//   - wouldRequireConfirmation says a confirmation gate would precede any future write;
//   - no code path in this module performs anything.
//
// Error codes reuse the world vocabulary: malformed gate input throws WORLD_INVALID_INPUT (same
// class as the world route input gates). No command-specific codes exist. Unknown command ids
// resolve as data in a 200 response ({ found: false, candidates }) so suggestions survive the
// hub serializer, which only forwards { error, code, ...storeFields } for thrown errors.
//
// Symbols (`/find`, `+/project`, ...) cannot be route path tokens; they resolve as data via
// GET /commands?symbol=%2Ffind, which returns the route-safe command id for describe/preview.
//
// Symbols are grouped into semantic families (COMMAND_FAMILIES): a family is one intent vocabulary
// (query text, attach to project, export selection, ...) that resolves to exactly one of the same
// seven previewed commands. Families add vocabulary and interpretation, never authority: a family
// may suggest argument values, but it can not merge them into a caller's arguments, and the preview
// gate validates only what the caller actually passes. interpretCommandInput is a pure lookup over
// frozen data: symbol/intent -> candidate command(s), with no store, network, browser, or mutation.
import { problem } from './http.mjs';

const DEFERRED_EFFECT = 'deferred: no live provider/browser work';
// World id grammar (same families as src/studio/world-service.mjs / world-relations.mjs):
// c-<40 hex> observed / c-i<38 hex> imported conversations; p- projects; n- notes;
// o- source references; s- selections. Shape-only here: the store remains the identity owner.
const ID_PART = '[a-z0-9-]{1,60}';
const CONVERSATION_SHAPE = `^c-${ID_PART}$`;
const PROJECT_SHAPE = `^p-${ID_PART}$`;
const WORLD_REFERENCE_SHAPE = `^[cnpos]-${ID_PART}$`;
const SELECTION_SHAPE = `^s-${ID_PART}$`;
const SOURCE_SHAPE = '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$';
const COMMAND_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ROUTE_TOKEN_RE = /^[a-z0-9@+?!$%^*=~_.-]{1,64}$/i;
const LOCAL_KINDS = Object.freeze(['message', 'project', 'note', 'source-reference', 'selection']);
const IMPORT_FORMATS = Object.freeze(['json', 'jsonl']);

const stringField = (maxLength, extra = {}) => ({ type: 'string', minLength: 1, maxLength, ...extra });
const schema = (properties, required) => Object.freeze({ type: 'object', properties, required: Object.freeze(required), additionalProperties: false });

const CATEGORIES = Object.freeze(['navigation', 'query', 'creation', 'organization', 'transfer', 'effect']);
const FAMILY_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
// A symbol always opens with punctuation, so it can never be read as a command id or as free text:
// `?` asks, `+` creates, `@` attaches, `!` names, `/` opens, `~` recalls.
const SYMBOL_RE = /^[?+/@!~^=$%*][a-z0-9-]*(?:\/[a-z0-9-]+)*$/;

// 17 semantic families over the seven previewed commands. `suggests` is presentation only: it names
// argument values a future caller might pass, and is never merged into an argument object here.
const COMMAND_FAMILIES = deepFreeze([
  // navigation
  {
    id: 'open-saved-conversation',
    category: 'navigation',
    commandId: 'open-conversation',
    summary: 'Open one saved conversation by its world id.',
    symbols: ['/open-conversation', '/conversation', '@conversation'],
    suggests: {},
  },
  {
    id: 'open-imported-conversation',
    category: 'navigation',
    commandId: 'open-conversation',
    summary: 'Open a conversation that arrived through a local import.',
    symbols: ['/open-imported', '?imported-conversation'],
    suggests: {},
  },
  // query
  {
    id: 'find-text',
    category: 'query',
    commandId: 'find',
    summary: 'Find saved local records by free query text.',
    symbols: ['/find', '?find', '?/find'],
    suggests: {},
  },
  {
    id: 'find-by-kind',
    category: 'query',
    commandId: 'find',
    summary: 'Find saved local records of a chosen record family.',
    symbols: ['/find-kind', '?kind'],
    suggests: {},
  },
  {
    id: 'find-notes',
    category: 'query',
    commandId: 'find',
    summary: 'Find saved notes matching query text.',
    symbols: ['/find-notes', '?notes'],
    suggests: { kind: 'note' },
  },
  {
    id: 'find-conversations',
    category: 'query',
    commandId: 'find',
    summary: 'Find saved conversation messages matching query text.',
    symbols: ['/find-conversations', '?conversations'],
    suggests: { kind: 'message' },
  },
  {
    id: 'find-sources',
    category: 'query',
    commandId: 'find',
    summary: 'Find saved source references matching query text.',
    symbols: ['/find-sources', '?sources'],
    suggests: { kind: 'source-reference' },
  },
  {
    id: 'find-project-records',
    category: 'query',
    commandId: 'find',
    summary: 'Find saved project records matching query text.',
    symbols: ['/find-in-project', '?/project-find'],
    suggests: { kind: 'project' },
  },
  // creation
  {
    id: 'draft-note',
    category: 'creation',
    commandId: 'add-note',
    summary: 'Draft a note for the local world.',
    symbols: ['+note', '+/note'],
    suggests: {},
  },
  {
    id: 'draft-project-note',
    category: 'creation',
    commandId: 'add-note',
    summary: 'Draft a note that names a local project.',
    symbols: ['+project-note', '?note-project'],
    suggests: {},
  },
  // organization
  {
    id: 'attach-record-to-project',
    category: 'organization',
    commandId: 'add-to-project',
    summary: 'Attach a local record to a local project.',
    symbols: ['@project', '+project', '+/project'],
    suggests: {},
  },
  {
    id: 'attach-conversation-to-project',
    category: 'organization',
    commandId: 'add-to-project',
    summary: 'Attach a saved conversation to a local project.',
    symbols: ['@project-conversation', '?/project-attach'],
    suggests: {},
  },
  {
    id: 'attach-note-to-project',
    category: 'organization',
    commandId: 'add-to-project',
    summary: 'Attach a saved note to a local project.',
    symbols: ['@project-note', '?/note-attach'],
    suggests: {},
  },
  // transfer
  {
    id: 'export-saved-selection',
    category: 'transfer',
    commandId: 'export-selection',
    summary: 'Export one saved local selection.',
    symbols: ['/export', '/export-selection'],
    suggests: {},
  },
  {
    id: 'import-check-json',
    category: 'transfer',
    commandId: 'import-check',
    summary: 'Check a local import source declared as json.',
    symbols: ['/import-check', '?import'],
    suggests: { format: 'json' },
  },
  {
    id: 'import-check-jsonl',
    category: 'transfer',
    commandId: 'import-check',
    summary: 'Check a local import source declared as jsonl.',
    symbols: ['/import-jsonl', '?import-jsonl'],
    suggests: { format: 'jsonl' },
  },
  // effect (deferred)
  {
    id: 'deferred-provider-send',
    category: 'effect',
    commandId: 'provider-send',
    summary: 'Name the deferred provider send.',
    // `!` names the family. It does not authorize it and cannot make an external effect runnable.
    symbols: ['/send', '!/send'],
    suggests: {},
  },
]);

/** Explicit symbol -> command id, derived from the families. Lookup is exact after normalization. Unknown text is never coerced into one of these. */
export const COMMAND_SYMBOLS = deepFreeze(Object.fromEntries(
  COMMAND_FAMILIES.flatMap((family) => family.symbols.map((symbol) => [symbol, family.commandId])),
));

const COMMANDS = deepFreeze([
  {
    id: 'open-conversation',
    summary: 'Open a saved conversation for local reading.',
    inputs: schema({
      conversationId: stringField(128, { pattern: CONVERSATION_SHAPE, description: 'World conversation id (c- prefix). Shape only; not looked up.' }),
    }, ['conversationId']),
    scope: 'read',
    requiresConfirmation: false,
    effects: 'Would show one saved conversation. Would not attach a browser, send a message, or change the conversation.',
    preconditions: [
      'conversationId matches the world conversation id shape.',
      'This preview does not check that the conversation exists.',
    ],
    unavailableReason: null,
  },
  {
    id: 'find',
    summary: 'Find saved local records by text.',
    inputs: schema({
      q: stringField(200, { multiline: true, description: 'Bounded local query text. May contain newlines and tabs.' }),
      kind: { type: 'string', enum: LOCAL_KINDS, description: 'Optional local record family.' },
    }, ['q']),
    scope: 'read',
    requiresConfirmation: false,
    effects: 'Would list saved local records that match the query. Would not search a provider or the network.',
    preconditions: [
      'q is a bounded nonempty string.',
      'kind, when present, is a known local record family.',
    ],
    unavailableReason: null,
  },
  {
    id: 'add-to-project',
    summary: 'Add a local record to a local project.',
    inputs: schema({
      projectId: stringField(64, { pattern: PROJECT_SHAPE, description: 'Local project id (p- prefix). Shape only; not looked up.' }),
      targetId: stringField(64, { pattern: WORLD_REFERENCE_SHAPE, description: 'Local record reference (c-/p-/n-/o-/s- prefix). Shape only; not looked up.' }),
    }, ['projectId', 'targetId']),
    scope: 'local-write',
    requiresConfirmation: true,
    effects: 'Would record a local project membership after confirmation. Would not publish, sync, or send anything.',
    preconditions: [
      'projectId and targetId match world id shape.',
      'Confirmation is required before any future write.',
      'This preview does not check that either id exists.',
    ],
    unavailableReason: null,
  },
  {
    id: 'add-note',
    summary: 'Add a note to the local world.',
    inputs: schema({
      title: stringField(120),
      body: stringField(4000, { multiline: true, description: 'Note text. May contain newlines and tabs.' }),
      projectId: stringField(64, { pattern: PROJECT_SHAPE, description: 'Optional local project id (p- prefix). Shape only; not looked up.' }),
    }, ['title', 'body']),
    scope: 'local-write',
    requiresConfirmation: true,
    effects: 'Would store a note locally after confirmation. Would not send the note to a provider.',
    preconditions: [
      'title and body are bounded text.',
      'Confirmation is required before any future write.',
      'projectId, when present, is shape-checked only.',
    ],
    unavailableReason: null,
  },
  {
    id: 'export-selection',
    summary: 'Export a local selection.',
    inputs: schema({
      selectionId: stringField(64, { pattern: SELECTION_SHAPE, description: 'Local selection id (s- prefix). Shape only; not looked up.' }),
    }, ['selectionId']),
    scope: 'local-write',
    requiresConfirmation: true,
    effects: 'Would write a local export of one selection after confirmation. Would not upload it.',
    preconditions: [
      'selectionId matches world id shape.',
      'Confirmation is required before any future write.',
      'This preview does not check that the selection exists and does not write a file.',
    ],
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
    preconditions: [
      'source is a bounded local name, not a path or URL.',
      'format, when present, is json or jsonl.',
      'This preview does not open the source.',
    ],
    unavailableReason: null,
  },
  {
    id: 'provider-send',
    summary: 'Send a prompt to a live provider conversation.',
    inputs: schema({
      conversationId: stringField(128, { pattern: CONVERSATION_SHAPE, description: 'World conversation id (c- prefix). Shape only; not contacted.' }),
      prompt: stringField(4000, { description: 'Prompt text. Not sent.' }),
    }, ['conversationId', 'prompt']),
    scope: 'external-effect',
    requiresConfirmation: true,
    effects: 'Would send a prompt outside this machine. This command is not available.',
    preconditions: [
      'A live provider and browser owner would be required.',
      'Confirmation would be required.',
      'Neither is available in this catalog.',
    ],
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
const knownCategories = new Set(CATEGORIES);
const familyIds = new Set();
const familyOwners = new Map();
const familyById = new Map();
for (const family of COMMAND_FAMILIES) {
  if (!FAMILY_ID_RE.test(family.id)) throw new Error(`Invalid family id: ${family.id}`);
  if (familyIds.has(family.id)) throw new Error(`Duplicate family: ${family.id}`);
  if (COMMANDS.some((command) => command.id === family.id)) throw new Error(`Family ${family.id} shadows a command id`);
  if (!knownCategories.has(family.category)) throw new Error(`Invalid category for family ${family.id}`);
  const command = COMMANDS.find((entry) => entry.id === family.commandId);
  if (!command) throw new Error(`Family ${family.id} points at unknown command ${family.commandId}`);
  if (typeof family.summary !== 'string' || family.summary.length === 0) throw new Error(`Family ${family.id} needs a summary`);
  if (!Array.isArray(family.symbols) || family.symbols.length === 0) throw new Error(`Family ${family.id} needs at least one symbol`);
  familyIds.add(family.id);
  familyById.set(family.id, family);
  for (const symbol of family.symbols) {
    if (!SYMBOL_RE.test(symbol)) throw new Error(`Invalid symbol ${symbol} in family ${family.id}`);
    const key = normalizeCommandInput(symbol);
    if (familyOwners.has(key)) throw new Error(`Duplicate symbol: ${symbol}`);
    familyOwners.set(key, family);
  }
  // A suggestion may only name a real field of that family's own command schema, with a real enum value.
  for (const [key, value] of Object.entries(family.suggests)) {
    if (!Object.hasOwn(command.inputs.properties, key)) throw new Error(`Family ${family.id} suggests unknown field ${key}`);
    const spec = command.inputs.properties[key];
    if (spec.enum && !spec.enum.includes(value)) throw new Error(`Family ${family.id} suggests a value outside ${key}`);
  }
}
for (const command of COMMANDS) {
  if (!COMMAND_FAMILIES.some((family) => family.commandId === command.id)) throw new Error(`Command ${command.id} has no family`);
}

const symbolOwners = new Map();
for (const [symbol, id] of Object.entries(COMMAND_SYMBOLS)) {
  if (!COMMANDS.some((command) => command.id === id)) throw new Error(`Symbol ${symbol} points at unknown command ${id}`);
  const key = normalizeCommandInput(symbol);
  if (symbolOwners.has(key)) throw new Error(`Duplicate symbol: ${symbol}`);
  symbolOwners.set(key, id);
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

/** Immutable structural copy: every nested object/array becomes a fresh frozen snapshot. */
function snapshot(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(snapshot));
  if (value && typeof value === 'object') {
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, snapshot(entry)])));
  }
  return value;
}

export function normalizeCommandInput(value) {
  return String(value ?? '').trim().toLowerCase().replace(/[ \t]+/g, ' ');
}

function publicCommand(command) {
  return Object.freeze({
    id: command.id,
    summary: command.summary,
    inputs: snapshot(command.inputs),
    scope: command.scope,
    requiresConfirmation: command.requiresConfirmation,
    effects: command.effects,
    preconditions: snapshot(command.preconditions),
    unavailableReason: command.unavailableReason,
    symbols: snapshot(Object.entries(COMMAND_SYMBOLS).filter(([, id]) => id === command.id).map(([symbol]) => symbol)),
    families: snapshot(COMMAND_FAMILIES.filter((family) => family.commandId === command.id).map((family) => ({
      id: family.id,
      category: family.category,
      summary: family.summary,
    }))),
  });
}

function publicFamily(family) {
  const command = commandById(family.commandId);
  return Object.freeze({
    id: family.id,
    category: family.category,
    summary: family.summary,
    commandId: family.commandId,
    scope: command.scope,
    requiresConfirmation: command.requiresConfirmation,
    unavailableReason: command.unavailableReason,
    symbols: snapshot(family.symbols),
    suggests: snapshot(family.suggests),
    // A suggestion is advisory data. The preview gate never merges it into caller arguments.
    suggestionNote: 'Suggested argument values only; not applied. Preview validates exactly the arguments passed.',
  });
}

/** Deep-frozen copy of every semantic family, in catalog order. Pure data; nothing is performed. */
export function listCommandFamilies() {
  return COMMAND_FAMILIES.map(publicFamily);
}

function familyFor(input) {
  if (typeof input !== 'string') return null;
  const normalized = normalizeCommandInput(input);
  if (!normalized || normalized.length > 64) return null;
  return familyById.get(normalized) ?? familyOwners.get(normalized) ?? null;
}

function commandById(id) {
  return COMMANDS.find((command) => command.id === id) ?? null;
}

function exactCommand(input) {
  if (typeof input !== 'string') return null;
  const normalized = normalizeCommandInput(input);
  if (!normalized || normalized.length > 64) return null;
  const family = familyFor(normalized);
  return commandById(normalized) ?? commandById(symbolOwners.get(normalized)) ?? (family ? commandById(family.commandId) : null) ?? null;
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

// Real ranking only: a token that overlaps nothing yields NO candidates rather than
// an unfalsifiable "everything at score 0" list.
function candidatesFor(input) {
  const normalized = typeof input === 'string' ? normalizeCommandInput(input) : '';
  return COMMANDS.map((command) => ({ id: command.id, summary: command.summary, score: scoreCommand(normalized, command) }))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, 8);
}

function scoreFamily(normalized, family) {
  let score = 0;
  if (family.id === normalized) score += 100;
  if (familyOwners.get(normalized)?.id === family.id) score += 100;
  if (normalized.length >= 2 && (family.id.startsWith(normalized) || normalized.startsWith(family.id))) score += 10;
  const tokens = normalized.split(/[^a-z0-9]+/).filter((token) => token.length >= 2);
  for (const token of tokens) {
    if (family.id.includes(token)) score += 5;
    if (family.category === token) score += 5;
    if (family.summary.toLowerCase().includes(token)) score += 2;
  }
  return score;
}

// Family ranking mirrors command ranking: exact family id or symbol beats prefix overlap beats
// token overlap, ties break on id, and a token that overlaps nothing yields no candidates at all.
function familyCandidatesFor(normalized) {
  return COMMAND_FAMILIES.map((family) => ({ family, score: scoreFamily(normalized, family) }))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score || a.family.id.localeCompare(b.family.id))
    .slice(0, 8)
    .map(({ family, score }) => ({ familyId: family.id, commandId: family.commandId, category: family.category, score }));
}

/**
 * Pure interpretation of a symbol, a family id, a command id, or loose intent text into candidate
 * commands. Reads frozen catalog data only: no store, no network, no browser, no mutation, and no
 * run-now claim. An exact hit answers with one candidate at score 100; otherwise ranked candidates
 * (families first, then commands) or an empty list. Selecting a candidate is still not permission to
 * act: the caller must go through the preview gate, which validates arguments and explains effects.
 */
export function interpretCommandInput(input) {
  const normalized = typeof input === 'string' ? normalizeCommandInput(input) : '';
  if (!normalized) {
    return snapshot({
      input: '',
      exact: false,
      family: null,
      command: null,
      candidates: [],
      reason: 'No symbol, family, or command was named.',
    });
  }
  if (normalized.length > 64) {
    return snapshot({
      input: normalized.slice(0, 64),
      exact: false,
      family: null,
      command: null,
      candidates: [],
      reason: 'Interpretation input is longer than any catalog id or symbol.',
    });
  }
  const family = familyFor(normalized);
  if (family) {
    const command = commandById(family.commandId);
    return snapshot({
      input: normalized,
      exact: true,
      family: publicFamily(family),
      command: { id: command.id, summary: command.summary, scope: command.scope, requiresConfirmation: command.requiresConfirmation },
      candidates: [{ familyId: family.id, commandId: command.id, category: family.category, score: 100 }],
      reason: null,
    });
  }
  const exactCommandMatch = exactCommand(normalized);
  if (exactCommandMatch) {
    return snapshot({
      input: normalized,
      exact: true,
      family: null,
      command: { id: exactCommandMatch.id, summary: exactCommandMatch.summary, scope: exactCommandMatch.scope, requiresConfirmation: exactCommandMatch.requiresConfirmation },
      candidates: [{ familyId: null, commandId: exactCommandMatch.id, category: null, score: 100 }],
      reason: null,
    });
  }
  const familyCandidates = familyCandidatesFor(normalized);
  const candidates = familyCandidates.length
    ? familyCandidates
    : candidatesFor(normalized).map((candidate) => ({ familyId: null, commandId: candidate.id, category: null, score: candidate.score }));
  return snapshot({
    input: normalized,
    exact: false,
    family: null,
    command: null,
    candidates,
    reason: candidates.length
      ? 'No exact family; ranked candidates only. Nothing was selected or performed.'
      : 'Input did not match a family, symbol, or command. Nothing was selected or performed.',
  });
}

const CONTROL_RE = /[\u0000-\u001f\u007f]/;
// Multi-line free-text fields additionally allow \n (0x0a) and \t (0x09).
const MULTILINE_CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f]/;

function controlChars(value, multiline = false) {
  return (multiline ? MULTILINE_CONTROL_RE : CONTROL_RE).test(value);
}

function checkValue(key, spec, value, errors, uncertain) {
  if (spec.enum) {
    if (typeof value !== 'string' || !spec.enum.includes(value)) errors.push(`${key} must be one of: ${spec.enum.join(', ')}`);
    return;
  }
  if (spec.type === 'string') {
    if (typeof value !== 'string') { errors.push(`${key} must be a string`); return; }
    if (controlChars(value, spec.multiline === true)) errors.push(`${key} contains control characters`);
    if (value.length < (spec.minLength ?? 0)) errors.push(`${key} must be at least ${spec.minLength} characters`);
    if (value.length > spec.maxLength) errors.push(`${key} exceeds ${spec.maxLength} characters`);
    if (spec.pattern && !new RegExp(spec.pattern).test(value)) errors.push(`${key} does not match the required shape`);
    else if (spec.pattern) uncertain.push(`${key} matched an id shape only; it was not resolved in a store.`);
  } else errors.push(`${key} has an unsupported type`);
}

function validateArgs(command, args) {
  const errors = [];
  const uncertain = [];
  // Plain-object gate (as gateBody does): arrays, class instances, Maps/ Dates and any
  // non-plain prototype are rejected, so inherited properties are never read.
  const plain = (value) => {
    if (!value || typeof value !== 'object') return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  };
  if (args === undefined) args = {};
  if (!plain(args)) return { errors: ['arguments must be a JSON object'], uncertain };
  const properties = command.inputs.properties;
  const keys = Object.keys(args);
  if (keys.length > 16) errors.push('too many arguments');
  for (const key of keys) if (!Object.hasOwn(properties, key)) errors.push(`unknown argument: ${key}`);
  for (const key of command.inputs.required) {
    if (!Object.hasOwn(args, key) || args[key] === undefined || args[key] === null || args[key] === '') errors.push(`missing argument: ${key}`);
  }
  for (const [key, spec] of Object.entries(properties)) {
    if (!Object.hasOwn(args, key) || args[key] === undefined) continue;
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
  // No field here claims a command can run now: canProceed means "arguments are valid"
  // (always false for external-effect), and the confirmation gate is only ever future tense.
  return {
    valid,
    canProceed: valid,
    errors,
    wouldDo,
    scope: command.scope,
    wouldRequireConfirmation: command.requiresConfirmation,
    uncertain,
    candidates: [],
  };
}

function unknownPreview(input) {
  return {
    valid: false,
    canProceed: false,
    errors: ['Unknown command or symbol; no command was selected.'],
    wouldDo: ['Nothing was performed.'],
    scope: null,
    wouldRequireConfirmation: null,
    uncertain: ['Input did not exactly match a command id or an explicit symbol.'],
    candidates: candidatesFor(input),
  };
}

function gateRouteId(id) {
  // COMMAND_ID_RE is a strict subset of ROUTE_TOKEN_RE (case-insensitive), so one check suffices.
  if (typeof id !== 'string' || id.length < 1 || id.length > 64 || id.includes('..') || id.includes('/') || id.includes('\\') || /\s/u.test(id) || controlChars(id) || !ROUTE_TOKEN_RE.test(id)) {
    throw problem(400, 'Command id is malformed', 'WORLD_INVALID_INPUT');
  }
  return id;
}

function gateBody(body) {
  if (body === undefined) return {};
  const prototype = body && typeof body === 'object' ? Object.getPrototypeOf(body) : false;
  if (!body || typeof body !== 'object' || Array.isArray(body) || (prototype !== Object.prototype && prototype !== null)) {
    throw problem(400, 'Preview body must be a JSON object', 'WORLD_INVALID_INPUT');
  }
  let encoded;
  try { encoded = JSON.stringify(body); } catch { throw problem(400, 'Preview body must be a JSON object', 'WORLD_INVALID_INPUT'); }
  // Generous outer bound only: schema field limits (checked per command) are the real validation,
  // so 6x JSON escaping of a maximum-length field can never turn valid data into a 400.
  if (encoded.length > 65536) throw problem(400, 'Preview body exceeds 65536 characters', 'WORLD_INVALID_INPUT');
  if (Object.keys(body).length > 16) throw problem(400, 'Preview body has too many fields', 'WORLD_INVALID_INPUT');
  return body;
}

function gateInput(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 128 || controlChars(value)) {
    throw problem(400, 'input must be a string of 1 to 128 characters without control characters', 'WORLD_INVALID_INPUT');
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
  // GET /commands?symbol=%2Ffind is the explicit endpoint-safe symbol resolution path (as data,
  // never a 404): it returns the route-safe command id that describe/preview routes accept.
  add('GET', '/commands', 'List semantic commands; resolve command ids or symbols as data via ?input= or ?symbol=. Catalog only; nothing is performed.', ({ q } = {}) => {
    if (q?.symbol !== undefined) {
      const resolved = catalog.resolve(gateInput(q.symbol));
      return { symbol: resolved.input, exact: resolved.exact, id: resolved.id, command: resolved.exact ? catalog.describe(resolved.id) : null, candidates: resolved.candidates };
    }
    if (q?.input !== undefined) return catalog.resolve(gateInput(q.input));
    return { commands: catalog.list(), families: listCommandFamilies(), categories: snapshot(CATEGORIES) };
  });
  add('GET', '/commands/{id}', 'Describe one semantic command by route-safe token (resolve symbols via GET /commands?symbol=...). Unknown ids resolve as data: { found: false, candidates }. Nothing is performed.', ({ p } = {}) => {
    const id = gateRouteId(p?.id);
    const command = catalog.describe(id);
    if (!command) return { found: false, id, candidates: catalog.resolve(id).candidates };
    return { found: true, command };
  });
  add('POST', '/commands/{id}/preview', 'Preview one semantic command by route-safe token. Validates and explains; a confirmation gate would always precede any future write, and nothing is performed.', ({ p, body } = {}) => {
    const id = gateRouteId(p?.id);
    return catalog.preview(id, gateBody(body));
  });
  return catalog;
}
