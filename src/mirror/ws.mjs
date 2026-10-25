// Minimal RFC 6455 WebSocket server side, zero dependencies.
//   - opening handshake (Sec-WebSocket-Accept, optional subprotocol, no extensions)
//   - frame parser for masked client frames: 7/16/64-bit lengths, fragmentation (opcode 0)
//   - text/binary send, ping -> pong, close handshake with status code + reason
// Compression extensions are never negotiated: captured frames are already payload-level.
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
export const OP = Object.freeze({ CONT: 0, TEXT: 1, BINARY: 2, CLOSE: 8, PING: 9, PONG: 10 });

export function acceptKey(key) {
  return createHash('sha1').update(String(key).trim() + GUID).digest('base64');
}

export function encodeFrame(opcode, payload = Buffer.alloc(0), { fin = true } = {}) {
  const p = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const len = p.length;
  let header;
  if (len < 126) { header = Buffer.alloc(2); header[1] = len; }
  else if (len < 65536) { header = Buffer.alloc(4); header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
  header[0] = (fin ? 0x80 : 0) | (opcode & 0x0f);
  return Buffer.concat([header, p]);
}

export class FrameParser {
  constructor({ maxPayload = 64 * 1024 * 1024 } = {}) { this.buf = Buffer.alloc(0); this.maxPayload = maxPayload; }
  // Returns complete frames; throws { code } on protocol violations.
  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out = [];
    for (;;) {
      const b = this.buf;
      if (b.length < 2) break;
      const fin = (b[0] & 0x80) !== 0, rsv = b[0] & 0x70, opcode = b[0] & 0x0f;
      const masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f, off = 2;
      if (rsv) throw Object.assign(new Error('RSV bits set without a negotiated extension'), { code: 1002 });
      if (len === 126) { if (b.length < 4) break; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) {
        if (b.length < 10) break;
        const big = b.readBigUInt64BE(2);
        if (big > BigInt(this.maxPayload)) throw Object.assign(new Error('frame too large'), { code: 1009 });
        len = Number(big); off = 10;
      }
      if (len > this.maxPayload) throw Object.assign(new Error('frame too large'), { code: 1009 });
      if (opcode >= 8 && (len > 125 || !fin)) throw Object.assign(new Error('invalid control frame'), { code: 1002 });
      const maskOff = off;
      if (masked) off += 4;
      if (b.length < off + len) break;
      let payload = Buffer.from(b.subarray(off, off + len));
      if (masked) { const m = b.subarray(maskOff, maskOff + 4); for (let i = 0; i < payload.length; i++) payload[i] ^= m[i & 3]; }
      this.buf = b.subarray(off + len);
      out.push({ fin, opcode, masked, payload });
    }
    return out;
  }
}

export class WsConnection extends EventEmitter {
  constructor(socket, { protocol = null, requireMask = true, maxMessage = 64 * 1024 * 1024 } = {}) {
    super();
    this.socket = socket;
    this.protocol = protocol;
    this.requireMask = requireMask;
    this.maxMessage = maxMessage;
    this.parser = new FrameParser({ maxPayload: maxMessage });
    this.partial = null;
    this.state = 'open';
    this.sent = { frames: 0, bytes: 0 };
    this.received = { frames: 0, bytes: 0 };
    socket.setNoDelay?.(true);
    socket.on('data', (d) => this._data(d));
    socket.on('close', () => this._closed(1006, ''));
    socket.on('error', () => this._closed(1006, 'socket error'));
  }

  get open() { return this.state === 'open'; }

