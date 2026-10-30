import { createOrchestrator, PATTERN_CHOICES } from './ai-orchestrator.mjs';
import { ORCHESTRATE_SITES } from './orchestrator-patterns.mjs';

// /api/v1/orchestrate — every multi-AI pattern through the ONE shared conversation runtime.
export function registerOrchestratorRoutes({ add, paths, conversationRuntime }) {
  if (!conversationRuntime) return;
  const orchestrator = createOrchestrator({ paths, conversations: conversationRuntime });
  add('GET', '/orchestrate', 'Ways to ask several of your AIs, and your recent questions', () => orchestrator.list());
  add('POST', '/orchestrate', 'Ask your own AI accounts using a pattern (single, fanout, race, fallback, hedge, council, judge, relay, critique, verify, auto)',
    ({ body }) => orchestrator.start(body ?? {}), {
      body: { type: 'object', properties: {
        pattern: { enum: PATTERN_CHOICES }, question: { type: 'string', minLength: 1, maxLength: 10000 },
        sites: { type: 'array', minItems: 1, maxItems: ORCHESTRATE_SITES.length, items: { enum: ORCHESTRATE_SITES } },
        options: { type: 'object', properties: {
          by: { enum: ORCHESTRATE_SITES, description: 'The AI that combines (council) or judges (judge)' },
          rounds: { type: 'integer', minimum: 1, maximum: 3 }, hedgeAfterSeconds: { type: 'integer', minimum: 5, maximum: 900 },
          deadlineMinutes: { type: 'integer', minimum: 1, maximum: 120 }, expect: { enum: ['text', 'json'] },
          instructions: { type: 'array', items: { type: 'string', maxLength: 2000 } },
          role: { type: 'string', description: 'With pattern auto: developer role that hints at the task kind' },
          constraints: { type: 'object', properties: { maxSends: { type: 'integer', minimum: 1, maximum: 6 },
            maxWaitMs: { type: 'integer', minimum: 1000 }, mustInclude: { type: 'array', items: { enum: ORCHESTRATE_SITES } },
            exclude: { type: 'array', items: { enum: ORCHESTRATE_SITES } } } } } } },
        required: ['pattern', 'question', 'sites'] }, successStatus: 202 });
  add('GET', '/orchestrate/{planId}', 'Read a saved multi-AI question and its progress', ({ p }) => orchestrator.get(p.planId));
  add('POST', '/orchestrate/{planId}/cancel', 'Stop waiting without repeating any question', ({ p }) => orchestrator.cancel(p.planId), { body: { type: 'object', properties: {} } });
}
