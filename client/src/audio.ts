// One-shot sound effects. Engine sounds (docs/CLIENT-API.md sound kinds) and interface
// sounds share one path: short recorded or produced clips (client/public/sfx, built from
// the Kenney CC0 packs by neobox-scratch/audio-work/build_sfx.py) decoded once and played
// through WebAudio. Each action has one sound, so a player learns it; a slight pitch spread
// keeps fast repeats from sounding mechanical.

import { prefs } from "./prefs";
import { fetchPrecached } from "./precached";
import { HttpError } from "./http-error";
import { CLIPS, CLIP_GAIN_DB, HOVER_LEVEL, UI_LEVEL, type SoundKey } from "./sfx-levels";

/** Interface sound names; the screens never play sounds themselves, the global hooks do (installUiSounds). */
export type UiSound =
  | "hover"
  | "scroll"
  | "slider"
  | "click"
  | "tab"
  | "toggle"
  | "open"
  | "close"
  | "error"
  | "win"
  | "lose"
  | "chat";

/** An engine sound kind (docs/CLIENT-API.md) or an interface sound. */
type Key = SoundKey;

/** Caption text for each engine sound kind, shown when captions are on (the sound's visual twin for players who cannot hear it). */
const CAPTIONS: Partial<Record<number, string>> = {
  1: "Jump",
  2: "Air jump",
  3: "Push hit",
  4: "Push",
  6: "Impact",
  7: "Impact (no jump)",
  8: "Freeze",
  9: "Spawn",
  10: "Tick",
  11: "Death",
  12: "Body impact",
  13: "Bat swing",
  14: "Bat hit",
  15: "Rocket charging",
  16: "Rocket fired",
  17: "Explosion",
  18: "Parachute",
  19: "Ghost",
  20: "Fanfare",
};

/** Caption text for the interface cues that end a match: the victory and defeat jingles. */
const UI_CAPTIONS: Partial<Record<UiSound, string>> = { win: "Victory fanfare", lose: "Defeat" };

/** QA hook (like __qaClip): the engine sound kinds played this session, and those that got a caption. The game never reads it. */
const qaSounds = { emitted: new Set<number>(), captioned: new Set<number>() };
Object.assign(globalThis, { __qaSounds: qaSounds });

/** Every distinct file, loaded once on the first gesture. */
const FILES = [...new Set(Object.values(CLIPS).filter((clip): clip is string => clip !== undefined))];

/** A repeat of one key sooner than this is dropped (a burst of ticks reads as noise). */
const MIN_GAP_MS = 35;
/** On-screen captions for game sounds: how long a caption line stays up. */
const CAPTION_MS = 1600;
/** Random playback-rate spread around 1, so repeats never sound identical. */
const RATE_SPREAD = 0.03;
/** Sound files fetched at once: one request per file would exhaust the browser's connections under host load. */
const LOAD_CONCURRENCY = 6;
/** A file that fails to fetch or decode is tried this many times before it is given up. */
const LOAD_ATTEMPTS = 2;

export class Sfx {
  private ctx: AudioContext | null = null;
  private buffers = new Map<string, AudioBuffer>();
  /** Set when the page starts leaving: pending audio work then rejects by design, not by failure. */
  private leaving = false;
  private lastPlayed = new Map<Key, number>();
  /** Silences the engine's scene sounds without touching the saved prefs; interface sounds still play. */
  sceneMuted = false;
  /** Multiplier on engine scene sounds (1 in matches/replays, lower for ambient main-menu replays). */
  sceneScale = 1;
  /** Active seamless loop for rocket charging (kind 15) while a player holds the rocket key. */
  private rocketLoop: { src: AudioBufferSourceNode; gain: GainNode; panner: StereoPannerNode | null } | null = null;

  /** Call from a user gesture: creates the audio context and loads the clips. */
  unlock(): void {
    if (!this.ctx) {
      const w: Window & { webkitAudioContext?: typeof AudioContext } = window;
      const Ctor = window.AudioContext ?? w.webkitAudioContext;
      if (!Ctor) return;
      this.ctx = new Ctor();
      // beforeunload comes before a reload or navigation cancels pending fetches, so a load aborted by it is not a failure.
      window.addEventListener("beforeunload", () => (this.leaving = true), { once: true });
      window.addEventListener("pagehide", () => (this.leaving = true), { once: true });
      void this.load(this.ctx);
    }
    this.ctx.resume().catch((err: unknown) => this.report("Audio could not resume:", err));
  }

  /** Play an engine sound kind at a volume (0..1), panned (-1 left .. 1 right). Repeats of one kind are rate-limited. */
  play(kind: number, volume: number, pan = 0): void {
    if (this.sceneMuted) return;
    qaSounds.emitted.add(kind);
    const text = CAPTIONS[kind];
    if (text && prefs.value.captions) {
      qaSounds.captioned.add(kind);
      showCaption(text);
    }
    // Kind 15 (rocket charge) runs as a continuous loop via syncRocketCharge() while held.
    if (kind === 15) return;
    const level = prefs.value.volume * prefs.value.sfxVolume * this.sceneScale * clamp01(volume);
    this.trigger(kind, level, pan);
  }

