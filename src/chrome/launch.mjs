// Launch a dedicated, loopback-only Chrome profile for capture.
// Chrome 136+ refuses remote debugging on the default profile, so a separate --user-data-dir
// is both required and safer: the person signs in to the sites they want captured once, there.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { isReachable, browserVersion, waitForReachable, discoveryProbe } from '../cdp/discovery.mjs';

export function chromeCandidates(env = process.env, platform = process.platform) {
  const c = [];
  if (env.CHROME_PATH) c.push(env.CHROME_PATH);
  if (platform === 'win32') {
    for (const base of [env['PROGRAMFILES'], env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean)) {
      c.push(path.win32.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'));
      c.push(path.win32.join(base, 'Google', 'Chrome Beta', 'Application', 'chrome.exe'));
      c.push(path.win32.join(base, 'Google', 'Chrome SxS', 'Application', 'chrome.exe'));
      c.push(path.win32.join(base, 'Chromium', 'Application', 'chrome.exe'));
      c.push(path.win32.join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    }
  } else if (platform === 'darwin') {
    c.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    c.push('/Applications/Chromium.app/Contents/MacOS/Chromium');
  } else {
    c.push('/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser');
  }
  return c;
}

export function findChrome() {
  const hit = chromeCandidates().find((p) => p && existsSync(p));
  if (!hit) throw new Error('Chrome not found. Set CHROME_PATH to chrome.exe.');
  return hit;
}

export async function launchChrome({ profileDir, port = 9222, url = 'about:blank', headless = false, extraArgs = [] } = {}) {
  if (await isReachable({ port })) {
    const v = await browserVersion({ port });
    return { alreadyRunning: true, port, browser: v.Browser, pid: null };
  }
  mkdirSync(profileDir, { recursive: true });
  const exe = findChrome();
  // Local-integrator escape hatch (owner machines and synthetic-https test fixtures): extra,
  // explicitly operator-provided Chrome flags. Opt-in via environment only; never set by
  // Capture Studio itself, and the listener stays loopback-only regardless of the flags.
  const envArgs = String(process.env.CAPTURE_STUDIO_CHROME_ARGS ?? '').split(/\s+/).filter(Boolean);
  const args = [
    `--remote-debugging-port=${port}`,
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    ...(headless ? ['--headless=new'] : []),
    ...extraArgs,
    ...envArgs,
    url,
  ];
  const child = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
  for (let i = 0; i < 60; i++) {
    if (await isReachable({ port })) {
      const v = await browserVersion({ port });
      return { alreadyRunning: false, port, browser: v.Browser, pid: child.pid, exe, profileDir };
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Chrome started (pid ${child.pid}) but DevTools did not answer on 127.0.0.1:${port}. Close other Chrome windows using that profile and retry.`);
}

// Attach if DevTools is already listening, otherwise launch and wait for it. Retries the launch
// once, because a profile that was closed uncleanly can refuse the first start.
export async function ensureChrome({ profileDir, port = 9222, url = 'about:blank', headless = false, extraArgs = [], attempts = 2, readyTimeoutMs = 20_000 } = {}) {
  let last;
  for (let i = 1; i <= attempts; i++) {
    try {
      const r = await launchChrome({ profileDir, port, url, headless, extraArgs });
      if (await waitForReachable({ port }, { timeoutMs: readyTimeoutMs })) return { ...r, attempt: i };
      last = new Error('DevTools endpoint did not become reachable');
    } catch (e) { last = e; }
    await new Promise((r) => setTimeout(r, 500 * i));
  }
  throw new Error(`Could not get a usable DevTools endpoint on 127.0.0.1:${port}: ${last?.message ?? last}`);
}

// Is a browser already serving DevTools on this port, and is it the profile we expect?
export async function chromeStatus({ port = 9222, profileDir = null } = {}) {
  const probe = await discoveryProbe({ port });
  return {
    port,
    reachable: probe.reachable,
    browser: probe.browser ?? null,
    protocol: probe.protocol ?? null,
    pages: probe.counts?.page ?? 0,
    targets: probe.counts ?? {},
    latencyMs: probe.latencyMs ?? null,
    error: probe.error ?? null,
    expectedProfileDir: profileDir,
    executable: (() => { try { return findChrome(); } catch { return null; } })(),
  };
}

// Available Chrome-family builds on this machine (first entry is the one launchChrome would use).
export function chromeInstalls(env = process.env, platform = process.platform) {
  return chromeCandidates(env, platform).filter((p) => p && existsSync(p));
}
