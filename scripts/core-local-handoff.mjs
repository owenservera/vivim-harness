#!/usr/bin/env node
// CORE L0/L1 Windows integration probe. Local evidence only, zero dependencies.
// L0: isolated CLI, doctor and loopback UI/API. L1: existing synthetic live-e2e.
// No real provider sends, no owner's Chrome profile, no automatic GitHub upload.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultDataDir } from '../src/config.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const round = String(process.argv[2] || 'l0').toLowerCase();
const flag = process.argv.indexOf('--out');
if (!['l0', 'l1'].includes(round) || (flag >= 0 && !process.argv[flag + 1])) {
  console.error('Usage: node scripts/core-local-handoff.mjs l0|l1 [--out DIR]');
  process.exit(2);
}
const runId = 'core-' + new Date().toISOString().replace(/\W/g, '').slice(0, 15) + '-' + randomUUID().slice(0, 8);
const out = path.resolve(flag >= 0 ? process.argv[flag + 1]
  : path.join(defaultDataDir(), 'integration-runs', runId, 'round-' + round.toUpperCase()));
function repositoryRoot(start) {
  for (let dir = start; ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    if (path.dirname(dir) === dir) return start;
  }
}
const repoRoot = repositoryRoot(root);
const rel = path.relative(repoRoot, out);
if (rel === '' || !(rel === '..' || rel.startsWith('..' + path.sep))) {
  console.error('Use an evidence directory outside the Git repository (not just outside Capture Studio).');
  process.exit(2);
}
const priv = path.join(out, 'private'), shareable = path.join(out, 'shareable');
fs.mkdirSync(priv, { recursive: true });
fs.mkdirSync(shareable, { recursive: true });
const env = { ...process.env, CAPTURE_STUDIO_HOME: path.join(priv, 'diagnostic-home'),
  CAPTURE_STUDIO_ACCESS_MODE: 'local', CAPTURE_STUDIO_CAPTURE_MODE: 'local-raw', NO_COLOR: '1' };
const begun = new Date().toISOString(), steps = [], failures = [];
const metrics = { passed: 0, failed: 0, skipped: 0, partial: 0, uiHttpStatus: null, apiHttpStatus: null,
  synthetic: null, externalSendAttempts: 0, provenExternalSends: 0,
  cpuMs: null, peakRssBytes: null };
let sha = null, dirtyCount = null, collectorSha = null;
const now = () => new Date().toISOString();
const maybeJson = (s) => { try { return JSON.parse(s.trim()); } catch { return null; } };

function step(id, action, status, started, durationMs, facts = {}) {
  const field = { PASS: 'passed', FAIL: 'failed', SKIP: 'skipped', PARTIAL: 'partial' }[status];
  metrics[field]++;
  const evidence = runId + '/' + round.toUpperCase() + '/' + id;
  steps.push({ step_id: id, action, started_at: started, ended_at: now(), result: status,
    evidence_ref: evidence, effect_class: round === 'l0' ? 'local-read-only' : 'synthetic-only',
    known: status === 'PASS' || status === 'FAIL', duration_ms: durationMs, ...facts });
  if (status === 'FAIL') failures.push({ signature: round.toUpperCase() + ':' + id,
    component: id, expected: 'PASS', observed: status, minimal_repro: action,
    suspected_owner: 'CORE (untriaged)', confidence: 'unknown', source_sha: sha,
    evidence_refs: [evidence] });
}

