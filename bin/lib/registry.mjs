// Command registry: definitions, group/alias resolution, help text, shell completion.
import { closest } from './args.mjs';
import { usageError } from './ui.mjs';

export const SECTIONS = ['Get started', 'Capture', 'Sessions', 'Replay and derive', 'Export', 'Knowledge', 'Learning', 'Profiles and families', 'System'];

export const GLOBAL_FLAGS = {
  'data-dir': { type: 'string', valueName: 'DIR', desc: 'Where sessions/profiles/learner state live (env CAPTURE_STUDIO_HOME)' },
  port: { type: 'number', valueName: 'N', desc: 'Chrome DevTools port (env CAPTURE_STUDIO_CDP_PORT, default 9222)' },
  json: { type: 'boolean', desc: 'Machine-readable JSON on stdout; progress and errors go to stderr' },
  quiet: { type: 'boolean', alias: 'q', desc: 'Suppress progress and decoration' },
  color: { type: 'boolean', desc: 'Colored output (use --no-color to disable; NO_COLOR is honored)' },
  verbose: { type: 'boolean', alias: 'v', desc: 'Show stack traces on errors' },
  help: { type: 'boolean', alias: 'h', desc: 'Show help for the command' },
  version: { type: 'boolean', alias: 'V', desc: 'Print version' },
};

const commands = new Map();   // 'profile list' -> def
const groups = new Map();     // 'profile' -> { summary, default, passthrough, section, subAliases }
const aliases = new Map();    // 'sessions' -> 'session list'

// def: { name, section, summary, usage, description, flags, examples, noData, hidden, run(ctx) }
export function define(def) {
  if (commands.has(def.name)) throw new Error(`duplicate command ${def.name}`);
  commands.set(def.name, { flags: {}, examples: [], usage: '', ...def });
  for (const a of def.aliases ?? []) aliases.set(a, def.name);
}
export function defineGroup(name, def) {
  groups.set(name, { passthrough: false, subAliases: {}, ...def });
  for (const a of def.aliases ?? []) aliases.set(a, name);
}
export const allCommands = () => [...commands.values()];
export const allGroups = () => groups;

export function resolveCommand(words) {
  const [w0, w1] = words;
  if (w0 === undefined) return { def: commands.get('help'), consumed: 0 };
  const canonical = aliases.get(w0) ?? w0;
  if (commands.has(canonical)) return { def: commands.get(canonical), consumed: 1 };
  if (groups.has(canonical)) {
    const g = groups.get(canonical);
    const sub = g.subAliases[w1] ?? w1;
    if (sub && commands.has(`${canonical} ${sub}`)) return { def: commands.get(`${canonical} ${sub}`), consumed: 2, group: canonical };
    if (sub === undefined || g.passthrough) return { def: commands.get(`${canonical} ${g.default}`), consumed: 1, group: canonical };
    const subs = subNames(canonical);
    const near = closest(w1, subs);
    throw usageError(`Unknown ${canonical} command "${w1}".`, near.length ? `Did you mean "${canonical} ${near[0]}"?` : `Available: ${subs.join(', ')}. See "studio help ${canonical}".`);
  }
  const all = topLevelNames();
  const near = closest(w0, all);
  throw usageError(`Unknown command "${w0}".`, near.length ? `Did you mean "${near.join('" or "')}"?` : 'Run "studio help" for the command list.');
}

export const subNames = (group) => allCommands().filter((c) => c.name.startsWith(`${group} `)).map((c) => c.name.slice(group.length + 1));
export function topLevelNames() {
  const names = new Set([...groups.keys(), ...aliases.keys()]);
  for (const c of commands.values()) if (!c.name.includes(' ') && !c.hidden) names.add(c.name);
  return [...names].sort();
}

