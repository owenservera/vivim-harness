// Live decoded-event tap: real-time view of a recording while it is still running.
//
//   const tap = createLiveTap(recorder, { kinds, decode = true });   // or recorder.tap(opts)
//   tap.on('text', ({ sid, delta, text }) => process.stdout.write(delta));
//
// Events (all payloads are plain objects; listeners run on a deferred tick, never inside the
// recorder's append path):
//   'record'        raw record exactly as persisted ({ seq, t, k, ... }), filtered by `kinds`
//   'stream-open'   { sid, url, transport, kind, method, mime, target, joinedLate, t }
//   'event'         { sid, seq, t, data, dialect, applied, revision, view, degraded }
//                   data = the decoded L2 event (SSE event, NDJSON line, WS frame, ...);
//                   dialect = delta dialect of its JSON payload ('json-patch', 'typed-events',
//                   'document', ...) or null when the payload is not reconstructable.
//   'text'          { sid, seq, t, delta, text, path, revision, replaced }
//                   live delta assembly: `text` is the current human-visible text of the
//                   stream, `delta` the appended suffix (or the whole text when replaced=true).
//   'stream-update' { sid, transport, from, appProtocol }   transport refined after open
//   'stream-close'  { sid, t, stats }
//   'target'        { targetId, type, url, tag, role, state }   recorded tab / popup / worker
//   'lag'           { state: 'dropping' | 'recovered', droppedRecords, sids, since }
//   'close'         {}
//
// Options:
//   kinds        which raw records reach 'record': null/'*' = all, array/Set/comma string of
//                record kinds ('chunk', 'ws.frame'; prefix wildcards like 'ws.*'), or a predicate.
//                Stream decoding always sees every record regardless of this filter.
//   decode       true (default): incremental per-stream decoding (AutoDecoder / WsFrameDecoder)
//                and live delta assembly (DeltaAssembler). false: structure only.
//   text         true (default): emit 'text'. plainText (default true) also streams raw
//                text/plain bodies and non-JSON SSE data as text.
//   streams      'data' (default): a stream opens when its first payload arrives;
//                'all': every observed request / socket opens (metadata-only ones included).
//   deltaDialect delta dialect override; default = the recorder profile's decode.delta or 'auto'.
//   maxQueue / maxQueueBytes / sliceMs / sync   backpressure controls (see below).
//
// Backpressure: Chrome cannot be slowed down, and the recorder must never wait for a viewer.
// Records are queued (bounded by maxQueue records and maxQueueBytes) and drained in time slices
// of sliceMs. When the tap falls behind, PAYLOAD records (chunks, frames, messages) are dropped
// first, never structure (req/res/done/fail/ws.open/ws.close/run.*), so streams still open and
// close correctly. Every affected stream is marked degraded with a count, a 'lag' event is
// emitted at the start and the end of the episode, and the durable raw log is unaffected (the
// tap is a preview; disk remains the source of truth). Drops by the raw log itself (local disk
// queue overflow) are detected too and degrade the affected streams the same way.
import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';
import { AutoDecoder, WsFrameDecoder, decodeWsPayload, sniffEnvelope, unwrapNestedJson } from '../decode/decoders.mjs';
import { DeltaAssembler, detectDialect } from '../decode/delta.mjs';
import { transportOf } from '../replay/reducer.mjs';
import { redactUrl } from './redact.mjs';

export const LIVE_TAP_EVENTS = Object.freeze(['record', 'stream-open', 'event', 'text', 'stream-update', 'stream-close', 'target', 'lag', 'close', 'warn']);

// Structural records are tiny and keep stream lifecycles correct; they are never dropped.
const STRUCTURAL = new Set(['run.start', 'run.end', 'req', 'res', 'done', 'fail', 'ws.open', 'ws.close', 'ws.error', 'ws.handshake',
  'body.excluded', 'body.truncated', 'stream.armed', 'stream.arm_failed', 'gap', 'reconnect.attempt', 'reconnect.ok', 'reconnect.failed',
  'pause', 'resume', 'lifecycle', 'nav']);

