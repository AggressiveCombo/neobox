// Map editor drawing: grid, bodies, joints, markers, selection and the preview
// of the gesture in progress. The canvas is sized to its CSS box times the
// device pixel ratio (capped at 2) and drawn in CSS pixels.
import { aspectFor } from "../map-aspect";

import { type Pt } from "./geom";
import {
  type BodyGeo,
  type Kind,
  type Ref,
  bodyBounds,
  bodyById,
  bodyGeo,
  bodyXf,
  getList,
  isCircle,
  jointAnchors,
  shapeWorld,
  toWorld,
} from "./model";
import { type Obj, asObj, list, num } from "./schema";

/** `scale` is screen pixels per map unit; (x, y) is the map point at the canvas centre. */
export interface View {
  x: number;
  y: number;
  scale: number;
}

export const MIN_SCALE = 0.02;
export const MAX_SCALE = 200;

export type Preview =
  | { kind: "rect"; a: Pt; b: Pt }
  | { kind: "circle"; c: Pt; r: Pt }
  | { kind: "poly"; pts: Pt[]; cursor: Pt | null }
  | { kind: "joint"; from: Pt; cursor: Pt | null };

export interface Scene {
  sel: readonly Ref[];
  preview: Preview | null;
  /** Body being edited in place: other bodies are dimmed and its selected shapes highlighted. */
  scope: { bi: number; shapes: readonly number[] } | null;
  /**
   * A gesture moves `bodies` of `base` (the doc it started from): the static layer keeps those bodies
   * where `base` has them and they are drawn from `doc` on each frame, so a drag does not redraw the map.
   */
  moving: { base: Obj; bodies: readonly number[] } | null;
}

export function clampScale(s: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
}

export function worldAt(v: View, w: number, h: number, px: number, py: number): Pt {
  return { x: v.x + (px - w / 2) / v.scale, y: v.y + (py - h / 2) / v.scale };
}

export function screenAt(v: View, w: number, h: number, p: Pt): Pt {
  return { x: w / 2 + (p.x - v.x) * v.scale, y: h / 2 + (p.y - v.y) * v.scale };
}

const MARKER_KINDS = ["spawn", "turret", "grapple", "cap"] as const;

/** The editor's opening view: the game's default view (`frameOf`), `Screen width` map units across the canvas. */
export function fitView(doc: Obj, w: number): View {
  const f = frameOf(doc);
  return { x: f.cx, y: f.cy, scale: clampScale(w / f.width) };
}

const BG = "#0a0a0a";
const GRID = "#1c1c1c";
const AXIS = "#333333";
const EDGE = "rgba(255, 255, 255, 0.35)";
const ACCENT = "#0095ff";
const ACCENT_FILL = "rgba(0, 149, 255, 0.14)";
const FRAME = "rgba(0, 149, 255, 0.6)";
const JOINT_COLOUR = ["#e8a33b", "#5ab38b", "#4fa3d1"] as const;
const MARKER_COLOUR: Record<(typeof MARKER_KINDS)[number], string> = {
  spawn: "#5ab38b",
  turret: "#d4574f",
  grapple: "#7d6bd6",
  cap: "#e8a33b",
};
const STEPS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000];
const TAU = Math.PI * 2;

function gridStep(scale: number): number {
  for (const s of STEPS) if (s * scale >= 40) return s;
  return STEPS[STEPS.length - 1]!;
}

/**
 * The static layers of the last drawn view, rendered LAYER_MARGIN CSS px past each edge of the canvas. The bodies are cut
 * at the moving ones: `runs[j]` holds the static bodies between moving body `moving[j - 1]` and `moving[j]` in a bitmap.
 * The first run is opaque and also holds the grid and the frame; the last also holds the joints that touch no moving body.
 * A run with no bodies is null, except the first and the last. A drag frame blits each run, then draws the moving body
 * after it live, so bodies and joints come in the order of a rest frame, which draws every body and then every joint.
 * Markers and the selection are drawn on every frame; a selection change blits the layers, and a pan blits them shifted,
 * redrawing only once the view has moved more than the margin.
 */
