// One-shot sound effects. Engine sounds (docs/CLIENT-API.md sound kinds) and interface
// sounds share one path: short recorded or produced clips (client/public/sfx, built from
// the Kenney CC0 packs by neobox-scratch/audio-work/build_sfx.py) decoded once and played
// through WebAudio, with a little random pitch and a random variant per play.

import { prefs } from "./prefs";

/** Interface sound names; the screens never play sounds themselves, the global hooks do (installUiSounds). */
export type UiSound = "click" | "tab" | "toggle" | "open" | "close" | "error" | "win" | "lose" | "chat";

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

/** Every distinct file, loaded once on the first gesture. */
const FILES = [...new Set(Object.values(CLIPS).flatMap((clips) => clips ?? []))];

/** Interface sounds sit well under the game effects. */
const UI_LEVEL = 0.5;
/** A repeat of one key sooner than this is dropped (a burst of ticks reads as noise). */
const MIN_GAP_MS = 35;
/** Random playback-rate spread around 1, so repeats never sound identical. */
const RATE_SPREAD = 0.03;

export class Sfx {
  private ctx: AudioContext | null = null;
  private buffers = new Map<string, AudioBuffer>();
  private lastPlayed = new Map<Key, number>();
  /** Silences playback without touching the saved prefs (the menu clip viewer mutes the scene sounds). */
  muted = false;

  /** Call from a user gesture: creates the audio context and loads the clips. */
  unlock(): void {
    if (!this.ctx) {
      const w: Window & { webkitAudioContext?: typeof AudioContext } = window;
      const Ctor = window.AudioContext ?? w.webkitAudioContext;
      if (!Ctor) return;
      this.ctx = new Ctor();
      void this.load(this.ctx);
    }
    void this.ctx.resume();
  }

  /** Play an engine sound kind at a volume (0..1), panned (-1 left .. 1 right). Repeats of one kind are rate-limited. */
  play(kind: number, volume: number, pan = 0): void {
    const level = prefs.value.volume * prefs.value.sfxVolume * clamp01(volume);
    this.trigger(kind, level, pan);
  }

  /** An interface sound, when the "Interface sounds" switch is on. */
  ui(name: UiSound): void {
    if (!prefs.value.uiSounds) return;
    this.trigger(name, prefs.value.volume * UI_LEVEL, 0);
  }

  /** Short pop for a chat line from another player. */
  chatPop(): void {
    this.ui("chat");
  }

  private async load(ctx: AudioContext): Promise<void> {
    await Promise.all(
      FILES.map(async (name) => {
        const res = await fetch(`sfx/${name}.mp3`);
        if (!res.ok) throw new Error(`sound ${name}: HTTP ${res.status}`);
        this.buffers.set(name, await ctx.decodeAudioData(await res.arrayBuffer()));
      }),
    ).catch((err: unknown) => console.error("Sound effects failed to load:", err));
  }

  private trigger(key: Key, level: number, pan: number): void {
    const ctx = this.ctx;
    if (!ctx || this.muted || prefs.value.muted || ctx.state !== "running") return;
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

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/** The one audio engine of the page. */
export const sfx = new Sfx();

/**
 * Interface sounds for everything that is not a game effect: buttons, switches, tabs,
 * dialogs opening and closing, error toasts. Delegated, so screens that mount later are covered.
 */
export function installUiSounds(): void {
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
