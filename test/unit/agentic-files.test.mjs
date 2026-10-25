// C-11 agentic file library is read-only, execution-free, and root-bounded.
// Source-level, discovery, refusal, cap, untrust, path-blast-radius, and coverage-honesty tests.
// Every test uses temp dirs under the OS temp root and never touches the repo working tree.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as mod from '../../src/studio/agentic-files.mjs';
import { createAgenticFileLibrary, registerAgenticFileRoutes, AGENTIC_FILE_KINDS, AGENTIC_FILE_LIMITS, AGENTIC_PRECEDENCE_RULE } from '../../src/studio/agentic-files.mjs';

const source = readFileSync(new URL('../../src/studio/agentic-files.mjs', import.meta.url), 'utf8');

function tempRoot(t, prefix = 'agentic-files-') {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

// Junctions work unprivileged on Windows and degrade to regular symlinks elsewhere, so the
// refusal assertions stay deterministic. When link creation itself is denied, the platform
// cannot host the refusal case here and the test keeps only the assertions it can prove.
function maybeJunction(target, linkPath) {
  try { symlinkSync(target, linkPath, 'junction'); return true; } catch { return false; }
}

function expect404(block) {
  try { block(); } catch (e) {
    assert.equal(e.status, 404);
    assert.equal(e.code, 'AGENTIC_NOT_FOUND');
    return;
  }
  assert.fail('expected an AgenticFile not-found problem');
}

function expect400(block) {
  try { block(); } catch (e) {
    assert.equal(e.status, 400);
    return;
  }
  assert.fail('expected an invalid-request problem');
}

// The output contract: root-relative paths only. Nothing in the full JSON payload may name
// the temp root, the OS temp dir, or carry a Windows drive-letter absolute path.
function expectNoAbsolutePaths(result, root) {
  const json = JSON.stringify(result);
  assert.equal(json.includes(root.toLowerCase()), false, 'output includes the root absolute path');
  assert.equal(json.includes(tmpdir().toLowerCase()), false, 'output includes the OS temp dir path');
  assert.doesNotMatch(json, /[A-Za-z]:[\\/]/, 'output includes a drive-letter absolute path');
}

test('module surface is inventory-only: no execution, no network, no process, no shell', () => {
  assert.deepEqual(Object.keys(mod).sort(), [
    'AGENTIC_FILE_KINDS', 'AGENTIC_FILE_LIMITS', 'AGENTIC_PRECEDENCE_RULE',
    'createAgenticFileLibrary', 'registerAgenticFileRoutes',
  ]);
  const lib = createAgenticFileLibrary({ roots: [] });
  assert.deepEqual(Object.keys(lib).sort(), ['get', 'list']);
  for (const banned of ['child_process', 'node:http', 'node:net', 'node:https', 'node:dns', 'node:tls',
    'node:worker_threads', 'node:vm', 'process.exec', 'spawn(', 'execSync', 'eval(', 'new Function', 'vm.runIn',
    `require(`
  ]) {
    assert.equal(source.includes(banned), false, `source must not contain ${banned}`);
  }
  assert.doesNotMatch(source, /export\s+(async\s+)?function\s+(execute|run|dispatch|perform|apply|send)\b/);
});

test('imports stay bounded to crypto, fs, path, and the shared studio problem helpers', () => {
  const imports = [...source.matchAll(/^import\s+(?:\{[\s\S]*?\}|[^;]+?)\s+from\s+'([^']+)';/gm)].map((m) => m[1]).sort();
  assert.deepEqual(imports, ['./http.mjs', 'node:crypto', 'node:fs', 'node:path']);
});

test('discovery inventories the known kinds with the full record contract', (t) => {
  const root = tempRoot(t);
  writeFileSync(path.join(root, 'AGENTS.md'), '# Root agent\nBe brief.\n');
  writeFileSync(path.join(root, 'CLAUDE.md'), '---\ncodename: v1\n---\n# Claude\n');
  mkdirSync(path.join(root, '.opencode', 'agents'), { recursive: true });
  writeFileSync(path.join(root, '.opencode', 'agents', 'reader.md'), '---\ntitle: Reader\n---\nReads saved evidence only.\n');
  mkdirSync(path.join(root, 'docs', 'agents'), { recursive: true });
  writeFileSync(path.join(root, 'docs', 'agents', 'git-manager.md'), '# Docs agent\n');
  mkdirSync(path.join(root, 'skills', 'demo'), { recursive: true });
  writeFileSync(path.join(root, 'skills', 'demo', 'SKILL.md'), '---\nname: demo-skill\n---\n# Skill body\n');
  // Non-matching families and policy exclusions are scanned and disclosed, not listed.
  writeFileSync(path.join(root, 'README.md'), '# not an agentic file\n');
  mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(path.join(root, 'node_modules', 'AGENTS.md'), 'inside node_modules\n');
  mkdirSync(path.join(root, '.git'), { recursive: true });
  writeFileSync(path.join(root, '.git', 'AGENTS.md'), 'inside git dir\n');

  const lib = createAgenticFileLibrary({ roots: [root] });
  const result = lib.list();
  expectNoAbsolutePaths(result, root);

  const byRel = new Map(result.items.map((item) => [item.path, item]));
  assert.deepEqual([...byRel.keys()].sort(), [
    '.opencode/agents/reader.md', 'AGENTS.md', 'CLAUDE.md', 'docs/agents/git-manager.md', 'skills/demo/SKILL.md',
  ]);
  assert.deepEqual(result.items.map((item) => item.kind).sort(), [...AGENTIC_FILE_KINDS].sort());
  assert.deepEqual(result.items.map((item) => item.kind).sort(), ['agents', 'claude', 'docs-agent', 'opencode-agent', 'skill']);

  for (const item of result.items) {
    assert.match(item.id, /^[a-f0-9]{64}$/);
    assert.equal(item.source, 'local-file');
    assert.equal(item.trust, 'untrusted-until-confirmed');
    assert.equal(item.raisesCapability, false);
    assert.deepEqual(item.capability, { raised: false, ceiling: 'none', reason: 'untrusted-root', claimsIgnored: false });
    assert.equal(typeof item.bytes, 'number');
    assert.match(item.sha256, /^[a-f0-9]{64}$/);
    assert.ok(item.mtime !== null && !Number.isNaN(Date.parse(item.mtime)));
    assert.equal(item.frontmatter === null || typeof item.frontmatter === 'object', true);
    assert.ok(typeof item.title === 'string' && item.title.length > 0);
    assert.equal(path.isAbsolute(item.path), false);
  }
  assert.equal(byRel.get('AGENTS.md').title, 'Root agent');
  assert.deepEqual(byRel.get('CLAUDE.md').frontmatter, { codename: 'v1' });
  assert.deepEqual(byRel.get('.opencode/agents/reader.md').frontmatter, { title: 'Reader' });
  assert.equal(byRel.get('.opencode/agents/reader.md').title, 'Reader');
  // A body heading outranks the frontmatter name backfill.
  assert.equal(byRel.get('skills/demo/SKILL.md').title, 'Skill body');
  assert.equal(byRel.get('skills/demo/SKILL.md').frontmatter.name, 'demo-skill');

  // bytes and sha256 agree with the on-disk bytes.
  const raw = readFileSync(path.join(root, 'AGENTS.md'));
  assert.equal(byRel.get('AGENTS.md').bytes, raw.length);
  assert.equal(byRel.get('AGENTS.md').sha256, createHash('sha256').update(raw).digest('hex'));

  // Coverage honesty: exclusions are listed as policy, nothing is silently dropped.
  assert.equal(result.coverage.complete, true);
  assert.equal(result.coverage.truncated, false);
  assert.deepEqual(result.coverage.excludedByPolicy, ['.git', 'node_modules']);
  assert.equal(result.coverage.matched, 5);
  const skippedReasons = new Set(result.coverage.skipped.map((entry) => entry.reason));
  assert.equal(skippedReasons.has('node_modules'), true);
  assert.equal(skippedReasons.has('git'), true);
  assert.ok(result.coverage.scanned > result.coverage.matched);
  assert.equal(result.coverage.roots.length, 1);
  assert.equal(result.coverage.roots[0].status, 'scanned');
  assert.equal(result.coverage.roots[0].skipReason, null);
  assert.equal(result.coverage.roots[0].untrusted, true);
  assert.equal(typeof result.coverage.qualification, 'string');
  assert.ok(result.coverage.qualification.includes('untrusted'));
});

test('ids are stable hashes of the root-relative path and stay stable across instances', (t) => {
  const root = tempRoot(t);
  writeFileSync(path.join(root, 'AGENTS.md'), 'alpha\n');
  const first = createAgenticFileLibrary({ roots: [{ path: root, id: 'alpha-root', untrusted: false }] });
  const second = createAgenticFileLibrary({ roots: [{ path: root, id: 'alpha-root', untrusted: false }] });
  const [a] = first.list().items;
  const [b] = second.list().items;
  assert.equal(a.id, b.id);
  assert.equal(a.id, createHash('sha256').update('alpha-root').update('\0').update('AGENTS.md').digest('hex'));
});

test('get() returns bounded declared text and never absolute provenance', (t) => {
  const root = tempRoot(t);
  writeFileSync(path.join(root, 'AGENTS.md'), 'line one\nline two\n');
  const lib = createAgenticFileLibrary({ roots: [{ path: root, id: 'g-root', untrusted: false }], limits: { maxContentBytes: 6 } });
  const [record] = lib.list().items;
  const clipped = lib.get(record.id);
  expectNoAbsolutePaths(clipped, root);
  assert.equal(clipped.contentState, 'truncated');
  assert.equal(clipped.contentTruncated, true);
  assert.ok(clipped.content.startsWith('line o'));
  assert.ok(clipped.content.length < 'line one\nline two\n'.length);
  assert.equal(clipped.path, record.path);
  assert.equal(clipped.source, 'local-file');
  assert.equal(clipped.trust, 'untrusted-until-confirmed');
  assert.equal(clipped.capability.raised, false);

  const whole = createAgenticFileLibrary({ roots: [{ path: root, id: 'g-root', untrusted: false }] }).get(record.id);
  assert.equal(whole.contentState, 'full');
  assert.equal(whole.contentTruncated, false);
  assert.equal(whole.content, 'line one\nline two\n');

  expect400(() => lib.get('not-a-hash'));
  expect404(() => lib.get('a'.repeat(64)));
});

test('the id is path-stable while get() serves the live file with its current hash, no stale text', (t) => {
  const root = tempRoot(t);
  writeFileSync(path.join(root, 'AGENTS.md'), 'first\n');
  const lib = createAgenticFileLibrary({ roots: [{ path: root, id: 'i-root', untrusted: false }] });
  const [record] = lib.list().items;
  const before = lib.get(record.id);
  assert.equal(before.content, 'first\n');
  assert.equal(before.sha256, record.sha256);
  writeFileSync(path.join(root, 'AGENTS.md'), 'rewritten after inventory\n');
  // Same id (hash of root id + relative path only), and the read recomputes integrity live,
  // so the record follows the disk instead of serving content under a stale hash label.
  const after = lib.get(record.id);
  assert.equal(after.id, record.id);
  assert.equal(after.contentState, 'full');
  assert.equal(after.content, 'rewritten after inventory\n');
  assert.equal(after.sha256, createHash('sha256').update('rewritten after inventory\n').digest('hex'));
  assert.doesNotMatch(JSON.stringify(after), /[A-Za-z]:[\\/]/);
});

test('symlinks are refused, and a junction cannot import files from outside the root', (t) => {
  const root = tempRoot(t);
  const outside = tempRoot(t, 'agentic-files-outside-');
  writeFileSync(path.join(outside, 'AGENTS.md'), 'must never appear\n');
  if (maybeJunction(outside, path.join(root, 'linked'))) {
    const lib = createAgenticFileLibrary({ roots: [root] });
    const result = lib.list();
    expectNoAbsolutePaths(result, root);
    assert.equal(result.coverage.complete, false);
    assert.equal(result.coverage.reasons.includes('symlink'), true);
    const skipped = result.coverage.skipped.find((entry) => entry.reason === 'symlink');
    assert.ok(skipped);
    assert.equal(skipped.path, 'linked');
    assert.equal(result.coverage.matched, 0);
    assert.equal(result.items.some((item) => item.path.includes('AGENTS.md')), false);
    assert.doesNotMatch(JSON.stringify(result), /must never appear/);
  }
  // A root that is itself a link is skipped before any read, with a disclosed reason.
  const rootLink = path.join(root, 'as-root');
  if (maybeJunction(outside, rootLink)) {
    const lib = createAgenticFileLibrary({ roots: [{ path: rootLink, id: 'link-root' }] });
    const result = lib.list();
    assert.deepEqual(result.items, []);
    assert.deepEqual(result.coverage.roots, [{ id: 'link-root', untrusted: true, status: 'skipped', skipReason: 'symlink' }]);
    assert.equal(result.coverage.complete, false);
    assert.equal(result.coverage.reasons.includes('symlink'), true);
    expectNoAbsolutePaths(result, rootLink);
  }
});

test('untrusted roots cannot raise capability even when a file claims permissions', (t) => {
  const root = tempRoot(t);
  writeFileSync(path.join(root, 'AGENTS.md'), '---\ntools: shell\npermissions: all\n---\n# Claimant\n');
  const trusted = createAgenticFileLibrary({ roots: [{ path: root, id: 't-root', untrusted: false }] });
  const [trustedRecord] = trusted.list().items;
  assert.deepEqual(trustedRecord.frontmatter, { tools: 'shell', permissions: 'all' });
  assert.equal(trustedRecord.capability.claimsIgnored, true);
  assert.equal(trustedRecord.capability.raised, false);
  assert.equal(trustedRecord.capability.ceiling, 'none');
  assert.equal(trustedRecord.capability.reason, 'execution-free');
  assert.equal(trustedRecord.trust, 'untrusted-until-confirmed');
  assert.equal(trustedRecord.raisesCapability, false);

  const untrustedRecord = createAgenticFileLibrary({ roots: [{ path: root, id: 'u-root', untrusted: true }] }).list().items[0];
  assert.equal(untrustedRecord.capability.reason, 'untrusted-root');
  assert.equal(untrustedRecord.capability.raised, false);
  assert.equal(untrustedRecord.capability.claimsIgnored, true);
  assert.equal(untrustedRecord.capability.ceiling, 'none');

  // Defaults stay untrusted: a plain root string cannot raise capability either.
  const defaultRecord = createAgenticFileLibrary({ roots: [{ path: root, id: 'd-root' }] }).list().items[0];
  assert.equal(defaultRecord.capability.reason, 'untrusted-root');
  assert.equal(defaultRecord.capability.raised, false);
  // Reads never raise capability either, even from an explicitly trusted root.
  const gotten = trusted.get(trustedRecord.id);
  assert.equal(gotten.capability.raised, false);
  assert.equal(gotten.capability.ceiling, 'none');
});

test('the strict bounded frontmatter parser rejects flow values, indents, and oversized blocks', (t) => {
  const root = tempRoot(t);
  writeFileSync(path.join(root, 'AGENTS.md'), '---\ntitle: valid\n---\nbody\n');
  const lib = createAgenticFileLibrary({ roots: [root] });
  assert.deepEqual(lib.list().items[0].frontmatter, { title: 'valid' });

  // Flow syntax, indented keys, and open blocks are rejected whole, not guessed.
  const malformed = [
    '---\ntitle: [a, b]\n---\nbody\n',
    '---\n  title: indented\n---\nbody\n',
    '---\ntitle: x\n',
  ];
  let index = 0;
  for (const text of malformed) {
    const dir = tempRoot(t, `agentic-fm-${index++}-`);
    writeFileSync(path.join(dir, 'AGENTS.md'), text);
    const record = createAgenticFileLibrary({ roots: [dir] }).list();
    assert.equal(record.items[0].frontmatter, null, `frontmatter must be rejected as data: ${JSON.stringify(text)}`);
    assert.equal(record.coverage.reasons.includes('frontmatter-rejected'), true);
    expectNoAbsolutePaths(record, dir);
  }

  // Bounds: a value over the declared maximum and more keys than allowed reject the block.
  const capped = tempRoot(t, 'agentic-fm-cap-');
  writeFileSync(path.join(capped, 'AGENTS.md'), `---\ntitle: ${'x'.repeat(AGENTIC_FILE_LIMITS.maxFrontmatterValue + 1)}\n---\nbody\n`);
  const cappedRecord = createAgenticFileLibrary({ roots: [capped] }).list();
  assert.equal(cappedRecord.items[0].frontmatter, null);
  const many = tempRoot(t, 'agentic-fm-keys-');
  const lines = Array.from({ length: AGENTIC_FILE_LIMITS.maxFrontmatterKeys + 1 }, (_, k) => `key${k}: v${k}`);
  writeFileSync(path.join(many, 'AGENTS.md'), `---\n${lines.join('\n')}\n---\nbody\n`);
  const manyRecord = createAgenticFileLibrary({ roots: [many] }).list();
  assert.equal(manyRecord.items[0].frontmatter, null);
  // Claim keys are parsed but flagged, never honored (plain scalar values only; `/bin/sh` is rejected outright).
  const claim = tempRoot(t, 'agentic-fm-claim-');
  writeFileSync(path.join(claim, 'AGENTS.md'), '---\nexec: run-all\ncapabilities: admin\n---\n# Claims\ntext\n');
  const claimItem = createAgenticFileLibrary({ roots: [claim] }).list().items[0];
  assert.deepEqual(claimItem.frontmatter, { exec: 'run-all', capabilities: 'admin' });
  assert.equal(claimItem.capability.claimsIgnored, true);
  assert.equal(claimItem.capability.raised, false);
});

test('caps truncate with disclosed reasons, never with silent or fabricated records', (t) => {
  const root = tempRoot(t);
  for (const dir of ['', 'sub1', 'sub1/sub2']) {
    mkdirSync(path.join(root, dir), { recursive: true });
    writeFileSync(path.join(root, dir, 'AGENTS.md'), `# agents at ${dir || 'root'}\n`);
  }
  const files = createAgenticFileLibrary({ roots: [root], limits: { maxFiles: 2 } }).list();
  assert.equal(files.coverage.matched, 2);
  assert.equal(files.coverage.truncated, true);
  assert.equal(files.coverage.complete, false);
  assert.equal(files.coverage.reasons.includes('max-files'), true);
  expectNoAbsolutePaths(files, root);

  const deep = createAgenticFileLibrary({ roots: [root], limits: { maxDepth: 1 } }).list();
  assert.equal(deep.coverage.matched, 2);
  assert.equal(deep.coverage.reasons.includes('depth'), true);
  assert.equal(deep.coverage.skipped.some((entry) => entry.reason === 'depth'), true);

  const tiny = createAgenticFileLibrary({ roots: [root], limits: { maxEntries: 2 } }).list();
  assert.equal(tiny.coverage.truncated, true);
  assert.equal(tiny.coverage.reasons.includes('max-entries'), true);

  const zeroed = createAgenticFileLibrary({ roots: [root], limits: { maxEntries: 0 } }).list();
  assert.deepEqual(zeroed.items, []);
  assert.equal(zeroed.coverage.truncated, true);
});

test('byte caps are disclosed on both inventory records and bounded reads', (t) => {
  const root = tempRoot(t);
  writeFileSync(path.join(root, 'AGENTS.md'), 'small\n');
  mkdirSync(path.join(root, 'sub'), { recursive: true });
  writeFileSync(path.join(root, 'sub', 'AGENTS.md'), 'b'.repeat(31), 'utf8');
  const lib = createAgenticFileLibrary({ roots: [root], limits: { maxFileBytes: 10 } });
  const result = lib.list();
  expectNoAbsolutePaths(result, root);
  assert.equal(result.coverage.reasons.includes('over-cap'), true);
  assert.equal(result.coverage.truncated, true);
  const small = result.items.find((item) => item.path === 'AGENTS.md');
  const large = result.items.find((item) => item.path === 'sub/AGENTS.md');
  assert.equal(small.bytes, 6);
  assert.equal(small.sha256.length, 64);
  assert.equal(large.sha256, null);
  assert.equal(large.frontmatter, null);
  const read = lib.get(large.id);
  assert.equal(read.content, null);
  assert.equal(read.contentState, 'over-cap');
  assert.equal(read.capability.raised, false);
});

test('precedence is returned as data: nearest-to-root wins only as a disclosed ranking', (t) => {
  const root = tempRoot(t);
  writeFileSync(path.join(root, 'AGENTS.md'), '# shallow\n');
  mkdirSync(path.join(root, 'ded'), { recursive: true });
  writeFileSync(path.join(root, 'ded', 'AGENTS.md'), '# deep\n');
  const result = createAgenticFileLibrary({ roots: [root] }).list();
  assert.equal(result.precedence.rule, AGENTIC_PRECEDENCE_RULE.rule);
  assert.equal(result.precedence.rule, 'nearest-to-root-wins');
  assert.equal(result.precedence.applied, false);
  assert.equal(result.precedence.resolved, undefined);
  const conflict = result.precedence.conflicts.find((entry) => entry.kind === 'agents');
  assert.ok(conflict);
  assert.equal(conflict.resolved, false);
  assert.equal(conflict.tie, false);
  const shallow = result.items.find((item) => item.path === 'AGENTS.md');
  const deep = result.items.find((item) => item.path === 'ded/AGENTS.md');
  assert.equal(conflict.winnerId, shallow.id);
  assert.notEqual(conflict.winnerId, deep.id);
  assert.deepEqual(conflict.candidates.map((candidate) => candidate.depth).sort(), [0, 1]);
  expectNoAbsolutePaths(result, root);

  // A single file of a kind yields no conflict, and no ranking is invented either.
  const solo = tempRoot(t, 'agentic-pre-solo-');
  writeFileSync(path.join(solo, 'AGENTS.md'), 'solo\n');
  const soloResult = createAgenticFileLibrary({ roots: [solo] }).list();
  assert.equal(soloResult.precedence.conflicts.length, 0);
});

test('coverage reports missing and non-directory roots without inventing files', (t) => {
  const root = tempRoot(t);
  writeFileSync(path.join(root, 'AGENTS.md'), 'real root\n');
  const missing = path.join(root, 'does-not-exist');
  const fileRoot = path.join(root, 'just-a-file.md');
  writeFileSync(fileRoot, 'not a directory\n');
  const lib = createAgenticFileLibrary({ roots: [{ path: root, id: 'good-root' }, { path: missing, id: 'missing-root' }, { path: fileRoot, id: 'file-root' }] });
  const result = lib.list();
  expectNoAbsolutePaths(result, root);
  assert.deepEqual(result.coverage.roots, [
    { id: 'good-root', untrusted: true, status: 'scanned', skipReason: null },
    { id: 'missing-root', untrusted: true, status: 'skipped', skipReason: 'root-missing' },
    { id: 'file-root', untrusted: true, status: 'skipped', skipReason: 'not-a-directory' },
  ]);
  assert.deepEqual(result.coverage.skipped.filter((entry) => entry.reason === 'root-missing').map((entry) => entry.path), ['.']);
  assert.equal(result.coverage.complete, false);
  assert.equal(result.coverage.reasons.includes('root-missing'), true);
  assert.equal(result.coverage.reasons.includes('not-a-directory'), true);
  assert.equal(result.coverage.matched, 1);
  assert.equal(result.items[0].path, 'AGENTS.md');
});

test('list validates filters and pagination, and never returns an absolute path', (t) => {
  const root = tempRoot(t);
  writeFileSync(path.join(root, 'AGENTS.md'), 'one\n');
  mkdirSync(path.join(root, 'docs', 'agents'), { recursive: true });
  writeFileSync(path.join(root, 'docs', 'agents', 'alpha.md'), 'two\n');
  writeFileSync(path.join(root, 'docs', 'agents', 'beta.md'), 'three\n');
  const lib = createAgenticFileLibrary({ roots: [root] });
  expect400(() => lib.list({ kind: 'not-a-kind' }));
  expect400(() => lib.list({ offset: -1 }));
  expect400(() => lib.list({ limit: 0 }));
  expect400(() => lib.list('bag-of-text'));
  const onlyDocs = lib.list({ kind: 'docs-agent' });
  assert.equal(onlyDocs.total, 2);
  assert.ok(onlyDocs.items.every((item) => item.kind === 'docs-agent'));
  const paged = lib.list({ kind: 'docs-agent', offset: 1, limit: 1 });
  assert.equal(paged.items.length, 1);
  assert.equal(paged.total, 2);
  assert.equal(paged.offset, 1);
  assert.equal(paged.nextOffset, null);
  const first = lib.list({ kind: 'docs-agent', offset: 0, limit: 1 });
  assert.equal(first.nextOffset, 1);
  expectNoAbsolutePaths(onlyDocs, root);
  expectNoAbsolutePaths(paged, root);
});

test('routes mount read-only GETs and keep error shape through the boundary', (t) => {
  const root = tempRoot(t);
  writeFileSync(path.join(root, 'AGENTS.md'), 'routed\n');
  const lib = createAgenticFileLibrary({ roots: [root] });
  const recorded = [];
  const add = (method, route, summary, handler) => recorded.push({ method, route, summary, handler });
  registerAgenticFileRoutes({ add, library: lib });
  assert.deepEqual(recorded.map((entry) => `${entry.method} ${entry.route}`).sort(), ['GET /agentic-files', 'GET /agentic-files/{id}']);
  for (const entry of recorded) assert.ok(typeof entry.summary === 'string' && entry.summary.length > 0);
  const listHandler = recorded.find((entry) => entry.route === '/agentic-files').handler;
  const getHandler = recorded.find((entry) => entry.route === '/agentic-files/{id}').handler;
  const listed = listHandler({ q: {} });
  assert.equal(listed.items.length, 1);
  const one = getHandler({ p: { id: listed.items[0].id } });
  assert.equal(one.path, 'AGENTS.md');
  assert.equal(one.content, 'routed\n');
  expect404(() => getHandler({ p: { id: 'f'.repeat(64) } }));
  expect400(() => getHandler({ p: { id: 'short' } }));
  expect400(() => listHandler({ q: { kind: 'nope' } }));
  // The routes never expose the temp root either.
  expectNoAbsolutePaths(listed, root);
  expectNoAbsolutePaths(one, root);

  assert.throws(() => registerAgenticFileRoutes({}), /add\(\) function/, 'without a router add');
  assert.throws(() => registerAgenticFileRoutes({ add: () => {} }), /library or explicit roots/, 'without library and without roots');
  // Explicit roots mint an internal library; the routes still stay mounted the same way.
  const recorded2 = [];
  registerAgenticFileRoutes({ add: (method, route, summary, handler) => recorded2.push({ method, route, summary, handler }), roots: [root] });
  assert.deepEqual(recorded2.map((entry) => entry.route), ['/agentic-files', '/agentic-files/{id}']);
  assert.equal(recorded2[0].handler({ q: {} }).items.length, 1);
});

test('empty roots produce an honest empty inventory and constructor failures are loud', (t) => {
  const lib = createAgenticFileLibrary({ roots: [] });
  const result = lib.list();
  assert.deepEqual(result.items, []);
  assert.equal(result.coverage.matched, 0);
  assert.equal(result.coverage.scanned, 0);
  assert.equal(result.coverage.truncated, false);
  assert.equal(result.coverage.complete, true);
  assert.equal(lib.list({ kind: 'agents' }).items.length, 0);
  assert.throws(() => createAgenticFileLibrary({}), /roots must be an explicit array/);
  assert.throws(() => createAgenticFileLibrary({ roots: ['relative/path'] }), /absolute path/);
  assert.throws(() => createAgenticFileLibrary({ roots: [{ path: 123 }] }), /absolute path/);
  assert.throws(() => createAgenticFileLibrary({ roots: [], limits: { notAKey: 1 } }), /not a known bound/);
  assert.throws(() => createAgenticFileLibrary({ roots: [], limits: { maxDepth: 99 } }), /between/);
  assert.throws(() => createAgenticFileLibrary({}), TypeError);
});
