//! Port of `Box2D.Collision.Shapes`: `b2Shape`, `b2CircleShape`, `b2PolygonShape`
//! and `b2MassData`. Edge/chain shapes and buoyancy (`ComputeSubmergedArea`) are
//! not ported. Operation order follows the archived JavaScript exactly.

use crate::collision::aabb::{AABB, RayCastInput, RayCastOutput};
use crate::common::math::{MIN_VALUE, Mat22, Transform, Vec2, cross_vf, mul_mv, mul_x, subtract_vv};
use crate::common::settings::{B2_PI, LINEAR_SLOP};

/// `b2Shape.e_circleShape` / `b2Shape.e_polygonShape`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ShapeType {
    Circle,
    Polygon,
}

/// `b2MassData`.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct MassData {
    pub mass: f64,
    pub center: Vec2,
    pub i: f64,
}

/// `b2CircleShape`. `p` is the local center (`m_p`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CircleShape {
    pub radius: f64,
    pub p: Vec2,
}

impl Default for CircleShape {
    /// `new b2CircleShape()`: `m_radius` starts at `b2_linearSlop`.
    fn default() -> Self {
        Self {
            radius: LINEAR_SLOP,
            p: Vec2::zero(),
        }
    }
}

impl CircleShape {
    /// `new b2CircleShape(radius)`.
    pub fn new(radius: f64) -> Self {
        Self {
            radius,
            p: Vec2::zero(),
        }
    }
    /// `b2CircleShape.prototype.SetLocalPosition`.
    pub fn set_local_position(&mut self, p: Vec2) {
        self.p = p;
    }
    /// `b2CircleShape.prototype.GetRadius`.
    pub fn get_radius(&self) -> f64 {
        self.radius
    }
}

/// `b2PolygonShape`. `vertices`/`normals` are grow-only arrays (JS `Reserve`);
/// only the first `vertex_count` entries are meaningful, as in the source.
#[derive(Clone, Debug, PartialEq)]
pub struct PolygonShape {
    pub radius: f64,
    pub vertex_count: usize,
    pub vertices: Vec<Vec2>,
    pub normals: Vec<Vec2>,
    pub centroid: Vec2,
}

impl Default for PolygonShape {
    /// `new b2PolygonShape()`: empty, `m_radius = b2_linearSlop`.
    fn default() -> Self {
        Self::new()
    }
}

impl PolygonShape {
    /// `new b2PolygonShape()`.
    pub fn new() -> Self {
        Self {
            radius: LINEAR_SLOP,
            vertex_count: 0,
            vertices: Vec::new(),
            normals: Vec::new(),
            centroid: Vec2::zero(),
        }
    }

    /// `b2PolygonShape.prototype.Reserve`: grows both arrays to at least `n`.
    fn reserve(&mut self, n: usize) {
        while self.vertices.len() < n {
            self.vertices.push(Vec2::zero());
            self.normals.push(Vec2::zero());
        }
    }

    /// `b2PolygonShape.prototype.SetAsArray` / `SetAsVector`. `count == 0` means
    /// `points.len()`. No convexity or winding check, no vertex limit.
    pub fn set_as_array(&mut self, points: &[Vec2], count: usize) {
        let count = if count == 0 { points.len() } else { count };
        self.vertex_count = count;
        self.reserve(count);
        for n in 0..count {
            self.vertices[n] = points[n];
        }
        for n in 0..count {
            let s = n;
            let a = if n + 1 < count { n + 1 } else { 0 };
            let edge = subtract_vv(self.vertices[a], self.vertices[s]);
            let mut normal = cross_vf(edge, 1.0);
            normal.normalize();
            self.normals[n] = normal;
        }
        self.centroid = compute_centroid(&self.vertices, count);
    }

