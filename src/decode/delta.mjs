// Generic delta/patch assembler. Many streaming UIs send a document once and then patches.
// The dialects below are recognised automatically from operation shape, never from a provider
// name, so a new site that uses a known encoding is reconstructed without any configuration:
//
//   json-patch        RFC 6902 operations { op, path, value } (add/remove/replace/move/copy/test)
//   json-merge-patch  RFC 7386 recursive merge where null deletes a key
//   path-ops          compact ops { p: "/a/b", o: "append|replace|add|remove|patch", v }
//                     where a bare { v: "..." } continues appending to the previous path
//   dotted-set        { path: "a.b.c", value } / { key, value } with dot-separated paths
//   array-splice      { path, splice: [start, deleteCount, ...items] }
//   put-merge         { put: { path, data } } / { merge: { path, data } } tree writes
//   ot-ops            { ops: [{ insert }, { retain }, { delete }] } text operational transforms
//   typed-events      { type: "x_start" | "x_delta" | "x_stop" | "a.b.delta", index?, delta? }
//                     start events carry objects, delta events append strings to the indexed
//                     block, stop/done events finalise
//
// Anything else is treated as a full document replacement when it is a plain object.
// Every applied operation counts as a revision, so intermediate states can be replayed.

const PATH_OPS = new Set(['append', 'replace', 'add', 'remove', 'patch', 'set', 'truncate', 'insert', 'delete', 'merge', 'splice', 'increment']);
const TYPED = /(^|[._])(start|stop|delta|done|created|completed|added|in_progress|chunk|partial|update|updated)$/;
const TYPED_START = /(^|[._])(start|created|added|in_progress)$/;
const TYPED_STOP = /(^|[._])(stop|done|completed)$/;
const TYPED_DELTA = /(delta|chunk|partial)/;
const INDEX_KEYS = ['index', 'output_index', 'content_index', 'block_index', 'candidate_index', 'choice_index'];
const DELTA_KEYS = ['delta', 'text_delta', 'chunk', 'partial', 'diff'];
// Field names whose string values are incremental content rather than a replaced attribute.
const TEXT_DELTA_FIELD = /^(text|content|value|token|tokens|append|partial|chunk|delta|body|output_text|message_text|answer|completion)$/i;
// A provider-supplied id is usable only when it is a non-empty string or a finite number.
const usableId = (v) => (typeof v === 'string' && v.length > 0) || Number.isFinite(v);

// Leaves that describe a message rather than carry its content. Matched on the last path segment;
// everything under /meta/ (the assembler's own bookkeeping) counts too.
const META_LEAF = /^(?:id|type|role|model|status|object|created|created_at|updated_at|stop_reason|stop_sequence|finish_reason|content_type|messageId|_done|_incomplete)$|_id$/i;
// A message's own /metadata/ subtree (for example ChatGPT's model_dil_v2 render code and
// fallbackMarkdown) describes or re-renders the reply; the reply itself is under content/parts.
const META_SUBTREE = /(?:^|\/)metadata\//;
const isMetaTextPath = (p) => (p.startsWith('/meta/') || META_SUBTREE.test(p) || META_LEAF.test(p.slice(p.lastIndexOf('/') + 1))) ? 1 : 0;

export function parsePointer(p) {
  if (p === '' || p === '/' || p === undefined || p === null) return [];
  return String(p).split('/').slice(1).map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
}

export function parseDotted(p) {
  if (p === undefined || p === null || p === '') return [];
  return String(p).split('.').flatMap((seg) => {
    const parts = [];
    const m = /^([^[]*)((\[\d+\])*)$/.exec(seg);
    if (!m) return [seg];
    if (m[1]) parts.push(m[1]);
    for (const idx of (m[2] ?? '').match(/\d+/g) ?? []) parts.push(idx);
    return parts;
  });
}

function getParent(doc, parts, create) {
  let node = doc;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (node[k] === undefined || node[k] === null || typeof node[k] !== 'object') {
      if (!create) return undefined;
      node[k] = /^\d+$/.test(parts[i + 1]) ? [] : {};
    }
    node = node[k];
  }
  return node;
}

export function getPointer(doc, parts) {
  let node = doc;
  for (const k of parts) {
    if (node === undefined || node === null || typeof node !== 'object') return undefined;
    node = node[k];
  }
  return node;
}

