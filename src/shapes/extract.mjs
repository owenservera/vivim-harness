// Apply accepted profile rules to decoded events -> structured records (datasets).
import { templateUrl } from './infer.mjs';

const selectorCache = new Map();

// Fully consumed, cached JSONPath subset. Unsupported syntax cannot silently select the root
// or a shorter prefix, and inherited prototype properties are never payload observations.
export function compileSelector(path) {
  if (!path || path === '$') return (value) => [value];
  if (typeof path !== 'string') throw new TypeError('Selection path must be a string');
  if (selectorCache.has(path)) return selectorCache.get(path);
  const tokens = [];
  const re = /\.([A-Za-z_$][\w$]*)|\[\*\]|\[(\d+)\]|\["((?:[^"\\]|\\.)*)"\]/y;
  const rest = path.replace(/^\$/, '');
  let offset = 0;
  while (offset < rest.length) {
    re.lastIndex = offset; const match = re.exec(rest);
    if (!match) throw new Error(`Unsupported selection path at offset ${offset}: ${path}`);
    tokens.push(match[1] !== undefined ? { key: match[1] } : match[2] !== undefined ? { index: Number(match[2]) } : match[3] !== undefined ? { key: JSON.parse(`"${match[3]}"`) } : { star: true });
    offset = re.lastIndex;
  }
  const selector = (value) => {
    let cur = [value];
    for (const t of tokens) {
      const next = [];
      for (const v of cur) {
        if (v === null || v === undefined) continue;
        if (t.star) { if (typeof v === 'object') for (const x of Object.values(v)) next.push(x); }
        else if (t.index !== undefined) { if (Array.isArray(v) && Object.hasOwn(v, t.index)) next.push(v[t.index]); }
        else if (typeof v === 'object' && Object.hasOwn(v, t.key)) next.push(v[t.key]);
      }
      cur = next;
    }
    return cur;
  };
  if (selectorCache.size >= 256) selectorCache.delete(selectorCache.keys().next().value);
  selectorCache.set(path, selector); return selector;
}

// Invalid drafts return no selected values; compileSelector exposes diagnostics to editors.
export function select(value, path) {
  try { return compileSelector(path)(value); } catch { return []; }
}

export function ruleMatchesEvent(rule, ev, stream) {
  if (rule.source !== 'event' || ev.json === undefined) return false;
  if (rule.endpoint && !new RegExp(rule.endpoint).test(templateUrl(stream?.url ?? ''))) return false;
  const disc = (d) => !d.discriminatorPath || (d.discriminatorPath === 'event' ? ev.event : select(ev.json, d.discriminatorPath)[0]) === d.discriminator;
  if (rule.anyOf) return rule.anyOf.some(disc);
  return disc(rule);
}

export function extractRecords(rule, ev, stream) {
  const items = select(ev.json, rule.itemsPath ?? '$');
  return items.filter((x) => x && typeof x === 'object' && (!rule.itemFilter || select(x, rule.itemFilter.path)[0] === rule.itemFilter.equals)).map((item) => {
    const rec = { _rule: rule.name, _sid: ev.sid, _seq: ev.seq, _t: ev.t };
    for (const [name, spec] of Object.entries(rule.fields ?? {})) {
      const f = typeof spec === 'string' ? { path: spec } : spec;
      if (f.exclude) continue;
      const v = select(item, f.path);
      rec[f.as ?? name] = coerce(v.length <= 1 ? v[0] : v, f.type);
    }
    if (rule.key) rec._key = select(item, rule.key)[0];
    return rec;
  });
}

// For "assembled" rules: records from the final assembled document of a delta stream.
export function extractFromAssembled(rule, doc, stream) {
  if (rule.source !== 'assembled' || !doc) return [];
  if (rule.endpoint && !new RegExp(rule.endpoint).test(templateUrl(stream?.url ?? ''))) return [];
  return extractRecords({ ...rule, source: 'event' }, { json: doc, sid: stream.sid, seq: null, t: stream.endT }, stream);
}

// Field types chosen in the model editor are applied on output; the raw value stays on disk.
export function coerce(v, type) {
  if (v === undefined || v === null || !type || type === 'auto') return v;
  try {
    if (type === 'number') { if (typeof v !== 'number' && (typeof v !== 'string' || !v.trim())) return v; const n = Number(v); return Number.isFinite(n) ? n : v; }
    if (type === 'string' || type === 'text') return typeof v === 'string' ? v : JSON.stringify(v);
    if (type === 'boolean') { if (typeof v === 'boolean') return v; const s = String(v).trim().toLowerCase(); return ['true', '1', 'yes'].includes(s) ? true : ['false', '0', 'no'].includes(s) ? false : v; }
    if (type === 'time') { const d = typeof v === 'number' ? new Date(v < 1e12 ? v * 1000 : v) : new Date(v); return Number.isNaN(d.getTime()) ? v : d.toISOString(); }
    if (type === 'json') return typeof v === 'string' ? JSON.parse(v) : v;
  } catch { return v; }
  return v;
}
