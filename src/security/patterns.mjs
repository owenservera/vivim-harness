/**
 * Secret / PII pattern engine for the capture studio.
 *
 * Deterministic, dependency-free. Every pattern carries a name, a kind, a
 * global regex, an optional validator and a confidence. Detection resolves
 * overlaps by confidence (then length), output is sorted by `start`.
 */

const B64URL = 'A-Za-z0-9_-';

function fresh(regex) {
  return new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : `${regex.flags}g`);
}

function decodeBase64Url(part) {
  try {
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    return Buffer.from(padded, 'base64').toString('utf8');
  } catch {
    return '';
  }
}

/** Luhn checksum over a digit string (non-digits are ignored). */
export function luhn(digits) {
  const d = String(digits ?? '').replace(/\D/g, '');
  if (d.length < 2) return false;
  let sum = 0;
  let dbl = false;
  for (let i = d.length - 1; i >= 0; i -= 1) {
    let n = d.charCodeAt(i) - 48;
    if (dbl) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

/** ISO 13616 IBAN check (mod-97 === 1). */
export function ibanMod97(iban) {
  const s = String(iban ?? '').replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(s)) return false;
  const rearranged = s.slice(4) + s.slice(0, 4);
  let rem = 0;
  for (const ch of rearranged) {
    const chunk =
      ch >= 'A' && ch <= 'Z' ? String(ch.charCodeAt(0) - 55) : ch >= '0' && ch <= '9' ? ch : null;
    if (chunk === null) return false;
    for (const c of chunk) rem = (rem * 10 + (c.charCodeAt(0) - 48)) % 97;
  }
  return rem === 1;
}

/** Shannon entropy in bits per character. */
export function shannonEntropy(str) {
  const s = String(str ?? '');
  if (s.length === 0) return 0;
  const counts = new Map();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

function jsonFieldValue(match) {
  const m = /[:=]\s*["']?([^"'\s,;\]}]+)/.exec(match);
  return m ? m[1] : '';
}

const PLACEHOLDER = /^(null|true|false|none|undefined|nil|nan|string|changeme|\*+|x+|\$\{[^}]*\}|<[^>]*>)$/i;

function digitsOf(s) {
  return String(s ?? '').replace(/\D/g, '');
}

/**
 * @type {Array<{
 *   name: string,
 *   kind: 'credential'|'pii',
 *   regex: RegExp,
 *   validate?: (match: string) => boolean,
 *   confidence: number,
 * }>}
 */
export const PATTERNS = [
  {
    name: 'aws_access_key',
    kind: 'credential',
    regex: /(?<![A-Z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Z0-9])/g,
    confidence: 0.98,
  },
  {
    name: 'private_key_block',
    kind: 'credential',
    regex:
      /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)? PRIVATE KEY-----/g,
    confidence: 0.99,
  },
  {
    name: 'jwt',
    kind: 'credential',
    regex: new RegExp(`\\b[${B64URL}]{8,}\\.[${B64URL}]{8,}\\.[${B64URL}]{8,}\\b`, 'g'),
    validate(match) {
      const [header] = match.split('.');
      const text = decodeBase64Url(header);
      if (!text) return false;
      try {
        const parsed = JSON.parse(text);
        return Boolean(parsed && typeof parsed === 'object' && typeof parsed.alg === 'string');
      } catch {
        return false;
      }
    },
    confidence: 0.9,
  },
  {
    name: 'bearer_token',
    kind: 'credential',
    regex: /(?<=[Bb]earer )[A-Za-z0-9._~+/=-]{8,}/g,
    confidence: 0.85,
  },
  {
    name: 'json_credential_field',
    kind: 'credential',
    regex:
      /(?:password|passwd|client_secret|access_token|refresh_token|api_key|apiKey|apikey|secret|token)\s*["']?\s*[:=]\s*["']?([^"'\s,;\]}]{3,})/gi,
    validate(match) {
      const value = jsonFieldValue(match);
      return value.length >= 3 && !PLACEHOLDER.test(value);
    },
    confidence: 0.8,
  },
  {
    name: 'github_token',
    kind: 'credential',
    regex: /gh[pousr]_[A-Za-z0-9]{36}/g,
    confidence: 0.97,
  },
  {
    name: 'slack_token',
    kind: 'credential',
    regex: /xox[baprs]-[A-Za-z0-9-]{10,}/g,
    confidence: 0.95,
  },
  {
    name: 'credit_card',
    kind: 'credential',
    regex: /\b(?:\d[ -]?){12,18}\d\b/g,
    validate(match) {
      const d = digitsOf(match);
      return d.length >= 13 && d.length <= 19 && luhn(d);
    },
    confidence: 0.85,
  },
  {
    name: 'iban',
    kind: 'credential',
    regex: /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g,
    validate(match) {
      return ibanMod97(match);
    },
    confidence: 0.85,
  },
  {
    name: 'email',
    kind: 'pii',
    regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g,
    confidence: 0.9,
  },
  {
    name: 'phone_e164',
    kind: 'pii',
    regex: /(?<![\w+])\+[1-9]\d{0,2}[\s.-]?\(?\d{2,4}\)?[\s.-]?\d{3,4}[\s.-]?\d{3,4}(?!\w)/g,
    validate(match) {
      const d = digitsOf(match);
      return d.length >= 8 && d.length <= 15;
    },
    confidence: 0.7,
  },
  {
    name: 'ipv4',
    kind: 'pii',
    regex: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
    validate(match) {
      const parts = match.split('.');
      if (parts.length !== 4) return false;
      return parts.every((p) => {
        if (!/^\d{1,3}$/.test(p)) return false;
        if (p.length > 1 && p.startsWith('0')) return false;
        return Number(p) <= 255;
      });
    },
    confidence: 0.6,
  },
  {
    name: 'high_entropy_token',
    kind: 'credential',
    regex: /[A-Za-z0-9+/_-]{24,}/g,
    validate(match) {
      if (shannonEntropy(match) < 4.0) return false;
      // Reject anything already covered by a named pattern.
      for (const other of PATTERNS) {
        if (other === undefined) continue;
        const re = fresh(other.regex);
        let m;
        while ((m = re.exec(match)) !== null) {
          if (m[0].length === 0) {
            re.lastIndex += 1;
            continue;
          }
          if (m[0].length >= match.length * 0.8) return false;
        }
      }
      return true;
    },
    confidence: 0.5,
  },
];

