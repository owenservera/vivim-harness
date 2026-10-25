// Stream-to-component map: declarative rules that say which parsed stream events open, extend,
// close or finish which UI component part of an AI chat answer, plus the DOM block-type mapping.
// Pure functions only: no I/O, no clock, no randomness. Not wired into manage/apply/families/
// derive/server/UI (a later lane does that).
//
// Vocabulary a `when` object may use (every key must match):
//   event        SSE "event:" name (decoded ev.event)
//   type         json.type; null means json.type is absent
//   block.type   json.content_block.type
//   delta.type   json.delta.type
//   path         effective JSON-patch pointer for path-ops; a trailing "*" means prefix match
//   o            effective path-op ("append" when omitted)
//   hasKey       json has this key. A dotted path (e.g. "v.error_code") checks a nested key;
//                a plain key checks the top level only (unchanged)
//   terminal     ev.terminal === true
//   data         raw SSE data string (e.g. "[DONE]")
//   nonNull      a dotted path, or an array of them (ANY): the value exists and is not null, undefined or ""
//   isObject     a dotted path whose value is a plain object (not an array, not a string)
//   equals       { "dotted.path": "text" }: the value at the path is a string equal to "text" (case-insensitive)
//
// Op "open" may carry keyPath (dotted path, open only): the component key is the usable id found at
// that path in the event itself (e.g. "v.message.id"); a message container is keyed by its id alone.
// The id also becomes the message id that later block keys use.
//
// Stream-level fields: messageIdPath and blockIndexPath are dotted paths read from the operation
// (the bare event payload, or one sub-operation of a path-op patch with its effective "p" filled
// in). blockIndexPattern, when present, is a regex whose first capture group is the block index.
// messageId is carried forward from the last event that carried one, so a block event inherits
// the id from its message_start. A componentKey is "<messageId>:<blockIndex>" only when both are
// known; otherwise it is null. Keys are never invented.
//
// Path-op handling follows src/decode/delta.mjs: a bare { v } continues the previous pointer, and
// an { o: "patch", v: [...] } envelope is expanded into its sub-operations (each keeps the parent
// sid/seq/n and gets a `sub` index).
//
// Op "signal" (additive): an event that reports something about the stream (an error envelope,
// or a status frame) rather than reply text. It never enters the timeline or the components. It is
// listed in `signals` as { sid, seq, n, kind, code, messageChars, rule }. `code` is kept only when
// it is a short token; message text is never copied, only its length (messageChars).
//
// Resolution: the first rule (in list order) whose `when` matches wins. One exception: an "append"
// rule whose textPath is not a string does not claim the event; the search continues with the rules
// after it. Such an event was unmapped before, so no timeline entry changes. This lets later rules
// (open, ignore, signal) see a bare envelope that continued a text pointer. Signal rules stay after
// the existing rules, so they cannot change what those rules already match.

export const STREAM_MAP_SCHEMA = 'capture-studio.stream-map/1';

// Mirrors families/ai-chat.json content_block.type (this module does no file I/O, so it is copied).
const FAMILY_COMPONENTS = ['paragraph', 'heading', 'list', 'table', 'code', 'quote', 'image', 'file', 'link', 'citation', 'equation', 'rule', 'tool', 'unknown'];
// Ops may also open 'message', the turn container (an entity, not a content block).
const OP_COMPONENTS = [...FAMILY_COMPONENTS, 'message'];
const OPS = ['open', 'append', 'close', 'finalize', 'ignore', 'signal'];
const WHEN_KEYS = ['event', 'type', 'block.type', 'delta.type', 'path', 'o', 'hasKey', 'terminal', 'data', 'nonNull', 'isObject', 'equals'];
const NULLABLE_WHEN = ['event', 'type', 'block.type', 'delta.type'];
const SIGNAL_KINDS = ['error', 'status'];
const DOTTED_PATH = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const isDottedPath = (s) => typeof s === 'string' && DOTTED_PATH.test(s);
// A signal code is kept only as a short token; anything else (long, spaced, numeric) becomes null.
const CODE_TOKEN = /^[A-Za-z0-9_.:-]+$/;
const codeToken = (v) => (typeof v === 'string' && v.length <= 64 && CODE_TOKEN.test(v) ? v : null);
const DIALECTS = ['json-patch', 'json-merge-patch', 'path-ops', 'dotted-set', 'array-splice', 'put-merge', 'ot-ops', 'typed-events'];

