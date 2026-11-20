// CPU geometry shared by every backend. One interleaved vertex format:
// position f32 x, f32 y, then colour u8 r, g, b, a (12 bytes: float32x2 + unorm8x4).
// Vertices are built into reused typed arrays that grow by doubling and never
// shrink, so steady-state frames allocate nothing here.

import type { PlayerRec, Scene } from "../frame";
import { FLAG_AIR_JUMP, FLAG_BAT, FLAG_DASH, FLAG_FROZEN, FLAG_GHOST, FLAG_LOCAL, FLAG_PUSHING, FLAG_TELEPORT } from "../frame";
import { backdropBounds, findLocal, type Bounds } from "../camera";
import { TEAM_BLUE, TEAM_FFA, TEAM_RED, TEAM_SPECTATOR } from "../protocol";
import { prefs, type Palette } from "../prefs";
import { BIT } from "../input";

/** Bytes per vertex. */
export const VERTEX_BYTES = 12;
/** Colour outside the arena inside the view, and the clear colour: the letterbox ink (#0a0a0a) in both themes. */
export const VOID_RGB = [10 / 255, 10 / 255, 10 / 255, 1] as const;
const WORDS_PER_VERTEX = 3;
const INITIAL_CAPACITY = 1024;
const BACKGROUND_VERTICES = 18;
/** Body (6), launcher (90), egg (6), highlight ring (24), marker fill and outline (21). The trail reserves its own. */
const PLAYER_MAX_VERTICES = 147;

/** Clip transform (sx, sy, ox, oy): clip = (x*sx + ox, y*sy + oy). */
export type Xf = [number, number, number, number];

/** Vertex range of one draw call. */
export interface Span {
  first: number;
  count: number;
}

/** Team and FFA colours per palette pref (FFA is indexed by player id). Each colour-blind palette is checked under its own
 *  deficiency (RUBRIC D06 cvd.minDeltaE >= 15): team pairs and FFA sets keep CIEDE2000 >= 15 after the Machado 2009 simulation. */
export const PALETTES: Record<Palette, { red: number; blue: number; ffa: readonly number[] }> = {
  default: { red: 0xff5252, blue: 0x4d9bff, ffa: [0x9be15d, 0x4fd1c5, 0x7f9cf5, 0xf28c28, 0xb0b0ff, 0xff7f9f, 0x3fbfbf, 0xcc79a7] },
  deuteranopia: { red: 0xf85800, blue: 0x0860a0, ffa: [0x706060, 0x0050e0, 0x108030, 0x0090e0, 0x407080, 0xf06020, 0x20a090, 0xf05080] },
  protanopia: { red: 0xc00800, blue: 0x1090f0, ffa: [0x30a000, 0xa000e0, 0x609070, 0x1090f0, 0xb02060, 0x307010, 0xc00030, 0x208090] },
  tritanopia: { red: 0xfcd4d8, blue: 0x98e8fc, ffa: [0xccacf4, 0x80f4f0, 0xf0d87c, 0xf498e8, 0xf8fcd4, 0xb4b4f4, 0xb8c40c, 0xb4e438] },
};
/** WCAG relative luminance of an 0xRRGGBB colour. */
export function relLuminance(rgb: number): number {
  const lin = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin((rgb >> 16) & 255) + 0.7152 * lin((rgb >> 8) & 255) + 0.0722 * lin(rgb & 255);
}
/** Edge-chip swatches darker than this relative luminance get a white ring; lighter colours already meet 3:1 on the panel. */
export const AWAY_RING_BELOW_LUM = 0.25;

