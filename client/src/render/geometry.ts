// CPU geometry shared by every backend. One interleaved vertex format:
// position f32 x, f32 y, then colour u8 r, g, b, a (12 bytes: float32x2 + unorm8x4).
// Vertices are built into reused typed arrays that grow by doubling and never
// shrink, so steady-state frames allocate nothing here.

import type { PlayerRec, Scene } from "../frame";
import { FLAG_BAT, FLAG_DASH, FLAG_FROZEN, FLAG_GHOST, FLAG_GROUNDED, FLAG_LOCAL, FLAG_PUSHING, FLAG_ROCKET_AIM } from "../frame";
import { TEAM_BLUE, TEAM_FFA, TEAM_RED, TEAM_SPECTATOR } from "../protocol";
import { prefs, type Palette } from "../prefs";

/** Bytes per vertex. */
export const VERTEX_BYTES = 12;
const WORDS_PER_VERTEX = 3;
const INITIAL_CAPACITY = 1024;
const BACKGROUND_VERTICES = 6;
/** Rocket aim line (6) + body quad (6) + local marker (3). */
const PLAYER_MAX_VERTICES = 15;

/** Clip transform (sx, sy, ox, oy): clip = (x*sx + ox, y*sy + oy). */
export type Xf = [number, number, number, number];
export const IDENTITY_XF: Xf = [1, 1, 0, 0];

/** Vertex range of one draw call. */
export interface Span {
  first: number;
  count: number;
}

/** Okabe-Ito colours: told apart under the common colour-vision deficiencies. */
const OKABE_ITO = [0xe69f00, 0x56b4e9, 0x009e73, 0xf0e442, 0xcc79a7, 0xbbbbbb, 0xffffff, 0x0072b2];
/** Team and FFA colours per palette pref (FFA is indexed by player id). */
export const PALETTES: Record<Palette, { red: number; blue: number; ffa: readonly number[] }> = {
  default: { red: 0xff5252, blue: 0x4d9bff, ffa: [0x9be15d, 0xffc857, 0xc792ea, 0x4fd1c5, 0xff8fab, 0xf6e05e, 0x7f9cf5, 0xf28c28] },
  deuteranopia: { red: 0xd55e00, blue: 0x0072b2, ffa: OKABE_ITO },
  protanopia: { red: 0xd55e00, blue: 0x0072b2, ffa: OKABE_ITO },
  tritanopia: { red: 0xd55e00, blue: 0xcc79a7, ffa: [0xe69f00, 0xd55e00, 0xcc79a7, 0xbbbbbb, 0xffffff, 0xff7f9f, 0xf0e442, 0xb0b0ff] },
};
const ICE_RGB = 0xbfe9ff;
const WHITE_RGB = 0xffffff;
const AIRBORNE_RGB = 0x8a8f99;
const GHOST_ALPHA = 0.35;
const AIM_ALPHA = 0.75;
const MARKER_ALPHA = 0.9;
const FROZEN_MIX = 0.5;
/** Aim line length and half width, in player sides. */
const AIM_LENGTH = 2;
const AIM_HALF_WIDTH = 0.04;
/** Marker gap, height and half width, in player sides. */
const MARKER_GAP = 0.15;
const MARKER_HEIGHT = 0.35;
const MARKER_HALF_WIDTH = 0.2;

/** Backing-store size for a device-pixel request, scaled by the renderScale pref. */
export function scaledSize(widthPx: number, heightPx: number): [number, number] {
  const s = prefs.value.renderScale;
  return [Math.max(1, Math.round(widthPx * s)), Math.max(1, Math.round(heightPx * s))];
}

/** Colours the room gave its players (id to 0xRRGGBB); used for FFA players on the default palette. */
let playerColours = new Map<number, number>();

/** Replace the room's player colours; players without one keep the palette colour. */
export function setPlayerColors(colours: ReadonlyMap<number, number>): void {
  playerColours = new Map(colours);
}

/** Team colour (red, blue) or the per-id FFA colour, from the palette pref, as 0xRRGGBB. */
export function playerRgb(team: number, id: number): number {
  const c = PALETTES[prefs.value.palette];
  if (team === TEAM_RED) return c.red;
  if (team === TEAM_BLUE) return c.blue;
  if (team === TEAM_FFA && prefs.value.palette === "default") {
    const own = playerColours.get(id);
    if (own !== undefined) return own;
  }
  return c.ffa[id % c.ffa.length];
}