interface Layer {
  target: HTMLCanvasElement;
  doc: Obj;
  view: View;
  w: number;
  h: number;
  dpr: number;
  scopeBi: number;
  skip: readonly number[];
  moving: readonly number[];
  runs: readonly (HTMLCanvasElement | null)[];
}
let layer: Layer | null = null;
/** CSS px drawn past each canvas edge, so a pan of up to this much reuses the layer. */
const LAYER_MARGIN = 256;
/** A view change within this long of the previous one is part of a gesture: the layer is moved and scaled, not redrawn. */
const GESTURE_MS = 250;
/** The full render after a gesture follows this long after its last view change. */
const SETTLE_MS = 120;
/** The view of the previous draw and when it last changed. */
let lastView: View | null = null;
let lastChange = -Infinity;
let settleTimer: number | undefined;
/** Set while the settle timer draws: the gesture is over, so the layer is redrawn. */
let settling = false;
/** Reused canvases of the layer runs, by run index. */
const runScratch: HTMLCanvasElement[] = [];
const NO_SKIP: readonly number[] = [];

/** Draw body `i` when its bounds meet the canvas; (ox, oy) is the map origin in CSS px and k the px per unit. */
function drawBodyAt(c: CanvasRenderingContext2D, body: Obj, i: number, scopeBi: number, ox: number, oy: number, k: number, w: number, h: number): void {
  const geo = bodyGeo(body);
  const bb = geo.bounds;
  if (!bb || bb.maxX * k + ox < 0 || bb.minX * k + ox > w || bb.maxY * k + oy < 0 || bb.minY * k + oy > h) return;
  drawBody(c, geo, body["50"] === true, ox, oy, k, scopeBi >= 0 && i !== scopeBi ? 0.3 : 1);
}

/** A canvas of the given device size, reusing `reuse` when it is given. */
function sizedCanvas(reuse: HTMLCanvasElement | null, pw: number, ph: number): HTMLCanvasElement {
  const el = reuse ?? document.createElement("canvas");
  if (el.width !== pw || el.height !== ph) {
    el.width = pw;
    el.height = ph;
  }
  return el;
}

/** The indices of the moving bodies in `skip` that name a body, ascending and without repeats. */
function movingBodies(bodyCount: number, skip: readonly number[]): number[] {
  const set = new Set<number>();
  for (const i of skip) if (i >= 0 && i < bodyCount) set.add(i);
  return [...set].sort((a, b) => a - b);
}

/** Draw joints at the joint alpha of the scope: all of them, or only the live ones of a drag. */
function drawJointSet(c: CanvasRenderingContext2D, doc: Obj, joints: readonly Obj[], S: (p: Pt) => Pt, scopeBi: number): void {
  c.globalAlpha = scopeBi >= 0 ? 0.3 : 1;
  drawJoints(c, doc, joints, S);
  c.globalAlpha = 1;
}

/** Most moving bodies a drag keeps runs for: each one costs a canvas, so a larger selection is drawn live. */
const MAX_MOVING_LAYERS = 4;

/**
 * Draw the static runs for this view: the canvases' device size plus LAYER_MARGIN on each side, same centre. Null when
 * there are more moving bodies than MAX_MOVING_LAYERS.
 */
