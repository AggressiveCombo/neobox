//! Port of `Box2D.Collision.b2TimeOfImpact`, `b2TOIInput`, `b2TOIOutput` and
//! `b2SeparationFunction`. Operation order follows the archived JavaScript.
//! Stats counters (`b2_toiCalls`, `b2_toiIters`, `b2_toiRootIters`,
//! `b2_toiMaxIters`, `b2_toiMaxRootIters`) are not ported.

use crate::collision::distance::{
    DistanceInput, DistanceOutput, DistanceProxy, SimplexCache, distance,
};
use crate::common::math::{
    MIN_VALUE, Sweep, Transform, Vec2, abs_f, cross_vf, max_f, mul_mv, mul_tmv, mul_x,
    subtract_vv,
};

/// `b2TOIInput`. `tolerance` is the JS `tolerance` field (the caller passes
/// `b2_linearSlop`).
#[derive(Clone, Copy, Debug)]
pub struct TOIInput<'a> {
    pub proxy_a: &'a DistanceProxy<'a>,
    pub proxy_b: &'a DistanceProxy<'a>,
    pub sweep_a: Sweep,
    pub sweep_b: Sweep,
    pub tolerance: f64,
}

/// `b2TOIOutput`. The JS `b2TimeOfImpact` returns a bare number, so the only
/// output is the fraction `t` in `[0, 1]`.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct TOIOutput {
    pub t: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SeparationType {
    Points,
    FaceA,
    FaceB,
}

/// `b2SeparationFunction`.
#[derive(Clone, Copy, Debug)]
pub struct SeparationFunction<'a> {
    proxy_a: &'a DistanceProxy<'a>,
    proxy_b: &'a DistanceProxy<'a>,
    kind: SeparationType,
    local_point: Vec2,
    axis: Vec2,
}

impl<'a> SeparationFunction<'a> {
    /// `b2SeparationFunction.prototype.Initialize(cache, proxyA, xfA, proxyB, xfB)`.
    ///
    /// The JS guard `else if (t.indexA[0] == t.indexA[0])` is always true, so
    /// the segment/segment fall-through branch is unreachable and omitted; the
    /// faceB case is taken whenever `count != 1` and `indexB[0] != indexB[1]`.
    pub fn initialize(
        cache: &SimplexCache,
        proxy_a: &'a DistanceProxy<'a>,
        xf_a: &Transform,
        proxy_b: &'a DistanceProxy<'a>,
        xf_b: &Transform,
    ) -> Self {
        let mut f = SeparationFunction {
            proxy_a,
            proxy_b,
            kind: SeparationType::Points,
            local_point: Vec2::default(),
            axis: Vec2::default(),
        };
        if cache.count == 1 {
            f.kind = SeparationType::Points;
            let m = proxy_a.get_vertex(cache.index_a[0]);
            let p = proxy_b.get_vertex(cache.index_b[0]);
            let d = mul_x(xf_a, m);
            let pw = mul_x(xf_b, p);
            f.axis = Vec2::new(pw.x - d.x, pw.y - d.y);
            f.axis.normalize();
        } else if cache.index_b[0] == cache.index_b[1] {
            // Two points on A and one on B: face normal from A's edge.
            f.kind = SeparationType::FaceA;
            let c = proxy_a.get_vertex(cache.index_a[0]);
            let h = proxy_a.get_vertex(cache.index_a[1]);
            let p = proxy_b.get_vertex(cache.index_b[0]);
            f.local_point = Vec2::new(0.5 * (c.x + h.x), 0.5 * (c.y + h.y));
            f.axis = cross_vf(subtract_vv(h, c), 1.0);
            f.axis.normalize();
            let n = mul_mv(&xf_a.r, f.axis);
            let lp = mul_x(xf_a, f.local_point);
            let pw = mul_x(xf_b, p);
            let dot = (pw.x - lp.x) * n.x + (pw.y - lp.y) * n.y;
            if dot < 0.0 {
                f.axis.negative_self();
            }
        } else {
            // Two points on B and one on A: face normal from B's edge.
            f.kind = SeparationType::FaceB;
            let y = proxy_b.get_vertex(cache.index_b[0]);
            let u = proxy_b.get_vertex(cache.index_b[1]);
            let m = proxy_a.get_vertex(cache.index_a[0]);
            f.local_point = Vec2::new(0.5 * (y.x + u.x), 0.5 * (y.y + u.y));
            f.axis = cross_vf(subtract_vv(u, y), 1.0);
            f.axis.normalize();
            let n = mul_mv(&xf_b.r, f.axis);
            let lp = mul_x(xf_b, f.local_point);
            let pw = mul_x(xf_a, m);
            let dot = (pw.x - lp.x) * n.x + (pw.y - lp.y) * n.y;
            if dot < 0.0 {
                f.axis.negative_self();
            }
        }
        f
    }

