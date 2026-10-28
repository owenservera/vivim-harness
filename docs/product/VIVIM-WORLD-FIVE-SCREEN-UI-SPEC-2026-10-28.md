# VIVIM World — Five-screen UI visual specification

**Status:** implementation in progress, not a product acceptance receipt  
**Reference:** owner-supplied five-panel desktop UI image in ChatGPT, 2026-10-28. The reference image is not copied to this public repository.  
**Canonical implementation:** `src/studio/ui/chat.html`, `chat.mjs`, `world-view.mjs`.  
**UI-only preview:** `ui-preview/build.mjs` + synthetic `preview-fixture.mjs` (not real provider acceptance).

## The five reference views

1. **First launch / guided onboarding:** immersive twilight mountain/lake tone, left-hand VIVIM brand/benefits, right-hand four-step onboarding card. In the current build the welcome stepper and provider choices open the existing Studio connection form; there is **no user-selected data-directory picker**, no automatic provider authentication, no automatic send and no auto-import. A supported provider is not a verified account.
2. **Chat / Capture:** compact left navigation, VIVIM brand top bar, provider rail, native conversation content, composer, and a right detail/evidence panel. Provider chips use the **existing** supported-sites response; they cannot switch an active conversation. Provenance, send authorization, no-resend and uncertain outcomes remain in the canonical Chat module. Rich content uses the existing safe native renderer, not a speculative replacement.
3. **Projects, Notes & Workspace:** cards with decorative gradient covers for **actually listed saved projects**, source-backed counts/links, a selectable detail pane, authored notes and the existing workspace reader. No invented project state, cover image or backend store.
4. **Knowledge Graph & Relations:** radial chart is a bounded, non-authoritative projection of the **same local** `/api/v1/world/map` nodes and edges. The labelled evidence/provenance list stays visible and authoritative. Unresolved, stale or missing items are visibly non-actionable. Neither visual proximity nor local edges establish provider identity.
5. **Settings, Providers & Transfer:** tabbed settings based on existing local supported-site discovery, read-only namespace information, Appearance/Data disclosures and a link to the existing Transfer workflow. **No fake connected-account badges, folder chooser, sync status or authentication state.**

## Design system

- **Palette:** near-black/navy background (`#080e1b`), deep panels (`#101d30`), electric blue actions (`#2473f2`), soft lavender for projects, mint for saved/local state, muted cool-gray metadata.
- **Navigation:** desktop compact ~205px fixed/sticky side rail, small provider/context actions; horizontal scroll on mobile. Current mode from the existing `World.choose()`; screen title/breadcrumb is synchronized with the active view.
- **Surfaces:** restrained 12–18px radii, crisp thin blue-gray borders, layered soft shadows, no broad brightly colored callouts. Small type remains readable with clear text hierarchy.
- **First run:** left immersive visual panel with text contrast; right structured steps. CSS-drawn scenery is illustrative and deliberately not represented as a user photograph.
- **Project cards:** 2–3 columns when room allows, 1 on narrow layouts; actual saved object title and linked counts, with explicitly decorative gradient artwork.
- **Graph:** center = the chosen saved record, not a fabricated "VIVIM entity." Maximum 12 displayed nodes in a view; metadata indicates partial scans and the list preserves all evidenced relations. Keyboard-usable buttons; fallback without SVG keeps the text graph projection.
- **Responsive:** ~960px sidebar breakpoint, ~850px welcome panel stack, ~700px single-column World; maintain keyboard focus and reduced-motion support.

## Implementation mapping

| Screen | Code | Actual behavior | Outstanding acceptance |
|---|---|---|---|
| Onboarding | `chat.html` welcome + `chat.mjs:renderWelcome` | Displays real supported sites; opens connection form only | Windows folder picker, real browser profile and first-user three-turn flow |
| Chat | `chat.html` shell + `chat.mjs` | Provider rail reflects actual registry, live snapshot remains authoritative | Screenshot/real-provider visual test and native rich-part fidelity |
| Projects | `world-view.mjs:fillItems`, gallery CSS | Displays source-backed saved project cards | Live layout, project creation/edit conflict acceptance |
| Relations | `world-view.mjs:graphProjection/renderRelationGraph` | Plots actual local map; canonical evidence list retained | Large-map visualization, keyboard/browser visual test |
| Settings | `world-view.mjs:renderSettings/loadSettingsSites` | Real supported-site GET, local namespace if available | Product decision on account switching, directory selection and settings lifecycle |

## Contract and honesty rules

Do not create a second application, database, authoritative history, browser/CDP owner or provider send path. Keep `VIEWS` as the three stored object families (conversations/projects/notes); Home and Settings are **shell-only projections**. Preserve existing Chat and World API routes, native identity uncertainty, local source fidelity and read/transfer safeguards.

The Vercel preview copies canonical modules and denies all mutations while presenting visibly synthetic records. No screenshot or successful deployed page has been verified unless accompanied by a real browser receipt. Never count a source parse or synthetic DOM check as a live acceptance.

## Next tests (no Playwright/Puppeteer)

- Verify desktop (1440/1280px), tablet (800px) and mobile (390px) with a human/browser viewport.
- Verify first-launch copy truthfulness and connection-form focus.
- Confirm active conversation keeps provider switching disabled; verify no send from navigation.
- Exercise project select, note edit conflict, Find, Transfer, relations partial coverage and unavailable graph items on a working local Harness.
- Test real Windows profile/account login, native three-turn Harbor→Cedar, source-preserving capture and re-open acceptance separately from the static UI preview.
