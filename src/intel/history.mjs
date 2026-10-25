// Temporal operations are explicit; absence never implies a removal.
import { assertInvariant } from '../core/invariants.mjs';

// Validate BEFORE applying any mutations: a single revision cannot both set
// and retract the same attribute. This rejects only that contradictory input;
// observations missing a field are normal and remain completely unrestricted.
export function validateRevision(revision = {}) {
  const values = revision.values ?? {};
  const removed = Array.isArray(revision.removed) ? revision.removed : [];
  const contradiction = removed.some((field) => typeof field === 'string'
    && Object.prototype.hasOwnProperty.call(values, field));
  assertInvariant(!contradiction, 'NSP-003', {
    boundary: 'temporal-revision', disposition: 'rejected', reason: 'write-and-remove',
    source: { session: revision.session ?? revision.evidence?.session,
      sid: revision.sid ?? revision.evidence?.sid,
      seq: revision.seq ?? revision.evidence?.seq },
  });
  return revision;
}

export function foldRevision(state, revision = {}) {
  validateRevision(revision);
  for (const [field, value] of Object.entries(revision.values ?? {})) {
    Object.defineProperty(state, field, { value, enumerable: true, writable: true, configurable: true });
  }
  for (const field of Array.isArray(revision.removed) ? revision.removed : []) {
    if (typeof field === 'string' && field) delete state[field];
  }
  return state;
}

export function summarizeRevisions(revisions = []) {
  const fields = new Map(), times = [], sessions = new Set();
  let untimed = 0, simultaneousConflicts = 0;
  const valuesAtTime = new Map();
  for (const revision of revisions) {
    if (revision.session) sessions.add(revision.session);
    if (Number.isFinite(revision.t)) times.push(revision.t); else untimed++;
    const changed = new Set(revision.changed ?? Object.keys(revision.values ?? {}));
    const removed = new Set(revision.removed ?? []);
    for (const field of new Set([...changed, ...removed])) {
      const row = fields.get(field) ?? { field, changes: 0, removals: 0, lastT: null, lastSource: null };
      row.changes++; if (removed.has(field)) row.removals++;
      if (Number.isFinite(revision.t)) {
        if (row.lastT === null || revision.t >= row.lastT) { row.lastT = revision.t; row.lastSource = { session: revision.session ?? null, sid: revision.sid ?? null, seq: revision.seq ?? null }; }
        const key = JSON.stringify([field, revision.t]);
        const signature = JSON.stringify([removed.has(field) ? 'removed' : 'value', revision.values?.[field]]);
        if (valuesAtTime.has(key) && valuesAtTime.get(key) !== signature) simultaneousConflicts++;
        valuesAtTime.set(key, signature);
      }
      fields.set(field, row);
    }
  }
  const firstT = times.length ? times.reduce((a, b) => Math.min(a, b)) : null;
  const lastT = times.length ? times.reduce((a, b) => Math.max(a, b)) : null;
  return { revisions: revisions.length, timed: times.length, untimed, sessions: sessions.size, firstT, lastT,
    spanMs: firstT === null ? null : lastT - firstT, simultaneousConflicts,
    fields: [...fields.values()].sort((a, b) => b.changes - a.changes || a.field.localeCompare(b.field)) };
}

// Incremental materialization with deterministic replay on late arrivals. The caller owns the
// evidence store; this accumulator is an in-memory view, not a second durable source of truth.
export class RevisionAccumulator {
  constructor() { this.revisions = []; this.state = {}; this.latestT = null; }
  append(revision) {
    const row = structuredClone(revision);
    validateRevision(row); // Cannot poison the journal with an invalid revision.
    this.revisions.push(row);
    if (Number.isFinite(row.t) && this.latestT !== null && row.t < this.latestT) {
      this.revisions.sort((a, b) => (a.t ?? Infinity) - (b.t ?? Infinity) || (a.seq ?? 0) - (b.seq ?? 0));
      this.state = this.revisions.reduce((state, rv) => foldRevision(state, rv), {});
    } else foldRevision(this.state, row);
    if (Number.isFinite(row.t)) this.latestT = Math.max(this.latestT ?? row.t, row.t);
    return structuredClone(this.state);
  }
  at(time) {
    if (!Number.isFinite(time)) throw new RangeError('Historical time must be finite');
    return this.revisions.filter((r) => Number.isFinite(r.t) && r.t <= time)
      .sort((a, b) => a.t - b.t || (a.seq ?? 0) - (b.seq ?? 0))
      .reduce((state, revision) => foldRevision(state, revision), {});
  }
  summary() { return summarizeRevisions(this.revisions); }
  get size() { return this.revisions.length; }
  static from(revisions = []) { const acc = new RevisionAccumulator(); for (const r of revisions ?? []) acc.append(r); return acc; }
}
