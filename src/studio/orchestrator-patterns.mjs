// Pure plan builders for src/studio/ai-orchestrator.mjs. No filesystem, network or browser access
// here: every function turns {question, sites, options} into a small declarative plan that the
// orchestrator engine persists and runs. The CLI (bin/commands/ask.mjs) imports this module for
// pattern names and validation without loading the engine.
//
// A plan is a list of SEND steps plus a rule for choosing the result:
//   step.after   ids that must be finished (ready/failed/skipped/stopped) before this step may start
//   step.when    { minReady } | { noneReady } | { skipIf: { step, match } } | { hedge: { step, afterMs } }
//   step.template prompt text with {{question}}, {{previous}}, {{answers}}, {{answer:sN}} slots. It is
//                rendered ONCE, right before the step is sent, and the rendered prompt is persisted with
//                the step — a resumed step is never re-rendered (same key + same text, or nothing).
//   plan.firstWins ids racing each other: the first VALID answer wins, the rest stop waiting (a sent
//                question cannot be unsent) and not-yet-sent ones are never sent.
//   plan.choose  { rule: 'first' | 'all' | 'prefer' | 'judge' | 'verify', ... }
export const SITE_LABELS = Object.freeze({ chatgpt: 'ChatGPT', claude: 'Claude', zai: 'Z.ai', qwen: 'Qwen', deepseek: 'DeepSeek', gemini: 'Gemini' });
export const ORCHESTRATE_SITES = Object.freeze(Object.keys(SITE_LABELS));
export const MAX_STEPS = 12;
// Valid step roles. 'agent' is the planner step: its reply is parsed and turned into appended steps
// by the engine, so a web AI can act as the primary agent and delegate to the other web AIs.
export const STEP_ROLES = Object.freeze(['answer', 'improve', 'critique', 'review', 'verify', 'synthesize', 'judge', 'agent', 'revise']);
const MAX_QUESTION = 10000;

const invalid = (message) => Object.assign(new Error(message), { code: 'ORCHESTRATE_INVALID', status: 400 });
const labelOf = (site) => SITE_LABELS[site];
const list = (names) => names.length <= 1 ? names.join('') : names.slice(0, -1).join(', ') + ' and ' + names.at(-1);

const QUESTION = 'Question:\n{{question}}';
const TEMPLATES = {
  answer: '{{question}}',
  synthesize: 'Several AI assistants answered the same question independently. Write the single best final answer: keep what they agree on, settle any disagreement (say which view is right and why), and add anything important they all missed. Do not mention the assistants or the numbered answers — just give the final answer.\n\n' + QUESTION + '\n\n{{answers}}',
  judge: 'You are judging answers to a question. Read the question and the numbered answers, then pick the single best one: most correct first, then most complete and clear.\n\n' + QUESTION + '\n\n{{answers}}\n\nReply in exactly this format and nothing else:\nWINNER: <number>\nWHY: <one or two sentences>',
  improve: 'Here is a question and the current answer from another AI assistant. Improve it: fix mistakes, fill gaps and tighten the wording. Reply with the full improved answer only.\n\n' + QUESTION + '\n\nCurrent answer:\n{{previous}}',
  critique: 'Review this answer to the question below. List concrete problems only — factual errors, missing pieces, unclear parts. Be specific and brief. If the answer is already excellent, reply with exactly: NO CHANGES NEEDED\n\n' + QUESTION + '\n\nAnswer to review:\n{{previous}}',
  verify: 'Check this answer to the question below for mistakes. Reply in exactly this format and nothing else:\nVERDICT: OK   (or)   VERDICT: PROBLEMS\nNOTES: <a short list of any problems, or "none">\n\n' + QUESTION + '\n\nAnswer to check:\n{{previous}}',
};
const reviseTemplate = (draft, review) => 'You answered the question below and a reviewer gave feedback. Write an improved full answer that fixes the valid points (ignore any that are wrong). Reply with the improved answer only.\n\n'
  + QUESTION + '\n\nYour earlier answer:\n{{answer:' + draft + '}}\n\nReviewer feedback:\n{{answer:' + review + '}}';

