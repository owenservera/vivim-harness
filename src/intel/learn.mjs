// Adaptive learning layer.
//
//   RoleModel       multinomial naive Bayes over structural field features (small, fast,
//                   incremental, interpretable; works with very few labels)
//   ScopedLearner   instance > page > site > family > global, with explicit promotion so a
//                   local correction never silently changes unrelated sites
//   Calibrator      histogram binning (Laplace smoothed) mapping raw confidence -> observed
//                   acceptance rate, per suggestion kind; reports ECE
//   activeQuestions which single clarification would reduce the most uncertainty
//
// All state is plain JSON so learned behaviour is versionable, inspectable and reversible.
import path from 'node:path';
import { ROLES, PRIOR_FIELDS, PRIOR_ROLES } from './priors.mjs';
import { tokens } from './schema.mjs';
import { LearnerJournal } from './learner-journal.mjs';
import { wilsonInterval } from './statistics.mjs';

export { ROLES };

const bucket = (x, edges, labels) => { for (let i = 0; i < edges.length; i++) if (x <= edges[i]) return labels[i]; return labels[labels.length - 1]; };

// Features of one field from its induced schema description (or a compact prior tuple).
export function fieldFeatures(name, d = {}, ctx = {}) {
  const f = [];
  const toks = tokens(name);
  for (const t of toks) f.push(`tok:${t}`);
  if (toks.length) f.push(`last:${toks[toks.length - 1]}`);
  if (toks.length > 1) f.push('compound');
  const kind = d.type === 'integer' ? 'integer' : d.type;
  f.push(`kind:${kind ?? 'unknown'}`);
  if (d.string) {
    for (const fm of Object.keys(d.string.formats ?? {})) f.push(`fmt:${fm}`);
    f.push(`len:${bucket(d.string.avgLen ?? 0, [3, 12, 40, 120], ['tiny', 'short', 'medium', 'long', 'verylong'])}`);
    f.push(`uniq:${bucket(d.string.uniqueness ?? 0, [0.15, 0.6, 0.95], ['low', 'mid', 'high', 'unique'])}`);
    if (d.string.enum) f.push('enum');
  }
  if (d.number) {
    if (d.number.format) f.push(`fmt:${d.number.format}`);
    f.push(`uniq:${bucket(d.number.uniqueness ?? 0, [0.15, 0.6, 0.95], ['low', 'mid', 'high', 'unique'])}`);
    f.push(`vol:${bucket(d.number.changeRate ?? 0, [0.1, 0.5], ['static', 'some', 'volatile'])}`);
    if (Number.isInteger(d.number.min) && Number.isInteger(d.number.max)) f.push('ints');
    if (d.number.min >= 0 && d.number.max <= 1) f.push('range:unit');
  }
  if (d.boolean) f.push('kind:boolean');
  if (d.presence !== undefined) f.push(`pres:${bucket(d.presence, [0.5, 0.99], ['sparse', 'mostly', 'always'])}`);
  if (ctx.depth !== undefined) f.push(`depth:${Math.min(ctx.depth, 3)}`);
  if (ctx.inArray) f.push('in_array');
  if (ctx.isKeyCandidate) f.push('keycand');
  return [...new Set(f)];
}

// Turn a prior tuple into a pseudo schema description so priors and live data share features.
export function priorDescription([name, kind, format, avgLen, uniq, extra = {}]) {
  const d = { type: kind };
  if (kind === 'string') d.string = { formats: format ? { [format]: 1 } : {}, avgLen: avgLen ?? 10, uniqueness: uniq ?? 0.5, ...(extra.enum ? { enum: [{}] } : {}) };
  if (kind === 'integer' || kind === 'number') d.number = { format: format ?? undefined, uniqueness: uniq ?? 0.5, changeRate: extra.volatile ? 0.8 : 0.05, min: 0, max: kind === 'integer' ? 100 : 99.5 };
  if (kind === 'boolean') d.boolean = { trueShare: 0.5 };
  return d;
}

