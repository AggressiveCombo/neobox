// Map document operations. A document is the plain map JSON object; every
// operation returns a new object and shares all untouched arrays and entries
// with the previous one, so undo snapshots stay cheap.

import { type Pt, bbox, convexParts, pointInPoly } from "./geom";
import {
  BODY,
  BODY_DEFAULTS,
  CAP_DEFAULTS,
  GRAPPLE,
  GRAPPLE_DEFAULTS,
  JOINT,
  JOINT_DEFAULTS,
  MAP,
  MARKER,
  MAX_OBJECT_ID,
  type ListKey,
  type Obj,
  SHAPE,
  SHAPE_DEFAULTS,
  SPAWN_DEFAULTS,
  TURRET_DEFAULTS,
  asObj,
  flatPoints,
  hexColor,
  list,
  num,
  shapeColor,
  withField,
} from "./schema";

export type Kind = "body" | "joint" | "spawn" | "turret" | "grapple" | "cap";

export interface Ref {
  kind: Kind;
  /** Index in the kind's list. */
  i: number;
}

/** A body being edited in place: its index, map id and selected shape indices. */
export interface BodyScope {
  index: number;
  id: number;
  shapes: readonly number[];
}

export const LIST_OF: Record<Kind, ListKey> = {
  body: MAP.bodies,
  joint: MAP.joints,
  spawn: MAP.spawns,
  turret: MAP.turrets,
  grapple: MAP.grapples,
  cap: MAP.caps,
};

const DEFAULTS_OF: Record<Kind, Obj> = {
  body: BODY_DEFAULTS,
  joint: JOINT_DEFAULTS,
  spawn: SPAWN_DEFAULTS,
  turret: TURRET_DEFAULTS,
  grapple: GRAPPLE_DEFAULTS,
  cap: CAP_DEFAULTS,
};

/** Body colours offered for new bodies (cycled by id). */
const PALETTE = ["#394a8e", "#e8a33b", "#5ab38b", "#d4574f", "#7d6bd6", "#4fa3d1"];

export const KIND_ORDER: readonly Kind[] = ["body", "spawn", "turret", "grapple", "cap", "joint"];

export function sameRef(a: Ref, b: Ref): boolean {
  return a.kind === b.kind && a.i === b.i;
}

export function getList(doc: Obj, kind: Kind): Obj[] {
  return list(doc, LIST_OF[kind]);
}

function withList(doc: Obj, kind: Kind, items: Obj[]): Obj {
  return { ...doc, [LIST_OF[kind]]: items };
}

function replaceAt<T>(arr: T[], i: number, v: T): T[] {
  const out = arr.slice();
  out[i] = v;
  return out;
}

function round(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}

export function nextBodyId(doc: Obj): number {
  let max = -1;
  for (const b of getList(doc, "body")) max = Math.max(max, num(b, BODY.id, 0));
  return Math.min(max + 1, MAX_OBJECT_ID);
}

export function bodyIdAt(doc: Obj, i: number): number {
  return num(getList(doc, "body")[i] ?? {}, BODY.id, -1);
}

export function bodyColor(id: number): number {
  return hexColor(PALETTE[id % PALETTE.length]!);
}

// Transforms: a body's shapes are local to its position and angle (Box2D convention).

export interface Xf {
  x: number;
  y: number;
  c: number;
  s: number;
}

export function bodyXf(b: Obj): Xf {
  const a = num(b, BODY.angle, 0);
  return { x: num(b, BODY.x, 0), y: num(b, BODY.y, 0), c: Math.cos(a), s: Math.sin(a) };
}

export function toWorld(xf: Xf, p: Pt): Pt {
  return { x: xf.x + xf.c * p.x - xf.s * p.y, y: xf.y + xf.s * p.x + xf.c * p.y };
}

export function toLocal(xf: Xf, w: Pt): Pt {
  const dx = w.x - xf.x;
  const dy = w.y - xf.y;
  return { x: xf.c * dx + xf.s * dy, y: -xf.s * dx + xf.c * dy };
}

export function isCircle(shape: Obj): boolean {
  return num(shape, SHAPE.kind, 0) === 1;
}

/** A polygon shape's points relative to the body (shape offset applied). */
export function shapeLocal(shape: Obj): Pt[] {
  const ox = num(shape, SHAPE.x, 0);
  const oy = num(shape, SHAPE.y, 0);
  const flat = flatPoints(shape);
  const out: Pt[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) out.push({ x: ox + flat[i]!, y: oy + flat[i + 1]! });
  return out;
}