function step(id, site, role, template, { after = [], when = null } = {}) {
  return { id, site, label: labelOf(site), role, template, after, when };
}
function sitesOf(sites, { min = 1, max = ORCHESTRATE_SITES.length, unique = true } = {}) {
  if (!Array.isArray(sites) || sites.some((s) => !Object.hasOwn(SITE_LABELS, s))) throw invalid('Choose from: ' + ORCHESTRATE_SITES.map(labelOf).join(', ') + '.');
  if (sites.length < min || sites.length > max) throw invalid(min === max ? `This needs exactly ${min} AI${min === 1 ? '' : 's'}.` : `Choose ${min} to ${max} AIs for this.`);
  if (unique && new Set(sites).size !== sites.length) throw invalid('Choose each AI only once.');
  return [...sites];
}
function siteOption(value, fallback, what) {
  if (value === undefined || value === null || value === '') return fallback;
  if (!Object.hasOwn(SITE_LABELS, value)) throw invalid(`Choose which AI ${what} from: ${ORCHESTRATE_SITES.map(labelOf).join(', ')}.`);
  return value;
}
function intOption(value, fallback, min, max, what) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) throw invalid(`${what} must be a whole number from ${min} to ${max}.`);
  return value;
}

// Every builder returns { sites, options, steps, firstWins, choose, describe }.
const BUILDERS = {
  single({ sites }) {
    const [site] = sitesOf(sites, { min: 1, max: 1 });
    return { steps: [step('s1', site, 'answer', TEMPLATES.answer)], choose: { rule: 'first', steps: ['s1'] } };
  },
  fanout({ sites }) {
    const chosen = sitesOf(sites);
    const steps = chosen.map((site, i) => step('s' + (i + 1), site, 'answer', TEMPLATES.answer));
    return { steps, choose: { rule: 'all', steps: steps.map((s) => s.id) } };
  },
  race({ sites }) {
    const chosen = sitesOf(sites, { min: 2 });
    const steps = chosen.map((site, i) => step('s' + (i + 1), site, 'answer', TEMPLATES.answer));
    const ids = steps.map((s) => s.id);
    return { steps, firstWins: ids, choose: { rule: 'first', steps: ids } };
  },
  fallback({ sites }) {
    const chosen = sitesOf(sites, { min: 2 });
    const steps = chosen.map((site, i) => step('s' + (i + 1), site, 'answer', TEMPLATES.answer,
      i ? { after: Array.from({ length: i }, (_, j) => 's' + (j + 1)), when: { noneReady: true } } : {}));
    return { steps, choose: { rule: 'first', steps: steps.map((s) => s.id) } };
  },
  hedge({ sites, options }) {
    const [first, second] = sitesOf(sites, { min: 2, max: 2 });
    const seconds = intOption(options.hedgeAfterSeconds, 90, 5, 900, 'Hedge delay (seconds)');
    const steps = [step('s1', first, 'answer', TEMPLATES.answer),
      step('s2', second, 'answer', TEMPLATES.answer, { when: { hedge: { step: 's1', afterMs: seconds * 1000 } } })];
    return { options: { hedgeAfterSeconds: seconds }, steps, firstWins: ['s1', 's2'], choose: { rule: 'first', steps: ['s1', 's2'] } };
  },
  council({ sites, options }) {
    const members = sitesOf(sites, { min: 2 });
    const by = siteOption(options.by, members[0], 'combines the answers');
    const steps = members.map((site, i) => step('s' + (i + 1), site, 'answer', TEMPLATES.answer));
    const ids = steps.map((s) => s.id);
    steps.push(step('s' + (ids.length + 1), by, 'synthesize', TEMPLATES.synthesize, { after: ids, when: { minReady: 2 } }));
    return { options: { by }, steps, choose: { rule: 'prefer', order: [steps.at(-1).id], fallback: ids } };
  },
  judge({ sites, options }) {
    const candidates = sitesOf(sites, { min: 2 });
    const by = siteOption(options.by, candidates[0], 'judges the answers');
    const steps = candidates.map((site, i) => step('s' + (i + 1), site, 'answer', TEMPLATES.answer));
    const ids = steps.map((s) => s.id);
    const judgeId = 's' + (ids.length + 1);
    steps.push(step(judgeId, by, 'judge', TEMPLATES.judge, { after: ids, when: { minReady: 2 } }));
    return { options: { by }, steps, choose: { rule: 'judge', judge: judgeId, fallback: ids } };
  },
  relay({ sites, options }) {
    const stages = sitesOf(sites, { min: 2, unique: false });
    const custom = Array.isArray(options.instructions) ? options.instructions : [];
    if (custom.length > stages.length || custom.some((x) => typeof x !== 'string' || x.length > 2000)) throw invalid('Give at most one short instruction per AI in the chain.');
    const steps = stages.map((site, i) => {
      const extra = custom[i]?.trim();
      const base = i ? TEMPLATES.improve : TEMPLATES.answer;
      const template = extra ? (i ? extra + '\n\n' + QUESTION + '\n\nCurrent answer:\n{{previous}}' : extra + '\n\n{{question}}') : base;
      // Each stage waits for ALL earlier stages; {{previous}} is the latest one that answered, so one
      // stuck AI in the middle of the chain is skipped over instead of breaking the relay.
      return step('s' + (i + 1), site, i ? 'improve' : 'answer', template,
        i ? { after: Array.from({ length: i }, (_, j) => 's' + (j + 1)), when: { minReady: 1 } } : {});
    });
    return { options: custom.length ? { instructions: custom } : {}, steps, choose: { rule: 'prefer', order: steps.map((s) => s.id).reverse() } };
  },
  critique({ sites, options }) {
    const chosen = sitesOf(sites, { min: 2, max: 2 });
    const [author, critic] = chosen;
    const rounds = intOption(options.rounds, 1, 1, 3, 'Rounds');
    const steps = [step('s1', author, 'answer', TEMPLATES.answer)];
    let draft = 's1';
    for (let r = 0; r < rounds; r++) {
      const review = 's' + (steps.length + 1), revise = 's' + (steps.length + 2);
      steps.push(step(review, critic, 'critique', TEMPLATES.critique, { after: [draft], when: { minReady: 1 } }));
      steps.push(step(revise, author, 'revise', reviseTemplate(draft, review),
        { after: [draft, review], when: { minReady: 2, skipIf: { step: review, match: '^\\s*NO CHANGES NEEDED' } } }));
      draft = revise;
    }
    return { options: { rounds }, steps, choose: { rule: 'prefer', order: steps.filter((s) => s.role !== 'critique').map((s) => s.id).reverse() } };
  },
  verify({ sites }) {
    const [answerer, checker] = sitesOf(sites, { min: 2, max: 2 });
    const steps = [step('s1', answerer, 'answer', TEMPLATES.answer), step('s2', checker, 'verify', TEMPLATES.verify, { after: ['s1'], when: { minReady: 1 } })];
    return { steps, choose: { rule: 'verify', answer: 's1', check: 's2' } };
  },
};

