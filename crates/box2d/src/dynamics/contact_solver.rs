//! `b2ContactSolver`: sequential-impulse solver for the touching contacts of
//! an island. Velocities and sweeps live on the bodies in the store; each
//! constraint copies the bodies' state into locals, mirroring box2dweb's
//! in-place updates.

use crate::collision::manifold::{ManifoldType, WorldManifold};
use crate::common::math::{Mat22, MIN_VALUE, Vec2, clamp, max_f, min_f};
use crate::common::settings::{
    LINEAR_SLOP, MAX_LINEAR_CORRECTION, MAX_MANIFOLD_POINTS, VELOCITY_THRESHOLD,
};
use crate::dynamics::TimeStep;
use crate::dynamics::store::Store;
use crate::ids::{BodyId, ContactId};

/// `b2ContactConstraintPoint`.
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct ContactConstraintPoint {
    pub(crate) local_point: Vec2,
    pub(crate) r_a: Vec2,
    pub(crate) r_b: Vec2,
    pub(crate) normal_impulse: f64,
    pub(crate) tangent_impulse: f64,
    pub(crate) normal_mass: f64,
    pub(crate) equalized_mass: f64,
    pub(crate) tangent_mass: f64,
    pub(crate) velocity_bias: f64,
}

/// `b2ContactConstraint`.
#[derive(Clone, Copy, Debug)]
pub(crate) struct ContactConstraint {
    pub(crate) body_a: BodyId,
    pub(crate) body_b: BodyId,
    pub(crate) contact: ContactId,
    pub(crate) normal: Vec2,
    pub(crate) normal_mass: Mat22,
    pub(crate) k: Mat22,
    pub(crate) local_plane_normal: Vec2,
    pub(crate) local_point: Vec2,
    pub(crate) friction: f64,
    pub(crate) restitution: f64,
    pub(crate) radius: f64,
    pub(crate) point_count: usize,
    pub(crate) points: [ContactConstraintPoint; MAX_MANIFOLD_POINTS],
    pub(crate) manifold_type: Option<ManifoldType>,
}

/// `b2ContactSolver`. Constraints are rebuilt each step into a reused `Vec`.
#[derive(Debug, Default)]
pub struct ContactSolver {
    pub(crate) constraints: Vec<ContactConstraint>,
}

/// `b2MixRestitution`.
fn mix_restitution(t: f64, o: f64) -> f64 {
    if t < 0.0 || o < 0.0 {
        max_f(0.0, o + t)
    } else if t > o {
        t
    } else {
        o
    }
}

/// `b2PositionSolverManifold`: world-space normal, points and separations.
#[derive(Clone, Copy, Debug, Default)]
struct PositionSolverManifold {
    normal: Vec2,
    points: [Vec2; MAX_MANIFOLD_POINTS],
    separations: [f64; MAX_MANIFOLD_POINTS],
}