/** A polygon shape's own points, relative to its offset. */
export function shapeOutline(shape: Obj): Pt[] {
  const flat = flatPoints(shape);
  const out: Pt[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) out.push({ x: flat[i]!, y: flat[i + 1]! });
  return out;
}

/** World-space polygon points of a shape (empty for circles). */
export function shapeWorld(body: Obj, shape: Obj): Pt[] {
  const xf = bodyXf(body);
  return shapeLocal(shape).map((p) => toWorld(xf, p));
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** One shape in world space: a circle's centre and radius, or a polygon's points. */
export interface ShapeGeo {
  circle: boolean;
  x: number;
  y: number;
  r: number;
  pts: Pt[];
  colour: string;
}

export interface BodyGeo {
  bounds: Bounds | null;
  shapes: ShapeGeo[];
}

const geoCache = new WeakMap<Obj, BodyGeo>();

/**
 * World-space geometry of a body, cached per body object. Edits never mutate a
 * body; they build a new object, so an entry stays valid for the object it was made for.
 */
export function bodyGeo(body: Obj): BodyGeo {
  const cached = geoCache.get(body);
  if (cached) return cached;
  const xf = bodyXf(body);
  const shapes: ShapeGeo[] = [];
  const all: Pt[] = [];
  for (const s of list(body, BODY.shapes)) {
    const shape = asObj(s);
    const colour = shapeColor(shape);
    if (isCircle(shape)) {
      const c = toWorld(xf, { x: num(shape, SHAPE.x, 0), y: num(shape, SHAPE.y, 0) });
      const r = num(shape, SHAPE.radius, 0);
      shapes.push({ circle: true, x: c.x, y: c.y, r, pts: [], colour });
      all.push({ x: c.x - r, y: c.y - r }, { x: c.x + r, y: c.y + r });
    } else {
      const pts = shapeLocal(shape).map((p) => toWorld(xf, p));
      shapes.push({ circle: false, x: 0, y: 0, r: 0, pts, colour });
      all.push(...pts);
    }
  }
  const geo: BodyGeo = { bounds: all.length ? bbox(all) : null, shapes };
  geoCache.set(body, geo);
  return geo;
}

/** World-space bounds of a body's shapes, or null when it has none. */
export function bodyBounds(body: Obj): Bounds | null {
  return bodyGeo(body).bounds;
}

/** Centre used for selection outlines and nudges. */
export function refCenter(doc: Obj, ref: Ref): Pt | null {
  const o = getList(doc, ref.kind)[ref.i];
  if (!o) return null;
  if (ref.kind === "body") {
    const b = bodyBounds(o);
    return b ? { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 } : { x: num(o, BODY.x, 0), y: num(o, BODY.y, 0) };
  }
  if (ref.kind === "joint") {
    const [a, b] = jointAnchors(doc, o);
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }
  return { x: num(o, MARKER.x, 0), y: num(o, MARKER.y, 0) };
}

/** The two anchor points of a joint in world space. Anchors are local to their body; ground anchors are world. */
export function jointAnchors(doc: Obj, j: Obj): [Pt, Pt] {
  return [
    anchorWorld(doc, num(j, JOINT.bodyA, -1), { x: num(j, JOINT.anchorAX, 0), y: num(j, JOINT.anchorAY, 0) }),
    anchorWorld(doc, num(j, JOINT.bodyB, -1), { x: num(j, JOINT.anchorBX, 0), y: num(j, JOINT.anchorBY, 0) }),
  ];
}

const bodyIndexes = new WeakMap<Obj[], Map<number, Obj>>();

/** The first body with map id `id`. Index per body array; arrays are never mutated in place, so an index stays valid. */
export function bodyById(doc: Obj, id: number): Obj | null {
  const bodies = getList(doc, "body");
  let index = bodyIndexes.get(bodies);
  if (!index) {
    index = new Map();
    for (const b of bodies) {
      const bid = num(b, BODY.id, -1);
      if (!index.has(bid)) index.set(bid, b);
    }
    bodyIndexes.set(bodies, index);
  }
  return index.get(id) ?? null;
}

function anchorWorld(doc: Obj, id: number, p: Pt): Pt {
  const body = id < 0 ? null : bodyById(doc, id);
  return body ? toWorld(bodyXf(body), p) : p;
}

const HIT_ORDER: readonly Kind[] = ["spawn", "turret", "grapple", "cap", "joint", "body"];

/**
 * The entity under a world point; `tol` is the pick radius in world units.
 * Markers win over bodies; among bodies and joints the one drawn last wins.
 */
export function hitTest(doc: Obj, w: Pt, tol: number): Ref | null {
  for (const kind of HIT_ORDER) {
    const items = getList(doc, kind);
    for (let i = items.length - 1; i >= 0; i--) {
      const o = items[i]!;
      if (kind === "body") {
        if (bodyHit(o, w, tol)) return { kind, i };
      } else if (kind === "joint") {
        const [a, b] = jointAnchors(doc, o);
        if (Math.hypot(w.x - a.x, w.y - a.y) <= tol || Math.hypot(w.x - b.x, w.y - b.y) <= tol) return { kind, i };
      } else if (Math.hypot(w.x - num(o, MARKER.x, 0), w.y - num(o, MARKER.y, 0)) <= tol) {
        return { kind, i };
      }
    }
  }
  return null;
}

function bodyHit(body: Obj, w: Pt, tol: number): boolean {
  const geo = bodyGeo(body);
  const b = geo.bounds;
  if (!b || w.x < b.minX - tol || w.x > b.maxX + tol || w.y < b.minY - tol || w.y > b.maxY + tol) return false;
  for (const s of geo.shapes) {
    if (s.circle) {
      if (Math.hypot(w.x - s.x, w.y - s.y) <= s.r + tol) return true;
      continue;
    }
    const pts = s.pts;
    if (pts.length < 3) continue;
    if (pointInPoly(w, pts)) return true;
    for (let i = 0; i < pts.length; i++) {
      if (distToSegment(w, pts[i]!, pts[(i + 1) % pts.length]!) <= tol) return true;
    }
  }
  return false;
}

export function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Shift the entities by (dx, dy). Joint anchors are local to their body and follow it by themselves. */
export function moveRefs(doc: Obj, refs: Ref[], dx: number, dy: number): Obj {
  if (refs.length === 0 || (dx === 0 && dy === 0)) return doc;
  const movedIds = new Set<number>();
  for (const r of refs) if (r.kind === "body") movedIds.add(bodyIdAt(doc, r.i));
  let next = doc;
  for (const kind of KIND_ORDER) {
    if (kind === "joint") continue;
    const sel = new Set(refs.filter((r) => r.kind === kind).map((r) => r.i));
    if (sel.size === 0) continue;
    next = withList(next, kind, getList(next, kind).map((o, i) => (sel.has(i) ? shiftEntity(kind, o, dx, dy) : o)));
  }
  const selJoints = new Set(refs.filter((r) => r.kind === "joint").map((r) => r.i));
  if (selJoints.size === 0) return next;
  return withList(
    next,
    "joint",
    getList(doc, "joint").map((j, i) => (selJoints.has(i) ? shiftJoint(doc, j, movedIds, dx, dy) : j)),
  );
}

function shiftEntity(kind: Kind, o: Obj, dx: number, dy: number): Obj {
  const [kx, ky] = kind === "body" ? [BODY.x, BODY.y] : [MARKER.x, MARKER.y];
  return { ...o, [kx!]: num(o, kx!, 0) + dx, [ky!]: num(o, ky!, 0) + dy };
}

/** Moves a selected joint's anchors in world space; anchors on a moved body already follow it. */
function shiftJoint(doc: Obj, j: Obj, moved: Set<number>, dx: number, dy: number): Obj {
  const out: Obj = { ...j };
  const ends: [number, string, string][] = [
    [num(j, JOINT.bodyA, -1), JOINT.anchorAX, JOINT.anchorAY],
    [num(j, JOINT.bodyB, -1), JOINT.anchorBX, JOINT.anchorBY],
  ];
  for (const [id, kx, ky] of ends) {
    if (moved.has(id)) continue;
    const body = id < 0 ? null : bodyById(doc, id);
    if (id >= 0 && !body) continue;
    const local = { x: num(j, kx, 0), y: num(j, ky, 0) };
    const world = body ? toWorld(bodyXf(body), local) : local;
    const next = { x: world.x + dx, y: world.y + dy };
    const to = body ? toLocal(bodyXf(body), next) : next;
    out[kx] = round(to.x);
    out[ky] = round(to.y);
  }
  return out;
}

/** Delete entities. Joints on a deleted body go with it. */
export function removeRefs(doc: Obj, refs: Ref[]): Obj {
  const bodyIds = new Set<number>();
  const kill = new Map<Kind, Set<number>>();
  for (const r of refs) {
    if (r.kind === "body") bodyIds.add(bodyIdAt(doc, r.i));
    const set = kill.get(r.kind) ?? new Set<number>();
    set.add(r.i);
    kill.set(r.kind, set);
  }
  if (bodyIds.size > 0) {
    const set = kill.get("joint") ?? new Set<number>();
    getList(doc, "joint").forEach((j, i) => {
      if (bodyIds.has(num(j, JOINT.bodyA, -1)) || bodyIds.has(num(j, JOINT.bodyB, -1))) set.add(i);
    });
    kill.set("joint", set);
  }
  let next = doc;
  for (const [kind, set] of kill) {
    next = withList(
      next,
      kind,
      getList(next, kind).filter((_, i) => !set.has(i)),
    );
  }
  return next;
}

/** Write fields of one entity. Values equal to their default are removed from the JSON. */
export function patchEntity(doc: Obj, ref: Ref, patch: Obj): Obj {
  const items = getList(doc, ref.kind);
  const cur = items[ref.i];
  if (!cur) return doc;
  let o = cur;
  for (const [k, v] of Object.entries(patch)) o = withField(o, k, v, DEFAULTS_OF[ref.kind]);
  return withList(doc, ref.kind, replaceAt(items, ref.i, o));
}

/** Replace the shapes of one body. */
export function setBodyShapes(doc: Obj, bodyIdx: number, shapes: Obj[]): Obj {
  const bodies = getList(doc, "body");
  const b = bodies[bodyIdx];
  if (!b) return doc;
  return withList(doc, "body", replaceAt(bodies, bodyIdx, { ...b, [BODY.shapes]: shapes }));
}

/** Append shapes to one body, in its frame. `first` is the index of the first one added (-1 if no such body). */
export function addShapes(doc: Obj, bodyIdx: number, shapes: Obj[]): { doc: Obj; first: number } {
  const body = getList(doc, "body")[bodyIdx];
  if (!body) return { doc, first: -1 };
  const old = list(body, BODY.shapes);
  return { doc: setBodyShapes(doc, bodyIdx, [...old, ...shapes]), first: old.length };
}

/** Delete shapes of one body. */
export function removeShapes(doc: Obj, bodyIdx: number, shapeIdxs: readonly number[]): Obj {
  const body = getList(doc, "body")[bodyIdx];
  if (!body) return doc;
  const drop = new Set(shapeIdxs);
  return setBodyShapes(
    doc,
    bodyIdx,
    list(body, BODY.shapes).filter((_, i) => !drop.has(i)),
  );
}

/** Shift shapes of one body by a world-space offset. Shape offsets are in the body's frame, so the offset is rotated into it. */
export function moveShapes(doc: Obj, bodyIdx: number, shapeIdxs: readonly number[], dx: number, dy: number): Obj {
  const body = getList(doc, "body")[bodyIdx];
  if (!body || shapeIdxs.length === 0 || (dx === 0 && dy === 0)) return doc;
  const xf = bodyXf(body);
  const lx = xf.c * dx + xf.s * dy;
  const ly = -xf.s * dx + xf.c * dy;
  const sel = new Set(shapeIdxs);
  const shapes = list(body, BODY.shapes).map((s, i) => {
    if (!sel.has(i)) return s;
    const shape = asObj(s);
    const moved = withField(shape, SHAPE.x, round(num(shape, SHAPE.x, 0) + lx), SHAPE_DEFAULTS);
    return withField(moved, SHAPE.y, round(num(moved, SHAPE.y, 0) + ly), SHAPE_DEFAULTS);
  });
  return setBodyShapes(doc, bodyIdx, shapes);
}

/**
 * Replace one polygon shape of a body by convex parts of `outline` (points
 * relative to the shape offset). Throws when the outline is not a simple polygon.
 */
export function setShapeOutline(doc: Obj, bodyIdx: number, shapeIdx: number, outline: Pt[]): Obj {
  const body = getList(doc, "body")[bodyIdx];
  if (!body) return doc;
  const shapes = list(body, BODY.shapes);
  const shape = asObj(shapes[shapeIdx]);
  const made = convexParts(outline).map((part) => ({ ...shape, [SHAPE.points]: part.flatMap((p) => [round(p.x), round(p.y)]) }));
  return setBodyShapes(doc, bodyIdx, [...shapes.slice(0, shapeIdx), ...made, ...shapes.slice(shapeIdx + 1)]);
}

/** Append a body with the given shapes (already relative to `centre`) and rotation `angle`. Returns the new doc and its index. */
export function addBody(doc: Obj, shapes: Obj[], centre: Pt, angle = 0): { doc: Obj; index: number } {
  const items = getList(doc, "body");
  const body: Obj = { [BODY.id]: nextBodyId(doc), [BODY.x]: round(centre.x), [BODY.y]: round(centre.y), [BODY.shapes]: shapes };
  if (angle !== 0) body[BODY.angle] = round(angle);
  return { doc: withList(doc, "body", [...items, body]), index: items.length };
}

/** Polygon shapes for world-space convex parts, positioned relative to `centre`. */
export function polyShapes(parts: Pt[][], centre: Pt, colour: number): Obj[] {
  return parts.map((part) => ({
    [SHAPE.points]: part.flatMap((p) => [round(p.x - centre.x), round(p.y - centre.y)]),
    [SHAPE.color]: colour,
  }));
}

/** Circle shape; `at` is its centre in the body's frame (omitted when at the origin). */
export function circleShape(r: number, colour: number, at: Pt = { x: 0, y: 0 }): Obj {
  const shape: Obj = { [SHAPE.kind]: 1, [SHAPE.radius]: round(r), [SHAPE.color]: colour };
  if (at.x !== 0) shape[SHAPE.x] = round(at.x);
  if (at.y !== 0) shape[SHAPE.y] = round(at.y);
  return shape;
}

/** Polygon shapes for convex parts given in a body's own frame; each part is offset to its own centre. */
export function localPolyShapes(parts: Pt[][], colour: number): Obj[] {
  return parts.map((part) => {
    const box = bbox(part);
    const c = { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 };
    const shape: Obj = { [SHAPE.points]: part.flatMap((p) => [round(p.x - c.x), round(p.y - c.y)]), [SHAPE.color]: colour };
    if (c.x !== 0) shape[SHAPE.x] = round(c.x);
    if (c.y !== 0) shape[SHAPE.y] = round(c.y);
    return shape;
  });
}

/** Append an anchored entity (spawn, turret, grapple, capture point) at (x, y). */
export function addMarker(doc: Obj, kind: Exclude<Kind, "body" | "joint">, x: number, y: number): { doc: Obj; index: number } {
  const items = getList(doc, kind);
  return { doc: withList(doc, kind, [...items, { [MARKER.x]: round(x), [MARKER.y]: round(y) }]), index: items.length };
}

/** Append a joint between two anchored points. `body` is a body id, or -1 for the ground. */
export function addJoint(doc: Obj, a: { body: number; p: Pt }, b: { body: number; p: Pt }, kind: number): { doc: Obj; index: number } {
  const items = getList(doc, "joint");
  const joint: Obj = {
    [JOINT.anchorAX]: round(a.p.x),
    [JOINT.anchorAY]: round(a.p.y),
    [JOINT.anchorBX]: round(b.p.x),
    [JOINT.anchorBY]: round(b.p.y),
    [JOINT.kind]: kind,
    [JOINT.bodyA]: a.body,
    [JOINT.bodyB]: b.body,
  };
  return { doc: withList(doc, "joint", [...items, joint]), index: items.length };
}

export function kindLabel(kind: Kind): string {
  return { body: "Body", joint: "Joint", spawn: "Spawn", turret: "Turret", grapple: "Grapple", cap: "Capture" }[kind];
}

/** Set a shape's keys in place: undefined removes a key, values equal to the default are dropped. */
export function patchShape(doc: Obj, bodyIdx: number, shapeIdx: number, patch: Obj): Obj {
  const body = getList(doc, "body")[bodyIdx];
  const shapes = body ? list(body, BODY.shapes) : [];
  if (!body || !shapes[shapeIdx]) return doc;
  const next: Obj = { ...asObj(shapes[shapeIdx]) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || (k in SHAPE_DEFAULTS && SHAPE_DEFAULTS[k] === v)) delete next[k];
    else next[k] = v;
  }
  return setBodyShapes(doc, bodyIdx, replaceAt(shapes, shapeIdx, next));
}