  _data(chunk) {
    let frames;
    try { frames = this.parser.push(chunk); } catch (e) { this.close(e.code ?? 1002, e.message); return; }
    for (const f of frames) {
      if (this.state === 'closed') return;
      if (this.requireMask && !f.masked) { this.close(1002, 'client frames must be masked'); return; }
      this.received.frames++; this.received.bytes += f.payload.length;
      switch (f.opcode) {
        case OP.PING: this._write(OP.PONG, f.payload); this.emit('ping', f.payload); break;
        case OP.PONG: this.emit('pong', f.payload); break;
        case OP.CLOSE: {
          const code = f.payload.length >= 2 ? f.payload.readUInt16BE(0) : 1005;
          const reason = f.payload.length > 2 ? f.payload.subarray(2).toString('utf8') : '';
          if (this.state === 'open') { this.state = 'closing'; this._write(OP.CLOSE, f.payload.length >= 2 ? f.payload.subarray(0, 2) : Buffer.alloc(0)); }
          this.socket.end();
          this._closed(code, reason);
          return;
        }
        case OP.TEXT:
        case OP.BINARY:
          if (this.partial) { this.close(1002, 'new message inside a fragmented message'); return; }
          if (f.fin) this._message(f.opcode, f.payload);
          else this.partial = { opcode: f.opcode, parts: [f.payload], size: f.payload.length };
          break;
        case OP.CONT:
          if (!this.partial) { this.close(1002, 'continuation without a message'); return; }
          this.partial.parts.push(f.payload); this.partial.size += f.payload.length;
          if (this.partial.size > this.maxMessage) { this.close(1009, 'message too large'); return; }
          if (f.fin) { const p = this.partial; this.partial = null; this._message(p.opcode, Buffer.concat(p.parts)); }
          break;
        default: this.close(1002, `unknown opcode ${f.opcode}`); return;
      }
    }
  }

  _message(opcode, data) {
    this.emit('message', { opcode, data, text: opcode === OP.TEXT ? data.toString('utf8') : null });
  }

  _write(opcode, payload) {
    if (this.socket.destroyed || this.socket.writableEnded) return false;
    const frame = encodeFrame(opcode, payload);
    this.sent.frames++; this.sent.bytes += frame.length;
    return this.socket.write(frame);
  }

  send(data, opcode) {
    if (this.state !== 'open') return false;
    const op = opcode ?? (Buffer.isBuffer(data) ? OP.BINARY : OP.TEXT);
    return this._write(op, data);
  }

  ping(data = Buffer.alloc(0)) { return this.state === 'open' ? this._write(OP.PING, data) : false; }

  close(code = 1000, reason = '') {
    if (this.state !== 'open') return;
    this.state = 'closing';
    // Control-frame payloads cap the reason at 123 bytes; never split a multi-byte UTF-8 sequence.
    let n = 123;
    const full = Buffer.from(String(reason));
    while (n > 0 && (full[n] & 0xc0) === 0x80) n--;
    const r = full.subarray(0, n);
    const p = Buffer.alloc(2 + r.length);
    p.writeUInt16BE(code, 0); r.copy(p, 2);
    this._write(OP.CLOSE, p);
    // Give the peer a moment to answer the close, then drop the TCP connection.
    const t = setTimeout(() => this.socket.destroy(), 1000);
    t.unref?.();
    this.socket.end();
    this._closed(code, String(reason));
  }

  terminate() { this.socket.destroy(); this._closed(1006, 'terminated'); }

  _closed(code, reason) {
    if (this.state === 'closed') return;
    this.state = 'closed';
    this.emit('close', { code, reason });
  }
}

// Completes the opening handshake on an http 'upgrade' socket. Returns a WsConnection or null
// (after answering with an HTTP error).
export function acceptUpgrade(req, socket, head, { selectProtocol, extraHeaders = {} } = {}) {
  const key = req.headers['sec-websocket-key'];
  const version = req.headers['sec-websocket-version'];
  const reject = (status, text) => {
    try { socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch { socket.destroy(); }
    return null;
  };
  if (req.method !== 'GET' || !key || !/^[A-Za-z0-9+/]{22}==$/.test(String(key).trim())) return reject(400, 'Bad Request');
  if (version && String(version) !== '13') {
    try { socket.end('HTTP/1.1 426 Upgrade Required\r\nSec-WebSocket-Version: 13\r\nContent-Length: 0\r\n\r\n'); } catch { socket.destroy(); }
    return null;
  }
  const requested = String(req.headers['sec-websocket-protocol'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const protocol = requested.length && selectProtocol ? selectProtocol(requested) : null;
  const lines = [
    'HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptKey(key)}`,
  ];
  if (protocol && requested.includes(protocol)) lines.push(`Sec-WebSocket-Protocol: ${protocol}`);
  for (const [k, v] of Object.entries(extraHeaders)) if (/^[\w-]+$/.test(k) && !/[\r\n]/.test(String(v))) lines.push(`${k}: ${v}`);
  socket.write(lines.join('\r\n') + '\r\n\r\n');
  const conn = new WsConnection(socket, { protocol: protocol && requested.includes(protocol) ? protocol : null });
  // Bytes that arrived with the upgrade are parsed after the caller has attached its listeners.
  if (head?.length) { const h = Buffer.from(head); setImmediate(() => conn._data(h)); }
  return conn;
}