// DOM agent block types -> family component. Identity for the types shared with the family enum.
// Explicit mappings for DOM-only types. rule, equation and file exist in the family enum, so they
// keep their own identity instead of collapsing to unknown (mapping them to unknown discards
// information the family can represent). Only graphic and details have no family equivalent.
const DOM_COMPONENT_MAP = {
  heading: 'heading',
  paragraph: 'paragraph',
  list: 'list',
  table: 'table',
  code: 'code',
  quote: 'quote',
  image: 'image',
  media: 'image',
  figure: 'image',
  graphic: 'unknown',
  details: 'unknown',
  rule: 'rule',
  equation: 'equation',
  file: 'file',
};

const CLAUDE_TYPED_EVENTS = {
  schema: STREAM_MAP_SCHEMA,
  id: 'claude-typed-events',
  site: 'generic',
  family: 'ai-chat',
  version: 1,
  dialect: 'typed-events',
  stream: {
    messageIdPath: 'message.id',
    blockIndexPath: 'index',
    ops: [
      { when: { type: 'message_start' }, op: 'open', component: 'message' },
      { when: { type: 'content_block_start', 'block.type': 'text' }, op: 'open', component: 'paragraph' },
      { when: { type: 'content_block_delta', 'delta.type': 'text_delta' }, op: 'append', component: 'paragraph', textPath: 'delta.text' },
      { when: { type: 'content_block_stop' }, op: 'close' },
      { when: { type: 'message_delta' }, op: 'ignore' },
      { when: { type: 'ping' }, op: 'ignore' },
      { when: { type: 'message_stop' }, op: 'finalize' },
    ],
  },
  dom: { componentMap: DOM_COMPONENT_MAP },
};

