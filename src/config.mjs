import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync, statSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const TOOL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const VERSION = JSON.parse(readFileSync(path.join(TOOL_ROOT, 'package.json'), 'utf8')).version;

// Captured data is private and lives OUTSIDE the repository by default.
export function defaultDataDir(env = process.env, platform = process.platform) {
  if (env.CAPTURE_STUDIO_HOME) return env.CAPTURE_STUDIO_HOME;
  if (platform === 'win32') return path.join(env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'AION', 'capture-studio');
  if (platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'AION', 'capture-studio');
  return path.join(env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'aion-capture-studio');
}

export function dataPaths(dataDir = defaultDataDir()) {
  return {
    root: dataDir,
    sessions: path.join(dataDir, 'sessions'),
    profiles: path.join(dataDir, 'profiles'),
    families: path.join(dataDir, 'families'),
    learner: path.join(dataDir, 'learner'),
    chromeProfile: path.join(dataDir, 'chrome-profile'),
    exports: path.join(dataDir, 'exports'),
    config: path.join(dataDir, 'config.json'),
  };
}

// Directories the CLI needs to exist before any command runs (exports is created lazily).
export function ensureDataDirs(paths) {
  for (const d of [paths.root, paths.sessions, paths.profiles, paths.families]) mkdirSync(d, { recursive: true });
  return paths;
}

// ---------------------------------------------------------------------------------------------
// CLI exit codes: stable so scripts can branch on them.
// ---------------------------------------------------------------------------------------------
export const EXIT = Object.freeze({
  OK: 0,
  ERROR: 1,        // unexpected / runtime failure
  USAGE: 2,        // bad flags, missing arguments, unknown command
  NOT_FOUND: 3,    // session / profile / dataset / entity does not exist
  INTEGRITY: 4,    // verification failed, stale or corrupt state
  ENVIRONMENT: 5,  // Chrome / DevTools / Node prerequisites missing
});

// ---------------------------------------------------------------------------------------------
// User settings: flags > environment > <data-dir>/config.json > defaults.
// ---------------------------------------------------------------------------------------------
export const EXPORT_FORMATS = ['jsonl', 'ndjson', 'json', 'csv', 'tsv', 'md', 'html'];

const asInt = (min, max) => (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`expected an integer between ${min} and ${max}`);
  return n;
};
const asNum = (min) => (v) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min) throw new Error(`expected a number >= ${min}`);
  return n;
};
const asBool = (v) => {
  if (typeof v === 'boolean') return v;
  if (/^(1|true|yes|on)$/i.test(String(v))) return true;
  if (/^(0|false|no|off)$/i.test(String(v))) return false;
  throw new Error('expected true or false');
};
const asChoice = (...choices) => (v) => {
  if (!choices.includes(String(v))) throw new Error(`expected one of ${choices.join(', ')}`);
  return String(v);
};
const asString = (v) => String(v);

// key -> { default, parse, env, desc }
export const SETTINGS_SCHEMA = Object.freeze({
  cdpPort: { default: 9222, parse: asInt(1, 65535), env: 'CAPTURE_STUDIO_CDP_PORT', desc: 'Chrome DevTools port used for capture' },
  studioPort: { default: 7878, parse: asInt(0, 65535), env: 'CAPTURE_STUDIO_PORT', desc: 'Port of the local studio web UI' },
  exportFormat: { default: 'jsonl', parse: asChoice(...EXPORT_FORMATS), env: 'CAPTURE_STUDIO_FORMAT', desc: 'Default dataset export format' },
  defaultProfile: { default: null, parse: asString, env: 'CAPTURE_STUDIO_PROFILE', desc: 'Profile to force for every capture (empty = auto-select by host)' },
  maxMb: { default: 0, parse: asNum(0), env: 'CAPTURE_STUDIO_MAX_MB', desc: 'Default per-session raw size quota in MB (0 = unlimited)' },
  color: { default: 'auto', parse: asChoice('auto', 'always', 'never'), env: 'CAPTURE_STUDIO_COLOR', desc: 'Colored terminal output' },
  json: { default: false, parse: asBool, env: 'CAPTURE_STUDIO_JSON', desc: 'Machine-readable JSON output for every command' },
  autoDerive: { default: true, parse: asBool, env: 'CAPTURE_STUDIO_AUTO_DERIVE', desc: 'Derive datasets and knowledge automatically after capture' },
});

export function parseSetting(key, raw) {
  const spec = SETTINGS_SCHEMA[key];
  if (!spec) throw new Error(`Unknown setting "${key}". Known: ${Object.keys(SETTINGS_SCHEMA).join(', ')}`);
  if (raw === null || raw === '' || raw === 'null') return spec.default;
  try { return spec.parse(raw); } catch (e) { throw new Error(`Invalid value for ${key}: ${e.message}`); }
}

export function loadUserConfig(configFile) {
  if (!existsSync(configFile)) return { values: {}, problems: [] };
  let raw;
  try { raw = JSON.parse(readFileSync(configFile, 'utf8')); } catch (e) { return { values: {}, problems: [`${configFile}: ${e.message}`] }; }
  const values = {}, problems = [];
  for (const [k, v] of Object.entries(raw ?? {})) {
    if (!SETTINGS_SCHEMA[k]) { problems.push(`unknown setting "${k}" ignored`); continue; }
    try { values[k] = parseSetting(k, v); } catch (e) { problems.push(e.message); }
  }
  return { values, problems };
}

export function saveUserConfig(configFile, values) {
  mkdirSync(path.dirname(configFile), { recursive: true });
  const body = JSON.stringify(values, null, 2) + '\n';
  writeFileSync(configFile + '.tmp', body);
  renameSync(configFile + '.tmp', configFile);
}

// Returns { settings, sources, problems }; `sources[key]` is 'flag' | 'env' | 'config' | 'default'.
export function resolveSettings({ configFile, env = process.env, flags = {} } = {}) {
  const { values: file, problems } = configFile ? loadUserConfig(configFile) : { values: {}, problems: [] };
  const settings = {}, sources = {};
  for (const [key, spec] of Object.entries(SETTINGS_SCHEMA)) {
    settings[key] = spec.default; sources[key] = 'default';
    if (key in file) { settings[key] = file[key]; sources[key] = 'config'; }
    if (spec.env && env[spec.env] !== undefined && env[spec.env] !== '') {
      try { settings[key] = spec.parse(env[spec.env]); sources[key] = 'env'; } catch (e) { problems.push(`${spec.env}: ${e.message}`); }
    }
    if (flags[key] !== undefined && flags[key] !== null) {
      try { settings[key] = spec.parse(flags[key]); sources[key] = 'flag'; } catch (e) { problems.push(`--${key}: ${e.message}`); }
    }
  }
  return { settings, sources, problems };
}

// Content hash of the collector source, recorded in every session as provenance.
let cachedSha;
export function collectorSourceSha() {
  if (cachedSha) return cachedSha;
  const h = createHash('sha256');
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const p = path.join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(mjs|js|html|json)$/.test(name)) { h.update(path.relative(TOOL_ROOT, p).replaceAll('\\', '/')); h.update(readFileSync(p)); }
    }
  };
  walk(path.join(TOOL_ROOT, 'src'));
  cachedSha = h.digest('hex').slice(0, 16);
  return cachedSha;
}