export function kindMatcher(kinds) {
  if (kinds === undefined || kinds === null || kinds === '*' || kinds === true) return () => true;
  if (kinds === false) return () => false;
  if (typeof kinds === 'function') return (rec) => { try { return !!kinds(rec); } catch { return false; } };
  const list = (typeof kinds === 'string' ? kinds.split(',') : [...kinds]).map((s) => String(s).trim()).filter(Boolean);
  const exact = new Set(), prefixes = [];
  for (const k of list) {
    if (k === '*') return () => true;
    if (k.endsWith('*')) prefixes.push(k.slice(0, -1)); else exact.add(k);
  }
  return (rec) => exact.has(rec.k) || (prefixes.length > 0 && prefixes.some((p) => String(rec.k).startsWith(p)));
}

function approxSize(rec) {
  return 256 + (rec.b64?.length ?? 0) + (typeof rec.payload === 'string' ? rec.payload.length : 0) + (typeof rec.data === 'string' ? rec.data.length : 0)
    + (Array.isArray(rec.items) ? rec.items.length * 128 : 0);
}

const now = () => (globalThis.performance?.now ? globalThis.performance.now() : Date.now());

export class LiveTap extends EventEmitter {
  constructor(source, {
    kinds = null, decode = true, text = true, plainText = true, streams = 'data', deltaDialect = null,
    maxQueue = 50_000, maxQueueBytes = 64 * 1024 * 1024, sliceMs = 8, sync = false, maxStreams = 10_000,
  } = {}) {
    super();
    this.setMaxListeners(100);
    this.source = source;
    this.match = kindMatcher(kinds);
    this.decode = decode !== false;
    this.textEnabled = text !== false;
    this.plainText = plainText !== false;
    this.openOn = streams === 'all' ? 'start' : 'data';
    this.deltaDialect = deltaDialect;
    this.maxQueue = maxQueue;
    this.maxQueueBytes = maxQueueBytes;
    this.sliceMs = sliceMs;
    this.sync = !!sync;
    this.maxStreams = maxStreams;
    this.closed = false;
    this.streams = new Map();                 // sid -> live stream state
    this.queue = []; this.qHead = 0; this.queueBytes = 0;
    this._scheduled = false;
    this._pendingDegrade = new Map();         // sid -> { n, reason }
    this._lag = null;
    this._s = {
      received: 0, processed: 0, dropped: 0, rawDropped: 0, recordsEmitted: 0, events: 0, textUpdates: 0,
      streamsOpened: 0, streamsClosed: 0, untracked: 0, lagEpisodes: 0, errors: 0, maxQueueSeen: 0, maxQueueBytesSeen: 0,
    };
    this.createdAt = Date.now();
    // A tap created mid-run cannot see what was decoded before it existed.
    this.joinedMidRun = source?.state === 'recording';

    this._onRecord = (rec) => { if (rec?.k === 'run.start') this._hookRaw(); this.ingest(rec); };
    this._onTarget = (t) => { if (!this.closed) this._safeEmit('target', t); };
    this._onStarted = () => this._hookRaw();
    this._onDrop = (d) => {
      this._s.rawDropped++;
      if (d?.sid) this._degradeLater(d.sid, 'raw_log_queue_overflow');
    };
    if (source && typeof source.on === 'function') {
      source.on('record', this._onRecord);
      source.on('target', this._onTarget);
      source.on('started', this._onStarted);
    }
    this._hookRaw();
    // Targets already being recorded are announced once listeners had a chance to attach.
    if (source?.targets instanceof Map && source.targets.size) {
      setImmediate(() => {
        if (this.closed) return;
        for (const e of source.targets.values()) {
          if (e.attaching) continue;
          this._safeEmit('target', { targetId: e.targetId, type: e.type, url: this.source?.privacy?.url(e.url ?? '') ?? redactUrl(e.url ?? ''), tag: e.tag, role: e.role, state: 'attached', snapshot: true });
        }
      });
    }
  }

  _hookRaw() {
    const raw = this.source?.session?.raw;
    if (!raw || raw === this._raw || typeof raw.on !== 'function') return;
    this._raw?.off?.('drop', this._onDrop);
    this._raw = raw;
    raw.on('drop', this._onDrop);
  }

  // Public: feed a record directly (used by the recorder subscription, and usable for replays).
  ingest(rec) {
    if (this.closed || !rec) return false;
    this._s.received++;
    if (this.sync) { this._processSafe(rec); return true; }
    const size = approxSize(rec);
    const depth = this.queue.length - this.qHead;
    if (!STRUCTURAL.has(rec.k) && (depth >= this.maxQueue || this.queueBytes + size > this.maxQueueBytes)) {
      this._drop(rec);
      return false;
    }
    this.queue.push({ rec, size });
    this.queueBytes += size;
    if (depth + 1 > this._s.maxQueueSeen) this._s.maxQueueSeen = depth + 1;
    if (this.queueBytes > this._s.maxQueueBytesSeen) this._s.maxQueueBytesSeen = this.queueBytes;
    this._schedule();
    return true;
  }

