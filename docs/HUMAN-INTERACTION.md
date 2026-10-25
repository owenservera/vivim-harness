# Human interaction layer (runbook)

How Capture Studio types into a live AI chat site, what the pacing parameters are, where they live,
what the local harness proves, and the measured CDP rules that must not be broken.

Everything here is opt-in. `record` and `capture` never touch the page; only `studio drive` and
`campaign --execute` reach this layer.

## Modules

| File | Role |
| --- | --- |
| `src/capture/actions.mjs` | Drive primitives: CDP transport, composer discovery, focus, send, reply read-back, login-wall check; exported as `driveSite()`. |
| `src/capture/human.mjs` | Pacing: `humanType`, `humanPressEnter`, `humanClick`, `humanScroll`, `humanIdle`, `prepareHumanEnvironment`, `DEFAULT_PACE`. No project imports, only `node:` builtins. |
| `src/capture/campaign.mjs` | Sequential multi-site run over `driveSite` + `derive` + `src/families/build.mjs`, plus the resume state file. |
| `src/capture/recorder.mjs` | The recorder used by both capture and drive, so a drive lands as an ordinary session. |
| `scripts/human-check.mjs` | The harness that proves the typing behaves like a person. Local fixture only. |

## Measured CDP rules

These are measured facts, not preferences. They are encoded in `src/capture/human.mjs` and asserted
by `scripts/human-check.mjs`.

1. **The working key-event shape is `keyDown` (no text) + `char` (with text) + `keyUp`.** The page
   then sees the full `keydown` → `keypress` → `keyup` → `input` sequence a physical keyboard
   produces, and exactly one character is inserted.
2. **`keyDown{text}` + `char{text}` + `keyUp` inserts every character twice and submits twice.**
   Measured on Chrome 155; a prompt typed that way was posted twice.
3. **`keyDown{text}` alone (plus `keyUp`) loses punctuation.** Letters insert, but a trailing `.`
   never reaches the composer.
4. **Enter uses the same shape with `text: '\r'`.** `keyDown` (no text) + `char('\r')` + `keyUp`
   submits exactly once and still inserts one newline in a multi-line composer. Never send a second
   Enter.
5. **Writing `.value` or `textContent` into a rich composer does not work.** ProseMirror and Lexical
   keep their own internal state, so the app never believes the text exists and the message is never
   sent. Only real key input reaches the app.
6. **`Input.insertText` updates app state but emits no key events.** It is used for a single
   character that no US-layout key maps to, never as the general typing path.
7. **The composer is found by adapter selectors first and by a generic heuristic second.** The
   generic path queries `textarea`, `[contenteditable="true"]`, `[contenteditable=""]` and
   `[role="textbox"]`, keeps visible and enabled elements, skips anything inside a
   `dialog`/`aria-hidden` subtree, and picks the largest by area. It must work with no adapter file
   at all. The chosen element is remembered in page state (`globalThis.__aionDrive`), never by
   mutating the DOM: no marker attributes, no injected elements.
