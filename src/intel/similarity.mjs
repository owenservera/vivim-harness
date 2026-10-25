// Shared deterministic comparison primitives. Scores are evidence, not probabilities.
export function stableStringify(value) {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  return '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

export const normalizeText = (value) => String(value ?? '').normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();
export const textTokens = (value) => normalizeText(value).match(/[\p{L}\p{N}]+(?:[._-][\p{L}\p{N}]+)*/gu) ?? [];
export const typedValueKey = (value) => typeof value + ':' + stableStringify(value);

export function diceSimilarity(a, b) {
  const grams = (s) => {
    const chars = [...normalizeText(s)], out = new Set();
    if (chars.length < 2) return new Set(chars);
    for (let i = 1; i < chars.length; i++) out.add(chars[i - 1] + chars[i]);
    return out;
  };
  const A = grams(a), B = grams(b);
  if (!A.size || !B.size) return 0;
  let shared = 0; for (const gram of A) if (B.has(gram)) shared++;
  return 2 * shared / (A.size + B.size);
}

export function compareRecords(a = {}, b = {}, { fields, weights = {}, immutable = [] } = {}) {
  const names = fields ?? [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  const comparisons = [], conflicts = [];
  let sum = 0, available = 0, possible = 0;
  for (const field of names) {
    const weight = Number.isFinite(weights[field]) ? Math.max(0, weights[field]) : 1;
    possible += weight;
    const x = a[field], y = b[field];
    if (x === null || x === undefined || y === null || y === undefined) continue;
    const exact = typedValueKey(x) === typedValueKey(y);
    const score = exact ? 1 : typeof x === 'string' && typeof y === 'string' ? diceSimilarity(x, y) : 0;
    if (!exact && immutable.includes(field)) conflicts.push(field);
    comparisons.push({ field, score: +score.toFixed(4), exact, weight });
    sum += score * weight; available += weight;
  }
  return { score: conflicts.length ? 0 : available ? +(sum / available).toFixed(4) : 0,
    coverage: possible ? +(available / possible).toFixed(4) : 0, conflicts, comparisons };
}
