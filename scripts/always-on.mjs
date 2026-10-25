#!/usr/bin/env node
// always-on.mjs — supervise `studio record` so capture keeps running, restarting after crashes
// and rotating sessions so no single recording grows forever.
//
// Zero-dependency ESM (Node 22+). Facts this file depends on, verified in the tree:
//
//   * `record` and its real flags live in bin/commands/capture.mjs:77-94 (recordFlags).
//     `--tabs` is a string with choices all|one (capture.mjs:81), `--follow` is a boolean
//     (capture.mjs:82), `--duration SECONDS` (capture.mjs:86) is wired to a stop timer at
//     capture.mjs:193, and `--max-mb MB` (capture.mjs:89) becomes maxSessionBytes at
//     capture.mjs:130, which the recorder enforces as a clean `quota_reached` stop
//     (src/capture/recorder.mjs:499). So duration-based rotation is genuinely supported.
//   * `record` is ATTACH-ONLY: Recorder.start calls browserVersion({port})
//     (src/capture/recorder.mjs:77) and never launches Chrome. This script therefore does
//     NOT pass --no-launch (that flag exists only on `capture`, capture.mjs:250/259, not on
//     `record`). Launching the dedicated browser is done by the `launch` command
//     (capture.mjs:29-32, via ensureChrome/launchChrome in src/chrome/launch.mjs:35-77) and
//     lazily by `capture` (capture.mjs:258-263). Consequence, stated plainly: a cycle with no
//     browser serving DevTools on the port fails fast and is retried with backoff — run
//     `node bin/studio.mjs launch` once (or start the studio) before leaving this running.
//   * Data dir: CAPTURE_STUDIO_HOME (src/config.mjs:12), paths from dataPaths()
//     (src/config.mjs:18). DevTools port: setting `cdpPort`, env CAPTURE_STUDIO_CDP_PORT,
//     default 9222 (src/config.mjs:78). The port default here is read from resolveSettings(),
//     never invented.
//   * Global `--data-dir` and `--port` flags are accepted after the subcommand
//     (bin/lib/registry.mjs:7-10, parsed over the whole argv in bin/studio.mjs:55-56).
//   * With --json, `record` writes exactly one pretty-printed JSON object to stdout whose
//     `id` is the session id (bin/lib/ui.mjs:70-73, summarizeRecording capture.mjs:96-107);
//     progress/warnings go to stderr. The session id is therefore recovered by parsing the
//     accumulated stdout at exit, not per line.
//
// Usage: node scripts/always-on.mjs [--tabs all|one] [--rotate-min N] [--max-mb N] [--port N]
//        [--chrome-profile DIR] [--ensure-chrome|--no-ensure-chrome] [--data-dir DIR]
//        [--status] [--stop] [--json] [--once] [--dry-run]
// --once runs one cycle and exits with the child's exit code; it writes no state file.
// --dry-run prints the resolved settings and the exact argv it would use, then exits 0.
//
// Stopping: the recorder is asked to stop over its IPC channel ({type:'stop'}), because on Windows
// a SIGINT sent to a child kills it before its finalize code runs (that left sessions stuck at
// "recording" with an unfinalized raw segment). bin/studio.mjs turns that message into the same
// SIGINT event Ctrl+C produces. Only if the child ignores the request for 30 s is it force-killed.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataPaths, defaultDataDir, resolveSettings } from '../src/config.mjs';
import { isReachable } from '../src/cdp/discovery.mjs';
import { findChrome } from '../src/chrome/launch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STUDIO = path.join(ROOT, 'bin', 'studio.mjs');
const LOG_MAX_BYTES = 5 * 1024 * 1024;
const BACKOFF_MS = [2000, 4000, 8000, 16000, 32000, 60000]; // capped at 60 s, never gives up
const SHORT_CYCLE_MS = 60_000;
const STOP_WAIT_MS = 20_000;
const GRACEFUL_STOP_MS = 30_000; // how long an IPC-stopped recorder gets to finalize
const CHROME_READY_MS = 25_000;   // how long a freshly launched Chrome gets to answer /json/version
const WARN_EVERY = 10;

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------
function usage(msg) {
  if (msg) process.stderr.write(`always-on: ${msg}\n`);
  process.stderr.write('usage: node scripts/always-on.mjs [--tabs all|one] [--rotate-min N] [--max-mb N] [--port N] [--chrome-profile DIR] [--ensure-chrome|--no-ensure-chrome] [--data-dir DIR] [--status] [--stop] [--json] [--once] [--dry-run]\n');
  process.exit(2);
}

