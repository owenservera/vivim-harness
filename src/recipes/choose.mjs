// Deterministic intent discovery, not LLM routing and never authorization to execute.
// Suggest only recipes registered in the same source-backed catalogue.
import { recipeDefinition, listRecipes } from './catalog.mjs';

const samples = Object.freeze({
  'provider.targets': ['list browser tabs', 'discover provider tabs', 'available providers', 'browser targets'],
  'provider.chat-index': ['chatgpt chat index', 'chatgpt sidebar chats', 'find chatgpt threads'],
  'conversation.list': ['list conversations', 'recent conversations', 'saved chats', 'my conversations'],
  'conversation.inspect': ['conversation status', 'inspect conversation', 'last turn status', 'conversation evidence'],
  'conversation.read': ['read conversation', 'read transcript', 'show recent messages', 'current reply'],
  'conversation.connect-existing': ['connect existing thread', 'attach chatgpt thread', 'resume exact thread'],
  'conversation.continue': ['continue conversation with revision', 'submit turn with revision'],
  'conversation.ask': ['ask a follow up', 'send follow up', 'ask this conversation', 'one command follow up', 'send prompt'],
  'conversation.finish': ['finish conversation capture', 'stop recording conversation', 'finalize conversation'],
  'recovery.reconcile-turn': ['uncertain send', 'unknown delivery', 'reconcile turn', 'possible duplicate send'],
});

const tokens = (s) => String(s).toLocaleLowerCase('en').normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '').match(/[a-z0-9]+/g) ?? [];
export function chooseRecipe(intent, { family, max = 3 } = {}) {
  if (typeof intent !== 'string' || !intent.trim() || intent.length > 1000)
    throw Object.assign(new Error('INVALID_RECIPE_INTENT'), { code: 'INVALID_RECIPE_INTENT', status: 400 });
  if (!Number.isSafeInteger(max) || max < 1 || max > 10)
    throw Object.assign(new Error('INVALID_RECIPE_LIMIT'), { code: 'INVALID_RECIPE_LIMIT', status: 400 });
  const words = tokens(intent), set = new Set(words);
  const candidates = listRecipes(family ? { family } : {}).map((recipe) => {
    const phrases = samples[recipe.id] ?? [];
    const matches = phrases.map((p) => {
      const keys = tokens(p), found = keys.filter((word) => set.has(word));
      return { phrase: p, hits: found.length, coverage: found.length / keys.length };
    });
    const best = matches.sort((a, b) => b.coverage - a.coverage || b.hits - a.hits)[0];
    const score = best && best.hits >= 2 ? Math.round(best.coverage * 100) : 0;
    return { id: recipe.id, family: recipe.family, score, reason: score ? 'vocabulary-overlap:' + best.phrase : 'no-grounded-match',
      effects: recipe.effects, requires: recipe.requires };
  }).filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, max);
  const ambiguous = candidates.length > 1 && candidates[0].score === candidates[1].score;
  return {
    schema: 'vivim.recipe-choice/1', intentChars: intent.length, candidates, ambiguous,
    selection: candidates.length === 1 || candidates.length && !ambiguous ? candidates[0].id : null,
    status: !candidates.length ? 'no-match' : ambiguous ? 'ambiguous' : 'suggested',
    evidence: 'deterministic-vocabulary-only', authorized: false, executed: false,
    nextSafeAction: !candidates.length || ambiguous ? 'inspect-catalog-and-choose' : 'inspect-recipe-and-plan',
    note: 'Selection is a suggestion, not capability verification or permission to send.',
  };
}