const ICE_RGB = 0xbfe9ff;
const WHITE_RGB = 0xffffff;
/** Local marker: frozen, air jump ready, air jump spent (the original's colours). */
const MARKER_FROZEN_RGB = 0x6b8aff;
const MARKER_READY_RGB = 0xffd240;
const MARKER_SPENT_RGB = 0xbbbbbb;
const GHOST_ALPHA = 0.35;
const MARKER_ALPHA = 0.9;
const FROZEN_MIX = 0.5;
/** Launcher and egg aim lines, and the countdown outline: the original's light grey, half-opaque lines. */
const LINE_RGB = 0xdddddd;
const LINE_ALPHA = 0.5;
const LINE_WIDTH = 0.03;
const LAUNCHER_RED_RGB = 0x8c2020;
/** Launcher in player sides: pivot, dashes, hub, fade-in length in charge frames, and egg reach. */
const LAUNCHER_PIVOT_X = 0.11;
const LAUNCHER_PIVOT_Y = 0.12;
const LAUNCHER_FADE_FRAMES = 6;
const DASH_COUNT = 6;
const DASH_PERIOD = 0.3;
const DASH_LENGTH = 0.15;
const HUB_X = 0.625;
const HUB_RADIUS = 0.0475;
const HUB_SIDES = 12;
const EGG_REACH = 4;
/** Motion trail: how long a position stays (ms) and its full width at the body, in player sides. */
const TRAIL_MS = 200;
const TRAIL_WIDTH = 0.4;
const TRAIL_RGB = 0x4d6d73;
/** Countdown outline stroke, and the keys that light it (the original's push, rocket, bat and grab). */
const HIGHLIGHT_STROKE = 0.08;
const HIGHLIGHT_KEYS = BIT.PUSH | BIT.ROCKET | BIT.BAT | BIT.GRAB;
/** Marker gap, height, half width and 1 px outline, in player sides. */
export const MARKER_GAP = 0.15;
export const MARKER_HEIGHT = 0.24;
export const MARKER_HALF_WIDTH = 0.2;
const MARKER_STROKE = 0.025;
const MARKER_STROKE_RGB = 0x000222;
/** Spawn preview: alpha and the vertices of its square. */
const SPAWN_ALPHA = 0.6;
const SPAWN_VERTICES = 6;

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

/** Vertices per trail segment and per quad (two triangles). */
const SEGMENT_VERTICES = 6;

/** Scratch output of poseAt, reused so mapping a vertex allocates nothing. */
const at = { x: 0, y: 0 };
/** Current local-to-world transform: origin, rotation, y-flip, pivot and scale (the original's pixi pose). */
const pose = { ox: 0, oy: 0, co: 1, si: 0, flip: 1, px: 0, py: 0, sc: 1 };

/** Set `pose`; angle in radians, flip -1 mirrors y before rotating, pivot and scale in player sides. */
function setPose(ox: number, oy: number, angle: number, flip: number, px: number, py: number, sc: number): void {
  pose.ox = ox;
  pose.oy = oy;
  pose.co = Math.cos(angle);
  pose.si = Math.sin(angle);
  pose.flip = flip;
  pose.px = px;
  pose.py = py;
  pose.sc = sc;
}

/** Map local (lx, ly), in player sides, into `at`: translate by -pivot, scale, flip y, rotate, translate. */
function poseAt(lx: number, ly: number): void {
  const a = (lx - pose.px) * pose.sc;
  const b = pose.flip * (ly - pose.py) * pose.sc;
  at.x = pose.ox + a * pose.co - b * pose.si;
  at.y = pose.oy + a * pose.si + b * pose.co;
}

/** The original's easing (`us`): a + b * easeOutBack over x in [0, c]; overshoots past a + b. */
function ease(x: number, a: number, b: number, c: number): number {
  const t = x / c - 1;
  return a + b * (t * t * ((1.70158 + 1) * t + 1.70158) + 1);
}

/** A trail sample: the body's position and when it was recorded (ms). */
interface TrailPoint {
  x: number;
  y: number;
  t: number;
}

interface Trail {
  points: TrailPoint[];
  generation: number;
}

export class Geometry {
  private f32 = new Float32Array(0);
  private u32 = new Uint32Array(0);
  /** Capacity in vertices. */
  private capacity = 0;
  /** Vertices written by the current build(). */
  private used = 0;
  /** Motion trails by player id; `generation` is the last build that drew the player. */
  private readonly trails = new Map<number, Trail>();
  private generation = 0;

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