// ---------------------------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------------------------
function flagLine(name, def) {
  const left = `${def.alias ? `-${def.alias}, ` : '    '}--${name}${def.type === 'boolean' ? '' : ` <${def.valueName ?? def.type}>`}`;
  const extra = [def.choices ? `one of ${def.choices.join('|')}` : '', def.default !== undefined ? `default ${def.default}` : ''].filter(Boolean).join('; ');
  return { left, right: `${def.desc ?? ''}${extra ? ` (${extra})` : ''}` };
}
function twoCol(rows, indent = 2) {
  const w = Math.max(0, ...rows.map((r) => r.left.length));
  return rows.map((r) => `${' '.repeat(indent)}${r.left.padEnd(w)}  ${r.right}`).join('\n');
}

export function renderRootHelp({ version, dataDir }) {
  const lines = [`Capture Studio ${version} — local, read-only website capture, replay and knowledge`, '', 'Usage: studio <command> [options]      studio help <command>', ''];
  for (const section of SECTIONS) {
    const rows = [];
    const seenGroups = new Set();
    for (const c of allCommands()) {
      if (c.section !== section || c.hidden) continue;
      const top = c.name.split(' ')[0];
      if (c.name.includes(' ')) {
        if (seenGroups.has(top)) continue;
        seenGroups.add(top);
        const g = groups.get(top);
        rows.push({ left: `${top} <${subNames(top).join('|')}>`, right: g?.summary ?? '' });
      } else rows.push({ left: `${c.name}${c.usage ? ` ${c.usage}` : ''}`, right: c.summary });
    }
    if (rows.length) lines.push(`${section}`, twoCol(rows), '');
  }
  lines.push('Global options', twoCol(Object.entries(GLOBAL_FLAGS).map(([n, d]) => flagLine(n, d))), '',
    `Data folder: ${dataDir}`, 'Exit codes: 0 ok, 1 error, 2 usage, 3 not found, 4 integrity/state conflict, 5 environment (Chrome/Node)', 'Session references: <id>, unique id prefix/suffix, "latest", "latest~2" (third newest), "latest:claude.ai" (newest for a site).');
  return lines.join('\n');
}

export function renderCommandHelp(def) {
  const lines = [`studio ${def.name}${def.usage ? ` ${def.usage}` : ''}`, '', def.description ?? def.summary];
  if (Object.keys(def.flags).length) lines.push('', 'Options', twoCol(Object.entries(def.flags).map(([n, d]) => flagLine(n, d))));
  lines.push('', 'Global options: --data-dir, --port, --json, --quiet, --no-color, --verbose (see "studio help")');
  if (def.examples.length) lines.push('', 'Examples', ...def.examples.map((e) => `  ${e}`));
  return lines.join('\n');
}

