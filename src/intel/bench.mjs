// Deterministic in-memory benchmark harness. Pure: no disk, no network, no clock, no randomness.
import { CorpusSearchIndex, primeFuzzySearch } from './search.mjs';
import { detectContent } from './autodetect.mjs';
import { lshClusters } from './rank.mjs';
import { detectSecrets } from '../security/patterns.mjs';

const round4 = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 1e4) / 1e4 : 0;
};

// --- search fixtures: 12 short docs, 8 typo queries whose target doc is known ---
const SEARCH_DOCS = [
  { id: 'd-kube', text: 'kubernetes autoscaling deployment replicas rolling update' },
  { id: 'd-pg', text: 'postgres vacuum analyze index bloat statistics planner' },
  { id: 'd-redis', text: 'redis eviction maxmemory policy allkeys lru' },
  { id: 'd-elastic', text: 'elasticsearch shard allocation rebalance cluster green yellow' },
  { id: 'd-tf', text: 'terraform provider registry module pinning workspace' },
  { id: 'd-grafana', text: 'grafana dashboard datasource annotation panels alert' },
  { id: 'd-prom', text: 'prometheus alertmanager routing inhibition silences' },
  { id: 'd-nginx', text: 'nginx ingress tls termination upstream keepalive' },
  { id: 'd-rabbit', text: 'rabbitmq quorum queue prefetch delivery acknowledgement' },
  { id: 'd-kafka', text: 'kafka consumer rebalance partition offset commit group' },
  { id: 'd-docker', text: 'docker layer cache multistage build context registry' },
  { id: 'd-git', text: 'git rebase interactive squash cherry pick revert' }
];

// Each query carries one typo in the discriminative term plus a decoy term owned by another doc.
const SEARCH_QUERIES = [
  { id: 'd-kube', query: 'autoscalng grafana' },
  { id: 'd-pg', query: 'postgrs redis' },
  { id: 'd-redis', query: 'maxmory terraform' },
  { id: 'd-elastic', query: 'alocation prometheus' },
  { id: 'd-tf', query: 'pinng rabbitmq' },
  { id: 'd-grafana', query: 'datasorce elasticsearch' },
  { id: 'd-prom', query: 'alertmanagr docker' },
  { id: 'd-nginx', query: 'terminaton kubernetes' }
];

async function benchSearch() {
  const index = new CorpusSearchIndex();
  for (const doc of SEARCH_DOCS) index.add(doc.id, { source: 'bench' }, { text: doc.text });
  await primeFuzzySearch();
  let bm25Hits = 0;
  let baselineHits = 0;
  for (const query of SEARCH_QUERIES) {
    const fuzzy = index.search(query.query, { limit: 3, fuzzy: true });
    const exact = index.search(query.query, { limit: 3, fuzzy: false });
    if (fuzzy.some((hit) => hit.id === query.id)) bm25Hits += 1;
    if (exact.some((hit) => hit.id === query.id)) baselineHits += 1;
  }
  const total = SEARCH_QUERIES.length;
  return {
    bm25: round4(bm25Hits / total),
    baseline: round4(baselineHits / total),
    metric: `hit@3 over ${total} typo queries`
  };
}

// --- autodetect fixtures: one sample per expected kind ---
const AUTODETECT_SAMPLES = [
  { kind: 'json', input: '{"id":42,"name":"bench","tags":["a","b"]}' },
  { kind: 'ndjson', input: '{"seq":1,"value":"x"}\n{"seq":2,"value":"y"}\n{"seq":3,"value":"z"}' },
  { kind: 'sse', input: 'event: message\ndata: {"a":1}\n\nevent: ping\ndata: {"b":2}\n' },
  { kind: 'csv', input: 'id,name,score\n1,alpha,0.5\n2,beta,0.75\n3,gamma,0.25\n' },
  { kind: 'html', input: '<!doctype html>\n<html lang="en">\n<head><title>Bench</title></head>\n<body><h1>Hello</h1><p>Text</p></body>\n</html>\n' },
  { kind: 'xml', input: '<?xml version="1.0" encoding="UTF-8"?>\n<catalog>\n  <item id="1">alpha</item>\n  <item id="2">beta</item>\n</catalog>\n' },
  { kind: 'yaml', input: 'name: bench\nversion: 1\nenabled: true\n' },
  { kind: 'logfmt', input: 'level=info msg=started requestId=abc123 durationMs=12\nlevel=warn msg=slow requestId=def456 durationMs=900\n' },
  { kind: 'ini', input: '[server]\nhost=localhost\nport=8080\n\n[client]\ntimeout=30\n' },
  { kind: 'gzip', input: Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03, 0x4b, 0x4c, 0x4a, 0x06, 0x00, 0xf2, 0xec, 0x36]) },
  { kind: 'png', input: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]) },
  { kind: 'text', input: 'The quick brown fox jumps over the lazy dog.\nNothing structured lives on these two lines.\n' }
];

function benchAutodetect() {
  const perFormat = {};
  let correct = 0;
  for (const sample of AUTODETECT_SAMPLES) {
    const detected = detectContent(sample.input);
    const ok = detected.kind === sample.kind;
    if (ok) correct += 1;
    if (!(sample.kind in perFormat)) perFormat[sample.kind] = true;
    if (!ok) perFormat[sample.kind] = false;
  }
  const total = AUTODETECT_SAMPLES.length;
  return { accuracy: round4(correct / total), perFormat };
}

