//! Port of `Box2D.Collision.b2Distance` (GJK), `b2DistanceProxy`, `b2SimplexCache`,
//! `b2DistanceInput`, `b2DistanceOutput`, `b2SimplexVertex` and `b2Simplex`.
//! Operation order follows the archived JavaScript exactly. Stats counters
//! (`b2_gjkCalls`, `b2_gjkIters`, `b2_gjkMaxIters`) are not ported.

use crate::collision::shapes::Shape;
use crate::common::math::{
    MIN_VALUE, Transform, Vec2, cross_fv, cross_vf, cross_vv, dot, mul_tmv, mul_x, subtract_vv,
};

/// `b2DistanceProxy`: convex point cloud used by GJK and TOI. Like the JS,
/// it refers to the shape's own vertex array (polygons may have more than
/// `b2_maxPolygonVertices` vertices in maps the original accepts).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DistanceProxy<'a> {
    pub vertices: &'a [Vec2],
    pub count: usize,
    pub radius: f64,
}

impl<'a> DistanceProxy<'a> {
    /// `b2DistanceProxy.prototype.Set(shape)`. Circles contribute their local
    /// center as the single vertex; polygons their first `vertex_count`
    /// vertices.
    pub fn new(shape: &'a Shape) -> Self {
        match shape {
            Shape::Circle(c) => DistanceProxy { vertices: std::slice::from_ref(&c.p), count: 1, radius: c.radius },
            Shape::Polygon(p) => DistanceProxy { vertices: &p.vertices, count: p.vertex_count, radius: p.radius },
        }
    }

    /// `b2DistanceProxy.prototype.GetSupport(d)`: index of the vertex with the
    /// largest dot product with `d` (first index wins ties).
    pub fn get_support(&self, d: Vec2) -> usize {
        let mut best = 0usize;
        let mut best_value = self.vertices[0].x * d.x + self.vertices[0].y * d.y;
        for n in 1..self.count {
            let value = self.vertices[n].x * d.x + self.vertices[n].y * d.y;
            if value > best_value {
                best = n;
                best_value = value;
            }
        }
        best
    }

    /// `b2DistanceProxy.prototype.GetSupportVertex(d)`.
    pub fn get_support_vertex(&self, d: Vec2) -> Vec2 {
        self.vertices[self.get_support(d)]
    }

    /// `b2DistanceProxy.prototype.GetVertexCount()`.
    pub fn get_vertex_count(&self) -> usize {
        self.count
    }

    /// `b2DistanceProxy.prototype.GetVertex(index)`.
    pub fn get_vertex(&self, index: usize) -> Vec2 {
        self.vertices[index]
    }
}

/// `b2SimplexCache`: warm-start data carried between GJK calls.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct SimplexCache {
    pub metric: f64,
    pub count: usize,
    pub index_a: [usize; 3],
    pub index_b: [usize; 3],
}

/// `b2DistanceInput`.
#[derive(Clone, Copy, Debug)]
pub struct DistanceInput<'a> {
    pub proxy_a: &'a DistanceProxy<'a>,
    pub proxy_b: &'a DistanceProxy<'a>,
    pub transform_a: &'a Transform,
    pub transform_b: &'a Transform,
    pub use_radii: bool,
}

/// `b2DistanceOutput`.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct DistanceOutput {
    pub point_a: Vec2,
    pub point_b: Vec2,
    pub distance: f64,
    pub iterations: usize,
}

/// `b2SimplexVertex`.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct SimplexVertex {
    pub w_a: Vec2,
    pub w_b: Vec2,
    pub w: Vec2,
    pub a: f64,
    pub index_a: usize,
    pub index_b: usize,
}

/// `b2Simplex`. The JS `m_v1/m_v2/m_v3` objects are the three elements of `v`;
/// JS `m_vX.Set(m_vY)` is a whole-struct copy here.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Simplex {
    pub v: [SimplexVertex; 3],
    pub count: usize,
}

impl Simplex {
    /// `b2Simplex.prototype.ReadCache`.
    pub fn read_cache(
        &mut self,
        cache: &SimplexCache,
        proxy_a: &DistanceProxy,
        xf_a: &Transform,
        proxy_b: &DistanceProxy,
        xf_b: &Transform,
    ) {
        self.count = cache.count;
        for h in 0..self.count {
            let p = &mut self.v[h];
            p.index_a = cache.index_a[h];
            p.index_b = cache.index_b[h];
            let l = proxy_a.get_vertex(p.index_a);
            let m = proxy_b.get_vertex(p.index_b);
            p.w_a = mul_x(xf_a, l);
            p.w_b = mul_x(xf_b, m);
            p.w = subtract_vv(p.w_b, p.w_a);
            p.a = 0.0;
        }
        if self.count > 1 {
            let y = cache.metric;
            let u = self.get_metric();
            if u < 0.5 * y || 2.0 * y < u || u < MIN_VALUE {
                self.count = 0;
            }
        }
        if self.count == 0 {
            let p = &mut self.v[0];
            p.index_a = 0;
            p.index_b = 0;
            let l = proxy_a.get_vertex(0);
            let m = proxy_b.get_vertex(0);
            p.w_a = mul_x(xf_a, l);
            p.w_b = mul_x(xf_b, m);
            p.w = subtract_vv(p.w_b, p.w_a);
            self.count = 1;
        }
    }

