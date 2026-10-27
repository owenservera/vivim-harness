// One user-facing recipe command dispatches through the ALREADY-RUNNING Studio HTTP hub.
// Discovery/plan operate offline. Run/status/reconcile reuse the hub's single effect owner.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { define, defineGroup } from '../lib/registry.mjs';
import { usageError, CliError } from '../lib/ui.mjs';
import { EXIT } from '../../src/config.mjs';
import { createStudioToolClient } from '../../src/studio/tool-client.mjs';
import { listRecipes, recipeDefinition, RECIPE_FAMILIES } from '../../src/recipes/catalog.mjs';
import { planRecipe } from '../../src/recipes/plan.mjs';
import { chooseRecipe } from '../../src/recipes/choose.mjs';

const shared = {
  'studio-port': { type: 'number', valueName: 'PORT', desc: 'Existing Studio HTTP port (default configured port)' },
  timeout: { type: 'number', valueName: 'SECONDS', default: 60, desc: 'One request, 1..60 seconds; no retries' },
};
const inputFlag = { input: { type: 'string', valueName: 'FILE|-', desc: 'Private JSON object file or stdin (default empty object)' } };
const emit = (ctx, result) => ctx.out.emit(result, (o) => o.line(JSON.stringify(result, null, 2)));
function inputOf(ctx) {
  if (!ctx.flags.input) return {};
  let data;
  try {
    data = JSON.parse(readFileSync(ctx.flags.input === '-' ? 0 : ctx.flags.input, 'utf8'));
  } catch { throw usageError('Recipe input must be a readable JSON object; no private input is printed.'); }
  if (!data || Array.isArray(data) || typeof data !== 'object') throw usageError('Recipe input must be one JSON object.');
  return data;
}
async function callStudio(ctx, method, route, body) {
  const timeout = ctx.flags.timeout ?? 60;
  const port = ctx.flags['studio-port'] ?? ctx.settings.studioPort;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60)
    throw usageError('Timeout must be 1..60 seconds.');
  let client;
  try {
    client = createStudioToolClient({ port, timeoutMs: timeout * 1000,
      ...(process.env.CAPTURE_STUDIO_TOKEN ? { token: process.env.CAPTURE_STUDIO_TOKEN } : {}) });
    return await client.recipeRequest(method, route === '/status' ? '/api/status' : '/api/v1' + route, body);
  } catch (error) {
    const code = /^[A-Z][A-Z0-9_]{0,79}$/.test(error?.code ?? '') ? error.code : 'STUDIO_CLIENT_ERROR';
    throw new CliError(code, { exit: EXIT.ENVIRONMENT, code,
      details: { httpStatus: Number.isInteger(error?.status) ? error.status : null,
        effect: error?.effect === 'unknown' ? 'unknown' : 'none', retry: false } });
  }
}
function only(ctx, count, usage) {
  if (ctx.args.length !== count) throw usageError('Usage: studio ' + usage);
}

