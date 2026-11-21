// Camera rules from docs/CLIENT-API.md "Camera".

import type { PlayerRec, Scene } from "./frame";
import { TEAM_SPECTATOR } from "./protocol";

/** PlayerRec.flags bit 2: a ghost body, not a live sprite (frame.rs). */
const FLAG_GHOST = 2;
/** Widest the framing zooms out, as a multiple of the original view width (sprites and name tags stay legible). */
const MAX_ZOOM_OUT = 1.6;
/** HUD insets of the view as fractions of its height (top: objective bar and chip rows) and width (sides). */
const SAFE_TOP = 0.2;
const SAFE_BOTTOM = 0.1;
const SAFE_SIDE = 0.08;

/** The game view's rect in window CSS px: the largest `aspect` rectangle, centred (the rest is letterbox). */
export interface ViewRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function fitView(winW: number, winH: number, aspect: number): ViewRect {
  if (winW <= 0 || winH <= 0) return { x: 0, y: 0, w: 0, h: 0 };
  let w = winW;
  let h = w / aspect;
  if (h > winH) {
    h = winH;
    w = h * aspect;
  }
  w = Math.floor(w);
  h = Math.floor(h);
  return { x: Math.floor((winW - w) / 2), y: Math.floor((winH - h) / 2), w, h };
}

/** The largest view rect of the aspect inside the window's column [freeLeft, freeRight) (full height): landscape touch controls sit beside it. */
export function fitViewBetween(winH: number, freeLeft: number, freeRight: number, aspect: number): ViewRect {
  const v = fitView(freeRight - freeLeft, winH, aspect);
  return { x: freeLeft + v.x, y: v.y, w: v.w, h: v.h };
}

/** Publish the view rect as `--view-x/-y/-w/-h` (px) on the root element; the game canvases are placed by them. */
export function publishView(view: ViewRect): void {
  const style = document.documentElement.style;
  style.setProperty("--view-x", `${view.x}px`);
  style.setProperty("--view-y", `${view.y}px`);
  style.setProperty("--view-w", `${view.w}px`);
  style.setProperty("--view-h", `${view.h}px`);
}

export interface Camera {
  cx: number;
  cy: number;
  /** View size in world units. */
  w: number;
  h: number;
  /** Live opponents outside the view (player ids), drawn as edge indicators. */
  away: readonly number[];
  /** The world rectangle the background must cover past the arena (backdrop only); absent when the view needs none. */
  fill?: Bounds;
}

/**
 * Centre of the last followed player. Held while nothing is followed (the local player is
 * dead or not yet spawned) so the view does not jump to the arena middle and back.
 */
let lastCentre: { x: number; y: number } | null = null;
/** Player a spectator follows; -1 none. Only used while the viewer has no local player. */
let spectateId = -1;
/** QA hook (client/qa/playfield.mjs): the view the last computed frame was drawn with. The game never reads it. */
const qaView: { cx: number; cy: number; w: number; h: number; aw: number; ah: number; bx0: number; by0: number; bx1: number; by1: number; tick: number; follow: number; away: readonly number[]; live: readonly (readonly [number, number, number])[] } = {
  cx: 0,
  cy: 0,
  w: 0,
  h: 0,
  aw: 0,
  ah: 0,
  bx0: 0,
  by0: 0,
  bx1: 0,
  by1: 0,
  tick: -1,
  follow: -1,
  away: [],
  live: [],
};
Object.assign(globalThis, { __qaCam: qaView });

/** QA hook: the menu backdrop's drawn view (backdropCamera), which computeCamera's hook above does not carry. The game never reads it. */
export function publishBackdrop(cam: Camera, arenaW: number, arenaH: number): void {
  qaView.cx = cam.cx;
  qaView.cy = cam.cy;
  qaView.w = cam.w;
  qaView.h = cam.h;
  qaView.aw = arenaW;
  qaView.ah = arenaH;
  // bx/by (the walls' extent) are published by backdropCamera
  qaView.away = cam.away;
}

/**
 * The view for a frame. With a subject (the followed player, else its held centre) the view follows it at the base
 * view size: other players never widen it, and those out of view are listed in `away`
 * for an edge indicator. Without one (a replay or spectator following nobody) the view frames every live sprite, zooming
 * out only as far as the group needs (up to MAX_ZOOM_OUT) with HUD insets kept clear. Either way it stays inside the arena.
 * No state beyond the held centre: the frame's positions are used as they come (no easing).
 */
