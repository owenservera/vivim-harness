// selftest: fast local health check for this build (Node, module imports, data dir, Chrome, CDP,
// platform functions, Studio HTTP API, mirror route table).
import { existsSync, readdirSync, mkdtempSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { EXIT, TOOL_ROOT } from '../../src/config.mjs';
import { define } from '../lib/registry.mjs';
import { startStudio } from '../../src/studio/server.mjs';
import { chromeInstalls } from '../../src/chrome/launch.mjs';
import { discoveryProbe } from '../../src/cdp/discovery.mjs';
import { detectAndScan, csvAnalyze } from '../../src/intel/platform.mjs';
import { expandTerm } from '../../src/intel/rank.mjs';

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

const STUDIO_URL = new URL('../studio.mjs', import.meta.url);

// Every .mjs under src/ (minus the browser-only UI scripts) and every command module.
function collectModules() {
  const srcRoot = path.join(TOOL_ROOT, 'src');
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (path.relative(TOOL_ROOT, full).split(path.sep).join('/') === 'src/studio/ui') continue;
        walk(full);
        continue;
      }
      if (entry.name.endsWith('.mjs')) files.push(full);
    }
  };
  if (existsSync(srcRoot)) walk(srcRoot);
  const cmdDir = path.join(TOOL_ROOT, 'bin', 'commands');
  const commands = existsSync(cmdDir)
    ? readdirSync(cmdDir).filter((f) => f.endsWith('.mjs')).sort().map((f) => path.join(cmdDir, f))
    : [];
  return { src: files, commands };
}

// Import each module one by one so the first failing file is reported precisely.
async function importModules(mods) {
  const failures = [];
  for (const mod of mods) {
    try { await import(mod.url); }
    catch (e) { failures.push({ label: mod.label, error: String(e?.message ?? e).split('\n')[0] }); }
  }
  return failures;
}

// Some engine helpers (src/cdp/client.mjs sleep()) unref their timers, so a failing probe can let
// the event loop drain and Node exit silently mid-run. Keep one ref'd timer alive for the whole
// check sequence so every check actually reports.
async function withEventLoopAlive(fn) {
  const keepAlive = setInterval(() => {}, 250);
  try { return await fn(); } finally { clearInterval(keepAlive); }
}

