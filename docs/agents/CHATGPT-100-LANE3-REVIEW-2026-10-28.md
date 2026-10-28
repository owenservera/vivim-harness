# CHATGPT-100 — LANE 3 Implementation Review (2026-10-28)

**Reviewer lane:** LANE 2 (read-only). **Subject:** LANE 3 working-tree implementation of
`docs/agents/CHATGPT-100-CODE-CHANGES-2026-10-28.md`.
**Revision inspected:** `9560f56` (branch `main`, level with `origin/main`) **plus the uncommitted lane-3 tree**.
Nothing was committed. `git status --short --branch` at review time:

```
 M docs/agents/CHATGPT-100-INVESTIGATION-2026-10-28.json      (not lane 3 — ledger)
 M docs/agents/CHATGPT-100-LIVE-2026-10-28.json               (not lane 3 — ledger)
 M src/capture/actions.mjs
 M src/capture/conversation-browser-adapter.mjs
 M src/capture/conversation-capsule.mjs
 M src/capture/conversation-service.mjs
 M src/studio/conversation-tools.mjs
 M test/unit/chatgpt-new-chat-binding-investigation.test.mjs
 M test/unit/conversation-capsule.test.mjs
 M test/unit/conversation-create.test.mjs
 M test/unit/drive-observation-truth.test.mjs
```

Scope rule honoured: no file under `src/**`, `test/**`, or any JSON ledger was written by this review.

---

## 1. Verdicts

| ID | P | Verdict | One line |
|---|---|---|---|
| CC-01 | P1 | **ACCEPT** | Catch persists the receipt, disarms capture, consumes the key, and still throws the original code. |
| CC-02 | P1 | **ACCEPT** | Restored assertions match the persisted fields and fail against HEAD; race test makes `preflight:425` live. |
| CC-03 | P2 | **ACCEPT** | Narrows transience correctly and is *stricter* than the spec snippet; cannot yield `ready:true` on a wrong location. |
| CC-04 | P2 | **ACCEPT** | `observed` replaces the dead evidence-prefix guard; the test discriminates against the old line. |
| CC-05 | P2 | **ACCEPT** | `blocked:null` on the failure path; every call site is truthiness-only, so `null` is safe. |
| CC-06 | P2 | **ACCEPT-WITH-NOTE** | Rename/branch declared. `edit`/`regenerate` remain omitted, so the CC-06 claim is only half closed. |
| CC-07 | P2 | **REJECT** | The added sentence is false for `conversation_capsule`: that tool is a pure projection and touches no page state. |

**Counts: 5 ACCEPT, 1 ACCEPT-WITH-NOTE, 1 REJECT.** One rejection (CC-07). One incomplete fix (CC-06).

---

## 2. Method

1. Read the spec from the working tree (`484` lines; its line numbers are HEAD-anchored, so every reference was
   re-grepped before use).
2. Diffed `src/**` and `test/**` against `HEAD` with `git --no-pager diff -U6`.
3. Compared changed regions with `git show HEAD:<file>` to check pre-change behaviour, not just the new text.
4. Ran one focused test invocation (allowed, non-mutating):
   `node --test test/unit/conversation-create.test.mjs test/unit/conversation-capsule.test.mjs test/unit/chatgpt-new-chat-binding-investigation.test.mjs test/unit/drive-observation-truth.test.mjs`
   → **46 tests, 46 pass, 0 fail** (51.4 s). Full suite not run.
5. For each new test, asked one question: *would it fail on the pre-change line?* Results in §7.

---

## 3. Per-finding detail

### CC-01 — creation preflight throw skips the pre-effect receipt — ACCEPT

Implemented as specified, at `src/capture/conversation-service.mjs:290-303`:

- `:291` code normalisation (`/^[A-Z][A-Z0-9_]{0,79}$/`), fallback `PREFLIGHT_FAILED`.
- `:292` `PREEXISTING_THREAD` keeps its own branch (`push` + `prove()` + `finish()`), unchanged behaviour.
- `:295` `snapshot.attempts.push(attempt)` **before** `prove()`.
- `:296` `attempt.reason = code` — applied *after* `prove()`, so it overrides `prove()`'s hardcoded
  `attempt.reason = 'PREEXISTING_THREAD'` (`:275`). Correct order; the spec note at line 99 asked for exactly this.
- `:297` `snapshot.readiness = { ready:false, draft:{present:null,chars:null}, reason:code }`.
- `:298` `snapshot.state = 'blocked'; snapshot.uncertainty = null`.
- `:299` `await adapter.stopTurnCapture?.().catch(() => {})`. Safe: `stopTurnCapture` is `async`
  (`conversation-browser-adapter.mjs:356-361`) and exported (`:411`), and short-circuits on a null recorder (`:357`).
- `:300` `snapshot.capture.state = 'idle'`; `:301` `save()`; `:302` `throw error(code)`.

The throw survives. No `finish()`, no `registered()` — the acknowledgement is not resolved, so the caller still
observes `BINDING_CHANGED`. This satisfies section 6's "persist the receipt **around** the throw, never replace the
throw".

