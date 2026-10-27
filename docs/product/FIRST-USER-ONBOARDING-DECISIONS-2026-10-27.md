# First-user onboarding — decisions and handoff (2026-10-27)

**Status:** durable decision record for the first-user onboarding discussion on 2026-10-27.
This is **not** an implementation plan, an approval to build, or an acceptance receipt. It
records what the owner decided, what the assistant recommended but the owner has not
approved, what remains parked, and the verified current state. Prior context exists only
as a summary; this document is a faithful reconstruction, not a transcript.

**Baseline:** `main` at `269791f6dd663403bcf3b19ceeceb5174097d6d7`
("docs(platform): record chrome-cdp.ps1 as an accepted exception, not a refactor target").
Clean worktree before this file was added.

**Scope when drafted:** this decision record only. No product code or other document was
modified, and no workspace setup, browser or provider effect was performed.

---

## 1. Owner decisions

These are decisions. They are requirements for the next design/implementation round, not
evidence that anything is already implemented.

| ID | Decision | Consequence / limit |
|---|---|---|
| **D1** | **Windows-only for this session.** | Verification and acceptance claims in this round are Windows-only. This does **not** amend the permanent Windows + Linux contract in [`docs/PORTABILITY.md`](../PORTABILITY.md); Linux was not executed this session and must not be claimed. |
| **D2** | The **personal workspace is separate from the source checkout**; its location is chosen by the user during onboarding. | No predetermined path is approved. The product must not default private user data into the repo. `CAPTURE_STUDIO_HOME` / `defaultDataDir()` already exist as the data-root mechanism, but a user-facing chooser does not. |
| **D3** | The **workspace is a core object**. Its full scaffold, lifecycle, ownership, migration, backup and world boundaries are **PARKED**, not designed. | Do not infer a folder schema, migration policy, backup format or ownership model from this record. Minimal onboarding may create only what it demonstrably needs. |
| **D4** | A **dedicated VIVIM Chrome profile is a "world"**. | Worlds are isolated by default. Sharing between worlds is explicit, never implicit. |
| **D5** | Folder/profile separation **alone is not an OS security boundary**. | Do not market or claim filesystem isolation as OS-level security. Isolation claims require verified browser/profile attachment and explicit data-boundary behavior. |
| **D6** | **`.dev` is an internal development workbench** for work and logs per world/profile on this machine. | It is **not** mandatory end-user onboarding, and it is not a second authoritative store. Final placement and layout remain open. It must not contain secrets. |
| **D7** | **Do not log secrets** and **do not create duplicate authoritative stores.** | Keep passwords, cookies, tokens, OTPs and raw credentials out of logs, `.dev` and Git. Transcript and full-saved exports can contain secrets present in message text; they are not automatically redacted. Logs are diagnostic only. |
| **D8** | The owner treats **account email as ordinary local data**. When the provider account email is **reliably observed**, it should be **stored and mapped automatically, with no mandatory confirmation step**. | This is a requirement for later implementation. It is **not** a claim that email detection works today. Never guess; never label a value verified when it was not observed. If observation is uncertain, the correct state is unknown/unverified. |
| **D9** | **Multiple accounts per provider must be supported.** | Same-world co-existence, account switching, per-account browser design and account attribution are a **MAJOR PARKED design item**. Do not hardcode a single-account assumption into data or UI. |
| **D10** | **The user signs in themselves.** VIVIM must not collect passwords, cookies or OTPs into its account records or workbench logs. | Sign-in is a human step. The dedicated Chrome profile itself retains browser session data; it must be protected and kept out of Git. |
| **D11** | Onboarding uses **existing conversation discovery, then explicit user selection**. | Discovery is informational. **Coverage must be truthful** — the provider sidebar is a partial rendered index, not the account's complete conversation list. Selecting a conversation for this pilot does **not** authorize copying all history or sending anything. |
| **D12** | **Local/remote sync configuration is PARKED.** | No sync schedule, remote endpoint or background polling policy is agreed. During the first multi-turn pilot, the local view should be kept updated for the conversations **explicitly tested**, without inventing a general polling policy. |
| **D13** | **Minimal onboarding first** was selected over a manual-only pilot. | Use the **existing product** — no second application, no second browser actor, no second storage system. Onboarding may be small, but it must exercise the real app path. |
| **D14** | The owner chose a **new ChatGPT conversation** and this fictional **3-turn test**: (1) a fictional **Harbor** project with local-first storage and JSON export; (2) **rename it Cedar** and add **offline mode**, without repeating the earlier facts; (3) ask for the **current name and all three requirements**. | Goal: **three distinct, fresh, context-dependent replies in the same provider-native thread**, captured and saved/reopened, with final content verified. Turn 2 deliberately omits prior facts so continuity is tested rather than restated. |
| **D15** | The pilot selection **is not authorization to send**. | A separate, explicit authorization is required before any provider effect. Never auto-resend when the effect outcome is uncertain. |