fn position_solver_manifold(cc: &ContactConstraint, store: &Store) -> PositionSolverManifold {
    let mut out = PositionSolverManifold::default();
    let xa = store.body(cc.body_a).xf;
    let xb = store.body(cc.body_b).xf;
    let ra = xa.r;
    let rb = xb.r;
    match cc.manifold_type {
        Some(ManifoldType::Circles) => {
            let lp = cc.local_point;
            let m = xa.position.x + (ra.col1.x * lp.x + ra.col2.x * lp.y);
            let c = xa.position.y + (ra.col1.y * lp.x + ra.col2.y * lp.y);
            let e = cc.points[0].local_point;
            let h = xb.position.x + (rb.col1.x * e.x + rb.col2.x * e.y);
            let p = xb.position.y + (rb.col1.y * e.x + rb.col2.y * e.y);
            let y = h - m;
            let u = p - c;
            let x = y * y + u * u;
            if x > MIN_VALUE * MIN_VALUE {
                let len = x.sqrt();
                out.normal.x = y / len;
                out.normal.y = u / len;
            } else {
                out.normal.x = 1.0;
                out.normal.y = 0.0;
            }
            out.points[0] = Vec2 {
                x: 0.5 * (m + h),
                y: 0.5 * (c + p),
            };
            out.separations[0] = y * out.normal.x + u * out.normal.y - cc.radius;
        }
        Some(ManifoldType::FaceA) => {
            let lpn = cc.local_plane_normal;
            out.normal = Vec2 {
                x: ra.col1.x * lpn.x + ra.col2.x * lpn.y,
                y: ra.col1.y * lpn.x + ra.col2.y * lpn.y,
            };
            let lp = cc.local_point;
            let a = xa.position.x + (ra.col1.x * lp.x + ra.col2.x * lp.y);
            let l = xa.position.y + (ra.col1.y * lp.x + ra.col2.y * lp.y);
            for n in 0..cc.point_count {
                let e = cc.points[n].local_point;
                let s = xb.position.x + (rb.col1.x * e.x + rb.col2.x * e.y);
                let r = xb.position.y + (rb.col1.y * e.x + rb.col2.y * e.y);
                out.separations[n] = (s - a) * out.normal.x + (r - l) * out.normal.y - cc.radius;
                out.points[n] = Vec2 { x: s, y: r };
            }
        }
        Some(ManifoldType::FaceB) => {
            let lpn = cc.local_plane_normal;
            out.normal = Vec2 {
                x: rb.col1.x * lpn.x + rb.col2.x * lpn.y,
                y: rb.col1.y * lpn.x + rb.col2.y * lpn.y,
            };
            let lp = cc.local_point;
            let a = xb.position.x + (rb.col1.x * lp.x + rb.col2.x * lp.y);
            let l = xb.position.y + (rb.col1.y * lp.x + rb.col2.y * lp.y);
            for n in 0..cc.point_count {
                let e = cc.points[n].local_point;
                let s = xa.position.x + (ra.col1.x * e.x + ra.col2.x * e.y);
                let r = xa.position.y + (ra.col1.y * e.x + ra.col2.y * e.y);
                out.separations[n] = (s - a) * out.normal.x + (r - l) * out.normal.y - cc.radius;
                out.points[n] = Vec2 { x: s, y: r };
            }
            out.normal.x *= -1.0;
            out.normal.y *= -1.0;
        }
        None => {}
    }
    out
}

impl ContactSolver {
    pub fn new() -> Self {
        Self::default()
    }

