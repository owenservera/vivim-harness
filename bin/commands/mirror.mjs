import { define, defineGroup } from '../lib/registry.mjs';
import { usageError } from '../lib/ui.mjs';
import { capability } from '../lib/capabilities.mjs';

defineGroup('mirror', {
  section: 'Replay and derive', default: 'serve', passthrough: true,
  summary: 'Serve a saved session as a local HTTP mirror, or list its routes',
  description: 'studio mirror <session> [--port N --speed X --instant --synthesize]\nReplays saved responses on loopback. Ctrl+C stops the server. Use "studio mirror routes <session>" to inspect routes without starting it.',
});

define({
  name: 'mirror serve', section: 'Replay and derive', usage: '[id|latest]',
  summary: 'Run a loopback HTTP mirror of captured routes',
  flags: {
    port: { type: 'number', valueName: 'N', default: 8787, desc: 'Mirror HTTP port (0 selects a free port; not the Chrome port)' },
    speed: { type: 'number', valueName: 'X', default: 1, desc: 'Response playback speed multiplier' },
    instant: { type: 'boolean', desc: 'Replay without timing delays' },
    synthesize: { type: 'boolean', desc: 'Allow the engine to synthesize missing responses' },
  },
  examples: ['studio mirror latest --port 8787', 'studio mirror latest --speed 4', 'studio mirror latest --instant --synthesize'],
  async run(ctx) {
    const f = ctx.flags;
    if (!Number.isInteger(f.port) || f.port < 0 || f.port > 65535) throw usageError('--port must be an integer from 0 to 65535.');
    if (!(f.speed > 0)) throw usageError('--speed must be greater than 0.');
    const { startMirror } = await capability('../../src/mirror/index.mjs', ['startMirror'], 'Session mirror');
    const session = ctx.session(ctx.args[0]);
    const mirror = await startMirror({ session, port: f.port, host: '127.0.0.1', speed: f.speed, instant: !!f.instant, synthesize: !!f.synthesize,
      onRequest: (request) => {
        if (request.phase !== undefined && request.phase !== 'end') return;
        ctx.out.info(`mirror: ${request.method ?? ''} ${request.path ?? request.url ?? ''} ${request.status ?? request.statusCode ?? ''}`.trim());
      },
    });
    try {
      ctx.out.emit({ session: session.id, url: mirror.url, port: mirror.port }, (out) => out.result(`Mirror running at ${mirror.url}\nPress Ctrl+C to stop.`));
      await new Promise((resolve) => {
        const stop = () => { process.off('SIGINT', stop); process.off('SIGTERM', stop); resolve(); };
        process.on('SIGINT', stop); process.on('SIGTERM', stop);
      });
    } finally { await mirror.close(); }
  },
});

define({
  name: 'mirror routes', section: 'Replay and derive', usage: '[id|latest]', summary: 'List recorded mirror routes without starting a server',
  async run(ctx) {
    const { buildRouteTable } = await capability('../../src/mirror/index.mjs', ['buildRouteTable'], 'Mirror route table');
    const session = ctx.session(ctx.args[0]);
    const table = await buildRouteTable(session);
    const routes = table instanceof Map ? [...table.entries()].map(([route, value]) => ({ route, value })) : table;
    ctx.out.emit({ session: session.id, routes }, (out) => out.result(JSON.stringify(routes, null, 2)));
  },
});
