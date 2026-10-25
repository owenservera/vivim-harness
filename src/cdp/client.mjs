// Minimal, dependency-free Chrome DevTools Protocol client.
// One browser-level WebSocket; per-target sessions use flatten mode (sessionId on each message).
// Node >= 22 provides a global WebSocket implementation.
//
// Resilience lives in two layers:
//   CdpConnection            one socket, optional per-request timeouts, optional heartbeat
//   ResilientCdpConnection   re-discovers the DevTools endpoint and reconnects with backoff,
//                            re-attaches the targets the caller asked for, and reports every
//                            transition so a capture can record an honest coverage note.
import { EventEmitter } from 'node:events';

export class CdpError extends Error {
  constructor(method, error) {
    super(`${method}: ${error?.message ?? 'CDP error'}${error?.data ? ` (${error.data})` : ''}`);
    this.code = error?.code;
    this.method = method;
    this.detail = error;
  }
}

export class CdpTimeoutError extends CdpError {
  constructor(method, ms) { super(method, { message: `timed out after ${ms} ms` }); this.timeoutMs = ms; }
}

export class CdpSession extends EventEmitter {
  constructor(connection, sessionId, targetInfo) {
    super();
    this.setMaxListeners(100);
    this.connection = connection;
    this.sessionId = sessionId;
    this.targetInfo = targetInfo;
    this.detached = false;
  }
  send(method, params = {}, opts) {
    if (this.detached) return Promise.reject(new CdpError(method, { message: 'session detached' }));
    return this.connection._send(method, params, this.sessionId, opts);
  }
  // Fire-and-forget variant: never rejects, returns null on failure. Useful for optional domains.
  async trySend(method, params = {}, opts) {
    try { return await this.send(method, params, opts); } catch (e) { this.emit('send-failed', { method, error: String(e?.message ?? e) }); return null; }
  }
  get targetId() { return this.targetInfo?.targetId; }
}