/** Set one shape's fill colour (0xRRGGBB). */
export function setShapeColor(doc: Obj, bodyIdx: number, shapeIdx: number, colour: number): Obj {
  return patchShape(doc, bodyIdx, shapeIdx, { [SHAPE.color]: colour });
}

/**
 * Merge bodies into the lowest-indexed one. Their shapes move onto it, re-expressed
 * in its frame; joints and grapples that pointed at a merged body point at the survivor.
 * A joint whose ends would both be the survivor is dropped.
 */
export function mergeBodies(doc: Obj, bodyIdxs: number[]): { doc: Obj; index: number } {
  const bodies = getList(doc, "body");
  const idxs = [...new Set(bodyIdxs)].filter((i) => bodies[i]).sort((a, b) => a - b);
  const surv = idxs[0];
  if (surv === undefined || idxs.length < 2) return { doc, index: surv ?? -1 };
  const sb = bodies[surv]!;
  const sx = bodyXf(sb);
  const survId = bodyIdAt(doc, surv);
  const absorbed = idxs.slice(1);
  const merged = new Set(absorbed.map((i) => bodyIdAt(doc, i)));
  const moved: Obj[] = [];
  for (const i of absorbed) {
    const b = bodies[i]!;
    const bx = bodyXf(b);
    const origin = toLocal(sx, toWorld(bx, { x: 0, y: 0 }));
    const dir = (x: number, y: number): Pt => {
      const w = toLocal(sx, toWorld(bx, { x, y }));
      return { x: w.x - origin.x, y: w.y - origin.y };
    };
    for (const s of list(b, BODY.shapes)) {
      const shape = asObj(s);
      const at = toLocal(sx, toWorld(bx, { x: num(shape, SHAPE.x, 0), y: num(shape, SHAPE.y, 0) }));
      const next: Obj = { ...shape, [SHAPE.x]: round(at.x), [SHAPE.y]: round(at.y) };
      const pts = flatPoints(shape);
      if (pts.length) {
        const rot: number[] = [];
        for (let k = 0; k + 1 < pts.length; k += 2) {
          const q = dir(pts[k]!, pts[k + 1]!);
          rot.push(round(q.x), round(q.y));
        }
        next.p = rot;
      }
      moved.push(next);
    }
  }
  const survBody: Obj = { ...sb, [BODY.shapes]: [...list(sb, BODY.shapes), ...moved] };
  const remap = (id: number): number => (merged.has(id) ? survId : id);
  let next = withList(
    doc,
    "body",
    bodies.map((b, i) => (i === surv ? survBody : b)).filter((_, i) => !absorbed.includes(i)),
  );
  const joints: Obj[] = [];
  for (const j of getList(next, "joint")) {
    const a = num(j, JOINT.bodyA, -1);
    const b = num(j, JOINT.bodyB, -1);
    if (remap(a) === remap(b) && remap(a) !== -1) continue;
    const out: Obj = { ...j };
    if (remap(a) !== a) out[JOINT.bodyA] = remap(a);
    if (remap(b) !== b) out[JOINT.bodyB] = remap(b);
    joints.push(out);
  }
  next = withList(next, "joint", joints);
  const grapples = getList(next, "grapple").map((g) => (merged.has(num(g, GRAPPLE.body, -1)) ? { ...g, [GRAPPLE.body]: survId } : g));
  next = withList(next, "grapple", grapples);
  return { doc: next, index: surv };
}

