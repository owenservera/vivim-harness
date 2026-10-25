// Optional filtered-mode masking helpers. Local-raw capture deliberately bypasses these helpers
// to preserve full on-PC evidence; see capturePrivacy() in privacy.mjs.
//  1. Headers: only an allowlist keeps values; every other header keeps its name, value -> "[redacted]".
//     Cookie / Set-Cookie / Authorization are dropped entirely.
//  2. URLs: query parameters with credential-like names are masked.
//  3. Endpoints that look like auth/session/token exchanges are captured as metadata only (no body).
//  4. Body bytes are scanned for JWT-like tokens and credential-like JSON fields; matches are
//     overwritten in place with '*' (same length, so offsets stay valid) and the redaction is
//     recorded on the record, so the deviation from byte-faithful capture is always disclosed.

const KEEP_HEADERS = new Set([
  'content-type', 'content-length', 'content-encoding', 'transfer-encoding', 'cache-control', 'vary', 'date',
  'server', 'accept', 'accept-encoding', 'accept-language', 'x-content-type-options', 'access-control-allow-origin',
  'sec-fetch-dest', 'sec-fetch-mode', 'sec-fetch-site', 'origin', 'connection', 'upgrade', 'sec-websocket-protocol',
  'sec-websocket-extensions', 'last-modified', 'etag', 'expires', 'age', 'x-request-id', 'cf-cache-status', 'alt-svc',
]);
const DROP_HEADERS = new Set(['cookie', 'set-cookie', 'authorization', 'proxy-authorization']);
const SECRET_PARAM = /(token|secret|password|passwd|auth|session|sig|signature|key|code|credential|jwt|bearer|otp|nonce)/i;

export const DEFAULT_SENSITIVE_URL = /\/(auth|oauth2?|login|logout|signin|signup|session|sessions|token|tokens|sso|saml|callback|account\/(security|password)|csrf)(\/|\?|$)/i;

export function redactHeaders(headers) {
  if (!headers) return undefined;
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    const n = name.toLowerCase();
    if (DROP_HEADERS.has(n)) { out[name] = '[dropped]'; continue; }
    if (n === 'referer') { out[name] = redactUrl(String(value)); continue; }
    out[name] = KEEP_HEADERS.has(n) ? value : '[redacted]';
  }
  return out;
}

export function redactUrl(url) {
  try {
    const u = new URL(url);
    let changed = false;
    for (const k of [...u.searchParams.keys()]) {
      if (SECRET_PARAM.test(k)) { u.searchParams.set(k, '[redacted]'); changed = true; }
    }
    if (u.username || u.password) { u.username = ''; u.password = ''; changed = true; }
    if (u.hash && /(access_token|id_token|token)=/i.test(u.hash)) { u.hash = '#[redacted]'; changed = true; }
    return changed ? u.toString() : url;
  } catch { return url; }
}

export function isSensitiveUrl(url, extraPatterns = []) {
  let pathPart = url;
  try { const u = new URL(url); pathPart = u.pathname + u.search; } catch { /* keep */ }
  if (DEFAULT_SENSITIVE_URL.test(pathPart)) return true;
  return extraPatterns.some((p) => new RegExp(p, 'i').test(url));
}

// Patterns are applied to latin1-decoded bytes so offsets equal byte offsets.
const SECRET_PATTERNS = [
  { kind: 'jwt', re: /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, group: 0 },
  { kind: 'json_credential', re: /"(?:access_?token|refresh_?token|id_?token|session_?token|accessToken|refreshToken|idToken|sessionToken|api_?key|apiKey|client_?secret|password|authorization|cookie|csrf_?token|csrfToken)"\s*:\s*"([^"\\]{6,})"/g, group: 1 },
  { kind: 'bearer', re: /Bearer\s+([A-Za-z0-9._~+/=-]{16,})/g, group: 1 },
];

// Returns { bytes, redactions:[{offset,length,kind}] }. Input/Output are Buffers.
export function scrubSecrets(buf) {
  if (!buf || !buf.length) return { bytes: buf, redactions: [] };
  const s = buf.toString('latin1');
  const redactions = [];
  for (const { kind, re, group } of SECRET_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(s))) {
      const full = m[0];
      const target = group === 0 ? full : m[group];
      const offset = m.index + (group === 0 ? 0 : full.indexOf(target));
      redactions.push({ offset, length: Buffer.byteLength(target, 'latin1'), kind });
    }
  }
  if (!redactions.length) return { bytes: buf, redactions };
  const out = Buffer.from(buf);
  for (const r of redactions) out.fill(0x2a, r.offset, r.offset + r.length);
  return { bytes: out, redactions: redactions.sort((a, b) => a.offset - b.offset) };
}

export function scrubText(text) {
  const { bytes, redactions } = scrubSecrets(Buffer.from(String(text), 'utf8'));
  return { text: redactions.length ? bytes.toString('utf8') : text, redactions };
}
