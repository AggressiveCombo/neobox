// Camera rules from docs/CLIENT-API.md "Camera".

import type { PlayerRec, Scene } from "./frame";

/** The original's view is `viewWidth` wide and `viewWidth / 1.6` high. */
const ORIGINAL_ASPECT = 1.6;

export interface Camera {
  cx: number;
  cy: number;
  /** View size in world units. */
  w: number;
  h: number;
}

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
  let cx = scene.arenaW / 2;
  let cy = scene.arenaH / 2;
  if (local) {
    cx = local.x;
    cy = local.y;
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

/** Find the local player record (or null when spectating). */
export function findLocal(scene: Scene): PlayerRec | undefined {
  if (scene.localId < 0) return undefined;
  return scene.players.find((p) => p.id === scene.localId);
}