export async function runRecipeList(ctx) {
  if (ctx.args.length) throw usageError('Usage: studio recipe list [--family NAME]');
  const family = ctx.flags.family;
  if (family && !RECIPE_FAMILIES.includes(family)) throw usageError('Unknown recipe family: ' + family);
  emit(ctx, { schema: 'vivim.recipe-catalog/1', families: RECIPE_FAMILIES, recipes: listRecipes(family ? { family } : {}) });
}
export async function runRecipeShow(ctx) {
  only(ctx, 1, 'recipe show FAMILY.NAME');
  const recipe = recipeDefinition(ctx.args[0]);
  if (!recipe) throw usageError('Unknown recipe: ' + ctx.args[0]);
  emit(ctx, recipe);
}
export async function runRecipeChoose(ctx) {
  only(ctx, 0, 'recipe choose --intent TEXT');
  if (!ctx.flags.intent) throw usageError('Provide an intent with --intent TEXT.');
  emit(ctx, chooseRecipe(ctx.flags.intent, { ...(ctx.flags.family ? { family: ctx.flags.family } : {}) }));
}
export async function runRecipePlan(ctx) {
  only(ctx, 1, 'recipe plan FAMILY.NAME [--input FILE]');
  emit(ctx, planRecipe(ctx.args[0], inputOf(ctx), {
    execute: !!ctx.flags.execute, authorizeSend: !!ctx.flags['authorize-send'],
  }));
}
export async function runRecipeExecute(ctx, dependencies = {}) {
  only(ctx, 1, 'recipe run FAMILY.NAME [--input FILE] [--execute] [--authorize-send]');
  const id = ctx.args[0], input = inputOf(ctx);
  const plan = planRecipe(id, input, {
    execute: !!ctx.flags.execute, authorizeSend: !!ctx.flags['authorize-send'],
  });
  if (ctx.flags['dry-run'] || !plan.ready) {
    emit(ctx, { ...plan, dryRun: true, browserAction: false, providerSends: 0 });
    return;
  }
  const request = { input, execute: !!ctx.flags.execute, authorizeSend: !!ctx.flags['authorize-send'],
    ...(ctx.flags.operation ? { operationId: ctx.flags.operation } : {}),
    includeContent: !!ctx.flags['include-content'] };
  emit(ctx, await (dependencies.request ?? callStudio)(ctx, 'POST', '/recipes/' + encodeURIComponent(id) + '/run', request));
}
export async function runRecipeStatus(ctx, dependencies = {}) {
  only(ctx, 1, 'recipe status RUN_ID');
  emit(ctx, await (dependencies.request ?? callStudio)(ctx, 'GET', '/recipes/runs/' + encodeURIComponent(ctx.args[0])));
}
export async function runRecipeReconcile(ctx, dependencies = {}) {
  only(ctx, 1, 'recipe reconcile RUN_ID [--key ORIGINAL_STEP_KEY]');
  const request = dependencies.request ?? callStudio;
  const runId = encodeURIComponent(ctx.args[0]);
  let key = ctx.flags.key;
  if (!key) {
    const current = await request(ctx, 'GET', '/recipes/runs/' + runId);
    key = current.lastStep?.key;
  }
  if (!key) throw usageError('No original step key to reconcile. Supply --key.');
  emit(ctx, await request(ctx, 'POST', '/recipes/runs/' + runId + '/reconcile', { stepKey: key }));
}
export async function runRecipeFinish(ctx, dependencies = {}) {
  only(ctx, 1, 'recipe finish RUN_ID --status succeeded|failed|interrupted');
  if (!['succeeded', 'failed', 'interrupted'].includes(ctx.flags.status)) throw usageError('Choose --status succeeded|failed|interrupted.');
  emit(ctx, await (dependencies.request ?? callStudio)(ctx, 'POST', '/recipes/runs/' + encodeURIComponent(ctx.args[0]) + '/finish', { status: ctx.flags.status }));
}
export async function runAgentCapabilities(ctx) {
  only(ctx, 0, 'agent capabilities');
  emit(ctx, { schema: 'vivim.agent-capabilities/1', recipes: listRecipes().length,
    transport: 'running-studio', browserAccountState: 'unknown-not-probed',
    source: 'static-native-tool-catalog', noBackgroundEffects: true,
    families: RECIPE_FAMILIES, canonicalCommand: 'studio recipe' });
}
export async function runAgentStatus(ctx, dependencies = {}) {
  only(ctx, 0, 'agent status');
  // The running server, not the current CLI checkout, is authoritative for the data root.
  // This call reads the EXISTING owner's status; never launches Chrome or a competing runtime.
  const status = await (dependencies.request ?? callStudio)(ctx, 'GET', '/status');
  const dataDir = typeof status.dataDir === 'string' ? status.dataDir : null;
  emit(ctx, { studio: 'reachable', version: status.version ?? null,
    studioPort: ctx.flags['studio-port'] ?? ctx.settings.studioPort,
    dataDir, chromeProfile: dataDir ? path.join(dataDir, 'chrome-profile') : null,
    cdpPort: status.cdpPort ?? null, chromeReachable: !!status.chrome,
    browserProfileVerified: 'not-proven-by-status',
    browserAccountState: 'unverified', recipeDiscovery: 'studio recipe list' });
}

