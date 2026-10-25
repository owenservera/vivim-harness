# Capture Studio — Local-PC defaults and de-securitization policy

**Scope:** Capture Studio product (collector, DOM, Studio UI, Chat, Live Drive, API and CLI).  
**Single operator; one Windows PC; evidence stored locally.** Updated 2026-10-22.

## Product contract

The system exists to **capture as much useful evidence as possible and make that evidence useful automatically**. Do not introduce approval workflows, synthetic enterprise security checklists or secret-scanning gates into ordinary local development. UI should communicate observable state and uncertainties, not demand repeated confirmation for the same direct action.

**Capture data** is stored in the local data directory outside the source repo. This is not equivalent to saying all software operations are offline: an explicit Send uses the selected external website/AI provider; GitHub source pushes leave the PC; opt-in loopback integrations exchange data with other local processes. The code does not implement cloud backup/telemetry for the evidence directory.

### Defaults actually implemented

| Behavior | Default | Optional alternative |
| --- | --- | --- |
| Network capture | `local-raw`: full local evidence, raw URLs, headers and bodies; no streaming credential guard | `CAPTURE_STUDIO_CAPTURE_MODE=filtered` masks credentials/excludes some bodies |
| DOM capture | Full extracted text, turns, nested blocks and snapshot HTML via the same capture mode | Filtered mode applies matching masking |
| Recorder/lifecycle metadata | URL fields follow capture mode; local raw does not silently redact target/query metadata | Filtered mode redacts |
| Live target preview | Uses the source recorder capture mode | Filtered mode redacts |
| OpenAPI discovery | No token required in localhost mode | Studio cookie/header in optional token mode |
| Studio Web UI | `http://127.0.0.1:<port>/` opens without token login | `CAPTURE_STUDIO_ACCESS_MODE=token` enables tokenized launch / cookie |
| Drive | Direct **Send to selected sites** click is the explicit execution action | Dry run is optional |
| Chat and Drive prompt length | At most **250,000 characters** (HTTP request size and provider limits also apply) | Smaller prompt if desired |
| Drive user URL | Full HTTPS URL, including query/fragment; local HTTP test URL is supported by the current Core contract | Known built-in site |
| Derived knowledge | Automatically derived when settings permit; no independent approval board | `autoDerive` setting |
| Export | Local files / local read-only APIs | Explicit local integrations through Integration Hub |

**Example local settings (PowerShell):**

```powershell
$env:CAPTURE_STUDIO_ACCESS_MODE = 'local'
$env:CAPTURE_STUDIO_CAPTURE_MODE = 'local-raw'
node bin/studio.mjs start
```

For optional filtered capture: `$env:CAPTURE_STUDIO_CAPTURE_MODE = 'filtered'`.

### Boundaries retained because they protect results rather than administer the user

- Bind to loopback, validate Host/Origin. These are passive; they do not require clicks or logins.
- A deliberate Send click or CLI `--execute` is required before transmitting to an external website. No automatic retry of a send with an unknown outcome.
- Only one foreground browser owner/lease at a time; reclaim dead owners. Otherwise one agent could contaminate another agent's recording.
- Track idempotency, expected revision and original conversation/job IDs so late responses cannot create duplicates or overwrite a new selection.
- Preserve raw evidence and truthful gaps/partial records; keep reversible state history.
- No inferred account identity, field deletion or type merge solely because two observations look alike.
- Do not silently accept cookie/age/login prompts without user-set intent; those are actions on an external provider, unlike passive local capture.

### Remaining limitations — not enterprise security policy

These still need targeted product work if they hinder actual usage:
- Chat's **one-turn-per-conversation** model, rather than reusable multi-turn agent context.
- Browser/site runtime readiness and site-side login/consent restrictions; a local tool cannot force a remote service to accept a request.
- Raw DOM agent per-block display cap, event preview caps, session quotas if explicitly configured and HTTP request-size limits; performance/coverage constraints rather than security. Make overridable based on measured need.
- Site-adapter availability and capture target discovery; convert hidden "blocked" states into actionable local customization.
- Native Windows/Chrome proof, full Node 22 test suite and independent QA are not established by source-only checks.

### Scope hygiene

The source repo and the evidence directory serve different purposes. Do **not** commit captured cookie/token values or the evidence directory to GitHub just because local-raw mode retains them. The local raw-mode test fixtures use made-up strings, not real credentials. This policy does not edit harvested third-party donor repositories or authorize non-local exposure of Studio.

## Source regression receipts

- **11 / 11** local-first contract tests passed using GitHub-fetched source in a V8 compatibility harness (including raw DOM and snapshot test fixtures).
- **62 / 62** preexisting Studio client contract tests passed in the same harness after compatibility updates.
- This **73 / 73** total is not native `node --test`, actual Windows Chrome, network capture or independent QA acceptance. Run those separately on a complete local checkout.

See `test/unit/local-first-mode.test.mjs`, `test/unit/studio-recovery-ui.test.mjs` and the UI agent's [five-sprint plan](https://github.com/owenservera/aion/blob/main/workspace/aion/ops/capture-studio-ui/FIVE-SPRINT-WORKPLAN.md).

**Rule for future agents:** Before adding a "security" gate, identify whether it prevents a concrete local data-loss/duplicate-action failure, or merely adds friction. Default to operator control and correct provenance. If a lower-fidelity capture mode is needed, make it a named opt-in, not an invisible default.
