// Incremental, removable BM25 corpus index. Local evidence only; no embeddings or dependencies.
import { textTokens, normalizeText, stableStringify } from './similarity.mjs';

const WORD_PATTERN = /[\p{L}\p{N}]+(?:[._-][\p{L}\p{N}]+)*/gu;

/** Ascending, non-overlapping character offsets of whole-token matches (case-insensitive). */
export function highlightSpans(text, terms) {
  const wanted = new Set((terms ?? []).map((term) => String(term).toLowerCase()));
  const spans = [];
  if (!wanted.size) return spans;
  for (const match of String(text ?? '').matchAll(WORD_PATTERN)) {
    if (!wanted.has(match[0].toLowerCase())) continue;
    const start = match.index, end = start + match[0].length, last = spans[spans.length - 1];
    if (last && start < last[1]) continue;
    spans.push([start, end]);
  }
  return spans;
}

// Lazily resolved optional expansion module; a failed import degrades search to exact matching.
let rankModule = null, rankLoad = null;
function ensureRank() {
  if (!rankLoad) {
    rankLoad = import('./rank.mjs').then((mod) => (rankModule = mod)).catch(() => null);
  }
  return rankLoad;
}

/** Warm the optional rank module so a synchronous fuzzy search can use expandTerm. */
export async function primeFuzzySearch() {
  try { await ensureRank(); } catch { /* optional dependency */ }
  return Boolean(rankModule?.expandTerm);
}

function documentText(value, depth = 0) {
  if (depth > 12 || value === null || value === undefined) return '';
  if (typeof value !== 'object') return String(value);
  return Object.entries(value).map(([key, v]) => (Array.isArray(value) ? '' : key + ' ') + documentText(v, depth + 1)).join(' ');
}

