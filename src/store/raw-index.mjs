// Readers for the append-only raw log and its derived index.
//
// The index is never trusted blindly: a seek only ever starts at a record boundary recorded by
// the writer, every yielded record is still parsed from the segment itself, and a missing or
// stale index degrades to a full ordered scan. Index files can be rebuilt at any time from the
// segments (buildRawIndex), which is also how sessions recorded before indexing gain one.
import { createReadStream, existsSync, readFileSync, readdirSync, statSync, writeFileSync, renameSync } from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';

const SEG_RE = /^\d{6}\.jsonl$/;
export const indexFileOf = (segFile) => segFile.replace(/\.jsonl$/, '.idx.jsonl');

export function readManifest(rawDir) {
  const p = path.join(rawDir, 'manifest.json');
  if (!existsSync(p)) return { format: 'aion-capture-raw/1', segments: [] };
  try { const m = JSON.parse(readFileSync(p, 'utf8')); m.segments ??= []; return m; } catch { return { format: 'unknown', segments: [], unreadableManifest: true }; }
}

export function segmentFiles(rawDir) {
  if (!existsSync(rawDir)) return [];
  return readdirSync(rawDir).filter((f) => SEG_RE.test(f)).sort();
}

export function readSegmentIndex(rawDir, segFile) {
  const p = path.join(rawDir, indexFileOf(segFile));
  if (!existsSync(p)) return null;
  const out = [];
  try {
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const e = JSON.parse(line);
      if (typeof e.s === 'number' && typeof e.o === 'number') out.push(e);
    }
  } catch { return out.length ? out : null; }
  out.sort((a, b) => a.s - b.s);
  return out;
}

export function readStreamIndex(rawDir) {
  const p = path.join(rawDir, 'streams.json');
  if (!existsSync(p)) return null;
  try {
    const j = JSON.parse(readFileSync(p, 'utf8'));
    const byId = new Map((j.streams ?? []).map((s) => [s.sid, s]));
    return { ...j, byId };
  } catch { return null; }
}

// Full picture of what exists on disk, index included.
export function loadRawIndex(rawDir) {
  const manifest = readManifest(rawDir);
  const bySeg = new Map((manifest.segments ?? []).map((s) => [s.file, s]));
  const segments = segmentFiles(rawDir).map((file) => {
    const p = path.join(rawDir, file);
    const bytes = existsSync(p) ? statSync(p).size : 0;
    const m = bySeg.get(file) ?? null;
    const entries = readSegmentIndex(rawDir, file);
    return {
      file, bytes, inManifest: !!m, records: m?.records ?? null,
      firstSeq: m?.firstSeq ?? entries?.[0]?.s ?? null, lastSeq: m?.lastSeq ?? null,
      entries: entries ?? [], indexed: !!entries?.length,
    };
  });
  // An empty trailing segment (written when a log is closed on a boundary) carries no index
  // entries and must not make the session look unindexed.
  const nonEmpty = segments.filter((s) => s.bytes > 0);
  return {
    format: manifest.format, dir: rawDir, segments,
    indexed: nonEmpty.length > 0 && nonEmpty.every((s) => s.indexed),
    partiallyIndexed: segments.some((s) => s.indexed),
    streams: readStreamIndex(rawDir),
    totalBytes: segments.reduce((a, s) => a + s.bytes, 0),
    firstSeq: nonEmpty.map((s) => s.firstSeq).filter((x) => typeof x === 'number').sort((a, b) => a - b)[0] ?? null,
    lastSeq: nonEmpty.map((s) => s.lastSeq).filter((x) => typeof x === 'number').sort((a, b) => b - a)[0] ?? null,
  };
}

// Largest index entry whose seq/time is still at or before the requested start.
export function seekOffset(entries, { fromSeq = 0, fromT = null } = {}) {
  if (!entries?.length) return 0;
  let off = 0;
  for (const e of entries) {
    const beforeSeq = fromSeq ? e.s <= fromSeq + 1 : true;
    const beforeT = fromT === null || fromT === undefined ? true : (e.t ?? 0) <= fromT;
    if (beforeSeq && beforeT) off = e.o; else break;
  }
  return off;
}