    /// `b2ContactSolver.Initialize`: builds one constraint per contact.
    pub fn initialize(&mut self, store: &Store, contacts: &[ContactId]) {
        self.constraints.clear();
        for &cid in contacts {
            let c = store.contact(cid);
            let manifold = &c.manifold;
            let fa = store.fixture(c.fixture_a);
            let fb = store.fixture(c.fixture_b);
            let ba = store.body(fa.body);
            let bb = store.body(fb.body);
            let radius_a = fa.shape.radius();
            let radius_b = fb.shape.radius();

            let mut wm = WorldManifold::default();
            wm.initialize(manifold, &ba.xf, radius_a, &bb.xf, radius_b);
            let normal = wm.normal;
            let (nx, ny) = (normal.x, normal.y);

            let mut cc = ContactConstraint {
                body_a: fa.body,
                body_b: fb.body,
                contact: cid,
                normal,
                normal_mass: Mat22::default(),
                k: Mat22::default(),
                local_plane_normal: manifold.local_normal,
                local_point: manifold.local_point,
                friction: (fa.friction * fb.friction).sqrt(),
                restitution: mix_restitution(fa.restitution, fb.restitution),
                radius: radius_a + radius_b,
                point_count: manifold.point_count,
                points: [ContactConstraintPoint::default(); MAX_MANIFOLD_POINTS],
                manifold_type: manifold.manifold_type,
            };
            let restitution = cc.restitution;

            let (ma, ia) = (ba.mass, ba.inv_i);
            let (ima, mb, ib) = (ba.inv_mass, bb.mass, bb.inv_i);
            let imb = bb.inv_mass;
            let va = ba.linear_velocity;
            let vb = bb.linear_velocity;
            let wa = ba.angular_velocity;
            let wb = bb.angular_velocity;

            for m in 0..cc.point_count {
                let mp = manifold.points[m];
                let wp = wm.points[m];
                let p = &mut cc.points[m];
                p.normal_impulse = mp.normal_impulse;
                p.tangent_impulse = mp.tangent_impulse;
                p.local_point = mp.local_point;

                let r_a = Vec2 {
                    x: wp.x - ba.sweep.c.x,
                    y: wp.y - ba.sweep.c.y,
                };
                let r_b = Vec2 {
                    x: wp.x - bb.sweep.c.x,
                    y: wp.y - bb.sweep.c.y,
                };
                p.r_a = r_a;
                p.r_b = r_b;

                let rn_a = r_a.x * ny - r_a.y * nx;
                let rn_b = r_b.x * ny - r_b.y * nx;
                let t = rn_a * rn_a;
                let r = rn_b * rn_b;
                let k = ima + imb + ia * t + ib * r;
                p.normal_mass = 1.0 / k;

                let mut z = ma * ima + mb * imb;
                z += ma * ia * t + mb * ib * r;
                p.equalized_mass = 1.0 / z;

                let tan_y = ny;
                let tan_x = -nx;
                let o = r_a.x * tan_x - r_a.y * tan_y;
                let j = r_b.x * tan_x - r_b.y * tan_y;
                let o = o * o;
                let j = j * j;
                let u = ima + imb + ia * o + ib * j;
                p.tangent_mass = 1.0 / u;
                p.velocity_bias = 0.0;

                let q = vb.x + -wb * r_b.y - va.x - -wa * r_a.y;
                let kv = vb.y + wb * r_b.x - va.y - wa * r_a.x;
                let w = nx * q + ny * kv;
                if w < -VELOCITY_THRESHOLD {
                    p.velocity_bias += -restitution * w;
                }
            }

            if cc.point_count == 2 {
                let p0 = cc.points[0];
                let p1 = cc.points[1];
                let to = p0.r_a.x * ny - p0.r_a.y * nx;
                let ti = p0.r_b.x * ny - p0.r_b.y * nx;
                let te = p1.r_a.x * ny - p1.r_a.y * nx;
                let tn = p1.r_b.x * ny - p1.r_b.y * nx;
                let ts = ima + imb + ia * to * to + ib * ti * ti;
                let tr = ima + imb + ia * te * te + ib * tn * tn;
                let ta = ima + imb + ia * to * te + ib * ti * tn;
                if ts * ts < 100.0 * (ts * tr - ta * ta) {
                    cc.k.col1.set(ts, ta);
                    cc.k.col2.set(ta, tr);
                    cc.k.get_inverse(&mut cc.normal_mass);
                } else {
                    cc.point_count = 1;
                }
            }
            self.constraints.push(cc);
        }
    }

    /// `b2ContactSolver.InitVelocityConstraints`: warm starts or zeroes impulses.
    pub fn init_velocity_constraints(&mut self, store: &mut Store, step: &TimeStep) {
        for cc in &mut self.constraints {
            let ima = store.body(cc.body_a).inv_mass;
            let ia = store.body(cc.body_a).inv_i;
            let imb = store.body(cc.body_b).inv_mass;
            let ib = store.body(cc.body_b).inv_i;
            let n = cc.point_count;
            let c = cc.normal.x;
            let h = cc.normal.y;
            let p = h;
            let y = -c;
            if step.warm_starting {
                for pt in &mut cc.points[..n] {
                    pt.normal_impulse *= step.dt_ratio;
                    pt.tangent_impulse *= step.dt_ratio;
                    let f = pt.normal_impulse * c + pt.tangent_impulse * p;
                    let d = pt.normal_impulse * h + pt.tangent_impulse * y;
                    let a = store.body_mut(cc.body_a);
                    a.angular_velocity -= ia * (pt.r_a.x * d - pt.r_a.y * f);
                    a.linear_velocity.x -= ima * f;
                    a.linear_velocity.y -= ima * d;
                    let b = store.body_mut(cc.body_b);
                    b.angular_velocity += ib * (pt.r_b.x * d - pt.r_b.y * f);
                    b.linear_velocity.x += imb * f;
                    b.linear_velocity.y += imb * d;
                }
            } else {
                for pt in &mut cc.points[..n] {
                    pt.normal_impulse = 0.0;
                    pt.tangent_impulse = 0.0;
                }
            }
        }
    }

