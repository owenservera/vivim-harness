# Local verification standard

GitHub Actions is not used in this repository. All `.github/workflows/*.yml` files were removed on
2026-10-28 (commit `10834cd`). Testing, gating and acceptance happen on the operator machine.

The repository Actions setting is separate from the workflow files: turning Actions off entirely is
an owner action in the GitHub UI (`Settings → Actions → General → Disable`). Deleting the files stops
every run either way.

## Commands

| Command | What it proves | Offline |
| --- | --- | --- |
| `bun run test` | Full unit suite: `node --test test/unit/**/*.test.mjs` | yes |
| `node bin/studio.mjs selftest` | Node version, module imports, data dir, Chrome install, Studio API over real loopback HTTP | yes (CDP check is `info` severity) |
| `node scripts/gate.mjs` | Architecture ownership, platform parity, platform smoke, then the full suite | yes |
| `node scripts/gate.mjs --fast` | The same minus the full suite — a dev loop, never a parity claim | yes |
| `bun run test:e2e` | End-to-end tests; **self-skips** when `CHROME_PATH` is unset, so a green run proves nothing | no |

Exit codes are the contract: any failure returns nonzero. `scripts/gate.mjs` resolves the suite by
walking `test/unit` itself, because `node --test` exits 0 when a glob matches nothing — a moved or
renamed suite would otherwise pass with zero tests. Each gate step also carries a timeout so a hung
child fails by name instead of hanging forever.

## What a local run may and may not claim

- A passing unit suite is **source acceptance**. It is not a live provider PASS.
- Live provider behaviour (ChatGPT objectives, capture readback, sends) is only established by an
  observed provider-side result recorded in the canonical append-only ledgers under `docs/agents/`.
- Live effects belong to one authorized owner on the dedicated Studio/Chrome profile. Source
  subagents never drive the browser and never write the live ledgers.
- `selftest` needs no credentials. `studio-stats` walks the real data root, so it gets its own
  30 s budget instead of the shared 5 s HTTP timeout.

## Recording a verification run

Quote the exact revision, the command, the pass/fail/skipped counts and the exit code. Never report
"green" from a partial run, a skipped suite, or a run against a different tree.
