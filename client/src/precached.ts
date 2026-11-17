// The static files the service worker precaches (build.ts lists every shipped file but music and flags). When the
// network cannot answer, the page reads its copy from the same cache. The worker itself never answers these requests:
// Firefox logs an error for each intercepted request the page cancels.

/** fetch(url), or the precached copy when the network is unreachable. An HTTP error response is returned as is. */
export async function fetchPrecached(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (err) {
    if (init?.signal?.aborted) throw err;
    const cached = await globalThis.caches?.match(url, { ignoreSearch: true });
    if (cached) return cached;
    throw err;
  }
}
