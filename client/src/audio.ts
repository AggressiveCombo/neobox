// Original procedural sound effects (WebAudio oscillators, no sample files).
// Keyed by the sound kinds of docs/CLIENT-API.md.

interface Voice {
  type: OscillatorType;
  f0: number;
  f1: number;
  dur: number;
  gain: number;
}

const VOICES: Record<number, Voice> = {
  1: { type: "sine", f0: 440, f1: 660, dur: 0.08, gain: 0.25 },
  2: { type: "sine", f0: 520, f1: 780, dur: 0.1, gain: 0.25 },
  3: { type: "square", f0: 180, f1: 140, dur: 0.06, gain: 0.12 },
  4: { type: "triangle", f0: 260, f1: 200, dur: 0.04, gain: 0.1 },
  6: { type: "sawtooth", f0: 120, f1: 60, dur: 0.1, gain: 0.2 },
  7: { type: "sawtooth", f0: 140, f1: 80, dur: 0.09, gain: 0.18 },
  8: { type: "sine", f0: 1200, f1: 900, dur: 0.2, gain: 0.2 },
  9: { type: "sine", f0: 600, f1: 900, dur: 0.15, gain: 0.2 },
  10: { type: "square", f0: 880, f1: 880, dur: 0.08, gain: 0.12 },
  11: { type: "sawtooth", f0: 400, f1: 80, dur: 0.35, gain: 0.25 },
  12: { type: "triangle", f0: 150, f1: 100, dur: 0.07, gain: 0.2 },
  13: { type: "triangle", f0: 300, f1: 200, dur: 0.1, gain: 0.12 },
  14: { type: "square", f0: 240, f1: 200, dur: 0.08, gain: 0.12 },
  15: { type: "sine", f0: 200, f1: 400, dur: 0.3, gain: 0.18 },
  16: { type: "sawtooth", f0: 300, f1: 60, dur: 0.25, gain: 0.2 },
  17: { type: "sawtooth", f0: 60, f1: 30, dur: 0.5, gain: 0.35 },
  18: { type: "triangle", f0: 500, f1: 400, dur: 0.3, gain: 0.15 },
  19: { type: "sine", f0: 900, f1: 900, dur: 0.12, gain: 0.08 },
};

const MIN_GAP_MS = 35;

export class Sfx {
  private ctx: AudioContext | null = null;
  private lastPlayed = new Map<number, number>();
  muted = false;

  /** Call from a user gesture to create the audio context. */
  unlock(): void {
    if (this.ctx) {
      void this.ctx.resume();
      return;
    }
    const w: Window & { webkitAudioContext?: typeof AudioContext } = window;
    const Ctor = window.AudioContext ?? w.webkitAudioContext;
    if (!Ctor) return;
    this.ctx = new Ctor();
  }

  /** Play a sound kind at a volume (0..1). Repeats of one kind are rate-limited. */
  play(kind: number, volume: number): void {
    const ctx = this.ctx;
    const v = VOICES[kind];
    if (!ctx || !v || this.muted || ctx.state !== "running") return;
    const now = performance.now();
    const last = this.lastPlayed.get(kind) ?? -Infinity;
    if (now - last < MIN_GAP_MS) return;
    this.lastPlayed.set(kind, now);

    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = v.type;
    osc.frequency.setValueAtTime(v.f0, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, v.f1), t + v.dur);
    const amp = v.gain * Math.min(1, Math.max(0, volume));
    gain.gain.setValueAtTime(amp, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + v.dur);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + v.dur + 0.02);
  }
}
