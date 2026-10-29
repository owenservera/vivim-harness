// Local-only, explicit Personal Agent memory search. Never indexes conversations or calls a provider.
// Matches bounded user-authored memory; response previews stay private to the authenticated Studio.
export const MEMORY_SEARCH_TIERS = Object.freeze(['CANON', 'Immediate', 'Curated']);
const bad = (message, code = 'PERSONAL_AGENT_MEMORY_SEARCH_INVALID', status = 400) =>
  Object.assign(new Error(message), { code, status });
const normalize = value => String(value).toLocaleLowerCase('en-US');
const MAX_PREVIEW = 240;

export function searchPersonalAgentMemory(state, { query, tier = 'all', limit = 20 } = {}) {
  if (typeof query !== 'string' || query.trim().length < 2 || query.trim().length > 120 ||
      /[\u0000-\u001f\u007f]/u.test(query)) {
    throw bad('Memory search query must be 2..120 characters on one line');
  }
  if (tier !== 'all' && !MEMORY_SEARCH_TIERS.includes(tier)) {
    throw bad('Unknown memory search tier');
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
    throw bad('Memory search limit must be an integer from 1 to 50');
  }
  if (!state || typeof state !== 'object') throw bad('Memory state unavailable', 'PERSONAL_AGENT_MEMORY_SEARCH_STATE', 500);
  const search = normalize(query.trim());
  const tiers = tier === 'all' ? MEMORY_SEARCH_TIERS : [tier];
  const hits = [];
  let order = 0;
  for (const currentTier of tiers) {
    const entries = state.memory?.[currentTier] ?? [];
    if (!Array.isArray(entries) || entries.length > 500) {
      throw bad('Memory tier unavailable or inconsistent', 'PERSONAL_AGENT_MEMORY_SEARCH_STATE', 500);
    }
    for (const entry of entries) {
      if (typeof entry?.key !== 'string' || typeof entry?.text !== 'string' ||
          entry.key.length > 64 || entry.text.length > 8000 || entry.source !== 'user-authored') {
        throw bad('Memory record has invalid provenance or content', 'PERSONAL_AGENT_MEMORY_SEARCH_STATE', 500);
      }
      const key = normalize(entry.key), text = normalize(entry.text);
      const keyAt = key.indexOf(search), textAt = text.indexOf(search);
      if (keyAt < 0 && textAt < 0) continue;
      const rank = key === search ? 0 : keyAt === 0 ? 1 : keyAt >= 0 ? 2 : 3;
      const start = textAt < 0 ? 0 : Math.max(0, textAt - 60);
      const part = entry.text.slice(start, start + MAX_PREVIEW);
      const preview = (start ? '…' : '') + part + (start + part.length < entry.text.length ? '…' : '');
      hits.push({ tier: currentTier, key: entry.key, preview, source: entry.source,
        updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : null,
        match: keyAt >= 0 ? 'key' : 'text', rank, order: order++ });
    }
  }
  hits.sort((a, b) => a.rank - b.rank ||
    String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')) ||
    a.order - b.order);
  const limited = hits.slice(0, limit).map(({ rank, order, ...item }) => item);
  return {
    tier, total: hits.length, shown: limited.length, truncated: hits.length > limited.length,
    items: limited,
    scope: 'private-user-authored-local-memory',
    execution: 'read-only-local-search; no provider, model, browser or conversation access',
  };
}
