// Append-only, segmented raw event log with bounded memory, explicit gap records and a
// side-car index that makes later reads seekable.
//
// Chrome cannot be slowed down by us, so true backpressure is impossible at the source.
// Instead: records are queued in memory up to `maxQueueBytes`; if the disk falls behind,
// further records are DROPPED and a `gap` record (with counts, bytes and affected stream ids)
// is written as soon as space frees. Nothing is ever silently lost or silently truncated.
//
// Durable layout under <session>/raw/:
//   manifest.json      segments with byte counts, seq ranges and sha256
//   NNNNNN.jsonl       append-only records, one JSON object per line
//   NNNNNN.idx.jsonl   sparse seek index: {s: seq, o: byteOffset, t: wallTime}
//   streams.json       per-stream locator: first/last seq, record counts, bytes, segments
//
// The index is strictly derived data: it can always be rebuilt from the segments
// (see store/raw-index.mjs buildIndex) and its absence never blocks a read.
import { createHash } from 'node:crypto';
import { mkdirSync, openSync, writeSync, fsyncSync, closeSync, writeFileSync, readFileSync, existsSync, renameSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import path from 'node:path';

const pad = (n) => String(n).padStart(6, '0');
export const RAW_FORMAT = 'aion-capture-raw/2';
export const segmentName = (n) => `${pad(n)}.jsonl`;
export const indexName = (segFile) => segFile.replace(/\.jsonl$/, '.idx.jsonl');

export class RawLog extends EventEmitter {
  constructor(dir, {
    segmentBytes = 64 * 1024 * 1024, maxQueueBytes = 128 * 1024 * 1024, flushIntervalMs = 50,
    fsyncIntervalMs = 1000, writeDelayMs = 0, index = true, indexStrideBytes = 64 * 1024,
    maxIndexedStreams = 50_000,
  } = {}) {
    super();
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
    this.segmentBytes = segmentBytes;
    this.maxQueueBytes = maxQueueBytes;
    this.writeDelayMs = writeDelayMs; // test hook: simulate a slow disk
    this.indexEnabled = index !== false;
    this.indexStrideBytes = Math.max(1, indexStrideBytes);
    this.maxIndexedStreams = maxIndexedStreams;
    this.seq = 0;
    this.queue = [];
    this.queueBytes = 0;
    this.dropped = null; // { records, bytes, sids:Set, firstSeq, lastSeq, since }
    this.manifest = this._loadManifest();
    this.stats = { records: 0, bytes: 0, droppedRecords: 0, droppedBytes: 0, gaps: 0, maxQueueBytesSeen: 0, indexEntries: 0, kinds: {} };
    this.streamIndex = new Map();   // sid -> { sid, firstSeq, lastSeq, records, bytes, firstT, lastT, segments:[] }
    this.streamIndexTruncated = false;
    this.closed = false;
    this._openSegment(this.manifest.segments.length + 1);
    this.flushTimer = setInterval(() => this.flush(), flushIntervalMs);
    this.fsyncTimer = setInterval(() => this._fsync(), fsyncIntervalMs);
    this.flushTimer.unref?.(); this.fsyncTimer.unref?.();
  }

  _loadManifest() {
    const p = path.join(this.dir, 'manifest.json');
    if (existsSync(p)) {
      const m = JSON.parse(readFileSync(p, 'utf8'));
      m.format ??= RAW_FORMAT;
      m.segments ??= [];
      return m;
    }
    return { format: RAW_FORMAT, segments: [] };
  }

  _saveManifest() {
    const p = path.join(this.dir, 'manifest.json');
    this.manifest.format = RAW_FORMAT;
    this.manifest.index = { enabled: this.indexEnabled, strideBytes: this.indexStrideBytes, entries: this.stats.indexEntries };
    writeFileSync(p + '.tmp', JSON.stringify(this.manifest, null, 2));
    renameSync(p + '.tmp', p);
  }

  _saveStreamIndex() {
    if (!this.indexEnabled) return;
    const p = path.join(this.dir, 'streams.json');
    const payload = {
      format: 'aion-capture-raw-streams/1', savedAt: new Date().toISOString(),
      truncated: this.streamIndexTruncated, count: this.streamIndex.size,
      streams: [...this.streamIndex.values()].map((s) => ({ ...s, segments: [...s.segments] })),
    };
    try { writeFileSync(p + '.tmp', JSON.stringify(payload)); renameSync(p + '.tmp', p); } catch { /* index is derived data */ }
  }

  _openSegment(n) {
    this.segName = segmentName(n);
    this.fd = openSync(path.join(this.dir, this.segName), 'a');
    this.segHash = createHash('sha256');
    this.segBytes = 0;
    this.segRecords = 0;
    this.segFirstSeq = null;
    this.segLastSeq = null;
    this.segIndexEntries = 0;
    this._nextIndexAt = 0;
    this.idxFd = undefined;
    if (this.indexEnabled) {
      try { this.idxFd = openSync(path.join(this.dir, indexName(this.segName)), 'a'); } catch { this.idxFd = undefined; }
    }
  }

  _closeSegment(final = false) {
    if (this.fd === undefined) return;
    fsyncSync(this.fd);
    closeSync(this.fd);
    this.fd = undefined;
    if (this.idxFd !== undefined) { try { fsyncSync(this.idxFd); closeSync(this.idxFd); } catch { /* ignore */ } this.idxFd = undefined; }
    if (this.segRecords > 0 || final) {
      const entry = {
        file: this.segName, bytes: this.segBytes, records: this.segRecords,
        firstSeq: this.segFirstSeq, lastSeq: this.segLastSeq, sha256: this.segHash.digest('hex'),
      };
      if (this.indexEnabled) entry.index = { file: indexName(this.segName), entries: this.segIndexEntries, strideBytes: this.indexStrideBytes };
      this.manifest.segments.push(entry);
      this._saveManifest();
      this._saveStreamIndex();
    }
  }

  _indexRecord(r, off) {
    if (!this.indexEnabled) return;
    if (r.sid) {
      let e = this.streamIndex.get(r.sid);
      if (!e) {
        if (this.streamIndex.size >= this.maxIndexedStreams) { this.streamIndexTruncated = true; }
        else { e = { sid: r.sid, firstSeq: r.seq, lastSeq: r.seq, records: 0, bytes: 0, firstT: r.t, lastT: r.t, segments: new Set() }; this.streamIndex.set(r.sid, e); }
      }
      if (e) { e.lastSeq = r.seq; e.records++; e.bytes += r.bytes; e.lastT = r.t; e.segments.add(this.segName); }
    }
    if (this.idxFd === undefined) return;
    if (off < this._nextIndexAt) return;
    this._nextIndexAt = off + this.indexStrideBytes;
    try {
      writeSync(this.idxFd, `${JSON.stringify({ s: r.seq, o: off, t: r.t })}\n`);
      this.segIndexEntries++; this.stats.indexEntries++;
    } catch { /* index is derived data: never fail a capture over it */ }
  }

  // Append a record. Returns the assigned seq, or null if it was dropped (a gap will be recorded).
  append(rec) {
    if (this.closed) return null;
    const seq = ++this.seq;
    const t = Date.now();
    const line = JSON.stringify({ seq, t, ...rec }) + '\n';
    const bytes = Buffer.byteLength(line);
    // Hysteresis: once dropping starts, keep dropping until the queue drains to half and the gap
    // record is written, so every gap is one contiguous, fully described seq range.
    if ((this.dropped || this.queueBytes + bytes > this.maxQueueBytes) && rec.k !== 'gap') {
      if (!this.dropped) this.dropped = { records: 0, bytes: 0, sids: new Set(), firstSeq: seq, lastSeq: seq, since: Date.now() };
      this.dropped.records++; this.dropped.bytes += bytes; this.dropped.lastSeq = seq;
      if (rec.sid) this.dropped.sids.add(rec.sid);
      this.stats.droppedRecords++; this.stats.droppedBytes += bytes;
      this.emit('drop', { seq, k: rec.k, sid: rec.sid });
      return null;
    }
    this.queue.push({ seq, line, bytes, k: rec.k, sid: rec.sid, t });
    this.queueBytes += bytes;
    this.stats.kinds[rec.k] = (this.stats.kinds[rec.k] ?? 0) + 1;
    if (this.queueBytes > this.stats.maxQueueBytesSeen) this.stats.maxQueueBytesSeen = this.queueBytes;
    return seq;
  }

  _emitGapIfAny() {
    if (!this.dropped || this.queueBytes > this.maxQueueBytes / 2) return;
    const d = this.dropped;
    this.dropped = null;
    this.stats.gaps++;
    this.append({ k: 'gap', reason: 'local_queue_overflow', droppedRecords: d.records, droppedBytes: d.bytes, droppedSeqFrom: d.firstSeq, droppedSeqTo: d.lastSeq, sids: [...d.sids], since: d.since });
  }

  flush() {
    if (this.writing || this.fd === undefined) return;
    this.writing = true;
    try {
      // Test hook: a "slow disk" writes one small batch per writeDelayMs, so the queue grows.
      if (this.writeDelayMs && !this.closing) {
        if (Date.now() < (this._nextWriteAt ?? 0)) return;
        this._nextWriteAt = Date.now() + this.writeDelayMs;
      }
      const limit = this.writeDelayMs && !this.closing ? 16 * 1024 : 4 * 1024 * 1024;
      // Write a bounded batch per tick so a slow disk shows up as queue growth, not a frozen loop.
      let batch = [], batchBytes = 0;
      while (this.queue.length && batchBytes < limit) { const r = this.queue.shift(); batch.push(r); batchBytes += r.bytes; }
      if (batch.length) {
        const buf = Buffer.from(batch.map((r) => r.line).join(''));
        writeSync(this.fd, buf);
        this.segHash.update(buf);
        let off = this.segBytes;
        for (const r of batch) { this._indexRecord(r, off); off += r.bytes; }
        this.segBytes += buf.length;
        this.segRecords += batch.length;
        if (this.segFirstSeq === null) this.segFirstSeq = batch[0].seq;
        this.segLastSeq = batch[batch.length - 1].seq;
        this.queueBytes -= batchBytes;
        this.stats.records += batch.length;
        this.stats.bytes += buf.length;
        this.emit('written', { records: batch.length, bytes: buf.length, lastSeq: this.segLastSeq });
        if (this.segBytes >= this.segmentBytes) { this._closeSegment(); this._openSegment(this.manifest.segments.length + 1); }
      }
      this._emitGapIfAny();
    } finally { this.writing = false; }
  }

  _fsync() { if (this.fd !== undefined) { try { fsyncSync(this.fd); } catch { /* ignore */ } } }

  get queueDepth() { return { records: this.queue.length, bytes: this.queueBytes }; }

  // Live locator for one stream (used by the studio to jump straight to its bytes).
  locate(sid) { const e = this.streamIndex.get(sid); return e ? { ...e, segments: [...e.segments] } : null; }
  locators() { return [...this.streamIndex.values()].map((e) => ({ ...e, segments: [...e.segments] })); }

  async close() {
    if (this.closed) return;
    clearInterval(this.flushTimer); clearInterval(this.fsyncTimer);
    this.closing = true;
    // Drain fully; a pending gap must be persisted before closing.
    while (this.queue.length || this.dropped) {
      if (this.dropped && !this.queue.length) { const d = this.dropped; this.dropped = null; this.stats.gaps++; this.queue.push(this._gapLine(d)); this.queueBytes += this.queue.at(-1).bytes; }
      this.flush();
    }
    this.closed = true;
    this._closeSegment(true);
  }

  _gapLine(d) {
    const seq = ++this.seq;
    const t = Date.now();
    const line = JSON.stringify({ seq, t, k: 'gap', reason: 'local_queue_overflow', droppedRecords: d.records, droppedBytes: d.bytes, droppedSeqFrom: d.firstSeq, droppedSeqTo: d.lastSeq, sids: [...d.sids], since: d.since }) + '\n';
    return { seq, line, bytes: Buffer.byteLength(line), k: 'gap', t };
  }
}
