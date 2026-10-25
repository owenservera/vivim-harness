# VIVIM Harness local engineering contract

This is the standalone product extracted from AION Capture Studio. Root is the canonical *candidate* application. Source lineage: `671c0b5a8f1e22822524fccc7543067ab89d121d` from `workspace/aion/sessions/roles/09-global-research/labs/website-to-local-streaming/capture-studio/` in `owenservera/aion`.

- Work in existing modules; no second browser actor, adapter registry, message store or /chat shell.
- Capture is read-only unless an explicit user-authorized send is performed through the existing effect owner.
- Respect origin/account/thread provenance, evidence coverage, no-duplicate-send behavior and rollback.
- Preserve local Windows profiles, sessions, evidence and scheduled tasks until verified cutover.
- No Playwright or Puppeteer.
- Run focused tests and full unit suite; separate offline results from real authenticated browser verification.
- Keep architecture/components.json as component identities and run `node scripts/architecture-inventory.mjs --check` after structural changes.
