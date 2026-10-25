// help, version, doctor, paths, config, completion
import { accessSync, constants, existsSync } from 'node:fs';
import { VERSION, collectorSourceSha, SETTINGS_SCHEMA, parseSetting, loadUserConfig, saveUserConfig, EXIT } from '../../src/config.mjs';
import { findChrome } from '../../src/chrome/launch.mjs';
import { isReachable, browserVersion } from '../../src/cdp/discovery.mjs';
import { lintProfile } from '../../src/profiles/manage.mjs';
import { define, defineGroup, allGroups, renderRootHelp, renderCommandHelp, renderGroupHelp, resolveCommand, completionScript, allCommands } from '../lib/registry.mjs';
import { usageError, fmtBytes } from '../lib/ui.mjs';

// ---------------------------------------------------------------------------------------------
define({
  name: 'help', section: 'Get started', usage: '[command]', summary: 'Show help for a command',
  description: 'Show the command list, or the options and examples for one command (e.g. "studio help export dataset").',
  noData: true,
  async run(ctx) {
    const words = ctx.args;
    const { out } = ctx;
    if (!words.length) { out.raw(`${renderRootHelp({ version: VERSION, dataDir: ctx.paths.root })}\n`); return; }
    if (allGroups().has(words[0]) && !words[1]) { out.raw(`${renderGroupHelp(words[0])}\n`); return; }
    const { def } = resolveCommand(words);
    out.raw(`${renderCommandHelp(def)}\n`);
  },
});

define({
  name: 'version', section: 'System', summary: 'Print the version and collector source hash', noData: true,
  async run(ctx) {
    const data = { version: VERSION, collectorSourceSha: collectorSourceSha(), node: process.version, platform: `${process.platform}-${process.arch}` };
    ctx.out.emit(data, (o) => o.result(`${VERSION} ${data.collectorSourceSha}`));
  },
});

// ---------------------------------------------------------------------------------------------
define({
  name: 'doctor', section: 'Get started', summary: 'Check Node, Chrome, DevTools, data folder, learner and profiles',
  description: 'Runs environment and data-health checks. Exits 5 when something required is missing, 0 otherwise (a stopped capture browser is only a warning).',
  flags: { fix: { type: 'boolean', desc: 'Print the suggested fix for every non-ok check' } },
  async run(ctx) {
    const { out, paths, port } = ctx;
    const checks = [];
    const add = (name, level, detail, fix = '') => checks.push({ name, level, detail, fix });

    const major = Number(process.versions.node.split('.')[0]);
    add('node', major >= 22 ? 'ok' : 'fail', process.version, major >= 22 ? '' : 'Install Node 22 or newer (built-in WebSocket is required).');

    let chrome = null; try { chrome = findChrome(); } catch { /* reported below */ }
    add('chrome', chrome ? 'ok' : 'fail', chrome ?? 'not found', chrome ? '' : 'Install Google Chrome (or Edge) or set CHROME_PATH.');

    const up = await isReachable({ port });
    let browser = null; if (up) { try { browser = (await browserVersion({ port })).Browser; } catch { /* raced */ } }
    add('devtools', up ? 'ok' : 'warn', up ? `127.0.0.1:${port} (${browser ?? 'unknown'})` : `127.0.0.1:${port} not running`, up ? '' : 'Run "studio launch" to open the capture browser.');

    let writable = true; try { accessSync(paths.root, constants.W_OK); } catch { writable = false; }
    add('data-dir', writable ? 'ok' : 'fail', paths.root, writable ? '' : 'Choose a writable --data-dir.');

    const sessions = ctx.listSessions();
    const bytes = sessions.reduce((a, s) => a + (s.rawBytes ?? 0), 0);
    const incomplete = sessions.filter((s) => s.status === 'recording');
    add('sessions', incomplete.length ? 'warn' : 'ok', `${sessions.length} saved, ${fmtBytes(bytes)} raw${incomplete.length ? `, ${incomplete.length} still marked "recording" (crashed or running)` : ''}`,
      incomplete.length ? 'Run "studio verify <id>" then "studio derive <id>" on interrupted sessions.' : '');

    try {
      const names = ctx.profiles().names();
      let errors = 0, warns = 0;
      for (const n of names) for (const i of lintProfile(ctx.profiles().load(n))) i.level === 'error' ? errors++ : warns++;
      add('profiles', errors ? 'fail' : warns ? 'warn' : 'ok', `${names.length} profiles${errors || warns ? `, ${errors} error(s), ${warns} warning(s)` : ''}`, errors || warns ? 'Run "studio profile lint --all".' : '');
    } catch (e) { add('profiles', 'fail', e.message, 'Check the profiles folder.'); }

    try {
      const l = ctx.learner();
      add('learner', 'ok', `revision ${l.revision}, ${l.corrections.length} correction(s), ${l.proposals.filter((p) => p.status === 'proposed').length} pending`);
    } catch (e) { add('learner', 'fail', e.message, 'Learner state failed its integrity check; inspect it with "studio learn versions" or restore a revision.'); }

    const { problems } = loadUserConfig(paths.config);
    add('config', problems.length ? 'warn' : 'ok', existsSync(paths.config) ? `${paths.config}${problems.length ? ` (${problems.join('; ')})` : ''}` : 'defaults (no config file)', problems.length ? 'Fix or remove the config entries listed.' : '');

    const failed = checks.some((c) => c.level === 'fail');
    out.emit({ ok: !failed, checks }, (o) => {
      const mark = { ok: o.c.green('ok  '), warn: o.c.yellow('warn'), fail: o.c.red('FIX ') };
      for (const c of checks) {
        o.line(`${mark[c.level]} ${c.name.padEnd(9)} ${c.detail}`);
        if (c.fix && c.level !== 'ok') o.line(`     ${o.c.dim(c.fix)}`);
      }
    });
    if (failed) process.exitCode = EXIT.ENVIRONMENT;
  },
});