  /** Keep the rocket-charging hum looping seamlessly for as long as any player holds rocket aim. */
  syncRocketCharge(active: boolean, volume: number, pan = 0): void {
    const ctx = this.ctx;
    const shouldPlay =
      active &&
      !this.sceneMuted &&
      ctx !== null &&
      !prefs.value.muted &&
      ctx.state === "running" &&
      prefs.value.volume * prefs.value.sfxVolume * this.sceneScale * clamp01(volume) > 0;

    if (!shouldPlay) {
      if (this.rocketLoop && ctx) {
        const { src, gain } = this.rocketLoop;
        this.rocketLoop = null;
        const now = ctx.currentTime;
        try {
          gain.gain.cancelScheduledValues(now);
          gain.gain.setValueAtTime(gain.gain.value, now);
          gain.gain.linearRampToValueAtTime(0, now + 0.045);
          src.stop(now + 0.055);
        } catch {
          // Already stopped.
        }
      }
      return;
    }

    const targetGain =
      prefs.value.volume *
      prefs.value.sfxVolume *
      this.sceneScale *
      clamp01(volume) *
      10 ** ((CLIP_GAIN_DB[15] ?? 0) / 20);
    const clampedPan = Math.max(-1, Math.min(1, pan));

    if (this.rocketLoop) {
      const now = ctx.currentTime;
      this.rocketLoop.gain.gain.setTargetAtTime(targetGain, now, 0.025);
      if (this.rocketLoop.panner) this.rocketLoop.panner.pan.setTargetAtTime(clampedPan, now, 0.025);
      return;
    }

    const clip = CLIPS[15];
    const buffer = clip === undefined ? undefined : this.buffers.get(clip);
    if (!buffer) return;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    // Trim past MP3 padding/ramp at start & end so the steady hum loops seamlessly forever.
    const pad = Math.min(0.18, buffer.duration * 0.15);
    if (buffer.duration > pad * 2 + 0.15) {
      src.loopStart = pad;
      src.loopEnd = buffer.duration - pad;
    }
    const gain = ctx.createGain();
    const now = ctx.currentTime;
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(targetGain, now + 0.04);
    src.connect(gain);
    let panner: StereoPannerNode | null = null;
    if (ctx.createStereoPanner) {
      panner = ctx.createStereoPanner();
      panner.pan.setValueAtTime(clampedPan, now);
      gain.connect(panner).connect(ctx.destination);
    } else {
      gain.connect(ctx.destination);
    }
    src.start(now, src.loopStart);
    this.rocketLoop = { src, gain, panner };
  }

  /** Stop any continuous looping scene effects (e.g. when a match or replay ends or pauses). */
  stopLoops(): void {
    this.syncRocketCharge(false, 0, 0);
  }

  /** An interface sound, when the "Interface sounds" switch is on. Optional `rate` scales playback pitch. */
  ui(name: UiSound, rate = 1): void {
    const text = UI_CAPTIONS[name];
    if (text && prefs.value.captions) showCaption(text);
    if (!prefs.value.uiSounds) return;
    const isTick = name === "hover" || name === "scroll" || name === "slider";
    this.trigger(name, prefs.value.volume * UI_LEVEL * (isTick ? HOVER_LEVEL : 1), 0, rate);
  }

  /** Short pop for a chat line from another player. */
  chatPop(): void {
    this.ui("chat");
  }

  /** Fetches and decodes every sound file, a few at a time; a file that fails is retried once, and the rest still load. */
  private async load(ctx: AudioContext): Promise<void> {
    const pending = [...FILES];
    const failed: unknown[] = [];
    const loadOne = async (name: string): Promise<void> => {
      for (let attempt = 1; ; attempt++) {
        try {
          const res = await fetchPrecached(`/sfx/${name}.mp3`);
          if (!res.ok) throw new HttpError(res.status);
          this.buffers.set(name, await ctx.decodeAudioData(await res.arrayBuffer()));
          return;
        } catch (err) {
          if (attempt === LOAD_ATTEMPTS) {
            failed.push(err);
            return;
          }
        }
      }
    };
    const worker = async (): Promise<void> => {
      for (let name = pending.shift(); name !== undefined; name = pending.shift()) await loadOne(name);
    };
    await Promise.all(Array.from({ length: LOAD_CONCURRENCY }, worker));
    if (failed.length) this.report(`Sound effects failed to load (${failed.length} of ${FILES.length}):`, failed[0]);
  }

  /** Logs an audio failure, except one the page causes by leaving: Firefox then rejects pending audio work with "Navigated away from page". */
  private report(what: string, err: unknown): void {
    if (!this.leaving) console.error(what, err);
  }