function renderLayer(target: HTMLCanvasElement, doc: Obj, view: View, w: number, h: number, dpr: number, scopeBi: number, skip: readonly number[]): Layer | null {
  const bodies = getList(doc, "body");
  const moving = movingBodies(bodies.length, skip);
  if (moving.length > MAX_MOVING_LAYERS) return null;
  // The layers are a larger viewport on the same centre, so every drawing helper works on them unchanged.
  const lw = w + 2 * LAYER_MARGIN;
  const lh = h + 2 * LAYER_MARGIN;
  const pw = Math.round(lw * dpr);
  const ph = Math.round(lh * dpr);
  const S = (p: Pt): Pt => screenAt(view, lw, lh, p);
  const k = view.scale;
  const ox = lw / 2 - view.x * k;
  const oy = lh / 2 - view.y * k;
  const fixed = splitJoints(doc, skip).fixed;
  const runs: (HTMLCanvasElement | null)[] = [];
  for (let j = 0; j <= moving.length; j++) {
    const first = j === 0;
    const last = j === moving.length;
    const from = first ? 0 : moving[j - 1]! + 1;
    const to = last ? bodies.length : moving[j]!;
    if (!first && !last && from >= to) {
      runs.push(null);
      continue;
    }
    const canvas = sizedCanvas(runScratch[j] ?? null, pw, ph);
    runScratch[j] = canvas;
    const c = canvas.getContext("2d");
    if (!c) return null;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, lw, lh);
    if (first) {
      c.fillStyle = BG;
      c.fillRect(0, 0, lw, lh);
      drawGrid(c, view, lw, lh);
      drawFrame(c, doc, S);
    }
    for (let i = from; i < to; i++) {
      const b = bodies[i];
      if (b) drawBodyAt(c, b, i, scopeBi, ox, oy, k, lw, lh);
    }
    if (last) drawJointSet(c, doc, fixed, S, scopeBi);
    runs.push(canvas);
  }
  return { target, doc, view: { ...view }, w, h, dpr, scopeBi, skip, moving, runs };
}

