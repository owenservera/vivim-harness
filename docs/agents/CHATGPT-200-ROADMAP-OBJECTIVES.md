# VIVIM roadmap — 100 additional real-user scenarios (101–200)

Companion to [`CHATGPT-100-OBJECTIVES.md`](CHATGPT-100-OBJECTIVES.md). These are **100 distinct user outcomes**, not a scripted run, action replay or a claim that the capabilities already exist.

## Ground rules

- **One scenario per agent at a time.** Assess native CLI / existing Studio and local VIVIM World as a real user would. No scenario-specific scripts, Playwright, Puppeteer or second browser controller.
- **Starting surface:** ChatGPT is the initial live webapp. Cross-provider, non-chat and Android scenarios are explicit roadmap integration milestones; report `NOT_IMPLEMENTED`, `FEATURE_UNAVAILABLE` or `ENVIRONMENT_BLOCKED` truthfully.
- **Ownership:** Own = local intake, evidence and user-controlled data. Share = deliberate portable context and authorized handoff. Evolve = retrieval, relationships, adapters and improvements.
- Browser sends, uploads, shares, settings changes, deletion and device pairing need user-scoped authorization. Read-only outcomes cannot produce browser effects.
- Every result needs scenario ID, native command count (target ≤3), elapsed time when actually measured, observed effect, persisted evidence, recovery status and verification level. Do not mark source-reviewed as live-verified.
- This extends—not replaces—the original 001–100 ChatGPT-native surface probes; the objective here is the VIVIM product journey from provider interaction to local personal World.

## 11 — Local-first intake and completeness
*Pillar: Own*

**101 · Capture an already** Capture an already open ChatGPT thread into VIVIM without sending a new message, and receive a durable local record ID.
**102 · Import a user-selected** Import a user-selected old thread whose oldest turns are not currently rendered, reporting exactly what history was and was not observed.
**103 · Refresh a previously** Refresh a previously saved thread after a new native answer appears without duplicating its earlier turns.
**104 · Import two selected** Import two selected ChatGPT threads into one local workspace while keeping their native thread identities distinct.
**105 · Recognize and locally** Recognize and locally preserve a user-edited native answer as a new observed version rather than silently overwriting an older capture.
**106 · Capture an assistant's** Capture an assistant's answer while it is still streaming, then mark the eventual completed version separately.
**107 · Collect an existing** Collect an existing thread's visible attachments as references even when their bytes cannot be downloaded.
**108 · Save a selected** Save a selected rich answer as locally readable content with text and structured blocks, rather than as a screenshot.
**109 · Resume an interrupted** Resume an interrupted local capture from its persisted checkpoint without re-sending the user prompt.
**110 · Show a capture-completeness** Show a capture-completeness receipt listing observed turns, missing history, truncated blocks and refused artifacts.

## 12 — Source identity, provenance and temporal truth
*Pillar: Own*

**111 · Trace one locally** Trace one locally saved answer back to its exact ChatGPT source thread and native message ID when observable.
**112 · Distinguish content the** Distinguish content the provider rendered from a VIVIM-generated title, summary or annotation.
**113 · Reopen an imported** Reopen an imported record and see which bytes were captured raw, decoded from protocol or extracted from DOM.
**114 · Keep two same-text** Keep two same-text answers from different native threads separate instead of merging on content equality.
**115 · Identify that a** Identify that a ChatGPT link changed its visible label while its destination remained the same.
**116 · Compare two time-stamped** Compare two time-stamped observations of a thread and show what content appeared, disappeared or changed.
**117 · Explain why a** Explain why a native message cannot be uniquely identified when the page exposes no stable message ID.
**118 · Follow an answer's** Follow an answer's cited URL into a local source-reference record without treating that URL as proof the claim is true.
**119 · Detect a mismatched** Detect a mismatched source thread during recapture and refuse to append evidence to the wrong local record.
**120 · Display a provenance** Display a provenance chain for a saved answer, including site, session, capture timestamp, extraction method and known gaps.

## 13 — VIVIM World organization
*Pillar: Own*