const CHATGPT_PATH_OPS = {
  schema: STREAM_MAP_SCHEMA,
  id: 'chatgpt-path-ops',
  site: 'generic',
  family: 'ai-chat',
  version: 1,
  dialect: 'path-ops',
  stream: {
    messageIdPath: 'message.id',
    blockIndexPath: 'p',
    blockIndexPattern: '/content/parts/(\\d+)$',
    ops: [
      { when: { hasKey: 'message', type: null }, op: 'open', component: 'message' },
      { when: { path: '/message/content/parts/*', o: 'append' }, op: 'append', component: 'paragraph', textPath: 'v' },
      { when: { path: '/message/status' }, op: 'ignore' },
      { when: { terminal: true, data: '[DONE]' }, op: 'finalize' },
      // ---- Rules below come from a read-only survey of 28 saved ChatGPT sessions. Labels are
      // "type=<json.type> event=<SSE event>". They are appended AFTER the four rules above, so
      // first-match-wins guarantees that no event the rules above already matched changes.
      // Tags: "survey-observed" = the label was counted in the survey; "semantics inferred" = the
      // meaning is read from the name, not confirmed against the site.
      // survey-observed, semantics inferred: the name says the stream ended. Seen once per
      // conversation stream (42 sessions). Finalize closes every open component.
      { when: { event: 'message', type: 'message_stream_complete' }, op: 'finalize' },
      // survey-observed, semantics inferred: non-content protocol events, no reply text.
      { when: { event: 'message', type: 'message_marker' }, op: 'ignore' },
      { when: { event: 'message', type: 'title_generation' }, op: 'ignore' },
      // survey-observed. It echoes the USER prompt, not the assistant reply, so it must never
      // build a component of the reply. Ignored on purpose.
      { when: { event: 'message', type: 'input_message' }, op: 'ignore' },
      // survey-observed, semantics inferred: session/telemetry bookkeeping, no reply text.
      { when: { event: 'message', type: 'resume_conversation_token' }, op: 'ignore' },
      { when: { event: 'message', type: 'server_ste_metadata' }, op: 'ignore' },
      { when: { event: 'message', type: 'conversation_detail_metadata' }, op: 'ignore' },
      { when: { event: 'message', type: 'user_signal_metadata' }, op: 'ignore' },
      // survey-observed, semantics inferred: version negotiation frame (no json.type). The engine
      // checks for a path-op shape (p/o/v) before rules run, so this rule only applies to frames
      // without those keys.
      { when: { event: 'delta_encoding' }, op: 'ignore' },
      // survey-observed, semantics inferred: delta frames that describe the message rather than
      // carry its text. "*" is a prefix match, so this covers every /message/metadata/... pointer
      // (any op). Known limit: a bare { v } continues the last pointer, so a bare continuation
      // right after one of these frames is ignored instead of appended. Not seen in the survey.
      { when: { path: '/message/metadata*' }, op: 'ignore' },
      // survey-observed, semantics inferred: timestamp and end-of-turn flags.
      { when: { path: '/message/update_time' }, op: 'ignore' },
      { when: { path: '/message/end_turn' }, op: 'ignore' },
      // ---- Error signals. These fire only on a REAL error: a non-null error_code or a non-null error.
      // Presence of the keys is NOT an error (the real message-open frames carry both as null), so a
      // healthy frame can never match these rules. They sit BEFORE the message-open rules on purpose:
      // a frame that carries a real error AND a message object must report the error, not just open.
      // Known limit: a bare envelope that continues an ignore pointer (/message/status,
      // /message/metadata*, update_time, end_turn) is ignored by that earlier rule, not reported.
      // Shape A: bare { v } with no p/o.
      { when: { nonNull: ['v.error_code', 'v.error'], o: 'append' }, op: 'signal', kind: 'error', codePath: 'v.error_code', textPath: 'v.message' },
      // Shape B: path-op "add" with an empty path.
      { when: { nonNull: ['v.error_code', 'v.error'], o: 'add', path: '' }, op: 'signal', kind: 'error', codePath: 'v.error_code', textPath: 'v.message' },
      // ---- Message-open frames (value-type check of 27 saved sessions: types only, no values).
      // The real frames carry the message object nested in v.message, with v.error and v.error_code
      // both null. Shape A is a bare { v } (no p/o; o defaults to "append"). Shape B is an "add" at
      // an empty path. A user-authored frame is ignored, so it never builds an assistant component.
      // Its role is compared case-insensitively. Frames with any other role, or no role, open "message".
      // The message container is keyed by v.message.id (keyPath); it has no block index.
      { when: { isObject: 'v.message', o: 'append', equals: { 'v.message.author.role': 'user' } }, op: 'ignore' },
      { when: { isObject: 'v.message', o: 'add', path: '', equals: { 'v.message.author.role': 'user' } }, op: 'ignore' },
      { when: { isObject: 'v.message', o: 'append' }, op: 'open', component: 'message', keyPath: 'v.message.id' },
      { when: { isObject: 'v.message', o: 'add', path: '' }, op: 'open', component: 'message', keyPath: 'v.message.id' },
    ],
  },
  dom: { componentMap: DOM_COMPONENT_MAP },
};

const OPENAI_RESPONSES = {
  schema: STREAM_MAP_SCHEMA,
  id: 'openai-responses',
  site: 'generic',
  family: 'ai-chat',
  version: 1,
  dialect: 'typed-events',
  stream: {
    messageIdPath: 'response.id',
    blockIndexPath: 'output_index',
    ops: [
      { when: { type: 'response.created' }, op: 'open', component: 'message' },
      { when: { type: 'response.output_item.added' }, op: 'ignore' },
      { when: { type: 'response.output_text.delta' }, op: 'append', component: 'paragraph', textPath: 'delta' },
      { when: { type: 'response.output_text.done' }, op: 'close' },
      { when: { type: 'response.completed' }, op: 'finalize' },
    ],
  },
  dom: { componentMap: DOM_COMPONENT_MAP },
};

