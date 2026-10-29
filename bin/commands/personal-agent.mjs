// Personal Agent local bootstrap commands: no running Studio or browser required.
import { define, defineGroup } from '../lib/registry.mjs';
import { createPersonalAgentService } from '../../src/agents/personal-agent-service.mjs';
import { usageError } from '../lib/ui.mjs';
import { randomUUID } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { inspectPortableSnapshot, MAX_AGENT_EXPORT_DOCUMENT_BYTES } from '../../src/agents/personal-agent-continuity.mjs';

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

define({ name: 'personal-agent self', section: 'System', usage: '[identity|bootstrap|memory|work|world|capabilities|privacy|all]',
  summary: 'Read source-qualified local self-knowledge with freshness and provenance',
  examples: ['studio personal-agent self all --json', 'studio personal-agent self capabilities --json'],
  run(ctx) {
    if (ctx.args.length > 1) throw usageError('Usage: studio personal-agent self [topic]');
    emit(ctx, service(ctx).selfKnowledge(ctx.args[0] ?? 'all'));
  },
});
define({ name: 'personal-agent work', section: 'System',
  summary: 'List private user-directed local Work, with no tool/provider dispatch',
  examples: ['studio personal-agent work --json'],
  run(ctx) { noArgs(ctx); emit(ctx, service(ctx).workList()); },
});
define({ name: 'personal-agent queue', section: 'System',
  summary: 'Create a local Work item with a stable idempotency key; does not execute it',
  flags: {
    title: { type: 'string', valueName: 'TEXT', desc: 'Work title' },
    objective: { type: 'string', valueName: 'TEXT', desc: 'Work objective' },
    key: { type: 'string', valueName: 'KEY', desc: 'Optional stable idempotency key for safe retries' },
  },
  examples: ['studio personal-agent queue --title "Review sources" --objective "Inventory sources only" --json'],
  run(ctx) {
    noArgs(ctx);
    if (!ctx.flags.title || !ctx.flags.objective) throw usageError('Both --title and --objective are required');
    const agent = service(ctx), current = agent.status();
    if (!current.initialized) throw usageError('Bootstrap the Personal Agent first');
    emit(ctx, agent.createWorkItem({ expectedVersion: current.version,
      title: ctx.flags.title, objective: ctx.flags.objective, idempotencyKey: ctx.flags.key ?? randomUUID() }));
  },
});
define({ name: 'personal-agent advance', section: 'System', usage: '<work-id>',
  summary: 'Explicitly transition a local Work item; does not send to a provider',
  flags: {
    to: { type: 'string', choices: ['active', 'blocked', 'completed', 'cancelled'], valueName: 'STATE', desc: 'New state' },
    note: { type: 'string', valueName: 'TEXT', desc: 'Reason (required for blocked)' },
    evidence: { type: 'list', valueName: 'REF,...', desc: 'User-attested evidence references (required for completed)' },
  },
  examples: ['studio personal-agent advance work-0123456789abcdef0123456789abcdef --to blocked --note "Need owner identity" --json'],
  run(ctx) {
    if (ctx.args.length !== 1 || !ctx.flags.to) throw usageError('Usage: studio personal-agent advance <work-id> --to <state>');
    const agent = service(ctx), current = agent.status();
    if (!current.initialized) throw usageError('Bootstrap the Personal Agent first');
    emit(ctx, agent.transitionWorkItem({ expectedVersion: current.version,
      id: ctx.args[0], to: ctx.flags.to, note: ctx.flags.note, evidence: ctx.flags.evidence ?? [] }));
  },
});

define({ name: 'personal-agent plan', section: 'System', usage: '<work-id>',
  summary: 'Set or clear a user-authored next action for open local Work (no execution)',
  flags: {
    next: { type: 'string', valueName: 'TEXT', desc: 'Next local action (1..1000 characters)' },
    clear: { type: 'boolean', desc: 'Clear the next action (not allowed for blocked Work)' },
  },
  examples: ['studio personal-agent plan work-0123456789abcdef0123456789abcdef --next "Review receipts" --json',
    'studio personal-agent plan work-0123456789abcdef0123456789abcdef --clear --json'],
  run(ctx) {
    if (ctx.args.length !== 1 || (!!ctx.flags.clear === !!ctx.flags.next)) {
      throw usageError('Usage: studio personal-agent plan <work-id> (--next <text> | --clear)');
    }
    const agent = service(ctx), current = agent.status();
    if (!current.initialized) throw usageError('Bootstrap the Personal Agent first');
    emit(ctx, agent.updateWorkNextAction({
      expectedVersion: current.version, id: ctx.args[0],
      nextAction: ctx.flags.clear ? null : ctx.flags.next,
    }));
  },
});

define({ name: 'personal-agent sitrep', section: 'System',
  summary: 'Private, bounded continuity packet: bootstrap, recent memory and outstanding Work',
  examples: ['studio personal-agent sitrep --json'],
  run(ctx) { noArgs(ctx); emit(ctx, service(ctx).continuity()); },
});
define({ name: 'personal-agent inspect-export', section: 'System', usage: '<snapshot.json>',
  summary: 'Read-only preflight of local portable Agent JSON; verifies checksum and privacy flags, never imports',
  examples: ['studio personal-agent inspect-export ./agent-snapshot.json --json'],
  run(ctx) {
    if (ctx.args.length !== 1) throw usageError('Usage: studio personal-agent inspect-export <snapshot.json>');
    const file = path.resolve(ctx.args[0]);
    let meta;
    try { meta = lstatSync(file); }
    catch { throw usageError('Snapshot file cannot be opened'); }
    if (!meta.isFile() || meta.isSymbolicLink() || meta.size < 2 || meta.size > MAX_AGENT_EXPORT_DOCUMENT_BYTES) {
      throw usageError('Snapshot must be a regular JSON file within the bounded export size');
    }
    let bundle;
    try { bundle = JSON.parse(readFileSync(file, 'utf8')); }
    catch { throw usageError('Snapshot is not valid readable JSON'); }
    emit(ctx, inspectPortableSnapshot(bundle));
  },
});

define({ name: 'personal-agent export', section: 'System',
  summary: 'Export checksummed local agent JSON; private details only on explicit flags',
  flags: {
    'include-memory': { type: 'boolean', desc: 'Explicitly include private memory text' },
    'include-work': { type: 'boolean', desc: 'Explicitly include private Work titles, objectives and events' },
  },
  examples: ['studio personal-agent export --json', 'studio personal-agent export --include-memory --include-work --json'],
  run(ctx) {
    noArgs(ctx);
    emit(ctx, service(ctx).exportSnapshot({
      includeMemory: !!ctx.flags['include-memory'],
      includeWorkDetails: !!ctx.flags['include-work'],
    }));
  },
});