  _drop(rec) {
    this._s.dropped++;
    let started = false;
    if (!this._lag) {
      this._lag = { droppedRecords: 0, sids: new Set(), since: Date.now(), fromSeq: rec.seq };
      this._s.lagEpisodes++;
      started = true;
    }
    this._lag.droppedRecords++;
    this._lag.toSeq = rec.seq;
    if (rec.sid) { this._lag.sids.add(rec.sid); this._degradeLater(rec.sid, 'tap_queue_overflow'); }
    if (started) {
      this._safeEmit('lag', {
        state: 'dropping', droppedRecords: this._lag.droppedRecords, sids: [...this._lag.sids].slice(0, 200),
        since: this._lag.since, fromSeq: rec.seq, queued: this.queue.length - this.qHead, queueBytes: this.queueBytes,
      });
    }
  }

  _degradeLater(sid, reason) {
    const p = this._pendingDegrade.get(sid) ?? { n: 0, reasons: new Set() };
    p.n++; p.reasons.add(reason);
    this._pendingDegrade.set(sid, p);
  }

  _schedule() {
    if (this._scheduled || this.closed) return;
    this._scheduled = true;
    setImmediate(() => this._drain());
  }

  _drain(budgetMs = this.sliceMs) {
    this._scheduled = false;
    const deadline = now() + Math.max(1, budgetMs);
    while (this.qHead < this.queue.length) {
      const item = this.queue[this.qHead];
      this.queue[this.qHead++] = undefined;
      this.queueBytes -= item.size;
      this._processSafe(item.rec);
      if (now() >= deadline) break;
    }
    if (this.qHead > 1024 && this.qHead * 2 > this.queue.length) { this.queue = this.queue.slice(this.qHead); this.qHead = 0; }
    if (this.qHead >= this.queue.length) { this.queue = []; this.qHead = 0; this.queueBytes = 0; }
    if (this._lag && this.queueBytes <= this.maxQueueBytes / 2 && (this.queue.length - this.qHead) <= this.maxQueue / 2) {
      const l = this._lag; this._lag = null;
      this._safeEmit('lag', { state: 'recovered', droppedRecords: l.droppedRecords, sids: [...l.sids].slice(0, 200), since: l.since, until: Date.now(), fromSeq: l.fromSeq, toSeq: l.toSeq });
    }
    if (this.qHead < this.queue.length) this._schedule();
  }

  _safeEmit(evt, payload) {
    if (!this.listenerCount(evt)) return false;
    try { return this.emit(evt, payload); }
    catch (e) {
      this._s.errors++;
      if (evt !== 'warn' && this.listenerCount('warn')) { try { this.emit('warn', { where: `listener:${evt}`, error: String(e?.message ?? e) }); } catch { /* ignore */ } }
      return false;
    }
  }

  _processSafe(rec) {
    try { this._process(rec); }
    catch (e) {
      this._s.errors++;
      this._safeEmit('warn', { where: 'process', k: rec?.k, sid: rec?.sid, error: String(e?.message ?? e) });
    }
    this._s.processed++;
  }

  // ------------------------------------------------------------------------------------------
  // Stream state
  // ------------------------------------------------------------------------------------------
  _newStream(sid, init, rec) {
    if (this.streams.size >= this.maxStreams) { this._s.untracked++; return null; }
    const st = {
      sid, kind: 'http', url: undefined, method: undefined, mime: undefined, target: undefined,
      chunks: 0, bytes: 0, frames: 0, esMessages: 0, metaFrames: 0, events: 0, textUpdates: 0,
      opened: false, closed: false, transport: null, decoder: undefined, appProtocol: undefined,
      degraded: false, degradedReasons: new Set(), droppedRecords: 0, joinedLate: false,
      startedT: rec?.t ?? Date.now(), dec: null, ws: null, delta: null, sd: null, plain: '',
      lastText: undefined, lastPath: undefined, primaryView: null, ...init,
    };
    this.streams.set(sid, st);
    return st;
  }