**121 · Create a local** Create a local VIVIM Project that groups selected saved threads without creating or modifying a remote ChatGPT Project.
**122 · Move a locally** Move a locally saved thread between two VIVIM Projects while leaving its remote membership unchanged.
**123 · Attach a personal** Attach a personal note to one assistant message without modifying the source conversation.
**124 · Tag an answer** Tag an answer with a user-defined topic and find the tag on a later visit.
**125 · Pin a saved** Pin a saved passage as a project reference while the rest of the thread remains unchanged.
**126 · Relate a ChatGPT** Relate a ChatGPT answer to a separately saved article with a user-defined relationship label.
**127 · Split one captured** Split one captured thread into two local collections without changing the underlying message evidence.
**128 · Merge duplicate local** Merge duplicate local imports of the same canonical thread while preserving observation history.
**129 · Delete a derived** Delete a derived summary without deleting its underlying captured evidence.
**130 · Reopen a saved** Reopen a saved VIVIM Project offline and see the exact previously captured content without an active provider session.

## 14 — Retrieval and contextual discovery
*Pillar: Evolve*

**131 · Search local ChatGPT** Search local ChatGPT captures for an exact phrase and open the matching message, not just the containing thread.
**132 · Find a saved** Find a saved passage using a related concept that does not occur verbatim in its text.
**133 · Filter local results** Filter local results to one site, time interval and VIVIM Project simultaneously.
**134 · Search only user-written** Search only user-written messages, excluding assistant replies.
**135 · Search only answers** Search only answers containing code blocks of a specified language.
**136 · Find previously captured** Find previously captured tables by a column heading or cell value.
**137 · Locate a saved** Locate a saved answer by its cited source domain.
**138 · Show which of** Show which of two conflicting saved statements was observed later without treating recency as correctness.
**139 · Return search results** Return search results with source links and freshness/provenance labels rather than unsupported confidence claims.
**140 · Reopen a result** Reopen a result with sufficient surrounding thread context to understand the quoted passage.

## 15 — Deliberate sharing and context portability
*Pillar: Share*

**141 · Select a saved** Select a saved excerpt and prepare a portable context packet without submitting it to any provider.
**142 · Preview exactly which** Preview exactly which original text, references and personal notes a context packet includes.
**143 · Remove one sensitive** Remove one sensitive passage from an export preview without altering the underlying local record.
**144 · Export a chosen** Export a chosen conversation as machine-readable JSON with role boundaries and provenance.
**145 · Export a user-selected** Export a user-selected answer as readable Markdown while preserving code fences and outbound links.
**146 · Transfer a selected** Transfer a selected ChatGPT fact into a fresh provider draft only after the user approves the exact destination and content.
**147 · Carry a saved** Carry a saved table into an approved form field while retaining local evidence of the originating cells.
**148 · Show the difference** Show the difference between a packet staged locally and content that was actually sent to a website.
**149 · Revoke a locally** Revoke a locally issued VIVIM sharing grant and verify subsequent access is denied.
**150 · Reimport a VIVIM-exported** Reimport a VIVIM-exported packet on a different device without losing its canonical source IDs.

## 16 — Cross-webapp and adapter learning
*Pillar: Evolve*

**151 · Capture one equivalent** Capture one equivalent answer from ChatGPT and Claude as distinct provider observations in the same local project.
**152 · Compare responses from** Compare responses from two AI webapps without falsely claiming they used identical models or settings.
**153 · Resume an existing** Resume an existing ChatGPT conversation after inspecting a Gemini tab, without switching send targets.
**154 · Discover an unfamiliar** Discover an unfamiliar site's readable article content without treating it as an AI-chat message.
**155 · Read a table** Read a table from a non-chat webapp using the same typed-block representation as an imported ChatGPT table.
**156 · Detect that a** Detect that a ChatGPT composer selector no longer matches and report an adapter-drift reason.
**157 · Collect an opt-in** Collect an opt-in DOM evidence sample for a broken UI control without capturing unrelated secrets.
**158 · Propose a revised** Propose a revised site adapter from observed evidence, clearly marking it unverified until validated.
**159 · Compare a candidate** Compare a candidate adapter against held-out captures before enabling it.
**160 · Roll back an** Roll back an adapter update that misclassifies a message role while preserving already captured raw evidence.

## 17 — Agent-facing native UX and workflow economy
*Pillar: Evolve*

