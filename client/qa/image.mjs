// Pixel metrics computed from a viewport screenshot: void (uniform background cells),
// contrast of text drawn over media, and contrast of control borders against their surroundings.
// Rects are CSS pixels of the viewport; the PNG may be larger (device scale factor).

import { PNG } from "pngjs";

const VOID_CELL_CSS = 32;
const UNIFORM_RANGE = 6;

function luminance([r, g, b]) {
  const lin = (c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrastRatio(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Largest all-true axis-aligned rectangle in a boolean grid (histogram method); returns its cell count. */
function maxRectCells(grid, rows, cols) {
  const heights = new Array(cols).fill(0);
  let best = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) heights[c] = grid[r * cols + c] ? heights[c] + 1 : 0;
    const stack = [];
    for (let c = 0; c <= cols; c++) {
      const h = c === cols ? 0 : heights[c];
      let start = c;
      while (stack.length && stack[stack.length - 1].h >= h) {
        const top = stack.pop();
        best = Math.max(best, top.h * (c - top.start));
        start = top.start;
      }
      stack.push({ h, start });
    }
  }
  return best;
}

export function analyseScreenshot(buf, { W, H, texts = [], controls = [] }) {
  const png = PNG.sync.read(buf);
  const sx = png.width / W;
  const sy = png.height / H;
  const at = (x, y) => {
    const i = (y * png.width + x) * 4;
    return [png.data[i], png.data[i + 1], png.data[i + 2]];
  };
  const pixelsIn = (x0, y0, x1, y1, step = 1) => {
    const out = [];
    const ax = Math.max(0, Math.floor(x0 * sx));
    const ay = Math.max(0, Math.floor(y0 * sy));
    const bx = Math.min(png.width, Math.ceil(x1 * sx));
    const by = Math.min(png.height, Math.ceil(y1 * sy));
    for (let y = ay; y < by; y += step) for (let x = ax; x < bx; x += step) out.push(at(x, y));
    return out;
  };

  // void: 32 CSS px cells whose device pixels are all within a few levels of each other
  const cell = VOID_CELL_CSS;
  const cols = Math.max(1, Math.floor(W / cell));
  const rows = Math.max(1, Math.floor(H / cell));
  const grid = new Array(rows * cols).fill(false);
  let uniform = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const samples = pixelsIn(c * cell, r * cell, (c + 1) * cell, (r + 1) * cell, 2);
      const lo = [255, 255, 255];
      const hi = [0, 0, 0];
      for (const p of samples) {
        for (let k = 0; k < 3; k++) {
          if (p[k] < lo[k]) lo[k] = p[k];
          if (p[k] > hi[k]) hi[k] = p[k];
        }
      }
      const flat = samples.length > 0 && hi.every((v, k) => v - lo[k] <= UNIFORM_RANGE);
      grid[r * cols + c] = flat;
      if (flat) uniform++;
    }
  }
  const total = rows * cols;
  const voidRatio = uniform / total;
  const voidMaxRect = maxRectCells(grid, rows, cols) / total;

  // contrast of text over media: background = most common colour in the text box (text is the minority)
  const fails = [];
  for (const t of texts) {
    const pixels = pixelsIn(t.rect.x, t.rect.y, t.rect.x + t.rect.w, t.rect.y + t.rect.h);
    if (pixels.length === 0) continue;
    const bins = new Map();
    for (const p of pixels) {
      const key = (p[0] >> 3) * 1024 + (p[1] >> 3) * 32 + (p[2] >> 3);
      const bin = bins.get(key) ?? { n: 0, sum: [0, 0, 0] };
      bin.n++;
      bin.sum[0] += p[0];
      bin.sum[1] += p[1];
      bin.sum[2] += p[2];
      bins.set(key, bin);
    }
    let best = null;
    for (const bin of bins.values()) if (!best || bin.n > best.n) best = bin;
    const bg = best.sum.map((v) => Math.round(v / best.n));
    const ratio = contrastRatio(t.fg, bg);
    const need = t.large ? 3 : 4.5;
    if (ratio < need) fails.push({ desc: t.desc, ratio: Number(ratio.toFixed(2)), need });
  }

  // non-text: control borders against the page just outside them
  const ctrlFails = [];
  for (const c of controls) {
    const { x, y, w, h } = c.rect;
    const side = x >= 4 ? { x: x - 3, y: y + h / 2 } : { x: x + w + 3, y: y + h / 2 };
    if (side.x < 0 || side.x >= W) continue;
    const bg = at(Math.floor(side.x * sx), Math.floor(side.y * sy));
    const ratio = contrastRatio(c.border, bg);
    if (ratio < 3) ctrlFails.push({ desc: c.desc, ratio: Number(ratio.toFixed(2)) });
  }

  return {
    metrics: {
      "void.ratio": Number(voidRatio.toFixed(4)),
      "void.maxRect": Number(voidMaxRect.toFixed(4)),
      "contrast.fails": fails.length,
      "contrast.nonText.fails": ctrlFails.length,
    },
    details: {
      "contrast.fails": fails.slice(0, 60),
      "contrast.nonText.fails": ctrlFails.slice(0, 60),
    },
  };
}

/** Number of pixels that differ clearly between two same-size PNG buffers. */
export function differingPixels(bufA, bufB) {
  const a = PNG.sync.read(bufA);
  const b = PNG.sync.read(bufB);
  if (a.width !== b.width || a.height !== b.height) return -1;
  let n = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const d = Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]);
    if (d > 24) n++;
  }
  return n;
}