/** Draw the whole map and the scene's overlays onto `canvas`. */
export function drawMap(canvas: HTMLCanvasElement, doc: Obj, view: View, scene: Scene): void {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (w === 0 || h === 0) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const pw = Math.round(w * dpr);
  const ph = Math.round(h * dpr);
  if (canvas.width !== pw || canvas.height !== ph) {
    canvas.width = pw;
    canvas.height = ph;
  }
  const c = canvas.getContext("2d");
  if (!c) return;
  const scope = scene.scope;
  const scopeBi = scope ? scope.bi : -1;
  const moving = scene.moving;
  const layerDoc = moving ? moving.base : doc;
  const skip = moving ? moving.bodies : NO_SKIP;
  const same =
    layer !== null &&
    layer.target === canvas &&
    layer.doc === layerDoc &&
    layer.w === w &&
    layer.h === h &&
    layer.dpr === dpr &&
    layer.scopeBi === scopeBi &&
    layer.skip.length === skip.length &&
    layer.skip.every((v, i) => v === skip[i]);
  // The layer's scale relative to the view, and where the layer's centre lands on the canvas (CSS px).
  const ratio = layer ? view.scale / layer.view.scale : 1;
  const shiftX = layer ? (layer.view.x - view.x) * view.scale : 0;
  const shiftY = layer ? (layer.view.y - view.y) * view.scale : 0;
  const exact = same && ratio === 1 && Math.abs(shiftX) <= LAYER_MARGIN && Math.abs(shiftY) <= LAYER_MARGIN;
  // During a pan or zoom gesture (view changes closer than GESTURE_MS apart), the last layer is shown moved and scaled,
  // and one full render follows SETTLE_MS after the last change, so a gesture never redraws every body on every event.
  const now = performance.now();
  const changed = lastView === null || lastView.x !== view.x || lastView.y !== view.y || lastView.scale !== view.scale;
  const inGesture = changed && now - lastChange < GESTURE_MS;
  if (changed) {
    lastChange = now;
    lastView = { ...view };
  }
  const approx = !exact && same && !settling && inGesture;
  window.clearTimeout(settleTimer);
  if (approx) {
    settleTimer = window.setTimeout(() => {
      settling = true;
      drawMap(canvas, doc, view, scene);
      settling = false;
    }, SETTLE_MS);
  } else if (!exact) layer = renderLayer(canvas, layerDoc, view, w, h, dpr, scopeBi, skip);
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.clearRect(0, 0, pw, ph);
  // A run is blitted: in a gesture it is moved and scaled (approx), otherwise copied 1:1 at whole device pixels.
  const blit = (src: HTMLCanvasElement): void => {
    c.setTransform(1, 0, 0, 1, 0, 0);
    if (approx) {
      const lw = (w + 2 * LAYER_MARGIN) * ratio;
      const lh = (h + 2 * LAYER_MARGIN) * ratio;
      c.drawImage(src, (w / 2 + shiftX - lw / 2) * dpr, (h / 2 + shiftY - lh / 2) * dpr, lw * dpr, lh * dpr);
    } else {
      // Whole device pixels, so the blit copies the layer 1:1 (a fractional offset would resample and blur it).
      const sx = exact ? shiftX : 0;
      const sy = exact ? shiftY : 0;
      c.drawImage(src, Math.round((sx - LAYER_MARGIN) * dpr), Math.round((sy - LAYER_MARGIN) * dpr));
    }
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  if (layer && approx) {
    c.fillStyle = BG;
    c.fillRect(0, 0, pw, ph);
  }
  const S = (p: Pt): Pt => screenAt(view, w, h, p);
  const k = view.scale;
  const ox = w / 2 - view.x * k;
  const oy = h / 2 - view.y * k;
  const bodies = getList(doc, "body");
  const drawLive = (i: number): void => {
    const b = bodies[i];
    if (b) drawBodyAt(c, b, i, scopeBi, ox, oy, k, w, h);
  };
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (layer) {
    // Each run is blitted, then the moving body after it is drawn live: bodies in index order, as a rest frame draws them.
    for (let j = 0; j <= layer.moving.length; j++) {
      const run = layer.runs[j];
      if (run) blit(run);
      if (j < layer.moving.length) drawLive(layer.moving[j]!);
    }
    drawJointSet(c, doc, splitJoints(doc, skip).live, S, scopeBi);
  } else {
    for (let i = 0; i < bodies.length; i++) drawLive(i);
    drawJointSet(c, doc, getList(doc, "joint"), S, scopeBi);
  }
  for (const kind of MARKER_KINDS) {
    for (const o of getList(doc, kind)) drawMarker(c, kind, screenAt(view, w, h, { x: num(o, "1", 0), y: num(o, "2", 0) }));
  }
  c.globalAlpha = 1;
  drawSelection(c, doc, scene.sel, S);
  const scoped = scope ? bodies[scope.bi] : undefined;
  if (scope && scoped) drawScope(c, scoped, scope.shapes, view.scale, S);
  drawPreview(c, scene.preview, S);
}

function drawGrid(c: CanvasRenderingContext2D, v: View, w: number, h: number): void {
  const step = gridStep(v.scale);
  const left = v.x - w / 2 / v.scale;
  const right = v.x + w / 2 / v.scale;
  const top = v.y - h / 2 / v.scale;
  const bottom = v.y + h / 2 / v.scale;
  c.lineWidth = 1;
  c.strokeStyle = GRID;
  c.beginPath();
  for (let x = Math.ceil(left / step) * step; x <= right; x += step) {
    const sx = Math.round(w / 2 + (x - v.x) * v.scale) + 0.5;
    c.moveTo(sx, 0);
    c.lineTo(sx, h);
  }
  for (let y = Math.ceil(top / step) * step; y <= bottom; y += step) {
    const sy = Math.round(h / 2 + (y - v.y) * v.scale) + 0.5;
    c.moveTo(0, sy);
    c.lineTo(w, sy);
  }
  c.stroke();
  c.strokeStyle = AXIS;
  c.beginPath();
  const ox = Math.round(w / 2 + (0 - v.x) * v.scale) + 0.5;
  const oy = Math.round(h / 2 + (0 - v.y) * v.scale) + 0.5;
  c.moveTo(ox, 0);
  c.lineTo(ox, h);
  c.moveTo(0, oy);
  c.lineTo(w, oy);
  c.stroke();
}

/**
 * The game's default view (camera.ts clampAxis): centred on the arena middle and held inside
 * it; a view wider than the arena stays centred on it. Map units; the y axis points down.
 */
function frameOf(doc: Obj): { cx: number; cy: number; width: number; height: number } {
  const set = asObj(doc.set);
  const width = num(set, "3", 30);
  const height = width / aspectFor(set.aspect === "wide");
  const arenaW = num(set, "15", 0);
  const arenaH = num(set, "16", 0);
  return { cx: clampAxis(arenaW / 2, width, arenaW), cy: clampAxis(arenaH / 2, height, arenaH), width, height };
}

/** The frame marks what a player would see on spawn, in world units. */
function drawFrame(c: CanvasRenderingContext2D, doc: Obj, S: (p: Pt) => Pt): void {
  const { cx, cy, width, height } = frameOf(doc);
  const a = S({ x: cx - width / 2, y: cy - height / 2 });
  const b = S({ x: cx + width / 2, y: cy + height / 2 });
  const x = Math.round(a.x) + 0.5;
  const y = Math.round(a.y) + 0.5;
  c.save();
  c.lineWidth = 1;
  c.strokeStyle = FRAME;
  c.setLineDash([6, 4]);
  c.strokeRect(x, y, Math.round(b.x - a.x), Math.round(b.y - a.y));
  c.setLineDash([]);
  c.fillStyle = FRAME;
  c.font = "11px system-ui, sans-serif";
  c.fillText(`Screen ${width} × ${height.toFixed(1)}`, Math.max(x, 0) + 6, Math.max(y, 0) + 15);
  c.restore();
}

/** camera.ts clampAxis: centre a view on `c`, held inside `[0, arena]`; a view wider than the arena is centred on it. */
function clampAxis(c: number, view: number, arena: number): number {
  if (arena < view) return arena / 2;
  return Math.min(Math.max(c, view / 2), arena - view / 2);
}

function drawBody(c: CanvasRenderingContext2D, geo: BodyGeo, invisible: boolean, ox: number, oy: number, k: number, alpha: number): void {
  for (const s of geo.shapes) {
    c.beginPath();
    c.globalAlpha = alpha;
    if (s.circle) {
      c.arc(ox + s.x * k, oy + s.y * k, s.r * k, 0, TAU);
    } else {
      const pts = s.pts;
      if (pts.length < 3) continue;
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i]!;
        if (i === 0) c.moveTo(ox + p.x * k, oy + p.y * k);
        else c.lineTo(ox + p.x * k, oy + p.y * k);
      }
      c.closePath();
    }
    c.lineWidth = 1;
    c.strokeStyle = EDGE;
    if (invisible) {
      c.setLineDash([4, 3]);
      c.stroke();
      c.setLineDash([]);
    } else {
      c.globalAlpha = 0.85 * alpha;
      c.fillStyle = s.colour;
      c.fill();
      c.globalAlpha = alpha;
      c.stroke();
    }
  }
  c.globalAlpha = 1;
}

