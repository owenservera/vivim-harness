// Expose agent recipes through the already-running Studio integration hub.
// All work is delegated to its existing conversation runtime + durable harness API.
import { createRecipeService } from '../recipes/service.mjs';
import { chooseRecipe } from '../recipes/choose.mjs';
import { problem } from './http.mjs';

const str = { type: 'string' };
const boolean = { type: 'boolean' };
const bodySchema = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const idParam = { recipe: { type: 'string', minLength: 3, maxLength: 100, pattern: '^[a-z]+\\.[a-z-]+$' } };
const runParam = { run: { type: 'string', minLength: 10, maxLength: 64, pattern: '^[a-f0-9-]{10,64}$' } };
const fail = (e) => { if (e.code === 'UNKNOWN_RECIPE_FAMILY') throw problem(400, e.message, e.code); throw e; };

export function registerRecipeRoutes({ add, harnessApi, conversationRuntime } = {}) {
  if (!harnessApi || !conversationRuntime) return null;
  const recipes = createRecipeService({ harnessApi, conversationRuntime });
  const request = bodySchema({
    input: { type: 'object', additionalProperties: true },
    execute: boolean, authorizeSend: boolean, operationId: str, includeContent: boolean,
  }, ['input']);
  add('GET', '/agent/capabilities', 'Inspect declared agent recipe capabilities without browser effects',
    () => recipes.capabilities(), { tool: 'agent_capabilities', annotations: { readOnlyHint: true, openWorldHint: false } });
  add('GET', '/recipes', 'List versioned available recipe definitions (registration is not live account availability)',
    ({ q }) => { try { return recipes.list(q.family); } catch (e) { return fail(e); } },
    { query: { family: str }, tool: 'recipe_list', annotations: { readOnlyHint: true, openWorldHint: false } });
  // Intent text can contain private user context: accept it in a POST body, never a URL
  // query string (which commonly persists in server access logs).
  add('POST', '/recipes/choose', 'Suggest compatible recipes from private intent text without executing',
    ({ body }) => { try { return chooseRecipe(body.intent, { ...(body.family ? { family: body.family } : {}) }); }
      catch (e) { return fail(e); } },
    { body: bodySchema({ intent: str, family: str }, ['intent']), tool: 'recipe_choose',
      annotations: { readOnlyHint: true, openWorldHint: false } });
  add('GET', '/recipes/{recipe}', 'Read one supported recipe contract; no browser effects',
    ({ p }) => recipes.show(p.recipe), { pathParameters: idParam, tool: 'recipe_show',
      annotations: { readOnlyHint: true, openWorldHint: false } });
  add('POST', '/recipes/{recipe}/plan', 'Validate recipe inputs and explicit effect authorizations without performing effects',
    ({ p, body }) => recipes.plan(p.recipe, body.input, { execute: body.execute, authorizeSend: body.authorizeSend }),
    { pathParameters: idParam, body: request, tool: 'recipe_plan',
      annotations: { readOnlyHint: true, openWorldHint: false } });
  add('POST', '/recipes/{recipe}/run', 'Use existing Studio harness run/step owner; no duplicate browser actor or automatic resend',
    ({ p, body }) => recipes.run(p.recipe, body.input, { execute: body.execute, authorizeSend: body.authorizeSend,
      operationId: body.operationId, includeContent: body.includeContent }),
    { pathParameters: idParam, body: request, tool: 'recipe_run',
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: true } });
  add('GET', '/recipes/runs/{run}', 'Read durable recipe run/step state without recovery effects',
    ({ p }) => recipes.status(p.run), { pathParameters: runParam, tool: 'recipe_run_status',
      annotations: { readOnlyHint: true, openWorldHint: false } });
  add('POST', '/recipes/runs/{run}/reconcile', 'Read-only reconciliation of original uncertain send; never resends',
    ({ p, body }) => recipes.reconcile(p.run, body.stepKey), {
      pathParameters: runParam,
      body: bodySchema({ stepKey: { type: 'string', minLength: 1, maxLength: 200 } }, ['stepKey']),
      tool: 'recipe_reconcile', annotations: { readOnlyHint: true, openWorldHint: false },
    });
  add('POST', '/recipes/runs/{run}/finish', 'Explicitly finalize one existing durable recipe run status',
    ({ p, body }) => recipes.finish(p.run, body.status), {
      pathParameters: runParam,
      body: bodySchema({ status: { type: 'string', enum: ['succeeded', 'failed', 'interrupted'] } }, ['status']),
      tool: 'recipe_finish', annotations: { readOnlyHint: false, openWorldHint: false },
    });
  return recipes;
}
