#!/usr/bin/env node
// Intelligence evaluation harness. Usage: node eval/run.mjs [--split dev|heldout|all] [--json]
// Reports measured numbers only; writes eval/results/latest.json (+ .md).
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIXTURES } from './fixtures.mjs';
import { FIXTURES_V2 } from './fixtures-v2.mjs';
import { discoverModel } from '../src/intel/discover.mjs';
import { resolveType } from '../src/intel/identity.mjs';
import { correlateRendered } from '../src/intel/correlate.mjs';
import { ScopedLearner, heuristicRole, expectedCalibrationError } from '../src/intel/learn.mjs';
import { induce, schemaDiff, alignFields } from '../src/intel/schema.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const split = args.includes('--split') ? args[args.indexOf('--split') + 1] : 'all';

const jac = (a, b) => { const A = new Set(a), B = new Set(b); let i = 0; for (const x of A) if (B.has(x)) i++; return i / (A.size + B.size - i || 1); };
const typeEq = (gt, got) => gt === got || (gt === 'number' && got === 'integer') || (gt === 'integer' && got === 'number');

// Match discovered types to GT types by top-level field-name overlap (one-to-one, greedy).
function matchTypes(gtTypes, types, extras = []) {
  const cands = [];
  gtTypes.forEach((g, gi) => types.forEach((t, ti) => { const s = jac(Object.keys(g.fields), t.fields.map((f) => f.name)); if (s >= 0.5) cands.push({ gi, ti, s }); }));
  cands.sort((a, b) => b.s - a.s);
  const gU = new Set(), tU = new Set(), pairs = [];
  for (const c of cands) { if (gU.has(c.gi) || tU.has(c.ti)) continue; gU.add(c.gi); tU.add(c.ti); pairs.push(c); }
  const neutral = types.map((t, ti) => ti).filter((ti) => !tU.has(ti) && extras.some((ex) => jac(ex, types[ti].fields.map((f) => f.name)) >= 0.5));
  return { pairs, unmatchedGt: gtTypes.map((_, i) => i).filter((i) => !gU.has(i)), falsePos: types.map((_, i) => i).filter((i) => !tU.has(i) && !neutral.includes(i)), neutral };
}

function scoreModel(gt, model, acc) {
  const { pairs, unmatchedGt, falsePos } = matchTypes(gt.types, model.types, gt.extras ?? []);
  acc.typeTP += pairs.length; acc.typeFN += unmatchedGt.length; acc.typeFP += falsePos.length;
  const nameOf = new Map();
  for (const p of pairs) {
    const g = gt.types[p.gi], t = model.types[p.ti];
    nameOf.set(t.id, g.name);
    acc.keyTotal++;
    const gotKey = t.key && !t.key.weak ? t.key.field : null;
    if (gotKey === g.key) acc.keyOk++; else acc.keyMiss.push(`${g.name}: expected ${g.key}, got ${gotKey}`);
    for (const [fname, fg] of Object.entries(g.fields)) {
      const f = t.fields.find((x) => x.name === fname);
      if (!f) { acc.fieldMissing++; continue; }
      acc.fieldTotal++; if (typeEq(fg.type, f.type)) acc.fieldTypeOk++;
      if (fg.role) {
        acc.roleTotal++;
        const ok = f.role === fg.role; if (ok) acc.roleOk++; else acc.roleMiss.push(`${g.name}.${fname}: ${fg.role} vs ${f.role}`);
        if (heuristicRole(fname, f.schema) === fg.role) acc.heuristicRoleOk++;
        acc.calib.push([f.roleConfidence, ok]);
      }
    }
    if (g.tag) { acc.tagTotal++; if (t.tagged?.field === g.tag) acc.tagOk++; }
  }
  const gtRels = (gt.relationships ?? []).map((r) => `${r.from}.${r.field}->${r.to}`);
  const gotRels = model.relationships.filter((r) => r.kind === 'references').map((r) => `${nameOf.get(r.from) ?? '?'}.${r.field}->${nameOf.get(r.to) ?? '?'}`);
  for (const r of gotRels) { if (gtRels.includes(r)) acc.relTP++; else acc.relFP++; }
  for (const r of gtRels) if (!gotRels.includes(r)) { acc.relFN++; acc.relMiss.push(r); }
  return { pairs, nameOf };
}