  /** Rebuild every vertex for `scene`. Reads scene.view fresh; keeps no views of the frame buffer. `fill` widens the backdrop past the arena. */
  build(scene: Scene, fill?: Bounds): void {
    this.used = 0;
    this.putBackground(scene, fill);
    this.copyWorld(scene);
    this.putPlayers(scene);
  }

  /** The backdrop covers the playable bounds (arena united with the map geometry and `fill`): gradient over the arena's height, edge colours beyond it. */
  private putBackground(scene: Scene, fill: Bounds | undefined): void {
    this.reserve(BACKGROUND_VERTICES);
    const top = packRgba(scene.bgTop, 1);
    const bottom = packRgba(scene.bgBottom, 1);
    const b = backdropBounds(scene);
    if (fill) {
      b.x0 = Math.min(b.x0, fill.x0);
      b.y0 = Math.min(b.y0, fill.y0);
      b.x1 = Math.max(b.x1, fill.x1);
      b.y1 = Math.max(b.y1, fill.y1);
    }
    const h = Math.max(0, scene.arenaH);
    this.background.first = this.used;
    this.putBand(b.x0, b.y0, b.x1, 0, top, top);
    this.putBand(b.x0, 0, b.x1, h, top, bottom);
    this.putBand(b.x0, h, b.x1, b.y1, bottom, bottom);
    this.background.count = BACKGROUND_VERTICES;
  }

  /** Quad over x0..x1 and y0..y1: colour c0 along the y0 edge, c1 along the y1 edge. */
  private putBand(x0: number, y0: number, x1: number, y1: number, c0: number, c1: number): void {
    this.put(x0, y0, c0);
    this.put(x1, y0, c0);
    this.put(x1, y1, c1);
    this.put(x0, y0, c0);
    this.put(x1, y1, c1);
    this.put(x0, y1, c1);
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
    this.reserve(players.length * PLAYER_MAX_VERTICES + SPAWN_VERTICES);
    this.players.first = this.used;
    this.generation++;
    const now = Date.now();
    const followed = findLocal(scene);
    this.putSpawn(scene, followed);
    for (let i = 0; i < players.length; i++) {
      const p = players[i];
      if (p.team !== TEAM_SPECTATOR) this.putPlayer(scene, p, followed, now);
    }
    this.pruneTrails();
    this.players.count = this.used - this.players.first;
  }

  /** Drop the trails of players that are not drawn this frame. */
  private pruneTrails(): void {
    for (const [id, trail] of this.trails) {
      if (trail.generation !== this.generation) this.trails.delete(id);
    }
  }

  private putPlayer(scene: Scene, p: PlayerRec, followed: PlayerRec | undefined, now: number): void {
    const rgb = playerRgb(p.team, p.id);
    this.putTrail(p, now);
    // The trail took room from the up-front reservation: make sure this player's parts still fit.
    this.reserve(PLAYER_MAX_VERTICES);
    this.putLauncher(p);
    this.putEgg(p);
    this.putBody(p, rgb);
    if ((p.flags & FLAG_LOCAL) !== 0 && scene.intro > -1 && (scene.localKeys & HIGHLIGHT_KEYS) !== 0) this.putHighlight(p);
    if (p === followed) this.putMarker(p);
  }

