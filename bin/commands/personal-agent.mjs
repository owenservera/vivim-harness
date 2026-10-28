// Personal Agent local bootstrap commands: no running Studio or browser required.
import { define, defineGroup } from '../lib/registry.mjs';
import { createPersonalAgentService } from '../../src/agents/personal-agent-service.mjs';
import { usageError } from '../lib/ui.mjs';

const emit = (ctx, data) => ctx.out.emit(data, out => out.line(JSON.stringify(data, null, 2)));
const service = ctx => createPersonalAgentService({ paths: ctx.paths });
const noArgs = ctx => { if (ctx.args.length) throw usageError('Unexpected positional argument'); };

export async function runPersonalAgentStatus(ctx) {
  noArgs(ctx);
  emit(ctx, service(ctx).status());
}
export async function runPersonalAgentBootstrap(ctx) {
  noArgs(ctx);
  const agent = service(ctx);
  const current = agent.status();
  // Optimistic CAS precondition captured immediately before bootstrapping. It must not
  // silently merge a concurrent change: VersionedStore rejects stale revisions.
  emit(ctx, agent.bootstrap({ expectedVersion: current.initialized ? current.version : null }));
}
export async function runPersonalAgentCapabilities(ctx) {
  noArgs(ctx);
  emit(ctx, service(ctx).capabilities());
}
defineGroup('personal-agent', { section: 'System', default: 'status',
  summary: 'Local Personal Agent lifecycle, bootstrap and capability discovery',
  description: 'One local, resumable four-stage scaffold. No new daemon, provider send or browser session. Data stays in the configured Studio directory.' });
define({ name: 'personal-agent status', section: 'System',
  summary: 'Read bootstrap progress, memory counts and next stage (no initialization)',
  examples: ['studio personal-agent status --json'], run: runPersonalAgentStatus });
define({ name: 'personal-agent bootstrap', section: 'System',
  summary: 'Initialize/resume four evidence-backed local bootstrap stages (no provider effects)',
  examples: ['studio personal-agent bootstrap --json'], run: runPersonalAgentBootstrap });
define({ name: 'personal-agent capabilities', section: 'System',
  summary: 'Inspect discovered local skills, not installed or live-tested tools',
  examples: ['studio personal-agent capabilities --json'], run: runPersonalAgentCapabilities });
