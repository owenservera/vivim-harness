// Canonical privacy-safe result projection for CLI, agent recipes and tool clients.
// Preserve identifiers, states, revisions, coverage and source links; never echo prompt/reply
// bodies or natural-language titles unless the caller explicitly opts in to full content.
const PRIVATE_FIELDS = new Set(['text', 'prompt', 'title', 'content', 'body', 'html', 'markdown', 'raw']);

export function metadataOnly(value, depth = 0) {
  // Bounded depth avoids accidentally serializing untrusted cyclic or enormous provider shapes.
  if (depth > 32) return null;
  if (Array.isArray(value)) return value.map((item) => metadataOnly(item, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !PRIVATE_FIELDS.has(key))
      .map(([key, item]) => [key, metadataOnly(item, depth + 1)]));
  }
  return value;
}
