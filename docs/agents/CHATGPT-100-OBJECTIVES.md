# ChatGPT capability probes — 100 DISTINCT real-user objectives
Version: 2026-10-27. **This document is not a test script, benchmark suite, prompt generator or task automation.** Every numbered line describes an independent, natural-language user goal. A human assigns ONE item to an agent; the agent discovers native VIVIM CLI commands using the companion environment helper.

## How to read this list
- **One objective per agent at a time.** A scenario is a desired outcome, not a command sequence. Do not automatically run adjacent items, reuse the same action with different wording, or claim support from a source declaration.
- All probes concern **ChatGPT in the dedicated VIVIM Chrome profile**. A capability is measured by the real webapp and the Harness's native CLI, not fabricated DOM, fixtures, other providers or private browser controllers.
- Every objective tests a different interaction primitive or failure boundary. ChatGPT account features differ; `FEATURE_UNAVAILABLE` is an informative result distinct from `HARNESS_UNSUPPORTED`.
- User-approved effects only. A scenario does not authorize provider sends, changing settings, uploading, sharing, deleting or even navigation that disrupts the active owner. Use disposable sample content and ask for scoped permission when needed. Five agents may work independently but may not simultaneously mutate one shared browser/effect owner.
- Only use `node bin/studio.mjs` and helper files. No scripted campaign, no Playwright/Puppeteer, no secondary CDP client, no direct API workaround, no code inspection to cheat a probe.
- Record status, wall-clock latency, number of CLI invocations, real native outcome, friction or missing command and exact evidence. No silent reruns after uncertain effects.
- Companion files: [probe agent](../../.opencode/agents/chatgpt-probe.md) · [environment, server and Chrome profile](CHATGPT-PROBE-ENVIRONMENT.md).

## 01 — Account and live-session awareness

**001 · Account identity.** Identify which ChatGPT account is signed in without exposing personal credentials.

**002 · Authentication state.** Detect whether ChatGPT is signed out and requires login.

**003 · Native thread identity.** Identify the currently visible native conversation ID, not its title.

**004 · Tab discovery.** Locate the ChatGPT tab among unrelated webapp tabs.

**005 · Chrome-profile isolation.** Recognize which ChatGPT window belongs to the dedicated VIVIM profile.

**006 · Page readiness.** Tell me whether ChatGPT is ready to accept input or still loading.

**007 · Streaming state.** Tell me whether the assistant is currently generating or finished.

**008 · Ephemeral chat awareness.** Recognize when ChatGPT is in Temporary Chat mode.

**009 · Duplicate-title identity.** Disambiguate two native threads with identical visible titles.

**010 · UI obstruction recognition.** Explain why the ChatGPT composer is blocked by a modal or challenge.

## 02 — Moving around ChatGPT

**011 · New-chat navigation.** Open a blank new conversation without sending anything.

**012 · Sidebar history selection.** Locate a particular conversation in the history sidebar by its title.

**013 · Deep-link navigation.** Open a conversation from its exact native /c/ address.

**014 · Cross-thread navigation.** Move between two open conversations and return to the original.

**015 · Native history search.** Use ChatGPT's own history search to find a specific old test phrase.

**016 · Recent-thread recovery.** Return to the last conversation after navigating away from it.

**017 · Long-thread traversal.** Navigate to a user turn near the start of a long thread.

**018 · Scroll-to-latest.** Jump to the most recent answer from an earlier message.

**019 · Sidebar expansion.** Expand a collapsed conversation sidebar and find its controls.

**020 · Archived-history navigation.** Find an archived disposable conversation if the account exposes archive history.

## 03 — Native conversation lifecycle

**021 · First-turn delivery.** Ask one harmless question in a fresh ChatGPT conversation and verify its answer.

**022 · Same-thread follow-up.** Ask a follow-up that depends on the answer in the immediately previous turn.

**023 · Long-range thread continuity.** Refer to a fact from an early turn after intervening discussion.

**024 · Message edit and branch awareness.** Edit a previously submitted disposable user message and identify the current answer branch.

**025 · Response regeneration.** Regenerate a completed assistant answer through ChatGPT's own control.

**026 · Interrupt generation.** Stop a message while ChatGPT is visibly generating.

**027 · Generation continuation.** Continue or resume an interrupted answer only when the site offers that control.

**028 · Conversation branching.** Create a branch from an earlier turn using ChatGPT's native branching feature if present.

**029 · Conversation rename.** Rename a disposable conversation using the ChatGPT interface.

**030 · Archive mutation.** Archive a disposable completed conversation without deleting it.

## 04 — Input controls and interaction modes

**031 · Multiline payload fidelity.** Send a single message containing multiple paragraphs with blank lines preserved.

**032 · Unicode editing.** Enter mixed Spanish accents, emoji and right-to-left text faithfully.

**033 · Keyboard send action.** Submit text using the site's supported keyboard shortcut rather than clicking Send.

**034 · Keyboard newline action.** Insert a newline without accidentally submitting the message.

**035 · Model selection.** Choose an available ChatGPT model and verify the selected model label.

**036 · Temporary Chat activation.** Start a Temporary Chat from the app's own controls.

**037 · Speech input.** Dictate a harmless message using ChatGPT's microphone input if available.

**038 · Suggestion-chip interaction.** Select a suggested follow-up chip and confirm the intended composer state.

**039 · Copy action.** Copy a completed assistant answer with ChatGPT's native Copy control.

**040 · Feedback UI discovery.** Inspect the message reaction or feedback controls without sending feedback.

## 05 — Structured answer extraction

**041 · Long-answer extraction.** Read an assistant answer that spans several screens without losing the end.

