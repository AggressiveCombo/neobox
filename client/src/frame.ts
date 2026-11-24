// Decodes the frame buffer header and records (docs/CLIENT-API.md "Frame buffer").
// Layout: little-endian words; header words 0..44; world verts (3 words), players
// (14 words), sounds (5 words), score rows (15 words), kill pairs (2 words), damage bars (4 words), turrets (5 words),
// bat hits (3 words, predicted: hit visuals), bat hits (3 words, confirmed: event log).

import type { FrameView } from "./engine";

export const FLAG_LOCAL = 1;
export const FLAG_GHOST = 2;
export const FLAG_FROZEN = 4;
export const FLAG_BAT = 16;
export const FLAG_PUSHING = 32;
export const FLAG_DASH = 64;
export const FLAG_TELEPORT = 128;
export const FLAG_AIR_JUMP = 256;

/** Victim kind of a player in a bat hit (HitRec.kind; the sim's kind). */
export const HIT_KIND_PLAYER = 1;

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
  /** Launcher charge frame (the original's `pn`, lerped and floored at 0); -1 when the launcher is idle. */
  rocketCharge: number;
  /** Launcher aim (radians), from the lerped sine and cosine of the aim angle. */
  rocketRot: number;
  /** Egg aim line length as a fraction of its full length (0..1). */
  eggCharge: number;
  /** Egg aim angle (radians). */
  eggAim: number;
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
  /** Claimed spawn point (world units); NaN when the player has none. */
  spawnX: number;
  spawnY: number;
}

/** A kill that happened since the previous frame, with the confirmed tick it happened on. */
export interface KillRec {
  killer: number;
  victim: number;
  tick: number;
}

/** A bat hit that landed since the previous frame: who swung, what it hit and its index. */
export interface HitRec {
  swinger: number;
  /** Victim kind: 0 body, 1 player, 2 projectile (sim kind). */
  kind: number;
  /** Body or projectile index, or the victim's player id for kind 1. */
  index: number;
}

/** A confirmed bat hit (the event log): a HitRec with the tick it landed on. */
export interface LogHitRec extends HitRec {
  tick: number;
}

/** A body's damage bar: centre (world units), fill fraction (0..1) and colour (0xRRGGBB). */
export interface BarRec {
  x: number;
  y: number;
  fraction: number;
  colour: number;
}

/** A turret: centre (world units), range (world units), health fraction (0..1) and team colour (0xRRGGBB). */
export interface TurretRec {
  x: number;
  y: number;
  range: number;
  fraction: number;
  colour: number;
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
  /** The map's view width over height (1.6 classic, 16/9 wide); header word 42. */
  viewAspect: number;
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
  /** Extent of the map's static bodies as drawn (world units); infinite when it has none. Moving bodies, projectiles and effects are not in it. */
  fixedX0: number;
  fixedY0: number;
  fixedX1: number;
  fixedY1: number;
  /** Local input mask (input.ts BIT values), set by the caller after readScene; not part of the frame. */
  localKeys: number;
  players: PlayerRec[];
  sounds: SoundRec[];
  scores: ScoreRow[];
  kills: KillRec[];
  bars: BarRec[];
  turrets: TurretRec[];
  hits: HitRec[];
  /** Bat hits of confirmed ticks: the event log. `hits` are the predicted hit visuals. */
  logHits: LogHitRec[];
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
    const o = playerOff + i * 14;
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
      rocketCharge: f32[o + 10] ?? 0,
      rocketRot: f32[o + 11] ?? 0,
      eggCharge: f32[o + 12] ?? 0,
      eggAim: f32[o + 13] ?? 0,
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
    const o = rowOff + i * 15;
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
      spawnX: f32[o + 13] ?? NaN,
      spawnY: f32[o + 14] ?? NaN,
    });
  }

  const kills: KillRec[] = [];
  for (let i = 0; i < killCount; i++) {
    const o = killOff + i * 3;
    kills.push({ killer: u32[o] ?? 0, victim: u32[o + 1] ?? 0, tick: u32[o + 2] ?? 0 });
  }

  const barCount = u32[32] ?? 0;
  const barOff = u32[33] ?? 0;
  const bars: BarRec[] = [];
  for (let i = 0; i < barCount; i++) {
    const o = barOff + i * 4;
    bars.push({ x: f32[o] ?? 0, y: f32[o + 1] ?? 0, fraction: f32[o + 2] ?? 0, colour: u32[o + 3] ?? 0 });
  }

  const hitCount = u32[34] ?? 0;
  const hitOff = u32[35] ?? 0;
  const hits: HitRec[] = [];
  for (let i = 0; i < hitCount; i++) {
    const o = hitOff + i * 3;
    hits.push({ swinger: u32[o] ?? 0, kind: u32[o + 1] ?? 0, index: u32[o + 2] ?? 0 });
  }

  const logHitCount = u32[36] ?? 0;
  const logHitOff = u32[37] ?? 0;
  const logHits: LogHitRec[] = [];
  for (let i = 0; i < logHitCount; i++) {
    const o = logHitOff + i * 4;
    logHits.push({ swinger: u32[o] ?? 0, kind: u32[o + 1] ?? 0, index: u32[o + 2] ?? 0, tick: u32[o + 3] ?? 0 });
  }

  const turretCount = u32[43] ?? 0;
  const turretOff = u32[44] ?? 0;
  const turrets: TurretRec[] = [];
  for (let i = 0; i < turretCount; i++) {
    const o = turretOff + i * 5;
    turrets.push({ x: f32[o] ?? 0, y: f32[o + 1] ?? 0, range: f32[o + 2] ?? 0, fraction: f32[o + 3] ?? 0, colour: u32[o + 4] ?? 0 });
  }

  return {
    version: u32[0] ?? 0,
    viewWidth: f32[9] ?? 0,
    viewAspect: f32[42] ?? 1.6,
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
    fixedX0: f32[38] ?? Infinity,
    fixedY0: f32[39] ?? Infinity,
    fixedX1: f32[40] ?? -Infinity,
    fixedY1: f32[41] ?? -Infinity,
    localKeys: 0,
    players,
    sounds,
    scores,
    kills,
    bars,
    turrets,
    hits,
    logHits,
    view: fb,
  };
}