/**
 * Joints grouped by kind: each kind is one stroke and one fill, so a frame costs a few canvas calls
 * rather than several per joint.
 */
function drawJoints(c: CanvasRenderingContext2D, doc: Obj, joints: readonly Obj[], S: (p: Pt) => Pt): void {
  const groups = new Map<number, { segs: Pt[]; ends: Pt[] }>();
  for (const j of joints) {
    const [a, b] = jointAnchors(doc, j);
    const kind = num(j, "5", 0);
    let g = groups.get(kind);
    if (!g) groups.set(kind, (g = { segs: [], ends: [] }));
    const pa = S(a);
    const pb = S(b);
    g.segs.push(pa, pb);
    g.ends.push(pa, pb);
  }
  for (const [kind, g] of groups) {
    const colour = JOINT_COLOUR[kind] ?? JOINT_COLOUR[0];
    c.strokeStyle = colour;
    c.fillStyle = colour;
    c.lineWidth = kind === 2 ? 3 : 1.5;
    c.setLineDash(kind === 0 ? [6, 4] : []);
    c.beginPath();
    for (let i = 0; i < g.segs.length; i += 2) {
      c.moveTo(g.segs[i]!.x, g.segs[i]!.y);
      c.lineTo(g.segs[i + 1]!.x, g.segs[i + 1]!.y);
    }
    c.stroke();
    c.setLineDash([]);
    c.beginPath();
    for (const p of g.ends) {
      c.moveTo(p.x + 3, p.y);
      c.arc(p.x, p.y, 3, 0, TAU);
    }
    c.fill();
  }
}

