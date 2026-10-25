// Process-local, bounded SSE replay. IDs are delivery cursors, NOT durable raw-log sequences.
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { problem, integer } from './http.mjs';

export const EVENT_TYPES = ['status', 'started', 'stopped', 'warn', 'record', 'event', 'session.derived', 'learning.changed'];

export class EventFeed extends EventEmitter {
  constructor({ maxEvents = 1000, maxBytes = 4 * 1024 * 1024, maxClientBytes = 512 * 1024, maxClients = 32, eventTypes = EVENT_TYPES } = {}) {
    super();
    this.epoch = randomBytes(8).toString('hex'); this.sequence = 0;
    this.events = []; this.bytes = 0; this.clients = new Set();
    Object.assign(this, { maxEvents, maxBytes, maxClientBytes, maxClients, eventTypes });
    this.closed = false;
  }

  publish(type, data, session = null) {
    if (this.closed) return;
    const id = `${this.epoch}:${++this.sequence}`;
    let event = { id, type, at: new Date().toISOString(), session, data };
    let encoded = JSON.stringify(event);
    // Do not let a single unusually large status/event defeat bounded replay memory.
    if (Buffer.byteLength(encoded) > 128 * 1024) {
      event = { id, type, at: event.at, session, data: { truncated: true, reason: 'integration_event_size_limit', seq: data?.seq, sid: data?.sid } };
      encoded = JSON.stringify(event);
    }
    // Snapshot before storing: caller mutations must not change a replayed delivery.
    event = JSON.parse(encoded);
    const entry = { event, encoded, bytes: Buffer.byteLength(encoded) };
    this.events.push(entry); this.bytes += entry.bytes;
    while (this.events.length > this.maxEvents || this.bytes > this.maxBytes) this.bytes -= this.events.shift().bytes;
    for (const client of this.clients) if (this.matches(client, event)) this.write(client, this.frame(entry, client.legacy));
    this.emit('delivery', event);
    return event;
  }

  matches(filter, event) {
    return (!filter.session || filter.session === event.session)
      && (!filter.types.size || filter.types.has(event.type))
      && (!filter.sid || event.data?.sid === filter.sid)
      && (!filter.kinds?.size || filter.kinds.has(event.data?.kind) || filter.kinds.has(event.data?.k) || filter.kinds.has(event.type));
  }

  frame(entry, legacy) {
    return `id: ${entry.event.id}\nevent: ${entry.event.type}\ndata: ${legacy ? JSON.stringify(entry.event.data) : entry.encoded}\n\n`;
  }

  write(client, frame) {
    if (client.res.destroyed || client.res.writableEnded) { client.cleanup(); return false; }
    if (client.res.writableLength + Buffer.byteLength(frame) > this.maxClientBytes) {
      // Disconnect slow clients; Last-Event-ID resumes within the retained window.
      client.res.destroy(); client.cleanup(); return false;
    }
    client.res.write(frame);
    return true;
  }

  subscribe(req, res, q = {}, { legacy = false, status = {} } = {}) {
    if (this.closed) throw problem(503, 'Event feed is closing');
    if (this.clients.size >= this.maxClients) throw problem(429, 'Too many event stream subscribers');
    const types = new Set(q.types ? String(q.types).split(',').filter(Boolean) : []);
    for (const type of types) if (!this.eventTypes.includes(type)) throw problem(400, `Unknown event type: ${type}`);
    const kinds = new Set(q.kind ? String(q.kind).split(',').filter(Boolean) : []);
    const cursor = req.headers['last-event-id'] ?? q.after;
    const replay = integer(q.replay, 0, this.maxEvents);
    let from = this.sequence, reset = null;
    if (cursor !== undefined) {
      const m = /^([a-f0-9]{16}):(\d+)$/.exec(String(cursor));
      if (!m || !Number.isSafeInteger(Number(m[2]))) throw problem(400, 'Invalid event cursor');
      from = Number(m[2]);
      const oldest = this.events[0]?.event.id.split(':')[1] ?? this.sequence + 1;
      if (m[1] !== this.epoch || from > this.sequence || from < Number(oldest) - 1) {
        reset = { reason: m[1] !== this.epoch ? 'server_restarted' : 'cursor_outside_retained_window', oldest: this.events[0]?.event.id ?? null, latest: `${this.epoch}:${this.sequence}`, durableRecovery: '/api/v1/sessions/{session}/replay/records' };
        from = Number(oldest) - 1;
      }
    } else if (replay) from = Math.max(0, this.sequence - replay);
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no', 'x-content-type-options': 'nosniff' });
    const client = { res, types, kinds, session: q.session, sid: q.sid, legacy, cleanup: () => { clearInterval(client.timer); this.clients.delete(client); } };
    res.on('close', client.cleanup); res.on('error', client.cleanup);
    this.clients.add(client);
    this.write(client, 'retry: 2000\n\n');
    if (reset) this.write(client, `event: reset\ndata: ${JSON.stringify(reset)}\n\n`);
    // Control messages have no ID, so reconnect never advances past a missed data event.
    this.write(client, legacy ? `event: status\ndata: ${JSON.stringify(status)}\n\n`
      : `event: hello\ndata: ${JSON.stringify({ cursor: `${this.epoch}:${this.sequence}`, status, preview: true, durable: false, retained: this.events.length })}\n\n`);
    for (const entry of this.events) {
      if (Number(entry.event.id.split(':')[1]) > from && this.matches(client, entry.event)) {
        if (!this.write(client, this.frame(entry, legacy))) return;
      }
    }
    if (!this.clients.has(client)) return;
    client.timer = setInterval(() => this.write(client, `: heartbeat ${Date.now()}\n\n`), 15000);
    client.timer.unref?.();
  }

  info() { return { epoch: this.epoch, latest: `${this.epoch}:${this.sequence}`, retainedEvents: this.events.length, retainedBytes: this.bytes, subscribers: this.clients.size, maxEvents: this.maxEvents, durable: false, preview: true }; }
  close() {
    this.closed = true;
    for (const client of this.clients) { client.res.end(); client.cleanup(); }
    this.events = []; this.bytes = 0;
  }
}