export class RoleModel {
  constructor(state) {
    this.alpha = 0.5;
    this.classCounts = state?.classCounts ?? Object.fromEntries(ROLES.map((r) => [r, 0]));
    this.featCounts = state?.featCounts ?? Object.fromEntries(ROLES.map((r) => [r, {}]));
    this.featTotals = state?.featTotals ?? Object.fromEntries(ROLES.map((r) => [r, 0]));
    this.vocab = new Set(state?.vocab ?? []);
    this.examples = state?.examples ?? 0;
  }
  train(features, role, weight = 1) {
    if (!ROLES.includes(role)) throw new Error(`unknown role ${role}`);
    if (!Number.isFinite(weight) || weight <= 0) throw new RangeError('Training weight must be positive and finite');
    this.classCounts[role] += weight;
    for (const f of new Set(features)) { if (typeof f !== 'string' || !f) continue; this.featCounts[role][f] = (this.featCounts[role][f] ?? 0) + weight; this.featTotals[role] += weight; this.vocab.add(f); }
    this.examples += weight;
  }
  trainBatch(examples) { for (const e of examples) this.train(e.features, e.role, e.weight ?? 1); return this; }
  decay(factor = 0.99) {
    if (!Number.isFinite(factor) || factor <= 0 || factor > 1) throw new RangeError('Decay factor must be in (0, 1]');
    for (const role of ROLES) {
      this.classCounts[role] *= factor; this.featTotals[role] *= factor;
      const counts = this.featCounts[role];
      if (!counts || typeof counts !== 'object') continue;
      for (const feature of Object.keys(counts)) {
        const scaled = counts[feature] * factor;
        if (scaled < 1e-6) delete counts[feature]; else counts[feature] = scaled;
      }
    }
    this.examples *= factor; return this;
  }
  // Log-likelihood contributions (unnormalised) so several scoped models can be combined.
  logScores(features) {
    const V = Math.max(1, this.vocab.size), total = Object.values(this.classCounts).reduce((a, b) => a + b, 0);
    const out = {};
    for (const r of ROLES) {
      let s = Math.log((this.classCounts[r] + this.alpha) / (total + this.alpha * ROLES.length));
      // Unseen features provide no learned evidence; don't bias toward small classes.
      for (const f of new Set(features)) if (this.vocab.has(f)) s += Math.log(((this.featCounts[r][f] ?? 0) + this.alpha) / (this.featTotals[r] + this.alpha * V));
      out[r] = s;
    }
    return out;
  }
  predict(features) { return softmax(this.logScores(features)); }
  explain(features, { limit = 12 } = {}) {
    const dist = this.predict(features), ranked = Object.entries(dist).sort((a, b) => b[1] - a[1]);
    const [winner, runnerUp] = ranked.map(([role]) => role), V = Math.max(1, this.vocab.size);
    const contributions = [...new Set(features)].filter((f) => this.vocab.has(f)).map((feature) => ({ feature,
      logOdds: Math.log(((this.featCounts[winner][feature] ?? 0) + this.alpha) / (this.featTotals[winner] + this.alpha * V))
        - Math.log(((this.featCounts[runnerUp][feature] ?? 0) + this.alpha) / (this.featTotals[runnerUp] + this.alpha * V)) }))
      .sort((a, b) => Math.abs(b.logOdds) - Math.abs(a.logOdds) || a.feature.localeCompare(b.feature));
    return { role: winner, runnerUp, dist, margin: ranked[0][1] - ranked[1][1], examples: this.examples,
      knownFeatures: contributions.length, unknownFeatures: [...new Set(features)].filter((f) => !this.vocab.has(f)), contributions: contributions.slice(0, limit) };
  }
  toJSON() { return { classCounts: this.classCounts, featCounts: this.featCounts, featTotals: this.featTotals, vocab: [...this.vocab], examples: this.examples }; }
}