// --- dedup fixtures: 5 near-duplicate groups of 3 plus 15 unique items ---
const DEDUP_GROUP_BASES = [
  ['invoice', 'customer', 'region', 'total', 'currency', 'status', 'issued', 'date', 'amount', 'tax'],
  ['shipment', 'carrier', 'weight', 'volume', 'origin', 'destination', 'tracking', 'label', 'status', 'eta'],
  ['employee', 'salary', 'department', 'manager', 'review', 'rating', 'promotion', 'bonus', 'tenure', 'grade'],
  ['sensor', 'reading', 'threshold', 'battery', 'firmware', 'interval', 'calibration', 'drift', 'alert', 'duty'],
  ['ticket', 'priority', 'assignee', 'queue', 'sla', 'escalation', 'resolution', 'category', 'response', 'hours']
];

function benchDedup() {
  const items = [];
  const truthGroups = [];
  DEDUP_GROUP_BASES.forEach((base, index) => {
    const ids = [`g${index}-a`, `g${index}-b`, `g${index}-c`];
    truthGroups.push(ids);
    items.push({ id: ids[0], tokens: [...base] });
    items.push({ id: ids[1], tokens: [...base.slice(0, 9), `${base[9]}_v1`] });
    items.push({ id: ids[2], tokens: [...base.slice(0, 9), `${base[9]}_v2`] });
  });
  for (let i = 1; i <= 15; i += 1) {
    items.push({
      id: `u-${i}`,
      tokens: [`solo${i}`, `alpha${i}`, `beta${i}`, `gamma${i}`, `delta${i}`, `epsilon${i}`, `zeta${i}`, `eta${i}`, `theta${i}`, `iota${i}`]
    });
  }

  const clusters = lshClusters(items, { threshold: 0.6 });
  const key = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const truthPairs = new Set();
  for (const group of truthGroups) {
    for (let i = 0; i < group.length; i += 1) {
      for (let j = i + 1; j < group.length; j += 1) truthPairs.add(key(group[i], group[j]));
    }
  }
  const predictedPairs = new Set();
  for (const cluster of clusters) {
    for (let i = 0; i < cluster.length; i += 1) {
      for (let j = i + 1; j < cluster.length; j += 1) predictedPairs.add(key(cluster[i], cluster[j]));
    }
  }
  let truePositive = 0;
  for (const pair of predictedPairs) if (truthPairs.has(pair)) truePositive += 1;
  const falsePositive = predictedPairs.size - truePositive;
  const falseNegative = truthPairs.size - truePositive;
  return {
    precision: round4(predictedPairs.size ? truePositive / predictedPairs.size : 1),
    recall: round4(truthPairs.size ? truePositive / truthPairs.size : 1),
    items: items.length
  };
}

// --- secrets fixtures: 9 positives, 7 negatives ---
const SECRET_CASES = [
  { secret: true, text: ['AK', 'IAIOSFODNN7EXAMPLE'].join('') },
  { secret: true, text: ['gh', 'p_1234567890abcdefghijklmnopqrstuvwxyz'].join('') },
  {
    secret: true,
    text: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'
  },
  { secret: true, text: 'card 4111111111111111 charged' },
  {
    secret: true,
    text: ['-----BEGIN RSA PRIV', 'ATE KEY-----\nMIIEowIBAAKCAQEAx7Vv8Q9m0pQ2rS5tU7vW9xY1zA3bC5dE7fG9hI0jK2lM4nO6pQ8rS0tU2vW4xY\n-----END RSA PRIV', 'ATE KEY-----'].join('')
  },
  { secret: true, text: ['xo', 'xb-123456789012-abcdefghijklmnop'].join('') },
  { secret: true, text: 'Authorization: Bearer abc123def456ghi789' },
  { secret: true, text: 'contact support@example.com for access' },
  { secret: true, text: 'server at 192.168.10.24 responded' },
  { secret: false, text: 'card number 4111 1111 1111 1112 on file' },
  { secret: false, text: 'The weather today is sunny and warm.' },
  { secret: false, text: '550e8400-e29b-41d4-a716-446655440000' },
  { secret: false, text: 'short hash 9f86d081884c7d659a' },
  { secret: false, text: 'Please update the deployment window before Friday.' },
  { secret: false, text: 'version 1.2.3 released for everyone' },
  { secret: false, text: 'product SKU 12345 is back in stock' }
];

function benchSecrets() {
  let truePositive = 0;
  let falsePositive = 0;
  let falseNegative = 0;
  for (const testCase of SECRET_CASES) {
    const found = detectSecrets(testCase.text, { extended: false, pii: true }).length > 0;
    if (found && testCase.secret) truePositive += 1;
    else if (found && !testCase.secret) falsePositive += 1;
    else if (!found && testCase.secret) falseNegative += 1;
  }
  const predicted = truePositive + falsePositive;
  const actual = truePositive + falseNegative;
  return {
    precision: round4(predicted ? truePositive / predicted : 1),
    recall: round4(actual ? truePositive / actual : 1),
    cases: SECRET_CASES.length
  };
}

async function section(run) {
  try {
    return await run();
  } catch (e) {
    return { error: String(e?.message ?? e) };
  }
}

/** Run every benchmark section. Sections never throw; a failing section reports {error}. */
export async function runBench() {
  return {
    search: await section(benchSearch),
    autodetect: await section(benchAutodetect),
    dedup: await section(benchDedup),
    secrets: await section(benchSecrets)
  };
}