8. **A background tab reports `document.hasFocus() === false`,** so the driver sends
   `Page.bringToFront` and then `Emulation.setFocusEmulationEnabled {enabled: true}` before
   interacting. `prepareHumanEnvironment()` reports what the page actually sees. Focus emulation
   answers `hasFocus`, not visibility — see [Visibility and focus](#visibility-and-focus).
9. **On this machine `navigator.webdriver` is `false`** (Chrome is launched without
   `--enable-automation`) **and the user agent is the normal Chrome UA.** The layer reads both and
   reports them; it never spoofs a UA and never sets automation overrides.

The wider research on what a page can observe, and the browser parameter table, is in
[`research/CDP-REALISM.md`](research/CDP-REALISM.md). It is not repeated here.

## Visibility and focus

A tab that is not the active tab is hidden, and Chrome does not deliver synthetic key input to a
hidden tab. Measured on Chrome 155 on this machine, with `document.visibilityState === "hidden"`:

- `Input.insertText` still wrote text into the composer, while `Input.dispatchKeyEvent` keystrokes
  were silently dropped. The drive looked like it typed and sent; nothing arrived.
- `Emulation.setFocusEmulationEnabled {enabled: true}` makes `document.hasFocus()` return `true`
  even while the tab is hidden, so `hasFocus()` alone is **not** a sufficient signal.
  `document.visibilityState` is. `prepareHumanEnvironment()` enables focus emulation and reports
  `hasFocus`; a `true` from it is not proof that the tab is visible.
- `Page.bringToFront` cannot fix a hidden tab when the browser window is occluded by another
  window. It switches tabs inside the browser and nothing more.

The fix is to drive in a freshly created tab, which is always visible. `driveSite()` opens its own
tab through `/json/new`, activates it, and closes it again when the drive ends, so the owner's
browser keeps only their own tabs. (`freshTab: false` exists and reuses an open tab on the host; it
is the path that hits the hidden-tab problem.)

When the window itself is behind another window, bring it to the foreground from the OS:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\focus-chrome.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\focus-chrome.ps1 -Title chatgpt
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\focus-chrome.ps1 -ProcessId 12345
```

`scripts/focus-chrome.ps1` calls `ShowWindow(SW_RESTORE)`, `BringWindowToTop` and
`SetForegroundWindow`, attaching the input queues with `AttachThreadInput` first because Windows
refuses `SetForegroundWindow` from a process that is not already foreground. `-ProcessId` and
`-Title` choose which Chrome window is used; with no filter it takes the first Chrome process that
has a main window. It waits 350 ms and exits `0` when the window is in front, `1` when it is not or
when no Chrome window was found.

## Reply detection

A drive accepts an answer only when **new content** appeared after the send. These rules live in
`readTranscript()`, `waitForCompletion()`, `detectSiteFailure()` and `detectAuthWall()` in
`src/capture/actions.mjs`.

- **New content, not new text.** The calibration prompt always produces the same 12 words, so a
  fresh reply can be byte-identical to the previous one. The transcript reader reports `count`, the
  number of visible content elements it matched, and `waitForCompletion()` accepts an answer only
  when that count grew past the baseline taken before the send (`baseCount`). Text equality is
  checked as well, but the count is the proof.
- **The prompt we sent is excluded.** The transcript is read with `exclude: [prompt]`, and a block
  whose text equals the prompt, contains it or is contained by it does not count.
- **Status placeholders are not answers.** `Thinking`, `Generating`, `working`, `loading`,
  `思考中`, `正在思考`, `生成中`, `加载中` and their dotted variants are filtered out of the count.
- **Navigation chrome is excluded.** Sidebars, headers, footers, navs, menus, toolbars and
  breadcrumbs are skipped, and so is interactive chrome (buttons, links, inputs). Kimi returned
  `New chat / My Kimi / Plugins` as an answer before this was fixed.
- **A site-side failure ends the drive immediately.** `detectSiteFailure()` checks visible
  dialogs/modals first and then the page text for quota and credit messages, network errors, rate
  limits, captchas, "service unavailable", age gates (`confirm your age`,
  `what year were you born`) and login prompts (`log in or create account`, `sign in to continue`,
  `请登录`). A match ends the drive with the site's own words instead of burning the timeout.
- **A login modal over a usable composer is a login wall.** `detectAuthWall()` blocks the drive when
  a visible dialog mentions log in, sign in, send code, a QR code or a password, even if the
  composer below it looks enabled (Kimi shows a WeChat/phone login dialog over a working composer).
  A login URL, a disabled composer and a read-only composer are walls too.

## Cookie consent

`dismissCookieBanner()` handles a consent banner before the prompt is typed, and always takes the
**least permissive** option: `necessary`, `essential only`, `only necessary`, `reject`,
`reject all`, `decline`, `deny`, `continue without`. What it will not do:

- **A banner that offers only "accept all" is reported, not accepted.** Consent is the owner's
  decision, so the banner and its labels are recorded in the drive result (`consent`) and the drive
  continues, because a banner rarely blocks the composer.
- **A "cookie settings" / "manage" / "preferences" link is never clicked.** On arena.ai it opened
  `?manage-cookies=true`, and the open modal swallowed the next click, so the chat was blocked.
- **An open settings modal is closed with Escape** (`closeCookieModal()`), which also clears the
  `?manage-cookies=true` URL state.

## Pacing parameters

They live in exactly one place: `DEFAULT_PACE` in `src/capture/human.mjs`.

| Key | Default | What it does |
| --- | --- | --- |
| `keyMinMs` / `keyMaxMs` | `35` / `110` | Delay after each character, drawn per character. |
| `wordPauseMs` | `[70, 190]` | Extra pause after a space. |
| `sentencePauseMs` | `[220, 520]` | Extra pause after `.`, `!` or `?`. |
| `thinkPauseEveryChars` | `24` | A longer pause every N characters (0 disables it). |
| `thinkPauseMs` | `[300, 800]` | Length of that pause. |
| `preSendPauseMs` | `[700, 1900]` | Hold before pressing Enter. |
| `mouseMoveSteps` | `[8, 22]` | Points on the curved path `humanClick` walks before clicking. |

Behaviour that is fixed in code rather than configurable per call:

- **One deliberate typo.** For text of 20 characters or more, one wrong character is typed at a
  random early position, removed with `Backspace` after 120–260 ms, and followed by a 180–460 ms
  pause before typing continues. It is counted in `stats.corrections`, and the harness adds two
  expected keydowns for it.
- **Read-back.** After typing, `humanType` reads the composer and requires the last (up to) 28
  characters of the intended text to be present, whitespace-normalised. A mismatch is reported as
  `ok: false`, never thrown.
- **`humanIdle`** waits 400–1200 ms so consecutive actions are not back-to-back.
- **`humanScroll`** scrolls in steps (default −240 px over 6 steps).
- **`{ human: false }`** uses a fixed 15 ms per character with no typo and no extra pauses. It
  exists for tests; do not use it against a site.

## Changing the pacing

1. Edit `DEFAULT_PACE` in `src/capture/human.mjs`. The object is frozen, and every helper merges a
   partial `pace` override over it (`{ ...DEFAULT_PACE, ...pace }`), so a caller can pass
   `{ pace: { keyMinMs: 45 } }` without editing the file.
2. There is **no CLI flag** for pacing. `studio drive` and `studio campaign` use the defaults.
3. Run `node scripts/human-check.mjs` and require all nine checks to pass before driving a real
   site again.

## What the harness proves

```powershell
node scripts/human-check.mjs
node scripts/human-check.mjs --json
node scripts/human-check.mjs --text "a shorter sentence." --port 9333
```

It writes a data-only fixture page into the OS temp directory, opens it as a `file://` tab, types a
sentence into a plain `<input>` (`#i`) and into a `contenteditable` (`#e`), then measures what the
page actually saw. It types into nothing else, closes the tab it opened and deletes the fixture
unless you pass `--keep-open`.

Flags: `--port N` (default 9222), `--text "..."`, `--json`, `--keep-open`.

Output is one JSON receipt on stdout (`{ ok, checks, gaps, events, env }`); a short human summary
goes to stderr and is suppressed by `--json`.

| Exit | Meaning |
| --- | --- |
| `0` | Every check passed. |
| `1` | A check failed. |
| `2` | Environment failure: no DevTools endpoint on the port, or `src/capture/human.mjs` is missing or does not export `humanType()` and `prepareHumanEnvironment()`. |

The nine checks:

| # | Check | What it means |
| --- | --- | --- |
| 1 | `humanType(#i)` resolved | The call returned without an error and without `ok: false`. |
| 2 | keydown count on `#i` == characters + 2 × corrections | Exactly one key sequence per character, plus two per deliberate slip. |
| 3 | input value == typed text | The exact text, whitespace-normalised. |
| 4 | contenteditable text == typed text | The same text through a rich editor, not just a plain input. |
| 5 | input events ≥ one per character | The page received real input events, not a single bulk write. |
| 6 | inter-key gaps in `[5, 2000]` ms, none under 15 ms | Pacing is real: no machine-speed bursts. The window is keydown-to-keydown on `#i`. |
| 7 | `navigator.webdriver === false` | The browser does not announce itself as automated. |
| 8 | `document.hasFocus()` after prepare | The focus value is recorded; when the OS window is not focused the check reports a WARN rather than failing. |
| 9 | UA does not contain `HeadlessChrome` | A real Chrome build, not a headless variant. |

Currently all nine pass.

**What a failure means.** Do not drive a real site until the harness is green again; a red check
means the layer no longer behaves like a keyboard.

| Failing check | Usual cause |
| --- | --- |
| 2 | The three-event shape was changed, or a correction was added without updating the count. |
| 3 or 4 | The punctuation keymap is wrong, or the `insertText` fallback fired for a mappable character. |
| 5 | A `.value`/`textContent` write or `Input.insertText` replaced the key path. |
| 6 | Pacing was bypassed: `human: false`, a zero delay, or a pause that no longer applies. |
| 7 | Chrome was started with `--enable-automation`. |
| 9 | A headless Chrome build answered on the port. |

## Do not do

- Do not write `.value` or `.textContent` into the composer.
- Do not write text only into the DOM and then click send.
- Do not send zero-delay key bursts; the 35–110 ms per-character floor is the point.
- Do not type with `keyDown{text}` — it double-inserts, double-submits, or drops punctuation.
- Do not send a second Enter after sending; one Enter is the send.
- Do not spoof the user agent or set automation overrides; the machine already reports
  `navigator.webdriver === false` and a normal Chrome UA.
- Do not run two drives at once, and do not loop `campaign --execute` to collect more messages.
- Do not drive in a reused background tab: a hidden tab silently drops every synthetic keystroke.
- Do not trust `document.hasFocus()` alone; focus emulation reports `true` for a hidden tab. Read
  `document.visibilityState`.
- Do not click a cookie "settings", "manage" or "preferences" link. Use a conservative option, or
  report the banner.
- Do not answer an age gate or a login prompt for the owner. Report it with the site's own words
  and stop that drive.

## Limits

- One browser, one tab, one prompt at a time. `campaign` is serial by construction, with a
  randomised 45–90 s cooldown between sites.
- A site may block on quota, a captcha or a new consent dialog: that site times out and is recorded
  as failed, and the campaign continues.
- An account may be rate-limited. One prompt per site per run is deliberate.
- On a page with several large editable regions the heuristic picks the largest visible one. When
  that is wrong, write an adapter (`src/profiles/sites/<id>.mjs`) and let the adapter selectors win.
- A login wall stops the drive before anything is typed; sign in once in that tab and re-run.

## Probing a site before writing an adapter

```powershell
node scripts/probe-site.mjs chatgpt
node scripts/probe-site.mjs claude --reload --wait 8
```

`scripts/probe-site.mjs <site|url>` is read-only: it never types, never sends, never clicks a send
control, never dispatches input events. It reuses an existing tab for the host, writes one JSON file
per site to `docs/research/probe/` (override with `--out DIR`), and closes only a tab it opened
unless `--keep-open`. Flags: `--port N`, `--out DIR`, `--wait S`, `--keep-open`, `--reload`. Exit
`0` success, `3` site unreachable or login-walled, `5` no CDP endpoint. The committed files under
`docs/research/probe/` are the evidence the adapters were written from.
