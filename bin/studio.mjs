#!/usr/bin/env node
// Capture Studio command line. Every command is a thin layer over the same engine the UI uses.
//
//   bin/studio.mjs                 entry point: parse, resolve, run, report errors with stable exit codes
//   bin/lib/args.mjs               strict zero-dependency argument parser
//   bin/lib/registry.mjs           command registry, help, shell completion
//   bin/lib/context.mjs            data paths, settings, stores, session references
//   bin/lib/ui.mjs                 human / --json output, tables, errors
//   bin/commands/*.mjs             commands by area (system, capture, sessions, replay, export, knowledge, learn, profiles)
import path from 'node:path';
import { VERSION, collectorSourceSha, defaultDataDir, EXIT } from '../src/config.mjs';
import { GLOBAL_FLAGS, resolveCommand, renderRootHelp, renderCommandHelp, renderGroupHelp } from './lib/registry.mjs';
import { parseArgv, leadingWords } from './lib/args.mjs';
import { buildContext } from './lib/context.mjs';
import { createOutput, reportError } from './lib/ui.mjs';

import './commands/system.mjs';
import './commands/capture.mjs';
import './commands/sessions.mjs';
import './commands/replay.mjs';
import './commands/mirror.mjs';
import './commands/export.mjs';
import './commands/knowledge.mjs';
import './commands/platform.mjs';
import './commands/selftest.mjs';
import './commands/learn.mjs';
import './commands/profiles.mjs';
import './commands/drive.mjs';
import './commands/chat.mjs';
import './commands/run.mjs';
import './commands/library.mjs';
import './commands/campaign.mjs';
import './commands/tools.mjs';

// A closed pipe (studio … | head) is a normal way to finish, not an error.
process.stdout.on('error', (e) => { if (e.code === 'EPIPE') process.exit(0); });

// Supervisor IPC stop (scripts/always-on.mjs sends { type: 'stop' }).
// Windows cannot deliver a catchable SIGINT to a child: process.kill() terminates it outright,
// which is what used to leave session.json at "recording" with an unfinalized raw segment. So the
// supervisor asks over the IPC channel instead, and the request is re-emitted as the very same
// SIGINT event the Ctrl+C path uses (bin/commands/capture.mjs:185 -> runRecording finalize), so
// the save/derive/exit logic exists once. Nothing else in this file may stop a recording.
if (process.channel) {
  process.on('message', (m) => {
    if (m !== 'stop' && m?.type !== 'stop') return;
    const handled = process.emit('SIGINT');
    // No recording is listening (e.g. a command that never attaches a handler): nothing to save.
    if (!handled) process.exit(0);
    // Safety net only: the graceful path exits by itself once the session is finalized.
    setTimeout(() => process.exit(0), 25_000).unref();
  });
}

async function main(argv) {
  const hasFlag = (...names) => { const end = argv.indexOf('--'); return argv.slice(0, end < 0 ? undefined : end).some((a) => names.includes(a)); };
  const words = leadingWords(argv, GLOBAL_FLAGS, 2);
  const dataDir = (() => {
    const i = argv.findIndex((a) => a === '--data-dir' || a.startsWith('--data-dir='));
    if (i < 0) return defaultDataDir();
    return path.resolve(argv[i].includes('=') ? argv[i].split('=').slice(1).join('=') : (argv[i + 1] ?? '.'));
  })();

  if (!words.length) {
    if (hasFlag('--version', '-V')) { console.log(`${VERSION} ${collectorSourceSha()}`); return; }
    console.log(renderRootHelp({ version: VERSION, dataDir }));
    return;
  }

  const { def, consumed, group } = resolveCommand(words);

  if (hasFlag('--help', '-h')) {
    if (group && consumed === 1 && words.length === 1) console.log(renderGroupHelp(group));
    else console.log(renderCommandHelp(def));
    return;
  }

  const spec = { ...GLOBAL_FLAGS, ...def.flags };
  const { flags, positional } = parseArgv(argv, spec, { command: def.name });
  if (flags.version === true && def.name !== 'help') { console.log(`${VERSION} ${collectorSourceSha()}`); return; }

  const ctx = buildContext({ def, flags, args: positional.slice(consumed), argv });
  try {
    await def.run(ctx);
  } catch (e) {
    process.exitCode = reportError(e, ctx.out);
  }
  if (def.forceExit) process.exit(process.exitCode ?? EXIT.OK);
}

main(process.argv.slice(2)).catch((e) => {
  const out = createOutput({ json: process.argv.includes('--json') });
  process.exitCode = reportError(e, out);
});
