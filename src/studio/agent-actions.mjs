// Pure protocol module: the action language a WEB AI (ChatGPT/Claude/Gemini/DeepSeek/Z.ai/Qwen,
// typed into in a dedicated signed-in browser tab, no API access, no native tool-calling) writes
// into its own reply so it can act as the primary agent — plan, read/edit local files, run approved
// commands, ask the other web AIs, and report back — the way a coding orchestrator does today.
//
// This module has NO side effects of its own: no filesystem, network, process or browser access.
// It only parses a reply into actions, validates one action against a workspace/budget context,
// classifies it read-only vs effect, renders a plain-language approval summary, renders a compact
// observation to send back to the AI, and builds the one-time instruction text that teaches a web AI
// this protocol. A later lane (the agent loop) is the only thing that actually reads/writes files,
// runs commands or calls src/studio/ai-orchestrator.mjs for ask_ai — this module never does.
//
// Parsing follows the same tolerant approach as src/studio/personal-app-provider-reply.mjs: smart
// quotes are straightened, exactly one JSON object is accepted (fenced ```json preferred, a single
// bare fence or embedded object otherwise), and more than one candidate is refused with a plain next
// step rather than guessed at. The constants below (ask_ai patterns/sites) intentionally MIRROR
// src/studio/orchestrator-patterns.mjs rather than importing it: this file stays import-free from the
// rest of Studio so it can be reviewed, tested and reused on its own. Keep the two lists in sync by
// hand if the orchestrator's pattern/site catalog changes.
import nodePath from 'node:path';

// ---------------------------------------------------------------------------------------------
// Closed vocabulary
export const ACTION_TYPES = Object.freeze([
  'read_file', 'list_files', 'search', 'propose_edit', 'write_file',
  'run_command', 'ask_ai', 'save_to_work', 'note', 'finish',
]);
// Mirrors orchestrator-patterns.mjs PATTERN_NAMES / SITE_LABELS (see note above).
export const ASK_AI_PATTERNS = Object.freeze([
  'single', 'fanout', 'race', 'fallback', 'hedge', 'council', 'judge', 'relay', 'critique', 'verify',
]);
export const ASK_AI_SITES = Object.freeze(['chatgpt', 'claude', 'gemini', 'deepseek', 'zai', 'qwen']);
export const FINISH_STATUSES = Object.freeze(['done', 'blocked', 'needs_owner']);
const READ_ONLY_TYPES = new Set(['read_file', 'list_files', 'search', 'note', 'finish']);

export const DEFAULT_BUDGETS = Object.freeze({
  maxSteps: 40,            // total actions a loop will run before it must stop and ask the owner
  maxSends: 8,             // total ask_ai sends to other web AIs in one loop
  maxReadBytes: 200_000,   // ceiling on a single read_file's maxBytes
  maxWriteBytes: 200_000,  // ceiling on write_file content / propose_edit find+replace+unifiedDiff
  maxCommandSeconds: 300,  // ceiling on run_command timeoutSec
  maxObservationBytes: 8_000, // ceiling on renderObservation's total output
  maxActionsPerReply: 8,   // ceiling on actions inside one parsed reply (parse-time, not overridable)
});
export const MAX_ACTIONS_PER_REPLY = DEFAULT_BUDGETS.maxActionsPerReply;
const MAX_QUESTION_CHARS = 10_000; // mirrors orchestrator-patterns.mjs MAX_QUESTION

// ---------------------------------------------------------------------------------------------
// Tolerant reply parsing (adapted from personal-app-provider-reply.mjs's extractProposalText)
const FENCE = /```[ \t]*([A-Za-z0-9_-]*)[ \t]*\r?\n([\s\S]*?)\r?\n?```/g;
const SMART_SINGLE = /[\u2018\u2019\u201A\u201B]/g;
const SMART_DOUBLE = /[\u201C\u201D\u201E\u201F]/g;
const straightenQuotes = (text) => text.replace(SMART_SINGLE, "'").replace(SMART_DOUBLE, '"');
// Control characters that must never appear in a single-line field (path, command, etc).
const CONTROL_LINE = /[\u0000-\u001f\u007f]/;
// Control characters disallowed in multi-line text fields (content, say, question...); \t \n \r kept.
const CONTROL_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

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
      i = end;
    } catch { /* not JSON: keep scanning from the next brace */ }
  }
  return found;
}

