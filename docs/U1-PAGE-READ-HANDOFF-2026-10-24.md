# U1 real page-read bridge — remote implementation handoff

**Branch:** `feature/u1-real-read-evidence-20261024`
**Base:** `c3e3e2dae769bdaf7f12f2b22fd0360fb2b1b594` (merged PRs #80/#82)
**Scope:** Existing `/chat` only. No backend, actor, sender, adapter registry, store, or production data migration.

## What changed

- `src/studio/ui/chat.mjs`: on the existing zero-send `POST /api/v1/conversations/{id}/read` success path, preserve the thread reference observed with the validated read; pass the in-memory read to the already mounted U1 panel. No extra network call, page read, effect, or browser operation.
- `src/studio/ui/universal-chat.mjs`: add `projectObservedPageRead(snapshot, pageRead)`, checking exact local conversation ID and captured thread binding. Present only role-tagged, bounded page text (200 messages / 200,000 characters) with explicit coverage notes. The panel clearly states **page observation, not native message ID, account index, verified source SID/seq, accepted capture, or goal outcome**. Content is always rendered as literal text nodes. U1's native-event store and DOM cache are reset when the conversation ID, bound thread, or browser attachment changes, preventing a prior conversation's blocks from appearing under reused turn IDs.
- `test/unit/u1-page-read.test.mjs`: twelve adversarial tests for wrong conversation/thread, missing identity, invalid read/sequence, injected role, unverified thread, DOM escaping, stale panel clearing, native-block scope isolation and memory bounds.

## Verification / evidence limits

- The twelve committed unit cases were executed against the exact fetched GitHub source using a V8 in-memory source-level harness: **12 passed, 0 failed**. The committed client files were also syntax-checked with V8: **2/2 parsed**.
- **NOT RUN:** actual Node 22/24 `node --test`, full Studio suite, Windows, live browser, saved-session L2 replay, visual navigation, or any provider sends. Remote container has no network route to GitHub, so the actual GitHub checkout could not be cloned into Node here.
- On the owner's Windows checkout, run:
  ```powershell
  # From the existing canonical Capture Studio directory:
  node --test test/unit/u1-page-read.test.mjs test/unit/universal-chat.test.mjs
  bun run test
  ```
- After merging the feature PR into a **separate owner review worktree**, open existing `/chat`, connect only to an owner-authorized local test target, use its existing **Read what's on the page** action, and inspect the additive U1 panel. Verify the text, partial coverage, and no send side effects. Switch conversations and ensure old text vanishes. Do not run fresh provider sends.

## Known limitations / follow-on

1. This is a **page-text read** bridge, not a native rich-block event feed. Native IDs and grounded capture provenance still require server-owned original source records. Do not generate native IDs from page positions or text hashes.
2. Read coverage may omit unloaded history, may be truncated, and is not account-wide. The original `readView` is the authority for the existing page read and its same-conversation/thread validation; the new U1 guard adds a second scope check.
3. Account state remains unknown unless an authoritative producer reports it. The UI does not invent account membership or native evidence.
4. Continue QA #72 L2 read-only saved-session differential replay and L3/L4 recovery/learning validation; reconcile PR #78 only after matching its trusted-source contracts to the merged one-owner CAS.

## Integration ownership

- Remote feature PR is **draft** and must be reviewed/tested on the owner's Windows machine before merging.
- No local activation or changes to `main` were performed in this remote round.