export function softmax(scores) {
  const entries = Object.entries(scores); if (!entries.length) return {};
  const infinite = entries.filter(([, v]) => v === Infinity);
  if (infinite.length) return Object.fromEntries(entries.map(([k, v]) => [k, v === Infinity ? 1 / infinite.length : 0]));
  if (entries.every(([, v]) => !Number.isFinite(v))) return Object.fromEntries(entries.map(([k]) => [k, 1 / entries.length]));
  const m = Math.max(...entries.map(([, v]) => Number.isFinite(v) ? v : -Infinity));
  const e = Object.fromEntries(entries.map(([k, v]) => [k, Number.isFinite(v) ? Math.exp(v - m) : 0]));
  const z = Object.values(e).reduce((a, b) => a + b, 0);
  return Object.fromEntries(Object.entries(e).map(([k, v]) => [k, v / z]));
}

export const entropy = (dist) => -Object.values(dist).reduce((a, p) => a + (p > 0 ? p * Math.log2(p) : 0), 0);
export const argmax = (dist) => Object.entries(dist).sort((a, b) => b[1] - a[1])[0];

export function priorModel() {
  const m = new RoleModel();
  PRIOR_FIELDS.forEach((t, i) => m.train(fieldFeatures(t[0], priorDescription(t)), PRIOR_ROLES[i], 1));
  return m;
}

// Deterministic level-1 rules (no learning). Used as a baseline and for explanation.
export function heuristicRole(name, d = {}) {
  const t = tokens(name), last = t[t.length - 1] ?? '';
  const fm = d.string?.formats ?? {};
  if (d.boolean || d.type === 'boolean') return 'flag';
  if (d.number?.format || fm.iso_time || /^(created|updated|modified|timestamp|time|date|ts|at)$/.test(last)) return 'timestamp';
  if (fm.url || /^(url|href|link|src|uri)$/.test(last)) return 'url';
  if (last === 'id' && t.length > 1) return 'reference';
  if (/^(id|uuid|guid|key|slug)$/.test(last) || ((fm.uuid || fm.hex_id || fm.token_id) && (d.string?.uniqueness ?? 0) > 0.9)) return 'id';
  if (fm.uuid || fm.token_id) return 'reference';
  if (d.string?.enum) return 'category';
  if ((d.string?.avgLen ?? 0) > 60 || fm.markdown) return 'text';
  if (d.string) return 'title';
  if (d.number) return (d.number.changeRate ?? 0) > 0.3 || !Number.isInteger(d.number.max) ? 'measure' : 'count';
  return 'metadata';
}

// --------------------------------------------------------------------------------------------
// Scopes and persistence
// --------------------------------------------------------------------------------------------
export const SCOPES = ['instance', 'page', 'site', 'account', 'family', 'global'];
const SCOPE_WEIGHT = { global: 1, family: 2, site: 3, account: 4, page: 5 };
const scopedKey = (scope, ctx = {}) => {
  if (scope === 'family') return ctx.family ? 'family:' + ctx.family : null;
  if (scope === 'site') return ctx.site ? (ctx.origin ? 'site:' + JSON.stringify([ctx.site, ctx.origin]) : 'site:' + ctx.site) : null;
  if (scope === 'account') return ctx.site && ctx.origin && ctx.account ? 'account:' + JSON.stringify([ctx.site, ctx.origin, ctx.account]) : null;
  if (scope === 'page') return ctx.site && ctx.page ? (ctx.origin || ctx.account
    ? 'page:' + JSON.stringify([ctx.site, ctx.origin ?? '', ctx.account ?? '', ctx.page])
    : 'page:' + ctx.site + '|' + ctx.page) : null;
  return null;
};
const instanceKey = (ctx, name) => JSON.stringify([ctx.site ?? '', ctx.origin ?? '', ctx.account ?? '',
  ctx.page ?? '', ctx.instanceId ?? '', ctx.typeKey ?? '', name]);