/** Deep-cloned editor clipboard payload: top-level entities (with the map they came from) or in-body shapes. */
export type ClipboardData =
  | { mode: "entities"; source: number; bodies: Obj[]; joints: Obj[]; spawns: Obj[]; turrets: Obj[]; grapples: Obj[]; caps: Obj[] }
  | { mode: "shapes"; shapes: Obj[]; origin: Pt; angle: number };

function cloneObj(o: Obj): Obj {
  return structuredClone(o);
}

/** Rotate a shape's offset and polygon points by `angle` about the body origin. */
function turnShape(shape: Obj, angle: number): Obj {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const x = num(shape, SHAPE.x, 0);
  const y = num(shape, SHAPE.y, 0);
  const next = withField(withField(shape, SHAPE.x, round(c * x - s * y), SHAPE_DEFAULTS), SHAPE.y, round(s * x + c * y), SHAPE_DEFAULTS);
  const flat = flatPoints(shape);
  if (flat.length === 0) return next;
  const rot: number[] = [];
  for (let k = 0; k + 1 < flat.length; k += 2) {
    const px = flat[k]!;
    const py = flat[k + 1]!;
    rot.push(round(c * px - s * py), round(s * px + c * py));
  }
  return { ...next, [SHAPE.points]: rot };
}

