// StreamReducer: turns raw L1 records into stream state + decoded L2 events.
// Used identically by the live recorder and by offline replay/derive, so the live view and
// a later reconstruction from disk cannot disagree.
import { pickAutoDecoder, decodeWsPayload, classifyMime, WsFrameDecoder, sniffEnvelope, unwrapNestedJson, AutoDecoder } from '../decode/decoders.mjs';
import { DeltaAssembler } from '../decode/delta.mjs';
import { classifyStreamRole, STREAM_ROLES } from './stream-role.mjs';
import { detectStreamMap, applyStreamMap } from '../profiles/stream-map.mjs';

// Content-free diagnostics of the decoder a stream actually used: declared vs sniffed framing,
// late re-sniff switches and the inner decoder's counters. Safe for receipts and timelines.
export function decoderInfo(dec, ws = null) {
  if (!dec && !ws) return null;
  const out = {};
  if (dec) {
    out.kind = dec.kind ?? null;
    out.inner = dec.inner?.constructor?.name ?? dec.constructor?.name ?? null;
    if (dec instanceof AutoDecoder) {
      Object.assign(out, { auto: true, declared: classifyMime(dec.mime), forced: dec.forced ?? null,
        switched: dec.switched ?? null, chunks: dec.chunkCount, emitted: dec.emitted, sniffedBytes: dec.headBytes });
    }
    const st = dec.stats;
    if (st && typeof st === 'object') { try { out.stats = JSON.parse(JSON.stringify(st)); } catch { /* counters only */ } }
  }
  if (ws) {
    out.ws = { protocol: ws.dominantProtocol?.() ?? null };
    if (ws.stats && typeof ws.stats === 'object') { try { out.ws.stats = JSON.parse(JSON.stringify(ws.stats)); } catch { /* ignore */ } }
  }
  return out;
}

// Transport vocabulary kept stable for receipts and downstream consumers.
export const STREAMING_TRANSPORTS = Object.freeze(['HTTP_SSE', 'HTTP_NDJSON', 'HTTP_STREAMED', 'EVENT_SOURCE', 'WEBSOCKET']);
const STREAMING_SET = new Set(STREAMING_TRANSPORTS);

export function transportOf(stream) {
  if (stream.kind === 'ws') return 'WEBSOCKET';
  if (stream.esMessages > 0) return 'EVENT_SOURCE';
  if (stream.decoder === 'sse') return 'HTTP_SSE';
  if (stream.decoder === 'ndjson' || stream.decoder === 'jsonseq') return 'HTTP_NDJSON';
  if (stream.decoder === 'chunked-json' || stream.decoder === 'grpc' || stream.decoder === 'length-prefixed') return 'HTTP_STREAMED';
  if (stream.chunks > 1) return 'HTTP_STREAMED';
  return 'HTTP';
}

// Finer-grained framing name; always a refinement of transportOf, never a replacement.
export function transportDetailOf(stream) {
  if (stream.kind === 'ws') return stream.appProtocol ? `WEBSOCKET_${String(stream.appProtocol).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}` : 'WEBSOCKET';
  if (stream.esMessages > 0) return 'EVENT_SOURCE';
  switch (stream.decoder) {
    case 'sse': return 'HTTP_SSE';
    case 'ndjson': return 'HTTP_NDJSON';
    case 'jsonseq': return 'HTTP_JSON_SEQ';
    case 'chunked-json': return 'HTTP_CHUNKED_JSON';
    case 'length-prefixed': return 'HTTP_LENGTH_PREFIXED';
    case 'grpc': return 'GRPC';
    default: return stream.chunks > 1 ? 'HTTP_STREAMED' : 'HTTP';
  }
}

export function isStreaming(stream) {
  return STREAMING_SET.has(stream?.transport ?? transportOf(stream ?? {}));
}

const SEQ_FIELDS = ['seq', 'sequence', 'sequence_number', 'sequenceNumber', 'offset', 'event_seq', 'revision', 'version', 'frame'];