  // A stream first seen mid-flight (tap created during the run, or structure dropped upstream).
  _lateStream(rec, kind) {
    const known = this.source?.reducer?.streams?.get?.(rec.sid);
    const st = this._newStream(rec.sid, {
      kind, joinedLate: true,
      url: known?.url, method: known?.method, mime: known?.mime, target: known?.target, startedT: known?.startedT ?? rec.t,
    }, rec);
    if (!st) return null;
    // Bytes before this point were never seen by this tap: decoding starts mid-stream.
    if (kind === 'http') this._degrade(st, 'joined_mid_stream', 0);
    return st;
  }

  _get(rec, kind) {
    if (!rec.sid) return null;
    return this.streams.get(rec.sid) ?? this._lateStream(rec, kind);
  }

  _degrade(st, reason, n = 1) {
    st.degraded = true;
    st.degradedReasons.add(reason);
    st.droppedRecords += n;
  }

  _applyPendingDegrade(st) {
    const p = this._pendingDegrade.get(st.sid);
    if (!p) return;
    this._pendingDegrade.delete(st.sid);
    for (const r of p.reasons) st.degradedReasons.add(r);
    st.degraded = true;
    st.droppedRecords += p.n;
  }

  _transport(st) {
    return transportOf({ kind: st.kind, esMessages: st.esMessages, decoder: st.decoder, chunks: st.chunks });
  }

  _open(st, rec) {
    if (st.opened) return;
    st.opened = true;
    st.transport = this._transport(st);
    this._s.streamsOpened++;
    this._safeEmit('stream-open', {
      sid: st.sid, url: st.url ?? null, transport: st.transport, kind: st.kind, method: st.method, mime: st.mime,
      target: st.target, joinedLate: st.joinedLate || undefined, lateJoin: st.lateJoin || undefined, t: rec?.t ?? Date.now(),
    });
  }

  _refreshTransport(st) {
    if (!st.opened) return;
    const t = this._transport(st);
    if (t === st.transport && st.appProtocol === st._announcedProtocol) return;
    const from = st.transport;
    st.transport = t;
    st._announcedProtocol = st.appProtocol;
    this._safeEmit('stream-update', { sid: st.sid, transport: t, from, appProtocol: st.appProtocol, decoder: st.decoder, decoderSwitch: st.dec?.switched ?? undefined });
  }

  _dialect() {
    return this.deltaDialect ?? this.source?.profile?.decode?.delta ?? 'auto';
  }

  // ------------------------------------------------------------------------------------------
  // Record processing
  // ------------------------------------------------------------------------------------------
  _process(rec) {
    if (this.match(rec) && this.listenerCount('record')) { this._s.recordsEmitted++; this._safeEmit('record', rec); }
    switch (rec.k) {
      case 'run.start':
        for (const st of [...this.streams.values()]) this._finish(st, rec, 'superseded_by_new_run');
        this.joinedMidRun = false;
        break;
      case 'run.end':
        for (const st of [...this.streams.values()]) this._finish(st, rec, 'incomplete_at_stop');
        break;
      case 'req': {
        // Redirect hops reuse the sid; the previous hop is closed by its own 'done'.
        const prev = this.streams.get(rec.sid);
        if (prev) this._finish(prev, rec, 'superseded');
        const st = this._newStream(rec.sid, { kind: 'http', url: rec.url, method: rec.method, resourceType: rec.type, target: rec.target, policy: rec.policy }, rec);
        if (st) { this._applyPendingDegrade(st); if (this.openOn === 'start') this._open(st, rec); }
        break;
      }
      case 'res': {
        const st = this._get(rec, 'http'); if (!st) break;
        if (!rec.redirect) { st.mime = rec.mime; st.statusCode = rec.status; st.fromServiceWorker = rec.fromServiceWorker || undefined; }
        break;
      }
      case 'body.excluded': { const st = this._get(rec, 'http'); if (st) st.bodyExcluded = rec.reason; break; }
      case 'body.truncated': { const st = this.streams.get(rec.sid); if (st) { st.truncated = true; this._degrade(st, 'truncated_at_byte_cap', 0); } break; }
      case 'chunk':
      case 'body': { const st = this._get(rec, 'http'); if (st) this._bytes(st, rec); break; }
      case 'es.msg': { const st = this._get(rec, 'http'); if (st) this._eventSource(st, rec); break; }
      case 'ws.open': {
        const prev = this.streams.get(rec.sid);
        if (prev) this._finish(prev, rec, 'superseded');
        const st = this._newStream(rec.sid, { kind: 'ws', url: rec.url, target: rec.target, lateJoin: !!rec.lateJoin, policy: rec.policy }, rec);
        if (st) { if (rec.lateJoin) this._degrade(st, 'socket_opened_before_observation', 0); this._applyPendingDegrade(st); this._open(st, rec); }
        break;
      }
      case 'ws.frame': { const st = this._get(rec, 'ws'); if (st) this._frame(st, rec); break; }
      case 'ws.frame_meta': { const st = this._get(rec, 'ws'); if (st) { st.metaFrames++; this._open(st, rec); } break; }
      case 'ws.error': { const st = this.streams.get(rec.sid); if (st) st.error = rec.error; break; }
      case 'done': { const st = this.streams.get(rec.sid); if (st) this._finish(st, rec, 'complete'); break; }
      case 'fail': { const st = this.streams.get(rec.sid); if (st) { st.error = rec.errorText; this._finish(st, rec, rec.canceled ? 'canceled' : 'failed'); } break; }
      case 'ws.close': { const st = this.streams.get(rec.sid); if (st) this._finish(st, rec, 'closed'); break; }
      case 'gap':
        for (const sid of rec.sids ?? []) { const st = this.streams.get(sid); if (st) this._degrade(st, 'raw_log_gap', 0); }
        break;
      case 'reconnect.attempt':
        for (const sid of rec.openStreams ?? []) { const st = this.streams.get(sid); if (st) this._degrade(st, 'devtools_connection_lost', 0); }
        break;
      case 'pause':
        for (const sid of rec.openStreams ?? []) { const st = this.streams.get(sid); if (st) this._degrade(st, 'paused_during_stream', 0); }
        break;
      default: break;
    }
  }

