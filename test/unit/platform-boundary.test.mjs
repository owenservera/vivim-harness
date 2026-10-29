// The OS-specific baggage budget, as an assertion.
//
// Platform knowledge may choose a *value* in a small, reviewed set of places. Everywhere else it
// must be absent, because a branch that no test exercises is a branch that will rot. Two failure
// modes matter and both are caught here:
//
//   - a new platform branch appears     -> baggage grows silently;
//   - an allowlisted branch disappears   -> portability was silently dropped, e.g. the Windows
//                                           data root deleted because only Linux was tested.
//
// The second one is the reason this file exists. A deleted branch is invisible in review; a test
// that notices it is missing is not. See docs/PORTABILITY.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const ROOTS = ['src', 'bin', 'scripts'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'fixtures', 'chrome-profile']);
const SOURCE = /\.(?:mjs|cjs|js)$/;

// A platform *decision*, not prose: a comment saying "on win32" is not a branch.
const DECISION_TOKENS = [
  /process\.platform/,
  /\bpath\.(?:win32|posix)\b/,
  /[=!]==?\s*['"](?:win32|darwin)['"]/,
];

// The shipped product surface may only decide these four things. Anything that is not here is a
// value that does not depend on the OS, or a capability that should be probed instead.
const PRODUCT_DOMAINS = ['data-root', 'browser-discovery', 'url-opener', 'filename-case'];
// Developer tooling may additionally tear processes down: Windows has no POSIX signals.
const TOOLING_DOMAINS = [...PRODUCT_DOMAINS, 'process-control'];

// Ordered per file: each entry must match the next platform line in that file, in source order.
// `match` is a stable substring of the line, so reformatting does not fail the test but changing
// the branch does.
const ALLOWLIST = {
  'src/config.mjs': [
    { match: 'export function defaultDataDir(', kind: 'decision', domain: 'data-root', reason: 'The private-data root is the one path only the OS can decide; platform is a parameter so both branches run on either host.' },
    { match: "if (platform === 'win32') return path.join(env.LOCALAPPDATA", kind: 'decision', domain: 'data-root', reason: 'Windows keeps private evidence under LOCALAPPDATA, never inside the source checkout.' },
    { match: "if (platform === 'darwin') return path.join(os.homedir(), 'Library'", kind: 'decision', domain: 'data-root', reason: 'macOS convention is Library/Application Support; XDG_DATA_HOME is a Linux convention and is not consulted there.' },
  ],
  'src/chrome/launch.mjs': [
    { match: 'const impl = platform === \'win32\'', kind: 'decision', domain: 'browser-discovery', reason: 'Windows separators and PATH delimiters differ; path.win32 keeps the Windows list correct when built on Linux.' },
    { match: 'env.Path ?? env.PATH ?? env.path', kind: 'decision', domain: 'browser-discovery', reason: 'Windows spells the variable Path by default; this env lookup is the only place that spelling matters.' },
    { match: 'export function chromeCandidates(', kind: 'decision', domain: 'browser-discovery', reason: 'Platform is a parameter, so the Windows candidate list is exercised on Linux and the Linux list on Windows.' },
    { match: 'const c = [], impl =', kind: 'decision', domain: 'browser-discovery', reason: 'Candidate paths must use the target platform the list describes, not the host running the test.' },
    { match: "if (platform === 'win32') {", kind: 'decision', domain: 'browser-discovery', reason: 'Windows install roots (PROGRAMFILES, LOCALAPPDATA) have no equivalent elsewhere, so they are only added there.' },
    { match: "else if (platform === 'darwin')", kind: 'decision', domain: 'browser-discovery', reason: 'macOS ships browsers as app bundles; this is the only darwin-specific knowledge in the codebase.' },
    { match: 'const names = platform ===', kind: 'decision', domain: 'browser-discovery', reason: 'Executable names differ (chrome.exe vs google-chrome); names are data appended to a list, not a second flow.' },
    { match: 'export function findChrome(', kind: 'decision', domain: 'browser-discovery', reason: 'findChrome takes the platform so a Linux candidate list is testable from Windows and vice versa.' },
    { match: 'export function chromeInstalls(', kind: 'decision', domain: 'browser-discovery', reason: 'Reports the same target-platform list the launcher would use.' },
  ],
  'bin/commands/capture.mjs': [
    { match: "const cmd = process.platform === 'win32' ? ['explorer.exe'", kind: 'decision', domain: 'url-opener', reason: 'Each OS has exactly one shell-free opener; the URL is passed as argv so no shell ever parses it.' },
  ],
  'bin/commands/selftest.mjs': [
    { match: 'platform: `${process.platform}-${process.arch}`', kind: 'report', reason: 'Receipts name the host that produced them; nothing branches on the value.' },
  ],
  'bin/commands/system.mjs': [
    { match: 'platform: `${process.platform}-${process.arch}`', kind: 'report', reason: 'Diagnostics report the host; nothing branches on the value.' },
  ],
  'src/store/versioned.mjs': [
    { match: "process.platform === 'win32' ? a.toLowerCase()", kind: 'decision', domain: 'filename-case', reason: 'Record identity compares NTFS paths case-insensitively because the filesystem does; ext4 is case-sensitive.' },
  ],
  'src/studio/agentic-files.mjs': [
    { match: "process.platform === 'win32' ? a.toLowerCase()", kind: 'decision', domain: 'filename-case', reason: 'Containment compares real paths with the host filesystem case rules, or a path could escape its root on NTFS.' },
    { match: "const win32 = process.platform === 'win32'", kind: 'decision', domain: 'filename-case', reason: 'The same case rule plus separator normalisation, computed once for the containment walk.' },
    { match: "const key = process.platform === 'win32' ? name.toLowerCase()", kind: 'decision', domain: 'filename-case', reason: 'Policy directory names (git, node_modules) are matched the way the filesystem would resolve them.' },
  ],
  'src/export/outcome-packet.mjs': [
    { match: 'platform: process.platform, node: process.version, source_sha', kind: 'report', reason: 'Offline packet provenance records the host; nothing branches on the value.' },
  ],
  'scripts/gate.mjs': [
    { match: 'process.platform', kind: 'report', reason: 'The gate header names the host so a pasted receipt cannot be attributed to the wrong OS.' },
  ],
  'scripts/local-verify.mjs': [
    { match: 'platform: process.platform', kind: 'report', reason: 'Verification receipts record the host for provenance, without branching on it.' },
    { match: "process.platform === 'win32' ? 'bun.exe' : 'bun'", kind: 'decision', domain: 'process-control', reason: 'Shell-free child process execution uses the Windows executable name instead of relying on shell resolution.' },
  ],
  'scripts/always-on.mjs': [
    { match: "if (process.platform === 'win32') {", kind: 'decision', domain: 'process-control', reason: 'Windows has no POSIX signals; a supervised child is torn down with taskkill /T.' },
    { match: "if (process.platform === 'win32') killTree(pid", kind: 'decision', domain: 'process-control', reason: 'The stop path must kill the tree on Windows, not just the parent, or the daemon survives.' },
    { match: "if (process.platform === 'win32') killTree(pid", kind: 'decision', domain: 'process-control', reason: 'The restart path uses the same teardown as stop.' },
  ],
  'scripts/fidelity-survey.mjs': [
    { match: "process.platform === 'win32' ? r.toLowerCase()", kind: 'decision', domain: 'filename-case', reason: 'Local path comparison follows the host filesystem; this survey never runs for another OS.' },
  ],
  'scripts/proto-field-search.mjs': [
    { match: "process.platform === 'win32' ? r.toLowerCase()", kind: 'decision', domain: 'filename-case', reason: 'Same host-filesystem comparison as fidelity-survey, duplicated rather than shared with a dev-only script.' },
  ],
  'scripts/live-e2e.mjs': [
    { match: "if (process.platform === 'win32') {", kind: 'decision', domain: 'process-control', reason: 'Confirming the driver owns the Chrome it started needs PowerShell CIM, which exists only on Windows.' },
  ],
  'scripts/bench-agent14-systems.mjs': [
    { match: 'platform:process.platform', kind: 'report', reason: 'Synthetic benchmark input records the host; nothing branches on the value.' },
  ],
  'scripts/core-local-handoff.mjs': [
    { match: 'platform: process.platform', kind: 'report', reason: 'Handoff metadata records the host; nothing branches on the value.' },
  ],
  'scripts/loadlab.mjs': [
    { match: 'platform: `${process.platform} ${process.arch}`', kind: 'report', reason: 'Load-lab result header records the host; nothing branches on the value.' },
    { match: 'platform: `${process.platform} ${process.arch}`', kind: 'report', reason: 'Second load-lab report path, same provenance purpose.' },
  ],
  'scripts/platform-smoke.mjs': [
    { match: 'platform: process.platform', kind: 'report', reason: 'Smoke receipt records the host so it cannot be misread as evidence for the other OS.' },
  ],
};

// Growth requires a deliberate edit here, which is the review conversation.
const SHIPPED_DECISION_BUDGET = 17;
const TOOLING_DECISION_BUDGET = 7;

function sourceFiles() {
  const out = [];
  const walk = (rel) => {
    for (const entry of readdirSync(path.join(repo, rel), { withFileTypes: true })) {
      const next = path.posix.join(rel, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) walk(next); }
      else if (SOURCE.test(entry.name)) out.push(next);
    }
  };
  for (const root of ROOTS) walk(root);
  return out;
}