    /// Writes the four box corners and their normals (shared by SetAsBox and
    /// SetAsOrientedBox).
    fn set_box_vertices(&mut self, hx: f64, hy: f64) {
        self.vertex_count = 4;
        self.reserve(4);
        self.vertices[0] = Vec2::new(-hx, -hy);
        self.vertices[1] = Vec2::new(hx, -hy);
        self.vertices[2] = Vec2::new(hx, hy);
        self.vertices[3] = Vec2::new(-hx, hy);
        self.normals[0] = Vec2::new(0.0, -1.0);
        self.normals[1] = Vec2::new(1.0, 0.0);
        self.normals[2] = Vec2::new(0.0, 1.0);
        self.normals[3] = Vec2::new(-1.0, 0.0);
    }

    /// `b2PolygonShape.prototype.SetAsBox(hx, hy)`.
    pub fn set_as_box(&mut self, hx: f64, hy: f64) {
        self.set_box_vertices(hx, hy);
        self.centroid = Vec2::zero();
    }

    /// `b2PolygonShape.prototype.SetAsOrientedBox(hx, hy, center, angle)`.
    pub fn set_as_oriented_box(&mut self, hx: f64, hy: f64, center: Vec2, angle: f64) {
        self.set_box_vertices(hx, hy);
        self.centroid = center;
        let xf = Transform {
            position: center,
            r: Mat22::from_angle(angle),
        };
        for r in 0..4 {
            self.vertices[r] = mul_x(&xf, self.vertices[r]);
            self.normals[r] = mul_mv(&xf.r, self.normals[r]);
        }
    }

    /// `b2PolygonShape.prototype.GetVertexCount`.
    pub fn get_vertex_count(&self) -> usize {
        self.vertex_count
    }
    /// `b2PolygonShape.prototype.GetVertices` (whole grow-only array).
    pub fn get_vertices(&self) -> &[Vec2] {
        &self.vertices
    }
    /// `b2PolygonShape.prototype.GetNormals` (whole grow-only array).
    pub fn get_normals(&self) -> &[Vec2] {
        &self.normals
    }
    /// `b2PolygonShape.prototype.GetRadius`.
    pub fn get_radius(&self) -> f64 {
        self.radius
    }

    /// `b2PolygonShape.prototype.TestPoint`.
    fn test_point(&self, xf: &Transform, p: Vec2) -> bool {
        let n = xf.r;
        let s0 = p.x - xf.position.x;
        let r0 = p.y - xf.position.y;
        let a = s0 * n.col1.x + r0 * n.col1.y;
        let l = s0 * n.col2.x + r0 * n.col2.y;
        for m in 0..self.vertex_count {
            let v = self.vertices[m];
            let s = a - v.x;
            let r = l - v.y;
            let nm = self.normals[m];
            if nm.x * s + nm.y * r > 0.0 {
                return false;
            }
        }
        true
    }

    /// `b2PolygonShape.prototype.RayCast`.
    fn ray_cast(&self, output: &mut RayCastOutput, input: &RayCastInput, xf: &Transform) -> bool {
        let mut lower = 0.0_f64;
        let mut upper = input.max_fraction;
        let mut index: Option<usize> = None;

        let mut l = input.p1.x - xf.position.x;
        let mut m = input.p1.y - xf.position.y;
        let n = xf.r;
        let c = l * n.col1.x + m * n.col1.y;
        let h = l * n.col2.x + m * n.col2.y;
        l = input.p2.x - xf.position.x;
        m = input.p2.y - xf.position.y;
        let p = l * n.col1.x + m * n.col1.y;
        let y = l * n.col2.x + m * n.col2.y;
        let u = p - c;
        let x = y - h;

        for f in 0..self.vertex_count {
            let v = self.vertices[f];
            let l = v.x - c;
            let m = v.y - h;
            let nm = self.normals[f];
            let d = nm.x * l + nm.y * m;
            let b = nm.x * u + nm.y * x;
            if b == 0.0 {
                if d < 0.0 {
                    return false;
                }
            } else if b < 0.0 && d < lower * b {
                lower = d / b;
                index = Some(f);
            } else if b > 0.0 && d < upper * b {
                upper = d / b;
            }
            if upper < lower - MIN_VALUE {
                return false;
            }
        }

        match index {
            Some(i) => {
                output.fraction = lower;
                let s = self.normals[i];
                let n = xf.r;
                output.normal = Vec2::new(
                    n.col1.x * s.x + n.col2.x * s.y,
                    n.col1.y * s.x + n.col2.y * s.y,
                );
                true
            }
            None => false,
        }
    }

