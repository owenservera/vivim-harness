import { readProviderPerformance } from './provider-performance.mjs';

export function registerProviderPerformanceRoutes({ add, paths }) {
  add('GET', '/providers/performance',
    'Read-only per-provider performance summary from saved comparison and AI-design job files (latest 200 per kind; no browser action)',
    () => readProviderPerformance({ paths }), { tool: 'provider_performance' });
}
