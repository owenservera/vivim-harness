# Live 100-scenario execution — defects found by running, 2026-10-27

**Environment:** Windows local master, `vivim-harness` at `bd26822` plus uncommitted fixes,
dedicated profile `C:\VIVIM\chrome-profile`, CDP `127.0.0.1:38702`, Chrome 155.0.8059.85,
Node v24.22.1. Account on ChatGPT was a real signed-in Plus session (`owen wallace-servera`).

**Why this file exists:** every entry below was produced by an actual browser run on that profile.
Nothing here is inferred from reading code. Receipts, session IDs and issue-log lines are the
evidence; they are metadata-only and contain no prompt or reply bodies.

---

## Case ledger (real runs)

| # | Case | Path | Result | Evidence |
|---|---|---|---|---|
| 1 | `chatgpt-groceries` | `live-100` `pilot-01` | `unresolved` `COMPOSER_UNREADABLE`, 26.6 s | effect reconciled to **none** |
| 1 | `chatgpt-groceries` | `live-100` `pilot-02` | `unresolved` `GENERATION_CONTROLS_UNAVAILABLE_OR_BUSY`, 19.4 s | effect reconciled to **none** |
| 1 | `chatgpt-groceries` | `studio drive` (human typing) | sent; reply = footer disclaimer | thread `/c/6ae0e3b6…` really answered "Rice / Milk / Eggs" |
| 1 | `chatgpt-groceries` | `live-100` `pilot-03` | **passed** 41.4 s | session `20261027-174852…`→ saved, `finishPhase done` |
| 1 | `chatgpt-groceries` | `studio drive --exact` | **passed** 49.3 s | typed 86/86, reply `Rice Milk Eggs` |
| 2 | `chatgpt-summary` | `live-100` `one-02` | **passed** 89.6 s | — |
| 2 | `chatgpt-summary` | `drive --exact` (parallel worker) | **passed** 2.9 s reply | typed 119/119 |
| 3 | `chatgpt-requirements` | parallel worker | `type-failed`, typed 0/133 | not sent |
| 4 | `chatgpt-math` | parallel worker | typed 99/99, `send did not take (enter)` | `DOM_TURNS` empty → no turn; text left in composer |
| 5 | `chatgpt-translation` | parallel worker | `DRIVE_LEASE_BUSY` 8/8 | never acquired the lease |
| 6 | `chatgpt-email` | parallel worker | `type-failed`, typed 0/113 | not sent |
| 7 | `chatgpt-priority` | parallel worker | **sent a merged 217-char prompt**, reply `No se ha podido cargar esta respuesta.` | see F-07 |
| 8 | `chatgpt-dedupe` | parallel worker | `type-failed`, typed 0/103 | not sent |

Parallel attempt result: **1 pass, 6 failures, 1 mangled send.** Sequential attempt result:
**2 passes, 0 mangled sends.**

---

## F-07 — CRITICAL: leftover draft appended, two prompts merged and sent

- **Observed:** `chatgpt-priority` reported `typed 217/118 chars` and `sent via enter`. The user
  turn captured in `kv/DOM_TURNS.json` was the math prompt **followed by** the priority prompt.
- **Cause:** `clearComposer()` existed but its failure was only pushed into `errors[]`; `insertText`
  appends to existing composer content. The math run had left its prompt in the composer after
  `send did not take (enter)`.
- **Impact:** the account received a message the user never wrote. This is the most serious class of
  defect in the harness: prompt corruption that still submits.
- **Fix (landed, uncommitted):** `src/capture/actions.mjs`
  1. clear is retried once; if anything survives, the run aborts with `draft-not-cleared` **before typing**;
  2. before Enter, the composer text must equal the prompt (whitespace-normalised) or the run aborts
     with `prompt-mismatch` and sends nothing.
- **Status:** fixed; regression case not yet re-proven live (validation run in progress).

## F-08 — `send did not take (enter)` leaves the draft behind

- **Observed:** `chatgpt-math` typed 99/99, Enter produced no submission, `uncertain: true`,
  `DOM_TURNS` empty. Reconciliation found no turn and no reply.
- **Impact:** the text stays in the composer and becomes F-07's trigger on the next run.
- **Status:** mitigated by F-07 (next run refuses or clears); the underlying "Enter did not submit"
  race on a hydrating page is **open**.

## F-09 — response stream aborted, page shows a failure notice, CLI still exits 1 with `ok: true`

- **Observed:** `chatgpt-priority` reply `"No se ha podido cargar esta respuesta."`; the captured
  stream carried only the first sentence (`net::ERR_ABORTED`, `chunks: 3`, `canceled: true`).
  The CLI printed `"ok": true` while exiting 1.
- **Impact:** a truncated answer and a partial-capture success are both possible; the exit code and
  the JSON disagree, which breaks scripted verdicts.
- **Status:** **open** (two separate defects: stream-abort handling, exit/`ok` disagreement).

## F-01 — fresh-tab composer race in the conversation adapter

- **Observed:** `pilot-01` `COMPOSER_UNREADABLE` after 26.6 s; nothing typed.
- **Cause:** ChatGPT paints `textarea#pending-home-input` first, then mounts
  `form div[contenteditable="true"]`; `preflight()` sampled once.