/** Linear blend of two 0xRRGGBB colours. */
export function mixRgb(a: number, b: number, t: number): number {
  return (mixChannel(a, b, 16, t) << 16) | (mixChannel(a, b, 8, t) << 8) | mixChannel(a, b, 0, t);
}

function mixChannel(a: number, b: number, shift: number, t: number): number {
  const x = (a >>> shift) & 0xff;
  const y = (b >>> shift) & 0xff;
  return Math.round(x + (y - x) * t);
}

/** Pack 0xRRGGBB and alpha (0..1) into the u32 colour word whose bytes are R, G, B, A. */
export function packRgba(rgb: number, alpha: number): number {
  const r = (rgb >>> 16) & 0xff;
  const g = (rgb >>> 8) & 0xff;
  const b = rgb & 0xff;
  const a = Math.round(alpha * 255);
  return ((r | (g << 8) | (b << 16) | (a << 24)) >>> 0);
}

/** CSS hex colour for 0xRRGGBB. */
export function cssHex(rgb: number): string {
  return `#${rgb.toString(16).padStart(6, "0")}`;
}

function bodyRgb(flags: number, rgb: number): number {
  let c = rgb;
  if ((flags & FLAG_FROZEN) !== 0) c = mixRgb(c, ICE_RGB, FROZEN_MIX);
  let lift = 0;
  if ((flags & FLAG_BAT) !== 0) lift += 0.15;
  if ((flags & FLAG_PUSHING) !== 0) lift += 0.2;
  if ((flags & FLAG_DASH) !== 0) lift += 0.3;
  return mixRgb(c, WHITE_RGB, Math.min(lift, 0.5));
}

export class Geometry {
  private f32 = new Float32Array(0);
  private u32 = new Uint32Array(0);
  /** Capacity in vertices. */
  private capacity = 0;
  /** Vertices written by the current build(). */
  private used = 0;

  readonly background: Span = { first: 0, count: 0 };
  readonly world: Span = { first: 0, count: 0 };
  readonly players: Span = { first: 0, count: 0 };

  /** Word view of the vertex store; the first `wordCount` words are the current frame. Valid until the next build(). */
  get words(): Uint32Array {
    return this.u32;
  }

  /** Number of 32-bit words in the current frame (3 per vertex). */
  get wordCount(): number {
    return this.used * WORDS_PER_VERTEX;
  }

  /** Rebuild every vertex for `scene`. Reads scene.view fresh; keeps no views of the frame buffer. */
  build(scene: Scene): void {
    this.used = 0;
    this.putBackground(scene);
    this.copyWorld(scene);
    this.putPlayers(scene);
  }

  private putBackground(scene: Scene): void {
    this.reserve(BACKGROUND_VERTICES);
    const top = packRgba(scene.bgTop, 1);
    const bottom = packRgba(scene.bgBottom, 1);
    this.background.first = this.used;
    this.put(-1, 1, top);
    this.put(1, 1, top);
    this.put(1, -1, bottom);
    this.put(-1, 1, top);
    this.put(1, -1, bottom);
    this.put(-1, -1, bottom);
    this.background.count = BACKGROUND_VERTICES;
  }

  /** Bitwise copy of the engine's world vertices (x f32, y f32, colour u32). */
  private copyWorld(scene: Scene): void {
    const src = scene.view.u32;
    const available = Math.floor((src.length - scene.worldOffset) / WORDS_PER_VERTEX);
    const count = Math.max(0, Math.min(scene.worldCount, available));
    this.reserve(count);
    const words = count * WORDS_PER_VERTEX;
    const dst = this.u32;
    const to = this.used * WORDS_PER_VERTEX;
    for (let i = 0; i < words; i++) dst[to + i] = src[scene.worldOffset + i];
    this.world.first = this.used;
    this.world.count = count;
    this.used += count;
  }