export class StreamReducer {
  // jsonMaxBytes (0 = unlimited, the default for every reader: derive, mirror, export, eval). Only a
  // live recorder sets it: a JSON value larger than the cap is emitted as an oversize marker with
  // no parsed json. Read when a stream's decoder is created, so set it before the first chunk.
  // roleClassifier (injectable for tests): only ever called on explicit opt-in, see summary({ includeStreamRoles }).
  constructor({ deltaDialect = 'auto', keepEvents = true, maxEventsPerStream = Infinity, stallMs = 5000, deltaOpsLog = 0, deltaSnapshotEvery = 0, jsonMaxBytes = 0, roleClassifier = classifyStreamRole } = {}) {
    this.roleClassifier = roleClassifier;
    this.jsonMaxBytes = jsonMaxBytes;
    this.maxEventsPerStream = maxEventsPerStream; // live view is bounded; disk keeps everything
    this.streams = new Map();
    this.deltaDialect = deltaDialect;
    this.deltaOpsLog = deltaOpsLog;
    this.deltaSnapshotEvery = deltaSnapshotEvery;
    this.keepEvents = keepEvents;
    this.stallMs = stallMs;
    this.gaps = [];
    this.nav = [];
    this.actions = [];
    this.dom = { batches: 0, mutations: 0, blocks: new Map() };
    this.lifecycle = [];
    this.run = {};
    this.protocols = new Map();     // app protocol -> frames observed
    this.connectionEvents = [];     // CDP reconnects / target loss, in order
    this.totals = { events: 0, heartbeats: 0, duplicates: 0, outOfOrder: 0, terminals: 0, decoderSwitches: 0, reassembledFrames: 0, bytes: 0 };
  }

  _stream(sid, init = {}) {
    let s = this.streams.get(sid);
    if (!s) {
      s = {
        sid, kind: 'http', chunks: 0, bytes: 0, preBytes: 0, events: 0, esMessages: 0, frames: 0,
        status: 'open', coverage: 'observed_from_request_start', redactions: 0, gaps: 0,
        heartbeats: 0, stalls: 0, maxChunkGapMs: 0, terminalSeen: false, ...init,
      };
      Object.defineProperty(s, '_dec', { value: null, writable: true, enumerable: false });
      Object.defineProperty(s, '_ws', { value: null, writable: true, enumerable: false });
      Object.defineProperty(s, '_delta', { value: new DeltaAssembler({ dialect: this.deltaDialect, opsLog: this.deltaOpsLog, snapshotEvery: this.deltaSnapshotEvery }), writable: true, enumerable: false });
      Object.defineProperty(s, '_events', { value: [], writable: true, enumerable: false });
      // Memoised per-stream summary body (see summary()); null = needs rebuilding.
      // role = memoised opt-in role classification (null until summary({ includeStreamRoles }) / streamRole()).
      Object.defineProperty(s, '_sum', { value: { base: null, role: null }, writable: true, enumerable: false });
      this.streams.set(sid, s);
    }
    // Every ingest path that mutates a stream goes through here (or marks it explicitly), so the
    // memoised summary is invalidated exactly when the stream can have changed.
    s._sum.base = null;
    s._sum.role = null;
    return s;
  }

  _touchAll() { for (const s of this.streams.values()) { s._sum.base = null; s._sum.role = null; } }
  _touch(sid) { const s = this.streams.get(sid); if (s) { s._sum.base = null; s._sum.role = null; } return s; }

