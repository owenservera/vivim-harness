// graph-analytics.mjs — deterministic graph metrics over plain {nodes, edges} views.
// Zero deps. Every export accepts nodes = string ids and edges = {from,to,weight=1}.
// Missing weights default to 1, edges to unknown nodes are ignored, parallel edges sum.

const SEP = '\u0000';

function idOf(value) {
  if (value === null || value === undefined) return null;
  const t = typeof value;
  if (t === 'string') return value;
  if (t === 'number' || t === 'boolean' || t === 'bigint') return String(value);
  if (t === 'object') {
    const raw = value.id ?? value.eid ?? value.name ?? value.label;
    return raw === null || raw === undefined ? null : String(raw);
  }
  return null;
}

function weightOf(edge) {
  const raw = edge.weight !== undefined ? edge.weight : edge.confidence;
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 1;
}

function toArray(value) {
  if (!value) return [];
  if (value instanceof Map) return [...value.values()];
  return Array.isArray(value) ? value : [...value];
}

// Deduped, sorted node ids.
function normalizeNodes(nodes) {
  const seen = new Set();
  for (const raw of toArray(nodes)) {
    const id = idOf(raw);
    if (id !== null) seen.add(id);
  }
  return [...seen].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

// Merged parallel edges, sorted by (from,to) for order-independent floats.
function mergeEdges(ids, edges) {
  const known = new Set(ids);
  const map = new Map();
  for (const edge of toArray(edges)) {
    if (!edge || typeof edge !== 'object') continue;
    const from = idOf(edge.from !== undefined ? edge.from : edge.source);
    const to = idOf(edge.to !== undefined ? edge.to : edge.target);
    if (from === null || to === null || !known.has(from) || !known.has(to)) continue;
    const key = from + SEP + to;
    const prev = map.get(key);
    const weight = weightOf(edge);
    if (prev) prev.weight += weight;
    else map.set(key, { from, to, weight });
  }
  return [...map.values()].sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : a.to < b.to ? -1 : a.to > b.to ? 1 : 0));
}

function outAdjacency(ids, edges) {
  const out = new Map(ids.map((id) => [id, []]));
  for (const edge of mergeEdges(ids, edges)) out.get(edge.from).push({ to: edge.to, weight: edge.weight });
  return out;
}

function cmpId(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

export function pagerank(nodes, edges, opts = {}) {
  const { damping = 0.85, tol = 1e-8, maxIter = 100 } = opts || {};
  const ids = normalizeNodes(nodes);
  const n = ids.length;
  const scores = {};
  if (n === 0) return { scores, iterations: 0, converged: true };

  const out = outAdjacency(ids, edges);
  const outSum = new Map();
  const dangling = [];
  for (const id of ids) {
    let sum = 0;
    for (const link of out.get(id)) sum += link.weight;
    outSum.set(id, sum);
    if (sum <= 0) dangling.push(id);
  }

  let rank = new Map(ids.map((id) => [id, 1 / n]));
  const iterLimit = Number.isFinite(maxIter) ? Math.max(0, Math.floor(maxIter)) : 100;
  let iterations = 0;
  let converged = false;

  for (let it = 0; it < iterLimit; it++) {
    iterations = it + 1;
    let danglingMass = 0;
    for (const id of dangling) danglingMass += rank.get(id);
    const base = (1 - damping) / n + (damping * danglingMass) / n;
    const next = new Map(ids.map((id) => [id, base]));
    for (const id of ids) {
      const sum = outSum.get(id);
      if (sum <= 0) continue;
      const share = (damping * rank.get(id)) / sum;
      for (const link of out.get(id)) next.set(link.to, next.get(link.to) + share * link.weight);
    }
    let delta = 0;
    for (const id of ids) delta += Math.abs(next.get(id) - rank.get(id));
    rank = next;
    if (delta <= tol) { converged = true; break; }
  }

  let total = 0;
  for (const id of ids) total += rank.get(id);
  for (const id of ids) scores[id] = total > 0 ? rank.get(id) / total : 1 / n;
  return { scores, iterations, converged };
}

export function betweenness(nodes, edges, opts = {}) {
  const { maxSources = 200, directed = true, normalize = true } = opts || {};
  const ids = normalizeNodes(nodes);
  const n = ids.length;
  const scores = {};
  if (n === 0) return { scores, sources: 0, sampled: false };

  const adj = new Map(ids.map((id) => [id, []]));
  for (const edge of mergeEdges(ids, edges)) {
    if (edge.from === edge.to) continue;
    adj.get(edge.from).push(edge.to);
    if (!directed) adj.get(edge.to).push(edge.from);
  }
  for (const id of ids) adj.get(id).sort(cmpId);

  const limit = Number.isFinite(maxSources) ? Math.max(0, Math.floor(maxSources)) : n;
  const sources = ids.slice(0, limit);
  const sampled = sources.length < n;

  const cumulative = new Map(ids.map((id) => [id, 0]));
  for (const source of sources) {
    const stack = [];
    const preds = new Map(ids.map((id) => [id, []]));
    const sigma = new Map(ids.map((id) => [id, 0]));
    const dist = new Map(ids.map((id) => [id, -1]));
    const delta = new Map(ids.map((id) => [id, 0]));
    sigma.set(source, 1);
    dist.set(source, 0);
    const queue = [source];

    for (let head = 0; head < queue.length; head++) {
      const v = queue[head];
      stack.push(v);
      const dv = dist.get(v);
      for (const w of adj.get(v)) {
        if (dist.get(w) < 0) { dist.set(w, dv + 1); queue.push(w); }
        if (dist.get(w) === dv + 1) {
          sigma.set(w, sigma.get(w) + sigma.get(v));
          preds.get(w).push(v);
        }
      }
    }

    for (let i = stack.length - 1; i >= 0; i--) {
      const w = stack[i];
      const sw = sigma.get(w);
      for (const v of preds.get(w)) delta.set(v, delta.get(v) + (sigma.get(v) / sw) * (1 + delta.get(w)));
      if (w !== source) cumulative.set(w, cumulative.get(w) + delta.get(w));
    }
  }

  const scale = sampled && sources.length > 0 ? n / sources.length : 1;
  const denom = normalize && n > 2 ? (directed ? (n - 1) * (n - 2) : ((n - 1) * (n - 2)) / 2) : 0;
  for (const id of ids) scores[id] = denom > 0 ? (cumulative.get(id) * scale) / denom : cumulative.get(id) * scale;
  return { scores, sources: sources.length, sampled };
}

export function components(nodes, edges) {
  const ids = normalizeNodes(nodes);
  const parent = new Map(ids.map((id) => [id, id]));
  const find = (x) => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root);
    while (parent.get(x) !== root) { const up = parent.get(x); parent.set(x, root); x = up; }
    return root;
  };
  for (const edge of mergeEdges(ids, edges)) {
    const a = find(edge.from);
    const b = find(edge.to);
    if (a === b) continue;
    if (a < b) parent.set(b, a); else parent.set(a, b);
  }
  const groups = new Map();
  for (const id of ids) {
    const root = find(id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(id);
  }
  return [...groups.values()]
    .map((group) => group.sort(cmpId))
    .sort((a, b) => b.length - a.length || cmpId(a[0], b[0]));
}

