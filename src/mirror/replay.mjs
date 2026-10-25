// Replay plans and timed writers.
//
// Timing: offsets are measured from the captured request (or WebSocket open). Consecutive records
// that both carry the browser's monotonic timestamp (ct, seconds) use its difference; otherwise
// the collector's wall clock (t, ms) is used. speed > 1 plays faster, instant skips every wait.
import { setTimeout as sleep } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';

// ---------------------------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------------------------
export function createClock({ speed = 1, instant = false } = {}) {
  const start = performance.now();
  const factor = instant || !(Number(speed) > 0) || !Number.isFinite(Number(speed)) ? 0 : 1 / Number(speed);
  return {
    instant: factor === 0,
    elapsed: () => performance.now() - start,
    async until(atMs, signal) {
      if (signal?.aborted) throw signal.reason ?? new Error('aborted');
      if (factor === 0) return;
      const wait = start + Math.max(0, atMs) * factor - performance.now();
      if (wait > 1) await sleep(wait, undefined, signal ? { signal } : undefined);
    },
  };
}

export function relativeTimes(records, t0) {
  const out = [];
  let lastAt = 0, lastCt = null;
  for (const r of records) {
    let at;
    if (typeof r.ct === 'number' && lastCt !== null) at = lastAt + Math.max(0, (r.ct - lastCt) * 1000);
    else at = Math.max(lastAt, (r.t ?? t0) - t0);
    out.push(at);
    lastAt = at;
    lastCt = typeof r.ct === 'number' ? r.ct : null;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------------------------
const DROP_RES_HEADERS = new Set([
  'content-length', 'content-encoding', 'transfer-encoding', 'connection', 'keep-alive', 'set-cookie', 'cookie',
  'strict-transport-security', 'alt-svc', 'content-security-policy', 'content-security-policy-report-only',
  'report-to', 'nel', 'upgrade', 'proxy-connection', 'trailer', 'te', 'access-control-allow-origin',
  'access-control-allow-credentials', 'public-key-pins', 'expect-ct', 'location',
]);

export function cleanResponseHeaders(headers) {
  const out = [];
  for (const [name, value] of Object.entries(headers ?? {})) {
    const n = name.toLowerCase();
    if (n.startsWith(':') || DROP_RES_HEADERS.has(n)) continue;
    if (value === '[redacted]' || value === '[dropped]' || value === undefined || value === null) continue;
    const values = String(value).split('\n').map((v) => v.trim()).filter((v) => v && !/[\r\0]/.test(v));
    if (values.length) out.push([n, values.length === 1 ? values[0] : values]);
  }
  return out;
}

// Rewrite an absolute URL on a captured host to a mirror-relative path.
export function localizeUrl(url, hosts) {
  try {
    const u = new URL(url);
    if (hosts.includes(u.host)) return `${u.pathname}${u.search}${u.hash}`;
  } catch { /* relative already */ }
  return url;
}

// { status, headers:[[k,v]], headersAt, parts:[{at,buf}], endAt, end:'end'|'destroy', notes }
export function buildHttpPlan(ex, records, { hosts = [] } = {}) {
  const ats = relativeTimes(records, ex.startT ?? records[0]?.t ?? 0);
  let status, headers = [], headersAt = null, endAt = null, end = 'end', mime;
  const parts = [], es = [], notes = {};
  records.forEach((r, i) => {
    const at = ats[i];
    switch (r.k) {
      case 'res': status = r.status; mime = r.mime; headers = cleanResponseHeaders(r.headers); headersAt = at; if (r.redirect) notes.redirect = true; break;
      case 'chunk':
      case 'body':
        if (r.bodyDropped) { notes.bodyDropped = true; break; }
        parts.push({ at, buf: Buffer.from(r.b64 ?? '', 'base64') });
        if (r.redactions?.length) notes.redactions = (notes.redactions ?? 0) + r.redactions.length;
        break;
      case 'es.msg': es.push({ at, rec: r }); break;
      case 'body.excluded': notes.excluded = r.reason ?? 'excluded'; break;
      case 'body.truncated': notes.truncated = true; break;
      case 'body.unavailable': notes.unavailable = true; break;
      case 'done': endAt = at; if (r.redirectedTo) notes.location = localizeUrl(r.redirectedTo, hosts); break;
      case 'fail': endAt = at; notes.failed = r.errorText ?? (r.canceled ? 'canceled' : 'failed'); end = 'destroy'; break;
      default: break;
    }
  });
  // EventSource captured only as browser-parsed messages: re-frame as SSE.
  if (!parts.length && es.length) {
    for (const { at, rec } of es) {
      let s = '';
      if (rec.eventName && rec.eventName !== 'message') s += `event: ${rec.eventName}\n`;
      if (rec.eventId) s += `id: ${rec.eventId}\n`;
      for (const line of String(rec.data ?? '').split('\n')) s += `data: ${line}\n`;
      parts.push({ at, buf: Buffer.from(s + '\n') });
    }
    notes.reframedFromEventSource = es.length;
    if (!headers.some(([k]) => k === 'content-type')) headers.push(['content-type', 'text/event-stream; charset=utf-8']);
  }
  if (status === undefined || status === 0) status = notes.failed && !parts.length ? 502 : 200;
  if ((status === 204 || status === 304) && parts.length) status = 200;
  if (notes.location && status >= 300 && status < 400) headers.push(['location', notes.location]);
  if (!headers.some(([k]) => k === 'content-type') && mime && parts.length) headers.push(['content-type', mime]);
  headersAt ??= 0;
  if (parts.length && parts[0].at < headersAt) headersAt = parts[0].at;
  endAt ??= parts.length ? parts[parts.length - 1].at : headersAt;
  endAt = Math.max(endAt, parts.length ? parts[parts.length - 1].at : 0);
  if (end === 'destroy' && !parts.length) end = 'end';  // nothing streamed: answer the failure status cleanly
  return { status, headers, headersAt, parts, endAt, end, notes, mime };
}

function waitDrain(res, signal) {
  return new Promise((resolve, reject) => {
    const done = () => { res.off('drain', done); signal?.removeEventListener('abort', ab); resolve(); };
    const ab = () => { res.off('drain', done); reject(signal.reason ?? new Error('aborted')); };
    res.once('drain', done);
    signal?.addEventListener('abort', ab, { once: true });
  });
}

// Writes a plan with timing. Returns { bytes, chunks, aborted }.
export async function sendHttpPlan(req, res, plan, { clock, extraHeaders = [], head = false }) {
  const ac = new AbortController();
  const onClose = () => { if (!res.writableFinished) ac.abort(new Error('client closed')); };
  res.on('close', onClose);
  req.socket?.setNoDelay?.(true);
  let bytes = 0, chunks = 0;
  try {
    res.statusCode = plan.status;
    for (const [k, v] of [...plan.headers, ...extraHeaders]) { try { res.setHeader(k, v); } catch { /* invalid captured header */ } }
    const single = plan.parts.length <= 1 && plan.end === 'end';
    if (single) res.setHeader('content-length', plan.parts[0]?.buf.length ?? 0);
    await clock.until(plan.headersAt, ac.signal);
    if (head || !plan.parts.length || single) {
      if (single && plan.parts.length) await clock.until(plan.parts[0].at, ac.signal);
      if (!head && plan.parts.length) { bytes = plan.parts[0].buf.length; chunks = 1; }
      await clock.until(plan.endAt, ac.signal);
      res.end(head ? undefined : plan.parts[0]?.buf);
      return { bytes, chunks, aborted: false };
    }
    res.flushHeaders();
    for (const p of plan.parts) {
      await clock.until(p.at, ac.signal);
      if (!p.buf.length) continue;
      chunks++; bytes += p.buf.length;
      if (!res.write(p.buf)) await waitDrain(res, ac.signal);
    }
    await clock.until(plan.endAt, ac.signal);
    if (plan.end === 'destroy') { res.destroy(); return { bytes, chunks, aborted: false, interrupted: true }; }
    res.end();
    return { bytes, chunks, aborted: false };
  } catch (e) {
    if (ac.signal.aborted) return { bytes, chunks, aborted: true };
    throw e;
  } finally { res.off('close', onClose); }
}

// ---------------------------------------------------------------------------------------------
// WebSocket script: turns triggered by client messages.
// ---------------------------------------------------------------------------------------------
// turn 0 = server frames sent on open; turn k = server frames that followed the k-th client frame.
export function buildWsScript(ex, records) {
  const ats = relativeTimes(records, ex.startT ?? records[0]?.t ?? 0);
  const frames = [];
  records.forEach((r, i) => {
    if (r.k === 'ws.frame') {
      const dir = r.dir === 'out' ? 'out' : 'in';
      // Fold continuation fragments into the message they continue (sent as one message).
      if (r.opcode === 0) {
        const prev = [...frames].reverse().find((x) => x.dir === dir && !x.metaOnly);
        if (prev?.payload) {
          prev.payload = Buffer.concat([prev.payload, Buffer.from(r.payload ?? '', prev.opcode === 2 ? 'base64' : 'utf8')]);
          if (prev.text !== null) prev.text += r.payload ?? '';
        }
        return;
      }
      const binaryish = r.opcode === 2 || r.opcode === 8;
      const payload = Buffer.from(r.payload ?? '', binaryish ? 'base64' : 'utf8');
      frames.push({ dir, opcode: r.opcode, payload, text: r.opcode === 1 ? (r.payload ?? '') : null, at: ats[i] });
    } else if (r.k === 'ws.frame_meta') {
      frames.push({ dir: r.dir === 'out' ? 'out' : 'in', opcode: r.opcode, payload: null, text: null, at: ats[i], metaOnly: true });
    }
  });
  const turns = [{ index: 0, trigger: null, start: 0, frames: [] }];
  for (const f of frames) {
    if (f.dir === 'out') {
      if (f.opcode === 9 || f.opcode === 10 || f.opcode === 8) continue;
      turns.push({ index: turns.length, trigger: f, start: f.at, frames: [] });
    } else if (!f.metaOnly && f.opcode !== 10) {
      const t = turns[turns.length - 1];
      t.frames.push({ ...f, rel: Math.max(0, f.at - t.start) });
    }
  }
  // Short client messages seen repeatedly (heartbeats) get a reusable turn.
  const counts = new Map();
  for (const t of turns) if (t.trigger?.text && t.trigger.text.length <= 40) counts.set(t.trigger.text, (counts.get(t.trigger.text) ?? 0) + 1);
  for (const t of turns) t.repeatable = !!(t.trigger?.text && (counts.get(t.trigger.text) ?? 0) >= 2);
  return {
    turns, mode: turns.length > 1 ? 'turns' : 'timeline',
    framesIn: frames.filter((f) => f.dir === 'in').length, framesOut: frames.filter((f) => f.dir === 'out').length,
  };
}
