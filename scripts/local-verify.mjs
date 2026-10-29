#!/usr/bin/env node
// Local-only verification, not CI: prints every test result and optionally writes a small
// privacy-safe receipt with the actual tested revision and TAP counters.
// No browser, network, provider send or external automation is started by this script.
import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const METRICS = Object.freeze(['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']);

export function parseTapSummary(output) {
  const summary = {};
  // Node's final TAP report contains one "# metric N" line for each counter.
  // Find the last occurrence of every metric, not an individual test's text.
  for (const line of String(output).split(/\r?\n/)) {
    const match = /^\s*#\s+(tests|pass|fail|cancelled|skipped|todo)\s+(\d+)\s*$/.exec(line);
    if (match) summary[match[1]] = Number(match[2]);
  }
  const complete = METRICS.every(key => Number.isSafeInteger(summary[key]));
  return { ...summary, complete };
}

export function verifyCliArgs(argv) {
  const args = { fast: false, receipt: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--fast') args.fast = true;
    else if (argv[i] === '--receipt' && argv[i + 1] && !argv[i + 1].startsWith('--')) {
      args.receipt = path.resolve(argv[++i]);
    } else throw new Error('Usage: node scripts/local-verify.mjs [--fast] [--receipt <new-local-json-path>]');
  }
  return args;
}

function git(args) {
  const res = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 10000 });
  return res.status === 0 ? res.stdout.trim() : null;
}

async function runStep(name, command, args) {
  const start = Date.now();
  console.log('\nLOCAL VERIFY — ' + name + ': ' + [command, ...args].join(' '));
  let tail = '';
  const result = await new Promise(resolve => {
    const child = spawn(command, args, { cwd: root, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const collect = (stream, out) => stream.on('data', chunk => {
      const text = String(chunk);
      out.write(text);
      if (stream === child.stdout) tail = (tail + text).slice(-32000);
    });
    collect(child.stdout, process.stdout);
    collect(child.stderr, process.stderr);
    child.once('error', error => resolve({ code: null, signal: null, error: error.code || error.message }));
    child.once('close', (code, signal) => resolve({ code, signal, error: null }));
  });
  return { name, command: [command, ...args], exitCode: result.code, signal: result.signal,
    error: result.error, elapsedMs: Date.now() - start, ...(name === 'full-unit-suite'
      ? { tap: parseTapSummary(tail) } : {}) };
}

async function main(argv) {
  const args = verifyCliArgs(argv);
  const startedAt = new Date().toISOString();
  const revision = git(['rev-parse', 'HEAD']);
  const porcelain = git(['status', '--porcelain']);
  const receipt = {
    schema: 'vivim.local-verification/1',
    startedAt, sourceRevision: revision,
    workingTreeDirtyAtStart: porcelain === null ? null : Boolean(porcelain),
    host: { platform: process.platform, node: process.version },
    mode: args.fast ? 'fast: full-unit-suite-skipped' : 'complete-local-gate',
    steps: [], status: 'RUNNING', providerLiveVerification: 'not-attempted',
    claim: 'Local process exit and TAP output only, never a live provider receipt',
  };
  try {
    receipt.steps.push(await runStep('architecture-parity-smoke', process.execPath,
      ['scripts/gate.mjs', '--fast']));
    if (receipt.steps.at(-1).exitCode === 0 && !args.fast) {
      receipt.steps.push(await runStep('full-unit-suite', process.platform === 'win32' ? 'bun.exe' : 'bun',
        ['run', 'test']));
    }
    const allSucceeded = receipt.steps.every(step => step.exitCode === 0 && !step.error);
    const suite = receipt.steps.find(step => step.name === 'full-unit-suite');
    const fullSuiteConfirmed = Boolean(suite && suite.tap.complete && suite.tap.fail === 0
      && suite.tap.cancelled === 0 && suite.tap.tests === suite.tap.pass + suite.tap.skipped + suite.tap.todo);
    receipt.status = !allSucceeded ? 'FAIL' : args.fast ? 'FAST_ONLY' : fullSuiteConfirmed ? 'PASS' : 'UNVERIFIED';
    receipt.fullSuiteConfirmed = fullSuiteConfirmed;
  } finally {
    receipt.finishedAt = new Date().toISOString();
    receipt.elapsedMs = Date.parse(receipt.finishedAt) - Date.parse(receipt.startedAt);
    if (args.receipt) {
      // Never overwrite another run's evidence; no raw test logs or private data are stored.
      writeFileSync(args.receipt, JSON.stringify(receipt, null, 2) + '\n',
        { flag: 'wx', mode: 0o600 });
      console.log('LOCAL VERIFY receipt: ' + args.receipt);
    }
    console.log('LOCAL VERIFY RESULT: ' + receipt.status + ' (' + (receipt.sourceRevision ?? 'unknown git revision') + ')');
    if (receipt.steps.find(step => step.name === 'full-unit-suite')) {
      console.log('LOCAL VERIFY TAP: ' + JSON.stringify(receipt.steps.find(step => step.name === 'full-unit-suite').tap));
    }
  }
  if (receipt.status === 'FAIL') process.exitCode = 1;
  if (receipt.status === 'UNVERIFIED') process.exitCode = 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    console.error('LOCAL VERIFY could not run: ' + error.message);
    process.exitCode = 2;
  });
}
