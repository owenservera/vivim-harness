// Session storage, modelled on Apify's storage triad:
//   raw/       append-only source of truth (RawLog) + derived seek index   ~ request/response archive
//   datasets/  append-only structured records (JSONL)                      ~ Apify Dataset
//   kv/        named JSON/blob values (INPUT, STATE, ...)                  ~ Apify Key-Value Store
// plus session.json with run metadata, status and stats.
//
// Reads go through store/raw-index.mjs, which seeks with the sparse index when one exists and
// falls back to a full ordered scan when it does not. The index is always rebuildable.
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, appendFileSync, renameSync, createReadStream, statSync, rmSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';
import { RawLog } from './raw-log.mjs';
import { iterateRaw, iterateStreamRecords, loadRawIndex, buildRawIndex, rawStats, readStreamIndex, readManifest, segmentFiles } from './raw-index.mjs';
import { compactSession, estimateCompaction, dirBytes } from './compact.mjs';

export class KeyValueStore {
  constructor(dir) { this.dir = dir; mkdirSync(dir, { recursive: true }); this._chains = new Map(); }
  _p(key) {
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(key)) throw new Error(`invalid key: ${key}`);
    return path.join(this.dir, key.includes('.') ? key : `${key}.json`);
  }
  set(key, value) {
    const p = this._p(key);
    const data = typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value, null, 2);
    writeFileSync(p + '.tmp', data); renameSync(p + '.tmp', p);
  }
  // Asynchronous set for periodic snapshots. The value is serialized here, synchronously, with the
  // same bytes set() would write, so the snapshot is fixed at call time. The file write itself runs
  // off the event loop: a uniquely named temp file, then rename over the key (the same atomic replace
  // as set()). Writes to one key are chained in call order, so a later snapshot always lands last.
  // The returned promise rejects on failure; the caller owns that rejection. A synchronous set() of
  // the same key must not overlap an unsettled setAsync() of it: callers await drain() first.
  setAsync(key, value) {
    const p = this._p(key);
    const data = typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value, null, 2);
    const tmp = `${p}.${randomBytes(4).toString('hex')}.tmp`;
    const prev = this._chains.get(p) ?? null;
    const run = (async () => {
      if (prev) await prev;
      try { await fsp.writeFile(tmp, data); await fsp.rename(tmp, p); }
      catch (e) { await fsp.rm(tmp, { force: true }).catch(() => {}); throw e; }
    })();
    const tail = run.then(() => {}, () => {}).then(() => { if (this._chains.get(p) === tail) this._chains.delete(p); });
    this._chains.set(p, tail);
    return run;
  }
  // Resolves once every setAsync() issued so far has settled (written or failed). Never rejects.
  async drain() { while (this._chains.size) await Promise.all([...this._chains.values()]); }
  get(key, fallback = undefined) {
    const p = this._p(key);
    if (!existsSync(p)) return fallback;
    const raw = readFileSync(p, 'utf8');
    return p.endsWith('.json') ? JSON.parse(raw) : raw;
  }
  has(key) { return existsSync(this._p(key)); }
  remove(key) { const p = this._p(key); if (existsSync(p)) { rmSync(p); return true; } return false; }
  stat(key) { const p = this._p(key); return existsSync(p) ? { key, bytes: statSync(p).size, modified: statSync(p).mtimeMs } : null; }
  keys() { return readdirSync(this.dir).filter((f) => !f.endsWith('.tmp')); }
}

// Datasets with a chunked writer ({ buffered: true }) accumulate pushed JSONL in memory and append
// it in one write when FLUSH_BYTES is reached, FLUSH_MS elapsed (unref'd timer), or anything could
// observe the file: every Dataset method that touches the file, constructing another Dataset for
// the same file (session.dataset() builds a fresh instance per call), Session.verify / saveMeta /
// bytes / datasets, and process exit. Bytes on disk are identical to unbuffered appends, in order.
const DATASET_FLUSH_BYTES = 256 * 1024;
const DATASET_FLUSH_MS = 250;
const pendingDatasets = new Set();
let exitHookInstalled = false;