export class CdpConnection extends EventEmitter {
  static async connect(wsUrl, { timeoutMs = 10_000, requestTimeoutMs = 0 } = {}) {
    assertLoopbackUrl(wsUrl);
    const ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`CDP connect timeout: ${wsUrl}`)), timeoutMs);
      ws.addEventListener('open', () => { clearTimeout(t); resolve(); }, { once: true });
      ws.addEventListener('error', (e) => { clearTimeout(t); reject(new Error(`CDP connect failed: ${e?.message ?? wsUrl}`)); }, { once: true });
    });
    return new CdpConnection(ws, { requestTimeoutMs, url: wsUrl });
  }

  constructor(ws, { requestTimeoutMs = 0, url = null } = {}) {
    super();
    this.setMaxListeners(100);
    this.ws = ws;
    this.url = url;
    this.requestTimeoutMs = requestTimeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    this.sessions = new Map();
    this.closed = false;
    this.openedAt = Date.now();
    this.stats = { sent: 0, received: 0, events: 0, errors: 0, timeouts: 0, bytesIn: 0 };
    ws.addEventListener('message', (ev) => this._onMessage(ev.data));
    ws.addEventListener('close', (ev) => this._onClose(ev));
    ws.addEventListener('error', () => { this.stats.errors++; });
  }

  _send(method, params, sessionId, { timeoutMs } = {}) {
    if (this.closed) return Promise.reject(new CdpError(method, { message: 'connection closed' }));
    const id = this.nextId++;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    const limit = timeoutMs ?? this.requestTimeoutMs;
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, method, sessionId, startedAt: Date.now() };
      if (limit > 0) {
        entry.timer = setTimeout(() => {
          if (!this.pending.has(id)) return;
          this.pending.delete(id);
          this.stats.timeouts++;
          reject(new CdpTimeoutError(method, limit));
        }, limit);
        entry.timer.unref?.();
      }
      this.pending.set(id, entry);
      try { this.ws.send(JSON.stringify(msg)); this.stats.sent++; }
      catch (e) { this.pending.delete(id); if (entry.timer) clearTimeout(entry.timer); reject(new CdpError(method, { message: String(e?.message ?? e) })); }
    });
  }

  send(method, params = {}, opts) { return this._send(method, params, undefined, opts); }
  async trySend(method, params = {}, opts) { try { return await this.send(method, params, opts); } catch { return null; } }

  _onMessage(data) {
    const text = typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
    this.stats.received++;
    this.stats.bytesIn += text.length;
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (p.timer) clearTimeout(p.timer);
      if (msg.error) { this.stats.errors++; p.reject(new CdpError(p.method, msg.error)); }
      else p.resolve(msg.result ?? {});
      return;
    }
    this.stats.events++;
    if (msg.method === 'Target.attachedToTarget') {
      const { sessionId, targetInfo } = msg.params;
      if (!this.sessions.has(sessionId)) this.sessions.set(sessionId, new CdpSession(this, sessionId, targetInfo));
    }
    if (msg.method === 'Target.detachedFromTarget') {
      const s = this.sessions.get(msg.params.sessionId);
      if (s) { s.detached = true; this.sessions.delete(msg.params.sessionId); s.emit('detached', msg.params); }
    }
    const target = msg.sessionId ? this.sessions.get(msg.sessionId) : this;
    if (target) {
      target.emit(msg.method, msg.params ?? {});
      target.emit('*', msg.method, msg.params ?? {});
    }
    // Child-session attach events are delivered to the parent session; expose them globally too.
    if (msg.sessionId && msg.method === 'Target.attachedToTarget') this.emit('child-attached', msg.params, msg.sessionId);
  }

  _onClose(ev) {
    if (this.closed) return;
    this.closed = true;
    this.stopHeartbeat();
    this.closeInfo = { code: ev?.code, reason: ev?.reason, at: Date.now() };
    for (const [, p] of this.pending) { if (p.timer) clearTimeout(p.timer); p.reject(new CdpError(p.method, { message: 'connection closed' })); }
    this.pending.clear();
    for (const s of this.sessions.values()) { s.detached = true; s.emit('detached', { reason: 'connection closed' }); }
    this.sessions.clear();
    this.emit('close', this.closeInfo);
  }

  async attach(targetId, { timeoutMs } = {}) {
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true }, { timeoutMs });
    let s = this.sessions.get(sessionId);
    if (!s) { s = new CdpSession(this, sessionId, { targetId }); this.sessions.set(sessionId, s); }
    if (!s.targetInfo?.targetId) s.targetInfo = { ...(s.targetInfo ?? {}), targetId };
    return s;
  }

  async detach(sessionId) {
    const s = this.sessions.get(sessionId);
    try { await this.send('Target.detachFromTarget', { sessionId }); } catch { /* already gone */ }
    if (s) { s.detached = true; this.sessions.delete(sessionId); }
    return true;
  }

  session(sessionId) { return this.sessions.get(sessionId); }
  sessionForTarget(targetId) { for (const s of this.sessions.values()) if (s.targetInfo?.targetId === targetId) return s; return null; }

  // Liveness probe: a cheap browser-domain round trip.
  async ping({ timeoutMs = 5000 } = {}) {
    const started = Date.now();
    await this.send('Browser.getVersion', {}, { timeoutMs });
    return Date.now() - started;
  }

  // Periodic probe; emits 'unhealthy' (with the error) instead of throwing, so the caller decides.
  startHeartbeat({ intervalMs = 15_000, timeoutMs = 5000 } = {}) {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(async () => {
      if (this.closed) return;
      try { this.lastPingMs = await this.ping({ timeoutMs }); this.lastPingAt = Date.now(); this.emit('healthy', this.lastPingMs); }
      catch (e) { this.emit('unhealthy', e); }
    }, intervalMs);
    this.heartbeatTimer.unref?.();
    return this;
  }
  stopHeartbeat() { if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; } }

  get openSessions() { return [...this.sessions.keys()]; }
  get uptimeMs() { return Date.now() - this.openedAt; }

  close() { this.stopHeartbeat(); try { this.ws.close(); } catch { /* ignore */ } }
}

// ---------------------------------------------------------------------------------------------
// Reconnecting wrapper.
//
// The DevTools browser endpoint changes whenever Chrome restarts, so reconnection re-runs HTTP
// discovery instead of reusing the old socket URL. Attachments requested through this wrapper are
// restored after each reconnect, and every transition is emitted:
//   'connected'      { attempt, wsUrl, browser }
//   'disconnected'   { reason }
//   'reconnecting'   { attempt, delayMs }
//   'reconnected'    { attempt, downtimeMs, reattached: [targetId] }
//   'failed'         { attempts, error }     no further attempts will be made
// ---------------------------------------------------------------------------------------------
export class ResilientCdpConnection extends EventEmitter {
  constructor({
    discover, wsUrl = null, maxAttempts = 10, baseDelayMs = 250, maxDelayMs = 10_000,
    requestTimeoutMs = 0, heartbeatMs = 0, autoReconnect = true,
  } = {}) {
    super();
    this.setMaxListeners(100);
    this.discover = discover ?? (async () => wsUrl);   // () => wsUrl | { webSocketDebuggerUrl }
    this.maxAttempts = maxAttempts;
    this.baseDelayMs = baseDelayMs;
    this.maxDelayMs = maxDelayMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.heartbeatMs = heartbeatMs;
    this.autoReconnect = autoReconnect;
    this.conn = null;
    this.closedByUser = false;
    this.attachments = new Map();    // targetId -> { onSession }
    this.generation = 0;
    this.history = [];               // bounded transition log for receipts
  }

  _log(entry) { this.history.push({ at: Date.now(), ...entry }); if (this.history.length > 100) this.history.shift(); }