**042 · Role attribution.** Identify exact user-versus-assistant message boundaries in a mixed thread.

**043 · List structure.** Recover ordered and unordered nested list hierarchy from an answer.

**044 · Code block fidelity.** Extract a code fence including programming language and indentation.

**045 · Table semantics.** Read a table as distinct headers, rows and cells.

**046 · Math fidelity.** Extract a displayed math expression in a reusable mathematical form.

**047 · Quotation structure.** Preserve the structure and attribution of a blockquote in an answer.

**048 · Hyperlink extraction.** Read the destination URL of a link without mistaking its visible label for the address.

**049 · Citation anchoring.** Bind an inline citation marker to the answer passage it supports.

**050 · Image-block extraction.** Locate an inline response image as an independently addressable content block.

## 06 — Search, citations and thinking surfaces

**051 · Search-tool activation.** Ask ChatGPT to search the public web and determine whether a web-search action really ran.

**052 · Source card reading.** Inspect the source cards attached to a search-assisted answer.

**053 · Citation-source navigation.** Open one referenced source through ChatGPT's own source UI.

**054 · Tool-panel expansion.** Expand a collapsed tool or sources panel and inspect its status.

**055 · Evidence presence.** Distinguish a sourced answer from an unsourced model assertion.

**056 · Reasoning mode awareness.** Select an available thinking mode and identify its visible progress state.

**057 · Reasoning completion.** Tell when a long reasoning response has actually completed instead of showing progress.

**058 · Deep Research discovery.** Locate the Deep Research entry point if the account offers it without starting research.

**059 · Research job monitoring.** Reopen an already existing research task and identify whether it is pending or complete.

**060 · Research report navigation.** Navigate the sections and reference links in a completed research report if available.

## 07 — User-provided files and multimodal inputs

**061 · File-picker input.** Attach a harmless local text file and verify its filename appears before sending.

**062 · Vision-file submission.** Ask ChatGPT to describe a disposable image the user deliberately provides.

**063 · PDF interpretation.** Attach a public sample PDF and ask ChatGPT for a fact on a numbered page.

**064 · Tabular file analysis.** Upload a synthetic CSV and request a grouped summary of its columns.

**065 · Spreadsheet rendering.** Attach a sample spreadsheet and request a visual chart of values.

**066 · Source-file input.** Provide a short nonsecret source-code file and ask about one named function.

**067 · File download.** Use ChatGPT's native UI to download a deliberately generated nonprivate file.

**068 · Attachment preview.** Open an attachment preview and inspect its type without sending a new message.

**069 · Image generation result.** Ask ChatGPT to generate a new original image and locate the output artifact.

**070 · Upload failure detection.** Distinguish a failed attachment upload from a completed attachment without retrying blindly.

## 08 — Generated artifacts and richer UI

**071 · Generated-document controls.** Find the download button and file type for a generated document.

**072 · Writing-artifact surface.** Open a native editable writing artifact in ChatGPT if offered.

**073 · Artifact edit.** Change a small piece of text in a disposable editable ChatGPT artifact when supported.

**074 · Data-analysis execution provenance.** Identify whether ChatGPT's data-analysis tool actually executed rather than merely describing code.

**075 · Tool failure detection.** Recover the visible error state when ChatGPT's tool computation fails.

**076 · Diagram artifact recognition.** Request a supported static diagram and identify its rendered result.

**077 · Chart semantics.** Inspect an in-chat chart's axis labels and data points.

**078 · Input-output provenance.** Compare a generated file with its source upload using the native ChatGPT context.

**079 · Code copying.** Open an existing code block's native copy control and preserve its whitespace.

**080 · Artifact-open navigation.** Find the action to open a generated attachment separately from downloading it.

## 09 — Projects, organization and controls

**081 · Project creation.** Create a disposable ChatGPT Project if the account supports Projects.

**082 · Conversation-to-Project move.** Move a disposable existing conversation into a specified Project.

**083 · Project unlink.** Remove an existing test conversation from its Project without deleting it.

**084 · Project instructions read.** Inspect a Project's custom instructions without modifying them.

**085 · Project file attachment.** Attach an approved reference file to a disposable Project when available.

**086 · Project-specific history.** Locate a conversation within a particular ChatGPT Project.

**087 · Sharing control discovery.** Discover whether a disposable conversation has a shareable link without publishing it.

**088 · Share-link revocation.** Revoke a previously created disposable shared conversation link when authorized.

**089 · Memory setting inspection.** Read the ChatGPT memory controls to determine whether Memory is enabled.

**090 · Personalization settings discovery.** Open Custom Instructions settings and report the controls available without changing them.

## 10 — Resilience, capture, and truthful outcomes

**091 · Network loss detection.** Notice when the ChatGPT page goes offline and report whether the current task can recover.

**092 · Session expiration.** Detect an expired login while preserving the originally selected thread.

**093 · Target drift.** Handle the exact ChatGPT tab changing during a pending interaction without sending to the wrong tab.

**094 · Snapshot freshness.** Recognize that previously captured message content is stale after a page reload.

**095 · Runtime reconnection.** Reconnect to the existing VIVIM Studio after a dropped CLI request without inventing a fresh browser owner.

**096 · No-resend reconciliation.** Recover safely from an uncertain send while preserving the original operation identity.

**097 · Rate-limit detection.** Identify when a ChatGPT quota or rate-limit banner prevents a user action.

**098 · Timeout truthfulness.** Distinguish a very slow generation from an actually failed or complete answer.

**099 · Capture provenance.** Capture one completed conversation into the local VIVIM World with original source attribution.

**100 · Return-to-source continuity.** Reopen that saved conversation from VIVIM's local World and point back to its exact native ChatGPT source.
