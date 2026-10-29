# Open VIVIM on Windows

1. Install **Node.js 22 or newer** from <https://nodejs.org> and Google Chrome (or Edge).
2. Keep the VIVIM download together in one folder. Open `scripts/windows` and double-click **VIVIM.cmd**.
3. Your **World** opens in your default browser. Studio keeps running in the background after you close the launcher window.
4. In the separate, dedicated VIVIM browser, sign in to ChatGPT or Claude yourself. VIVIM uses your own website accounts, not API keys. Never give VIVIM your password. A connected browser does not by itself prove you are signed in.

## Add a Desktop and Start Menu shortcut

Right-click `install-shortcut.ps1` in `scripts/windows` and choose **Run with PowerShell**. It creates **VIVIM** on the Desktop, plus **VIVIM**, **VIVIM phone pairing** and **Stop VIVIM** in the Start Menu, without administrator access. Keep the installation folder in place afterwards. Running it again refreshes the shortcuts.

If Windows blocks the script, open PowerShell in that folder and run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install-shortcut.ps1
```

## Existing VIVIM and saved sign-ins

The launcher checks the browser owner's Studio port first, then **38730, 38703, 38710 and 7878** (with a custom `-StudioPort` before the defaults). New Studio instances use **38730**. If it finds VIVIM, it opens that World without starting another Studio or browser. It waits for `/api/v1/health` before opening a newly started World. If native launch or Studio refuses because another Studio owns the browser, it waits for and reuses that owner. A starting owner is never bypassed with a second controller.

Pair in the World if prompted. The launcher can recover the pairing link from a Studio it started, or use `CAPTURE_STUDIO_TOKEN`. A token-protected owner can be reused without that token, but you may need your existing pairing link to enter World. An unverified occupied port stops startup rather than risking another owner.

For a new start the default data folder is **C:\VIVIM**, or `CAPTURE_STUDIO_HOME` if set. The dedicated browser profile is `chrome-profile` inside that folder. Keep using the **same data folder** to preserve sign-ins. Never delete the profile as a connection fix. If port 38702 is occupied, VIVIM checks the browser's native ownership marker and identity before reusing it; an unverified browser is left untouched. If the browser is absent, VIVIM launches it using that same profile.

To use an older installation's data folder:

```powershell
.\VIVIM.ps1 -DataDir 'C:\path\to\your\existing\data'
```

Children inherit `CAPTURE_STUDIO_HOME`; the browser command is `node bin/studio.mjs launch --port 38702` (never `--data-dir`). Studio uses `serve --studio-port 38730 --port 38702 --no-open`. Installation and data paths may contain spaces. Startup checks for Node.js 22 or newer and explains how to install it if missing or outdated.

The start action never closes a browser, sends an AI message, or signs in on your behalf. If the dedicated browser goes missing while Studio is running, use that running VIVIM's browser recovery controls; the launcher deliberately does not start another controller.

## Stop VIVIM

Double-click **Stop-VIVIM.cmd**, use the **Stop VIVIM** shortcut, or run `.\VIVIM.ps1 -Stop`. It stops only the Studio identified by this data folder's browser-owner lock, never Chrome. The browser and your sign-ins stay. A launcher record and matching process creation time identify a Studio started by this launcher. For any other owner, you must type **YES** to confirm; `-Force` does not bypass that confirmation. A recording must be stopped in World first (`-Force` overrides that recording guard). The launcher rechecks ownership before stopping anything and never kills processes by name or port.

## Use your phone (optional)

Open **VIVIM phone pairing** or run `.\VIVIM.ps1 -LanPair`. A new Studio starts with `--lan-pair`; the launcher prints the phone link and QR code and copies the link to your clipboard. Join the same WiFi and allow only private networks if Windows asks about the firewall. Anyone with the link can use your VIVIM while it runs: do not share it. The link is also stored in that Studio's local log under your data folder's `logs` directory; no token is stored in shortcuts or launcher state. If an existing Studio has no phone pairing, stop it explicitly first, then reopen with `-LanPair`; the launcher does not restart it automatically.

## Safe preview (does not launch or open anything)

```powershell
.\VIVIM.ps1 -DryRun
.\VIVIM.ps1 -DryRun -LanPair -DataDir 'C:\VIVIM data'
.\VIVIM.ps1 -Stop -DryRun
.\install-shortcut.ps1 -DryRun
```

Preview still checks Node, running Studio and browser ownership. It prints the existing World it would open, or the startup steps it would take. For a more detailed connection report, run `node bin/studio.mjs doctor --port 38702 --json`; its connection check is not proof of sign-in or browser ownership.
