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
import { h, labelSwap, showLabel } from "./dom";
import { icon } from "./icons";

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
  /** Set once its first frame reached the screen: the card is live and shows the caption. */
  shown: boolean;
}

export type ClipState = "loading" | "live" | "idle";

/**
 * Start the background clip playback in `host`. `onState` reports what the card shows: "loading" (blank, no clip
 * frame yet), "live" (a clip is drawn, with its caption), "idle" (no clip can play: the brand tile). Returns the
 * cleanup function (stops it).
 */
export function mountMenuClips(ctx: AppCtx, host: HTMLElement, onState?: (state: ClipState) => void): () => void {
  let destroyed = false;
  let eng: Engine | null = null;
  let clips: ClipSummary[] = [];
  let atEnd = false;
  let cursor = 0;
  let playing: Playing | null = null;
  /** Held on one frame by the pause button; starts held under reduced motion. The clip does not advance while true. */
  let paused = reducedMotion();
  let lastReduce = paused;
  /** The clip last drawn still while paused: it is drawn once, not every frame. */
  let frozenFor: Playing | null = null;
  let loading = false;
  let state: ClipState = "loading";
  let rafId = 0;
  let last = 0;
  let retryTimer = 0;
  // Aborted when the page leaves (beforeunload, then pagehide) and when the menu closes: a fetch the page abandons
  // mid-navigation rejects with a page error in WebKit, so it is cancelled first, in the page, and its rejection is handled below.
  let net = new AbortController();
  const abortLoads = () => net.abort();
  window.addEventListener("beforeunload", abortLoads);
  window.addEventListener("pagehide", abortLoads);

  // The clip's caption and its pause control. The bar is hidden until a clip plays; the button is the only part that takes clicks.
  const credit = h("p", { class: "menu-clip-credit" });
  // The icon shows the state; the sr-only name is the button's accessible name ("Pause clip" / "Play clip").
  const pauseIcon = labelSwap([[icon("pause", 16)], [icon("play", 16)]], paused ? 1 : 0);
  const pauseLabel = labelSwap([["Pause clip"], ["Play clip"]], paused ? 1 : 0);
  const showPaused = (): void => {
    showLabel(pauseIcon, paused ? 1 : 0);
    showLabel(pauseLabel, paused ? 1 : 0);
  };
  const pauseBtn = h(
    "button",
    {
      type: "button",
      class: "menu-clip-pause",
      onclick: () => {
        paused = !paused;
        showPaused();
      },
    },
    pauseIcon,
    h("span", { class: "menu-clip-pause-name" }, pauseLabel),
  );
  const bar = h("div", { class: "menu-clip-bar" }, credit, pauseBtn);
  bar.hidden = true;
  host.append(bar);

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

  /** Draw the clip's frame at its tick. The first frame that reaches the screen makes the card live and shows the caption. */
  function draw(engine: Engine, p: Playing): boolean {
    // null: a seek waits for keyframes not yet built; nothing is presented, so an empty buffer never shows as the clip.
    if (engine.replayFrame(p.tick, p.follow) === null) return false;
    if (!ctx.present(p.names, p.info.hz, false)) return false;
    if (!p.shown) {
      p.shown = true;
      const caption = `${p.clip.map_name} · recorded by ${p.clip.recorder}`;
      credit.textContent = caption;
      credit.title = caption;
      bar.hidden = false;
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
    bar.hidden = true;
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
    if (net.signal.aborted) net = new AbortController();
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
    // The system's reduce-motion choice can change while the menu is open: follow it, then the button shows the state.
    const reduce = reducedMotion();
    if (reduce !== lastReduce) {
      lastReduce = reduce;
      paused = reduce;
      showPaused();
    }
    if (paused) {
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
      // The last frame stays up with its caption until the next clip's first frame (or the tile, when none plays).
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
    window.removeEventListener("beforeunload", abortLoads);
    window.removeEventListener("pagehide", abortLoads);
    net.abort();
    cancelAnimationFrame(rafId);
    window.clearTimeout(retryTimer);
    playing = null;
    qaClip.tick = -1;
    eng?.replayClose();
    bar.remove();
    ctx.sfx.sceneMuted = soundWasMuted;
  };
}
