//! Port of `Box2D.Collision.b2Collision` manifold generators: `CollideCircles`,
//! `CollidePolygons`, `CollidePolygonAndCircle` and their helpers
//! (`ClipSegmentToLine`, `EdgeSeparation`, `FindMaxSeparation`,
//! `FindIncidentEdge`). Operation order follows the archived JavaScript exactly.
//! The JS static scratch buffers are replaced by locals; their contents never
//! escape a call, so results are unchanged.

use crate::collision::manifold::{ContactFeature, Manifold, ManifoldType};
use crate::collision::shapes::{CircleShape, PolygonShape};
use crate::common::math::{MIN_VALUE, Transform, Vec2};
use crate::common::settings::MAX_MANIFOLD_POINTS;

/// `ClipVertex`: a clipped point and the feature it came from.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct ClipVertex {
    pub v: Vec2,
    pub id: ContactFeature,
}

/// `b2Collision.ClipSegmentToLine`. Writes at most two entries to `out` and
/// returns how many were written.
fn clip_segment_to_line(
    out: &mut [ClipVertex; 2],
    input: &[ClipVertex; 2],
    normal: Vec2,
    offset: f64,
) -> usize {
    let mut s = 0usize;
    let r = input[0].v;
    let a = input[1].v;
    let l = normal.x * r.x + normal.y * r.y - offset;
    let m = normal.x * a.x + normal.y * a.y - offset;
    if l <= 0.0 {
        out[s] = input[0];
        s += 1;
    }
    if m <= 0.0 {
        out[s] = input[1];
        s += 1;
    }
    if l * m < 0.0 {
        let p = l / (l - m);
        out[s].v.x = r.x + p * (a.x - r.x);
        out[s].v.y = r.y + p * (a.y - r.y);
        out[s].id = if l > 0.0 { input[0].id } else { input[1].id };
        s += 1;
    }
    s
}

/// `b2Collision.EdgeSeparation`.
fn edge_separation(
    poly1: &PolygonShape,
    xf1: &Transform,
    edge: usize,
    poly2: &PolygonShape,
    xf2: &Transform,
) -> f64 {
    let count2 = poly2.vertex_count;
    let n = poly1.normals[edge];
    let d1 = xf1.r;
    let c = d1.col1.x * n.x + d1.col2.x * n.y;
    let h = d1.col1.y * n.x + d1.col2.y * n.y;
    let p = xf2.r.col1.x * c + xf2.r.col1.y * h;
    let y = xf2.r.col2.x * c + xf2.r.col2.y * h;
    let mut u = 0usize;
    let mut min = f64::MAX;
    for i in 0..count2 {
        let w = poly2.vertices[i];
        let f = w.x * p + w.y * y;
        if f < min {
            min = f;
            u = i;
        }
    }
    let v1 = poly1.vertices[edge];
    let px = xf1.position.x + (d1.col1.x * v1.x + d1.col2.x * v1.y);
    let py = xf1.position.y + (d1.col1.y * v1.x + d1.col2.y * v1.y);
    let v2 = poly2.vertices[u];
    let qx = xf2.position.x + (xf2.r.col1.x * v2.x + xf2.r.col2.x * v2.y);
    let qy = xf2.position.y + (xf2.r.col1.y * v2.x + xf2.r.col2.y * v2.y);
    (qx - px) * c + (qy - py) * h
}

