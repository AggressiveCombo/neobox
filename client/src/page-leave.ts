// Page fetches the page abandons when it leaves. The browser cancels a load that is still in flight when a reload or
// navigation commits, and WebKit reports that cancellation as an error of its own ("Fetch API cannot load ... due to
// access control checks"). beforeunload comes before the cancellation (pagehide can come too late), so the page aborts
// its in-flight fetches there and starts no new ones until the page is shown again (pageshow, back-forward cache) or
// the user acts (a cancelled beforeunload prompt leaves the page up with no event to say so).

const live = new Set<AbortController>();
let leaving = false;

function abortLive(): void {
  for (const ctl of live) ctl.abort();
  live.clear();
}

function onBack(): void {
  leaving = false;
}

window.addEventListener("beforeunload", () => {
  leaving = true;
  abortLive();
});
window.addEventListener("pagehide", abortLive);
window.addEventListener("pageshow", onBack);
window.addEventListener("pointerdown", onBack, { capture: true });
window.addEventListener("keydown", onBack, { capture: true });

/** True from beforeunload until the page is shown again or the user acts: the page should start no new requests. */
export function pageLeaving(): boolean {
  return leaving;
}

/**
 * fetch(), aborted when the page starts leaving while it is in flight. A keepalive request is sent to outlive the
 * page, so it is left alone. The caller's own signal still aborts the request.
 */
export function pageFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  if (init.keepalive) return fetch(input, init);
  const ctl = new AbortController();
  if (init.signal?.aborted || leaving) ctl.abort();
  else init.signal?.addEventListener("abort", () => ctl.abort(), { once: true });
  live.add(ctl);
  return fetch(input, { ...init, signal: ctl.signal }).finally(() => live.delete(ctl));
}
