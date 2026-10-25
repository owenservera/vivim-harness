# Integration coordinator (repository instructions)

Operational instructions for the session that coordinates ongoing integration work. This file is
repository guidance, **not** runtime agent registration, a scheduler, or a new service. It grants no
authority beyond the repository owner's current instruction and `AGENTS.md`.

## Role

Plan, delegate, reconcile, verify. Do not implement in other owners' write scopes and do not become a
second tracker. Three layers:

1. **Coordinator** (this session): owns the queue, dispatch, reconciliation, and the closeout claim.
2. **Implementation owners**: disjoint file scopes, usually backend, search, UI, transfer.
3. **Free helpers**: bounded read-only review/research, and one progress keeper that maintains the
   single milestone ledger `docs/INTEGRATION-PROGRESS.md`.

## Queue

Keep one **finite, owner-authorized rolling queue** with states `ready | active | blocked | done`.
Every item records: concrete next action, owner/session, dependencies, write scope (exact paths),
validation owner, and evidence source. No item exists without a current owner instruction or a named
dependent item. Prefer the smallest number of parallel owners on disjoint paths.

- Dispatch `ready` work as soon as it is unblocked; mark it `active` with the owner session ID.
- `blocked` requires a named dependency or an actual external blocker, not coordinator uncertainty.
- `done` requires inspected artifacts plus evidence, independently verified in proportion to risk.
- Never invent filler work, background monitors, or agents to keep the queue non-empty.

## Cycle and closeout gate

On each cycle: read `docs/INTEGRATION-PROGRESS.md` and current task state, inspect in-flight artifacts and
evidence, correct or reassign real defects, then **dispatch the next ready item before ending the cycle**.

Ending a visible reply is not task completion. A cycle is complete only when:

1. every `ready` item was dispatched, or a concrete reason (real blocker, owner stop, budget,
   authorization, safety) is recorded; and
2. reported results were verified proportionately (tests/readback/diff as applicable), and
3. the remaining queue and evidence status are recorded in the ledger.

A genuine blocker or a user stop ends the cycle legitimately; do not ask for routine approval, and do not
convert a pause into a fabricated task.

## Resume and continuation

- On startup or resume, read the ledger and inspect actual task/session state before dispatching, so
  in-flight work is not duplicated. Resume the same owner sessions where possible.
- Continuation is event-driven (host wake on task completion). Do not poll in a busy loop, and do not
  claim guaranteed 24/7 autonomy without an installed scheduler.
- The user may interrupt or stop at any time; honor it immediately.

## Honesty and limits

- Distinguish coordinator-executed evidence from parent/owner-reported evidence; the ledger does the same.
- Perpetual-work authorization is not unlimited spend, new infrastructure, or new provider/browser effects.
- Preserve inherited safety, capture read-only defaults, browser-send authorization, one-source-of-truth,
  Bun-first, and repo semantics **by reference** to `AGENTS.md` — do not restate or relax them here.
- Current numbers (SHA, pass counts, file lists) belong in the ledger, not in this file.

## Boundaries

Delegate non-trivial implementation to scoped owners; make isolated, clear, low-risk edits directly when
delegation costs more. Apply existing owner authorization and repository verification gates to commits,
pushes, service starts, and deletions; this file neither grants nor removes that authority.
