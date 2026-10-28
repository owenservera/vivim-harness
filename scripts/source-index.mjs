import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = 'docs/agents/CHATGPT-100-SOURCE-INDEX.json';
const posix = (value) => value.split(path.sep).join('/');
const sorted = (object) => Object.fromEntries(Object.entries(object).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
const existsFile = (file) => { try { return fs.statSync(file).isFile(); } catch { return false; } };

function walk(dir, result) {
  let entries;
  try { entries = fs.readdirSync(path.join(root, dir), { withFileTypes: true }); } catch { return; }
  for (const entry of entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    if (['node_modules', '.git', 'dist', 'build'].includes(entry.name)) continue;
    const name = posix(path.join(dir, entry.name));
    if (entry.isDirectory()) walk(name, result);
    else if (entry.isFile() && /\.(?:mjs|js|json)$/.test(name)) result.push(name);
  }
}

// Preserve offsets and newlines while hiding strings and comments from declaration scans.
function lex(text) {
  const code = text.split('');
  const comments = [];
  const hide = (start, end) => { for (let j = start; j < end; j++) if (code[j] !== '\n' && code[j] !== '\r') code[j] = ' '; };
  let i = 0;
  while (i < text.length) {
    const start = i;
    if (text[i] === '/' && text[i + 1] === '/') {
      i += 2; while (i < text.length && text[i] !== '\n') i++;
      comments.push({ start, end: i, text: text.slice(start, i), type: 'line' }); hide(start, i);
    } else if (text[i] === '/' && text[i + 1] === '*') {
      i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i = Math.min(text.length, i + 2);
      comments.push({ start, end: i, text: text.slice(start, i), type: text[start + 2] === '*' ? 'doc' : 'block' }); hide(start, i);
    } else if (text[i] === '"' || text[i] === "'" || text[i] === '`') {
      const quote = text[i++];
      while (i < text.length) { if (text[i] === '\\') i += 2; else if (text[i++] === quote) break; }
      hide(start, Math.min(i, text.length));
    } else i++;
  }
  return { code: code.join(''), comments };
}

function indexFile(name, text) {
  const { code, comments } = lex(text);
  const lineAt = (offset) => 1 + (text.slice(0, offset).match(/\n/g) || []).length;
  const declarations = [];
  const add = (symbol, kind, exported, offset) => declarations.push({ symbol, kind, exported, offset, line: lineAt(offset) });
  let match;
  const decl = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(function|const|let|var|class)\s+([A-Za-z_$][\w$]*)(?=\s*(?:\(|=|\{|extends\b))/gm;
  while ((match = decl.exec(code))) add(match[2], match[1], /^export\b/.test(match[0]), match.index);
  const named = /\bexport\s*\{([^}]*)\}/g;
  while ((match = named.exec(code))) {
    for (const item of match[1].split(',')) {
      const part = item.trim().match(/^([\w$]+)(?:\s+as\s+([\w$]+))?$/);
      if (part) add(part[2] || part[1], 'export', true, match.index);
    }
  }
  const defaults = /\bexport\s+default\s+(?:async\s+)?(?:function\s+)?([A-Za-z_$][\w$]*)/g;
  while ((match = defaults.exec(code))) if (match[1] !== 'function' && match[1] !== 'class') add(match[1], 'default', true, match.index);
  const common = /\bmodule\s*\.\s*exports\s*(?:\.\s*([\w$]+)\s*=|=\s*\{([^}]*)\})/g;
  while ((match = common.exec(code))) {
    const names = match[1] ? [match[1]] : match[2].split(',').map((part) => part.trim().match(/^([\w$]+)/)?.[1]).filter(Boolean);
    for (const symbol of names) add(symbol, 'export', true, match.index);
  }
  declarations.sort((a, b) => a.offset - b.offset);
  const docs = (offset) => {
    let cursor = offset;
    let index = comments.length - 1;
    while (index >= 0 && comments[index].end > cursor) index--;
    const parts = [];
    while (index >= 0) {
      const comment = comments[index];
      if (!/^\s*$/.test(text.slice(comment.end, cursor)) || !['line', 'doc'].includes(comment.type)) break;
      parts.unshift(comment.text.replace(/^\/\/\s?/, '').replace(/^\/\*\*?/, '').replace(/\*\/$/, '').replace(/^\s*\*\s?/gm, ''));
      cursor = comment.start;
      if (comment.type === 'doc') break;
      index--;
    }
    return parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, 240);
  };
  const symbols = {};
  for (const declaration of declarations) {
    const key = `${name}#${declaration.symbol}`;
    const previous = symbols[key];
    if (previous) { previous.exported ||= declaration.exported; continue; }
    symbols[key] = { line: declaration.line, kind: declaration.kind, exported: declaration.exported, doc: docs(declaration.offset), serves: [] };
  }
  const annotations = [];
  let tagCount = 0;
  for (const comment of comments) {
    const tags = /@serves\s+(\d{3}(?:\s*(?:,|-)\s*\d{3})*)/g;
    while ((match = tags.exec(comment.text))) {
      tagCount++;
      const ids = new Set();
      for (const item of match[1].split(/\s*,\s*/)) {
        const range = item.match(/^(\d{3})(?:\s*-\s*(\d{3}))?$/);
        if (!range) continue;
        const first = Number(range[1]), last = Number(range[2] || range[1]);
        for (let n = first; n <= last; n++) ids.add(String(n).padStart(3, '0'));
      }
      const target = declarations.find((declaration) => declaration.offset >= comment.end);
      const key = target ? `${name}#${target.symbol}` : name;
      for (const id of ids) {
        if (symbols[key] && !symbols[key].serves.includes(id)) symbols[key].serves.push(id);
        annotations.push([id, key]);
      }
    }
  }
  for (const symbol of Object.values(symbols)) symbol.serves.sort();
  const imports = new Set();
  // Match specifiers in the original text, but require the keyword to be code.
  const importPattern = /\b(?:import\s*(?:\([^)]*?\)|(?:[^;'"\n]*?\s+from\s*)?['"][^'"]+['"])|export\s+(?:\*|\{[^}]*\})\s+from\s*['"][^'"]+['"]|require\s*\(\s*['"][^'"]+['"]\s*\))/g;
  while ((match = importPattern.exec(text))) {
    if (!/^(?:import|export|require)\b/.test(code.slice(match.index))) continue;
    const spec = match[0].match(/['"]([^'"]+)['"]/)?.[1];
    if (!spec || !/^(?:\.|\/)/.test(spec)) continue;
    const base = spec.startsWith('/') ? path.resolve(root, `.${spec}`) : path.resolve(root, path.dirname(name), spec);
    const resolved = [base, ...['.mjs', '.js', '.json'].map((ext) => base + ext), ...['index.mjs', 'index.js', 'index.json'].map((file) => path.join(base, file))].find(existsFile);
    if (resolved) imports.add(posix(path.relative(root, resolved)));
  }
  const stars = [];
  const starPattern = /\bexport\s+\*\s+from\s*['"]([^'"]+)['"]/g;
  while ((match = starPattern.exec(text))) if (/^export\b/.test(code.slice(match.index))) stars.push(match[1]);
  return { file: { lines: text ? text.split(/\r\n|\r|\n/).length - (/\r\n$|\r$|\n$/.test(text) ? 1 : 0) : 0, imports: [...imports].sort(), ...(stars.length ? { exportStars: [...new Set(stars)].sort() } : {}) }, symbols, annotations, tagCount };
}

function build() {
  const paths = [];
  for (const dir of ['src', 'bin', 'profiles', 'test', 'docs', '.github']) walk(dir, paths);
  const files = {}, keys = {}, serves = {};
  let servesTags = 0;
  for (const name of paths.sort()) {
    try {
      const text = fs.readFileSync(path.join(root, name), 'utf8');
      const indexed = indexFile(name, text);
      files[name] = indexed.file; Object.assign(keys, indexed.symbols); servesTags += indexed.tagCount;
      for (const [id, key] of indexed.annotations) (serves[id] ||= new Set()).add(key);
    } catch (error) { console.error(`INDEX_ERROR ${name}: ${error.message}`); }
  }
  for (const id of Object.keys(serves)) serves[id] = [...serves[id]].sort();
  let commit = null;
  try { commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null; } catch { /* Git is optional. */ }
  let dirty = null;
  try { dirty = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().length > 0; } catch { /* Git is optional. */ }
  return { generatedAt: new Date().toISOString(), commit, dirty,
    counts: { files: Object.keys(files).length, symbols: Object.keys(keys).length, withDoc: Object.values(keys).filter((item) => item.doc).length, servesTags, objectivesAnnotated: Object.keys(serves).length },
    files: sorted(files), keys: sorted(keys), serves: sorted(serves) };
}

function validate(index, filename) {
  const lines = fs.readFileSync(path.resolve(filename), 'utf8').split(/\r\n|\r|\n/);
  const misses = [];
  let cited = 0, keys = 0, files = 0;
  for (let line = 0; line < lines.length; line++) {
    for (const match of lines[line].matchAll(/`([^`]+)`/g)) {
      const token = match[1];
      if (/\s/.test(token) || /(?:https?:\/\/|^\/\/)/i.test(token)) continue;
      if (token.includes('#')) {
        cited++; keys++;
        if (!Object.hasOwn(index.keys, token)) misses.push(`${line + 1}: ${token}`);
      } else if (/^(?:src|bin|test|profiles|\.github)\//.test(token)) {
        const file = token.replace(/:\d+$/, '');
        if (!/\.[A-Za-z0-9]+$/.test(file)) continue;
        cited++; files++;
        if (!Object.hasOwn(index.files, file)) misses.push(`${line + 1}: ${token}`);
      }
    }
  }
  console.log(`UNRESOLVED ${misses.length}`);
  for (const miss of misses) console.log(miss);
  console.log(`CITED ${cited} KEYS ${keys} FILES ${files}`);
  if (misses.length) process.exitCode = 1;
}

const index = build();
if (process.argv[2] === '--validate') {
  if (!process.argv[3]) { console.error('Usage: node scripts/source-index.mjs --validate <map.md>'); process.exitCode = 2; }
  else validate(index, process.argv[3]);
} else if (process.argv[2] === '--coverage') {
  const mapPath = process.argv[3] || path.join(root, 'docs', 'agents', 'CHATGPT-100-SOURCE-MAP.md');
  const mapLines = fs.readFileSync(mapPath, 'utf8').split(/\r?\n/);
  const present = new Set();
  for (const line of mapLines) {
    const match = line.match(/^\|\s*(\d{3})\s*\|/);
    if (match) present.add(match[1]);
  }
  const missing = Array.from({ length: 100 }, (_, n) => String(n + 1).padStart(3, '0')).filter((id) => !present.has(id));
  console.log(`MAP_ROWS ${present.size} OBJECTIVES_WITHOUT_SOURCE ${missing.length}`);
  console.log(missing.join(' '));
} else if (process.argv.length > 2) {
  console.error('Usage: node scripts/source-index.mjs [--validate <map.md> | --coverage]'); process.exitCode = 2;
} else {
  fs.writeFileSync(path.join(root, output), `${JSON.stringify(index, null, 2)}\n`);
  const c = index.counts;
  console.log(`files ${c.files} symbols ${c.symbols} withDoc ${c.withDoc} servesTags ${c.servesTags} objectivesAnnotated ${c.objectivesAnnotated} -> ${output}`);
}
