// A tiny entity query language for "studio knowledge query".
//   type=Message            exact (case-insensitive); a|b means either
//   attrs.role=assistant    nested field (the "attrs." prefix is optional: role=assistant)
//   text~hello              contains (case-insensitive)
//   observations>3          numeric comparison (>, >=, <, <=)
//   title!=Untitled         not equal
//   email?                  field exists
//   hello                   bare word: appears anywhere in the entity
// All terms must match (AND). Fields: type|typeName, eid, key, scope, method, observations,
// revisions (count), confidence, first, last, or any attribute.
import { usageError } from './ui.mjs';

const TERM = /^([A-Za-z_][A-Za-z0-9_.\[\]-]*)(!=|>=|<=|=|~|>|<|\?)(.*)$/;
const TOP = new Set(['type', 'typeName', 'eid', 'key', 'scope', 'method', 'observations', 'revisions', 'confidence', 'first', 'last', 'session', 'confidenceBasis', 'idBasis']);

export function parseQuery(tokens) {
  const terms = [];
  for (const raw of tokens) {
    const m = TERM.exec(raw);
    if (!m) { terms.push({ kind: 'text', needle: raw.toLowerCase() }); continue; }
    const [, field, op, rhs] = m;
    if (op === '?' && rhs !== '') { terms.push({ kind: 'text', needle: raw.toLowerCase() }); continue; }
    terms.push({ kind: 'field', field, op, rhs, alternatives: rhs.split('|').map((x) => x.toLowerCase()) });
  }
  if (!terms.length) throw usageError('Empty query.', 'Example: studio knowledge query type=Message role=assistant text~hello');
  return terms;
}

export function fieldValue(entity, field) {
  if (field === 'type' || field === 'typeName') return field === 'type' ? [entity.typeName, entity.type] : [entity.typeName];
  if (field === 'revisions') return [Array.isArray(entity.revisions) ? entity.revisions.length : 0];
  if (TOP.has(field)) return [entity[field]];
  const path = field.replace(/^attrs\./, '').replace(/\[(\d+)\]/g, '.$1').split('.');
  let cur = entity.attrs;
  for (const p of path) { if (cur === null || cur === undefined) return [undefined]; cur = cur[p]; }
  return [cur];
}

const asText = (v) => (v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

export function matches(entity, terms) {
  for (const t of terms) {
    if (t.kind === 'text') {
      if (!JSON.stringify([entity.eid, entity.typeName, entity.key, entity.attrs]).toLowerCase().includes(t.needle)) return false;
      continue;
    }
    const values = fieldValue(entity, t.field);
    const defined = values.filter((v) => v !== undefined && v !== null);
    let ok;
    switch (t.op) {
      case '?': ok = defined.length > 0; break;
      case '=': ok = defined.some((v) => t.alternatives.includes(asText(v).toLowerCase())); break;
      case '!=': ok = !defined.some((v) => t.alternatives.includes(asText(v).toLowerCase())); break;
      case '~': ok = defined.some((v) => t.alternatives.some((a) => asText(v).toLowerCase().includes(a))); break;
      default: {
        const rhs = Number(t.rhs);
        ok = Number.isFinite(rhs) && defined.some((v) => { const n = Number(v); return Number.isFinite(n) && (t.op === '>' ? n > rhs : t.op === '>=' ? n >= rhs : t.op === '<' ? n < rhs : n <= rhs); });
      }
    }
    if (!ok) return false;
  }
  return true;
}

// Short human summary of an entity's attributes for table cells.
export function attrSummary(attrs, max = 100) {
  const parts = [];
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === null || v === undefined) continue;
    parts.push(`${k}=${typeof v === 'string' ? v.replace(/\s+/g, ' ').slice(0, 40) : JSON.stringify(v).slice(0, 40)}`);
    if (parts.join(' ').length > max) break;
  }
  const s = parts.join(' ');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