  _bytes(st, rec) {
    this._applyPendingDegrade(st);
    const buf = Buffer.from(rec.b64 ?? '', 'base64');
    st.chunks++; st.bytes += buf.length;
    if (rec.k === 'body') st.retrospective = true;
    let evs = [];
    if (this.decode && !st.noDecode) {
      st.dec ??= new AutoDecoder({ mime: st.mime });
      try { evs = st.dec.push(buf); }
      catch (e) { st.noDecode = true; st.decodeError = String(e?.message ?? e); }
      st.decoder = st.dec.kind;
    }
    this._open(st, rec);
    this._refreshTransport(st);
    this._emitDecoded(st, evs, rec, 'bytes');
    if (this.decode && this.plainText) this._plainBytes(st, buf, rec);
  }

  // text/plain streaming bodies (common for token streams) carry no events; surface them as text.
  _plainBytes(st, buf, rec) {
    if (st.decoder !== 'text' || st.delta?.revisions) return;
    if (st.mime && !/^text\/plain/i.test(st.mime)) return;
    st.sd ??= new StringDecoder('utf8');
    const s = st.sd.write(buf);
    if (s) this._appendPlain(st, s, rec);
  }

  _appendPlain(st, s, rec) {
    st.plain += s;
    if (!this.textEnabled) return;
    st.lastText = st.plain; st.lastPath = '(plain)';
    st.textUpdates++; this._s.textUpdates++;
    this._safeEmit('text', { sid: st.sid, seq: rec.seq, t: rec.t, delta: s, text: st.plain, path: '(plain)' });
  }

  _eventSource(st, rec) {
    this._applyPendingDegrade(st);
    st.esMessages++;
    const env = sniffEnvelope(rec.data ?? '');
    const ev = { type: 'eventsource', event: rec.eventName || 'message', id: rec.eventId || undefined, data: rec.data, browserParsed: true };
    if (env?.json !== undefined) ev.json = env.json;
    if (env?.envelope && !env.headerOnly) ev.envelope = env.envelope;
    if (ev.json !== undefined) { const nested = unwrapNestedJson(ev.json); if (nested) ev.jsonNested = nested; }
    const trimmed = String(rec.data ?? '').trim();
    if (trimmed === '[DONE]' || /^(done|complete|completed|end)$/i.test(String(rec.eventName ?? ''))) ev.terminal = true;
    if (!trimmed || trimmed === '{}' || /^(ping|pong|heartbeat)$/i.test(trimmed)) ev.heartbeat = true;
    this._open(st, rec);
    this._refreshTransport(st);
    this._emitDecoded(st, this.decode ? [ev] : [], rec, 'browser');
  }

