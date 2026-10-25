// RFC 4180 CSV helpers + incremental CsvDecoder.
// Event shape matches NdjsonDecoder: { type, text, span:[start,end], index }.
// push(chunk) / flush() — end() is the decoder-interface alias of flush().

const DELIMS = [',', ';', '\t', '|'];

function stripBom(text) {
  const s = String(text ?? '');
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

function isNumericString(s) {
  return /^-?(?:\d+\.\d+|\d+\.|\.\d+|\d+)(?:[eE][+-]?\d+)?$/.test(s);
}

function isIsoDate(s) {
  return /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.test(s);
}

/** Quote-aware logical records (newlines inside quotes stay inside the record). */
function logicalLines(text, max = 50) {
  const s = stripBom(text);
  const lines = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < s.length && lines.length < max; i++) {
    const c = s[i];
    if (c === '"') {
      if (inQ && s[i + 1] === '"') { cur += '""'; i++; continue; }
      inQ = !inQ;
      cur += c;
      continue;
    }
    if (!inQ && (c === '\n' || c === '\r')) {
      if (c === '\r' && s[i + 1] === '\n') i++;
      lines.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur && lines.length < max) lines.push(cur);
  return lines;
}

function countFields(line, delimiter) {
  let n = 1;
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQ && line[i + 1] === '"') { i++; continue; }
      inQ = !inQ;
      continue;
    }
    if (!inQ && c === delimiter) n++;
  }
  return n;
}

export function parseCsv(text, { delimiter = ',' } = {}) {
  const s = stripBom(text);
  const rows = [];
  let row = [];
  let field = '';
  let inQ = false;
  let started = false;
  const pushRow = () => { row.push(field); rows.push(row); row = []; field = ''; started = false; };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQ) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; started = true; continue; }
        inQ = false;
        started = true;
        continue;
      }
      field += c;
      started = true;
      continue;
    }
    if (c === '"' && field === '') { inQ = true; started = true; continue; }
    if (c === delimiter) { row.push(field); field = ''; started = true; continue; }
    if (c === '\r' || c === '\n') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      pushRow();
      continue;
    }
    field += c;
    started = true;
  }
  if (started || row.length) pushRow();
  return rows;
}

export function sniffDelimiter(text) {
  const lines = logicalLines(text, 50).filter((l) => l.length > 0);
  let best = { delimiter: ',', confidence: 0 };
  if (!lines.length) return best;
  for (const delimiter of DELIMS) {
    const counts = lines.map((line) => countFields(line, delimiter));
    const freq = new Map();
    let multi = 0;
    for (const c of counts) {
      if (c > 1) { multi++; freq.set(c, (freq.get(c) ?? 0) + 1); }
    }
    if (!multi) continue;
    let mode = 0;
    let modeN = 0;
    for (const [k, v] of freq) {
      if (v > modeN || (v === modeN && k > mode)) { mode = k; modeN = v; }
    }
    let confidence = (modeN / counts.length) * (modeN / multi);
    if (counts.length < 2) confidence *= 0.7;
    confidence = round4(Math.min(1, confidence));
    if (confidence > best.confidence) best = { delimiter, confidence };
  }
  return best;
}

export function headerLikelihood(rows) {
  if (!Array.isArray(rows) || rows.length < 2 || !Array.isArray(rows[0]) || rows[0].length === 0) return 0;
  const cells = rows[0].map((c) => String(c ?? '').trim());
  const nonNum = cells.filter((c) => c !== '' && !isNumericString(c)).length / cells.length;
  const unique = new Set(cells).size / cells.length;
  let considered = 0;
  let typedCols = 0;
  for (let col = 0; col < cells.length; col++) {
    const vals = [];
    for (let r = 1; r < rows.length; r++) {
      const cell = rows[r]?.[col];
      if (cell == null) continue;
      const t = String(cell).trim();
      if (t === '') continue;
      vals.push(t);
    }
    if (!vals.length) continue;
    considered++;
    const hits = vals.filter((v) => isNumericString(v) || isIsoDate(v)).length;
    if (hits / vals.length >= 0.5) typedCols++;
  }
  const typed = considered ? typedCols / considered : 0;
  let score = 0.15 * nonNum + 0.15 * unique + 0.7 * typed;
  if (nonNum === 1 && unique === 1 && typed > 0) score = Math.max(score, 0.6 + 0.4 * typed);
  if (nonNum < 1 || unique < 1) score = Math.min(score, 0.49);
  return round4(Math.max(0, Math.min(1, score)));
}

