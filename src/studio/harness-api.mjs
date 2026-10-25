// Harness run surfaces over the EXISTING runtime owner: one durable run identity per task, with
// steps executed through the same conversation tools and the same conversation runtime that serve
// every other client. No second browser actor, no second evidence store, no new write path.
import { problem } from './http.mjs';
import { CONVERSATION_TOOLS, executeConversationTool, validateConversationTool } from './conversation-tools.mjs';
import { withDispatchPreflight } from './harness-executor-preflight.mjs';
import { reconcileUncertainStep } from './uncertain-step-reconciler.mjs';
import { reconcileLifecycle } from './core-runtime-bridge.mjs';
import { argsDigestOf } from '../capture/harness-runs.mjs';

// Same-key retry after a PROVEN not-dispatched failure is allowed only for tools the registry
// itself marks read-only. The policy is derived from the single tool surface — never hand-maintained
// here — so a future read-only tool is automatically covered and an effectful tool can never slip in.
export const HARNESS_RETRYABLE_TOOLS = Object.freeze(
  CONVERSATION_TOOLS.filter((t) => t.annotations?.readOnlyHint === true).map((t) => t.name));

const str = { type: 'string' };
const objectSchema = (properties = {}, required = []) => ({ type: 'object', properties, ...(required.length ? { required } : {}) });
const runBody = objectSchema({
  task: { oneOf: [{ ...str, minLength: 1, maxLength: 2000 }, objectSchema({ description: { ...str, minLength: 1, maxLength: 2000 } }, ['description'])] },
  conversationId: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$' },
}, ['task']);
const stepBody = objectSchema({
  key: { ...str, minLength: 1, maxLength: 200 },
  tool: { type: 'string', enum: CONVERSATION_TOOLS.map((t) => t.name) },
  arguments: { type: 'object', default: {} },
}, ['key', 'tool']);
const finishBody = objectSchema({ status: { type: 'string', enum: ['succeeded', 'failed', 'interrupted'] } }, ['status']);
const noteBody = objectSchema({ context: { type: 'object' } }, ['context']);

const runView = (run) => ({ ...run });

export function createHarnessApi({ runs, intentBindings = null, conversationRuntime = null } = {}) {
  if (!runs) return null;
  // Round 7 seam: submit steps get a durable pre-effect intent binding recorded BEFORE the store
  // dispatches, and completed with the OBSERVED journal turn identity after the executor returns.
  // A crash between the two leaves an incomplete binding, which the read-only reconcile query
  // honestly classifies as still_unknown — never a guess, never a resend authorization.
  const recordSubmitIntent = (runId, body) => {
    if (!intentBindings || !conversationRuntime || body.tool !== 'submit_conversation_turn') return null;
    const conversationId = body.arguments?.conversation;
    if (typeof conversationId !== 'string' || !conversationId) return null;
    let threadKey = null;
    try { threadKey = conversationRuntime.journalSnapshot?.(conversationId)?.threadKey ?? null; } catch { threadKey = null; }
    if (!threadKey) return null; // no durable thread identity observable pre-effect: no binding claim
    return intentBindings.record({
      runId, stepKey: body.key, stepTool: body.tool,
      argsDigest: argsDigestOf(body.arguments ?? {}),
      conversationId, threadKey,
    });
  };
  const completeSubmitIntent = (binding, runId, body) => {
    if (!binding || !intentBindings || !conversationRuntime) return;
    const conversationId = body.arguments?.conversation;
    const requestKey = body.arguments?.key;
    if (typeof conversationId !== 'string' || typeof requestKey !== 'string' || !requestKey) return;
    try {
      // The journal owns turn identity: the submit args' durable request key IS the journal
      // turn key, so the join is read from the journal itself (not from a summarized result).
      const turn = conversationRuntime.journalSnapshot(conversationId)?.turns?.find((t) => t?.key === requestKey) ?? null;
      if (turn?.key && turn?.payloadDigest) {
        intentBindings.complete({ runId: binding.runId, stepKey: binding.stepKey, journalTurnKey: turn.key, journalPayloadDigest: turn.payloadDigest });
      }
      // No journal turn under that key: the dispatch never reached the journal. The binding
      // stays incomplete; the reconcile query classifies it honestly as still_unknown.
    } catch { /* journal unreadable: reconcile classifies the incomplete binding honestly */ }
  };
  return {
    create: (body) => ({ run: runView(runs.create(body)) }),
    list: () => ({ runs: runs.list() }),
    get: (id) => ({ run: runView(runs.get(id)) }),
    step: async (id, body) => {
      const binding = recordSubmitIntent(id, body);
      // The completion runs in `finally`: an uncertain step THROWS (STEP_UNCERTAIN) and that is
      // precisely the case the binding must survive for — the journal-side join is read after
      // the store has durably recorded the attempt, success or failure alike.
      let out;
      try {
        out = await runs.step(id, { key: body.key, tool: body.tool, args: body.arguments ?? {} });
      } finally {
        completeSubmitIntent(binding, id, body);
      }
      return { run: runView(out.run), step: out.step, replayed: out.replayed,
        ...(out.replayed ? { note: out.note } : { result: out.result }) };
    },
    finish: (id, body) => ({ run: runView(runs.finish(id, body)) }),
    note: (id, body) => ({ run: runView(runs.note(id, body)) }),
    // Read-only uncertain-step reconciliation (Agent 14 Round 7): store snapshot + durable intent
    // binding + journal snapshot through the runtime's own read path. Never mutates anything.
    // Four-lane C1 seam: the same verified snapshots additionally feed `reconcileLifecycle`,
    // an independent six-stage projection (delivery / reply attribution / network terminal /
    // capture / accepted evidence / goal). Provenance that the harness cannot yet prove
    // (pre-send assistant baseline, recorder capture reference, accepted evidence, goal) is
    // passed as null — the bridge then reports those stages as honestly unknown instead of
    // inferring them. `dispatched:false` always; no stage of this projection sends anything.
    reconcileStep: (runId, stepKey) => {
      if (!intentBindings || !conversationRuntime) throw problem(501, 'Intent binding store or runtime journal unavailable', 'RECONCILE_UNAVAILABLE');
      const run = runs.get(runId);
      const binding = intentBindings.find({ runId, stepKey });
      let journal = null;
      if (run.conversationId) {
        try { journal = conversationRuntime.journalSnapshot(run.conversationId); } catch { journal = null; }
      }
      const reconciliation = reconcileUncertainStep({ run, stepKey, journal, intentBinding: binding });
      const lifecycle = reconcileLifecycle({
        run, stepKey, journal, binding,
        reconcileUncertainStep,
        baseline: null, attachment: null, capture: null, acceptance: null, goal: null,
        origin: journal?.origin ?? null,
      });
      return { reconciliation, lifecycle };
    },
  };
}

