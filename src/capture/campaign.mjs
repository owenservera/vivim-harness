// Sequential multi-site campaign: walk the known AI chat sites in order, interact with each like a
// person, record the exchange, derive knowledge and consolidate the site family.
//
// Design:
//   - ONE browser, ONE site at a time. There is no concurrency anywhere in this file.
//   - Every interaction is delegated: driveSite (src/capture/actions.mjs) owns typing, sending,
//     waiting and the login-wall check; derive (src/replay/derive.mjs) owns reconstruction;
//     src/families/build.mjs owns consolidation. Nothing is reimplemented here.
//   - A bad site never aborts the campaign: problems are returned as `status` + `reason`.
//   - Default is plan-only (`execute === false`): adapters and target URLs are resolved, nothing
//     is opened, typed into or sent.
//   - Progress survives between runs through `<dataDir>/campaign-state.json` (resume).
import fs from 'node:fs';
import path from 'node:path';
import { defaultDataDir, dataPaths } from '../config.mjs';
import { ADAPTER_IDS, getAdapter } from '../profiles/sites/index.mjs';
import { Session } from '../store/session.mjs';
import { ProfileStore } from '../profiles/profiles.mjs';
import { FamilyStore } from '../families/families.mjs';
import { ScopedLearner } from '../intel/learn.mjs';
import { derive } from '../replay/derive.mjs';
import { evaluateAcceptance, writeAcceptance, readAcceptance } from './acceptance.mjs';
import { driveSite } from './actions.mjs';

// The fixed calibration prompt: 12 words, deterministic, so a captured reply can be checked
// word for word (same wording as `studio drive`).
export const defaultPrompt = 'Reply with exactly these 12 words separated by single spaces and nothing else: alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima';

// The answer the calibration prompt asks for. A reply is only accepted when it contains these
// words in order: without that check a static greeting, a sidebar menu or a redirect notice
// counts as a successful capture.
export const expectedWords = Object.freeze('alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima'.split(' '));

// Is there another site left to drive after the current one?
function moreToDoSoon(wanted, index, cap, totals, resume, state) {
  if (cap !== null && totals.processed >= cap) return false;
  return wanted.slice(index + 1).some((rest) => {
    const d = state.sites?.[rest];
    return !(resume && d?.status === 'ok' && d?.sessionId);
  });
}

// What a reply must contain to count as the calibration answer.
export function expectedAnswer(prompt = defaultPrompt) {
  const p = String(prompt ?? '');
  if (!p.includes('alpha bravo charlie')) return null;
  return expectedWords.join(' ');
}

// Does a reply contain the expected words, in order, ignoring punctuation and case?
export function replyMatchesExpectation(reply, expected) {
  const want = String(expected ?? '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!want) return { ok: false, reason: 'no expectation given' };
  const got = String(reply ?? '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const words = want.split(' ');
  let at = 0;
  const missing = [];
  for (const w of words) {
    const idx = got.indexOf(w, at);
    if (idx < 0) { missing.push(w); continue; }
    at = idx + w.length;
  }
  return missing.length === 0
    ? { ok: true, reason: `the reply contains all ${words.length} expected words in order` }
    : { ok: false, reason: `the reply is missing ${missing.length} of ${words.length} expected words (${missing.slice(0, 6).join(', ')})`, missing };
}

// Sites in campaign order. ADAPTER_IDS is the registry truth; keep the order explicit here.
export const siteOrder = Object.freeze(['chatgpt', 'claude', 'gemini', 'deepseek', 'zai', 'qwen', 'lmarena', 'minimax', 'kimi']);

const STATE_FILE = 'campaign-state.json';
const DEFAULT_COOLDOWN_MIN_MS = 45000;
const DEFAULT_COOLDOWN_MAX_MS = 90000;

const msg = (e) => String(e?.message ?? e ?? 'unknown error');
const nowIso = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

// ---------------------------------------------------------------------------------------------
// Resume state: which sites already completed, and with which recording.
// A corrupt or unreadable state file is treated as empty, never fatal.
// ---------------------------------------------------------------------------------------------
export function statePath(dataDir) {
  return path.join(dataDir, STATE_FILE);
}

function readState(dataDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(statePath(dataDir), 'utf8'));
    const sites = raw && typeof raw === 'object' && raw.sites && typeof raw.sites === 'object' ? raw.sites : {};
    return { version: 1, updatedAt: raw?.updatedAt ?? null, sites };
  } catch {
    return { version: 1, updatedAt: null, sites: {} };
  }
}