export function renderGroupHelp(name) {
  const g = groups.get(name);
  const subs = allCommands().filter((c) => c.name.startsWith(`${name} `));
  const lines = [`studio ${name} <command>`, '', g?.description ?? g?.summary ?? '', '', 'Commands', twoCol(subs.map((c) => ({ left: `${c.name.slice(name.length + 1)}${c.usage ? ` ${c.usage}` : ''}`, right: c.summary }))), '', `Run "studio help ${name} <command>" for options and examples.`];
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------
// Shell completion
// ---------------------------------------------------------------------------------------------
function flagWords(def) {
  return [...new Set([...Object.keys(def.flags), ...Object.keys(GLOBAL_FLAGS)])].map((f) => `--${f}`);
}

export function completionScript(shell) {
  const tops = topLevelNames();
  const subsOf = Object.fromEntries([...groups.keys()].map((g) => [g, [...subNames(g), ...Object.keys(groups.get(g).subAliases)]]));
  const flagTable = allCommands().map((c) => [c.name, flagWords(c)]);
  const aliasTable = [...aliases].map(([a, target]) => [a, target]);
  const globalWords = Object.keys(GLOBAL_FLAGS).map((f) => `--${f}`);
  if (shell === 'bash' || shell === 'zsh') {
    const sh = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
    const script = [
      '# studio completion — source this file, e.g.  source <(studio completion bash)',
      '_studio_complete() {',
      '  local cur="${COMP_WORDS[COMP_CWORD]}" w1="${COMP_WORDS[1]}" w2="${COMP_WORDS[2]}" opts=""',
      `  if [[ $COMP_CWORD -eq 1 ]]; then COMPREPLY=( $(compgen -W ${sh(tops.join(' '))} -- "$cur") ); return; fi`,
      '  if [[ $COMP_CWORD -eq 2 && "$cur" != -* ]]; then',
      '    case "$w1" in',
      ...Object.entries(subsOf).map(([g, subs]) => `      ${g}) COMPREPLY=( $(compgen -W ${sh(subs.join(' '))} -- "$cur") ); return;;`),
      '    esac',
      '  fi',
      '  case "$w1" in',
      ...aliasTable.map(([a, target]) => `    ${a}) w1=${sh(target.split(' ')[0])}; w2=${sh(target.split(' ')[1] ?? '')};;`),
      '  esac',
      '  case "$w1 $w2" in',
      ...flagTable.map(([name, words]) => `    ${sh(name)}|${sh(`${name} `)}*) opts=${sh(words.join(' '))};;`),
      `    *) opts=${sh(globalWords.join(' '))};;`,
      '  esac',
      '  if [[ "$cur" == -* ]]; then COMPREPLY=( $(compgen -W "$opts" -- "$cur") ); fi',
      '}',
      shell === 'zsh' ? 'autoload -U +X bashcompinit && bashcompinit\ncomplete -o default -F _studio_complete studio' : 'complete -o default -F _studio_complete studio',
      '',
    ];
    return script.join('\n');
  }
  if (shell === 'pwsh' || shell === 'powershell') {
    const q = (s) => `'${s.replace(/'/g, "''")}'`;
    return [
      '# studio completion — add to your $PROFILE, e.g.  studio completion pwsh | Out-String | Invoke-Expression',
      `$script:StudioTop = @(${tops.map(q).join(', ')})`,
      `$script:StudioSubs = @{ ${Object.entries(subsOf).map(([g, s]) => `${q(g)} = @(${s.map(q).join(', ')})`).join('; ')} }`,
      `$script:StudioAlias = @{ ${aliasTable.map(([a, t]) => `${q(a)} = ${q(t)}`).join('; ')} }`,
      `$script:StudioFlags = @{ ${flagTable.map(([n, w]) => `${q(n)} = @(${w.map(q).join(', ')})`).join('; ')} }`,
      `$script:StudioGlobal = @(${globalWords.map(q).join(', ')})`,
      'Register-ArgumentCompleter -Native -CommandName studio -ScriptBlock {',
      '  param($wordToComplete, $commandAst, $cursorPosition)',
      '  $words = @($commandAst.CommandElements | Select-Object -Skip 1 | ForEach-Object { $_.ToString() })',
      '  $done = @($words | Where-Object { $_ -ne $wordToComplete })',
      '  if ($done.Count -eq 0 -and -not $wordToComplete.StartsWith("-")) { return $script:StudioTop | Where-Object { $_ -like "$wordToComplete*" } }',
      '  $w1 = $done[0]; if ($script:StudioAlias.ContainsKey($w1)) { $w1 = $script:StudioAlias[$w1] }',
      '  if ($done.Count -eq 1 -and -not $wordToComplete.StartsWith("-") -and $script:StudioSubs.ContainsKey($w1)) { return $script:StudioSubs[$w1] | Where-Object { $_ -like "$wordToComplete*" } }',
      '  $key = if ($done.Count -ge 2) { "$w1 $($done[1])" } else { $w1 }',
      '  $opts = if ($script:StudioFlags.ContainsKey($key)) { $script:StudioFlags[$key] } elseif ($script:StudioFlags.ContainsKey($w1)) { $script:StudioFlags[$w1] } else { $script:StudioGlobal }',
      '  if ($wordToComplete.StartsWith("-")) { $opts | Where-Object { $_ -like "$wordToComplete*" } }',
      '}',
      '',
    ].join('\n');
  }
  throw usageError(`Unsupported shell "${shell}".`, 'Use bash, zsh or pwsh.');
}