export function flushPendingDatasets(match = null) {
  for (const ds of [...pendingDatasets]) if (!match || match(ds.file)) ds.flush();
}

export class Dataset {
  constructor(file, { buffered = false, flushBytes = DATASET_FLUSH_BYTES, flushMs = DATASET_FLUSH_MS } = {}) {
    // Another instance may hold unwritten lines for this very file; make them visible first.
    if (pendingDatasets.size) flushPendingDatasets((f) => f === file);
    this.file = file; mkdirSync(path.dirname(file), { recursive: true }); this.count = 0;
    this.buffered = !!buffered; this.flushBytes = flushBytes; this.flushMs = flushMs;
    this._buf = []; this._bufBytes = 0; this._timer = null;
  }
  push(items) {
    const arr = Array.isArray(items) ? items : [items];
    if (!arr.length) return;
    const text = arr.map((i) => JSON.stringify(i)).join('\n') + '\n';
    this.count += arr.length;
    if (!this.buffered) { appendFileSync(this.file, text); return; }
    this._buf.push(text); this._bufBytes += text.length;
    if (this._bufBytes >= this.flushBytes) { this.flush(); return; }
    pendingDatasets.add(this);
    if (!exitHookInstalled) { exitHookInstalled = true; process.once('exit', () => { try { flushPendingDatasets(); } catch { /* best effort at exit */ } }); }
    if (!this._timer) { this._timer = setTimeout(() => { this._timer = null; try { this.flush(); } catch { /* retried on the next push / read / exit */ } }, this.flushMs); this._timer.unref?.(); }
  }
  // Writes every buffered line now. Safe to call at any time; a no-op when nothing is pending.
  flush() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    if (!this._buf.length) { pendingDatasets.delete(this); return; }
    const text = this._buf.length === 1 ? this._buf[0] : this._buf.join('');
    this._buf = []; this._bufBytes = 0; pendingDatasets.delete(this);
    try { appendFileSync(this.file, text); }
    catch (e) { this._buf = [text]; this._bufBytes = text.length; pendingDatasets.add(this); throw e; } // never drop lines on a failed write
  }
  close() { this.flush(); }
  reset() { this._buf = []; this._bufBytes = 0; pendingDatasets.delete(this); if (this._timer) { clearTimeout(this._timer); this._timer = null; } if (existsSync(this.file)) rmSync(this.file); this.count = 0; }
  exists() { this.flush(); return existsSync(this.file); }
  bytes() { this.flush(); return existsSync(this.file) ? statSync(this.file).size : 0; }
  async *iterate({ from = 0, limit = Infinity, filter = null } = {}) {
    this.flush();
    if (!existsSync(this.file)) return;
    const rl = readline.createInterface({ input: createReadStream(this.file), crlfDelay: Infinity });
    let i = 0, yielded = 0;
    for await (const line of rl) {
      if (!line.trim()) continue;
      if (i++ < from) continue;
      let v; try { v = JSON.parse(line); } catch { continue; }
      if (filter && !filter(v)) continue;
      yield v;
      if (++yielded >= limit) return;
    }
  }
  async toArray(limit = Infinity) { const out = []; for await (const i of this.iterate()) { out.push(i); if (out.length >= limit) break; } return out; }
  async size() { let n = 0; for await (const _ of this.iterate()) n++; return n; }  // eslint-disable-line no-unused-vars
  // Last n records without loading the whole file into memory.
  async tail(n = 50) {
    const ring = new Array(n);
    let i = 0;
    for await (const v of this.iterate()) { ring[i % n] = v; i++; }
    if (i <= n) return ring.slice(0, i);
    return [...ring.slice(i % n), ...ring.slice(0, i % n)];
  }
}

export function newSessionId(site = 'site') {
  const d = new Date();
  const ts = d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const slug = String(site).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'site';
  return `${ts}-${slug}-${randomBytes(3).toString('hex')}`;
}

