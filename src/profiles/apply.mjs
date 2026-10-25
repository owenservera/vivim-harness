// Turn an accepted (optionally edited) suggestion into a new profile version.
export function applySuggestion(profile, suggestion, { action = 'accept', edits = {} } = {}) {
  const p = structuredClone(profile);
  p.capture ??= {}; p.shapes ??= {}; p.records ??= [];
  p.shapes.renames ??= {}; p.shapes.excluded ??= []; p.shapes.accepted ??= []; p.shapes.retention ??= {};
  const stamp = { id: suggestion.id, kind: suggestion.kind, title: suggestion.title, at: new Date().toISOString() };

  if (action === 'reject') {
    if (!p.shapes.excluded.some((x) => x.id === suggestion.id)) p.shapes.excluded.push(stamp);
    return { profile: p, note: `rejected: ${suggestion.title}` };
  }
  const prop = { ...(suggestion.proposal ?? {}), ...edits };
  switch (prop.op) {
    case 'include_url': if (!p.capture.include?.includes(prop.pattern)) (p.capture.include ??= []).push(prop.pattern); break;
    case 'exclude_url': if (!p.capture.exclude?.includes(prop.pattern)) (p.capture.exclude ??= []).push(prop.pattern); break;
    case 'rename_shape': p.shapes.renames[prop.group] = prop.name; break;
    case 'record_rule': {
      const rule = { ...prop.rule, ...(edits.rule ?? {}) };
      const i = p.records.findIndex((r) => r.name === rule.name);
      if (i >= 0) p.records[i] = rule; else p.records.push(rule);
      break;
    }
    case 'retain_revisions': p.shapes.retention[prop.endpoint] = prop.choice ?? 'all'; break;
    case 'link_family': {
      p.family = prop.family;
      const chosen = (edits.mappings ?? prop.mappings ?? []).filter((m) => !m.skip);
      p.familyMappings = chosen.map((m) => ({ entity: m.entity, source: m.source, fields: m.fields, confidence: m.confidence }));
      break;
    }
    case 'add_family_mapping': (p.familyMappings ??= []).push(prop.mapping); break;
    case 'remap_family': if (prop.mapping) p.familyMappings[prop.index] = prop.mapping; break;
    default: break; // observation-only suggestion: confirmation is recorded below
  }
  p.shapes.accepted = p.shapes.accepted.filter((x) => x.id !== suggestion.id);
  p.shapes.accepted.push({ ...stamp, edits: Object.keys(edits).length ? edits : undefined });
  p.shapes.excluded = p.shapes.excluded.filter((x) => x.id !== suggestion.id);
  return { profile: p, note: `accepted: ${suggestion.title}` };
}
