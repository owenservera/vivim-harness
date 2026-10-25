// L1 network capture for one tab (plus its auto-attached iframes/workers).
//
// Read-only by construction: uses Network.* observation only. It never uses Fetch.* interception
// (taking an intercepted body stream would require the collector to re-supply the response).
//
// Per in-scope response:
//   1. Network.streamResourceContent(requestId) is armed at responseReceived. Its bufferedData holds
//      bytes received before arming (recorded with pre:true); afterwards each Network.dataReceived
//      carries the next chunk as base64, in order.
//   2. If arming fails (unsupported, already finished, ...), the failure is recorded and, when the
//      profile allows, Network.getResponseBody is attempted at loadingFinished (marked retrospective).
//   3. WebSocket frames and browser-parsed EventSource messages are recorded as separate views.
import { EventEmitter } from 'node:events';
import { isSensitiveUrl } from './redact.mjs';
import { capturePrivacy } from './privacy.mjs';
import { ChunkCredentialGuard, FrameCredentialGuard } from './stream-guard.mjs';
import { inScope } from '../profiles/profiles.mjs';

export class NetworkRecorder extends EventEmitter {
  constructor({ append, profile, getPageUrl, options = {} }) {
    super();
    this.append = append;              // (rec) => seq|null  — writes to raw log + live pipeline
    this.profile = profile;
    this.privacy = capturePrivacy(profile);
    this.getPageUrl = getPageUrl;
    this.options = options;
    this.reqs = new Map();             // sid -> state
    this.stats = {
      captureMode: this.privacy.mode,
      requests: 0, outOfScope: 0, metadataOnly: 0, streamed: 0, armFailed: 0, armRetried: 0,
      retrospective: 0, chunks: 0, bytes: 0, wsFrames: 0, wsControlFrames: 0, esMessages: 0,
      sensitiveExcluded: 0, redactions: 0, truncatedStreams: 0, reattaches: 0, handlerErrors: 0,
      wsLateJoined: 0, wsMetadataFrames: 0,
    };
    this.sessions = new Map();         // sessionId -> { tag, session, targetInfo }
    // 0 = unlimited. A per-stream cap keeps one runaway response from filling the disk; the cut is
    // always recorded as body.truncated so the coverage stays explicit.
    this.maxStreamBytes = options.maxStreamBytes ?? profile?.capture?.maxStreamBytes ?? 0;
    this.armRetries = options.armRetries ?? profile?.capture?.armRetries ?? 1;
    this.armRetryDelayMs = options.armRetryDelayMs ?? 60;
    // Per-stream memory budget for chunks held while Network.streamResourceContent is pending.
    // Overflow stops buffering for that stream and is recorded as body.truncated (arming_buffer_overflow).
    this.maxPendingArmBytes = options.maxPendingArmBytes ?? profile?.capture?.maxPendingArmBytes ?? 8 * 1024 * 1024;
  }

  setProfile(p) {
    this.profile = p;
    this.privacy = capturePrivacy(p);
    this.stats.captureMode = this.privacy.mode;
    if (this.options.maxStreamBytes === undefined) this.maxStreamBytes = p?.capture?.maxStreamBytes ?? this.maxStreamBytes;
    if (this.options.maxPendingArmBytes === undefined) this.maxPendingArmBytes = p?.capture?.maxPendingArmBytes ?? this.maxPendingArmBytes;
  }

  _sid(tag, requestId) { return `${tag}:${requestId}`; }

  // `tag` identifies the recorded target (p, t1, w1, c3 ...); with several tabs in one run the
  // scope is judged against the page that issued the request, not the primary tab.
  _policy(url, resourceType, tag) {
    const pageUrl = this.getPageUrl(tag);
    const c = this.profile.capture ?? {};
    if (!url.startsWith('http') && !url.startsWith('ws')) return { capture: false, reason: 'non_network_scheme' };
    if (!inScope(this.profile, url, pageUrl)) {
      return this.profile.scope?.thirdParty === 'metadata' ? { capture: true, body: false, reason: 'third_party_metadata' } : { capture: false, reason: 'out_of_scope' };
    }
    // The PC-local default records in-scope traffic without automatic auth
    // suppression or format allowlists. Profiles still control site scope.
    if (this.privacy.localRaw) return { capture: true, body: true, reason: 'local_raw' };
    if (isSensitiveUrl(url, c.sensitive ?? [])) return { capture: true, body: false, reason: 'credential_policy' };
    if ((c.exclude ?? []).some((re) => new RegExp(re, 'i').test(url))) return { capture: true, body: false, reason: 'profile_exclude' };
    if (this.options.allBodies) return { capture: true, body: true };
    if ((c.include ?? []).some((re) => new RegExp(re, 'i').test(url))) return { capture: true, body: true };
    if (resourceType && !(c.bodyResourceTypes ?? []).includes(resourceType)) return { capture: true, body: false, reason: 'resource_type_metadata_only' };
    return { capture: true, body: true };
  }