`prove()` (`:271-280` also sets `preEffect.typing/dispatch='not-executed'` (`:274`), `state='blocked'` (`:277`),
and releases the writer (`:279`). `save()` at `:301` persists all of it.

**Regression risk.** Low. The two behaviour changes for callers are (a) capture is disarmed instead of left
`recording`, (b) the key is consumed. Both are the safe direction. No test expected `capture.state === 'recording'`
after a blocked preflight (focused run is green).

### CC-01 stated deviation — verified CORRECT, spec is wrong

Lane 3 report: "the spec's claim that `:267` makes a same-key retry return `CREATION_UNCERTAIN` is wrong; the same
key replays read-only."

Confirmed. `submit()` resolves the key before any creation work:

```
conversation-service.mjs:430  const original = snapshot.attempts.find((a) => a.key === key);
conversation-service.mjs:432  if (original) { if (original.payloadDigest !== payloadDigest) throw error('IDEMPOTENCY_CONFLICT'); … return replay; }
```

`:432` returns before `writable()` (`:443`), before `revision()`/`confirm` (`:444-445`), and before the
`creatingNow()` path that reaches `submitCreation`. Therefore `:267`
(`if (snapshot.attempts.length !== 0) throw error('CREATION_UNCERTAIN')`) is **unreachable for a key already in
`snapshot.attempts`**. `CREATION_UNCERTAIN` needs a *new* key. Spec line 102 is wrong; the test encodes the truth
(`test/unit/conversation-create.test.mjs:111-119`).

### CC-02 — the pre-effect creation proof lost its unit coverage — ACCEPT

Restored assertions are `test/unit/conversation-create.test.mjs:97-120`. Every one matches a field that is actually
persisted:

| Assertion | Persisted field | Written by |
|---|---|---|
| `disk.attempts.length === 1` (`:100`) | `snapshot.attempts` | `conversation-service.mjs:295` |
| `attempts[0].phase === 'blocked'` (`:101`) | `attempt.phase` | `updateAttempt` `:163`, called from `prove()` `:278` |
| `attempts[0].reason === 'BINDING_CHANGED'` (`:102`) | `attempt.reason` | `:296` |
| `preEffect.typing/dispatch === 'not-executed'` (`:103-104`) | `attempt.preEffect.{typing,dispatch}` | `prove()` `:273-274` |
| `binding.thread === undefined` (`:105`) | `snapshot.binding.thread` | never pinned — no `pinThread` on this path |
| `capture.state === 'idle'` (`:106`) | `snapshot.capture.state` | `:300` |
| `state === 'blocked'` (`:107`) | `snapshot.state` | `:298` |
| `readiness.reason === 'BINDING_CHANGED'` (`:108`) | `snapshot.readiness.reason` | `:297` |
| `readiness.ready === false` (`:109`) | `snapshot.readiness.ready` | `:297` |
| `thread-turns` dir absent (`:110`) | filesystem | no turn record written |

The assertions are read back from the file on disk (`f.file(c.id)` parsed at `:99`), not from the in-memory view, so
they test persistence rather than a return value.

**Discriminating?** Yes for the new half. Against `HEAD` (pre-CC-01) the catch did not push the attempt, so
`attempts.length === 1` and `attempts[0].phase === 'blocked'` fail. The `:111-119` tail additionally proves
idempotency: same key → replay with `phase/reason` preserved and `insertions/sends` still `0`; new key `'two'` →
`CREATION_UNCERTAIN` with `0` inserts and `0` sends.

**Spec's extra requirement** — the adapter-level race test making `preflight:425` reachable — is present at
`test/unit/chatgpt-new-chat-binding-investigation.test.mjs:115-128`, and asserts exactly the three named properties:
`e.code === 'PREEXISTING_THREAD' && e.notDispatched === true && e.notTyped === true`. The race is deterministic
(`fixture({ armable: true, urls: () => … })`, `:119`), not a sleep, as the spec demanded (`:185`).

### CC-03 — `readiness()` turns a transient location sample into a terminal failure — ACCEPT

Implemented at `conversation-browser-adapter.mjs:114-190`.

- `:116` `let lastReason = null` declared outside the `do`, **and** `:118` `lastReason = null` reset at each tick
  top. Satisfies spec constraint "a stale `lastReason` from a previous tick must not leak" (`:236-237`) — belt and
  braces, both halves present.
- `:120` `if (!target) return blocked('TARGET_DISAPPEARED')` — still a hard return, unchanged (`:238`).
- `:135-151` the catch narrows transience:
  - `:138` code normalisation;
  - `:145-147` one re-read of `listTargets`, `TARGET_DISAPPEARED` if it vanished (`:146`);
  - `:149` `if (targetOrigin !== null && targetOrigin !== binding.origin) throw problem(code)` — a **committed,
    parseable, foreign** target stays terminal;
  - `:150` otherwise `lastReason = code` and the tick continues.
- `:152` `if (loc) { … }` gates the entire composer/auth/site probe, so a tick that failed `creationLocation()` can
  never reach `ready:true`.
- `:189` `return blocked(lastReason ?? 'READINESS_TIMEOUT')`.

No new error codes were introduced (`:239`).

**Stated deviation — the spec's rollback sentence is wrong.** Lane 3 report: "the spec's 'restore the single
`const loc` line' was wrong; `test/unit/chatgpt-new-chat-binding-investigation.test.mjs:100` depends on the uncaught
throw."

First half true, second half false. `:100` is `second target sample reverting to about:blank throws rather than
returning blocked`. Under lane 3's catch that test still rejects: the second sample is `about:blank`, so
`creationLocation`'s `new URL(target.url).origin` is the **string** `'null'`, `'null' !== 'https://chatgpt.com'`,
hence `throw problem('BINDING_CHANGED')` at `:107` of the adapter's `creationLocation` (`:101-107`); the catch's
re-read at `:145-147` also sees `about:blank`, so `targetOrigin === 'null'`, `!== null`, `!== binding.origin` →
`throw` at `:149`. The test rejects either way. It does **not** depend on the uncaught throw.

The real justification for not restoring the spec snippet is different and stronger: the snippet replaced the
`const loc = await creationLocation();` line with a catch that handed **every** failure to `blocked(...)`, which
would have demoted a genuine foreign-origin failure from a throw to a returned `blocked` value. Lane 3's version
keeps the throw for that case. **The code is better than the spec; the stated reason is wrong.** No repo text
carries the wrong reason — it lives only in lane 3's report.

**Fails closed?** Yes, three independent ways:
1. `ready:true` at `:168` requires `loc` truthy, and `loc` is only assigned on a full success of
   `creationLocation()` (origin match, `threadMatches`, `pageThreadMatches`).
2. Route fences at `:153` (`PREEXISTING_THREAD`) and `:155` (`BINDING_CHANGED` for non-`/` paths) run before the
   composer probe.
3. The deadline always breaks (`:186`) and returns `ready:false`.

**Can the catch swallow a real binding change?** No. Every cross-origin target state is caught *before* the catch:

| Change | Caught at | Result |
|---|---|---|
| target URL unparseable | `:121` | `blocked('BINDING_CHANGED')` |
| target committed, foreign origin | `:122-123` | `blocked('BINDING_CHANGED')` (only `about:blank` + `freshTab` tolerated) |
| page origin foreign | `:126-127` | `blocked('BINDING_CHANGED')` |
| thread/route drift | `:128-129` | `blocked('BINDING_CHANGED')` |
| target→foreign between `:119` and `creationLocation`'s own read | catch re-read `:145-147` → `:149` | `throw problem(code)` |
| target vanished in that window | `:146` | `blocked('TARGET_DISAPPEARED')` |

The only states that reach `lastReason` are: unparseable target URL, a same-origin target whose page sample is
unreadable, and a `listTargets` failure inside the catch. All three are re-evaluated on the next tick against a fresh
read, and the outer fences above are unconditional. A persistently wrong location therefore ends as
`blocked(reason)` at the deadline and never as `ready:true`.

### CC-04 — dead failure-string branch in `sendState` — ACCEPT

`actions.mjs:428-432`:

```js
    const stream = await isStreaming(page, adapter);
    // `observed` is the contract, not the evidence wording: a failed observation must never
    // assign a value here, whatever string the failure happens to carry.
    streaming = stream.observed === true ? stream.streaming : null;
```

Dead `String(stream.evidence ?? '').startsWith('streaming check failed:')` guard removed. Behaviour-identical for
today's returns (`isStreaming` failure path is `{ streaming:null, observed:false, … }`), and the rule is now
expressed structurally instead of by wording.

Test `test/unit/drive-observation-truth.test.mjs:77-96` is better than the spec's suggested test: the fake page
returns `{ streaming: true, evidence: 'streaming check failed: legacy wording' }`, i.e. a **successful observation
carrying the retired prefix**. Old line: prefix matches → `streaming` not assigned → `after.streaming === false` →
test red. New line: `observed === true` → assigned → `after.streaming === true` → green. Genuinely discriminating.

**Gap (not a verdict change).** The spec's other named assertion — failed observation → `streaming === null`,
`sent === false` while the turn count grew — is not asserted anywhere. That branch was already correct at HEAD, so
it would not discriminate, but it is now unpinned. Listed in §9.

### CC-05 — `detectAuthWall` reports an unreadable page as "not blocked" — ACCEPT

`actions.mjs:899-906`:

```js
  if (!r.ok) return { blocked: null, reason: `auth check unavailable: ${r.error}` };
  return { blocked: !!r.value?.blocked, reason: r.value?.reason ?? 'unknown' };
```

Only the failure path changed. `!!r.value?.blocked` still coerces the success path to a boolean, so `blocked` is
`true | false | null` — three-valued, as intended.

**Full call-site audit of `.blocked`** (`Select-String` over `src/**/*.mjs`, `bin/**/*.mjs`, `test/**/*.mjs`):

| Site | Test | `null` behaviour | Safe? |
|---|---|---|---|
| `actions.mjs:1174` | `emit({ type:'auth', blocked: auth.blocked, … })` (value only) | emits `null` in the event | Yes — value passthrough, no decision |
| `actions.mjs:1175` | `if (auth.blocked)` | falsy → does not set `result.blocked` | Yes — identical to `false`; `result.blocked` stays unset |
| `conversation-browser-adapter.mjs:158` | `if (auth.blocked) return blocked('AUTH_WALL')` | falsy → falls through, keeps polling | Yes — fail-closed via the composer probe + deadline |
| `conversation-browser-adapter.mjs:174` | same | same | Yes |
| `conversation-browser-adapter.mjs:452` | `if ((await …detectAuthWall(…)).blocked) throw problem('AUTH_WALL')` | falsy → preflight proceeds to its own gates | Yes — `:460` `freshComposerReady` still gates; an unreadable page cannot fake a composer |
| `conversation-browser-adapter.mjs:470` | same shape in the bound-thread preflight | same | Yes |
| `bin/commands/drive.mjs:100` | `if (!ev.blocked)` → prints info | `null` → info line printed | Yes — presentation only, no gate |
| `campaign.mjs:350-353`, `drive-api.mjs:16` | `result.blocked` | unrelated field on a different result object | Yes — not `detectAuthWall` output |

No `=== false` comparison on an auth-wall `blocked` exists anywhere in `src/**` or `test/**`. The spec's own
pre-merge grep (`:324`) holds. A future `=== false` consumer is the only way this becomes a hole — see §9.

Tests: `test/unit/drive-observation-truth.test.mjs:98-104` asserts `result.blocked === null`,
`result.blocked !== false`, and `reason` matches `/auth check unavailable/` — discriminating (HEAD returns `false`).
The adapter-level companion at `chatgpt-new-chat-binding-investigation.test.mjs:106-113` asserts only
`result.readiness.reason !== 'AUTH_WALL'`, which passes before and after; it pins the spec's required property but
carries no discriminating power. Noted, not blocking.

### CC-06 — native controls only half-declared — ACCEPT-WITH-NOTE

`conversation-capsule.mjs:69-81` adds `renameNative` and `branchNative`, both
`op(name, 'unavailable', { reason: 'NOT_IMPLEMENTED_IN_RUNTIME', evidence: [...] })`, with the registration bar in
the evidence strings exactly as the spec's block (`:355-361`) specified. Both are added to the operations map.

`op()` shape is `{ operation, availability, reason?, evidence }`; the test
(`test/unit/conversation-capsule.test.mjs:70-78`) asserts `.availability`, `.reason`, `.evidence` — matching fields,
not tautologies. No consumer iterates `operations` and treats `unavailable` as an error: every `.operations` hit in
`src/`, `bin/`, and `test/` is either the capsule builder itself or a per-key assertion (§8 of this review's grep).
Additive payload is safe.

**Note — the fix is incomplete relative to its own claim.** CC-06's claim (`spec:333-335`) names five missing
operations: `rename, branch, edit, regenerate, stop-generation`. The minimal change block only adds rename and
branch. `edit` and `regenerate` remain **absent from the map entirely**, so a consumer can still read
absence-as-permission for those two — the exact defect CC-06 was raised to remove. Lane 3 followed the spec's code
block literally, so this is a spec-scope defect inherited verbatim, not a lane-3 error. Tracked in §9.

The spec's suggested assertion (`capsule.operations.branch_conversation.state`) names a non-existent `.state`
property; lane 3 correctly used `.availability`. That is a spec typo, not a lane-3 deviation.

### CC-07 — "no page state" wording — REJECT

The spec's scope (`:401-405`) was: **keep `conversation-tools.mjs:52` as-is**, and narrow *any other doc or capsule
string* that says "no page state"; leave `actions.mjs` alone. It also required the CC-07 regression test: pin the
`__aionDrive` write set around `findComposer`.

Lane 3's handle-pin test is correct and lands where it belongs —
`test/unit/drive-observation-truth.test.mjs:106-129`: `found:true` → `handle.el === composer`;
`found:false` → `handle === null`. Discriminating against a refactor that deletes the write.

The **description edit is wrong**:

```
src/studio/conversation-tools.mjs:43-44 (conversation_capsule entry)
  description: '… Advisory evidence only, not provider availability or authorization for effects.
               Not a zero-page-state read: it leaves one composer handle in page state
               (globalThis.__aionDrive) so later samples can reuse it; no focus, scrolling,
               insertion or send.'
```

Three reasons this is a REJECT:

1. **It is false for this tool.** `conversation_capsule` is `runtime.capsule(id)` →
   `conversation-runtime.mjs:735-739` → `buildCapabilityCapsule({ view: snapshot, profile })`. The capsule is a
   pure projection over the persisted view. Its own header says so: "Pure function over the conversation view + the
   site profile's measured selectors … No I/O, no registry import" (`conversation-capsule.mjs:11-13`). It never
   reads or writes a page, and therefore never leaves a composer handle.
2. **It misattributes another operation's effect.** `globalThis.__aionDrive` is written by `findComposer`
   (`actions.mjs:59-103`, writes at `:75`/`:98`, clears at `:93`), which runs during `readiness`/read/preflight —
   not during a capsule read. The sentence describes `read_conversation`, then attaches it to `conversation_capsule`.
3. **It manufactures the misinformation the finding was raised to remove.** Before the edit the description made no
   page-state claim at all; it is now a false one, which is worse than silence for a consumer reasoning about side
   effects.

**Deviation claim 4 ("no doc said 'no page state', so lane 3 added the accurate sentence to the capsule tool
description") is rejected as stated.** No doc said it, and none needed editing: `conversation-tools.mjs:52`
(`read_conversation`) says "Read-only: no focus, scrolling, insertion or send" — accurate, and already protected by
section 6. The correct action under CC-07 was **no production edit plus the handle-pin test**. The test is right;
the sentence must go.

Rollback is one line (restore the original description), per the spec's own rollback note (`:411`).

---

## 4. Section 6 "do not change" verification

Diff scope: `src/capture/actions.mjs`, `conversation-browser-adapter.mjs`, `conversation-capsule.mjs`,
`conversation-service.mjs`, `src/studio/conversation-tools.mjs`, plus four test files. Nothing else.

| §6 item | Check | Result |
|---|---|---|
| `ownedFreshTargetIds` / `freshTargetProvenance` (`conversation-ownership.mjs`) | `git --no-pager diff --stat -- src/capture/conversation-ownership.mjs` | **untouched** (empty) |
| `targets()` (`conversation-runtime.mjs:498-518`) | same command on `conversation-runtime.mjs` | **untouched** (empty) |
| `freshComposerReady` not requiring `controls.observed` (`:222-224`) | diff has no hunk in that region; HEAD `:198-200` and working `:222-224` are byte-identical (`composerEnabled === true && stopPresent === false && state !== 'busy' && draft.chars === 0 && messages.length === 0`) | **preserved** |
| `detectSiteFailure` fail-open (`actions.mjs:847` region) | `actions.mjs` diff is confined to `sendState` `:428-432` and `detectAuthWall` `:899-906` | **untouched** |
| `try { } catch { /* keep polling */ }` (`:141` / now `:164`) | present verbatim at `:164`: `if (!state.evalOk) { /* keep polling */ }` | **preserved** |
| Thrown `BINDING_CHANGED` in the creation preflight path | `:302` `throw error(code)`; no `finish()`/`registered()` on the non-PREEXISTING_THREAD branch; `test/unit/conversation-create.test.mjs:97` still asserts `e.code === 'BINDING_CHANGED'` | **preserved** |
| `check():174-180` fresh-home fence | now at `:191-206`; fence intact at `:198-204` (`targetPath !== '/' \|\| pagePath !== '/'` → throw). Diff contains no hunk inside `check()` | **preserved** |
| `conversation-tools.mjs:52` capability wording | `git show HEAD:src/studio/conversation-tools.mjs` line 52 vs working line 52 | **untouched** — the edit is on the `conversation_capsule` entry (`:43-44`) |
| `conversation-thread.mjs:52-89` idle definition | `git --no-pager diff --stat -- src/capture/conversation-thread.mjs` | **untouched** (empty) |

All nine rows hold. CC-07's edit lands on a file in the diff, but not on the protected line.

---

## 5. Cross-cutting risk: the `about:blank` asymmetry

Not caused by lane 3, but CC-03 makes it visible. The loop tolerates an uncommitted fresh tab:

```
conversation-browser-adapter.mjs:123  if (!(freshTab && target.url === 'about:blank')) return blocked('BINDING_CHANGED');
conversation-browser-adapter.mjs:127  if (!(freshTab && pageOrigin === 'null')) return blocked('BINDING_CHANGED');
```

but `creationLocation()` does not, and its failure is re-thrown by the catch:

```
conversation-browser-adapter.mjs:105  try { parsed = new URL(target.url); } catch { throw problem('BINDING_CHANGED'); }
conversation-browser-adapter.mjs:107  if (parsed.origin !== binding.origin) throw problem('BINDING_CHANGED');
```

`new URL('about:blank').origin` is the **string** `'null'`, not `null`. So on a fresh tab that is still committing,
`:123`/`:127` would have tolerated it, but a target read landing inside `creationLocation()` throws
`BINDING_CHANGED`, the catch's re-read sees `'null' !== null` and `!== binding.origin`, and `:149` re-throws
terminally. Pre-existing behaviour (`test/unit/chatgpt-new-chat-binding-investigation.test.mjs:100` pins it), not a
regression — but the two tolerances disagree, and a live connect on a slow commit could still abort where CC-03
intended to survive. See §9.

---

## 6. Verified deviations summary

| # | Lane 3 claim | Verdict |
|---|---|---|
| 1 | Same key replays read-only at `:430-432`; `:267` `CREATION_UNCERTAIN` needs a new key | **CORRECT** — spec line 102 wrong; replay returns before `writable()`/creation |
| 2 | `:100` depends on the uncaught throw; transience narrowed per origin parseability | **Code CORRECT, reason WRONG** — `:100` rejects under both versions; the real justification is that the spec snippet demoted a real foreign-origin throw to a returned `blocked` |
| 3 | Only rename/branch declared; edit/regenerate undeclared | **CONFIRMED** — matches the spec's code block, but leaves CC-06's claim half-closed |
| 4 | No doc said "no page state", so a sentence was added to the capsule description | **REJECTED** — no doc needed editing; the added sentence is factually false for `conversation_capsule` |

---

## 7. Test discriminating power

| Test | Location | Fails on pre-change code? |
|---|---|---|
| CC-01/CC-02 receipt + replay + new-key | `conversation-create.test.mjs:93-120` | **Yes** — `attempts.length`, `phase`, `state`, `readiness` all fail at HEAD |
| CC-02 race `PREEXISTING_THREAD` | `chatgpt-new-chat-binding-investigation.test.mjs:115-128` | Yes — the path is dark at HEAD without `armable` + racing `urls()` |
| CC-03 Scenario A (transient unparseable) | `chatgpt-new-chat-binding-investigation.test.mjs:130-138` | **Yes** — HEAD throws out of `readiness`; test expects `ready:true` |
| CC-03 Scenario C (persistent bad sample) | `chatgpt-new-chat-binding-investigation.test.mjs:140-150` | **Yes** — HEAD rejects; test expects `ready:false` + `reason:'BINDING_CHANGED'` |
| CC-03 Scenario B (`TARGET_DISAPPEARED`) | `chatgpt-new-chat-binding-investigation.test.mjs:152-157` | No — pins a constraint the change must not break; correct as a guard |
| CC-04 `observed` vs wording | `drive-observation-truth.test.mjs:77-96` | **Yes** — legacy-prefixed success observation is dropped by the old guard |
| CC-05 `blocked:null` | `drive-observation-truth.test.mjs:98-104` | **Yes** — HEAD returns `false` |
| CC-05 adapter-level "not AUTH_WALL" | `chatgpt-new-chat-binding-investigation.test.mjs:106-113` | No — passes both ways; property pin only |
| CC-06 rename/branch declared | `conversation-capsule.test.mjs:70-78` | **Yes** — keys absent at HEAD |
| CC-07 handle pin | `drive-observation-truth.test.mjs:106-129` | Yes for the refactor it guards; no behavioural change to detect |

Assertions read persisted/reported fields, not constants. No tautologies found. Two tests are non-discriminating by
design (constraint pins), which is stated above rather than hidden.

**Focused receipt:** 46 tests / 46 pass / 0 fail, 51.4 s, four files, no edits.

---

## 8. Residual risks

1. **CC-07 false description ships.** *(highest)* Any agent reading `conversation_capsule` now believes the read
   mutates page state, and may avoid a safe call or "clean up" `__aionDrive` — the exact refactor CC-07 exists to
   prevent. The test that should protect the write is correct, so the guard is intact; the prose is not.
2. **`about:blank` asymmetry (§5).** A fresh tab mid-commit can still abort a connect via the catch's re-throw,
   contradicting the tolerance at `:123`/`:127`. CC-03 narrows but does not remove this.
3. **`blocked:null` is one `=== false` away from a hole.** All eight call sites are truthiness-only today (§3), but
   nothing pins that. A future `auth.blocked === false` consumer turns "unknown" into "no wall".
4. **Catch-path branches untested.** `:146` (`TARGET_DISAPPEARED` inside the catch) and `:149` (parseable foreign
   origin re-throw) have no test exercising them through the catch. Scenario B covers the outer `:120` return, not
   `:146`.
5. **CC-04 failure branch unpinned.** `observed:false → streaming:null, sent:false` with turn growth is untested.
6. **`edit`/`regenerate` still absent-as-permission.** CC-06's stated defect survives for two of the five named
   operations.
7. **`listTargets` failure inside the catch is transient while the same failure at `:119` is terminal.** Inconsistent
   severity for the same error; safe direction (retry, never ready), but undocumented.

---

## 9. Required follow-ups

| # | Action | Owner lane | Blocking? |
|---|---|---|---|
| F-1 | Revert the `conversation_capsule` description to the HEAD text (`conversation-tools.mjs:43-44`). No replacement sentence — no doc makes the "no page state" claim. Keep the handle-pin test. | 3 | **Yes — CC-07 is a REJECT** |
| F-2 | Declare `edit_message` / `regenerate` in the capsule as `unavailable`/`NOT_IMPLEMENTED_IN_RUNTIME`, or record an explicit exclusion rationale in the capsule header. Closes CC-06's claim. | 3 | No |
| F-3 | Correct lane 3's CC-03 justification in its report: `chatgpt-new-chat-binding-investigation.test.mjs:100` rejects under both versions; the real reason for rejecting the spec snippet is foreign-origin demotion. | 3 (report only) | No |
| F-4 | Add a catch-path test for the parseable foreign origin (`:149` throw) and for `TARGET_DISAPPEARED` inside the catch (`:146`). | 3 | No |
| F-5 | Add the CC-04 failure assertion: `observed:false` with turn growth → `streaming === null`, `sent === false`. | 3 | No |
| F-6 | Reconcile `about:blank`: either tolerate it in `creationLocation()`/the catch's re-read the way `:123`/`:127` do, or document why the inner read is stricter. | 3 | No (pre-existing) |
| F-7 | Pin the `blocked:null` contract: a comment or test asserting no call site compares `auth.blocked === false` positively. | 3 | No |
| F-8 | Keep CC-01+CC-02 as one reviewable commit and CC-03 as its own, per spec §5. Do not batch all seven. | 3 | Process |

---

## 10. Bottom line

Five of seven findings are implemented correctly, one deviates in a direction that is **stricter** than the spec
(CC-03, with a wrong but harmless stated reason), one is **incomplete** (CC-06: rename/branch only), and one is
**wrong in the repo** (CC-07: a false capability claim added to the tool surface). CC-01 and CC-02 — the pair that
restores the pre-effect receipt — are correct, tested, and provably fail against `9560f56`. Section 6 holds on all
nine rows. The 46/46 focused run is real.

Ship-blocker: F-1 only.

---

## Delta review (post-FIX 1/2/3)

Reviewed against the working tree at ledger attempt `058`/`ERA3_NAV` (`2026-10-28T12:47:27Z`).
`git diff --stat -- src test`: 8 files, 307 insertions, 40 deletions. Dirty `src`:
`actions.mjs`, `conversation-browser-adapter.mjs`, `conversation-capsule.mjs`,
`conversation-service.mjs`.

Tree-state caveat: during the review one read of `conversation-browser-adapter.mjs:121-127`
returned the HEAD form with `// TEMP-RED-CHECK` markers; the next `git diff` showed the
tolerance restored. `Select-String … TEMP-RED-CHECK` over `src/`, `test/` now returns 0 hits and
the line evidence below is from that final state. A tree that mutates mid-review can invalidate
any verdict read from it; this one was re-read after the last change.

### D-1 — CC-07 reverted — PASS

`git diff -- src/studio/conversation-tools.mjs` = 0 lines. `conversation_capsule`
(`conversation-tools.mjs:42-44`) carries the HEAD description with no "no page state" claim. The
false capability sentence and its test are gone.

### D-2 — CC-06 completed — PASS

`conversation-capsule.mjs:83-95` declares `editNative` → `edit_message` (`:86`) and
`regenerateNative` → `regenerate` (`:93`), both `unavailable` with
`reason: 'NOT_IMPLEMENTED_IN_RUNTIME'` and non-empty `evidence`. `:135` registers both in
`operations` alongside `rename_conversation` (`:72`), `branch_conversation` (`:79`) and
`stop_generation` (`:66`). `test/unit/conversation-capsule.test.mjs:73` asserts all four for
`availability`, `reason` and `evidence.length > 0`. That is the full F-2 list — no silent
omission left.

### D-3 — CC-03 still fails closed on a committed foreign origin — PASS

`new URL('https://example.com/').origin` → `'https://example.com'` ≠ binding `https://chatgpt.com`,
so `:122` is true and `:127` evaluates `!(true && (false || false))` → `return
blocked('BINDING_CHANGED')`. The function returns; there is no retry and no ready path.

The effect gate is independent and unchanged: `check()` `:201` throws on
`originOf(target.url) !== binding.origin`, and `creationLocation()` `:106` throws on
`parsed.origin !== binding.origin`. A committed foreign origin cannot reach typing or send.

Nit N-1: `:127`'s foreign branch has no dedicated test in this file. The suite covers the
catch-path terminal throw (`:155`) via "a target that commits a foreign origin inside
creationLocation stays a terminal throw" (`urls: [root, 'https://example.com/']`), and the
`:120` `TARGET_DISAPPEARED` via "a missing target stays a hard TARGET_DISAPPEARED". The catch's
own `:152` `if (!now) return blocked('TARGET_DISAPPEARED')` is still dark.

### D-4 — `ready: true` is unreachable on an uncommitted target — PASS

Two sites return `ready: true`: `:174` and `:187`.

- `:187` is in the `else` of `:134` (`freshTab && !binding.thread`). For the fresh-tab,
  no-thread binding this fix targets, `:187` cannot run.
- `:174` requires `loc` truthy from `:140`, which requires `creationLocation()` to return, which
  requires `:106` `parsed.origin === binding.origin`. A target on `chrome://newtab/`,
  `about:blank` or any other non-special scheme parses to origin `'null'`, so `:106` throws,
  `loc` stays `null`, and neither ready site runs.
- The null *page* origin tolerated at `:130-131` does not open a ready path either: that branch
  skips the whole `if/else if` chain, so `:174` and `:187` are both bypassed.

With the target pinned to `chrome://newtab/` for the whole window the loop ends at `:195` as
`READINESS_TIMEOUT`; the test asserts that plus `deferredCapture: true`, `sessionId: null`.
Verified by execution (35/35 pass), not by reading.

Nit N-2: that test's comment says ready is reachable "from one place, the loc branch (:158)".
`:187` is a second site, reachable only when `freshTab` is false or `binding.thread` is set.
The comment needs that qualifier; the assertion itself is sound.

### D-5 — `'null'` cannot swallow a wrong http(s) binding — PASS, with an accepted degradation

`new URL(x).origin` on this runtime:

| Input | origin |
|---|---|
| `https://example.com/`, `https://chatgpt.com/`, `https://user:pw@example.com/` | `https://…` |
| `blob:https://example.com/uuid` | `https://example.com` |
| `ws://example.com/`, `ftp://example.com/` | own origin |
| `about:blank`, `chrome://newtab/`, `chrome-extension://…`, `file:///C:/x`, `data:…`, `javascript:…`, `mailto:…` | `'null'` |

Every http(s) origin keeps its scheme+host, and `blob:` inherits the wrapped origin, so no
foreign web origin can stringify to `'null'`. `:121`'s catch assigns `'null'` only when
`new URL` throws, which for Chrome target urls means an empty/blank string (covered by the
`urls: () => (++reads === 2 ? '' : root)` test). `:155`'s tolerance is therefore reachable only
for non-special schemes and unparseable strings — never for a committed `https://` foreign
origin.

Accepted degradation: a target that commits `file:`, `chrome:`, `data:` or an unparseable URL
now polls to the deadline instead of failing fast. `lastReason` is reset at `:118`, so the final
reason is `READINESS_TIMEOUT` unless the last tick took the catch path. No ready, no typing, and
`check()` still throws.

Operational consequence worth flagging to lane 1: the live 011 shape (`readiness.ready` false,
reason `BINDING_CHANGED`) was produced by pre-fix code. Post-fix, the same null-origin tab
reports `READINESS_TIMEOUT`. `PROGRESS` :50 and `RUNBOOK` :264 quote `BINDING_CHANGED`; a
post-fix 011 rerun will legitimately record a different reason string. That is a reporting
change, not a safety change.

### D-6 — operation key naming — PASS (advisory only)

Chain: `buildCapabilityCapsule` (`conversation-capsule.mjs:125-138`) →
`conversation-runtime.mjs:735-739` `capsule(id)` → tool `conversation_capsule`
(`conversation-tools.mjs:42-44`, `GET /conversations/{conversation}/capsule`, runtime method
`capsule`). No consumer indexes `operations` by a fixed name: the map is returned whole and each
entry repeats its key as `operation` (`:18-19`, `:86`, `:93`, `:135`). So a key cannot mismatch a
consumer; it only has to match the runtime vocabulary. `edit_message` follows
`<verb>_<noun>` like `rename_conversation` / `branch_conversation`; `regenerate` is a bare verb
matching objective 025 and the F-2 wording. Naming is correct as advisory metadata.

### D-7 — test properties — PASS, two nits

| Test | Name claims | Assertion | Holds |
|---|---|---|---|
| null origin then settles | becomes ready | `ready: true`, `reason: null` | yes |
| about:blank mid-connect | retries, does not abort | `ready: true` | yes (`:127` tolerates) |
| pinned `chrome://newtab/` | never ready | `ready: false`, `READINESS_TIMEOUT`, `deferredCapture: true`, `sessionId: null` | yes |
| pinned `about:blank` | blocked, not thrown | `ready: false`, `READINESS_TIMEOUT` | yes |
| foreign origin in creationLocation | terminal throw | `rejects(BINDING_CHANGED)` | yes |
| unreadable auth check | not AUTH_WALL, keeps polling | `reason !== 'AUTH_WALL'`, `deferredCapture: true` | yes, polling inferred |
| `/c/` race | preflight PREEXISTING_THREAD | code + `notDispatched` + `notTyped` | yes |
| transient `''` sample | not terminal | `ready: true` | yes |
| alternating null page sample | no throw, no ready, recorded reason | `reason: 'BINDING_CHANGED'` | yes |
| missing target | hard TARGET_DISAPPEARED | `reason: 'TARGET_DISAPPEARED'` | yes |

Deleted `'second target sample reverting to about:blank throws rather than returning blocked'`
asserted `rejects(BINDING_CHANGED)` for `urls: [root, 'about:blank']`. Its scenario survives
verbatim as "a target pinned to about:blank resolves blocked rather than throwing" — same
fixture, expectation inverted. The safety half of the old assertion (a committed foreign origin
is terminal) survives as the foreign-origin catch-path test. The property was inverted
deliberately, not dropped, and the inverted reading is the correct one: `about:blank` is
uncommitted, not a binding change.

Nit N-3: "an unreadable auth check … keeps polling" asserts `reason !== 'AUTH_WALL'` and
`deferredCapture: true`; it does not assert a poll count. Name slightly stronger than the
assertion. Non-blocking.

### F-1 … F-8 disposition

| # | State |
|---|---|
| F-1 | **Done.** 0 diff on `conversation-tools.mjs`. |
| F-2 | **Done.** All four declared, registered, asserted. |
| F-3 | Report-only; no code change needed. |
| F-4 | **Half.** Foreign-origin catch-path test added; catch `:152` `TARGET_DISAPPEARED` still uncovered (N-1). |
| F-5 | Not in this delta; no assertion added. |
| F-6 | **Done.** `:121`, `:127`, `:155` all tolerate `'null'`/`about:blank`. |
| F-7 | **Partially.** Behaviour pinned by test; no comment asserting no positive `blocked === false` comparison. |
| F-8 | **Open.** 8 dirty files still span three findings. |

### Delta verdicts

| Item | Verdict |
|---|---|
| CC-07 revert | PASS |
| CC-06 completion | PASS |
| CC-03 fail-closed | PASS |
| CC-03 ready reachability | PASS |
| CC-03 `'null'` tolerance | PASS, accepted degradation |
| Operation key naming | PASS |
| Test properties | PASS (N-1, N-2, N-3 nits) |
| **REJECT** | **none** |

No ship-blocker remains in this delta. The one thing that would change that: a path where
`ready: true` is returned while `actual !== binding.origin`. None exists in `:114-196` — `:128`
is the only branch that can reach either ready return, and it is entered only when the target
origin matches.