**Explicit non-decisions:** D2 does not choose a path; D3 does not approve a scaffold; D4
does not define how a world is represented on disk; D8 does not approve a specific detection
method; D9 does not choose an account-switching UX; D12 does not approve a scheduler.

---

## 2. Assistant recommendations (not approved)

Recorded separately so they are not mistaken for owner decisions.

| ID | Recommendation | Why it is only a recommendation |
|---|---|---|
| **R1** | During onboarding, explain in plain language where local data lives, that provider history remains provider-owned, and what VIVIM does and does not copy. | Owner has not reviewed the wording or the exact disclosure. |
| **R2** | Require the user-chosen workspace to be outside the source checkout, and validate that before creating anything. | Follows D2, but the validation rule and error UX are not approved. |
| **R3** | Create only the minimum scaffold needed for the pilot (workspace marker + conversation/saved-record area + export area), deferring the full lifecycle. | Consistent with D3/D13; concrete layout still open. |
| **R4** | Before claiming world isolation, verify that the reachable CDP endpoint belongs to the expected dedicated profile; do not silently attach to an unrelated reachable port. | A code-level recommendation; the required validation and failure behavior are not approved. |
| **R5** | Show account identity as **observed / unknown**, and map email automatically only when observation is reliable. | Follows D8, but detection method and evidence fields are undecided. |
| **R6** | Present discovery as "found via the visible provider surface", with an explicit partial-coverage note and user selection. | Follows D11; UI treatment is open. |
| **R7** | Obtain explicit authorization for the three specified sends, capture each reply, then save and reopen the thread locally and compare the final content. | Pilot mechanics follow D14; the authorization must explicitly cover the intended sends and scope. |
| **R8** | Keep `.dev` logs scoped per world/profile and explicitly exclude credentials, cookies, tokens and raw provider secrets. | Follows D6/D7; final `.dev` layout is open. |
| **R9** | Refine UI vs runtime design before implementation; do not treat this record as a full implementation plan. | Presentation and runtime boundaries need a separate design pass. |

---

## 3. Open / parked decisions