function problem(code, message) { return { code, message }; }
function parseFail(code, message, retryPrompt) { return { ok: false, problem: problem(code, message), retryPrompt }; }

const RETRY_FORMAT = 'Reply with exactly one fenced code block like:\n```json\n{"actions":[{"type":"note","text":"..."}],"say":"..."}\n```';

// Pick the one candidate JSON object out of a reply, or refuse with a plain next step.
function extractJsonCandidate(replyText) {
  const text = straightenQuotes(String(replyText ?? ''));
  const blocks = [...text.matchAll(FENCE)]
    .filter(([, tag, body]) => (tag ? tag.toLowerCase() === 'json' : body.trim().startsWith('{')))
    .map((match) => match[2].trim());
  if (blocks.length > 1) return { ambiguous: true };
  if (blocks.length === 1) return { candidate: blocks[0] };
  const whole = text.trim();
  if (whole.startsWith('{')) return { candidate: whole };
  const objects = whole.length <= 100_000 ? jsonObjectsIn(whole) : [];
  if (objects.length > 1) return { ambiguous: true };
  if (objects.length === 1) return { candidate: objects[0] };
  return { candidate: null };
}

/**
 * Parse one web-AI reply into {actions, say}. Pure text in, structured result out.
 * @returns {{ok:true, actions:object[], say:string} | {ok:false, problem:{code,message}, retryPrompt:string}}
 */
export function parseAgentReply(text) {
  const { ambiguous, candidate } = extractJsonCandidate(text);
  if (ambiguous) {
    return parseFail('AGENT_REPLY_AMBIGUOUS',
      'The reply contained more than one possible JSON block.',
      'Your reply had more than one JSON block, so I don\u2019t know which to use. ' + RETRY_FORMAT);
  }
  if (!candidate) {
    return parseFail('AGENT_REPLY_NO_JSON',
      'No JSON object was found in the reply.',
      'I couldn\u2019t find a JSON action block in your reply. ' + RETRY_FORMAT);
  }
  let parsed;
  try { parsed = JSON.parse(candidate); }
  catch (error) {
    return parseFail('AGENT_REPLY_INVALID_JSON',
      `The JSON could not be parsed: ${error.message}`,
      `I couldn\u2019t read that as JSON (${error.message}). ` + RETRY_FORMAT);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return parseFail('AGENT_REPLY_SHAPE',
      'The top-level JSON value must be an object with an "actions" array.',
      'Your JSON must be a single object with an "actions" array and an optional "say" string. ' + RETRY_FORMAT);
  }
  const { actions, say } = parsed;
  if (!Array.isArray(actions) || actions.length === 0) {
    return parseFail('AGENT_REPLY_SHAPE',
      'The "actions" field must be a non-empty array.',
      'Include at least one action in "actions". ' + RETRY_FORMAT);
  }
  if (actions.length > MAX_ACTIONS_PER_REPLY) {
    return parseFail('AGENT_REPLY_TOO_MANY_ACTIONS',
      `At most ${MAX_ACTIONS_PER_REPLY} actions are allowed in one reply.`,
      `That\u2019s too many actions for one turn (max ${MAX_ACTIONS_PER_REPLY}). Send the first few, then continue after you see the results.`);
  }
  if (say !== undefined && typeof say !== 'string') {
    return parseFail('AGENT_REPLY_SHAPE', 'The "say" field must be a string when present.',
      '"say" must be plain text. ' + RETRY_FORMAT);
  }
  for (const action of actions) {
    const type = action?.type;
    if (typeof type !== 'string' || !ACTION_TYPES.includes(type)) {
      return parseFail('AGENT_ACTION_UNKNOWN',
        `Unknown action type: ${JSON.stringify(type ?? null)}`,
        `I don\u2019t know the action type ${JSON.stringify(type ?? null)}. Use one of: ${ACTION_TYPES.join(', ')}. ` + RETRY_FORMAT);
    }
  }
  return { ok: true, actions, say: typeof say === 'string' ? say : '' };
}

