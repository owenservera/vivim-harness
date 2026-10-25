// Small, strict argument parser (zero dependencies).
//   --flag  --flag=value  --flag value  --no-flag  -f  -f value  -abc (boolean cluster)  --  (end of flags)
// Flag spec: { type: 'boolean'|'string'|'number'|'list', alias, desc, choices, valueName, default }
// Unspecified flags stay undefined so callers can tell "not given" from "false".
import { CliError } from './ui.mjs';
import { EXIT } from '../../src/config.mjs';

export function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}

export function closest(word, candidates, max = 3) {
  const w = String(word).toLowerCase();
  return candidates
    .map((c) => ({ c, d: c.toLowerCase().startsWith(w) || w.startsWith(c.toLowerCase()) ? 0 : levenshtein(w, c.toLowerCase()) }))
    .filter((x) => x.d <= Math.max(2, Math.floor(w.length / 3)))
    .sort((a, b) => a.d - b.d).slice(0, max).map((x) => x.c);
}

function indexSpec(spec) {
  const byLong = new Map(Object.entries(spec));
  const byShort = new Map();
  for (const [name, def] of byLong) if (def.alias) byShort.set(def.alias, name);
  return { byLong, byShort };
}

const usage = (message, hint) => new CliError(message, { exit: EXIT.USAGE, code: 'USAGE', hint });

function coerce(name, def, raw) {
  if (def.type === 'number') {
    const n = Number(raw);
    if (raw === '' || !Number.isFinite(n)) throw usage(`--${name} expects a number, got "${raw}".`);
    return n;
  }
  if (def.choices && !def.choices.includes(String(raw))) {
    throw usage(`--${name} must be one of: ${def.choices.join(', ')} (got "${raw}").`);
  }
  return String(raw);
}

// Skim argv for the leading positional words (command + subcommand) without knowing the command's
// own flags yet. Global string flags consume their value; unknown flags are assumed boolean.
export function leadingWords(argv, globalSpec, count = 2) {
  const { byLong, byShort } = indexSpec(globalSpec);
  const words = [];
  for (let i = 0; i < argv.length && words.length < count; i++) {
    const a = argv[i];
    if (a === '--') { words.push(...argv.slice(i + 1, i + 1 + count - words.length)); break; }
    if (a.startsWith('--')) {
      const name = a.slice(2).split('=')[0].replace(/^no-/, '');
      const def = byLong.get(name);
      if (def && def.type !== 'boolean' && !a.includes('=')) i++;
    } else if (a.startsWith('-') && a.length > 1) {
      const def = byLong.get(byShort.get(a.slice(1, 2)));
      if (def && def.type !== 'boolean' && a.length === 2) i++;
    } else words.push(a);
  }
  return words;
}

export function parseArgv(argv, spec, { command = '' } = {}) {
  const { byLong, byShort } = indexSpec(spec);
  const flags = {}, positional = [];
  const unknown = (shown, names) => {
    const near = closest(shown, names);
    return usage(`Unknown option ${shown.length === 1 ? '-' : '--'}${shown}${command ? ` for "${command}"` : ''}.`,
      near.length ? `Did you mean ${near.map((n) => `--${n}`).join(' or ')}?` : `Run "studio help ${command}".`.trim());
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { positional.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      let name = (eq < 0 ? a.slice(2) : a.slice(2, eq));
      const inline = eq < 0 ? undefined : a.slice(eq + 1);
      let negate = false;
      if (!byLong.has(name) && name.startsWith('no-') && byLong.get(name.slice(3))?.type === 'boolean') { negate = true; name = name.slice(3); }
      const def = byLong.get(name);
      if (!def) throw unknown(name, [...byLong.keys()]);
      if (def.type === 'boolean') {
        if (inline !== undefined) {
          if (!/^(true|false|1|0|yes|no|on|off)$/i.test(inline)) throw usage(`--${name} is a switch; "${inline}" is not true/false.`);
          flags[name] = /^(true|1|yes|on)$/i.test(inline);
        } else flags[name] = !negate;
        continue;
      }
      if (negate) throw usage(`--no-${name} is not valid; --${name} takes a value.`);
      let raw = inline;
      if (raw === undefined) {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--')) throw usage(`--${name} needs a value${def.valueName ? ` (${def.valueName})` : ''}.`);
        raw = argv[++i];
      }
      if (def.type === 'list') (flags[name] ??= []).push(...String(raw).split(',').map((x) => x.trim()).filter(Boolean));
      else flags[name] = coerce(name, def, raw);
      continue;
    }
    if (a.startsWith('-') && a.length > 1 && !/^-\d/.test(a)) {
      const chars = a.slice(1);
      for (let k = 0; k < chars.length; k++) {
        const long = byShort.get(chars[k]);
        if (!long) throw unknown(chars[k], [...byLong.keys()]);
        const def = byLong.get(long);
        if (def.type === 'boolean') { flags[long] = true; continue; }
        let raw = chars.slice(k + 1) || argv[++i];
        if (raw === undefined || raw.startsWith('--')) throw usage(`-${chars[k]} (--${long}) needs a value.`);
        if (def.type === 'list') (flags[long] ??= []).push(...String(raw).split(',').map((x) => x.trim()).filter(Boolean));
        else flags[long] = coerce(long, def, raw);
        break;
      }
      continue;
    }
    positional.push(a);
  }
  for (const [name, def] of byLong) if (flags[name] === undefined && def.default !== undefined) flags[name] = def.default;
  return { flags, positional };
}