function deepFreeze(o) {
  if (o && typeof o === 'object') {
    for (const v of Object.values(o)) deepFreeze(v);
    Object.freeze(o);
  }
  return o;
}

export const DEFAULT_STREAM_MAPS = deepFreeze([CLAUDE_TYPED_EVENTS, CHATGPT_PATH_OPS, OPENAI_RESPONSES]);

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const usableId = (v) => (typeof v === 'string' && v.length > 0) || Number.isFinite(v);

function getPath(obj, dotted) {
  let node = obj;
  for (const k of String(dotted).split('.')) {
    if (!isObj(node)) return undefined;
    node = node[k];
    if (node === undefined) return undefined;
  }
  return node;
}

function canonicalWhen(when) {
  return JSON.stringify(Object.keys(when).sort().map((k) => [k, when[k]]));
}

export function validateStreamMap(map) {
  const errors = [];
  if (!isObj(map)) return { ok: false, errors: ['map must be an object'] };
  if (map.schema !== STREAM_MAP_SCHEMA) errors.push(`schema must be ${STREAM_MAP_SCHEMA}`);
  if (typeof map.id !== 'string' || !map.id) errors.push('id must be a non-empty string');
  if (typeof map.site !== 'string' || !map.site) errors.push('site must be a non-empty string');
  if (map.family !== 'ai-chat') errors.push('family must be ai-chat');
  if (!Number.isInteger(map.version) || map.version < 1) errors.push('version must be a positive integer');
  if (!DIALECTS.includes(map.dialect)) errors.push(`unknown dialect ${JSON.stringify(map.dialect)}`);

  const s = map.stream;
  if (!isObj(s) || !Array.isArray(s.ops)) {
    errors.push('stream.ops must be an array');
  } else {
    for (const k of ['messageIdPath', 'blockIndexPath']) {
      if (s[k] !== undefined && (typeof s[k] !== 'string' || !s[k])) errors.push(`stream.${k} must be a non-empty string when present`);
    }
    if (s.blockIndexPattern !== undefined) {
      try { new RegExp(s.blockIndexPattern); } catch { errors.push('stream.blockIndexPattern is not a valid regex'); }
    }
    const seen = new Set();
    s.ops.forEach((r, i) => {
      const at = `stream.ops[${i}]`;
      if (!isObj(r)) { errors.push(`${at} must be an object`); return; }
      if (!OPS.includes(r.op)) errors.push(`${at}: unknown op ${JSON.stringify(r.op)}`);
      if (!isObj(r.when) || Object.keys(r.when).length === 0) {
        errors.push(`${at}: when must be a non-empty object`);
      } else {
        for (const [k, v] of Object.entries(r.when)) {
          if (!WHEN_KEYS.includes(k)) { errors.push(`${at}: unknown when key ${JSON.stringify(k)}`); continue; }
          let okType;
          if (NULLABLE_WHEN.includes(k)) okType = typeof v === 'string' || v === null;
          else if (k === 'terminal') okType = typeof v === 'boolean';
          else if (k === 'hasKey') okType = typeof v === 'string' && v.length > 0 && (!v.includes('.') || DOTTED_PATH.test(v));
          else if (k === 'path') okType = typeof v === 'string'; // "" is the empty pointer of a path-op add
          else if (k === 'nonNull') okType = isDottedPath(v) || (Array.isArray(v) && v.length > 0 && v.every(isDottedPath));
          else if (k === 'isObject') okType = isDottedPath(v);
          else if (k === 'equals') okType = isObj(v) && Object.keys(v).length > 0 && Object.entries(v).every(([p, s]) => isDottedPath(p) && typeof s === 'string');
          else okType = typeof v === 'string'; // o, data
          if (!okType) errors.push(`${at}: when.${k} has an unsupported value`);
        }
        const sig = canonicalWhen(r.when);
        if (seen.has(sig)) errors.push(`${at}: duplicate when`);
        seen.add(sig);
      }
      if (r.op === 'open' && !r.component) errors.push(`${at}: open needs a component`);
      if (r.component !== undefined && !OP_COMPONENTS.includes(r.component)) errors.push(`${at}: component ${JSON.stringify(r.component)} is outside the ai-chat enum`);
      if (r.textPath !== undefined && r.op !== 'append' && r.op !== 'signal') errors.push(`${at}: textPath is only allowed on append and signal`);
      if (r.op === 'signal') {
        if (r.component !== undefined) errors.push(`${at}: signal rule must not set component`);
        if (r.kind !== undefined && !SIGNAL_KINDS.includes(r.kind)) errors.push(`${at}: signal kind must be error or status`);
        if (r.codePath !== undefined && !isDottedPath(r.codePath)) errors.push(`${at}: codePath must be a dotted identifier path`);
        if (r.textPath !== undefined && !isDottedPath(r.textPath)) errors.push(`${at}: textPath must be a dotted identifier path`);
      } else {
        if (r.kind !== undefined) errors.push(`${at}: kind is only allowed on signal`);
        if (r.codePath !== undefined) errors.push(`${at}: codePath is only allowed on signal`);
      }
      if (r.keyPath !== undefined && (r.op !== 'open' || !isDottedPath(r.keyPath))) {
        errors.push(`${at}: keyPath is only allowed on open and must be a dotted identifier path`);
      }
      if (r.op === 'append' && (typeof r.textPath !== 'string' || !r.textPath)) errors.push(`${at}: append needs a textPath`);
    });
  }

  if (!isObj(map.dom) || !isObj(map.dom.componentMap)) {
    errors.push('dom.componentMap must be an object');
  } else {
    for (const [t, c] of Object.entries(map.dom.componentMap)) {
      if (!FAMILY_COMPONENTS.includes(c)) errors.push(`dom.componentMap.${t} targets ${JSON.stringify(c)}, outside the ai-chat enum`);
    }
  }
  return { ok: errors.length === 0, errors };
}