function parseArgs(argv) {
  const o = { status: false, stop: false, json: false, once: false, dryRun: false, ensureChrome: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.startsWith('--') && a.includes('=') ? a.indexOf('=') : -1;
    const name = eq > 0 ? a.slice(0, eq) : a;
    const inline = eq > 0 ? a.slice(eq + 1) : null;
    const value = () => (inline !== null ? inline : argv[++i]);
    switch (name) {
      case '--tabs': o.tabs = value(); break;
      case '--rotate-min': o.rotateMin = value(); break;
      case '--max-mb': o.maxMb = value(); break;
      case '--port': o.port = value(); break;
      case '--data-dir': o.dataDir = value(); break;
      case '--chrome-profile': {
        const v = value();
        if (v === undefined || String(v).trim() === '') usage('--chrome-profile expects a directory');
        o.chromeProfile = v;
        break;
      }
      case '--ensure-chrome': o.ensureChrome = true; break;
      case '--no-ensure-chrome': o.ensureChrome = false; break;
      case '--status': o.status = true; break;
      case '--stop': o.stop = true; break;
      case '--json': o.json = true; break;
      case '--once': o.once = true; break;
      case '--dry-run': o.dryRun = true; break;
      case '--help': case '-h': usage(); break;
      default: usage(`unknown argument "${a}"`);
    }
  }
  if (o.tabs !== undefined && !['all', 'one'].includes(o.tabs)) usage('--tabs must be all or one');
  if (o.chromeProfile !== undefined && String(o.chromeProfile).trim() === '') usage('--chrome-profile expects a directory');
  const num = (v, label, min) => {
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isFinite(n) || n < min) usage(`--${label} expects a number >= ${min}`);
    return n;
  };
  o.rotateMin = num(o.rotateMin, 'rotate-min', 1) ?? 60;
  o.maxMb = num(o.maxMb, 'max-mb', 1) ?? 512;
  o.port = num(o.port, 'port', 1) ?? null;
  o.tabs = o.tabs ?? 'all';
  return o;
}

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g;
const stripAnsi = (s) => String(s).replace(ANSI, '');
const now = () => new Date().toISOString();

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function killTree(pid, { force = true } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (process.platform === 'win32') {
    const r = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    return r.status === 0;
  }
  try { process.kill(pid, force ? 'SIGKILL' : 'SIGTERM'); return true; } catch { return false; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitDead(pid, timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (!pidAlive(pid)) return true;
    await sleep(250);
  }
  return !pidAlive(pid);
}

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

function writeJsonAtomic(file, value) {
  writeFileSync(`${file}.tmp`, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(`${file}.tmp`, file);
}

// ---------------------------------------------------------------------------------------------
// Logger: one line per event, appended, rotated at startup when over 5 MB.
// ---------------------------------------------------------------------------------------------
function makeLogger(file) {
  let fd = openSync(file, 'a');
  const write = (text) => {
    try { writeFileSync(fd, text); } catch { /* logging must never kill the supervisor */ }
  };
  return {
    file,
    line(kind, message) {
      const body = stripAnsi(message).replace(/\r/g, '').replace(/\n+$/, '');
      if (body === '') return;
      write(`[${now()}] ${kind} ${body}\n`);
    },
    close() { try { closeSync(fd); } catch { /* already closed */ } },
  };
}

function rotateLog(file) {
  try {
    if (existsSync(file) && statSync(file).size > LOG_MAX_BYTES) {
      const prev = `${file}.1`;
      if (existsSync(prev)) unlinkSync(prev);
      renameSync(file, prev);
    }
  } catch { /* a failed rotation is not fatal */ }
}

// ---------------------------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------------------------
// PowerShell passes "%LOCALAPPDATA%\chrome-cdp-profile" through verbatim, so expand %VAR% here.
function expandEnv(value) {
  if (typeof value !== 'string') return value;
  return value.replace(/%([^%]+)%/g, (m, name) => process.env[name] ?? process.env[name.toUpperCase()] ?? m);
}

function setup(argv) {
  const o = parseArgs(argv);
  const dataDir = o.dataDir ? path.resolve(o.dataDir) : defaultDataDir();
  const paths = dataPaths(dataDir);
  const settings = resolveSettings({ configFile: paths.config }).settings;
  const port = o.port ?? settings.cdpPort; // config.mjs:78 — no invented default
  mkdirSync(dataDir, { recursive: true });
  const stateFile = path.join(dataDir, 'always-on.json');
  const logFile = path.join(dataDir, 'always-on.log');
  const stopFile = path.join(dataDir, 'always-on.stop');
  const chromeProfile = o.chromeProfile ? path.resolve(expandEnv(o.chromeProfile)) : null;
  // Ensure-chrome defaults to ON exactly when a profile is given: with no profile there is no
  // dedicated browser to start, and launching an arbitrary one is not this script's business.
  const ensureChrome = o.ensureChrome ?? Boolean(chromeProfile);
  return { ...o, dataDir, paths, port, stateFile, logFile, stopFile, chromeProfile, ensureChrome };
}

// The exact recorder argv, used both to spawn and to print in --dry-run.
function recorderArgs(cfg) {
  return [
    STUDIO, 'record',
    '--tabs', cfg.tabs,
    '--follow',
    '--duration', String(Math.round(cfg.rotateMin * 60)),
    '--max-mb', String(cfg.maxMb),
    '--json',
    '--data-dir', cfg.dataDir,
    '--port', String(cfg.port),
  ];
}

// The exact Chrome argv used when a browser has to be started (also printed by --dry-run).
function chromeArgs(port, profileDir) {
  return [
    `--remote-debugging-port=${port}`,
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--restore-last-session',
  ];
}

const quoteArg = (a) => (String(a).includes(' ') ? `"${a}"` : String(a));
const formatCmd = (exe, args) => [quoteArg(exe), ...args.map(quoteArg)].join(' ');

// ---------------------------------------------------------------------------------------------
// --status
// ---------------------------------------------------------------------------------------------
function cmdStatus(cfg) {
  const state = readJson(cfg.stateFile);
  if (!state) {
    if (cfg.json) console.log(JSON.stringify({ running: false, stateFile: cfg.stateFile }, null, 2));
    else console.log(`not running (no state file at ${cfg.stateFile})`);
    return 0;
  }
  const supervisorAlive = pidAlive(state.pid);
  const childAlive = pidAlive(state.childPid);
  const running = supervisorAlive || childAlive;
  if (cfg.json) {
    console.log(JSON.stringify({ running, supervisorAlive, childAlive, ...state }, null, 2));
    return 0;
  }
  console.log(`state file: ${cfg.stateFile}`);
  console.log(`supervisor: pid ${state.pid} ${supervisorAlive ? 'alive' : 'dead'} (started ${state.startedAt})`);
  console.log(`recorder:   pid ${state.childPid ?? '-'} ${childAlive ? 'alive' : 'dead'} (started ${state.childStartedAt ?? '-'})`);
  console.log(`settings:   port ${state.port}, tabs ${state.tabs}, rotate ${state.rotateMin}m, max ${state.maxMb}MB`);
  console.log(`cycles:     ${state.cycles} (restarts ${state.restarts})`);
  console.log(`log:        ${state.logFile}`);
  console.log(running ? 'status: running' : 'status: not running (stale state file)');
  return 0;
}

// ---------------------------------------------------------------------------------------------
// Browser guarantee: probe the DevTools port, start the dedicated Chrome only if nothing answers.
// A browser that is already serving the port is never touched (no restart, no kill, no re-profile).
// ---------------------------------------------------------------------------------------------
async function ensureBrowser(cfg, say) {
  if (await isReachable({ port: cfg.port })) {
    say('info', `DevTools reachable on 127.0.0.1:${cfg.port}; leaving the running browser alone`);
    return { reachable: true, launched: false };
  }
  if (!cfg.ensureChrome) {
    say('warn', `DevTools unreachable on 127.0.0.1:${cfg.port} and ensure-chrome is off; not launching a browser`);
    return { reachable: false, launched: false };
  }
  if (!cfg.chromeProfile) {
    say('warn', 'DevTools unreachable and no --chrome-profile given; no browser to start');
    return { reachable: false, launched: false };
  }
  try { mkdirSync(cfg.chromeProfile, { recursive: true }); }
  catch (e) { say('err', `cannot create chrome profile "${cfg.chromeProfile}": ${e.message}`); return { reachable: false, launched: false }; }
  let exe;
  try { exe = findChrome(); } catch (e) { say('err', e.message); return { reachable: false, launched: false }; }
  const args = chromeArgs(cfg.port, cfg.chromeProfile);
  say('info', `chrome start: ${formatCmd(exe, args)}`);
  const startedAt = Date.now();
  let child;
  try {
    child = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: false });
  } catch (e) {
    say('err', `chrome spawn failed: ${e.message}`);
    return { reachable: false, launched: false };
  }
  child.on('error', (e) => say('err', `chrome spawn error: ${e.message}`));
  child.unref();
  const until = Date.now() + CHROME_READY_MS;
  while (Date.now() < until) {
    if (await isReachable({ port: cfg.port })) {
      say('info', `chrome pid ${child.pid} serving 127.0.0.1:${cfg.port} after ${Math.round((Date.now() - startedAt) / 1000)}s`);
      return { reachable: true, launched: true };
    }
    await sleep(250);
  }
  say('warn', `chrome pid ${child.pid} did not answer 127.0.0.1:${cfg.port}/json/version within ${CHROME_READY_MS / 1000}s; the recorder will retry with backoff`);
  return { reachable: false, launched: true };
}