/// `b2Collision.FindMaxSeparation`. Returns `(edge index, separation)`.
fn find_max_separation(
    poly1: &PolygonShape,
    xf1: &Transform,
    poly2: &PolygonShape,
    xf2: &Transform,
) -> (usize, f64) {
    let count1 = poly1.vertex_count;
    let a = xf2.r;
    let r = poly2.centroid;
    let mut cx = xf2.position.x + (a.col1.x * r.x + a.col2.x * r.y);
    let mut cy = xf2.position.y + (a.col1.y * r.x + a.col2.y * r.y);
    let a = xf1.r;
    let r = poly1.centroid;
    cx -= xf1.position.x + (a.col1.x * r.x + a.col2.x * r.y);
    cy -= xf1.position.y + (a.col1.y * r.x + a.col2.y * r.y);
    let y = cx * xf1.r.col1.x + cy * xf1.r.col1.y;
    let u = cx * xf1.r.col2.x + cy * xf1.r.col2.y;
    let mut x = 0usize;
    let mut best = -f64::MAX;
    for f in 0..count1 {
        let n = poly1.normals[f];
        let d = n.x * y + n.y * u;
        if d > best {
            best = d;
            x = f;
        }
    }
    let mut sep = edge_separation(poly1, xf1, x, poly2, xf2);
    let prev = if x >= 1 { x - 1 } else { count1 - 1 };
    let prev_sep = edge_separation(poly1, xf1, prev, poly2, xf2);
    let next = if x + 1 < count1 { x + 1 } else { 0 };
    let next_sep = edge_separation(poly1, xf1, next, poly2, xf2);
    let mut best_i;
    let mut best_sep;
    let step: i32;
    if prev_sep > sep && prev_sep > next_sep {
        step = -1;
        best_i = prev;
        best_sep = prev_sep;
    } else {
        if !(next_sep > sep) {
            return (x, sep);
        }
        step = 1;
        best_i = next;
        best_sep = next_sep;
    }
    loop {
        x = if step == -1 {
            if best_i >= 1 { best_i - 1 } else { count1 - 1 }
        } else if best_i + 1 < count1 {
            best_i + 1
        } else {
            0
        };
        sep = edge_separation(poly1, xf1, x, poly2, xf2);
        if sep > best_sep {
            best_i = x;
            best_sep = sep;
        } else {
            break;
        }
    }
    (best_i, best_sep)
}

/// `b2Collision.FindIncidentEdge`.
fn find_incident_edge(
    out: &mut [ClipVertex; 2],
    ref_poly: &PolygonShape,
    ref_xf: &Transform,
    edge: usize,
    inc_poly: &PolygonShape,
    inc_xf: &Transform,
) {
    let count = inc_poly.vertex_count;
    let ln = ref_poly.normals[edge];
    let a = ref_xf.r;
    let u0 = a.col1.x * ln.x + a.col2.x * ln.y;
    let x0 = a.col1.y * ln.x + a.col2.y * ln.y;
    let a = inc_xf.r;
    let u = a.col1.x * u0 + a.col1.y * x0;
    let x = a.col2.x * u0 + a.col2.y * x0;
    let mut f = 0usize;
    let mut d = f64::MAX;
    for b in 0..count {
        let n = inc_poly.normals[b];
        let dd = u * n.x + x * n.y;
        if dd < d {
            d = dd;
            f = b;
        }
    }
    let v = f;
    let next = if v + 1 < count { v + 1 } else { 0 };
    let a = inc_xf.r;

    let q = inc_poly.vertices[v];
    out[0].v.x = inc_xf.position.x + (a.col1.x * q.x + a.col2.x * q.y);
    out[0].v.y = inc_xf.position.y + (a.col1.y * q.x + a.col2.y * q.y);
    out[0].id.set_reference_edge(edge as u32);
    out[0].id.set_incident_edge(v as u32);
    out[0].id.set_incident_vertex(0);

    let q = inc_poly.vertices[next];
    out[1].v.x = inc_xf.position.x + (a.col1.x * q.x + a.col2.x * q.y);
    out[1].v.y = inc_xf.position.y + (a.col1.y * q.x + a.col2.y * q.y);
    out[1].id.set_reference_edge(edge as u32);
    out[1].id.set_incident_edge(next as u32);
    out[1].id.set_incident_vertex(1);
}

/// `b2Collision.CollideCircles`.
pub fn collide_circles(
    manifold: &mut Manifold,
    a: &CircleShape,
    xf_a: &Transform,
    b: &CircleShape,
    xf_b: &Transform,
) {
    manifold.point_count = 0;
    let r = xf_a.r;
    let p = a.p;
    let lx = xf_a.position.x + (r.col1.x * p.x + r.col2.x * p.y);
    let ly = xf_a.position.y + (r.col1.y * p.x + r.col2.y * p.y);
    let r = xf_b.r;
    let p = b.p;
    let cx = xf_b.position.x + (r.col1.x * p.x + r.col2.x * p.y);
    let cy = xf_b.position.y + (r.col1.y * p.x + r.col2.y * p.y);
    let dx = cx - lx;
    let dy = cy - ly;
    let radius = a.radius + b.radius;
    if !(dx * dx + dy * dy > radius * radius) {
        manifold.manifold_type = Some(ManifoldType::Circles);
        manifold.local_point = a.p;
        manifold.local_normal = Vec2::new(0.0, 0.0);
        manifold.point_count = 1;
        manifold.points[0].local_point = b.p;
        manifold.points[0].id.key = 0;
    }
}

