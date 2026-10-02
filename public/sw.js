// The service worker: makes Ticket MNG installable, and lets its pages open without a
// connection.
//
// Only PUBLIC files are cached here (pages, scripts, styles, icons). This cache outlives
// logins and is shared by everyone who uses the browser, so personal data never goes in it:
// API requests pass straight through, and My tickets keeps the signed-in user's tickets in
// IndexedDB instead (offline-store.js), deleted on logout.
//
// Network first, cache as the fallback: online, every page load gets the current release
// (no "reload twice to see the update"); offline, the last version seen.

const CACHE = 'ticket-mng-v1';

/** Saved at install, so pages open offline even before they've been visited. */
const PRECACHE = [
  '/',
  '/my-tickets',
  '/login',
  '/signup',
  '/forgot-password',
  '/reset-password',
  '/verify-email',
  '/event.html',
  '/styles.css',
  '/site.css',
  '/auth.css',
  '/auth-ui.js',
  '/catalog.js',
  '/event.js',
  '/format.js',
  '/forgot-password.js',
  '/header.js',
  '/login.js',
  '/my-tickets.js',
  '/offline-store.js',
  '/reset-password.js',
  '/saved-tickets.js',
  '/session.js',
  '/signup.js',
  '/verify-email.js',
  '/manifest.webmanifest',
  '/icons/icon.svg',
  '/icons/icon-192.png',
  '/icons/apple-touch-icon.png',
];

/** On a connection this slow, use the saved copy (if there is one) rather than keep waiting. */
const NETWORK_TIMEOUT_MS = 4_000;

/** Never cached: the API (personal data), docs, metrics, health checks, the test gateway. */
const PASS_THROUGH = /^\/(api|docs|metrics|health|fake-gateway)(\/|$)/;

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // One at a time, so a missing file can't fail the whole install.
      await Promise.allSettled(PRECACHE.map((path) => cache.add(path)));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (PASS_THROUGH.test(url.pathname)) return;
  event.respondWith(networkFirst(event, cacheKey(url)));
});

/** Every event page is the same file, and pages read their query string in the browser. */
const cacheKey = (url) => (url.pathname.startsWith('/events/') ? '/event.html' : url.pathname);

async function networkFirst(event, key) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(event.request, { signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS) });
    if (response.ok && response.type === 'basic') event.waitUntil(cache.put(key, response.clone()));
    return response;
  } catch {
    const cached = await cache.match(key);
    if (cached) return cached;
    return fetch(event.request); // nothing saved: the network is all there is, however slow
  }
}
