// `studio providers performance`: read-only report over an ALREADY-RUNNING Studio's
// GET /api/v1/providers/performance (src/studio/provider-performance-routes.mjs ->
// provider-performance.mjs). No browser action, no session enumeration here; the route itself
// bounds its scan to the latest 200 saved job files per kind.
import { define, defineGroup } from '../lib/registry.mjs';
import { usageError, envError, CliError, fmtMs } from '../lib/ui.mjs';
import { EXIT } from '../../src/config.mjs';
import { createStudioToolClient } from '../../src/studio/tool-client.mjs';

async function callStudio(ctx, method, route, body) {
  const seconds = ctx.flags.timeout ?? 15;
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 60) throw usageError('--timeout must be 1-60 seconds.');
  const client = createStudioToolClient({ port: ctx.flags['studio-port'] ?? ctx.settings.studioPort, timeoutMs: seconds * 1000,
    ...(process.env.CAPTURE_STUDIO_TOKEN ? { token: process.env.CAPTURE_STUDIO_TOKEN } : {}) });
  try { return await client.recipeRequest(method, '/api/v1' + route, body); }
  catch (error) {
    if (error?.status === 503) throw envError('Could not reach the running Studio.', 'Start it first ("studio launch"), or pass the right --studio-port.');
    const code = /^[A-Z][A-Z0-9_]{0,79}$/.test(error?.code ?? '') ? error.code : 'STUDIO_CLIENT_ERROR';
    throw new CliError(code, { exit: EXIT.ENVIRONMENT, code,
      details: { httpStatus: Number.isInteger(error?.status) ? error.status : null, effect: 'none', retry: false } });
  }
}

export async function runProvidersPerformance(ctx, dependencies = {}) {
  if (ctx.args.length) throw usageError('Usage: studio providers performance');
  const report = await (dependencies.request ?? callStudio)(ctx, 'GET', '/providers/performance');
  const providers = Array.isArray(report?.providers) ? report.providers : [];
  const scanned = report?.scanned ?? {};
  ctx.out.emit(report, (o) => {
    o.table(providers, [
      { title: 'Provider', key: 'label' },
      { title: 'Jobs', key: 'jobs', align: 'right' },
      { title: 'Done', key: 'completed', align: 'right' },
      { title: 'Failed', key: 'failed', align: 'right' },
      { title: 'Signed out', key: 'skipped', align: 'right' },
      { title: 'Uncertain', key: 'uncertain', align: 'right' },
      { title: 'Median', get: (r) => fmtMs(r.medianMs) },
      { title: 'P90', get: (r) => fmtMs(r.p90Ms) },
      { title: 'Last problem', get: (r) => r.lastError?.message ?? '-' },
    ], { empty: 'No comparison or AI-design jobs recorded yet.' });
    o.line('');
    o.line(`Scanned latest ${scanned.compareJobs ?? 0} comparison job(s), ${scanned.aiDesignJobs ?? 0} app-design job(s) and ${scanned.orchestratePlans ?? 0} orchestrated plan(s) (cap ${scanned.maxPerKind ?? 0} each).`);
  });
}

defineGroup('providers', { section: 'Knowledge', default: 'performance',
  summary: 'Read how your own AI accounts have been performing as development subagents' });
define({
  name: 'providers performance', section: 'Knowledge', noData: true,
  summary: 'Per-provider jobs/completed/failed/signed-out/uncertain counts, median and p90 time-to-answer, and the last plain-language error',
  description: 'Reads GET /api/v1/providers/performance on an already-running Studio: a read-only summary built from saved "studio ask" comparison jobs, app-design jobs and orchestrated plans for each of your signed-in AI accounts (ChatGPT, Claude, Z.ai, Qwen, DeepSeek, Gemini). No browser action and no live probe; it only reads what was already saved.',
  flags: {
    'studio-port': { type: 'number', valueName: 'PORT', desc: 'Existing Studio HTTP port (default configured port)' },
    timeout: { type: 'number', valueName: 'SECONDS', default: 15, desc: 'One request, 1-60 seconds; no retries' },
  },
  examples: ['studio providers performance --json'],
  run: runProvidersPerformance,
});