  private trigger(key: Key, level: number, pan: number, rate = 1): void {
    const ctx = this.ctx;
    if (!ctx || prefs.value.muted || ctx.state !== "running") return;
    const clip = CLIPS[key];
    const buffer = clip === undefined ? undefined : this.buffers.get(clip);
    if (buffer === undefined) return;
    const now = performance.now();
    if (now - (this.lastPlayed.get(key) ?? -Infinity) < MIN_GAP_MS) return;
    this.lastPlayed.set(key, now);

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = rate * (1 + (Math.random() * 2 - 1) * RATE_SPREAD);
    const gain = ctx.createGain();
    gain.gain.value = level * 10 ** ((CLIP_GAIN_DB[key] ?? 0) / 20);
    src.connect(gain);
    if (pan !== 0 && ctx.createStereoPanner) {
      const panner = ctx.createStereoPanner();
      panner.pan.value = Math.max(-1, Math.min(1, pan));
      gain.connect(panner).connect(ctx.destination);
    } else {
      gain.connect(ctx.destination);
    }
    src.start();
  }
}

/** Captions line: one at a time, replaced by the next sound. aria-hidden, because screen readers get the game's own text messages. */
let captionEl: HTMLElement | null = null;
let captionTimer = 0;
function showCaption(text: string): void {
  if (captionEl === null) {
    captionEl = document.createElement("div");
    captionEl.className = "sound-captions";
    captionEl.setAttribute("aria-hidden", "true");
    document.body.append(captionEl);
  }
  captionEl.textContent = text;
  captionEl.hidden = false;
  clearTimeout(captionTimer);
  captionTimer = window.setTimeout(() => {
    if (captionEl) captionEl.hidden = true;
  }, CAPTION_MS);
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/** The one audio engine of the page. */
export const sfx = new Sfx();
Object.assign(globalThis, { __qaSfx: sfx });

/** What a hover tick marks: the things a click acts on. */
const HOVERABLE =
  "button:not(:disabled), a[href], summary, select:not(:disabled), [role='tab'], [role='option'], .seg-option, label:has(> input:not(:disabled))";

/** Minimum gap between ticks while dragging a range slider, ms. */
const SLIDER_TICK_MS = 55;

/**
 * Interface sounds for everything that is not a game effect: hovers, buttons, switches, tabs,
 * sliders, selects, disclosures, dialogs opening and closing, error toasts. Delegated, so screens
 * that mount later are covered.
 */
export function installUiSounds(): void {
  // A mouse entering a control ticks once; moving inside it, or a touch, does not.
  let hovered: Element | null = null;
  let lastSliderAt = 0;
  let lastSliderVal = "";
  document.addEventListener(
    "pointerover",
    (e) => {
      if (e.pointerType !== "mouse" || !(e.target instanceof Element)) return;
      const el = e.target.closest(HOVERABLE);
      if (el === hovered) return;
      hovered = el;
      if (el !== null) sfx.ui("hover");
    },
    true,
  );
  document.addEventListener(
    "click",
    (e) => {
      if (!(e.target instanceof Element)) return;
      if (e.target.closest(".seg-option, [role='tab']")) sfx.ui("tab");
      else if (e.target.closest("summary")) sfx.ui("toggle");
      else if (e.target.closest("button, a[href]")) sfx.ui("click");
    },
    true,
  );
  document.addEventListener(
    "input",
    (e) => {
      const t = e.target;
      if (!(t instanceof HTMLInputElement) || t.type !== "range") return;
      const now = performance.now();
      if (t.value === lastSliderVal || now - lastSliderAt < SLIDER_TICK_MS) return;
      lastSliderVal = t.value;
      lastSliderAt = now;
      const min = Number(t.min || 0);
      const max = Number(t.max || 100);
      const span = max - min;
      const frac = span > 0 ? clamp01((Number(t.value) - min) / span) : 0.5;
      sfx.unlock();
      sfx.ui("slider", 0.85 + frac * 0.35);
    },
    true,
  );
  document.addEventListener(
    "change",
    (e) => {
      const t = e.target;
      if (t instanceof HTMLInputElement && t.type === "checkbox") sfx.ui("toggle");
      else if (t instanceof HTMLInputElement && t.type === "radio") sfx.ui("tab");
      else if (t instanceof HTMLInputElement && t.type === "color") sfx.ui("click");
      else if (t instanceof HTMLSelectElement) sfx.ui("tab");
    },
    true,
  );
  document.addEventListener(
    "close",
    (e) => {
      if (e.target instanceof HTMLDialogElement && e.target.classList.contains("modal")) sfx.ui("close");
    },
    true,
  );
  new MutationObserver((records) => {
    for (const r of records) {
      for (const n of r.addedNodes) {
        if (!(n instanceof HTMLElement)) continue;
        if (n.matches("dialog.modal")) sfx.ui("open");
        else if (n.matches(".toast-error")) sfx.ui("error");
      }
    }
  }).observe(document.body, { childList: true });
}
