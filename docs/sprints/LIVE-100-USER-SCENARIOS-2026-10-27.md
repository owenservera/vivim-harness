# VIVIM Harness — 100 real provider/browser user scenarios (2026-10-27)

**Status:** IMPLEMENTED ON ISOLATED BRANCH, NOT LOCALLY EXECUTED OR ACCEPTED.
Branch: `dev/live-browser-100-20261027`. Canonical repository: `owenservera/vivim-harness`.
Evidence tier at authorship: remote source changes plus static JavaScript parse; **zero real-browser/provider executions and zero passing suite claims**.

## Objective and scope

Deliver one-command execution of 100 **actual website-user tasks**: 20 distinct practical user requests on each of five existing adapters (ChatGPT, Claude, Gemini, DeepSeek, Z.ai). A case is a genuine fresh browser conversation via the existing production conversation runtime, not a fake DOM, stub, simulated reply or benchmark score. For each case the CLI:

1. Reuses or starts **only** the dedicated Chrome profile and verifies the CDP browser identity against a local continuity marker.
2. Creates a fresh native provider tab, records the durable case intent, submits **once** with the existing writer lease/journal, and reads the actual provider reply (no repeated sends).
3. Evaluates useful answer expectations, explicitly finishes capture, reopens the local conversation snapshot, checks on-disk session metadata and writes a metadata-only durable outcome receipt.

The script is a **capability and acceptance driver**, not proof that the five providers currently work. In particular creation/unpinned thread identity and site-specific login/composer drift can block. A scenario is `passed` only on an observed send + attributed ready reply + matching answer + finished/reopenable saved session; otherwise the receipt says `answer-failed` or `unresolved`. Every prior attempt is fenced from automatic retry across restarts. A first uncertain effect stops the batch. An untried scenario is never counted as passing.

## User rule: maximum three commands

From the checkout:

- Zero-send preview: `node bin/studio.mjs live-100`
- Small **real-provider** pilot (when the dedicated browser is signed in): `node bin/studio.mjs live-100 --providers chatgpt --limit 3 --execute --accept-sends --suite pilot-01`
- Full 100-case run: `node bin/studio.mjs live-100 --execute --accept-sends --suite 100-live-01`

Each user action is **one CLI invocation**. If signing in is necessary, first run `node bin/studio.mjs start` and sign in **manually** to the relevant providers using that dedicated profile. Run the pilot from a second terminal; it uses the same profile, one production runtime and the existing foreground writer lease. A separate `--suite` creates a new deliberate test run; rerunning the same suite never resends any case already started. Never select a new suite just to retry an unresolved provider effect without investigating the original conversation/journal first.

`npm run live:100 -- --execute --accept-sends --suite 100-live-01` is also supported.

**Do not run the full suite accidentally.** Full mode attempts up to 100 real provider messages, uses account quota, opens real tabs and writes local capture data. Nothing sends without both `--execute` and `--accept-sends`. The preview never opens Chrome. No provider credentials, cookies, OTPs or raw reply bodies are written in the summary receipt. Provider conversations themselves may remain visible in the provider account.

## Local receipts and acceptance rules

Receipt directory: `<data-root>/live-scenarios/<suite>.json` (outside the source repository). It stores only case ID, provider, title, state, timestamps, journal key, conversation/session IDs, proof tier and bounded failure codes; no prompt/reply text. The detailed provider/user content, if captured, stays in the existing VIVIM session store and must never be pushed to Git.

- `passed`: actual provider send positively observed, reply marked ready, public test output contains expected markers, finish completed and same conversation reopens with saved session metadata.
- `answer-failed`: live provider/save path succeeded but content expectation did not; not an operational pass.
- `unresolved`: unknown effect, failed/uncertain send, missing capture or unverifiable finish. **STOP**, inspect journal and original provider tab; never auto-resend.
- `notAttempted`: cannot be called a success.
- `preserved`: existing case receipt; no new send.

**G5/T3u remains separate.** These 100 provider-flow checks do **not** replace actual mouse/keyboard UX acceptance in `/chat` (J1–J4), native session continuity, security release gates or Linux parity. A single-turn case is **not** proof of native multi-turn continuity; the existing three-turn Harbor→Cedar pilot is still required. The code deliberately does not claim otherwise.

## Critical code fixes included

- `src/chrome/browser-ownership.mjs`: local marker and endpoint identity continuity check; rejects a reachable but unowned or changed CDP browser. The marker is not an OS security boundary.
- `src/chrome/launch.mjs`: validates the actual endpoint before reuse; writes marker only after a new dedicated launch.
- `bin/commands/capture.mjs`: `start`, `targets`, `record`, `capture` now use that ownership fence, including the already-reachable-port path.
- `bin/commands/chat.mjs`, `drive.mjs`: automatically launch or verify the dedicated browser in a single CLI command before live effects.
- `test/unit/conversation-prefix-negative.test.mjs`: corrects three staged-rejection regressions so valid first-stage writes are not blamed on the refused second operation.
- `test/unit/live-100.test.mjs`: catalogue cardinality, no-effect preview, send authorization and endpoint ownership regression coverage.

**Migration note:** A Chrome session launched by old code has no ownership marker. The new code will fail closed until the operator deliberately saves their work, closes **only the dedicated VIVIM Chrome** and restarts it using the new launcher. Do **not** kill or replace the owner's ordinary Chrome/profile. Browser/login state should remain in the persistent dedicated profile; this needs local verification.

## Local code and browser checks required before merge

1. Inspect active process/effect ownership and local uncommitted files; preserve them. Use an isolated worktree for this branch. Do not overwrite `PROMPT.md` or a live Chrome session.
2. Run `node --test test/unit/live-100.test.mjs test/unit/conversation-prefix-negative.test.mjs`, `node scripts/architecture-inventory.mjs --check`, `npm test`. Record actual counts and failures. Run Windows + Linux when available; hosted GitHub CI is currently billing-blocked.
3. Start with `studio live-100` (zero sends), then a **small authenticated test** with explicit authorization and inspect real source receipts. Stop on any unpinned or uncertain native thread; investigate the production adapter rather than retrying.
4. Perform the independent three-turn existing-provider Harbor→Cedar continuity pilot and real `/chat` J1–J4 keyboard/user interaction acceptance. Do not conflate the 100 single-turn suite with these gates.
5. Check whether server-side `serve` and API calls can bypass CLI ownership validation; harden those paths before claiming the browser guard end-to-end. Merge only after no regression on the Windows local-master branch.

No Playwright or Puppeteer. No parallel browser actor. No fabricated passes. No live provider send from ChatGPT remote work.