defineGroup('recipe', { section: 'Knowledge', default: 'list',
  summary: 'Discover, plan, execute and safely reconcile agent recipes using Studio native tools' });
defineGroup('agent', { section: 'Get started', default: 'capabilities',
  summary: 'Agent capability discovery and running Studio status' });
define({ name: 'recipe list', noData: true, section: 'Knowledge', summary: 'List available recipe contracts without opening Chrome',
  flags: { family: { type: 'string', valueName: 'NAME', desc: 'Filter by recipe family' } }, run: runRecipeList });
define({ name: 'recipe show', noData: true, section: 'Knowledge', usage: 'FAMILY.NAME', summary: 'Read the exact tool, schema, effects and guard rules',
  run: runRecipeShow });
define({ name: 'recipe choose', noData: true, section: 'Knowledge', summary: 'Suggest recipes from intent text; no side effects or authorization',
  flags: { intent: { type: 'string', valueName: 'TEXT', desc: 'User goal; suggestion only, no send' },
    family: { type: 'string', valueName: 'NAME', desc: 'Optional recipe family' } },
  run: runRecipeChoose });
define({ name: 'recipe plan', noData: true, section: 'Knowledge', usage: 'FAMILY.NAME [--input FILE]', summary: 'Validate typed inputs and effects without side effects',
  flags: { ...inputFlag, execute: { type: 'boolean' }, 'authorize-send': { type: 'boolean' } }, run: runRecipePlan });
define({ name: 'recipe run', section: 'Knowledge', usage: 'FAMILY.NAME [--input FILE] [--execute] [--authorize-send]',
  summary: 'Invoke a real native tool through the running Studio harness, with durable effect fencing',
  description: 'Read-only recipes run normally. Mutations require --execute, provider sends also require --authorize-send. Same operation ID cannot dispatch twice. Default output is metadata-only; private output must be explicitly requested.',
  flags: { ...shared, ...inputFlag,
    execute: { type: 'boolean', desc: 'Authorize local/browser mutations' },
    'authorize-send': { type: 'boolean', desc: 'Authorize one real provider send; account quota may be used' },
    'dry-run': { type: 'boolean', desc: 'Always preview, never perform browser effects' },
    operation: { type: 'string', valueName: 'ID', desc: 'Caller-owned stable effect ID for non-send mutations' },
    'include-content': { type: 'boolean', desc: 'Explicitly return private source content from read-only results' } },
  examples: ['studio recipe run provider.targets --json',
    'studio recipe run conversation.continue --input turn.json --execute --authorize-send --json'],
  run: runRecipeExecute });
define({ name: 'recipe status', section: 'Knowledge', usage: 'RUN_ID', summary: 'Read durable recipe run status (no browser effects)',
  flags: shared, run: runRecipeStatus });
define({ name: 'recipe reconcile', section: 'Knowledge', usage: 'RUN_ID [--key ORIGINAL_KEY]',
  summary: 'Inspect original uncertain send/journal without resending',
  flags: { ...shared, key: { type: 'string', valueName: 'KEY', desc: 'Original step key (defaults to latest)' } }, run: runRecipeReconcile });
define({ name: 'recipe finish', section: 'Knowledge', usage: 'RUN_ID --status STATUS',
  summary: 'Finalize durable run status after inspecting actual evidence',
  flags: { ...shared, status: { type: 'string', valueName: 'STATUS' } }, run: runRecipeFinish });
define({ name: 'agent capabilities', noData: true, section: 'Get started', summary: 'Read registered agent capabilities without probing accounts',
  run: runAgentCapabilities });
define({ name: 'agent status', noData: true, section: 'Get started', summary: 'Read running Studio health without browser effects',
  flags: shared, run: runAgentStatus });