    /// `b2SeparationFunction.prototype.Evaluate(xfA, xfB)`.
    pub fn evaluate(&self, xf_a: &Transform, xf_b: &Transform) -> f64 {
        match self.kind {
            SeparationType::Points => {
                let e = mul_tmv(&xf_a.r, self.axis);
                let r = mul_tmv(&xf_b.r, self.axis.get_negative());
                let a = self.proxy_a.get_support_vertex(e);
                let l = self.proxy_b.get_support_vertex(r);
                let m = mul_x(xf_a, a);
                let c = mul_x(xf_b, l);
                (c.x - m.x) * self.axis.x + (c.y - m.y) * self.axis.y
            }
            SeparationType::FaceA => {
                let h = mul_mv(&xf_a.r, self.axis);
                let m = mul_x(xf_a, self.local_point);
                let r = mul_tmv(&xf_b.r, h.get_negative());
                let l = self.proxy_b.get_support_vertex(r);
                let c = mul_x(xf_b, l);
                (c.x - m.x) * h.x + (c.y - m.y) * h.y
            }
            SeparationType::FaceB => {
                let h = mul_mv(&xf_b.r, self.axis);
                let c = mul_x(xf_b, self.local_point);
                let e = mul_tmv(&xf_a.r, h.get_negative());
                let a = self.proxy_a.get_support_vertex(e);
                let m = mul_x(xf_a, a);
                (m.x - c.x) * h.x + (m.y - c.y) * h.y
            }
        }
    }
}

/// `b2TimeOfImpact`: conservative advancement time of impact over `[0, 1]`
/// of the two sweeps (sweeps must share `t0`).
pub fn time_of_impact(output: &mut TOIOutput, input: &TOIInput<'_>) {
    let proxy_a = input.proxy_a;
    let proxy_b = input.proxy_b;
    let sweep_a = input.sweep_a;
    let sweep_b = input.sweep_b;

    let total_radius = proxy_a.radius + proxy_b.radius;
    let tolerance = input.tolerance;
    // `c`: current time; `h`: outer iteration count; `p`: target separation.
    let mut c = 0.0f64;
    let mut h = 0usize;
    let mut p = 0.0f64;

    let mut cache = SimplexCache::default();
    let mut xf_a = Transform::default();
    let mut xf_b = Transform::default();
    let mut dist_out = DistanceOutput::default();

    loop {
        sweep_a.get_transform(&mut xf_a, c);
        sweep_b.get_transform(&mut xf_b, c);
        let dist_in = DistanceInput {
            proxy_a,
            proxy_b,
            transform_a: &xf_a,
            transform_b: &xf_b,
            use_radii: false,
        };
        distance(&mut dist_out, &mut cache, &dist_in);
        if dist_out.distance <= 0.0 {
            c = 1.0;
            break;
        }

        let fcn = SeparationFunction::initialize(&cache, proxy_a, &xf_a, proxy_b, &xf_b);
        let y = fcn.evaluate(&xf_a, &xf_b);
        if y <= 0.0 {
            c = 1.0;
            break;
        }

        if h == 0 {
            p = if y > total_radius {
                max_f(total_radius - tolerance, 0.75 * total_radius)
            } else {
                max_f(y - tolerance, 0.02 * total_radius)
            };
        }
        if y - p < 0.5 * tolerance {
            if h == 0 {
                c = 1.0;
            }
            break;
        }

        // Root finding on [lo, hi] for the separation hitting `p`.
        let mut u = c;
        let mut lo = c;
        let mut hi = 1.0f64;
        let mut s_lo = y;
        sweep_a.get_transform(&mut xf_a, hi);
        sweep_b.get_transform(&mut xf_b, hi);
        let mut s_hi = fcn.evaluate(&xf_a, &xf_b);
        if s_hi >= p {
            c = 1.0;
            break;
        }

        let mut root_iter = 0usize;
        loop {
            let v = if root_iter & 1 == 1 {
                lo + ((p - s_lo) * (hi - lo)) / (s_hi - s_lo)
            } else {
                0.5 * (lo + hi)
            };
            sweep_a.get_transform(&mut xf_a, v);
            sweep_b.get_transform(&mut xf_b, v);
            let s_v = fcn.evaluate(&xf_a, &xf_b);
            if abs_f(s_v - p) < 0.025 * tolerance {
                u = v;
                break;
            }
            if s_v > p {
                lo = v;
                s_lo = s_v;
            } else {
                hi = v;
                s_hi = s_v;
            }
            root_iter += 1;
            if root_iter == 50 {
                break;
            }
        }

        if u < (1.0 + 100.0 * MIN_VALUE) * c {
            break;
        }
        c = u;
        h += 1;
        if h == 1000 {
            break;
        }
    }

    output.t = c;
}