// A payload that is a path-op: explicit p/o, or a bare v with no type (continues the last pointer).
const isPathLike = (u) => isObj(u) && ('p' in u || 'o' in u || ('v' in u && !('type' in u)));

// Expand an { o: "patch", v: [...] } envelope into its sub-operations.
function unitsOf(json) {
  if (json === undefined) return [{ unit: undefined }];
  if (isObj(json) && json.o === 'patch' && Array.isArray(json.v)) {
    if (json.v.length === 0) return [{ error: 'empty_patch' }];
    return json.v.map((unit, sub) => ({ unit, sub }));
  }
  return [{ unit: json }];
}

function ruleMatches(when, view, unit) {
  for (const [k, want] of Object.entries(when)) {
    if (k === 'hasKey') {
      if (!isObj(unit)) return false;
      if (want.includes('.')) {
        if (getPath(unit, want) === undefined) return false;
      } else if (!Object.prototype.hasOwnProperty.call(unit, want)) {
        return false;
      }
      continue;
    }
    if (k === 'path') {
      if (typeof view.path !== 'string') return false;
      const hit = want.endsWith('*') ? view.path.startsWith(want.slice(0, -1)) : view.path === want;
      if (!hit) return false;
      continue;
    }
    if (k === 'nonNull') {
      const paths = Array.isArray(want) ? want : [want];
      const any = paths.some((p) => { const x = getPath(unit, p); return x !== undefined && x !== null && x !== ''; });
      if (!any) return false;
      continue;
    }
    if (k === 'isObject') {
      if (!isObj(getPath(unit, want))) return false;
      continue;
    }
    if (k === 'equals') {
      for (const [p, s] of Object.entries(want)) {
        const x = getPath(unit, p);
        if (typeof x !== 'string' || x.toLowerCase() !== s.toLowerCase()) return false;
      }
      continue;
    }
    const got = view[k];
    if (want === null ? got !== undefined : got !== want) return false;
  }
  return true;
}