export function communities(nodes, edges, opts = {}) {
  const { maxIter = 20 } = opts || {};
  const ids = normalizeNodes(nodes);
  const labels = {};
  if (ids.length === 0) return { labels, groups: [], iterations: 0 };

  const neighbours = new Map(ids.map((id) => [id, new Map()]));
  for (const edge of mergeEdges(ids, edges)) {
    if (edge.from === edge.to) continue;
    const a = neighbours.get(edge.from);
    const b = neighbours.get(edge.to);
    a.set(edge.to, (a.get(edge.to) ?? 0) + edge.weight);
    b.set(edge.from, (b.get(edge.from) ?? 0) + edge.weight);
  }

  const label = new Map(ids.map((id) => [id, id]));
  const iterLimit = Number.isFinite(maxIter) ? Math.max(0, Math.floor(maxIter)) : 0;
  let iterations = 0;

  for (let it = 0; it < iterLimit; it++) {
    iterations = it + 1;
    let changed = false;
    for (const id of ids) {
      const totals = new Map();
      for (const [nb, weight] of neighbours.get(id)) {
        const l = label.get(nb);
        totals.set(l, (totals.get(l) ?? 0) + weight);
      }
      let bestLabel = null;
      let bestWeight = -Infinity;
      for (const l of [...totals.keys()].sort(cmpId)) {
        const weight = totals.get(l);
        if (weight > bestWeight) { bestWeight = weight; bestLabel = l; }
      }
      if (bestLabel !== null && bestLabel !== label.get(id)) {
        label.set(id, bestLabel);
        changed = true;
      }
    }
    if (!changed) break;
  }

  const buckets = new Map();
  for (const id of ids) {
    const l = label.get(id);
    labels[id] = l;
    if (!buckets.has(l)) buckets.set(l, []);
    buckets.get(l).push(id);
  }
  const groups = [...buckets.values()]
    .map((group) => group.sort(cmpId))
    .sort((a, b) => b.length - a.length || cmpId(a[0], b[0]));
  return { labels, groups, iterations };
}

export function topK(scoreObj, k = 10) {
  const limit = Number.isFinite(k) ? Math.max(0, Math.floor(k)) : 10;
  const entries = [];
  for (const [id, raw] of Object.entries(scoreObj ?? {})) {
    const score = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(score)) continue;
    entries.push({ id, score });
  }
  entries.sort((a, b) => b.score - a.score || cmpId(a.id, b.id));
  return entries.slice(0, limit);
}

export function graphAnalytics(graph, opts = {}) {
  const source = graph ?? {};
  const options = opts ?? {};
  const ids = normalizeNodes(source.nodes ?? []);
  const merged = mergeEdges(ids, source.edges ?? []);

  const rank = pagerank(ids, merged, options.pagerank ?? {});
  const centrality = betweenness(ids, merged, options.betweenness ?? {});
  const parts = components(ids, merged);
  const comms = communities(ids, merged, options.communities ?? {});

  return {
    nodes: ids.length,
    edges: merged.length,
    pagerank: { iterations: rank.iterations, converged: rank.converged, top: topK(rank.scores, 10) },
    betweenness: { sampled: centrality.sampled, top: topK(centrality.scores, 10) },
    components: { count: parts.length, largest: parts.slice(0, 5).map((group) => group.length) },
    communities: { count: comms.groups.length, groups: comms.groups.slice(0, 10) },
  };
}