// ---------------------------------------------------------------------------------------------
// --dry-run: print exactly what would happen, spawn nothing
// ---------------------------------------------------------------------------------------------
function cmdDryRun(cfg) {
  let exe = '(none: chrome only starts if the port is unreachable)';
  if (cfg.ensureChrome && cfg.chromeProfile) {
    try { exe = findChrome(); } catch (e) { exe = `(not found: ${e.message})`; }
  }
  const lines = [
    `data dir:        ${cfg.dataDir}`,
    `port:            ${cfg.port}`,
    `tabs:            ${cfg.tabs}`,
    `rotate:          ${cfg.rotateMin}m`,
    `max session:     ${cfg.maxMb}MB`,
    `ensure chrome:   ${cfg.ensureChrome ? 'on' : 'off'}`,
    `chrome profile:  ${cfg.chromeProfile ?? '(none)'}`,
    `state file:      ${cfg.stateFile}`,
    `log file:        ${cfg.logFile}`,
    '',
    `recorder argv:   ${formatCmd(process.execPath, recorderArgs(cfg))}`,
  ];
  if (cfg.ensureChrome && cfg.chromeProfile) lines.push(`chrome argv:     ${formatCmd(exe, chromeArgs(cfg.port, cfg.chromeProfile))}`);
  else lines.push('chrome argv:     (skipped: ensure-chrome is off or no --chrome-profile)');
  console.log(lines.join('\n'));
  return 0;
}