  /**
   * The original's motion trail: the body's positions over the last TRAIL_MS, each segment as wide as
   * its newer end and thinning with age. A teleport starts a fresh trail.
   */
  private putTrail(p: PlayerRec, now: number): void {
    let trail = this.trails.get(p.id);
    if (!trail || (p.flags & FLAG_TELEPORT) !== 0) {
      trail = { points: [], generation: 0 };
      this.trails.set(p.id, trail);
    }
    trail.generation = this.generation;
    const pts = trail.points;
    pts.push({ x: p.x, y: p.y, t: now });
    while (pts.length > 1 && now - pts[0].t > TRAIL_MS) pts.shift();
    this.reserve((pts.length - 1) * SEGMENT_VERTICES);
    const colour = packRgba(TRAIL_RGB, 1);
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      const width = TRAIL_WIDTH * p.size * (1 - (now - b.t) / TRAIL_MS);
      this.putSegment(a.x, a.y, b.x, b.y, width / 2, colour);
    }
  }

  /**
   * The original's launcher, in its own frame: a dashed rail, a red hub and two grey blocks, pivoted
   * near the back and turned to the aim. Idle (charge -1) it is hidden; a fresh charge fades it in while
   * it rises from below the body.
   */
  private putLauncher(p: PlayerRec): void {
    if (p.rocketCharge < 0) return;
    const s = p.size;
    let yoff = 0;
    let alpha = 1;
    if (p.rocketCharge < LAUNCHER_FADE_FRAMES) {
      alpha = Math.min(1, Math.max(0, ease(p.rocketCharge, 0.2, 1, LAUNCHER_FADE_FRAMES)));
      yoff = ease(p.rocketCharge, -0.7 * s, 0.7 * s, LAUNCHER_FADE_FRAMES);
    }
    const flip = Math.abs(p.rocketRot) < Math.PI / 2 ? 1 : -1;
    setPose(p.x, p.y + yoff, p.rocketRot, flip, LAUNCHER_PIVOT_X, LAUNCHER_PIVOT_Y, s);
    const line = packRgba(LINE_RGB, LINE_ALPHA * alpha);
    const grey = packRgba(LINE_RGB, alpha);
    for (let k = 0; k < DASH_COUNT; k++) {
      const x0 = k * DASH_PERIOD;
      this.rectLocal(x0, -LINE_WIDTH / 2, x0 + DASH_LENGTH, LINE_WIDTH / 2, line);
    }
    const red = packRgba(LAUNCHER_RED_RGB, alpha);
    for (let i = 0; i < HUB_SIDES; i++) {
      const a0 = (2 * Math.PI * i) / HUB_SIDES;
      const a1 = (2 * Math.PI * (i + 1)) / HUB_SIDES;
      this.triLocal(
        HUB_X,
        0,
        HUB_X + HUB_RADIUS * Math.cos(a0),
        HUB_RADIUS * Math.sin(a0),
        HUB_X + HUB_RADIUS * Math.cos(a1),
        HUB_RADIUS * Math.sin(a1),
        red,
      );
    }
    this.rectLocal(-0.625, -0.095, 0.625, 0.095, grey);
    this.rectLocal(-0.625, -0.125, -0.525, 0.125, grey);
    this.rectLocal(0.15625, 0, 0.22625, 0.15, grey);
  }

  /** The egg aim line: from the centre along the egg aim, its length following the charge. */
  private putEgg(p: PlayerRec): void {
    if (p.eggCharge <= 0) return;
    setPose(p.x, p.y, p.eggAim, 1, 0, 0, p.size);
    this.rectLocal(0, -LINE_WIDTH / 2, EGG_REACH * p.eggCharge, LINE_WIDTH / 2, packRgba(LINE_RGB, LINE_ALPHA));
  }

  /** Countdown outline on the local body, drawn while the intro runs and a fire key is held. */
  private putHighlight(p: PlayerRec): void {
    setPose(p.x, p.y, p.angle, 1, 0, 0, p.size);
    const outer = 0.5 + HIGHLIGHT_STROKE / 2;
    const inner = 0.5 - HIGHLIGHT_STROKE / 2;
    const c = packRgba(LINE_RGB, 1);
    this.rectLocal(-outer, -outer, outer, -inner, c);
    this.rectLocal(-outer, inner, outer, outer, c);
    this.rectLocal(-outer, -inner, -inner, inner, c);
    this.rectLocal(inner, -inner, outer, inner, c);
  }

  /** Rectangle [x0, x1] x [y0, y1] in the current pose. */
  private rectLocal(x0: number, y0: number, x1: number, y1: number, colour: number): void {
    this.quadLocal(x0, y0, x1, y0, x1, y1, x0, y1, colour);
  }

  /** Quad with corners in order, in the current pose. */
  private quadLocal(x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, x3: number, y3: number, colour: number): void {
    poseAt(x0, y0);
    const ax = at.x;
    const ay = at.y;
    poseAt(x1, y1);
    const bx = at.x;
    const by = at.y;
    poseAt(x2, y2);
    const cx = at.x;
    const cy = at.y;
    poseAt(x3, y3);
    const dx = at.x;
    const dy = at.y;
    this.put(ax, ay, colour);
    this.put(bx, by, colour);
    this.put(cx, cy, colour);
    this.put(ax, ay, colour);
    this.put(cx, cy, colour);
    this.put(dx, dy, colour);
  }

  /** Triangle in the current pose. */
  private triLocal(x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, colour: number): void {
    poseAt(x0, y0);
    const ax = at.x;
    const ay = at.y;
    poseAt(x1, y1);
    const bx = at.x;
    const by = at.y;
    poseAt(x2, y2);
    this.put(ax, ay, colour);
    this.put(bx, by, colour);
    this.put(at.x, at.y, colour);
  }

  /** Line of half-width `hw` from (ax, ay) to (bx, by), world coordinates; nothing for a zero-length line. */
  private putSegment(ax: number, ay: number, bx: number, by: number, hw: number, colour: number): void {
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy);
    if (len === 0) return;
    const nx = (-dy / len) * hw;
    const ny = (dx / len) * hw;
    this.put(ax + nx, ay + ny, colour);
    this.put(ax - nx, ay - ny, colour);
    this.put(bx - nx, by - ny, colour);
    this.put(ax + nx, ay + ny, colour);
    this.put(bx - nx, by - ny, colour);
    this.put(bx + nx, by + ny, colour);
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

  /**
   * The original's spawn preview: a square of the player's size on the followed player's claimed
   * spawn, drawn under the bodies and blinking on the wall clock (shown for the first half of each 100 ms).
   */
  private putSpawn(scene: Scene, followed: PlayerRec | undefined): void {
    if (!followed) return;
    const row = scene.scores.find((r) => r.id === followed.id);
    if (!row || !Number.isFinite(row.spawnX) || !Number.isFinite(row.spawnY)) return;
    if (Date.now() % 100 >= 50) return;
    const h = followed.size / 2;
    const x = row.spawnX;
    const y = row.spawnY;
    const colour = packRgba(playerRgb(followed.team, followed.id), SPAWN_ALPHA);
    this.put(x - h, y - h, colour);
    this.put(x + h, y - h, colour);
    this.put(x + h, y + h, colour);
    this.put(x - h, y - h, colour);
    this.put(x + h, y + h, colour);
    this.put(x - h, y + h, colour);
  }

  /**
   * The original's marker over the followed player: a triangle whose tip sits just above the body and
   * whose flat edge is above the tip, with a thin dark outline.
   */
  private putMarker(p: PlayerRec): void {
    const size = p.size;
    const tipY = p.y - size / 2 - size * MARKER_GAP;
    const topY = tipY - size * MARKER_HEIGHT;
    const hw = size * MARKER_HALF_WIDTH;
    const rgb =
      (p.flags & FLAG_FROZEN) !== 0 ? MARKER_FROZEN_RGB : (p.flags & FLAG_AIR_JUMP) !== 0 ? MARKER_READY_RGB : MARKER_SPENT_RGB;
    const colour = packRgba(rgb, MARKER_ALPHA);
    this.put(p.x, tipY, colour);
    this.put(p.x - hw, topY, colour);
    this.put(p.x + hw, topY, colour);
    const stroke = packRgba(MARKER_STROKE_RGB, 1);
    const sh = (size * MARKER_STROKE) / 2;
    this.putSegment(p.x, tipY, p.x - hw, topY, sh, stroke);
    this.putSegment(p.x - hw, topY, p.x + hw, topY, sh, stroke);
    this.putSegment(p.x + hw, topY, p.x, tipY, sh, stroke);
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
