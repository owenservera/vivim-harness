// Deterministic lexical ranking helpers. No I/O, clock, or randomness.
import { createHash } from 'node:crypto';

const STOPWORDS = new Set(`
a about above after again against all am an and any are aren't as at be because been
before being below between both but by can can't could couldn't did didn't do does
doesn't don't down during each few for from had hadn't has hasn't have haven't he
her here him his how i if in into is isn't it its me more most my myself no nor not
of off on only or other our out over own same she should shouldn't so some than that
the their them then there these they this those through to too under up very was
wasn't we were what when where which while who why with won't would wouldn't you
your yours yourself
`.trim().split(/\s+/));

/** @param {string} s SHA-1 digest. */
function sha1(s) {
  return createHash('sha1').update(String(s), 'utf8').digest();
}

/** @param {string} s Padded lowercase character trigrams. */
export function trigrams(s) {
  const padded = `  ${String(s).toLowerCase()}  `;
  const out = new Set();
  for (let i = 0; i + 2 < padded.length; i++) out.add(padded.slice(i, i + 3));
  return out;
}

/** @param {Set<string>} a @param {Set<string>} b Trigram Jaccard. */
function jaccardSets(a, b) {
  if (!a.size && !b.size) return 1;
  let inter = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const value of small) if (large.has(value)) inter++;
  const union = a.size + b.size - inter;
  return union ? inter / union : 0;
}

/** Optimal string alignment distance; returns max+1 when the bound is exceeded. */
export function damerauLevenshtein(a, b, max = Infinity) {
  a = String(a);
  b = String(b);
  if (a === b) return 0 > max ? max + 1 : 0;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > max) return max + 1;
  const d = Array.from({ length: la + 1 }, () => new Uint32Array(lb + 1));
  for (let i = 0; i <= la; i++) d[i][0] = i;
  for (let j = 0; j <= lb; j++) d[0][j] = j;
  for (let i = 1; i <= la; i++) {
    let rowMin = d[i][0];
    for (let j = 1; j <= lb; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      let best = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a.charCodeAt(i - 1) === b.charCodeAt(j - 2) && a.charCodeAt(i - 2) === b.charCodeAt(j - 1)) {
        best = Math.min(best, d[i - 2][j - 2] + 1);
      }
      d[i][j] = best;
      if (best < rowMin) rowMin = best;
    }
    if (rowMin > max) return max + 1;
  }
  return d[la][lb] > max ? max + 1 : d[la][lb];
}

function cmpStr(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Vocab terms within a scaled Damerau bound after a trigram-Jaccard prefilter. */
export function expandTerm(term, vocab, { maxDist = 2, limit = 5, minTrigramJaccard = 0.2 } = {}) {
  const query = String(term).toLowerCase();
  let cap = Number.isFinite(maxDist) ? maxDist : Infinity;
  if (query.length < 3) cap = 0;
  else if (query.length < 5) cap = Math.min(cap, 1);
  const qg = trigrams(query);
  const hits = [];
  for (const raw of vocab) {
    const original = String(raw);
    const candidate = original.toLowerCase();
    if (jaccardSets(qg, trigrams(candidate)) < minTrigramJaccard) continue;
    const dist = damerauLevenshtein(query, candidate, cap);
    if (dist > cap) continue;
    const sim = 1 - dist / Math.max(query.length, candidate.length, 1);
    hits.push({ term: original, dist, sim });
  }
  hits.sort((a, b) => a.dist - b.dist || b.sim - a.sim || cmpStr(a.term, b.term));
  return hits.slice(0, limit > 0 ? limit : 0);
}

/** @param {string|string[]} input Lowercased letter/number tokens. */
function tokenize(input) {
  const parts = Array.isArray(input) ? input : [input];
  const tokens = [];
  for (const part of parts) {
    for (const token of String(part).toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
      if (token) tokens.push(token);
    }
  }
  return tokens;
}

/** 64-bit SHA-1 prefix masked to `bits`, sign-voted by term frequency. */
export function simhash(input, bits = 53) {
  const width = Math.max(0, Math.min(64, bits | 0));
  const freq = new Map();
  for (const token of tokenize(input)) freq.set(token, (freq.get(token) ?? 0) + 1);
  const votes = new Array(width).fill(0);
  const mask = width >= 64 ? (1n << 64n) - 1n : (1n << BigInt(width)) - 1n;
  for (const [token, weight] of freq) {
    let hash = 0n;
    const digest = sha1(token);
    for (let i = 0; i < 8; i++) hash = (hash << 8n) | BigInt(digest[i]);
    hash &= mask;
    for (let bit = 0; bit < width; bit++) {
      votes[bit] += ((hash >> BigInt(bit)) & 1n) === 1n ? weight : -weight;
    }
  }
  let out = 0n;
  for (let bit = 0; bit < width; bit++) if (votes[bit] > 0) out |= 1n << BigInt(bit);
  return out;
}

/** Popcount of the XOR of two bit fingerprints. */
export function hamming(a, b) {
  let x = BigInt(a) ^ BigInt(b);
  let count = 0;
  while (x) {
    count += Number(x & 1n);
    x >>= 1n;
  }
  return count;
}

/** k minima of seeded SHA-1 prefixes over tokens. */
export function minhash(tokens, k = 64) {
  const n = Math.max(0, k | 0);
  const out = new Uint32Array(n);
  const list = Array.isArray(tokens) ? tokens : [...tokens];
  for (let seed = 0; seed < n; seed++) {
    let min = 0xffffffff;
    for (const token of list) {
      const digest = sha1(`${seed}:${token}`);
      const hash = ((digest[0] * 16777216) + (digest[1] << 16) + (digest[2] << 8) + digest[3]) >>> 0;
      if (hash < min) min = hash;
    }
    out[seed] = min;
  }
  return out;
}

/** Fraction of equal MinHash slots. */
export function jaccardFromMinhash(a, b) {
  const n = Math.max(a.length, b.length);
  if (!n) return 1;
  const m = Math.min(a.length, b.length);
  let equal = 0;
  for (let i = 0; i < m; i++) if (a[i] === b[i]) equal++;
  return equal / n;
}

/** Banded MinHash LSH clusters confirmed by exact token-set Jaccard. */
export function lshClusters(items, { bands = 16, rows = 4, threshold = 0.5 } = {}) {
  const bandCount = Math.max(1, bands | 0);
  const rowCount = Math.max(1, rows | 0);
  const prepared = items.map((item) => {
    const tokens = [...item.tokens].map(String);
    return { id: String(item.id), sig: minhash(tokens, bandCount * rowCount), set: new Set(tokens) };
  });
  const buckets = new Map();
  for (let index = 0; index < prepared.length; index++) {
    const sig = prepared[index].sig;
    for (let band = 0; band < bandCount; band++) {
      let key = String(band);
      const start = band * rowCount;
      for (let row = 0; row < rowCount; row++) key += `:${sig[start + row]}`;
      const bucket = buckets.get(key);
      if (bucket) bucket.push(index);
      else buckets.set(key, [index]);
    }
  }
  const parent = prepared.map((_, index) => index);
  const find = (index) => {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]];
      index = parent[index];
    }
    return index;
  };
  for (const bucket of buckets.values()) {
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        const left = bucket[i];
        const right = bucket[j];
        if (find(left) === find(right)) continue;
        if (jaccardSets(prepared[left].set, prepared[right].set) >= threshold) parent[find(left)] = find(right);
      }
    }
  }
  const groups = new Map();
  for (let index = 0; index < prepared.length; index++) {
    const root = find(index);
    const group = groups.get(root);
    if (group) group.push(prepared[index].id);
    else groups.set(root, [prepared[index].id]);
  }
  const clusters = [...groups.values()].filter((ids) => ids.length >= 2);
  for (const ids of clusters) ids.sort(cmpStr);
  clusters.sort((a, b) => b.length - a.length || cmpStr(a[0], b[0]));
  return clusters;
}