// ---------------------------------------------------------------------------------------------
// --stop  (the supervisor owns the recorder's IPC channel, so it finalizes the session)
// ---------------------------------------------------------------------------------------------
async function cmdStop(cfg) {
  const state = readJson(cfg.stateFile);
  if (!state) {
    console.log('nothing is running (no state file)');
    return 0;
  }
  const log = makeLogger(cfg.logFile);
  const childAlive = pidAlive(state.childPid);
  const supervisorAlive = pidAlive(state.pid);
  if (!childAlive && !supervisorAlive) {
    log.line('info', 'stop requested but nothing is alive; removing stale state');
    log.close();
    try { unlinkSync(cfg.stateFile); } catch { /* already gone */ }
    console.log('nothing is running (removed stale state file)');
    return 0;
  }
  console.log(`stopping supervisor pid ${state.pid} and recorder pid ${state.childPid ?? '-'} (graceful)`);
  log.line('info', `stop requested (child ${state.childPid ?? '-'}, supervisor ${state.pid})`);

  if (supervisorAlive) {
    try { writeFileSync(cfg.stopFile, `${now()} stop requested by pid ${process.pid}\n`); }
    catch (e) { log.line('warn', `could not write ${cfg.stopFile}: ${e.message}`); }
    log.line('info', `graceful stop request written to ${cfg.stopFile}; waiting up to ${(GRACEFUL_STOP_MS + 5000) / 1000}s for supervisor pid ${state.pid}`);
    if (await waitDead(state.pid, GRACEFUL_STOP_MS + 5000)) {
      log.line('info', `supervisor pid ${state.pid} exited after the graceful stop request`);
    } else {
      log.line('warn', `supervisor pid ${state.pid} ignored the stop request for ${(GRACEFUL_STOP_MS + 5000) / 1000}s; forcing tree kill`);
      killTree(state.pid, { force: true });
      await waitDead(state.pid, 5000);
    }
  } else {
    log.line('warn', `supervisor pid ${state.pid} is dead; only recorder pid ${state.childPid ?? '-'} can be handled`);
  }

  if (pidAlive(state.childPid)) {
    log.line('warn', `recorder pid ${state.childPid} survived the supervisor; forcing tree kill (its session may stay unfinalized)`);
    killTree(state.childPid, { force: true });
    await waitDead(state.childPid, 5000);
  }

  try { unlinkSync(cfg.stopFile); } catch { /* already gone */ }
  try { unlinkSync(cfg.stateFile); } catch { /* already gone */ }
  log.line('info', 'stopped; state file removed');
  log.close();
  console.log('stopped');
  return 0;
}

