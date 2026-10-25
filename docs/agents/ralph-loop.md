# Ralph loop (integration coordinator)

One task per iteration. State lives in files, not in anyone's memory. A fresh session can resume from these files alone.

## State files (the only memory)
- `docs/track/queue.md` - ordered work queue. The top `READY` item is the next iteration.
- `docs/INTEGRATION-PROGRESS.md` - milestone ledger, kept by the free progress keeper.
- `docs/track/worklog.yaml`, `crosswalk.yaml`, `atlas.yaml` - static status trackers, not live proof.

## Iteration
1. **Read** the state files, `git status --short --branch`, and the running-lane list. Do not start work that overlaps a running lane's write scope.
2. **Pick** the top `READY` queue item whose dependencies are done. If the queue has fewer than 2 READY items, refill it from the atlas top-10 and the worklog gaps before dispatching.
3. **Dispatch** one lane (backend/UI/search owners on Grok medium; reviews, trackers and git on free DeepSeek). The prompt states scope, files, tests to write first, and what not to touch. No Sol high.
4. **Wait** for the completion notification. Do not poll.
5. **Verify** independently: rerun the focused tests myself, `git diff --check`, `scripts/architecture-inventory.mjs --check`. A subagent summary is a claim, not evidence.
6. **Review** the diff with a free read-only reviewer for non-trivial changes. Verified defects go back to the owning session, tests first.
7. **Record**: move the item to `DONE` with the evidence tier (fixture / source-only, never live), and send a one-line milestone to the progress keeper.
8. **Commit and push every cycle** (owner directive: remote council steers frequently). Green -> normal commit; red/unverified -> `wip:` commit, still pushed, failures listed in the body. Never wait for perfection to push.
   Dispatch: dispatch `git-manager` with explicit paths. Standing owner push authorization (2026-10-25): git-manager commits and pushes green increments to origin on the current branch with plain `git push`; never force. It stops and reports on rejection, secrets in the diff, or any red gate.
9. **Loop** to step 1.

## Stop conditions (the loop pauses and asks the owner)
- Same lane fails verification twice on the same defect: escalate to a different model or oracle, do not loop a third time.
- A change would need a live provider, a browser, Playwright/Puppeteer, or runtime cutover.
- A decision that is the owner's: identity merge rules, custody semantics, what to build vs harvest.
- Anything touching credentials, private captures, or force-push.
- Tests red at the start of an iteration that the previous iteration did not cause.

## Deferred (not in the loop)
Formal acceptance (next week), security program (two weeks), live browser/provider work, cutover.

## Rules that never relax
- Imported content is never labelled observed. sha256 is integrity, not identity. Account stays `unknown`.
- Free models are not unlimited: cap each lane at about two self-correction rounds.
- Keep `PROMPT.md`, `clone-tmp/` and the model resource map out of commits.
