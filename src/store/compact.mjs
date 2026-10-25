// Raw-log compaction.
//
// Compaction never edits the original log in place. It writes a NEW segment set and a
// compaction.json receipt describing exactly what was changed, so the result stays auditable:
//
//   * runs of consecutive `chunk` records for the same stream are merged into one record
//     (`merged`, `seqTo`, `tEnd` keep the original seq range and timing envelope),
//   * selected record kinds can be dropped (`dropKinds`), counted in the receipt,
//   * bodies can be stripped to byte counts (`dropBodies`) for long-term metadata-only archives.
//
// Only globally adjacent records are merged, so output seq order is still strictly increasing and
// every merged record explains the seq range it stands for. Session.verify() understands `seqTo`,
// so a compacted log still verifies.
import { mkdirSync, openSync, writeSync, closeSync, fsyncSync, writeFileSync, renameSync, existsSync, statSync, readdirSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { iterateRaw, readManifest, buildRawIndex, segmentFiles } from './raw-index.mjs';
import { RAW_FORMAT, segmentName } from './raw-log.mjs';

class SegmentWriter {
  constructor(dir, { segmentBytes = 64 * 1024 * 1024 } = {}) {
    this.dir = dir;
    this.segmentBytes = segmentBytes;
    mkdirSync(dir, { recursive: true });
    this.segments = [];
    this.n = 0;
    this.bytes = 0;
    this.records = 0;
    this._open();
  }
  _open() {
    this.n++;
    this.file = segmentName(this.n);
    this.fd = openSync(path.join(this.dir, this.file), 'a');
    this.hash = createHash('sha256');
    this.segBytes = 0; this.segRecords = 0; this.firstSeq = null; this.lastSeq = null;
  }
  _close() {
    if (this.fd === undefined) return;
    try { fsyncSync(this.fd); } catch { /* ignore */ }
    closeSync(this.fd);
    this.fd = undefined;
    if (this.segRecords) this.segments.push({ file: this.file, bytes: this.segBytes, records: this.segRecords, firstSeq: this.firstSeq, lastSeq: this.lastSeq, sha256: this.hash.digest('hex') });
  }
  write(rec) {
    const line = JSON.stringify(rec) + '\n';
    const buf = Buffer.from(line);
    writeSync(this.fd, buf);
    this.hash.update(buf);
    this.segBytes += buf.length; this.segRecords++;
    this.bytes += buf.length; this.records++;
    if (this.firstSeq === null) this.firstSeq = rec.seq;
    this.lastSeq = rec.seqTo ?? rec.seq;
    if (this.segBytes >= this.segmentBytes) { this._close(); this._open(); }
  }
  finish(extra = {}) {
    this._close();
    const manifest = { format: RAW_FORMAT, compacted: true, segments: this.segments, ...extra };
    const p = path.join(this.dir, 'manifest.json');
    writeFileSync(p + '.tmp', JSON.stringify(manifest, null, 2));
    renameSync(p + '.tmp', p);
    return manifest;
  }
}

const MERGEABLE = new Set(['chunk']);

export async function compactRaw(srcDir, outDir, {
  dropKinds = [], dropBodies = false, mergeChunks = true, maxMergedBytes = 4 * 1024 * 1024,
  segmentBytes = 64 * 1024 * 1024, onlySids = null, dropSids = null, buildIndex = true,
} = {}) {
  const dropSet = new Set(dropKinds);
  const onlySet = onlySids ? new Set(onlySids) : null;
  const dropSidSet = dropSids ? new Set(dropSids) : null;
  const w = new SegmentWriter(outDir, { segmentBytes });
  const stats = {
    recordsIn: 0, recordsOut: 0, merged: 0, mergedRuns: 0, droppedByKind: {}, droppedBySid: 0,
    bodiesStripped: 0, bytesIn: 0, bytesOut: 0, corrupt: 0, kindsOut: {},
  };
  let pending = null; // { rec, parts:[Buffer], bytes, firstSeq, lastSeq, tEnd, count }

  const flush = () => {
    if (!pending) return;
    const { rec, parts, count, lastSeq, tEnd } = pending;
    pending = null;
    const merged = Buffer.concat(parts);
    const out = { ...rec };
    if (dropBodies) { delete out.b64; out.n = merged.length; out.bodyDropped = true; stats.bodiesStripped++; }
    else { out.b64 = merged.toString('base64'); out.n = merged.length; }
    if (count > 1) { out.merged = count; out.seqTo = lastSeq; out.tEnd = tEnd; stats.merged += count - 1; stats.mergedRuns++; }
    w.write(out);
    stats.recordsOut++;
    stats.kindsOut[out.k] = (stats.kindsOut[out.k] ?? 0) + 1;
  };

  for await (const rec of iterateRaw(srcDir, { useIndex: false })) {
    if (rec.k === 'corrupt') { stats.corrupt++; continue; }
    stats.recordsIn++;
    stats.bytesIn += Buffer.byteLength(JSON.stringify(rec)) + 1;
    if (dropSet.has(rec.k)) { stats.droppedByKind[rec.k] = (stats.droppedByKind[rec.k] ?? 0) + 1; continue; }
    if (rec.sid && onlySet && !onlySet.has(rec.sid)) { stats.droppedBySid++; continue; }
    if (rec.sid && dropSidSet && dropSidSet.has(rec.sid)) { stats.droppedBySid++; continue; }

    const mergeable = mergeChunks && MERGEABLE.has(rec.k) && rec.sid && !rec.redactions?.length && !rec.pre && !rec.bodyDropped;
    if (mergeable) {
      const buf = Buffer.from(rec.b64 ?? '', 'base64');
      if (pending && pending.rec.sid === rec.sid && pending.bytes + buf.length <= maxMergedBytes) {
        pending.parts.push(buf); pending.bytes += buf.length; pending.lastSeq = rec.seq; pending.tEnd = rec.t; pending.count++;
        continue;
      }
      flush();
      pending = { rec: { ...rec }, parts: [buf], bytes: buf.length, firstSeq: rec.seq, lastSeq: rec.seq, tEnd: rec.t, count: 1 };
      continue;
    }
    flush();
    const out = { ...rec };
    if (dropBodies && (out.k === 'chunk' || out.k === 'body')) { const n = Buffer.from(out.b64 ?? '', 'base64').length; delete out.b64; out.n = n; out.bodyDropped = true; stats.bodiesStripped++; }
    if (dropBodies && out.k === 'ws.frame') { const n = out.opcode === 2 ? Buffer.from(out.payload ?? '', 'base64').length : Buffer.byteLength(out.payload ?? ''); delete out.payload; out.n = n; out.bodyDropped = true; stats.bodiesStripped++; }
    w.write(out);
    stats.recordsOut++;
    stats.kindsOut[out.k] = (stats.kindsOut[out.k] ?? 0) + 1;
  }
  flush();

  const srcManifest = readManifest(srcDir);
  const manifest = w.finish({
    compaction: {
      at: new Date().toISOString(), source: path.basename(srcDir),
      sourceSegments: (srcManifest.segments ?? []).length,
      options: { dropKinds, dropBodies, mergeChunks, maxMergedBytes, onlySids: onlySids ? onlySids.length : null, dropSids: dropSids ? dropSids.length : null },
    },
  });
  stats.bytesOut = w.bytes;
  if (buildIndex) stats.index = await buildRawIndex(outDir, { write: true });
  const receipt = {
    schema: 'capture-studio.compaction/1', at: new Date().toISOString(),
    source: srcDir, out: outDir, segmentsOut: manifest.segments.length,
    ...stats,
    reduction: stats.bytesIn ? +(1 - stats.bytesOut / stats.bytesIn).toFixed(4) : 0,
    integrity_note: 'merged records carry seqTo so the original seq range stays explicit; dropped kinds and stripped bodies are counted above',
  };
  writeFileSync(path.join(outDir, 'compaction.json'), JSON.stringify(receipt, null, 2));
  return receipt;
}

// Compact a session's raw log. By default the result lands next to it as raw-compact/ and the
// original raw/ is untouched; replace:true swaps them, keeping the original as raw.pre-compact-*.
export async function compactSession(session, { out = 'raw-compact', replace = false, ...opts } = {}) {
  const srcDir = path.join(session.dir, 'raw');
  if (!existsSync(srcDir)) throw new Error('session has no raw/ directory');
  const outDir = path.resolve(session.dir, out);
  // Guard: recursive rmSync must never be able to delete the session or its raw source.
  {
    const sessionDir = path.resolve(session.dir);
    const srcResolved = path.resolve(srcDir);
    const contains = (parent, child) => {
      const rel = path.relative(parent, child);
      return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
    };
    if (outDir === sessionDir) throw new Error('refusing to compact: output directory equals the session directory');
    if (outDir === srcResolved) throw new Error('refusing to compact: output directory equals the raw source directory');
    if (contains(outDir, srcResolved)) throw new Error('refusing to compact: raw source directory is inside the output directory');
  }
  if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
  const receipt = await compactRaw(srcDir, outDir, opts);
  if (replace) {
    const keep = path.join(session.dir, `raw.pre-compact-${Date.now()}`);
    renameSync(srcDir, keep);
    renameSync(outDir, srcDir);
    receipt.replaced = true;
    receipt.originalKeptAt = path.basename(keep);
    writeFileSync(path.join(srcDir, 'compaction.json'), JSON.stringify(receipt, null, 2));
  }
  try {
    session.kv.set('COMPACTION', receipt);
    session.meta.compaction = { at: receipt.at, recordsIn: receipt.recordsIn, recordsOut: receipt.recordsOut, bytesIn: receipt.bytesIn, bytesOut: receipt.bytesOut, replaced: !!receipt.replaced };
    session.saveMeta();
  } catch { /* receipt already on disk */ }
  return receipt;
}

// How much a compaction would save, without writing anything.
export async function estimateCompaction(session, { dropKinds = [], mergeChunks = true } = {}) {
  const srcDir = path.join(session.dir, 'raw');
  const dropSet = new Set(dropKinds);
  const est = { records: 0, bytes: 0, mergeableRuns: 0, mergeableRecords: 0, droppable: 0, droppableBytes: 0, byKind: {} };
  let prevSid = null, run = 0;
  for await (const rec of iterateRaw(srcDir, { useIndex: false })) {
    if (rec.k === 'corrupt') continue;
    const size = Buffer.byteLength(JSON.stringify(rec)) + 1;
    est.records++; est.bytes += size;
    est.byKind[rec.k] = (est.byKind[rec.k] ?? 0) + size;
    if (dropSet.has(rec.k)) { est.droppable++; est.droppableBytes += size; continue; }
    if (mergeChunks && rec.k === 'chunk' && rec.sid) {
      if (rec.sid === prevSid) { run++; est.mergeableRecords++; }
      else { if (run > 0) est.mergeableRuns++; run = 0; prevSid = rec.sid; }
    } else { if (run > 0) est.mergeableRuns++; run = 0; prevSid = null; }
  }
  if (run > 0) est.mergeableRuns++;
  // Each merged record removes one JSON envelope (~120 B) plus base64 padding slack.
  est.estimatedBytesSaved = est.droppableBytes + est.mergeableRecords * 120;
  est.estimatedReduction = est.bytes ? +(est.estimatedBytesSaved / est.bytes).toFixed(4) : 0;
  return est;
}

// Directory size helper used by session listings and the compaction UI.
export function dirBytes(dir) {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const f of readdirSync(dir)) { try { const s = statSync(path.join(dir, f)); if (s.isFile()) n += s.size; } catch { /* ignore */ } }
  return n;
}

export { segmentFiles };