// ---------------------------------------------------------------------------------------------
// One recording cycle
// ---------------------------------------------------------------------------------------------
function runCycle(cfg, log, onChild) {
  const args = recorderArgs(cfg);
  const startedAt = Date.now();
  log.line('info', `spawn ${formatCmd(process.execPath, args)}`);
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    env: { ...process.env, CAPTURE_STUDIO_HOME: cfg.dataDir, CAPTURE_STUDIO_CDP_PORT: String(cfg.port) },
    windowsHide: true,
    // fd 3 is the IPC channel the recorder listens on for a graceful {type:'stop'}.
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  onChild?.(child);

  let stdout = '';
  let lastErr = '';
  const pump = (stream, tag) => {
    let buf = '';
    stream.setEncoding('utf8');
    stream.on('data', (d) => {
      if (tag === 'out') stdout += d;
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = stripAnsi(buf.slice(0, i));
        buf = buf.slice(i + 1);
        log.line(tag, line);
        if (tag === 'err' && line.trim() !== '') { lastErr = line; process.stdout.write(`${line}\n`); }
      }
    });
    stream.on('end', () => {
      if (buf.trim() !== '') {
        const line = stripAnsi(buf);
        log.line(tag, line);
        if (tag === 'err' && line.trim() !== '') { lastErr = line; process.stdout.write(`${line}\n`); }
      }
    });
  };
  pump(child.stdout, 'out');
  pump(child.stderr, 'err');

  return new Promise((resolve) => {
    child.on('error', (e) => {
      log.line('err', `spawn failed: ${e.message}`);
      resolve({ code: 1, signal: null, ms: Date.now() - startedAt, sessionId: null, lastError: `spawn failed: ${e.message}` });
    });
    child.on('exit', (code, signal) => {
      let sessionId = null;
      try { sessionId = JSON.parse(stdout.trim())?.id ?? null; } catch { /* no JSON result */ }
      resolve({ code: code ?? (signal ? 1 : 0), signal, ms: Date.now() - startedAt, sessionId, lastError: lastErr });
    });
  });
}