  async attach(session, tag, targetInfo = {}) {
    this.sessions.set(session.sessionId, { tag, session, targetInfo });
    const on = (ev, fn) => session.on(ev, (p) => { try { fn(p); } catch (e) { this.stats.handlerErrors++; this.emit('error', e); } });
    on('Network.requestWillBeSent', (p) => this._onRequest(session, tag, p, targetInfo));
    on('Network.webSocketWillSendHandshakeRequest', (p) => this._onWsHandshakeRequest(tag, p));
    on('Network.responseReceived', (p) => this._onResponse(session, tag, p));
    on('Network.dataReceived', (p) => this._onData(tag, p));
    on('Network.loadingFinished', (p) => this._onFinished(session, tag, p));
    on('Network.loadingFailed', (p) => this._onFailed(tag, p));
    on('Network.eventSourceMessageReceived', (p) => this._onEventSource(tag, p));
    on('Network.webSocketCreated', (p) => this._onWsCreated(tag, p, targetInfo));
    on('Network.webSocketHandshakeResponseReceived', (p) => this._onWsHandshake(tag, p));
    on('Network.webSocketFrameReceived', (p) => this._onWsFrame(tag, p, 'in', targetInfo));
    on('Network.webSocketFrameSent', (p) => this._onWsFrame(tag, p, 'out', targetInfo));
    on('Network.webSocketFrameError', (p) => { const st = this.reqs.get(this._sid(tag, p.requestId)); if (st) this.append({ k: 'ws.error', sid: st.sid, error: p.errorMessage }); });
    on('Network.webSocketClosed', (p) => { const st = this.reqs.get(this._sid(tag, p.requestId)); if (!st) return;
      if (!st.ignored) {
        for (const frame of st.frameGuard?.finish().frames ?? []) this._appendSafeWsFrame(frame);
        this.append({ k: 'ws.close', sid: st.sid, ct: p.timestamp });
      }
      this.reqs.delete(st.sid);
    });
    await session.send('Network.enable', { maxTotalBufferSize: 256 * 1024 * 1024, maxResourceBufferSize: 64 * 1024 * 1024, maxPostDataSize: 1024 * 1024 });
    // Keep the browser cache from hiding traffic? No: altering cache behaviour changes the page.
  }

  // Re-arm after a DevTools reconnect. Requests that were in flight keep their sid, but their
  // byte stream cannot be resumed: Chrome only streams content for requests armed while live.
  // Those streams are therefore marked, never silently continued.
  async reattach(session, tag, targetInfo = {}) {
    this.stats.reattaches++;
    const orphaned = [];
    for (const st of this.reqs.values()) {
      if (st.ignored || !st.body) continue;
      if (!st.sid.startsWith(`${tag}:`)) continue;
      st.armed = false; st.reattachOrphan = true;
      if (st.guard?.discard()) this.append({ k: 'body.excluded', sid: st.sid, reason: 'security_tail_devtools_reconnect' });
      if (st.frameGuard?.discard().length) this.append({ k: 'body.excluded', sid: st.sid, reason: 'security_frames_devtools_reconnect' });
      if (st.esGuard?.discard().length) this.append({ k: 'body.excluded', sid: st.sid, reason: 'security_events_devtools_reconnect' });
      orphaned.push(st.sid);
      this.append({ k: 'body.excluded', sid: st.sid, reason: 'devtools_reconnect_stream_not_resumable' });
    }
    await this.attach(session, tag, targetInfo);
    return { orphaned };
  }

