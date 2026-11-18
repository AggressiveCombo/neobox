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
  // An axis the arena fits inside at the base view is fixed: centred on the arena and not part of the zoom need,
  // so a map that fits both axes has a fixed camera (no follow, no zoom pumping).
  const fitsX = scene.arenaW <= w0;
  const fitsY = scene.arenaH <= h0;
  // The narrowest view that keeps the group inside the insets, on the axes that move.
  const needX = fitsX ? 0 : (maxX - minX) / (1 - 2 * SAFE_SIDE);
  const needY = fitsY ? 0 : ((maxY - minY) * VIEW_ASPECT) / (1 - SAFE_TOP - SAFE_BOTTOM);
  const w = Math.min(Math.max(needX, needY, w0), w0 * MAX_ZOOM_OUT);
  const h = w / VIEW_ASPECT;
  const cx = fitsX ? scene.arenaW / 2 : axisCentre(sx, minX, maxX, w, w * SAFE_SIDE, w * SAFE_SIDE, scene.arenaW);
  const cy = fitsY ? scene.arenaH / 2 : axisCentre(sy, minY, maxY, h, h * SAFE_TOP, h * SAFE_BOTTOM, scene.arenaH);
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
 * centre weighted halfway to the subject, and the view kept inside the arena unless the subject is outside it.
 */
function axisCentre(l: number, lo: number, hi: number, len: number, a: number, b: number, arena: number): number {
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
  // The group's range is the last word: a player may stand past the arena box (a blast zone) and must stay in view,
  // so the arena clamp only moves the centre while the group stays inside.
  const c = clampAxis(Math.min(Math.max(pref, c0), c1), len, arena);
  return Math.min(Math.max(c, c0), c1);
}

/**
 * Backdrop camera (the main menu's clip, drawn over the whole window): the largest rectangle of the
 * window's aspect that lies inside the arena, centred on `cam`, so no off-arena colour shows at any
 * window shape. Decorative: it zooms in on portrait windows.
 */
export function coverCamera(scene: Scene, cam: Camera, aspect: number): Camera {
  const w = Math.min(scene.arenaW, scene.arenaH * aspect);
  if (!(w > 0) || !(aspect > 0)) return cam;
  const h = w / aspect;
  return { cx: clampAxis(cam.cx, w, scene.arenaW), cy: clampAxis(cam.cy, h, scene.arenaH), w, h, away: [] };
}

function clampAxis(c: number, view: number, arena: number): number {
  if (arena < view) return arena / 2;
  return Math.min(Math.max(c, view / 2), arena - view / 2);
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