// RFC 7386 JSON merge patch (null deletes).
export function applyMergePatch(target, patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return structuredClone(patch);
  const base = (target && typeof target === 'object' && !Array.isArray(target)) ? target : {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete base[k];
    else base[k] = applyMergePatch(base[k], v);
  }
  return base;
}

export function detectDialect(json) {
  const arr = Array.isArray(json) ? json : [json];
  if (!arr.length || arr.some((x) => !x || typeof x !== 'object')) return null;
  if (arr.every((x) => typeof x.op === 'string' && typeof x.path === 'string')) return 'json-patch';
  if (!Array.isArray(json) && typeof json.type === 'string' && TYPED.test(json.type)) return 'typed-events';
  if (!Array.isArray(json)) {
    const keys = Object.keys(json);
    if (keys.length && keys.every((k) => ['p', 'o', 'v', 'c'].includes(k)) && ('v' in json || 'o' in json)) {
      if (json.o === undefined || PATH_OPS.has(json.o)) return 'path-ops';
    }
    if (Array.isArray(json.ops) && json.ops.length && json.ops.every((o) => o && typeof o === 'object' && ('insert' in o || 'retain' in o || 'delete' in o))) return 'ot-ops';
    if (Array.isArray(json.splice) && json.splice.length >= 2 && typeof json.splice[0] === 'number') return 'array-splice';
    if ((json.put && typeof json.put === 'object' && 'path' in json.put) || (json.merge && typeof json.merge === 'object' && 'path' in json.merge)) return 'put-merge';
    if (keys.length <= 3 && typeof json.path === 'string' && !json.path.startsWith('/') && json.path.includes('.') && ('value' in json || 'v' in json)) return 'dotted-set';
    if (keys.length === 2 && typeof json.key === 'string' && 'value' in json && json.key.includes('.')) return 'dotted-set';
  }
  return null;
}

export class DeltaAssembler {
  // new DeltaAssembler('auto') (legacy) or new DeltaAssembler({ dialect, opsLog, snapshotEvery })
  constructor(arg = 'auto') {
    const opts = typeof arg === 'string' ? { dialect: arg } : (arg ?? {});
    this.dialect = opts.dialect ?? 'auto';
    this.doc = undefined;
    this.lastPath = null;
    this.revisions = 0;
    this.detected = new Set();
    this.unapplied = 0;
    this.ops = {};                                   // op name -> count
    this.errors = [];                                // bounded list of refused operations
    this.maxErrors = opts.maxErrors ?? 20;
    this.opsLogLimit = opts.opsLog ?? 200;            // bounded op trail (no payloads)
    this.opsLog = [];
    this.snapshotEvery = opts.snapshotEvery ?? 0;     // 0 = no intermediate snapshots
    this.maxSnapshots = opts.maxSnapshots ?? 20;
    this.snapshots = [];
    this.pathRevisions = new Map();                   // pointer -> times written
    this.replacements = 0;
    this.lastAppliedAt = null;
    this.messageId = null;                            // from a message_start-style event, never invented
    this.messageIdSource = null;                      // 'message' | 'response' | 'item' | null (what set messageId)
    this._meta = null;                                // doc.meta object we created (not a content root)
  }

  _note(op, path) {
    this.ops[op] = (this.ops[op] ?? 0) + 1;
    if (path !== undefined && path !== null) this.pathRevisions.set(String(path), (this.pathRevisions.get(String(path)) ?? 0) + 1);
    if (this.opsLogLimit > 0) {
      this.opsLog.push({ r: this.revisions + 1, op, path: path === undefined ? undefined : String(path) });
      if (this.opsLog.length > this.opsLogLimit) this.opsLog.shift();
    }
  }

  _fail(reason, detail) {
    this.unapplied++;
    if (this.errors.length < this.maxErrors) this.errors.push({ reason, detail: detail === undefined ? undefined : String(detail).slice(0, 120) });
    return false;
  }

  _commit() {
    this.revisions++;
    this.lastAppliedAt = Date.now();
    if (this.snapshotEvery && this.revisions % this.snapshotEvery === 0) {
      this.snapshots.push({ revision: this.revisions, doc: structuredClone(this.doc) });
      if (this.snapshots.length > this.maxSnapshots) this.snapshots.shift();
    }
    return true;
  }

