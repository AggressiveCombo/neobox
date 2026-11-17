// Service worker template. build.ts writes it to dist/sw.js with this build's id in the
// cache names and the list of files to precache. It caches the app shell only: the server's
// api, websocket, admin and internal routes are never intercepted.

const BUILD = "__BUILD__";
const SHELL = `neobox-shell-${BUILD}`;
const MEDIA = `neobox-media-${BUILD}`;
const PRECACHE = __PRECACHE__;

// Live server traffic: always the network.
const SERVER_PATH = /^\/(api|ws|admin|internal|healthz)(\/|$)/;
// Sound effects are precached with the shell (build.ts): a hit never touches the network.
const SFX_PATH = /^\/sfx\//;
// Music and flags load on demand; kept for later offline play.
const MEDIA_PATH = /^\/(music|flags)\//;

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
  } else if (SFX_PATH.test(url.pathname)) {
    if (!req.headers.has("range")) event.respondWith(sfx(req));
  } else if (MEDIA_PATH.test(url.pathname)) {
    if (!req.headers.has("range")) event.respondWith(networkThenMedia(MEDIA, req));
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

// Sound effects: the shell cache holds them (build.ts precaches sfx/), so a hit answers without the network. The network
// is asked only on a miss, and a fetch the page abandons (reload, navigation) rejects: answer with a network error rather
// than a worker exception (an exception escaping respondWith is a page error in Firefox).
async function sfx(req) {
  const hit = await matchCached(SHELL, req);
  if (hit) return hit;
  return networkThenMedia(MEDIA, req);
}

// Music and flags: the network first, every good response kept; the cache answers only when the network fails.
async function networkThenMedia(name, req) {
  try {
    const res = await fetch(req);
    if (res.ok) void remember(name, req, res.clone());
    return res;
  } catch {
    return (await matchCached(name, req)) ?? Response.error();
  }
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
