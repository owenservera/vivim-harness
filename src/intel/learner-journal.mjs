// Durable, optimistic-concurrency journal for the existing ScopedLearner JSON state.
// Only the holder of the exclusive directory lock may compare+write a revision.
// Prior immutable revisions remain addressable; rollback is another revision.
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, rmSync, readdirSync, openSync, closeSync, fsyncSync } from 'node:fs';

export class LearnerWriteConflict extends Error {
  constructor(message, code = 'LEARNER_REVISION_CONFLICT') { super(message); this.name = 'LearnerWriteConflict'; this.code = code; }
}

const digest = (data) => createHash('sha256').update(JSON.stringify(data)).digest('hex');
const revisionOf = (state) => Number.isSafeInteger(state?.revision) && state.revision >= 0 ? state.revision : 0;
const snapshotFile = (dir, revision) => path.join(dir, 'history', `rev-${String(revision).padStart(9, '0')}.json`);

// Unique temporary files prevent racing writers from overwriting each other's .tmp.
function atomicJson(file, obj) {
  const tmp = `${file}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    writeFileSync(fd, JSON.stringify(obj, null, 2) + '\n');
    fsyncSync(fd);
  } finally { closeSync(fd); }
  try { renameSync(tmp, file); }
  catch (e) { try { rmSync(tmp, { force: true }); } catch {} throw e; }
}

export class LearnerJournal {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'learner.json');
    this.historyDir = path.join(dir, 'history');
    this.lockDir = path.join(dir, '.learner-write-lock');
  }
  read() {
    if (!existsSync(this.file)) return null;
    const data = JSON.parse(readFileSync(this.file, 'utf8'));
    if (data.integrity) {
      const { integrity, ...body } = data;
      if (digest(body) !== integrity) throw new Error('Learner state integrity mismatch: refusing to use corrupted data');
    }
    return data;
  }
  version() { return revisionOf(this.read()); }
  versions() {
    if (!existsSync(this.historyDir)) return [];
    return readdirSync(this.historyDir).filter((n) => /^rev-\d{9}\.json$/.test(n))
      .map((n) => Number(n.slice(4, 13))).sort((a, b) => a - b);
  }
  at(revision) {
    if (!Number.isSafeInteger(revision) || revision < 0) throw new RangeError('Invalid learner revision');
    const current = this.read();
    if (current && revisionOf(current) === revision) return current;
    const file = snapshotFile(this.dir, revision);
    if (!existsSync(file)) throw new Error(`Learner revision ${revision} not found`);
    const snap = JSON.parse(readFileSync(file, 'utf8'));
    if (revisionOf(snap) !== revision) throw new Error('Learner snapshot revision mismatch');
    if (snap.integrity) { const { integrity, ...body } = snap; if (digest(body) !== integrity) throw new Error('Learner snapshot integrity mismatch'); }
    return snap;
  }
  diff(fromRevision, toRevision = this.version()) {
    return diffLearnerStates(this.at(fromRevision), this.at(toRevision));
  }
  lineage({ limit = 50 } = {}) {
    const revisions = this.versions().slice().reverse().slice(0, Number.isInteger(limit) && limit > 0 ? limit : 50);
    return revisions.map((revision) => {
      const state = this.at(revision);
      return { revision, parentRevision: state.parentRevision ?? null, savedAt: state.savedAt ?? null,
        integrityRecorded: !!state.integrity, models: Object.keys(state.models ?? {}).length,
        acceptedCorrections: (state.corrections ?? []).filter((c) => !c.reverted && c.status !== 'rejected').length,
        pendingProposals: (state.proposals ?? []).filter((p) => p.status === 'proposed').length };
    });
  }
  commit(state, expectedRevision) {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new RangeError('Invalid expected revision');
    mkdirSync(this.dir, { recursive: true });
    try { mkdirSync(this.lockDir); }
    catch (e) {
      if (e.code === 'EEXIST') throw new LearnerWriteConflict('Another writer holds the learner lock; retry after it releases', 'LEARNER_LOCKED');
      throw e;
    }
    try {
      const previous = this.read();
      const actual = revisionOf(previous);
      if (actual !== expectedRevision) throw new LearnerWriteConflict(`Stale learner state: expected revision ${expectedRevision}, found ${actual}`);
      const revision = actual + 1;
      const body = { ...state, version: 2, revision, parentRevision: actual, savedAt: new Date().toISOString() };
      delete body.integrity;
      const next = { ...body, integrity: digest(body) };
      mkdirSync(this.historyDir, { recursive: true });
      // Preserve the legacy v1 state before the first v2 commit.
      if (previous && !existsSync(snapshotFile(this.dir, actual))) atomicJson(snapshotFile(this.dir, actual), previous);
      const target = snapshotFile(this.dir, revision);
      if (existsSync(target)) throw new LearnerWriteConflict(`Revision ${revision} already reserved; recovery review required`, 'LEARNER_HISTORY_COLLISION');
      atomicJson(target, next);
      atomicJson(this.file, next);
      return next;
    } finally { rmSync(this.lockDir, { recursive: true, force: true }); }
  }
}

// Metadata-only model evolution: no features, names, values or evidence contents copied.
export function diffLearnerStates(before = {}, after = {}) {
  const oldIds = new Map((before.corrections ?? []).map((c) => [c.id, c]));
  const newIds = new Map((after.corrections ?? []).map((c) => [c.id, c]));
  const oldModels = new Set(Object.keys(before.models ?? {})), newModels = new Set(Object.keys(after.models ?? {}));
  const calibrationCount = (state) => Object.values(state.calibrator?.bins ?? {}).reduce((sum, bins) => sum + bins.reduce((n, bin) => n + bin.n, 0), 0);
  return { fromRevision: revisionOf(before), toRevision: revisionOf(after),
    correctionsAdded: [...newIds.keys()].filter((id) => !oldIds.has(id)),
    correctionsRemoved: [...oldIds.keys()].filter((id) => !newIds.has(id)),
    correctionsReverted: [...newIds].filter(([id, c]) => c.reverted && !oldIds.get(id)?.reverted).map(([id]) => id),
    modelCountDelta: newModels.size - oldModels.size,
    modelsAdded: [...newModels].filter((key) => !oldModels.has(key)).length,
    modelsRemoved: [...oldModels].filter((key) => !newModels.has(key)).length,
    calibrationObservationsDelta: calibrationCount(after) - calibrationCount(before) };
}
