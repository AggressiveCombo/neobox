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
/** Cap how long one clip holds the menu showcase before sliding to the next, seconds. */
const MAX_CLIP_SHOW_SECS = 11;

interface DemoEntry {
  summary: ClipSummary;
  url: string;
}

/** Bundled demo matches, played in an infinite loop when the server has no uploaded clips yet. */
const DEMO_CLIPS: readonly DemoEntry[] = [
  { summary: { id: 0, recorder: "neobox", map_name: "Simple Arena 1", created: 0, size: 0 }, url: "/clips/demo.json" },
  { summary: { id: -1, recorder: "neobox", map_name: "Golden Temple", created: 0, size: 0 }, url: "/clips/demo-2.json" },
  { summary: { id: -2, recorder: "neobox", map_name: "Ice factory", created: 0, size: 0 }, url: "/clips/demo-3.json" },
];

async function fetchDemo(url: string, signal: AbortSignal): Promise<string> {
  const res = await fetchPrecached(url, { signal });
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
  /** Tick at which this clip hands off to the next replay in the showcase. */
  stopTick: number;
  /** Set once its first frame reached the screen: the card is live. */
  shown: boolean;
}

export type ClipState = "loading" | "live" | "idle";

export interface ClipTransitionHooks {
  /** Called synchronously right after the outgoing clip's last frame is drawn, before switching clips. */
  beforeSwitch(): void;
  /** Called right after the incoming clip draws its first live frame. */
  onReady(): void;
}

/**
 * Start the background clip playback in `host`. `onState` reports what the card shows: "loading" (blank, no clip
 * frame yet), "live" (a clip is drawn), "idle" (no clip can play: the brand tile). `onAspect` reports
 * the arena's width over its height whenever a drawn clip's arena has a new shape. Returns the cleanup function (stops it).
 */
export function mountMenuClips(
  ctx: AppCtx,
  host: HTMLElement,
  onState?: (state: ClipState) => void,
  onAspect?: (aspect: number) => void,
  transition?: ClipTransitionHooks,
): () => void {
  let destroyed = false;
  let eng: Engine | null = null;
  let clips: ClipSummary[] = [];
  let usingDemos = false;
  let atEnd = false;
  let cursor = 0;
  let playing: Playing | null = null;
  let hasShownClip = false;
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
  const prevSceneScale = ctx.sfx.sceneScale;
  // Play background replay game sounds at a gentle ambient level under menu music and UI clicks.
  ctx.sfx.sceneMuted = false;
  ctx.sfx.sceneScale = 0.35;

  async function fetchPage(): Promise<void> {
    const page = await listClips(clips.at(-1)?.id, net.signal);
    if (destroyed) return;
    clips = [...clips, ...page];
    atEnd = page.length < PAGE_SIZE;
    // A new server has no clips yet: the menu cycles through the bundled demo clips instead.
    if (atEnd && clips.length === 0) {
      usingDemos = true;
      clips = DEMO_CLIPS.map((d) => d.summary);
    } else if (page.length > 0) {
      usingDemos = false;
    }
  }

  /** Fetch and load one clip into the engine; throws when it does not load. */
  async function loadClip(clip: ClipSummary): Promise<Playing> {
    const engine = await ctx.engine();
    const demo = DEMO_CLIPS.find((d) => d.summary === clip);
    const text = demo ? await fetchDemo(demo.url, net.signal) : await fetchClipReplay(clip.id, net.signal);
    if (destroyed) throw new Error("the menu closed");
    engine.replayClose();
    const info = engine.replayLoad(text);
    if (info.end <= info.first) {
      engine.replayClose();
      throw new Error(`clip ${clip.id} has no frames`);
    }
    eng = engine;
    const follow = info.names.find(([, name]) => name === clip.recorder)?.[0] ?? info.players[0]?.[0] ?? -1;
    const maxTicks = Math.max(1, Math.round(MAX_CLIP_SHOW_SECS * info.hz));
    const stopTick = Math.min(info.end, info.first + maxTicks);
    return { clip, info, names: new Map(info.names), follow, tick: info.first, stopTick, shown: false };
  }

  /**
   * The next clip that loads: fetches pages on demand and wraps infinitely to the start of the list.
   * On wrap, checks the server again so newly uploaded clips join the rotation automatically.
   * Null when nothing loads (no clips, or every loaded clip failed in this pass).
   */
  async function loadNext(): Promise<Playing | null> {
    let failures = 0;
    let wrapped = false;
    for (;;) {
      if (destroyed) return null;
      if (cursor >= clips.length) {
        if (!atEnd) {
          await fetchPage();
          continue;
        }
        if (clips.length === 0 || failures >= clips.length) return null;
        cursor = 0;
        // Refresh the clip list once per full cycle so newly recorded server clips enter rotation.
        if (!wrapped && hasShownClip && !usingDemos) {
          wrapped = true;
          try {
            const fresh = await listClips(undefined, net.signal);
            if (!destroyed && fresh.length > 0) {
              clips = fresh;
              atEnd = fresh.length < PAGE_SIZE;
            }
          } catch {
            // Keep cycling through the existing list if the refresh fails transiently.
          }
        }
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
      const wasLive = hasShownClip;
      hasShownClip = true;
      setState("live");
      if (wasLive) transition?.onReady();
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
    // Keep the view alive while the next clip is fetching during a slide handoff.
    if (!playing && loading && hasShownClip) {
      ctx.holdView();
      return;
    }
    // The host sits in the clip square, which is display:none in short landscape: nothing is drawn, so the clip holds.
    if (!playing || !eng || document.hidden || host.getClientRects().length === 0) return;
    const p = playing;
    // Reduced motion holds the clip on one frame (the still frame is the control); the card follows the system choice live.
    const reduce = reducedMotion();
    // A modal over the menu covers the clip: its last frame stays up undrawn, so the modal's open and close animations
    // get the frame budget. The clip resumes from the same tick when the modal closes (last is kept current above).
    if (document.querySelector("dialog.modal[open]")) {
      ctx.sfx.sceneMuted = true;
      ctx.sfx.stopLoops();
      ctx.holdView();
      return;
    }
    if (reduce) {
      ctx.sfx.sceneMuted = true;
      ctx.sfx.stopLoops();
      ctx.holdView();
      // Held on one frame: drawn once, and again until it reaches the screen.
      if (frozenFor !== p && draw(eng, p)) frozenFor = p;
      return;
    }
    ctx.sfx.sceneMuted = false;
    frozenFor = null;
    p.tick += (dt / 1000) * p.info.hz;
    qaClip.tick = p.tick;
    qaClip.dtMs = dt;
    if (p.tick >= p.stopTick) {
      // Render the outgoing clip's last frame right now so the WebGL buffer is live for the slide snapshot.
      p.tick = Math.min(p.tick, p.info.end);
      if (draw(eng, p)) transition?.beforeSwitch();
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
    ctx.sfx.stopLoops();
    ctx.sfx.sceneScale = prevSceneScale;
    ctx.sfx.sceneMuted = soundWasMuted;
  };
}