  _frame(st, rec) {
    this._applyPendingDegrade(st);
    st.frames++;
    const size = rec.opcode === 2 ? Buffer.from(rec.payload ?? '', 'base64').length : Buffer.byteLength(rec.payload ?? '');
    st.bytes += size;
    let evs = [];
    if (this.decode) {
      st.ws ??= new WsFrameDecoder();
      try {
        evs = st.ws.push({ opcode: rec.opcode, payload: rec.payload, dir: rec.dir, t: rec.t });
        if (!evs.length) evs = [{ ...decodeWsPayload(rec), dir: rec.dir, opcode: rec.opcode, size }];
        for (const e of evs) { if (e.size === undefined) e.size = size; e.dir ??= rec.dir; }
        st.appProtocol = st.ws.dominantProtocol() ?? st.appProtocol;
      } catch (e) { st.decodeError = String(e?.message ?? e); evs = []; }
    }
    this._open(st, rec);
    this._refreshTransport(st);
    this._emitDecoded(st, evs, rec, 'frames');
  }

  _emitDecoded(st, evs, rec, view) {
    if (!evs?.length) return;
    const wantEvent = this.listenerCount('event') > 0;
    for (const ev of evs) {
      st.events++; this._s.events++;
      // EventSource streams can be seen twice (armed bytes + browser-parsed messages). The first
      // view that produced an event feeds reconstruction; the other is reported, not re-applied.
      st.primaryView ??= view;
      const secondary = st.primaryView !== view;
      const forDelta = ev.jsonNested?.json !== undefined ? ev.jsonNested.json : ev.json;
      let dialect = null, applied = false, revision;
      if (this.decode && !secondary && forDelta !== undefined && !ev.heartbeat) {
        st.delta ??= new DeltaAssembler({ dialect: this._dialect(), opsLog: 0 });
        const declared = st.delta.dialect === 'auto' ? detectDialect(forDelta) : st.delta.dialect;
        applied = st.delta.apply(forDelta);
        dialect = declared ?? (applied ? 'document' : null);
        if (applied) revision = st.delta.revisions;
      }
      if (wantEvent) {
        this._safeEmit('event', {
          sid: st.sid, seq: rec.seq, t: rec.t, data: ev, dialect, applied, revision, view,
          ...(secondary ? { secondaryView: true } : {}), ...(st.degraded ? { degraded: true } : {}),
        });
      }
      if (applied) this._text(st, rec, revision);
      else if (!secondary && this.plainText && !ev.heartbeat && !ev.terminal && ev.json === undefined && (ev.type === 'sse' || ev.type === 'eventsource')
        && typeof ev.data === 'string' && ev.data && !st.delta?.revisions) {
        this._appendPlain(st, ev.data, rec); // token-per-event SSE without JSON
      }
    }
  }

  // Live delta assembly -> current visible text. Cheap path: the leaf that grew last time.
  _text(st, rec, revision) {
    if (!this.textEnabled || !this.listenerCount('text')) return;
    const a = st.delta;
    const prev = st.lastText ?? '';
    let text, path;
    if (st.lastPath && st.lastPath.startsWith('/') && st.lastPath !== '/blocks') {
      const v = a.textOf(st.lastPath);
      if (typeof v === 'string' && v !== prev && v.startsWith(prev)) { text = v; path = st.lastPath; }
    }
    if (text === undefined) {
      const blocks = a.blocks();
      const joined = blocks.map((b) => (typeof b.text === 'string' ? b.text : '')).filter(Boolean).join('\n');
      if (joined) { text = joined; path = '/blocks'; }
      else { const top = a.texts(1)[0]; if (top) { text = top.text; path = top.path; } }
    }
    if (text === undefined || text === prev) return;
    const appended = prev.length > 0 && text.startsWith(prev);
    const delta = appended || !prev ? text.slice(prev.length) : text;
    st.lastText = text; st.lastPath = path;
    st.textUpdates++; this._s.textUpdates++;
    this._safeEmit('text', {
      sid: st.sid, seq: rec.seq, t: rec.t, delta, text, path, revision,
      ...(!appended && prev ? { replaced: true } : {}), ...(st.degraded ? { degraded: true } : {}),
    });
  }