| Area | State | What is missing |
|---|---|---|
| Workspace scaffold, lifecycle, ownership, migration, backup, world boundaries | **PARKED** (D3) | Object model, folder contract, migration/rollback, backup/restore, ownership rules. |
| Exact filesystem layout | **UNDECIDED** | User chooses the workspace location at onboarding (D2); internal layout is not agreed. |
| Identity model | **UNDECIDED** | How observed identity is recorded, what counts as reliable observation, and how unknown states are represented. |
| Multiple accounts per provider | **MAJOR PARKED** (D9) | Same-world co-existence, switching, browser/profile topology, attribution and conflict handling. |
| Browser visibility | **TODO — owner requested** | Let the user choose whether VIVIM Chrome is visible, minimized or hidden. Define the behavior and limitations of each mode, including how a user can sign in or recover access; hidden and headless are not assumed to be equivalent. |
| Active VIVIM browsers | **TODO — owner requested** | Provide a place to see active VIVIM-owned browsers, their status and tabs, with world/profile attribution only when verified. UI and management actions remain to be designed. |
| Provider memory | **TODO — owner requested** | Track provider memory changes and their provenance where observable. Distinguish a provider's confirmed saved-memory event from a model merely saying it will remember something, and preserve unknown states; discovery, access, retention and multi-account scope need design. The owner reported a memory update during the first ChatGPT pilot; it has not been independently verified. |
| Local/remote sync | **PARKED** (D12) | Remote target, scheduling, conflict handling, retention; no background polling policy exists. |
| `.dev` placement/layout | **OPEN** (D6) | Not mandatory onboarding; per-world/profile scope suggested, final structure undecided. |
| Workbench log discovery | **TODO — owner requested** | Make the active workspace, world and `.dev` log locations discoverable to operators and agents; distinguish repository files from machine-local evidence, and label quoted or inaccessible logs as second-hand. Do not publish raw logs or credentials. The precise manifest or status surface is undecided. |
| Isolation enforcement | **OPEN** | Folder separation is not OS security (D5); verified profile attachment is not yet implemented/claimed. |
| Existing-history import scope | **NOT AUTHORIZED** | Discovery + selection only (D11). Bulk copy or full-history export has no approval. |
| Provider effects | **NOT AUTHORIZED** | D15 requires explicit authorization covering provider sends; uncertain outcomes must not be retried automatically. |
| UI vs runtime design | **REFINABLE** | May be refined before implementation; no approved design yet. |

---

## 4. Verified current state (evidence, not requirements)

Everything below is observed/reported evidence. It is deliberately weaker than the
requirements above.

### 4.1 Repository and gates

- Baseline HEAD: `269791f6dd663403bcf3b19ceeceb5174097d6d7`; worktree clean before this
  documentation file was created.
- **Windows gate at baseline (reported this session):** 1977 tests, **1972 pass, 0 fail,
  3 skipped, 2 todo**. This is local Windows execution, not hosted CI.
- **QA-S1-F1:** a failing assertion inside a `TODO` in `test/unit/replay-fidelity.test.mjs`
  (family eligibility; no evaluator exists). It is a recorded TODO, **not counted as a
  failure** in the 0-fail result.
- **Linux:** **not tested this session.** A historic receipt exists in
  [`docs/PORTABILITY.md`](../PORTABILITY.md); it is not a result of this session and must
  not be presented as current.
- Hosted CI is not acceptance evidence (account billing lock; zero steps executed per
  [`docs/track/queue.md`](../track/queue.md)).

### 4.2 First-use / browser evidence

- **CLI self-test (reported):** 9 required checks pass; the CDP endpoint check reports an
  informational failure; the owner's Chrome was untouched.
- **Browser smoke (reported):** automated **headless, disposable Chrome navigation smoke
  only**. This does not establish provider behavior, login state, capture fidelity or
  world isolation.
- **Full J1–J4 real-browser acceptance suite and receipt: NOT created/run.**
- **Provider-native acceptance: NOT performed.** No live ChatGPT turn, no reply capture,
  no save/reopen proof.
- Therefore: **no claim** of working email detection, full world isolation, live provider
  operation, or a working onboarding wizard.

### 4.3 Code facts relevant to onboarding