    /// `b2ContactSolver.SolveVelocityConstraints`: friction then normal, with the
    /// two-point block solver when both points are active.
    pub fn solve_velocity_constraints(&mut self, store: &mut Store) {
        for cc in &mut self.constraints {
            let (mut wa, mut va, ima, ia) = {
                let b = store.body(cc.body_a);
                (b.angular_velocity, b.linear_velocity, b.inv_mass, b.inv_i)
            };
            let (mut wb, mut vb, imb, ib) = {
                let b = store.body(cc.body_b);
                (b.angular_velocity, b.linear_velocity, b.inv_mass, b.inv_i)
            };
            let gx = cc.normal.x;
            let ny = cc.normal.y;
            let fx = -gx;
            let friction = cc.friction;
            let n = cc.point_count;

            for pt in cc.points[..n].iter_mut() {
                let n_ = vb.x - wb * pt.r_b.y - va.x + wa * pt.r_a.y;
                let s_ = vb.y + wb * pt.r_b.x - va.y - wa * pt.r_a.x;
                let a_ = n_ * ny + s_ * fx;
                let mut l = -(pt.tangent_mass * a_);
                let m = friction * pt.normal_impulse;
                let c = clamp(pt.tangent_impulse + l, -m, m);
                l = c - pt.tangent_impulse;
                let h = l * ny;
                let p = l * fx;
                va.x -= ima * h;
                va.y -= ima * p;
                wa -= ia * (pt.r_a.x * p - pt.r_a.y * h);
                vb.x += imb * h;
                vb.y += imb * p;
                wb += ib * (pt.r_b.x * p - pt.r_b.y * h);
                pt.tangent_impulse = c;
            }

            if n == 1 {
                let pt = &mut cc.points[0];
                let n_ = vb.x + -wb * pt.r_b.y - va.x - -wa * pt.r_a.y;
                let s_ = vb.y + wb * pt.r_b.x - va.y - wa * pt.r_a.x;
                let r_ = n_ * gx + s_ * ny;
                let mut l = -pt.normal_mass * (r_ - pt.velocity_bias);
                let c = {
                    let v = pt.normal_impulse + l;
                    if v > 0.0 { v } else { 0.0 }
                };
                l = c - pt.normal_impulse;
                let h = l * gx;
                let p = l * ny;
                va.x -= ima * h;
                va.y -= ima * p;
                wa -= ia * (pt.r_a.x * p - pt.r_a.y * h);
                vb.x += imb * h;
                vb.y += imb * p;
                wb += ib * (pt.r_b.x * p - pt.r_b.y * h);
                pt.normal_impulse = c;
            } else {
                let [t, r] = &mut cc.points;
                let k_imp = t.normal_impulse;
                let z_imp = r.normal_impulse;
                let e_ = vb.x - wb * t.r_b.y - va.x + wa * t.r_a.y;
                let n2 = vb.y + wb * t.r_b.x - va.y - wa * t.r_a.x;
                let o_ = vb.x - wb * r.r_b.y - va.x + wa * r.r_a.y;
                let j_ = vb.y + wb * r.r_b.x - va.y - wa * r.r_a.x;
                let u_ = e_ * gx + n2 * ny;
                let q_ = o_ * gx + j_ * ny;
                let mut kk = u_ - t.velocity_bias;
                let mut ww = q_ - r.velocity_bias;
                kk -= cc.k.col1.x * k_imp + cc.k.col2.x * z_imp;
                ww -= cc.k.col1.y * k_imp + cc.k.col2.y * z_imp;

                let nm = cc.normal_mass;
                let x0 = -(nm.col1.x * kk + nm.col2.x * ww);
                let z0 = -(nm.col1.y * kk + nm.col2.y * ww);
                let sol = if x0 >= 0.0 && z0 >= 0.0 {
                    Some((x0, z0))
                } else {
                    let x1 = -t.normal_mass * kk;
                    let q1 = cc.k.col1.y * x1 + ww;
                    if x1 >= 0.0 && q1 >= 0.0 {
                        Some((x1, 0.0))
                    } else {
                        let z2 = -r.normal_mass * ww;
                        let u2 = cc.k.col2.x * z2 + kk;
                        if z2 >= 0.0 && u2 >= 0.0 {
                            Some((0.0, z2))
                        } else if kk >= 0.0 && ww >= 0.0 {
                            Some((0.0, 0.0))
                        } else {
                            None
                        }
                    }
                };

                if let Some((x, z)) = sol {
                    let dy = x - k_imp;
                    let du = z - z_imp;
                    let xx = dy * gx;
                    let yy = dy * ny;
                    let ff = du * gx;
                    let dd = du * ny;
                    va.x -= ima * (xx + ff);
                    va.y -= ima * (yy + dd);
                    wa -= ia * (t.r_a.x * yy - t.r_a.y * xx + r.r_a.x * dd - r.r_a.y * ff);
                    vb.x += imb * (xx + ff);
                    vb.y += imb * (yy + dd);
                    wb += ib * (t.r_b.x * yy - t.r_b.y * xx + r.r_b.x * dd - r.r_b.y * ff);
                    t.normal_impulse = x;
                    r.normal_impulse = z;
                }
            }

            {
                let a = store.body_mut(cc.body_a);
                a.angular_velocity = wa;
                a.linear_velocity = va;
            }
            {
                let b = store.body_mut(cc.body_b);
                b.angular_velocity = wb;
                b.linear_velocity = vb;
            }
        }
    }