  apply(json) {
    if (json === undefined || this.dialect === 'none') return false;
    const d = this.dialect === 'auto' ? detectDialect(json) : this.dialect;
    if (d === 'json-patch') {
      this.detected.add(d);
      for (const op of [].concat(json)) this._jsonPatch(op);
      return this._commit();
    }
    if (d === 'json-merge-patch') { this.detected.add(d); this.doc = applyMergePatch(this.doc, json); this._note('merge-patch', ''); return this._commit(); }
    if (d === 'typed-events') { this.detected.add(d); if (this._typed(json)) return this._commit(); return this._fail('typed_event_not_applicable', json.type); }
    if (d === 'ot-ops') { this.detected.add(d); if (this._otOps(json)) return this._commit(); return this._fail('ot_ops_empty'); }
    if (d === 'array-splice') { this.detected.add(d); if (this._splice(json)) return this._commit(); return this._fail('splice_target_missing', json.path); }
    if (d === 'put-merge') { this.detected.add(d); if (this._putMerge(json)) return this._commit(); return this._fail('put_merge_invalid'); }
    if (d === 'dotted-set') {
      this.detected.add(d);
      const parts = parseDotted(json.path ?? json.key);
      this._ensureDoc();
      this._set(parts, structuredClone('value' in json ? json.value : json.v), 'replace');
      this._note('dotted-set', (json.path ?? json.key));
      return this._commit();
    }
    if (d === 'path-ops') {
      this.detected.add(d);
      // A path-op with an object value at the root and no op is a full document.
      if ((json.p === undefined || json.p === '') && json.o === undefined && json.v && typeof json.v === 'object' && !Array.isArray(json.v)) {
        this.doc = structuredClone(json.v); this.lastPath = null; this._note('document', ''); this.replacements++; this._idFromSnapshot(); return this._commit();
      }
      this._pathOp(json); return this._commit();
    }
    if (json && typeof json === 'object' && !Array.isArray(json) && this.dialect === 'auto') {
      // Plain object: keep as the latest full snapshot only if nothing patch-like has been seen
      // or it clearly carries a document (heuristic: many keys).
      // Once a patch dialect has built the document, a typed side-channel event (for example
      // ChatGPT's trailing conversation_detail_metadata / title_generation / message_marker) is
      // protocol chatter, not a replacement document: it must never overwrite the reply.
      if (this.detected.has('path-ops') && typeof json.type === 'string') return this._fail('side_channel_event_ignored', json.type);
      if (!this.detected.size || Object.keys(json).length >= 3) {
        this.doc = structuredClone(json); this._note('document', ''); this.replacements++; this._idFromSnapshot(); return this._commit();
      }
    }
    return this._fail('no_dialect_match');
  }

  _ensureDoc() { if (this.doc === undefined || this.doc === null || typeof this.doc !== 'object') this.doc = {}; }

  _set(parts, value, mode) {
    this._ensureDoc();
    if (!parts.length) { if (mode === 'append' && typeof this.doc === 'string') this.doc += value; else this.doc = value; return; }
    const parent = getParent(this.doc, parts, true);
    const key = parts[parts.length - 1];
    if (mode === 'append') {
      const cur = parent[key];
      if (typeof cur === 'string' && typeof value === 'string') parent[key] = cur + value;
      else if (Array.isArray(cur)) cur.push(...[].concat(value));
      else if (cur === undefined) parent[key] = value;
      else parent[key] = value;
    } else if ((mode === 'add' || mode === 'insert') && Array.isArray(parent) && (key === '-' || /^\d+$/.test(key))) {
      if (key === '-') parent.push(value); else parent.splice(Number(key), 0, value);
    } else if (mode === 'remove' || mode === 'delete') {
      if (Array.isArray(parent)) parent.splice(Number(key), 1); else delete parent[key];
    } else if (mode === 'truncate') {
      const cur = parent[key];
      if (typeof cur === 'string' || Array.isArray(cur)) parent[key] = cur.slice(0, Number(value));
    } else if (mode === 'merge') {
      parent[key] = applyMergePatch(parent[key], value);
    } else if (mode === 'increment') {
      parent[key] = (typeof parent[key] === 'number' ? parent[key] : 0) + (typeof value === 'number' ? value : 1);
    } else parent[key] = value;
  }

