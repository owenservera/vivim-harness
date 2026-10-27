// Recipe-facing orchestration over the ONE existing Studio harness API.
// No independent CDP, provider sender, parser or persistent run store.
import { randomUUID } from 'node:crypto';
import { listRecipes, recipeDefinition } from './catalog.mjs';
import { planRecipe } from './plan.mjs';
import { summarizeResult, argsDigestOf } from '../capture/harness-runs.mjs';
import { executeConversationTool } from '../studio/conversation-tools.mjs';
import { metadataOnly } from '../studio/tool-result.mjs';

const fail = (status, code) => Object.assign(new Error(code), { status, code });
const validOperation = (v) => typeof v === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,99}$/.test(v);
const toView = (r) => {
  const step = r.steps?.at(-1) ?? null;
  const open = r.status === 'running';
  return { runId: r.id, status: r.status, conversationId: r.conversationId ?? null,
    lastStep: step ? { key: step.key, tool: step.tool, status: step.status, summary: step.summary ?? null } : null,
    retryAllowed: false,
    nextSafeAction: !open ? 'none' : step?.status === 'uncertain' || step?.status === 'in_flight'
      ? 'reconcile-original-step' : step?.status === 'failed' ? 'inspect-failure'
        : 'inspect-conversation-and-close-run' };
};

