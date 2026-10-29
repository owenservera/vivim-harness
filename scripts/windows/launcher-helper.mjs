// Small Node helpers for scripts/windows/VIVIM.ps1. They live in a file (not `node -e`) so
// Windows PowerShell 5.1 argument quoting can never mangle the code, and secrets travel only
// through the environment, never through process arguments.
//
//   node launcher-helper.mjs verify <profileDir> <cdpPort>
//       Read-only: exit 0 when the browser on <cdpPort> is the dedicated VIVIM profile.
//   node launcher-helper.mjs spawn <cliPath> <cdpPort> <studioPort> <logFile> [lan]
//       Start `studio serve` detached and hidden, so it survives the launcher window.
//       The data folder comes from CAPTURE_STUDIO_HOME (inherited); prints {"pid":N}.
//   node launcher-helper.mjs qr
//       Print a terminal QR code for VIVIM_QR_TEXT (env, so the token is not in argv).
import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import path from 'node:path';

const [cmd, ...args] = process.argv.slice(2);

try {
  if (cmd === 'verify') {
    const { verifyBrowserOwner } = await import('../../src/chrome/browser-ownership.mjs');
    const [profileDir, port] = args;
    try {
      await verifyBrowserOwner({ profileDir, port: Number(port) });
      console.log('The dedicated VIVIM browser is already open.');
    } catch {
      console.error('A browser is using the VIVIM connection, but it is not the dedicated VIVIM browser for this data folder.');
      process.exitCode = 1;
    }
  } else if (cmd === 'spawn') {
    const [cli, cdpPort, studioPort, logFile, lan] = args;
    mkdirSync(path.dirname(logFile), { recursive: true });
    // Unique per launcher attempt, so another double-click cannot erase the owner's pairing link.
    const fd = openSync(logFile, 'wx');
    const argv = [cli, 'serve', '--port', String(cdpPort), '--studio-port', String(studioPort), '--no-open', ...(lan === 'lan' ? ['--lan-pair'] : [])];
    const child = spawn(process.execPath, argv, { cwd: path.dirname(path.dirname(cli)), detached: true, windowsHide: true, stdio: ['ignore', fd, fd], env: process.env });
    child.once('error', (error) => { closeSync(fd); console.error(`Could not start VIVIM: ${error.message}`); process.exitCode = 1; });
    child.once('spawn', () => { closeSync(fd); child.unref(); console.log(JSON.stringify({ pid: child.pid })); });
  } else if (cmd === 'qr') {
    const { qrToTerminal } = await import('../../src/studio/lan-pair.mjs');
    const text = process.env.VIVIM_QR_TEXT;
    if (!text) throw new Error('nothing to show');
    console.log(qrToTerminal(text));
  } else {
    console.error('usage: launcher-helper.mjs verify|spawn|qr');
    process.exitCode = 2;
  }
} catch (error) {
  console.error(error?.message ?? String(error));
  process.exitCode = 1;
}
