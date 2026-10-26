# VIVIM Harness — run this from C:\0-BlackBoxProject-0\vivim-harness

If this folder is empty, clone first (do not copy legacy files in):
    git clone https://github.com/owenservera/vivim-harness.git .

## Context (canonical rules — AION AGENTS.md 2026-10-25)

This repo is now the canonical owner of VIVIM Harness source code, tests,
benchmarks, CI, scripts and implementation assets. The old AION checkout
(`AION/.../capture-studio/`) is immutable rollback reference only. Do not
resurrect supplier-local browser controllers, switch Chrome/CDP ownership,
delete legacy source, disable local launchers, or run two always-on
supervisors.

## Product goal

Three genuinely fresh, context-dependent provider turns through the existing
VIVIM capture/drive/UI flow in one provider-native thread — real ChatGPT
first, then Claude, then Gemini. One proven provider at a time. A startup or
HTTP 200 is never acceptance; what counts is observed fresh reply content in
the provider-native conversation, captured and derived via the harness.

## Current task (do this, don't plan more)

1. Read `docs/MIGRATION.md` and review centralization PR #1 (open, unverified).
2. Implement safe successive turns — remove the one-message-per-conversation
   restriction WITHOUT bypassing the harness. Modules: `src/capture`,
   `src/studio`, `src/intel`, `src/profiles`, `test`.
3. Fix the known live blocker class: deferred first-turn capture + stale
   readiness (preflight skipped when sessionId absent; UI rejecting deferred
   initial send while capture is not recording). Confirm the real
   BINDING_CHANGED cause before assuming.
4. Write/extend tests under `test/` for the fixed paths.
5. Run the failed actual journey end-to-end on this Windows host; record a
   dated receipt with observed provider content, not status codes.

## Constraints

- Windows PC is local-master: never damage sessions, private captures,
  cookies, credentials, browser tabs or Git state. Keep private raw captures
  and transcripts out of Git.
- Single browser-effect owner. No Playwright/Puppeteer.
- Invariants: exact effect/journal/identity binding, idempotency, provenance.
- Commit and push verified work to this repo's main; never claim tests that
  didn't run.