// ---------------------------------------------------------------------------------------------
// Supervisor loop
// ---------------------------------------------------------------------------------------------
async function cmdRun(cfg) {
  const existing = readJson(cfg.stateFile);
  if (existing && pidAlive(existing.pid)) {
    console.log(`already running (pid ${existing.pid})`);
    return 0;
  }
  rotateLog(cfg.logFile);
  const log = makeLogger(cfg.logFile);
  try { unlinkSync(cfg.stopFile); } catch { /* no stale stop request */ }
  const state = {
    pid: process.pid,
    startedAt: now(),
    childPid: null,
    childStartedAt: null,
    port: cfg.port,
    tabs: cfg.tabs,
    rotateMin: cfg.rotateMin,
    maxMb: cfg.maxMb,
    ensureChrome: cfg.ensureChrome,
    chromeProfile: cfg.chromeProfile,
    logFile: cfg.logFile,
    cycles: 0,
    restarts: 0,
  };
  const persist = () => writeJsonAtomic(cfg.stateFile, state);

  persist();

  let child = null;
  let stopping = false;
  let backoffIndex = 0;
  let shortFailures = 0;
  let stopPoll = null;

  // Ask the recorder to stop through its IPC channel; bin/studio.mjs re-emits that as the SIGINT
  // the Ctrl+C path handles, so session.json gets status "complete", endedAt and a closed raw
  // segment. Force-killing is only the fallback after GRACEFUL_STOP_MS.
  const gracefulStop = async (why) => {
    const pid = child?.pid;
    if (!Number.isInteger(pid) || !pidAlive(pid)) return true;
    let sent = false;
    try { sent = child.connected ? child.send({ type: 'stop' }) === true : false; } catch { sent = false; }
    if (!sent) {
      log.line('warn', `recorder pid ${pid} has no IPC channel (${why}); forcing tree kill`);
      if (process.platform === 'win32') killTree(pid, { force: true });
      else { try { child.kill(); } catch { /* already gone */ } }
      await waitDead(pid, 5000);
      return false;
    }
    log.line('info', `recorder pid ${pid}: IPC stop sent (${why}); waiting up to ${GRACEFUL_STOP_MS / 1000}s to finalize`);
    if (await waitDead(pid, GRACEFUL_STOP_MS)) {
      log.line('info', `recorder pid ${pid} exited gracefully; session finalized`);
      return true;
    }
    log.line('warn', `recorder pid ${pid} ignored the IPC stop for ${GRACEFUL_STOP_MS / 1000}s; forcing tree kill`);
    if (process.platform === 'win32') killTree(pid, { force: true });
    else { try { child.kill(); } catch { /* already gone */ } }
    await waitDead(pid, 5000);
    return false;
  };

  const shutdown = async (why) => {
    if (stopping) return;
    stopping = true;
    if (stopPoll) { clearInterval(stopPoll); stopPoll = null; }
    log.line('info', `${why}; stopping recorder pid ${child?.pid ?? '-'}`);
    await gracefulStop(why);
    try { unlinkSync(cfg.stateFile); } catch { /* already gone */ }
    try { unlinkSync(cfg.stopFile); } catch { /* already gone */ }
    log.line('info', 'supervisor stopped');
    log.close();
    process.exit(0);
  };

  process.on('SIGINT', () => { shutdown('SIGINT').catch(() => process.exit(0)); });
  process.on('SIGTERM', () => { shutdown('SIGTERM').catch(() => process.exit(0)); });
  // `--stop` cannot signal this process graciously on Windows (process.kill terminates it), so the
  // stop request arrives as a file in the data dir and is acted on within 500 ms.
  stopPoll = setInterval(() => {
    if (stopping) return;
    if (existsSync(cfg.stopFile)) shutdown('stop request received').catch(() => process.exit(0));
  }, 500);

  log.line('info', `supervisor pid ${process.pid} started (port ${cfg.port}, tabs ${cfg.tabs}, rotate ${cfg.rotateMin}m, max ${cfg.maxMb}MB, ensure-chrome ${cfg.ensureChrome ? 'on' : 'off'}${cfg.chromeProfile ? `, chrome profile ${cfg.chromeProfile}` : ''})`);

  for (;;) {
    state.cycles += 1;
    state.childStartedAt = now();
    persist();
    log.line('info', `cycle ${state.cycles}: starting`);

    await ensureBrowser(cfg, (kind, message) => log.line(kind, message));
    if (stopping) return 0;

    let rotateTimer = null;
    const result = await runCycle(cfg, log, (c) => {
      child = c;
      state.childPid = c.pid ?? null;
      persist();
      // Rotation safety net: the recorder normally ends the cycle with its own --duration timer.
      // If that ever fails, ask it to stop over IPC so the session is finalized, not abandoned.
      rotateTimer = setTimeout(() => {
        if (stopping || !c.connected) return;
        log.line('info', `rotation: ${cfg.rotateMin}m reached; sending IPC stop to pid ${c.pid}`);
        try { c.send({ type: 'stop' }); } catch { /* the exit handler follows either way */ }
      }, Math.round(cfg.rotateMin * 60_000));
    });
    if (rotateTimer) clearTimeout(rotateTimer);

    state.childPid = null;
    persist();
    log.line(result.code === 0 ? 'info' : 'err',
      `cycle ${state.cycles} exited code=${result.code} signal=${result.signal ?? '-'} after ${Math.round(result.ms / 1000)}s` +
      (result.sessionId ? ` session=${result.sessionId}` : ' session=-'));

    if (stopping) return 0;

    const healthy = result.ms >= SHORT_CYCLE_MS;
    if (healthy) {
      backoffIndex = 0;
      shortFailures = 0;
    } else {
      shortFailures += 1;
      backoffIndex = Math.min(backoffIndex + 1, BACKOFF_MS.length - 1); // capped at 60 s
      // Never give up: a closed browser, a logged-out profile or a busy port is expected to heal.
      if (shortFailures % WARN_EVERY === 0) {
        log.line('warn', `${shortFailures} consecutive cycles shorter than ${SHORT_CYCLE_MS / 1000}s (${state.cycles} cycles total); last error: ${result.lastError || '(no stderr output)'}; still retrying`);
      }
    }

    const waitMs = BACKOFF_MS[backoffIndex];
    state.restarts += 1;
    persist();
    log.line('warn', `respawning in ${waitMs / 1000}s (short failures ${shortFailures})`);
    const until = Date.now() + waitMs;
    while (Date.now() < until && !stopping) await sleep(Math.min(500, Math.max(50, until - Date.now())));
    if (stopping) return 0;
  }
}

async function cmdOnce(cfg) {
  rotateLog(cfg.logFile);
  const log = makeLogger(cfg.logFile);
  log.line('info', `one-shot cycle (port ${cfg.port}, tabs ${cfg.tabs}, rotate ${cfg.rotateMin}m, max ${cfg.maxMb}MB)`);
  await ensureBrowser(cfg, (kind, message) => log.line(kind, message));
  const result = await runCycle(cfg, log);
  log.line(result.code === 0 ? 'info' : 'err',
    `one-shot exited code=${result.code} signal=${result.signal ?? '-'} after ${Math.round(result.ms / 1000)}s` +
    (result.sessionId ? ` session=${result.sessionId}` : ' session=-'));
  log.close();
  return result.code;
}

// ---------------------------------------------------------------------------------------------
const cfg = setup(process.argv.slice(2));
if (cfg.dryRun) process.exit(cmdDryRun(cfg));
if (cfg.status) process.exit(cmdStatus(cfg));
if (cfg.stop) process.exit(await cmdStop(cfg));
if (cfg.once) process.exit(await cmdOnce(cfg));
process.exit(await cmdRun(cfg));
