// Main-menu backdrop: the newest recorded clips play in the background behind the menu.
// Each clip loads into the engine's replay player and advances in real time; frames are
// drawn through ctx.present (the GL canvas sits behind the UI). Clips come newest first,
// 10 per page; the list wraps to the start. Scene sounds stay muted while a clip plays.
// A server with no clips yet plays the bundled demo (public/clips/demo.json).

import type { AppCtx } from "../ctx";
import type { Engine, ReplayInfo } from "../engine";
import { fetchClipReplay, listClips, type ClipSummary } from "../clips";
import { fetchPrecached } from "../precached";
import { HttpError } from "../http-error";
import { reducedMotion } from "./a11y";
import { h } from "./dom";

/** Clips per page; matches the server's page size, so a short page means the end. */
const PAGE_SIZE = 10;
/** Largest wall-clock step applied per frame, so a stalled tab does not skip the clip. */
const MAX_FRAME_MS = 250;
/** Wait before trying the list again after a failed fetch or a full pass of failed loads. */
const RETRY_MS = 15_000;

/** The bundled demo match, listed when the server has no clips. */
const DEMO_CLIP: ClipSummary = { id: 0, recorder: "neobox", map_name: "Simple Arena 1", created: 0, size: 0 };

async function fetchDemo(signal: AbortSignal): Promise<string> {
  const res = await fetchPrecached("/clips/demo.json", { signal });
  if (!res.ok) throw new HttpError(res.status);
  return res.text();
}

/** A clip that is loaded in the engine and playing. */
interface Playing {
  clip: ClipSummary;
  info: ReplayInfo;
  names: ReadonlyMap<number, string>;
  follow: number;
  tick: number;
}

/**
 * Start the background clip playback in `host`. `onPlaying` is told when a clip starts
 * and when it ends. Returns the cleanup function (stops it).
 */
export function mountMenuClips(ctx: AppCtx, host: HTMLElement, onPlaying?: (on: boolean) => void): () => void {
  let destroyed = false;
  let eng: Engine | null = null;
  let clips: ClipSummary[] = [];
  let atEnd = false;
  let cursor = 0;
  let playing: Playing | null = null;
  /** The clip last held still under reduced motion; it is drawn once, not every frame. */
  let frozenFor: Playing | null = null;
  let loading = false;
  let rafId = 0;
  let last = 0;
  let retryTimer = 0;
  // Aborted when the page leaves (beforeunload, then pagehide) and when the menu closes: a fetch the page abandons
  // mid-navigation rejects with a page error in WebKit, so it is cancelled first, in the page, and its rejection is handled below.
  let net = new AbortController();
  const abortLoads = () => net.abort();
  window.addEventListener("beforeunload", abortLoads);
  window.addEventListener("pagehide", abortLoads);

  const credit = h("p", { class: "menu-clip-credit" });
  credit.hidden = true;
  host.append(credit);

  const soundWasMuted = ctx.sfx.sceneMuted;
  ctx.sfx.sceneMuted = true;

  async function fetchPage(): Promise<void> {
    const page = await listClips(clips.at(-1)?.id, net.signal);
    if (destroyed) return;
    clips = [...clips, ...page];
    atEnd = page.length < PAGE_SIZE;
    // A new server has no clips yet: the menu plays the bundled demo instead.
    if (atEnd && clips.length === 0) clips = [DEMO_CLIP];
  }

  /** Fetch and load one clip into the engine; throws when it does not load. */
  async function loadClip(clip: ClipSummary): Promise<Playing> {
    const engine = await ctx.engine();
    const text = clip === DEMO_CLIP ? await fetchDemo(net.signal) : await fetchClipReplay(clip.id, net.signal);
    if (destroyed) throw new Error("the menu closed");
    engine.replayClose();
    const info = engine.replayLoad(text);
    if (info.end <= info.first) {
      engine.replayClose();
      throw new Error(`clip ${clip.id} has no frames`);
    }
    eng = engine;
    const follow = info.names.find(([, name]) => name === clip.recorder)?.[0] ?? info.players[0]?.[0] ?? -1;
    return { clip, info, names: new Map(info.names), follow, tick: info.first };
  }

  /**
   * The next clip that loads: fetches pages on demand and wraps to the start of the list.
   * Null when nothing loads (no clips, or every loaded clip failed in this pass).
   */
  async function loadNext(): Promise<Playing | null> {
    let failures = 0;
    for (;;) {
      if (destroyed) return null;
      if (cursor >= clips.length) {
        if (!atEnd) {
          await fetchPage();
          continue;
        }
        if (clips.length === 0 || failures >= clips.length) return null;
        cursor = 0;
      }
      const clip = clips[cursor];
      cursor += 1;
      if (!clip) continue;
      try {
        return await loadClip(clip);
      } catch {
        failures += 1;
      }
    }
  }

  function begin(next: Playing): void {
    playing = next;
    onPlaying?.(true);
    credit.textContent = `${next.clip.map_name} · recorded by ${next.clip.recorder}`;
    credit.hidden = false;
  }

  function startNext(): void {
    if (loading || destroyed) return;
    if (net.signal.aborted) net = new AbortController();
    loading = true;
    loadNext().then(
      (next) => {
        loading = false;
        if (destroyed) return;
        if (next) begin(next);
        else if (clips.length > 0) scheduleRetry();
      },
      () => {
        loading = false;
        if (!destroyed) scheduleRetry();
      },
    );
  }

  function scheduleRetry(): void {
    window.clearTimeout(retryTimer);
    retryTimer = window.setTimeout(() => {
      retryTimer = 0;
      startNext();
    }, RETRY_MS);
  }

  /** One animation frame: advance the playing clip in real time and draw it. */
  function tick(now: number): void {
    rafId = requestAnimationFrame(tick);
    const dt = Math.min(Math.max(now - last, 0), MAX_FRAME_MS);
    last = now;
    if (!playing || !eng || document.hidden) return;
    const p = playing;
    if (reducedMotion()) {
      // Reduced motion holds the clip on one frame: draw it once, then stop advancing until the setting is off.
      if (frozenFor !== p) {
        frozenFor = p;
        eng.replayFrame(p.tick, p.follow);
        ctx.present(p.names, p.info.hz, false);
      }
      return;
    }
    frozenFor = null;
    p.tick += (dt / 1000) * p.info.hz;
    if (p.tick >= p.info.end) {
      playing = null;
      credit.hidden = true;
      onPlaying?.(false);
      startNext();
      return;
    }
    eng.replayFrame(p.tick, p.follow);
    ctx.present(p.names, p.info.hz, false);
  }

  rafId = requestAnimationFrame(tick);
  startNext();

  return () => {
    destroyed = true;
    window.removeEventListener("beforeunload", abortLoads);
    window.removeEventListener("pagehide", abortLoads);
    net.abort();
    cancelAnimationFrame(rafId);
    window.clearTimeout(retryTimer);
    playing = null;
    eng?.replayClose();
    credit.remove();
    ctx.sfx.sceneMuted = soundWasMuted;
  };
}