  _jsonPatch(op) {
    const parts = parsePointer(op.path);
    switch (op.op) {
      case 'add': this._set(parts, structuredClone(op.value), 'add'); this._note('add', op.path); return true;
      case 'replace': this._set(parts, structuredClone(op.value), 'replace'); this._note('replace', op.path); return true;
      case 'remove': this._set(parts, undefined, 'remove'); this._note('remove', op.path); return true;
      case 'move': {
        const from = parsePointer(op.from);
        const v = getPointer(this.doc, from);
        if (v === undefined) return this._fail('move_source_missing', op.from);
        this._set(from, undefined, 'remove');
        this._set(parts, structuredClone(v), 'add');
        this._note('move', op.path);
        return true;
      }
      case 'copy': {
        const v = getPointer(this.doc, parsePointer(op.from));
        if (v === undefined) return this._fail('copy_source_missing', op.from);
        this._set(parts, structuredClone(v), 'add');
        this._note('copy', op.path);
        return true;
      }
      case 'test': {
        const v = getPointer(this.doc, parts);
        const ok = JSON.stringify(v) === JSON.stringify(op.value);
        this._note('test', op.path);
        if (!ok) this._fail('test_failed', op.path);
        return ok;
      }
      default: return this._fail('unknown_json_patch_op', op.op);
    }
  }

  _pathOp(op) {
    if (op.o === 'patch' && Array.isArray(op.v)) { for (const sub of op.v) this._pathOp(sub); return; }
    // ChatGPT delta encoding v1 continues a patch batch as a bare { v: [ {p,o,v}, ... ] }: an
    // array of operation objects with neither a path nor an op is a batch, not a value to append.
    if (op.o === undefined && op.p === undefined && Array.isArray(op.v) && op.v.length
      && op.v.every((x) => x && typeof x === 'object' && !Array.isArray(x) && typeof x.p === 'string' && typeof x.o === 'string' && PATH_OPS.has(x.o))) {
      for (const sub of op.v) this._pathOp(sub); return;
    }
    const path = op.p !== undefined ? op.p : this.lastPath;
    if (path === null || path === undefined) { this._fail('path_op_without_path'); return; }
    this.lastPath = path;
    const mode = op.o ?? 'append';
    this._note(mode, path);
    this._set(parsePointer(path), op.v === undefined ? undefined : structuredClone(op.v), mode === 'set' ? 'replace' : mode);
  }

  _splice(op) {
    this._ensureDoc();
    const parts = op.path ? (String(op.path).startsWith('/') ? parsePointer(op.path) : parseDotted(op.path)) : [];
    const [start, del, ...items] = op.splice;
    if (!parts.length) {
      if (!Array.isArray(this.doc)) this.doc = Array.isArray(this.doc) ? this.doc : [];
      this.doc.splice(start, del ?? 0, ...structuredClone(items));
      this._note('splice', op.path ?? '');
      return true;
    }
    const parent = getParent(this.doc, parts, true);
    const key = parts[parts.length - 1];
    if (!Array.isArray(parent[key])) parent[key] = [];
    parent[key].splice(start, del ?? 0, ...structuredClone(items));
    this._note('splice', op.path);
    return true;
  }

