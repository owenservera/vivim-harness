<div align="center">

# VIVIM

### Your AI. Your world.

**Own your AI. · Share your AI. · Evolve your AI.**

A local-first foundation for a personal AI world — so your conversations, ideas, and knowledge can become something you control and build upon.

[**Explore the vision**](#why-vivim) · [**See what's working**](#what-exists-today) · [**Try the developer preview**](#try-it-locally) · [**Follow development**](https://github.com/owenservera/vivim-harness/issues)

<br>

![Status](https://img.shields.io/badge/status-active_development-B9E8CF?style=flat-square&labelColor=202B2B)
![Local first](https://img.shields.io/badge/approach-local--first-8BD6B0?style=flat-square&labelColor=202B2B)
![Runtime](https://img.shields.io/badge/runtime-Node.js_22%2B-92C7E3?style=flat-square&labelColor=202B2B)
![Platforms](https://img.shields.io/badge/target-Windows_%7C_Linux-DCC7FA?style=flat-square&labelColor=202B2B)

</div>

---

## Your AI life shouldn't be scattered everywhere.

A conversation in one assistant. A useful insight in another. Weeks later, you remember the idea — but not where it lives.

**VIVIM is building a personal AI world around *you*, not around a single AI provider.**

The goal is simple: bring your AI interactions into a world where you can find, organize, relate, and use what matters — while making deliberate choices about what stays local and what gets shared.

<table>
<tr>
<td width="33%" valign="top">

### 🏡 Own your AI

Build lasting personal context beyond a single chat interface. Keep the foundation under your direction.

</td>
<td width="33%" valign="top">

### 🔗 Share your AI

Choose what to bring into a conversation or workflow. Sharing should be deliberate, not assumed.

</td>
<td width="34%" valign="top">

### 🌱 Evolve your AI

Turn disconnected moments into more useful knowledge as your work, interests, and ideas grow.

</td>
</tr>
</table>

> **My machine. My data. My AI.** That's the direction we're building toward — not a claim that every envisioned feature is available today.

## Why VIVIM?

Most AI products start with a model and an empty chat box. VIVIM starts with the person using them.

- **One personal world:** a coherent place for conversations and knowledge, rather than a collection of isolated chat histories.
- **Provider-aware:** work with your existing AI experiences instead of requiring you to adopt one new model.
- **Local-first by design:** the existing capture foundation stores its evidence on your machine, outside the source checkout.
- **Explicit control:** user-directed conversation selection and provider interactions; capture does not imply permission to send.
- **Built for continuity:** a foundation for remembering, finding and reusing context over time.

These are product goals and architectural principles. The next section separates current code from the broader vision.

## What exists today?

VIVIM is in **active development**. This public repository contains the runnable **Capture Studio / VIVIM Harness foundation**, not a finished one-click consumer release.

| Area | Current state |
| --- | --- |
| Local capture engine | Implemented: Chrome DevTools Protocol-based capture and local evidence storage |
| AI conversation interaction | Implemented in the harness: explicit, user-authorized send/read flows for supported targets; live operation depends on the site's current UI, account sign-in and browser state |
| Local Studio UI and CLI | Present in source; developer-oriented and still evolving |
| Evidence and derived knowledge | Raw, decoded and rendered records with rebuildable derived outputs |
| Agent workflows | CLI discovery, recipes and guarded execution paths are present |
| Personal AI World experience | **In progress** — the cohesive consumer journey is not yet a finished product |
| Onboarding and multi-account experience | **In progress / design decisions parked** — do not assume hands-free setup, full-history discovery or production-ready account switching |
| Cross-platform support | Windows and Linux are engineering targets; see the portability document for verified scope |

**Important:** The original developer-facing Capture Studio system is the technical core. The product we're building on top of it is VIVIM — a more approachable, connected personal experience.

## The experience we're building

<table>
<tr><td width="50%" valign="top">

**01 · Return**

Find the conversations and ideas you want to revisit.

</td><td width="50%" valign="top">

**02 · Organize**

Build a world that reflects your own projects, interests and thinking.

</td></tr>
<tr><td valign="top">

**03 · Find**

Locate useful context without hunting through unrelated histories.

</td><td valign="top">

**04 · Take action**

Carry the context you choose into your next AI interaction or task.

</td></tr>
</table>

*The four stages describe the intended product journey, not four claims of completed consumer functionality.*

## Try it locally

This is currently a **developer preview**, not an installer for general users.

**You'll need:** Node.js 22 or newer, and Chrome or a compatible browser for live capture. You sign into AI provider sites yourself. The repository has no runtime npm dependency install step.

```bash
git clone https://github.com/owenservera/vivim-harness.git
cd vivim-harness
node bin/studio.mjs start
```

Open the localhost URL reported by the running Studio server. Use the Studio UI to explore the current local harness. To inspect available commands without starting the server:

```bash
node bin/studio.mjs help
node bin/studio.mjs agent capabilities --json
```

For browser setup, user-authorized capture, troubleshooting, and environment-specific instructions, see the [technical manual](docs/TECHNICAL-README.md), [Windows live-test guide](docs/LIVE-TEST.md), and [portability notes](docs/PORTABILITY.md).

**No silent provider sends.** Sending a prompt is a separate, explicitly authorized action that can use your provider account. A local preview is not proof that a live provider has passed end-to-end acceptance.

## Built around trust and user choice

**Local-first ≠ offline-only ≠ guaranteed isolation.** The harness writes captured evidence to a local directory outside Git; it does not run a product cloud-sync or telemetry backend by default. Visiting or sending to a third-party AI website still involves that provider's network and account services.

Capture may include sensitive content and, in raw mode, authentication material from browser traffic. Protect your local workspace and never commit captures or browser profiles. Dedicated browser profiles help separate worlds but are not an operating-system security boundary.

Read the [local-first design](docs/LOCAL-FIRST.md) and [first-user onboarding decisions](docs/product/FIRST-USER-ONBOARDING-DECISIONS-2026-10-27.md) for exact boundaries.

## Explore the project

| I want to… | Start here |
| --- | --- |
| Understand the architecture | [Architecture overview](ARCHITECTURE.md) |
| Dive into commands and technical capabilities | [Complete technical manual](docs/TECHNICAL-README.md) |
| See the intended product | [Integrated app blueprint](docs/product/V1-INTEGRATED-APP-BLUEPRINT.md) |
| Follow current work | [GitHub issues](https://github.com/owenservera/vivim-harness/issues) |
| See local test guidance | [Live testing runbook](docs/LIVE-TEST.md) |
| Understand portability | [Windows + Linux](docs/PORTABILITY.md) |
| Contribute as a coding agent | [Agent instructions](AGENTS.md) |
| View the separate visual landing-page experiment | [Marketing prototype](marketing/index.html) |

## Building in the open

This is an evolving product and engineering repository. Contributions, discussions and bug reports can start in [Issues](https://github.com/owenservera/vivim-harness/issues). Please don't attach private conversations, cookies, access tokens or browser profiles to reports.

**Project website:** [vivim.live](https://vivim.live) · **Source:** [GitHub](https://github.com/owenservera/vivim-harness)

<sub>VIVIM — Own your AI. Share your AI. Evolve your AI.</sub>