  // Annotate every in-flight stream when the DevTools transport drops.
  markConnectionLost(reason = 'devtools_connection_lost') {
    const open = [];
    for (const st of this.reqs.values()) { if (st.ignored) continue; open.push(st.sid); st.connectionLost = reason; }
    return open;
  }

  detachSession(sessionId) {
    const entry = this.sessions.get(sessionId);
    this.sessions.delete(sessionId);
    if (!entry) return 0;
    let n = 0;
    for (const [sid, st] of [...this.reqs]) {
      if (!sid.startsWith(`${entry.tag}:`)) continue;
      if (st.guard?.discard()) this.append({ k: 'body.excluded', sid, reason: 'security_tail_target_detached' });
      if (st.frameGuard?.discard().length) this.append({ k: 'body.excluded', sid, reason: 'security_frames_target_detached' });
      if (st.esGuard?.discard().length) this.append({ k: 'body.excluded', sid, reason: 'security_events_target_detached' });
      if (!st.ignored) this.append({ k: 'fail', sid, errorText: 'target detached', canceled: false, chunks: st.chunks ?? 0, bytes: st.bytes ?? 0 });
      this.reqs.delete(sid);
      n++;
    }
    return n;
  }

  _onRequest(session, tag, p, targetInfo) {
    const sid = this._sid(tag, p.requestId);
    const url = p.request.url;
    // Redirects reuse the requestId: close the previous hop explicitly.
    const prev = this.reqs.get(sid);
    if (prev && p.redirectResponse) {
      if (prev.guard?.discard()) this.append({ k: 'body.excluded', sid, reason: 'security_tail_unfinished_redirect' });
      if (prev.frameGuard?.discard().length) this.append({ k: 'body.excluded', sid, reason: 'security_frames_unfinished_redirect' });
      if (prev.esGuard?.discard().length) this.append({ k: 'body.excluded', sid, reason: 'security_events_unfinished_redirect' });
      this.append({ k: 'res', sid, status: p.redirectResponse.status, mime: p.redirectResponse.mimeType, headers: this.privacy.headers(p.redirectResponse.headers), redirect: true });
      this.append({ k: 'done', sid, redirectedTo: this.privacy.url(url) });
    }
    const pol = this._policy(url, p.type, tag);
    this.stats.requests++;
    if (!pol.capture) { this.stats.outOfScope++; this.reqs.set(sid, { sid, ignored: true }); return; }
    const st = { sid, url, body: pol.body, reason: pol.reason, armed: false, chunks: 0, bytes: 0, session,
      guard: pol.body ? new ChunkCredentialGuard() : null };
    this.reqs.set(sid, st);
    if (!pol.body) this.stats.metadataOnly++;
    if (pol.reason === 'credential_policy') this.stats.sensitiveExcluded++;
    const rec = {
      k: 'req', sid, method: p.request.method, url: this.privacy.url(url), type: p.type, frameId: p.frameId,
      initiator: p.initiator?.type, ct: p.timestamp, wallTime: p.wallTime, target: targetInfo.type ?? 'page',
      headers: this.privacy.headers(p.request.headers), hasPostData: !!p.request.hasPostData,
      policy: pol.body ? 'body' : `metadata_only:${pol.reason}`,
    };
    if ((this.privacy.localRaw || this.profile.capture?.requestBodies) && pol.body && p.request.postData) {
      const { text, redactions } = this.privacy.text(p.request.postData);
      rec.postData = text;
      if (redactions.length) rec.postDataRedactions = redactions.length;
    }
    this.append(rec);
  }

