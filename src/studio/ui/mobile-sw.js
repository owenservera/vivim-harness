// VIVIM Mobile shell service worker. Caches ONLY the read-only shell (page + module) so the app
// opens offline-capable. It deliberately has no handler for /api/ or any non-GET request: every
// state-changing call, and every API read, goes straight to the live server and is never queued,
// cached or replayed. Network-first so edits on the PC are picked up; cache is the offline fallback.
const CACHE = 'vivim-mobile-shell-v4';
const SHELL = new Map([
  ['/mobile', 'text/html'], ['/ui/mobile.mjs', 'text/javascript'],
  ['/mobile.webmanifest', 'application/manifest+json'],
]);
// A redirect, JSON error or a response from another endpoint is never a shell asset.
const isShell = (response, path) => response.ok && !response.redirected
  && new URL(response.url).origin === self.location.origin
  && new URL(response.url).pathname === path
  && response.headers.get('content-type')?.split(';')[0].trim() === SHELL.get(path);
async function fetchShell(request) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 8000);
  try { return await fetch(request, { signal: controller.signal, cache: 'no-store', credentials: 'same-origin' }); }
  finally { clearTimeout(timer); }
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    for (const path of SHELL.keys()) {
      try {
        const response = await fetchShell(path);
        if (isShell(response, path)) await cache.put(path, response);
      } catch { /* shell caching is best effort; the page still works online */ }
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('vivim-mobile-shell-') && key !== CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return; // never touch mutations
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !SHELL.has(url.pathname)) return; // APIs and everything else: network, untouched
  // Pairing links must reach the PC to set the cookie. Never disguise failed pairing with an offline shell.
  if (url.searchParams.has('token')) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE).catch(() => null);
    try {
      const response = await fetchShell(request);
      if (cache && isShell(response, url.pathname)) {
        event.waitUntil(cache.put(url.pathname, response.clone()).catch(() => {}));
      }
      return response; // 401/other statuses pass through uncached
    } catch (error) {
      const cached = await cache?.match(url.pathname);
      if (cached && isShell(cached, url.pathname)) return cached;
      throw error;
    }
  })());
});
