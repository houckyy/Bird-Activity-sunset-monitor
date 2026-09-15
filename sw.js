/* Service worker: makes the app itself (the page, its styles, its logic,
   the solar-position math) load with zero network - useful in the field
   where cell signal is the first thing to go. It does NOT try to cache the
   weather/tile API calls; those already have their own offline
   fallback (the last-successful reading cached in localStorage, see
   saveGoodState/loadGoodState in app.js), which is a better fit than an HTTP
   cache for data that goes stale by design.

   Bump CACHE_VERSION whenever the app shell files change, so returning
   visitors pick up the new version instead of being stuck on a stale cache. */
const CACHE_VERSION = "pbam-shell-v1";
const APP_SHELL = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./suncalc-lite.js",
  "./manifest.json"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Only manage requests for this app's own files. Everything else (Open-
  // Meteo, the topo tile server, Google Fonts, the reverse-geocode
  // lookup) passes straight through to the network untouched - those all
  // have their own freshness requirements this cache shouldn't interfere
  // with, and the app already degrades gracefully when they fail offline.
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(req, copy));
        }
        return res;
      }).catch(() => cached); // offline - fall back to whatever's cached
      // Cache-first for instant offline loads; refresh the cache in the
      // background so the next load picks up any change once back online.
      return cached || network;
    })
  );
});
