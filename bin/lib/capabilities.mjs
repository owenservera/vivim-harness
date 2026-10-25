import { CliError } from './ui.mjs';

// Keep optional/in-progress engines out of the CLI's startup import graph.
export async function capability(relativePath, names, label) {
  let mod;
  try { mod = await import(new URL(relativePath, import.meta.url)); }
  catch (error) {
    if (!['ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND', 'ENOENT'].includes(error.code)) throw error;
    throw unavailable(label, error.message);
  }
  for (const name of names) if (typeof mod[name] !== 'function') throw unavailable(label, `Missing export ${name}.`);
  return mod;
}

export function unavailable(label, details) {
  return new CliError(`${label} is not available in this build.`, {
    exit: 5, code: 'CAPABILITY_UNAVAILABLE', details,
    hint: 'Install or finish the corresponding Capture Studio engine module, then retry.',
  });
}

export function stageProgress(out, session) {
  return (stage, detail) => {
    const event = typeof stage === 'object' && stage !== null ? stage : { stage, ...(typeof detail === 'object' ? detail : { status: detail }) };
    out.info(`[${session}] ${event.stage ?? event.name ?? event.id ?? 'derive'}${event.status ?? event.state ? `: ${event.status ?? event.state}` : ''}${event.message ? ` — ${event.message}` : ''}`);
  };
}
