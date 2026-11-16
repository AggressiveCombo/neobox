// Service worker template. build.ts writes it to dist/sw.js with this build's id in the
// cache names and the list of files to precache. It caches the app shell only: the server's
// api, websocket, admin and internal routes are never intercepted.

const BUILD = "__BUILD__";
const SHELL = `neobox-shell-${BUILD}`;
const MEDIA = `neobox-media-${BUILD}`;
const PRECACHE = __PRECACHE__;

// Live server traffic: always the network.
const SERVER_PATH = /^\/(api|ws|admin|internal|healthz)(\/|$)/;
// Sounds and music load on demand and are kept for later offline play.
const MEDIA_PATH = /^\/(sfx|music|flags)\//;

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL);
      // reload bypasses the HTTP cache so this build's files are fetched fresh.
      await cache.addAll(PRECACHE.map((url) => new Request(url, { cache: "reload" })));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (name.startsWith("neobox-") && name !== SHELL && name !== MEDIA) await caches.delete(name);
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin || SERVER_PATH.test(url.pathname)) return;
  if (req.mode === "navigate") {
    event.respondWith(networkFirst(req));
  } else if (MEDIA_PATH.test(url.pathname)) {
    // Range requests (seeking in audio) go to the network: the cache holds whole files only.
    if (!req.headers.has("range")) event.respondWith(cacheThenNetwork(MEDIA, req, true));
  } else {
    event.respondWith(cacheThenNetwork(SHELL, req, false));
  }
});

// Pages come from the network so a deploy shows at once; offline, the precached page is used.
// Only the precached page is a fallback: a fresh network page may name files this cache lacks.
async function networkFirst(req) {
  try {
    return await fetch(req);
  } catch {
    const cached = await (await caches.open(SHELL)).match("/index.html");
    if (cached) return cached;
    return Response.error();
  }
}

// Files are named by content hash, so a cached copy under the same name is always right.
async function cacheThenNetwork(name, req, store) {
  const cache = await caches.open(name);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (store && res.ok) void cache.put(req, res.clone()).catch(() => {});
  return res;
}