function pairF1(truth, clusters) {
  // truth: label per instance index; clusters: arrays of instance indices.
  const pred = new Map(); clusters.forEach((c, ci) => c.forEach((i) => pred.set(i, ci)));
  let tp = 0, fp = 0, fn = 0;
  for (let i = 0; i < truth.length; i++) for (let j = i + 1; j < truth.length; j++) {
    const same = truth[i] === truth[j], linked = pred.get(i) === pred.get(j);
    if (same && linked) tp++; else if (!same && linked) fp++; else if (same && !linked) fn++;
  }
  const p = tp / (tp + fp || 1), r = tp / (tp + fn || 1);
  return { precision: +p.toFixed(3), recall: +r.toFixed(3), f1: +(2 * p * r / (p + r || 1)).toFixed(3) };
}

const fresh = () => ({ typeTP: 0, typeFP: 0, typeFN: 0, keyOk: 0, keyTotal: 0, keyMiss: [], fieldTypeOk: 0, fieldTotal: 0, fieldMissing: 0, roleOk: 0, heuristicRoleOk: 0, roleTotal: 0, roleMiss: [], tagOk: 0, tagTotal: 0, relTP: 0, relFP: 0, relFN: 0, relMiss: [], calib: [] });
const pr = (tp, fp, fn) => ({ precision: +(tp / (tp + fp || 1)).toFixed(3), recall: +(tp / (tp + fn || 1)).toFixed(3) });

function summarize(acc) {
  return {
    typeDiscovery: pr(acc.typeTP, acc.typeFP, acc.typeFN),
    keyAccuracy: +(acc.keyOk / (acc.keyTotal || 1)).toFixed(3),
    fieldTypeAccuracy: +(acc.fieldTypeOk / (acc.fieldTotal || 1)).toFixed(3),
    fieldsMissing: acc.fieldMissing,
    roleAccuracy: +(acc.roleOk / (acc.roleTotal || 1)).toFixed(3),
    heuristicBaselineRoleAccuracy: +(acc.heuristicRoleOk / (acc.roleTotal || 1)).toFixed(3),
    taggedUnionAccuracy: acc.tagTotal ? +(acc.tagOk / acc.tagTotal).toFixed(3) : null,
    relationships: pr(acc.relTP, acc.relFP, acc.relFN),
    roleCalibrationECE: expectedCalibrationError(acc.calib),
    misses: { keys: acc.keyMiss, roles: acc.roleMiss.slice(0, 25), relationships: acc.relMiss },
  };
}

