// Decodes the frame buffer header and records (docs/CLIENT-API.md "Frame buffer").
// Layout: little-endian words; header words 0..31; world verts (3 words), players
// (11 words), sounds (5 words), score rows (13 words), kill pairs (2 words).

import type { FrameView } from "./engine";

export const FLAG_LOCAL = 1;
export const FLAG_GHOST = 2;
export const FLAG_FROZEN = 4;
export const FLAG_ROCKET_AIM = 8;
export const FLAG_BAT = 16;
export const FLAG_PUSHING = 32;
export const FLAG_DASH = 64;
export const FLAG_TELEPORT = 128;
export const FLAG_AIR_JUMP = 256;

export interface PlayerRec {
  id: number;
  x: number;
  y: number;
  angle: number;
  team: number;
  stamina: number;
  flags: number;
  attacker: number;
  size: number;
  health: number;
  aim: number;
}

export interface ScoreRow {
  id: number;
  team: number;
  kills: number;
  wins: number;
  lives: number;
  alive: boolean;
  respawn: number;
  eliminated: number;
  /** Player id of the last attacker; -1 none. */
  killedBy: number;
  /** Player id of the last victim; -1 none. */
  lastVictim: number;
  killTimer: number;
  deathTimer: number;
  suicideTimer: number;
}

/** A kill that happened since the previous frame. */
export interface KillRec {
  killer: number;
  victim: number;
}

export interface SoundRec {
  kind: number;
  x: number;
  y: number;
  volume: number;
  player: number;
}

export interface Scene {
  version: number;
  viewWidth: number;
  arenaW: number;
  arenaH: number;
  bgTop: number;
  bgBottom: number;
  tick: number;
  localId: number;
  intro: number;
  roundOver: number;
  gameOver: number;
  winner: number;
  objectiveTeam: number;
  red: number;
  blue: number;
  mode: number;
  objectiveLimit: number;
  maxStamina: number;
  round: number;
  wraps: boolean;
  predictionDepth: number;
  rollbacksPerSec: number;
  worldOffset: number;
  worldCount: number;
  players: PlayerRec[];
  sounds: SoundRec[];
  scores: ScoreRow[];
  kills: KillRec[];
  /** Word offset of the world vertex block (for zero-copy geometry). */
  view: FrameView;
}

export function readScene(fb: FrameView): Scene {
  const { u32, f32, i32 } = fb;
  const playerCount = u32[3] ?? 0;
  const playerOff = u32[4] ?? 0;
  const soundCount = u32[5] ?? 0;
  const soundOff = u32[6] ?? 0;
  const rowCount = u32[7] ?? 0;
  const rowOff = u32[8] ?? 0;
  const killCount = u32[30] ?? 0;
  const killOff = u32[31] ?? 0;

  const players: PlayerRec[] = [];
  for (let i = 0; i < playerCount; i++) {
    const o = playerOff + i * 11;
    players.push({
      id: u32[o] ?? 0,
      x: f32[o + 1] ?? 0,
      y: f32[o + 2] ?? 0,
      angle: f32[o + 3] ?? 0,
      team: u32[o + 4] ?? 0,
      stamina: f32[o + 5] ?? 0,
      flags: u32[o + 6] ?? 0,
      attacker: u32[o + 7] ?? 0,
      size: f32[o + 8] ?? 0,
      health: f32[o + 9] ?? 0,
      aim: f32[o + 10] ?? 0,
    });
  }

  const sounds: SoundRec[] = [];
  for (let i = 0; i < soundCount; i++) {
    const o = soundOff + i * 5;
    sounds.push({
      kind: u32[o] ?? 0,
      x: f32[o + 1] ?? 0,
      y: f32[o + 2] ?? 0,
      volume: f32[o + 3] ?? 0,
      player: i32[o + 4] ?? -1,
    });
  }

  const scores: ScoreRow[] = [];
  for (let i = 0; i < rowCount; i++) {
    const o = rowOff + i * 13;
    scores.push({
      id: u32[o] ?? 0,
      team: u32[o + 1] ?? 0,
      kills: f32[o + 2] ?? 0,
      wins: f32[o + 3] ?? 0,
      lives: f32[o + 4] ?? 0,
      alive: (u32[o + 5] ?? 0) !== 0,
      respawn: f32[o + 6] ?? 0,
      eliminated: f32[o + 7] ?? 0,
      killedBy: i32[o + 8] ?? -1,
      lastVictim: i32[o + 9] ?? -1,
      killTimer: f32[o + 10] ?? 0,
      deathTimer: f32[o + 11] ?? 0,
      suicideTimer: f32[o + 12] ?? 0,
    });
  }

  const kills: KillRec[] = [];
  for (let i = 0; i < killCount; i++) {
    const o = killOff + i * 2;
    kills.push({ killer: u32[o] ?? 0, victim: u32[o + 1] ?? 0 });
  }

  return {
    version: u32[0] ?? 0,
    viewWidth: f32[9] ?? 0,
    arenaW: f32[10] ?? 0,
    arenaH: f32[11] ?? 0,
    bgTop: u32[12] ?? 0,
    bgBottom: u32[13] ?? 0,
    tick: u32[14] ?? 0,
    localId: i32[15] ?? -1,
    intro: f32[16] ?? -1,
    roundOver: f32[17] ?? -1,
    gameOver: f32[18] ?? -1,
    winner: f32[19] ?? -2,
    objectiveTeam: f32[20] ?? -2,
    red: f32[21] ?? 0,
    blue: f32[22] ?? 0,
    mode: i32[23] ?? 0,
    objectiveLimit: f32[24] ?? 0,
    maxStamina: f32[25] ?? 0,
    round: f32[26] ?? 0,
    wraps: ((u32[27] ?? 0) & 1) !== 0,
    predictionDepth: f32[28] ?? 0,
    rollbacksPerSec: f32[29] ?? 0,
    worldOffset: u32[2] ?? 0,
    worldCount: u32[1] ?? 0,
    players,
    sounds,
    scores,
    kills,
    view: fb,
  };
}