export class ScopedLearner {
  constructor(dir = null) {
    this.dir = dir;
    this.journal = dir ? new LearnerJournal(dir) : null;
    this.revision = 0;
    this.global = priorModel();
    this.models = {};
    this.overrides = {};
    this.corrections = [];
    this.proposals = [];
    this.audit = [];
    this.nextCorrectionId = 0;
    this.calibrator = new Calibrator();
    if (dir) this._load();
  }

  _file() { return path.join(this.dir, 'learner.json'); }
  _load(snapshot = this.journal?.read()) {
    this.global = priorModel(); this.models = {}; this.overrides = {};
    this.corrections = []; this.proposals = []; this.audit = [];
    this.nextCorrectionId = 0; this.calibrator = new Calibrator();
    this.revision = snapshot?.revision ?? 0;
    if (!snapshot) return;
    for (const [k, v] of Object.entries(snapshot.models ?? {})) this.models[k] = new RoleModel(v);
    for (const c of snapshot.globalLearned ?? []) this.global.train(c.features, c.role, c.weight ?? 1);
    this.overrides = snapshot.overrides ?? {};
    this.corrections = snapshot.corrections ?? [];
    this.proposals = snapshot.proposals ?? [];
    this.audit = snapshot.audit ?? [];
    this.nextCorrectionId = Math.max(snapshot.nextCorrectionId ?? 0, this.corrections.length + this.proposals.length);
    this.calibrator = new Calibrator(snapshot.calibrator);
  }
  reload() { if (!this.journal) return this.revision; this._load(); return this.revision; }
  versions() { return this.journal?.versions() ?? []; }
  save() {
    if (!this.journal) return null;
    const state = {
      models: Object.fromEntries(Object.entries(this.models).map(([k, m]) => [k, m.toJSON()])),
      globalLearned: this.corrections.filter((c) => c.scope === 'global' && !c.reverted && c.status !== 'rejected')
        .map((c) => ({ features: c.features, role: c.role, weight: c.weight })),
      overrides: this.overrides, corrections: this.corrections, proposals: this.proposals,
      audit: this.audit, nextCorrectionId: this.nextCorrectionId, calibrator: this.calibrator.toJSON(),
    };
    const written = this.journal.commit(state, this.revision);
    this.revision = written.revision;
    return this.revision;
  }
  rollbackTo(revision, { actor = null, reason = null } = {}) {
    if (!this.journal) throw new Error('Rollback requires persistent learner state');
    const from = this.revision;
    const priorAudit = this.audit.slice();
    const snap = this.journal.at(revision);
    this._load(snap);
    this.revision = from; // rollback is a NEW revision, never a rewrite of history
    this.nextCorrectionId = Math.max(this.nextCorrectionId,
      ...priorAudit.map((a) => Number(a.sequence ?? 0)).filter(Number.isFinite), 0);
    this.audit = [...priorAudit, { action: 'rollback', fromRevision: from, toRevision: revision,
      actor, reason, at: new Date().toISOString(), sequence: ++this.nextCorrectionId }];
    return this.save();
  }
  _chain(ctx) {
    return ['family', 'site', 'account', 'page']
      .map((scope) => [scope, scopedKey(scope, ctx)]).filter(([, key]) => !!key);
  }
  predict(name, d, ctx = {}) {
    const key = instanceKey(ctx, name);
    const legacyKey = !ctx.origin && !ctx.account && !ctx.page && !ctx.instanceId
      ? `${ctx.site ?? ''}|${ctx.typeKey ?? ''}|${name}` : null;
    const override = this.overrides[key] ?? (legacyKey ? this.overrides[legacyKey] : null);
    if (override) return { dist: { [override]: 1 }, role: override, confidence: 1, calibrated: 1, entropy: 0, margin: 1, source: 'instance-override' };
    const feats = fieldFeatures(name, d, ctx);
    const total = this.global.logScores(feats);
    let source = 'prior';
    for (const [scope, k] of this._chain(ctx)) {
      const m = this.models[k]; if (!m || !m.examples) continue;
      const ls = m.logScores(feats);
      const w = SCOPE_WEIGHT[scope] * Math.min(1, m.examples / 3);
      for (const r of ROLES) total[r] += w * (ls[r] - Math.log(1 / ROLES.length));
      source = scope;
    }
    const dist = softmax(total);
    const [role, p] = argmax(dist);
    const ranked = Object.values(dist).sort((a, b) => b - a);
    return { dist, role, confidence: p, margin: p - (ranked[1] ?? 0),
      calibrated: this.calibrator.calibrate('field_role', p), entropy: entropy(dist), source, features: feats };
  }
  _validate({ scope, name, role, ctx = {}, weight = 5 }) {
    if (!SCOPES.includes(scope)) throw new Error('Invalid correction scope');
    if (!ROLES.includes(role)) throw new Error('Invalid correction role');
    if (typeof name !== 'string' || !name.trim()) throw new Error('Correction field name required');
    if (!Number.isFinite(weight) || weight <= 0 || weight > 100) throw new Error('Invalid correction weight');
    if (scope !== 'global' && scope !== 'instance' && !scopedKey(scope, ctx)) throw new Error('Missing scope context: ' + scope);
    if (scope === 'page' && (!ctx.site || !ctx.origin || !ctx.account || !ctx.page))
      throw new Error('Page correction requires site, origin, account and page');
    if (scope === 'instance' && (!ctx.site || !ctx.origin || !ctx.account || !ctx.instanceId))
      throw new Error('Instance correction requires site, origin, account and instanceId');
  }
  _context(ctx = {}) { return { site: ctx.site, origin: ctx.origin, account: ctx.account,
    family: ctx.family, page: ctx.page, instanceId: ctx.instanceId, typeKey: ctx.typeKey }; }
  _id() { this.nextCorrectionId++; return 'c' + this.nextCorrectionId; }
  _audit(action, item, actor, evidence, note) {
    this.audit.push({ action, correctionId: item.id, actor: actor ?? null,
      evidence: evidence ?? null, note: note ?? null, at: new Date().toISOString(),
      modelRevision: this.revision, sequence: ++this.nextCorrectionId });
  }
  proposeCorrection({ scope, name, d = {}, ctx = {}, role, weight = 5, note, actor, evidence } = {}) {
    this._validate({ scope, name, role, ctx, weight });
    const proposal = { id: this._id(), status: 'proposed', scope, name, role, weight,
      features: fieldFeatures(name, d, ctx), ctx: this._context(ctx),
      at: new Date().toISOString(), note: note ?? null, actor: actor ?? null,
      evidence: evidence ?? null };
    this.proposals.push(proposal);
    this._audit('propose', proposal, actor, evidence, note);
    return proposal;
  }
  reviewCorrection(id, { action, actor, evidence, note } = {}) {
    if (!['accept', 'reject'].includes(action)) throw new Error('Review action must be accept or reject');
    const p = this.proposals.find((x) => x.id === id);
    if (!p || p.status !== 'proposed') throw new Error('No pending correction proposal for ' + id);
    p.status = action === 'accept' ? 'accepted' : 'rejected';
    p.reviewedAt = new Date().toISOString(); p.reviewedBy = actor ?? null;
    this._audit(action, p, actor, evidence, note);
    if (action === 'accept') this._apply({ ...p, status: 'accepted' });
    return p;
  }
  _apply(entry) {
    if (entry.scope === 'instance') this.overrides[instanceKey(entry.ctx, entry.name)] = entry.role;
    else if (entry.scope === 'global') this.global.train(entry.features, entry.role, entry.weight);
    else (this.models[scopedKey(entry.scope, entry.ctx)] ??= new RoleModel()).train(entry.features, entry.role, entry.weight);
    if (!this.corrections.some((c) => c.id === entry.id)) this.corrections.push(entry);
  }
  // Backward-compatible direct accepted correction; use propose/review for explicit human approval.
  learn({ scope, name, d = {}, ctx = {}, role, weight = 5, note, actor, evidence }) {
    this._validate({ scope, name, role, ctx, weight });
    const entry = { id: this._id(), at: new Date().toISOString(), scope, name, role,
      ctx: this._context(ctx), features: fieldFeatures(name, d, ctx), weight,
      status: 'accepted', actor: actor ?? null, evidence: evidence ?? null, note: note ?? null };
    this._apply(entry);
    this._audit('accept', entry, actor, evidence, note);
    return entry;
  }
  // Retrain from accepted non-reverted evidence; rejecting a proposal never trains.
  revert(id, { actor, note } = {}) {
    const c = this.corrections.find((x) => x.id === id);
    if (!c || c.reverted) return false;
    c.reverted = true; c.revertedAt = new Date().toISOString(); c.revertedBy = actor ?? null;
    this.global = priorModel(); this.models = {}; this.overrides = {};
    for (const x of this.corrections) if (!x.reverted && x.status !== 'rejected') this._replay(x);
    this._audit('revert', c, actor, c.evidence, note);
    return true;
  }
  _replay(x) {
    if (x.scope === 'instance') this.overrides[instanceKey(x.ctx, x.name)] = x.role;
    else if (x.scope === 'global') this.global.train(x.features, x.role, x.weight);
    else (this.models[scopedKey(x.scope, x.ctx)] ??= new RoleModel()).train(x.features, x.role, x.weight);
  }
  promotionCandidates(minSites = 2) {
    const by = new Map();
    for (const c of this.corrections) {
      if (c.reverted || c.status === 'rejected' || !['site', 'page', 'account', 'instance'].includes(c.scope)) continue;
      const sig = `${c.role}|${c.features.filter((f) => f.startsWith('last:') || f.startsWith('kind:') || f.startsWith('fmt:')).sort().join(',')}`;
      const e = by.get(sig) ?? { role: c.role, signature: sig, sites: new Set(), families: new Set(), examples: [] };
      e.sites.add(c.ctx.site); if (c.ctx.family) e.families.add(c.ctx.family); e.examples.push(c.id);
      by.set(sig, e);
    }
    return [...by.values()].filter((e) => e.sites.size >= minSites)
      .map((e) => ({ role: e.role, signature: e.signature, sites: [...e.sites],
        suggestedScope: e.families.size === 1 ? 'family:' + [...e.families][0] : 'global',
        corrections: e.examples }));
  }
}