  _emitEvents(s, evs, rec, out) {
    for (let idx = 0; idx < evs.length; idx++) {
      const ev = evs[idx];
      // n = position within this emission (one raw record per emission), so (sid, seq, n) is unique.
      // A decoder-provided ev.n is never overwritten: the position is kept as evn instead.
      const e = { sid: s.sid, seq: rec.seq, t: rec.t, layer: 'L2', ...(ev.n === undefined ? { n: idx } : { evn: idx }), ...ev };
      // Duplicate / out-of-order detection from protocol ids or sequence-like fields.
      if (ev.id !== undefined && ev.id !== '') {
        s._ids ??= new Set();
        if (s._ids.has(ev.id)) { e.duplicate = true; s.duplicates = (s.duplicates ?? 0) + 1; } else s._ids.add(ev.id);
        s.lastEventId = ev.id;
      } else if (ev.lastEventId !== undefined) s.lastEventId ??= ev.lastEventId;
      if (ev.retry !== undefined && typeof ev.retry === 'number') s.sseRetryMs = ev.retry;
      if (ev.heartbeat) { s.heartbeats++; this.totals.heartbeats++; }
      if (ev.terminal) { s.terminalSeen = true; this.totals.terminals++; }
      if (ev.reassembled) this.totals.reassembledFrames++;
      if (ev.protocol) {
        s.appProtocol ??= ev.protocol;
        if (ev.protocol !== 'json' && ev.protocol !== 'text') s.appProtocol = ev.protocol;
        this.protocols.set(ev.protocol, (this.protocols.get(ev.protocol) ?? 0) + 1);
      }
      if (ev.channel !== undefined && ev.channel !== null) { (s.channels ??= new Set()).add(String(ev.channel)); }
      if (ev.frameType !== undefined) (s.frameTypes ??= new Set()).add(String(ev.frameType));
      const j = ev.json;
      if (j && typeof j === 'object' && !Array.isArray(j)) {
        let k;
        for (let fi = 0; fi < SEQ_FIELDS.length; fi++) if (typeof j[SEQ_FIELDS[fi]] === 'number') { k = SEQ_FIELDS[fi]; break; }
        if (k) {
          const key = `${k}|${j.type ?? ''}`;
          s._lastNum ??= {};
          if (s._lastNum[key] !== undefined) {
            if (j[k] === s._lastNum[key]) { e.duplicate = true; s.duplicates = (s.duplicates ?? 0) + 1; }
            else if (j[k] < s._lastNum[key]) { e.outOfOrder = true; s.outOfOrder = (s.outOfOrder ?? 0) + 1; }
            else if (j[k] > s._lastNum[key] + 1) { e.sequenceSkip = j[k] - s._lastNum[key] - 1; s.sequenceSkips = (s.sequenceSkips ?? 0) + (e.sequenceSkip); }
          }
          s._lastNum[key] = Math.max(j[k], s._lastNum[key] ?? -Infinity);
        }
      }
      // Reconstruction: prefer an unwrapped nested document when the envelope only carries a
      // JSON string (very common for channel/push transports).
      const forDelta = ev.jsonNested?.json !== undefined ? ev.jsonNested.json : ev.json;
      if (forDelta !== undefined) {
        if (s._delta.apply(forDelta)) e.revision = s._delta.revisions;
      }
      s.events++;
      this.totals.events++;
      if (e.duplicate) this.totals.duplicates++;
      if (e.outOfOrder) this.totals.outOfOrder++;
      if (this.keepEvents) {
        s._events.push(e);
        if (s._events.length > this.maxEventsPerStream) { s._events.shift(); s.eventsOnlyOnDisk = (s.eventsOnlyOnDisk ?? 0) + 1; }
      }
      out.push(e);
    }
  }

  // The decoder is created lazily on the first byte so content sniffing can see real bytes;
  // s.decoder is only written once a decoder has actually consumed something.
  _ensureDecoder(s) {
    if (!s._dec) s._dec = pickAutoDecoder(s.mime, s.forcedDecoder, { jsonMaxBytes: this.jsonMaxBytes });
    return s._dec;
  }

  _timing(s, rec) {
    if (!s.firstChunkT) s.firstChunkT = rec.t;
    if (s.lastChunkT) {
      const d = rec.t - s.lastChunkT;
      if (d > s.maxChunkGapMs) s.maxChunkGapMs = d;
      if (d >= this.stallMs) s.stalls++;
      s.interarrivalSum = (s.interarrivalSum ?? 0) + d;
      s.interarrivalN = (s.interarrivalN ?? 0) + 1;
    }
    s.lastChunkT = rec.t;
  }

