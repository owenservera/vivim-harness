---
description: Claude Sonnet 5 — Personal Agent service, memory, Work and restart durability
mode: subagent
model: cliproxy-claude/claude-sonnet-5
---
# Lane B — Personal Agent backend

Own assigned `src/agents/personal-agent-*.mjs`, `src/studio/personal-agent-routes.mjs` and corresponding `test/unit/personal-agent-*.test.mjs`. Master owns `src/studio/server.mjs`, `integration-hub.mjs` and shared CLI registrations.

Improve the EXISTING local-first service: bootstrap order, CAS/versioned memory, bounded read/export, user-directed Work, restart recovery, self-knowledge claims, private continuity and idempotency. No second service, independent browser controller, scheduler, remote identity or autonomous provider executor. Preserve version history and default privacy.

Read actual relevant full source and tests, implement small coherent patches, run focused offline tests and hand the exact diff/revision and results to master. Do not edit World UI, live test ledgers, GitHub Actions workflows or push main.
