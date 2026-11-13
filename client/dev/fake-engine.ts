// Dev-only stand-in for the neobox WASM module (never imported by src/).
// Same exports and frame-buffer layout as docs/CLIENT-API.md; the scene is an
// animated placeholder, not game logic. Memory is a bump heap; nb_free is a no-op.

import type { NeoboxExports, RawEngine } from "../src/engine";

const PAGE = 65536;
// Fixed regions in linear memory. The bump allocator starts at HEAP_BASE.
const ERR_PTR = 0x100;
const ERR_CAP = 256;
const OUT_PTR = 0x1000;
const OUT_CAP = 0x10000;
const FRAME_PTR = OUT_PTR + OUT_CAP;
const FRAME_CAP = 0x4000;
const HEAP_BASE = FRAME_PTR + FRAME_CAP;

// Frame buffer layout in 32-bit words (docs/CLIENT-API.md "Frame buffer").
const HEADER_WORDS = 32;
const VERT_WORDS = 3;
const PLAYER_WORDS = 12;
const SOUND_WORDS = 5;
const ROW_WORDS = 8;

const VIEW_W = 80;
const ARENA_W = 240;
const ARENA_H = 135;
const BG_TOP = 0x14202e;
const BG_BOTTOM = 0x05070b;
const TICK_HZ = 60;
const INTRO_MS = 2000;
const SOUND_EVERY_TICKS = 180;
const PREDICTION_DEPTH = 2;
const ROLLBACKS_PER_SEC = 0.5;
const NO_ATTACKER = 0xffffffff;
const FLAG_LOCAL = 1;
const FLAG_GHOST = 2;
const TEAM_FFA = 1;
const TEAM_RED = 2;
const TEAM_BLUE = 3;

/** Packs RGBA into the u32 the renderer reads (bytes R, G, B, A in memory). */
function rgba(r: number, g: number, b: number, a = 0xff): number {
  return ((a << 24) | (b << 16) | (g << 8) | r) >>> 0;
}

const WALL = rgba(0x2a, 0x3b, 0x4d);
const PLAT_A = rgba(0x2f, 0x9f, 0xe0);
const PLAT_B = rgba(0x7c, 0x4d, 0xd8);
const PLAT_C = rgba(0xe0, 0xa2, 0x2f);

interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  colour: number;
}

/** Closed arena: four walls, three static platforms and one drifting platform (t = seconds). */
function arenaRects(t: number): Rect[] {
  const sway = Math.sin(t * 0.8) * 22;
  return [
    { x0: 0, y0: 128, x1: ARENA_W, y1: ARENA_H, colour: WALL },
    { x0: 0, y0: 0, x1: ARENA_W, y1: 7, colour: WALL },
    { x0: 0, y0: 0, x1: 7, y1: ARENA_H, colour: WALL },
    { x0: ARENA_W - 7, y0: 0, x1: ARENA_W, y1: ARENA_H, colour: WALL },
    { x0: 28, y0: 96, x1: 80, y1: 101, colour: PLAT_A },
    { x0: 160, y0: 96, x1: 212, y1: 101, colour: PLAT_A },
    { x0: 96, y0: 66, x1: 144, y1: 71, colour: PLAT_B },
    { x0: 60 + sway, y0: 36, x1: 100 + sway, y1: 41, colour: PLAT_C },
  ];
}

/** Demo player pose at time t (seconds) for roster index i; stays inside the arena. */
function pose(i: number, t: number): { x: number; y: number; angle: number } {
  return {
    x: 120 + 80 * Math.sin(t * 0.35 + i * 1.57),
    y: 66 + 28 * Math.sin(t * 0.9 + i * 2.1),
    angle: t * 2 + i,
  };
}

interface RosterEntry {
  id: number;
  team: number;
}

interface MatchState {
  roster: RosterEntry[];
  mode: number;
  objectiveLimit: number;
  maxStamina: number;
}

/** Match-start JSON; `players` is [id, team] pairs (protocol MatchStart). Read unchecked: dev only. */
interface MatchJson {
  players?: [number, number][];
  settings?: { game_mode?: number; objective_limit?: number; max_stamina?: number };
}

function readMatch(json: string): MatchState {
  const parsed: MatchJson | null = JSON.parse(json);
  if (parsed === null) throw new Error("match json must be an object");
  const settings = parsed.settings ?? {};
  return {
    roster: (parsed.players ?? []).map(([id, team]) => ({ id, team })),
    mode: settings.game_mode ?? 0,
    objectiveLimit: settings.objective_limit ?? 10,
    maxStamina: settings.max_stamina ?? 100,
  };
}

interface FrameOpts extends MatchState {
  tick: number;
  t: number;
  localId: number;
  intro: number;
  sound: boolean;
}