  // Returns derived L2 events produced by this raw record.
  ingest(rec) {
    const out = [];
    switch (rec.k) {
      case 'run.start': this.run = { ...rec }; break;
      case 'run.end': this.run.end = rec; this._touchAll(); for (const s of this.streams.values()) if (s.status === 'open') { s.status = 'incomplete_at_stop'; this._finish(s, rec, out); } break;
      case 'req': {
        const s = this._stream(rec.sid, { url: rec.url, method: rec.method, resourceType: rec.type, startedT: rec.t, frameId: rec.frameId, initiator: rec.initiator, target: rec.target });
        s.url = rec.url; s.method = rec.method; s.resourceType = rec.type;
        if (rec.policy) s.policy = rec.policy;
        if (rec.postData !== undefined) {
          s.hasRequestBody = true;
          const env = sniffEnvelope(rec.postData);
          if (env?.json !== undefined) {
            s.requestJsonKeys = Object.keys(env.json && typeof env.json === 'object' && !Array.isArray(env.json) ? env.json : {}).slice(0, 20);
            if (typeof env.json?.query === 'string' && /\b(query|mutation|subscription)\b/.test(env.json.query)) s.graphql = /\bsubscription\b/.test(env.json.query) ? 'subscription' : /\bmutation\b/.test(env.json.query) ? 'mutation' : 'query';
            if (env.json?.jsonrpc !== undefined || (typeof env.json?.method === 'string' && 'params' in env.json)) s.rpc = 'json-rpc';
          }
        }
        break;
      }
      case 'res': {
        const s = this._stream(rec.sid);
        Object.assign(s, { status_code: rec.status, mime: rec.mime, protocol: rec.protocol, firstResponseT: rec.t, fromServiceWorker: rec.fromServiceWorker, fromCache: rec.fromCache });
        s.mimeClass = classifyMime(rec.mime);
        if (rec.redirect) s.redirects = (s.redirects ?? 0) + 1;
        break;
      }
      case 'stream.armed': { const s = this._stream(rec.sid); s.armed = rec.mode; s.armedT = rec.t; break; }
      case 'stream.arm_failed': { const s = this._stream(rec.sid); s.armError = rec.error; break; }
      case 'chunk':
      case 'body': {
        const s = this._stream(rec.sid);
        const buf = Buffer.from(rec.b64 ?? '', 'base64');
        s.chunks++; s.bytes += buf.length;
        this.totals.bytes += buf.length;
        if (rec.pre) s.preBytes += buf.length;
        if (rec.k === 'body') s.retrospective = true;
        if (rec.redactions?.length) s.redactions += rec.redactions.length;
        this._timing(s, rec);
        const dec = this._ensureDecoder(s);
        if (dec) {
          this._emitEvents(s, dec.push(buf), rec, out);
          s.decoder = dec.kind;
          // Only a genuine late re-sniff (after bytes disagreed with the declared type) counts as
          // a switch; the initial choice is not a switch.
          if (dec.switched && !s.decoderSwitch) { s.decoderSwitch = dec.switched; s.decoderSwitchedFrom = dec.switched.from; this.totals.decoderSwitches++; }
        }
        break;
      }
      case 'body.truncated': { const s = this._stream(rec.sid); s.truncatedAtBytes = rec.bytes; s.coverage = 'truncated_at_byte_cap'; break; }
      case 'done': { const s = this._stream(rec.sid); s.status = 'complete'; s.encodedDataLength = rec.encodedDataLength; s.endT = rec.t; this._finish(s, rec, out); break; }
      case 'fail': { const s = this._stream(rec.sid); s.status = rec.canceled ? 'canceled' : 'failed'; s.error = rec.errorText; s.endT = rec.t; if (s.bytes > 0) s.interrupted = true; this._finish(s, rec, out); break; }
      case 'body.excluded': { const s = this._stream(rec.sid); s.bodyExcluded = rec.reason; break; }
      case 'es.msg': {
        const s = this._stream(rec.sid);
        s.esMessages++;
        this._timing(s, rec);
        const env = sniffEnvelope(rec.data ?? '');
        const ev = { type: 'eventsource', event: rec.eventName || 'message', id: rec.eventId || undefined, data: rec.data, browserParsed: true };
        if (env?.json !== undefined) ev.json = env.json;
        if (env?.envelope && !env.headerOnly) ev.envelope = env.envelope;
        if (ev.json !== undefined) { const nested = unwrapNestedJson(ev.json); if (nested) ev.jsonNested = nested; }
        const trimmed = String(rec.data ?? '').trim();
        if (trimmed === '[DONE]' || /^(done|complete|completed|end)$/i.test(String(rec.eventName ?? ''))) ev.terminal = true;
        if (!trimmed || trimmed === '{}' || /^(ping|pong|heartbeat)$/i.test(trimmed)) ev.heartbeat = true;
        this._emitEvents(s, [ev], rec, out);
        break;
      }
      case 'ws.open': {
        // A late-joined socket was opened before observation: URL, handshake and earlier frames are
        // UNKNOWN, so it must never claim to have been observed from the request start.
        this._stream(rec.sid, { kind: 'ws', url: rec.url, startedT: rec.t, target: rec.target, ...(rec.lateJoin ? { lateJoin: true, urlUnknown: true, coverage: 'joined_late_earlier_frames_unknown' } : {}) });
        break;
      }
      case 'ws.handshake': { const s = this._stream(rec.sid, { kind: 'ws' }); s.status_code = rec.status; if (rec.headers) { const sp = rec.headers['sec-websocket-protocol'] ?? rec.headers['Sec-WebSocket-Protocol']; if (sp) s.wsSubprotocol = sp; } break; }
      case 'ws.handshake_request': { const s = this._stream(rec.sid, { kind: 'ws' }); if (rec.requestedProtocols) s.wsRequestedProtocols = rec.requestedProtocols; break; }
      case 'ws.frame': {
        const s = this._stream(rec.sid, { kind: 'ws' });
        s.frames++;
        const size = rec.opcode === 2 ? Buffer.from(rec.payload ?? '', 'base64').length : Buffer.byteLength(rec.payload ?? '');
        s.bytes += size;
        this.totals.bytes += size;
        this._timing(s, rec);
        if (!s._ws) s._ws = new WsFrameDecoder();
        const evs = s._ws.push({ opcode: rec.opcode, payload: rec.payload, dir: rec.dir, t: rec.t });
        for (const e of evs) { if (e.size === undefined) e.size = size; e.dir ??= rec.dir; e.opcode ??= rec.opcode; }
        this._emitEvents(s, evs.length ? evs : [{ ...decodeWsPayload(rec), dir: rec.dir, opcode: rec.opcode, size }], rec, out);
        s.appProtocol = s._ws.dominantProtocol() ?? s.appProtocol;
        break;
      }
      case 'ws.frame_meta': { const s = this._stream(rec.sid, { kind: 'ws' }); s.metadataOnlyFrames = (s.metadataOnlyFrames ?? 0) + 1; s.metadataOnlyFrameBytes = (s.metadataOnlyFrameBytes ?? 0) + (rec.size ?? 0); break; }
      case 'ws.error': { const s = this._stream(rec.sid, { kind: 'ws' }); s.frameErrors = (s.frameErrors ?? 0) + 1; s.error = rec.error ?? s.error; break; }
      case 'ws.close': { const s = this._stream(rec.sid, { kind: 'ws' }); s.status = 'closed'; s.endT = rec.t; this._finish(s, rec, out); break; }
      case 'gap': {
        this.gaps.push(rec);
        for (const sid of rec.sids ?? []) { const s = this._touch(sid); if (s) { s.gaps++; s.coverage = 'gap_in_stream'; } }
        break;
      }
      case 'nav': this.nav.push(rec); break;
      case 'action': this.actions.push(rec); break;
      case 'dom.batch': {
        this.dom.batches++;
        for (const m of rec.items ?? []) {
          this.dom.mutations++;
          const b = this.dom.blocks.get(m.id) ?? { id: m.id, sig: m.sig, firstT: rec.t, revisions: 0 };
          b.revisions++; b.lastT = rec.t; b.text = m.text ?? b.text; b.tag = m.tag ?? b.tag; b.removed = m.op === 'removed';
          this.dom.blocks.set(m.id, b);
        }
        break;
      }
      case 'reconnect.attempt':
      case 'reconnect.ok':
      case 'reconnect.failed': {
        this.connectionEvents.push({ seq: rec.seq, t: rec.t, k: rec.k, reason: rec.reason, attempt: rec.attempt, error: rec.error });
        for (const sid of rec.openStreams ?? []) { const s = this._touch(sid); if (s) { s.coverage = 'devtools_connection_lost_during_stream'; s.connectionLosses = (s.connectionLosses ?? 0) + 1; } }
        this.lifecycle.push(rec);
        break;
      }
      case 'lifecycle': this.lifecycle.push(rec); break;
      case 'pause': for (const sid of rec.openStreams ?? []) { const s = this._touch(sid); if (s) { s.coverage = 'paused_during_stream'; s.pausedGaps = (s.pausedGaps ?? 0) + 1; } } this.lifecycle.push(rec); break;
      case 'resume': this.lifecycle.push(rec); this.paused = (this.paused ?? []).concat([{ ms: rec.pausedMs, notCaptured: rec.notCaptured }]); break;
      default: break;
    }
    return out;
  }

