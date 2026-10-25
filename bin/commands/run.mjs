// Durable harness runs from the CLI: create, step (via the same conversation tools), finish,
// inspect. Each invocation is a separate process — resumability across processes is the point:
// state lives in <data-dir>/harness-runs/<runId>.run.json, never in the process. Steps execute
// through the same conversation runtime and tool validation as the studio server; there is no
// second browser actor here.
import { randomUUID } from 'node:crypto';
import { define, defineGroup } from '../lib/registry.mjs';
import { usageError } from '../lib/ui.mjs';
import { EXIT } from '../../src/config.mjs';
import { createHarnessRunStore } from '../../src/capture/harness-runs.mjs';
import { defaultConversationRuntime } from '../../src/studio/conversation-api.mjs';
import { conversationToolExecutor, HARNESS_RETRYABLE_TOOLS } from '../../src/studio/harness-api.mjs';

defineGroup('run', {
  summary: 'Durable harness runs: persistent task/run identity with a resumable step ledger', section: 'Knowledge', default: 'list',
  description: 'Run state lives in <data-dir>/harness-runs/<runId>.run.json, never in the process, so create/step/finish may happen in different processes. Steps execute the same nine conversation tools through the same runtime owner as the studio server; there is no second browser actor. Aliases: runs.',
  aliases: ['runs'],
});

async function storeFor(ctx) {
  return createHarnessRunStore({ dir: ctx.paths ? ctx.paths.root + '/harness-runs' : undefined, toolExecutor: async () => { throw usageError('This subcommand does not execute steps'); } });
}

async function runCreate(ctx) {
  const { flags, args, out } = ctx;
  const task = flags.task ?? args.join(' ');
  const store = await storeFor(ctx);
  const run = store.create({ task, ...(flags.conversation ? { conversationId: flags.conversation } : {}) });
  out.emit(run, (o) => o.line(`${run.id}  ${run.status}  ${JSON.stringify(run.task.description).slice(0, 80)}`));
}

async function runList(ctx) {
  const { out } = ctx;
  const store = await storeFor(ctx);
  const runs = store.list();
  out.emit({ runs }, (o) => { for (const r of runs) o.line(`${r.id}  ${r.status}  steps=${r.steps}  ${String(r.taskDescription ?? '').slice(0, 60)}`); if (!runs.length) o.line('no runs'); });
}

async function runGet(ctx) {
  const { args } = ctx;
  const { out } = ctx;
  if (!args[0]) throw usageError('Usage: studio run get <runId>');
  const store = await storeFor(ctx);
  const run = store.get(args[0]);
  out.emit(run, (o) => o.line(JSON.stringify(run, null, 2)));
}

async function runStep(ctx) {
  const { args } = ctx;
  const { flags, out } = ctx;
  const runId = args[0];
  if (!runId || !flags.tool) throw usageError('Usage: studio run step <runId> --tool NAME [--arguments JSON] --key KEY [--execute]');
  let argsJson = {};
  if (flags.arguments) {
    try { argsJson = JSON.parse(flags.arguments); } catch { throw usageError('--arguments must be a JSON object'); }
    if (!argsJson || typeof argsJson !== 'object' || Array.isArray(argsJson)) throw usageError('--arguments must be a JSON object');
  }
  const key = flags.key ?? randomUUID();
  const emit = (result) => out.emit(result, (o) => o.line(JSON.stringify(result, null, 2)));
  if (!flags.execute || flags['dry-run']) {
    emit({ dryRun: true, runId, tool: flags.tool, arguments: argsJson, key, browserAction: false,
      note: 'create the run, then --execute this step; the tool executes through the same runtime as the studio server' });
    return;
  }
  const paths = ctx.paths;
  const runtime = await defaultConversationRuntime({ paths, profileStore: ctx.profiles(), familyStore: ctx.families(), port: ctx.port });
  try {
    const store = createHarnessRunStore({ dir: paths.root + '/harness-runs', toolExecutor: conversationToolExecutor(runtime), retryableTools: HARNESS_RETRYABLE_TOOLS });
    const out2 = await store.step(runId, { key, tool: flags.tool, args: argsJson });
    emit({ run: out2.run, step: out2.step, replayed: out2.replayed, ...(out2.replayed ? { note: out2.note } : { result: out2.result }) });
    if (out2.step.status === 'failed') process.exitCode = EXIT.ENVIRONMENT;
  } finally { await runtime.close(); }
}

