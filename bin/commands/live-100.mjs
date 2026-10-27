// Execute real provider/browser user journeys through the ONE production conversation runtime.
// No Playwright/Puppeteer, stubs, replayed answers, synthetic providers, automatic resends,
// parallel effects or raw prompt/reply bodies in receipts. Defaults to a zero-effect preview.
import path from 'node:path';
import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { launchChrome } from '../../src/chrome/launch.mjs';
import { defaultConversationRuntime } from '../../src/studio/conversation-api.mjs';
import { allLiveScenarios, assessUserAnswer, LIVE_PROVIDERS } from '../../src/capture/live-scenarios.mjs';
import { define } from '../lib/registry.mjs';
import { usageError } from '../lib/ui.mjs';
import { EXIT } from '../../src/config.mjs';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const codeOf = (e) => /^[A-Z][A-Z0-9_]{0,79}$/.test(e?.code ?? '') ? e.code : 'LIVE_SCENARIO_ERROR';
const lastTurn = (c) => c?.turn ?? c?.turns?.at(-1) ?? null;
const unsafe = (c) => {
  const turn = lastTurn(c);
  return ['blocked', 'needs-reconciliation'].includes(c?.state)
    || ['blocked', 'uncertain', 'needs-reconciliation'].includes(turn?.phase)
    || ['uncertain', 'not-sent', 'failed'].includes(turn?.send?.state);
};
const terminal = (c) => unsafe(c) || ['ready', 'failed'].includes(c?.reply?.state) || c?.state === 'closed';

function writeReceipt(file, data) {
  const tmp = file + '.' + randomUUID() + '.tmp';
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    renameSync(tmp, file);
  } finally { if (existsSync(tmp)) rmSync(tmp, { force: true }); }
}

function loadReceipt(file, suite, scenarioIds) {
  if (!existsSync(file)) return { schema: 'vivim.live-user-scenarios/1', suite, createdAt: new Date().toISOString(), cases: {} };
  let saved;
  try { saved = JSON.parse(readFileSync(file, 'utf8')); } catch { throw usageError('Existing scenario receipt is unreadable. Preserve it and use a different --suite.'); }
  if (saved.schema !== 'vivim.live-user-scenarios/1' || saved.suite !== suite || !saved.cases || typeof saved.cases !== 'object' || Array.isArray(saved.cases))
    throw usageError('Existing receipt is incompatible. Preserve it and choose a different --suite.');
  // Fail closed on a corrupted receipt, because replay could send a previously dispatched turn.
  for (const key of Object.keys(saved.cases)) {
    if (!scenarioIds.includes(key) && !/^([a-z0-9-]+)$/.test(key)) throw usageError('Receipt has an invalid scenario id; refusing to retry sends.');
  }
  return saved;
}