    /// `b2Simplex.prototype.WriteCache`.
    pub fn write_cache(&self, cache: &mut SimplexCache) {
        cache.metric = self.get_metric();
        cache.count = self.count;
        for e in 0..self.count {
            cache.index_a[e] = self.v[e].index_a;
            cache.index_b[e] = self.v[e].index_b;
        }
    }

    /// `b2Simplex.prototype.GetSearchDirection`.
    pub fn get_search_direction(&self) -> Vec2 {
        match self.count {
            1 => self.v[0].w.get_negative(),
            2 => {
                let t = subtract_vv(self.v[1].w, self.v[0].w);
                if cross_vv(t, self.v[0].w.get_negative()) > 0.0 {
                    cross_fv(1.0, t)
                } else {
                    cross_vf(t, 1.0)
                }
            }
            _ => Vec2::default(),
        }
    }

    /// `b2Simplex.prototype.GetWitnessPoints(pA, pB)`.
    pub fn get_witness_points(&self, point_a: &mut Vec2, point_b: &mut Vec2) {
        match self.count {
            1 => {
                *point_a = self.v[0].w_a;
                *point_b = self.v[0].w_b;
            }
            2 => {
                point_a.x = self.v[0].a * self.v[0].w_a.x + self.v[1].a * self.v[1].w_a.x;
                point_a.y = self.v[0].a * self.v[0].w_a.y + self.v[1].a * self.v[1].w_a.y;
                point_b.x = self.v[0].a * self.v[0].w_b.x + self.v[1].a * self.v[1].w_b.x;
                point_b.y = self.v[0].a * self.v[0].w_b.y + self.v[1].a * self.v[1].w_b.y;
            }
            3 => {
                let x = self.v[0].a * self.v[0].w_a.x
                    + self.v[1].a * self.v[1].w_a.x
                    + self.v[2].a * self.v[2].w_a.x;
                let y = self.v[0].a * self.v[0].w_a.y
                    + self.v[1].a * self.v[1].w_a.y
                    + self.v[2].a * self.v[2].w_a.y;
                point_a.x = x;
                point_b.x = x;
                point_a.y = y;
                point_b.y = y;
            }
            _ => {}
        }
    }

    /// `b2Simplex.prototype.GetMetric`.
    pub fn get_metric(&self) -> f64 {
        match self.count {
            2 => subtract_vv(self.v[0].w, self.v[1].w).length(),
            3 => cross_vv(
                subtract_vv(self.v[1].w, self.v[0].w),
                subtract_vv(self.v[2].w, self.v[0].w),
            ),
            _ => 0.0,
        }
    }

    /// `b2Simplex.prototype.Solve2`.
    pub fn solve2(&mut self) {
        let w1 = self.v[0].w;
        let w2 = self.v[1].w;
        let e = subtract_vv(w2, w1);
        let n = -(w1.x * e.x + w1.y * e.y);
        if n <= 0.0 {
            self.v[0].a = 1.0;
            self.count = 1;
            return;
        }
        let r = w2.x * e.x + w2.y * e.y;
        if r <= 0.0 {
            self.v[1].a = 1.0;
            self.count = 1;
            self.v[0] = self.v[1];
            return;
        }
        let a = 1.0 / (r + n);
        self.v[0].a = r * a;
        self.v[1].a = n * a;
        self.count = 2;
    }

