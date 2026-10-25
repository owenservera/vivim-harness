# VIVIM Harness extraction receipt

Source: [owenservera/aion](https://github.com/owenservera/aion) at `671c0b5a8f1e22822524fccc7543067ab89d121d`.

Original path: `workspace/aion/sessions/roles/09-global-research/labs/website-to-local-streaming/capture-studio/`.

Destination: root of [owenservera/vivim-harness](https://github.com/owenservera/vivim-harness).

## Transfer method
The original **386 tracked files** (5,499,291 bytes) were copied into the new repository by GitHub API, and all 386 Git blob SHA values were compared against the source snapshot: **0 differences** at initial import. Git's blob SHA equality confirms content equality.

This creates a new repository commit history; **the full source commit ancestry has not been rewritten/transplanted**. Consult AION at the pinned commit for historical evolution. Do not mistake import commits for original authored commits.

## Product scope
All ten Architecture Atlas stages are in the extracted Capture Studio root, including src/, bin/, scripts/, test/, profiles/, families/, eval/ and docs/.

Independent AION Chrome Relay / Bus / Velocity, Agent14 supplier packages, research material and the 2,433 donor archive files remain in AION. They are explicitly tracked as *adjacent*, not assumed required runtime dependencies.

## Cutover status
- Source extraction: completed and blob-verified.
- Standalone CI: configured; see the new repository Actions results for actual pass/fail status.
- Windows runtime, scheduled task, local evidence/data, Chrome profile and CDP connection: **not modified or verified**.
- Original AION code: **not deleted or redirected**.
- Runtime ownership: VIVIM Harness is the destination candidate, but AION stays operational until actual Windows smoke/live checks succeed.

## Local cutover
1. Preserve AION and any dirty worktrees; do not remove historical sources.
2. Clone vivim-harness to a distinct Windows directory. Avoid reusing a live data/profile directory by accident.
3. Run `node --version`, `npm test`, `node bin/studio.mjs help`; inspect dedicated Chrome/CDP connectivity.
4. Inspect the existing `CaptureStudio-AlwaysOn` Scheduled Task **before** changing its working directory or script path. Do not run two supervisors against the same Chrome profile.
5. Verify persisted sessions are read from the intended original local data directory; do not migrate private evidence into GitHub.
6. Verify exact-thread read, a safe explicitly authorized turn, streaming, persistence and recovery on the real Windows host.
7. After verification, update the canonical path in AION root AGENTS.md and current executable consumers, then retire the old runtime without deleting history.

## Known external references to audit in AION
- `.github/workflows/capture-studio-intel.yml`
- `.github/workflows/native-discovery-ci.yml`
- `AGENTS.md`
- `workspace/aion/initiatives/discovery-to-read-v1/src/studio-source-reader.mjs`
- `workspace/aion/qa/capture-studio/tools/count-metrics.mjs`
- Any locally installed Windows Task Scheduler launch action pointing at the old directory.

Do not redirect external AION workflows until the Windows cutover is accepted.