// --------------------------------------------------------------------------------------------
// Confidence calibration (histogram binning), per suggestion kind.
// --------------------------------------------------------------------------------------------
export class Calibrator {
  constructor(state) { this.bins = state?.bins ?? {}; this.nBins = 10; }
  _b(p) { return Math.max(0, Math.min(this.nBins - 1, Math.floor(p * this.nBins))); }
  observe(kind, p, accepted) {
    if (!Number.isFinite(p) || p < 0 || p > 1) throw new RangeError('Confidence must be in [0, 1]');
    const k = (this.bins[kind] ??= Array.from({ length: this.nBins }, () => ({ n: 0, pos: 0, psum: 0 })));
    const b = k[this._b(p)]; b.n++; b.psum += p; if (accepted) b.pos++;
  }
  calibrate(kind, p) {
    if (!Number.isFinite(p)) return null;
    p = Math.max(0, Math.min(1, p));
    const k = this.bins[kind]; if (!k) return p;
    const b = k[this._b(p)]; if (b.n < 3) return p;
    return +this.reliability(kind)[this._b(p)].calibrated.toFixed(3);
  }
  reliability(kind) {
    const bins = this.bins[kind] ?? Array.from({ length: this.nBins }, () => ({ n: 0, pos: 0, psum: 0 }));
    // Pool-adjacent-violators: more confident bins cannot acquire lower calibrated rates.
    // Five pseudo-observations at the bin midpoint regularise thin/empty bins.
    const blocks = [];
    bins.forEach((bin, i) => {
      blocks.push({ from: i, to: i, sum: bin.pos + 5 * (i + 0.5) / this.nBins, weight: bin.n + 5 });
      while (blocks.length > 1) {
        const a = blocks[blocks.length - 2], b = blocks.at(-1);
        if (a.sum / a.weight <= b.sum / b.weight) break;
        blocks.splice(-2, 2, { from: a.from, to: b.to, sum: a.sum + b.sum, weight: a.weight + b.weight });
      }
    });
    return bins.map((bin, i) => {
      const block = blocks.find((v) => i >= v.from && i <= v.to);
      return { from: i / this.nBins, to: (i + 1) / this.nBins, observations: bin.n,
        acceptanceRate: bin.n ? bin.pos / bin.n : null, rawMean: bin.n ? bin.psum / bin.n : null,
        calibrated: block.sum / block.weight, interval: wilsonInterval(bin.pos, bin.n) };
    });
  }
  ece(kind) {
    const k = this.bins[kind]; if (!k) return null;
    const N = k.reduce((a, b) => a + b.n, 0); if (!N) return null;
    return +k.reduce((a, b) => a + (b.n ? (b.n / N) * Math.abs(b.pos / b.n - b.psum / b.n) : 0), 0).toFixed(4);
  }
  toJSON() { return { bins: this.bins }; }
}