| Fact | Evidence |
|---|---|
| Data root can be overridden with `CAPTURE_STUDIO_HOME`; default is OS-specific and outside the repo. | `src/config.mjs:11-18` (`defaultDataDir`) |
| Paths include `sessions`, `profiles`, `families`, `learner`, `chromeProfile`, `exports`, `config`. | `src/config.mjs:20-31` (`dataPaths`) |
| A dedicated Chrome profile is launched at `<dataDir>/chrome-profile` with a loopback CDP port. | `src/chrome/launch.mjs:51-91`; [`docs/PORTABILITY.md`](../PORTABILITY.md) |
| There is **no first-run folder chooser**. | Current CLI/Studio surface; no onboarding command found. |
| Account scope is **not yet read**. | [`ARCHITECTURE.md`](../../ARCHITECTURE.md) lines 256–261 |
| Workspace (personal vs team) is **not modelled**. | Same identity table, line 257 |
| The launcher returns `alreadyRunning` when a port is reachable **before** validating the expected profile. | `src/chrome/launch.mjs:51-58`; status reports `expectedProfileDir` but does not prove attachment. See also `chromeStatus()` at `:108-122`. |
| A reachable port is not proof of the intended world/profile. | Consequence of the above; isolation needs verified attachment before any isolation claim. |
| Discovery is partial by construction: the provider sidebar is a virtualized rendered index. | [`ARCHITECTURE.md`](../../ARCHITECTURE.md) lines 268–269; D11 |

**Implication:** minimal onboarding must treat "browser reachable" and "correct world
attached" as different facts. Until verified attachment exists, the honest status is
"profile unverified", not "world isolated".

---

## 5. Proposed minimal first-run sequence (assistant proposal — not approved)

This is a proposal for review. It is not an approved flow and not a complete implementation
plan. UI vs runtime design may be refined before implementation.

| Step | Proposed action | Why |
|---|---|---|
| **0. Preconditions** | Detect Node/browser; run the existing CLI self-test; report CDP as informational; never touch the owner's normal Chrome profile. | Establish environment truth without effects. |
| **1. Explain local data** | State where data will live, that the provider remains authoritative for remote conversations, and that credentials are not captured. | D7, D10, R1. |
| **2. Choose workspace** | User picks the personal workspace folder; reject a location inside the source checkout. | D2, R2. |
| **3. Minimal scaffold** | Create only what the pilot needs; do not invent the full workspace lifecycle. | D3, D13, R3. |
| **4. World + browser** | Create/open a dedicated VIVIM Chrome profile for this world; verify the attached endpoint matches it **before** claiming isolation; user signs in manually. | D4, D5, D10, R4. |
| **5. Identity** | If email is reliably observed, store/map it automatically; otherwise show unknown and never guess. | D8, R5. |
| **6. Discover + select** | If browsing existing conversations, show discovered items with truthful partial-coverage language and require explicit selection. The first pilot instead uses a new conversation. | D11, D14, R6. |
| **7. Pilot (authorized)** | In a new ChatGPT conversation, run the three turns from D14, capturing each reply; save and reopen locally; verify the final content. | D14, R7. **Separate send authorization required.** |
| **8. Closeout** | Record what was observed at its true tier; leave sync policy parked; do not auto-configure background polling. | D12, AGENTS verification rules. |

### Pass criteria for the minimal first run

1. Workspace is **outside the source checkout** and chosen by the user.
2. Dedicated profile is the one actually attached (verified, not assumed from a reachable
   port); the owner's normal Chrome profile is untouched.
3. Sign-in was performed by the user; no password, cookie or OTP was extracted into account
   records or workbench logs. Chrome's dedicated profile may retain session cookies.
4. Account email is stored only if reliably observed; otherwise it is visibly unknown.
5. Any discovery is described as partial; existing conversations are selected explicitly,
   and no bulk history copy occurred. Discovery is not a prerequisite for a new-thread pilot.
6. The three sends were explicitly authorized within the agreed scope; each returned a **distinct, fresh,
   context-dependent** reply in the **same provider-native thread**:
   - turn 1 establishes Harbor + local-first storage + JSON export;
   - turn 2 renames it Cedar and adds offline mode without restating prior facts;
   - turn 3 reports the current name and all three requirements.
7. All three turns are captured locally, then the saved conversation is reopened and the
   final content matches what was observed.
8. No duplicate authoritative store was created; `.dev`/logs contain no secrets.
9. Uncertain effects are **not** auto-resent; failure is reported as uncertain.
10. Any claim beyond this — full isolation, complete history coverage, sync, multi-account
    support — remains explicitly unverified.

If any criterion is not met, report the true tier (source-only / synthetic / local runtime /
real browser / provider-native) rather than a pass.

