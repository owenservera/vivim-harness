// Terminal output helpers: consistent human/JSON output, tables, colors, errors.
// Contract: with --json, stdout carries exactly the command's JSON result (or NDJSON where a
// command streams rows); progress, warnings and errors always go to stderr.
import { EXIT } from '../../src/config.mjs';

export class CliError extends Error {
  constructor(message, { exit = EXIT.ERROR, code = 'ERROR', hint = null, details = null } = {}) {
    super(message);
    this.name = 'CliError';
    this.exit = exit; this.code = code; this.hint = hint; this.details = details;
  }
}
export const notFound = (message, hint) => new CliError(message, { exit: EXIT.NOT_FOUND, code: 'NOT_FOUND', hint });
export const usageError = (message, hint) => new CliError(message, { exit: EXIT.USAGE, code: 'USAGE', hint });
export const integrityError = (message, hint) => new CliError(message, { exit: EXIT.INTEGRITY, code: 'INTEGRITY', hint });
export const envError = (message, hint) => new CliError(message, { exit: EXIT.ENVIRONMENT, code: 'ENVIRONMENT', hint });

// ---------------------------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------------------------
export const fmtBytes = (n) => {
  n = Number(n) || 0;
  return n >= 1073741824 ? `${(n / 1073741824).toFixed(2)} GB` : n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`;
};
export const fmtMs = (ms) => {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '-';
  return ms >= 60000 ? `${Math.floor(ms / 60000)}m${String(Math.round((ms % 60000) / 1000)).padStart(2, '0')}s` : ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
};
export const fmtPct = (x, digits = 0) => (Number.isFinite(x) ? `${(x * 100).toFixed(digits)}%` : '-');
export function fmtAgo(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '-';
  const s = Math.max(0, Math.round((now - t) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`;
}
export const truncate = (s, n) => { s = String(s ?? ''); return s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s; };
export const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

// "30d", "12h", "90m", "45s", "2w" or an ISO date -> epoch ms cutoff (now - duration).
export function parseSince(text, now = Date.now()) {
  const m = /^(\d+(?:\.\d+)?)\s*([smhdw])$/i.exec(String(text).trim());
  if (m) return now - Number(m[1]) * { s: 1e3, m: 6e4, h: 36e5, d: 864e5, w: 6048e5 }[m[2].toLowerCase()];
  const t = Date.parse(text);
  if (!Number.isFinite(t)) throw usageError(`"${text}" is not a duration (30d, 12h, 90m) or ISO date.`);
  return t;
}

// ---------------------------------------------------------------------------------------------
// Output object
// ---------------------------------------------------------------------------------------------
const ANSI = { bold: 1, dim: 2, red: 31, green: 32, yellow: 33, blue: 34, magenta: 35, cyan: 36, gray: 90 };

export function createOutput({ json = false, quiet = false, color = 'auto', verbose = false, stdout = process.stdout, stderr = process.stderr } = {}) {
  const useColor = !json && color !== 'never' && !process.env.NO_COLOR && (color === 'always' || (stdout.isTTY && process.env.TERM !== 'dumb'));
  const paint = (name) => (s) => (useColor ? `\x1b[${ANSI[name]}m${s}\x1b[0m` : String(s));
  const c = Object.fromEntries(Object.keys(ANSI).map((k) => [k, paint(k)]));
  const width = () => Math.max(60, Math.min(stdout.columns || 120, 200));
  const out = {
    json, quiet, verbose, c, width,
    // Human line on stdout (suppressed under --json and --quiet).
    line(s = '') { if (!json && !quiet) stdout.write(`${s}\n`); },
    // Always printed in human mode even with --quiet (the command's primary answer).
    result(s = '') { if (!json) stdout.write(`${s}\n`); },
    // Raw bytes on stdout (export to '-', replay): never decorated.
    raw(s) { stdout.write(s); },
    info(s) { if (!quiet) stderr.write(`${s}\n`); },
    warn(s) { stderr.write(`${c.yellow('warning:')} ${s}\n`); },
    progress(s) { if (!quiet && stderr.isTTY) stderr.write(`\r${s}`); },
    progressDone() { if (!quiet && stderr.isTTY) stderr.write('\n'); },
    // Emit one result: JSON document under --json, otherwise the human renderer.
    emit(data, human) {
      if (json) stdout.write(`${JSON.stringify(data, null, 2)}\n`);
      else if (human) human(out);
    },
    ndjson(rows) { for (const r of rows) stdout.write(`${JSON.stringify(r)}\n`); },
    kv(pairs, indent = 2) {
      const entries = pairs.filter(([, v]) => v !== undefined && v !== null && v !== '');
      const w = Math.max(0, ...entries.map(([k]) => k.length));
      for (const [k, v] of entries) out.line(`${' '.repeat(indent)}${c.dim(k.padEnd(w))}  ${v}`);
    },
    heading(s) { out.line(c.bold(s)); },
    table(rows, columns, { empty = 'Nothing to show.', indent = 0 } = {}) {
      if (!rows.length) { out.line(`${' '.repeat(indent)}${c.dim(empty)}`); return; }
      const cols = columns.map((col) => ({ max: 60, ...col }));
      const cell = (row, col) => oneLine(col.get ? col.get(row) : row[col.key]);
      const cells = rows.map((r) => cols.map((col) => cell(r, col)));
      const widths = cols.map((col, i) => Math.min(col.max, Math.max(col.title.length, ...cells.map((r) => r[i].length))));
      const budget = width() - indent - 2 * (cols.length - 1);
      while (widths.reduce((a, b) => a + b, 0) > budget) {
        const i = widths.indexOf(Math.max(...widths));
        if (widths[i] <= 12) break;
        widths[i] -= 1;
      }
      const fmt = (vals, bold) => ' '.repeat(indent) + vals.map((v, i) => {
        const t = truncate(v, widths[i]);
        return cols[i].align === 'right' ? t.padStart(widths[i]) : (i === vals.length - 1 ? t : t.padEnd(widths[i]));
      }).join('  ');
      out.line(c.bold(fmt(cols.map((col) => col.title))));
      for (const r of cells) out.line(fmt(r));
    },
  };
  return out;
}

