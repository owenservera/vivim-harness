// Single sanitizer for provider URLs projected into the world (API reads, search hit source,
// relations nodes, export, import re-validation). Read-time: stored session bytes are never
// rewritten; imported and legacy stored values are sanitized at projection time.
//
// Rule: parse with URL; only http/https; keep origin + pathname; DROP userinfo (user:pass@),
// query string and fragment. Unparsable, non-http(s) or non-string -> null.
//
// KNOWN LIMIT: the path is kept. A URL whose secret is a path segment cannot be detected from the
// stored bytes alone, so the pathname survives for usability; every projection discloses that the
// value is origin+pathname only.
export function sanitizeProviderUrl(value) {
  if (typeof value !== 'string') return null;
  let url;
  try { url = new URL(value.trim()); } catch { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return url.origin + url.pathname;
}

// For records that carry a source object (conversation metadata, imported records, stored
// source-references/selections): overwrite providerUrl in place of the copy only.
export const sanitizedSource = (source) => {
  if (!source || typeof source !== 'object' || !Object.hasOwn(source, 'providerUrl')) return source;
  return { ...source, providerUrl: sanitizeProviderUrl(source.providerUrl) };
};
// Diff the given providerUrl against its sanitized form and name what was changed. Returns
// null when the value already projects as itself (clean, absent or non-string): no note needed.
export const providerUrlRemovalReason = (value) => {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return 'provider-url-unparsable-removed';
  const safe = sanitizeProviderUrl(value);
  if (safe !== null) return safe === value.trim() ? null : 'provider-url-query-removed';
  return safe === null ? 'provider-url-unparsable-removed' : null;
};
