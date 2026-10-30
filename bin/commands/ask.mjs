// `studio ask`: one or more AI sites asked through the EXISTING /api/v1/compare route on an
// ALREADY-RUNNING Studio (src/studio/compare-routes.mjs -> compare-service.mjs). This file opens
// no browser and runs no runtime of its own; it is a thin HTTP caller, same pattern as recipes.mjs.
// --wait only ever re-polls the SAME job id (GET /api/v1/compare/{id}); it never posts a second
// question. Re-running this exact command (same sites + question) while the job is still active
// reattaches to that SAME job instead of asking again — compare-service.mjs dedupes that itself.
//
// Developer-helper layer on top of that same thin call:
//  --role <reviewer|implementer|explainer|copywriter>  builds a bounded, role-specific prompt
//    (src/studio/ask-prompts.mjs) instead of sending the raw --question text verbatim.
//  --diff <git-rev-range> / --files a,b  attach READ-ONLY local context (git diff / file contents),
//    capped in size and refused outright for secret-looking paths (.env, credentials, keys, …) —
//    those never get read, let alone sent to a third-party AI website.
//  --auto N  asks the N healthiest/fastest signed-in sites from GET /api/v1/providers/performance
//    instead of naming sites (falls back to chatgpt,claude when there is no history yet).
//  --save  waits for the job to finish, then writes the question summary, each provider's answer,
//    its time-to-answer and state to docs/session/ai-work/<timestamp>-<role>.md. It never writes
//    diff/file CONTENT, only that --diff/--files were used, so a saved file can never leak secrets.
//  --print-prompt  prints the built prompt and returns WITHOUT posting anything — a fully offline
//    dry run (no Studio, no browser, no network) for checking what would be sent.
import { execFile } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { define } from '../lib/registry.mjs';
import { usageError, envError, CliError, fmtMs, truncate } from '../lib/ui.mjs';
import { EXIT, TOOL_ROOT } from '../../src/config.mjs';
import { createStudioToolClient } from '../../src/studio/tool-client.mjs';
import { ROLE_NAMES, buildPrompt, isSecretPath, secretPathsInDiff } from '../../src/studio/ask-prompts.mjs';
import { PATTERN_NAMES, PATTERN_CHOICES, PATTERNS, buildPlanSpec } from '../../src/studio/orchestrator-patterns.mjs';

const TERMINAL_JOB_STATES = new Set(['complete', 'partial', 'failed', 'cancelled']);
const KNOWN_SITES = ['chatgpt', 'claude', 'zai', 'qwen', 'deepseek', 'gemini'];

function client(ctx) {
  const seconds = ctx.flags.timeout ?? 15;
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 60) throw usageError('--timeout (per HTTP request) must be 1-60 seconds.');
  return createStudioToolClient({ port: ctx.flags['studio-port'] ?? ctx.settings.studioPort, timeoutMs: seconds * 1000,
    ...(process.env.CAPTURE_STUDIO_TOKEN ? { token: process.env.CAPTURE_STUDIO_TOKEN } : {}) });
}
async function callStudio(ctx, method, route, body) {
  try { return await client(ctx).recipeRequest(method, '/api/v1' + route, body); }
  catch (error) {
    if (error?.status === 503) throw envError('Could not reach the running Studio.', 'Start it first ("studio launch"), or pass the right --studio-port.');
    const code = /^[A-Z][A-Z0-9_]{0,79}$/.test(error?.code ?? '') ? error.code : 'STUDIO_CLIENT_ERROR';
    throw new CliError(code, { exit: EXIT.ENVIRONMENT, code,
      details: { httpStatus: Number.isInteger(error?.status) ? error.status : null, effect: error?.effect === 'unknown' ? 'unknown' : 'none', retry: false } });
  }
}

function questionFrom(flags) {
  const parts = [];
  if (typeof flags.question === 'string' && flags.question.trim()) parts.push(flags.question.trim());
  if (typeof flags.file === 'string' && flags.file) {
    if (isSecretPath(flags.file)) throw usageError(`Refusing to read --file "${flags.file}": looks like a secret/credentials path.`, 'VIVIM never sends secret-looking files to an AI website.');
    let content;
    try { content = readFileSync(flags.file, 'utf8'); }
    catch (e) { throw usageError(`Could not read --file "${flags.file}": ${e.code ?? e.message}`); }
    if (content.trim()) parts.push(content.trim());
  }
  if (!parts.length) throw usageError('Provide a question with --question "..." or --file prompt.md (or both).');
  return parts.join('\n\n');
}

