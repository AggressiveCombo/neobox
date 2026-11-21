// Sound-effect loudness check (metric sfx.loudness.failing). Measures every way a clip reaches the speakers, as
// heard in game: the clip file (K-weighted, BS.1770) x the bus master (prefs defaults) x the caller's volume x the
// clip's mastering gain (CLIP_GAIN_DB in client/src/sfx-levels.ts). Each usage must sit within its class tolerance of
// the class target, and no usage may peak above the mastered ceiling (no clipping).
// Run: cd client && bun qa/sfx-loudness.mjs   (needs ffmpeg on PATH; exit 1 on any failure)
//
// Loudness is short-term: energy over the clip, its window floored at 400 ms (a one-shot is shorter than a gating
// block). Dynamic sounds (impact, body impact, parachute) are measured at their typical sim volume.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CLIPS, CLIP_GAIN_DB, HOVER_LEVEL, UI_LEVEL } from "../src/sfx-levels.ts";

const SFX_DIR = fileURLToPath(new URL("../public/sfx/", import.meta.url));
const SR = 48000;
// Defaults from client/src/prefs.ts (DEFAULT_PREFS): master volume and effects level.
const MASTER = 0.6;
const SFX_LEVEL = 0.8;
/** Peak ceiling of the mastered clips (neobox-scratch/audio-work/build_sfx.py); no usage may exceed it in game. */
const CEILING_DB = -1;

/** Loudness classes: target in-game level (dB) and the tolerance around it. */
export const CLASSES = {
  game: { target: -34, tol: 3, what: "gameplay effects" },
  jingle: { target: -30, tol: 3, what: "fanfares and match-end jingles" },
  interface: { target: -38, tol: 3, what: "clicks, tabs, switches, dialogs" },
  tick: { target: -43, tol: 3, what: "high-rate ticks (hover, post-game tally)" },
};

// Each usage: the key it plays, its bus (game = sfx bus, ui = interface bus), the caller volume on top of the bus,
// and its class. Engine volumes are the sim's sound volumes (crates/sim, player.rs / objects.rs / step.rs) or the
// client caller's (postgame.ts, frame.rs). Interface volume is the audio.ts factor (UI_LEVEL, HOVER_LEVEL).
const game = (name, key, volume, cls, src) => ({ name, key, bus: "game", volume, cls, src });
const ui = (name, key, volume, cls) => ({ name, key, bus: "ui", volume, cls, src: "audio.ts ui()" });
const USAGES = [
  game("jump", 1, 1.0, "game", "player.rs JUMP"),
  game("air jump", 2, 1.0, "game", "player.rs AIR_JUMP"),
  game("push hit", 3, 0.8, "game", "player.rs PUSH_HIT"),
  game("push miss", 4, 0.8, "game", "player.rs PUSH_MISS"),
  game("impact", 6, 0.5, "game", "player.rs IMPACT, typical 0.025 x mass"),
  game("impact (no jump)", 7, 0.5, "game", "player.rs IMPACT_NOJUMP, typical"),
  game("freeze", 8, 0.6, "game", "player.rs FREEZE"),
  game("spawn", 9, 1.0, "game", "round.rs SPAWN"),
  game("countdown", 10, 1.0, "game", "step.rs COUNTDOWN"),
  game("death", 11, 0.23, "game", "player.rs DEATH"),
  game("body impact", 12, 0.2, "game", "objects.rs BODY_IMPACT, typical 0.008 x mass"),
  game("bat swing", 13, 1.0, "game", "player.rs BAT_SWING"),
  game("bat hit", 14, 1.0, "game", "player.rs BAT_HIT"),
  game("rocket charge", 15, 0.2, "game", "player.rs ROCKET_CHARGE"),
  game("rocket fire", 16, 0.4, "game", "player.rs ROCKET_FIRE"),
  game("rocket fire (other player)", 16, 0.3, "game", "player.rs ROCKET_FIRE sim sound"),
  game("explosion", 17, 0.3, "game", "objects.rs EXPLOSION"),
  game("parachute", 18, 0.5, "game", "player.rs PARACHUTE, typical"),
  game("ghost trail", 19, 1.0, "game", "player.rs GHOST_TRAIL"),
  game("fanfare (game over)", 20, 1.0, "jingle", "frame.rs SOUND_FANFARE"),
  game("level up", 20, 0.5, "game", "postgame.ts LEVEL_SOUND, a one-shot cue"),
  game("post-game tally tick", 10, 0.4, "tick", "postgame.ts TICK_SOUND, one per XP step"),
  ui("hover", "hover", UI_LEVEL * HOVER_LEVEL, "tick"),
  ui("click", "click", UI_LEVEL, "interface"),
  ui("tab", "tab", UI_LEVEL, "interface"),
  ui("toggle", "toggle", UI_LEVEL, "interface"),
  ui("open dialog", "open", UI_LEVEL, "interface"),
  ui("close dialog", "close", UI_LEVEL, "interface"),
  ui("error toast", "error", UI_LEVEL, "interface"),
  ui("chat", "chat", UI_LEVEL, "interface"),
  ui("victory jingle", "win", UI_LEVEL, "jingle"),
  ui("defeat jingle", "lose", UI_LEVEL, "jingle"),
];