// ---------------------------------------------------------------------------------------------
// Workspace scoping and secret-path refusal
function scopePath(raw, workspaceRoot) {
  if (typeof raw !== 'string' || !raw.trim()) return { ok: false, code: 'PATH_MISSING', message: 'A path is required.' };
  if (CONTROL_LINE.test(raw)) return { ok: false, code: 'PATH_INVALID', message: 'The path contains control characters.' };
  if (nodePath.isAbsolute(raw)) {
    return { ok: false, code: 'PATH_ABSOLUTE', message: `"${raw}" must be relative to the project folder, not an absolute path.` };
  }
  const root = nodePath.resolve(workspaceRoot);
  const resolved = nodePath.resolve(root, raw);
  const rel = nodePath.relative(root, resolved);
  if (rel.startsWith('..') || nodePath.isAbsolute(rel)) {
    return { ok: false, code: 'PATH_ESCAPE', message: `"${raw}" points outside the project folder.` };
  }
  return { ok: true, abs: resolved, rel: rel === '' ? '.' : rel.split(nodePath.sep).join('/') };
}

const SECRET_PATH_PATTERNS = [
  /(^|\/)\.env(\..+)?$/, /(^|\/)\.env\.local$/, /(^|\/)\.ssh(\/|$)/, /(^|\/)\.gnupg(\/|$)/, /(^|\/)\.aws(\/|$)/,
  /(^|\/)\.npmrc$/, /(^|\/)\.netrc$/, /id_rsa(\.pub)?$/, /id_ed25519(\.pub)?$/,
  /\.(pem|pfx|p12|keystore|jks|key)$/, /credential/, /\bsecret/, /\btoken/, /password/,
];
const isSecretLookingPath = (rel) => SECRET_PATH_PATTERNS.some((re) => re.test(rel.toLowerCase()));