/// `b2Collision.CollidePolygons`.
pub fn collide_polygons(
    manifold: &mut Manifold,
    poly_a: &PolygonShape,
    xf_a: &Transform,
    poly_b: &PolygonShape,
    xf_b: &Transform,
) {
    manifold.point_count = 0;
    let total_radius = poly_a.radius + poly_b.radius;
    let (edge_a, sep_a) = find_max_separation(poly_a, xf_a, poly_b, xf_b);
    if sep_a > total_radius {
        return;
    }
    let (edge_b, sep_b) = find_max_separation(poly_b, xf_b, poly_a, xf_a);
    if sep_b > total_radius {
        return;
    }

    // The manifold type is set here, before clipping, as in the JS.
    let (ref_poly, ref_xf, inc_poly, inc_xf, ref_edge, flip) =
        if sep_b > 0.98 * sep_a + 0.001 {
            manifold.manifold_type = Some(ManifoldType::FaceB);
            (poly_b, xf_b, poly_a, xf_a, edge_b, 1u32)
        } else {
            manifold.manifold_type = Some(ManifoldType::FaceA);
            (poly_a, xf_a, poly_b, xf_b, edge_a, 0u32)
        };

    let mut incident = [ClipVertex::default(); 2];
    find_incident_edge(&mut incident, ref_poly, ref_xf, ref_edge, inc_poly, inc_xf);

    let ref_count = ref_poly.vertex_count;
    let v1 = ref_poly.vertices[ref_edge];
    let v2 = if ref_edge + 1 < ref_count {
        ref_poly.vertices[ref_edge + 1]
    } else {
        ref_poly.vertices[0]
    };
    let mut tangent = Vec2::new(v2.x - v1.x, v2.y - v1.y);
    tangent.normalize();
    let local_normal = Vec2::new(tangent.y, -tangent.x);
    let plane_point = Vec2::new(0.5 * (v1.x + v2.x), 0.5 * (v1.y + v2.y));

    let rm = ref_xf.r;
    let m = Vec2::new(
        rm.col1.x * tangent.x + rm.col2.x * tangent.y,
        rm.col1.y * tangent.x + rm.col2.y * tangent.y,
    );
    let tangent_neg = Vec2::new(-m.x, -m.y);
    let normal = Vec2::new(m.y, -m.x);

    let l1 = Vec2::new(
        ref_xf.position.x + (rm.col1.x * v1.x + rm.col2.x * v1.y),
        ref_xf.position.y + (rm.col1.y * v1.x + rm.col2.y * v1.y),
    );
    let l2 = Vec2::new(
        ref_xf.position.x + (rm.col1.x * v2.x + rm.col2.x * v2.y),
        ref_xf.position.y + (rm.col1.y * v2.x + rm.col2.y * v2.y),
    );
    let front_offset = normal.x * l1.x + normal.y * l1.y;
    let side_offset1 = -m.x * l1.x - m.y * l1.y + total_radius;
    let side_offset2 = m.x * l2.x + m.y * l2.y + total_radius;

    let mut clip1 = [ClipVertex::default(); 2];
    if clip_segment_to_line(&mut clip1, &incident, tangent_neg, side_offset1) < 2 {
        return;
    }
    let mut clip2 = [ClipVertex::default(); 2];
    if clip_segment_to_line(&mut clip2, &clip1, m, side_offset2) < 2 {
        return;
    }

    manifold.local_normal = local_normal;
    manifold.local_point = plane_point;
    let inc_rm = inc_xf.r;
    let mut count = 0usize;
    for i in 0..MAX_MANIFOLD_POINTS {
        let a = clip2[i];
        if normal.x * a.v.x + normal.y * a.v.y - front_offset <= total_radius {
            let j = a.v.x - inc_xf.position.x;
            let k = a.v.y - inc_xf.position.y;
            let point = &mut manifold.points[count];
            point.local_point.x = j * inc_rm.col1.x + k * inc_rm.col1.y;
            point.local_point.y = j * inc_rm.col2.x + k * inc_rm.col2.y;
            point.id = a.id;
            point.id.set_flip(flip);
            count += 1;
        }
    }
    manifold.point_count = count;
}

