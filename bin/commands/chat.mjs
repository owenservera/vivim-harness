// A one-shot lifecycle, not an alternate browser driver or a persistent recorder daemon.
import { randomUUID } from 'node:crypto';
import { define } from '../lib/registry.mjs';
import { usageError } from '../lib/ui.mjs';
import { EXIT } from '../../src/config.mjs';
import { defaultConversationRuntime, validateConversationBody } from '../../src/studio/conversation-api.mjs';

export async function runChat(ctx, { factory = defaultConversationRuntime, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now } = {}) {
  const { flags, args, out } = ctx;
  if (args.length !== 1) throw usageError('Usage: studio chat <site> --prompt TEXT [--execute]');
  const connect = validateConversationBody('connect', { site: args[0], ...(flags.target ? { targetId: flags.target } : {}), freshTab: flags.fresh ?? !flags.target });
  if (connect.freshTab && connect.targetId || !connect.freshTab && !connect.targetId) throw usageError('Choose either --target ID or a fresh tab, not both');
  const prompt = flags.prompt;
  const timeout = flags.timeout ?? 120;
  if (!Number.isFinite(timeout) || timeout < 1 || timeout > 900) throw usageError('timeout must be between 1 and 900 seconds');
  validateConversationBody('submit', { key: 'validation-only', prompt, confirm: true, expectedRevision: 0 });
  const emit = (result) => out.emit(result, (o) => o.line(JSON.stringify(result, null, 2)));
  if (!flags.execute || flags['dry-run']) {
    // Do not construct the runtime: even target discovery is forbidden in the default preview.
    emit({ dryRun: true, site: connect.site, targetId: connect.targetId ?? null, freshTab: connect.freshTab ?? false, promptChars: prompt.length, timeoutSeconds: timeout, action: 'connect-submit-poll-finish', browserAction: false });
    return;
  }
  const runtime = await factory({ paths: ctx.paths, profileStore: ctx.profiles(), familyStore: ctx.families(), port: ctx.port });
  let conversation, finalized = false;
  try {
    conversation = await runtime.connect(connect);
    conversation = await runtime.submit(conversation.id, { key: randomUUID(), prompt, confirm: true, expectedRevision: conversation.revision });
    const deadline = now() + timeout * 1000;
    const terminal = (c) => ['ready', 'failed'].includes(c.reply?.state)
      || ['blocked', 'needs-reconciliation', 'closed'].includes(c.state)
      || ['blocked', 'uncertain', 'needs-reconciliation'].includes(c.turn?.phase)
      || ['uncertain', 'not-sent', 'failed'].includes(c.turn?.send?.state);
    while (now() < deadline && !terminal(conversation)) {
      await sleep(Math.min(500, Math.max(0, deadline - now())));
      conversation = await runtime.get(conversation.id);
    }
    const timedOut = now() >= deadline && !terminal(conversation);
    const stopped = { state: conversation.state, phase: conversation.turn?.phase, send: conversation.turn?.send?.state };
    // Never close a tab here, particularly after an uncertain send. Never retry dispatch.
    finalized = true;
    conversation = await runtime.finish(conversation.id, { closeTab: false });
    const error = ['blocked', 'needs-reconciliation'].includes(stopped.state) || ['blocked', 'uncertain', 'needs-reconciliation'].includes(stopped.phase)
      || ['uncertain', 'not-sent', 'failed'].includes(stopped.send)
      ? { code: stopped.phase === 'blocked' || stopped.state === 'blocked' ? 'TURN_BLOCKED' : 'TURN_NOT_CONFIRMED', ...stopped }
      : timedOut ? { code: 'LOCAL_WAIT_TIMEOUT' } : null;
    emit({ conversation, timedOut, error, resent: false, tabCloseRequested: false });
    if (error) process.exitCode = EXIT.ENVIRONMENT;
  } finally {
    try {
      if (conversation && !finalized) await runtime.finish(conversation.id, { closeTab: false });
    } finally { await runtime.close(); }
  }
}

define({
  name: 'chat', section: 'Knowledge', usage: '<site> --prompt TEXT [--execute] [--timeout S]',
  summary: 'Preview, or explicitly send one conversation turn and finish its capture',
  description: 'Default is an offline dry-run. --execute connects, submits once, polls local snapshots for a bounded time, and finishes recording without closing the tab. No retries or persistent CLI recorder.',
  flags: {
    prompt: { type: 'string', valueName: 'TEXT', desc: 'Required prompt, at most 250000 characters' },
    execute: { type: 'boolean', desc: 'Confirm one real website send (may consume account quota)' },
    'dry-run': { type: 'boolean', desc: 'Preview without browser access, even with --execute' },
    timeout: { type: 'number', default: 120, valueName: 'SECONDS', desc: 'Local polling budget, 1–900 seconds' },
    target: { type: 'string', valueName: 'ID', desc: 'Bind an existing target id' },
    fresh: { type: 'boolean', desc: 'Request a new Studio-owned tab' },
  },
  examples: ['studio chat chatgpt --prompt "Hello"', 'studio chat chatgpt --prompt "Hello" --execute --json'],
  run: runChat,
});