/**
 * Joints split by whether an end sits on one of `skip`'s bodies: those are drawn live with the moving bodies,
 * the rest are static and cached in the last run.
 */
function splitJoints(doc: Obj, skip: readonly number[]): { fixed: Obj[]; live: Obj[] } {
  const joints = getList(doc, "joint");
  if (skip.length === 0) return { fixed: joints, live: [] };
  const bodies = getList(doc, "body");
  const moved = new Set<Obj>();
  for (const i of skip) {
    const b = bodies[i];
    if (b) moved.add(b);
  }
  const fixed: Obj[] = [];
  const live: Obj[] = [];
  for (const j of joints) {
    const touches = [num(j, "7", -1), num(j, "8", -1)].some((id) => {
      const b = id < 0 ? null : bodyById(doc, id);
      return b !== null && moved.has(b);
    });
    (touches ? live : fixed).push(j);
  }
  return { fixed, live };
}

function drawMarker(c: CanvasRenderingContext2D, kind: (typeof MARKER_KINDS)[number], p: Pt): void {
  c.fillStyle = MARKER_COLOUR[kind];
  c.strokeStyle = MARKER_COLOUR[kind];
  c.lineWidth = 2;
  c.beginPath();
  switch (kind) {
    case "spawn":
      c.arc(p.x, p.y, 6, 0, TAU);
      c.fill();
      break;
    case "turret":
      c.rect(p.x - 6, p.y - 6, 12, 12);
      c.fill();
      break;
    case "grapple":
      c.moveTo(p.x, p.y - 8);
      c.lineTo(p.x + 8, p.y);
      c.lineTo(p.x, p.y + 8);
      c.lineTo(p.x - 8, p.y);
      c.closePath();
      c.fill();
      break;
    case "cap":
      c.arc(p.x, p.y, 9, 0, TAU);
      c.stroke();
      break;
  }
}

function drawSelection(c: CanvasRenderingContext2D, doc: Obj, sel: readonly Ref[], S: (p: Pt) => Pt): void {
  c.strokeStyle = ACCENT;
  c.fillStyle = ACCENT;
  c.lineWidth = 1.5;
  for (const ref of sel) {
    const o = getList(doc, ref.kind)[ref.i];
    if (!o) continue;
    if (ref.kind === "body") {
      const bb = bodyBounds(o);
      if (!bb) continue;
      const a = S({ x: bb.minX, y: bb.minY });
      const b = S({ x: bb.maxX, y: bb.maxY });
      c.setLineDash([5, 3]);
      c.strokeRect(a.x - 4, a.y - 4, b.x - a.x + 8, b.y - a.y + 8);
      c.setLineDash([]);
    } else if (ref.kind === "joint") {
      for (const p of jointAnchors(doc, o)) {
        const q = S(p);
        c.beginPath();
        c.arc(q.x, q.y, 8, 0, TAU);
        c.stroke();
      }
    } else {
      const q = S({ x: num(o, "1", 0), y: num(o, "2", 0) });
      c.beginPath();
      c.arc(q.x, q.y, 14, 0, TAU);
      c.stroke();
    }
  }
  const only = sel.length === 1 && sel[0]!.kind === "body" ? getList(doc, "body")[sel[0]!.i] : undefined;
  if (only) drawVertexHandles(c, only, S);
}