const HIGH_ENTROPY = 'high_entropy_token';

function allowedByOptions(pattern, { extended, pii }) {
  if (pattern.name === HIGH_ENTROPY && !extended) return false;
  if (pattern.kind === 'credential') return true;
  return pii === true;
}

/**
 * @param {string} text
 * @param {{extended?: boolean, pii?: boolean}} [opts]
 * @returns {Array<{name: string, kind: 'credential'|'pii', start: number, end: number, confidence: number}>}
 */
export function detectSecrets(text, { extended = false, pii = false } = {}) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const opts = { extended: extended === true, pii: pii === true };
  const candidates = [];

  for (const pattern of PATTERNS) {
    if (!allowedByOptions(pattern, opts)) continue;
    const re = fresh(pattern.regex);
    let m;
    while ((m = re.exec(text)) !== null) {
      if (m[0].length === 0) {
        re.lastIndex += 1;
        continue;
      }
      if (pattern.validate && pattern.validate(m[0]) !== true) continue;
      candidates.push({
        name: pattern.name,
        kind: pattern.kind,
        start: m.index,
        end: m.index + m[0].length,
        confidence: pattern.confidence,
      });
    }
  }

  candidates.sort(
    (a, b) =>
      b.confidence - a.confidence ||
      b.end - b.start - (a.end - a.start) ||
      a.start - b.start,
  );

  const picked = [];
  for (const candidate of candidates) {
    const overlaps = picked.some((kept) => candidate.start < kept.end && kept.start < candidate.end);
    if (!overlaps) picked.push(candidate);
  }

  picked.sort((a, b) => a.start - b.start);
  return picked;
}

/**
 * Replace every detection with a mask.
 * @param {string} text
 * @param {{extended?: boolean, pii?: boolean}} [opts]
 * @param {string} [mask] `{name}` is substituted with the pattern name.
 */
export function scrub(text, opts = {}, mask = '[REDACTED:{name}]') {
  if (typeof text !== 'string') return { text: '', found: 0 };
  const hits = detectSecrets(text, opts);
  if (hits.length === 0) return { text, found: 0 };
  let out = text;
  for (let i = hits.length - 1; i >= 0; i -= 1) {
    const hit = hits[i];
    out = out.slice(0, hit.start) + String(mask).replace(/\{name\}/g, hit.name) + out.slice(hit.end);
  }
  return { text: out, found: hits.length };
}

/** Register every pattern into `registry` under kind `secretPatterns`. */
export function registerPatterns(registry) {
  if (!registry || typeof registry.register !== 'function') {
    throw new TypeError('registerPatterns: a registry is required');
  }
  for (const pattern of PATTERNS) {
    registry.register('secretPatterns', pattern.name, pattern, {
      replace: true,
      builtin: true,
      meta: { kind: pattern.kind, confidence: pattern.confidence, validated: typeof pattern.validate === 'function' },
    });
  }
  return PATTERNS.length;
}

export default PATTERNS;