// Read-only: `git diff <range>` in the repo checkout, never a working-tree write. 15s ceiling and a
// generous buffer so a legitimate large diff never silently truncates mid-process; the final cap
// (and the warning for it) happens once, in ask-prompts.mjs, next to the files/question caps.
function readDiff(range) {
  return new Promise((resolve, reject) => {
    execFile('git', ['diff', '--no-color', range], { cwd: TOOL_ROOT, maxBuffer: 16 * 1024 * 1024, timeout: 15000 },
      (error, stdout, stderr) => { if (error) reject(Object.assign(error, { stderr })); else resolve(stdout); });
  });
}

function readContextFiles(paths) {
  return paths.map((p) => {
    if (isSecretPath(p)) throw usageError(`Refusing to read --files entry "${p}": looks like a secret/credentials path.`, 'VIVIM never sends secret-looking files to an AI website. Remove it from --files.');
    try { return { path: p, content: readFileSync(p, 'utf8') }; }
    catch (e) { throw usageError(`Could not read --files entry "${p}": ${e.code ?? e.message}`); }
  });
}

// Rank already-saved performance (GET /providers/performance) by success rate, then speed. A site
// with zero saved jobs is unranked (never proven healthy OR unhealthy); with no ranked sites at all
// (brand-new install), fall back to the two accounts the owner actually has signed in today.
function rankSites(providers) {
  return providers.filter((p) => p.jobs > 0)
    .map((p) => ({ site: p.site, successRate: p.completed / p.jobs, medianMs: p.medianMs }))
    .sort((a, b) => (b.successRate - a.successRate) || ((a.medianMs ?? Infinity) - (b.medianMs ?? Infinity)));
}
async function autoSites(request, n) {
  const report = await request('GET', '/providers/performance');
  const ranked = rankSites(report?.providers ?? []);
  return (ranked.length ? ranked.map((r) => r.site) : ['chatgpt', 'claude']).slice(0, n);
}

function printResult(ctx, result) {
  const { out } = ctx;
  if (result.state === 'ready') {
    out.result(out.c.bold(result.label) + ':');
    out.result(result.answer ? result.answer : '(empty answer)');
  } else {
    out.result(out.c.bold(result.label) + ': ' + (result.message || result.state));
  }
  out.result('');
}

// docs/session/ai-work/<timestamp>-<role>.md — question summary, each answer, time-to-answer, state.
// Never the diff/file CONTENT (only that they were used): a saved file can never carry a secret that
// --diff/--files already refused to read, and never carries more than what the AI itself answered.
function saveAskResult({ role, rawQuestion, diffRange, filePaths, job }) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(TOOL_ROOT, 'docs', 'session', 'ai-work');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${stamp}-${role ?? 'ask'}.md`);
  const context = [diffRange ? `diff ${diffRange}` : null, filePaths?.length ? `files: ${filePaths.join(', ')}` : null].filter(Boolean);
  const lines = [`# Ask — ${role ?? 'question'} — ${stamp}`, '', '## Question', '', truncate(rawQuestion, 2000)];
  if (context.length) lines.push('', `Context: ${context.join('; ')}`);
  lines.push('', '## Results', '');
  for (const r of job.results) {
    const ms = r.startedAt && r.answeredAt ? Date.parse(r.answeredAt) - Date.parse(r.startedAt) : null;
    lines.push(`### ${r.label} — ${r.state}${Number.isFinite(ms) ? ` (${fmtMs(ms)})` : ''}`, '',
      r.state === 'ready' ? (r.answer || '(empty answer)') : (r.message || r.state), '');
  }
  writeFileSync(file, lines.join('\n'));
  return file;
}

