// LAN pairing helpers (opt-in only; see startStudio `lanPair`). Pure functions plus a minimal in-tree
// QR encoder (byte mode, error-correction level L, versions 1-10 = up to 271 bytes) so no npm
// dependency is needed. Nothing here opens a socket or changes any default behavior.
import os from 'node:os';

const VIRTUAL_NAME = /vethernet|virtualbox|vmware|vbox|wsl|docker|hyper-v|bluetooth|veth|virbr|^br-|utun|awdl|llw|loopback/i;

function rankOf(name, address) {
  const [a, b] = address.split('.').map(Number);
  let rank = a === 192 && b === 168 ? 0 : a === 10 ? 1 : a === 172 && b >= 16 && b <= 31 ? 2 : 3;
  if (VIRTUAL_NAME.test(name)) rank += 10; // WSL/Hyper-V/Docker adapters are never what a phone can reach
  return rank;
}

/** Non-loopback, non-link-local IPv4 addresses, best candidate first. */
export function lanAddresses(interfaces = os.networkInterfaces()) {
  const found = [];
  for (const [name, list] of Object.entries(interfaces)) {
    for (const entry of list ?? []) {
      const family = typeof entry.family === 'string' ? entry.family : entry.family === 4 ? 'IPv4' : 'IPv6';
      if (family !== 'IPv4' || entry.internal || entry.address.startsWith('169.254.')) continue;
      found.push({ name, address: entry.address, rank: rankOf(name, entry.address) });
    }
  }
  return found.sort((x, y) => x.rank - y.rank);
}

/** The preferred address (must be one of this machine's own addresses) or the best candidate. */
export function pickLanAddress(addresses, preferred) {
  const wanted = typeof preferred === 'string' ? preferred.trim() : preferred;
  if (wanted) {
    const match = addresses.find((a) => a.address === wanted);
    if (!match) throw new Error(`--lan-host ${wanted} is not a non-loopback IPv4 address of this machine (available: ${addresses.map((a) => a.address).join(', ') || 'none found'})`);
    return match;
  }
  return addresses[0] ?? null;
}

/** True when a token is long enough for LAN exposure and can travel verbatim in the Set-Cookie header
 *  (RFC 6265 cookie-octets subset: base64/base64url/hex). Spaces, quotes, `;`, `,`, `\` or control
 *  characters would split or break the cookie, so the phone could never stay signed in. */
export function isCookieSafeToken(token) {
  return typeof token === 'string' && /^[A-Za-z0-9._~+/=-]{16,512}$/.test(token);
}

/** Host header values this machine legitimately answers to in LAN-pair mode (exact matches, no wildcards). */
export function lanHostHeaders(port, addresses = lanAddresses()) {
  const hosts = addresses.map((a) => `${a.address}:${port}`);
  const name = os.hostname().toLowerCase();
  if (/^[a-z0-9-]+$/.test(name)) hosts.push(`${name}:${port}`, `${name}.local:${port}`);
  return hosts;
}

/** The URL a phone opens; the token query is exchanged for a cookie and stripped by the server. */
export function pairingUrl({ address, port, token }) {
  return `http://${address}:${port}/mobile?token=${encodeURIComponent(token)}`;
}

// ---------------------------------------------------------------------------------------------
// Minimal QR encoder (byte mode, ECC level L, versions 1-10). Algorithm per ISO/IEC 18004.
// ---------------------------------------------------------------------------------------------
// version -> [total codewords, ECC codewords per block, number of blocks]
const QR_L = { 1: [26, 7, 1], 2: [44, 10, 1], 3: [70, 15, 1], 4: [100, 20, 1], 5: [134, 26, 1], 6: [172, 18, 2], 7: [196, 20, 2], 8: [242, 24, 2], 9: [292, 30, 2], 10: [346, 18, 4] };
const QR_ALIGN = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50] };
const bit = (x, i) => ((x >>> i) & 1) !== 0;

function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11d); z ^= ((y >>> i) & 1) * x; }
  return z;
}
function rsDivisor(degree) {
  const r = new Array(degree).fill(0); r[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) { r[j] = gfMul(r[j], root); if (j + 1 < degree) r[j] ^= r[j + 1]; }
    root = gfMul(root, 2);
  }
  return r;
}
function rsRemainder(data, divisor) {
  const r = new Array(divisor.length).fill(0);
  for (const b of data) {
    const factor = b ^ r.shift(); r.push(0);
    divisor.forEach((c, i) => { r[i] ^= gfMul(c, factor); });
  }
  return r;
}

function buildCodewords(bytes, version) {
  const [total, eccLen, blocks] = QR_L[version];
  const dataCw = total - eccLen * blocks;
  const bits = [];
  const push = (v, n) => { for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1); };
  push(0b0100, 4); push(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) push(b, 8);
  push(0, Math.min(4, dataCw * 8 - bits.length));
  while (bits.length % 8) bits.push(0);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  for (let pad = 0xec; data.length < dataCw; pad ^= 0xec ^ 0x11) data.push(pad);

  const shortCount = blocks - (total % blocks);
  const shortLen = Math.floor(total / blocks);
  const divisor = rsDivisor(eccLen);
  const list = [];
  for (let i = 0, k = 0; i < blocks; i++) {
    const len = shortLen - eccLen + (i < shortCount ? 0 : 1);
    const dat = data.slice(k, k + len); k += len;
    const ecc = rsRemainder(dat, divisor);
    if (i < shortCount) dat.push(0);
    list.push(dat.concat(ecc));
  }
  const out = [];
  for (let i = 0; i < list[0].length; i++) {
    list.forEach((block, j) => { if (i !== shortLen - eccLen || j >= shortCount) out.push(block[i]); });
  }
  return out;
}