function platformLines(file) {
  const lines = readFileSync(path.join(repo, file), 'utf8').split(/\r?\n/);
  const hits = [];
  lines.forEach((text, index) => {
    const trimmed = text.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) return; // prose, not a branch
    if (DECISION_TOKENS.some((token) => token.test(trimmed))) hits.push({ n: index + 1, text: trimmed });
  });
  return hits;
}

function entries() {
  return Object.entries(ALLOWLIST).flatMap(([file, list]) => list.map((entry) => ({ file, ...entry })));
}

test('platform branching stays inside the reviewed allowlist', () => {
  const problems = [];
  const scanned = sourceFiles();
  for (const file of scanned) {
    const lines = platformLines(file);
    const allowed = ALLOWLIST[file] ?? [];
    for (const extra of lines.slice(allowed.length))
      problems.push(`unlisted platform branch: ${file}:${extra.n}\n    ${extra.text}\n    Remove it, probe the capability instead, or add an allowlist entry with a reason.`);
    for (const stale of allowed.slice(lines.length))
      problems.push(`stale allowlist entry for ${file} ("${stale.match}" is no longer there).\n    If portability was dropped on purpose, delete the entry and say why; otherwise restore the branch.`);
    for (let i = 0; i < Math.min(lines.length, allowed.length); i++) {
      if (!lines[i].text.includes(allowed[i].match))
        problems.push(`allowlist drift: ${file}:${lines[i].n}\n    expected a line containing: ${allowed[i].match}\n    found: ${lines[i].text}`);
    }
  }
  for (const file of Object.keys(ALLOWLIST))
    if (!scanned.includes(file)) problems.push(`allowlist names a missing file: ${file}`);
  assert.deepEqual(problems, [], `\n${problems.join('\n')}\n`);
});