// ---------------------------------------------------------------------------------------------
// Destructive command denylist. Deliberately a DENY list over an impossible allow list: everything
// not matched here is still an "effect" needing explicit owner approval before it runs.
export const DENY_COMMANDS = Object.freeze([
  { re: /\brm\s+-[a-z]*r[a-z]*f[a-z]*\b|\brm\s+-[a-z]*f[a-z]*r[a-z]*\b/i, reason: 'recursive force delete (rm -rf)' },
  { re: /\bsudo\s+rm\b/i, reason: 'elevated delete' },
  { re: /\bformat\s+[a-z]:/i, reason: 'disk format' },
  { re: /\bmkfs\b/i, reason: 'filesystem format' },
  { re: /\bdiskpart\b/i, reason: 'disk partitioning tool' },
  { re: /\bdd\s+if=/i, reason: 'raw disk clone/overwrite' },
  { re: /\bvssadmin\b/i, reason: 'volume shadow copy admin tool' },
  { re: /git\s+push\b[^\n]*(--force\b|--force-with-lease\b|\s-f\b)/i, reason: 'force push' },
  { re: /remove-item\b[^\n]*-recurse[^\n]*-force\b|remove-item\b[^\n]*-force[^\n]*-recurse\b/i, reason: 'recursive force delete (Remove-Item)' },
  { re: /remove-item\b[^\n]*(['"]?[a-z]:\\\s*['"]?\s*$|~\s*$|\$env:userprofile)/i, reason: 'delete at a drive or home root' },
  { re: /\bdel\s+\/s\s+\/q\b[^\n]*[a-z]:\\\s*$/i, reason: 'recursive quiet delete of a drive root' },
  { re: /\breg\s+(add|delete)\b/i, reason: 'registry edit' },
  { re: /\bregedit\b/i, reason: 'registry editor' },
  { re: /set-itemproperty\b[^\n]*hk(lm|cu):/i, reason: 'registry edit' },
  { re: /remove-item\b[^\n]*hk(lm|cu):/i, reason: 'registry edit' },
  { re: /\bgit\s+credential\b/i, reason: 'credential store access' },
  { re: /\bcmdkey\b/i, reason: 'Windows credential manager' },
  { re: /\bvault\s+login\b/i, reason: 'secrets vault login' },
  { re: /\baws\s+configure\b/i, reason: 'cloud credential setup' },
  { re: /\bgh\s+auth\s+login\b/i, reason: 'auth token login' },
  { re: /\bssh-keygen\b/i, reason: 'key generation/overwrite' },
  { re: /\bshutdown\b/i, reason: 'shuts down or restarts the PC' },
  { re: /\brestart-computer\b/i, reason: 'restarts the PC' },
]);
const deniedCommandReason = (command) => DENY_COMMANDS.find((entry) => entry.re.test(command))?.reason ?? null;

// ---------------------------------------------------------------------------------------------
// Small field helpers
const isStr = (v) => typeof v === 'string';
const nonEmpty = (v, max) => isStr(v) && v.trim().length > 0 && v.length <= max && !CONTROL_TEXT.test(v);
const singleLine = (v, max) => isStr(v) && v.trim().length > 0 && v.length <= max && !CONTROL_LINE.test(v);
const clip = (text, max) => (text.length <= max ? text : text.slice(0, max) + '\u2026');
const fail = (code, message) => ({ ok: false, problem: problem(code, message) });

function mergeBudgets(budgets) { return { ...DEFAULT_BUDGETS, ...(budgets && typeof budgets === 'object' ? budgets : {}) }; }
function mergeUsed(used) { return { steps: 0, sends: 0, ...(used && typeof used === 'object' ? used : {}) }; }

/**
 * Validate one parsed action against workspace scoping, secret-path refusal, destructive-command
 * denial and per-loop budgets. Never touches disk, network or a process: it only checks shapes.
 * @param {object} action one entry from parseAgentReply(...).actions
 * @param {{workspaceRoot:string, budgets?:object, used?:{steps?:number, sends?:number}}} ctx
 * @returns {{ok:true, action:object} | {ok:false, problem:{code,message}}}
 */
export function validateAction(action, ctx = {}) {
  const { workspaceRoot } = ctx;
  if (typeof workspaceRoot !== 'string' || !workspaceRoot) throw new TypeError('ctx.workspaceRoot (absolute path string) is required');
  const budgets = mergeBudgets(ctx.budgets), used = mergeUsed(ctx.used);
  const type = action?.type;
  if (typeof type !== 'string' || !ACTION_TYPES.includes(type)) {
    return fail('AGENT_ACTION_UNKNOWN', `Unknown action type: ${JSON.stringify(type ?? null)}`);
  }
  if (used.steps >= budgets.maxSteps) {
    return fail('BUDGET_STEPS', `This loop already used its step budget (${budgets.maxSteps}). Ask the owner to continue before doing more.`);
  }

  function path(raw, label) {
    const scoped = scopePath(raw, workspaceRoot);
    if (!scoped.ok) return fail(scoped.code, `${label}: ${scoped.message}`);
    if (isSecretLookingPath(scoped.rel)) return fail('PATH_SECRET', `${label}: "${raw}" looks like a secret or credential file and is refused.`);
    return { ok: true, rel: scoped.rel };
  }

  switch (type) {
    case 'read_file': {
      const p = path(action.path, 'path'); if (!p.ok) return p;
      const maxBytes = action.maxBytes === undefined ? Math.min(20_000, budgets.maxReadBytes) : action.maxBytes;
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > budgets.maxReadBytes) {
        return fail('FIELD_INVALID', `maxBytes must be a whole number from 1 to ${budgets.maxReadBytes}.`);
      }
      return { ok: true, action: { type, path: p.rel, maxBytes } };
    }
    case 'list_files': {
      const dir = action.dir === undefined || action.dir === '' ? '.' : action.dir;
      const p = path(dir, 'dir'); if (!p.ok) return p;
      if (action.glob !== undefined && !singleLine(action.glob, 200)) return fail('FIELD_INVALID', 'glob must be a short single-line string.');
      return { ok: true, action: { type, dir: p.rel, glob: action.glob ?? null } };
    }
    case 'search': {
      if (!nonEmpty(action.pattern, 500)) return fail('FIELD_INVALID', 'pattern is required (text or /regex/, up to 500 characters).');
      const dir = action.dir === undefined || action.dir === '' ? '.' : action.dir;
      const p = path(dir, 'dir'); if (!p.ok) return p;
      return { ok: true, action: { type, pattern: action.pattern, dir: p.rel } };
    }
    case 'propose_edit': {
      const p = path(action.path, 'path'); if (!p.ok) return p;
      const hasFindReplace = action.find !== undefined || action.replace !== undefined;
      const hasDiff = action.unifiedDiff !== undefined;
      if (hasFindReplace === hasDiff) return fail('FIELD_INVALID', 'Give exactly one of {find, replace} or {unifiedDiff}.');
      if (hasFindReplace) {
        if (!isStr(action.find) || !action.find.length || CONTROL_TEXT.test(action.find)) return fail('FIELD_INVALID', 'find must be a non-empty string.');
        if (!isStr(action.replace) || CONTROL_TEXT.test(action.replace)) return fail('FIELD_INVALID', 'replace must be a string.');
        if (action.find.length + action.replace.length > budgets.maxWriteBytes) return fail('CONTENT_TOO_LARGE', `find+replace exceeds the ${budgets.maxWriteBytes}-character budget for one edit.`);
        return { ok: true, action: { type, path: p.rel, find: action.find, replace: action.replace } };
      }
      if (!isStr(action.unifiedDiff) || !action.unifiedDiff.trim() || CONTROL_TEXT.test(action.unifiedDiff)) return fail('FIELD_INVALID', 'unifiedDiff must be a non-empty string.');
      if (action.unifiedDiff.length > budgets.maxWriteBytes) return fail('CONTENT_TOO_LARGE', `unifiedDiff exceeds the ${budgets.maxWriteBytes}-character budget for one edit.`);
      return { ok: true, action: { type, path: p.rel, unifiedDiff: action.unifiedDiff } };
    }
    case 'write_file': {
      const p = path(action.path, 'path'); if (!p.ok) return p;
      if (!isStr(action.content) || CONTROL_TEXT.test(action.content)) return fail('FIELD_INVALID', 'content must be a string.');
      if (action.content.length > budgets.maxWriteBytes) return fail('CONTENT_TOO_LARGE', `content exceeds the ${budgets.maxWriteBytes}-character write budget.`);
      return { ok: true, action: { type, path: p.rel, content: action.content } };
    }
    case 'run_command': {
      if (!singleLine(action.command, 4000)) return fail('FIELD_INVALID', 'command must be a non-empty single-line string (up to 4000 characters).');
      const reason = deniedCommandReason(action.command);
      if (reason) return fail('COMMAND_DENIED', `Refused: this command looks like ${reason}. Nothing was run.`);
      let cwd = '.';
      if (action.cwd !== undefined && action.cwd !== '') { const p = path(action.cwd, 'cwd'); if (!p.ok) return p; cwd = p.rel; }
      const timeoutSec = action.timeoutSec === undefined ? 60 : action.timeoutSec;
      if (!Number.isSafeInteger(timeoutSec) || timeoutSec < 1 || timeoutSec > budgets.maxCommandSeconds) {
        return fail('FIELD_INVALID', `timeoutSec must be a whole number from 1 to ${budgets.maxCommandSeconds}.`);
      }
      return { ok: true, action: { type, command: action.command, cwd, timeoutSec } };
    }
    case 'ask_ai': {
      if (used.sends >= budgets.maxSends) return fail('BUDGET_SENDS', `This loop already used its budget of ${budgets.maxSends} questions to other AIs. Ask the owner before sending more.`);
      if (!isStr(action.pattern) || !ASK_AI_PATTERNS.includes(action.pattern)) return fail('FIELD_INVALID', `pattern must be one of: ${ASK_AI_PATTERNS.join(', ')}.`);
      let sites;
      if (action.sites === 'auto') sites = 'auto';
      else if (Array.isArray(action.sites) && action.sites.length >= 1 && action.sites.length <= ASK_AI_SITES.length
        && action.sites.every((s) => ASK_AI_SITES.includes(s)) && new Set(action.sites).size === action.sites.length) {
        sites = [...action.sites];
      } else {
        return fail('FIELD_INVALID', `sites must be "auto" or a list of unique values from: ${ASK_AI_SITES.join(', ')}.`);
      }
      if (!nonEmpty(action.question, MAX_QUESTION_CHARS)) return fail('FIELD_INVALID', `question must be 1 to ${MAX_QUESTION_CHARS} characters.`);
      return { ok: true, action: { type, pattern: action.pattern, sites, question: action.question } };
    }
    case 'save_to_work': {
      if (!nonEmpty(action.title, 200)) return fail('FIELD_INVALID', 'title must be 1 to 200 characters.');
      if (!isStr(action.note) || CONTROL_TEXT.test(action.note) || action.note.length > budgets.maxWriteBytes) {
        return fail('FIELD_INVALID', `note must be a string up to ${budgets.maxWriteBytes} characters.`);
      }
      return { ok: true, action: { type, title: action.title, note: action.note } };
    }
    case 'note': {
      if (!nonEmpty(action.text, 4000)) return fail('FIELD_INVALID', 'text must be 1 to 4000 characters.');
      return { ok: true, action: { type, text: action.text } };
    }
    case 'finish': {
      if (!nonEmpty(action.summary, 4000)) return fail('FIELD_INVALID', 'summary must be 1 to 4000 characters.');
      if (!isStr(action.status) || !FINISH_STATUSES.includes(action.status)) return fail('FIELD_INVALID', `status must be one of: ${FINISH_STATUSES.join(', ')}.`);
      return { ok: true, action: { type, summary: action.summary, status: action.status } };
    }
    default:
      return fail('AGENT_ACTION_UNKNOWN', `Unknown action type: ${type}`);
  }
}

/** Read-only vs effect, for the owner-approval gate. 'unknown' only for a malformed/invalid type. */
export function classify(action) {
  const type = action?.type;
  if (typeof type !== 'string' || !ACTION_TYPES.includes(type)) return 'unknown';
  return READ_ONLY_TYPES.has(type) ? 'read' : 'effect';
}

// ---------------------------------------------------------------------------------------------
// Plain-language one-liners for an owner approval card / event log.
const countLines = (text) => String(text ?? '').split('\n').length;
const diffStat = (diff) => {
  let added = 0, removed = 0;
  for (const line of String(diff ?? '').split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) added++; else if (line.startsWith('-')) removed++;
  }
  return { added, removed };
};

export function summarize(action) {
  const type = action?.type;
  switch (type) {
    case 'read_file': return `Read ${action.path}${action.maxBytes ? ` (up to ${action.maxBytes} bytes)` : ''}`;
    case 'list_files': return `List files in ${action.dir}${action.glob ? ` matching ${action.glob}` : ''}`;
    case 'search': return `Search for "${clip(String(action.pattern ?? ''), 80)}" in ${action.dir || 'the project folder'}`;
    case 'propose_edit': {
      if (action.unifiedDiff) { const { added, removed } = diffStat(action.unifiedDiff); return `Apply a patch to ${action.path} (+${added}/-${removed} lines)`; }
      return `Change ${countLines(action.find)} line(s) in ${action.path}`;
    }
    case 'write_file': return `Write ${action.path} (${String(action.content ?? '').length} characters)`;
    case 'run_command': return `Run: ${action.command} (in ${action.cwd && action.cwd !== '.' ? action.cwd : 'the project folder'})`;
    case 'ask_ai': {
      const who = action.sites === 'auto' ? 'an AI VIVIM picks' : (Array.isArray(action.sites) ? action.sites.join(', ') : String(action.sites));
      return `Ask ${who} (${action.pattern}): "${clip(String(action.question ?? ''), 80)}"`;
    }
    case 'save_to_work': return `Save a note to Work: "${clip(String(action.title ?? ''), 100)}"`;
    case 'note': return `Note: "${clip(String(action.text ?? ''), 100)}"`;
    case 'finish': return `Finish (${action.status}): ${clip(String(action.summary ?? ''), 100)}`;
    default: return `Unknown action: ${JSON.stringify(type ?? null)}`;
  }
}

// ---------------------------------------------------------------------------------------------
// Compact text the loop sends back to the AI after running its actions.
/**
 * @param {Array<{action:object, ok:boolean, output?:string, error?:{code?:string, message?:string}}>} results
 * @param {{maxBytes?:number}} [opts]
 */
export function renderObservation(results, opts = {}) {
  const cap = Number.isSafeInteger(opts.maxBytes) && opts.maxBytes > 0 ? opts.maxBytes : DEFAULT_BUDGETS.maxObservationBytes;
  const list = Array.isArray(results) ? results : [];
  const lines = []; let used = 0, shown = 0;
  for (const entry of list) {
    let head;
    try { head = `[${shown + 1}] ${summarize(entry?.action)} -> ${entry?.ok ? 'OK' : 'ERROR'}`; }
    catch { head = `[${shown + 1}] action -> ${entry?.ok ? 'OK' : 'ERROR'}`; }
    const body = entry?.ok
      ? (typeof entry.output === 'string' ? entry.output : '')
      : (entry?.error?.message ? `${entry.error.code ?? 'ERROR'}: ${entry.error.message}` : 'failed');
    const block = body ? `${head}\n${body}` : head;
    const remaining = cap - used;
    if (remaining <= 40) break; // leave room for the truncation note instead of a ragged tail
    const piece = block.length > remaining ? block.slice(0, remaining - 20) + '\n\u2026(truncated)' : block;
    lines.push(piece); used += piece.length; shown++;
  }
  const omitted = list.length - shown;
  let text = lines.join('\n\n');
  if (omitted > 0) text += `\n\n\u2026(${omitted} more result${omitted === 1 ? '' : 's'} omitted; ask again if you still need them)`;
  if (text.length > cap) text = text.slice(0, Math.max(0, cap - 20)) + '\n\u2026(truncated)';
  return text || '(no results)';
}

// ---------------------------------------------------------------------------------------------
// The one-time instruction text that teaches a web AI this protocol.
export function buildSystemBrief({ goal = '', workspace = '.', budgets = {} } = {}) {
  const b = mergeBudgets(budgets);
  const lines = [
    'You are acting as the primary coding agent for a local project, through VIVIM.',
    goal ? `Goal: ${goal}` : null,
    `Project folder (your workspace root): ${workspace}. You cannot see or touch anything outside it.`,
    '',
    'Reply with EXACTLY ONE fenced code block containing one JSON object, and nothing meaningful outside it:',
    '```json',
    '{"actions": [ ...one or more actions... ], "say": "a short plain message for the person watching"}',
    '```',
    '',
    'Action types (use only these; anything else is rejected):',
    '- read_file {"path": "relative/path", "maxBytes": 20000}',
    '- list_files {"dir": "relative/dir", "glob": "**/*.mjs"}',
    '- search {"pattern": "text or /regex/", "dir": "relative/dir"}',
    '- propose_edit {"path": "...", "find": "old text", "replace": "new text"}  OR  {"path": "...", "unifiedDiff": "...a unified diff..."}',
    '- write_file {"path": "...", "content": "the full new file content"}',
    '- run_command {"command": "npm test", "cwd": "relative/dir", "timeoutSec": 60}',
    `- ask_ai {"pattern": "single", "sites": ["claude"] (or "auto"), "question": "..."}  (patterns: ${ASK_AI_PATTERNS.join(', ')}; sites: ${ASK_AI_SITES.join(', ')})`,
    '- save_to_work {"title": "...", "note": "..."}',
    '- note {"text": "..."}',
    `- finish {"summary": "...", "status": "${FINISH_STATUSES.join('" | "')}"}`,
    '',
    'Rules:',
    '- Paths are relative to the project folder; absolute paths and paths that escape it are refused.',
    '- Paths that look like secrets (.env, keys, credentials, tokens) are refused \u2014 never ask to read or write them.',
    '- read_file, list_files, search, note and finish are read-only and run right away.',
    '- propose_edit, write_file, run_command, ask_ai and save_to_work are effects: the owner reviews and approves each one before it runs.',
    '- Destructive commands (recursive delete, force push, format/disk tools, registry edits, credential tools) are always refused.',
    `- Budgets for this run: up to ${b.maxSteps} actions total, up to ${b.maxSends} questions sent to other AIs, up to ${b.maxWriteBytes} characters per file write/edit.`,
    '- After each action runs you get its result as plain text, then reply again in the same one-JSON-block format.',
    '- When the task is done, or you are stuck and need the owner, use finish.',
    '',
    'Example \u2014 read a file, then propose a one-line fix, and tell the owner:',
    '```json',
    '{"actions": [',
    '  {"type": "read_file", "path": "src/app.mjs", "maxBytes": 20000},',
    '  {"type": "propose_edit", "path": "src/app.mjs", "find": "console.log(oldThing)", "replace": "console.log(newThing)"}',
    '], "say": "Found the bug in src/app.mjs and proposed a one-line fix for your approval."}',
    '```',
  ];
  return lines.filter((line) => line !== null).join('\n');
}
