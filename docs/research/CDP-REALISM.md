# CDP Realism — Driving a Real, Logged-In Chrome Like a Human

**Status:** research note, late 2026 · **Scope:** Chrome DevTools Protocol (CDP) input synthesis against the owner's own logged-in Chrome profile, for capturing streamed responses from AI chat web apps.
**Evidence grades:** `CONFIRMED` = stated by a primary/official source and cited inline. `UNVERIFIED` = plausible but not proven here; the verification method is given.

---

## 1. Why this document exists

Plainly writing `.value` / `textContent` on a ProseMirror-style composer does not reach the app's internal editor state, so `Enter` does nothing. `Input.insertText` does reach app state but emits **no key events** — the protocol itself describes it as emulating "inserting text that doesn't come from a key press, for example an emoji keyboard or an IME" ([Input domain](https://chromedevtools.github.io/devtools-protocol/tot/Input)). `Input.dispatchKeyEvent` with a `text` payload produces real `keydown`/`keypress`/`keyup` plus `input` **and** inserts the text — this is what Playwright's `keyboard.type` does. Everything below builds on that fact.

## 2. Launch posture

- **Do not pass `--enable-automation`.** In Chrome, `navigator.webdriver` is `true` when "the `--enable-automation` or `--headless` flag is used, or the `--remote-debugging-port` flag specifying port 0 is used" ([MDN: Navigator.webdriver](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/webdriver)). That sentence contains a second trap worth acting on: **use a fixed debugging port (e.g. `9222`), never `--remote-debugging-port=0`**, or you set the automation flag without any automation switch. `CONFIRMED` (MDN).
- **Chrome 136+ refuses to debug the default profile.** From Chrome 136, `--remote-debugging-port` and `--remote-debugging-pipe` "will no longer be respected if attempting to debug the default Chrome data directory… must now be accompanied by the `--user-data-dir` switch" ([Chrome for Developers, 2025-03-17](https://developer.chrome.com/blog/remote-debugging-port)). The junction-path `--user-data-dir` already used on this machine is the sanctioned workaround, not a hack. `CONFIRMED`.
- **Consequence:** a CDP-attached, non-automated Chrome should report `navigator.webdriver === false`. `CONFIRMED` by MDN's flag list; worth re-asserting per run via `Runtime.evaluate`.

## 3. Method reference (exact names and parameters)

Field names below are the JSON wire names, taken from the generated protocol bindings ([chromedp/cdproto/input](https://pkg.go.dev/github.com/chromedp/cdproto/input)) and the protocol docs.

### 3.1 `Input.dispatchKeyEvent`

`type` (`keyDown` | `keyUp` | `rawKeyDown` | `char`), `modifiers`, `timestamp`, `text`, `unmodifiedText`, `keyIdentifier`, `code`, `key`, `windowsVirtualKeyCode`, `nativeVirtualKeyCode`, `autoRepeat`, `isKeypad`, `isSystemKey`, `location`, `commands`.

Practical mapping used by real drivers: printable character → `keyDown` with `text` (this is what makes the browser fire `keypress` and edit the DOM), then `keyUp` without `text`. `Enter` → `rawKeyDown` with `windowsVirtualKeyCode: 13` and `text: "\r"`, then `keyUp`. `char` is legacy; prefer `keyDown` + `text`.

### 3.2 Modifiers bit field

| Bit | Value | Key |
|---|---|---|
| Alt | 1 | `Alt` |
| Ctrl | 2 | `Control` |
| Meta | 4 | `Meta` / `Command` |
| Shift | 8 | `Shift` |

Values are documented on the [Input domain](https://chromedevtools.github.io/devtools-protocol/tot/Input) as a bit field of "Alt=1, Ctrl=2, Meta/Command=4, Shift=8". Combine by addition (Ctrl+Shift = 10).

### 3.3 Other methods

| Method | Parameters | Notes | Landed |
|---|---|---|---|
| `Input.insertText` | `text` | Emulates non-keyboard insertion (IME/emoji). **No key events.** | ancient; exact milestone UNVERIFIED |
| `Input.dispatchMouseEvent` | `type` (`mousePressed`/`mouseReleased`/`mouseMoved`/`mouseWheel`), `x`, `y`, `modifiers`, `timestamp`, `button`, `buttons`, `clickCount`, `force`, `tangentialPressure`, `tiltX`, `tiltY`, `twist`, `deltaX`, `deltaY`, `pointerType` | `buttons` is the bitmask of *currently held* buttons (`1` = left) and must be set during press/move; `clickCount: 1` for a normal click | ancient; UNVERIFIED |
| `Emulation.setFocusEmulationEnabled` | `enabled` (boolean) | "Enables or disables simulating a focused and active page" | UNVERIFIED milestone |
| `Page.bringToFront` | none | Real window/ tab activation; cheap and side-effect-light | UNVERIFIED milestone |
| `Page.setWebLifecycleState` | `state`: `frozen` \| `active` | Forces a backgrounded tab back to `active` so `requestAnimationFrame` and streaming paint keep running | UNVERIFIED milestone |
| `Emulation.setAutomationOverride` | marked **Experimental**; "Allows overriding the automation flag" | **Exists.** Present in the official `tot` protocol ([Emulation domain](https://chromedevtools.github.io/devtools-protocol/tot/Emulation)) and present as a protocol string in the Chrome **155.0.8059.85** install on this machine (string-presence check, 2026-10-22) | exact milestone **UNVERIFIED** |
| `Emulation.setUserAgentOverride` | `userAgent`, `acceptLanguage`, `platform`, `userAgentMetadata` | "`userAgentMetadata` must be set for Client Hint headers to be sent" | UNVERIFIED milestone |
| `Emulation.UserAgentMetadata` | `brands`, `fullVersionList`, `fullVersion` (deprecated), `platform`, `platformVersion`, `architecture`, `model`, `mobile`, `bitness`, `wow64`, `formFactors` | Missing optional values are filled by the target with what it would normally use | — |
| `Runtime.addBinding` | `name`, `executionContextId` (deprecated), `executionContextName` | Survives reloads; each call emits `Runtime.bindingCalled` | UNVERIFIED milestone |
| `Page.addScriptToEvaluateOnNewDocument` | `source`, `worldName`, `includeCommandLineAPI`, `runImmediately` → returns `identifier` | Runs before any frame script | UNVERIFIED milestone |

**Client-hints consistency trap.** If you change the UA string you must also supply `userAgentMetadata`, or `Sec-CH-UA*` headers keep advertising the real brand/version while `navigator.userAgent` says something else — an instantly visible mismatch. Our position: **do not spoof at all.** We are on the owner's genuine Chrome, so the honest values are already internally consistent.

**`setAutomationOverride` caveat.** The parameter is a single boolean (name UNVERIFIED — read it from `tot/Emulation` before shipping), and the doc says only "overriding the automation flag". Whether it flips `navigator.webdriver` specifically, Blink's automation-controlled state, or both, is **UNVERIFIED**. Verification: attach, set it both ways, and read `navigator.webdriver` plus the rendered event behaviour. It is a *repair* for an already-wrong posture, not a substitute for launching cleanly.

## 4. Detection surface

| Signal | What a page sees | Grade |
|---|---|---|
| `navigator.webdriver` | `true` with `--enable-automation`, `--headless`, or `--remote-debugging-port=0` | **CONFIRMED** — [MDN](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/webdriver) |
| Automation infobar | "Chrome is being controlled by automated test software" — implies `--enable-automation` | **CONFIRMED** — [rebrowser-patches](https://github.com/rebrowser/rebrowser-patches) |
| `Runtime.enable` leak | Page code observes the console/stack side effects of the `Runtime` domain being enabled; "used by all major anti-bot software such as Cloudflare, DataDome" | **CONFIRMED** — [rebrowser-patches](https://github.com/rebrowser/rebrowser-patches); origin: [DataDome research](https://datadome.co/threat-research/how-new-headless-chrome-the-cdp-signal-are-impacting-bot-detection/) |
| Script-source leakage | Puppeteer's `//# sourceURL=pptr:…` and Playwright's `UtilityScript` helper are visible in `new Error().stack` | **CONFIRMED** — same source |
| `HeadlessChrome` in UA | Only in headless mode; absent from a real profile | **CONFIRMED** — same source |
| Launch switches a page can notice | `--disable-popup-blocking` (popups open without a click), `--disable-ipc-flooding-protection` (URL-update flood visible), Playwright's `ThirdPartyStoragePartitioning` disable (cross-site iframe can read `localStorage`) | **CONFIRMED** — same source |
| `cdc_*` globals | ChromeDriver/Selenium artifact, **not** a CDP artifact; should be absent when driving CDP directly | mechanism CONFIRMED, absence here **UNVERIFIED** — verify with a `window`/`document` key scan |
| Missing plugins/languages, odd `screen`/WebGL | Headless artifacts; not expected on a real profile | N/A for this setup, **UNVERIFIED** per-profile |
| DevTools-open heuristics (`debugger` timing, console width) | Heavy false positives; no credible modern consensus | **UNVERIFIED** |
| `document.hasFocus()` / `visibilityState` | A backgrounded tab reports `false`/`hidden`, so input is dropped or the app pauses | mechanism **CONFIRMED** by spec; per-tab state **UNVERIFIED** |
| `event.isTrusted` | CDP `Input.*` events are browser-generated, so `isTrusted === true`, unlike `dispatchEvent()` | **CONFIRMED** in principle; verify per event type on host |

**Headline answer:** with no automation flags and no `Runtime.enable`, the *state* a page reads (`webdriver`, UA, plugins, headers) is identical to a normal browser. What can still differ is the **timing and shape** of events, and any **protocol side effect** you opted into by calling `Runtime.enable` or injecting script. So the residual risk is behavioural plus `Runtime`-domain, not fingerprint.

## 5. Recommended event sequence

1. **Activate the tab.** `Page.bringToFront`; if the window is genuinely backgrounded, `Page.setWebLifecycleState {state:"active"}` and `Emulation.setFocusEmulationEnabled {enabled:true}`. Never type into an unfocused document.
2. **Warm-up pointer.** 1–2 `mouseMoved` events over a neutral area so the page's pointer history exists before the first click.
3. **Approach.** Bezier path from the previous position to the composer centre: 18–35 `mouseMoved` steps, 8–22 ms apart, with 1–2 sub-pixel jitters. Land slightly off-centre (±2–4 px).
4. **Click to focus.** `mousePressed` (`buttons:1`, `clickCount:1`) → 60–140 ms → `mouseReleased` (`buttons:0`). Hover 250–600 ms first. This is the *only* legitimate way to focus a composer.
5. **Type.** Per character: `keyDown` with `text` → 55–165 ms → `keyUp`. Longer pauses at word boundaries (120–320 ms) and at sentence punctuation (600–1500 ms). Scale the whole cadence by ±15 % per session so no two runs share a signature.
6. **One correction.** At a ~1-in-100-character rate, type a wrong neighbour key, pause 140–380 ms ("noticing"), then `Backspace` (`rawKeyDown` keyCode 8) ×1–3 at 90–220 ms.
7. **Read before sending.** 1.2–4.5 s pause, then optionally a small scroll or a `mouseMoved` drift — a human re-reads.
8. **Send by mouse** on the actual send button: hover → press → release. Only fall back to `Enter` if the button is not clickable.
9. **Wait, then read.** After send, do nothing for 0.8–2.0 s; then poll the DOM every 180–400 ms (jittered). Do not poll at a fixed 100 ms.
10. **Scroll while streaming** with `mouseWheel` (`deltaY` 90–180) in 3–6 ticks, 40–120 ms apart.

## 6. What to avoid

- **Instant value writes** (`el.value = …`, `textContent`, `execCommand`, framework setters) — bypasses editor state and produces zero key events.
- **Zero-delay key bursts** or loop-with-no-await; typing 100 characters in under a second.
- **`Input.insertText` for the main body** — correct text, no `keydown`/`keypress`, so a page logging keystroke cadence sees nothing.
- **Sending via a click on a different element** than the one you hovered, or dispatching into a hidden/`display:none` node.
- **No focus step** — input into `document.activeElement === body`.
- **`--enable-automation`, `--headless`, `--remote-debugging-port=0`.**
- **`Runtime.enable` when you can avoid it**; prefer `Page.addScriptToEvaluateOnNewDocument` + a soberly named `Runtime.addBinding` (note a binding briefly exposes a global).
- **UA spoofing without `userAgentMetadata`**, or any fingerprint patch that leaves `Function.prototype.toString` inconsistencies — rebrowser notes stealth plugins are themselves detectable ("`nativeTampering` and `workerConsistency` red").

## 7. Recommended parameter table

| Parameter | Recommended | Rationale |
|---|---|---|
| Key delay (inter-character) | **55–165 ms**, mean ≈ 95 ms, lognormal-skewed | Adult typing is 150–300 CPM; uniform random is itself a fingerprint, so bias toward the short end with a long tail |
| Word pause (after space) | **120–320 ms**, scaled by word length | Boundary hesitation is the strongest human cue after raw speed |
| Sentence pause (after `.`/`,`/`?`) | **600–1500 ms** | Thinking time; comma pauses at the low end, terminal punctuation at the high end |
| Typo rate | **1 per 80–120 characters**, corrected | Perfect transcription over long text is rare |
| Correction pauses | notice **140–380 ms**, backspace **90–220 ms** | Reads as "spot and fix", not scripted undo |
| Pre-send "think" pause | **1.2–4.5 s** | Scales with prompt length; sub-second sends look like paste-and-submit bots |
| Mouse move steps | **18–35**, 8–22 ms/step, 2–4 px landing error | Below ~12 steps the path is visibly a straight line; above ~40 it looks like interpolation |
| Hover before click | **250–600 ms** | Humans acquire then act |
| Press→release | **60–140 ms** | Real clicks are not 0 ms |
| Scroll | **3–6 wheel ticks**, `deltaY` 90–180, 40–120 ms apart | Fixed 100 px × N is a synthetic read pattern |
| Post-send silence | **0.8–2.0 s** | Streaming UI needs a beat to start |
| DOM poll interval | **180–400 ms**, jittered | Constant-interval polling is trivially detectable in page timers |
| Per-session cadence jitter | **±15 %** on all ranges | Prevents cross-run correlation |
| Debug port | **fixed, e.g. 9222** (never `0`) | Port 0 sets `navigator.webdriver` per MDN |

## 8. Open questions

1. Exact Chrome milestone for `Emulation.setAutomationOverride` and for each `Emulation`/`Page`/`Runtime` method above. **Verification:** check `json/browser_protocol.json` per Chrome-for-Testing milestone tag in `ChromeDevTools/devtools-protocol`, or read the schema from `/json/protocol` of the running browser and bisect.
2. Whether `setAutomationOverride` changes `navigator.webdriver` or only Blink's internal automation state. **Verification:** A/B on a live target, reading `navigator.webdriver` and inspecting `event.isTrusted`/key-event flow.
3. Whether *any* page-observable difference remains with zero automation flags and no `Runtime.enable` on this exact Chrome build. **Verification:** run a local detector page (e.g. `bot-detector.rebrowser.net`) in both a clean and a CDP-attached context of the same profile and diff the results.
4. Whether Cloudflare/DataDome-style checks fire purely on input cadence for chat UIs. **Verification:** none available offline; treat behavioural realism as risk reduction, not proof of non-detection.
