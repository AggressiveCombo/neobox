// Which clip plays for each sound, and how loud each clip is mastered. Kept apart from audio.ts (no imports, so
// the loudness check in client/qa/sfx-loudness.mjs can read it without a browser).

import type { UiSound } from "./audio";

/** An engine sound kind (docs/CLIENT-API.md sound kinds) or an interface sound. */
export type SoundKey = number | UiSound;

/** Interface sounds sit well under the game effects. */
export const UI_LEVEL = 0.5;
/** Hover ticks play under the other interface sounds: they fire far more often. */
export const HOVER_LEVEL = 0.4;

/** The clip for each key, a file name in client/public/sfx (without `.mp3`); no two actions share a clip. Kind 5 (push click, wasm frame.rs) has no clip and is silent. */
export const CLIPS: Partial<Record<SoundKey, string>> = {
  1: "maximize_002", // jump
  2: "maximize_004", // air jump
  3: "impactPlate_medium_001", // push hit
  4: "impactPunch_medium_000", // push miss
  6: "impactPlank_medium_003", // impact
  7: "impactPlate_medium_002", // impact on a no-jump body
  8: "scratch_004", // freeze
  9: "open_002", // spawn
  10: "back_003", // countdown tick (also the post-game point tick)
  11: "phaserDown3", // death
  12: "impactSoft_medium_003", // body impact
  13: "phaseJump4", // bat swing
  14: "impactWood_medium_000", // bat hit
  15: "spaceEngineSmall_000", // rocket charge
  16: "explosionCrunch_003", // rocket fire
  17: "lowFrequency_explosion_001", // explosion
  18: "thrusterFire_001", // parachute
  19: "tick_001", // ghost trail (quiet)
  20: "jingles_SAX01", // fanfare (game over, level up)
  hover: "tick_004",
  click: "click_001",
  tab: "select_002",
  toggle: "switch_004",
  open: "maximize_006",
  close: "minimize_004",
  error: "forceField_001",
  win: "jingles_STEEL01",
  lose: "jingles_SAX02",
  chat: "drop_002",
};

/**
 * Mastering gain in dB per key, on top of the clip's own level: each clip is brought to its loudness class
 * (targets and tolerance in client/qa/sfx-loudness.mjs). Keys absent here play at 0 dB.
 */
export const CLIP_GAIN_DB: Partial<Record<SoundKey, number>> = {
  1: -7.5, // jump (game)
  2: -9.5, // air jump (game)
  6: 1, // impact (game)
  7: 4, // impact on a no-jump body (game)
  8: -3, // freeze (game)
  9: -8, // spawn (game)
  11: 7, // death (game)
  12: 15.5, // body impact (game); typical sim volume is very low
  13: -5.5, // bat swing (game)
  14: -2.5, // bat hit (game)
  15: 9.5, // rocket charge (game)
  16: 7.5, // rocket fire, and the other player's copy (game)
  17: 7, // explosion (game)
  18: 2, // parachute (game)
  19: 6.5, // ghost trail (game)
  20: -1.1, // fanfare (jingle) and level up (game): one clip, two classes
  hover: 2.5, // tick class
  click: 4.5, // interface
  tab: 3.5, // interface
  toggle: 0.5, // interface
  open: -5, // interface
  close: -9, // interface
  error: -5, // interface
  chat: -2.5, // interface
  win: 2, // jingle
  lose: 2, // jingle
};