// Consumer-facing catalog of what is actually runnable (also served by GET /api/v1/orchestrate).
export const PATTERNS = Object.freeze({
  single: { title: 'Ask one AI', sites: '1', summary: 'One question to one of your AIs.' },
  fanout: { title: 'Ask several at once', sites: '1-6', summary: 'The same question to each chosen AI; see every answer side by side.' },
  race: { title: 'Fastest answer', sites: '2-6', summary: 'Asks each AI in turn and keeps the first good answer. The others stop being waited for.' },
  fallback: { title: 'Backup AIs', sites: '2-6', summary: 'Asks your first AI; only if it can’t answer (signed out, stuck) asks the next one.' },
  hedge: { title: 'Backup if slow', sites: '2', summary: 'Asks your first AI; if it hasn’t answered after a while, also asks the second. First good answer wins.' },
  council: { title: 'Council', sites: '2-6', summary: 'Each AI answers on its own, then one AI combines them into one best answer.' },
  judge: { title: 'Pick the best', sites: '2-6', summary: 'Each AI answers, then one AI picks the best answer and says why.' },
  relay: { title: 'Relay', sites: '2-6', summary: 'The first AI answers, each next AI improves the previous answer.' },
  critique: { title: 'Review and improve', sites: '2', summary: 'Your first AI answers, the second reviews it, and the first improves its answer.' },
  verify: { title: 'Double-check', sites: '2', summary: 'Your first AI answers and the second checks it for mistakes.' },
  auto: { title: 'Choose automatically', sites: '1-6', summary: 'VIVIM picks the way to ask and the AIs for you, based on the task and how your AIs have performed.' },
});
export const PATTERN_NAMES = Object.freeze(Object.keys(BUILDERS));
// "auto" is resolved by src/studio/ai-router.mjs (pattern + sites + reason) before a builder runs.
export const PATTERN_CHOICES = Object.freeze([...PATTERN_NAMES, 'auto']);