export async function runEval({ which = split, learner } = {}) {
  const results = { generatedAt: new Date().toISOString(), node: process.version, fixtures: {}, aggregate: {} };
  const accs = { dev: fresh(), heldout: fresh() };
  const perf = [];
  const L = learner ?? new ScopedLearner();
  const simple = ['chatPathOps', 'dashboardTicks', 'feedPages', 'workspaceMixed', 'nestedHetero', 'multiPageWorkflow', 'unknownFormat', 'keylessRerender'];
  for (const key of simple) {
    const fx = FIXTURES[key]();
    if (which !== 'all' && fx.split !== which) continue;
    const mem0 = process.memoryUsage().heapUsed, t0 = performance.now();
    const model = discoverModel(fx.samples, { learner: L, patchGroups: fx.patchGroups });
    const ms = performance.now() - t0;
    perf.push({ fixture: fx.name, samples: fx.samples.length, ms: +ms.toFixed(1), msPer1kSamples: +(ms / fx.samples.length * 1000).toFixed(1), heapDeltaMB: +((process.memoryUsage().heapUsed - mem0) / 1048576).toFixed(2) });
    const local = fresh();
    const { nameOf } = scoreModel(fx.gt, model, local); scoreModel(fx.gt, model, accs[fx.split]);
    const r = { split: fx.split, discovered: model.types.map((t) => ({ name: t.name, gtMatch: nameOf.get(t.id) ?? null, key: t.key?.weak ? null : t.key?.field ?? null, fields: t.fields.length, confidence: t.confidence })), metrics: summarize(local) };
    // Identity: entity counts vs truth; pairwise F1 for keyless.
    if (fx.gt.identity) {
      r.identity = {};
      for (const [gname, expected] of Object.entries(fx.gt.identity)) {
        const tid = [...nameOf].find(([, n]) => n === gname)?.[0];
        const t = model.types.find((x) => x.id === tid);
        const res = t ? resolveType(t) : null;
        r.identity[gname] = { expectedEntities: expected, resolved: res?.entities.length ?? null, method: res?.method ?? null };
      }
    }
    if (fx.truth) {
      const t = model.types[0];
      const res = t ? resolveType(t) : null;
      const idxOf = new Map(fx.samples.map((s, i) => [s.source.domId, i]));
      const clusters = res ? res.entities.map((e) => e.revisions.map((rv) => idxOf.get(rv.domId)).concat(e.duplicates ? [] : [])) : [];
      // Revisions drop exact duplicates; recover full membership through instances.
      const membership = res ? clusterMembership(t, res) : [];
      r.identityLinkage = { ...pairF1(fx.truth, membership.length ? membership : clusters), entities: res?.entities.length, expected: new Set(fx.truth).size, method: res?.method, basis: res?.basis };
    }
    if (fx.gt.rendered && fx.elements) {
      const subjects = fx.gt.rendered.map((x) => ({ kind: 'stream', id: x.subject, text: x.text }));
      const hyps = correlateRendered(subjects, fx.elements);
      let ok = 0, likelyOk = 0, likely = 0;
      for (const x of fx.gt.rendered) { const hy = hyps.find((h) => h.from.stream === x.subject); if (hy?.to?.element === x.element) ok++; if (hy?.status === 'likely') { likely++; if (hy.to.element === x.element) likelyOk++; } }
      r.correlation = { topAccuracy: +(ok / fx.gt.rendered.length).toFixed(3), likelyPrecision: likely ? +(likelyOk / likely).toFixed(3) : null, likelyShare: +(likely / fx.gt.rendered.length).toFixed(3) };
    }
    results.fixtures[fx.name] = r;
  }

  // Drift repair (held-out).
  if (which === 'all' || which === 'heldout') {
    const fx = FIXTURES.dynamicSchema();
    const d = schemaDiff(induce(fx.v1), induce(fx.v2));
    const got = Object.fromEntries(d.repairs.map((x) => [x.from, x.to]));
    const exp = fx.gt.repairs;
    results.fixtures[fx.name] = { split: fx.split, driftDetected: d.drifted, repairAccuracy: +(Object.entries(exp).filter(([a, b]) => got[a] === b).length / Object.keys(exp).length).toFixed(3), repairs: d.repairs };

    // Two sites, same entities: per-site discovery + cross-site alignment of the task type.
    const two = FIXTURES.twoSitesSameEntities();
    const ma = discoverModel(two.siteA, { learner: L }), mb = discoverModel(two.siteB, { learner: L });
    const accA = fresh(), accB = fresh();
    const sa = scoreModel(two.gt.a, ma, accA), sb = scoreModel(two.gt.b, mb, accB);
    scoreModel(two.gt.a, ma, accs.heldout); scoreModel(two.gt.b, mb, accs.heldout);
    const ta = ma.types.find((t) => sa.nameOf.get(t.id) === 'task'), tb = mb.types.find((t) => sb.nameOf.get(t.id) === 'task');
    let alignAcc = null, pairs = [];
    if (ta && tb) { pairs = alignFields(ta.schema, tb.schema).pairs; const got2 = Object.fromEntries(pairs.map((p) => [p.a, p.b])); alignAcc = +(Object.entries(two.gt.alignment).filter(([a, b]) => got2[a] === b).length / Object.keys(two.gt.alignment).length).toFixed(3); }
    results.fixtures[two.name] = { split: 'heldout', siteA: summarize(accA), siteB: summarize(accB), crossSiteAlignmentAccuracy: alignAcc, alignment: pairs.map((p) => `${p.a}↔${p.b} (${p.score})`) };
  }

  results.performance = perf;
  for (const [k, a] of Object.entries(accs)) if (a.typeTP + a.typeFN) results.aggregate[k] = summarize(a);
  return results;
}

// Model signature for order-independence checks: type names, keys and field sets.
export function modelSignature(model) {
  return model.types.map((t) => `${t.name}|${t.key && !t.key.weak ? t.key.field : '-'}|${t.fields.map((f) => f.name).sort().join(',')}`).sort().join('\n') + '\n' + model.relationships.map((r) => `${r.kind}:${r.field ?? ''}`).sort().join(',');
}