function blockIndexOf(scope, stream) {
  if (typeof stream.blockIndexPath !== 'string') return null;
  const raw = getPath(scope, stream.blockIndexPath);
  const present = (typeof raw === 'string' && raw !== '') || Number.isFinite(raw);
  if (!present) return null;
  let s = String(raw);
  if (stream.blockIndexPattern) {
    const m = new RegExp(stream.blockIndexPattern).exec(s);
    if (!m || m[1] === undefined) return null;
    s = m[1];
  }
  return s;
}

function messageIdOf(scope, stream) {
  if (typeof stream.messageIdPath !== 'string') return undefined;
  const raw = getPath(scope, stream.messageIdPath);
  return usableId(raw) ? String(raw) : undefined;
}

const describeView = (v) => [
  `type=${v.type ?? '-'}`,
  `event=${v.event ?? '-'}`,
  v.path !== undefined ? `path=${v.path}` : null,
  v.o !== undefined ? `o=${v.o}` : null,
].filter(Boolean).join(' ');

// Shared engine for applyStreamMap and detectStreamMap. Assumes the map is valid.
function runMap(map, events) {
  const stream = map.stream;
  const rules = stream.ops;
  const timeline = [];
  const unmapped = [];
  const components = [];
  const signals = [];
  const st = { lastPath: null, messageId: null, finalized: false };
  const list = Array.isArray(events) ? events : [];
  let units = 0;
  let matched = 0;

  const newComponent = (key, component, e) => ({
    componentKey: key, component, text: '', opened: { seq: e.seq, n: e.n }, closed: null,
  });
  const findOpen = (key, component) => {
    for (let i = components.length - 1; i >= 0; i--) {
      const c = components[i];
      if (c.closed !== null || c.componentKey !== key) continue;
      if (component === undefined ? c.component !== 'message' : c.component === component) return c;
    }
    return null;
  };

  // Privacy: the code is kept only as a token; the text is measured, never copied.
  const emitSignal = (idx, u, ref) => {
    const r = rules[idx];
    const code = r.codePath === undefined ? null : codeToken(getPath(u, r.codePath));
    const text = r.textPath === undefined ? undefined : getPath(u, r.textPath);
    signals.push({
      ...ref,
      kind: r.kind ?? 'error',
      code,
      messageChars: typeof text === 'string' ? text.length : null,
      rule: idx,
    });
  };

  for (const ev of list) {
    const e = isObj(ev) ? ev : {};
    const base = { sid: e.sid, seq: e.seq, n: e.n };
    for (const { unit, sub, error } of unitsOf(e.json)) {
      units++;
      const ref = sub === undefined ? base : { ...base, sub };
      if (error) { unmapped.push({ ...ref, reason: error }); continue; }
      const u = unit;
      const pathLike = isPathLike(u);
      let p;
      let o;
      if (pathLike) {
        p = u.p !== undefined ? u.p : st.lastPath;
        o = u.o === undefined ? 'append' : u.o;
      }
      const view = {
        event: e.event,
        type: isObj(u) ? u.type : undefined,
        'block.type': isObj(u) && isObj(u.content_block) ? u.content_block.type : undefined,
        'delta.type': isObj(u) && isObj(u.delta) ? u.delta.type : undefined,
        path: p,
        o,
        terminal: e.terminal === true,
        data: e.data,
      };
      if (pathLike && typeof p === 'string') st.lastPath = p;
      // First rule (list order) whose `when` matches. An append whose textPath is not a string does
      // not claim the event, so the search continues after it (see header).
      const resolve = () => {
        for (let i = 0; i < rules.length; i++) {
          const r = rules[i];
          if (!ruleMatches(r.when, view, u)) continue;
          if (r.op === 'append' && typeof getPath(u, r.textPath) !== 'string') continue;
          return i;
        }
        return -1;
      };
      const idx = resolve();
      if (idx < 0) {
        const app = rules.findIndex((r) => r.op === 'append' && ruleMatches(r.when, view, u));
        if (app >= 0) { matched++; unmapped.push({ ...ref, reason: 'textPath_not_string', rule: app }); }
        else if (pathLike && typeof p !== 'string') unmapped.push({ ...ref, reason: 'path_op_without_path' });
        else unmapped.push({ ...ref, reason: `no_rule_matched: ${describeView(view)}` });
        continue;
      }
      const rule = rules[idx];
      matched++;
      const scope = pathLike ? { ...u, p } : (isObj(u) ? u : {});
      if (rule.op === 'signal') { emitSignal(idx, u, ref); continue; }

      // A keyed open takes its key from the event (v.message.id); other ops use the stream id path.
      const keyed = rule.keyPath !== undefined;
      const keyedId = keyed ? getPath(u, rule.keyPath) : undefined;
      const mid = keyed ? (usableId(keyedId) ? String(keyedId) : undefined) : messageIdOf(scope, stream);
      if (mid !== undefined) st.messageId = mid;
      const bi = blockIndexOf(scope, stream);
      const key = keyed ? (mid ?? null) : (st.messageId != null && bi != null ? `${st.messageId}:${bi}` : null);

      switch (rule.op) {
        case 'ignore':
          timeline.push({ ...ref, op: 'ignore', component: null, componentKey: key, rule: idx });
          break;
        case 'open': {
          components.push(newComponent(key, rule.component, e));
          timeline.push({ ...ref, op: 'open', component: rule.component, componentKey: key, rule: idx });
          break;
        }
        case 'append': {
          const text = getPath(u, rule.textPath);
          if (typeof text !== 'string') { unmapped.push({ ...ref, reason: 'textPath_not_string', rule: idx }); break; }
          let c = findOpen(key, rule.component);
          if (!c) {
            if (!rule.component) { unmapped.push({ ...ref, reason: 'append_without_open_or_component', rule: idx }); break; }
            c = newComponent(key, rule.component, e);
            components.push(c);
          }
          c.text += text;
          timeline.push({ ...ref, op: 'append', component: c.component, componentKey: c.componentKey, text, rule: idx });
          break;
        }
        case 'close': {
          const c = findOpen(key, rule.component);
          if (!c) { unmapped.push({ ...ref, reason: 'close_without_open', rule: idx }); break; }
          c.closed = { seq: e.seq, n: e.n };
          timeline.push({ ...ref, op: 'close', component: c.component, componentKey: c.componentKey, rule: idx });
          break;
        }
        case 'finalize': {
          st.finalized = true;
          for (const c of components) if (c.closed === null) c.closed = { seq: e.seq, n: e.n };
          timeline.push({ ...ref, op: 'finalize', component: null, componentKey: key, rule: idx });
          break;
        }
        default:
          unmapped.push({ ...ref, reason: `unknown_op ${rule.op}`, rule: idx });
      }
    }
  }

  const stats = {
    events: list.length,
    units,
    matched,
    timeline: timeline.length,
    mapped: timeline.filter((t) => t.op !== 'ignore').length,
    ignored: timeline.filter((t) => t.op === 'ignore').length,
    unmapped: unmapped.length,
    components: components.length,
    openComponents: components.filter((c) => c.closed === null).length,
    finalized: st.finalized,
    signals: signals.length,
    errorSignals: signals.filter((s) => s.kind === 'error').length,
    hadError: signals.some((s) => s.kind === 'error'),
  };
  return { timeline, components, unmapped, stats, matched, signals };
}

export function applyStreamMap(map, events) {
  const v = validateStreamMap(map);
  if (!v.ok) throw new Error(`invalid stream map: ${v.errors.join('; ')}`);
  const { timeline, components, unmapped, stats, signals } = runMap(map, events);
  return { timeline, components, unmapped, stats, signals };
}

// Pick the built-in map whose rules match the most events. Ties, or no matches at all, give null.
export function detectStreamMap(events) {
  const candidates = DEFAULT_STREAM_MAPS.map((m) => ({ id: m.id, matched: runMap(m, events).matched }));
  const best = Math.max(...candidates.map((c) => c.matched));
  const top = candidates.filter((c) => c.matched === best);
  if (best === 0 || top.length !== 1) return { map: null, candidates };
  return { map: DEFAULT_STREAM_MAPS.find((m) => m.id === top[0].id), candidates };
}
