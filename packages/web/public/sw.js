/**
 * Rookzen service worker — app-shell caching for PWA installability.
 *
 * Strategy (option b — runtime caching, no build-time precache injection):
 * - Precache: the shell, manifest and icons are precached on install.
 *   Hashed production assets (JS/CSS in dist/assets/) are NOT precached
 *   because the build does not inject them into this file. Instead, they
 *   are cached on first visit via the runtime cache-first handler below.
 *   This means offline support requires at least one online visit.
 * - Navigations: network-first (always try the network, fall back to
 *   cached index.html for offline support).
 * - Static assets (same-origin GET): cache-first for immutable hashed assets;
 *   mutable URLs revalidate on the network, falling back to cache offline.
 * - API (/v1/) and WebSocket: NEVER cached — always go to network.
 *
 * CACHE_VERSION invalidates incompatible cache formats, not every deployment.
 * Mutable freshness does not depend on changing worker bytes or the cache name.
 *
 * To implement build-time precache injection (option a), a postbuild script
 * would rewrite APP_SHELL in dist/sw.js from the actual dist/assets/* listing.
 * That is deferred to a future increment; option (b) is honest and acceptable
 * for M6.
 */

const APP_SHELL = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/icon.svg',
  '/icon-192.png',
  '/icon-512.png',
];

// Retain the established internal prefix while invalidating pre-Rookzen cached static assets.
const CACHE_VERSION = 'gambit-v4';
const CACHE_NAME = CACHE_VERSION;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).catch(() => {}),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))),
    ),
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // NEVER cache API responses or WebSocket upgrades.
  if (url.pathname.startsWith('/v1/') || url.protocol === 'ws:' || url.protocol === 'wss:') {
    return; // Let the browser handle it directly.
  }

  // Navigations: network-first, fall back to cached index.html offline.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((response) => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put('/index.html', clone)).catch(() => {});
          return response;
        })
        .catch(() => caches.match('/index.html')),
    );
    return;
  }

  // Match the immutable Vite asset contract in docker/web/nginx.conf.template.
  if (url.origin === self.location.origin) {
    const immutable = /^\/assets\/(?:.*\/)?[^/]+-[A-Za-z0-9_-]{8}\.[^/]+$/.test(url.pathname);
    if (!immutable) {
      event.respondWith(
        fetch(new Request(req, { cache: 'no-cache' })).then(async (response) => {
          // Nginx's SPA fallback can answer a missing public asset with successful HTML.
          // Preserve its last valid bytes rather than delivering/caching the shell as JS or an image.
          const assetFile = /\.[^/]+$/.test(url.pathname) && !/\.html?$/i.test(url.pathname);
          const html = response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() === 'text/html';
          if (response.ok && assetFile && html) {
            return (await caches.match(req)) || new Response('Offline', { status: 503, statusText: 'Offline' });
          }
          if (response.ok) {
            const clone = response.clone();
            await caches.open(CACHE_NAME).then((cache) => cache.put(req, clone)).catch(() => {});
          }
          return response;
        }).catch(async () => (await caches.match(req)) || new Response('Offline', { status: 503, statusText: 'Offline' })),
      );
      return;
    }
    // Immutable assets keep the established cache-first/offline behavior.
    event.respondWith(
      caches.match(req).then((cached) => {
        if (cached) return cached;
        return fetch(req).then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, clone)).catch(() => {});
          }
          return response;
        }).catch(() => new Response('Offline', { status: 503, statusText: 'Offline' }));
      }),
    );
  }
});
