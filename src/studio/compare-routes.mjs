import { createCompareJobs, COMPARE_SITES } from './compare-service.mjs';

export function registerCompareRoutes({ add, paths, conversationRuntime }) {
  if (!conversationRuntime) return;
  const jobs = createCompareJobs({ paths, conversations: conversationRuntime });
  add('POST', '/compare', 'Ask selected providers using your own web accounts', ({ body }) => jobs.start(body), {
    body: { type: 'object', properties: { question: { type: 'string', minLength: 1, maxLength: 10000 },
      sites: { type: 'array', minItems: 1, maxItems: COMPARE_SITES.length, uniqueItems: true, items: { enum: COMPARE_SITES } } }, required: ['question'] }, successStatus: 202,
  });
  add('GET', '/compare/{jobId}', 'Read a saved comparison', ({ p }) => jobs.get(p.jobId));
  add('POST', '/compare/{jobId}/cancel', 'Stop waiting without repeating any question', ({ p }) => jobs.cancel(p.jobId), { body: { type: 'object', properties: {} } });
}