/** Encode text to a square boolean matrix (true = dark module). */
export function qrEncode(text) {
  const bytes = [...Buffer.from(String(text), 'utf8')];
  let version = 0;
  for (let v = 1; v <= 10 && !version; v++) {
    const [total, ecc, blocks] = QR_L[v];
    if (4 + (v < 10 ? 8 : 16) + bytes.length * 8 <= (total - ecc * blocks) * 8) version = v;
  }
  if (!version) throw new RangeError('Text is too long for the built-in QR renderer (max 271 bytes)');
  const size = version * 4 + 17;
  const modules = Array.from({ length: size }, () => new Array(size).fill(false));
  const isFn = Array.from({ length: size }, () => new Array(size).fill(false));
  const setFn = (x, y, dark) => { modules[y][x] = dark; isFn[y][x] = true; };

  const drawFormat = (mask) => {
    const data = (1 << 3) | mask; // ECC level L = 01
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    for (let i = 0; i <= 5; i++) setFn(8, i, bit(bits, i));
    setFn(8, 7, bit(bits, 6)); setFn(8, 8, bit(bits, 7)); setFn(7, 8, bit(bits, 8));
    for (let i = 9; i < 15; i++) setFn(14 - i, 8, bit(bits, i));
    for (let i = 0; i < 8; i++) setFn(size - 1 - i, 8, bit(bits, i));
    for (let i = 8; i < 15; i++) setFn(8, size - 15 + i, bit(bits, i));
    setFn(8, size - 8, true);
  };
  const finder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx, y = cy + dy;
      if (x >= 0 && x < size && y >= 0 && y < size) setFn(x, y, Math.max(Math.abs(dx), Math.abs(dy)) !== 2 && Math.max(Math.abs(dx), Math.abs(dy)) !== 4);
    }
  };
  for (let i = 0; i < size; i++) { setFn(6, i, i % 2 === 0); setFn(i, 6, i % 2 === 0); }
  finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
  const pos = QR_ALIGN[version];
  pos.forEach((py, i) => pos.forEach((px, j) => {
    if ((i === 0 && j === 0) || (i === 0 && j === pos.length - 1) || (i === pos.length - 1 && j === 0)) return;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) setFn(px + dx, py + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }));
  drawFormat(0);
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3), b = Math.floor(i / 3);
      setFn(a, b, bit(bits, i)); setFn(b, a, bit(bits, i));
    }
  }

  const codewords = buildCodewords(bytes, version);
  let n = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
      const x = right - j;
      const y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
      if (!isFn[y][x] && n < codewords.length * 8) { modules[y][x] = bit(codewords[n >>> 3], 7 - (n & 7)); n++; }
    }
  }

  const MASKS = [
    (x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
  ];
  const applyMask = (m) => { for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!isFn[y][x] && MASKS[m](x, y)) modules[y][x] = !modules[y][x]; };
  // Simplified penalty (runs, 2x2 blocks, dark balance). Any mask is valid; this only improves scan quality.
  const penalty = () => {
    let p = 0, dark = 0;
    for (let a = 0; a < size; a++) for (const vertical of [false, true]) {
      let run = 1;
      for (let b = 1; b < size; b++) {
        const cur = vertical ? modules[b][a] : modules[a][b], prev = vertical ? modules[b - 1][a] : modules[a][b - 1];
        if (cur === prev) { run++; if (run === 5) p += 3; else if (run > 5) p++; } else run = 1;
      }
    }
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      if (modules[y][x]) dark++;
      if (x < size - 1 && y < size - 1 && modules[y][x] === modules[y][x + 1] && modules[y][x] === modules[y + 1][x] && modules[y][x] === modules[y + 1][x + 1]) p += 3;
    }
    return p + Math.max(0, Math.ceil(Math.abs(dark * 20 - size * size * 10) / (size * size)) - 1) * 10;
  };
  let best = 0, bestPenalty = Infinity;
  for (let m = 0; m < 8; m++) {
    applyMask(m); drawFormat(m);
    const p = penalty();
    if (p < bestPenalty) { best = m; bestPenalty = p; }
    applyMask(m);
  }
  applyMask(best); drawFormat(best);
  return modules;
}

/** Terminal rendering with half-block glyphs; forced black-on-white so dark terminal themes still scan.
 *  The default 4-module quiet zone is the ISO minimum; a narrower white border fails on some phone scanners
 *  because the terminal background around it is dark. */
export function qrToTerminal(text, { quiet = 4, ansi = true } = {}) {
  const m = qrEncode(text), n = m.length, total = n + quiet * 2;
  const dark = (x, y) => x >= quiet && y >= quiet && x < n + quiet && y < n + quiet && m[y - quiet][x - quiet];
  const lines = [];
  for (let y = 0; y < total; y += 2) {
    let line = '';
    for (let x = 0; x < total; x++) { const t = dark(x, y), b = dark(x, y + 1); line += t && b ? '█' : t ? '▀' : b ? '▄' : ' '; }
    lines.push(ansi ? `\x1b[30;47m${line}\x1b[0m` : line);
  }
  return lines.join('\n');
}
