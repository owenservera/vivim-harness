# Observed-Prefix Recovery Spec — Harbor pilot, turn 1

**Status: PROPOSED — NOT APPROVED.** This document specifies a capability; it does not implement it, authorize it, or report it as working.
**Date:** 2026-10-27 · **Repo:** `owenservera/vivim-harness` · **Branch:** `main` (owner forbids branches) · **Base SHA:** `10a60ef`
**Scope of this document:** docs only. No source, test, fixture, config, Git, network, or provider change was made for it.

---

## 1. Purpose

### 1.1 The capability in one sentence

A fresh, live Studio runtime can **bind the exact existing ChatGPT thread**, record the user-visible turn 1 as an **observed prefix** (explicitly unattributed to Studio's submit path), and then send turns 2–3 on that same thread — **without resending turn 1, without writing a fabricated journal `delivered` event, and without a second browser actor or a duplicate store**.

### 1.2 What this capability is not

- It is **not** recovery of the original conversation. The original snapshot stays exactly as it is: unbound, `needs-reconciliation`, `CREATION_UNPINNED`, one journal-less attempt.
- It is **not** a claim that Studio dispatched turn 1. The submit path already reported `dispatched: true` (`src/capture/actions.mjs:354`) for a transport timeout, and a CDP request timeout is a client-side timer (`src/cdp/client.mjs:21-23`, reject at `:88`), not a coded pre-effect refusal. Both directions are unprovable, so the prefix records `sendActor: unknown`.
- It is **not** a second message store, journal, adapter registry, or `/chat` surface. The prefix lives in the existing conversation snapshot; the capture KV is referenced in place, never copied.

### 1.3 Live situation (given by the orchestrator; **not re-verified in this session**)

Studio PID 8616 (port 38703), dedicated Chrome PID 18216 (CDP 38702, profile `C:\VIVIM\chrome-profile`), workspace `C:\VIVIM`. Three prompts authorized, once each, in one new thread; only turn 1 was submitted
(`For a fictional project called Harbor, remember two requirements: local-first storage and JSON export. Briefly confirm them.`)
and the user visually confirmed the reply. Turns 2–3 were never sent. Studio recorded `needs-reconciliation` / `CREATION_UNPINNED` with identity `unbound / NEW_CHAT`. This session did not read `C:\VIVIM`, the log, the page, or the CDP endpoint.

### 1.4 Starting verdict carried forward (accepted, not re-investigated)

**NO-GO** for recording turn 1 as journal-attributed delivery. **Conditional GO** for a new runtime that binds the exact thread and records turn 1 as an observed prefix.

---

## 2. Verified anchors

Every line below was read in this session at `10a60ef`. These are the only facts the design may rely on.

| Claim | Anchor |
|---|---|
| Creation submit failure goes straight to `uncertain('CREATION_UNPINNED')`, before reservation/binding | `src/capture/conversation-service.mjs:315-318` (catch `:315`, `uncertain(…)` `:317`) |
| Failure path never creates `binding.thread`, journal reservation, or delivery evidence | `src/capture/conversation-service.mjs:257-342` (reservation only at `:327`; only on the success branch) |
| Journal access requires a bound identity | `src/capture/conversation-service.mjs:107-111` (throw `:108`) |
| `observe()` requires the bound journal and a boundary | `src/capture/conversation-service.mjs:155-171` (journal call `:163`) |
| New key on an unbound creation is refused | `src/capture/conversation-service.mjs:258` (`CREATION_UNCERTAIN`) |
| Same key + same payload replays read-only | `src/capture/conversation-service.mjs:411-413` |
| Any journal-less attempt blocks later submits **in the same conversation** | `src/capture/conversation-service.mjs:441` (`LEGACY_ATTEMPT_REQUIRES_RECONCILIATION`) |
| Reconcile is journal-bound; a null observation changes nothing | `src/capture/conversation-service.mjs:588-593` |
| `finish` does not resolve uncertainty | `src/capture/conversation-service.mjs:612-634` (stop-fail `:620`; each attempt marked `incomplete` `:625`) |
| `finishEntry` releases the writer, then preserves evidence | `src/capture/conversation-runtime.mjs:188-212` |
| `writer.active` is occupancy accounting, not a leak | `src/capture/conversation-runtime.mjs:136-140`, `253-276` |
| Existing-thread attach is refused while a journal-less, non-blocked attempt exists on the origin | `src/capture/conversation-runtime.mjs:399-404` (refusal `:403`) |
| `finish` does not clear that guard | guard reads snapshot files from disk, never `finish`; same lines |
| Restart installs a stub adapter (reconcile → null, stop → throws) | `src/capture/conversation-runtime.mjs:68-69` |
| Recovered entries cannot submit | `src/capture/conversation-runtime.mjs:453` (`CONVERSATION_NOT_WRITABLE`) |
| A CDP timeout is a request timeout | `src/cdp/client.mjs:21-23`; `_send` `:75-96` (reject `:88`) |
| A dispatch error is still reported as dispatched/uncertain | `src/capture/actions.mjs:335-337`, `349-359` (`dispatched: true` `:354`) |
| Creation attempt KV is written **before** typing, with prompt + digest + boundary | `src/capture/conversation-browser-adapter.mjs:435-438` (KV `:437`) |
| KV persistence is `tmp` + `rename`, **no fsync** | `src/store/session.mjs:24-28`; `keys()` filters `.tmp` `:60` |
| Attaching a target that still has a recording/stopping session is refused | `src/capture/conversation-browser-adapter.mjs:249`; `src/capture/recorder.mjs:108-111` (`TARGET_RECORDER_BUSY`) |
| Recorder terminal metadata carries `endReason` + `integrity` | `src/capture/recorder.mjs:807-811`; stop-failed `:765-769` |
| A journal `delivered` turn **must** have a boundary | `src/capture/thread-turn-journal.mjs:137`; `delivery.state` ⇔ `phase==='delivered'` `:128` |
| `reserve()` fences on any unresolved turn and creates `boundary: null` | `src/capture/thread-turn-journal.mjs:251-268` (fence `:260`, turn `:262-265`) |
| Delivery observation requires attribution + boundary | `src/capture/thread-turn-journal.mjs:308-319`, `validDelivery` via `attributed()` `:73-79` |
| Snapshot validation is field-strict for attempts | `src/capture/conversation-service.mjs:57-82` (attempt loop `:77-81`) |
| `/c/<uuid>` is the only supported thread form | `src/capture/conversation-thread.mjs:7-23`; `validThread` `:27-30` |
| Page message ids come only from native `data-message-id` | `src/capture/conversation-thread.mjs:95`, `127-128` |

**Consequence that shapes the whole design:** because `:441` refuses *any* conversation holding a journal-less attempt, adopting the prefix into the original conversation would permanently forbid turns 2–3. Because `:403` refuses attaching the thread to a *new* conversation while that journal-less attempt exists, the new conversation needs an explicit, narrow admission exception. Both facts are structural, not incidental.

---

## 3. Definitions

| Term | Meaning here |
|---|---|
| **Journal delivery** | A turn admitted by `reserve()`, progressed `typing → dispatching`, and closed by `observeDelivery()` with attributable evidence (`thread-turn-journal.mjs:251-319`). Only turns 2–3 may ever reach this. |
| **Observed prefix** | A user message and its reply that **exist on the bound page** at bind time, whose arrival channel and sender are unknown. It is page-observed, not admitted, not delivered, not journal-attributed. |
| **Adoption** | The one-time, local, effect-free act of recording that observed prefix against a new conversation and the exact thread. |
| **Preimage** | The immutable tuple of digests/ids that defines an adoption: source conversation, source attempt, prompt digest, thread ref, user-message id + digest, assistant-message id + digest. |
| **Settled capture** | A recorder session whose metadata is terminal and carries `endedAt`, `endReason`, `integrity`. |

---

## 4. Exact-target proof

Bind uses the existing read-only idle-page attach path (`conversation-browser-adapter.mjs:78-90`) and **no recorder**. All checks are reads: `listTargets`, `Runtime.evaluate` of `location.*` + transcript. No `Page.bringToFront`, no focus, no navigation, no typing, no send, no screenshot.

The request must name the target explicitly: `POST /api/v1/conversations/prefix` with `{ site, targetId, expectedThread, source: { conversationId, attemptId }, promptAttestation? }`. No ambient "pick the only tab" behaviour.

### 4.1 Check sequence (all must pass; first failure is terminal)

| # | Check | Refusal code |
|---|---|---|
| T1 | `listTargets` reachable; exactly one live target with `id === targetId`, `type === 'page'` | `PREFIX_TARGET_NOT_FOUND`, `PREFIX_TARGET_NOT_PAGE` |
| T2 | `new URL(target.url).origin` is `https://chatgpt.com` or `https://chat.openai.com`, and equals the origin the adapter profile resolves | `PREFIX_TARGET_ORIGIN_MISMATCH` |
| T3 | `parseThread('chatgpt', target.url)` yields a thread whose `ref` equals `expectedThread` | `PREFIX_TARGET_URL_UNSUPPORTED`, `PREFIX_THREAD_ID_MISMATCH` |
| T4 | The target URL parses to exactly the UUID in `expectedThread` — no redirect form, no query-encoded id, no trailing junk | `PREFIX_THREAD_ID_MISMATCH` |
| T5 | Exactly one **page** target on this CDP endpoint parses to the same thread ref | `PREFIX_TARGET_AMBIGUOUS` |
| T6 | In-page `location.origin === target origin` and `location.pathname` parses (`parseThread`) to the **same** ref | `PREFIX_PAGE_THREAD_MISMATCH` |
| T7 | The page's own native thread id equals the URL id: the `parseThread` id from `location.pathname` equals the id from `target.url` | `PREFIX_THREAD_ID_MISMATCH` |
| T8 | A second, later read (after the reply-stability window, §6) still yields the same `targetId`, origin, ref, and id | `PREFIX_TARGET_CHANGED` |

T7 is the "DOM thread id must equal the URL id" requirement in its strongest available form: `conversation-thread.mjs` derives identity from the path only (`:14-23`) and never from the title (`:5`), and no other native thread-id source exists in this codebase. The spec therefore treats **two independent path reads on two channels** (DevTools target list vs. page `location`) plus the exact UUID equality as the proof. If a future adapter exposes a true page-level thread id, it must be added as an additional equality, never as a replacement.

**Named scenarios:** `T-twin-tabs` (two tabs, same thread → refuse), `T-stale-target` (target reloaded between reads → refuse), `T-redirect` (URL settles on `/c/<uuid>?…` → refuse), `T-cross-origin` (page on a different host → refuse), `T-title-lies` (title claims another thread; ignored).

**Negative invariants**
- N1: A target is never inferred from "the only chatgpt tab".
- N2: A thread is never inferred from the tab title, page heading, or message text.
- N3: No bind proceeds on a single read; T8 requires two agreeing reads.

---

## 5. Original persisted evidence

Everything here is read directly from disk. The bind path **must not** call `runtime.load()` on the source conversation: it would be `readOnly` while PID 8616 lives (`conversation-runtime.mjs:63-70`), and loading mutates nothing but still couples this path to the live process's fate.

### 5.1 Required source files

- Conversation snapshot: `<root>/conversations/<conversationId>.conversation.json`
- Capture session: `<root>/sessions/<sessionId>/session.json`
- Creation-attempt KV: `<root>/sessions/<sessionId>/kv/CONVERSATION_ATTEMPT_<attemptId>.json` (`conversation-browser-adapter.mjs:437`)

### 5.2 Checks

| # | Check | Refusal code |
|---|---|---|
| O1 | Source snapshot exists and parses; `validSnapshot`-equivalent field validation passes | `PREFIX_SOURCE_MISSING`, `PREFIX_SOURCE_CORRUPT` |
| O2 | Exactly one attempt matches `attemptId` | `PREFIX_SOURCE_ATTEMPT_MISSING` |
| O3 | That attempt has `creation === true` | `PREFIX_SOURCE_ATTEMPT_NOT_CREATION` |
| O4 | It is the only attempt in the snapshot | `PREFIX_SOURCE_ATTEMPTS_AMBIGUOUS` |
| O5 | `payloadDigest` is 64 lowercase hex and `key`/`id` are non-empty | `PREFIX_SOURCE_DIGEST_INVALID` |
| O6 | Snapshot `sessionId` equals the KV record's `boundary.sessionId`, and `binding.targetId` equals the live target | `PREFIX_SESSION_OWNER_MISMATCH` |
| O7 | `session.json.conversationOwner.conversationId` equals the source conversation id (`recorder.mjs:128`) | `PREFIX_SESSION_OWNER_MISMATCH` |
| O8 | Session status is **settled**: `complete`, `complete_with_integrity_warnings`, or `incomplete`, **and** `endedAt`, `endReason`, `integrity` are present (`recorder.mjs:807-811`) | `PREFIX_SESSION_METADATA_INVALID` |
| O9 | Session status is **not** `recording` or `stopping` (a live recorder still owns the target; `adapter:249`, `recorder:108-111`) | `PREFIX_SESSION_STILL_RECORDING` |
| O10 | If the KV record exists, its `payloadDigest` and `boundary` (sequence, transcriptCount, sessionId) equal the snapshot attempt's | `PREFIX_SOURCE_KV_MISMATCH` |
| O11 | The attempt is **not** already adopted by another prefix record | `PREFIX_SOURCE_ALREADY_ADOPTED` |
| O12 | The attempt's phase is `uncertain` (the recorded outcome) and it has no journal | `PREFIX_SOURCE_STATE_UNEXPECTED` |

### 5.3 Prompt resolution — hypothesis made explicit

**Hypothesis H1:** the exact prompt bytes are recoverable from `CONVERSATION_ATTEMPT_<attemptId>.json`. This is plausible because the KV write precedes typing (`adapter:435-438`) and contains `prompt`, `payloadDigest`, `boundary`, `baseline`.

**H1 is not guaranteed:** the KV write is `tmp`+`rename` with no fsync (`session.mjs:24-28`), so a crash can leave a `.tmp` remnant and no final file; `keys()` ignores `.tmp` (`:60`). A `.tmp` file for this key is an **unconfirmed write** and MUST NOT be read as evidence.

Resolution tiers, in order:

| Tier | Condition | Recorded `prompt.source` |
|---|---|---|
| A | KV exists, KV digest === snapshot digest, `sha256(pageUserText)` === digest | `capture-kv` |
| B | KV absent, `sha256(pageUserText)` === snapshot digest | `page+snapshot-digest` |
| C | KV absent, owner supplies the exact prompt at bind time, `sha256(ownerPrompt)` === snapshot digest, and `pageUserText` equals `ownerPrompt` after the documented CRLF→LF normalization (`adapter:442-443`) | `owner-attested` |
| D | none of the above | **refuse** `PREFIX_PROMPT_UNVERIFIED` |

Digest rule, stated so it cannot be bent: the digest is computed over the **exact string** with `sha256(…, 'utf8')`, the same call the service uses (`conversation-service.mjs:410`). If the original prompt contained CRLF, `sha256(LF-normalized page text)` will not match, and only tier C can succeed. Text is never trimmed, case-folded, or whitespace-collapsed for the digest comparison.

**Named scenarios:** `O-kv-present`, `O-kv-tmp-only` (→ tier B/C), `O-kv-mismatch` (→ refuse), `O-session-recording` (→ refuse), `O-session-stopfailed` (terminal-incomplete → tier A unavailable, `captureCorroboration: 'terminal-incomplete'`), `O-source-owned-by-live-pid` (read-only disk access only), `O-already-adopted` (→ idempotent read-only replay if the preimage matches this bind, else refuse).

---

## 6. Page evidence

One `transcriptExpression` read plus one repeat read, using the existing bounded shaper (`conversation-thread.mjs:77-113`, `boundTranscript` `:119-159`). No second reader, no second CDP client, no Playwright/Puppeteer.

| # | Check | Refusal code |
|---|---|---|
| P1 | Read succeeds and validates (`messages` array, `draft` shape, `controls` shape) | `PREFIX_PAGE_UNREADABLE` |
| P2 | `renderedTotal === 2 && messages.length === 2 && coverage.omittedMessages === 0` (exact shape; no hidden/nested/ambiguous skips) | `PREFIX_PAGE_SHAPE_MISMATCH` |
| P3 | `coverage.olderHistory === 'top-reached'` (a fresh two-message thread can prove no older history) | `PREFIX_PAGE_HISTORY_INCOMPLETE` |
| P4 | `messages[0].role === 'user'`, `index === 0`, native `id` present (`idSource === 'data-message-id'`) | `PREFIX_USER_TURN_MISSING`, `PREFIX_USER_TURN_ID_MISSING` |
| P5 | `messages[1].role === 'assistant'`, native `id` present, non-empty text | `PREFIX_REPLY_MISSING` |
| P6 | `sha256(messages[0].text)` matches the resolved prompt digest | `PREFIX_PAGE_TEXT_MISMATCH` |
| P7 | `controls.observed === true && controls.state === 'idle' && controls.idleControlPresent === true && controls.stopPresent === false && controls.composerEnabled === true` — **positive idle**, never "no spinner found" | `PREFIX_CONTROLS_NOT_IDLE` |
| P8 | Same read: `draft.present === false && draft.chars === 0` | `PREFIX_DRAFT_PRESENT` |
| P9 | Repeat read after the stability window (≥ 1500 ms, ≤ 5000 ms) yields identical assistant id, digest, and char count | `PREFIX_REPLY_UNSTABLE` |
| P10 | Thread ref not present in any existing snapshot's `threadDenylist` | `PREFIX_THREAD_DENYLISTED` |
| P11 | No other conversation on disk has `binding.thread.ref === thread.ref` (except the source conversation, which is thread-less anyway) | `PREFIX_THREAD_BOUND_ELSEWHERE` |

P7 and P8 are read from the **same** evaluation as the messages, so idle and empty composer describe the same instant as the reply text.

**Named scenarios:** `P-spinner` (stop control present → refuse), `P-no-id` (ChatGPT surface without `data-message-id` → refuse; see §14), `P-streaming-tail` (text still growing → unstable), `P-draft-left` (user typed something → refuse), `P-history-scrolled` (two messages but older history possible → refuse), `P-assistant-edited` (digest differs on repeat → refuse), `P-second-tab` (denylisted/bound elsewhere → refuse).

**Negative invariants**
- N4: "No error banner" or "no spinner" is never accepted as completion.
- N5: A truncated message (`truncated: true`) can never satisfy P6/P9 — the prefix needs the full text, and `perMessageCap` must exceed the observed char count or the read is re-run with a larger cap.
- N6: Page text is evidence of the page, never of the network or of who sent the message.

---

## 7. Recorded unknowns

The prefix record MUST contain, verbatim:

```json
{ "sendActor": "unknown", "dispatch": "unknown", "account": "unknown", "arrival": "page-observed" }
```

- `sendActor` may never be `studio`, `user`, or any other value in this release. The schema rejects everything except `"unknown"`; a mutation test asserts this (§14.5).
- `account` is **not** inferred. No profile name, email, avatar, workspace label, or account menu is read, even if visible. Reading it would create an identity claim this codebase cannot validate, and would put personal identifiers into product data.
- The document, the API response, and the UI label must all say *observed on the page at bind time*, never *sent by Studio*.
- Consequence: turn 1 is excluded from any acceptance metric that requires a journal delivery. `view().turn` remains `null` for the adopted conversation until turn 2 is admitted; the prefix is a separate `prefix` object.

---

## 8. Fail-closed rule and refusal codes

**Rule:** any missing, unreadable, inconsistent, ambiguous, contradictory, or timed-out read means **no bind, no prefix, no send**. There is no partial adoption: the prefix record is written either complete or not at all. The bind holds no browser-effect lease beyond a short writer window and performs no effect, so a refusal costs nothing and leaves the live page untouched.

Refusal codes (all match `/^[A-Z][A-Z0-9_]{0,79}$/`, the code shape already validated at `conversation-service.mjs:282,382,578`):

| Group | Codes |
|---|---|
| Target | `PREFIX_TARGET_NOT_FOUND`, `PREFIX_TARGET_NOT_PAGE`, `PREFIX_TARGET_ORIGIN_MISMATCH`, `PREFIX_TARGET_URL_UNSUPPORTED`, `PREFIX_TARGET_AMBIGUOUS`, `PREFIX_TARGET_CHANGED`, `PREFIX_PAGE_THREAD_MISMATCH`, `PREFIX_THREAD_ID_MISMATCH` |
| Source | `PREFIX_SOURCE_MISSING`, `PREFIX_SOURCE_CORRUPT`, `PREFIX_SOURCE_ATTEMPT_MISSING`, `PREFIX_SOURCE_ATTEMPT_NOT_CREATION`, `PREFIX_SOURCE_ATTEMPTS_AMBIGUOUS`, `PREFIX_SOURCE_DIGEST_INVALID`, `PREFIX_SOURCE_KV_MISMATCH`, `PREFIX_SOURCE_STATE_UNEXPECTED`, `PREFIX_SOURCE_ALREADY_ADOPTED` |
| Session | `PREFIX_SESSION_OWNER_MISMATCH`, `PREFIX_SESSION_STILL_RECORDING`, `PREFIX_SESSION_METADATA_INVALID` |
| Page | `PREFIX_PAGE_UNREADABLE`, `PREFIX_PAGE_SHAPE_MISMATCH`, `PREFIX_PAGE_HISTORY_INCOMPLETE`, `PREFIX_USER_TURN_MISSING`, `PREFIX_USER_TURN_ID_MISSING`, `PREFIX_REPLY_MISSING`, `PREFIX_PAGE_TEXT_MISMATCH`, `PREFIX_PROMPT_UNVERIFIED`, `PREFIX_CONTROLS_NOT_IDLE`, `PREFIX_DRAFT_PRESENT`, `PREFIX_REPLY_UNSTABLE`, `PREFIX_THREAD_DENYLISTED`, `PREFIX_THREAD_BOUND_ELSEWHERE` |
| Lifecycle | `PREFIX_WRITER_BUSY`, `PREFIX_IDEMPOTENCY_CONFLICT`, `PREFIX_PENDING_UNRESOLVED`, `PREFIX_NOT_ACTIVE`, `PREFIX_INVALIDATED`, `PREFIX_CORRUPT_OR_UNREADABLE_SNAPSHOT`, `PREFIX_PERSISTENCE_FAILED_REOPEN_REQUIRED` |
| Continuation | `PREFIX_AUDIT_REQUIRED`, `PREFIX_AUDIT_FAILED`, `PREFIX_REPLY_CHANGED`, `PREFIX_USER_MESSAGE_MISSING` |

On refusal: no new conversation file is created, no existing file is modified, the original snapshot and session are untouched, and the error body carries only the code plus the target/thread refs already supplied by the caller.

**Negative invariants**
- N7: A timeout anywhere in the sequence is a refusal, never a retry and never a partial record.
- N8: An exception whose `code` is not a known refusal code becomes `PREFIX_*` generic refusal, not a success path.
- N9: Refusal never writes a journal file, a journal turn, or a delivery event.

---

## 9. Capture semantics

The bind reads capture state; it never stops, starts, or finalizes a recorder.

| Observed session state | Meaning | Bind decision | Recorded |
|---|---|---|---|
| `recording` / `stopping` | A live recorder still owns the target (`recorder.mjs:108-111`; attach would fail `TARGET_RECORDER_BUSY`, `adapter:249`) | **Refuse** `PREFIX_SESSION_STILL_RECORDING` | nothing |
| `complete` / `complete_with_integrity_warnings` | Settled; `endReason`, `integrity` present (`recorder.mjs:807-811`) | Allow; KV may corroborate (tier A) | `capture: { sessionId, status, endReason, integrityOk, corroboration: 'terminal-complete' }` |
| `incomplete` with `endReason` (e.g. `stop_failed:*`, `recorder.mjs:765-769`) | Settled but not a clean capture | Allow with downgrade: tier A unavailable; page digest must stand alone (tier B/C) | `corroboration: 'terminal-incomplete'` |
| `recording` but owner PID dead (crash remnant) | Not settled, and cannot be settled by this spec | **Refuse** `PREFIX_SESSION_STILL_RECORDING`; resolving it is a separate, explicitly authorized operation | nothing |

### 9.1 Why stopped-session KV / raw / `DOM_TURNS` cannot become journal delivery evidence

This is a structural impossibility, not a policy preference:

1. `observeDelivery` requires a turn in phase `typing` or `dispatching` with a non-null boundary (`thread-turn-journal.mjs:308-319`; `validTurn` requires a boundary for `delivered` at `:137`). A turn reserved by `reserve()` always starts `boundary: null, phase: 'preparing'` (`:262-265`), and `markTyping` requires the caller to have been admitted by *this* client (`:273`, `:244`). A late, after-the-fact reservation can therefore never carry a pre-typing boundary.
2. The evidence must be attributable to the attempt: `attributed()` ties `turnId`, `payloadDigest`, `sessionId` and `boundary.sequence` together (`thread-turn-journal.mjs:73-79`). The stopped session's records belong to a **different** session id than any new conversation's `snapshot.sessionId`, and the service additionally requires `e.sessionId === snapshot.sessionId` (`conversation-service.mjs:158`).
3. `DOM_TURNS` is a KV snapshot of the rendered transcript (`conversation-evidence.mjs:122`), not an admitted per-turn record: it has no journal turn id, no delivery identity, and no sequence relation to a reservation.
4. The raw segment sequence of the old session cannot be re-based into a new recorder session; sequence numbers are per-session (`adapter:383`, `:414`) and are compared with `e.sequence > a.boundary.sequence` (`conversation-service.mjs:159`).
5. Writing a synthetic `delivered` turn would require forging a boundary and a delivery identity. That is fabricating journal evidence, which the whole design exists to prevent.

**Negative invariants**
- N10: No prefix may reference a `sequence`, `sessionId`, or `delivery.identity` as if it were a journal delivery.
- N11: The KV record's `samples` and `raw` are never replayed as send evidence.
- N12: A still-recording session is never stopped, truncated, or "finalized" by this capability.

---

## 10. Durability, ordering, exactly-once

### 10.1 Where the prefix lives

Additive, top-level `prefix` object in the **new** conversation snapshot (`<root>/conversations/<newId>.conversation.json`), validated by an extended `validSnapshot` (today `conversation-service.mjs:57-82` ignores unknown top-level keys, so absence of extension would silently trust a corrupt prefix — the extension is mandatory, not optional).

```json
{
  "kind": "observed-prefix",
  "schema": 1,
  "state": "pending | active | invalidated",
  "prefixId": "<sha256 hex>",
  "source": { "conversationId": "...", "attemptId": "...", "sessionId": "...", "phase": "uncertain", "journalless": true },
  "thread": { "kind": "chatgpt-c", "id": "...", "ref": "chatgpt-c:..." },
  "target": { "targetId": "...", "origin": "https://chatgpt.com" },
  "prompt": { "digest": "<64 hex>", "chars": 0, "source": "capture-kv|page+snapshot-digest|owner-attested" },
  "userMessage": { "id": "<native>", "index": 0, "digest": "<64 hex>", "chars": 0 },
  "assistant": { "id": "<native>", "index": 1, "digest": "<64 hex>", "chars": 0, "completion": "observed-complete" },
  "sendActor": "unknown", "dispatch": "unknown", "account": "unknown", "arrival": "page-observed",
  "capture": { "sessionId": "...", "status": "...", "endReason": "...", "integrityOk": true, "corroboration": "terminal-complete|terminal-incomplete" },
  "reads": [ { "at": "...", "assistantDigest": "...", "controls": "idle" } ],
  "preimageDigest": "<64 hex>",
  "observedAt": "...", "adoptedAt": "..."
}
```

No prompt body, no reply body, no raw records, no token, no account string.

### 10.2 Write protocol

`serial()` (already `conversation-service.mjs:130`) plus the existing `save()` discipline (`:133-151`: `openSync(tmp,'wx',0o600)`, write, `fsync`, `rename`, `fsync` final file).

1. Acquire the short writer window (`runtime.writerWindow`, `conversation-runtime.mjs:253-276`). `enter() === false` → `PREFIX_WRITER_BUSY`. Bind has no browser effect, so the window is held only for the read+write sequence.
2. Run T1–T8, O1–O12, P1–P11 **before** writing anything.
3. Create the new conversation snapshot with `prefix.state = 'pending'` and the complete preimage. Nothing in the snapshot is sendable in this state.
4. Re-read the two page reads' digests and compare with the pending preimage. Any drift → `PREFIX_INVALIDATED` and the snapshot is left `pending` + `invalidated` (never `active`).
5. Flip `prefix.state = 'active'`, add `adoptedAt`, re-save. Only now may turns 2–3 be submitted.
6. Release the writer window.

### 10.3 Crash points

| Crash after | On reentry |
|---|---|
| step 2 (no write) | Nothing exists; a new bind creates a fresh id; no effect occurred |
| `pending` write, before page re-read | `pending` + matching preimage → re-verify and continue; preimage mismatch → `PREFIX_PENDING_UNRESOLVED` (manual audit, never auto-activate) |
| page re-read, before `active` | Same as above |
| `active` write, before response | Re-entry with the same request returns the record read-only (idempotent), like `conversation-service.mjs:411-413` |
| during turn 2 (existing path) | Unchanged: the journal fences; the turn is `unknown`, never resent |

**Negative invariants**
- N13: `pending` is never sendable, and is never promoted without a fresh page re-read inside the same call.
- N14: A prefix write failure poisons persistence exactly like any other save (`:144-146`); no further send is admitted until reopen.
- N15: Adoption is effect-free; a crash during adoption can never have sent anything.

### 10.4 Idempotency, concurrency, exactly-once

- `prefixId = sha256(source.conversationId + ':' + attemptId + ':' + thread.ref + ':' + prompt.digest)`.
- Same `prefixId` + identical preimage → return the existing record read-only, change nothing (no second conversation file, no duplicate effect).
- Same `prefixId`, different preimage → `PREFIX_IDEMPOTENCY_CONFLICT`.
- Different source attempt for the same thread → `PREFIX_THREAD_BOUND_ELSEWHERE` if a prefix already binds that thread.
- Two concurrent binds: serialized by the writer window. The loser gets `PREFIX_WRITER_BUSY`, never a second snapshot.
- Turns 2–3 keep the existing exactly-once machinery: `reserve()` idempotency by key+digest (`thread-turn-journal.mjs:251-259`), `THREAD_FENCED` on unresolved turns (`:260`), `assertEffectAllowed` immediately before each effect (`:242-250`), and the service's fail-closed checks (`conversation-service.mjs:444-448`).
- **No continuation before every check passes:** `prefix.state === 'active'`, the prefix audit passes (§11.2), and the journal fence is clear.

---

## 11. Journal, continuation, and the connect guard

### 11.1 Turn 1: journal untouched

The bind MUST NOT call `reserve`, `markTyping`, `markDispatching`, `observeDelivery`, `provePreEffect`, `markUnknown`, `recordReply`, `recordReadiness`, or `recordCompletion`. The thread journal file must be **byte-identical** before and after adoption (asserted by hash in the test). Turn 1 is not a journal turn, is not fenced by the journal, and can never appear as `delivered`.

### 11.2 Turns 2–3: the only journal deliveries

Each continuation is an ordinary `submit` on the bound conversation (service `:406-537`). Two additions:

1. **Adapter prefix audit.** `preflight(binding, { priorTurns, prefix })` gains an optional `prefix` descriptor `{ userMessageId, userMessageDigest, assistantMessageId, assistantDigest, assistantChars }`, evaluated inside the **same** `pageState()` read (no second read). It returns `prefixAudit: { ok, reason }`. The service requires `prefixAudit.ok === true` whenever `snapshot.prefix` is set; missing audit → `PREFIX_AUDIT_REQUIRED`; failed audit → `PREFIX_AUDIT_FAILED` with the specific reason (`PREFIX_REPLY_CHANGED`, `PREFIX_USER_MESSAGE_MISSING`). This mirrors the existing prior-turn checks (`adapter:398-413`) without inventing a journal turn.
2. **Blocked pre-effect.** On audit failure the attempt is blocked via the existing `blockPreEffect()` (`conversation-service.mjs:189-193`) with `typing: 'not-executed', dispatch: 'not-executed'`. No type, no dispatch, no `unknown` turn. The prefix is marked `invalidated`; further submits refuse `PREFIX_INVALIDATED` until a human re-binds.

Only after both do turns 2–3 use `markTyping → markDispatching → observeDelivery`, and only those two turns can ever be called delivered.

### 11.3 The required narrow guard exception

`conversation-runtime.mjs:399-404` refuses attaching the thread while the original journal-less attempt exists. Adoption must not delete, rewrite, or journalize that attempt (source evidence is immutable). Therefore:

- `connect()` gains an explicit `prefixSource: { conversationId, attemptId, payloadDigest }` request field. There is **no** implicit or ambient adoption.
- The exception applies only when **all** hold: (a) `prefixSource` is present; (b) the referenced snapshot parses and its single attempt matches `attemptId`/`payloadDigest`; (c) that attempt is journal-less, `phase === 'uncertain'`, `creation === true`; (d) a `pending` prefix record already exists on disk whose `source` names exactly that conversation+attempt and whose `thread.ref` equals the requested thread; (e) the requested target is the same origin.
- When it applies, only the adopted conversation id may bind that thread. Every other conversation on the origin still gets `LEGACY_ATTEMPT_REQUIRES_RECONCILIATION` (`:403`) — the refusal set shrinks by exactly one (conversation, thread) pair, never by "any thread on this origin".
- The original snapshot is never modified. The guard's evidence stays on disk forever, so the exception remains auditable.

Without this exception, adoption cannot reach a live bind at all; the capability would be dead code. With it, the change is one predicate, one request field, and a documented reason.

---

## 12. Authorization boundary

The owner's authorization is **exactly**: three named prompts, submitted once each, in one new thread, with turn 1 already submitted. It does **not** cover, and this spec does **not** request:

- restarting or shutting down Studio PID 8616, or Chrome PID 18216;
- stopping, finalizing, or clearing the live capture session;
- clearing `C:\VIVIM\chrome-profile`, cookies, or account state;
- sending turn 1 again (a resend is forbidden regardless of authorization, because the effect outcome is uncertain);
- editing, deleting, migrating, or "repairing" the original conversation snapshot or its session;
- launching a second browser, second CDP client, or second Studio server;
- any provider-side action beyond turns 2–3 once separately approved.

**Live application requires a separate, explicit approval** given after fixture proof, naming at minimum: the target id, the thread ref, the exact turn-1 prompt, the exact write set (new conversation file only), and an acknowledgement that the original snapshot and session remain untouched. If the live recorder is still `recording`, the live application is impossible under this authorization and must be refused, not attempted with a workaround.

---

## 13. Validation plan

**Base:** current `main` only (`10a60ef`), no branches, no new dependencies, Node 22, `node:test`. **Fixture data only** (temporary directories, fake adapters/targets exactly as `test/unit/conversation-create.test.mjs` already does). No live page, no provider, no CDP.

### 13.1 Intended source paths

| Path | Change |
|---|---|
| `src/capture/conversation-prefix.mjs` (new) | Pure helpers: refusal codes, `prefixId`/`preimageDigest`, prompt tier resolution, page-evidence predicate, prefix record validation |
| `src/capture/conversation-service.mjs` | Additive `prefix` field + validation in `validSnapshot`; `adoptPrefix` (write protocol); require `prefixAudit` in `submit`; expose `prefix` in `view()` with text stripped |
| `src/capture/conversation-browser-adapter.mjs` | `readPrefixEvidence()` (read-only, two reads); `prefixAudit` inside `preflight` |
| `src/capture/conversation-runtime.mjs` | `bindObservedPrefix()`; narrow `connect` guard exception (§11.3); expose `prefix` in `view()` |
| `src/studio/conversation-api.mjs` | `POST /api/v1/conversations/prefix` |

### 13.2 Focused tests, RED first

| Test file | Asserts (must fail on current `main`) |
|---|---|
| `test/unit/conversation-prefix-bind.test.mjs` | Happy path tier A; exactly 2 messages; positive idle; empty composer; `sendActor/account/dispatch === 'unknown'`; journal file hash unchanged |
| `test/unit/conversation-prefix-fallback.test.mjs` | Tier B (no KV), tier C (owner-attested), tier D refusal; `.tmp`-only KV is not evidence; CRLF prompt refuses tier B |
| `test/unit/conversation-prefix-negative.test.mjs` | Every refusal code in §8 reachable by a minimal fixture; a refusal writes nothing |
| `test/unit/conversation-prefix-continuation.test.mjs` | Turns 2–3 submit on the bound thread; prefix audit failure blocks pre-effect; `PREFIX_AUDIT_REQUIRED` when an adapter omits the audit; prefix never appears as a delivered turn |
| `test/unit/conversation-prefix-crash.test.mjs` | Pending→active crash points; idempotent replay; concurrent bind yields one snapshot; `pending` is not sendable |
| `test/unit/conversation-runtime.test.mjs` (extend) | Guard exception applies only with a matching `pending` prefix; every other conversation on the origin still gets `LEGACY_ATTEMPT_REQUIRES_RECONCILIATION` |

Each test starts RED (module/route absent), then GREEN with the smallest change.

### 13.3 Full gate

`node scripts/gate.mjs` on Windows: `architecture` (`scripts/architecture-inventory.mjs --check`), `parity` (`platform-parity` + `platform-boundary`), `smoke`, then the full `test/unit/**` suite (`scripts/gate.mjs:10-15`). Run after updating `architecture/components.json` if a new module is added. **Linux is not tested in this session**; no parity claim may be made.

### 13.4 Adversarial / mutation checks

| Mutation | Required outcome |
|---|---|
| Flip `sendActor` to `"studio"` in a fixture snapshot | Load refuses (`PREFIX_CORRUPT_OR_UNREADABLE_SNAPSHOT`), because the schema admits only `"unknown"` |
| Change assistant text after adoption | Turn 2 blocked pre-effect, prefix `invalidated`, no dispatch |
| Change user turn text/digest | Same, with `PREFIX_USER_MESSAGE_MISSING` / `PREFIX_PAGE_TEXT_MISMATCH` |
| Delete the user turn from the page | `PREFIX_AUDIT_FAILED`, no send |
| Add a second open tab on the same thread | `PREFIX_TARGET_AMBIGUOUS` |
| Hand-insert a journal turn for the prefix | Journal validation rejects (`delivered` without boundary, `thread-turn-journal.mjs:128,137`) — test documents why the shortcut is impossible |
| Re-run bind with a different prompt digest | `PREFIX_IDEMPOTENCY_CONFLICT` |
| Re-run bind concurrently | One snapshot, second call read-only |
| Kill between `pending` and `active` | Re-entry verifies or refuses; never sends |
| Point at the original conversation id | Refused: source is read-only; adoption always creates a new conversation |

---

## 14. Feasibility honesty

### 14.1 Depends on evidence that may not exist

- **H1 (KV prompt).** The KV write is atomic-by-rename but **not fsynced** (`session.mjs:24-28`). If the pilot's crash timing left only `CONVERSATION_ATTEMPT_<id>.json.*.tmp`, tier A is gone and tier B/C must carry the proof. If PID 8616 is still alive, the KV may also still be unflushed to the OS cache — reading it from another process is a best-effort read of a live file.
- **Session settlement.** If the creation session is still `recording` (or crashed while recording with a dead owner), the target has an active recorder and **nothing** can bind today (`adapter:249`, `recorder:108-111`). Resolving that requires an operation this spec explicitly does not authorize.
- **Native message ids.** `boundTranscript` only accepts ids from `data-message-id` (`conversation-thread.mjs:127-128`). If the live ChatGPT surface renders turn 1 without that attribute, P4/P5 fail, and **no prefix can be recorded**. The only remaining honest option — a brand-new thread — is outside the current authorization.
- **Page accessibility.** A hung CDP target (the same condition that produced the original 30 s timeout) yields `PREFIX_PAGE_UNREADABLE`. The adoption cannot be performed by a runtime whose reads time out.

### 14.2 What remains impossible without that evidence

- An **attributable** turn 1: there is no configuration in which Studio may claim it dispatched turn 1. Without page ids, no prefix at all.
- A **journal** turn 1: structurally impossible (§9.1), regardless of evidence quality.
- **Retroactive capture** of turn 1's network stream: the raw data (if any) belongs to the old session; sequence numbers do not transfer (`adapter:383,414`), and the old session cannot be made a delivery source.
- **Resending** turn 1 to "make it clean": forbidden by the no-resend rule (`AGENTS.md:13,15`) and by `validSnapshot`'s single-observed-send guard (`conversation-service.mjs:76`).

### 14.3 What is fully feasible today

The target/origin/thread proof, the prompt digest comparison, the page-shape/idle/composer checks, the prefix record, the journal-untouched guarantee, the idempotent crash-safe write, and turns 2–3 over the existing submit path — all of these use mechanisms already present and tested at `10a60ef`. The uncertainty is concentrated in §14.1, not in the design.

---

## 15. Consolidated negative invariants

- N1–N3: exact-target proof (§4) — no inference from "only tab", title, heading, or single read.
- N4–N6: page evidence (§6) — no negative-idle proof, no truncated text, no page-as-sender claim.
- N7–N9: fail-closed (§8) — timeout is refusal, unknown code is refusal, refusal writes nothing.
- N10–N12: capture semantics (§9) — no journal-shaped reuse of stopped-session data, no replay, no stopping a live recorder.
- N13–N15: durability (§10) — `pending` is not sendable, poisoned persistence stops everything, adoption is effect-free.
- N16: the original snapshot, its attempt, and its session are never modified by adoption.
- N17: the thread's journal is byte-identical across adoption.
- N18: turn 1 is never sent again by any path in this capability.
- N19: exactly one conversation may hold the adopted prefix for a given thread ref.
- N20: no second browser actor, no second CDP client, no second store; the prefix is metadata in the existing snapshot.

---

## 16. Approval request

This document proposes the capability above. It does **not** claim approval, implementation, or any live verification.

**Requested decision — one of:**

1. **Approve fixture implementation only** (recommended reading): implement §13 against disposable fixtures on `main`, run the focused RED→GREEN tests and the full Windows gate, and return with measured results. No live page, no provider, no change under `C:\VIVIM`.
2. **Approve fixture implementation + a separate live-application proposal**, where the live step still requires its own follow-up approval naming target id, thread ref, prompt, and write set, and is refused outright if the original recorder is still `recording`.
3. **Reject / defer**: keep turn 1 as unrecorded and do not attempt continuation on that thread.

**Not covered by any option above, and still requiring explicit separate authorization:** restarting Studio or Chrome, stopping the live capture session, clearing the profile, resending turn 1, or modifying the original conversation snapshot or session.

**Decision state: UNAPPROVED.**
