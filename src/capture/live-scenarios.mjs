// Twenty realistic single-turn tasks, exercised against five real provider browser sessions.
// 20 x 5 = 100 independent live user journeys; prompts are public, synthetic and secret-free.
// The runner checks delivered/replied/finished/saved evidence separately from answer quality.
export const LIVE_PROVIDERS = Object.freeze(['chatgpt', 'claude', 'gemini', 'deepseek', 'zai']);

export const USER_TASKS = Object.freeze([
  { id: 'groceries', title: 'Organize a grocery list', prompt: 'I need rice, milk, and eggs. Give me a short checklist with exactly those three items.', expect: ['rice', 'milk', 'eggs'] },
  { id: 'summary', title: 'Summarize project notes', prompt: 'Summarize this in one sentence: Cedar is an offline-first personal notebook; exports must be JSON; sign-in is optional.', expect: ['cedar', 'offline', 'json'] },
  { id: 'requirements', title: 'Extract functional requirements', prompt: 'From this product request extract the two requirements as separate bullet points: Users must save data locally and export it in JSON.', expect: ['local', 'json'] },
  { id: 'math', title: 'Calculate a quote', prompt: 'A supplier quoted 19 units at 23 euros each. What is the total? Give the number 437 in your answer.', expect: ['437'] },
  { id: 'translation', title: 'Translate a customer note', prompt: 'Translate to Spanish: Good morning, the meeting is tomorrow. Include the words buenos and mañana.', expect: ['buenos', 'mañana'] },
  { id: 'email', title: 'Draft a scheduling email', prompt: 'Draft a two-sentence email to a teammate asking to meet on Friday. Include the subject line Subject: Friday sync.', expect: ['subject', 'friday'] },
  { id: 'priority', title: 'Classify a product incident', prompt: 'A production app is unavailable for all customers. Classify this incident as HIGH or LOW priority and explain briefly.', expect: ['high'] },
  { id: 'dedupe', title: 'Deduplicate contacts', prompt: 'Deduplicate these names: Ada, Ada, Lin, Sam, Lin. Return one occurrence of each, sorted alphabetically.', expect: ['ada', 'lin', 'sam'] },
  { id: 'agenda', title: 'Create a meeting agenda', prompt: 'Make a short three-point agenda for a product kickoff: scope, owners, risks. Mention all three.', expect: ['scope', 'owners', 'risks'] },
  { id: 'project-naming', title: 'Rename a fictional project', prompt: 'A fictional product named Harbor has been renamed Cedar. What is its current name? Answer in one sentence.', expect: ['cedar'] },
  { id: 'comparison', title: 'Compare product options', prompt: 'Compare offline-first storage and cloud-only storage. Include the words offline and cloud and one tradeoff.', expect: ['offline', 'cloud'] },
  { id: 'onboarding', title: 'Write onboarding steps', prompt: 'Draft three onboarding steps for a local notebook: choose workspace, create a note, export JSON.', expect: ['workspace', 'note', 'json'] },
  { id: 'user-story', title: 'Write an actionable user story', prompt: 'Write a user story for exporting local notes to JSON. Use the phrases As a user and so that.', expect: ['as a user', 'so that'] },
  { id: 'http-error', title: 'Explain an HTTP failure', prompt: 'What does HTTP 401 mean for a signed-in application? Answer with the number 401 and the word authentication.', expect: ['401', 'authentication'] },
  { id: 'debugging', title: 'Propose a reproducible bug report', prompt: 'An export button does nothing. Write a short bug report with Steps, Expected, and Actual headings.', expect: ['steps', 'expected', 'actual'] },
  { id: 'table', title: 'Format a product comparison table', prompt: 'Make a Markdown table with headers Feature and Priority and rows Export and Search.', expect: ['feature', 'priority', 'export', 'search'] },
  { id: 'risk', title: 'Identify privacy risks', prompt: 'List the top two risks of putting authentication tokens in application logs. Use the words tokens and logs.', expect: ['tokens', 'logs'] },
  { id: 'decision', title: 'Record a product decision', prompt: 'Write a short decision record stating that the app uses local-first storage and JSON export. Label the decision Decision.', expect: ['decision', 'local', 'json'] },
  { id: 'acceptance', title: 'Draft acceptance criteria', prompt: 'Write acceptance criteria for offline mode. Include the words offline, restart and saved.', expect: ['offline', 'restart', 'saved'] },
  { id: 'exact', title: 'Follow an exact response instruction', prompt: 'Respond with exactly this text and nothing else: VIVIM CEDAR READY', expect: ['vivim cedar ready'], exact: 'VIVIM CEDAR READY' },
]);

export function allLiveScenarios(providers = LIVE_PROVIDERS) {
  if (!Array.isArray(providers) || !providers.length || providers.some((id) => !LIVE_PROVIDERS.includes(id)) || new Set(providers).size !== providers.length)
    throw new Error('Providers must be distinct entries from ' + LIVE_PROVIDERS.join(', '));
  return providers.flatMap((provider) => USER_TASKS.map((task) => ({
    id: provider + '-' + task.id, provider, task,
    title: provider + ': ' + task.title,
  })));
}

export function assessUserAnswer(task, reply) {
  if (typeof reply !== 'string' || !reply.trim()) return { ok: false, reason: 'EMPTY_REPLY' };
  if (task.exact && reply.trim() !== task.exact) return { ok: false, reason: 'EXACT_RESPONSE_MISMATCH' };
  const lower = reply.toLocaleLowerCase();
  const missing = task.expect.filter((term) => !lower.includes(term.toLocaleLowerCase()));
  return missing.length ? { ok: false, reason: 'EXPECTED_CONTENT_MISSING', missing } : { ok: true, reason: null };
}
