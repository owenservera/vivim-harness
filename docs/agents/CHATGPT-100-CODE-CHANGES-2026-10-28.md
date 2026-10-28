# CHATGPT-100 — Code Changes for Lane 3 (2026-10-28)

**Revision inspected:** `9560f567b97bc0b00f32f3ee5009a210b54c4925` (`9560f56`, 2026-10-28 11:41 +0100), branch `main`, level with `origin/main`.
**Author lane:** LANE 2 (read-only investigator). **Consumer:** LANE 3 (implementer).
**Scope rule:** LANE 2 read source and ledgers only. Nothing under `src/**` or `test/**` was modified. The ledgers were read from `git show HEAD:...` because the working copies are dirty (investigation JSON, live JSON, and `test/unit/conversation-create.test.mjs` are uncommitted).

---

## 0. Implementation status (2026-10-28)

Added after implementation. Sections 1-7 are the original work order; this section and the
inline `[CORRECTED 2026-10-28]` annotations are the only parts that describe the tree as it is.

**This spec is a historical work order.** Where it disagrees with
`docs/agents/CHATGPT-100-LANE3-REVIEW-2026-10-28.md`, the review file is correct.

| Finding | Status | Landed |
|---|---|---|
| CC-01 | Implemented | `conversation-service.mjs:289-302` — receipt pushed, `prove()`, reason overridden, capture disarmed, the same error still thrown |
| CC-02 | Implemented | `conversation-create.test.mjs:93-120` — error code plus the full receipt proof, and the `/c/` race test for `PREEXISTING_THREAD` |
| CC-03 | Implemented, shape differs from the spec | `conversation-browser-adapter.mjs:121-127,139-157` — see the correction under CC-03 |
| CC-04 | Implemented | `actions.mjs:432` — `stream.observed === true ? stream.streaming : null` |
| CC-05 | Implemented | `actions.mjs:904` — `blocked: null` on an unreadable check |
| CC-06 | Implemented after scope widened from 2 to 4 native controls | `conversation-capsule.mjs:69-95,135` — `rename_conversation`, `branch_conversation`, `edit_message`, `regenerate`; test `conversation-capsule.test.mjs:71` |
| CC-07 | **REJECTED and reverted** | `src/studio/conversation-tools.mjs` byte-identical to HEAD (`git diff` = 0 lines) |

Verdicts and evidence: `docs/agents/CHATGPT-100-LANE3-REVIEW-2026-10-28.md` §1 (verdicts, including the
CC-07 reject), §3 (per-finding detail) and `## Delta review (post-FIX 1/2/3)` (D-1…D-7, F-1…F-8). Two claims in the original work order were
false and are corrected in place below, original text kept: CC-01's `:267` retry claim and CC-03's
rollback claim.

---

## 1. Method

1. Read the three ledgers: `docs/agents/CHATGPT-NEW-CHAT-BINDING-REPAIR-PLAN-2026-10-28.md`,
   `docs/agents/CHATGPT-100-INVESTIGATION-2026-10-28.json` (`repairGroups`, `sourceRepairRounds`),
   `docs/agents/CHATGPT-100-RECONCILED-STATUS.md` (objectives 011/021/024/028/029), and
   `docs/agents/CHATGPT-100-GAP-MAP.md`.
2. Read every file each claim points at, with line numbers, from the HEAD working tree:
   `conversation-service.mjs`, `conversation-browser-adapter.mjs`, `conversation-runtime.mjs`,
   `conversation-ownership.mjs`, `conversation-thread.mjs`, `conversation-capsule.mjs`,
   `conversation-tools.mjs`, `actions.mjs`, `src/profiles/sites/chatgpt.mjs`.
3. Checked each claim against history (`git log`, `git show`) to separate *live defects* from *stale ledger entries*.
4. Reproduced the creation-path behaviour with a throwaway probe outside the repo
   (`%TEMP%\probe-create.mjs`, importing repo modules over `file:///…`). No repo file was edited to get evidence.
5. Ran `node --test test/unit/conversation-create.test.mjs` → 8/8 pass on the dirty working copy, so the
   currently-committed test state is *green while it has lost assertions* (see CC-02).

Deliberately chosen line anchors, not prose. If a line number below does not match the file at lane 3's
starting commit, re-grep the quoted code before editing.

---

## 2. Findings table

Counts: **P0 = 0, P1 = 2, P2 = 5, total = 7.**