export async function runLiveScenarios(ctx, { runtimeFactory = defaultConversationRuntime, launch = launchChrome, sleep = pause, now = Date.now } = {}) {
  const flags = ctx.flags, providers = flags.providers ?? LIVE_PROVIDERS;
  const chosen = Array.isArray(providers) ? providers : String(providers).split(',');
  if (chosen.some((p) => !LIVE_PROVIDERS.includes(p))) throw usageError('Supported providers: ' + LIVE_PROVIDERS.join(', '));
  const scenarios = allLiveScenarios(chosen);
  const limit = flags.limit ?? scenarios.length;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw usageError('--limit must be an integer from 1 to 100');
  const selected = scenarios.slice(0, limit);
  const suite = flags.suite ?? 'default';
  if (!/^[a-z0-9_-]{1,40}$/i.test(suite)) throw usageError('--suite accepts only letters, digits, dash and underscore (1..40)');
  const timeout = flags.timeout ?? 150;
  if (!Number.isFinite(timeout) || timeout < 5 || timeout > 900) throw usageError('--timeout must be between 5 and 900 seconds');

  const receiptFile = path.join(ctx.paths.root, 'live-scenarios', suite + '.json');
  const preview = { dryRun: true, totalAvailable: 100, selected: selected.length, providers: chosen,
    caseIds: selected.map((s) => s.id), commandsRequired: 1, browserAction: false, providerSends: 0,
    note: 'The --execute --accept-sends pair is required for live sends. Each case is a fresh real provider conversation; no retry after uncertain effects.' };
  if (!flags.execute || flags['dry-run']) {
    ctx.out.emit(preview, (o) => o.line('Preview: ' + selected.length + ' actual provider/browser scenarios; zero sends. Use --execute --accept-sends to authorize.'));
    return preview;
  }
  if (!flags['accept-sends']) throw usageError('Live sends require both --execute and --accept-sends. The full suite attempts up to 100 provider messages, potentially consuming quota.');

  // Browser launch/validation is part of THIS command. No manual DevTools command is required.
  await launch({ profileDir: ctx.paths.chromeProfile, port: ctx.port });
  const dir = path.dirname(receiptFile);
  mkdirSync(dir, { recursive: true });
  const receipt = loadReceipt(receiptFile, suite, scenarios.map((s) => s.id));
  const update = (item, patch) => {
    receipt.cases[item.id] = { ...receipt.cases[item.id], ...patch, updatedAt: new Date().toISOString() };
    writeReceipt(receiptFile, receipt);
  };
  const outcome = { suite, receiptFile, selected: selected.length, passed: 0, answerFailed: 0,
    blocked: 0, preserved: 0, notAttempted: 0, stoppedOn: null, browser: 'dedicated-verified',
    evidenceTier: 'live-provider-with-local-capture-pending-local-execution' };
  const runtime = await runtimeFactory({ paths: ctx.paths, profileStore: ctx.profiles(), familyStore: ctx.families(), port: ctx.port });
  try {
    for (const item of selected) {
      // Every previous start is a durable no-retry fence, even if the process crashed.
      if (receipt.cases[item.id]) {
        outcome.preserved++;
        continue;
      }
      const row = { id: item.id, provider: item.provider, title: item.task.title, state: 'started',
        startedAt: new Date().toISOString(), key: 'vivim-live-100:' + suite + ':' + item.id,
        effect: 'unknown', answer: 'not-assessed', evidenceTier: 'not-proven' };
      update(item, row); // durable intent BEFORE opening a tab or submitting
      let conversation = null, current = null, stop = false;
      try {
        conversation = await runtime.connect({ site: item.provider, freshTab: true });
        update(item, { conversationId: conversation.id, state: 'connected' });
        // A single submission. Once invoked, no catch path retries this key or a replacement.
        update(item, { state: 'send-intent-recorded' });
        current = await runtime.submit(conversation.id, {
          key: row.key, prompt: item.task.prompt, confirm: true, expectedRevision: conversation.revision,
        });
        const deadline = now() + timeout * 1000;
        while (!terminal(current) && now() < deadline) {
          await sleep(Math.min(650, Math.max(1, deadline - now())));
          current = await runtime.get(conversation.id);
        }
        if (!terminal(current)) {
          update(item, { state: 'unresolved', error: 'LOCAL_WAIT_TIMEOUT', effect: 'unknown' });
          outcome.blocked++; stop = true;
        } else if (unsafe(current)) {
          update(item, { state: 'unresolved', error: 'UNCONFIRMED_PROVIDER_EFFECT', effect: lastTurn(current)?.send?.state ?? 'unknown' });
          outcome.blocked++; stop = true;
        } else if (current.reply?.state !== 'ready' || lastTurn(current)?.send?.state !== 'observed') {
          update(item, { state: 'unresolved', error: 'NO_ATTRIBUTED_COMPLETE_REPLY', effect: lastTurn(current)?.send?.state ?? 'unknown' });
          outcome.blocked++; stop = true;
        } else {
          const answer = assessUserAnswer(item.task, current.reply?.text);
          update(item, { state: 'reply-observed', effect: 'observed', answer: answer.ok ? 'matched' : answer.reason });
        }
      } catch (e) {
        // A thrown exception AFTER send intent is never proof that nothing was dispatched.
        update(item, { state: 'unresolved', error: codeOf(e), effect: 'unknown' });
        outcome.blocked++; stop = true;
      } finally {
        if (conversation) {
          try {
            const finished = await runtime.finish(conversation.id, { closeTab: false });
            const reopened = await runtime.get(conversation.id);
            const sessionId = finished.sessionId ?? null;
            const persisted = !!sessionId && existsSync(path.join(ctx.paths.sessions, sessionId, 'session.json'))
              && reopened.id === conversation.id && finished.diagnostic?.finishPhase === 'done';
            const before = receipt.cases[item.id];
            // Answer success without saved source evidence is NOT a passing end-to-end use case.
            const accepted = before.state === 'reply-observed' && before.answer === 'matched' && persisted;
            const answerFailed = before.state === 'reply-observed' && before.answer !== 'matched' && persisted;
            update(item, { ...before, state: accepted ? 'passed' : answerFailed ? 'answer-failed' : before.state,
              saved: persisted, sessionId, evidenceTier: persisted ? 'real-provider-saved-local' : 'unverified-persistence',
              finishPhase: finished.diagnostic?.finishPhase ?? 'unknown' });
            if (accepted) outcome.passed++;
            else if (answerFailed) outcome.answerFailed++;
            else { stop = true; if (!['unresolved'].includes(before.state)) outcome.blocked++; }
          } catch (e) {
            update(item, { state: 'unresolved', error: 'FINISH_OR_REOPEN_UNVERIFIED', saved: false });
            stop = true; // leave browser and original snapshots intact
          }
        }
      }
      if (stop) { outcome.stoppedOn = item.id; break; }
    }
  } finally {
    await runtime.close().catch(() => {});
  }
  outcome.notAttempted = selected.filter((s) => !receipt.cases[s.id]).length;
  outcome.evidenceTier = outcome.passed || outcome.answerFailed ? 'real-provider-browser-local-receipt' : 'no-live-success-proven';
  ctx.out.emit(outcome, (o) => {
    o.line('Live user scenarios: ' + outcome.passed + ' passed, ' + outcome.answerFailed + ' answer mismatches, ' +
      outcome.blocked + ' blocked, ' + outcome.preserved + ' already fenced, ' + outcome.notAttempted + ' not attempted.');
    o.line('Receipt: ' + receiptFile);
    if (outcome.stoppedOn) o.line('Stopped safely at ' + outcome.stoppedOn + ' (no automatic resend).');
  });
  if (outcome.blocked || outcome.answerFailed || outcome.notAttempted) process.exitCode = EXIT.ENVIRONMENT;
  return outcome;
}

