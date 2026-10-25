// Optional engines must not prevent existing export formats from loading.
export async function exportCapability(relativePath, name, label) {
  let mod;
  try { mod = await import(new URL(relativePath, import.meta.url)); }
  catch (error) {
    if (!['ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND', 'ENOENT'].includes(error.code)) throw error;
    throw Object.assign(new Error(`${label} is not available in this build: ${error.message}`), { code: 'CAPABILITY_UNAVAILABLE' });
  }
  if (typeof mod[name] !== 'function') throw Object.assign(new Error(`${label} is not available in this build (missing ${name}).`), { code: 'CAPABILITY_UNAVAILABLE' });
  return mod[name];
}
