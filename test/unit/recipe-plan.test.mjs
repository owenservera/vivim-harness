import test from 'node:test';
import assert from 'node:assert/strict';
import { listRecipes, recipeDefinition } from '../../src/recipes/catalog.mjs';
import { planRecipe } from '../../src/recipes/plan.mjs';

test('a read-only recipe plan is eligible with no effect authorization and never returns private input values', () => {
  const plan = planRecipe('provider.targets', {});
  assert.equal(plan.ready, true);
  assert.deepEqual(plan.effects, ['read']);
  assert.equal(plan.tool, 'conversation_targets');
  assert.equal(plan.maxUserCommands, 1);
  assert.equal(plan.note.includes('Runtime verifies'), true);
});
test('typed argument schema rejects missing, extraneous, wrong-type or unsupported native provider input', () => {
  assert.throws(() => planRecipe('conversation.inspect', {}), (e) => e.code === 'INVALID_RECIPE_INPUT');
  assert.throws(() => planRecipe('provider.targets', { inject: true }), (e) => e.code === 'INVALID_RECIPE_INPUT');
  assert.throws(() => planRecipe('conversation.continue', { conversation: 'c1', prompt: 'hello', key: 'abc',
    confirm: false, expectedRevision: 0 }), (e) => e.code === 'INVALID_RECIPE_INPUT');
  assert.throws(() => planRecipe('conversation.connect-existing', {
    site: 'claude', targetId: 't-1', expectedThread: 'chatgpt-c:44444444-4444-4444-8444-444444444444',
  }), (e) => e.code === 'INVALID_RECIPE_INPUT');
});
test('real provider sends require two independent authorizations and an original durable key', () => {
  const input = { conversation: 'c1', key: 'one', prompt: 'Keep this private', confirm: true, expectedRevision: 0 };
  const preview = planRecipe('conversation.continue', input);
  assert.deepEqual(preview.missingAuthorization, ['execute', 'provider-send']);
  assert.equal(preview.ready, false);
  assert.equal(JSON.stringify(preview).includes('Keep this private'), false);
  const halfway = planRecipe('conversation.continue', input, { execute: true });
  assert.deepEqual(halfway.missingAuthorization, ['provider-send']);
  const ready = planRecipe('conversation.continue', input, { execute: true, authorizeSend: true });
  assert.equal(ready.ready, true);
  assert.equal(ready.nextSafeAction, 'execute-via-studio-owner');
  assert.notEqual(ready.inputDigest, planRecipe('conversation.continue', { ...input, prompt: 'different' }).inputDigest);
});
test('native exact-thread recipe declares existing ChatGPT thread only, never fresh provider creation', () => {
  const recipe = recipeDefinition('conversation.connect-existing');
  assert.deepEqual(recipe.inputSchema.properties.site.enum, ['chatgpt']);
  assert.equal(recipe.inputSchema.properties.freshTab.const, false);
  assert.ok(recipe.inputSchema.required.includes('expectedThread'));
  assert.equal(listRecipes({ family: 'provider' }).length, 2);
});
