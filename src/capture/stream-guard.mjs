// Pre-persistence streaming credential quarantine.
//
// A completed-buffer regex cannot protect independently appended HTTP chunks or
// WebSocket frames. Hold back at least the longest recognizable marker, then
// refuse to persist ANY pending payload when one appears. This deliberately
// over-excludes content, rather than claiming arbitrary bytes are credential-free.
// It is not universal secret detection. Rules match the scrubber's supported
// credential family plus common API-token prefixes. This guard is used only in
// optional filtered mode; local-raw mode preserves the original stream. See W4 notes.
import { scrubSecrets } from './redact.mjs';

export const STREAM_GUARD_HOLDBACK = 128;
export const STREAM_GUARD_MAX_BUFFER = 1024 * 1024;

// The complete sensitive VALUE does not need to be visible before we exclude
// it. A marker in the withheld tail is sufficient, including when the marker
// itself was split across CDP chunks / frames.
const CANDIDATE = /"(?:access_?token|refresh_?token|id_?token|session_?token|accessToken|refreshToken|idToken|sessionToken|api_?key|apiKey|client_?secret|password|authorization|cookie|csrf_?token|csrfToken)"|\bBearer\b|eyJ|sk-[A-Za-z0-9_-]*|gh[pousr]_|github_pat_/i;

export function credentialCandidate(bytes) {
  return CANDIDATE.test(bytes.toString('latin1'));
}

const empty = () => Buffer.alloc(0);
const safe = (bytes) => {
  const result = scrubSecrets(bytes);
  return { bytes: result.bytes, redactions: result.redactions };
};

// HTTP/SSE: may emit slightly delayed, sanitized byte chunks. The held bytes
// are never persisted until later input, and never on abnormal termination.
export class ChunkCredentialGuard {
  constructor({ holdbackBytes = STREAM_GUARD_HOLDBACK, maxBufferedBytes = STREAM_GUARD_MAX_BUFFER } = {}) {
    this.holdbackBytes = holdbackBytes;
    this.maxBufferedBytes = maxBufferedBytes;
    this.pending = empty();
    this.excluded = false;
    this.reason = null;
  }
  push(input) {
    if (this.excluded) return { bytes: empty(), redactions: [], excluded: false };
    if (!Buffer.isBuffer(input) || input.length > this.maxBufferedBytes) return this.exclude('security_scan_limit');
    const combined = Buffer.concat([this.pending, input]);
    if (combined.length > this.maxBufferedBytes + this.holdbackBytes) return this.exclude('security_scan_limit');
    if (credentialCandidate(combined)) return this.exclude('credential_candidate');
    const count = Math.max(0, combined.length - this.holdbackBytes);
    const emitted = safe(combined.subarray(0, count));
    this.pending = Buffer.from(combined.subarray(count));
    return { ...emitted, excluded: false };
  }
  finish() {
    if (this.excluded) return { bytes: empty(), redactions: [], excluded: false };
    const remainder = this.pending;
    this.pending = empty();
    if (credentialCandidate(remainder)) return this.exclude('credential_candidate');
    return { ...safe(remainder), excluded: false };
  }
  exclude(reason) {
    this.excluded = true;
    this.reason = reason;
    this.pending = empty();
    return { bytes: empty(), redactions: [], excluded: true, reason };
  }
  discard() {
    const hadPending = this.pending.length > 0;
    this.pending = empty();
    return hadPending;
  }
}

// WS: preserve WHOLE frame boundaries and order. A frame is emitted only once
// at least holdbackBytes of subsequent payload has been observed. If a marker
// spans frames, queued content is discarded and all further frames are metadata.
// A large uninspectable frame also fails closed.
export class FrameCredentialGuard {
  constructor({ holdbackBytes = STREAM_GUARD_HOLDBACK, maxBufferedBytes = STREAM_GUARD_MAX_BUFFER,
    maxPendingFrames = 4096 } = {}) {
    this.holdbackBytes = holdbackBytes;
    this.maxBufferedBytes = maxBufferedBytes;
    this.maxPendingFrames = maxPendingFrames;
    this.pending = [];
    this.bytes = 0;
    this.excluded = false;
    this.reason = null;
  }
  push(frame, bytes) {
    if (this.excluded) return { frames: [], excluded: false, dropped: [] };
    if (!Buffer.isBuffer(bytes) || bytes.length > this.maxBufferedBytes) return this.exclude('security_scan_limit', { frame, bytes: bytes?.length ?? 0 });
    this.pending.push({ frame, bytes });
    this.bytes += bytes.length;
    if (this.bytes > this.maxBufferedBytes || this.pending.length > this.maxPendingFrames)
      return this.exclude('security_scan_limit');
    if (credentialCandidate(Buffer.concat(this.pending.map((f) => f.bytes), this.bytes))) return this.exclude('credential_candidate');
    const frames = [];
    while (this.pending.length && this.bytes - this.pending[0].bytes.length >= this.holdbackBytes) {
      const first = this.pending.shift();
      this.bytes -= first.bytes.length;
      frames.push(first.frame);
    }
    return { frames, excluded: false, dropped: [] };
  }
  finish() {
    if (this.excluded) return { frames: [], excluded: false, dropped: [] };
    const frames = this.pending.map((x) => x.frame);
    this.pending = [];
    this.bytes = 0;
    return { frames, excluded: false, dropped: [] };
  }
  exclude(reason, extra = null) {
    const dropped = this.pending.map((x) => ({ frame: x.frame, bytes: x.bytes.length }));
    if (extra) dropped.push(extra);
    this.pending = [];
    this.bytes = 0;
    this.excluded = true;
    this.reason = reason;
    return { frames: [], excluded: true, reason, dropped };
  }
  discard() {
    const dropped = this.pending.map((x) => ({ frame: x.frame, bytes: x.bytes.length }));
    this.pending = [];
    this.bytes = 0;
    return dropped;
  }
}
