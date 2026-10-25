# VIVIM Harness Architecture Atlas

`components.json` declares ten stable logical architecture-stage identities and the code paths they own. Several stages legitimately share source files; stage counts **are not additive**.

Use `node scripts/architecture-inventory.mjs --json` for current, filesystem-derived counts and path coverage. Use `--check` in CI to ensure source paths remain owned by at least one stage. `atlas.html` is an offline interactive visualization and an initial source-footprint snapshot.

Maturity labels describe current evidence quality, not invented progress percentages:
- source-backed: implementation exists
- integrated-offline: source and synthetic/unit integration evidence
- live-partial: some genuine browser observations, not all acceptance gates
- integration-pending-live: source present; real provider full-loop proof pending
- live-accepted: only after dated reproducible runtime evidence

All new provenance and maturity claims must link to a real test/receipt and commit. The initial imported snapshot did not independently rerun the unit suite.
