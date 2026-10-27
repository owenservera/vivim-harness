// Pure recipe planning and input validation. No network/browser/run-store calls.
// A recipe executes only a declared production tool, never arbitrary shell/JS instructions.
import { argsDigestOf } from '../capture/harness-runs.mjs';
import { recipeDefinition } from './catalog.mjs';
import { validateConversationTool } from '../studio/conversation-tools.mjs';

const fail = (code, message = code) => Object.assign(new Error(message), { code, status: 400 });
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function valueIs(value, schema) {
  const type = schema.type;
  if (type === 'string' && typeof value !== 'string') return false;
  if (type === 'integer' && !Number.isSafeInteger(value)) return false;
  if (type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) return false;
  if (type === 'boolean' && typeof value !== 'boolean') return false;
  if (type === 'array' && !Array.isArray(value)) return false;
  if (type === 'object' && !object(value)) return false;
  if (schema.const !== undefined && value !== schema.const) return false;
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return false;
  if (typeof value === 'string' && (
    (schema.minLength !== undefined && value.length < schema.minLength)
    || (schema.maxLength !== undefined && value.length > schema.maxLength)
    || (schema.pattern && !(new RegExp(schema.pattern).test(value)))
  )) return false;
  if (typeof value === 'number' && ((schema.minimum !== undefined && value < schema.minimum)
    || (schema.maximum !== undefined && value > schema.maximum))) return false;
  if (Array.isArray(value) && (schema.maxItems !== undefined && value.length > schema.maxItems
    || schema.items && value.some((item) => !valueIs(item, schema.items)))) return false;
  if (object(value) && schema.properties) {
    if (Object.keys(value).some((key) => schema.additionalProperties === false && !(key in schema.properties))) return false;
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) return false;
    for (const [key, v] of Object.entries(value)) if (schema.properties[key] && !valueIs(v, schema.properties[key])) return false;
  }
  return true;
}

export function planRecipe(id, input = {}, { execute = false, authorizeSend = false } = {}) {
  const recipe = recipeDefinition(id);
  if (!recipe) throw fail('RECIPE_NOT_FOUND');
  if (!object(input)) throw fail('INVALID_RECIPE_INPUT');
  const schema = recipe.inputSchema;
  const unknown = Object.keys(input).filter((k) => !Object.hasOwn(schema.properties ?? {}, k));
  const missing = (schema.required ?? []).filter((key) => !Object.hasOwn(input, key));
  const invalid = Object.entries(input).filter(([key, val]) => schema.properties?.[key] && !valueIs(val, schema.properties[key])).map(([key]) => key);
  // Native validator enforces contract-specific guards (e.g. exact ChatGPT /c thread).
  if (!unknown.length && !missing.length && !invalid.length) {
    try { validateConversationTool(recipe.tool, input); } catch (e) { throw fail(e.code ?? 'INVALID_RECIPE_INPUT'); }
  }
  if (unknown.length || missing.length || invalid.length) throw Object.assign(fail('INVALID_RECIPE_INPUT'), { fields: { unknown, missing, invalid } });
  const effects = recipe.effects.filter((e) => e !== 'read');
  const missingAuthorization = [
    ...(effects.length && !execute ? ['execute'] : []),
    ...(recipe.effects.includes('provider-send') && !authorizeSend ? ['provider-send'] : []),
  ];
  const ready = missingAuthorization.length === 0;
  return {
    schema: 'vivim.recipe-plan/1', id: recipe.id, version: recipe.version, tool: recipe.tool,
    family: recipe.family, transport: 'studio-tool', inputFields: Object.keys(input).sort(),
    // Important: no private prompt/body strings are present in the plan or diagnostics.
    inputDigest: argsDigestOf(input), effects: recipe.effects, requires: recipe.requires,
    evidence: recipe.evidence, maxUserCommands: recipe.maxUserCommands,
    ready, status: ready ? 'eligible-static' : 'authorization-required',
    missingAuthorization, unverifiedRuntimeRequirements: recipe.requires,
    onUnknownEffect: recipe.onUnknownEffect,
    nextSafeAction: ready ? 'execute-via-studio-owner' : 'obtain-explicit-authorization',
    note: 'Static eligibility only. Runtime verifies live owner, thread identity, authorization and journal again at effect time.',
  };
}