    /// `b2PolygonShape.prototype.ComputeAABB`.
    fn compute_aabb(&self, aabb: &mut AABB, xf: &Transform) {
        let e = xf.r;
        let n0 = self.vertices[0];
        let mut lo_x = xf.position.x + (e.col1.x * n0.x + e.col2.x * n0.y);
        let mut lo_y = xf.position.y + (e.col1.y * n0.x + e.col2.y * n0.y);
        let mut hi_x = lo_x;
        let mut hi_y = lo_y;
        for m in 1..self.vertex_count {
            let n = self.vertices[m];
            let c = xf.position.x + (e.col1.x * n.x + e.col2.x * n.y);
            let h = xf.position.y + (e.col1.y * n.x + e.col2.y * n.y);
            lo_x = if lo_x < c { lo_x } else { c };
            lo_y = if lo_y < h { lo_y } else { h };
            hi_x = if hi_x > c { hi_x } else { c };
            hi_y = if hi_y > h { hi_y } else { h };
        }
        aabb.lower_bound = Vec2::new(lo_x - self.radius, lo_y - self.radius);
        aabb.upper_bound = Vec2::new(hi_x + self.radius, hi_y + self.radius);
    }

    /// `b2PolygonShape.prototype.ComputeMass`.
    fn compute_mass(&self, density: f64) -> MassData {
        if self.vertex_count == 2 {
            let center = Vec2::new(
                0.5 * (self.vertices[0].x + self.vertices[1].x),
                0.5 * (self.vertices[0].y + self.vertices[1].y),
            );
            return MassData {
                mass: 0.0,
                center,
                i: 0.0,
            };
        }

        let a = 1.0 / 3.0;
        let mut ex = 0.0_f64;
        let mut ey = 0.0_f64;
        let mut area = 0.0_f64;
        let mut inertia = 0.0_f64;
        for l in 0..self.vertex_count {
            let m = self.vertices[l];
            let c = if l + 1 < self.vertex_count {
                self.vertices[l + 1]
            } else {
                self.vertices[0]
            };
            let h = m.x - 0.0;
            let p = m.y - 0.0;
            let y = c.x - 0.0;
            let u = c.y - 0.0;
            let x = h * u - p * y;
            let half = 0.5 * x;
            area += half;
            ex += half * a * (0.0 + m.x + c.x);
            ey += half * a * (0.0 + m.y + c.y);
            inertia += x
                * (a * (0.25 * (h * h + y * h + y * y) + (0.0 * h + 0.0 * y)) + 0.0
                    + (a * (0.25 * (p * p + u * p + u * u) + (0.0 * p + 0.0 * u)) + 0.0));
        }

        let mass = density * area;
        ex *= 1.0 / area;
        ey *= 1.0 / area;
        MassData {
            mass,
            center: Vec2::new(ex, ey),
            i: density * inertia,
        }
    }
}

/// `b2PolygonShape.ComputeCentroid(vertices, count)`.
fn compute_centroid(vertices: &[Vec2], count: usize) -> Vec2 {
    let mut e = Vec2::zero();
    let mut n = 0.0_f64;
    let s = 1.0 / 3.0;
    for r in 0..count {
        let a = vertices[r];
        let l = if r + 1 < count {
            vertices[r + 1]
        } else {
            vertices[0]
        };
        let m = a.x - 0.0;
        let c = a.y - 0.0;
        let p = l.x - 0.0;
        let y = 0.5 * (m * (l.y - 0.0) - c * p);
        n += y;
        e.x += y * s * (0.0 + a.x + l.x);
        e.y += y * s * (0.0 + a.y + l.y);
    }
    e.x *= 1.0 / n;
    e.y *= 1.0 / n;
    e
}

/// `b2Shape` variant dispatch (`b2CircleShape` | `b2PolygonShape`).
#[derive(Clone, Debug, PartialEq)]
pub enum Shape {
    Circle(CircleShape),
    Polygon(PolygonShape),
}