  async _onResponse(session, tag, p) {
    const sid = this._sid(tag, p.requestId);
    const st = this.reqs.get(sid);
    if (!st || st.ignored) return;
    const r = p.response;
    this.append({
      k: 'res', sid, status: r.status, mime: r.mimeType, protocol: r.protocol, type: p.type, ct: p.timestamp,
      headers: this.privacy.headers(r.headers), fromServiceWorker: !!r.fromServiceWorker, fromCache: !!(r.fromDiskCache || r.fromPrefetchCache), encodedDataLength: r.encodedDataLength,
    });
    if (!st.body) { this.append({ k: 'body.excluded', sid, reason: st.reason }); return; }
    if (p.type === 'WebSocket') return;
    st.arming = true;
    try {
      const res = await this._armStream(session, p.requestId, st);
      st.armed = true;
      this.stats.streamed++;
      this.append({ k: 'stream.armed', sid, mode: 'stream', bufferedBytes: res.bufferedData ? Buffer.from(res.bufferedData, 'base64').length : 0, ...(st.armAttempts > 1 ? { attempts: st.armAttempts } : {}) });
      if (res.bufferedData) this._chunk(st, Buffer.from(res.bufferedData, 'base64'), { pre: true });
    } catch (e) {
      this.stats.armFailed++;
      st.armFailed = String(e.message ?? e);
      this.append({ k: 'stream.arm_failed', sid, error: st.armFailed, attempts: st.armAttempts ?? 1 });
    } finally {
      st.arming = false;
      // Chunks that raced the arming response are written after bufferedData, preserving byte order.
      for (const d of st.pendingData ?? []) this._chunk(st, d.buf, d.extra);
      st.pendingData = null;
      st.pendingBytes = 0;
      // Bytes after the overflow point were never buffered, so everything after it is a gap: marked, not resumed.
      if (st.pendingOverflow) { this._truncateStream(st, 'arming_buffer_overflow', this.maxPendingArmBytes, st.pendingOverflow.bytes); st.pendingOverflow = null; }
      if (st.finishedWhileArming) this._finalize(st.finishedWhileArming.session, st, st.finishedWhileArming.p);
    }
  }

  // Arming can lose a race with the response pipeline; one short retry recovers the common
  // "not yet streamable" case. Chunks that arrive meanwhile are queued (st.arming), so byte
  // order is preserved across the retry.
  async _armStream(session, requestId, st) {
    let last;
    for (let attempt = 1; attempt <= 1 + Math.max(0, this.armRetries); attempt++) {
      st.armAttempts = attempt;
      try { return await session.send('Network.streamResourceContent', { requestId }); }
      catch (e) {
        last = e;
        const msg = String(e?.message ?? e);
        // Permanent refusals are not worth retrying.
        if (/not supported|already finished|No resource|Invalid|cannot be/i.test(msg)) break;
        if (attempt <= this.armRetries) { this.stats.armRetried++; await new Promise((r) => setTimeout(r, this.armRetryDelayMs * attempt)); }
      }
    }
    throw last;
  }

  // Only this method can write response body chunks. The guard withholds a tail
  // across DevTools events so an incomplete credential marker is never persisted.
  _appendProtectedChunk(st, result, extra = {}) {
    if (result.excluded) {
      st.credentialExcluded = true;
      this.stats.sensitiveExcluded++;
      this.append({ k: 'body.excluded', sid: st.sid, reason: result.reason, securityGuard: 'stream-v1',
        coverage: 'A credential marker or uninspectable input was found before persistence. Remaining body bytes are unavailable.' });
      return;
    }
    const { bytes, redactions = [] } = result;
    if (!bytes?.length) return;
    st.chunks++; st.bytes += bytes.length;
    this.stats.chunks++; this.stats.bytes += bytes.length;
    this.stats.redactions += redactions.length;
    const rec = { k: 'chunk', sid: st.sid, n: bytes.length, b64: bytes.toString('base64'),
      ...extra, securityDelayed: true };
    if (redactions.length) rec.redactions = redactions;
    this.append(rec);
  }

  // The cap counts bytes already admitted plus the filtered-mode tail held by the guard. A chunk that
  // crosses the cap is split at the boundary: the head up to the cap is admitted, the rest is dropped.
  // Whole chunks are never admitted past the cap.
  _chunk(st, buf, extra = {}) {
    if (st.credentialExcluded) return;
    // A truncated stream (byte cap or arming overflow) never resumes: later bytes are a gap, not continuation.
    if (st.truncated) return this._truncateStream(st, 'max_stream_bytes', this.maxStreamBytes, buf.length);
    if (this.maxStreamBytes && buf.length) {
      const room = this.maxStreamBytes - (st.bytes + (st.guard?.pending.length ?? 0));
      if (room <= 0) return this._truncateStream(st, 'max_stream_bytes', this.maxStreamBytes, buf.length);
      if (buf.length > room) {
        this._admit(st, buf.subarray(0, room), extra);
        if (st.credentialExcluded) return; // body.excluded already states that the remaining bytes are unavailable
        return this._truncateStream(st, 'max_stream_bytes', this.maxStreamBytes, buf.length - room);
      }
    }
    this._admit(st, buf, extra);
  }