  // Convenience: ingest a whole (async)iterable of raw records, returning all derived events.
  ingestAll(records) {
    const out = [];
    for (const rec of records ?? []) out.push(...this.ingest(rec));
    return out;
  }

  async ingestStream(asyncRecords, onEvents) {
    let n = 0;
    for await (const rec of asyncRecords) {
      const evs = this.ingest(rec);
      n++;
      if (evs.length && onEvents) await onEvents(evs, rec);
    }
    return n;
  }

  _finish(s, rec, out) {
    if (s._dec) this._emitEvents(s, s._dec.end(), rec, out);
    if (s._ws) s._ws.end();
    s._delta.finalize({ complete: s.status === 'complete' || s.status === 'closed' });
    s.transport = transportOf(s);
    s.transportDetail = transportDetailOf(s);
  }

  // Stream-local summary body (everything that depends only on this stream's own state).
  // Key order matches the historical output; idleMs keeps its slot with a placeholder that
  // summary() overwrites with the clock-dependent value.
  _streamSummary(s) {
    const d = s._delta;
    const o = {
      ...s,
      transport: s.transport ?? transportOf(s),
      transportDetail: s.transportDetail ?? transportDetailOf(s),
      deltaRevisions: d.revisions,
      deltaDialects: [...d.detected],
      deltaUnapplied: d.unapplied,
      deltaOps: { ...d.ops },
      streaming: STREAMING_SET.has(s.transport ?? transportOf(s)),
    };
    if (d.errors.length) o.deltaErrors = d.errors.slice(0, 3);
    if (s.channels) o.channels = [...s.channels].slice(0, 50);
    if (s.frameTypes) o.frameTypes = [...s.frameTypes].slice(0, 50);
    if (s.interarrivalN) o.avgChunkGapMs = Math.round(s.interarrivalSum / s.interarrivalN);
    if (s.status === 'open' && s.lastChunkT) o.idleMs = 0;
    if (s.firstChunkT && (s.endT ?? s.lastChunkT)) {
      const dur = (s.endT ?? s.lastChunkT) - s.firstChunkT;
      o.durationMs = dur;
      if (dur > 0) o.bytesPerSec = Math.round((s.bytes / dur) * 1000);
    }
    delete o.interarrivalSum; delete o.interarrivalN;
    return o;
  }

