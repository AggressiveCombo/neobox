// Plane geometry for the map editor: polygon checks, ear clipping and the
// convex split the sim needs (it builds polygons without a hull step).

export interface Pt {
  x: number;
  y: number;
}

export interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

const EPS = 1e-9;

export function cross(o: Pt, a: Pt, b: Pt): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

export function area2(pts: readonly Pt[]): number {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    const q = pts[(i + 1) % pts.length]!;
    s += p.x * q.y - q.x * p.y;
  }
  return s;
}

export function bbox(pts: readonly Pt[]): Box {
  const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const p of pts) {
    if (p.x < b.minX) b.minX = p.x;
    if (p.y < b.minY) b.minY = p.y;
    if (p.x > b.maxX) b.maxX = p.x;
    if (p.y > b.maxY) b.maxY = p.y;
  }
  return b;
}

export function pointInPoly(p: Pt, pts: readonly Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i]!;
    const b = pts[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Closest point on segment ab to p. */
export function nearestOnSegment(p: Pt, a: Pt, b: Pt): Pt {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return { x: a.x + t * dx, y: a.y + t * dy };
}

function segmentsCross(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  return ((d1 > EPS && d2 < -EPS) || (d1 < -EPS && d2 > EPS)) && ((d3 > EPS && d4 < -EPS) || (d3 < -EPS && d4 > EPS));
}

/** True when two non-adjacent edges of the closed polygon properly cross. */
export function selfIntersects(pts: readonly Pt[]): boolean {
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % n]!;
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const c = pts[j]!;
      const d = pts[(j + 1) % n]!;
      if (segmentsCross(a, b, c, d)) return true;
    }
  }
  return false;
}

function samePt(a: Pt, b: Pt): boolean {
  return a.x === b.x && a.y === b.y;
}

/**
 * Drops repeated points and points that sit straight on the line between
 * their neighbours (same outline). Keeps the winding.
 */
export function cleanPoly(pts: readonly Pt[]): Pt[] {
  let out: Pt[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && Math.hypot(p.x - last.x, p.y - last.y) < EPS) continue;
    out.push(p);
  }
  if (out.length > 1 && Math.hypot(out[0]!.x - out[out.length - 1]!.x, out[0]!.y - out[out.length - 1]!.y) < EPS) out.pop();
  let changed = true;
  while (changed && out.length >= 3) {
    changed = false;
    for (let i = 0; i < out.length; i++) {
      const prev = out[(i + out.length - 1) % out.length]!;
      const cur = out[i]!;
      const next = out[(i + 1) % out.length]!;
      const straight = Math.abs(cross(prev, cur, next)) <= EPS * (Math.hypot(cur.x - prev.x, cur.y - prev.y) + 1);
      const forward = (cur.x - prev.x) * (next.x - cur.x) + (cur.y - prev.y) * (next.y - cur.y) >= 0;
      if (straight && forward) {
        out = out.filter((_, k) => k !== i);
        changed = true;
        break;
      }
    }
  }
  return out;
}

export function ccw(pts: readonly Pt[]): Pt[] {
  return area2(pts) < 0 ? [...pts].reverse() : [...pts];
}

export function isConvexCcw(pts: readonly Pt[]): boolean {
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    if (cross(pts[i]!, pts[(i + 1) % n]!, pts[(i + 2) % n]!) < -EPS) return false;
  }
  return true;
}

function insideTri(p: Pt, a: Pt, b: Pt, c: Pt): boolean {
  const d1 = cross(a, b, p);
  const d2 = cross(b, c, p);
  const d3 = cross(c, a, p);
  const neg = d1 < -EPS || d2 < -EPS || d3 < -EPS;
  const pos = d1 > EPS || d2 > EPS || d3 > EPS;
  return !(neg && pos);
}

/** Ear clipping of a simple CCW polygon. Returns CCW triangles. */
function triangulate(pts: readonly Pt[]): Pt[][] {
  let idx = pts.map((_, i) => i);
  const tris: Pt[][] = [];
  let guard = pts.length * pts.length + 8;
  while (idx.length > 3 && guard-- > 0) {
    let clipped = false;
    for (let k = 0; k < idx.length; k++) {
      const a = pts[idx[(k + idx.length - 1) % idx.length]!]!;
      const b = pts[idx[k]!]!;
      const c = pts[idx[(k + 1) % idx.length]!]!;
      if (cross(a, b, c) <= EPS) continue;
      let ok = true;
      for (const j of idx) {
        const p = pts[j]!;
        if (samePt(p, a) || samePt(p, b) || samePt(p, c)) continue;
        if (insideTri(p, a, b, c)) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      tris.push([a, b, c]);
      idx = idx.filter((_, m) => m !== k);
      clipped = true;
      break;
    }
    if (!clipped) {
      // Only collinear corners are left: drop one and keep going.
      const k = idx.findIndex((ib, m) => {
        const a = pts[idx[(m + idx.length - 1) % idx.length]!]!;
        const c = pts[idx[(m + 1) % idx.length]!]!;
        return Math.abs(cross(a, pts[ib]!, c)) <= EPS;
      });
      if (k < 0) break;
      idx = idx.filter((_, m) => m !== k);
    }
  }
  if (idx.length === 3) tris.push([pts[idx[0]!]!, pts[idx[1]!]!, pts[idx[2]!]!]);
  return tris;
}

/** Merge parts along shared edges while the result stays convex (Hertel-Mehlhorn). */
function mergeConvex(input: Pt[][]): Pt[][] {
  let parts = input;
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let a = 0; a < parts.length; a++) {
      const A = parts[a]!;
      const n = A.length;
      for (let i = 0; i < n; i++) {
        const p = A[i]!;
        const q = A[(i + 1) % n]!;
        for (let b = 0; b < parts.length; b++) {
          if (b === a) continue;
          const B = parts[b]!;
          const m = B.length;
          for (let j = 0; j < m; j++) {
            if (!samePt(B[j]!, q) || !samePt(B[(j + 1) % m]!, p)) continue;
            const cand: Pt[] = [];
            for (let k = 0; k < n; k++) cand.push(A[(i + 1 + k) % n]!);
            for (let k = 2; k < m; k++) cand.push(B[(j + k) % m]!);
            const clean = cleanPoly(cand);
            if (clean.length < 3 || !isConvexCcw(clean)) continue;
            parts = parts.filter((_, z) => z !== a && z !== b);
            parts.push(clean);
            merged = true;
            break outer;
          }
        }
      }
    }
  }
  return parts;
}

/**
 * Splits a simple polygon into convex CCW parts. A convex input returns one
 * part. Throws on self-intersection or a degenerate outline.
 */
export function convexParts(input: readonly Pt[]): Pt[][] {
  const pts = cleanPoly(input);
  if (pts.length < 3) throw new Error("A shape needs at least 3 different points");
  if (Math.abs(area2(pts)) < EPS) throw new Error("The shape has no area");
  if (selfIntersects(pts)) throw new Error("The outline crosses itself");
  const outline = ccw(pts);
  if (isConvexCcw(outline)) return [outline];
  const tris = triangulate(outline);
  if (tris.length === 0) throw new Error("The shape could not be split into convex parts");
  return mergeConvex(tris).map((p) => cleanPoly(p));
}