- **Fix:** `src/capture/conversation-browser-adapter.mjs` polls to `readinessTimeoutMs`.
- **Status:** fixed; `pilot-03` passed on the same code path.

## F-02 — preflight threw on transient non-idle controls

- **Observed:** `pilot-02` `GENERATION_CONTROLS_UNAVAILABLE_OR_BUSY` at 19.4 s; nothing typed.
- **Cause:** during hydration the composer exists but the submit control is disabled, so
  `controls.state` was `unknown`; the guard threw instead of polling.
- **Fix:** non-idle controls now poll; the deadline reports the precise stage
  (`COMPOSER_UNAVAILABLE` / `COMPOSER_UNREADABLE` / `GENERATION_CONTROLS_UNAVAILABLE_OR_BUSY` / `READINESS_TIMEOUT`).
- **Status:** fixed; `pilot-03` passed.

## F-03 — reply extractor returned the footer disclaimer instead of the answer

- **Observed:** `drive` returned `"ChatGPT puede cometer errores. Comprueba la información importante."`
  while the live DOM had `[data-markdown-text-style="assistant-message"]` = "Rice Milk Eggs".
- **Cause:** loose container selectors (`article`, `[data-testid*="assistant" i]`) also matched the
  trailing footer, and "last match wins" selected it.
- **Fix:** `src/capture/actions.mjs` prefers explicit assistant-message nodes and strips the
  disclaimer family and `Última respuesta` / `Last answer` markers.
- **Status:** fixed; `send-once` 43/43.

## F-04 — `live-100` never exited after finishing

- **Observed:** `pilot-02` wrote its receipt at 18:12:45 and the process was still alive 20+ minutes
  later holding the Chrome profile; it had to be killed.
- **Cause:** the recorder's CDP socket outlived the run.
- **Fix:** bounded release (1.5 s natural-exit window, then exit) **after** every receipt is fsynced;
  applies only to the real runtime, not injected test runtimes.
- **Status:** fixed; `pilot-03` exited cleanly.

## F-05 — human-paced typing corrupts the prompt

- **Observed:** prompt asked for "eggs"; `DOM_TURNS` recorded the user turn as "and gggs";
  the model dutifully answered "Gggs".
- **Cause:** `driveSite` defaults `humanPace: true` (per-key `keyDown`+`char`+`keyUp`).
- **Fix:** `studio drive --exact` inserts the prompt in one CDP `insertText` and reports
  `prompt-mangled` when the typed length differs.
- **Status:** fixed for `--exact`; human-pacing still available and still capable of this.

## F-06 — drive fresh-tab focus race

- **Observed:** `typed 0/119`, `Cannot find default execution context`, `could not focus the
  composer`; nothing sent.
- **Fix:** `waitForStableComposer` samples the same element across two polls at both the probe and
  the recording page; a lost execution context is "not ready yet", not an auth verdict.
- **Status:** fixed; `send-once` 43/43. Still observed as `could not focus the composer (focus)` as a
  non-fatal note in several runs.

## F-10 — parallel workers starve on the exclusive drive lease (design constraint)

- **Observed:** translation `DRIVE_LEASE_BUSY` on 8/8 attempts; the holder rotated between
  `legacy-10584` and `legacy-18812` — i.e. siblings taking the lease back-to-back.
- **Meaning:** five concurrent `studio drive` workers on one browser cannot work. Parallelism
  requires one profile+port per lane.
- **Status:** by design; not a defect. Scheduling must serialize on one port.

## F-11 — a cloned Chrome profile does not carry the provider session

- **Observed:** lane `p1` created from a trimmed copy (22 MB) and then from a full-ish copy (298 MB)
  of `C:\VIVIM\chrome-profile`; both opened ChatGPT signed **out** (`loginish: true`).
- **Meaning:** five lanes need five manual sign-ins, not five copies.
- **Status:** open; blocks true 5-way parallelism until each lane is signed in once.

## F-12 — tab litter after runs

- **Observed:** 14 page targets accumulated (chat/thread tabs from failed runs, extension onboarding
  pages); cleaned manually to 1.
- **Status:** open (cosmetic/operational).

## Test-harness defects fixed along the way

- `live-100.test.mjs` fast-sweep test built a `runtimeFactory` but never passed it, so it exercised
  the **real** runtime; fixed.
- The same test asserted submit IDs as case ids; it now asserts prompt prefixes.
- The same test inherited `process.exitCode` from the runner and failed the file; it now resets it.

---

## Method notes for whoever continues this list

1. One send at a time on port 38702. The lease is exclusive and siblings starve each other.
2. Always `--exact`. Default human pacing can alter the prompt.
3. A run that reports `type-failed`, `draft-not-cleared`, `prompt-mismatch` or `blocked` did **not**
   send; it is safe to re-run.
4. A run that reports `sent` or `uncertain` must be reconciled (journal + `DOM_TURNS`) before any
   re-run. Never resend on uncertainty.
5. `pilot-01`, `pilot-02` and `sweep-01` are fenced receipts of defects, not of passing cases.
