// Map editor interaction: tools, selection, pointer gestures, view and keys.
// The document lives in a History, so every finished gesture is one undo step.
// Gestures show their work live (history.live) and settle once on release.

import { type Pt, bbox, convexParts, pointInPoly } from "./geom";
import { History } from "./history";
import {
  KIND_ORDER,
  type BodyScope,
  type Ref,
  addBody,
  addJoint,
  addMarker,
  addShapes,
  bodyColor,
  bodyIdAt,
  bodyXf,
  circleShape,
  getList,
  hitTest,
  isCircle,
  localPolyShapes,
  mergeBodies,
  moveRefs,
  moveShapes,
  nextBodyId,
  polyShapes,
  refCenter,
  removeRefs,
  removeShapes,
  sameRef,
  setShapeColor,
  setShapeOutline,
  shapeLocal,
  shapeOutline,
  shapeWorld,
  toLocal,
  toWorld,
} from "./model";
import { type MarkerKind, type Preview, type Scene, type View, clampScale, drawMap, fitView, worldAt } from "./view";
import { type Obj, asObj, emptyDoc, list, num } from "./schema";
import { loadDraft, saveDraft } from "./io";

export type Tool = "select" | "rect" | "circle" | "poly" | "joint" | "fill" | MarkerKind;

/** Keys that switch tools (no modifier). */
const TOOL_KEYS: Record<string, Tool> = {
  q: "select",
  w: "rect",
  e: "circle",
  r: "poly",
  j: "joint",
  t: "spawn",
  i: "turret",
  g: "grapple",
  y: "cap",
  u: "fill",
};

const HIT_PX = 8;
const DRAG_PX = 3;
/** Smallest box or circle the editor creates, in map units. */
const MIN_SIZE = 1;
/** Half the side of a box, or the radius of a circle, that Enter places at the view centre (screen pixels, so it reads the same at any zoom). */
const KEY_PX = 40;
/** Joints made by the joint tool are pivots; the inspector changes the kind. */
const JOINT_PIVOT = 1;
const DRAFT_MS = 400;
const DOUBLE_MS = 350;
const DOUBLE_PX = 12;

interface Anchor {
  body: number;
  p: Pt;
  /** World position. */
  w: Pt;
}

type Gesture =
  | { kind: "move"; start: Pt; startPx: Pt; base: Obj; refs: Ref[]; clicked: Ref; collapse: boolean; moved: boolean }
  | { kind: "vertex"; base: Obj; bi: number; si: number; k: number }
  | { kind: "marquee"; a: Pt; b: Pt; keep: Ref[] }
  | { kind: "shapeMove"; start: Pt; startPx: Pt; base: Obj; bi: number; sel: number[]; clicked: number; collapse: boolean; moved: boolean }
  | { kind: "shapeMarquee"; a: Pt; b: Pt; keep: number[]; bi: number }
  | { kind: "rect"; a: Pt; b: Pt; startPx: Pt; moved: boolean }
  | { kind: "circle"; c: Pt; r: Pt; startPx: Pt; moved: boolean }
  | { kind: "pan"; p0: Pt; v0: View };