function writeState(dataDir, state) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    const file = statePath(dataDir);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify({ ...state, updatedAt: nowIso() }, null, 2)}\n`);
    fs.renameSync(tmp, file); // atomic replace: an interrupted run never leaves a half state file
    return true;
  } catch {
    return false; // resume is a convenience; losing it must not fail the campaign
  }
}

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------
function normalizeSites(sites) {
  const list = Array.isArray(sites) && sites.length ? sites : siteOrder;
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const id = String(raw ?? '').trim().toLowerCase();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function targetUrlOf(adapter) {
  if (adapter?.url) return adapter.url;
  const host = Array.isArray(adapter?.hosts) ? adapter.hosts.find(Boolean) : null;
  return host ? `https://${host}/` : null;
}

function hostnameOf(url) {
  try { return new URL(String(url)).hostname.toLowerCase(); } catch { return ''; }
}

// No artificial inter-site wait for the single-PC owner. A requested cooldown
// remains deterministic and explicit; operational/provider limits are separate.
function cooldownFor(cooldownMs, override) {
  if (typeof cooldownMs === 'number' && Number.isFinite(cooldownMs) && cooldownMs >= 0) return cooldownMs;
  return 0;
}

// src/families/build.mjs is loaded lazily so a missing module degrades to "derive only" instead of
// breaking the campaign (and the CLI) at import time.
let familyModule;
async function familyBuilder() {
  if (familyModule !== undefined) return familyModule;
  try {
    const mod = await import('../families/build.mjs');
    familyModule = typeof mod.buildFamily === 'function' && typeof mod.writeFamily === 'function' ? mod : null;
  } catch {
    familyModule = null;
  }
  return familyModule;
}

function resultFor(id, patch = {}) {
  return { id, status: 'failed', reason: 'not processed', sessionId: null, reply: '', derived: false, family: null, signature: null, ms: 0, ...patch };
}

