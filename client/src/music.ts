// Main-menu music: one licensed track, played once from the start each time the
// menu is shown. The track streams through an HTMLAudioElement (no full decode).
// Browsers refuse audio before the player has interacted with the page, so a
// refused start waits for the next pointer or key press.

import { prefs } from "./prefs";

/** Relative to the page, like logo.svg; the file lives in client/public/music. */
const TRACK_URL = "music/menu.mp3";
/** Track level relative to the master volume; the mix is quiet under the menu UI. */
const TRACK_VOLUME = 0.3;
const FADE_MS = 2000;
const FADE_TICK_MS = 50;

class MenuMusic {
  private audio: HTMLAudioElement | null = null;
  /** The menu wants music: set by start(), cleared by stop() and when the track ends. */
  private wanted = false;
  /** Multiplier on the volume during a stop fade (1 = no fade). */
  private fadeLevel = 1;
  private fadeTimer: number | null = null;
  private gestureArmed = false;

  constructor() {
    prefs.subscribe(() => this.onPrefs());
  }

  /** Show the menu track. No-op while muted; resumes from the start after a stop. */
  start(): void {
    this.wanted = true;
    this.cancelFade();
    this.play();
  }

  /** Leave the menu: fade out over 2 s, then rewind so the next start() plays from the beginning. */
  stop(): void {
    this.wanted = false;
    const el = this.audio;
    if (!el || el.paused || !this.audible()) {
      this.halt();
      return;
    }
    if (this.fadeTimer !== null) return;
    const began = Date.now();
    this.fadeTimer = window.setInterval(() => {
      const t = (Date.now() - began) / FADE_MS;
      if (t >= 1) {
        this.halt();
        return;
      }
      this.fadeLevel = 1 - t;
      this.applyVolume();
    }, FADE_TICK_MS);
  }

  private audible(): boolean {
    return !prefs.value.musicMuted && !prefs.value.muted;
  }

  private element(): HTMLAudioElement {
    if (!this.audio) {
      const el = new Audio(TRACK_URL);
      el.loop = false;
      el.preload = "auto";
      // The track plays once; a finished track must not restart on a later prefs change.
      el.addEventListener("ended", () => {
        this.wanted = false;
      });
      this.audio = el;
    }
    return this.audio;
  }

  private play(): void {
    if (!this.wanted || !this.audible()) return;
    const el = this.element();
    this.applyVolume();
    if (!el.paused) return;
    el.play().catch(() => {
      // Refused without a user gesture (or a stale request); retry on the next press.
      if (this.wanted && this.audible()) this.armGesture();
    });
  }

  /** Retry the start on the first pointer or key press after the page loads. */
  private armGesture(): void {
    if (this.gestureArmed) return;
    this.gestureArmed = true;
    const go = (): void => {
      window.removeEventListener("pointerdown", go);
      window.removeEventListener("keydown", go);
      this.gestureArmed = false;
      this.play();
    };
    window.addEventListener("pointerdown", go);
    window.addEventListener("keydown", go);
  }

  private onPrefs(): void {
    if (!this.audible()) {
      this.halt();
      return;
    }
    this.play();
    this.applyVolume();
  }

  private applyVolume(): void {
    if (!this.audio) return;
    this.audio.volume = TRACK_VOLUME * prefs.value.volume * this.fadeLevel;
  }

  private cancelFade(): void {
    if (this.fadeTimer !== null) {
      window.clearInterval(this.fadeTimer);
      this.fadeTimer = null;
    }
    this.fadeLevel = 1;
  }

  /** Stop now and rewind; `wanted` is left as the caller set it. */
  private halt(): void {
    this.cancelFade();
    if (!this.audio) return;
    this.audio.pause();
    this.audio.currentTime = 0;
    this.applyVolume();
  }
}

export const music = new MenuMusic();
