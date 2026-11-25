// Which clip plays for each sound, and how loud each clip is mastered. Kept apart from audio.ts (no imports, so
// the loudness check in client/qa/sfx-loudness.mjs can read it without a browser).

import type { UiSound } from "./audio";

/** An engine sound kind (docs/CLIENT-API.md sound kinds) or an interface sound. */
export type SoundKey = number | UiSound;

/** Interface sounds sit well under the game effects. */
export const UI_LEVEL = 0.5;
/** Hover ticks play under the other interface sounds: they fire far more often. */
export const HOVER_LEVEL = 0.4;

/** Background music level per track, relative to the music volume (music.ts). Both tracks sit at the music class target in game. */
export const MUSIC_LEVEL = { menu: 0.4, match: 0.5 };

/** The clip for each key, a file name in client/public/sfx (without `.mp3`); no two actions share a clip. Kind 5 (push click, wasm frame.rs) has no clip and is silent. */
export const CLIPS: Partial<Record<SoundKey, string>> = {
  1: "es_jump", // jump
  2: "es_air_jump", // air jump
  3: "impactPlate_medium_001", // push hit
  4: "impactPunch_medium_000", // push miss
  6: "impactPlank_medium_003", // impact
  7: "impactPlate_medium_002", // impact on a no-jump body
  8: "scratch_004", // freeze
  9: "es_spawn", // spawn
  10: "es_tick", // countdown tick (also the post-game point tick)
  11: "es_death", // death
  12: "impactSoft_medium_003", // body impact
  13: "es_bat_swing", // bat swing
  14: "impactWood_medium_000", // bat hit
  15: "spaceEngineSmall_000", // rocket charge
  16: "explosionCrunch_003", // rocket fire
  17: "lowFrequency_explosion_001", // explosion
  18: "es_parachute", // parachute
  19: "es_ghost", // ghost trail (quiet)
  20: "jingles_SAX01", // fanfare (game over, level up)
  hover: "es_hover",
  scroll: "es_scroll",
  slider: "es_slider",
  click: "es_click",
  tab: "es_tab",
  toggle: "es_toggle",
  open: "maximize_006",
  close: "es_close",
  error: "es_error",
  win: "jingles_STEEL01",
  lose: "jingles_SAX02",
  chat: "es_chat",
};

/**
 * Mastering gain in dB per key, on top of the clip's own level: each clip is brought to its loudness class
 * (targets and tolerance in client/qa/sfx-loudness.mjs). Keys absent here play at 0 dB.
 */
export const CLIP_GAIN_DB: Partial<Record<SoundKey, number>> = {
  1: -10.6, // jump (subtle)
  2: -12.2, // air jump (subtle)
  3: 0.2, // push hit (game)
  4: -4.0, // push miss (subtle)
  6: 1.0, // impact (game)
  7: 4.1, // impact on a no-jump body (game)
  8: -3.2, // freeze (game)
  9: -16.4, // spawn (game)
  10: -6.4, // countdown tick (game) & post-game tally (tick)
  11: -2.6, // death (impact)
  12: 11.5, // body impact (subtle); typical sim volume is very low
  13: -14.5, // bat swing (subtle)
  14: -2.4, // bat hit (game)
  15: 5.6, // rocket charge loop (subtle)
  16: 10.4, // rocket fire (impact)
  17: 9.9, // explosion (impact)
  18: -5.9, // parachute (subtle)
  19: -6.7, // ghost trail (subtle)
  20: -1.1, // fanfare (jingle) and level up (game)
  hover: -2.7, // tick class
  scroll: -6.5, // tick class (menu drum wheel)
  slider: -3.3, // tick class (range slider drag)
  click: -5.0, // interface
  tab: -16.1, // interface
  toggle: -5.7, // interface
  open: -6.0, // interface
  close: -10.1, // interface
  error: -8.7, // interface
  chat: -6.6, // interface
  win: 2.1, // jingle
  lose: 1.9, // jingle
};