// ---------------------------------------------------------------------------------------------
define({
  name: 'paths', section: 'System', summary: 'Print the data folder layout',
  async run(ctx) {
    const data = { ...ctx.paths };
    ctx.out.emit(data, (o) => o.kv(Object.entries(data)));
  },
});

// ---------------------------------------------------------------------------------------------
defineGroup('config', { summary: 'View and change persistent defaults (config.json in the data folder)', section: 'System', default: 'show' });

define({
  name: 'config show', section: 'System', summary: 'Show effective settings and where each value comes from',
  async run(ctx) {
    const rows = Object.entries(SETTINGS_SCHEMA).map(([key, spec]) => ({ key, value: ctx.settings[key], source: ctx.sources[key], env: spec.env, description: spec.desc }));
    ctx.out.emit({ file: ctx.paths.config, settings: rows }, (o) => {
      o.table(rows, [{ title: 'SETTING', key: 'key' }, { title: 'VALUE', get: (r) => JSON.stringify(r.value) }, { title: 'FROM', key: 'source' }, { title: 'DESCRIPTION', key: 'description', max: 70 }]);
      o.line(o.c.dim(`File: ${ctx.paths.config}   (flags > environment > file > defaults)`));
    });
  },
});

define({
  name: 'config get', section: 'System', usage: '<key>', summary: 'Print one effective setting',
  async run(ctx) {
    const [key] = ctx.args;
    if (!key) throw usageError('Usage: studio config get <key>', `Keys: ${Object.keys(SETTINGS_SCHEMA).join(', ')}`);
    if (!(key in SETTINGS_SCHEMA)) throw usageError(`Unknown setting "${key}".`, `Keys: ${Object.keys(SETTINGS_SCHEMA).join(', ')}`);
    ctx.out.emit({ key, value: ctx.settings[key], source: ctx.sources[key] }, (o) => o.result(String(ctx.settings[key])));
  },
});

define({
  name: 'config set', section: 'System', usage: '<key> <value>', summary: 'Persist a default in config.json',
  examples: ['studio config set cdpPort 9333', 'studio config set exportFormat csv', 'studio config set autoDerive false'],
  async run(ctx) {
    const [key, ...rest] = ctx.args;
    if (!key || !rest.length) throw usageError('Usage: studio config set <key> <value>', `Keys: ${Object.keys(SETTINGS_SCHEMA).join(', ')}`);
    const value = parseSetting(key, rest.join(' '));
    const { values } = loadUserConfig(ctx.paths.config);
    values[key] = value;
    saveUserConfig(ctx.paths.config, values);
    ctx.out.emit({ key, value, file: ctx.paths.config }, (o) => o.result(`${key} = ${JSON.stringify(value)}  (${ctx.paths.config})`));
  },
});

define({
  name: 'config unset', section: 'System', usage: '<key>', summary: 'Remove a persisted default',
  async run(ctx) {
    const [key] = ctx.args;
    if (!key) throw usageError('Usage: studio config unset <key>');
    if (!(key in SETTINGS_SCHEMA)) throw usageError(`Unknown setting "${key}".`, `Keys: ${Object.keys(SETTINGS_SCHEMA).join(', ')}`);
    const { values } = loadUserConfig(ctx.paths.config);
    const had = key in values;
    delete values[key];
    saveUserConfig(ctx.paths.config, values);
    ctx.out.emit({ key, removed: had }, (o) => o.result(had ? `Removed ${key}.` : `${key} was not set.`));
  },
});

define({
  name: 'config path', section: 'System', summary: 'Print the config file path',
  async run(ctx) { ctx.out.emit({ file: ctx.paths.config, exists: existsSync(ctx.paths.config) }, (o) => o.result(ctx.paths.config)); },
});

// ---------------------------------------------------------------------------------------------
define({
  name: 'completion', section: 'System', usage: '<bash|zsh|pwsh>', summary: 'Print a shell completion script', noData: true,
  examples: ['source <(studio completion bash)', 'studio completion pwsh | Out-String | Invoke-Expression'],
  async run(ctx) {
    const shell = ctx.args[0];
    if (!shell) throw usageError('Usage: studio completion <bash|zsh|pwsh>');
    ctx.out.raw(completionScript(shell));
  },
});

define({
  name: 'commands', section: 'System', summary: 'List every command (machine-readable with --json)', noData: true,
  async run(ctx) {
    const rows = allCommands().filter((c) => !c.hidden).map((c) => ({ command: c.name, section: c.section, summary: c.summary, usage: c.usage, flags: Object.keys(c.flags) }));
    ctx.out.emit(rows, (o) => o.table(rows, [{ title: 'COMMAND', key: 'command' }, { title: 'SUMMARY', key: 'summary', max: 90 }]));
  },
});