  _admit(st, buf, extra = {}) {
    if (this.privacy.localRaw) {
      st.chunks++; st.bytes += buf.length;
      this.stats.chunks++; this.stats.bytes += buf.length;
      this.append({ k: 'chunk', sid: st.sid, n: buf.length, b64: buf.toString('base64'), ...extra });
      return;
    }
    this._appendProtectedChunk(st, (st.guard ??= new ChunkCredentialGuard()).push(buf), extra);
  }

  // Single writer of loss for a body cut by the byte cap or the arming budget. The first loss in a
  // stream writes body.truncated with the exact persisted byte count; later losses only add to
  // droppedByCap, so persisted + droppedByCap always equals the bytes received. The filtered-mode tail
  // still held by the guard is discarded (unchanged behaviour) and reported as withheldBytes, so the
  // marker never overstates what was persisted.
  _truncateStream(st, reason, cap, droppedLen) {
    const withheld = st.guard?.pending.length ?? 0;
    if (!st.truncated) {
      st.truncated = true; this.stats.truncatedStreams++;
      this.append({ k: 'body.truncated', sid: st.sid, bytes: st.bytes, cap, reason, ...(withheld ? { withheldBytes: withheld } : {}) });
    }
    st.guard?.discard();
    st.droppedByCap = (st.droppedByCap ?? 0) + droppedLen + withheld;
  }

  _onData(tag, p) {
    const st = this.reqs.get(this._sid(tag, p.requestId));
    if (!st || st.ignored || !st.body) return;
    if (p.data) {
      const buf = Buffer.from(p.data, 'base64'), extra = { ct: p.timestamp, enc: p.encodedDataLength };
      if (st.arming) this._bufferWhileArming(st, buf, extra); else this._chunk(st, buf, extra);
    }
    else if (!st.armed) st.unarmedDataEvents = (st.unarmedDataEvents ?? 0) + 1; // bytes are in bufferedData or the retrospective body
  }

  // Chunks that arrive while arming is pending are held until arming settles, within a per-stream budget.
  // On overflow, buffering stops for good: the buffered prefix is still written in order, and the loss is
  // recorded when the arm settles (see _onResponse). Nothing is dropped without a marker.
  _bufferWhileArming(st, buf, extra) {
    if (st.pendingOverflow || (st.pendingBytes ?? 0) + buf.length > this.maxPendingArmBytes) {
      st.pendingOverflow = { bytes: (st.pendingOverflow?.bytes ?? 0) + buf.length };
      return;
    }
    (st.pendingData ??= []).push({ buf, extra });
    st.pendingBytes = (st.pendingBytes ?? 0) + buf.length;
  }

  _onFinished(session, tag, p) {
    const st = this.reqs.get(this._sid(tag, p.requestId));
    if (!st) return;
    if (st.ignored) { this.reqs.delete(st.sid); return; }
    if (st.arming) { st.finishedWhileArming = { session, p }; return; }
    this._finalize(session, st, p);
  }