    /// `b2ContactSolver.FinalizeVelocityConstraints`: copies impulses back to the manifolds.
    pub fn finalize_velocity_constraints(&mut self, store: &mut Store) {
        for cc in &self.constraints {
            let c = store.contact_mut(cc.contact);
            for n in 0..cc.point_count {
                c.manifold.points[n].normal_impulse = cc.points[n].normal_impulse;
                c.manifold.points[n].tangent_impulse = cc.points[n].tangent_impulse;
            }
        }
    }

    /// `b2ContactSolver.SolvePositionConstraints`: returns true when every
    /// separation is within `-1.5 * LINEAR_SLOP`.
    pub fn solve_position_constraints(&mut self, store: &mut Store, baumgarte: f64) -> bool {
        let mut min_sep = 0.0;
        for cc in &self.constraints {
            let (ka, kla) = {
                let b = store.body(cc.body_a);
                (b.mass * b.inv_mass, b.mass * b.inv_i)
            };
            let (kb, klb) = {
                let b = store.body(cc.body_b);
                (b.mass * b.inv_mass, b.mass * b.inv_i)
            };
            let psm = position_solver_manifold(cc, store);
            for p in 0..cc.point_count {
                let u = cc.points[p];
                let x = psm.points[p];
                let sep = psm.separations[p];
                let sa = store.body(cc.body_a).sweep.c;
                let sb = store.body(cc.body_b).sweep.c;
                let f = x.x - sa.x;
                let d = x.y - sa.y;
                let b = x.x - sb.x;
                let dd = x.y - sb.y;

                min_sep = min_f(min_sep, sep);
                let v = clamp(
                    baumgarte * (sep + LINEAR_SLOP),
                    -MAX_LINEAR_CORRECTION,
                    0.0,
                );
                let impulse = -u.equalized_mass * v;
                let ax = impulse * psm.normal.x;
                let ay = impulse * psm.normal.y;

                let ba = store.body_mut(cc.body_a);
                ba.sweep.c.x -= ka * ax;
                ba.sweep.c.y -= ka * ay;
                ba.sweep.a -= kla * (f * ay - d * ax);
                ba.synchronize_transform();

                let bb = store.body_mut(cc.body_b);
                bb.sweep.c.x += kb * ax;
                bb.sweep.c.y += kb * ay;
                bb.sweep.a += klb * (b * ay - dd * ax);
                bb.synchronize_transform();
            }
        }
        min_sep > -1.5 * LINEAR_SLOP
    }
}