// ---------------------------------------------------------------------------------------------
// Derive one recorded session, then consolidate the site family from the whole store.
// Returns flags + a note; never throws.
// ---------------------------------------------------------------------------------------------
async function deriveAndConsolidate({ sessionId, adapter, targetUrl, paths, conversation = null }) {
  const out = { derived: false, family: null, signature: null,
    acceptance: 'unassessed', note: '' };
  const notes = [];
  if (!sessionId) { notes.push('no session was recorded'); out.note = notes.join('; '); return out; }

  try {
    const session = Session.open(paths.sessions, sessionId);
    const profiles = new ProfileStore(paths.profiles);
    let profile;
    try { profile = profiles.load(session.meta?.profile?.name ?? 'generic'); }
    catch { profile = profiles.load('generic'); } // the recorded profile may be gone: generic is documented
    await derive(session, profile, {
      families: new FamilyStore(paths.families),
      learner: new ScopedLearner(paths.learner),
    });
    out.derived = true;
  } catch (e) {
    notes.push(`derive failed: ${msg(e)}`);
  }

  if (!out.derived) { out.note = notes.join('; '); return out; }

  // The normal derive only knows the saved raw evidence; its G1–G3 context
  // gates are explicitly not checked. Promote only after *observed* calibration
  // and completion context can be supplied by the drive, never from SHAPES.
  try {
    const session = Session.open(paths.sessions, sessionId);
    if (conversation) {
      const doc = await evaluateAcceptance({ session, conversation });
      writeAcceptance(session, doc);
    }
    const stored = readAcceptance(session); // Verifies raw digest and G1–G7.
    out.acceptance = stored.verdict;
    if (stored.verdict !== 'capture_accepted') {
      notes.push(`family withheld: G1–G7 verdict ${stored.verdict} (${(stored.reasons ?? []).slice(0, 3).join('; ')})`);
      out.note = notes.join('; ');
      return out;
    }
  } catch (error) {
    notes.push(`family withheld: acceptance evaluation failed (${msg(error)})`);
    out.note = notes.join('; ');
    return out;
  }

  const builder = await familyBuilder();
  if (!builder) {
    notes.push('family build skipped: src/families/build.mjs is unavailable');
    out.note = notes.join('; ');
    return out;
  }

  try {
    const host = hostnameOf(targetUrl) || (adapter?.hosts?.[0] ?? '');
    const built = builder.buildFamily({
      sessionsDir: paths.sessions, host: host || null, site: adapter?.id ?? null,
      profilesDir: paths.profiles, minSessions: 1,
    });
    if (!(built.coverage?.eligible > 0) || !built.shapes.length) {
      notes.push('family withheld: no eligible exact-origin shape groups');
      notes.push(...(built.warnings ?? []).slice(0, 2));
      out.note = notes.join('; ');
      return out;
    }
    const written = builder.writeFamily({ familiesDir: paths.families, built });
    out.family = built.family?.id ?? null;
    out.signature = built.family?.signature ?? null;
    if (!built.coverage?.withDerived) notes.push('family has no derived sessions');
    if (built.warnings?.length) notes.push(...built.warnings.slice(0, 3));
    out.note = notes.join('; ');
    return { ...out, version: written?.version ?? null };
  } catch (e) {
    notes.push(`family build failed: ${msg(e)}`);
    out.note = notes.join('; ');
    return out;
  }
}