// Validated, normalized plan spec (no ids/keys yet — the engine assigns those).
export function buildPlanSpec({ pattern, question, sites, options = {} } = {}) {
  if (typeof pattern !== 'string' || !Object.hasOwn(BUILDERS, pattern)) throw invalid('Choose a way to ask: ' + PATTERN_NAMES.join(', ') + '.');
  const text = typeof question === 'string' ? question.trim() : '';
  if (!text || text.length > MAX_QUESTION) throw invalid('Write a question under 10,000 characters.');
  if (options === null || typeof options !== 'object' || Array.isArray(options)) throw invalid('Options must be an object.');
  const deadlineMinutes = intOption(options.deadlineMinutes, 20, 1, 120, 'Time limit (minutes)');
  const expect = options.expect === undefined ? 'text' : options.expect;
  if (!['text', 'json'].includes(expect)) throw invalid('Expected answer type must be text or json.');
  const built = BUILDERS[pattern]({ sites, options });
  if (built.steps.length > MAX_STEPS) throw invalid('That is too many steps for one question.');
  return { pattern, question: text, sites: [...sites], options: { ...(built.options ?? {}), deadlineMinutes, expect },
    steps: built.steps, firstWins: built.firstWins ?? [], choose: built.choose };
}

// Plain-language summary of a finished plan's result (used by the engine).
export function describeResult(plan, picked) {
  const steps = plan.steps, ready = steps.filter((s) => s.state === 'ready' && s.valid);
  const by = (id) => steps.find((s) => s.id === id);
  switch (plan.pattern) {
    case 'fanout': return `${ready.length} of ${steps.length} AIs answered.`;
    case 'race': case 'hedge': return picked ? `${picked.label} answered first.` : '';
    case 'fallback': {
      if (!picked) return '';
      const before = steps.slice(0, steps.indexOf(picked)).map((s) => s.label);
      return before.length ? `Answered by ${picked.label} because ${list(before)} couldn’t.` : `Answered by ${picked.label}.`;
    }
    case 'council': {
      const members = steps.filter((s) => s.role === 'answer' && s.state === 'ready' && s.valid).map((s) => s.label);
      return picked?.role === 'synthesize' ? `${picked.label} combined the answers from ${list(members)}.` : picked ? `Only ${picked.label}’s answer came back, so nothing was combined.` : '';
    }
    case 'relay': return picked ? 'Refined by ' + steps.filter((s) => s.state === 'ready').map((s) => s.label).join(' → ') + '.' : '';
    case 'critique': return picked?.role === 'revise' ? `${picked.label} improved its answer after ${by('s2')?.label}’s review.`
      : picked && steps.some((s) => s.role === 'revise' && s.reason === 'NOT_NEEDED') ? `${by('s2')?.label} found nothing to change.` : picked ? `Showing ${picked.label}’s first answer; the review step didn’t finish.` : '';
    default: return picked ? `Answer from ${picked.label}.` : '';
  }
}

