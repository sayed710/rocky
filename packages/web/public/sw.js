/**
 * Rookzen service worker — app-shell caching for PWA installability.
 *
 * Strategy (option b — runtime caching, no build-time precache injection):
 * - Precache: only the manifest and index.html are precached on install.
 *   Hashed production assets (JS/CSS in dist/assets/) are NOT precached
 *   because the build does not inject them into this file. Instead, they
 *   are cached on first visit via the runtime cache-first handler below.
 *   This means offline support requires at least one online visit.
 * - Navigations: network-first (always try the network, fall back to
 *   cached index.html for offline support).
 * - Static assets (same-origin GET): cache-first (immutable hashed assets
 *   are safe to serve from cache after first fetch).
 * - API (/v1/) and WebSocket: NEVER cached — always go to network.
 *
 * The cache is versioned by CACHE_VERSION so deploys invalidate old caches.
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

  // Same-origin static assets: cache-first (hashed assets are immutable).
  if (url.origin === self.location.origin) {
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