  async _finalize(session, st, p) {
    // Do not claim safe trailing bytes until completion is confirmed.
    if (st.armed && st.guard && !st.truncated && !st.credentialExcluded)
      this._appendProtectedChunk(st, st.guard.finish(), { finalSecurityTail: true });
    else if (st.guard) st.guard.discard();
    if (!st.credentialExcluded) {
      for (const msg of st.esGuard?.finish().frames ?? []) this.append(msg);
    } else st.esGuard?.discard();
    if (st.body && !st.armed && this.profile.capture?.retrospectiveFallback !== false) {
      try {
        const r = await session.send('Network.getResponseBody', { requestId: p.requestId });
        const buf = Buffer.from(r.body ?? '', r.base64Encoded ? 'base64' : 'utf8');
        this.stats.retrospective++;
        // Retrospective is a completed body, but it must still use the bounded
        // fail-closed guard. A large/ambiguous body is metadata-only.
        const guard = this.privacy.localRaw ? null : new ChunkCredentialGuard();
        const first = guard ? guard.push(buf) : { bytes: buf, redactions: [], excluded: false };
        const last = guard ? (first.excluded ? first : guard.finish())
          : { bytes: Buffer.alloc(0), redactions: [], excluded: false };
        if (first.excluded || last.excluded) {
          this.stats.sensitiveExcluded++;
          this.append({ k: 'body.excluded', sid: st.sid, reason: first.reason ?? last.reason,
            securityGuard: 'stream-v1', retrospective: true });
        } else {
          const bytes = Buffer.concat([first.bytes, last.bytes]);
          const redactions = [...first.redactions, ...last.redactions.map((x) => ({
            ...x, offset: x.offset + first.bytes.length }))];
          this.stats.redactions += redactions.length;
          const rec = { k: 'body', sid: st.sid, n: bytes.length, b64: bytes.toString('base64'),
            retrospective: true, ...(this.privacy.localRaw ? { captureMode: 'local-raw' } : { securityGuard: 'stream-v1' }) };
          if (redactions.length) rec.redactions = redactions;
          this.append(rec);
        }
      } catch (e) {
        // Do not persist arbitrary exception messages from a CDP body read.
        this.append({ k: 'body.unavailable', sid: st.sid, reason: 'retrospective_body_unavailable' });
      }
    }
    this.append({
      k: 'done', sid: st.sid, ct: p.timestamp, encodedDataLength: p.encodedDataLength, chunks: st.chunks, bytes: st.bytes,
      ...(st.truncated ? { truncated: true, droppedByCap: st.droppedByCap ?? 0 } : {}),
      ...(st.unarmedDataEvents ? { unarmedDataEvents: st.unarmedDataEvents } : {}),
    });
    this.reqs.delete(st.sid);
  }

  _onFailed(tag, p) {
    const st = this.reqs.get(this._sid(tag, p.requestId));
    if (!st) return;
    if (st.ignored) { this.reqs.delete(st.sid); return; }
    if (st.guard?.discard()) this.append({ k: 'body.excluded', sid: st.sid, reason: 'security_tail_unfinished_failure' });
    if (st.frameGuard?.discard().length) this.append({ k: 'body.excluded', sid: st.sid, reason: 'security_frames_unfinished_failure' });
    if (st.esGuard?.discard().length) this.append({ k: 'body.excluded', sid: st.sid, reason: 'security_events_unfinished_failure' });
    this.append({ k: 'fail', sid: st.sid, ct: p.timestamp, errorText: p.errorText, canceled: !!p.canceled, blockedReason: p.blockedReason, chunks: st.chunks, bytes: st.bytes });
    this.reqs.delete(st.sid);
  }

  _onEventSource(tag, p) {
    const st = this.reqs.get(this._sid(tag, p.requestId));
    if (!st || st.ignored || !st.body) return;
    this.stats.esMessages++;
    if (st.credentialExcluded) return;
    if (this.privacy.localRaw) {
      this.append({ k: 'es.msg', sid: st.sid, ct: p.timestamp, eventName: p.eventName,
        eventId: p.eventId, data: p.data ?? '' });
      return;
    }
    // CDP emits this parsed view IN ADDITION to raw HTTP bytes. Guard it
    // independently so split secret markers cannot survive via es.msg.
    const bytes = Buffer.from(String(p.data ?? ''), 'utf8');
    const { text, redactions } = this.privacy.text(p.data ?? '');
    const rec = { k: 'es.msg', sid: st.sid, ct: p.timestamp,
      eventName: this.privacy.text(p.eventName ?? '').text, eventId: this.privacy.text(p.eventId ?? '').text,
      data: text, securityDelayed: true };
    if (redactions.length) rec.redactions = redactions;
    const result = (st.esGuard ??= new FrameCredentialGuard()).push(rec, bytes);
    for (const safe of result.frames) this.append(safe);
    if (result.excluded) {
      st.credentialExcluded = true;
      st.guard?.exclude('eventsource_credential_candidate');
      this.stats.sensitiveExcluded++;
      this.append({ k: 'body.excluded', sid: st.sid, reason: result.reason,
        securityGuard: 'eventsource-v1', coverage: 'Parsed EventSource messages and remaining stream body suppressed after a credential candidate.' });
    }
  }