export function computeCamera(scene: Scene, local?: PlayerRec): Camera {
  let sx: number;
  let sy: number;
  if (local) {
    sx = local.x;
    sy = local.y;
    lastCentre = { x: sx, y: sy };
  } else if (lastCentre) {
    sx = lastCentre.x;
    sy = lastCentre.y;
  } else {
    sx = scene.arenaW / 2;
    sy = scene.arenaH / 2;
  }
  const live = liveSprites(scene);
  // The framed group: the subject alone when there is one (E42: walking away from the training dummies zoomed the view
  // out to keep them in), else every live sprite.
  const follows = local !== undefined || lastCentre !== null;
  let minX = sx;
  let maxX = sx;
  let minY = sy;
  let maxY = sy;
  if (!follows && live.length > 0) {
    minX = Infinity;
    maxX = -Infinity;
    minY = Infinity;
    maxY = -Infinity;
    for (const p of live) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    }
  }
  const w0 = scene.viewWidth;
  const h0 = w0 / scene.viewAspect;
  // The camera's bounds are the arena, as in the original: a map whose arena fits the base view has a fixed camera
  // centred on it (no follow, no zoom pumping), and a larger arena is followed and clamped to its edges. Ground or
  // map machinery past the arena edge is not framed.
  const bounds: Bounds = { x0: 0, y0: 0, x1: Math.max(0, scene.arenaW), y1: Math.max(0, scene.arenaH) };
  // The view aspect reaches the client as an f32, so a view exactly the arena's size can land a hair short of it (classic
  // 1.6 is 1.6000000238 in f32): the fit test allows that rounding, or a classic arena that fills the view would follow.
  const FIT_EPS = 1e-4;
  const fitsX = bounds.x1 - bounds.x0 <= w0 + FIT_EPS;
  const fitsY = bounds.y1 - bounds.y0 <= h0 + FIT_EPS;
  // The narrowest view that keeps the group inside the insets, on the axes that move.
  const needX = fitsX ? 0 : (maxX - minX) / (1 - 2 * SAFE_SIDE);
  const needY = fitsY ? 0 : ((maxY - minY) * scene.viewAspect) / (1 - SAFE_TOP - SAFE_BOTTOM);
  const w = Math.min(Math.max(needX, needY, w0), w0 * MAX_ZOOM_OUT);
  const h = w / scene.viewAspect;
  const cx = fitsX ? (bounds.x0 + bounds.x1) / 2 : axisCentre(sx, minX, maxX, w, w * SAFE_SIDE, w * SAFE_SIDE, bounds.x0, bounds.x1);
  const cy = fitsY ? (bounds.y0 + bounds.y1) / 2 : axisCentre(sy, minY, maxY, h, h * SAFE_TOP, h * SAFE_BOTTOM, bounds.y0, bounds.y1);
  const away: number[] = [];
  for (const p of live) {
    if (p === local) continue;
    if (Math.abs(p.x - cx) > w / 2 || Math.abs(p.y - cy) > h / 2) away.push(p.id);
  }
  qaView.cx = cx;
  qaView.cy = cy;
  qaView.w = w;
  qaView.h = h;
  qaView.aw = scene.arenaW;
  qaView.ah = scene.arenaH;
  qaView.bx0 = bounds.x0;
  qaView.by0 = bounds.y0;
  qaView.bx1 = bounds.x1;
  qaView.by1 = bounds.y1;
  qaView.tick = scene.tick;
  qaView.follow = local?.id ?? -1;
  qaView.away = away;
  return { cx, cy, w, h, away };
}

/** Live sprites: spectators, ghosts and dead players are not framed. */
function liveSprites(scene: Scene): PlayerRec[] {
  const out: PlayerRec[] = [];
  for (const p of scene.players) {
    if (p.team === TEAM_SPECTATOR || (p.flags & FLAG_GHOST) !== 0) continue;
    if (scene.scores.find((r) => r.id === p.id)?.alive) out.push(p);
  }
  return out;
}

/**
 * Centre on one axis for the view length `len`, with the group [lo, hi] inside the view (insets `a` on the
 * low side and `b` on the high side when they fit, else without insets, else the subject `l` alone), the
 * centre weighted halfway to the subject, and the view kept inside the playable bounds [blo, bhi] unless the subject is outside it.
 */
function axisCentre(l: number, lo: number, hi: number, len: number, a: number, b: number, blo: number, bhi: number): number {
  const pref = (l + (lo + hi) / 2) / 2;
  let c0 = hi - len / 2 + b;
  let c1 = lo + len / 2 - a;
  if (c0 > c1) {
    c0 = hi - len / 2;
    c1 = lo + len / 2;
  }
  if (c0 > c1) {
    c0 = l - len / 2 + a;
    c1 = l + len / 2 - b;
  }
  // The group's range is the last word: a player may stand past the bounds (a blast zone) and must stay in view.
  // The bounds clamp moves the centre only while the whole group stays inside the view, so an edge group shows with
  // the view ending at the bounds' edge (no VOID past it); otherwise the centre keeps the group inside its insets.
  const p = Math.min(Math.max(pref, c0), c1);
  const q = clampAxis(p, len, blo, bhi);
  return q >= hi - len / 2 && q <= lo + len / 2 ? q : p;
}

