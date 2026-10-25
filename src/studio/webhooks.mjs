// Explicitly registered, process-lifetime local integrations. Never forward Studio auth.
// No redirects, no DNS lookup, no remote destinations, no retry of uncertain effects.
import http from 'node:http';
import https from 'node:https';
import { createHmac, randomBytes } from 'node:crypto';
import { EVENT_TYPES } from './event-feed.mjs';
import { problem, object, text } from './http.mjs';

export class Webhooks {
  constructor(feed, { forbiddenPorts = () => [] } = {}) {
    this.feed = feed; this.forbiddenPorts = forbiddenPorts;
    this.hooks = new Map(); this.closed = false;
    this.onDelivery = (event) => this.dispatch(event);
    feed.on('delivery', this.onDelivery);
  }

  register(input) {
    object(input);
    if (this.closed) throw problem(503, 'Webhooks are closing');
    // A registration POST is the explicit local-owner operation; no redundant
    // confirm checkbox or artificial 16-hook cap. Delivery remains 127.0.0.1/[::1] only.
    let url;
    try { url = new URL(text(input.url, 'url', 2048)); } catch { throw problem(400, 'Invalid webhook URL'); }
    if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', '[::1]'].includes(url.hostname)
      || url.username || url.password || url.hash || url.search) throw problem(400, 'Webhook URL must use literal 127.0.0.1 or [::1], HTTP(S), and no credentials, query or fragment');
    const destinationPort = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    if (this.forbiddenPorts().includes(destinationPort)) throw problem(400, 'Studio and DevTools ports cannot be webhook destinations');
    const events = input.events ?? ['started', 'stopped', 'session.derived'];
    if (!Array.isArray(events) || !events.length || events.some((e) => !EVENT_TYPES.includes(e))) throw problem(400, 'events must be a nonempty list of supported event types');
    if (input.session !== undefined) text(input.session, 'session', 128);
    if (input.includePayload !== undefined && typeof input.includePayload !== 'boolean') throw problem(400, 'includePayload must be boolean');
    const hook = { id: randomBytes(12).toString('hex'), url: url.href, events: [...new Set(events)], session: input.session ?? null,
      includePayload: input.includePayload === true, secret: randomBytes(32).toString('base64url'), createdAt: new Date().toISOString(),
      queue: [], queuedBytes: 0, delivered: 0, failed: 0, dropped: 0, active: null, receipts: [] };
    this.hooks.set(hook.id, hook);
    return { ...this.view(hook), secret: hook.secret, secretNote: 'Returned once; HMAC-SHA256 over timestamp + dot + exact request body. Registration expires on Studio shutdown.' };
  }

  view(hook) {
    return { id: hook.id, url: hook.url, events: hook.events, session: hook.session, includePayload: hook.includePayload,
      createdAt: hook.createdAt, pending: hook.queue.length, inFlight: !!hook.active, delivered: hook.delivered, failed: hook.failed, dropped: hook.dropped,
      lastDelivery: hook.receipts.at(-1) ?? null, durable: false, retries: false };
  }
  get(id) { const hook = this.hooks.get(id); if (!hook) throw problem(404, 'Webhook not found', 'NOT_FOUND'); return hook; }
  list() { return [...this.hooks.values()].map((h) => this.view(h)); }
  remove(id) {
    const hook = this.get(id); this.hooks.delete(id);
    hook.active?.destroy(); hook.queue = []; hook.queuedBytes = 0;
    return { deleted: id, inFlightMayHaveBeenDelivered: !!hook.active };
  }

  dispatch(event) {
    if (this.closed) return;
    for (const hook of this.hooks.values()) {
      if (!hook.events.includes(event.type) || (hook.session && hook.session !== event.session)) continue;
      // Payloads can contain private captured content. Default envelope contains no URLs/text.
      const data = hook.includePayload ? event.data : Object.fromEntries(['seq', 't', 'sid', 'k', 'state'].filter((k) => event.data?.[k] !== undefined).map((k) => [k, event.data[k]]));
      const body = JSON.stringify({ schema: 'capture-studio.webhook/1', id: event.id, type: event.type, at: event.at, session: event.session, preview: true, payloadIncluded: hook.includePayload, data });
      const bytes = Buffer.byteLength(body);
      if (hook.queue.length >= 100 || hook.queuedBytes + bytes > 1024 * 1024) { hook.dropped++; continue; }
      hook.queue.push({ body, bytes, eventId: event.id }); hook.queuedBytes += bytes;
      this.pump(hook);
    }
  }

  pump(hook) {
    if (hook.active || !hook.queue.length || this.closed || !this.hooks.has(hook.id)) return;
    const item = hook.queue.shift(); hook.queuedBytes -= item.bytes;
    const stamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac('sha256', hook.secret).update(`${stamp}.${item.body}`).digest('hex');
    const started = Date.now();
    let finished = false, deadline;
    const done = (status, error = null) => {
      if (finished) return; finished = true; clearTimeout(deadline);
      const ok = status >= 200 && status < 300;
      if (ok) hook.delivered++; else hook.failed++;
      hook.receipts.push({ eventId: item.eventId, at: new Date().toISOString(), status: status ?? null, ok, error, durationMs: Date.now() - started,
        outcome: ok ? 'acknowledged' : status ? 'http_rejected' : 'delivery_unknown' });
      if (hook.receipts.length > 100) hook.receipts.shift();
      hook.active = null;
      setImmediate(() => this.pump(hook));
    };
    try {
      const transport = hook.url.startsWith('https:') ? https : http;
      const req = transport.request(hook.url, { method: 'POST', agent: false, headers: {
        'content-type': 'application/json', 'content-length': item.bytes,
        'x-capture-event-id': item.eventId, 'x-capture-timestamp': stamp, 'x-capture-signature': `sha256=${signature}`,
      } }, (response) => {
        // Status is sufficient. Never collect arbitrary receiver bodies or follow redirects.
        done(response.statusCode); response.destroy();
      });
      hook.active = req;
      req.on('error', () => done(null, 'network_error_or_timeout'));
      deadline = setTimeout(() => req.destroy(new Error('delivery timeout')), 5000);
      deadline.unref?.();
      req.end(item.body);
    } catch { done(null, 'request_failed'); }
  }

  close() {
    this.closed = true; this.feed.off('delivery', this.onDelivery);
    for (const hook of this.hooks.values()) { hook.active?.destroy(); hook.queue = []; hook.queuedBytes = 0; }
    this.hooks.clear();
  }
}
