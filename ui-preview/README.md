# VIVIM UI preview (Vercel)

**Purpose:** view and test the *actual canonical VIVIM Harness frontend* on HTTPS while the local Studio backend is under development. This is a preview fixture, not a second VIVIM application and not evidence that a provider integration works.

- `node ui-preview/build.mjs` copies the real `src/studio/ui/chat.html`, `chat.mjs`, `world-view.mjs` and `universal-chat.mjs` into `ui-preview/dist`.
- The builder injects a visible **DEMO DATA** label and a fixture module **before** the existing app script; production source remains unchanged.
- The fixture module intercepts every `/api/v1/*` call. Only synthetic read-only local-world records are returned. All POST/PUT/PATCH/DELETE operations return **405**. Requests to external sites are refused by the preview shim. No credentials, browser profiles or real conversations are copied.
- The original Chat and World mounting/navigation/rendering code runs on the deployed website; provider sends, real sign-in, migrations, import and persistence require the local Harness runtime, so the preview does not claim them.
- Use `node --test test/unit/ui-preview.test.mjs test/unit/vivim-shell.test.mjs` for offline fixture/contract tests. No Playwright or Puppeteer.

**Vercel Git project:** source repo `owenservera/vivim-harness`, root directory = repository root, framework = Other (null), build command = `node ui-preview/build.mjs`, output directory = `ui-preview/dist`. Use a **preview deployment**, not the product's production domain.

**Browser review:** check welcome → Explore connection UI (existing connection field), sidebar Saved Conversations → open synthetic detail, Projects/Notes → read sample, Find and Relations → synthetic status, Transfer → clearly blocked writes, desktop narrow/mobile layout and keyboard focus. Report visual bugs separately from native provider acceptance.

**Local browser fallback:** `node ui-preview/serve.mjs` builds the same preview and serves it only at `http://127.0.0.1:4173/`. No cloud, backend, browser automation, provider effect or credentials are required. Stop with Ctrl+C. Never expose this loopback preview to the network.