export function createRecipeService({ harnessApi, conversationRuntime } = {}) {
  if (!harnessApi || !conversationRuntime) throw fail(503, 'RECIPE_OWNER_UNAVAILABLE');
  const status = (runId) => {
    const run = harnessApi.get(runId).run;
    const label = /^recipe:([a-z]+\\.[a-z-]+):operation:([a-zA-Z0-9][a-zA-Z0-9_.:-]{0,99})$/.exec(run.task?.description ?? '');
    if (!label || !recipeDefinition(label[1])) throw fail(404, 'RECIPE_RUN_NOT_FOUND');
    return { schema: 'vivim.recipe-run/1', recipe: label[1], ...toView(run) };
  };
  return {
    list(family) { return { schema: 'vivim.recipe-catalog/1', recipes: listRecipes(family ? { family } : {}) }; },
    show(id) { const recipe = recipeDefinition(id); if (!recipe) throw fail(404, 'RECIPE_NOT_FOUND'); return recipe; },
    plan(id, input, flags = {}) { return planRecipe(id, input, flags); },
    status,
    async run(id, input = {}, { execute = false, authorizeSend = false, operationId, includeContent = false } = {}) {
      const plan = planRecipe(id, input, { execute, authorizeSend });
      if (!plan.ready) throw fail(428, 'RECIPE_AUTHORIZATION_REQUIRED');
      const recipe = recipeDefinition(id);
      // Only stored run intent + native journal fence authorize effects. No retry of a prior
      // operation even after an HTTP timeout, crash, failed call or unknown browser response.
      const effectful = recipe.effects.some((e) => e !== 'read');
      // Read-only agent observation is stateless. It must NOT consume scarce durable run
      // slots (the native harness store is finite) or create pretend effect receipts.
      // Reuse exactly the native validated dispatcher and current runtime owner.
      if (!effectful) {
        const result = await executeConversationTool(conversationRuntime, recipe.tool, input);
        return {
          schema: 'vivim.recipe-run/1', recipe: id, status: 'succeeded', runId: null,
          persisted: false, tool: recipe.tool, retryAllowed: true, nextSafeAction: 'none',
          effectState: 'none', evidenceTier: 'runtime-read',
          result: includeContent ? result : metadataOnly(result),
        };
      }
      const identity = operationId ?? (recipe.effects.includes('provider-send') ? input.key : null);
      if (recipe.effects.includes('provider-send') && operationId !== undefined && operationId !== input.key)
        throw fail(409, 'RECIPE_SEND_OPERATION_MISMATCH');
      if (effectful && !validOperation(identity)) throw fail(400, 'RECIPE_OPERATION_REQUIRED');
      const op = identity ?? randomUUID();
      const task = 'recipe:' + id + ':operation:' + op;
      // A duplicate attempt must discover its ORIGINAL run even after the native revision
      // advanced. Check once before any browser read, then again immediately before create
      // (no await between the second check and create, so concurrent requests cannot race).
      const prior = () => {
        const existing = harnessApi.list().runs.find((r) => r.taskDescription === task);
        if (!existing) return null;
        const saved = harnessApi.get(existing.id).run;
        const last = saved.steps.at(-1);
        const originalDigest = saved.context?.recipeIntentDigest
          ?? (!recipe.autoRevision ? last?.argsDigest : null);
        if (!originalDigest) throw fail(409, 'RECIPE_ORIGINAL_INTENT_UNVERIFIED');
        if (originalDigest !== argsDigestOf(input)) throw fail(409, 'RECIPE_OPERATION_CONFLICT');
        return { ...status(existing.id), existing: true,
          nextSafeAction: 'inspect-existing-run-no-retry', note: 'Existing operation preserved; no tool call was attempted.' };
      };
      const found = prior();
      if (found) return found;
      let nativeArgs = input;
      if (recipe.effects.includes('provider-send')) {
        const current = await conversationRuntime.get(input.conversation);
        if (!Number.isSafeInteger(current.revision) || current.revision < 0)
          throw fail(409, 'RECIPE_REVISION_UNAVAILABLE');
        if (current.state === 'closed' || current.identity?.state !== 'bound' || current.recovery?.pending)
          throw fail(409, 'RECIPE_THREAD_NOT_WRITABLE');
        if (!recipe.autoRevision && current.revision !== input.expectedRevision)
          throw fail(409, 'RECIPE_REVISION_CHANGED');
        if (recipe.autoRevision)
          nativeArgs = { ...input, expectedRevision: current.revision, confirm: true };
      }
      const raced = prior();
      if (raced) return raced;
      const created = harnessApi.create({ task, ...(input.conversation ? { conversationId: input.conversation } : {}) }).run;
      const key = recipe.effects.includes('provider-send') ? input.key : 'recipe-step:' + op;
      try {
        // Store only a cryptographic digest of the caller intent before any provider effect.
        // The native step can have hydrated revision/confirm fields without confusing replay.
        harnessApi.note(created.id, { context: { recipeIntentDigest: argsDigestOf(input),
          recipeVersion: recipe.version } });
        const result = await harnessApi.step(created.id, { key, tool: recipe.tool, arguments: nativeArgs });
        if (result.step?.status !== 'succeeded') throw fail(409, 'RECIPE_STEP_NOT_VERIFIED');
        // The harness step being recorded is not enough to claim a provider reply or local
        // capture acceptance. Reads can finish immediately; mutations remain inspectable.
        if (!effectful) harnessApi.finish(created.id, { status: 'succeeded' });
        const latest = status(created.id);
        return { ...latest, recipe: id, operationId: op, effectState: effectful ? 'tool-completed-outcome-unverified' : 'none',
          evidenceTier: effectful ? 'runtime-step-receipt' : 'runtime-read',
          ...(includeContent ? { result: result.result ?? null } : { resultSummary: summarizeResult(result.result) }) };
      } catch (error) {
        // Do not throw away the only known run identifier when a send may have occurred.
        const current = status(created.id);
        return { ...current, recipe: id, operationId: op, errorCode: /^[A-Z][A-Z0-9_]{0,79}$/.test(error?.code ?? '')
          ? error.code : 'RECIPE_EFFECT_UNKNOWN', effectState: 'unknown',
          evidenceTier: 'unverified', retryAllowed: false,
          nextSafeAction: 'inspect-existing-run-no-retry' };
      }
    },
    reconcile(runId, stepKey) {
      const run = harnessApi.get(runId).run;
      status(runId); // Validated recipe run identity, not just a spoofed task prefix.
      const step = run.steps.find((s) => s.key === stepKey);
      if (!step) throw fail(404, 'RECIPE_STEP_NOT_FOUND');
      if (step.tool !== 'submit_conversation_turn')
        return { ...status(runId), reconciliation: { verdict: 'not-applicable', reason: 'Only send steps have journal-effect reconciliation' }, dispatched: false };
      const result = harnessApi.reconcileStep(runId, stepKey);
      return { ...status(runId), reconciliation: result.reconciliation, lifecycle: result.lifecycle, dispatched: false,
        retryAllowed: false, nextSafeAction: 'inspect-reconciliation-evidence' };
    },
    async finish(runId, state) {
      if (!['succeeded', 'failed', 'interrupted'].includes(state)) throw fail(400, 'INVALID_RUN_STATUS');
      const prior = status(runId);
      if (state === 'succeeded') {
        const run = harnessApi.get(runId).run;
        const recipe = recipeDefinition(prior.recipe);
        const step = run.steps.at(-1);
        if (!recipe || step?.status !== 'succeeded' || step.tool !== recipe.tool)
          throw fail(409, 'RECIPE_COMPLETION_UNVERIFIED');
        if (recipe.effects.includes('provider-send')) {
          if (!run.conversationId) throw fail(409, 'RECIPE_COMPLETION_UNVERIFIED');
          const snapshot = await conversationRuntime.get(run.conversationId);
          const turn = snapshot.turns?.find((t) => t.key === step.key);
          // A registered submit != a delivered reply. The exact original turn must have
          // observed delivery, an attributable ready reply and proven final capture stop.
          if (!turn || turn.send?.state !== 'observed' || turn.reply?.state !== 'ready'
            || turn.readiness?.state !== 'ready' || !snapshot.sessionId
            || snapshot.diagnostic?.finishPhase !== 'done')
            throw fail(409, 'RECIPE_COMPLETION_UNVERIFIED');
        }
      }
      const out = harnessApi.finish(runId, { status: state });
      return { ...prior, ...toView(out.run) };
    },
    capabilities() {
      return { schema: 'vivim.agent-capabilities/1',
        owner: 'running-studio', recipeTransport: 'studio-tool', recipeCount: listRecipes().length,
        source: 'registered-tools-not-provider-auth',
        providerAccounts: 'unknown', browserOwned: 'unverified-by-this-read',
        effects: ['read', 'local-write', 'provider-send'], sendRequires: ['execute', 'provider-send', 'original-key'],
        retryPolicy: 'never-auto-retry-unknown-effect' };
    },
  };
}