/** Outline the selected shapes of the body being edited in place, and the body's bounds. */
function drawScope(c: CanvasRenderingContext2D, body: Obj, sel: readonly number[], scale: number, S: (p: Pt) => Pt): void {
  c.strokeStyle = ACCENT;
  c.lineWidth = 1.5;
  const bb = bodyBounds(body);
  if (bb) {
    const a = S({ x: bb.minX, y: bb.minY });
    const b = S({ x: bb.maxX, y: bb.maxY });
    c.setLineDash([5, 3]);
    c.strokeRect(a.x - 4, a.y - 4, b.x - a.x + 8, b.y - a.y + 8);
    c.setLineDash([]);
  }
  const shapes = list(body, "s");
  for (const si of sel) {
    const s = shapes[si];
    if (s === undefined) continue;
    const shape = asObj(s);
    c.beginPath();
    if (isCircle(shape)) {
      const centre = S(toWorld(bodyXf(body), { x: num(shape, "2", 0), y: num(shape, "3", 0) }));
      c.arc(centre.x, centre.y, num(shape, "9", 0) * scale + 3, 0, TAU);
    } else {
      shapeWorld(body, shape).forEach((q, i) => {
        const p = S(q);
        if (i === 0) c.moveTo(p.x, p.y);
        else c.lineTo(p.x, p.y);
      });
      c.closePath();
    }
    c.stroke();
  }
}

/** Squares on the corners of a body's polygon shapes, shown when one body is selected. */
function drawVertexHandles(c: CanvasRenderingContext2D, body: Obj, S: (p: Pt) => Pt): void {
  c.fillStyle = ACCENT;
  c.strokeStyle = BG;
  c.lineWidth = 1;
  for (const s of list(body, "s")) {
    const shape = asObj(s);
    if (isCircle(shape)) continue;
    for (const q of shapeWorld(body, shape)) {
      const p = S(q);
      c.fillRect(p.x - 4, p.y - 4, 8, 8);
      c.strokeRect(p.x - 4, p.y - 4, 8, 8);
    }
  }
}

function drawPreview(c: CanvasRenderingContext2D, pv: Preview | null, S: (p: Pt) => Pt): void {
  if (!pv) return;
  c.strokeStyle = ACCENT;
  c.fillStyle = ACCENT_FILL;
  c.lineWidth = 1.5;
  switch (pv.kind) {
    case "rect": {
      const a = S(pv.a);
      const b = S(pv.b);
      const x = Math.min(a.x, b.x);
      const y = Math.min(a.y, b.y);
      const w = Math.abs(a.x - b.x);
      const h = Math.abs(a.y - b.y);
      c.fillRect(x, y, w, h);
      c.strokeRect(x, y, w, h);
      break;
    }
    case "circle": {
      const centre = S(pv.c);
      const edge = S(pv.r);
      c.beginPath();
      c.arc(centre.x, centre.y, Math.hypot(edge.x - centre.x, edge.y - centre.y), 0, TAU);
      c.fill();
      c.stroke();
      c.beginPath();
      c.moveTo(centre.x, centre.y);
      c.lineTo(edge.x, edge.y);
      c.stroke();
      break;
    }
    case "poly": {
      const pts = pv.cursor ? [...pv.pts, pv.cursor] : pv.pts;
      if (pts.length > 1) {
        c.beginPath();
        pts.forEach((q, i) => {
          const p = S(q);
          if (i === 0) c.moveTo(p.x, p.y);
          else c.lineTo(p.x, p.y);
        });
        c.stroke();
      }
      for (const q of pv.pts) {
        const p = S(q);
        c.beginPath();
        c.arc(p.x, p.y, 3, 0, TAU);
        c.fill();
      }
      if (pv.pts.length >= 3) {
        const first = S(pv.pts[0]!);
        c.beginPath();
        c.arc(first.x, first.y, 9, 0, TAU);
        c.stroke();
      }
      break;
    }
    case "joint": {
      const from = S(pv.from);
      c.beginPath();
      c.arc(from.x, from.y, 4, 0, TAU);
      c.fill();
      if (pv.cursor) {
        const to = S(pv.cursor);
        c.setLineDash([4, 4]);
        c.beginPath();
        c.moveTo(from.x, from.y);
        c.lineTo(to.x, to.y);
        c.stroke();
        c.setLineDash([]);
      }
      break;
    }
  }
}

/** Kind of entity the editor can place as a point marker. */
export type MarkerKind = Exclude<Kind, "body" | "joint">;