**161 · Ask the native** Ask the native CLI which actions are currently feasible for a selected conversation, including the reason for unavailable actions.
**162 · Complete read-only target** Complete read-only target discovery and thread selection in at most three CLI calls.
**163 · Capture a selected** Capture a selected existing conversation using one explicitly named CLI operation, without constructing a script.
**164 · Request a typed** Request a typed answer block through a single native command rather than manually navigating raw session files.
**165 · Inspect the progress** Inspect the progress of a long-running capture using its durable operation ID.
**166 · Recover a stored** Recover a stored operation after restarting the agent without inventing a replacement request key.
**167 · Receive the same** Receive the same structured tool schema through the CLI and the Studio integration endpoint.
**168 · Distinguish an unregistered** Distinguish an unregistered tool from a registered tool whose live browser prerequisite is unavailable.
**169 · Ask for command** Ask for command help that includes the next admissible user action after a failed prerequisite.
**170 · See a terse** See a terse capability-and-cost receipt covering native calls, browser effects, elapsed time and evidence status.

## 18 — Failure recovery and continuity
*Pillar: Own*

**171 · Recover an existing** Recover an existing conversation capture after Studio restarts while leaving the original ChatGPT tab untouched.
**172 · Report that a** Report that a selected target disappeared and identify whether the associated local capture is still readable.
**173 · Continue a local-only** Continue a local-only search during a browser or network outage.
**174 · Reconcile an uncertain** Reconcile an uncertain native send using the original durable key without submitting it again.
**175 · Recognize a partial** Recognize a partial assistant reply after a timeout and keep its completion status uncertain.
**176 · Distinguish a browser** Distinguish a browser reconnect from a user-initiated new conversation.
**177 · Refuse a send** Refuse a send when the native thread has changed between preview and effect dispatch.
**178 · Show that a** Show that a page reload invalidated an earlier DOM snapshot and request fresh observation.
**179 · Repair a corrupted** Repair a corrupted derived local index from intact raw capture rather than fetching the provider again.
**180 · Explain which parts** Explain which parts of a partially failed capture are safe to reuse and which require another observation.

## 19 — Privacy, consent and trustworthy local control
*Pillar: Own*

**181 · List what data** List what data classes a capture would read before starting, including prompts, replies, URLs and attachments.
**182 · Prevent a file** Prevent a file outside explicitly selected local intake roots from being attached or exported.
**183 · Create a redacted** Create a redacted export that omits detected credential-shaped strings but records that redaction occurred.
**184 · Show whether a** Show whether a saved artifact resides only on the local machine or has been sent externally.
**185 · Inspect a local** Inspect a local audit record of a browser-side mutation with time, target and operation identity.
**186 · Reject a cross-origin** Reject a cross-origin redirect during a ChatGPT-bound native send.
**187 · Keep private prompt** Keep private prompt and reply bodies out of default CLI diagnostics while allowing explicit local content readback.
**188 · Purge a selected** Purge a selected local derived cache and verify the authoritative raw capture remains available.
**189 · Delete a user-selected** Delete a user-selected local capture with clear distinction from remote provider deletion.
**190 · Demonstrate that a** Demonstrate that a read-only native tool never types, submits, uploads, navigates or changes provider settings.

## 20 — Windows-to-mobile and durable product experience
*Pillar: Share / Evolve*

**191 · Use the Windows** Use the Windows desktop harness to capture a ChatGPT thread and find that same saved record from the VIVIM local UI.
**192 · Open a local** Open a local World record on a paired Android PWA without requiring the original ChatGPT tab to stay open.
**193 · Send a user-selected** Send a user-selected text snippet from the Android PWA to the Windows intake queue without sending it to a provider.
**194 · Distinguish queued, received,** Distinguish queued, received, saved and failed states for a phone-to-Windows intake item.
**195 · Resume a phone** Resume a phone intake after a temporary Tailscale disconnect without creating duplicate local records.
**196 · Search previously captured** Search previously captured Windows records from the PWA and open a compact, source-attributed view.
**197 · Reject an unpaired** Reject an unpaired device's attempt to read private local World data.
**198 · Export a chosen** Export a chosen local World collection as a portable archive and verify its manifest and item count.
**199 · Restore a saved** Restore a saved archive into a fresh local workspace and reconcile duplicate source identities.
**200 · Complete the journey** Complete the journey capture → organize → find → user-approved share, demonstrating explicit evidence for each completed stage.

## Completion criteria

Count **exactly 100** IDs, 101–200. A scenario is verified only by an observed user outcome; a file or API method being present is not enough. Preserve captured source, permission boundary, uncertainty and local recoverability. Keep capability gaps in the maps rather than inventing simulated passes.