/**
 * Re-point a copied joint's ends at the pasted bodies, or at the world (-1) with an offset. An end on a body
 * the clip did not copy keeps its body only within the same map; from another map it would hit an unrelated
 * body, so the joint is dropped (returns false).
 */
function relinkJoint(j: Obj, idMap: Map<number, number>, doc: Obj, sameMap: boolean, dx: number, dy: number): boolean {
  const ends: [string, string, string][] = [
    [JOINT.bodyA, JOINT.anchorAX, JOINT.anchorAY],
    [JOINT.bodyB, JOINT.anchorBX, JOINT.anchorBY],
  ];
  for (const [kid, kx, ky] of ends) {
    const oldId = num(j, kid, -1);
    const mapped = oldId >= 0 ? idMap.get(oldId) : undefined;
    if (mapped !== undefined) {
      j[kid] = mapped;
    } else if (oldId < 0) {
      j[kx] = round(num(j, kx, 0) + dx);
      j[ky] = round(num(j, ky, 0) + dy);
    } else if (!sameMap) {
      return false;
    } else {
      const host = bodyById(doc, oldId);
      if (host) {
        const local = { x: num(j, kx, 0), y: num(j, ky, 0) };
        const world = toWorld(bodyXf(host), local);
        const moved = toLocal(bodyXf(host), { x: world.x + dx, y: world.y + dy });
        j[kx] = round(moved.x);
        j[ky] = round(moved.y);
      } else {
        delete j[kid];
        j[kx] = round(num(j, kx, 0) + dx);
        j[ky] = round(num(j, ky, 0) + dy);
      }
    }
  }
  return true;
}