// One HTTP GET against the local Studio, without keep-alive sockets.
function httpGet(port, urlPath, token, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1', port, path: urlPath, method: 'GET', agent: false,
      headers: token ? { 'x-studio-token': token } : {},
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let body = null;
        try { body = JSON.parse(text); } catch { body = null; }
        resolve({ status: res.statusCode ?? 0, body, text });
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout after ${timeoutMs} ms`)));
    req.on('error', (e) => resolve({ status: 0, body: null, text: '', error: String(e?.message ?? e) }));
    req.end();
  });
}

// ---------------------------------------------------------------------------------------------
define({
  name: 'selftest', section: 'System', summary: 'Run a local self-test of this build (Node, imports, data dir, Chrome, Studio API)',
  description: 'Runs a fixed list of checks in order and reports each one as {name, ok, ms, detail, severity}. Exits 0 when every required check passes, 1 otherwise. Informational checks never change the exit code.',
  flags: { 'no-studio': { type: 'boolean', desc: 'Skip the Studio HTTP API checks' } },
  examples: ['studio selftest', 'studio selftest --json', 'studio selftest --no-studio'],
  async run(ctx) {
    await withEventLoopAlive(() => runChecks(ctx));
  },
});

// The check sequence itself.
async function runChecks(ctx) {
  const checks = [];
  const record = (name, ok, ms, detail, severity) => { checks.push({ name, ok: !!ok, ms: Math.round(ms), detail: String(detail ?? ''), severity }); };
  const run = async (name, severity, fn) => {
    const started = Date.now();
    try {
      const detail = await fn();
      record(name, true, Date.now() - started, detail ?? 'ok', severity);
      return true;
    } catch (e) {
      record(name, false, Date.now() - started, String(e?.message ?? e), severity);
      return false;
    }
  };

  // (1) Node version.
  await run('node-version', 'required', async () => {
    const major = Number(process.versions.node.split('.')[0]);
    if (!(major >= 22)) throw new Error(`Node ${process.version} is older than the required Node 22.`);
    return `Node ${process.version}`;
  });

  // (2) Every module in the build imports cleanly.
  await run('module-imports', 'required', async () => {
    const { src, commands } = collectModules();
    const mods = [
      ...src.map((f) => ({ label: path.relative(TOOL_ROOT, f).split(path.sep).join('/'), url: pathToFileURL(f).href })),
      ...commands.map((f) => ({ label: path.relative(TOOL_ROOT, f).split(path.sep).join('/'), url: new URL(`./commands/${path.basename(f)}`, STUDIO_URL).href })),
    ];
    const failures = await importModules(mods);
    if (failures.length) throw new Error(`${failures.length}/${mods.length} module(s) failed to import; first: ${failures[0].label}: ${failures[0].error}`);
    return `${mods.length} module(s) imported`;
  });

  // (3) Data dir resolves and is writable.
  await run('data-dir', 'required', async () => {
    const root = ctx.paths.root;
    if (!existsSync(root)) throw new Error(`Data dir does not exist: ${root}`);
    const probe = path.join(root, `.selftest-${process.pid}-${Date.now()}.tmp`);
    try { writeFileSync(probe, 'ok'); }
    catch (e) { throw new Error(`Data dir is not writable (${root}): ${e.message}`); }
    finally { try { unlinkSync(probe); } catch { /* best effort */ } }
    return root;
  });

  // (4) Chrome install (informational).
  await run('chrome-install', 'info', async () => {
    const installs = chromeInstalls();
    if (!installs.length) throw new Error('No Chrome-family install found (set CHROME_PATH).');
    return installs.join(', ');
  });

  // (5) DevTools endpoint on the configured port (informational).
  await run('cdp-endpoint', 'info', async () => {
    const probe = await discoveryProbe({ port: ctx.port });
    if (!probe.reachable) throw new Error(`127.0.0.1:${ctx.port} not reachable${probe.error ? ` (${probe.error})` : ''}`);
    return `127.0.0.1:${ctx.port} ${probe.browser ?? 'unknown'} in ${probe.latencyMs} ms`;
  });

  // (6) Platform function smoke test.
  await run('platform-functions', 'required', async () => {
    const detected = await detectAndScan('a,b\n1,2\n');
    if (!detected || typeof detected !== 'object') throw new Error('detectAndScan did not return an object.');
    if (!Array.isArray(detected.candidates) || !detected.candidates.length) throw new Error('detectAndScan returned no candidates.');
    const csv = await csvAnalyze('x,y\n1,2\n');
    if (!csv || typeof csv !== 'object') throw new Error('csvAnalyze did not return an object.');
    if (!Array.isArray(csv.header) || !csv.header.length) throw new Error('csvAnalyze returned no header columns.');
    if (!(Number(csv.stats?.rows) >= 1)) throw new Error('csvAnalyze reported no rows.');
    const expanded = expandTerm('tickt', ['ticket']);
    if (!Array.isArray(expanded) || !expanded.length) throw new Error('expandTerm returned no candidates.');
    if (!expanded.some((h) => h?.term === 'ticket')) throw new Error('expandTerm did not match "ticket" for "tickt".');
    return `detect=${detected.format}, csv rows=${csv.stats.rows}, expandTerm=${expanded.length} hit(s)`;
  });

  // (7) Studio HTTP API.
  if (!ctx.flags['no-studio']) {
    let studio = null;
    let token = null;
    let port = null;
    try {
      const startedOk = await run('studio-start', 'required', async () => {
        token = randomBytes(18).toString('base64url');
        studio = await startStudio({
          paths: ctx.paths, profileStore: ctx.profiles(), familyStore: ctx.families(),
          cdpPort: ctx.port, port: 0, token,
        });
        port = studio.port;
        return `Studio listening on 127.0.0.1:${port}`;
      });

      if (startedOk) {
        await run('studio-stats', 'required', async () => {
          const res = await httpGet(port, '/api/x/stats', token);
          if (res.status !== 200) throw new Error(`GET /api/x/stats -> HTTP ${res.status}${res.error ? ` (${res.error})` : ''}`);
          if (res.body?.schema !== 'capture-studio.platform-stats/1') throw new Error(`unexpected schema key: ${JSON.stringify(res.body?.schema)}`);
          return `schema=${res.body.schema}, sessions=${res.body.sessions}`;
        });
        await run('studio-registry', 'required', async () => {
          const res = await httpGet(port, '/api/x/registry', token);
          if (res.status !== 200) throw new Error(`GET /api/x/registry -> HTTP ${res.status}${res.error ? ` (${res.error})` : ''}`);
          if (!res.body || typeof res.body.kinds !== 'object') throw new Error('response has no "kinds" object.');
          return `${Object.keys(res.body.kinds).length} kind(s)`;
        });
        await run('studio-openapi', 'required', async () => {
          const res = await httpGet(port, '/api/v1/openapi.json', token);
          if (res.status !== 200) throw new Error(`GET /api/v1/openapi.json -> HTTP ${res.status}${res.error ? ` (${res.error})` : ''}`);
          if (typeof res.body?.openapi !== 'string' || !res.body.paths) throw new Error('response is not an OpenAPI document.');
          return `openapi=${res.body.openapi}, ${Object.keys(res.body.paths).length} path(s)`;
        });
        await run('studio-page', 'info', async () => {
          const res = await httpGet(port, '/platform', token);
          if (res.status === 404) throw new Error('GET /platform -> HTTP 404 (page not present in this build).');
          if (res.status !== 200) throw new Error(`GET /platform -> HTTP ${res.status}${res.error ? ` (${res.error})` : ''}`);
          return 'GET /platform -> 200';
        });
      }
    } finally {
      if (studio) {
        const started = Date.now();
        let detail = 'Studio stopped';
        let ok = true;
        try {
          await studio.close();
          try { studio.server?.closeAllConnections?.(); } catch { /* optional */ }
        } catch (e) { ok = false; detail = `Studio close failed: ${e?.message ?? e}`; }
        record('studio-stop', ok, Date.now() - started, detail, 'required');
      }
    }
  }

  // (8) Mirror route table over an empty session (informational).
  await run('mirror-route-table', 'info', async () => {
    const { buildRouteTable } = await import('../../src/mirror/index.mjs');
    const dir = mkdtempSync(path.join(os.tmpdir(), 'studio-selftest-mirror-'));
    try {
      writeFileSync(path.join(dir, 'session.json'), JSON.stringify({ id: 'selftest-empty', site: 'selftest' }));
      const table = buildRouteTable(dir);
      if (!Array.isArray(table)) throw new Error('buildRouteTable did not return an array.');
      return `${table.length} route(s) from an empty session`;
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  const required = checks.filter((c) => c.severity === 'required');
  const failed = required.filter((c) => !c.ok);
  const ok = failed.length === 0;
  const payload = {
    ok,
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    requiredFailed: failed.length,
    checks,
  };

  ctx.out.emit(payload, (o) => {
    const mark = { true: o.c.green('ok  '), false: o.c.red('FAIL') };
    o.table(checks.map((c) => ({ ...c, result: c.ok ? 'ok' : 'FAIL' })), [
      { title: 'CHECK', key: 'name', max: 22 },
      { title: 'RESULT', get: (r) => mark[r.ok] },
      { title: 'MS', get: (r) => String(r.ms), align: 'right' },
      { title: 'SEVERITY', key: 'severity', max: 9 },
      { title: 'DETAIL', get: (r) => r.detail, max: 90 },
    ]);
    o.line('');
    o.result(ok
      ? `Self-test passed: ${required.length} required check(s), ${checks.length - required.length} informational.`
      : `Self-test failed: ${failed.length} of ${required.length} required check(s) failed — ${failed.map((c) => c.name).join(', ')}.`);
  });

  if (!ok) process.exitCode = EXIT.ERROR;
}
