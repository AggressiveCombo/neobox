// Lobby map preview on plain Canvas2D: the arena fitted to the canvas, background
// gradient, then each world triangle filled with the average of its vertex colours.

import type { FrameView } from "../engine";
import { readScene } from "../frame";
import { cssHex } from "./geometry";

const MAX_DPR = 2;
const WORDS_PER_VERTEX = 3;
const WORDS_PER_TRIANGLE = 3 * WORDS_PER_VERTEX;

export function drawMapPreview(canvas: HTMLCanvasElement, fb: FrameView): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
  const cssW = canvas.clientWidth > 0 ? canvas.clientWidth : canvas.width / dpr;
  const cssH = canvas.clientHeight > 0 ? canvas.clientHeight : canvas.height / dpr;
  canvas.width = Math.max(1, Math.round(cssW * dpr));
  canvas.height = Math.max(1, Math.round(cssH * dpr));
  const w = canvas.width;
  const h = canvas.height;

  const scene = readScene(fb);
  const aw = Math.max(scene.arenaW, 1);
  const ah = Math.max(scene.arenaH, 1);
  const scale = Math.min(w / aw, h / ah);
  const ox = (w - aw * scale) / 2;
  const oy = (h - ah * scale) / 2;

  const sky = ctx.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, cssHex(scene.bgTop));
  sky.addColorStop(1, cssHex(scene.bgBottom));
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h);
  ctx.setTransform(scale, 0, 0, scale, ox, oy);

  // Read the frame buffer fresh: its views are re-created when wasm memory grows.
  const { u32, f32 } = fb;
  const available = Math.floor((u32.length - scene.worldOffset) / WORDS_PER_VERTEX);
  const vertices = Math.max(0, Math.min(scene.worldCount, available));
  const triangles = Math.floor(vertices / 3);
  for (let t = 0; t < triangles; t++) {
    const v = scene.worldOffset + t * WORDS_PER_TRIANGLE;
    ctx.beginPath();
    ctx.moveTo(f32[v], f32[v + 1]);
    ctx.lineTo(f32[v + 3], f32[v + 4]);
    ctx.lineTo(f32[v + 6], f32[v + 7]);
    ctx.closePath();
    ctx.fillStyle = averageCss(u32[v + 2], u32[v + 5], u32[v + 8]);
    ctx.fill();
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

/** Average three packed colour words (bytes R, G, B, A) into a CSS rgba() string. */
function averageCss(c0: number, c1: number, c2: number): string {
  const r = channelAverage(c0, c1, c2, 0);
  const g = channelAverage(c0, c1, c2, 8);
  const b = channelAverage(c0, c1, c2, 16);
  const a = channelAverage(c0, c1, c2, 24);
  return `rgba(${r}, ${g}, ${b}, ${a / 255})`;
}

function channelAverage(c0: number, c1: number, c2: number, shift: number): number {
  return Math.round((((c0 >>> shift) & 0xff) + ((c1 >>> shift) & 0xff) + ((c2 >>> shift) & 0xff)) / 3);
}
