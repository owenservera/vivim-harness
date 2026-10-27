import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseRecipe } from '../../src/recipes/choose.mjs';
import { registerRecipeRoutes } from '../../src/studio/recipe-routes.mjs';

test('intent choices are explicit suggestions, never authorization or side effects', () => {
  const choice = chooseRecipe('Please reconcile an uncertain send after unknown delivery');
  assert.equal(choice.candidates[0].id, 'recovery.reconcile-turn');
  assert.equal(choice.authorized, false);
  assert.equal(choice.executed, false);
  assert.equal(choice.nextSafeAction, 'inspect-recipe-and-plan');
  assert.equal(choice.intentChars, 'Please reconcile an uncertain send after unknown delivery'.length);
  assert.equal('prompt' in choice, false);
});
test('unknown intent fails conservatively and never guesses an executor', () => {
  const choice = chooseRecipe('opaque zythrum feature nebula');
  assert.equal(choice.status, 'no-match');
  assert.equal(choice.selection, null);
  assert.equal(choice.nextSafeAction, 'inspect-catalog-and-choose');
  assert.throws(() => chooseRecipe(''), (e) => e.code === 'INVALID_RECIPE_INTENT');
  assert.throws(() => chooseRecipe('list conversations', { family: 'wrong' }), /UNKNOWN_RECIPE_FAMILY/);
});
test('recipe native route registration uses the supplied Studio add() owner; no service starts', () => {
  const routes = [];
  const fakeApi = { get: () => ({ run: { task: { description: 'manual' } } }) };
  const fakeRuntime = {};
  const api = registerRecipeRoutes({ add: (method, route, summary, handler, opts) =>
    routes.push({ method, route, summary, handler, opts }), harnessApi: fakeApi, conversationRuntime: fakeRuntime });
  assert.ok(api);
  assert.equal(routes.length, 9);
  assert.ok(routes.some((r) => r.method === 'GET' && r.route === '/recipes/choose'));
  assert.ok(routes.some((r) => r.method === 'POST' && r.route === '/recipes/{recipe}/run'
    && r.opts.tool === 'recipe_run'));
  assert.ok(routes.some((r) => r.route === '/recipes/runs/{run}/reconcile'
    && r.opts.annotations.readOnlyHint === true));
  assert.equal(routes.find((r) => r.route === '/recipes/{recipe}/run').opts.annotations.readOnlyHint, false);
  assert.equal(registerRecipeRoutes({ add: () => { throw new Error('must not register'); } }), null);
});
