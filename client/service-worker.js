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
    event.respondWith(networkThenShell(req));
  }
});

// Pages come from the network so a deploy shows at once; offline, the precached page is used.
// Only the precached page is a fallback: a fresh network page may name files this cache lacks.
async function networkFirst(req) {
  try {
    return await fetch(req);
  } catch {
    const cached = await matchCached(SHELL, "/index.html");
    if (cached) return cached;
    return Response.error();
  }
}

// Shell files that keep their name across builds (fonts/, logo.svg, training.json, ...) and content-hashed bundle files
// come from the network: an old worker must not hand this build's page the previous build's copy. This build's precache
// answers only when the network is unreachable. neobox.wasm is requested with a build-id query (engine-loader.ts): the
// precache ignores the query offline. Network-first for hashed files: a cache-hit response for a favicon/image load
// failed in Firefox ("A ServiceWorker intercepted the request and encountered an unexpected error").
async function networkThenShell(req) {
  try {
    return await fetch(req);
  } catch {
    return (await matchCached(SHELL, req, { ignoreSearch: true })) ?? Response.error();
  }
}

// Sounds and music: a cached copy is always right. The cache is an optimisation: when it throws (storage full,
// cache not yet open) the page gets the network response instead. An exception escaping respondWith is a page error in Firefox.
async function cacheThenNetwork(name, req, store) {
  const hit = await matchCached(name, req);
  if (hit) return hit;
  // A fetch the page abandons (reload, navigation) rejects; answer with a network error rather than a worker exception.
  let res;
  try {
    res = await fetch(req);
  } catch {
    return Response.error();
  }
  if (store && res.ok) void remember(name, req, res.clone());
  return res;
}

async function matchCached(name, req, options) {
  try {
    return await (await caches.open(name)).match(req, options);
  } catch {
    return undefined;
  }
}

async function remember(name, req, res) {
  try {
    await (await caches.open(name)).put(req, res);
  } catch {
    // not stored; the next request goes to the network again
  }
}