  // Role classification of one stream (see replay/stream-role.mjs). Reads the in-memory event window,
  // the assembled document and the built-in stream maps, so it is NOT free: it runs only on explicit
  // request (summary({ includeStreamRoles: true }) / streamRole()) and is memoised per stream until the
  // stream changes. A bounded event window (maxEventsPerStream) or keepEvents:false is reported to the
  // classifier as events held only on disk, which it reports as incomplete_capture.
  _roleFor(s, base) {
    if (s._sum.role) return s._sum.role;
    const events = this.keepEvents ? s._events : [];
    const summaryRow = !this.keepEvents && base.events > 0 && !(base.eventsOnlyOnDisk > 0) ? { ...base, eventsOnlyOnDisk: base.events } : base;
    let map = null;
    if (s.kind !== 'ws' && events.length) {
      try {
        const det = detectStreamMap(events);
        if (det.map) map = applyStreamMap(det.map, events);
      } catch { map = null; }
    }
    const r = this.roleClassifier({ summary: summaryRow, events, assembled: s._delta.revisions > 0 ? this.assembled(s.sid) : null, map });
    // coverage (additive): what the verdict actually examined. A custom roleClassifier may omit it.
    const role = { role: r.role, confidence: r.confidence, evidence: r.evidence, coverage: r.coverage ?? null };
    s._sum.role = role;
    return role;
  }