function run(program, args, id, timeoutMs = 60000) {
  const start = Date.now();
  return new Promise((resolve) => {
    let stdout = '', stderr = '', complete = false, child, timer;
    // Full byte streams land locally; only the parser's in-memory tail is
    // bounded. Never silently truncate diagnostic evidence on disk.
    const stdoutFd = fs.openSync(path.join(priv, id + '.stdout.txt'), 'w');
    const stderrFd = fs.openSync(path.join(priv, id + '.stderr.txt'), 'w');
    const capture = (fd, chunk, channel) => {
      fs.writeSync(fd, chunk);
      const value = chunk.toString('utf8');
      if (channel === 'stdout') stdout = (stdout + value).slice(-1048576);
      else stderr = (stderr + value).slice(-1048576);
    };
    const finish = (exitCode, reason = null) => {
      if (complete) return;
      complete = true;
      clearTimeout(timer);
      fs.closeSync(stdoutFd);
      fs.closeSync(stderrFd);
      resolve({ code: exitCode, stdout, stderr, reason, durationMs: Date.now() - start });
    };
    try {
      child = spawn(program, args, { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.on('data', (chunk) => capture(stdoutFd, chunk, 'stdout'));
      child.stderr.on('data', (chunk) => capture(stderrFd, chunk, 'stderr'));
      child.on('error', (e) => { stderr += String(e); finish(-1, 'SPAWN_FAILED'); });
      child.on('close', (code) => finish(code ?? -1));
      timer = setTimeout(() => { try { child.kill(); } catch {} finish(-1, 'TIMEOUT'); }, timeoutMs);
    } catch (e) { stderr += String(e); finish(-1, 'SPAWN_FAILED'); }
  });
}
async function check(id, action, program, args, statusOf = (r) => r.code === 0 ? 'PASS' : 'FAIL', timeout) {
  const started = now(), r = await run(program, args, id, timeout);
  step(id, action, statusOf(r), started, r.durationMs,
    { exit_code: r.code, ...(r.reason ? { reason: r.reason } : {}) });
  return r;
}
async function gitInfo() {
  const r = await check('git-head', 'git rev-parse HEAD', 'git', ['rev-parse', 'HEAD']);
  sha = /^[0-9a-f]{40}$/.test(r.stdout.trim()) ? r.stdout.trim() : null;
  const status = await check('git-dirty', 'git status --porcelain', 'git', ['status', '--porcelain']);
  dirtyCount = status.code === 0 ? status.stdout.trim().split(/\r?\n/).filter(Boolean).length : null;
}
async function probeLoopback() {
  const started = now(), start = Date.now();
  let child, stdout = '', stderr = '', stopped = false, ui = null, api = null;
  try {
    child = spawn(process.execPath, ['bin/studio.mjs', 'serve', '--studio-port', '0',
      '--no-open', '--json'], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
    child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
    child.on('close', () => { stopped = true; });
    child.on('error', (e) => { stopped = true; stderr += String(e); });
    let info = null;
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline && !stopped) {
      info = maybeJson(stdout);
      if (Number.isInteger(info?.port) && info.port > 0) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!Number.isInteger(info?.port) || info.port < 1) throw Error('STUDIO_DID_NOT_START');
    const base = 'http://127.0.0.1:' + info.port;
    const get = async (url) => { const r = await fetch(base + url, { signal: AbortSignal.timeout(7000) }); await r.arrayBuffer(); return r.status; };
    ui = await get('/');
    api = await get('/api/status');
    metrics.uiHttpStatus = ui; metrics.apiHttpStatus = api;
    step('studio-loopback', 'serve --studio-port 0 --no-open; GET / and /api/status',
      ui === 200 && api === 200 ? 'PASS' : 'FAIL', started, Date.now() - start,
      { ui_http_status: ui, api_http_status: api });
  } catch (e) {
    step('studio-loopback', 'serve --studio-port 0 --no-open; GET / and /api/status',
      'FAIL', started, Date.now() - start, { reason: 'START_OR_HTTP_FAILED' });
    stderr += '\n' + String(e);
  } finally {
    if (child && !stopped) { try { child.kill(); } catch {} }
    fs.writeFileSync(path.join(priv, 'studio-loopback.stdout.txt'), stdout);
    fs.writeFileSync(path.join(priv, 'studio-loopback.stderr.txt'), stderr);
  }
}
async function l0() {
  await gitInfo();
  await check('cli-help', 'node bin/studio.mjs help', process.execPath, ['bin/studio.mjs', 'help']);
  const version = await check('cli-version', 'node bin/studio.mjs version --json', process.execPath,
    ['bin/studio.mjs', 'version', '--json']);
  collectorSha = maybeJson(version.stdout)?.collectorSourceSha ?? null;
  await check('cli-paths', 'studio paths --json [isolated]', process.execPath,
    ['bin/studio.mjs', 'paths', '--json']);
  const doctor = await check('doctor', 'studio doctor --json [isolated]', process.execPath,
    ['bin/studio.mjs', 'doctor', '--json'], (r) => {
      const result = maybeJson(r.stdout);
      if (!Array.isArray(result?.checks)) return 'FAIL';
      const fails = result.checks.filter((c) => c.level === 'fail' && c.name !== 'chrome');
      const chrome = result.checks.find((c) => c.name === 'chrome');
      metrics.doctor = { checks: result.checks.map((c) => ({ name: c.name, level: c.level })) };
      return fails.length ? 'FAIL' : chrome?.level === 'ok' ? 'PASS' : 'PARTIAL';
    });
  await check('sessions', 'studio session list --json [isolated]', process.execPath,
    ['bin/studio.mjs', 'session', 'list', '--json']);
  await probeLoopback();
}
async function l1() {
  await gitInfo();
  const started = now();
  const r = await run(process.execPath, ['scripts/live-e2e.mjs', '--keep'], 'synthetic-e2e', 900000);
  const match = r.stdout.match(/result written to ([^\r\n]+live-e2e-result\.json)/);
  let fixture = null;
  if (match && fs.existsSync(match[1].trim())) {
    try { fixture = JSON.parse(fs.readFileSync(match[1].trim(), 'utf8')); } catch {}
  }
  if (!Array.isArray(fixture?.steps)) {
    step('fixture-result', 'node scripts/live-e2e.mjs --keep', 'FAIL', started, r.durationMs,
      { reason: 'RESULT_NOT_FOUND', exit_code: r.code });
    return;
  }
  metrics.synthetic = { ...fixture.counts, data_retained_locally: true };
  fixture.steps.forEach((s, i) => {
    const result = ['PASS', 'FAIL', 'SKIP'].includes(s.status) ? s.status : 'PARTIAL';
    step('fixture-' + (i + 1), 'synthetic: ' + String(s.name ?? 'unnamed').slice(0, 100),
      result, started, s.ms ?? null);
  });
  if (r.code !== 0 && !(fixture.counts?.fail > 0)) step('fixture-exit',
    'node scripts/live-e2e.mjs --keep', 'FAIL', started, r.durationMs,
    { reason: 'NONZERO_RUNNER_EXIT', exit_code: r.code });
}
try { if (round === 'l0') await l0(); else await l1(); }
catch (e) {
  step('runner-error', 'CORE handoff runner', 'FAIL', now(), null, { reason: 'RUNNER_EXCEPTION' });
  fs.writeFileSync(path.join(priv, 'runner-error.txt'), String(e?.stack ?? e));
} finally {
  const overall = metrics.failed ? 'FAIL' : (metrics.partial || metrics.skipped) ? 'PARTIAL' : 'PASS';
  const runInfo = {
    schema: 'aion.capture-studio.local-round/1', run_id: runId, round: round.toUpperCase(),
    started_at: begun, ended_at: now(), status: overall, source_sha: sha,
    dirty_count: dirtyCount, node_version: process.version, platform: process.platform,
    machine_label: 'owner-local', capture_mode: 'local-raw', access_mode: 'local',
    collector_source_sha: collectorSha, no_real_provider_sends: true,
    fixture: round === 'l1' ? 'built-in-live-e2e' : null,
  };
  const jsonl = (items) => items.map((x) => JSON.stringify(x)).join('\n') + (items.length ? '\n' : '');
  const summary = '# CORE ' + round.toUpperCase() + ' integration run\n\n**Status:** ' + overall +
    '\n**SHA:** ' + (sha || 'unknown') + '\n**Checks:** ' + metrics.passed + ' pass; ' +
    metrics.failed + ' fail; ' + metrics.skipped + ' skip; ' + metrics.partial +
    ' partial\n\nPrivate evidence stays on this PC; review shareable/ before distributing. ' +
    'This is not L2 real-send or native Windows QA acceptance until actually run locally.\n';
  for (const dir of [out, shareable]) {
    fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify(runInfo, null, 2) + '\n');
    fs.writeFileSync(path.join(dir, 'metrics.json'), JSON.stringify(metrics, null, 2) + '\n');
    fs.writeFileSync(path.join(dir, 'steps.jsonl'), jsonl(steps));
    fs.writeFileSync(path.join(dir, 'failures.jsonl'), jsonl(failures));
    fs.writeFileSync(path.join(dir, 'summary.md'), summary);
  }
  console.log('CORE ' + round.toUpperCase() + ': ' + overall + ' @ ' + (sha?.slice(0, 12) || 'unknown'));
  console.log('Evidence: ' + out);
  console.log('Sanitized (review before sharing): ' + shareable);
  if (overall === 'FAIL') process.exitCode = 1;
}