// ---------------------------------------------------------------------------------------------
// Tolerant structured-reply parsing for a planner AI's reply. Same style as src/studio/
// agent-actions.mjs's extractJsonCandidate (import-free, no side effects): smart quotes are
// straightened, exactly one JSON object is accepted (fenced ```json preferred, a single bare fence
// or embedded object otherwise), and more than one candidate is refused rather than guessed at.
// Returns null when the reply cannot be read as a plan (the engine then finishes gracefully).
const FENCE = /```[ \t]*([A-Za-z0-9_-]*)[ \t]*\r?\n([\s\S]*?)\r?\n?```/g;
const SMART_SINGLE = /[\u2018\u2019\u201a\u201b]/g;
const SMART_DOUBLE = /[\u201c\u201d\u201e\u201f]/g;
const straightenQuotes = (text) => String(text ?? '').replace(SMART_SINGLE, "'").replace(SMART_DOUBLE, '"');
function jsonObjectsIn(text) {
  const found = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    let depth = 0, inString = false, end = -1;
    for (let j = i; j < text.length && end < 0; j++) {
      const c = text[j];
      if (inString) { if (c === '\\') j++; else if (c === '"') inString = false; }
      else if (c === '"') inString = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) end = j;
    }
    if (end < 0) break;
    const slice = text.slice(i, end + 1);
    try {
      const value = JSON.parse(slice);
      if (value && typeof value === 'object' && !Array.isArray(value) && !found.includes(slice)) found.push(slice);
      i = end;
    } catch { /* not JSON: keep scanning from the next brace */ }
  }
  return found;
}
// Planner reply schema:
//   { "finish": boolean, "summary": string, "steps": [ { site, role, prompt, after?: string[], when?: object } ] }
// `after` references step ids within THIS plan (the planner step itself is s1, appended steps are s2, s3, …).
export function parsePlannerReply(text) {
  const t = straightenQuotes(text);
  const blocks = [...t.matchAll(FENCE)]
    .filter(([, tag, body]) => (tag ? tag.toLowerCase() === 'json' : body.trim().startsWith('{')))
    .map((m) => m[2].trim());
  let candidate;
  if (blocks.length > 1) return null; // ambiguous: refuse rather than guess
  if (blocks.length === 1) candidate = blocks[0];
  else {
    const whole = t.trim();
    if (whole.startsWith('{')) candidate = whole;
    else {
      const objs = jsonObjectsIn(whole);
      if (objs.length !== 1) return null;
      candidate = objs[0];
    }
  }
  let parsed;
  try { parsed = JSON.parse(candidate); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const { finish, steps, summary } = parsed;
  if (typeof finish !== 'boolean') return null;
  const stepList = Array.isArray(steps) ? steps : [];
  const clean = [];
  for (const s of stepList) {
    if (!s || typeof s.site !== 'string' || !Object.hasOwn(SITE_LABELS, s.site)) return null;
    if (typeof s.role !== 'string' || !STEP_ROLES.includes(s.role)) return null;
    if (typeof s.prompt !== 'string' || !s.prompt.trim()) return null;
    clean.push({ site: s.site, role: s.role, prompt: s.prompt.trim(),
      after: Array.isArray(s.after) ? s.after.filter((x) => typeof x === 'string') : [],
      when: s.when && typeof s.when === 'object' ? s.when : null });
  }
  return { finish, steps: clean, summary: typeof summary === 'string' ? summary.trim() : '' };}
