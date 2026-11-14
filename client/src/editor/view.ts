// Map editor drawing: grid, bodies, joints, markers, selection and the preview
// of the gesture in progress. The canvas is sized to its CSS box times the
// device pixel ratio (capped at 2) and drawn in CSS pixels.

import { type Pt, bbox } from "./geom";
import {
  type Kind,
  type Ref,
  bodyBounds,
  bodyXf,
  getList,
  isCircle,
  jointAnchors,
  shapeWorld,
  toWorld,
} from "./model";
import { type Obj, asObj, list, num, shapeColor } from "./schema";

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

const FALLBACK_BOX = { minX: -400, minY: -225, maxX: 400, maxY: 225 };
const MARKER_KINDS = ["spawn", "turret", "grapple", "cap"] as const;

/** A view that shows every entity of the map (or a default arena when empty). */
export function fitView(doc: Obj, w: number, h: number): View {
  const pts: Pt[] = [];
  for (const b of getList(doc, "body")) {
    const bb = bodyBounds(b);
    if (bb) pts.push({ x: bb.minX, y: bb.minY }, { x: bb.maxX, y: bb.maxY });
  }
  for (const kind of MARKER_KINDS) {
    for (const o of getList(doc, kind)) pts.push({ x: num(o, "1", 0), y: num(o, "2", 0) });
  }
  for (const j of getList(doc, "joint")) pts.push(...jointAnchors(doc, j));
  const b = pts.length ? bbox(pts) : FALLBACK_BOX;
  const bw = Math.max(b.maxX - b.minX, 50);
  const bh = Math.max(b.maxY - b.minY, 50);
  const scale = clampScale(Math.min((w - 80) / bw, (h - 80) / bh));
  return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2, scale };
}

const BG = "#0b0d10";
const GRID = "#161b21";
const AXIS = "#2a323b";
const EDGE = "rgba(255, 255, 255, 0.35)";
const ACCENT = "#0095ff";
const ACCENT_FILL = "rgba(0, 149, 255, 0.14)";
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
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.fillStyle = BG;
  c.fillRect(0, 0, w, h);

  const S = (p: Pt): Pt => screenAt(view, w, h, p);
  drawGrid(c, view, w, h);
  for (const b of getList(doc, "body")) drawBody(c, b, S, view.scale);
  for (const j of getList(doc, "joint")) drawJoint(c, doc, j, S);
  for (const kind of MARKER_KINDS) {
    for (const o of getList(doc, kind)) drawMarker(c, kind, screenAt(view, w, h, { x: num(o, "1", 0), y: num(o, "2", 0) }));
  }
  drawSelection(c, doc, scene.sel, S);
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

function drawBody(c: CanvasRenderingContext2D, body: Obj, S: (p: Pt) => Pt, scale: number): void {
  const invisible = body["50"] === true;
  const xf = bodyXf(body);
  for (const s of list(body, "s")) {
    const shape = asObj(s);
    c.beginPath();
    if (isCircle(shape)) {
      const centre = S(toWorld(xf, { x: num(shape, "2", 0), y: num(shape, "3", 0) }));
      c.arc(centre.x, centre.y, num(shape, "9", 0) * scale, 0, TAU);
    } else {
      const pts = shapeWorld(body, shape);
      if (pts.length < 3) continue;
      pts.forEach((q, i) => {
        const p = S(q);
        if (i === 0) c.moveTo(p.x, p.y);
        else c.lineTo(p.x, p.y);
      });
      c.closePath();
    }
    c.lineWidth = 1;
    c.strokeStyle = EDGE;
    if (invisible) {
      c.setLineDash([4, 3]);
      c.stroke();
      c.setLineDash([]);
    } else {
      c.globalAlpha = 0.85;
      c.fillStyle = shapeColor(shape);
      c.fill();
      c.globalAlpha = 1;
      c.stroke();
    }
  }
}

function drawJoint(c: CanvasRenderingContext2D, doc: Obj, j: Obj, S: (p: Pt) => Pt): void {
  const [a, b] = jointAnchors(doc, j);
  const kind = num(j, "5", 0);
  const colour = JOINT_COLOUR[kind] ?? JOINT_COLOUR[0];
  const pa = S(a);
  const pb = S(b);
  c.strokeStyle = colour;
  c.fillStyle = colour;
  c.lineWidth = kind === 2 ? 3 : 1.5;
  c.setLineDash(kind === 0 ? [6, 4] : []);
  c.beginPath();
  c.moveTo(pa.x, pa.y);
  c.lineTo(pb.x, pb.y);
  c.stroke();
  c.setLineDash([]);
  for (const p of [pa, pb]) {
    c.beginPath();
    c.arc(p.x, p.y, 3, 0, TAU);
    c.fill();
  }
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