async function* iterateSegment(rawDir, file, start = 0) {
  const p = path.join(rawDir, file);
  if (!existsSync(p)) return;
  const rl = readline.createInterface({ input: createReadStream(p, start ? { start } : {}), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    let r;
    try { r = JSON.parse(line); } catch { yield { k: 'corrupt', file, note: 'unparseable line (likely torn write at crash)' }; continue; }
    yield r;
  }
}

// Ordered raw record iteration with optional seek and filters.
//   fromSeq  exclusive lower bound on seq (matches Session.records legacy semantics)
//   toSeq    inclusive upper bound; iteration stops as soon as it is passed
//   fromT/toT wall-clock window
//   kinds    array/Set of record kinds to yield
//   sids     array/Set of stream ids to yield
export async function* iterateRaw(rawDir, {
  fromSeq = 0, toSeq = Infinity, fromT = null, toT = null, kinds = null, sids = null,
  useIndex = true, includeCorrupt = true,
} = {}) {
  const kindSet = kinds ? (kinds instanceof Set ? kinds : new Set(kinds)) : null;
  const sidSet = sids ? (sids instanceof Set ? sids : new Set(sids)) : null;
  const manifest = readManifest(rawDir);
  const bySeg = new Map((manifest.segments ?? []).map((s) => [s.file, s]));
  for (const file of segmentFiles(rawDir)) {
    const m = bySeg.get(file);
    // Whole-segment skip when the manifest proves it is outside the window.
    if (m && typeof m.lastSeq === 'number' && m.lastSeq <= fromSeq) continue;
    if (m && typeof m.firstSeq === 'number' && m.firstSeq > toSeq) break;
    let start = 0;
    if (useIndex && (fromSeq || fromT !== null)) {
      const entries = readSegmentIndex(rawDir, file);
      if (entries?.length) start = seekOffset(entries, { fromSeq, fromT });
    }
    for await (const r of iterateSegment(rawDir, file, start)) {
      if (r.k === 'corrupt') { if (includeCorrupt) yield r; continue; }
      if (typeof r.seq === 'number') {
        if (r.seq <= fromSeq) continue;
        if (r.seq > toSeq) return;
      }
      if (fromT !== null && fromT !== undefined && r.t < fromT) continue;
      if (toT !== null && toT !== undefined && r.t > toT) return;
      if (kindSet && !kindSet.has(r.k)) continue;
      if (sidSet && !sidSet.has(r.sid)) continue;
      yield r;
    }
  }
}

// Records belonging to one stream, using the stream index to skip whole segments.
export async function* iterateStreamRecords(rawDir, sid, opts = {}) {
  const si = readStreamIndex(rawDir);
  const e = si?.byId?.get(sid);
  const base = { ...opts, sids: [sid] };
  if (e) { base.fromSeq = Math.max(opts.fromSeq ?? 0, (e.firstSeq ?? 1) - 1); base.toSeq = Math.min(opts.toSeq ?? Infinity, e.lastSeq ?? Infinity); }
  yield* iterateRaw(rawDir, base);
}

// Rebuild the sparse seek index and the per-stream locator from the segments themselves.
export async function buildRawIndex(rawDir, { strideBytes = 64 * 1024, write = true } = {}) {
  const manifest = readManifest(rawDir);
  const bySeg = new Map((manifest.segments ?? []).map((s) => [s.file, s]));
  const streams = new Map();
  const result = { segments: [], entries: 0, records: 0, streams: 0, written: write };
  for (const file of segmentFiles(rawDir)) {
    const p = path.join(rawDir, file);
    const entries = [];
    let off = 0, nextAt = 0, records = 0, firstSeq = null, lastSeq = null;
    const rl = readline.createInterface({ input: createReadStream(p), crlfDelay: Infinity });
    for await (const line of rl) {
      const bytes = Buffer.byteLength(line) + 1;
      let r = null;
      try { r = JSON.parse(line); } catch { off += bytes; continue; }
      records++;
      if (firstSeq === null) firstSeq = r.seq;
      lastSeq = r.seq;
      if (off >= nextAt) { entries.push({ s: r.seq, o: off, t: r.t }); nextAt = off + strideBytes; }
      if (r.sid) {
        let e = streams.get(r.sid);
        if (!e) { e = { sid: r.sid, firstSeq: r.seq, lastSeq: r.seq, records: 0, bytes: 0, firstT: r.t, lastT: r.t, segments: new Set() }; streams.set(r.sid, e); }
        e.lastSeq = r.seq; e.records++; e.bytes += bytes; e.lastT = r.t; e.segments.add(file);
      }
      off += bytes;
    }
    if (write) {
      const ip = path.join(rawDir, indexFileOf(file));
      writeFileSync(ip + '.tmp', entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : ''));
      renameSync(ip + '.tmp', ip);
      const m = bySeg.get(file);
      if (m) m.index = { file: indexFileOf(file), entries: entries.length, strideBytes };
    }
    result.segments.push({ file, entries: entries.length, records, firstSeq, lastSeq, bytes: off });
    result.entries += entries.length;
    result.records += records;
  }
  if (write) {
    manifest.index = { enabled: true, strideBytes, entries: result.entries, rebuiltAt: new Date().toISOString() };
    const mp = path.join(rawDir, 'manifest.json');
    writeFileSync(mp + '.tmp', JSON.stringify(manifest, null, 2));
    renameSync(mp + '.tmp', mp);
    const sp = path.join(rawDir, 'streams.json');
    const payload = {
      format: 'aion-capture-raw-streams/1', savedAt: new Date().toISOString(), rebuilt: true,
      count: streams.size, streams: [...streams.values()].map((s) => ({ ...s, segments: [...s.segments] })),
    };
    writeFileSync(sp + '.tmp', JSON.stringify(payload));
    renameSync(sp + '.tmp', sp);
  }
  result.streams = streams.size;
  result.streamIndex = [...streams.values()].map((s) => ({ ...s, segments: [...s.segments] }));
  return result;
}

// Cheap on-disk statistics without decoding payloads.
export function rawStats(rawDir) {
  const idx = loadRawIndex(rawDir);
  const manifest = readManifest(rawDir);
  return {
    format: idx.format,
    segments: idx.segments.length,
    bytes: idx.totalBytes,
    records: (manifest.segments ?? []).reduce((a, s) => a + (s.records ?? 0), 0),
    firstSeq: idx.firstSeq,
    lastSeq: idx.lastSeq,
    compacted: !!manifest.compacted,
    indexed: idx.indexed,
    indexEntries: idx.segments.reduce((a, s) => a + s.entries.length, 0),
    streams: idx.streams?.count ?? null,
  };
}