    /// `b2Simplex.prototype.Solve3`.
    pub fn solve3(&mut self) {
        let w1 = self.v[0].w;
        let w2 = self.v[1].w;
        let w3 = self.v[2].w;
        // Edge 1-2.
        let e12 = subtract_vv(w2, w1);
        let dot12_1 = dot(w1, e12);
        let dot12_2 = dot(w2, e12);
        let neg_dot12_1 = -dot12_1;
        // Edge 1-3.
        let e13 = subtract_vv(w3, w1);
        let dot13_1 = dot(w1, e13);
        let dot13_3 = dot(w3, e13);
        let neg_dot13_1 = -dot13_1;
        // Edge 2-3.
        let e23 = subtract_vv(w3, w2);
        let dot23_2 = dot(w2, e23);
        let dot23_3 = dot(w3, e23);
        let neg_dot23_2 = -dot23_2;
        // Triangle.
        let f = cross_vv(e12, e13);
        let c_23 = f * cross_vv(w2, w3);
        let c_31 = f * cross_vv(w3, w1);
        let c_12 = f * cross_vv(w1, w2);

        if neg_dot12_1 <= 0.0 && neg_dot13_1 <= 0.0 {
            self.v[0].a = 1.0;
            self.count = 1;
            return;
        }
        if dot12_2 > 0.0 && neg_dot12_1 > 0.0 && c_12 <= 0.0 {
            let v = 1.0 / (dot12_2 + neg_dot12_1);
            self.v[0].a = dot12_2 * v;
            self.v[1].a = neg_dot12_1 * v;
            self.count = 2;
            return;
        }
        if dot13_3 > 0.0 && neg_dot13_1 > 0.0 && c_31 <= 0.0 {
            let v = 1.0 / (dot13_3 + neg_dot13_1);
            self.v[0].a = dot13_3 * v;
            self.v[2].a = neg_dot13_1 * v;
            self.count = 2;
            self.v[1] = self.v[2];
            return;
        }
        if dot12_2 <= 0.0 && neg_dot23_2 <= 0.0 {
            self.v[1].a = 1.0;
            self.count = 1;
            self.v[0] = self.v[1];
            return;
        }
        if dot13_3 <= 0.0 && dot23_3 <= 0.0 {
            self.v[2].a = 1.0;
            self.count = 1;
            self.v[0] = self.v[2];
            return;
        }
        if dot23_3 > 0.0 && neg_dot23_2 > 0.0 && c_23 <= 0.0 {
            let v = 1.0 / (dot23_3 + neg_dot23_2);
            self.v[1].a = dot23_3 * v;
            self.v[2].a = neg_dot23_2 * v;
            self.count = 2;
            self.v[0] = self.v[2];
            return;
        }
        let v = 1.0 / (c_23 + c_31 + c_12);
        self.v[0].a = c_23 * v;
        self.v[1].a = c_31 * v;
        self.v[2].a = c_12 * v;
        self.count = 3;
    }
}

/// `b2Distance`: GJK closest points between two proxies.
pub fn distance(output: &mut DistanceOutput, cache: &mut SimplexCache, input: &DistanceInput<'_>) {
    let proxy_a = input.proxy_a;
    let proxy_b = input.proxy_b;
    let xf_a = input.transform_a;
    let xf_b = input.transform_b;

    let mut simplex = Simplex::default();
    simplex.read_cache(cache, proxy_a, xf_a, proxy_b, xf_b);

    let mut save_a = [0usize; 3];
    let mut save_b = [0usize; 3];
    let mut iter = 0usize;
    while iter < 20 {
        let saved = simplex.count;
        for d in 0..saved {
            save_a[d] = simplex.v[d].index_a;
            save_b[d] = simplex.v[d].index_b;
        }
        match simplex.count {
            2 => simplex.solve2(),
            3 => simplex.solve3(),
            _ => {}
        }
        if simplex.count == 3 {
            break;
        }
        let search = simplex.get_search_direction();
        if search.length_squared() < MIN_VALUE * MIN_VALUE {
            break;
        }
        let idx = simplex.count;
        let index_a = proxy_a.get_support(mul_tmv(&xf_a.r, search.get_negative()));
        let w_a = mul_x(xf_a, proxy_a.get_vertex(index_a));
        let index_b = proxy_b.get_support(mul_tmv(&xf_b.r, search));
        let w_b = mul_x(xf_b, proxy_b.get_vertex(index_b));
        let c = &mut simplex.v[idx];
        c.index_a = index_a;
        c.w_a = w_a;
        c.index_b = index_b;
        c.w_b = w_b;
        c.w = subtract_vv(w_b, w_a);
        iter += 1;

        let mut duplicate = false;
        for d in 0..saved {
            if index_a == save_a[d] && index_b == save_b[d] {
                duplicate = true;
                break;
            }
        }
        if duplicate {
            break;
        }
        simplex.count += 1;
    }

    simplex.get_witness_points(&mut output.point_a, &mut output.point_b);
    output.distance = subtract_vv(output.point_a, output.point_b).length();
    output.iterations = iter;
    simplex.write_cache(cache);

    if input.use_radii {
        let ra = proxy_a.radius;
        let rb = proxy_b.radius;
        if output.distance > ra + rb && output.distance > MIN_VALUE {
            output.distance -= ra + rb;
            let mut g = subtract_vv(output.point_b, output.point_a);
            g.normalize();
            output.point_a.x += ra * g.x;
            output.point_a.y += ra * g.y;
            output.point_b.x -= rb * g.x;
            output.point_b.y -= rb * g.y;
        } else {
            let mid_x = 0.5 * (output.point_a.x + output.point_b.x);
            let mid_y = 0.5 * (output.point_a.y + output.point_b.y);
            output.point_a.x = mid_x;
            output.point_b.x = mid_x;
            output.point_a.y = mid_y;
            output.point_b.y = mid_y;
            output.distance = 0.0;
        }
    }
}
