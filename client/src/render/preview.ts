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
  const scene = readScene(fb);
  const aspect = scene.viewAspect > 0 ? scene.viewAspect : 1.6;
  canvas.style.setProperty("--preview-aspect", String(aspect));
  const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
  const cssW = canvas.clientWidth > 0 ? canvas.clientWidth : Math.max(canvas.width / dpr, 320);
  const cssH = canvas.clientHeight > 0 ? canvas.clientHeight : cssW / aspect;
  canvas.width = Math.max(1, Math.round(cssW * dpr));
  canvas.height = Math.max(1, Math.round(cssH * dpr));
  const w = canvas.width;
  const h = canvas.height;

  // Read the frame buffer fresh: its views are re-created when wasm memory grows.
  const { u32, f32 } = fb;
  const available = Math.floor((u32.length - scene.worldOffset) / WORDS_PER_VERTEX);
  const vertices = Math.max(0, Math.min(scene.worldCount, available));
  const triangles = Math.floor(vertices / 3);

  const hasArena = scene.arenaW > 0 && scene.arenaH > 0;
  let minX = 0;
  let minY = 0;
  let bw = scene.arenaW;
  let bh = scene.arenaH;
  if (!hasArena) {
    // Editor-created maps often have arenaW/arenaH = 0; frame actual geometry or the default view box around (0, 0).
    let vx0 = Number.POSITIVE_INFINITY;
    let vy0 = Number.POSITIVE_INFINITY;
    let vx1 = Number.NEGATIVE_INFINITY;
    let vy1 = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < triangles * 3; i++) {
      const o = scene.worldOffset + i * WORDS_PER_VERTEX;
      const vx = f32[o] ?? 0;
      const vy = f32[o + 1] ?? 0;
      if (vx < vx0) vx0 = vx;
      if (vx > vx1) vx1 = vx;
      if (vy < vy0) vy0 = vy;
      if (vy > vy1) vy1 = vy;
    }
    if (triangles > 0 && Number.isFinite(vx0) && vx1 > vx0 && vy1 > vy0) {
      const pad = Math.max(vx1 - vx0, vy1 - vy0) * 0.06;
      minX = vx0 - pad;
      minY = vy0 - pad;
      bw = Math.max(vx1 - vx0 + pad * 2, 1);
      bh = Math.max(vy1 - vy0 + pad * 2, 1);
    } else {
      const vw = Math.max(scene.viewWidth, 1);
      const vh = vw / aspect;
      minX = -vw / 2;
      minY = -vh / 2;
      bw = vw;
      bh = vh;
    }
  }

  // Fit ("contain") the full arena inside the thumbnail over the map's own sky gradient so wide/tall maps aren't cropped.
  const scale = Math.min(w / bw, h / bh);
  const fitW = bw * scale;
  const fitH = bh * scale;
  const fitX = (w - fitW) / 2;
  const fitY = (h - fitH) / 2;
  const ox = fitX - minX * scale;
  const oy = fitY - minY * scale;

  const sky = ctx.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, cssHex(scene.bgTop));
  sky.addColorStop(1, cssHex(scene.bgBottom));
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h);
  ctx.save();
  // Clip to the arena bounds so off-arena geometry (e.g. outer boundary walls or death circles) never bleeds into margins.
  if (hasArena) {
    ctx.beginPath();
    ctx.rect(fitX, fitY, fitW, fitH);
    ctx.clip();
  }
  ctx.setTransform(scale, 0, 0, scale, ox, oy);
  // Canvas2D anti-aliases each triangle's edges on its own, which leaves light seams
  // between neighbours; a hairline stroke in the fill colour closes them.
  ctx.lineWidth = 1 / scale;
  ctx.lineJoin = "round";
  for (let t = 0; t < triangles; t++) {
    const v = scene.worldOffset + t * WORDS_PER_TRIANGLE;
    ctx.beginPath();
    ctx.moveTo(f32[v], f32[v + 1]);
    ctx.lineTo(f32[v + 3], f32[v + 4]);
    ctx.lineTo(f32[v + 6], f32[v + 7]);
    ctx.closePath();
    const colour = averageCss(u32[v + 2], u32[v + 5], u32[v + 8]);
    ctx.fillStyle = colour;
    ctx.strokeStyle = colour;
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
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
