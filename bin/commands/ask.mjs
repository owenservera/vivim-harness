// `studio ask`: one or more AI sites asked through the EXISTING /api/v1/compare route on an
// ALREADY-RUNNING Studio (src/studio/compare-routes.mjs -> compare-service.mjs). This file opens
// no browser and runs no runtime of its own; it is a thin HTTP caller, same pattern as recipes.mjs.
// --wait only ever re-polls the SAME job id (GET /api/v1/compare/{id}); it never posts a second
// question. Re-running this exact command (same sites + question) while the job is still active
// reattaches to that SAME job instead of asking again — compare-service.mjs dedupes that itself.
import { readFileSync } from 'node:fs';
import { define } from '../lib/registry.mjs';
import { usageError, envError, CliError, fmtMs } from '../lib/ui.mjs';
import { EXIT } from '../../src/config.mjs';
import { createStudioToolClient } from '../../src/studio/tool-client.mjs';

const TERMINAL_JOB_STATES = new Set(['complete', 'partial', 'failed', 'cancelled']);

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
    let content;
    try { content = readFileSync(flags.file, 'utf8'); }
    catch (e) { throw usageError(`Could not read --file "${flags.file}": ${e.code ?? e.message}`); }
    if (content.trim()) parts.push(content.trim());
  }
  if (!parts.length) throw usageError('Provide a question with --question "..." or --file prompt.md (or both).');
  return parts.join('\n\n');
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

export async function runAsk(ctx, dependencies = {}) {
  const sites = ctx.args;
  if (!sites.length) throw usageError('Usage: studio ask <site...> --question "..." [--file prompt.md] [--wait]', 'Example: studio ask chatgpt claude --question "What is a monorepo?" --wait');
  const question = questionFrom(ctx.flags);
  const request = (...a) => (dependencies.request ?? callStudio)(ctx, ...a);

  const started = await request('POST', '/compare', { question, sites });
  let job = started.job;
  if (!ctx.flags.wait) {
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
}

define({
  name: 'ask', section: 'Knowledge', usage: '<site...> --question "..." [--file prompt.md] [--wait]',
  summary: 'Ask one or more of your own signed-in AI accounts a question (ChatGPT, Claude, Z.ai, Qwen)',
  description: 'Posts to the existing /api/v1/compare route on an already-running Studio: each listed site is one real question to that AI account, through the ONE shared browser/runtime owner. --wait polls the SAME job id (never a second send) and prints each answer as it arrives, with plain-language progress ("Waiting for Claude…"). Without --wait, prints the started job and its id; re-running the exact same command later (with --wait) reattaches to that same job instead of asking again.',
  flags: {
    'studio-port': { type: 'number', valueName: 'PORT', desc: 'Existing Studio HTTP port (default configured port)' },
    timeout: { type: 'number', valueName: 'SECONDS', default: 15, desc: 'Per-HTTP-request deadline, 1-60 seconds; never retries' },
    question: { type: 'string', valueName: 'TEXT', desc: 'The question to ask (combined with --file if both are given)' },
    file: { type: 'string', valueName: 'FILE', desc: 'Read the question (or extra context) from this file' },
    wait: { type: 'boolean', desc: 'Poll until every site answers, fails, or is skipped, then print the answers' },
    'wait-timeout': { type: 'number', valueName: 'SECONDS', default: 900, desc: 'How long this CLI command polls before giving up locally (the job itself keeps running on Studio)' } },
  examples: [
    'studio ask chatgpt --question "Summarize the CAP theorem in 3 sentences." --wait',
    'studio ask chatgpt claude zai qwen --question "Which of you can read local files?" --wait --json',
    'studio ask claude --file prompt.md --wait',
  ],
  run: runAsk,
});