// Static ECE for a list of (confidence, correct) pairs.
export function expectedCalibrationError(pairs, nBins = 10) {
  if (!Number.isInteger(nBins) || nBins < 1) throw new RangeError('nBins must be a positive integer');
  const bins = Array.from({ length: nBins }, () => ({ n: 0, c: 0, p: 0 }));
  let count = 0;
  for (const [p, ok] of pairs) { if (!Number.isFinite(p) || p < 0 || p > 1) continue; const b = bins[Math.min(nBins - 1, Math.floor(p * nBins))]; b.n++; b.p += p; if (ok) b.c++; count++; }
  const N = count || 1;
  return +bins.reduce((a, b) => a + (b.n ? (b.n / N) * Math.abs(b.c / b.n - b.p / b.n) : 0), 0).toFixed(4);
}

// --------------------------------------------------------------------------------------------
// Active learning: the questions whose answers reduce the most expected uncertainty.
// items: [{ id, kind, entropy|dist, impact (instances affected), prompt, choices }]
// --------------------------------------------------------------------------------------------
export function activeQuestions(items, n = 5, { maxPerGroup = Infinity } = {}) {
  const ranked = items
    .map((it) => { const h = it.entropy ?? (it.dist ? entropy(it.dist) : 0); return { ...it, entropy: +h.toFixed(3), value: +(h * Math.log2(1 + (it.impact ?? 1))).toFixed(3) }; })
    .filter((x) => x.value > 0)
    .sort((a, b) => b.value - a.value || String(a.id).localeCompare(String(b.id)));
  const groups = new Map(), seen = new Set(), chosen = [];
  if (!(n > 0)) return chosen;
  for (const item of ranked) {
    const id = item.id ?? item.prompt;
    if (id !== undefined && seen.has(id)) continue;
    const group = item.group ?? item.typeKey ?? item.kind ?? 'other';
    if ((groups.get(group) ?? 0) >= maxPerGroup) continue;
    groups.set(group, (groups.get(group) ?? 0) + 1); if (id !== undefined) seen.add(id);
    chosen.push(item); if (chosen.length >= n) break;
  }
  return chosen;
}
