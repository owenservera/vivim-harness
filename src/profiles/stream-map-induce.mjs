// Stream-map induction: propose a stream map (the format src/profiles/stream-map.mjs already
// accepts) from the decoded events of one or more streams. Pure and deterministic: no I/O, no
// clock, no randomness, no site names, no vocabulary beyond structural features (key paths and
// value TYPES, never values). Nothing here is wired into the engine; a caller decides whether to
// keep the proposal. The induced object is itself a map: applyStreamMap/validateStreamMap accept
// it unchanged (rule-level `evidence`/`confidence` and the top-level `induction`/`unexplained`
// fields are ignored by the engine), so no inducedMapToProfile converter is needed or provided.
//
// Method (all counts only; every emitted rule carries evidence + confidence):
//   1. Expand each event into the same units the engine sees (an { o:"patch", v:[...] } envelope
//      becomes its sub-operations; a bare { v } inherits the previous pointer, as in delta.mjs).
//   2. Cluster units by structural signature: SSE event name, json.type, block/delta type, the
//      resolved pointer TEMPLATE (numeric / uuid-ish segments become "*") plus op, the terminal
//      flag and the sorted ["path:type"] leaf map. Values never enter the key.
//   3. Per cluster compute counts: occurrences, streams it appears in, whether it starts / ends
//      each stream, and per string leaf the sequence counters used to classify growth:
//      cumulative (every value is a prefix of the next), constant, or fragment deltas.
//   4. Emit rules only on structural evidence:
//        OPEN     starts every stream, small count, carries a nested object (keyPath from a
//                 string `id` inside it; messageIdPath is that dotted path).
//        APPEND   a string leaf with >= minGrowth consecutive non-empty, non-prefix fragments
//                 (concatenated text is therefore non-decreasing); textPath is that leaf.
//        CLOSE    no text, has the block-index leaf, every occurrence after the stream's first
//                 append, and is not the stream's last unit.
//        FINALIZE the terminal flag, or a text-free cluster that is every stream's last unit.
//        IGNORE   every other text-free cluster that has an expressible selector.
//      Clusters with no expressible selector, cumulative snapshots (a "set" op the engine does
//      not have), and clusters whose growth is below threshold are listed under `unexplained`
//      with their count and a reason; nothing is silently dropped.
//   5. Signal rules are NEVER induced. Error-ish key NAMES are irrelevant here: a real-data
//      finding is 326 events carrying error/error_code keys with null values, so any rule keyed
//      on presence would fire a false error. Only value types are observed and `signal` is not
//      in the emitted op set at all.
//
// Honest limits: a cumulative-snapshot stream cannot be mapped by an append-only engine, so it
// stays unexplained; a mid-stream pointer change to an unrelated path inside one signature is
// collided by the "*" template; path selectors are prefix matches when a variable segment is
// not last; close/finalize are distinguished only by position and index presence, not by name.

import { STREAM_MAP_SCHEMA } from './stream-map.mjs';

const MAX_LEAVES = 60;
const MAX_DEPTH = 4;
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const NUMERIC_SEG = /^\d+$/;
const HEXISH_SEG = /^[0-9a-f]{8,}$/i;
const CATEGORIES = ['open', 'append', 'close', 'ignore'];

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const round2 = (x) => Math.round(x * 100) / 100;
const round3 = (x) => Math.round(x * 1000) / 1000;

function getPath(obj, dotted) {
  let node = obj;
  for (const k of String(dotted).split('.')) {
    if (!isObj(node)) return undefined;
    node = node[k];
    if (node === undefined) return undefined;
  }
  return node;
}

// Same unit expansion as the engine (src/profiles/stream-map.mjs unitsOf). Copied because that
// module does not export it; keep in sync.
function unitsOf(json) {
  if (json === undefined) return [{ unit: undefined }];
  if (isObj(json) && json.o === 'patch' && Array.isArray(json.v)) {
    if (json.v.length === 0) return [{ error: 'empty_patch' }];
    return json.v.map((unit) => ({ unit }));
  }
  return [{ unit: json }];
}

// Sorted "path:type" leaf map. Arrays are a leaf of type "array" (their items are not indexed:
// indices are values and would fragment the signature). Keys that cannot be written as a dotted
// path are skipped, because a rule could not address them anyway.
function leavesOf(unit) {
  const types = new Map();
  const walk = (v, p, depth) => {
    if (types.size >= MAX_LEAVES || depth > MAX_DEPTH) return;
    const t = v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
    if (p !== '') types.set(p, t);
    if (Array.isArray(v) || !isObj(v)) return;
    for (const k of Object.keys(v).sort()) {
      if (!IDENT.test(k)) continue;
      walk(v[k], p ? `${p}.${k}` : k, depth + 1);
    }
  };
  walk(unit, '', 0);
  return types;
}