// ---------------------------------------------------------------------------------------------
// Errors -> stderr (+ exit code)
// ---------------------------------------------------------------------------------------------
export function reportError(err, out) {
  const e = err instanceof CliError ? err : toCliError(err);
  if (out?.json) {
    process.stderr.write(`${JSON.stringify({ error: { message: e.message, code: e.code, exit: e.exit, hint: e.hint ?? undefined, details: e.details ?? undefined } })}\n`);
  } else {
    const red = out ? out.c.red : (s) => s;
    process.stderr.write(`${red('error:')} ${e.message}\n`);
    if (e.hint) process.stderr.write(`${out ? out.c.dim('hint:') : 'hint:'} ${e.hint}\n`);
    if (out?.verbose && err?.stack) process.stderr.write(`${err.stack}\n`);
  }
  return e.exit;
}

// Map errors thrown by lower layers to friendly CLI errors.
export function toCliError(err) {
  const msg = String(err?.message ?? err);
  if (err?.code === 'CAPABILITY_UNAVAILABLE') return new CliError(msg, { exit: EXIT.ENVIRONMENT, code: err.code });
  if (err?.code === 'ECONNREFUSED' || /fetch failed|ECONNREFUSED|DevTools/i.test(msg) && /127\.0\.0\.1|DevTools|9222/.test(msg)) {
    return new CliError(`Cannot reach the capture browser: ${msg}`, { exit: EXIT.ENVIRONMENT, code: 'NO_BROWSER', hint: 'Run "studio launch" (or "studio doctor") first.' });
  }
  if (/^No session|matches \d+ sessions|^No sessions recorded/.test(msg)) return notFound(msg, 'List sessions with "studio sessions".');
  if (/^No (profile|family) "|has no version/.test(msg)) return notFound(msg, 'List them with "studio profile list" / "studio family list".');
  if (err?.code === 'DATASET_NOT_FOUND' || err?.code === 'NO_KNOWLEDGE') return notFound(msg);
  if (err?.code === 'KNOWLEDGE_FAILED') return integrityError(msg);
  if (err?.code === 'BAD_FORMAT' || err?.code === 'BAD_ASSIGNMENT' || err?.code === 'BAD_URL' || err?.code === 'BAD_NAME' || err?.code === 'NO_HOSTS' || err?.code === 'BAD_IMPORT') return usageError(msg);
  if (err?.code === 'LEARNER_LOCKED' || err?.code === 'LEARNER_REVISION_CONFLICT' || err?.name === 'LearnerWriteConflict') {
    return new CliError(msg, { exit: EXIT.INTEGRITY, code: err.code ?? 'LEARNER_CONFLICT', hint: 'Another process is writing learner state (is "studio serve" running?). Retry shortly.' });
  }
  if (err?.code === 'ENOENT') return notFound(msg);
  if (err?.code === 'EACCES' || err?.code === 'EPERM') return new CliError(msg, { exit: EXIT.ERROR, code: err.code, hint: 'Check file permissions or choose another --out / --data-dir.' });
  return new CliError(msg, { exit: EXIT.ERROR, code: err?.code && typeof err.code === 'string' ? err.code : 'ERROR' });
}
