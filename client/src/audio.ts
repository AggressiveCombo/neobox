// One-shot sound effects. Engine sounds (docs/CLIENT-API.md sound kinds) and interface
// sounds share one path: short recorded or produced clips (client/public/sfx, built from
// the Kenney CC0 packs by neobox-scratch/audio-work/build_sfx.py) decoded once and played
// through WebAudio, with a little random pitch and a random variant per play.

import { prefs } from "./prefs";
import { fetchPrecached } from "./precached";
import { HttpError } from "./http-error";

/** Interface sound names; the screens never play sounds themselves, the global hooks do (installUiSounds). */
export type UiSound = "hover" | "click" | "tab" | "toggle" | "open" | "close" | "error" | "win" | "lose" | "chat";

/** An engine sound kind (docs/CLIENT-API.md) or an interface sound. */
type Key = number | UiSound;

/** Clip variants per key, as file names in client/public/sfx (without `.mp3`). Kind 5 is never emitted. */
const CLIPS: Partial<Record<Key, readonly string[]>> = {
  1: ["maximize_002", "maximize_008"], // jump
  2: ["maximize_004", "maximize_007"], // air jump
  3: ["impactPlate_medium_001", "impactPlank_medium_001"], // push hit
  4: ["impactPunch_medium_000", "impactPunch_medium_002"], // push miss
  6: ["impactPlank_medium_001", "impactPlank_medium_003"], // impact
  7: ["impactPlate_medium_000", "impactPlate_medium_002"], // impact on a no-jump body
  8: ["scratch_004", "scratch_005"], // freeze
  9: ["open_002", "confirmation_004"], // spawn
  10: ["back_003", "switch_001"], // countdown tick (also the post-game point tick)
  11: ["laser6", "phaserDown3"], // death
  12: ["impactSoft_medium_003", "impactSoft_medium_004"], // body impact
  13: ["phaseJump4", "laserSmall_002"], // bat swing
  14: ["impactWood_medium_000", "impactWood_medium_001"], // bat hit
  15: ["spaceEngineSmall_000", "spaceEngineSmall_002"], // rocket charge
  16: ["explosionCrunch_003", "explosionCrunch_000"], // rocket fire
  17: ["explosionCrunch_001", "lowFrequency_explosion_001"], // explosion
  18: ["thrusterFire_001", "thrusterFire_004"], // parachute
  19: ["tick_001", "tick_002"], // ghost trail (quiet)
  20: ["jingles_SAX01", "jingles_SAX14"], // fanfare (game over, level up)
  hover: ["tick_004", "select_001"],
  click: ["click_001", "click_002"],
  tab: ["select_002", "select_003"],
  toggle: ["switch_004", "click_001"],
  open: ["maximize_006"],
  close: ["minimize_004"],
  error: ["forceField_001", "forceField_004"],
  win: ["jingles_STEEL01"],
  lose: ["jingles_SAX02"],
  chat: ["drop_002", "drop_004"],
};

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
const FILES = [...new Set(Object.values(CLIPS).flatMap((clips) => clips ?? []))];

/** Interface sounds sit well under the game effects. */
const UI_LEVEL = 0.5;
/** Hover ticks play under the other interface sounds: they fire far more often. */
const HOVER_LEVEL = 0.4;
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
  /** Silences the engine's scene sounds without touching the saved prefs (the menu clip viewer); interface sounds still play. */
  sceneMuted = false;

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
    const level = prefs.value.volume * prefs.value.sfxVolume * clamp01(volume);
    this.trigger(kind, level, pan);
  }

  /** An interface sound, when the "Interface sounds" switch is on. */
  ui(name: UiSound): void {
    const text = UI_CAPTIONS[name];
    if (text && prefs.value.captions) showCaption(text);
    if (!prefs.value.uiSounds) return;
    this.trigger(name, prefs.value.volume * UI_LEVEL * (name === "hover" ? HOVER_LEVEL : 1), 0);
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

  private trigger(key: Key, level: number, pan: number): void {
    const ctx = this.ctx;
    if (!ctx || prefs.value.muted || ctx.state !== "running") return;
    const variants = (CLIPS[key] ?? []).map((n) => this.buffers.get(n)).filter((b): b is AudioBuffer => b !== undefined);
    if (variants.length === 0) return;
    const now = performance.now();
    if (now - (this.lastPlayed.get(key) ?? -Infinity) < MIN_GAP_MS) return;
    this.lastPlayed.set(key, now);

    const src = ctx.createBufferSource();
    src.buffer = variants[Math.floor(Math.random() * variants.length)];
    src.playbackRate.value = 1 + (Math.random() * 2 - 1) * RATE_SPREAD;
    const gain = ctx.createGain();
    gain.gain.value = level;
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
const HOVERABLE = "button:not(:disabled), a[href], summary, select:not(:disabled), [role='tab'], .seg-option, label:has(> input:not(:disabled))";

/**
 * Interface sounds for everything that is not a game effect: hovers, buttons, switches, tabs,
 * dialogs opening and closing, error toasts. Delegated, so screens that mount later are covered.
 */
export function installUiSounds(): void {
  // A mouse entering a control ticks once; moving inside it, or a touch, does not.
  let hovered: Element | null = null;
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
      else if (e.target.closest("button")) sfx.ui("click");
    },
    true,
  );
  document.addEventListener(
    "change",
    (e) => {
      const t = e.target;
      if (t instanceof HTMLInputElement && t.type === "checkbox") sfx.ui("toggle");
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