  _onWsCreated(tag, p, targetInfo) {
    const sid = this._sid(tag, p.requestId);
    if (!this.profile.capture?.websockets) { this.reqs.set(sid, { sid, ignored: true }); return; }
    const pol = this._policy(p.url, null, tag); // WebSockets are governed by capture.websockets, not resource types
    if (!pol.capture || !pol.body) { this.reqs.set(sid, { sid, ignored: !pol.capture, body: false }); if (pol.capture) this.append({ k: 'ws.open', sid, url: this.privacy.url(p.url), policy: `metadata_only:${pol.reason}` }); return; }
    this.reqs.set(sid, { sid, url: p.url, ws: true, body: true, frames: 0, bytes: 0, chunks: 0,
      frameGuard: new FrameCredentialGuard() });
    this.append({ k: 'ws.open', sid, url: this.privacy.url(p.url), initiator: p.initiator?.type, target: targetInfo.type ?? 'page' });
  }

  _onWsHandshakeRequest(tag, p) {
    const st = this.reqs.get(this._sid(tag, p.requestId));
    if (!st || st.ignored) return;
    const headers = this.privacy.headers(p.request?.headers ?? {});
    const proto = headers['sec-websocket-protocol'] ?? headers['Sec-WebSocket-Protocol'];
    this.append({ k: 'ws.handshake_request', sid: st.sid, ct: p.timestamp, headers, ...(proto ? { requestedProtocols: String(proto).split(/\s*,\s*/) } : {}) });
  }

  _onWsHandshake(tag, p) {
    const st = this.reqs.get(this._sid(tag, p.requestId));
    if (!st || st.ignored) return;
    this.append({ k: 'ws.handshake', sid: st.sid, status: p.response?.status, headers: this.privacy.headers(p.response?.headers) });
  }

  // A socket opened before observation began never produces webSocketCreated, but Chrome still
  // reports its frames. Instead of dropping them silently, the socket is joined late with an
  // explicit coverage note (URL, handshake and earlier frames are UNKNOWN). Profile control:
  // capture.lateWebSockets = 'body' (default) | 'metadata' | 'off'. Without a URL the scope is
  // judged by the page that owns the socket.
  _lateJoinWs(tag, requestId, targetInfo = {}) {
    const sid = this._sid(tag, requestId);
    const c = this.profile.capture ?? {};
    const mode = c.lateWebSockets ?? 'body';
    if (!c.websockets || mode === 'off') { this.reqs.set(sid, { sid, ignored: true }); return null; }
    const pageUrl = this.getPageUrl(tag) ?? '';
    const pageInScope = !!pageUrl && inScope(this.profile, pageUrl, pageUrl);
    if (!pageInScope && !this.options.allBodies) { this.reqs.set(sid, { sid, ignored: true }); return null; }
    const body = mode === 'body';
    const st = { sid, url: null, ws: true, body, frames: 0, bytes: 0, chunks: 0, lateJoin: true,
      frameGuard: body ? new FrameCredentialGuard() : null };
    this.reqs.set(sid, st);
    this.stats.wsLateJoined++;
    this.append({
      k: 'ws.open', sid, lateJoin: true, urlUnknown: true, target: targetInfo.type ?? 'page',
      policy: body ? 'body:late_join' : 'metadata_only:late_join',
      coverage: 'Socket was opened before observation began: its URL, handshake and every frame before this record are UNKNOWN.',
    });
    return st;
  }

  _appendSafeWsFrame(frame) {
    this.stats.redactions += frame.redactions?.length ?? 0;
    this.append(frame);
  }