// --pattern: POST /api/v1/orchestrate (src/studio/ai-orchestrator.mjs) instead of /compare. Same
// rules: --wait only re-polls the SAME plan id; re-running the same command while it is active
// reattaches to that plan (the orchestrator dedupes identical active questions).
function patternOptions(flags) {
  const options = {};
  if (flags.by !== undefined) options.by = flags.by;
  if (flags.rounds !== undefined) options.rounds = flags.rounds;
  if (flags['hedge-after'] !== undefined) options.hedgeAfterSeconds = flags['hedge-after'];
  if (flags['deadline-minutes'] !== undefined) options.deadlineMinutes = flags['deadline-minutes'];
  return options;
}
function printPlan(ctx, plan) {
  const { out } = ctx;
  const result = plan.result;
  if (result?.answers?.length) {
    for (const a of result.answers) { out.result(out.c.bold(a.label) + ':'); out.result(a.answer || '(empty answer)'); out.result(''); }
  } else if (result?.answer) {
    out.result(out.c.bold(result.from?.label ?? 'Answer') + ':'); out.result(result.answer); out.result('');
  }
  if (result?.notes) { out.result(out.c.bold('Notes') + ':'); out.result(result.notes); out.result(''); }
  if (result?.summary) out.result(result.summary);
  for (const s of plan.steps) {
    const time = Number.isFinite(s.answerMs) ? ' (' + fmtMs(s.answerMs) + ')' : '';
    out.line(out.c.dim(`  ${s.label} · ${s.role} · ${s.state}${time}${s.state === 'ready' ? '' : ' — ' + s.message}`));
  }
}
function savePlanResult({ role, rawQuestion, diffRange, filePaths, plan }) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(TOOL_ROOT, 'docs', 'session', 'ai-work');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${stamp}-${plan.pattern}-${role ?? 'ask'}.md`);
  const context = [diffRange ? `diff ${diffRange}` : null, filePaths?.length ? `files: ${filePaths.join(', ')}` : null].filter(Boolean);
  const lines = [`# Ask (${plan.title}) — ${role ?? 'question'} — ${stamp}`, '', '## Question', '', truncate(rawQuestion, 2000)];
  if (context.length) lines.push('', `Context: ${context.join('; ')}`);
  lines.push('', '## Result', '', plan.result?.summary ?? plan.state, '');
  if (plan.result?.answer) lines.push(`### Chosen answer (${plan.result.from?.label ?? '?'})`, '', plan.result.answer, '');
  if (plan.result?.notes) lines.push('### Notes', '', plan.result.notes, '');
  lines.push('## Steps', '');
  for (const s of plan.steps) {
    lines.push(`### ${s.label} — ${s.role} — ${s.state}${Number.isFinite(s.answerMs) ? ` (${fmtMs(s.answerMs)})` : ''}`, '',
      s.state === 'ready' ? (s.answer || '(empty answer)') : (s.message || s.state), '');
  }
  writeFileSync(file, lines.join('\n'));
  return file;
}
async function runPattern(ctx, { request, pattern, question, sites, role, rawQuestion, diffRange, filePaths }) {
  const options = patternOptions(ctx.flags);
  const mustWait = !!ctx.flags.wait || !!ctx.flags.save;
  const started = await request('POST', '/orchestrate', { pattern, question, sites, options });
  let plan = started.plan;
  if (!mustWait) {
    ctx.out.emit(started, () => ctx.out.info(`${plan.title} started (id ${plan.id}). Run the exact same "studio ask" command with --wait to follow it; it will not ask again.`));
    return;
  }
  const waitSeconds = Number.isSafeInteger(ctx.flags['wait-timeout']) ? ctx.flags['wait-timeout'] : 900;
  const deadline = Date.now() + Math.max(1, waitSeconds) * 1000;
  const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
  const shown = new Set(); // events are a capped rolling log; print each one once
  for (;;) {
    for (const e of plan.events ?? []) {
      const id = e.at + '|' + (e.step ?? '') + '|' + e.text;
      if (!shown.has(id)) { shown.add(id); ctx.out.info(e.text); }
    }
    if (TERMINAL_JOB_STATES.has(plan.state)) break;
    if (Date.now() >= deadline) {
      ctx.out.info('Still waiting after ' + fmtMs(waitSeconds * 1000) + '. Nothing was sent twice; run the same "studio ask ... --wait" again to keep checking.');
      process.exitCode = EXIT.ENVIRONMENT;
      break;
    }
    await sleep(2000);
    plan = (await request('GET', '/orchestrate/' + encodeURIComponent(plan.id))).plan;
  }
  ctx.out.emit({ plan }, () => printPlan(ctx, plan));
  if (plan.state === 'failed') process.exitCode = EXIT.ENVIRONMENT;
  if (ctx.flags.save) {
    if (!TERMINAL_JOB_STATES.has(plan.state)) ctx.out.warn('Not saved: still waiting. Run the exact same command again with --save once it finishes; it will not ask twice.');
    else ctx.out.info('Saved to ' + savePlanResult({ role, rawQuestion, diffRange, filePaths, plan }));
  }
}