// Route + tool registration through the hub's own add(), so harness endpoints appear in the same
// tool surface, with the same auth, problem-json and documentation as every other Studio API.
export function registerHarnessTools({ add, harnessApi }) {
  if (!harnessApi) return;
  const runParameter = { run: { type: 'string', minLength: 10, maxLength: 64, pattern: '^[a-f0-9-]{10,64}$' } };
  add('POST', '/harness/runs', 'Open a durable harness run: persistent task/run identity bound to an optional conversation',
    async ({ body }) => harnessApi.create(body),
    { body: runBody, tool: 'harness_start_run', successStatus: 201,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } });
  add('GET', '/harness/runs', 'List durable harness runs (summaries; step bodies are digests only)',
    () => harnessApi.list(),
    { tool: 'harness_list_runs', annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } });
  add('GET', '/harness/runs/{run}', 'Read one durable harness run: task, status, conversation binding and step ledger',
    ({ p }) => harnessApi.get(p.run),
    { tool: 'harness_get_run', pathParameters: runParameter,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } });
  add('POST', '/harness/runs/{run}/steps', 'Execute one conversation-tool call inside a harness run. Durable key: same key + same arguments replays the recorded outcome without re-execution; never generate a replacement key after a timeout or unknown effect',
    async ({ p, body }) => harnessApi.step(p.run, body),
    { body: stepBody, tool: 'harness_run_step', pathParameters: runParameter,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } });
  add('POST', '/harness/runs/{run}/reconcile', 'Classify one unresolved harness step against the durable intent binding and the owning conversation journal (READ-ONLY: verdict + evidence + independent six-stage lifecycle projection, never mutates, never authorizes a resend)',
    ({ p, body }) => {
      if (typeof body.stepKey !== 'string' || !body.stepKey.length || body.stepKey.length > 200) throw problem(400, 'stepKey is required (1..200 chars)');
      const out = harnessApi.reconcileStep(p.run, body.stepKey);
      return { run: p.run, stepKey: body.stepKey, reconciliation: out.reconciliation, lifecycle: out.lifecycle };
    },
    { body: objectSchema({ stepKey: { ...str, minLength: 1, maxLength: 200 } }, ['stepKey']), tool: 'harness_reconcile_step',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } });

  add('POST', '/harness/runs/{run}/finish', 'Close a harness run with an explicit final status; the ledger becomes immutable',
    ({ p, body }) => harnessApi.finish(p.run, body),
    { body: finishBody, tool: 'harness_finish_run', pathParameters: runParameter,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } });
  add('POST', '/harness/runs/{run}/context', 'Merge durable continuation context into a running harness run (bounded, bodies excluded)',
    ({ p, body }) => harnessApi.note(p.run, body),
    { body: noteBody, tool: 'harness_note_run', pathParameters: runParameter,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } });
}

// The executor handed to the run store: conversation tools through the shared single path.
// Agent 14 Round 6 dispatch preflight: a PURE validation failure is proven not_dispatched
// (the store may record a safe `failed` step); anything thrown after validation may have had a
// real effect and is left unannotated so the store fences it as `uncertain`.
export function conversationToolExecutor(conversationRuntime) {
  if (!conversationRuntime) throw problem(503, 'Conversation runtime unavailable', 'CONVERSATION_CAPABILITY_UNAVAILABLE');
  return withDispatchPreflight(
    ({ tool, args }) => executeConversationTool(conversationRuntime, tool, args),
    (tool, args) => validateConversationTool(tool, args),
  );
}

// Tool-argument envelope validator used before the store is touched (fails closed on junk).
export function validateHarnessStepBody(body) {
  const { key, tool, arguments: args } = body ?? {};
  if (typeof key !== 'string' || !key.trim()) throw problem(400, 'Missing step key', 'INVALID_STEP_KEY');
  if (!CONVERSATION_TOOLS.some((t) => t.name === tool)) throw problem(400, `Unknown conversation tool: ${String(tool)}`, 'INVALID_TOOL');
  if (args !== undefined && (typeof args !== 'object' || args === null || Array.isArray(args))) throw problem(400, 'arguments must be an object', 'INVALID_TOOL_ARGUMENTS');
  return { key, tool, args: args ?? {} };
}
