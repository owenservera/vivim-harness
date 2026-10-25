import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CdpConnection } from '../../src/cdp/client.mjs';
import { browserVersion, listTargets, isReachable } from '../../src/cdp/discovery.mjs';

export const CHROME = process.env.CHROME_PATH;
export const hasChrome = !!CHROME && existsSync(CHROME);

export async function launchHeadless(url, port) {
  if (await isReachable({ port })) throw new Error(`Refusing an already occupied DevTools port ${port}`);
  const prof = mkdtempSync(path.join(os.tmpdir(), 'cs-chrome-'));
  const child = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1', `--user-data-dir=${prof}`, '--no-first-run', url], { stdio: 'ignore' });
  let exited = null;
  child.on('exit', (code) => { exited = code; });
  for (let i = 0; i < 150 && !(await isReachable({ port })); i++) {
    if (exited !== null) throw new Error(`Chromium exited early (code ${exited}) on port ${port}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!(await isReachable({ port }))) throw new Error(`Chromium did not expose DevTools on 127.0.0.1:${port} within 15 s`);
  // kill() also removes the throwaway user-data-dir once the browser has actually exited.
  const rmProf = () => { try { rmSync(prof, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* best effort */ } };
  child.once('exit', rmProf);
  return { child, kill: () => {
    // Kill only this still-owned child handle, never a port-discovered PID or a process-name match.
    if (exited === null && child.exitCode === null && !child.killed) {
      if (child.spawnfile !== CHROME || !child.spawnargs.includes(`--user-data-dir=${prof}`)
        || !child.spawnargs.includes(`--remote-debugging-port=${port}`)) throw new Error('Disposable Chrome ownership mismatch');
      child.kill('SIGKILL');
    }
    if (exited !== null) rmProf();
  } };
}

// A separate DevTools client that plays the role of the human using the page.
export async function userDriver(port, urlPart) {
  const v = await browserVersion({ port });
  const conn = await CdpConnection.connect(v.webSocketDebuggerUrl);
  const t = (await listTargets({ port })).find((x) => x.url.includes(urlPart));
  const s = await conn.attach(t.id);
  await s.send('Runtime.enable');
  return {
    targetId: t.id,
    eval: async (expr) => (await s.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.value,
    reload: () => s.send('Page.reload'),
    close: () => conn.close(),
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function waitFor(fn, ms = 10000) { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(50); } return false; }