// Held-out v2: unseen adversarial fixtures, scored with the same metrics plus extra checks.
export async function runEvalV2({ learner } = {}) {
  const L = learner ?? new ScopedLearner();
  const out = { fixtures: {}, aggregate: null };
  const acc = fresh();
  const signatures = {};
  for (const make of Object.values(FIXTURES_V2)) {
    const fx = make();
    if (fx.v1) {
      const d = schemaDiff(induce(fx.v1), induce(fx.v2));
      const got = Object.fromEntries(d.repairs.map((x) => [x.from, x.to]));
      out.fixtures[fx.name] = { driftDetected: d.drifted, repairAccuracy: +(Object.entries(fx.gt.repairs).filter(([a, b]) => got[a] === b).length / Object.keys(fx.gt.repairs).length).toFixed(3), typeChangeDetected: fx.gt.typeChanged.every((f) => d.typeChanged.some((x) => x.field === f)), removedDetected: fx.gt.removed.filter((f) => d.removed.includes(f) || got[f]).length + '/' + fx.gt.removed.length, repairs: d.repairs };
      continue;
    }
    if (fx.siteA) {
      const ma = discoverModel(fx.siteA, { learner: L }), mb = discoverModel(fx.siteB, { learner: L });
      const sa = scoreModel(fx.gt.a, ma, acc), sb = scoreModel(fx.gt.b, mb, acc);
      const ta = ma.types.find((t) => sa.nameOf.get(t.id) === fx.gt.a.types[0].name), tb = mb.types.find((t) => sb.nameOf.get(t.id) === fx.gt.b.types[0].name);
      const pairs = ta && tb ? alignFields(ta.schema, tb.schema).pairs : [];
      const got = Object.fromEntries(pairs.map((p) => [p.a, p.b]));
      out.fixtures[fx.name] = { crossSiteAlignmentAccuracy: +(Object.entries(fx.gt.alignment).filter(([a, b]) => got[a] === b).length / Object.keys(fx.gt.alignment).length).toFixed(3), alignment: pairs.map((p) => `${p.a}↔${p.b} (${p.score})`), keysA: ta?.key?.field, keysB: tb?.key?.field };
      continue;
    }
    const t0 = performance.now();
    const model = discoverModel(fx.samples, { learner: L, patchGroups: fx.patchGroups });
    const ms = performance.now() - t0;
    signatures[fx.name] = modelSignature(model);
    const local = fresh();
    const { nameOf } = scoreModel(fx.gt, model, local);
    if (!fx.orderOf) scoreModel(fx.gt, model, acc);
    const r = { ms: +ms.toFixed(1), samples: fx.samples.length, discovered: model.types.map((t) => `${t.name}[${t.key && !t.key.weak ? t.key.field : '-'}]`), metrics: summarize(local) };
    if (fx.gt.identity) { r.identity = {}; for (const [g, exp] of Object.entries(fx.gt.identity)) { const t = model.types.find((x) => nameOf.get(x.id) === g); const res = t ? resolveType(t) : null; r.identity[g] = { expected: exp, resolved: res?.entities.length ?? null }; } }
    if (fx.truth) { const t = model.types[0]; const res = t ? resolveType(t) : null; r.identityLinkage = { ...pairF1(fx.truth, res ? clusterMembership(t, res) : []), entities: res?.entities.length, expected: new Set(fx.truth).size }; }
    if (fx.gt.mustSeeFields) for (const [g, fields] of Object.entries(fx.gt.mustSeeFields)) { const t = model.types.find((x) => nameOf.get(x.id) === g); r.rareFieldsSeen = fields.filter((f) => t?.fields.some((x) => x.name === f)).length + '/' + fields.length; }
    if (fx.orderOf) r.orderIndependent = signatures[fx.orderOf] === signatures[fx.name];
    out.fixtures[fx.name] = r;
  }
  out.aggregate = summarize(acc);
  return out;
}

function clusterMembership(type, res) {
  // Map each instance back to its entity via the identity field or linkage clusters.
  const out = [];
  if (res.method === 'key') { const by = new Map(); type.instances.forEach((inst, i) => { const k = String(inst.obj[type.key.field]); if (!by.has(k)) by.set(k, []); by.get(k).push(i); }); return [...by.values()]; }
  // Linkage: rebuild clusters from revision domIds plus exact duplicates.
  const idx = new Map(type.instances.map((inst, i) => [inst.prov.domId, i]));
  for (const e of res.entities) out.push(e.revisions.map((r) => idx.get(r.domId)).filter((x) => x !== undefined));
  const seen = new Set(out.flat());
  type.instances.forEach((inst, i) => { if (!seen.has(i)) { const j = out.findIndex((c) => c.some((m) => JSON.stringify(type.instances[m].obj) === JSON.stringify(inst.obj))); if (j >= 0) out[j].push(i); else out.push([i]); } });
  return out;
}