  _putMerge(op) {
    const spec = op.put ?? op.merge;
    if (!spec || typeof spec !== 'object') return false;
    const raw = spec.path ?? '';
    const parts = String(raw).startsWith('/') ? parsePointer(raw) : parseDotted(String(raw).replace(/^\/+|\/+$/g, '').replace(/\//g, '.'));
    const data = 'data' in spec ? spec.data : spec.value;
    if (op.put) {
      if (!parts.length) { this.doc = structuredClone(data); this.replacements++; }
      else this._set(parts, structuredClone(data), 'replace');
      this._note('put', raw);
    } else {
      if (!parts.length) this.doc = applyMergePatch(this.doc, data);
      else this._set(parts, structuredClone(data), 'merge');
      this._note('merge', raw);
    }
    return true;
  }

  // Operational-transform text ops (Quill/Delta style): insert/retain/delete over a text doc.
  _otOps(json) {
    const path = typeof json.path === 'string' ? json.path : null;
    const parts = path ? (path.startsWith('/') ? parsePointer(path) : parseDotted(path)) : ['text'];
    this._ensureDoc();
    const parent = getParent(this.doc, parts, true);
    const key = parts[parts.length - 1];
    let text = typeof parent[key] === 'string' ? parent[key] : '';
    let cursor = 0;
    let applied = false;
    for (const op of json.ops) {
      if (typeof op.retain === 'number') { cursor = Math.min(text.length, cursor + op.retain); applied = true; }
      else if (typeof op.delete === 'number') { text = text.slice(0, cursor) + text.slice(cursor + op.delete); applied = true; }
      else if (typeof op.insert === 'string') { text = text.slice(0, cursor) + op.insert + text.slice(cursor); cursor += op.insert.length; applied = true; }
      else if (op.insert !== undefined) { (this.doc.embeds ??= []).push(structuredClone(op.insert)); applied = true; }
    }
    parent[key] = text;
    this._note('ot-ops', path ?? 'text');
    return applied;
  }

  _setMessageId(id, source) {
    this.messageId = id;
    this.messageIdSource = source;
    this._meta = { ...(this._meta ?? {}), messageId: id };
    this.doc.meta = this._meta;
  }

  // ChatGPT-style streams carry the message id inside the first full-document frame
  // (`{ message: { id, ... } }`) rather than in a message_start event. Take it from there only when
  // nothing else has supplied an id, and do NOT write it into doc.meta: the snapshot is the site's
  // own document and a top-level `meta` key there could be real content.
  _idFromSnapshot() {
    if (this.messageIdSource != null) return;
    const id = this.doc?.message?.id;
    if (usableId(id)) { this.messageId = String(id); this.messageIdSource = 'snapshot'; }
  }

  _typed(ev) {
    const t = ev.type;
    if (this.doc === undefined || typeof this.doc !== 'object' || this.doc === null) this.doc = {};
    // message_start-style event: record the message id only when the event carries one.
    if (TYPED_START.test(t) && /message/.test(t)) {
      const mid = ev.message?.id ?? ev.id;
      if (usableId(mid)) this._setMessageId(String(mid), 'message');
    }
    // Responses-style: response.created / response.in_progress carry the id at response.id.
    // A response id replaces only an item-sourced fallback id, never a message-sourced one.
    if (/^response\.(created|in_progress)$/.test(t)) {
      const rid = ev.response?.id;
      if (usableId(rid) && this.messageIdSource !== 'message' && this.messageIdSource !== 'response') this._setMessageId(String(rid), 'response');
    } else if (/^response\.(output_item|output_text|content_part)/.test(t) && this.messageIdSource == null) {
      // Fallback only when no response id (or message id) was seen: the item id from the event.
      const iid = ev.item_id;
      if (usableId(iid)) this._setMessageId(String(iid), 'item');
    }
    const key = INDEX_KEYS.filter((k) => Number.isInteger(ev[k])).map((k) => ev[k]).join('.');
    const rootObj = () => { for (const [k, v] of Object.entries(this.doc)) if (k !== 'blocks' && v !== this._meta && v && typeof v === 'object' && !Array.isArray(v)) return v; return this.doc; };
    const objectFields = Object.entries(ev).filter(([k, v]) => k !== 'type' && !DELTA_KEYS.includes(k) && !INDEX_KEYS.includes(k) && v && typeof v === 'object' && !Array.isArray(v));
    if (TYPED_START.test(t)) {
      if (!objectFields.length) return false;
      for (const [k, v] of objectFields) {
        if (key) { this.doc.blocks ??= {}; this.doc.blocks[key] = { ...(this.doc.blocks[key] ?? {}), ...structuredClone(v) }; }
        else this.doc[k] = { ...(this.doc[k] ?? {}), ...structuredClone(v) };
      }
      this._note('typed-start', key || '');
      return true;
    }
    if (TYPED_DELTA.test(t)) {
      const target = key ? ((this.doc.blocks ??= {})[key] ??= {}) : rootObj();
      const dk = DELTA_KEYS.find((k) => ev[k] !== undefined);
      const d = dk ? ev[dk] : undefined;
      if (typeof d === 'string') target.text = (target.text ?? '') + d;
      else if (d && typeof d === 'object') {
        for (const [k, v] of Object.entries(d)) {
          if (k === 'type') continue;
          // Block-level string deltas append. At message level, a string under a content-bearing
          // name still appends (an unindexed "delta.text" stream is an append stream); anything
          // else (stop reasons, usage counters) replaces.
          if (typeof v === 'string' && (key || TEXT_DELTA_FIELD.test(k))) target[k] = (typeof target[k] === 'string' ? target[k] : '') + v;
          else target[k] = structuredClone(v);
        }
      } else {
        // Some encodings put the incremental text directly on a sibling field.
        const inline = ['text', 'content', 'value', 'token', 'append'].find((k) => typeof ev[k] === 'string');
        if (inline) target.text = (target.text ?? '') + ev[inline];
        else return false;
      }
      for (const [k, v] of objectFields) rootObj()[k] = structuredClone(v);
      this._note('typed-delta', key || '');
      return true;
    }
    if (TYPED_STOP.test(t)) {
      for (const [k, v] of objectFields) this.doc[k] = { ...(this.doc[k] ?? {}), ...structuredClone(v) };
      if (key && this.doc.blocks?.[key]) this.doc.blocks[key]._done = true; else if (!objectFields.length) this.doc._done = true;
      this._note('typed-stop', key || '');
      return true;
    }
    return false;
  }

  // Longest string leaves are the most likely human-visible text.
  texts(minLength = 1) {
    const out = [];
    // key: RFC 6901 escaped JSON pointer of the part (same value as path for ordinary keys).
    const walk = (node, p, ptr) => {
      if (typeof node === 'string') { if (node.length >= minLength) out.push({ path: p, key: ptr, text: node }); return; }
      if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) walk(v, `${p}/${k}`, `${ptr}/${String(k).replace(/~/g, '~0').replace(/\//g, '~1')}`);
    };
    walk(this.doc, '', '');
    // Content first, then by length. Several consumers take texts()[0] as "the reply", so an
    // identifier or status leaf (a message id, a model name, a role) must never outrank a short
    // reply just because it is longer. Metadata leaves are demoted, never removed.
    return out.sort((a, b) => (isMetaTextPath(a.path) - isMetaTextPath(b.path)) || (b.text.length - a.text.length));
  }

  // Text of a specific pointer or dotted path.
  textOf(path) {
    const parts = String(path ?? '').startsWith('/') ? parsePointer(path) : parseDotted(path);
    const v = getPointer(this.doc, parts);
    return typeof v === 'string' ? v : undefined;
  }

  // Indexed blocks produced by typed-event streams, in index order.
  blocks() {
    const b = this.doc?.blocks;
    if (!b || typeof b !== 'object') return [];
    return Object.entries(b)
      // key = `${messageId}:${index}` once a message id has been observed, otherwise null.
      // parentIndex: the composite index without its last segment ("0.0" -> "0"), null for top-level indexes.
      .map(([k, v]) => ({ index: k, done: !!v?._done, ...v, key: this.messageId == null ? null : `${this.messageId}:${k}`, parentIndex: k.includes('.') ? k.slice(0, k.lastIndexOf('.')) : null }))
      .sort((x, y) => String(x.index).localeCompare(String(y.index), undefined, { numeric: true }));
  }

  // The longest text leaf: what a reader would consider "the content".
  primaryText(minLength = 1) { return this.texts(minLength)[0]?.text; }

  stats() {
    let bytes = 0;
    try { bytes = Buffer.byteLength(JSON.stringify(this.doc ?? null)); } catch { bytes = -1; }
    return {
      revisions: this.revisions, unapplied: this.unapplied, replacements: this.replacements,
      dialects: [...this.detected], ops: { ...this.ops }, paths: this.pathRevisions.size,
      docBytes: bytes, errors: this.errors.slice(0, 5), snapshots: this.snapshots.length,
    };
  }

  // Deterministic end-of-stream marker so consumers can tell "finished" from "cut off".
  finalize({ complete = true } = {}) {
    if (this.doc && typeof this.doc === 'object' && !Array.isArray(this.doc)) {
      if (!complete) this.doc._incomplete = true;
    }
    return this.stats();
  }
}

// Rebuild a document from an ordered list of decoded JSON payloads (or decoded events).
export function reconstruct(items, { dialect = 'auto', opsLog = 0, snapshotEvery = 0 } = {}) {
  const a = new DeltaAssembler({ dialect, opsLog, snapshotEvery });
  let applied = 0;
  for (const it of items ?? []) {
    const json = it && typeof it === 'object' && 'json' in it ? it.json : it;
    if (json === undefined) continue;
    if (a.apply(json)) applied++;
  }
  return { doc: a.doc, applied, assembler: a, ...a.stats() };
}