/** TF-IDF maps: tf = 1+ln(count), idf = ln(1+N/df). */
export function tfidfVectors(docs) {
  const n = docs.length;
  const df = new Map();
  const counted = docs.map((doc) => {
    const counts = new Map();
    for (const token of doc.tokens) {
      const term = String(token);
      counts.set(term, (counts.get(term) ?? 0) + 1);
    }
    for (const term of counts.keys()) df.set(term, (df.get(term) ?? 0) + 1);
    return { id: doc.id, counts };
  });
  const idf = new Map();
  for (const [term, documentFrequency] of df) idf.set(term, Math.log(1 + n / documentFrequency));
  const vectors = new Map();
  for (const { id, counts } of counted) {
    const vector = new Map();
    for (const [term, count] of counts) vector.set(term, (1 + Math.log(count)) * idf.get(term));
    vectors.set(id, vector);
  }
  return { vectors, idf };
}

/** Cosine similarity of sparse term maps. */
export function cosine(vecA, vecB) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (const [term, weight] of vecA) {
    normA += weight * weight;
    if (vecB.has(term)) dot += weight * vecB.get(term);
  }
  for (const weight of vecB.values()) normB += weight * weight;
  if (!normA || !normB) return 0;
  return dot / Math.sqrt(normA * normB);
}

/** Classic RAKE phrases scored by degree/frequency, using built-in or given stopwords. */
export function rake(text, { limit = 10, stopwords = STOPWORDS } = {}) {
  const phrases = [];
  let phrase = [];
  let lastEnd = 0;
  let seen = false;
  const source = String(text).toLowerCase();
  for (const match of source.matchAll(/\p{L}[\p{L}\p{N}']*|\p{N}+/gu)) {
    const gap = source.slice(lastEnd, match.index);
    if (seen && /[^\p{L}\p{N}\s']/u.test(gap) && phrase.length) {
      phrases.push(phrase);
      phrase = [];
    }
    const word = match[0];
    if (stopwords.has(word)) {
      if (phrase.length) phrases.push(phrase);
      phrase = [];
    } else phrase.push(word);
    lastEnd = match.index + word.length;
    seen = true;
  }
  if (phrase.length) phrases.push(phrase);
  const freq = new Map();
  const deg = new Map();
  for (const words of phrases) {
    for (const word of words) {
      freq.set(word, (freq.get(word) ?? 0) + 1);
      deg.set(word, (deg.get(word) ?? 0) + words.length);
    }
  }
  const wordScore = new Map();
  for (const [word, count] of freq) wordScore.set(word, deg.get(word) / count);
  const unique = new Map();
  for (const words of phrases) {
    const textPhrase = words.join(' ');
    if (unique.has(textPhrase)) continue;
    let score = 0;
    for (const word of words) score += wordScore.get(word);
    unique.set(textPhrase, score);
  }
  return [...unique].map(([textPhrase, score]) => ({ phrase: textPhrase, score }))
    .sort((a, b) => b.score - a.score || cmpStr(a.phrase, b.phrase))
    .slice(0, limit > 0 ? limit : 0);
}