/// `b2Collision.CollidePolygonAndCircle`.
pub fn collide_polygon_and_circle(
    manifold: &mut Manifold,
    poly: &PolygonShape,
    xf_a: &Transform,
    circle: &CircleShape,
    xf_b: &Transform,
) {
    manifold.point_count = 0;
    let rb = xf_b.r;
    let cx = xf_b.position.x + (rb.col1.x * circle.p.x + rb.col2.x * circle.p.y);
    let cy = xf_b.position.y + (rb.col1.y * circle.p.x + rb.col2.y * circle.p.y);
    let lx = cx - xf_a.position.x;
    let ly = cy - xf_a.position.y;
    let ra = xf_a.r;
    let px = lx * ra.col1.x + ly * ra.col1.y;
    let py = lx * ra.col2.x + ly * ra.col2.y;

    let radius = poly.radius + circle.radius;
    let count = poly.vertex_count;
    let mut best_i = 0usize;
    let mut best = -f64::MAX;
    for i in 0..count {
        let vi = poly.vertices[i];
        let dx = px - vi.x;
        let dy = py - vi.y;
        let n = poly.normals[i];
        let sep = n.x * dx + n.y * dy;
        if sep > radius {
            return;
        }
        if sep > best {
            best = sep;
            best_i = i;
        }
    }

    let next_i = if best_i + 1 < count { best_i + 1 } else { 0 };
    let va = poly.vertices[best_i];
    let vb = poly.vertices[next_i];
    if best < MIN_VALUE {
        manifold.point_count = 1;
        manifold.manifold_type = Some(ManifoldType::FaceA);
        manifold.local_normal = poly.normals[best_i];
        manifold.local_point = Vec2::new(0.5 * (va.x + vb.x), 0.5 * (va.y + vb.y));
        manifold.points[0].local_point = circle.p;
        manifold.points[0].id.key = 0;
        return;
    }

    let g = (px - va.x) * (vb.x - va.x) + (py - va.y) * (vb.y - va.y);
    let w = (px - vb.x) * (va.x - vb.x) + (py - vb.y) * (va.y - vb.y);
    if g <= 0.0 {
        if (px - va.x) * (px - va.x) + (py - va.y) * (py - va.y) > radius * radius {
            return;
        }
        manifold.point_count = 1;
        manifold.manifold_type = Some(ManifoldType::FaceA);
        manifold.local_normal = Vec2::new(px - va.x, py - va.y);
        manifold.local_normal.normalize();
        manifold.local_point = va;
        manifold.points[0].local_point = circle.p;
        manifold.points[0].id.key = 0;
    } else if w <= 0.0 {
        if (px - vb.x) * (px - vb.x) + (py - vb.y) * (py - vb.y) > radius * radius {
            return;
        }
        manifold.point_count = 1;
        manifold.manifold_type = Some(ManifoldType::FaceA);
        manifold.local_normal = Vec2::new(px - vb.x, py - vb.y);
        manifold.local_normal.normalize();
        manifold.local_point = vb;
        manifold.points[0].local_point = circle.p;
        manifold.points[0].id.key = 0;
    } else {
        let mx = 0.5 * (va.x + vb.x);
        let my = 0.5 * (va.y + vb.y);
        let n = poly.normals[best_i];
        let sep = (px - mx) * n.x + (py - my) * n.y;
        if sep > radius {
            return;
        }
        manifold.point_count = 1;
        manifold.manifold_type = Some(ManifoldType::FaceA);
        manifold.local_normal = n;
        manifold.local_normal.normalize();
        manifold.local_point = Vec2::new(mx, my);
        manifold.points[0].local_point = circle.p;
        manifold.points[0].id.key = 0;
    }
}
