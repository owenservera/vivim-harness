// Mergeable bounded cardinality sketch (HyperLogLog, 256 registers by default).
import { createHash, hash as oneShotHash } from 'node:crypto';
import { typedValueKey } from './similarity.mjs';

// The sketch hash is part of persisted state (registers are serialized), so it stays sha256 over
// typedValueKey(value) read as the first big-endian uint32. Only the cost changes:
//  - crypto.hash() one-shot instead of createHash().update().digest() (no Hash object per call),
//  - primitives skip the generic stableStringify walk (typedValueKey of a primitive is
//    typeof + ':' + JSON.stringify(value), reproduced here verbatim),
//  - a small bounded memo, so the same value observed again (the schema profiler observes every
//    value twice: cumulative + window node; enums repeat constantly) is not re-hashed.
const MEMO_MAX = 8192;
const MEMO_STR_MAX = 256;
const PLAIN_STRING = /^[\x20\x21\x23-\x5b\x5d-\x7e]*$/; // printable ASCII without " and \ : JSON.stringify adds only the quotes
const memo = new Map();

// Allocation-free SHA-256 for short ASCII keys (the common case: scalar field values). A native
// crypto call costs ~10-20 us of fixed overhead per invocation; one 64-byte block in JS is ~1 us.
// This is the SAME algorithm and returns the same first digest word (H0); anything it does not
// handle (non-ASCII or > MAX_JS_BYTES) goes to node:crypto. test/unit/sketch-hash.test.mjs checks
// it against node:crypto across every length boundary.
const K256 = new Int32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const MAX_JS_BYTES = 247; // 247 + 0x80 + 8-byte length = 256 = 4 blocks
const W = new Int32Array(64);

export function sha256Head32Ascii(str) {
  const n = str.length;
  if (n > MAX_JS_BYTES) return null;
  const total = ((n + 9 + 63) >> 6) << 6;
  const lenWordAt = total - 4; // byte offset of the (32-bit) message length; the high word is zero
  let h0 = 0x6a09e667 | 0, h1 = 0xbb67ae85 | 0, h2 = 0x3c6ef372 | 0, h3 = 0xa54ff53a | 0;
  let h4 = 0x510e527f | 0, h5 = 0x9b05688c | 0, h6 = 0x1f83d9ab | 0, h7 = 0x5be0cd19 | 0;
  for (let off = 0; off < total; off += 64) {
    // Message words straight from the characters: data, then 0x80, zeros, bit length.
    for (let i = 0; i < 16; i++) {
      const p = off + i * 4;
      let w = 0;
      if (p === lenWordAt) w = (n * 8) | 0;
      else if (p <= n + 3) {
        for (let j = 0; j < 4; j++) {
          const q = p + j;
          let byte = 0;
          if (q < n) { byte = str.charCodeAt(q); if (byte > 127) return null; } else if (q === n) byte = 0x80;
          w = (w << 8) | byte;
        }
      }
      W[i] = w;
    }
    for (let i = 16; i < 64; i++) {
      const w15 = W[i - 15], w2 = W[i - 2];
      const s0 = ((w15 >>> 7) | (w15 << 25)) ^ ((w15 >>> 18) | (w15 << 14)) ^ (w15 >>> 3);
      const s1 = ((w2 >>> 17) | (w2 << 15)) ^ ((w2 >>> 19) | (w2 << 13)) ^ (w2 >>> 10);
      W[i] = ((((W[i - 16] + s0) | 0) + W[i - 7]) | 0) + s1 | 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = ((((((h + S1) | 0) + ch) | 0) + K256[i]) | 0) + W[i] | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
  }
  return h0 >>> 0;
}

function digest32(key) {
  const fast = sha256Head32Ascii(key);
  if (fast !== null) return fast;
  return typeof oneShotHash === 'function'
    ? oneShotHash('sha256', key, 'buffer').readUInt32BE(0)
    : createHash('sha256').update(key).digest().readUInt32BE(0);
}

export function sketchHash32(value) {
  const t = typeof value;
  const cacheable = t === 'number' || (t === 'string' && value.length <= MEMO_STR_MAX);
  if (cacheable) {
    const hit = memo.get(value);
    if (hit !== undefined) return hit;
  }
  // Same key as typedValueKey(): for a "plain" string JSON.stringify is just the quoted text, and
  // for a finite number it equals String(value); everything else takes the generic route.
  const key = t === 'string' ? (PLAIN_STRING.test(value) ? 'string:"' + value + '"' : 'string:' + JSON.stringify(value))
    : t === 'number' && Number.isFinite(value) ? 'number:' + value
      : typedValueKey(value);
  const h = digest32(key);
  if (cacheable) {
    if (memo.size >= MEMO_MAX) memo.clear();
    memo.set(value, h);
  }
  return h;
}

export class CardinalitySketch {
  constructor({ precision = 8, registers } = {}) {
    if (!Number.isInteger(precision) || precision < 4 || precision > 16) throw new RangeError('precision must be 4..16');
    this.precision = precision;
    this.registers = new Uint8Array(1 << precision);
    if (registers) {
      if (registers.length !== this.registers.length) throw new RangeError('Register count mismatch');
      this.registers.set(registers);
    }
  }
  add(value) {
    const hash = sketchHash32(value);
    const index = hash >>> (32 - this.precision), rest = hash << this.precision;
    const rank = Math.min(32 - this.precision + 1, Math.clz32(rest) + 1);
    this.registers[index] = Math.max(this.registers[index], rank); return this;
  }
  merge(other) {
    if (other.precision !== this.precision) throw new RangeError('Sketch precision mismatch');
    for (let i = 0; i < this.registers.length; i++) this.registers[i] = Math.max(this.registers[i], other.registers[i]);
    return this;
  }
  estimate() {
    const m = this.registers.length;
    const alpha = m === 16 ? 0.673 : m === 32 ? 0.697 : m === 64 ? 0.709 : 0.7213 / (1 + 1.079 / m);
    let sum = 0, zero = 0;
    for (const rank of this.registers) { sum += 2 ** -rank; if (!rank) zero++; }
    let estimate = alpha * m * m / sum;
    if (estimate <= 2.5 * m && zero) estimate = m * Math.log(m / zero);
    return Math.round(estimate);
  }
  toJSON() { return { precision: this.precision, registers: [...this.registers] }; }
}

export function wilsonInterval(positive, total, z = 1.96) {
  if (!(total > 0) || !Number.isFinite(positive) || positive < 0 || positive > total) return { lower: 0, upper: 1 };
  const p = positive / total, z2 = z * z, denominator = 1 + z2 / total;
  const center = (p + z2 / (2 * total)) / denominator;
  const radius = z * Math.sqrt(p * (1 - p) / total + z2 / (4 * total * total)) / denominator;
  return { lower: +Math.max(0, center - radius).toFixed(4), upper: +Math.min(1, center + radius).toFixed(4) };
}