  async _resolveUrl() {
    const v = await this.discover();
    const url = typeof v === 'string' ? v : v?.webSocketDebuggerUrl;
    if (!url) throw new Error('No DevTools WebSocket endpoint available');
    return { url, info: typeof v === 'string' ? null : v };
  }

  async open() {
    const { url, info } = await this._resolveUrl();
    this.conn = await CdpConnection.connect(url, { requestTimeoutMs: this.requestTimeoutMs });
    this.generation++;
    this._wire();
    if (this.heartbeatMs) this.conn.startHeartbeat({ intervalMs: this.heartbeatMs });
    this._log({ event: 'connected', generation: this.generation });
    this.emit('connected', { attempt: 0, wsUrl: url, browser: info?.Browser, generation: this.generation });
    return this.conn;
  }

  _wire() {
    const conn = this.conn;
    conn.on('close', (info) => {
      if (this.closedByUser || conn !== this.conn) return;
      this._log({ event: 'disconnected', code: info?.code });
      this.emit('disconnected', { reason: info?.reason || `code ${info?.code ?? 'unknown'}` });
      if (this.autoReconnect) this._reconnectLoop(Date.now()).catch((e) => this.emit('error', e));
    });
    conn.on('unhealthy', (e) => this.emit('unhealthy', e));
    conn.on('child-attached', (p, parentSessionId) => this.emit('child-attached', p, parentSessionId));
  }

  async _reconnectLoop(lostAt) {
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      if (this.closedByUser) return null;
      const delay = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** (attempt - 1));
      this.emit('reconnecting', { attempt, delayMs: delay });
      this._log({ event: 'reconnecting', attempt, delayMs: delay });
      await sleep(delay);
      if (this.closedByUser) return null;
      try {
        const { url, info } = await this._resolveUrl();
        const conn = await CdpConnection.connect(url, { requestTimeoutMs: this.requestTimeoutMs });
        this.conn = conn;
        this.generation++;
        this._wire();
        if (this.heartbeatMs) conn.startHeartbeat({ intervalMs: this.heartbeatMs });
        const reattached = [];
        for (const [targetId, spec] of this.attachments) {
          try {
            const session = await conn.attach(targetId);
            await spec.onSession?.(session, { reconnected: true, generation: this.generation });
            reattached.push(targetId);
          } catch (e) { this.emit('reattach-failed', { targetId, error: String(e?.message ?? e) }); }
        }
        const downtimeMs = Date.now() - lostAt;
        this._log({ event: 'reconnected', attempt, downtimeMs, reattached: reattached.length });
        this.emit('reconnected', { attempt, downtimeMs, reattached, browser: info?.Browser, generation: this.generation });
        return conn;
      } catch (e) {
        this.lastError = e;
        this._log({ event: 'reconnect_failed', attempt, error: String(e?.message ?? e) });
      }
    }
    this._log({ event: 'failed', attempts: this.maxAttempts });
    this.emit('failed', { attempts: this.maxAttempts, error: this.lastError ? String(this.lastError.message ?? this.lastError) : 'unknown' });
    return null;
  }

  // Attach now and after every future reconnect. onSession runs for the first attach too.
  async attach(targetId, onSession) {
    this.attachments.set(targetId, { onSession });
    const session = await this.conn.attach(targetId);
    await onSession?.(session, { reconnected: false, generation: this.generation });
    return session;
  }

  releaseAttachment(targetId) { return this.attachments.delete(targetId); }

  send(method, params = {}, opts) {
    if (!this.conn || this.conn.closed) return Promise.reject(new CdpError(method, { message: 'connection closed' }));
    return this.conn.send(method, params, opts);
  }

  session(sessionId) { return this.conn?.session(sessionId) ?? null; }
  get closed() { return !this.conn || this.conn.closed; }
  get stats() { return { generation: this.generation, attachments: this.attachments.size, transitions: this.history.length, ...(this.conn?.stats ?? {}) }; }

  close() { this.closedByUser = true; this.conn?.close(); }
}

// Connect with retry, re-running discovery each attempt (Chrome may still be starting).
export async function connectWithRetry(discover, { maxAttempts = 20, baseDelayMs = 250, maxDelayMs = 5000, requestTimeoutMs = 0 } = {}) {
  let last;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const v = await discover();
      const url = typeof v === 'string' ? v : v?.webSocketDebuggerUrl;
      if (!url) throw new Error('no DevTools endpoint');
      return await CdpConnection.connect(url, { requestTimeoutMs });
    } catch (e) {
      last = e;
      await sleep(Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1)));
    }
  }
  throw new Error(`CDP connect failed after ${maxAttempts} attempts: ${last?.message ?? last}`);
}

export function sleep(ms) { return new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); }); }

// Remote debugging must never be reached over a non-loopback interface.
export function assertLoopbackUrl(url) {
  const u = new URL(url);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
    throw new Error(`Refusing non-loopback DevTools endpoint: ${host}. Bind Chrome with --remote-debugging-address=127.0.0.1.`);
  }
}