| ID | Sev | Area | Claim | Evidence | Confirmed? |
|---|---|---|---|---|---|
| CC-01 | P1 | D — creation preflight | A failed creation preflight throws before any attempt is persisted, leaving `capture.state='recording'`, stale `readiness.ready:true`, and an unconsumed idempotency key | `src/capture/conversation-service.mjs:287,289,290-293` vs `292,299,303` | **Confirmed source defect** (probe) |
| CC-02 | P1 | D — test coverage | The pre-effect creation proof path now has zero unit coverage; the committed test asserts only the throw | `test/unit/conversation-create.test.mjs:93-99`; `git diff -- test/unit/conversation-create.test.mjs` | **Confirmed** (diff + grep) |
| CC-03 | P2 | C — ownership/readiness | `readiness()` calls `creationLocation()` uncaught; a transient location throw becomes a terminal connect failure | `src/capture/conversation-browser-adapter.mjs:129`; throws at `104,105,106,108` | **Confirmed source; live occurrence unproven** |
| CC-04 | P2 | A — readiness truth | `sendState()` still tests a failure string that `isStreaming()` no longer produces (dead branch) | `src/capture/actions.mjs:430` vs `731-734` | **Confirmed** (residual of `e7deb05`) |
| CC-05 | P2 | A — readiness truth | `detectAuthWall()` reports `blocked:false` when the page cannot be evaluated, i.e. "unreadable" is reported as "not blocked" | `src/capture/actions.mjs:900` | **Confirmed** |
| CC-06 | P2 | F — native controls | `rename`, `branch`, `edit`, `regenerate`, `stop_generation` are absent from the runtime and from the site profile; only `stop_generation` is honestly registered as unavailable | `conversation-capsule.mjs:63-67,105-107`; `src/profiles/sites/chatgpt.mjs`; no branch in runtime | **Confirmed absence** |
| CC-07 | P2 | A — contract wording | The capsule is described as not touching page state, but `findComposer` writes `globalThis.__aionDrive` and the read path depends on it | `src/capture/actions.mjs:33,75,93,98`; `conversation-tools.mjs:52`; `actions.mjs:856,388` | **Confirmed behaviour; not a contract breach — wording only** |

**Corrections to this table (2026-10-28).** Rows kept as written.

- **CC-03, "live occurrence unproven" is false.** Two live conversations returned `readiness.ready: false`
  with `reason: "BINDING_CHANGED"` — returned, not thrown — with zero sends. The origin is the pre-catch
  return at `:123`, not `creationLocation()` at `:129`. See CC-03.
- **CC-07 is rejected.** The row is right that this is not a contract breach, and that is why the wording
  change was reverted: `conversation-tools.mjs:52` is accurate as written.

---

## 3. Per-finding implementation specs

### CC-01 — Creation preflight throw skips the pre-effect receipt (P1)

**Claim.** In `submitCreation`, capture is armed and then `adapter.preflight` is awaited *outside* any
receipt bookkeeping. Any preflight failure other than `PREEXISTING_THREAD` is rethrown before
`snapshot.attempts.push(...)` ever runs.

**Evidence.**
- `src/capture/conversation-service.mjs:287` — `await ensureCapture();` → `armCapture()` at `224`, and `226`
  persists `sessionId` + `capture.state = 'recording'` and calls `save()`.
- `src/capture/conversation-service.mjs:289` — `try { preflight = await adapter.preflight(...) }`
- `src/capture/conversation-service.mjs:290-293` — on `PREEXISTING_THREAD` it pushes the attempt and calls
  `prove()`; **every other code does `throw error(...)` on line 291 with no `attempts.push`.**
- Attempts are only pushed at `292` (PREEXISTING_THREAD), `299` (thread already present), `303` (normal path).

