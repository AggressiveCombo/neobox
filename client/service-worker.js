// Service worker template. build.ts writes it to dist/sw.js with this build's id in the cache name and the list of
// files to precache: every shipped file but music and flags. It answers two things itself: page navigations (network
// first, the precached page offline) and the content-hashed bundle files. Every other request goes to the browser
// unchanged; the page reads its other precached files itself (client/src/precached.ts).

const BUILD = "__BUILD__";
const SHELL = `neobox-shell-${BUILD}`;
const PRECACHE = __PRECACHE__;

// Live server traffic: always the network.
const SERVER_PATH = /^\/(api|ws|admin|internal|healthz)(\/|$)/;
// Bundle files: the content hash is in the name, so a cached copy is this build's copy.
const BUNDLE_PATH = /^\/chunk-[^/]+\.(js|css)$/;

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
        if (name.startsWith("neobox-") && name !== SHELL) await caches.delete(name);
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "build-id" && event.ports && event.ports[0]) {
    event.ports[0].postMessage(BUILD);
  }
});

// Firefox logs "A ServiceWorker intercepted the request and encountered an unexpected error" for every intercepted
// request the page cancels (a reload or navigation while it loads), whatever the worker answers. So the worker answers
// only pages and bundles. Other files (wasm, sfx, fonts, logo, clips, music) are not intercepted: the page reads the
// precached copies when the network is down, and fonts and the logo rely on the browser's HTTP cache.
self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin || SERVER_PATH.test(url.pathname)) return;
  if (req.mode === "navigate") {
    event.respondWith(networkFirst(req));
  } else if (BUNDLE_PATH.test(url.pathname)) {
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

// Bundles come from the network; the precache answers only when the network is unreachable.
async function networkThenShell(req) {
  try {
    return await fetch(req);
  } catch {
    return (await matchCached(SHELL, req)) ?? Response.error();
  }
}

async function matchCached(name, req) {
  try {
    return await (await caches.open(name)).match(req);
  } catch {
    return undefined;
  }
}