export function coerceCell(str) {
  if (str == null) return null;
  const s = String(str);
  if (s === '') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (isIsoDate(s)) return s;
  if (/^-?\d+$/.test(s)) {
    const n = Number(s);
    return Number.isSafeInteger(n) ? n : s;
  }
  if (/^-?(?:\d+\.\d+|\d+\.|\.\d+)(?:[eE][+-]?\d+)?$/.test(s) || /^-?\d+[eE][+-]?\d+$/.test(s)) {
    const n = Number(s);
    return Number.isFinite(n) ? n : s;
  }
  return s;
}

function columnNames(cells) {
  const seen = new Map();
  return cells.map((c, i) => {
    const base = String(c ?? '').trim() || `col${i}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n === 0 ? base : `${base}_${n + 1}`;
  });
}

function splitRecord(text, delimiter) {
  if (text === '') return [''];
  const rows = parseCsv(text, { delimiter });
  if (rows.length === 1) return rows[0];
  if (!rows.length) return [''];
  // A logical record can still contain a quoted newline; parseCsv returns one row.
  // If several rows come back, keep fields of the first and append the rest flattened
  // only when the record was a single physical line — otherwise join back via first row
  // plus subsequent rows' cells (quoted embedded breaks stay inside parseCsv's first row).
  return rows.length > 1 ? rows.flat() : rows[0];
}

export function csvToObjects(text, opts = {}) {
  const delimiter = opts.delimiter ?? sniffDelimiter(text).delimiter;
  const matrix = parseCsv(text, { delimiter });
  const likelihood = headerLikelihood(matrix);
  const hasHeader = typeof opts.hasHeader === 'boolean' ? opts.hasHeader : likelihood >= 0.5;
  let columns;
  let data;
  if (hasHeader && matrix.length) {
    columns = columnNames(matrix[0]);
    data = matrix.slice(1);
  } else {
    const width = matrix.reduce((m, r) => Math.max(m, r.length), 0);
    columns = Array.from({ length: width }, (_, i) => `col${i}`);
    data = matrix;
  }
  const rows = data.map((r) => {
    const obj = {};
    const n = Math.max(columns.length, r.length);
    for (let i = 0; i < n; i++) {
      const key = columns[i] ?? `col${i}`;
      obj[key] = coerceCell(r[i] ?? '');
    }
    return obj;
  });
  return { delimiter, hasHeader, columns, rows };
}

function toBuf(chunk) {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  if (typeof chunk === 'string') return Buffer.from(chunk, 'utf8');
  return Buffer.alloc(0);
}

export class CsvDecoder {
  constructor(opts = {}) {
    this.kind = 'csv';
    this.delimiter = opts.delimiter;
    this.forceHeader = typeof opts.hasHeader === 'boolean' ? opts.hasHeader : undefined;
    this.buf = Buffer.alloc(0);
    this.base = 0;
    this.bomChecked = false;
    this.pending = [];
    this.decided = false;
    this.hasHeader = false;
    this.columns = null;
    this.count = 0;
    this.stats = { events: 0, rows: 0 };
  }

  push(chunk) {
    const part = toBuf(chunk);
    if (!part.length) return this._drain(false);
    this.buf = this.buf.length ? Buffer.concat([this.buf, part]) : Buffer.from(part);
    this._stripBom(false);
    this._queue(this._extract(false));
    return this._drain(false);
  }

  /** Emit buffered rows. Decides the header once two records exist, or now if fewer. */
  flush() {
    this._stripBom(true);
    this._queue(this._extract(true));
    return this._drain(true);
  }

  /** Decoder-interface alias (NdjsonDecoder.end). */
  end() { return this.flush(); }

  _stripBom(final) {
    if (this.bomChecked || this.base !== 0) { if (this.base !== 0) this.bomChecked = true; return; }
    if (this.buf.length < 3 && !final) return;
    this.bomChecked = true;
    if (this.buf.length >= 3 && this.buf[0] === 0xef && this.buf[1] === 0xbb && this.buf[2] === 0xbf) {
      this.buf = Buffer.from(this.buf.subarray(3));
      this.base = 3;
    }
  }

  _extract(final) {
    const buf = this.buf;
    const recs = [];
    let inQ = false;
    let start = 0;
    let i = 0;
    const uncertain = () => {
      this._keep(buf, start);
      return recs;
    };
    while (i < buf.length) {
      const b = buf[i];
      if (b === 0x22) {
        if (inQ && i + 1 < buf.length && buf[i + 1] === 0x22) { i += 2; continue; }
        if (inQ && i + 1 >= buf.length && !final) return uncertain();
        inQ = !inQ;
        i++;
        continue;
      }
      if (!inQ && b === 0x0d) {
        if (i + 1 >= buf.length && !final) return uncertain();
        let end = i + 1;
        if (i + 1 < buf.length && buf[i + 1] === 0x0a) end = i + 2;
        recs.push({ raw: buf.subarray(start, i), start: this.base + start, end: this.base + end });
        i = end;
        start = end;
        continue;
      }
      if (!inQ && b === 0x0a) {
        recs.push({ raw: buf.subarray(start, i), start: this.base + start, end: this.base + i + 1 });
        i++;
        start = i;
        continue;
      }
      i++;
    }
    if (final && (start < buf.length || inQ)) {
      recs.push({
        raw: buf.subarray(start),
        start: this.base + start,
        end: this.base + buf.length,
        incomplete: inQ || undefined,
      });
      start = buf.length;
    }
    this._keep(buf, start);
    return recs;
  }

  _keep(buf, start) {
    if (start <= 0) return;
    this.buf = Buffer.from(buf.subarray(start));
    this.base += start;
  }

  _queue(recs) {
    for (const r of recs) {
      this.pending.push({
        text: r.raw.toString('utf8'),
        start: r.start,
        end: r.end,
        incomplete: r.incomplete,
      });
    }
  }

  _drain(final) {
    if (!this.decided) {
      if (this.pending.length < 2 && !final) return [];
      if (!this.pending.length) return [];
      if (!this.delimiter) this.delimiter = sniffDelimiter(this.pending.map((r) => r.text).join('\n')).delimiter;
      for (const r of this.pending) r.cells = splitRecord(r.text, this.delimiter);
      const like = headerLikelihood(this.pending.map((r) => r.cells));
      this.hasHeader = this.forceHeader ?? (like >= 0.5);
      if (this.hasHeader) {
        this.columns = columnNames(this.pending[0].cells);
        this.pending.shift();
      } else {
        const width = this.pending.reduce((m, r) => Math.max(m, r.cells.length), 0);
        this.columns = Array.from({ length: width }, (_, i) => `col${i}`);
      }
      this.decided = true;
    }
    const out = [];
    while (this.pending.length) out.push(this._event(this.pending.shift()));
    return out;
  }

  _event(r) {
    if (!r.cells) r.cells = splitRecord(r.text, this.delimiter || ',');
    const values = r.cells.map((c) => coerceCell(c));
    const row = {};
    const n = Math.max(this.columns?.length ?? 0, r.cells.length);
    for (let i = 0; i < n; i++) row[this.columns?.[i] ?? `col${i}`] = values[i] ?? null;
    const ev = {
      type: 'csv',
      text: r.text,
      span: [r.start, r.end],
      index: this.count++,
      cells: r.cells,
      values,
      row,
      columns: this.columns ? this.columns.slice() : [],
      delimiter: this.delimiter,
      hasHeader: this.hasHeader,
    };
    if (r.incomplete) ev.incomplete = true;
    this.stats.events++;
    this.stats.rows++;
    return ev;
  }
}
