// Background music. The main-menu track loops; the in-match playlist plays its
// tracks in turn. Both stream through HTMLAudioElements and fade in and out. The
// room jukebox (YouTube) owns the speakers while it plays, so both stay silent.
// Browsers refuse audio before the player has interacted with the page, so a
// refused start waits for the next pointer or key press.

import { prefs } from "./prefs";

/** Which music the screen wants: the menu track, the match playlist, or none. */
export type MusicScene = "menu" | "match" | null;

interface ChannelOptions {
  /** Relative to the page, like logo.svg; the files live in client/public/music. */
  tracks: readonly string[];
  /** Repeat the single track forever; otherwise the tracks play in turn. */
  loop: boolean;
  /** Level relative to the music volume; the mix sits under the UI and effects. */
  level: number;
}

const MENU: ChannelOptions = { tracks: ["music/menu.mp3"], loop: true, level: 0.7 };
const MATCH: ChannelOptions = { tracks: ["music/match-1.mp3", "music/match-2.mp3"], loop: false, level: 0.5 };
const FADE_MS = 2000;
const FADE_TICK_MS = 50;

class Channel {
  private readonly els: HTMLAudioElement[];
  private cur = 0;
  /** Fade position: 0 silent, 1 full. */
  private fade = 0;
  private wanted = false;
  private timer: number | null = null;
  private gestureArmed = false;

  constructor(private readonly opts: ChannelOptions) {
    this.els = opts.tracks.map((src) => {
      const el = new Audio(src);
      el.preload = "none";
      el.loop = opts.loop;
      el.addEventListener("ended", () => this.onEnded(el));
      return el;
    });
  }

  /** Fade toward playing (`on`) or silent. Starts the track on the first fade in. */
  set(on: boolean): void {
    if (on === this.wanted) return;
    this.wanted = on;
    if (on) this.play();
    this.ensureTimer();
  }

  /** Re-apply the volume prefs (master, music level, fade). */
  applyVolume(): void {
    const el = this.els[this.cur];
    el.volume = Math.min(1, Math.max(0, prefs.value.volume * prefs.value.musicVolume * this.opts.level * this.fade));
  }

  private get current(): HTMLAudioElement {
    return this.els[this.cur];
  }

  private play(): void {
    if (!this.wanted) return;
    this.applyVolume();
    const el = this.current;
    if (!el.paused) return;
    el.play().catch(() => {
      // Refused without a user gesture: retry on the next press.
      if (this.wanted) this.armGesture();
    });
  }

  private ensureTimer(): void {
    if (this.timer !== null) return;
    this.timer = window.setInterval(() => this.step(), FADE_TICK_MS);
  }

  private step(): void {
    const target = this.wanted ? 1 : 0;
    const delta = FADE_TICK_MS / FADE_MS;
    if (this.fade < target) this.fade = Math.min(target, this.fade + delta);
    else if (this.fade > target) this.fade = Math.max(target, this.fade - delta);
    this.applyVolume();
    if (this.fade === target) {
      window.clearInterval(this.timer ?? undefined);
      this.timer = null;
      if (target === 0) this.halt();
    }
  }

  /** Faded out: pause and rewind, so the next start plays from the beginning (the playlist moves on). */
  private halt(): void {
    const el = this.current;
    el.pause();
    el.currentTime = 0;
    if (!this.opts.loop) this.cur = (this.cur + 1) % this.els.length;
  }

  private onEnded(el: HTMLAudioElement): void {
    if (this.opts.loop || el !== this.current) return;
    this.cur = (this.cur + 1) % this.els.length;
    this.play();
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
}

class Music {
  private scene: MusicScene = null;
  private jukebox = false;
  private readonly menu = new Channel(MENU);
  private readonly match = new Channel(MATCH);

  constructor() {
    prefs.subscribe(() => this.sync());
  }

  /** The screen's music: menu track, match playlist, or silence. */
  setScene(scene: MusicScene): void {
    this.scene = scene;
    this.sync();
  }

  /** The room jukebox is playing: both channels fade out until it stops. */
  setJukebox(playing: boolean): void {
    this.jukebox = playing;
    this.sync();
  }

  private sync(): void {
    const p = prefs.value;
    const audible = !this.jukebox && !p.muted;
    this.menu.set(audible && this.scene === "menu" && !p.musicMuted);
    this.match.set(audible && this.scene === "match" && !p.matchMusicMuted);
    this.menu.applyVolume();
    this.match.applyVolume();
  }
}

export const music = new Music();