  _finish(st, rec, status) {
    if (st.closed) return;
    st.closed = true;
    st.status = status;
    st.endT = rec?.t ?? Date.now();
    if (this.decode && st.dec && !st.noDecode) {
      let evs = [];
      try { evs = st.dec.end(); } catch (e) { st.decodeError = String(e?.message ?? e); }
      if (evs.length) { this._open(st, rec); this._emitDecoded(st, evs, rec ?? { t: st.endT }, 'bytes'); }
    }
    if (st.sd) { const tail = st.sd.end(); if (tail) this._appendPlain(st, tail, rec ?? { t: st.endT }); }
    try { st.ws?.end(); } catch { /* ignore */ }
    if (this.openOn === 'start' && !st.opened) this._open(st, rec);
    if (st.opened) {
      this._refreshTransport(st);
      this._s.streamsClosed++;
      this._safeEmit('stream-close', { sid: st.sid, t: st.endT, stats: this._streamStats(st) });
    }
    this.streams.delete(st.sid);
  }

  _streamStats(st) {
    const d = st.delta?.stats?.();
    return {
      status: st.status, kind: st.kind, transport: st.transport ?? this._transport(st), decoder: st.decoder, appProtocol: st.appProtocol,
      url: st.url ?? null, method: st.method, mime: st.mime, statusCode: st.statusCode, target: st.target,
      chunks: st.chunks, bytes: st.bytes, frames: st.frames, metadataFrames: st.metaFrames || undefined, esMessages: st.esMessages,
      events: st.events, revisions: d?.revisions ?? 0, dialects: d?.dialects ?? [], unapplied: d?.unapplied ?? 0,
      textLength: st.lastText?.length ?? 0, textUpdates: st.textUpdates,
      degraded: st.degraded, degradedReasons: [...st.degradedReasons], droppedRecords: st.droppedRecords,
      joinedLate: st.joinedLate || undefined, lateJoin: st.lateJoin || undefined, retrospective: st.retrospective || undefined,
      truncated: st.truncated || undefined, bodyExcluded: st.bodyExcluded, error: st.error, decodeError: st.decodeError,
      decoderSwitch: st.dec?.switched ?? undefined, durationMs: (st.endT ?? Date.now()) - (st.startedT ?? st.endT ?? Date.now()),
    };
  }

  // ------------------------------------------------------------------------------------------
  // Public surface
  // ------------------------------------------------------------------------------------------
  // Current live state of open streams (no payloads), e.g. for a late-joining UI.
  openStreams() {
    return [...this.streams.values()].filter((s) => s.opened).map((s) => ({
      sid: s.sid, url: s.url ?? null, transport: s.transport, kind: s.kind, events: s.events, bytes: s.bytes,
      textLength: s.lastText?.length ?? 0, degraded: s.degraded,
    }));
  }

  // Current assembled text of one open stream (or undefined).
  textOf(sid) { return this.streams.get(sid)?.lastText; }

  // Process everything queued right now (synchronously).
  flush() { while (this.qHead < this.queue.length) this._drain(1e9); }

  stats() {
    let open = 0, degraded = 0;
    for (const s of this.streams.values()) { if (s.opened) open++; if (s.degraded) degraded++; }
    return {
      closed: this.closed, decode: this.decode, joinedMidRun: this.joinedMidRun,
      ...this._s,
      queued: this.queue.length - this.qHead, queueBytes: this.queueBytes, lagging: !!this._lag,
      streams: { tracked: this.streams.size, open, degraded, opened: this._s.streamsOpened, closed: this._s.streamsClosed },
      listeners: Object.fromEntries(LIVE_TAP_EVENTS.map((e) => [e, this.listenerCount(e)]).filter(([, n]) => n > 0)),
    };
  }

  close({ flush = true } = {}) {
    if (this.closed) return this.stats();
    if (flush) { try { this.flush(); } catch { /* ignore */ } }
    const src = this.source;
    if (src && typeof src.off === 'function') {
      src.off('record', this._onRecord);
      src.off('target', this._onTarget);
      src.off('started', this._onStarted);
    }
    this._raw?.off?.('drop', this._onDrop);
    for (const st of [...this.streams.values()]) this._finish(st, null, 'tap_closed');
    this.closed = true;
    this.queue = []; this.qHead = 0; this.queueBytes = 0;
    const final = this.stats();
    this._safeEmit('close', final);
    this.removeAllListeners();
    return final;
  }
}

export function createLiveTap(recorder, opts = {}) {
  return new LiveTap(recorder, opts);
}