/** Copy the selected top-level entities, plus any joints linking two copied bodies. */
export function copyRefs(doc: Obj, refs: readonly Ref[], source: number): ClipboardData | null {
  if (refs.length === 0) return null;
  const byKind = new Map<Kind, Set<number>>();
  for (const r of refs) {
    const set = byKind.get(r.kind) ?? new Set<number>();
    set.add(r.i);
    byKind.set(r.kind, set);
  }
  const copiedBodyIds = new Set<number>();
  const bodies: Obj[] = [];
  for (const i of [...(byKind.get("body") ?? [])].sort((a, b) => a - b)) {
    const b = getList(doc, "body")[i];
    if (!b) continue;
    copiedBodyIds.add(num(b, BODY.id, -1));
    bodies.push(cloneObj(b));
  }
  const jointIdxs = new Set<number>(byKind.get("joint") ?? []);
  if (copiedBodyIds.size > 0) {
    getList(doc, "joint").forEach((j, i) => {
      const a = num(j, JOINT.bodyA, -1);
      const b = num(j, JOINT.bodyB, -1);
      if (a >= 0 && b >= 0 && copiedBodyIds.has(a) && copiedBodyIds.has(b)) jointIdxs.add(i);
    });
  }
  const pick = (kind: Kind, idxs: Iterable<number>): Obj[] => {
    const items = getList(doc, kind);
    const out: Obj[] = [];
    for (const i of [...idxs].sort((a, b) => a - b)) {
      const o = items[i];
      if (o) out.push(cloneObj(o));
    }
    return out;
  };
  const joints = pick("joint", jointIdxs);
  const spawns = pick("spawn", byKind.get("spawn") ?? []);
  const turrets = pick("turret", byKind.get("turret") ?? []);
  const grapples = pick("grapple", byKind.get("grapple") ?? []);
  const caps = pick("cap", byKind.get("cap") ?? []);
  if (bodies.length + joints.length + spawns.length + turrets.length + grapples.length + caps.length === 0) return null;
  return { mode: "entities", source, bodies, joints, spawns, turrets, grapples, caps };
}

