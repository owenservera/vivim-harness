# Open VIVIM on Windows

1. Install **Node.js 22 or newer** from <https://nodejs.org> and Google Chrome (or Edge).
2. Keep the VIVIM download together in one folder. Open `scripts/windows` and double-click **VIVIM.cmd**.
3. Your **World** opens in your default browser. Keep the VIVIM window open while using it.
4. In the separate, dedicated VIVIM browser, sign in to ChatGPT or Claude yourself. VIVIM uses your own website accounts, not API keys. Never give VIVIM your password. A connected browser does not by itself prove you are signed in.

## Add a Desktop and Start Menu shortcut

Right-click `install-shortcut.ps1` in `scripts/windows` and choose **Run with PowerShell**. It creates **VIVIM** shortcuts for your Windows user, without administrator access. Keep the installation folder in place afterwards. Running it again refreshes the shortcuts.

If Windows blocks the script, open PowerShell in that folder and run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install-shortcut.ps1
```

## Existing VIVIM and saved sign-ins

The launcher checks Studio health on ports **38703, 38710 and 7878** (and a custom `-StudioPort` first). If it finds VIVIM, it only opens that World: it does not start another Studio or browser. Pair in the World if prompted. An authenticated existing Studio needs its `CAPTURE_STUDIO_TOKEN` in the launcher's environment for discovery; no token is saved in shortcuts or printed in URLs. An occupied but unverifiable port stops startup rather than risking another owner.

For a new start the default data folder is **C:\VIVIM**, or `CAPTURE_STUDIO_HOME` if set. The dedicated browser profile is `chrome-profile` inside that folder. Keep using the **same data folder** to preserve sign-ins. Never delete the profile as a connection fix. If port 38702 is occupied, VIVIM checks the browser's native ownership marker and identity before reusing it; an unverified browser is left untouched. If the browser is absent, VIVIM launches it using that same profile.

To use an older installation's data folder:

```powershell
.\VIVIM.ps1 -DataDir 'C:\path\to\your\existing\data'
```

The launcher never closes a browser, stops a Studio, sends an AI message, or signs in on your behalf. If the dedicated browser goes missing while Studio is running, use that running VIVIM's browser recovery controls; the launcher deliberately does not start another controller.

## Safe preview (does not launch or open anything)

```powershell
.\VIVIM.ps1 -DryRun
.\install-shortcut.ps1 -DryRun
```

Preview still checks Node, running Studio and browser ownership. It prints the existing World it would open, or the startup steps it would take. For a more detailed connection report, run `node bin/studio.mjs doctor --port 38702 --json`; its connection check is not proof of sign-in or browser ownership.