**Current behaviour (reproduced).** With the adapter returning `BINDING_CHANGED` from `preflight`:
- the call throws `code: 'BINDING_CHANGED'` (correct — lane 1's test depends on it);
- on disk: `{"state":"ready","sessionId":"cap-1-0","capture":"recording","readiness":{"ready":true,…},"attempts":0}`;
- the `thread-turns` directory is never created;
- re-submitting **the same `key`** proceeds to typing and dispatch (`insertions:1, sends:1`) — the key was
  silently not consumed, so a caller that retries after a preflight failure sends a second message.

**Why it is wrong.** Three invariants break at once: (a) `capture.state` stays `recording` although nothing
was typed, so a later `finish`/close path believes a capture is live; (b) `readiness.ready` stays `true`
while the connection is in fact blocked, so the capsule and the owner both read a stale truth; (c) the
idempotency key is not consumed, so a retry is not idempotent. All three are exactly the class of defect
the pre-effect receipt exists to prevent.

**MINIMAL change** — replace only the `catch` body at `conversation-service.mjs:290-293`. Do **not** call
`finish()` and do **not** call `registered()`; that would resolve the acknowledgement and suppress the throw
that lane 1's test asserts.

```js
    catch (e) {
      const code = /^[A-Z][A-Z0-9_]{0,79}$/.test(e?.code ?? '') ? e.code : 'PREFLIGHT_FAILED';
      if (e?.code === 'PREEXISTING_THREAD') { snapshot.attempts.push(attempt); prove(); return finish(); }
      // Proven pre-effect block: nothing was typed or dispatched, so the receipt is persisted,
      // capture is disarmed, and the key is consumed - then the same error still propagates.
      snapshot.attempts.push(attempt); prove();
      attempt.reason = code;
      snapshot.readiness = { ready: false, draft: { present: null, chars: null }, reason: code };
      snapshot.state = 'blocked'; snapshot.uncertainty = null;
      await adapter.stopTurnCapture?.().catch(() => {});
      snapshot.capture.state = 'idle';
      save();
      throw error(code);
    }
```

Notes for the implementer:
- `prove()` (`271-280`) already sets `preEffect.typing/dispatch = 'not-executed'`, `state='blocked'`,
  `uncertainty=null`, and calls `writer?.release?.()` on `279`. Keep it; then override `reason` on both the
  attempt and `snapshot.readiness` so the code survives `prove()`'s hardcoded `PREEXISTING_THREAD`.
- `stopTurnCapture` exists and is already called with this exact `.catch(() => {})` shape in
  `conversation-runtime.mjs:177,703,708` and is exported at `conversation-browser-adapter.mjs:387`.
- Because `attempts.length !== 0` now, the `:267` guard turns a same-key retry into `CREATION_UNCERTAIN`,
  which is the intended "key consumed" outcome (compare `test/unit/conversation-create.test.mjs:110`).
  **[CORRECTED 2026-10-28 — the sentence above is false; original kept for the record.]**
  `submit()` returns the stored replay at `conversation-service.mjs:430-432` **before** `writable()` at
  `:443`, so the `:267` guard is unreachable for an existing key. `CREATION_UNCERTAIN` requires a **new**
  key. Lane 3's probe: same key → `turn.phase: 'blocked'`, `reason: 'BINDING_CHANGED'`, 0 insertions,
  0 sends.

**Regression test** — `test/unit/conversation-create.test.mjs`, in the existing denylist test at `93-99`
(restore the assertions lane 1 removed) plus one assertion group for the newly-fixed state:

```
Scenario: fresh owned NEW_CHAT, then navigate the tab to /c/<OPEN> before submit
  -> await assert.rejects(f.submit(c), e => e.code === 'BINDING_CHANGED')
Assertions:
  f.state.insertions === 0
  f.state.sends === 0
  f.state.replyReads === 0
  disk.attempts.length === 1
  disk.attempts[0].phase === 'blocked'
  disk.attempts[0].reason === 'BINDING_CHANGED'
  disk.attempts[0].preEffect.typing === 'not-executed'
  disk.attempts[0].preEffect.dispatch === 'not-executed'
  disk.binding.thread === undefined            // still unbound: no thread pinned
  disk.capture.state === 'idle'                // NEW: capture disarmed
  disk.state === 'blocked'                     // NEW
  disk.readiness.reason === 'BINDING_CHANGED'  // NEW: no stale ready:true
  disk.readiness.ready === false               // NEW
  fs.existsSync(<dir>/thread-turns) === false
Then: await assert.rejects(f.submit(c), e => e.code === 'CREATION_UNCERTAIN')  // key consumed
  [CORRECTED 2026-10-28 — the line above is false for the same key. Same-key retry replays, it does not throw.]
  Same key:  const replay = await f.submit(c); replay.turn.phase === 'blocked';
             replay.turn.reason === 'BINDING_CHANGED'; f.state.insertions === 0; f.state.sends === 0
  New key:   await assert.rejects(f.submit(c, { key: 'two', expectedRevision: <rev> }),
             e => e.code === 'CREATION_UNCERTAIN')
```

**Risk / rollback.** Additive except for the disarmed capture and the now-thrown error staying a throw. The
only behaviour change for callers is that a retry after a blocked preflight returns `CREATION_UNCERTAIN`
instead of re-typing, which is the safe direction. **[CORRECTED 2026-10-28 — false: a same-key retry
replays the persisted blocked attempt read-only (`conversation-service.mjs:430-432`), never reaching
`:267` and never throwing. `CREATION_UNCERTAIN` is the outcome for a new key only.]** If any existing test depends on `capture.state` remaining
`recording` after a throw, it will fail loudly and the two lines `stopTurnCapture`/`capture.state` can be
reverted independently of the receipt.

**Live verification required?** No. Fully demonstrated by the unit harness (`FakeRecorder` implements
`stop()`/`stopTurnCapture`).

---

### CC-02 — The pre-effect creation proof lost its only unit coverage (P1)

**Claim.** The committed test for the denylisted-`/c` navigation now asserts only that `submit` throws. Every
post-condition that proves nothing happened was deleted, so CC-01 regressed without a failing test.

**Evidence.** `git diff -- test/unit/conversation-create.test.mjs` on the working copy removes exactly:

```
- const blocked = await f.submit(c);
- assert.equal(blocked.turn.phase, 'blocked'); assert.equal(blocked.turn.reason, 'PREEXISTING_THREAD');
- const disk = JSON.parse(fs.readFileSync(f.file(c.id), 'utf8'));
- assert.equal(disk.attempts[0].preEffect.typing, 'not-executed'); assert.equal(disk.attempts[0].preEffect.dispatch, 'not-executed');
- assert.equal(disk.binding.thread, undefined);
- assert.equal(fs.existsSync(path.join(path.dirname(f.file(c.id)), 'thread-turns')), false);
+ await assert.rejects(f.submit(c), (e) => e.code === 'BINDING_CHANGED');
```

The replacement is not wrong about the error code (the adapter now fences at
`conversation-browser-adapter.mjs:179`, which is why the code changed from `PREEXISTING_THREAD` to
`BINDING_CHANGED`), but it dropped the *proof* half. `grep` across `test/` shows `PREEXISTING_THREAD`
survives only in `test/unit/chatgpt-new-chat-binding-investigation.test.mjs:53` (adapter-level), so the
`prove()` writers at `conversation-service.mjs:292,299,315,325` are untested.

Note the reachability shift that caused this: since `check()` gained the fresh-home fence at
`conversation-browser-adapter.mjs:174-180`, `preflight`'s own `PREEXISTING_THREAD` throw at `:425` is
reachable only by a race (navigate between `check()` and `creationLocation()`). So the *code* to test via
the denylist scenario is now `BINDING_CHANGED`, while the *receipt* to assert is unchanged.

**Current behaviour.** `node --test test/unit/conversation-create.test.mjs` is 8/8 green, and it stays green
while CC-01 is present. The suite currently certifies the regression.

**MINIMAL change.** Test-only. Restore the deleted assertions on top of the new error-code assertion, exactly
as specified in CC-01. Do not delete the `assert.rejects` line; keep both halves.

**Regression test.** The CC-01 block above *is* the test. Additionally, add one narrow adapter-level test for
the race path so `:425` is not permanently dark:

```
File: test/unit/chatgpt-new-chat-binding-investigation.test.mjs
Scenario: fresh home passes check(), then creationLocation() observes /c/<OPEN>
  -> adapter.preflight(...) rejects with code PREEXISTING_THREAD and flags notDispatched/notTyped true
Assertions: e.code === 'PREEXISTING_THREAD'; e.notDispatched === true; e.notTyped === true
```

**Risk / rollback.** None to production code. Low risk of a flaky test if the "navigate between calls" hook is
faked rather than timed — make it a deterministic stub, not a sleep.

**Live verification required?** No.

---

### CC-03 — `readiness()` turns a transient location sample into a terminal connect failure (P2)

**Claim.** Inside the fresh-composer branch, `readiness` awaits `creationLocation()` with no `try/catch`, so
any `TARGET_DISAPPEARED` / `BINDING_CHANGED` it raises ends the poll loop and fails the connection — even
though the surrounding function is a *polling* function with a deadline and already tolerates the equivalent
`null`-origin transient at `:125`.

**Evidence.**
- `src/capture/conversation-browser-adapter.mjs:129` — `const loc = await creationLocation();` (uncaught).
- `creationLocation` throws at `:104` (`TARGET_DISAPPEARED`), `:105` (`BINDING_CHANGED`), `:106`
  (`BINDING_CHANGED`), `:108` (`BINDING_CHANGED`).
- `:125` — `if (!(freshTab && pageOrigin === 'null')) return blocked('BINDING_CHANGED')` — explicit
  tolerance for a tab that has not committed its origin yet.
- `:108` has no such tolerance, and `:107` reads `location.pathname` from the page, so a page mid-navigation
  can legitimately report an empty/`null` origin for one sample.
- `:162-165` — the loop's own deadline path already returns `blocked('READINESS_TIMEOUT')`.
- `conversation-service.mjs:389-392` — a throw here becomes `needs-reconciliation` /
  `attachment-failed` rather than a retryable "not ready yet".

**Current behaviour.** A one-sample transient during creation connect is reported to the owner as a hard
binding change. Net effect is fail-closed (nothing is typed), but the classification is wrong and the
connect cannot succeed on retry within its own deadline.

**Why source-level, live-unproven.** This is the strongest source candidate for the still-unexplained live
objective 011 `BINDING_CHANGED`, but no live trace has been captured that shows `readiness:129` as the
origin. Treat the fix as correctness hardening, not as closing 011.

**[CORRECTED 2026-10-28 — the origin named above is wrong.]** Live proof exists and points elsewhere. Two
conversations both returned `readiness.ready: false` with `reason: "BINDING_CHANGED"` — returned, not
thrown — with zero sends. A throw at `:129` propagates out of `readiness()` and surfaces as a failed connect
(`needs-reconciliation` / `attachment-failed`, `conversation-service.mjs:389-392`); it cannot produce a
returned readiness object. The live blocker was the **pre-catch return at `:123`**, where
`new URL('chrome://newtab/').origin === 'null'` failed the literal-`about:blank` tolerance.
`creationLocation()` was never reached.

**MINIMAL change** — wrap only the `creationLocation()` call at `:129` and remember the reason:

```js
        } else if (freshTab && !binding.thread) {
          let loc = null, lastReason = null;
          try { loc = await creationLocation(); }
          catch (e) { lastReason = /^[A-Z][A-Z0-9_]{0,79}$/.test(e?.code ?? '') ? e.code : 'BINDING_CHANGED'; }
          if (loc) {
            if (loc.targetThread || loc.pageThread) return blocked('PREEXISTING_THREAD');
            if (loc.targetPath !== '/' || loc.pathname !== '/') return blocked('BINDING_CHANGED');
          }
          // fall through to the composer probe only when the sample succeeded
          if (loc) { /* existing composer/auth/gate/sendState block, unchanged */ }
```

and change `:165` to `return blocked(lastReason ?? 'READINESS_TIMEOUT');`.

Implementation constraints for lane 3:
- Keep the variable declared **inside** the loop iteration, or reset it per iteration; a stale `lastReason`
  from a previous tick must not leak into the timeout reason.
- `TARGET_DISAPPEARED` at `:118` must stay a hard return — a missing target is not a transient.
- Do not add new error codes. `blocked()` reasons are already an open string set consumed by
  `conversation-service.mjs:400-412`.

**Regression test** — `test/unit/chatgpt-new-chat-binding-investigation.test.mjs` (adapter-level harness):

```
Scenario A (transient): evaluate('location.origin') returns 'https://chatgpt.com', then creationLocation's
  listTargets returns a target with an unparseable/blank url on the FIRST call only, valid afterwards.
  -> readiness resolves, adapter eventually reports ready:true (or, with a 1-tick deadline, blocked('BINDING_CHANGED'))
Assertions A: no throw; result.reason !== undefined; the call did not reject.
Scenario B (persistent): listTargets never returns the target -> resolves blocked('TARGET_DISAPPEARED') with no throw.
Scenario C (deadline): every sample throws BINDING_CHANGED and the deadline is 1ms -> resolves
  blocked('BINDING_CHANGED') (not READINESS_TIMEOUT, because a reason was recorded).
```

**Risk / rollback.** A swallowed throw is the classic way to hide a real binding change. Two guards make that
acceptable here: the loop still ends at the deadline, and the composer probe (`:133-145`) is only reached when
`loc` is non-null, so a persistently wrong location can never produce `ready:true`. Roll back by restoring the
single `const loc = await creationLocation();` line — no other code depends on the change.

**[CORRECTED 2026-10-28 — the rollback claim above is false twice over.]**

1. **The original test depended on the uncaught throw.** The HEAD test asserted
   `rejects(…, e.code === 'BINDING_CHANGED')` for a second target sample reverting to `about:blank`.
   Restoring `:129` alone leaves that expectation and the new tolerance contradicting each other, so the test
   had to change with the code. It was inverted deliberately; its safety half survives as "a target that
   commits a foreign origin inside creationLocation stays a terminal throw".
2. **`:129` was never the live blocker.** The blocker was the pre-catch return at `:123`, where
   `new URL('chrome://newtab/').origin === 'null'` failed the literal-`about:blank` tolerance. Fixing only
   `:129` would not have moved 011: the loop returned `blocked('BINDING_CHANGED')` before `creationLocation()`
   ran.

**Landed shape (2026-10-28)** — `conversation-browser-adapter.mjs`:

- `:121-127` — a fresh tab tolerates **any** null target origin (`actual === 'null' || target.url === 'about:blank'`). A committed foreign origin still returns `blocked('BINDING_CHANGED')`.
- `:155` — the catch treats `'null'` as transient alongside an unparseable target URL; a parseable foreign origin re-throws.
- Committed foreign origins stay terminal on both paths. `new URL` yields `'null'` only for `about:`, `chrome:`, `chrome-extension:`, `file:`, `data:`, `javascript:`, `mailto:` and unparseable strings — never for an `http(s)` origin, and `blob:https://…` keeps the wrapped origin.
- Consequence: a target committed to a non-special scheme now ends as `READINESS_TIMEOUT` instead of failing fast. No ready, no typing; `check()` still throws on drift.

**Live verification required?** Yes for *closing* objective 011 (needs a trace proving the path); no for
merging the fix.

**[CORRECTED 2026-10-28 — the trace exists; it closes the origin question, not 011.]** Two live conversations
returned `readiness.ready: false` / `reason: "BINDING_CHANGED"` with zero sends. That names the path
(`:123`, returned) and rules out `:129` (thrown). Objective 011 stays `PARTIAL` until readiness flips `true`
in a live run.

---

### CC-04 — Dead failure-string branch in `sendState` (P2)

**Claim.** `sendState` still filters streaming evidence by a string that `isStreaming` stopped emitting in
`e7deb05`, so the guard is dead. The `null`-truth contract itself is already correct.

**Evidence.**
- `src/capture/actions.mjs:430` — `if (!String(stream.evidence ?? '').startsWith('streaming check failed:')) streaming = stream.streaming;`
- `src/capture/actions.mjs:731-734` — the only failure return is now
  `{ streaming: null, observed: false, evidence: 'streaming observation unavailable' }`.
- `waitForCompletion` already gates on `observed` (`:783-785` region) and `readTranscript` likewise.

**Current behaviour.** Correct by accident: on failure `stream.streaming` is `null`, so assigning it is
harmless; but the guard no longer expresses the rule it was written for, and a future change that reuses
`evidence` text silently re-opens the false-"finished" hole.

**MINIMAL change** — one line at `:430`:

```js
    streaming = stream.observed === true ? stream.streaming : null;
```

**Regression test** — a unit test over `sendState` with an injected `isStreaming` stub. If no such seam
exists today, add the assertion at the level of `actions.mjs` exports using a fake `page` whose
`Runtime.evaluate` throws for the streaming expression:
`assert.equal(result.streaming, null)` and `assert.equal(result.sent, false)` even when the turn count grew.

**Risk / rollback.** Expression is behaviour-preserving for today's values. Revert is one line.

**Live verification required?** No.

---

### CC-05 — `detectAuthWall` reports an unreadable page as "not blocked" (P2)

**Claim.** When the in-page evaluation fails, `detectAuthWall` returns `blocked:false`. An unreadable page is
"unknown", not "definitely not an auth wall".

**Evidence.** `src/capture/actions.mjs:900` —
`if (!r.ok) return { blocked: false, reason: \`auth check unavailable: ${r.error}\` };`
Call sites: `conversation-browser-adapter.mjs:135` and `:150` (`if (auth.blocked) return blocked('AUTH_WALL')`),
plus `preflight` at `:428` and `:446`.

**Current behaviour.** Net effect stays fail-closed: a page that cannot be evaluated also cannot produce a
usable composer, so `readiness` keeps polling and ends in `AUTH_WALL`/`SITE_GATE`/`READINESS_TIMEOUT` rather
than claiming readiness. What is wrong is the *reason*: the owner is told "no auth wall" when the truth is
"could not check", and any future caller that trusts `blocked === false` as positive evidence inherits a hole.

**MINIMAL change** — one line at `:900`:

```js
  if (!r.ok) return { blocked: null, reason: `auth check unavailable: ${r.error}` };
```

`null` is falsy, so both existing call sites (`if (auth.blocked)`) behave identically; `:901`'s
`!!r.value?.blocked` is unaffected because it only runs on the success path.

**Regression test** — `test/unit/conversation-create.test.mjs` style harness or an `actions`-level test with
`evaluate` throwing: `assert.equal((await detectAuthWall(page, adapter)).blocked, null)` and, at the adapter
level, that `readiness` does **not** return `AUTH_WALL` for it.

**Risk / rollback.** Any consumer doing `blocked === false` would change behaviour; a `grep` at time of
implementation confirms only truthiness tests exist. Revert is one line.

**Live verification required?** No.

---

### CC-06 — Native conversation controls are absent and only half-declared (P2)

**Claim.** The runtime exposes no rename, branch, edit, regenerate or stop-generation operation, but the
capsule registers only `stop_generation` as explicitly `unavailable`. The other four are simply missing, which
lets a consumer conclude they "might" work.

**Evidence.**
- `src/capture/conversation-capsule.mjs:105-107` — operations map has exactly
  `read_conversation, read_transcript, submit_conversation_turn, stop_generation,
  reconcile_conversation, finish_conversation, close_tab, change_model` (8 keys).
- `:63-67` — `stop_generation` is the correct pattern:
  `op('stop_generation', 'unavailable', { reason: 'NOT_IMPLEMENTED_IN_RUNTIME', evidence: [...] })`.
- `:89-95` — `change_model` shows the second correct pattern: unavailable when no measured selector exists.
- No branch/rename/edit/regenerate handling anywhere in `src/capture/` and no selectors for them in
  `src/profiles/sites/chatgpt.mjs` (there are no `modelSelectors` either).
- `docs/agents/CHATGPT-100-RECONCILED-STATUS.md` — objectives 024/028/029 already say
  "unsupported / Native lifecycle control is not exposed".

**Current behaviour.** Honest for `stop_generation`, silent for the rest. Nothing sends incorrectly; the risk
is a consumer reading absence-as-permission.

**MINIMAL change** — two new capsule entries mirroring `stop`, and no runtime work:

```js
  const renameNative = op('rename_conversation', 'unavailable', {
    reason: 'NOT_IMPLEMENTED_IN_RUNTIME',
    evidence: ['no measured rename control in the site profile; no post-effect title readback defined'] });

  const branchNative = op('branch_conversation', 'unavailable', {
    reason: 'NOT_IMPLEMENTED_IN_RUNTIME',
    evidence: ['branching changes thread identity; requires exact-thread gate, draft-idle precondition and post-branch readback'] });
```

and add `rename_conversation: renameNative, branch_conversation: branchNative` to the map at `:105-107`.

Explicitly out of scope for lane 3: implementing these. The registration bar should stay documented in the
evidence strings — measured selectors, ownership, exact-thread, draft-idle, post-effect readback.

**Regression test** — `test/unit/conversation-capsule.test.mjs` (no exhaustive key assertion exists today, so
adding keys is safe):
`assert.equal(capsule.operations.branch_conversation.state, 'unavailable')` and
`assert.equal(capsule.operations.branch_conversation.reason, 'NOT_IMPLEMENTED_IN_RUNTIME')`; same for rename.

**[CORRECTED 2026-10-28 — `state` is not the property name.** `op()` emits `availability`
(`conversation-capsule.mjs:18-19`). The landed test asserts `availability` and `reason` for all four keys:
`test/unit/conversation-capsule.test.mjs:71-77`.**

**Risk / rollback.** Purely additive to a JSON-shaped payload. If any consumer iterates operations and treats
`unavailable` as an error, that consumer should be fixed, not this change — verify with `grep` for
`operations` across `src/` and `test/` first.

**Live verification required?** No.

---

### CC-07 — "No page state" wording vs. the `__aionDrive` handle (P2, wording only)

**Claim.** The read path does mutate page state: `findComposer` stores the chosen element on
`globalThis.__aionDrive`, and `sendState`/`detectAuthWall` read it back through `live()`. Any description of
the capsule as not touching page state is inaccurate.

**Evidence.**
- `src/capture/actions.mjs:33` — `const store = (el, kind, tag) => { globalThis.__aionDrive = {...} }`
- `src/capture/actions.mjs:75` and `:98` — the two write sites; `:93` clears it when nothing matches.
- `src/capture/actions.mjs:34` — `const live = () => { const s = globalThis.__aionDrive; … }`
- Consumers: `:388` (`sendState`), `:856` (`detectAuthWall`).
- `src/capture/conversation-tools.mjs:52` — the actual claim is narrower and *correct*:
  "no focus, scrolling, insertion or send".

**Current behaviour.** Not a bug. But it is load-bearing: `sendState`'s fallback at `:390-391` is
`document.activeElement`, so deleting the write would degrade readiness quality (`evalOk:false` on pages
where the composer is never focused) rather than merely "clean up". A well-meaning refactor here is a
regression.

**MINIMAL change.** No production change. Two documentation edits are the correct scope for lane 3:
1. Keep `conversation-tools.mjs:52` as-is (it is accurate). If any other doc or capsule string says "no page
   state", narrow it to "writes a single composer handle (`globalThis.__aionDrive`); no focus, scroll,
   insertion, or send".
2. Leave `actions.mjs` alone.

**Regression test** — pin the write set so the refactor cannot happen silently:
after `findComposer` resolves `found:true`, assert the page reports a `__aionDrive` handle; after
`findComposer` resolves `found:false`, assert it is `null`.

**Risk / rollback.** Documentation only. Roll back by deleting the sentence.

**Live verification required?** No.

---

## 4. Hypotheses that remain UNPROVEN (do not code against these)

| ID | Statement | Why unproven | What would prove it |
|---|---|---|---|
| U-1 | Live objective 011's `BINDING_CHANGED` comes from `readiness:129` | No live trace names the origin; CC-03 is a source-level candidate only | A live run whose error carries the `readiness`/`creationLocation` reason, cross-checked against the `connection.json` reason |
| U-2 | Project/GPT routes (`/g/g-p-*/c/<id>`) fail differently from plain `/c/<id>` | Only unit-level route assertions exist (`conversation-create.test.mjs:71,83`) | A live project-tab connect |
| U-3 | A real auth wall renders on a fresh home tab | No live auth-wall capture in the ledgers | A signed-out live run |
| U-4 | `PREEXISTING_THREAD` from `preflight:425` is reachable in practice | It now requires a race past `check()`, which no test or live run has hit | A deterministic race test (see CC-02) |

**U-1 is resolved (2026-10-28), and the answer to the row is no.** The live reason is returned from the
pre-catch guard at `:123`; `:129` never ran. Two live conversations: `readiness.ready: false`,
`reason: "BINDING_CHANGED"`, zero sends. Row kept as written.

Stale ledger claims that are **already fixed at HEAD** — do not "fix" them again:
- `isStreaming` returning `streaming:false` on evaluation failure → fixed in `e7deb05` (`actions.mjs:731-734`).
- `targets()` hardcoding `ownedByStudio:false` → fixed in `1a0c3a3` (`targets()` at
  `conversation-runtime.mjs:498-518` now uses `ownedFreshTargetIds`). The repair plan's line 9 is stale.

---

## 5. Recommended order for LANE 3 (smallest safe first)

1. **CC-04** — one line, no behaviour change, no test rig needed. Establishes the pattern for the rest.
2. **CC-05** — one line, `null` is falsy so both call sites are unchanged; adds a two-assertion test.
3. **CC-06** — two capsule entries + two assertions; purely additive payload.
4. **CC-07** — documentation wording only; do it here, while the surrounding files are already open, so
   nobody later "fixes" the `__aionDrive` write.
5. **CC-02** — restore the deleted assertions as the failing test *first* (they fail against current HEAD for
   the `capture.state`/`phase`/`reason` half).
6. **CC-01** — the only real logic change; makes step 5 green. Verify with
   `node --test test/unit/conversation-create.test.mjs` and then the full unit suite.
7. **CC-03** — last, because it is the only change that swallows an error, and it should land on top of a
   green suite so any behavioural fallout is attributable.

Rationale for this order: it front-loads everything that cannot regress an effect path (1-4), then does the
one logic change that restores a proven invariant (5-6), then the one change with real blast radius (7). It
also means that if lane 3 runs out of budget, the repo is still strictly better than at `9560f56`.

**Do not** batch 1-7 into a single commit: CC-01 + CC-02 must be reviewable as a pair (the fix and the test
that would have caught it), and CC-03 must be independently revertible.

---

## 6. Do-not-change list

| Thing | Why it must stay |
|---|---|
| `ownedFreshTargetIds` / `freshTargetProvenance` (`conversation-ownership.mjs`) | Correct as of `1a0c3a3`. Ownership is the exact `targetID` + origin, revocation happens at `ownership.mjs:18`, and provenance is deliberately ephemeral (never reconstructed on recovery). A drifted tab still reading `owned:true` is defensible because every effect re-checks the path. |
| `targets()` (`conversation-runtime.mjs:498-518`) | Already isolated; the ledger claim that it hardcodes `false` is stale. |
| `freshComposerReady` not requiring `controls.observed` (`conversation-browser-adapter.mjs:198-200`) | Deliberate: a blank home composer has no Send button, so requiring observed idle controls would make every creation attempt fail. |
| `detectSiteFailure` fail-open (`actions.mjs:847`) | A failed failure-probe must not fabricate a site error; `readiness` compensates by never reaching `ready:true` without a composer. |
| `try { … } catch { /* keep polling */ }` at `conversation-browser-adapter.mjs:141` | Intentional: an unreadable send state keeps the poll alive instead of aborting. |
| The thrown `BINDING_CHANGED` in the creation preflight path | `test/unit/conversation-create.test.mjs:97` asserts it, and it is the correct classification for the fresh-home fence at `check():179`. CC-01 must persist the receipt **around** the throw, never replace the throw with a `finish()`/`registered()` return. |
| `check():174-180` fresh-home fence | It is the reason `PREEXISTING_THREAD` at `preflight:425` is now race-only. Removing the fence to "restore coverage" would reopen same-origin drift onto `/g/g-p-*` routes. |
| `conversation-tools.mjs:52` capability wording | It is accurate ("no focus, scrolling, insertion or send"). |
| `src/capture/conversation-thread.mjs:52-89` idle definition (requires a send button) | Ties "idle" to an actionable composer; loosening it would let a busy turn read as idle. |

---

## 7. Verification commands for LANE 3

```powershell
node --test test/unit/conversation-create.test.mjs
node --test test/unit/conversation-capsule.test.mjs
node --test "test/unit/**/*.test.mjs"          # full unit suite
node scripts/architecture-inventory.mjs --check
git status --short --branch                     # confirm only the intended files moved
```

Acceptance for this spec: CC-01 and CC-02 land together with the named assertions green; CC-03 has its own
commit and a scenario test proving a transient sample no longer aborts the connect; CC-04/05/06/07 are
one-liners each with one assertion. Nothing in section 4 or section 6 is touched.