// ---------------------------------------------------------------------------------------------
// Campaign
// ---------------------------------------------------------------------------------------------
export async function runCampaign({
  sites = [...siteOrder], prompt = defaultPrompt, port = 9222, dataDir,
  execute = false, cooldownMs, perSiteTimeoutMs, limit, onEvent, resume = true,
  drive = driveSite, // injectable for tests; production always uses driveSite
} = {}) {
  const startedAt = nowIso();
  const root = path.resolve(dataDir ? String(dataDir) : defaultDataDir());
  const paths = dataPaths(root);
  const emit = (ev) => { try { onEvent?.({ at: nowIso(), ...ev }); } catch { /* a listener must never break the campaign */ } };

  const wanted = normalizeSites(sites);
  const cap = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.floor(Number(limit)) : null;
  const timeoutMs = Number.isFinite(Number(perSiteTimeoutMs)) && Number(perSiteTimeoutMs) > 0 ? Math.floor(Number(perSiteTimeoutMs)) : undefined;

  const state = resume ? readState(root) : { version: 1, updatedAt: null, sites: {} };
  const results = [];
  const totals = { requested: wanted.length, processed: 0, ok: 0, unverified: 0, planned: 0, blocked: 0, failed: 0, skipped: 0, envFailure: false };

  emit({ type: 'campaign.start', sites: wanted, execute, port, prompt, limit: cap, resume });

  for (let index = 0; index < wanted.length; index++) {
    const id = wanted[index];
    if (cap !== null && totals.processed >= cap) break;

    const siteStarted = Date.now();

    // 1. Resume: a site that already finished successfully is not touched again.
    const done = state.sites?.[id];
    if (resume && done?.status === 'ok' && done?.sessionId) {
      totals.skipped++;
      results.push(resultFor(id, {
        status: 'skipped', sessionId: done.sessionId, reply: '', derived: done.derived ?? true,
        family: done.family ?? null, signature: done.signature ?? null, ms: 0,
        reason: `already completed in a previous run (session ${done.sessionId}); pass --no-resume to run it again`,
      }));
      emit({ type: 'site.skipped', site: id, sessionId: done.sessionId });
      continue;
    }

    totals.processed++;

    // 2. Adapter: an id without an installed adapter is recorded as blocked, not fatal.
    let adapter = null;
    try { adapter = await getAdapter(id); } catch { adapter = null; }
    if (!adapter) {
      totals.blocked++;
      results.push(resultFor(id, {
        status: 'blocked', ms: Date.now() - siteStarted,
        reason: ADAPTER_IDS.includes(id)
          ? `no adapter installed for "${id}" (src/profiles/sites/${id}.mjs did not load)`
          : `unknown site "${id}": no adapter matches it`,
      }));
      emit({ type: 'site.blocked', site: id, reason: 'no-adapter' });
      continue;
    }

    const targetUrl = targetUrlOf(adapter);

    // 3. Plan mode: report the target and stop. No tab, no typing, no network.
    if (!execute) {
      totals.planned++;
      results.push(resultFor(id, {
        status: 'planned', url: targetUrl, ms: Date.now() - siteStarted,
        reason: `plan only — would drive ${targetUrl ?? '(no url declared by the adapter)'}`,
      }));
      emit({ type: 'site.plan', site: id, targetUrl, label: adapter.label ?? id });
      continue;
    }

    // 4. Execute: drive, then derive, then consolidate.
    emit({ type: 'site.start', site: id, targetUrl });
    let driven;
    try {
      driven = await drive({
        adapter, prompt, port, dataDir: root, record: true, timeoutMs,
        onEvent: (ev) => emit({ type: 'drive', site: id, event: ev }),
      });
    } catch (e) {
      // driveSite returns its problems, but a thrown error (transport bug) still must not abort.
      totals.failed++;
      results.push(resultFor(id, { status: 'failed', url: targetUrl, ms: Date.now() - siteStarted, reason: `drive threw: ${msg(e)}` }));
      continue;
    }

    const siteResult = resultFor(id, {
      url: targetUrl, sessionId: driven?.sessionId ?? null, reply: String(driven?.reply ?? ''),
      ms: Date.now() - siteStarted,
    });

    if (driven?.reason === 'no-browser' || (!driven?.target && !driven?.sessionId && /DevTools endpoint unreachable|ECONNREFUSED|fetch failed/i.test(String(driven?.errors?.[0] ?? '')))) {
      totals.envFailure = true;
      totals.failed++;
      results.push({ ...siteResult, status: 'failed', reason: `no DevTools endpoint on 127.0.0.1:${port}: ${driven?.errors?.[0] ?? driven?.reason ?? 'unreachable'}` });
      emit({ type: 'campaign.env-failure', site: id, port });
      // Nothing else can succeed without the browser: record the rest and stop.
      for (const rest of wanted.slice(index + 1)) {
        if (cap !== null && totals.processed >= cap) break;
        totals.processed++;
        totals.blocked++;
        results.push(resultFor(rest, { status: 'blocked', reason: `campaign stopped: no DevTools endpoint on 127.0.0.1:${port}` }));
      }
      break;
    }

    if (driven?.blocked) {
      totals.blocked++;
      results.push({ ...siteResult, status: 'blocked', reason: String(driven.reason ?? 'blocked by a login wall') });
      emit({ type: 'site.blocked', site: id, reason: driven.reason });
    } else if (!driven?.ok) {
      totals.failed++;
      const why = String(driven?.reason ?? 'drive failed');
      const first = driven?.errors?.find?.((e) => String(e) !== why);
      results.push({ ...siteResult, status: 'failed', reason: first ? `${why}: ${first}` : why });
      emit({ type: 'site.failed', site: id, reason: why });
    } else {
      // Check the calibration answer BEFORE publishing a family. A completed
      // capture is useful raw evidence even when the reply is unrelated.
      const expect = expectedAnswer(prompt);
      const match = expect ? replyMatchesExpectation(siteResult.reply, expect) : null;
      if (match) siteResult.verified = match.ok;
      const conversation = match?.ok && driven.done === true
        ? { prompt, expectedReplyWords: expectedWords,
            completionRule: { requireDone: true, stableObserved: driven.done === true },
            // Pre-send freshness cursor measured by the drive; without it G1/G2 would stay
            // 'unknown' and no family could ever be promoted on honest evidence.
            ...(driven.baselineTurns ? { baseline: driven.baselineTurns } : {}) }
        : null;
      const built = await deriveAndConsolidate({
        sessionId: siteResult.sessionId, adapter, targetUrl: driven?.target?.url ?? targetUrl,
        paths, conversation,
      });
      siteResult.derived = built.derived;
      siteResult.family = built.family;
      siteResult.signature = built.signature;
      siteResult.acceptance = built.acceptance;
      const notes = [`reply settled (${String(siteResult.reply ?? '').trim().length} chars)`];
      if (!built.derived) notes.push(built.note || 'not derived');
      else if (!built.family) notes.push(built.note || 'family not published');
      siteResult.reason = notes.filter(Boolean).join('; ');
      siteResult.ms = Date.now() - siteStarted;

      // Calibration correctness is independent from capture/knowledge acceptance.
      // Never label an incorrect fixed-answer reply as site success.
      if (expect) {
        if (!match.ok) {
          siteResult.reason += `; ${match.reason}`;
          totals.unverified++;
          results.push({ ...siteResult, status: 'unverified' });
          emit({ type: 'site.unverified', site: id, reason: match.reason, reply: siteResult.reply });
          state.sites[id] = { status: 'unverified', reason: match.reason, at: nowIso(), sessionId: siteResult.sessionId ?? null };
          writeState(root, state);
          if (moreToDoSoon(wanted, index, cap, totals, resume, state)) {
            const waitMs = cooldownFor(cooldownMs);
            if (waitMs > 0) {
              emit({ type: 'campaign.cooldown', ms: waitMs, after: id });
              await sleep(waitMs);
            }
          }
          continue;
        }
        siteResult.reason += `; ${match.reason}`;
      }
      totals.ok++;
      // resultFor() defaults to 'failed'; the persistence step below reads siteResult.status, so it
      // must be set here, not only on the pushed copy (else a verified drive is stored as 'failed').
      siteResult.status = 'ok';
      results.push({ ...siteResult });
      emit({ type: 'site.ok', site: id, sessionId: siteResult.sessionId, derived: siteResult.derived, acceptance: siteResult.acceptance, family: siteResult.family, signature: siteResult.signature });
    }

    // Persist progress per site, so a later run resumes instead of repeating a real interaction.
    if (siteResult.status === 'ok' && siteResult.sessionId) {
      state.sites[id] = {
        status: 'ok', sessionId: siteResult.sessionId, at: nowIso(),
        prompt, derived: !!siteResult.derived, family: siteResult.family, signature: siteResult.signature,
        reply: String(siteResult.reply ?? '').slice(0, 2000),
      };
      writeState(root, state);
    } else if (siteResult.status === 'failed' || siteResult.status === 'blocked') {
      state.sites[id] = { status: siteResult.status, reason: siteResult.reason, at: nowIso(), sessionId: siteResult.sessionId ?? null };
      writeState(root, state);
    }

    // Human pacing between two real interactions, never after the last one.
    const moreToDo = results.length && wanted.slice(index + 1).some((rest) => {
      const d = state.sites?.[rest];
      return !(resume && d?.status === 'ok' && d?.sessionId);
    });
    if (moreToDo && !(cap !== null && totals.processed >= cap)) {
      const waitMs = cooldownFor(cooldownMs);
      if (waitMs > 0) {
        emit({ type: 'campaign.cooldown', ms: waitMs, after: id });
        await sleep(waitMs);
      }
    }
  }

  const finishedAt = nowIso();
  writeState(root, state);

  const ok = !totals.envFailure && totals.blocked === 0 && totals.failed === 0;
  emit({ type: 'campaign.end', ok, totals });

  return { ok, startedAt, finishedAt, sites: results, totals };
}
