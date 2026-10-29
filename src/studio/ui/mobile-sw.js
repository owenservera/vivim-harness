// VIVIM Mobile shell service worker. Caches ONLY the read-only shell (page + module) so the app
// opens offline-capable. It deliberately has no handler for /api/ or any non-GET request: every
// state-changing call, and every API read, goes straight to the live server and is never queued,
// cached or replayed. Network-first so edits on the PC are picked up; cache is the offline fallback.
const CACHE = 'vivim-mobile-shell-v2';
const SHELL = new Set(['/mobile', '/ui/mobile.mjs']);

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    for (const path of SHELL) {
      try {
        const response = await fetch(path, { credentials: 'same-origin', cache: 'reload' });
        if (response.ok) await cache.put(path, response);
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
  event.respondWith((async () => {
    try {
      const response = await fetch(request);
      if (response.ok) (await caches.open(CACHE)).put(url.pathname, response.clone()).catch(() => {});
      return response; // 401/other statuses pass through uncached
    } catch (error) {
      const cached = await caches.match(url.pathname);
      if (cached) return cached;
      throw error;
    }
  })());
});