test('every platform site is classified, and the shipped surface keeps all four decisions', () => {
  const all = entries();
  const problems = [];
  for (const entry of all) {
    if (!['decision', 'report'].includes(entry.kind)) problems.push(`${entry.file}: "${entry.match}" has kind "${entry.kind}"`);
    if (typeof entry.reason !== 'string' || entry.reason.length < 24) problems.push(`${entry.file}: "${entry.match}" needs a real reason`);
    if (entry.kind === 'report' && entry.domain) problems.push(`${entry.file}: "${entry.match}" only reports the platform but claims domain "${entry.domain}"`);
    if (entry.kind === 'decision') {
      const permitted = entry.file.startsWith('scripts/') ? TOOLING_DOMAINS : PRODUCT_DOMAINS;
      if (!permitted.includes(entry.domain)) problems.push(`${entry.file}: decision domain "${entry.domain}" is not permitted here (allowed: ${permitted.join(', ')})`);
    }
  }
  for (const domain of PRODUCT_DOMAINS) {
    if (!all.some((e) => e.kind === 'decision' && e.domain === domain && !e.file.startsWith('scripts/')))
      problems.push(`portability dropped: no shipped code still decides ${domain}. Restore it or amend docs/PORTABILITY.md and this test together.`);
  }
  assert.deepEqual(problems, [], `\n${problems.join('\n')}\n`);
});

test('the platform baggage budget has not grown', () => {
  const shipped = entries().filter((e) => e.kind === 'decision' && !e.file.startsWith('scripts/')).length;
  const tooling = entries().filter((e) => e.kind === 'decision' && e.file.startsWith('scripts/')).length;
  assert.ok(shipped <= SHIPPED_DECISION_BUDGET,
    `shipped surface has ${shipped} platform decision lines, budget ${SHIPPED_DECISION_BUDGET}. Fold the new one into a value, probe the capability, or raise the budget and docs/PORTABILITY.md together.`);
  assert.ok(tooling <= TOOLING_DECISION_BUDGET,
    `scripts/ has ${tooling} platform decision lines, budget ${TOOLING_DECISION_BUDGET}.`);
});
