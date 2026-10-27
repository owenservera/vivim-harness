import test from 'node:test';
import assert from 'node:assert/strict';
import { RECIPE_CATALOG, RECIPE_FAMILIES, EFFECT_CLASSES, listRecipes, recipeDefinition } from '../../src/recipes/catalog.mjs';
import { CONVERSATION_TOOLS } from '../../src/studio/conversation-tools.mjs';

test('recipe catalogue is distinct, versioned, transport-scoped and bound to existing native tool schemas', () => {
  assert.equal(new Set(RECIPE_CATALOG.map((r) => r.id)).size, RECIPE_CATALOG.length);
  assert.ok(RECIPE_FAMILIES.includes('conversation'));
  assert.ok(EFFECT_CLASSES.includes('provider-send'));
  const tools = new Map(CONVERSATION_TOOLS.map((tool) => [tool.name, tool]));
  for (const recipe of RECIPE_CATALOG) {
    const tool = tools.get(recipe.tool);
    assert.ok(tool, recipe.id + ' must name a real registered tool');
    assert.deepEqual(recipe.inputSchema, tool.inputSchema);
    assert.equal(recipe.version, 1);
    assert.equal(recipe.transport, 'studio-tool');
    assert.equal(recipe.executionReady, false, 'V1 declarations are not an executor');
    assert.equal(recipe.maxUserCommands, 1);
    assert.equal(recipe.onUnknownEffect, 'halt-and-reconcile');
    if (tool.annotations.readOnlyHint) assert.deepEqual(recipe.effects, ['read']);
    if (recipe.effects.includes('provider-send')) assert.equal(recipe.tool, 'submit_conversation_turn');
  }
});
test('family filtering, unknown family rejection and unsupported recipe lookup stay read-only', () => {
  const subset = listRecipes({ family: 'provider' });
  assert.equal(subset.length, 2);
  assert.ok(subset.every((recipe) => recipe.family === 'provider'));
  assert.throws(() => listRecipes({ family: 'phantom' }), /UNKNOWN_RECIPE_FAMILY/);
  assert.equal(recipeDefinition('does.not-exist'), null);
  assert.equal(recipeDefinition('conversation.connect-existing').inputSchema.properties.site.enum[0], 'chatgpt');
  assert.equal(recipeDefinition('conversation.continue').effects.includes('provider-send'), true);
});