  // { role, confidence, evidence } for one stream, or null when the sid is unknown. Returns copies.
  streamRole(sid) {
    const s = this.streams.get(sid);
    if (!s) return null;
    if (!s._sum.base) s._sum.base = this._streamSummary(s);
    const r = this._roleFor(s, s._sum.base);
    return { role: r.role, confidence: r.confidence, evidence: r.evidence.map((e) => ({ ...e })), coverage: r.coverage ? structuredClone(r.coverage) : null };
  }

  // Summary for UI / receipts (no payload content).
  // includeStreamRoles (default false: output and cost are unchanged) adds role / roleConfidence /
  // roleEvidence / roleCoverage to every stream row and roleCounts to the result.
  summary({ now = Date.now(), includeStreamRoles = false } = {}) {
    // The 1 s status tick used to rebuild every stream's summary from scratch. The stream-local part
    // is now memoised per stream (invalidated whenever ingest touches it); only the clock-dependent
    // idleMs and the cross-stream reconnect annotations below are computed per call, on a fresh copy
    // (so callers can never mutate the memo).
    const streams = [];
    for (const s of this.streams.values()) {
      let base = s._sum.base;
      if (!base) base = s._sum.base = this._streamSummary(s);
      const o = { ...base };
      o.deltaDialects = [...base.deltaDialects];
      o.deltaOps = { ...base.deltaOps };
      if (base.deltaErrors) o.deltaErrors = base.deltaErrors.slice();
      if (base.channels) o.channels = base.channels.slice();
      if (base.frameTypes) o.frameTypes = base.frameTypes.slice();
      if (s.status === 'open' && s.lastChunkT) o.idleMs = now - s.lastChunkT;
      if (includeStreamRoles) {
        const r = this._roleFor(s, base);
        o.role = r.role;
        o.roleConfidence = r.confidence;
        o.roleEvidence = r.evidence.map((e) => ({ ...e }));
        if (r.coverage) o.roleCoverage = structuredClone(r.coverage);
      }
      streams.push(o);
    }
    // Reconnects: a stream to the same endpoint that starts soon after another one failed/closed.
    const ep = (s) => { try { const u = new URL(s.url); return `${s.method ?? s.kind}|${u.host}${u.pathname}`; } catch { return s.url; } };
    const byEndpoint = new Map();
    for (const s of streams) { const k = ep(s); if (!byEndpoint.has(k)) byEndpoint.set(k, []); byEndpoint.get(k).push(s); }
    for (const list of byEndpoint.values()) {
      list.sort((a, b) => (a.startedT ?? 0) - (b.startedT ?? 0));
      for (let i = 0; i < list.length; i++) {
        const s = list[i];
        if (!['failed', 'canceled', 'closed', 'incomplete_at_stop'].includes(s.status) || !s.endT) continue;
        const next = list.slice(i + 1).find((x) => (x.startedT ?? Infinity) >= s.endT && x.startedT - s.endT < 60_000 && !x.reconnectOf);
        if (!next) continue;
        next.reconnectOf = s.sid;
        next.reconnectAfterMs = next.startedT - s.endT;
        next.lifecycleNote = `reconnect ${Math.round(next.reconnectAfterMs / 100) / 10}s after ${s.sid} ${s.status}`;
        if (s.lastEventId !== undefined) next.resumeCandidateFrom = s.lastEventId;
        s.reconnectedAs = next.sid;
      }
      // Chain depth: how many times this endpoint has been re-established.
      let depth = 0;
      for (const s of list) { if (s.reconnectOf) { depth++; s.reconnectIndex = depth; } }
      if (depth) for (const s of list) s.reconnectChainLength = depth + 1;
    }
    const counts = {};
    const detailCounts = {};
    for (const s of streams) {
      counts[s.transport] = (counts[s.transport] ?? 0) + 1;
      detailCounts[s.transportDetail] = (detailCounts[s.transportDetail] ?? 0) + 1;
    }
    const roleCounts = includeStreamRoles ? Object.fromEntries(STREAM_ROLES.map((r) => [r, streams.filter((x) => x.role === r).length])) : undefined;
    return {
      streams, transportCounts: counts, transportDetailCounts: detailCounts,
      ...(roleCounts ? { roleCounts } : {}),
      gaps: this.gaps.length, navs: this.nav.length, actions: this.actions.length,
      domBatches: this.dom.batches, domBlocks: this.dom.blocks.size,
      appProtocols: Object.fromEntries(this.protocols),
      totals: { ...this.totals },
      connectionEvents: this.connectionEvents.length,
      stalledStreams: streams.filter((s) => s.stalls > 0).length,
    };
  }