function toMarkdown(r) {
  const L = [`# Capture Studio intelligence evaluation`, '', `Generated ${r.generatedAt} on Node ${r.node}. Synthetic ground truth; held-out fixtures were not used for tuning.`, ''];
  for (const [split, m] of Object.entries(r.aggregate)) {
    L.push(`## Aggregate — ${split}`, '', '| Metric | Value |', '| --- | --- |');
    L.push(`| Record-type discovery precision / recall | ${m.typeDiscovery.precision} / ${m.typeDiscovery.recall} |`);
    L.push(`| Identity key accuracy | ${m.keyAccuracy} |`, `| Field type accuracy | ${m.fieldTypeAccuracy} |`, `| Field role accuracy (learned) | ${m.roleAccuracy} |`, `| Field role accuracy (deterministic baseline) | ${m.heuristicBaselineRoleAccuracy} |`);
    L.push(`| Tagged-union discriminator accuracy | ${m.taggedUnionAccuracy ?? 'n/a'} |`, `| Relationship precision / recall | ${m.relationships.precision} / ${m.relationships.recall} |`, `| Role confidence ECE | ${m.roleCalibrationECE} |`, '');
  }
  L.push('## Per fixture', '');
  for (const [name, f] of Object.entries(r.fixtures)) {
    L.push(`### ${name} (${f.split})`, '');
    if (f.metrics) L.push(`types P/R ${f.metrics.typeDiscovery.precision}/${f.metrics.typeDiscovery.recall}, keys ${f.metrics.keyAccuracy}, roles ${f.metrics.roleAccuracy}, relationships P/R ${f.metrics.relationships.precision}/${f.metrics.relationships.recall}`);
    if (f.identity) L.push(`identity: ${JSON.stringify(f.identity)}`);
    if (f.identityLinkage) L.push(`keyless linkage: P ${f.identityLinkage.precision} R ${f.identityLinkage.recall} F1 ${f.identityLinkage.f1} (${f.identityLinkage.entities}/${f.identityLinkage.expected} entities)`);
    if (f.correlation) L.push(`raw→rendered correlation: top-1 ${f.correlation.topAccuracy}, 'likely' precision ${f.correlation.likelyPrecision}`);
    if (f.repairAccuracy !== undefined) L.push(`drift detected ${f.driftDetected}, repair accuracy ${f.repairAccuracy}`);
    if (f.crossSiteAlignmentAccuracy !== undefined) L.push(`cross-site field alignment accuracy ${f.crossSiteAlignmentAccuracy}: ${f.alignment.join(', ')}`);
    if (f.metrics?.misses?.keys?.length) L.push(`key misses: ${f.metrics.misses.keys.join('; ')}`);
    if (f.metrics?.misses?.roles?.length) L.push(`role misses: ${f.metrics.misses.roles.join('; ')}`);
    if (f.metrics?.misses?.relationships?.length) L.push(`relationship misses: ${f.metrics.misses.relationships.join('; ')}`);
    L.push('');
  }
  if (r.heldout2) {
    const m = r.heldout2.aggregate;
    L.push('## Held-out v2 (unseen, adversarial)', '', `types P/R ${m.typeDiscovery.precision}/${m.typeDiscovery.recall}, keys ${m.keyAccuracy}, field types ${m.fieldTypeAccuracy}, roles ${m.roleAccuracy} (baseline ${m.heuristicBaselineRoleAccuracy}), relationships P/R ${m.relationships.precision}/${m.relationships.recall}, ECE ${m.roleCalibrationECE}`, '');
    for (const [n, f] of Object.entries(r.heldout2.fixtures)) L.push(`- **${n}**: ${JSON.stringify({ discovered: f.discovered, keys: f.metrics?.misses?.keys, rels: f.metrics?.misses?.relationships, identity: f.identity, linkageF1: f.identityLinkage?.f1, rare: f.rareFieldsSeen, orderIndependent: f.orderIndependent, align: f.crossSiteAlignmentAccuracy, repair: f.repairAccuracy, typeChange: f.typeChangeDetected })}`);
    L.push('');
  }
  L.push('## Performance', '', '| Fixture | Samples | ms | ms / 1k samples | Heap Δ MB |', '| --- | --- | --- | --- | --- |');
  for (const p of r.performance) L.push(`| ${p.fixture} | ${p.samples} | ${p.ms} | ${p.msPer1kSamples} | ${p.heapDeltaMB} |`);
  if (r.learning) { L.push('', '## Learning loop', '', '```json', JSON.stringify(r.learning, null, 2), '```'); }
  return L.join('\n');
}

if (process.argv[1] && process.argv[1].endsWith('run.mjs')) {
  const r = await runEval();
  r.heldout2 = await runEvalV2();
  try { const { runLearningEval } = await import('./learning.mjs'); r.learning = await runLearningEval(); } catch (e) { r.learning = { status: 'not available', error: String(e.message) }; }
  mkdirSync(path.join(here, 'results'), { recursive: true });
  writeFileSync(path.join(here, 'results', 'latest.json'), JSON.stringify(r, null, 2));
  writeFileSync(path.join(here, 'results', 'latest.md'), toMarkdown(r));
  if (args.includes('--json')) console.log(JSON.stringify(r, null, 2)); else console.log(toMarkdown(r));
}
