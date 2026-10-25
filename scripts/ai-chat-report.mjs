#!/usr/bin/env node
// AI-chat shape report.
//
// Renders the captured shape library (families/<familyId>/vNNNN.json) as a human-readable
// matrix: which AI-chat sites have a family, which chat endpoints they expose, which transport
// each one uses and which field path appears to carry the streamed delta.
//
// Read-only on the data directory. Only writes the Markdown report (--out).
// Every value printed comes from a file on disk; missing values render as "not observed".
//
// Usage:
//   node scripts/ai-chat-report.mjs [--data-dir DIR] [--out FILE] [--json] [--families a,b,c]
//
// Qualification rule (documented in the report header as well):
//   A family is treated as an AI-chat family when its id/hosts match a site adapter host from
//   src/profiles/sites/index.mjs (chatgpt, claude, gemini, deepseek, zai, qwen, lmarena,
//   minimax, kimi), or when it exposes at least two endpoints matching the chat path filter
//   (an incidental single /api/chat route is not treated as a chat surface).
import path from 'node:path';
import { readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defaultDataDir, dataPaths, TOOL_ROOT } from '../src/config.mjs';
import { ADAPTER_IDS, listAdapters } from '../src/profiles/sites/index.mjs';

const CHAT_ENDPOINT_RE = /conversation|completion|chat|message|generate|stream|reply|timeline|response/i;

// Field-path matching is segment based, so "$.context_scopes" does not count as "text".
const DELTA_SEGMENTS = new Set([
  'delta', 'deltas',
  'content', 'contents', 'contenttype',
  'text', 'texts',
  'message', 'messages', 'msg', 'msgs',
  'choice', 'choices',
  'token', 'tokens',
  'payload', 'payloads',
  'response', 'responses',
  'output', 'outputs',
  'chunk', 'chunks',
]);
const STREAM_END_SEGMENTS = new Set([
  'done', 'finish', 'finished', 'finishdetails',
  'end', 'ends', 'ending', 'endturn',
  'stop', 'stopped', 'stopreason', 'stoptokens',
  'close', 'closed', 'closereason',
  'final', 'isfinal', 'terminated', 'eos', 'complete', 'completed', 'completereason',
]);

