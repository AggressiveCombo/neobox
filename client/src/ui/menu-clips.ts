// Main-menu backdrop: the newest recorded clips play in the background behind the menu.
// Each clip loads into the engine's replay player and advances in real time; frames are
// drawn through ctx.present (the GL canvas sits behind the UI). Clips come newest first,
// 10 per page; the list wraps to the start. Scene sounds stay muted while a clip plays.
// A server with no clips yet plays the bundled demo (public/clips/demo.json).
// Reduced motion (the OS preference or Settings > Motion) holds the clip on one still frame: that is its motion control; the menu has no pause.

import type { AppCtx } from "../ctx";
import type { Engine, ReplayInfo } from "../engine";
import { fetchClipReplay, listClips, type ClipSummary } from "../clips";
import { fetchPrecached } from "../precached";
import { HttpError } from "../http-error";
import { reducedMotion } from "./a11y";

/** Clips per page; matches the server's page size, so a short page means the end. */
const PAGE_SIZE = 10;
/** Largest wall-clock step applied per frame. A hitch (the first draws of a clip, GC, a stalled tab) freezes the clip for its length instead of jumping it ahead: at 250 ms one hitch moved the clip 5-7 ticks in a single frame. */
const MAX_FRAME_MS = 50;
/** QA hook (like __qaCam): the playing clip's tick and the wall-clock step (ms) applied to it on the last frame. The game never reads it. */
const qaClip = { tick: -1, dtMs: 0 };
Object.assign(globalThis, { __qaClip: qaClip });
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
  /** Set once its first frame reached the screen: the card is live. */
  shown: boolean;
}

export type ClipState = "loading" | "live" | "idle";

/**
 * Start the background clip playback in `host`. `onState` reports what the card shows: "loading" (blank, no clip
 * frame yet), "live" (a clip is drawn), "idle" (no clip can play: the brand tile). `onAspect` reports
 * the arena's width over its height whenever a drawn clip's arena has a new shape. Returns the cleanup function (stops it).
 */
export function mountMenuClips(ctx: AppCtx, host: HTMLElement, onState?: (state: ClipState) => void, onAspect?: (aspect: number) => void): () => void {
  let destroyed = false;
  let eng: Engine | null = null;
  let clips: ClipSummary[] = [];
  let atEnd = false;
  let cursor = 0;
  let playing: Playing | null = null;
  /** The clip last drawn while reduced motion held it: it is drawn once, not every frame. */
  let frozenFor: Playing | null = null;
  let loading = false;
  let state: ClipState = "loading";
  /** The arena shape last reported to onAspect. */
  let reportedAspect = 0;
  let rafId = 0;
  let last = 0;
  let retryTimer = 0;
  // One controller per mount, aborted when the menu closes. Page-leave fetches (pageFetch) also stop at beforeunload.
  const net = new AbortController();

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
    return { clip, info, names: new Map(info.names), follow, tick: info.first, shown: false };
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
    // A card that showed nothing goes blank while the clip loads; a live card keeps its last frame until the next clip draws.
    if (state === "idle") setState("loading");
  }

  /** Draw the clip's frame at its tick. The first frame that reaches the screen makes the card live. */
  function draw(engine: Engine, p: Playing): boolean {
    // null: a seek waits for keyframes not yet built; nothing is presented, so an empty buffer never shows as the clip.
    if (engine.replayFrame(p.tick, p.follow) === null) return false;
    const scene = ctx.present(p.names, p.info.hz, false);
    if (!scene) return false;
    // the card takes the match view's shape (camera.ts backdropCamera)
    const aspect = scene.viewAspect;
    if (aspect !== reportedAspect && Number.isFinite(aspect)) {
      reportedAspect = aspect;
      onAspect?.(aspect);
    }
    if (!p.shown) {
      p.shown = true;
      setState("live");
    }
    return true;
  }

  function setState(next: ClipState): void {
    if (next === state) return;
    state = next;
    onState?.(next);
  }

  /** Nothing can play (no clips, offline, every load failed): the card shows the brand tile. */
  function showIdle(): void {
    setState("idle");
  }

  function startNext(): void {
    // A clip is playing (the online listener fired mid-clip): it finishes first.
    if (loading || destroyed || playing) return;
    // Offline the clip list cannot load and would only log errors; the `online` listener starts it again.
    if (!navigator.onLine) {
      showIdle();
      return;
    }
    loading = true;
    loadNext().then(
      (next) => {
        loading = false;
        if (destroyed) return;
        if (next) {
          begin(next);
          return;
        }
        showIdle();
        if (clips.length > 0) scheduleRetry();
      },
      () => {
        loading = false;
        if (destroyed) return;
        showIdle();
        scheduleRetry();
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
    // The host sits in the clip square, which is display:none in short landscape: nothing is drawn, so the clip holds.
    if (!playing || !eng || document.hidden || host.getClientRects().length === 0) return;
    const p = playing;
    // Reduced motion holds the clip on one frame (the still frame is the control); the card follows the system choice live.
    const reduce = reducedMotion();
    // A modal over the menu covers the clip: its last frame stays up undrawn, so the modal's open and close animations
    // get the frame budget. The clip resumes from the same tick when the modal closes (last is kept current above).
    if (document.querySelector("dialog.modal[open]")) {
      ctx.holdView();
      return;
    }
    if (reduce) {
      ctx.holdView();
      // Held on one frame: drawn once, and again until it reaches the screen.
      if (frozenFor !== p && draw(eng, p)) frozenFor = p;
      return;
    }
    frozenFor = null;
    p.tick += (dt / 1000) * p.info.hz;
    qaClip.tick = p.tick;
    qaClip.dtMs = dt;
    if (p.tick >= p.info.end) {
      // The last frame stays up until the next clip's first frame (or the tile, when none plays).
      playing = null;
      qaClip.tick = -1;
      startNext();
      return;
    }
    draw(eng, p);
  }

  rafId = requestAnimationFrame(tick);
  startNext();
  window.addEventListener("online", startNext);

  return () => {
    window.removeEventListener("online", startNext);
    destroyed = true;
    net.abort();
    cancelAnimationFrame(rafId);
    window.clearTimeout(retryTimer);
    playing = null;
    qaClip.tick = -1;
    eng?.replayClose();
    ctx.sfx.sceneMuted = soundWasMuted;
  };
}