async function runNote(ctx) {
  const { args } = ctx;
  const { flags, out } = ctx;
  if (!args[0] || !flags.context) throw usageError('Usage: studio run context <runId> --context JSON');
  let context;
  try { context = JSON.parse(flags.context); } catch { throw usageError('--context must be a JSON object'); }
  const store = await storeFor(ctx);
  const run = store.note(args[0], { context });
  out.emit(run, (o) => o.line(JSON.stringify(run, null, 2)));
}

async function runFinish(ctx) {
  const { args } = ctx;
  const { flags, out } = ctx;
  if (!args[0] || !flags.status) throw usageError('Usage: studio run finish <runId> --status succeeded|failed|interrupted');
  const store = await storeFor(ctx);
  const run = store.finish(args[0], { status: flags.status });
  out.emit(run, (o) => o.line(`${run.id}  ${run.status}  steps=${run.steps.length}`));
}

define({
  name: 'run create', section: 'Knowledge', usage: '--task TEXT [--conversation ID]',
  summary: 'Open a durable harness run (persistent task/run identity)',
  description: 'Writes <data-dir>/harness-runs/<runId>.run.json. A run is durable process-independent state: steps can be executed later by other processes or by the studio server tools. No browser action happens here.',
  flags: { task: { type: 'string', valueName: 'TEXT', desc: 'Task description (required unless passed positionally)' },
    conversation: { type: 'string', valueName: 'ID', desc: 'Bind an existing conversation id' } },
  examples: ['studio run create --task "Summarize the captured Duck.ai thread"'],
  run: runCreate,
});
define({
  name: 'run list', section: 'Knowledge', usage: '',
  summary: 'List durable harness runs',
  flags: {},
  run: (ctx) => runList(ctx),
});
define({
  name: 'run get', section: 'Knowledge', usage: '<runId>',
  summary: 'Read one durable harness run with its step ledger',
  flags: {},
  run: runGet,
});
define({
  name: 'run step', section: 'Knowledge', usage: '<runId> --tool NAME [--arguments JSON] --key KEY [--execute]',
  summary: 'Execute one conversation-tool call inside a durable run',
  description: 'Default is an offline dry-run. --execute constructs the conversation runtime and executes the tool through the same validation and runtime owner as the studio server. The durable key replays a recorded success without re-execution; the same key with different arguments is refused. submit_conversation_turn is additionally fenced by the conversation journal.',
  flags: { tool: { type: 'string', valueName: 'NAME', desc: 'One of the nine conversation tools' },
    arguments: { type: 'string', valueName: 'JSON', desc: 'Tool arguments as a JSON object' },
    key: { type: 'string', valueName: 'KEY', desc: 'Caller-owned durable step key (default: generated)' },
    execute: { type: 'boolean', desc: 'Really execute (may act on the connected browser tab)' },
    'dry-run': { type: 'boolean', desc: 'Preview without browser access, even with --execute' } },
  examples: ['studio run step <runId> --tool list_conversations', 'studio run step <runId> --tool read_conversation --arguments \'{"conversation":"<id>"}\' --key read-1 --execute'],
  run: runStep,
});
define({
  name: 'run context', section: 'Knowledge', usage: '<runId> --context JSON',
  summary: 'Merge durable continuation context into a running harness run',
  flags: { context: { type: 'string', valueName: 'JSON', desc: 'JSON object merged into run.context' } },
  run: runNote,
});
define({
  name: 'run finish', section: 'Knowledge', usage: '<runId> --status succeeded|failed|interrupted',
  summary: 'Close a durable harness run; the ledger becomes immutable',
  flags: { status: { type: 'string', valueName: 'STATUS', desc: 'succeeded, failed or interrupted' } },
  run: runFinish,
});