/**
 * The margin the backdrop keeps around the arena, as a share of its size on each side: room for the name labels of players
 * at the arena's edge. The card frames the arena as a match does (static ground past the arena edge is cut, as in a match).
 * At 0.08 around the walls' extent the clip read as zoomed out next to the match view.
 */
const BACKDROP_MARGIN = 0.02;

/** The part of the map the backdrop shows: the arena with the margin on each side, in world units. Its shape is the arena's. */
export function backdropSize(scene: Scene): { w: number; h: number } {
  return { w: scene.arenaW * (1 + 2 * BACKDROP_MARGIN), h: scene.arenaH * (1 + 2 * BACKDROP_MARGIN) };
}

/**
 * Backdrop camera (the main menu's clip). The GL view is the menu card itself, untilted: `box` is its rect in CSS px.
 * The card is the rect backdropSize gives, centred on the arena, scaled so that rect fills the card edge to edge. `fill` is
 * the card's world rect: the backdrop's background covers it, so the card shows the map's own background (no page colour,
 * no void). Fixed on that centre: no follow, no zoom, so the clip holds still from its first frame. Also publishes the
 * walls' extent and the live players' ids and world positions to the QA hook (qaView).
 */
export function backdropCamera(scene: Scene, box: { w: number; h: number }): Camera {
  // World units per CSS px: the larger of the shown rect's ratios to the card, so the whole shown rect fits on both axes.
  const shown = backdropSize(scene);
  const k = Math.max(shown.w / box.w, shown.h / box.h);
  const w = box.w * k;
  const h = box.h * k;
  const cx = scene.arenaW / 2;
  const cy = scene.arenaH / 2;
  const ext = backdropBounds(scene);
  // the drawn static extent (walls included) for the QA hook
  qaView.bx0 = ext.x0;
  qaView.by0 = ext.y0;
  qaView.bx1 = ext.x1;
  qaView.by1 = ext.y1;
  qaView.live = liveSprites(scene).map((p) => [p.id, p.x, p.y] as const);
  return {
    cx,
    cy,
    w,
    h,
    away: [],
    fill: { x0: cx - w / 2, y0: cy - h / 2, x1: cx + w / 2, y1: cy + h / 2 },
  };
}

function clampAxis(c: number, view: number, lo: number, hi: number): number {
  if (hi - lo < view) return (lo + hi) / 2;
  return Math.min(Math.max(c, lo + view / 2), hi - view / 2);
}

/** A world-space rectangle. */
export interface Bounds {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
/**
 * The backdrop's bounds: the arena united with the map's static geometry (the frame's fixed extent), so static ground
 * that comes into view past the arena edge is drawn over the backdrop, never over page colour. Moving bodies,
 * projectiles, effects and aim lines are not in the extent.
 */
export function backdropBounds(scene: Scene): Bounds {
  // The fixed extent is infinite (min > max) when the map has no visible static body.
  const has = scene.fixedX0 <= scene.fixedX1 && scene.fixedY0 <= scene.fixedY1;
  return {
    x0: has ? Math.min(0, scene.fixedX0) : 0,
    y0: has ? Math.min(0, scene.fixedY0) : 0,
    x1: Math.max(0, scene.arenaW, has ? scene.fixedX1 : 0),
    y1: Math.max(0, scene.arenaH, has ? scene.fixedY1 : 0),
  };
}

/** Clip-space transform (sx, sy, ox, oy): clip = (x*sx + ox, y*sy + oy). */
export function worldXf(cam: Camera): [number, number, number, number] {
  return [2 / cam.w, -2 / cam.h, (-2 * cam.cx) / cam.w, (2 * cam.cy) / cam.h];
}

/** The record the camera and HUD follow: the local player, else the spectated player (or none). */
export function findLocal(scene: Scene): PlayerRec | undefined {
  const id = scene.localId >= 0 ? scene.localId : spectateId;
  if (id < 0) return undefined;
  return scene.players.find((p) => p.id === id);
}

/** Move the spectator's target `step` players along (+1 next, -1 previous), wrapping. */
export function cycleSpectate(scene: Scene, step: number): void {
  const ids = scene.players.filter((p) => p.team !== TEAM_SPECTATOR).map((p) => p.id);
  if (ids.length === 0) {
    spectateId = -1;
    return;
  }
  const at = ids.indexOf(spectateId);
  const next = at < 0 ? (step < 0 ? ids.length - 1 : 0) : (at + step + ids.length) % ids.length;
  spectateId = ids[next] ?? -1;
}

/** Player id the spectator follows; -1 none. */
export function spectatedId(): number {
  return spectateId;
}