/** Copy selected shapes from one body. */
export function copyShapes(doc: Obj, bodyIdx: number, shapeIdxs: readonly number[]): ClipboardData | null {
  const body = getList(doc, "body")[bodyIdx];
  if (!body || shapeIdxs.length === 0) return null;
  const src = list(body, BODY.shapes);
  const shapes: Obj[] = [];
  for (const i of [...new Set(shapeIdxs)].sort((a, b) => a - b)) {
    const s = src[i];
    if (s) shapes.push(cloneObj(asObj(s)));
  }
  if (shapes.length === 0) return null;
  return { mode: "shapes", shapes, origin: { x: num(body, BODY.x, 0), y: num(body, BODY.y, 0) }, angle: num(body, BODY.angle, 0) };
}

/** Paste copied top-level entities with fresh body IDs, remapped joints/grapples, and a world offset. `sameMap` is false when the clip came from another map: references to bodies it did not copy are dropped. */
export function pasteClipboard(doc: Obj, clip: ClipboardData, dx: number, dy: number, sameMap: boolean): { doc: Obj; refs: Ref[] } {
  if (clip.mode === "shapes") {
    const cloned = clip.shapes.map(cloneObj);
    const made = addBody(doc, cloned, { x: round(clip.origin.x + dx), y: round(clip.origin.y + dy) }, clip.angle);
    return { doc: made.doc, refs: [{ kind: "body", i: made.index }] };
  }
  let next = doc;
  const refs: Ref[] = [];
  const idMap = new Map<number, number>();
  let allocId = nextBodyId(next);

  if (clip.bodies.length > 0) {
    const existing = getList(next, "body");
    const added: Obj[] = [];
    for (const raw of clip.bodies) {
      const b = cloneObj(raw);
      const oldId = num(b, BODY.id, -1);
      const newId = Math.min(allocId, MAX_OBJECT_ID);
      allocId = Math.min(allocId + 1, MAX_OBJECT_ID);
      if (oldId >= 0) idMap.set(oldId, newId);
      b[BODY.id] = newId;
      b[BODY.x] = round(num(b, BODY.x, 0) + dx);
      b[BODY.y] = round(num(b, BODY.y, 0) + dy);
      refs.push({ kind: "body", i: existing.length + added.length });
      added.push(b);
    }
    next = withList(next, "body", [...existing, ...added]);
  }

  const appendSimple = (kind: "spawn" | "turret" | "cap", items: Obj[]): void => {
    if (items.length === 0) return;
    const existing = getList(next, kind);
    const added = items.map((raw, k) => {
      const o = cloneObj(raw);
      o[MARKER.x] = round(num(o, MARKER.x, 0) + dx);
      o[MARKER.y] = round(num(o, MARKER.y, 0) + dy);
      refs.push({ kind, i: existing.length + k });
      return o;
    });
    next = withList(next, kind, [...existing, ...added]);
  };
  appendSimple("spawn", clip.spawns);
  appendSimple("turret", clip.turrets);
  appendSimple("cap", clip.caps);

  if (clip.grapples.length > 0) {
    const existing = getList(next, "grapple");
    const added = clip.grapples.map((raw, k) => {
      const g = cloneObj(raw);
      g[MARKER.x] = round(num(g, MARKER.x, 0) + dx);
      g[MARKER.y] = round(num(g, MARKER.y, 0) + dy);
      const attached = num(g, GRAPPLE.body, -1);
      if (attached >= 0) {
        const mapped = idMap.get(attached);
        if (mapped !== undefined) g[GRAPPLE.body] = mapped;
        else if (!sameMap || !bodyById(next, attached)) delete g[GRAPPLE.body];
      }
      refs.push({ kind: "grapple", i: existing.length + k });
      return g;
    });
    next = withList(next, "grapple", [...existing, ...added]);
  }

  if (clip.joints.length > 0) {
    const existing = getList(next, "joint");
    const added: Obj[] = [];
    for (const raw of clip.joints) {
      const j = cloneObj(raw);
      if (!relinkJoint(j, idMap, next, sameMap, dx, dy)) continue;
      refs.push({ kind: "joint", i: existing.length + added.length });
      added.push(j);
    }
    next = withList(next, "joint", [...existing, ...added]);
  }

  return { doc: next, refs };
}

/** Paste copied shapes into a scoped body and shift them by a world offset. Their geometry turns by the body angle difference, so they keep their world orientation. */
export function pasteShapes(doc: Obj, bodyIdx: number, clip: ClipboardData, dx: number, dy: number): { doc: Obj; shapes: number[] } {
  if (clip.mode !== "shapes") return { doc, shapes: [] };
  const target = getList(doc, "body")[bodyIdx];
  if (!target) return { doc, shapes: [] };
  const turn = clip.angle - num(target, BODY.angle, 0);
  const pasted = turn === 0 ? clip.shapes.map(cloneObj) : clip.shapes.map((s) => turnShape(s, turn));
  const made = addShapes(doc, bodyIdx, pasted);
  const idxs = pasted.map((_, i) => made.first + i);
  const next = dx !== 0 || dy !== 0 ? moveShapes(made.doc, bodyIdx, idxs, dx, dy) : made.doc;
  return { doc: next, shapes: idxs };
}
