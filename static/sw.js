/**
 * Service Worker for Summa PWA.
 * Provides offline support and caching strategies.
 */

const CACHE_NAME = "summa-cache-v271";
// JS modules, CSS files and fonts are not listed here: they are discovered at
// install time from the server-rendered /static/js-manifest.json,
// /static/css-manifest.json and /static/fonts-manifest.json (which glob
// static/js/*.js, static/css/*.css and static/fonts/*.woff2), so adding a
// module, stylesheet or font needs no edit to this file. The vendored Chart.js
// lives in a nested js/vendor/ dir the non-recursive js glob won't match, so it
// is listed explicitly below.
const STATIC_ASSETS = [
  "/",
  "/static/favicon.png",
  "/static/manifest.json",
  "/static/icons/icon-192.png",
  "/static/js/vendor/chart.umd.min.js",
];

/**
 * Install event - cache static assets.
 */
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      console.log("[SW] Caching static assets");
      try {
        const [jsResponse, cssResponse, fontResponse] = await Promise.all([
          fetch("/static/js-manifest.json"),
          fetch("/static/css-manifest.json"),
          fetch("/static/fonts-manifest.json"),
        ]);
        const jsModules = await jsResponse.json();
        const cssFiles = await cssResponse.json();
        const fontFiles = await fontResponse.json();
        await cache.addAll([
          ...STATIC_ASSETS,
          ...jsModules,
          ...cssFiles,
          ...fontFiles,
        ]);
      } catch (error) {
        console.log(
          "[SW] Asset manifest unavailable, caching core assets only:",
          error,
        );
        await cache.addAll(STATIC_ASSETS);
      }
    }),
  );
  // Activate immediately
  self.skipWaiting();
});

/**
 * Activate event - clean up old caches.
 */
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME)
          .map((name) => {
            console.log("[SW] Deleting old cache:", name);
            return caches.delete(name);
          }),
      );
    }),
  );
  // Take control of all pages immediately
  self.clients.claim();
});

/**
 * Fetch event - network-only for API, cache-first for static assets.
 */
self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET requests
  if (request.method !== "GET") {
    return;
  }

  // API requests: Network-only, never cached (financial data at rest)
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(networkOnly(request));
    return;
  }

  // Static assets: Cache-first, fallback to network
  event.respondWith(cacheFirst(request));
});

/**
 * Cache-first strategy: Try cache, fallback to network.
 */
async function cacheFirst(request) {
  const cachedResponse = await caches.match(request);
  if (cachedResponse) {
    return cachedResponse;
  }

  try {
    const networkResponse = await fetch(request);
    // Cache successful responses
    if (networkResponse.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  } catch (error) {
    // Return offline fallback for navigation requests
    if (request.mode === "navigate") {
      return caches.match("/");
    }
    throw error;
  }
}

/**
 * Network-only strategy: fetch from the network, never persist to the cache.
 * API payloads are financial data; keeping them out of Cache Storage avoids an
 * unencrypted copy at rest on the device (SECURITY-TODO L3).
 */
async function networkOnly(request) {
  try {
    return await fetch(request);
  } catch {
    // No cached fallback by design: report offline for failed API calls.
    return new Response(JSON.stringify({ error: "Offline - no connection" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  }
}