function pathSegments(fieldPath) {
  return String(fieldPath)
    .replaceAll('$', '.')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function hasAnySegment(fieldPath, set) {
  return pathSegments(fieldPath).some((seg) => set.has(seg));
}

const REPORT_NAME = 'AI-CHAT-SHAPES.md';

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------
function fail(message) {
  process.stderr.write(`ai-chat-report: ${message}\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const args = { dataDir: null, out: null, json: false, families: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    const eq = token.indexOf('=');
    const key = eq > 0 ? token.slice(0, eq) : token;
    const inline = eq > 0 ? token.slice(eq + 1) : null;
    const take = () => {
      if (inline !== null) return inline;
      const next = argv[++i];
      if (next === undefined || next.startsWith('--')) fail(`${key} needs a value`);
      return next;
    };
    if (token === '--json') args.json = true;
    else if (token === '--help' || token === '-h') args.help = true;
    else if (key === '--data-dir') args.dataDir = take();
    else if (key === '--out') args.out = take();
    else if (key === '--families') {
      const raw = take();
      args.families = raw.split(',').map((s) => s.trim()).filter(Boolean);
      if (args.families.length === 0) fail('--families needs at least one family id');
    } else fail(`unknown argument "${token}"`);
  }
  return args;
}

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------
function bareHost(value) {
  let v = String(value ?? '').trim().toLowerCase();
  if (!v) return '';
  v = v.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  v = v.split('/')[0].split('?')[0].split('#')[0];
  v = v.split('@').pop();
  v = v.replace(/:\d+$/, '');
  return v.replace(/^www\./, '');
}

const uniq = (list) => [...new Set(list)];
const missing = 'not observed';

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asCount(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function show(value) {
  return value === null || value === undefined || value === '' ? missing : String(value);
}

function latestFamilyFile(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  const versioned = names
    .map((name) => {
      const m = /^v(\d+)\.json$/.exec(name);
      return m ? { name, n: Number(m[1]) } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.n - b.n || a.name.localeCompare(b.name));
  if (versioned.length > 0) return path.join(dir, versioned[versioned.length - 1].name);
  const plain = names.filter((n) => /^family\.json$/i.test(n)).sort()[0];
  return plain ? path.join(dir, plain) : null;
}

// ---------------------------------------------------------------------------------------------
// Load one family (never throws; corrupt files become an `error` record)
// ---------------------------------------------------------------------------------------------
function loadFamily(familiesDir, familyId) {
  const dir = path.join(familiesDir, familyId);
  const file = latestFamilyFile(dir);
  let record = null;
  let error = null;
  if (!file) error = 'no versioned family file';
  else {
    try {
      record = JSON.parse(readFileSync(file, 'utf8'));
      if (!record || typeof record !== 'object' || Array.isArray(record)) {
        error = 'family file is not a JSON object';
        record = null;
      }
    } catch (e) {
      error = e.message;
      record = null;
    }
  }

  if (!record) {
    return {
      id: familyId,
      file: file ? path.relative(TOOL_ROOT, file).replaceAll('\\', '/') : null,
      error,
      name: null,
      site: null,
      hosts: [],
      signature: null,
      profile: null,
      kind: null,
      memberIds: [],
      coverage: { sessions: null, withDerived: null, streams: null, transports: [] },
      warnings: [],
      endpoints: [],
      chatEndpoints: [],
    };
  }

  const coverageRaw = record.coverage && typeof record.coverage === 'object' ? record.coverage : {};
  const memberIds = asArray(record.members).filter((m) => typeof m === 'string');

  const endpoints = asArray(record.shapes)
    .filter((s) => s && typeof s === 'object' && typeof s.endpoint === 'string')
    .map((s) => {
      const fields = asArray(s.fields).filter((f) => f && typeof f.path === 'string');
      const allPaths = uniq(fields.map((f) => f.path)).sort();
      const deltaPaths = allPaths.filter((p) => hasAnySegment(p, DELTA_SEGMENTS));
      return {
        transport: typeof s.transport === 'string' ? s.transport : null,
        endpoint: s.endpoint,
        fieldPaths: fields.length,
        allPaths,
        deltaPaths,
        sessions: asCount(s.sessions),
        observations: asCount(s.observations),
        deltas: asArray(s.deltas).length,
      };
    })
    .sort((a, b) => a.endpoint.localeCompare(b.endpoint) || String(a.transport).localeCompare(String(b.transport)));

  const transportsRaw = Array.isArray(coverageRaw.transports)
    ? uniq(coverageRaw.transports.filter((t) => typeof t === 'string')).sort()
    : uniq(endpoints.map((e) => e.transport).filter(Boolean)).sort();

  const family = {
    id: typeof record.id === 'string' && record.id ? record.id : familyId,
    file: file ? path.relative(TOOL_ROOT, file).replaceAll('\\', '/') : null,
    error: null,
    name: typeof record.name === 'string' ? record.name : null,
    site: typeof record.site === 'string' ? record.site : null,
    hosts: asArray(record.hosts).filter((h) => typeof h === 'string'),
    signature: typeof record.signature === 'string' ? record.signature : null,
    profile: typeof record.profile === 'string' ? record.profile : null,
    kind: typeof record.kind === 'string' ? record.kind : null,
    memberIds,
    coverage: {
      sessions: asCount(coverageRaw.sessions),
      withDerived: asCount(coverageRaw.withDerived),
      streams: asCount(coverageRaw.streams),
      transports: transportsRaw,
    },
    warnings: asArray(record.warnings).map((w) => (typeof w === 'string' ? w : JSON.stringify(w))),
    endpoints,
    chatEndpoints: endpoints.filter((e) => CHAT_ENDPOINT_RE.test(e.endpoint)),
  };
  return family;
}

// ---------------------------------------------------------------------------------------------
// Chat-site knowledge, from the adapter registry only
// ---------------------------------------------------------------------------------------------
async function chatHostIndex() {
  const index = new Map(); // bareHost -> { id, label }
  let adapters = [];
  try {
    adapters = await listAdapters();
  } catch {
    adapters = [];
  }
  for (const a of adapters) {
    const entry = { id: a.id, label: a.label ?? a.id, hosts: asArray(a.hosts) };
    for (const candidate of [a.id, ...entry.hosts]) {
      const host = bareHost(candidate);
      if (host) index.set(host, entry);
    }
  }
  return { index, adapters };
}

function adapterForFamily(family, hostIndex) {
  const candidates = [family.id, ...family.hosts].map(bareHost).filter(Boolean);
  for (const host of candidates) {
    if (hostIndex.has(host)) return hostIndex.get(host);
  }
  return null;
}

function qualifiesAsChat(family, hostIndex) {
  if (family.error) return { isChat: false, reason: null };
  const adapter = adapterForFamily(family, hostIndex);
  if (adapter) return { isChat: true, reason: `host matches adapter "${adapter.id}"` };
  if (family.chatEndpoints.length >= 2) {
    return { isChat: true, reason: `${family.chatEndpoints.length} endpoints match the chat path filter` };
  }
  return { isChat: false, reason: null };
}

// ---------------------------------------------------------------------------------------------
// Console table
// ---------------------------------------------------------------------------------------------
function renderTable(rows) {
  const headers = ['family', 'sessions', 'derived', 'streams', 'transports', 'chat endpoints', 'signature'];
  const body = rows.map((r) => [
    r.id,
    String(show(r.coverage.sessions)),
    String(show(r.coverage.withDerived)),
    String(show(r.coverage.streams)),
    r.coverage.transports.length > 0 ? r.coverage.transports.join(',') : missing,
    String(r.chatEndpoints.length),
    show(r.signature),
  ]);
  const widths = headers.map((h, i) => Math.max(h.length, ...body.map((row) => row[i].length)));
  const line = (cells) => cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i]))).join('  ').trimEnd();
  const divider = widths.map((w) => '-'.repeat(w)).join('  ');
  return [line(headers), divider, ...body.map(line)].join('\n');
}

// ---------------------------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------------------------
function cell(value) {
  return String(value).replaceAll('|', '\\|').replace(/\r?\n/g, ' ');
}

function code(value) {
  return `\`${String(value).replaceAll('`', "'")}\``;
}

function summarisePaths(paths, limit = 4) {
  if (paths.length === 0) return missing;
  const shown = paths.slice(0, limit).map(code).join(', ');
  return paths.length > limit ? `${shown} (+${paths.length - limit} more)` : shown;
}

// End-of-stream evidence is only taken from field paths actually present in the family's shapes.
function streamEndPaths(family) {
  const found = new Set();
  for (const e of family.chatEndpoints) {
    for (const key of e.allPaths ?? []) if (hasAnySegment(key, STREAM_END_SEGMENTS)) found.add(key);
  }
  return [...found].sort();
}

function renderMarkdown({ families, gaps, unreadable, excluded, meta }) {
  const out = [];
  out.push('# AI chat shape library');
  out.push('');
  out.push('> **Generated output - do not edit by hand.** Regenerate with the command below.');
  out.push('>');
  out.push(`> - command: ${code(meta.command)}`);
  out.push(`> - data dir: ${code(meta.dataDir)}`);
  out.push(`> - generated (UTC): ${code(meta.generatedAt)}`);
  out.push(`> - families with a chat surface: ${families.length}`);
  out.push('>');
  out.push('> Every value is read from a captured family file (`families/<familyId>/vNNNN.json`).');
  out.push(`> Fields that the captures do not show are printed as "${missing}".`);
  out.push('>');
  out.push('> A family counts as an AI-chat family when its id/hosts match a site adapter host');
  out.push('> (`src/profiles/sites/index.mjs` -> `ADAPTER_IDS`), or when it exposes at least two');
  out.push('> endpoints matching `/conversation|completion|chat|message|generate|stream|reply|timeline|response/i`.');
  out.push('');

  out.push('## Summary');
  out.push('');
  out.push('| family | hosts | sessions | derived | streams | transports | chat endpoints | endpoints (total) | signature |');
  out.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const f of families) {
    out.push(
      `| ${cell(f.id)} | ${cell(f.hosts.length ? f.hosts.join(', ') : missing)} | ${show(f.coverage.sessions)} | ${show(
        f.coverage.withDerived,
      )} | ${show(f.coverage.streams)} | ${cell(f.coverage.transports.length ? f.coverage.transports.join(', ') : missing)} | ${
        f.chatEndpoints.length
      } | ${f.endpoints.length} | ${cell(show(f.signature))} |`,
    );
  }
  out.push('');

  for (const f of families) {
    out.push(`## ${f.id}`);
    out.push('');
    out.push(`- hosts: ${f.hosts.length ? f.hosts.map(code).join(', ') : missing}`);
    out.push(`- site / family name: ${f.site ? code(f.site) : missing} / ${f.name ? code(f.name) : missing}`);
    out.push(`- member sessions: ${f.coverage.sessions ?? f.memberIds.length}${f.memberIds.length ? ` (${f.memberIds.map(code).join(', ')})` : ''}`);
    out.push(`- derived sessions: ${show(f.coverage.withDerived)}, streams: ${show(f.coverage.streams)}`);
    out.push(`- transports: ${f.coverage.transports.length ? f.coverage.transports.map(code).join(', ') : missing}`);
    out.push(`- profile / signature: ${f.profile ? code(f.profile) : missing} / ${f.signature ? code(f.signature) : missing}`);
    out.push(`- endpoint surface: ${f.chatEndpoints.length} chat, ${f.endpoints.length} total`);
    if (f.warnings.length) out.push(`- family warnings: ${f.warnings.map(cell).join('; ')}`);
    out.push('');
    if (f.chatEndpoints.length === 0) {
      out.push('No chat endpoint was observed in this family.');
      out.push('');
      continue;
    }
    out.push('| transport | endpoint | field paths | delta / content field paths |');
    out.push('| --- | --- | --- | --- |');
    for (const e of f.chatEndpoints) {
      out.push(
        `| ${cell(show(e.transport))} | ${code(e.endpoint)} | ${e.fieldPaths} | ${cell(summarisePaths(e.deltaPaths))} |`,
      );
    }
    out.push('');
    const truncated = f.chatEndpoints.filter((e) => e.deltaPaths.length > 4);
    if (truncated.length) {
      out.push('<details><summary>All delta / content field paths</summary>');
      out.push('');
      for (const e of truncated) {
        out.push(`**${code(e.endpoint)}** (${show(e.transport)})`);
        out.push('');
        out.push('```');
        for (const p of e.deltaPaths) out.push(p);
        out.push('```');
        out.push('');
      }
      out.push('</details>');
      out.push('');
    }
  }

  out.push('## How the sites differ');
  out.push('');
  out.push('Derived from the tables above: the transport of each chat endpoint, any observed end-of-stream');
  out.push(`field path, and the field paths that look like a delta/content payload. "${missing}" means the`);
  out.push('capture does not show that property - it is not an assumption that it is absent at the site.');
  out.push('');
  out.push('| site | chat transports | stream-end field path | delta / content carrier |');
  out.push('| --- | --- | --- | --- |');
  for (const f of families) {
    const chatTransports = uniq(f.chatEndpoints.map((e) => e.transport).filter(Boolean)).sort();
    const endPaths = streamEndPaths(f);
    const carriers = uniq(f.chatEndpoints.flatMap((e) => e.deltaPaths)).sort();
    out.push(
      `| ${cell(f.id)} | ${cell(chatTransports.length ? chatTransports.join(', ') : missing)} | ${cell(
        summarisePaths(endPaths, 3),
      )} | ${cell(summarisePaths(carriers, 3))} |`,
    );
  }
  out.push('');
  for (const f of families) {
    const parts = [];
    const chatTransports = uniq(f.chatEndpoints.map((e) => e.transport).filter(Boolean)).sort();
    parts.push(
      chatTransports.length
        ? `${f.id} serves chat over ${chatTransports.join(', ')} (${f.chatEndpoints.length} chat endpoint${
            f.chatEndpoints.length === 1 ? '' : 's'
          } of ${f.endpoints.length}).`
        : `${f.id}: no chat transport observed.`,
    );
    const endPaths = streamEndPaths(f);
    parts.push(
      endPaths.length
        ? `End of stream is signalled by ${summarisePaths(endPaths, 2)}.`
        : `End-of-stream signalling: ${missing}.`,
    );
    const carriers = uniq(f.chatEndpoints.flatMap((e) => e.deltaPaths)).sort();
    parts.push(carriers.length ? `Delta/content paths observed: ${summarisePaths(carriers, 2)}.` : `Delta/content carrier: ${missing}.`);
    out.push(`- ${parts.join(' ')}`);
  }
  out.push('');

  out.push('## Coverage and gaps');
  out.push('');
  out.push('AI chat sites declared in `src/profiles/sites/index.mjs` -> `ADAPTER_IDS`, and whether the captured');
  out.push('family store has a family for the site.');
  out.push('');
  out.push('| adapter | label | adapter hosts | family | chat endpoints |');
  out.push('| --- | --- | --- | --- | --- |');
  for (const g of gaps) {
    out.push(
      `| ${cell(g.id)} | ${cell(g.label)} | ${cell(g.hosts.length ? g.hosts.join(', ') : missing)} | ${
        g.familyId ? code(g.familyId) : '**NO FAMILY**'
      } | ${g.familyId ? g.chatEndpoints : 0} |`,
    );
  }
  out.push('');
  const missingSites = gaps.filter((g) => !g.familyId).map((g) => g.id);
  out.push(
    missingSites.length
      ? `Sites with no captured family yet: ${missingSites.map(code).join(', ')}.`
      : 'Every AI chat site in `ADAPTER_IDS` has a captured family.',
  );
  out.push('');
  out.push(`- family files in the store: ${meta.familyCount}`);
  out.push(`- chat families reported: ${families.length}`);
  out.push(
    excluded.length
      ? `- families with a chat-looking path but no chat surface / no adapter host (not reported above): ${excluded
          .map((e) => `${code(e.id)} (${e.why})`)
          .join(', ')}`
      : '- families with a chat-looking path but no chat surface: none',
  );
  out.push(
    unreadable.length
      ? `- unreadable or empty family files: ${unreadable.map((u) => `${code(u.id)}: ${cell(u.error)}`).join('; ')}`
      : '- unreadable family files: none',
  );
  out.push('');
  return out.join('\n');
}

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(
      'Usage: node scripts/ai-chat-report.mjs [--data-dir DIR] [--out FILE] [--json] [--families a,b,c]\n',
    );
    return;
  }

  const dataDir = args.dataDir ? path.resolve(args.dataDir) : defaultDataDir();
  const paths = dataPaths(dataDir);
  const outFile = args.out
    ? path.resolve(TOOL_ROOT, args.out)
    : path.join(TOOL_ROOT, 'docs', REPORT_NAME);

  let familyDirs = [];
  try {
    familyDirs = readdirSync(paths.families, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch (e) {
    fail(`cannot read family store ${paths.families}: ${e.message}`);
  }

  const allFamilies = familyDirs.map((id) => loadFamily(paths.families, id));
  const { index: hostIndex, adapters } = await chatHostIndex();

  const unreadable = allFamilies.filter((f) => f.error);
  const excluded = [];
  let selected = [];
  for (const family of allFamilies) {
    if (family.error) continue;
    const verdict = qualifiesAsChat(family, hostIndex);
    if (verdict.isChat) selected.push({ ...family, chatReason: verdict.reason });
    else if (family.chatEndpoints.length > 0) {
      excluded.push({ id: family.id, why: `${family.chatEndpoints.length} chat-looking endpoint, no adapter host` });
    }
  }

  if (args.families) {
    const want = new Set(args.families.map((s) => s.toLowerCase()));
    selected = selected.filter((f) => want.has(f.id.toLowerCase()));
  }
  selected.sort((a, b) => a.id.localeCompare(b.id));
  unreadable.sort((a, b) => a.id.localeCompare(b.id));
  excluded.sort((a, b) => a.id.localeCompare(b.id));

  // Gap analysis uses the whole store, so --families never hides a missing site.
  const gaps = adapters
    .map((a) => {
      const hosts = asArray(a.hosts).map(bareHost).filter(Boolean);
      const family = allFamilies.find((f) => {
        if (f.error) return false;
        if (bareHost(f.id) === bareHost(a.id)) return true;
        return f.hosts.map(bareHost).some((h) => hosts.includes(h));
      });
      return {
        id: a.id,
        label: a.label ?? a.id,
        hosts: asArray(a.hosts),
        familyId: family ? family.id : null,
        chatEndpoints: family ? (family.chatEndpoints ?? []).length : 0,
      };
    })
    .sort((x, y) => x.id.localeCompare(y.id));

  const generatedAt = `${new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')}`;
  const command = ['node scripts/ai-chat-report.mjs', args.dataDir ? `--data-dir ${args.dataDir}` : null, args.out ? `--out ${args.out}` : null, args.families ? `--families ${args.families.join(',')}` : null]
    .filter(Boolean)
    .join(' ');

  const meta = { command, dataDir, generatedAt, familyCount: familyDirs.length };

  const payload = {
    generatedAt,
    command,
    dataDir,
    reportFile: outFile,
    families: selected.map((f) => ({
      id: f.id,
      name: f.name,
      site: f.site,
      hosts: f.hosts,
      kind: f.kind,
      signature: f.signature,
      profile: f.profile,
      files: f.file,
      chatReason: f.chatReason,
      members: { count: f.coverage.sessions ?? f.memberIds.length, ids: f.memberIds },
      coverage: f.coverage,
      warnings: f.warnings,
      chatEndpoints: f.chatEndpoints.map((e) => ({
        transport: e.transport,
        endpoint: e.endpoint,
        fieldPaths: e.fieldPaths,
        deltaPaths: e.deltaPaths,
      })),
      totalEndpoints: f.endpoints.length,
    })),
    adapters: gaps,
    unreadable: unreadable.map((f) => ({ id: f.id, error: f.error })),
    excluded,
  };

  const markdown = renderMarkdown({ families: selected, gaps, unreadable, excluded, meta });
  mkdirSync(path.dirname(outFile), { recursive: true });
  writeFileSync(outFile, markdown + '\n');

  if (args.json) {
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
  } else {
    const rows = selected.map((f) => ({
      id: f.id,
      coverage: f.coverage,
      chatEndpoints: f.chatEndpoints,
      signature: f.signature,
    }));
    process.stdout.write(renderTable(rows) + '\n');
    process.stdout.write(`report: ${outFile}\n`);
    const missingSites = gaps.filter((g) => !g.familyId).map((g) => g.id);
    process.stdout.write(`no family yet: ${missingSites.length ? missingSites.join(', ') : 'none'}\n`);
  }
}

main().catch((e) => {
  process.stderr.write(`ai-chat-report: ${e && e.stack ? e.stack : e}\n`);
  process.exit(1);
});