export class Session {
  static create(sessionsDir, { site, meta = {}, rawOptions = {} } = {}) {
    const id = newSessionId(site);
    const dir = path.join(sessionsDir, id);
    mkdirSync(dir, { recursive: true });
    const s = new Session(dir);
    s.meta = { id, site, createdAt: new Date().toISOString(), status: 'recording', ...meta };
    s.saveMeta();
    s.raw = new RawLog(path.join(dir, 'raw'), rawOptions);
    return s;
  }

  static open(sessionsDir, idOrPrefix) {
    const dir = resolveSessionDir(sessionsDir, idOrPrefix);
    return new Session(dir);
  }

  constructor(dir) {
    this.dir = dir;
    this.kv = new KeyValueStore(path.join(dir, 'kv'));
    const mp = path.join(dir, 'session.json');
    this.meta = existsSync(mp) ? JSON.parse(readFileSync(mp, 'utf8')) : { id: path.basename(dir) };
  }

  get id() { return this.meta.id; }
  get rawDir() { return path.join(this.dir, 'raw'); }
  // Only the per-event dataset sits on the capture hot path, so only it gets the chunked writer.
  dataset(name) { return new Dataset(path.join(this.dir, 'datasets', `${name}.jsonl`), { buffered: name === 'events' }); }
  // Make buffered dataset lines visible to anything that reads this session's files directly.
  flushDatasets() { const prefix = path.join(this.dir, 'datasets'); flushPendingDatasets((f) => f.startsWith(prefix)); }
  datasets() {
    this.flushDatasets();
    const d = path.join(this.dir, 'datasets');
    if (!existsSync(d)) return [];
    return readdirSync(d).filter((f) => f.endsWith('.jsonl')).map((f) => ({ name: f.slice(0, -6), bytes: statSync(path.join(d, f)).size }));
  }
  saveMeta() { this.flushDatasets(); const p = path.join(this.dir, 'session.json'); writeFileSync(p + '.tmp', JSON.stringify(this.meta, null, 2)); renameSync(p + '.tmp', p); }

  // Iterate raw records in seq order across all segments (including an unclosed one after a crash).
  // Accepts the original { fromSeq } plus optional toSeq / time window / kind and stream filters.
  // When a seek index exists it is used to skip straight to the first interesting byte.
  async *records(opts = {}) {
    if (!existsSync(this.rawDir)) return;
    yield* iterateRaw(this.rawDir, opts);
  }

  // Records belonging to one stream (skips whole segments via the stream locator).
  async *streamRecords(sid, opts = {}) {
    if (!existsSync(this.rawDir)) return;
    yield* iterateStreamRecords(this.rawDir, sid, opts);
  }

  // Index access / maintenance -----------------------------------------------------------------
  rawIndex() { return loadRawIndex(this.rawDir); }
  rawStats() { return rawStats(this.rawDir); }
  streamIndex() { return readStreamIndex(this.rawDir); }
  manifest() { return readManifest(this.rawDir); }
  segments() { return segmentFiles(this.rawDir); }
  async reindex(opts = {}) { return buildRawIndex(this.rawDir, { write: true, ...opts }); }
  async ensureIndex(opts = {}) {
    const idx = loadRawIndex(this.rawDir);
    if (idx.indexed) return { alreadyIndexed: true, segments: idx.segments.length };
    return buildRawIndex(this.rawDir, { write: true, ...opts });
  }

  // Compaction ---------------------------------------------------------------------------------
  async compact(opts = {}) { return compactSession(this, opts); }
  async compactionEstimate(opts = {}) { return estimateCompaction(this, opts); }

  bytes() {
    this.flushDatasets();
    return {
      raw: dirBytes(this.rawDir),
      datasets: dirBytes(path.join(this.dir, 'datasets')),
      kv: dirBytes(path.join(this.dir, 'kv')),
    };
  }