function pathTemplate(p) {
  if (typeof p !== 'string') return undefined;
  return p.split('/').map((s) => (NUMERIC_SEG.test(s) || HEXISH_SEG.test(s) ? '*' : s)).join('/');
}

// The engine matches a path ending in "*" as a prefix. A template with a variable segment that
// is not last can only be approximated by the prefix before the first "*" (documented limit).
function selectorFor(template) {
  if (template === undefined) return null;
  const i = template.indexOf('*');
  if (i < 0) return template;
  return `${template.slice(0, i)}*`;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Only when the variable segment is the last one: the path itself carries the block index.
function patternFromTemplate(template) {
  if (typeof template !== 'string') return null;
  if (!template.endsWith('*')) return null;
  const prefix = template.slice(0, -1);
  if (!prefix.includes('/')) return null;
  return `${escapeRegex(prefix)}(\\d+)$`;
}

const distinctSize = (s) => (s.distinctDropped ? 9 : s.distinct.size);
// Leaf names that hold an identifier rather than prose. A changing id is never reply text, so it
// can neither be appended nor make a cluster "possibly text" (the value itself is never read).
const IDENTIFIER_LEAF = /(^|\.)(id|uuid|guid|key|token|hash|sha\d*|nonce|etag|marker|request_id|message_id|conversation_id|turn_exchange_id|working_turn_id|parent_id)$/i;
const isIdentifierLeaf = (path) => IDENTIFIER_LEAF.test(String(path));
// Protocol labels (`type`, `event`, `name`, `object`, `kind`) carry the frame's own name, not prose.
// Their values may be long (an event name such as `response.output_item.added`), so the one-shot
// "long string" text guess must not fire on them.
const LABEL_LEAF = /(^|\.)(type|event|name|object|kind)$/i;
const isLabelLeaf = (path) => LABEL_LEAF.test(String(path));

// Fragment-delta candidates: >=3 occurrences, no empty value, more than one distinct value, not a
// prefix chain (that is a cumulative snapshot), and enough total text to be a reply. All of them
// are returned because ambiguity is evidence: a cluster whose strings grow in more than one field
// is a metadata frame (a marker plus a changing event label, say), not reply text.
function growthCandidates(c, minGrowth) {
  const out = [];
  for (const [path, s] of c.str) {
    if (isIdentifierLeaf(path) || isLabelLeaf(path)) continue;
    if (s.n < 3) continue;
    if (s.emptyN !== 0) continue;
    if (distinctSize(s) < 2) continue;
    // Prefix evidence must be evaluated within each SID, never across separate streams.
    // Even one prefix transition is ambiguous: do not silently double-append a snapshot.
    if (s.prefixN > 0) continue;
    if (s.totalLen < 8) continue;
    if (s.maxLen < 2) continue;
    const growthPairs = s.pairs;
    if (growthPairs < minGrowth) continue;
    out.push({ path, growthPairs, textChars: s.totalLen });
  }
  // Largest total text first, then path, so the choice (and the report) never depends on Map order.
  return out.sort((a, b) => b.textChars - a.textChars || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

// String leaf whose whole sequence is a prefix chain (a snapshot that grew), which an append-only
// engine cannot reproduce without duplicating text.
function cumulativeCandidate(c) {
  const paths = [...c.str.keys()].sort();
  for (const path of paths) {
    const s = c.str.get(path);
    if (s.n < 2 || s.pairs === 0) continue;
    if (distinctSize(s) < 2) continue;
    if (s.prefixN === s.pairs) return { path, count: s.n };
  }
  return null;
}

// Could this cluster be carrying reply text the engine should not silently drop? Two shapes:
// a string that changes over >=3 occurrences and is long enough to be prose, or a single long
// string (a one-shot reply frame). Short enums, ids and discriminators do not qualify.
function potentiallyText(c) {
  for (const [path, s] of c.str) {
    if (isIdentifierLeaf(path) || isLabelLeaf(path)) continue;
    if (s.n >= 3 && distinctSize(s) > 1 && s.maxLen >= 8) return true;
    if (s.n === 1 && s.maxLen >= 24) return true;
  }
  return false;
}

function objectIdPath(c) {
  const keys = [...c.types.keys()].sort((a, b) => (a.length - b.length) || (a < b ? -1 : a > b ? 1 : 0));
  for (const k of keys) {
    if (c.types.get(k) !== 'object') continue;
    if (c.types.get(`${k}.id`) === 'string') return { obj: k, id: `${k}.id` };
  }
  if (c.types.get('id') === 'string') return { obj: null, id: 'id' };
  return null;
}

function nestedObjectPath(c) {
  const keys = [...c.types.keys()].sort((a, b) => (a.length - b.length) || (a < b ? -1 : a > b ? 1 : 0));
  for (const k of keys) if (c.types.get(k) === 'object') return k;
  return null;
}

/**
 * Propose a stream map from decoded events.
 * @param {Array} events decoded stream events ({ sid, seq, event, data, json, terminal })
 * @param {object} [opts] { id, site, minGrowth (default 2), domComponentMap }
 * @returns a valid stream map plus `induction` (counts) and `unexplained` (clusters, counts only)
 */
export function induceStreamMap(events, opts = {}) {
  const list = Array.isArray(events) ? events : [];
  const minGrowth = Number.isInteger(opts.minGrowth) && opts.minGrowth > 0 ? opts.minGrowth : 2;
  const clusters = new Map();
  const order = [];
  const perSid = new Map();
  const sidList = [];
  let gpos = 0;
  let totalUnits = 0;
  let pathLikeUnits = 0;

  for (const ev of list) {
    const e = isObj(ev) ? ev : {};
    const sid = e.sid !== undefined && e.sid !== null ? String(e.sid) : '(none)';
    let st = perSid.get(sid);
    if (!st) { st = { lastPath: null, units: 0 }; perSid.set(sid, st); sidList.push(sid); }
    for (const { unit, error } of unitsOf(e.json)) {
      totalUnits++;
      const pos = { sid, pos: st.units++, at: gpos++ };
      const pathLike = isObj(unit) && ('p' in unit || 'o' in unit || ('v' in unit && !('type' in unit)));
      let p;
      let o = null;
      if (pathLike) {
        p = unit.p !== undefined ? unit.p : st.lastPath;
        o = unit.o === undefined ? 'append' : unit.o;
        if (typeof p === 'string') st.lastPath = p;
        pathLikeUnits++;
      }
      const view = {
        eventName: typeof e.event === 'string' ? e.event : null,
        // "(non-string)" is a sentinel for a type key whose value is not a string: not expressible.
        type: isObj(unit) ? (typeof unit.type === 'string' ? unit.type : ('type' in unit ? '(non-string)' : null)) : null,
        blockType: isObj(unit) && isObj(unit.content_block) && typeof unit.content_block.type === 'string' ? unit.content_block.type : null,
        deltaType: isObj(unit) && isObj(unit.delta) && typeof unit.delta.type === 'string' ? unit.delta.type : null,
        pathTemplate: pathTemplate(p),
        o: typeof o === 'string' ? o : null,
        terminal: e.terminal === true,
      };
      const types = error ? new Map() : leavesOf(unit);
      // The pointer keys are protocol plumbing, not content: the engine resolves them into the
      // view (path/o) before rules run, so a rule can never distinguish {p,o,v} from a bare {v}.
      if (pathLike) { types.delete('p'); types.delete('o'); }
      const sig = [...types.entries()].map(([k, t]) => `${k}:${t}`).join('|');
      const key = JSON.stringify([
        error ?? null, view.eventName, view.type, view.blockType, view.deltaType,
        view.pathTemplate ?? null, view.o, view.terminal, sig,
      ]);
      let c = clusters.get(key);
      if (!c) {
        c = { id: `c${order.length + 1}`, key, sig, ...view, types, count: 0, pos: [], str: new Map(), firstSids: new Set(), lastSids: new Set() };
        clusters.set(key, c);
        order.push(c);
      }
      c.count++;
      c.pos.push(pos);
      if (error) continue;
      for (const [path, t] of types) {
        if (t !== 'string') continue;
        const v = getPath(unit, path);
        if (typeof v !== 'string') continue;
        let s = c.str.get(path);
        if (!s) {
          s = { n: 0, distinct: new Set(), distinctDropped: false, prevBySid: new Map(), pairs: 0, prefixN: 0, eqN: 0, emptyN: 0, totalLen: 0, maxLen: 0 };
          c.str.set(path, s);
        }
        s.n++;
        if (!s.distinctDropped) {
          s.distinct.add(v);
          if (s.distinct.size > 8) { s.distinctDropped = true; s.distinct.clear(); }
        }
        const prev = s.prevBySid.get(sid);
        if (prev !== undefined) {
          s.pairs++;
          if (v.startsWith(prev)) s.prefixN++;
          if (v === prev) s.eqN++;
        }
        s.prevBySid.set(sid, v);
        if (v === '') s.emptyN++;
        s.totalLen += v.length;
        if (v.length > s.maxLen) s.maxLen = v.length;
      }
    }
  }

  const streams = sidList.length;
  const totalBySid = new Map(sidList.map((sid) => [sid, perSid.get(sid).units]));
  for (const c of order) {
    for (const q of c.pos) {
      if (q.pos === 0) c.firstSids.add(q.sid);
      if (q.pos === totalBySid.get(q.sid) - 1) c.lastSids.add(q.sid);
    }
  }

  // Append candidates first: close needs to know where appending starts in each stream.
  const appends = new Map();
  for (const c of order) {
    if (c.terminal) continue;
    const candidates = growthCandidates(c, minGrowth);
    if (candidates.length) appends.set(c, { best: candidates[0], count: candidates.length });
  }
  const firstAppendBySid = new Map();
  for (const c of appends.keys()) {
    for (const q of c.pos) {
      const cur = firstAppendBySid.get(q.sid);
      if (cur === undefined || q.pos < cur) firstAppendBySid.set(q.sid, q.pos);
    }
  }

  const dialect = totalUnits > 0 && pathLikeUnits * 2 > totalUnits ? 'path-ops' : 'typed-events';

  // Block index: the most frequent numeric leaf (ties: lexicographically smallest path). For
  // path-ops streams the pointer itself carries the index, so "p" + a captured number is better.
  const numFreq = new Map();
  for (const c of order) for (const [path, t] of c.types) if (t === 'number') numFreq.set(path, (numFreq.get(path) ?? 0) + c.count);
  const rankedNumeric = [...numFreq].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const numericPath = rankedNumeric.length && rankedNumeric[0][1] >= 2 ? rankedNumeric[0][0] : null;
  const firstAppend = appends.keys().next().value ?? null;
  let blockIndexPath = numericPath;
  let blockIndexPattern;
  if (dialect === 'path-ops' && firstAppend) {
    const pattern = patternFromTemplate(firstAppend.pathTemplate);
    if (pattern) { blockIndexPath = 'p'; blockIndexPattern = pattern; }
  }

  // A rule needs an expressible selector; `o` is emitted only when the same pointer template is
  // observed with more than one op (otherwise the minimal selector is used, as the hand maps do).
  const opsByTemplate = new Map();
  for (const c of order) {
    if (c.pathTemplate === undefined) continue;
    const sp = selectorFor(c.pathTemplate);
    const set = opsByTemplate.get(sp) ?? new Set();
    if (c.o !== null) set.add(c.o);
    opsByTemplate.set(sp, set);
  }

  const baseWhen = (c, objectPath = null) => {
    const w = {};
    if (c.pathTemplate !== undefined) {
      const sp = selectorFor(c.pathTemplate);
      if (sp === null) return null;
      w.path = sp;
      const ops = opsByTemplate.get(sp) ?? new Set();
      if (ops.size > 1 && c.o !== null) w.o = c.o;
      if (typeof c.type === 'string') w.type = c.type;
      return Object.keys(w).length ? w : null;
    }
    if (typeof c.type === 'string') {
      // A type discriminator is already selective; adding isObject would only narrow the hand-map
      // overlap without adding evidence.
      w.type = c.type;
      if (c.blockType) w['block.type'] = c.blockType;
      if (c.deltaType) w['delta.type'] = c.deltaType;
    } else if (c.type === null) {
      // Without a type discriminator, an event name or a nested object there is no selector that
      // would not also swallow unrelated frames later; such a cluster stays unexplained.
      if (objectPath) w.isObject = objectPath;
      else if (c.eventName !== null) w.event = c.eventName;
      else return null;
      w.type = null;
    }
    return Object.keys(w).length ? w : null;
  };

  const openRules = [];
  const appendRules = [];
  const closeRules = [];
  const finalizeRules = [];
  const ignoreRules = [];
  const unexplained = [];
  let messageIdPath;

  const evidenceOf = (c) => ({
    clusterId: c.id,
    count: c.count,
    streams: new Set(c.pos.map((q) => q.sid)).size,
    firstInStream: c.firstSids.size,
    lastInStream: c.lastSids.size,
  });

  // Two structurally different clusters can still resolve to the same selector (a bare {v}
  // continuation and an explicit {p,o,v} frame, two terminal frames): the engine cannot tell them
  // apart, so one rule covers both and the counts are merged instead of a duplicate `when`.
  const byWhen = new Map();
  const emit = (bucket, rule) => {
    const sig = JSON.stringify(canonicalWhen(rule.when));
    const prior = byWhen.get(sig);
    if (prior) {
      prior.evidence.count += rule.evidence.count;
      prior.evidence.clusters = (prior.evidence.clusters ?? 1) + 1;
      return;
    }
    byWhen.set(sig, rule);
    bucket.push(rule);
  };

  for (const c of order) {
    const app = appends.get(c) ?? null;
    // Exactly one growth field is evidence of reply text; several growth fields in one cluster
    // (a marker plus a changing label, say) mean the cluster is metadata, not a text stream.
    const t = app && app.count === 1 ? app.best : null;
    const ambiguousGrowth = app ? app.count > 1 : false;

    // 1. Terminal flag: the only finalize evidence that does not depend on position.
    if (c.terminal) {
      emit(finalizeRules, {
        when: { terminal: true }, op: 'finalize', evidence: evidenceOf(c), confidence: 0.9,
      });
      continue;
    }

    const idInfo = c.firstSids.size === streams && c.count <= streams * 3 ? objectIdPath(c) : null;
    const nested = c.firstSids.size === streams && c.count <= streams * 3 ? nestedObjectPath(c) : null;

    // 2. OPEN: starts every stream, small count, carries a nested object.
    if (nested !== null) {
      const when = baseWhen(c, idInfo?.obj ?? nested);
      if (when) {
        const rule = { when, op: 'open', component: 'message' };
        if (idInfo) { rule.keyPath = idInfo.id; if (messageIdPath === undefined) messageIdPath = idInfo.id; }
        rule.evidence = evidenceOf(c);
        rule.confidence = round2(Math.min(0.95, 0.55 + 0.25 + 0.05 * Math.min(3, c.count)));
        emit(openRules, rule);
        continue;
      }
    }

    // 3. APPEND: fragment growth at a stable string leaf.
    if (t) {
      const when = baseWhen(c);
      if (when) {
        emit(appendRules, {
          when, op: 'append', component: 'paragraph', textPath: t.path,
          evidence: { ...evidenceOf(c), growthPairs: t.growthPairs, textChars: t.textChars },
          confidence: round2(Math.min(0.95, 0.45 + 0.1 * Math.min(5, t.growthPairs))),
        });
        continue;
      }
    }

    // 4. Position facts used by CLOSE and FINALIZE.
    const afterFirstAppend = c.pos.every((q) => {
      const fa = firstAppendBySid.get(q.sid);
      return fa !== undefined && q.pos > fa;
    });
    const lastAll = c.lastSids.size === streams && c.count === streams;
    const hasIndex = blockIndexPath
      ? c.types.get(blockIndexPath) === 'number' || (blockIndexPath === 'p' && c.types.get('p') === 'string')
      : false;

    if (afterFirstAppend && !lastAll && hasIndex) {
      const when = baseWhen(c);
      if (when) {
        emit(closeRules, {
          when, op: 'close', evidence: { ...evidenceOf(c), afterFirstAppend: c.count },
          confidence: round2(Math.min(0.85, 0.55 + 0.05 * Math.min(3, c.count))),
        });
        continue;
      }
    }

    if (lastAll) {
      const when = baseWhen(c);
      if (when) {
        emit(finalizeRules, {
          when, op: 'finalize', evidence: evidenceOf(c), confidence: 0.6,
        });
        continue;
      }
    }

    // 5. IGNORE: text-free, not an open/append/close/finalize frame. A cumulative snapshot or a
    // cluster that could be carrying reply text is NOT ignored: ignoring it would silently discard
    // content, so it stays unexplained below.
    const cum = cumulativeCandidate(c);
    if (!t && !cum && !potentiallyText(c)) {
      const when = baseWhen(c);
      if (when) {
        emit(ignoreRules, {
          when, op: 'ignore', evidence: evidenceOf(c),
          confidence: round2(Math.min(0.75, 0.5 + 0.03 * Math.min(5, c.count))),
        });
        continue;
      }
    }

    // 6. Unexplained: counted, never dropped.
    const noSelector = c.type === null && c.pathTemplate === undefined && c.eventName === null;
    let reason;
    if (t) reason = 'append_selector_not_expressible';
    else if (ambiguousGrowth) reason = 'ambiguous_growth';
    else if (noSelector) reason = 'no_selector';
    else if (cum) reason = 'cumulative_snapshot_text';
    else if (c.str.size > 0) reason = 'insufficient_growth';
    else reason = 'no_structural_role';
    unexplained.push({
      clusterId: c.id, count: c.count, streams: new Set(c.pos.map((q) => q.sid)).size,
      reason, signature: c.sig.slice(0, 160),
    });
  }

  // Only one messageIdPath: the shortest object.id path seen anywhere, when no open rule gave one.
  if (messageIdPath === undefined) {
    const candidates = [];
    for (const c of order) {
      const info = objectIdPath(c);
      if (info) candidates.push(info.id);
    }
    candidates.sort((a, b) => (a.length - b.length) || (a < b ? -1 : a > b ? 1 : 0));
    if (candidates.length) messageIdPath = candidates[0];
  }

  // Rule order: terminal finalize, open, append, close, positional finalize, ignore. Selectors are
  // disjoint per cluster, so the order only fixes a deterministic document order.
  const ops = [...finalizeRules.filter((r) => r.when.terminal === true), ...openRules, ...appendRules,
    ...closeRules, ...finalizeRules.filter((r) => r.when.terminal !== true), ...ignoreRules];

  const stream = {};
  if (typeof messageIdPath === 'string' && messageIdPath) stream.messageIdPath = messageIdPath;
  if (typeof blockIndexPath === 'string' && blockIndexPath) stream.blockIndexPath = blockIndexPath;
  if (typeof blockIndexPattern === 'string' && blockIndexPattern) stream.blockIndexPattern = blockIndexPattern;
  stream.ops = ops;

  return {
    schema: STREAM_MAP_SCHEMA,
    id: typeof opts.id === 'string' && opts.id ? opts.id : 'induced-stream-map',
    site: typeof opts.site === 'string' && opts.site ? opts.site : 'generic',
    family: 'ai-chat',
    version: 1,
    dialect,
    stream,
    dom: { componentMap: isObj(opts.domComponentMap) ? opts.domComponentMap : {} },
    induction: {
      events: list.length,
      units: totalUnits,
      streams,
      clusters: order.length,
      rules: ops.length,
      unexplained: unexplained.length,
      pathLikeUnits,
    },
    unexplained,
  };
}

// ---------------------------------------------------------------------------------------------
// Comparison against a hand-written map. SELECTOR-based Dice overlap per rule category, a number
// in [0,1] with no pass/fail threshold. A rule's identity here is only its selector: `op` plus
// `when` (sorted, with o:"append" dropped because that is the engine's default op for a path
// frame). Targets (component, textPath, keyPath, kind) are deliberately NOT compared: the two
// sides may reach the same frame with a different target, and the question is whether they select
// the same frames. `finalize` is not one of the four reported categories, but it counts in `all`.
// Two empty sets score 1 (nothing in that category on either side).
// ---------------------------------------------------------------------------------------------
function canonicalWhen(when) {
  if (!isObj(when)) return [];
  const out = [];
  for (const k of Object.keys(when).sort()) {
    if (k === 'o' && when[k] === 'append') continue;
    out.push([k, when[k]]);
  }
  return out;
}

function ruleSig(rule) {
  if (!isObj(rule)) return '';
  return JSON.stringify([rule.op, canonicalWhen(rule.when)]);
}

function diceSets(a, b) {
  if (a.size === 0 && b.size === 0) return 1;
  let common = 0;
  for (const x of a) if (b.has(x)) common++;
  return round3((2 * common) / (a.size + b.size));
}

export function compareMaps(induced, reference) {
  const a = Array.isArray(induced?.stream?.ops) ? induced.stream.ops : [];
  const b = Array.isArray(reference?.stream?.ops) ? reference.stream.ops : [];
  const cat = (ops, category) => new Set(ops.filter((r) => isObj(r) && r.op === category).map(ruleSig));
  const out = {};
  for (const category of CATEGORIES) out[category] = diceSets(cat(a, category), cat(b, category));
  out.all = diceSets(new Set(a.filter(isObj).map(ruleSig)), new Set(b.filter(isObj).map(ruleSig)));
  return out;
}
