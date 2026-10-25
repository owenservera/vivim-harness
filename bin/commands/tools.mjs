// Existing CLI -> owned running Studio HTTP dispatcher. Never starts Studio or a browser runtime.
import { readFileSync } from 'node:fs';
import { define, defineGroup } from '../lib/registry.mjs';
import { usageError, CliError } from '../lib/ui.mjs';
import { EXIT } from '../../src/config.mjs';
import { createStudioToolClient } from '../../src/studio/tool-client.mjs';

const clientFlags = {
  'studio-port': { type: 'number', valueName: 'PORT', desc: 'Running loopback Studio port (default: configured studioPort)' },
  timeout: { type: 'number', default: 10, valueName: 'SECONDS', desc: 'HTTP deadline 1–60 seconds; never retries' },
};
function connect(ctx, dependencies) {
  const seconds = ctx.flags.timeout ?? 10;
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 60) throw usageError('timeout must be 1–60 seconds');
  const env = dependencies.env ?? process.env;
  return (dependencies.client ?? createStudioToolClient)({ port: ctx.flags['studio-port'] ?? ctx.settings.studioPort,
    timeoutMs: seconds * 1000, ...(env.CAPTURE_STUDIO_TOKEN ? { token: env.CAPTURE_STUDIO_TOKEN } : {}) });
}
const emit = (ctx, result) => ctx.out.emit(result, (out) => out.line(JSON.stringify(result, null, 2)));
async function execute(run) {
  try { return await run(); }
  catch (error) {
    const code = /^[A-Z][A-Z0-9_]{0,79}$/.test(error?.code ?? '') ? error.code : 'STUDIO_CLIENT_ERROR';
    throw new CliError(code, { exit: EXIT.ENVIRONMENT, code,
      details: { httpStatus: Number.isInteger(error?.status) ? error.status : null,
        effect: error?.effect === 'unknown' ? 'unknown' : 'none', retry: false } });
  }
}
const metadataOnly = (value) => Array.isArray(value) ? value.map(metadataOnly) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).filter(([key]) => !['text', 'prompt', 'title', 'content'].includes(key)).map(([key, child]) => [key, metadataOnly(child)])) : value;

export async function runToolsList(ctx, dependencies = {}) {
  if (ctx.args.length) throw usageError('Usage: studio tools list');
  emit(ctx, await execute(() => connect(ctx, dependencies).list()));
}
export async function runToolsCall(ctx, dependencies = {}) {
  if (ctx.args.length !== 1) throw usageError('Usage: studio tools call <tool> --input <file|->');
  const input = ctx.flags.input ?? '-';
  let args;
  try { args = JSON.parse((dependencies.readInput ?? ((file) => readFileSync(file === '-' ? 0 : file, 'utf8')))(input)); }
  catch { throw usageError('Input must contain one JSON arguments object; private input is not echoed'); }
  const result = await execute(() => connect(ctx, dependencies).call(ctx.args[0], args));
  emit(ctx, ctx.flags['include-content'] ? result : metadataOnly(result));
}

defineGroup('tools', { section: 'System', default: 'list', summary: 'Use the running same-owner Studio integration tools over loopback HTTP',
  description: 'No new server, runtime, CDP driver or MCP actor. CAPTURE_STUDIO_TOKEN optionally supplies the running server token. Capability registration is not account availability.' });
define({ name: 'tools list', section: 'System', noData: true, flags: clientFlags,
  summary: 'List the running Studio conversation tool registrations (no browser action)', run: runToolsList });
define({ name: 'tools call', section: 'System', noData: true, usage: '<tool> --input <file|->',
  summary: 'Invoke one registered conversation tool on the running Studio; never retry',
  description: 'Arguments come from private local JSON file/stdin. Send requires its own confirm:true, key and expectedRevision; none are invented. Output omits private bodies/titles by default; --include-content explicitly returns them to this local caller. HTTP timeout means inspect/reconcile, NEVER automatic resend.',
  flags: { ...clientFlags, input: { type: 'string', valueName: 'FILE|-', desc: 'JSON arguments file, or stdin (default -)' },
    'include-content': { type: 'boolean', desc: 'Explicitly include private reply text/title content in the local command result' } },
  examples: ['studio tools list --json', 'studio tools call conversation_targets --input request.json --json'], run: runToolsCall });
