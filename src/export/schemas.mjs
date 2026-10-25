import { exportCapability } from './capabilities.mjs';
import { openSink, ExportError } from './export.mjs';

const DRAFT = 'https://json-schema.org/draft/2020-12/schema';

// Older MODEL snapshots retain field summaries, not the full nested schema. Mark that loss.
function typeDescription(type) {
  if (type.schema) return { description: type.schema, summaryOnly: false };
  const fields = Array.isArray(type.fields) ? type.fields : Object.entries(type.fields ?? {}).map(([name, value]) => ({ name, ...value }));
  return { summaryOnly: true, description: { type: 'object', count: type.support ?? 0,
    fields: Object.fromEntries(fields.map((field) => [field.name, field.schema ?? {
      type: field.type, nullable: field.nullable, presence: field.presence,
      // Rounded presence values cannot prove a field was always present.
      required: field.required === true,
      ...(field.enum ? { string: { enum: field.enum.map((value) => ({ value })) } } : {}),
    }])) } };
}

// loadArtifacts is optional. A missing derive-all engine must not block schemas already stored on the session.
async function savedArtifacts(session) {
  try {
    const loadArtifacts = await exportCapability('../replay/derive-all.mjs', 'loadArtifacts', 'Derived schema artifacts');
    return await loadArtifacts(session);
  } catch (error) {
    if (error.code !== 'CAPABILITY_UNAVAILABLE' && !session.kv.get('MODEL', null) && !session.kv.get('SCHEMAS', null)) throw error;
    return null;
  }
}

export async function sessionSchemas(session) {
  const loaded = await savedArtifacts(session);
  const artifacts = loaded?.artifacts ?? (loaded && typeof loaded === 'object' ? loaded : {});
  const model = artifacts.model ?? session.kv.get('MODEL', null);
  if (model?.error) throw new ExportError(`Knowledge derivation failed: ${model.error}`, 'KNOWLEDGE_FAILED');
  const entries = (model?.types ?? []).map((type) => ({ id: String(type.id ?? type.name), name: type.name ?? type.id, ...typeDescription(type) }));
  const schemas = artifacts.schemas ?? artifacts.schemaProfiler ?? session.kv.get('SCHEMAS', null);
  const groups = Array.isArray(schemas) ? schemas : schemas?.groups ?? [];
  for (const group of groups) {
    const description = group.schema ?? group.description;
    const id = group.id ?? group.group ?? group.name;
    if (id !== undefined && description && !entries.some((entry) => entry.id === String(id))) entries.push({ id: String(id), name: group.name ?? String(id), description, summaryOnly: false });
  }
  if (!model && !schemas) throw new ExportError(`No schemas for ${session.id}. Run "studio derive ${session.id}" first.`, 'NO_KNOWLEDGE');
  return entries;
}

function alreadyJsonSchema(description) {
  return !!description && typeof description === 'object' && (description.$schema || description.properties || description.$ref);
}

async function portableSchema(entry) {
  if (alreadyJsonSchema(entry.description)) {
    return { $schema: entry.description.$schema ?? DRAFT, ...entry.description, title: entry.description.title ?? entry.name,
      'x-capture-type': entry.id, 'x-summary-only': entry.summaryOnly };
  }
  const toJsonSchema = await exportCapability('../shapes/profiler.mjs', 'toJsonSchema', 'JSON Schema conversion');
  return { ...toJsonSchema(entry.description), title: entry.name,
    'x-capture-type': entry.id, 'x-summary-only': entry.summaryOnly,
    $comment: 'Inferred from observed samples, not an authoritative server contract. Summary-only schemas omit unavailable nested detail.' };
}

export async function schemaForType(session, name, { jsonSchema = false } = {}) {
  const entries = await sessionSchemas(session);
  const exact = entries.filter((entry) => entry.id === name);
  const matches = exact.length ? exact : entries.filter((entry) => String(entry.name).toLowerCase() === String(name).toLowerCase());
  if (matches.length !== 1) throw new ExportError(matches.length ? `Ambiguous type "${name}"; use its exact id.` : `No schema for type "${name}" in ${session.id}.`, 'NO_KNOWLEDGE');
  return jsonSchema ? portableSchema(matches[0]) : { session: session.id, ...matches[0] };
}

export async function exportSchemas(session, outFile, { type } = {}) {
  const entries = await sessionSchemas(session);
  const selected = type ? entries.filter((entry) => entry.id === type || String(entry.name).toLowerCase() === String(type).toLowerCase()) : entries;
  if (type && selected.length !== 1) throw new ExportError(`Expected one schema for "${type}", found ${selected.length}. Use an exact type id.`, 'NO_KNOWLEDGE');
  const definitions = [];
  for (const entry of selected) definitions.push([entry.id, await portableSchema(entry)]);
  const bundle = { $schema: DRAFT, title: `Observed schemas for ${session.id}`, 'x-session': session.id,
    $comment: 'Definition bundle; select a type with a JSON Pointer into $defs. The root imposes no instance constraint.',
    $defs: Object.fromEntries(definitions) };
  const text = JSON.stringify(bundle, null, 2) + '\n';
  const sink = openSink(outFile);
  await sink.write(text); await sink.end();
  return { file: sink.path, bytes: Buffer.byteLength(text), format: 'json-schema', types: selected.length };
}