  _onWsFrame(tag, p, dir, targetInfo = {}) {
    let st = this.reqs.get(this._sid(tag, p.requestId));
    if (!st) st = this._lateJoinWs(tag, p.requestId, targetInfo);
    if (!st || st.ignored) return;
    const f = p.response ?? {};
    const data = f.payloadData ?? '';
    const size = f.opcode === 2 ? Buffer.from(data, 'base64').length : Buffer.byteLength(data);
    const metadata = { k: 'ws.frame_meta', sid: st.sid, dir, opcode: f.opcode, size, ct: p.timestamp };
    if (!st.body || st.credentialExcluded) {
      this.stats.wsMetadataFrames++;
      this.append({ ...metadata, policy: st.credentialExcluded ? 'metadata_only:credential_guard' : 'metadata_only' });
      return;
    }
    if (dir === 'out' && !this.privacy.localRaw && !this.profile.capture?.wsSentFrames) {
      this.stats.wsMetadataFrames++;
      this.append({ ...metadata, policy: 'metadata_only:sent_frame_policy' });
      return;
    }
    this.stats.wsFrames++;
    if ([0, 8, 9, 10].includes(f.opcode)) this.stats.wsControlFrames++;
    st.frames = (st.frames ?? 0) + 1;
    // Frames are protocol units and cannot be split: a frame that would cross the cap is omitted whole
    // (ws.frame_meta droppedByCap), and the stream stays truncated for every later frame.
    if (this.maxStreamBytes && (st.truncated || (st.bytes ?? 0) + size > this.maxStreamBytes)) {
      const withheld = st.frameGuard?.bytes ?? 0;
      if (!st.truncated) { st.truncated = true; this.stats.truncatedStreams++;
        this.append({ k: 'body.truncated', sid: st.sid, bytes: (st.bytes ?? 0) - withheld, cap: this.maxStreamBytes, reason: 'max_stream_bytes', ...(withheld ? { withheldBytes: withheld } : {}) }); }
      for (const dropped of st.frameGuard?.discard() ?? [])
        this.append({ k: 'ws.frame_meta', sid: st.sid, dir: dropped.frame.dir, opcode: dropped.frame.opcode,
          ct: dropped.frame.ct, size: dropped.bytes, policy: 'metadata_only:security_tail_truncated' });
      this.append({ ...metadata, droppedByCap: true });
      return;
    }
    // Observe raw bytes only in memory, before appending anything to raw JSONL.
    // Each delayed safe frame keeps its original opcode/direction and arrival ct.
    const bytes = f.opcode === 2 ? Buffer.from(data, 'base64') : Buffer.from(data, 'utf8');
    if (this.privacy.localRaw) {
      st.bytes = (st.bytes ?? 0) + size;
      this.append({ k: 'ws.frame', sid: st.sid, dir, opcode: f.opcode, payload: data, ct: p.timestamp });
      return;
    }
    let payload, redactions;
    if (f.opcode === 2) { const r = this.privacy.bytes(bytes); payload = r.bytes.toString('base64'); redactions = r.redactions; }
    else { const r = this.privacy.text(data); payload = r.text; redactions = r.redactions; }
    const rec = { k: 'ws.frame', sid: st.sid, dir, opcode: f.opcode, payload, ct: p.timestamp, securityDelayed: true };
    if (redactions.length) rec.redactions = redactions;
    st.bytes = (st.bytes ?? 0) + size;
    const gated = (st.frameGuard ??= new FrameCredentialGuard()).push(rec, bytes);
    for (const ready of gated.frames) this._appendSafeWsFrame(ready);
    if (gated.excluded) {
      st.credentialExcluded = true;
      this.stats.sensitiveExcluded++;
      this.append({ k: 'body.excluded', sid: st.sid, reason: gated.reason, securityGuard: 'ws-frames-v1',
        coverage: 'Pending and later WebSocket frames are metadata-only to prevent cross-frame credential exposure.' });
      for (const dropped of gated.dropped)
        this.append({ k: 'ws.frame_meta', sid: st.sid, dir: dropped.frame.dir, opcode: dropped.frame.opcode,
          ct: dropped.frame.ct, size: dropped.bytes, policy: 'metadata_only:credential_guard' });
    }
  }

  openStreams() { return [...this.reqs.values()].filter((s) => !s.ignored).map((s) => s.sid); }

  // Same set with enough detail for a coverage note (what exactly is still in flight).
  openStreamDetail() {
    return [...this.reqs.values()].filter((s) => !s.ignored).map((s) => ({
      sid: s.sid, url: s.url ? this.privacy.url(s.url) : undefined, ws: !!s.ws, body: !!s.body,
      chunks: s.chunks ?? 0, bytes: s.bytes ?? 0, frames: s.frames ?? 0,
      armed: !!s.armed, truncated: !!s.truncated, securityExcluded: !!s.credentialExcluded,
      securityWithheldBytes: (s.guard?.pending.length ?? 0) + (s.frameGuard?.bytes ?? 0) + (s.esGuard?.bytes ?? 0),
    }));
  }
}