  private putPlayers(scene: Scene): void {
    const players = scene.players;
    this.reserve(players.length * PLAYER_MAX_VERTICES);
    this.players.first = this.used;
    for (let i = 0; i < players.length; i++) {
      const p = players[i];
      if (p.team !== TEAM_SPECTATOR) this.putPlayer(p);
    }
    this.players.count = this.used - this.players.first;
  }

  private putPlayer(p: PlayerRec): void {
    const rgb = playerRgb(p.team, p.id);
    if ((p.flags & FLAG_ROCKET_AIM) !== 0) this.putAim(p, rgb);
    this.putBody(p, rgb);
    if ((p.flags & FLAG_LOCAL) !== 0) this.putMarker(p);
  }

  /** Thin line from the player centre along `aim`, fading nothing (constant alpha). */
  private putAim(p: PlayerRec, rgb: number): void {
    const dx = Math.cos(p.aim);
    const dy = Math.sin(p.aim);
    const len = p.size * AIM_LENGTH;
    const hw = p.size * AIM_HALF_WIDTH;
    const ex = p.x + dx * len;
    const ey = p.y + dy * len;
    const nx = -dy * hw;
    const ny = dx * hw;
    const colour = packRgba(rgb, AIM_ALPHA);
    this.put(p.x + nx, p.y + ny, colour);
    this.put(p.x - nx, p.y - ny, colour);
    this.put(ex - nx, ey - ny, colour);
    this.put(p.x + nx, p.y + ny, colour);
    this.put(ex - nx, ey - ny, colour);
    this.put(ex + nx, ey + ny, colour);
  }

  /** Square of side `size` centred on the player, rotated by `angle`. */
  private putBody(p: PlayerRec, rgb: number): void {
    const colour = packRgba(bodyRgb(p.flags, rgb), (p.flags & FLAG_GHOST) !== 0 ? GHOST_ALPHA : 1);
    const h = p.size / 2;
    const co = Math.cos(p.angle);
    const si = Math.sin(p.angle);
    const x = p.x;
    const y = p.y;
    // Corner (lx, ly) maps to (x + lx*co - ly*si, y + lx*si + ly*co).
    const ax = x - h * co + h * si;
    const ay = y - h * si - h * co;
    const bx = x + h * co + h * si;
    const by = y + h * si - h * co;
    const cx = x + h * co - h * si;
    const cy = y + h * si + h * co;
    const dx = x - h * co - h * si;
    const dy = y - h * si + h * co;
    this.put(ax, ay, colour);
    this.put(bx, by, colour);
    this.put(cx, cy, colour);
    this.put(ax, ay, colour);
    this.put(cx, cy, colour);
    this.put(dx, dy, colour);
  }

  /** Small upright triangle above the local player (not rotated). */
  private putMarker(p: PlayerRec): void {
    const size = p.size;
    const baseY = p.y - size / 2 - size * MARKER_GAP;
    const tipY = baseY - size * MARKER_HEIGHT;
    const hw = size * MARKER_HALF_WIDTH;
    const colour = packRgba((p.flags & FLAG_GROUNDED) !== 0 ? WHITE_RGB : AIRBORNE_RGB, MARKER_ALPHA);
    this.put(p.x, tipY, colour);
    this.put(p.x - hw, baseY, colour);
    this.put(p.x + hw, baseY, colour);
  }

  /** Grow the store (doubling) so `extra` more vertices fit. Keeps the vertices written so far. */
  private reserve(extra: number): void {
    const need = this.used + extra;
    if (need <= this.capacity) return;
    let capacity = Math.max(this.capacity * 2, INITIAL_CAPACITY);
    while (capacity < need) capacity *= 2;
    const buffer = new ArrayBuffer(capacity * VERTEX_BYTES);
    const u32 = new Uint32Array(buffer);
    u32.set(this.u32.subarray(0, this.used * WORDS_PER_VERTEX));
    this.f32 = new Float32Array(buffer);
    this.u32 = u32;
    this.capacity = capacity;
  }

  /** Append one vertex. Callers reserve capacity first. */
  private put(x: number, y: number, colour: number): void {
    const w = this.used * WORDS_PER_VERTEX;
    this.f32[w] = x;
    this.f32[w + 1] = y;
    this.u32[w + 2] = colour;
    this.used++;
  }
}
