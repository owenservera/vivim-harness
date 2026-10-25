// drive: type a prompt into a live AI web app through CDP, record the exchange, read the reply.
import path from 'node:path';
import { EXIT } from '../../src/config.mjs';
import { ADAPTER_IDS, getAdapter, listAdapters } from '../../src/profiles/sites/index.mjs';
import { driveSite } from '../../src/capture/actions.mjs';
import { expectedAnswer, replyMatchesExpectation } from '../../src/capture/campaign.mjs';
import { define } from '../lib/registry.mjs';
import { notFound, envError, usageError, oneLine, truncate, fmtMs } from '../lib/ui.mjs';

// Deterministic, so a captured transcript can be checked word for word.
const DEFAULT_PROMPT = 'Reply with exactly these 12 words separated by single spaces and nothing else: alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima';

// `studio drive <site|url>`: a plain URL is driven with the generic heuristics only.
function adapterFromUrl(raw) {
  const s = String(raw).trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : /^[^\s/]+\.[a-z]{2,}(?:[/:?#]|$)/i.test(s) ? `https://${s}` : null;
  if (!withScheme) return null;
  let u;
  try { u = new URL(withScheme); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  return { id: u.hostname.toLowerCase(), label: u.hostname, hosts: [u.hostname], url: u.toString() };
}

define({
  name: 'drive', section: 'Knowledge', usage: '<site|url> [--prompt TEXT] [--timeout S] [--no-record] [--reuse-tab] [--json] [--dry-run]',
  summary: 'Send a prompt to a live AI site, record it and read the reply back',
  description: 'Reuses the tab already open on that site (or opens one), refuses to type into a login wall, records the exchange unless --no-record, then waits until the reply stops changing and prints it. Works without a site adapter: the generic heuristics in src/capture/actions.mjs find the composer, the send control and the reply.',
  flags: {
    prompt: { type: 'string', valueName: 'TEXT', desc: 'Prompt to send (default: a fixed 12-word fidelity check)' },
    timeout: { type: 'number', valueName: 'SECONDS', default: 120, desc: 'Give up waiting for the reply after this long' },
    record: { type: 'boolean', desc: 'Capture the exchange as a session (use --no-record to skip)' },
    'dry-run': { type: 'boolean', desc: 'Print the resolved adapter and target, then stop without typing' },
    'reuse-tab': { type: 'boolean', desc: 'Drive the tab already open on that site (brought to front) instead of opening a fresh one; keeps an in-progress guest thread' },
  },
  examples: [
    'studio drive chatgpt',
    'studio drive claude --prompt "Summarize this page in one sentence" --timeout 90',
    'studio drive https://example.ai/ --dry-run',
  ],
  async run(ctx) {
    const { out, flags } = ctx;
    const ref = ctx.args[0];
    if (!ref) throw usageError('Usage: studio drive <site|url> [--prompt TEXT]', 'Example: studio drive chatgpt --dry-run');

    let adapter = await getAdapter(ref);
    if (!adapter) adapter = adapterFromUrl(ref);
    if (!adapter) {
      const known = await listAdapters();
      throw notFound(
        `No site adapter or URL for "${ref}".`,
        known.length ? `Known sites: ${known.map((a) => a.id).join(', ')}. A full URL also works.` : `No adapters are installed yet (expected: ${ADAPTER_IDS.join(', ')}); pass a full https:// URL instead.`,
      );
    }

    const prompt = String(flags.prompt ?? DEFAULT_PROMPT);
    const timeoutMs = Math.max(5, Number(flags.timeout ?? 120)) * 1000;
    const record = flags.record !== false;
    const site = adapter.label ? `${adapter.id} (${adapter.label})` : adapter.id;

    if (flags['dry-run']) {
      const targetUrl = adapter.url ?? (adapter.hosts?.[0] ? `https://${adapter.hosts[0]}/` : null);
      const dry = {
        site: adapter.id, label: adapter.label ?? adapter.id, hosts: adapter.hosts ?? [], targetUrl,
        composer: adapter.composer ?? null, send: adapter.send ?? null, assistant: adapter.assistant ?? null,
        preflight: adapter.preflight ?? null, streamHints: adapter.streamHints ?? null,
        prompt, timeoutMs, record,
      };
      out.emit(dry, (o) => {
        o.result(`${site}`);
        o.line(`  target    ${targetUrl ?? '-'}`);
        o.line(`  hosts     ${(dry.hosts.length ? dry.hosts : ['-']).join(', ')}`);
        o.line(`  composer  ${dry.composer?.selectors?.length ? dry.composer.selectors.join(', ') : 'generic heuristic only'}`);
        o.line(`  send      ${dry.send?.strategy ?? 'both'}${dry.send?.buttonSelectors?.length ? ` (${dry.send.buttonSelectors.length} button selector(s))` : ' (Enter)'}`);
        o.line(`  assistant ${dry.assistant?.containerSelectors?.length ? `${dry.assistant.containerSelectors.length} container selector(s)` : 'generic fallback'}`);
        o.line(`  auth      ${dry.preflight?.requiresAuth ? 'login usually required' : 'no login declared'}`);
        o.line(`  record    ${dry.record ? 'yes' : 'no'}, timeout ${fmtMs(dry.timeoutMs)}`);
        o.line(`  prompt    ${truncate(oneLine(dry.prompt), 100)}`);
      });
      return;
    }

    const dataDir = ctx.paths.home ?? path.dirname(ctx.paths.sessions);
    const result = await driveSite({
      adapter, prompt, port: ctx.port, dataDir, record, timeoutMs, freshTab: !flags['reuse-tab'],
      onEvent: (ev) => {
        if (ev.type === 'target') out.info(`tab ${String(ev.id).slice(0, 8)} (${ev.reused ? 'existing' : 'new'}) ${ev.url ?? ''}`);
        else if (ev.type === 'tab' && ev.opening) out.info(`opening ${ev.opening}`);
        else if (ev.type === 'auth' && !ev.blocked) out.info(`auth: ${ev.reason}`);
        else if (ev.type === 'recording') out.info(`recording ${ev.sessionId ?? '(no session)'}${ev.profile ? ` with profile ${ev.profile}` : ''}`);
        else if (ev.type === 'composer') out.info(ev.found ? `composer ${ev.tag} via ${ev.reason}` : 'composer not found');
        else if (ev.type === 'sent') out.info(`sent via ${ev.method}`);
        else if (ev.type === 'completion') out.info(`reply ${ev.done ? 'settled' : 'timed out'} after ${fmtMs(ev.ms)}`);
      },
    });

    if (result.blocked) {
      throw notFound(`${site}: blocked by a login wall — ${result.reason ?? 'authentication required'}`, 'Sign in once in that browser tab, then run the command again.');
    }

    const first = result.errors?.[0] ?? result.reason ?? 'unknown';
    if (result.reason === 'no-browser' || /ECONNREFUSED|fetch failed|DevTools/i.test(first)) {
      throw envError(`Cannot drive ${site}: ${first}`, `Start Chrome with --remote-debugging-port=${ctx.port}, or run "studio launch".`);
    }

    const reply = oneLine(result.reply);
    // The default prompt asks for 12 exact words, so the reply can be checked objectively. A
    // reply that settled but does not contain them is not the answer (a greeting, a menu, a
    // notice) and is reported as unverified rather than as a successful drive.
    const expect = expectedAnswer(prompt);
    const check = expect ? replyMatchesExpectation(result.reply, expect) : null;
    const verified = check ? check.ok : null;
    out.emit(result, (o) => {
      o.result(`${result.site}  ${result.sessionId ?? '(not recorded)'}  ${fmtMs(result.ms)}  ${result.ok ? (verified === false ? 'unverified' : 'ok') : `failed: ${result.reason ?? first}`}`);
      o.result(`reply: ${reply ? truncate(reply, 120) : '(empty)'}`);
      if (check && !check.ok) o.line(`  check: ${check.reason}`);
      if (result.target?.url) o.line(`  tab ${result.target.url}`);
      for (const e of result.errors ?? []) if (e !== result.reason) o.line(`  note: ${e}`);
    });

    if (!result.ok) process.exitCode = EXIT.ENVIRONMENT;
  },
});
