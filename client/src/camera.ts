// Camera rules from docs/CLIENT-API.md "Camera".

import type { PlayerRec, Scene } from "./frame";
import { TEAM_SPECTATOR } from "./protocol";

/** The original's view is `viewWidth` wide and `viewWidth / VIEW_ASPECT` high: 2:1 for its mobile user agents, 1.6:1 otherwise. */
const MOBILE_UA = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i;
const VIEW_ASPECT = MOBILE_UA.test(navigator.userAgent) ? 2 : 1.6;

/** PlayerRec.flags bit 2: a ghost body, not a live sprite (frame.rs). */
const FLAG_GHOST = 2;
/** Widest the framing zooms out, as a multiple of the original view width (sprites and name tags stay legible). */
const MAX_ZOOM_OUT = 1.6;
/** HUD insets of the view as fractions of its height (top: objective bar and chip rows) and width (sides). */
const SAFE_TOP = 0.2;
const SAFE_BOTTOM = 0.1;
const SAFE_SIDE = 0.08;

/** The game view's rect in window CSS px: the largest `VIEW_ASPECT` rectangle, centred (the rest is letterbox). */
export interface ViewRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function fitView(winW: number, winH: number): ViewRect {
  if (winW <= 0 || winH <= 0) return { x: 0, y: 0, w: 0, h: 0 };
  let w = winW;
  let h = w / VIEW_ASPECT;
  if (h > winH) {
    h = winH;
    w = h * VIEW_ASPECT;
  }
  w = Math.floor(w);
  h = Math.floor(h);
  return { x: Math.floor((winW - w) / 2), y: Math.floor((winH - h) / 2), w, h };
}

/** The largest view rect of the aspect inside the window's column [freeLeft, freeRight) (full height): landscape touch controls sit beside it. */
export function fitViewBetween(winH: number, freeLeft: number, freeRight: number): ViewRect {
  const v = fitView(freeRight - freeLeft, winH);
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
}

/**
 * Centre of the last followed player. Held while nothing is followed (the local player is
 * dead or not yet spawned) so the view does not jump to the arena middle and back.
 */
let lastCentre: { x: number; y: number } | null = null;
/** Player a spectator follows; -1 none. Only used while the viewer has no local player. */
let spectateId = -1;
/** QA hook (client/qa/playfield.mjs): the view the last computed frame was drawn with. The game never reads it. */
const qaView: { cx: number; cy: number; w: number; h: number; tick: number; follow: number; away: readonly number[] } = {
  cx: 0,
  cy: 0,
  w: 0,
  h: 0,
  tick: -1,
  follow: -1,
  away: [],
};
Object.assign(globalThis, { __qaCam: qaView });

/**
 * The view for a frame. It frames every live sprite: the subject (the followed player, else the held
 * centre, else the arena middle) is weighted into the middle of the group, the view zooms out only as far
 * as the group needs (up to MAX_ZOOM_OUT) with HUD insets kept clear, and it stays inside the arena.
 * Live opponents still outside the view are listed in `away` for edge indicators. No state beyond the
 * held centre: the frame's positions are used as they come (no easing).
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
  let minX = sx;
  let maxX = sx;
  let minY = sy;
  let maxY = sy;
  if (live.length > 0) {
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
  const h0 = w0 / VIEW_ASPECT;
  // An axis the playable bounds fit inside at the base view is fixed: centred on them and not part of the zoom need,
  // so a map that fits both axes has a fixed camera (no follow, no zoom pumping).
  const bounds = playBounds(scene);
  const fitsX = bounds.x1 - bounds.x0 <= w0;
  const fitsY = bounds.y1 - bounds.y0 <= h0;
  // The narrowest view that keeps the group inside the insets, on the axes that move.
  const needX = fitsX ? 0 : (maxX - minX) / (1 - 2 * SAFE_SIDE);
  const needY = fitsY ? 0 : ((maxY - minY) * VIEW_ASPECT) / (1 - SAFE_TOP - SAFE_BOTTOM);
  const w = Math.min(Math.max(needX, needY, w0), w0 * MAX_ZOOM_OUT);
  const h = w / VIEW_ASPECT;
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
 * Backdrop camera (the main menu's clip). The view is the whole window at its own scale, placed so the arena's
 * shorter side spans the menu square's bounding box `box` (window CSS px; the turned square lies inside it) with 4%
 * to spare. The turned square then shows arena only: no VOID, no page colour. Fixed on the arena's centre with the
 * box's centre on screen, so the clip holds still from its first frame (no follow, no zoom).
 */
export function backdropCamera(scene: Scene, box: { cx: number; cy: number; side: number }, winW: number, winH: number): Camera {
  const k = Math.min(scene.arenaW, scene.arenaH) / (box.side * 1.04);
  return {
    cx: scene.arenaW / 2 + (winW / 2 - box.cx) * k,
    cy: scene.arenaH / 2 + (winH / 2 - box.cy) * k,
    w: winW * k,
    h: winH * k,
    away: [],
  };
}

function clampAxis(c: number, view: number, lo: number, hi: number): number {
  if (hi - lo < view) return (lo + hi) / 2;
  return Math.min(Math.max(c, lo + view / 2), hi - view / 2);
}

/**
 * The playable bounds: the arena united with the map's geometry (world vertices, x f32 and y f32 per 3-word vertex,
 * as geometry.ts copies them). Ground past the arena edge is framed and backed, so no legal spot shows VOID.
 */
export interface Bounds {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
export function playBounds(scene: Scene): Bounds {
  const b: Bounds = { x0: 0, y0: 0, x1: Math.max(0, scene.arenaW), y1: Math.max(0, scene.arenaH) };
  const f = scene.view.f32;
  const available = Math.floor((f.length - scene.worldOffset) / 3);
  const count = Math.max(0, Math.min(scene.worldCount, available));
  for (let i = 0; i < count; i++) {
    const at = scene.worldOffset + 3 * i;
    const x = f[at];
    const y = f[at + 1];
    if (x < b.x0) b.x0 = x;
    if (x > b.x1) b.x1 = x;
    if (y < b.y0) b.y0 = y;
    if (y > b.y1) b.y1 = y;
  }
  return b;
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