export async function runAsk(ctx, dependencies = {}) {
  const role = ctx.flags.role ?? null;
  const diffRange = typeof ctx.flags.diff === 'string' && ctx.flags.diff ? ctx.flags.diff : null;
  const filePaths = ctx.flags.files?.length ? ctx.flags.files : [];
  const printPrompt = !!ctx.flags['print-prompt'];
  const autoN = ctx.flags.auto;

  const pattern = ctx.flags.pattern ?? null;
  const autoPattern = pattern === 'auto';
  if (ctx.args.length && autoN !== undefined) throw usageError('Give site names OR --auto N, not both.');
  if (!ctx.args.length && autoN === undefined && !autoPattern) throw usageError('Usage: studio ask <site...|--auto N|--pattern auto> --question "..." [--pattern NAME] [--role reviewer|implementer|explainer|copywriter] [--diff REV-RANGE] [--files a,b] [--wait] [--save] [--print-prompt]', 'Example: studio ask chatgpt claude --question "What is a monorepo?" --wait');
  if (autoN !== undefined && (!Number.isSafeInteger(autoN) || autoN < 1 || autoN > KNOWN_SITES.length)) throw usageError(`--auto must be an integer 1-${KNOWN_SITES.length}.`);

  let diffText = '';
  if (diffRange) {
    try { diffText = await readDiff(diffRange); }
    catch (e) {
      if (e.code === 'ENOENT') throw envError('git is not available on PATH.', 'Install git, or drop --diff.');
      throw usageError(`"git diff ${diffRange}" failed: ${String(e.stderr || e.message).trim().slice(0, 400)}`, 'Check the rev-range, e.g. "HEAD~3..HEAD" or "main..feature".');
    }
    const secret = secretPathsInDiff(diffText);
    if (secret.length) throw usageError(`Refusing --diff "${diffRange}": it touches secret-looking path(s): ${secret.join(', ')}.`, 'Pick a narrower rev-range, or avoid touching that file.');
  }
  const contextFiles = filePaths.length ? readContextFiles(filePaths) : [];

  const rawQuestion = questionFrom(ctx.flags);
  let question = rawQuestion;
  if (role || diffText || contextFiles.length) {
    const built = buildPrompt({ role, question: rawQuestion, diff: diffText, diffRange, files: contextFiles });
    question = built.prompt;
    for (const w of built.warnings) ctx.out.warn(w);
  }

  if (pattern === null && (ctx.flags.by !== undefined || ctx.flags.rounds !== undefined || ctx.flags['hedge-after'] !== undefined)) throw usageError('--by, --rounds and --hedge-after need --pattern.');
  if (pattern === 'auto' && (ctx.args.length || autoN !== undefined)) throw usageError('--pattern auto picks the AIs itself; drop the site names and --auto (or name a pattern to choose them yourself).');
  // Offline validation of the pattern + sites (same builder Studio uses), before anything is posted.
  const checkPattern = (sites) => {
    if (pattern === 'auto') return null; // the chooser runs inside Studio, on real signed-in evidence
    try { return buildPlanSpec({ pattern, question, sites, options: patternOptions(ctx.flags) }); }
    catch (e) { throw usageError(e.message, `Pattern "${pattern}": ${PATTERNS[pattern]?.summary ?? ''} AIs: ${PATTERNS[pattern]?.sites ?? '?'}.`); }
  };

  if (printPrompt) {
    const plan = pattern && autoN === undefined ? checkPattern(ctx.args) : null;
    ctx.out.emit({ role, pattern, sites: autoN !== undefined ? `auto:${autoN}` : ctx.args, prompt: question, ...(plan ? { steps: plan.steps.map((s) => ({ id: s.id, site: s.site, role: s.role, after: s.after })) } : {}) }, (o) => {
      o.heading(`Built prompt${role ? ` (role: ${role})` : ''}:`);
      o.result(question);
      if (plan) { o.line(''); o.line(`${PATTERNS[pattern].title} — steps:`); for (const s of plan.steps) o.line(`  ${s.id}  ${s.label} · ${s.role}${s.after.length ? ' (after ' + s.after.join(', ') + ')' : ''}`); }
      if (autoN !== undefined) o.line(o.c.dim(`Sites would be auto-selected (top ${autoN} by saved performance) when actually asked; not resolved in --print-prompt.`));
    });
    return;
  }

  const request = (...a) => (dependencies.request ?? callStudio)(ctx, ...a);
  const sites = autoN !== undefined ? await autoSites(request, autoN) : ctx.args;
  if (pattern) {
    checkPattern(sites);
    return runPattern(ctx, { request, pattern, question, sites, role, rawQuestion, diffRange, filePaths });
  }
  const mustWait = !!ctx.flags.wait || !!ctx.flags.save;

  const started = await request('POST', '/compare', { question, sites });
  let job = started.job;
  if (!mustWait) {
    ctx.out.emit(started, () => {
      ctx.out.info('Asked (id ' + job.id + '). Run the exact same "studio ask" command with --wait to see the answers; it will not ask again.');
      for (const r of job.results) printResult(ctx, r);
    });
    return;
  }

  const waitSeconds = Number.isSafeInteger(ctx.flags['wait-timeout']) ? ctx.flags['wait-timeout'] : 900; // CLI-side polling patience only; never a resend
  const deadline = Date.now() + Math.max(1, waitSeconds) * 1000;
  const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
  const announced = new Map();
  for (;;) {
    for (const r of job.results) {
      if (announced.get(r.site) !== r.message) { announced.set(r.site, r.message); if (r.message) ctx.out.info(r.message); }
    }
    if (TERMINAL_JOB_STATES.has(job.state)) break;
    if (Date.now() >= deadline) {
      ctx.out.info('Still waiting after ' + fmtMs(waitSeconds * 1000) + '. Nothing was sent twice; run the same "studio ask ... --wait" again to keep checking this question.');
      process.exitCode = EXIT.ENVIRONMENT;
      break;
    }
    await sleep(2000);
    const read = await request('GET', '/compare/' + encodeURIComponent(job.id));
    job = read.job;
  }
  ctx.out.emit({ job }, () => { for (const r of job.results) printResult(ctx, r); });
  if (job.state === 'failed') process.exitCode = EXIT.ENVIRONMENT;

  if (ctx.flags.save) {
    if (!TERMINAL_JOB_STATES.has(job.state)) {
      ctx.out.warn('Not saved: still waiting for an answer. Run the exact same command again with --save (same sites + question) to save once it finishes; it will not ask twice.');
    } else {
      const file = saveAskResult({ role, rawQuestion, diffRange, filePaths, job });
      ctx.out.info('Saved to ' + file);
    }
  }
}