impl Shape {
    /// `b2Shape.prototype.GetType`.
    pub fn shape_type(&self) -> ShapeType {
        match self {
            Shape::Circle(_) => ShapeType::Circle,
            Shape::Polygon(_) => ShapeType::Polygon,
        }
    }

    /// `b2Shape.m_radius`.
    pub fn radius(&self) -> f64 {
        match self {
            Shape::Circle(c) => c.radius,
            Shape::Polygon(p) => p.radius,
        }
    }

    /// `b2Shape.GetChildCount` semantics: circles and polygons have one child.
    pub fn child_count(&self) -> usize {
        1
    }

    /// `b2Shape.prototype.TestPoint(xf, p)`.
    pub fn test_point(&self, xf: &Transform, p: Vec2) -> bool {
        match self {
            Shape::Circle(c) => {
                let e = xf.r;
                let n = xf.position.x + (e.col1.x * c.p.x + e.col2.x * c.p.y);
                let s = xf.position.y + (e.col1.y * c.p.x + e.col2.y * c.p.y);
                let dx = p.x - n;
                let dy = p.y - s;
                dx * dx + dy * dy <= c.radius * c.radius
            }
            Shape::Polygon(poly) => poly.test_point(xf, p),
        }
    }

    /// `b2Shape.prototype.RayCast(output, input, xf)`.
    pub fn ray_cast(&self, output: &mut RayCastOutput, input: &RayCastInput, xf: &Transform) -> bool {
        match self {
            Shape::Circle(c) => circle_ray_cast(c, output, input, xf),
            Shape::Polygon(poly) => poly.ray_cast(output, input, xf),
        }
    }

    /// `b2Shape.prototype.ComputeAABB(aabb, xf)`.
    pub fn compute_aabb(&self, aabb: &mut AABB, xf: &Transform) {
        match self {
            Shape::Circle(c) => {
                let e = xf.r;
                let n = xf.position.x + (e.col1.x * c.p.x + e.col2.x * c.p.y);
                let s = xf.position.y + (e.col1.y * c.p.x + e.col2.y * c.p.y);
                aabb.lower_bound = Vec2::new(n - c.radius, s - c.radius);
                aabb.upper_bound = Vec2::new(n + c.radius, s + c.radius);
            }
            Shape::Polygon(poly) => poly.compute_aabb(aabb, xf),
        }
    }

    /// `b2Shape.prototype.ComputeMass(massData, density)`.
    pub fn compute_mass(&self, density: f64) -> MassData {
        match self {
            Shape::Circle(c) => {
                let mass = density * B2_PI * c.radius * c.radius;
                let i = mass
                    * (0.5 * c.radius * c.radius + (c.p.x * c.p.x + c.p.y * c.p.y));
                MassData {
                    mass,
                    center: c.p,
                    i,
                }
            }
            Shape::Polygon(poly) => poly.compute_mass(density),
        }
    }
}

/// `b2CircleShape.prototype.RayCast`.
fn circle_ray_cast(c: &CircleShape, output: &mut RayCastOutput, input: &RayCastInput, xf: &Transform) -> bool {
    let n = xf.r;
    let s = xf.position.x + (n.col1.x * c.p.x + n.col2.x * c.p.y);
    let r = xf.position.y + (n.col1.y * c.p.x + n.col2.y * c.p.y);
    let a = input.p1.x - s;
    let l = input.p1.y - r;
    let m = a * a + l * l - c.radius * c.radius;
    let cc = input.p2.x - input.p1.x;
    let h = input.p2.y - input.p1.y;
    let p = a * cc + l * h;
    let y = cc * cc + h * h;
    let u = p * p - y * m;
    if u < 0.0 || y < MIN_VALUE {
        return false;
    }
    let mut x = -(p + u.sqrt());
    if 0.0 <= x && x <= input.max_fraction * y {
        x /= y;
        output.fraction = x;
        output.normal = Vec2::new(a + x * cc, l + x * h);
        output.normal.normalize();
        true
    } else {
        false
    }
}
