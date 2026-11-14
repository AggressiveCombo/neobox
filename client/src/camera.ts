// Camera rules from docs/CLIENT-API.md "Camera".

import type { PlayerRec, Scene } from "./frame";
import { TEAM_SPECTATOR } from "./protocol";

/** The original's view is `viewWidth` wide and `viewWidth / 1.6` high. */
const ORIGINAL_ASPECT = 1.6;

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

export function computeCamera(scene: Scene, canvasW: number, canvasH: number, local?: PlayerRec): Camera {
  const aspect = canvasW > 0 && canvasH > 0 ? canvasW / canvasH : ORIGINAL_ASPECT;
  const baseH = scene.viewWidth / ORIGINAL_ASPECT;
  // landscape: show at least the original's whole view (extra space on the
  // long axis); portrait: keep the original's vertical extent and narrow
  // the view, so players stay big enough to play (DEVIATIONS.md P2)
  let w: number;
  let h: number;
  if (aspect >= ORIGINAL_ASPECT || aspect < 1) {
    h = baseH;
    w = h * aspect;
  } else {
    w = scene.viewWidth;
    h = w / aspect;
  }
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
