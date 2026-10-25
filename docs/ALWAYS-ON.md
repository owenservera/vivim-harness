# Always-on capture (runbook)

Short guide to the always-on supervisor of Capture Studio. No flags other than the ones listed here exist.

## What runs

`node scripts/always-on.mjs` is the supervisor. It:

1. probes the DevTools port before every spawn. If a browser is already serving it, that browser is
   left completely alone (never restarted, killed or re-profiled). If nothing answers and
   `--chrome-profile` was given, it starts the dedicated capture browser itself (see
   [Ensure the browser](#ensure-the-browser-ensure-chrome));
2. runs the recorder against that browser, one recording session at a time;
3. restarts the recorder forever — there is no give-up state (see [Retry policy](#retry-policy)).

The CDP port defaults to **9222** and can be changed with `--port N` or the environment variable
`CAPTURE_STUDIO_CDP_PORT` (see `src/config.mjs`, key `cdpPort`).

## Start it now

```powershell
node scripts\always-on.mjs
```

Flags: `--tabs all|one`, `--rotate-min N`, `--max-mb N`, `--port N`, `--chrome-profile DIR`,
`--ensure-chrome` / `--no-ensure-chrome`, `--data-dir DIR`, `--status`, `--stop`, `--once`,
`--dry-run`, `--json`.

```powershell
node scripts\always-on.mjs --status   # supervisor state
node scripts\always-on.mjs --stop     # stop the supervisor and the recorder (graceful)
node scripts\always-on.mjs --dry-run --chrome-profile "%LOCALAPPDATA%\chrome-cdp-profile"
```

The supervisor runs in the foreground; close it with Ctrl+C, or stop it from anywhere with
`--stop`.

`--dry-run` prints the resolved settings, the exact recorder argv and the exact Chrome argv it would
use, then exits 0 without spawning anything. Run it first when a setting looks wrong.

## Ensure the browser (`--ensure-chrome`)

`--chrome-profile DIR` names the dedicated Chrome profile. With that flag, ensure-chrome defaults to
**on**: the supervisor probes `127.0.0.1:<port>/json/version` before each spawn and, only when
nothing answers, creates `DIR` if missing, resolves `chrome.exe` (`CHROME_PATH`, then the usual
install locations — the same lookup as `src/chrome/launch.mjs`) and starts it detached with

```
--remote-debugging-port=<port> --remote-debugging-address=127.0.0.1
--user-data-dir="DIR" --no-first-run --no-default-browser-check --restore-last-session
```

It then waits up to 25 s for the port and logs the outcome. A browser that is already serving the
port is never touched. Without `--chrome-profile` there is no profile to open, so nothing is
launched; `--no-ensure-chrome` disables the launch step explicitly (the recorder then fails fast and
retries, as before).

## Pin the launcher (`scripts/chrome-cdp.ps1`)

A debug port only exists if Chrome was *started* with `--remote-debugging-port`. Any ordinary Chrome
launch — taskbar, Start menu, a link in another app — starts the browser **without** the port, so
capture loses its browser even though Chrome is running. Pin this script (shortcut, taskbar) and the
port comes back the same way every time:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\chrome-cdp.ps1
npm run chrome:cdp
```

Parameters: `-Port` (default 9222) and `-Profile` (default `%LOCALAPPDATA%\chrome-cdp-profile`).
If the port already answers it prints `already attached on <port>` and starts nothing. Otherwise it
creates the profile as a **directory junction** to `%LOCALAPPDATA%\Google\Chrome\User Data` (so your
existing sign-ins are used) and refuses with an explanation if that path exists but is not a
junction, launches Chrome with the flags above, waits up to 25 s, then prints the profile path, the
pid and `OK`. PowerShell 5.1, no admin.

## Background capture, foreground drive

Capture reads a tab over CDP and needs nothing from the window: a background capture is fine, and the
supervisor is happy with the browser behind other windows. **A background drive is not.**

- A tab that is not the active tab reports `document.visibilityState === "hidden"`, and Chrome does
  not deliver synthetic key input to a hidden tab. Measured on Chrome 155 on this machine:
  `Input.insertText` still wrote into the composer while `Input.dispatchKeyEvent` keystrokes were
  silently dropped, so the drive looked like it typed and sent but nothing arrived.
- `Emulation.setFocusEmulationEnabled` makes `document.hasFocus()` return `true` even while the tab
  is hidden, so `hasFocus()` is not a sufficient signal; `visibilityState` is. See
  [`HUMAN-INTERACTION.md`](HUMAN-INTERACTION.md#visibility-and-focus).
- A window that is occluded by another window reports every page as hidden, and `Page.bringToFront`
  only switches tabs inside the browser. A drive therefore opens its own tab, which is visible by
  construction, and closes it when the drive ends.

If the window has to be brought forward for a drive:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\focus-chrome.ps1
```

It restores and raises the Chrome window from the OS (`ShowWindow(SW_RESTORE)`, `BringWindowToTop`,
`SetForegroundWindow` with `AttachThreadInput`), accepts `-ProcessId` and `-Title`, and exits `0`
when the window is in front, `1` when it is not or no Chrome window was found.

## Stopping is graceful

`--stop` writes a stop request to `<data dir>\always-on.stop`; the supervisor notices it within
500 ms, sends `{ type: 'stop' }` over the recorder's IPC channel, and waits up to **30 s** for it to
exit. `bin/studio.mjs` turns that message into the same SIGINT event Ctrl+C produces, so
`session.json` ends with `"status": "complete"` plus `endedAt` and the raw segment is closed. Only
if the recorder ignores the request is it force-killed (`taskkill /PID <pid> /T /F` on Windows,
`child.kill()` elsewhere), and the log says which path was taken. This replaces the old
`process.kill(child, 'SIGINT')` behaviour, which on Windows terminated the recorder outright and left
sessions stuck at `"recording"` with `records: 0`.

## Retry policy

The supervisor never gives up. A cycle shorter than 60 s counts as a failure and raises the backoff
through 2, 4, 8, 16, 32, 60 s; it stays at 60 s and keeps retrying. Every 10th consecutive failure
logs one `warn` line with the count and the last error line, so a closed browser or a logged-out
profile shows up in `always-on.log` without flooding it.

## Install / remove autostart (per user, no admin)

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-autostart.ps1 -Install
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-autostart.ps1 -Status
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-autostart.ps1 -Start
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-autostart.ps1 -Stop
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-autostart.ps1 -Remove
```

The task is named `CaptureStudio-AlwaysOn`. It triggers at logon of the current user, runs
`node.exe scripts\always-on.mjs` hidden, with the capture-studio root as working directory, an
unlimited execution time limit, and restarts up to 999 times, once a minute. It is not stopped on
battery or idle. Running `-Install` again replaces the existing task.

## Where the data lives

The data directory is `%LOCALAPPDATA%\AION\capture-studio` on Windows (override with the
environment variable `CAPTURE_STUDIO_HOME`). `node bin\studio.mjs paths` prints the resolved paths.

| Item | Path |
| --- | --- |
| Supervisor log | `<data dir>\always-on.log` |
| Supervisor state | `<data dir>\always-on.json` |
| Sessions | `<data dir>\sessions\<session-id>\` (`session.json`, `raw\`) |
| Capture browser profile | `<data dir>\chrome-profile\` |

## How sessions rotate

A recording session ends when either limit is reached, whichever comes first:

- **duration** — `--rotate-min N`: the session is closed after N minutes and a fresh session starts;
- **size** — `--max-mb N`: the session is closed cleanly when its raw data reaches N MB.
  `--max-mb 0` means no size limit (the default per-session quota in `src/config.mjs` is `maxMb = 0`, unlimited).

Each finished session lands in `<data dir>\sessions\<session-id>\`.

## Verify it is really capturing

```powershell
node bin\studio.mjs session list
node bin\studio.mjs targets
```

`session list` shows the saved recordings (newest first); `targets` shows the tabs of the capture
browser that can be recorded.

## Failure triage

| Symptom | Action |
| --- | --- |
| Nothing captured / no browser seen | `node bin\studio.mjs doctor` (checks Node, Chrome, DevTools, data folder, learner, profiles) |
| No browser after closing Chrome | Pin `scripts\chrome-cdp.ps1` (`npm run chrome:cdp`); with `--chrome-profile` the supervisor also starts the browser itself |
| CDP port busy or wrong browser attached | Use a different port: `node scripts\always-on.mjs --port 9333` |
| Session stuck at `"recording"`, `records: 0` | Old abrupt-kill symptom; stop with `node scripts\always-on.mjs --stop` (graceful, IPC) instead of closing the console |

## Security note

The DevTools port is bound to **127.0.0.1** (loopback only) and grants **full control of that
browser profile to any local process**. Any program running as any user on this machine can attach
to the port and read or drive the capture browser, including its signed-in sessions and cookies. Keep
the machine account trusted; close the capture browser when it is not needed.

## Browser closed vs. open

| Step | Capture browser |
| --- | --- |
| `-Install`, `-Status`, `-Remove`, `-Start`, `-Stop` of the task | may stay open |
| `node scripts\always-on.mjs` (start) | may stay open — the supervisor attaches to it |
| Changing the port (`--port`) | **close it first** — the dedicated profile cannot be opened twice, so a second Chrome on another port would fail to start |
| Uninstall (below) | **close it first** |

## Uninstall

```powershell
# 1. stop the supervisor and the scheduled task
node scripts\always-on.mjs --stop
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-autostart.ps1 -Stop
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-autostart.ps1 -Remove

# 2. close the capture browser window (it holds the profile lock)

# 3. optionally delete the captured data
#    %LOCALAPPDATA%\AION\capture-studio
```

Removing the scheduled task stops the automatic start; deleting the data directory removes the
captured sessions, the logs and the capture browser profile.