/** Decodes a clip to mono float samples at 48 kHz. */
function decode(path) {
  const r = spawnSync("ffmpeg", ["-v", "error", "-i", path, "-f", "f32le", "-ac", "1", "-ar", String(SR), "-"], { maxBuffer: 1 << 28 });
  if (r.error) throw new Error(`ffmpeg is required for the sfx loudness check: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`ffmpeg could not decode ${path}: ${r.stderr}`);
  return new Float32Array(r.stdout.buffer, r.stdout.byteOffset, r.stdout.byteLength / 4);
}

// BS.1770-4 K-weighting (pre-filter shelf, then RLB high-pass) for 48 kHz.
const SHELF = { b: [1.53512485958697, -2.69169618940638, 1.19839281085285], a: [1, -1.69065929318241, 0.73248077421585] };
const HPF = { b: [1, -2, 1], a: [1, -1.99004745483398, 0.99007225036621] };

function kWeight(x) {
  let y = x;
  for (const { b, a } of [SHELF, HPF]) {
    const out = new Float64Array(y.length);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < y.length; i++) {
      const xi = y[i];
      const yi = b[0] * xi + b[1] * x1 + b[2] * x2 - a[1] * y1 - a[2] * y2;
      x2 = x1; x1 = xi; y2 = y1; y1 = yi;
      out[i] = yi;
    }
    y = out;
  }
  return y;
}

/** Short-term loudness (LUFS-scale) and sample peak (dBFS) of one clip. */
function measure(file) {
  const x = decode(SFX_DIR + file + ".mp3");
  const k = kWeight(x);
  let sum = 0;
  let peak = 0;
  for (let i = 0; i < k.length; i++) {
    sum += k[i] * k[i];
    peak = Math.max(peak, Math.abs(x[i]));
  }
  const window = Math.max(k.length, 0.4 * SR);
  return { lufs: -0.691 + 10 * Math.log10(sum / window), peakDb: 20 * Math.log10(peak) };
}

const db = (linear) => 20 * Math.log10(linear);

/** The level of a usage in game (dB), before the clip's mastering gain is added. */
function busDb(u) {
  return db((u.bus === "game" ? MASTER * SFX_LEVEL : MASTER) * u.volume);
}

const gainOf = (key) => CLIP_GAIN_DB[key] ?? 0;

/** Evaluates every usage: returns one row per usage with its in-game level, deviation and verdict. */
export function evaluate() {
  const cache = new Map();
  return USAGES.map((u) => {
    const file = CLIPS[u.key];
    const cls = CLASSES[u.cls];
    if (file === undefined || !existsSync(SFX_DIR + file + ".mp3")) {
      return { ...u, file, failed: `missing clip for key ${u.key}` };
    }
    if (!cache.has(file)) cache.set(file, measure(file));
    const m = cache.get(file);
    const level = busDb(u) + gainOf(u.key);
    const inGame = m.lufs + level;
    const peak = m.peakDb + level;
    const dev = inGame - cls.target;
    let failed = null;
    if (Math.abs(dev) > cls.tol) failed = `${dev > 0 ? "too loud" : "too quiet"} by ${Math.abs(dev).toFixed(1)} dB`;
    else if (peak > CEILING_DB) failed = `peaks at ${peak.toFixed(1)} dBFS, above the ${CEILING_DB} dBFS ceiling`;
    return { ...u, file, fileLufs: m.lufs, peak, inGame, dev, target: cls.target, failed };
  });
}

if (import.meta.main) {
  const rows = evaluate();
  const fmt = (n, w = 7) => (Number.isFinite(n) ? n.toFixed(1) : "-").padStart(w);
  console.log(["usage".padEnd(28), "key".padEnd(8), "clip".padEnd(26), "class".padEnd(10), "file".padStart(7), "game".padStart(7), "target".padStart(7), "dev".padStart(7), "peak".padStart(7)].join(" "));
  for (const r of rows) {
    console.log([r.name.padEnd(28), String(r.key).padEnd(8), String(r.file ?? "-").padEnd(26), r.cls.padEnd(10), fmt(r.fileLufs), fmt(r.inGame), fmt(r.target), fmt(r.dev), fmt(r.peak)].join(" "));
  }
  const bad = rows.filter((r) => r.failed);
  for (const r of bad) console.log(`FAIL ${r.name} (key ${r.key}): ${r.failed}`);
  // Suggested per-key gain: the class target minus the in-game level without the clip gain, averaged over the key's usages.
  const byKey = new Map();
  for (const r of rows) {
    if (r.inGame === undefined) continue;
    const want = r.target - (r.inGame - gainOf(r.key));
    byKey.set(r.key, [...(byKey.get(r.key) ?? []), want]);
  }
  const suggestions = [...byKey].map(([key, wants]) => `${key}: ${(wants.reduce((a, b) => a + b, 0) / wants.length).toFixed(1)}`);
  console.log(`sfx.loudness.failing: ${bad.length} of ${rows.length} usages`);
  if (bad.length) console.log(`suggested CLIP_GAIN_DB (dB, per key): ${suggestions.join(", ")}`);
  process.exitCode = bad.length ? 1 : 0;
}
