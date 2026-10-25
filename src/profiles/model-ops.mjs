// Semantic edits behind the visual model editor. Each returns a new profile and a human note.
// Users pick fields, types and record types from lists; no regex or JSON editing required.
const clone = (x) => structuredClone(x);
const ruleIdx = (p, name) => { const i = (p.records ?? []).findIndex((r) => r.name === name); if (i < 0) throw new Error(`No record type "${name}".`); return i; };
const fieldSpec = (v) => (typeof v === 'string' ? { path: v } : { ...v });

export function applyModelOp(profile, op) {
  const p = clone(profile);
  p.records ??= []; p.familyMappings ??= [];
  const target = () => {
    if (op.mappingIndex !== undefined) { const m = p.familyMappings[op.mappingIndex]; if (!m) throw new Error('No such family mapping.'); return { fields: m.fields, label: `${p.family} ${m.entity}` }; }
    const r = p.records[ruleIdx(p, op.rule)]; return { fields: (r.fields ??= {}), rule: r, label: `record type “${r.name}”` };
  };
  switch (op.op) {
    case 'rename_record': { const r = p.records[ruleIdx(p, op.rule)]; if (p.records.some((x) => x.name === op.to)) throw new Error(`"${op.to}" already exists.`); r.name = op.to; return { profile: p, note: `renamed record type ${op.rule} → ${op.to}` }; }
    case 'rename_field': { const t = target(); if (!(op.field in t.fields)) throw new Error(`No field ${op.field}.`); const f = fieldSpec(t.fields[op.field]); delete t.fields[op.field]; t.fields[op.to] = f; if (t.rule?.key === `$.${op.field}`) { /* key path unchanged: it points at source data */ } return { profile: p, note: `${t.label}: renamed field ${op.field} → ${op.to}` }; }
    case 'set_field_type': { const t = target(); t.fields[op.field] = { ...fieldSpec(t.fields[op.field]), type: op.type }; return { profile: p, note: `${t.label}: ${op.field} is now ${op.type}` }; }
    case 'set_field_path': { const t = target(); t.fields[op.field] = { ...fieldSpec(t.fields[op.field] ?? {}), path: op.path }; return { profile: p, note: `${t.label}: ${op.field} now reads ${op.path}` }; }
    case 'add_field': { const t = target(); if (op.field in t.fields) throw new Error(`Field ${op.field} exists.`); t.fields[op.field] = { path: op.path, ...(op.type ? { type: op.type } : {}) }; return { profile: p, note: `${t.label}: added field ${op.field}` }; }
    case 'exclude_field': { const t = target(); t.fields[op.field] = { ...fieldSpec(t.fields[op.field]), exclude: op.exclude !== false }; return { profile: p, note: `${t.label}: ${op.exclude !== false ? 'excluded' : 'included'} ${op.field}` }; }
    case 'remove_field': { const t = target(); delete t.fields[op.field]; return { profile: p, note: `${t.label}: removed field ${op.field}` }; }
    case 'set_identity': { const r = p.records[ruleIdx(p, op.rule)]; r.key = op.field ? (typeof r.fields[op.field] === 'string' ? r.fields[op.field] : r.fields[op.field]?.path) : null; return { profile: p, note: `record type “${r.name}”: identity ${op.field ?? 'none (each observation is a new record)'}` }; }
    case 'set_revisions': { const r = p.records[ruleIdx(p, op.rule)]; r.revisions = op.mode; return { profile: p, note: `record type “${r.name}”: keep ${op.mode === 'final' ? 'only the latest version per identity' : 'every revision'}` }; }
    case 'set_relationship': { const r = p.records[ruleIdx(p, op.rule)]; r.parent = op.parent ? { rule: op.parent, field: op.field } : undefined; return { profile: p, note: op.parent ? `“${r.name}”.${op.field} links to “${op.parent}”` : `“${r.name}” relationship removed` }; }
    case 'merge_records': {
      const a = p.records[ruleIdx(p, op.rules[0])], b = p.records[ruleIdx(p, op.rules[1])];
      const merged = { ...a, name: op.to ?? `${a.name}_${b.name}`, endpoint: a.endpoint === b.endpoint ? a.endpoint : `(?:${a.endpoint})|(?:${b.endpoint})`, fields: { ...b.fields, ...a.fields }, mergedFrom: [a, b] };
      if (a.discriminator !== b.discriminator || a.discriminatorPath !== b.discriminatorPath) { merged.anyOf = [{ discriminatorPath: a.discriminatorPath, discriminator: a.discriminator }, { discriminatorPath: b.discriminatorPath, discriminator: b.discriminator }]; delete merged.discriminator; delete merged.discriminatorPath; }
      p.records = p.records.filter((r) => r !== a && r !== b); p.records.push(merged);
      return { profile: p, note: `merged ${a.name} + ${b.name} → ${merged.name}` };
    }
    case 'split_record': {
      const i = ruleIdx(p, op.rule), r = p.records[i];
      if (r.mergedFrom) { p.records.splice(i, 1, ...r.mergedFrom); return { profile: p, note: `split ${r.name} back into ${r.mergedFrom.map((x) => x.name).join(', ')}` }; }
      if (!op.byField || !op.values?.length) throw new Error('Choose a field and its values to split by.');
      const parts = op.values.map((v) => ({ ...clone(r), name: `${r.name}_${String(v).replace(/[^A-Za-z0-9]+/g, '_').toLowerCase()}`, itemFilter: { path: fieldSpec(r.fields[op.byField]).path, equals: v } }));
      p.records.splice(i, 1, ...parts);
      return { profile: p, note: `split ${r.name} by ${op.byField} into ${parts.map((x) => x.name).join(', ')}` };
    }
    case 'remove_record': { const i = ruleIdx(p, op.rule); const [r] = p.records.splice(i, 1); return { profile: p, note: `removed record type ${r.name}` }; }
    case 'set_scope': { p.scope = { ...p.scope, ...op.scope }; return { profile: p, note: `scope: ${JSON.stringify(op.scope)}` }; }
    case 'set_capture': { p.capture = { ...p.capture, ...op.capture }; return { profile: p, note: `capture settings: ${Object.keys(op.capture).join(', ')}` }; }
    case 'set_family': { p.family = op.family || null; if (!op.family) p.familyMappings = []; return { profile: p, note: op.family ? `linked to family ${op.family}` : 'unlinked from family' }; }
    case 'remove_family_mapping': { p.familyMappings.splice(op.mappingIndex, 1); return { profile: p, note: 'removed a family mapping' }; }
    default: throw new Error(`Unknown model operation "${op.op}".`);
  }
}