define({
  name: 'live-100', section: 'Knowledge', usage: '[--providers chatgpt,claude,...] [--limit N] [--execute --accept-sends]',
  summary: 'Preview or perform 100 real provider/browser user journeys, with durable no-retry receipts',
  description: 'One command. Twenty useful tasks across ChatGPT, Claude, Gemini, DeepSeek and Z.ai. Uses the existing runtime and dedicated Chrome. Preview sends nothing; live mode explicitly requires --execute --accept-sends and may use provider quota. Stops at an uncertain effect; never resends or opens a second browser actor.',
  flags: {
    providers: { type: 'list', desc: 'Provider ids (default: chatgpt,claude,gemini,deepseek,zai)' },
    limit: { type: 'number', valueName: 'N', desc: 'How many cases to attempt, 1..100 (default 100)' },
    timeout: { type: 'number', valueName: 'SECONDS', default: 150, desc: 'Per-case reply wait, 5..900 seconds' },
    suite: { type: 'string', valueName: 'NAME', default: 'default', desc: 'Durable receipt id; choose a new name for a fresh run' },
    execute: { type: 'boolean', desc: 'Allow real provider/browser effects' },
    'accept-sends': { type: 'boolean', desc: 'Explicitly authorize live sends and quota usage' },
    'dry-run': { type: 'boolean', desc: 'Preview without browser access even with --execute' },
  },
  examples: [
    'studio live-100',
    'studio live-100 --providers chatgpt --limit 3 --execute --accept-sends --suite pilot-01',
    'studio live-100 --execute --accept-sends --suite full-100-01',
  ],
  run: runLiveScenarios,
});
