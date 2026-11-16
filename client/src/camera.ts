// Camera rules from docs/CLIENT-API.md "Camera".

import type { PlayerRec, Scene } from "./frame";
import { TEAM_SPECTATOR } from "./protocol";

/** The original's view is `viewWidth` wide and `viewWidth / VIEW_ASPECT` high: 2:1 for its mobile user agents, 1.6:1 otherwise. */
const MOBILE_UA = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i;
const VIEW_ASPECT = MOBILE_UA.test(navigator.userAgent) ? 2 : 1.6;

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
}

/**
 * Centre of the last followed player. Held while nothing is followed (the local player is
 * dead or not yet spawned) so the view does not jump to the arena middle and back.
 */
let lastCentre: { x: number; y: number } | null = null;
/** Player a spectator follows; -1 none. Only used while the viewer has no local player. */
let spectateId = -1;

export function computeCamera(scene: Scene, local?: PlayerRec): Camera {
  const w = scene.viewWidth;
  const h = w / VIEW_ASPECT;
  let cx: number;
  let cy: number;
  if (local) {
    cx = local.x;
    cy = local.y;
    lastCentre = { x: cx, y: cy };
  } else if (lastCentre) {
    cx = lastCentre.x;
    cy = lastCentre.y;
  } else {
    cx = scene.arenaW / 2;
    cy = scene.arenaH / 2;
  }
  cx = clampAxis(cx, w, scene.arenaW);
  cy = clampAxis(cy, h, scene.arenaH);
  return { cx, cy, w, h };
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
  return { cx: clampAxis(cam.cx, w, scene.arenaW), cy: clampAxis(cam.cy, h, scene.arenaH), w, h };
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