---

## 6. Safety boundaries for the first run

- **Windows-only** for this session (D1). Do not claim Linux.
- **No real browser profile access**: do not inspect, copy, move or delete the owner's normal
  Chrome profile, cookies or session data.
- **No second actor**: use the existing CDP/browser ownership. No Playwright, no Puppeteer,
  no parallel browser controller, no second app/store.
- **Unknown data is left alone**: unrecognized folders, profiles, sessions or partial
  captures are not migrated, normalized or deleted. Report and stop.
- **No secrets in logs or Git**: keep credentials, cookies, tokens, OTPs and raw auth data out
  of `.dev` and commits. Transcript and full-saved exports can contain secrets pasted into
  message text; these modes do not automatically redact content.
- **User-owned sign-in**: the human signs in; VIVIM never captures or replays credentials.
- **Effects are explicit**: selecting a conversation or opening a page authorizes nothing.
  Sending requires separate explicit authorization; uncertain outcomes are never retried
  automatically.
- **Truthful states**: observed, unverified, partial and unknown are distinct. Do not label
  a value verified when it was not observed.

---

## 7. Next steps and gates

| Gate | Action | Owner | Status |
|---|---|---|---|
| **G0 — Review** | Owner reviews this decision record and the proposed first-run sequence; corrects any misrecorded decision. | Owner | **OPEN** |
| **G1 — Identity** | Decide how observed identity/email is represented and when it counts as reliable. | Owner + design | **UNDECIDED** |
| **G2 — Filesystem** | Decide the minimal layout and how the user-chosen workspace is validated; full scaffold stays parked. | Owner + design | **UNDECIDED** |
| **G3 — Isolation** | Define and verify expected-profile attachment; do not claim isolation before it passes. | Implementation | **OPEN** |
| **G4 — Sync** | Keep local/remote sync configuration parked; allow only the explicitly tested conversation to update locally during the pilot. | Owner | **PARKED** |
| **G5 — Multi-account** | Decide same-world co-existence, switching and attribution architecture. | Owner + design | **MAJOR PARKED** |
| **G6 — Send authorization** | Obtain explicit, separate authorization before any provider send. | Owner | **NOT GRANTED** |
| **G7 — Acceptance evidence** | Run the real-browser J1–J4 suite and produce a receipt; provider-native pilot only after G6. | Implementation | **NOT RUN** |

**Implementation must not start from this document alone.** G0 must pass first, and G1–G3
need decisions before code. The absence of a full implementation plan is intentional; UI vs
runtime design may be refined separately.

---

## 8. References

- [`AGENTS.md`](../../AGENTS.md) — Windows local-master rule, no Playwright/Puppeteer,
  read-only capture default, explicit effect authorization, no auto-resend, one source of truth.
- [`docs/track/queue.md`](../track/queue.md) — current queue, L0–L4 status, hosted-CI billing
  lock, G5 not accepted, T3u not run.
- [`docs/PORTABILITY.md`](../PORTABILITY.md) — Windows + Linux contract, data-root/browser
  decisions, evidence tiers, current verified boundary.
- [`docs/product/V1-INTEGRATED-APP-BLUEPRINT.md`](V1-INTEGRATED-APP-BLUEPRINT.md) — J1
  first-open journey, workspace/world object model, first-user activation and continuity
  goals; status "Proposed", not implemented.
- [`ARCHITECTURE.md`](../../ARCHITECTURE.md) lines 256–269 — harness identity table
  (account scope not read, workspace not modelled, thread identity) and open-target/partial
  sidebar rules.
- `src/config.mjs` — `defaultDataDir()`/`dataPaths()`/`ensureDataDirs()`; data root and
  `chrome-profile` path.
- `src/chrome/launch.mjs` — dedicated launch and `chromeStatus()`; `alreadyRunning` returned
  before expected-profile validation at lines 51–58, 108–122.
- `bin/commands/selftest.mjs` — local CLI self-test used for first-use environment checks.