  // Integrity check against the manifest: hashes, record counts, seq continuity.
  // Merged (compacted) records declare the range they stand for via seqTo, and gap records declare
  // dropped ranges; any other hole is reported as unexplained.
  async verify() {
    this.flushDatasets();
    const rawDir = this.rawDir;
    const manifestPath = path.join(rawDir, 'manifest.json');
    const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : { segments: [] };
    const bySeg = new Map((manifest.segments ?? []).map((s) => [s.file, s]));
    const files = existsSync(rawDir) ? readdirSync(rawDir).filter((f) => /^\d{6}\.jsonl$/.test(f)).sort() : [];
    const report = { segments: [], ok: true, seqGaps: [], gapRecords: 0, droppedRecords: 0, records: 0, mergedRecords: 0, compacted: !!manifest.compacted };
    let lastSeq = 0;
    for (const f of files) {
      const p = path.join(rawDir, f);
      const buf = readFileSync(p);
      const sha = createHash('sha256').update(buf).digest('hex');
      const m = bySeg.get(f);
      const entry = { file: f, bytes: buf.length, inManifest: !!m, shaMatches: m ? m.sha256 === sha : null, torn: buf.length > 0 && buf[buf.length - 1] !== 0x0a };
      if (m && !entry.shaMatches) report.ok = false;
      if (entry.torn) report.ok = false;
      report.segments.push(entry);
    }
    const ranges = [];
    for await (const r of this.records()) {
      if (r.k === 'corrupt') { report.ok = false; continue; }
      report.records++;
      if (r.seq !== lastSeq + 1) report.seqGaps.push({ from: lastSeq + 1, to: r.seq - 1 });
      lastSeq = r.seqTo ?? r.seq;
      if (r.seqTo !== undefined && r.seqTo > r.seq) { report.mergedRecords++; ranges.push([r.seq + 1, r.seqTo]); }
      if (r.k === 'gap') { report.gapRecords++; report.droppedRecords += r.droppedRecords ?? 0; ranges.push([r.droppedSeqFrom, r.droppedSeqTo]); }
    }
    // A seq hole is expected only if a gap record or a merged record declares that range.
    const unexplained = report.seqGaps.filter((g) => !ranges.some(([a, b]) => a <= g.from && g.to <= b));
    report.unexplainedSeqGaps = unexplained.length;
    if (unexplained.length) { report.ok = false; report.unexplained = unexplained.slice(0, 20); }
    return report;
  }
}

export function listSessions(sessionsDir) {
  if (!existsSync(sessionsDir)) return [];
  return readdirSync(sessionsDir)
    .filter((d) => existsSync(path.join(sessionsDir, d, 'session.json')))
    .map((d) => {
      let meta;
      try { meta = JSON.parse(readFileSync(path.join(sessionsDir, d, 'session.json'), 'utf8')); } catch { meta = { id: d, status: 'unreadable_metadata' }; }
      let bytes = 0;
      const raw = path.join(sessionsDir, d, 'raw');
      if (existsSync(raw)) for (const f of readdirSync(raw)) { try { bytes += statSync(path.join(raw, f)).size; } catch { /* ignore */ } }
      return { ...meta, rawBytes: bytes };
    })
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export function resolveSessionDir(sessionsDir, idOrPrefix) {
  if (!idOrPrefix || idOrPrefix === 'latest') {
    const all = listSessions(sessionsDir);
    if (!all.length) throw new Error('No sessions recorded yet.');
    return path.join(sessionsDir, all[0].id);
  }
  const direct = path.join(sessionsDir, idOrPrefix);
  if (existsSync(path.join(direct, 'session.json'))) return direct;
  const hits = existsSync(sessionsDir) ? readdirSync(sessionsDir).filter((d) => d.startsWith(idOrPrefix) || d.endsWith(idOrPrefix)) : [];
  if (hits.length === 1) return path.join(sessionsDir, hits[0]);
  throw new Error(hits.length ? `"${idOrPrefix}" matches ${hits.length} sessions.` : `No session "${idOrPrefix}".`);
}

export { buildRawIndex, loadRawIndex, iterateRaw, compactSession, estimateCompaction };