const LOBBY: Omit<FrameOpts, "tick" | "t"> = {
  roster: [],
  mode: 0,
  objectiveLimit: 10,
  maxStamina: 100,
  localId: -1,
  intro: -1,
  sound: false,
};

interface Match extends MatchState {
  localId: number;
  startMs: number;
}

function inputFrame(mask: number, tick: number): Uint8Array {
  const b = new Uint8Array(8);
  b[0] = 0x49; // 'I': dev format; the mock server ignores binary frames
  b[1] = mask & 0xff;
  new DataView(b.buffer).setUint32(4, tick, true);
  return b;
}

function pingFrame(nowMs: number): Uint8Array {
  const b = new Uint8Array(8);
  b[0] = 0x50; // 'P'
  new DataView(b.buffer).setUint32(4, nowMs >>> 0, true);
  return b;
}

export function createFakeEngine(): RawEngine {
  const memory = new WebAssembly.Memory({ initial: 32 });
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let heap = HEAP_BASE;
  let tick = 0;
  let frameLen = 0;
  let errLen = 0;
  let lastMask = -1;
  let match: Match | null = null;

  // Views are created per call: memory.buffer changes when memory grows.
  const bytesAt = (ptr: number, len: number): Uint8Array => new Uint8Array(memory.buffer, ptr, len);
  const textAt = (ptr: number, len: number): string => decoder.decode(bytesAt(ptr, len));

  function setError(err: unknown): void {
    const bytes = encoder.encode(err instanceof Error ? err.message : String(err)).subarray(0, ERR_CAP);
    bytesAt(ERR_PTR, bytes.byteLength).set(bytes);
    errLen = bytes.byteLength;
  }

  /** Runs fn; a thrown error becomes the engine error message and returns -1. */
  function guard(fn: () => number): number {
    try {
      return fn();
    } catch (err) {
      setError(err);
      return -1;
    }
  }

  function alloc(len: number): number {
    const ptr = heap;
    heap = (heap + len + 7) & ~7;
    const have = memory.buffer.byteLength;
    if (heap > have) memory.grow(Math.ceil((heap - have) / PAGE));
    return ptr;
  }

  function writeOut(bytes: Uint8Array): number {
    if (bytes.byteLength > OUT_CAP) throw new Error("output exceeds the out buffer");
    bytesAt(OUT_PTR, bytes.byteLength).set(bytes);
    return bytes.byteLength;
  }

  function writeFrame(o: FrameOpts): number {
    const rects = arenaRects(o.t);
    const rows = o.roster.map((p, i) => ({ id: p.id, team: p.team, kills: (Math.floor(o.t / 10) + i) % 5 }));
    const sound = o.sound ? rows[0] : undefined;
    const n = rows.length;
    const vertCount = rects.length * 6;
    const soundCount = sound ? 1 : 0;
    const vOff = HEADER_WORDS;
    const pOff = vOff + vertCount * VERT_WORDS;
    const sOff = pOff + n * PLAYER_WORDS;
    const rOff = sOff + soundCount * SOUND_WORDS;
    const words = rOff + n * ROW_WORDS;
    const dv = new DataView(memory.buffer);
    const setU = (w: number, v: number): void => dv.setUint32(FRAME_PTR + w * 4, v, true);
    const setF = (w: number, v: number): void => dv.setFloat32(FRAME_PTR + w * 4, v, true);
    const setI = (w: number, v: number): void => dv.setInt32(FRAME_PTR + w * 4, v, true);

    let redKills = 0;
    let blueKills = 0;
    for (const r of rows) {
      if (r.team === TEAM_RED) redKills += r.kills;
      if (r.team === TEAM_BLUE) blueKills += r.kills;
    }

    // Header (words 0..29).
    setU(0, 1);
    setU(1, vertCount);
    setU(2, vOff);
    setU(3, n);
    setU(4, pOff);
    setU(5, soundCount);
    setU(6, sOff);
    setU(7, n);
    setU(8, rOff);
    setF(9, VIEW_W);
    setF(10, ARENA_W);
    setF(11, ARENA_H);
    setU(12, BG_TOP);
    setU(13, BG_BOTTOM);
    setU(14, o.tick);
    setI(15, o.localId);
    setF(16, o.intro);
    setF(17, -1);
    setF(18, -1);
    setF(19, -2);
    setF(20, -2);
    setF(21, redKills);
    setF(22, blueKills);
    setI(23, o.mode);
    setF(24, o.objectiveLimit);
    setF(25, o.maxStamina);
    setF(26, 1 + (Math.floor(o.t / 30) % 3));
    setU(27, 0);
    setF(28, PREDICTION_DEPTH);
    setF(29, ROLLBACKS_PER_SEC);

    // World vertices: two triangles per rectangle, back to front.
    let w = vOff;
    for (const r of rects) {
      const corners: [number, number][] = [
        [r.x0, r.y0],
        [r.x1, r.y0],
        [r.x1, r.y1],
        [r.x0, r.y0],
        [r.x1, r.y1],
        [r.x0, r.y1],
      ];
      for (const [x, y] of corners) {
        setF(w, x);
        setF(w + 1, y);
        setU(w + 2, r.colour);
        w += VERT_WORDS;
      }
    }

    // Players: ghost flag on roster index 2 for one second in four.
    for (const [i, r] of rows.entries()) {
      const p = pose(i, o.t);
      const b = pOff + i * PLAYER_WORDS;
      const ghost = i === 2 && Math.floor(o.t / 5) % 4 === 2;
      const flags = (r.id === o.localId ? FLAG_LOCAL : 0) | (ghost ? FLAG_GHOST : 0);
      setU(b, r.id);
      setF(b + 1, p.x);
      setF(b + 2, p.y);
      setF(b + 3, p.angle);
      setU(b + 4, r.team);
      setF(b + 5, o.maxStamina * (0.5 + 0.5 * Math.sin(o.t + i)));
      setU(b + 6, flags);
      setU(b + 7, NO_ATTACKER);
      setF(b + 8, 1);
      setF(b + 9, 1);
      setF(b + 10, p.angle);
      setU(b + 11, 0);
    }

    // Sound: a jump by the first roster player, when the caller asks for one.
    if (sound) {
      const p = pose(0, o.t);
      setU(sOff, 1);
      setF(sOff + 1, p.x);
      setF(sOff + 2, p.y);
      setF(sOff + 3, 1);
      setI(sOff + 4, sound.id);
    }

    // Score rows.
    for (const [i, r] of rows.entries()) {
      const b = rOff + i * ROW_WORDS;
      setU(b, r.id);
      setU(b + 1, r.team);
      setF(b + 2, r.kills);
      setF(b + 3, 0);
      setF(b + 4, 3);
      setU(b + 5, 1);
      setF(b + 6, 0);
      setF(b + 7, 0);
    }

    return words * 4;
  }

  const exports: NeoboxExports = {
    memory,
    nb_alloc: alloc,
    nb_free: () => {},
    nb_error_ptr: () => ERR_PTR,
    nb_error_len: () => errLen,
    nb_match_start: (json, jsonLen, local, nowMs) =>
      guard(() => {
        match = { ...readMatch(textAt(json, jsonLen)), localId: local, startMs: nowMs };
        return 0;
      }),
    // The snapshot state blob is not decoded: the fake only adopts the tick.
    nb_match_snapshot: (json, jsonLen, local, snapTick, _snap, _snapLen, nowMs) =>
      guard(() => {
        match = { ...readMatch(textAt(json, jsonLen)), localId: local, startMs: nowMs };
        tick = snapTick;
        return 0;
      }),
    nb_match_end: () => {
      match = null;
    },
    nb_server_frame: () => 0,
    nb_frame: (nowMs, mask) => {
      tick += 1;
      const t = nowMs / 1000;
      if (match) {
        const elapsed = nowMs - match.startMs;
        frameLen = writeFrame({
          tick,
          t,
          roster: match.roster,
          localId: match.localId,
          intro: elapsed < INTRO_MS ? ((INTRO_MS - elapsed) * TICK_HZ) / 1000 : -1,
          mode: match.mode,
          objectiveLimit: match.objectiveLimit,
          maxStamina: match.maxStamina,
          sound: tick % SOUND_EVERY_TICKS === 0,
        });
      } else {
        frameLen = writeFrame({ ...LOBBY, tick, t });
      }
      if (!match || mask === lastMask) return 0;
      lastMask = mask;
      return writeOut(inputFrame(mask, tick));
    },
    nb_out_ptr: () => OUT_PTR,
    nb_frame_ptr: () => FRAME_PTR,
    nb_frame_len: () => frameLen,
    nb_ping: (nowMs) => writeOut(pingFrame(nowMs)),
    nb_map_preview: (code, codeLen) =>
      guard(() => {
        if (textAt(code, codeLen) === "bad") throw new Error("fake engine: map code rejected");
        frameLen = writeFrame({ ...LOBBY, tick, t: 0 });
        return 0;
      }),
    nb_map_encode: (json, jsonLen) =>
      guard(() => {
        const parsed: unknown = JSON.parse(textAt(json, jsonLen));
        return writeOut(encoder.encode(JSON.stringify(parsed)));
      }),
    nb_rtt: () => 42,
  };

  return { exports };
}