function dist(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Physics shapes a map costs: shapes of bodies that are not scenery (body 23) and are not scenery shapes (shape 14). */
export function physicsShapeCount(doc: Obj): number {
  let n = 0;
  for (const b of getList(doc, "body")) {
    if (b["23"]) continue;
    for (const s of list(b, "s")) if (!asObj(s)?.["14"]) n++;
  }
  return n;
}

/**
 * Editor wording for a physics shape count. Calibrated from the wasm engine in Chromium (endless mode,
 * 30 Hz tick, static squares, no contacts; median of 5 runs of 60 ticks; CDP CPU throttle 1x and 4x; see
 * client/qa/lag-bands.ts). Medians, ms per tick, at 802 / 1602 / 2402 / 3202 / 4802 shapes: 1x 1.6 / 4.5 / 8.3 /
 * 12.9 / 26.1; 4x 4.9 / 14.2 / 42.6 / 57.6 / 120.6. A 60 Hz frame is 16.7 ms. The 4x run stands for a weak
 * device, so it must fit a frame with room to spare (about 8 ms gives "no lag" up to 1000 shapes); it passes 16.7 ms
 * near 1670 shapes ("may lag" to 1500). A typical 1x device passes 16.7 ms near 3660 shapes ("laggy" to 3500).
 * Contacts and dynamic bodies cost more than this scene; see client/qa/copy-claims.json (physics-lag-no-lag
 * through physics-lag-unplayable).
 */
export function lagVerdict(n: number): string {
  if (n <= 1000) return "no lag expected";
  if (n <= 1500) return "may lag on the weakest devices";
  if (n <= 3500) return "laggy on many devices";
  return "probably unplayable on most devices";
}

/** Entities whose centre lies inside the box spanned by a and b. */
function refsIn(doc: Obj, a: Pt, b: Pt): Ref[] {
  const x0 = Math.min(a.x, b.x);
  const x1 = Math.max(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const y1 = Math.max(a.y, b.y);
  const out: Ref[] = [];
  for (const kind of KIND_ORDER) {
    getList(doc, kind).forEach((_, i) => {
      const c = refCenter(doc, { kind, i });
      if (c && c.x >= x0 && c.x <= x1 && c.y >= y0 && c.y <= y1) out.push({ kind, i });
    });
  }
  return out;
}

/** Index of the shape and polygon vertex of a body under `w`, if any. */
function vertexAt(doc: Obj, bodyIdx: number, w: Pt, tol: number): { si: number; k: number } | null {
  const body = getList(doc, "body")[bodyIdx];
  if (!body) return null;
  const xf = bodyXf(body);
  let best: { si: number; k: number } | null = null;
  let bestD = tol;
  list(body, "s").forEach((s, si) => {
    const shape = asObj(s);
    if (isCircle(shape)) return;
    shapeLocal(shape).forEach((p, k) => {
      const d = dist(toWorld(xf, p), w);
      if (d <= bestD) {
        bestD = d;
        best = { si, k };
      }
    });
  });
  return best;
}

/** Index of the topmost shape of a body that `w` lies in (within `tol` for circles), if any. */
function shapeAt(body: Obj, w: Pt, tol: number): number | null {
  const xf = bodyXf(body);
  const shapes = list(body, "s");
  for (let si = shapes.length - 1; si >= 0; si--) {
    const shape = asObj(shapes[si]);
    if (!shape) continue;
    if (isCircle(shape)) {
      const c = toWorld(xf, { x: num(shape, "2", 0), y: num(shape, "3", 0) });
      if (dist(c, w) <= num(shape, "9", 0) + tol) return si;
    } else if (pointInPoly(w, shapeWorld(body, shape))) return si;
  }
  return null;
}

/** World-space centre of a shape: the circle centre, or the mean of a polygon's points. */
function shapeMid(body: Obj, shape: Obj): Pt {
  if (isCircle(shape)) return toWorld(bodyXf(body), { x: num(shape, "2", 0), y: num(shape, "3", 0) });
  const pts = shapeWorld(body, shape);
  const n = pts.length || 1;
  return { x: pts.reduce((a, q) => a + q.x, 0) / n, y: pts.reduce((a, q) => a + q.y, 0) / n };
}

/** Indices of a body's shapes whose centres lie in the box spanned by a and b. */
function shapesIn(body: Obj, a: Pt, b: Pt): number[] {
  const x0 = Math.min(a.x, b.x);
  const x1 = Math.max(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const y1 = Math.max(a.y, b.y);
  const out: number[] = [];
  list(body, "s").forEach((s, si) => {
    const m = shapeMid(body, asObj(s));
    if (m.x >= x0 && m.x <= x1 && m.y >= y0 && m.y <= y1) out.push(si);
  });
  return out;
}

export class EditorController {
  private readonly history: History<Obj>;
  private view: View = { x: 0, y: 0, scale: 1 };
  private fitted = false;
  private selection: Ref[] = [];
  private activeTool: Tool = "select";
  private gesture: Gesture | null = null;
  private pinch: { d0: number; m0: Pt; v0: View; w0: Pt } | null = null;
  private readonly pointers = new Map<number, Pt>();
  private hover: Pt | null = null;
  private poly: Pt[] = [];
  private jointFrom: Anchor | null = null;
  /** First corner or centre set by a tap; the next tap completes the box or circle. */
  private pending: Pt | null = null;
  private spaceDown = false;
  /** True while test play runs: pointers and keys belong to the game then. */
  private paused = false;
  /** Map id of the body being edited in place, or null. */
  private scopeId: number | null = null;
  /** Selected shape indices of the body being edited in place. */
  private shapeSel: number[] = [];
  /** The last select-tool press, for double-click and double-tap detection. */
  private lastTap: { t: number; p: Pt } | null = null;
  private draftTimer = 0;
  private paintFrame = 0;
  private note = "";
  private colour = bodyColor(0);
  private readonly cleanups: (() => void)[] = [];

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly onChange: () => void,
    /** False for a room map: the local draft is neither read nor written. */
    private readonly draft = true,
  ) {
    this.history = new History<Obj>((draft ? loadDraft() : null) ?? emptyDoc());
    this.listen(canvas, "pointerdown", (e) => this.onDown(e as PointerEvent));
    this.listen(canvas, "pointermove", (e) => this.onMove(e as PointerEvent));
    this.listen(canvas, "pointerup", (e) => this.onUp(e as PointerEvent));
    this.listen(canvas, "pointercancel", (e) => this.onUp(e as PointerEvent));
    this.listen(canvas, "pointerleave", () => {
      if (this.pointers.size === 0) {
        this.hover = null;
        this.paint();
      }
    });
    this.listen(canvas, "wheel", (e) => this.onWheel(e as WheelEvent), { passive: false });
    this.listen(canvas, "contextmenu", (e) => e.preventDefault());
    this.listen(window, "keydown", (e) => this.onKey(e as KeyboardEvent));
    this.listen(window, "keyup", (e) => {
      if ((e as KeyboardEvent).code === "Space") this.spaceDown = false;
    });
  }

  get doc(): Obj {
    return this.history.present;
  }

  get sel(): readonly Ref[] {
    return this.selection;
  }

  get tool(): Tool {
    return this.activeTool;
  }

  /** The body being edited in place and its selected shapes, or null. Found by map id, so it follows the body through edits. */
  get scope(): BodyScope | null {
    if (this.scopeId === null) return null;
    const index = getList(this.doc, "body").findIndex((b) => num(b, "1", -1) === this.scopeId);
    if (index < 0) return null;
    const count = list(getList(this.doc, "body")[index]!, "s").length;
    return { index, id: this.scopeId, shapes: this.shapeSel.filter((i) => i < count) };
  }

  get fillColour(): number {
    return this.colour;
  }

  /** Physics shapes the map costs (see physicsShapeCount). */
  get physicsShapes(): number {
    return physicsShapeCount(this.doc);
  }

  setFillColour(colour: number): void {
    this.colour = colour;
    this.notify();
  }

  get canUndo(): boolean {
    return this.history.canUndo;
  }

  get canRedo(): boolean {
    return this.history.canRedo;
  }

  /** One line of instructions for the current tool. */
  get hint(): string {
    switch (this.activeTool) {
      case "select":
        if (this.scope) {
          return this.scope.shapes.length
            ? "Drag or arrow keys to move. [ ] cycles shapes. Delete removes. Esc leaves the body."
            : "Click a shape, or drag to box-select. [ ] cycles shapes. Esc leaves the body.";
        }
        return this.selection.length
          ? "Drag or arrow keys to move (Shift: 10 units). [ ] cycles. Delete removes."
          : "Tap or drag to select. [ ] cycles entities. Arrow keys pan the view.";
      case "rect":
        if (this.pending) return "Tap the opposite corner, or press Enter for the view centre. Esc cancels.";
        return "Drag a box, or tap two corners. Enter places a box at the view centre.";
      case "circle":
        if (this.pending) return "Tap the edge, or press Enter for the view centre. Esc cancels.";
        return "Drag from the centre to set the radius, or tap centre then edge. Enter places a circle at the view centre.";
      case "poly":
        return this.poly.length
          ? "Tap points in order. Tap the first point or press Shift+Enter to close. Enter adds the view-centre point."
          : "Tap to place the first point. Enter places it at the view centre.";
      case "joint":
        return this.jointFrom
          ? "Tap the second anchor. Empty space is the ground. Enter joins at the view centre."
          : "Tap the first anchor. Empty space is the ground. Enter anchors at the view centre.";
      case "fill":
        return "Click a shape to paint it with the current colour. Enter paints the shape at the view centre.";
      default:
        return "Tap to place. Enter places at the view centre.";
    }
  }

  /** The last error or notice, empty when there is none. */
  get message(): string {
    return this.note;
  }

  setTool(tool: Tool): void {
    this.cancelGesture();
    this.poly = [];
    this.jointFrom = null;
    this.pending = null;
    this.activeTool = tool;
    this.note = "";
    this.notify();
    this.paint();
  }

  /** Replace the whole map (opened file, built-in map, new map). Clears history. */
  load(doc: Obj): void {
    this.cancelGesture();
    this.history.reset(doc);
    this.selection = [];
    this.scopeId = null;
    this.shapeSel = [];
    this.lastTap = null;
    this.poly = [];
    this.jointFrom = null;
    this.pending = null;
    this.note = "";
    this.fitted = false;
    this.fit();
    this.scheduleDraft();
    this.notify();
    this.paint();
  }

  /** Replace the map with `next` as one undo step; the selection is kept. */
  commit(next: Obj): void {
    this.history.set(next);
    this.dropStaleScope();
    this.scheduleDraft();
    this.notify();
    this.paint();
  }

  removeSelection(): void {
    const scope = this.scope;
    if (scope) {
      if (scope.shapes.length === 0) return;
      this.cancelGesture();
      this.commitScoped(removeShapes(this.doc, scope.index, scope.shapes), []);
      return;
    }
    if (this.selection.length === 0) return;
    this.cancelGesture();
    const next = removeRefs(this.doc, this.selection);
    this.commitWith(next, []);
  }

  undo(): void {
    this.cancelGesture();
    if (this.history.undo()) this.clearSelection();
    this.afterHistory();
  }

  redo(): void {
    this.cancelGesture();
    if (this.history.redo()) this.clearSelection();
    this.afterHistory();
  }

  selectAll(): void {
    const scope = this.scope;
    if (scope) {
      const body = getList(this.doc, "body")[scope.index];
      this.shapeSel = list(body ?? {}, "s").map((_, i) => i);
    } else {
      const all: Ref[] = [];
      for (const kind of KIND_ORDER) getList(this.doc, kind).forEach((_, i) => all.push({ kind, i }));
      this.selection = all;
    }
    this.notify();
    this.paint();
  }

  /** Join the selected bodies into one body. One undo step; needs two or more bodies selected. */
  mergeSelected(): void {
    const idx = this.selection.filter((r) => r.kind === "body").map((r) => r.i);
    if (idx.length < 2) {
      this.note = "Select two or more bodies to merge.";
      this.notify();
      return;
    }
    this.cancelGesture();
    this.create(() => {
      const made = mergeBodies(this.doc, idx);
      this.commitWith(made.doc, [{ kind: "body", i: made.index }]);
    });
  }

  /** Show the whole map again (the same view as opening the editor), and say so: a reset that changes nothing visible is otherwise silent. */
  resetZoom(): void {
    this.fit();
    this.note = "Showing the whole map.";
    this.notify();
    this.paint();
  }

  /** Move the selection by whole map units (the scoped shapes while editing in place). */
  nudge(dx: number, dy: number): void {
    const scope = this.scope;
    if (scope) {
      if (scope.shapes.length) this.commit(moveShapes(this.doc, scope.index, scope.shapes, dx, dy));
      return;
    }
    if (this.selection.length === 0) return;
    this.commit(moveRefs(this.doc, this.selection, dx, dy));
  }

  /** Scale the view by `factor` around the canvas centre. */
  zoomBy(factor: number): void {
    const { w, h } = this.size();
    const c = { x: w / 2, y: h / 2 };
    this.zoomAt(c, factor, w, h);
  }

  fit(): void {
    const { w, h } = this.size();
    if (w === 0 || h === 0) return;
    this.view = fitView(this.doc, w, h);
    this.fitted = true;
  }

  /** Called when the canvas box changes size. */
  resize(): void {
    if (!this.fitted) this.fit();
    this.paint();
  }

  /** Save the draft now and drop every listener. */
  destroy(): void {
    clearTimeout(this.draftTimer);
    if (this.draft) saveDraft(this.doc);
    cancelAnimationFrame(this.paintFrame);
    this.cancelGesture();
    for (const off of this.cleanups) off();
    this.cleanups.length = 0;
  }

  /** While paused (test play runs) the editor ignores pointers and keys. */
  pause(on: boolean): void {
    this.paused = on;
    if (on) {
      this.pointers.clear();
      this.cancelGesture();
      this.pinch = null;
    }
    this.paint();
  }

  // Pointer handling

  private onDown(e: PointerEvent): void {
    if (this.paused) return;
    this.canvas.setPointerCapture(e.pointerId);
    const p = this.pos(e);
    this.pointers.set(e.pointerId, p);
    if (this.pointers.size >= 2) {
      this.cancelGesture();
      const [a, b] = [...this.pointers.values()] as [Pt, Pt];
      const m0 = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const { w, h } = this.size();
      this.pinch = { d0: dist(a, b), m0, v0: { ...this.view }, w0: worldAt(this.view, w, h, m0.x, m0.y) };
      this.paint();
      return;
    }
    if (e.button === 1 || e.button === 2 || (e.button === 0 && this.spaceDown)) {
      this.gesture = { kind: "pan", p0: p, v0: { ...this.view } };
      return;
    }
    if (e.button !== 0) return;

    const raw = this.worldOf(p);
    const s = this.snap(raw);
    const tol = HIT_PX / this.view.scale;
    switch (this.activeTool) {
      case "select":
        if (this.tapped(p) && this.enterOrLeave(raw, tol)) break;
        this.selectDown(e, p, raw, tol, s);
        break;
      case "rect":
        this.gesture = { kind: "rect", a: s, b: s, startPx: p, moved: false };
        break;
      case "circle":
        this.gesture = { kind: "circle", c: s, r: s, startPx: p, moved: false };
        break;
      case "poly":
        if (this.poly.length >= 3 && dist(raw, this.poly[0]!) <= tol) this.finishPoly();
        else {
          this.poly.push(s);
          this.notify();
        }
        break;
      case "joint":
        this.jointDown(raw, s, tol);
        break;
      case "fill":
        this.fillDown(raw, tol);
        break;
      default:
        this.placeMarker(this.activeTool, s);
    }
    this.paint();
  }

  private selectDown(e: PointerEvent, p: Pt, raw: Pt, tol: number, s: Pt): void {
    const scope = this.scope;
    if (scope) {
      this.scopedSelectDown(e, p, raw, tol, s, scope);
      return;
    }
    const doc = this.doc;
    const shift = e.shiftKey;
    const first = this.selection.length === 1 ? this.selection[0]! : null;
    if (!shift && first?.kind === "body") {
      const v = vertexAt(doc, first.i, raw, tol);
      if (v) {
        this.gesture = { kind: "vertex", base: doc, bi: first.i, si: v.si, k: v.k };
        return;
      }
    }
    const ref = hitTest(doc, raw, tol);
    if (ref) {
      const was = this.selection.some((r) => sameRef(r, ref));
      const collapse = !shift && this.selection.length > 1 && was;
      if (shift) {
        this.selection = was ? this.selection.filter((r) => !sameRef(r, ref)) : [...this.selection, ref];
        if (!this.selection.some((r) => sameRef(r, ref))) {
          this.notify();
          return;
        }
      } else if (!was) {
        this.selection = [ref];
      }
      this.gesture = { kind: "move", start: s, startPx: p, base: doc, refs: [...this.selection], clicked: ref, collapse, moved: false };
    } else {
      this.gesture = { kind: "marquee", a: raw, b: raw, keep: shift ? [...this.selection] : [] };
      if (!shift) this.selection = [];
    }
    this.notify();
  }

  private jointDown(raw: Pt, s: Pt, tol: number): void {
    const bi = this.bodyUnder(raw, tol);
    const anchor: Anchor =
      bi !== null ? { body: bodyIdAt(this.doc, bi), p: toLocal(bodyXf(getList(this.doc, "body")[bi]!), s), w: s } : { body: -1, p: s, w: s };
    if (!this.jointFrom) {
      this.jointFrom = anchor;
      this.notify();
      return;
    }
    const from = this.jointFrom;
    this.jointFrom = null;
    this.create(() => {
      const made = addJoint(this.doc, from, anchor, JOINT_PIVOT);
      this.commitWith(made.doc, [{ kind: "joint", i: made.index }]);
    });
  }

  /** Paint the shape under the pointer with the current colour. */
  private fillDown(raw: Pt, tol: number): void {
    const bi = this.bodyUnder(raw, tol);
    if (bi === null) return;
    const body = getList(this.doc, "body")[bi];
    const si = body ? shapeAt(body, raw, tol) : null;
    if (si === null) return;
    const colour = this.colour;
    this.create(() => this.commit(setShapeColor(this.doc, bi, si, colour)));
  }

  private placeMarker(kind: MarkerKind, s: Pt): void {
    this.create(() => {
      const made = addMarker(this.doc, kind, s.x, s.y);
      this.commitWith(made.doc, [{ kind, i: made.index }]);
    });
  }

  private onMove(e: PointerEvent): void {
    const p = this.pos(e);
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, p);
    if (this.pinch && this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()] as [Pt, Pt];
      const pn = this.pinch;
      const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const scale = clampScale((pn.v0.scale * dist(a, b)) / pn.d0);
      const { w, h } = this.size();
      this.view = { scale, x: pn.w0.x - (m.x - w / 2) / scale, y: pn.w0.y - (m.y - h / 2) / scale };
      this.paint();
      return;
    }
    this.hover = this.snap(this.worldOf(p));
    const g = this.gesture;
    if (!g) {
      if (this.poly.length || this.jointFrom || this.pending) this.paint();
      return;
    }
    switch (g.kind) {
      case "pan":
        this.view = { ...g.v0, x: g.v0.x - (p.x - g.p0.x) / g.v0.scale, y: g.v0.y - (p.y - g.p0.y) / g.v0.scale };
        break;
      case "move": {
        if (!g.moved) {
          if (dist(p, g.startPx) < DRAG_PX) return;
          g.moved = true;
        }
        const cur = this.snap(this.worldOf(p));
        this.history.live(moveRefs(g.base, g.refs, cur.x - g.start.x, cur.y - g.start.y));
        break;
      }
      case "vertex":
        this.dragVertex(g, this.snap(this.worldOf(p)));
        break;
      case "shapeMove": {
        if (!g.moved) {
          if (dist(p, g.startPx) < DRAG_PX) return;
          g.moved = true;
        }
        const cur = this.snap(this.worldOf(p));
        this.history.live(moveShapes(g.base, g.bi, g.sel, cur.x - g.start.x, cur.y - g.start.y));
        break;
      }
      case "shapeMarquee": {
        g.b = this.worldOf(p);
        const body = getList(this.doc, "body")[g.bi];
        const inside = body ? shapesIn(body, g.a, g.b) : [];
        this.shapeSel = [...g.keep, ...inside.filter((i) => !g.keep.includes(i))];
        this.notify();
        break;
      }
      case "marquee": {
        g.b = this.worldOf(p);
        const inside = refsIn(this.doc, g.a, g.b);
        this.selection = [...g.keep, ...inside.filter((r) => !g.keep.some((k) => sameRef(k, r)))];
        this.notify();
        break;
      }
      case "rect":
        if (!g.moved) {
          if (dist(p, g.startPx) < DRAG_PX) return;
          g.moved = true;
        }
        g.b = this.snap(this.worldOf(p));
        break;
      case "circle":
        if (!g.moved) {
          if (dist(p, g.startPx) < DRAG_PX) return;
          g.moved = true;
        }
        g.r = this.snap(this.worldOf(p));
        break;
    }
    this.paint();
  }

  private dragVertex(g: Extract<Gesture, { kind: "vertex" }>, target: Pt): void {
    const body = getList(g.base, "body")[g.bi];
    const shape = body ? asObj(list(body, "s")[g.si]) : null;
    if (!body || !shape) return;
    const local = toLocal(bodyXf(body), target);
    const ox = num(shape, "2", 0);
    const oy = num(shape, "3", 0);
    const outline = shapeOutline(shape).map((q, i) => (i === g.k ? { x: local.x - ox, y: local.y - oy } : q));
    try {
      this.history.live(setShapeOutline(g.base, g.bi, g.si, outline));
      this.note = "";
    } catch (err) {
      this.note = errText(err);
    }
  }

  private onUp(e: PointerEvent): void {
    this.pointers.delete(e.pointerId);
    if (this.pinch) {
      if (this.pointers.size < 2) this.pinch = null;
      this.paint();
      return;
    }
    const g = this.gesture;
    this.gesture = null;
    if (g) this.finish(g);
    this.paint();
  }

  private finish(g: Gesture): void {
    switch (g.kind) {
      case "pan":
        return;
      case "move":
        if (g.moved) {
          this.history.settle();
          this.scheduleDraft();
        } else if (g.collapse) {
          this.selection = [g.clicked];
        }
        this.notify();
        return;
      case "vertex":
        this.history.settle();
        this.scheduleDraft();
        this.notify();
        return;
      case "marquee":
        this.notify();
        return;
      case "shapeMove":
        if (g.moved) {
          this.history.settle();
          this.scheduleDraft();
        } else if (g.collapse) {
          this.shapeSel = [g.clicked];
        }
        this.notify();
        return;
      case "shapeMarquee":
        this.notify();
        return;
      case "rect":
        if (!g.moved) return this.tapCorner(g.a);
        this.pending = null;
        if (Math.abs(g.b.x - g.a.x) < MIN_SIZE || Math.abs(g.b.y - g.a.y) < MIN_SIZE) return this.notify();
        this.placeBox(g.a, g.b);
        return;
      case "circle":
        if (!g.moved) return this.tapCentre(g.c);
        this.pending = null;
        if (dist(g.c, g.r) < MIN_SIZE) return this.notify();
        this.placeCircle(g.c, dist(g.c, g.r));
        return;
    }
  }

  /** Close the polygon in progress: its points become convex shapes of one body (or of the scoped body). */
  private finishPoly(): void {
    const pts = this.poly;
    this.create(() => {
      this.addParts(convexParts(pts));
      this.poly = [];
    });
  }

  /** Add a box with corners a and b: to the scoped body while editing in place, else as a new body. One undo step. */
  private placeBox(a: Pt, b: Pt): void {
    this.pending = null;
    this.create(() => {
      const x0 = Math.min(a.x, b.x);
      const x1 = Math.max(a.x, b.x);
      const y0 = Math.min(a.y, b.y);
      const y1 = Math.max(a.y, b.y);
      const corners = [
        { x: x0, y: y0 },
        { x: x1, y: y0 },
        { x: x1, y: y1 },
        { x: x0, y: y1 },
      ];
      this.addParts(convexParts(corners));
    });
  }

  /** Add a circle of radius r around c (see addCircle). One undo step. */
  private placeCircle(c: Pt, r: number): void {
    this.pending = null;
    this.create(() => this.addCircle(c, r));
  }

  /** Box by taps: the first tap sets a corner, the second completes the box. */
  private tapCorner(s: Pt): void {
    if (!this.pending) {
      this.pending = s;
      this.note = "";
      this.notify();
      return;
    }
    const a = this.pending;
    if (Math.abs(s.x - a.x) < MIN_SIZE || Math.abs(s.y - a.y) < MIN_SIZE) {
      this.note = "Tap a corner away from the first.";
      this.notify();
      return;
    }
    this.placeBox(a, s);
  }

  /** Circle by taps: the first tap sets the centre, the second sets the radius. */
  private tapCentre(s: Pt): void {
    if (!this.pending) {
      this.pending = s;
      this.note = "";
      this.notify();
      return;
    }
    const c = this.pending;
    const r = dist(c, s);
    if (r < MIN_SIZE) {
      this.note = "Tap a point away from the centre.";
      this.notify();
      return;
    }
    this.placeCircle(c, r);
  }

  /** Add convex world-space parts as polygon shapes: to the scoped body while editing in place, else as a new body. */
  private addParts(parts: Pt[][]): void {
    const scope = this.scope;
    if (scope) {
      const xf = bodyXf(getList(this.doc, "body")[scope.index]!);
      this.addScoped(scope.index, localPolyShapes(parts.map((part) => part.map((p) => toLocal(xf, p))), this.colour));
      return;
    }
    const box = bbox(parts.flat());
    const centre = { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 };
    const shapes = polyShapes(parts, centre, bodyColor(nextBodyId(this.doc)));
    const made = addBody(this.doc, shapes, centre);
    this.commitWith(made.doc, [{ kind: "body", i: made.index }]);
  }

  /** Add a circle at world point c: to the scoped body while editing in place, else as a new body. */
  private addCircle(c: Pt, r: number): void {
    const scope = this.scope;
    if (scope) {
      const xf = bodyXf(getList(this.doc, "body")[scope.index]!);
      this.addScoped(scope.index, [circleShape(r, this.colour, toLocal(xf, c))]);
      return;
    }
    const made = addBody(this.doc, [circleShape(r, bodyColor(nextBodyId(this.doc)))], c);
    this.commitWith(made.doc, [{ kind: "body", i: made.index }]);
  }

  /** Append shapes to the body at `index` and select them. One undo step. */
  private addScoped(index: number, shapes: Obj[]): void {
    const made = addShapes(this.doc, index, shapes);
    this.commitScoped(made.doc, shapes.map((_, i) => made.first + i));
  }

  private commitScoped(next: Obj, shapeSel: number[]): void {
    this.history.set(next);
    this.selection = [];
    this.shapeSel = shapeSel;
    this.scheduleDraft();
    this.notify();
  }

  /** Edit inside a body: its shapes become selectable and the other bodies are dimmed. */
  private enterScope(index: number): void {
    this.cancelGesture();
    this.scopeId = bodyIdAt(this.doc, index);
    this.selection = [];
    this.shapeSel = [];
    this.poly = [];
    this.jointFrom = null;
    this.note = "";
    this.notify();
    this.paint();
  }

  /** Leave the body being edited in place (Esc, double-click on empty space, or the notice's button). */
  leaveScope(): void {
    if (this.scopeId === null) return;
    this.cancelGesture();
    this.scopeId = null;
    this.shapeSel = [];
    this.note = "";
    this.notify();
    this.paint();
  }

  /** Leave the scope when its body is gone (deleted, merged away, or undone past its creation). */
  private dropStaleScope(): void {
    if (this.scopeId !== null && !this.scope) {
      this.scopeId = null;
      this.shapeSel = [];
    }
  }

  private clearSelection(): void {
    this.selection = [];
    this.shapeSel = [];
  }

  /** True when this press completes a double tap or click: same spot and close in time. */
  private tapped(p: Pt): boolean {
    const now = performance.now();
    const prev = this.lastTap;
    this.lastTap = { t: now, p };
    if (!prev || now - prev.t > DOUBLE_MS || dist(prev.p, p) > DOUBLE_PX) return false;
    this.lastTap = null;
    return true;
  }

  /** Double-click: enter the body under the pointer, or leave the scope when the pointer is on empty space. False when neither applies. */
  private enterOrLeave(raw: Pt, tol: number): boolean {
    const scope = this.scope;
    if (scope) {
      const body = getList(this.doc, "body")[scope.index]!;
      if (shapeAt(body, raw, tol) !== null) return false;
      this.leaveScope();
      return true;
    }
    const bi = this.bodyUnder(raw, tol);
    if (bi === null) return false;
    this.enterScope(bi);
    return true;
  }

  /** Index of the body a press lands on: only the scoped body (on one of its shapes) while editing in place. */
  private bodyUnder(raw: Pt, tol: number): number | null {
    const scope = this.scope;
    if (scope) {
      const body = getList(this.doc, "body")[scope.index];
      return body && shapeAt(body, raw, tol) !== null ? scope.index : null;
    }
    const ref = hitTest(this.doc, raw, tol);
    return ref?.kind === "body" ? ref.i : null;
  }

  /** Select-tool press inside a body: a shape moves or joins the selection, empty space starts a box-select of shapes. */
  private scopedSelectDown(e: PointerEvent, p: Pt, raw: Pt, tol: number, s: Pt, scope: BodyScope): void {
    const body = getList(this.doc, "body")[scope.index]!;
    const shift = e.shiftKey;
    const si = shapeAt(body, raw, tol);
    if (si !== null) {
      const was = scope.shapes.includes(si);
      const collapse = !shift && scope.shapes.length > 1 && was;
      if (shift) {
        this.shapeSel = was ? scope.shapes.filter((i) => i !== si) : [...scope.shapes, si];
        if (was) {
          this.notify();
          return;
        }
      } else if (!was) {
        this.shapeSel = [si];
      }
      this.gesture = { kind: "shapeMove", start: s, startPx: p, base: this.doc, bi: scope.index, sel: [...this.shapeSel], clicked: si, collapse, moved: false };
    } else {
      this.gesture = { kind: "shapeMarquee", a: raw, b: raw, keep: shift ? [...scope.shapes] : [], bi: scope.index };
      if (!shift) this.shapeSel = [];
    }
    this.notify();
  }

  /** Run a creation step; a failure is shown as the message and nothing changes. */
  private create(step: () => void): void {
    try {
      step();
      this.note = "";
    } catch (err) {
      this.note = errText(err);
      this.notify();
    }
    this.paint();
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const { w, h } = this.size();
    this.zoomAt(this.pos(e), Math.exp(-e.deltaY * 0.0015), w, h);
    this.paint();
  }

  private zoomAt(p: Pt, factor: number, w: number, h: number): void {
    const before = worldAt(this.view, w, h, p.x, p.y);
    const scale = clampScale(this.view.scale * factor);
    this.view = { scale, x: before.x - (p.x - w / 2) / scale, y: before.y - (p.y - h / 2) / scale };
    this.paint();
  }

  // Keys

  private onKey(e: KeyboardEvent): void {
    if (this.paused) return;
    const t = e.target;
    if (t instanceof HTMLInputElement || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement) return;
    if (t instanceof HTMLElement && t.isContentEditable) return;
    if (e.code === "Space") {
      if (!e.repeat) this.spaceDown = true;
      e.preventDefault();
      return;
    }
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (mod) {
      if (key === "z") {
        if (e.shiftKey) this.redo();
        else this.undo();
      }
      else if (key === "y") this.redo();
      else if (key === "a") this.selectAll();
      else return;
      e.preventDefault();
      return;
    }
    if (e.altKey) return;
    if (e.key === "Delete" || e.key === "Backspace") {
      this.removeSelection();
    } else if (e.key === "Escape") {
      this.escape();
    } else if (e.key === "Enter") {
      if (t instanceof HTMLButtonElement) return;
      if (e.shiftKey) {
        if (this.activeTool !== "poly" || this.poly.length < 3) return;
        this.finishPoly();
      } else if (!this.placeAtView()) return;
    } else if (e.key.startsWith("Arrow")) {
      const big = e.shiftKey;
      const sx = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0;
      const sy = e.key === "ArrowUp" ? -1 : e.key === "ArrowDown" ? 1 : 0;
      if (this.selection.length === 0 && !this.scope?.shapes.length) this.pan(sx * (big ? 240 : 80), sy * (big ? 240 : 80));
      else this.nudge(sx * (big ? 10 : 1), sy * (big ? 10 : 1));
    } else if (e.key === "[" || e.key === "]") {
      this.cycle(e.key === "]" ? 1 : -1);
    } else if (TOOL_KEYS[key] && !e.shiftKey) {
      this.setTool(TOOL_KEYS[key]);
    } else {
      return;
    }
    e.preventDefault();
  }

  private escape(): void {
    if (this.gesture) this.cancelGesture();
    else if (this.poly.length) this.poly = [];
    else if (this.jointFrom) this.jointFrom = null;
    else if (this.pending) this.pending = null;
    else if (this.scope) {
      this.leaveScope();
      return;
    } else if (this.activeTool !== "select") this.activeTool = "select";
    else if (this.selection.length) this.selection = [];
    else return;
    this.note = "";
    this.notify();
    this.paint();
  }

  /** Enter: what a tap at the view centre does; a box or circle with nothing started gets the default size. False when the tool places nothing. */
  private placeAtView(): boolean {
    const { w, h } = this.size();
    const raw = worldAt(this.view, w, h, w / 2, h / 2);
    const s = this.snap(raw);
    const tol = HIT_PX / this.view.scale;
    switch (this.activeTool) {
      case "select":
        return false;
      case "rect":
        if (this.pending) this.tapCorner(s);
        else this.placeBox({ x: s.x - KEY_PX / this.view.scale, y: s.y - KEY_PX / this.view.scale }, { x: s.x + KEY_PX / this.view.scale, y: s.y + KEY_PX / this.view.scale });
        break;
      case "circle":
        if (this.pending) this.tapCentre(s);
        else this.placeCircle(s, KEY_PX / this.view.scale);
        break;
      case "poly":
        this.poly.push(s);
        this.notify();
        break;
      case "joint":
        this.jointDown(raw, s, tol);
        break;
      case "fill":
        this.fillDown(raw, tol);
        break;
      default:
        this.placeMarker(this.activeTool, s);
    }
    this.paint();
    return true;
  }

  /** [ and ]: select the previous or next entity, or shape while editing in place. */
  private cycle(step: 1 | -1): void {
    const scope = this.scope;
    if (scope) {
      const n = list(getList(this.doc, "body")[scope.index] ?? {}, "s").length;
      if (n === 0) return;
      const cur = scope.shapes.length === 1 ? scope.shapes[0]! : step > 0 ? -1 : 0;
      this.shapeSel = [(((cur + step) % n) + n) % n];
    } else {
      const all: Ref[] = [];
      for (const kind of KIND_ORDER) getList(this.doc, kind).forEach((_, i) => all.push({ kind, i }));
      if (all.length === 0) return;
      const cur = this.selection.length === 1 ? all.findIndex((r) => sameRef(r, this.selection[0]!)) : -1;
      const next = cur < 0 ? (step > 0 ? 0 : all.length - 1) : (cur + step + all.length) % all.length;
      this.selection = [all[next]!];
    }
    this.notify();
    this.paint();
  }

  /** Pan the view by a screen offset in pixels (arrow keys with nothing selected). */
  private pan(dx: number, dy: number): void {
    this.view = { ...this.view, x: this.view.x + dx / this.view.scale, y: this.view.y + dy / this.view.scale };
    this.paint();
  }

  // Helpers

  /** Drop the gesture in progress, restoring the map it started from. */
  private cancelGesture(): void {
    const g = this.gesture;
    if (!g) return;
    this.gesture = null;
    if ("base" in g) this.history.live(g.base);
  }

  private commitWith(next: Obj, sel: Ref[]): void {
    this.history.set(next);
    this.dropStaleScope();
    this.selection = sel;
    this.scheduleDraft();
    this.notify();
  }

  private afterHistory(): void {
    this.dropStaleScope();
    this.scheduleDraft();
    this.notify();
    this.paint();
  }

  private snapStep(): number {
    return num(asObj(this.doc.set), "4", 1);
  }

  private snap(p: Pt): Pt {
    const step = this.snapStep();
    if (step <= 0) return p;
    return { x: Math.round(p.x / step) * step, y: Math.round(p.y / step) * step };
  }

  private size(): { w: number; h: number } {
    return { w: this.canvas.clientWidth, h: this.canvas.clientHeight };
  }

  private pos(e: MouseEvent): Pt {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private worldOf(p: Pt): Pt {
    const { w, h } = this.size();
    return worldAt(this.view, w, h, p.x, p.y);
  }

  private preview(): Preview | null {
    const g = this.gesture;
    if (g?.kind === "rect") return { kind: "rect", a: g.a, b: g.b };
    if (g?.kind === "circle") return { kind: "circle", c: g.c, r: g.r };
    if (g?.kind === "marquee") return { kind: "rect", a: g.a, b: g.b };
    if (this.pending && this.activeTool === "rect") return { kind: "rect", a: this.pending, b: this.hover ?? this.pending };
    if (this.pending && this.activeTool === "circle") return { kind: "circle", c: this.pending, r: this.hover ?? this.pending };
    if (this.activeTool === "poly" && this.poly.length) return { kind: "poly", pts: this.poly, cursor: this.hover };
    if (this.activeTool === "joint" && this.jointFrom) return { kind: "joint", from: this.jointFrom.w, cursor: this.hover };
    return null;
  }

  /** The bodies the current gesture moves: drawn live over the static layer of the gesture's start doc. */
  private movingBodies(): Scene["moving"] {
    const g = this.gesture;
    if (g?.kind === "move") return { base: g.base, bodies: g.refs.filter((r) => r.kind === "body").map((r) => r.i) };
    if (g?.kind === "shapeMove") return { base: g.base, bodies: [g.bi] };
    return null;
  }

  private paint(): void {
    if (this.paintFrame) return;
    this.paintFrame = requestAnimationFrame(() => {
      this.paintFrame = 0;
      this.draw();
    });
  }

  private draw(): void {
    if (!this.fitted) this.fit();
    const scope = this.scope;
    const scene: Scene = { sel: this.selection, preview: this.preview(), scope: scope ? { bi: scope.index, shapes: scope.shapes } : null, moving: this.movingBodies() };
    drawMap(this.canvas, this.doc, this.view, scene);
  }

  private notify(): void {
    this.onChange();
  }

  private scheduleDraft(): void {
    if (!this.draft) return;
    clearTimeout(this.draftTimer);
    this.draftTimer = window.setTimeout(() => {
      if (!saveDraft(this.doc)) this.note = "Could not save the draft: browser storage is full.";
    }, DRAFT_MS);
  }

  private listen(target: EventTarget, type: string, fn: (e: Event) => void, options?: AddEventListenerOptions): void {
    target.addEventListener(type, fn, options);
    this.cleanups.push(() => target.removeEventListener(type, fn, options));
  }
}