  eventsOf(sid) { return this.streams.get(sid)?._events ?? []; }
  deltaOf(sid) { return this.streams.get(sid)?._delta ?? null; }
  decoderOf(sid) { const s = this.streams.get(sid); return s ? decoderInfo(s._dec, s._ws) : null; }
  textOf(sid) { return this.streams.get(sid)?._delta?.primaryText?.(1); }
  assembled(sid) {
    const s = this.streams.get(sid);
    if (!s) return null;
    return { doc: s._delta.doc, revisions: s._delta.revisions, texts: s._delta.texts(1).slice(0, 20), stats: s._delta.stats(), blocks: s._delta.blocks().slice(0, 50) };
  }
  assembledAll({ minRevisions = 1 } = {}) {
    const out = {};
    for (const s of this.streams.values()) if (s._delta.revisions >= minRevisions) out[s.sid] = { revisions: s._delta.revisions, dialects: [...s._delta.detected], doc: s._delta.doc };
    return out;
  }
  // Ordered, content-free event trail useful for timelines and health views.
  timeline({ limit = 500 } = {}) {
    const rows = [
      ...this.nav.map((r) => ({ t: r.t, seq: r.seq, k: 'nav', detail: r.kind })),
      ...this.actions.map((r) => ({ t: r.t, seq: r.seq, k: 'action', detail: r.kind })),
      ...this.gaps.map((r) => ({ t: r.t, seq: r.seq, k: 'gap', detail: `${r.droppedRecords ?? 0} records` })),
      ...this.lifecycle.map((r) => ({ t: r.t, seq: r.seq, k: r.k ?? 'lifecycle', detail: r.event ?? r.reason })),
    ].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
    return rows.slice(-limit);
  }
  rawBytesOf() { return null; } // raw bytes are read back from disk on demand (see replay/derive.mjs)

  // Build a reducer from an iterable of raw records in one call.
  static replay(records, opts = {}) {
    const r = new StreamReducer(opts);
    r.ingestAll(records);
    return r;
  }
}