define({
  name: 'ask', section: 'Knowledge', usage: '<site...|--auto N> --question "..." [--pattern NAME [--by SITE] [--rounds N] [--hedge-after S]] [--role R] [--diff REV-RANGE] [--files a,b] [--wait] [--save] [--print-prompt]',
  summary: 'Ask one or more of your own signed-in AI accounts a question — plain, or as a bounded developer-role prompt with diff/file context',
  description: 'Posts to the existing /api/v1/compare route on an already-running Studio: each listed site (or the --auto N healthiest/fastest sites, from "studio providers performance") is one real question to that AI account, through the ONE shared browser/runtime owner. --role builds a bounded, role-specific prompt (src/studio/ask-prompts.mjs) with an explicit output format; --diff/--files attach capped, read-only local context and refuse secret-looking paths outright. --wait polls the SAME job id (never a second send) and prints each answer as it arrives, with plain-language progress ("Waiting for Claude…"). --save (implies --wait) writes the question, each answer, its time-to-answer and state to docs/session/ai-work/<timestamp>-<role>.md, never the diff/file content. --print-prompt prints the built prompt and exits without posting anything — a fully offline dry run. Without --wait/--save, prints the started job and its id; re-running the exact same command later (with --wait) reattaches to that same job instead of asking again. With --pattern NAME it posts to /api/v1/orchestrate instead (the central multi-AI orchestrator: race, fallback, hedge, council, judge, relay, critique, verify, fanout, single), prints plain-language progress and the chosen answer; the same no-resend and reattach rules apply.',
  flags: {
    'studio-port': { type: 'number', valueName: 'PORT', desc: 'Existing Studio HTTP port (default configured port)' },
    timeout: { type: 'number', valueName: 'SECONDS', default: 15, desc: 'Per-HTTP-request deadline, 1-60 seconds; never retries' },
    question: { type: 'string', valueName: 'TEXT', desc: 'The question to ask (combined with --file if both are given)' },
    file: { type: 'string', valueName: 'FILE', desc: 'Read the question (or extra context) from this file; refuses secret-looking paths' },
    role: { type: 'string', choices: ROLE_NAMES, valueName: 'ROLE', desc: 'Build a bounded developer prompt with an explicit output format instead of sending --question verbatim' },
    diff: { type: 'string', valueName: 'REV-RANGE', desc: 'Attach "git diff REV-RANGE" as read-only context (capped, warns when trimmed, refuses secret-looking paths)' },
    files: { type: 'list', valueName: 'A,B', desc: 'Attach these files as read-only context (capped, warns when trimmed, refuses secret-looking paths)' },
    auto: { type: 'number', valueName: 'N', desc: 'Ask the N healthiest/fastest signed-in sites from "studio providers performance" instead of naming sites (falls back to chatgpt,claude with no history)' },
    save: { type: 'boolean', desc: 'After it finishes, save the question, each answer, time-to-answer and state to docs/session/ai-work/ (implies --wait; never saves diff/file content)' },
    'print-prompt': { type: 'boolean', desc: 'Print the built prompt and exit; never posts anything (offline dry run)' },
    wait: { type: 'boolean', desc: 'Poll until every site answers, fails, or is skipped, then print the answers' },
    'wait-timeout': { type: 'number', valueName: 'SECONDS', default: 900, desc: 'How long this CLI command polls before giving up locally (the job itself keeps running on Studio)' },
    pattern: { type: 'string', choices: PATTERN_NAMES, valueName: 'NAME', desc: 'Ask through the multi-AI orchestrator: single, fanout, race (first good answer), fallback (next AI only if one fails), hedge (second AI if the first is slow), council (combine), judge (pick best), relay (each improves), critique (review + improve), verify (double-check)' },
    by: { type: 'string', valueName: 'SITE', desc: 'With --pattern council|judge: the AI that combines or judges (default: the first listed)' },
    rounds: { type: 'number', valueName: 'N', desc: 'With --pattern critique: review rounds, 1-3 (default 1)' },
    'hedge-after': { type: 'number', valueName: 'SECONDS', desc: 'With --pattern hedge: ask the second AI if the first has not answered after this long (default 90)' },
    'deadline-minutes': { type: 'number', valueName: 'MIN', desc: 'With --pattern: overall time limit on Studio, 1-120 (default 20); stops waiting, never resends' } },
  examples: [
    'studio ask chatgpt --question "Summarize the CAP theorem in 3 sentences." --wait',
    'studio ask chatgpt claude zai qwen --question "Which of you can read local files?" --wait --json',
    'studio ask claude --file prompt.md --wait',
    'studio ask chatgpt claude --role reviewer --diff HEAD~1..HEAD --question "Focus on error handling." --wait',
    'studio ask --auto 2 --role implementer --files bin/commands/ask.mjs --question "Add a --dry-run flag." --wait --save',
    'studio ask claude --role copywriter --question "Write the empty-state message for the Ask screen." --print-prompt',
    'studio ask chatgpt claude zai --pattern council --by claude --question "Best way to back up a Windows PC?" --wait',
    'studio ask chatgpt claude qwen --pattern race --question "Capital of Australia?" --wait',
    'studio ask chatgpt claude zai --pattern fallback --question "Explain HTTP/3 in two sentences." --wait',
    'studio ask chatgpt claude --pattern relay --question "Draft a short welcome email." --wait',
  ],
  run: runAsk,
});