export class CorpusSearchIndex {
  constructor({ k1 = 1.2, b = 0.75, maxTokens = 20000 } = {}) {
    this.k1 = Number.isFinite(k1) && k1 > 0 ? k1 : 1.2;
    this.b = Number.isFinite(b) ? Math.max(0, Math.min(1, b)) : 0.75;
    this.maxTokens = Number.isInteger(maxTokens) && maxTokens > 0 ? maxTokens : 20000;
    this.documents = new Map(); this.postings = new Map(); this.totalLength = 0;
  }
  add(id, document, { text, source, boost = 1 } = {}) {
    id = String(id); this.remove(id);
    const content = text ?? documentText(document);
    const all = textTokens(content), tokens = all.slice(0, this.maxTokens), frequencies = new Map();
    for (const token of tokens) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
    const row = { id, document, text: String(content), source: source ?? document?.source ?? null,
      boost: Number.isFinite(boost) ? Math.max(0, boost) : 1, length: tokens.length, frequencies,
      truncated: all.length > tokens.length };
    this.documents.set(id, row); this.totalLength += row.length;
    for (const [token, frequency] of frequencies) {
      if (!this.postings.has(token)) this.postings.set(token, new Map());
      this.postings.get(token).set(id, frequency);
    }
    return this;
  }
  remove(id) {
    id = String(id); const row = this.documents.get(id); if (!row) return false;
    for (const token of row.frequencies.keys()) {
      const posting = this.postings.get(token); posting.delete(id);
      if (!posting.size) this.postings.delete(token);
    }
    this.totalLength -= row.length; this.documents.delete(id); return true;
  }
  vocabulary() { return this.postings.keys(); }
  search(query, { limit = 20, requireAll = false, filter, phraseBoost = 0.3, fuzzy = false } = {}) {
    const terms = [...new Set(textTokens(query))];
    if (!terms.length || !this.documents.size) return [];
    const candidates = new Map(), N = this.documents.size, avg = this.totalLength / N || 1;
    const weighted = terms.map((term) => ({ term, weight: 1, from: null, dist: 0 }));
    if (fuzzy) {
      if (!rankModule) ensureRank();
      if (typeof rankModule?.expandTerm === 'function') {
        let vocabulary = null;
        for (const term of terms) {
          if ((this.postings.get(term)?.size ?? 0) > 0) continue;
          vocabulary ??= [...this.vocabulary()];
          let expansions = [];
          try { expansions = rankModule.expandTerm(term, vocabulary, { maxDist: 2, limit: 3 }) ?? []; } catch { expansions = []; }
          for (const expansion of expansions) {
            const next = String(expansion?.term ?? expansion ?? '');
            if (!next || next === term || weighted.some((entry) => entry.term === next)) continue;
            const dist = Number.isFinite(expansion?.dist) ? expansion.dist : 0;
            weighted.push({ term: next, weight: 0.5, from: term, dist });
          }
        }
      }
    }
    for (const { term, weight, from, dist } of weighted) {
      const posting = this.postings.get(term); if (!posting) continue;
      const idf = Math.log(1 + (N - posting.size + 0.5) / (posting.size + 0.5));
      for (const [id, frequency] of posting) {
        const row = this.documents.get(id), hit = candidates.get(id) ?? { row, score: 0, matchedTerms: [], fuzzyTerms: [] };
        hit.score += weight * idf * frequency * (this.k1 + 1) / (frequency + this.k1 * (1 - this.b + this.b * row.length / avg));
        if (!from) { if (!hit.matchedTerms.includes(term)) hit.matchedTerms.push(term); }
        else if (!hit.fuzzyTerms.some((entry) => entry.from === from && entry.to === term)) {
          hit.fuzzyTerms.push({ from, to: term, dist });
        }
        candidates.set(id, hit);
      }
    }
    const phrase = normalizeText(query);
    return [...candidates.values()].filter(({ row, matchedTerms }) => (!requireAll || matchedTerms.length === terms.length)
      && (!filter || filter(row.document, row.source)))
      .map(({ row, score, matchedTerms, fuzzyTerms }) => {
        const exactPhrase = normalizeText(row.text).includes(phrase);
        const lowered = row.text.toLowerCase();
        const words = [...matchedTerms, ...fuzzyTerms.map((entry) => entry.to)]
          .map((term) => lowered.indexOf(String(term).toLowerCase())).filter((i) => i >= 0);
        const at = words.length ? Math.min(...words) : 0;
        return { id: row.id, score: +((score + (exactPhrase ? Math.max(0, phraseBoost) : 0)) * row.boost).toFixed(6),
          matchedTerms, matched: [...matchedTerms], fuzzyMatched: fuzzyTerms.map((entry) => ({ ...entry })),
          coverage: matchedTerms.length / terms.length, exactPhrase,
          source: row.source, document: row.document, snippet: row.text.slice(Math.max(0, at - 70), at + 180),
          indexTruncated: row.truncated };
      }).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      .slice(0, Number.isInteger(limit) && limit > 0 ? limit : 20);
  }
  stats() { return { documents: this.documents.size, terms: this.postings.size, tokens: this.totalLength,
    truncatedDocuments: [...this.documents.values()].filter((d) => d.truncated).length }; }
  has(id) { return this.documents.has(String(id)); }
  get size() { return this.documents.size; }
  // Row form used for persistence: { id, text, source, boost } adds/replaces; { id, remove: true }
  // deletes. Replaying rows in order rebuilds the same index (later rows win).
  applyRow(row) {
    if (!row || row.id === undefined || row.id === null) return false;
    if (row.remove) return this.remove(row.id);
    this.add(row.id, row.document ?? row.source ?? {}, { text: row.text ?? '', source: row.source ?? null, boost: row.boost ?? 1 });
    return true;
  }
  toRows({ includeDocument = false } = {}) {
    return [...this.documents.values()].map((d) => ({ id: d.id, text: d.text, source: d.source, boost: d.boost, ...(includeDocument ? { document: d.document } : {}) }));
  }
  static fromRows(rows, options) { const index = new CorpusSearchIndex(options); for (const row of rows ?? []) index.applyRow(row); return index; }
}

export function indexCorpus(samples, options) {
  const index = new CorpusSearchIndex(options), repeats = new Map();
  for (const sample of samples) {
    const source = sample.source ?? {};
    const base = stableStringify([source.session, source.sid, source.seq, source.domId, source.group, source.index]);
    const ordinal = repeats.get(base) ?? 0; repeats.set(base, ordinal + 1);
    index.add(base + ':' + ordinal, sample, { text: documentText(sample.value ?? sample.attrs ?? sample), source });
  }
  return index;
}

export function rankCorpus(samples, query, options = {}) { return indexCorpus(samples, options).search(query, options); }
