// Read-only enumeration: current runtime provenance is required for an owned tab.
// Historical snapshots, same-origin URLs and recordings cannot grant ownership.
export function ownedFreshTargetIds(entries, discovered) {
  const owned = new Set(), conflicts = new Set();
  for (const entry of entries) {
    const provenance = entry.freshTargetProvenance;
    if (!provenance || entry.recovered || entry.readOnly || entry.pure || entry.finishing) continue;
    let snapshot;
    try { snapshot = entry.service.read(); } catch { continue; }
    if (snapshot.finish?.requested || snapshot.binding?.ownedByStudio !== true
      || snapshot.binding.targetId !== provenance.targetId || snapshot.binding.origin !== provenance.origin) continue;
    const matches = discovered.filter((t) => t.id === provenance.targetId && (!t.type || t.type === 'page'));
    let origin = null;
    try { if (matches.length === 1) origin = new URL(matches[0].url).origin; } catch {}
    if (origin !== provenance.origin) {
      // Revocation is only in-memory. A disappeared or foreign tab cannot regain
      // ownership if Chrome later reuses its target ID.
      entry.freshTargetProvenance = null;
      continue;
    }
    // A contested ID must never be claimed by either entry.
    if (owned.has(provenance.targetId)) { owned.delete(provenance.targetId); conflicts.add(provenance.targetId); }
    else if (!conflicts.has(provenance.targetId)) owned.add(provenance.targetId);
  }
  return owned;
}
