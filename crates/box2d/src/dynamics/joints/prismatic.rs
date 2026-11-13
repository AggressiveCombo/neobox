//! `b2PrismaticJoint` / `b2PrismaticJointDef` (box2dweb operation order preserved).

use crate::arena::Arena;
use crate::common::math::{Mat22, Mat33, MIN_VALUE, Vec2, Vec3, abs_f, clamp, max_f, min_f, mul_mv};
use crate::common::settings::{ANGULAR_SLOP, LINEAR_SLOP, MAX_LINEAR_CORRECTION};
use crate::dynamics::TimeStep;
use crate::dynamics::body::Body;
use crate::dynamics::joints::{BodyWork, JointBase, LimitState, commit, commit_and_sync, rotate_local};
use crate::dynamics::store::Store;
use crate::ids::BodyId;

/// `b2PrismaticJointDef`. Build with [`PrismaticJointDef::new`] then optionally `initialize`.
#[derive(Clone, Copy, Debug)]
pub struct PrismaticJointDef {
    pub body_a: BodyId,
    pub body_b: BodyId,
    pub local_anchor_a: Vec2,
    pub local_anchor_b: Vec2,
    pub local_axis_a: Vec2,
    pub reference_angle: f64,
    pub enable_limit: bool,
    pub lower_translation: f64,
    pub upper_translation: f64,
    pub enable_motor: bool,
    pub max_motor_force: f64,
    pub motor_speed: f64,
    pub collide_connected: bool,
    pub user_data: u64,
}

/// The JS defaults with both bodies unset (`BodyId(0)`): set them before use.
impl Default for PrismaticJointDef {
    fn default() -> Self {
        Self::new(BodyId(0), BodyId(0))
    }
}

impl PrismaticJointDef {
    /// `new b2PrismaticJointDef()` with the bodies set; axis `(1, 0)`, no limit, no motor.
    pub fn new(body_a: BodyId, body_b: BodyId) -> Self {
        Self {
            body_a,
            body_b,
            local_anchor_a: Vec2::zero(),
            local_anchor_b: Vec2::zero(),
            local_axis_a: Vec2::new(1.0, 0.0),
            reference_angle: 0.0,
            enable_limit: false,
            lower_translation: 0.0,
            upper_translation: 0.0,
            enable_motor: false,
            max_motor_force: 0.0,
            motor_speed: 0.0,
            collide_connected: false,
            user_data: 0,
        }
    }

    /// `b2PrismaticJointDef.Initialize(bodyA, bodyB, anchor, axis)` with a world-space anchor and axis.
    pub fn initialize(&mut self, store: &Store, body_a: BodyId, body_b: BodyId, anchor: Vec2, axis: Vec2) {
        self.body_a = body_a;
        self.body_b = body_b;
        let a = store.body(body_a);
        let b = store.body(body_b);
        self.local_anchor_a = a.get_local_point(anchor);
        self.local_anchor_b = b.get_local_point(anchor);
        self.local_axis_a = a.get_local_vector(axis);
        self.reference_angle = b.get_angle() - a.get_angle();
    }
}

/// `b2PrismaticJoint`.
#[derive(Clone, Debug)]
pub struct PrismaticJoint {
    pub(crate) base: JointBase,
    pub(crate) local_anchor_a: Vec2,
    pub(crate) local_anchor_b: Vec2,
    pub(crate) local_x_axis_a: Vec2,
    pub(crate) local_y_axis_a: Vec2,
    pub(crate) reference_angle: f64,
    pub(crate) impulse: Vec3,
    pub(crate) motor_mass: f64,
    pub(crate) motor_impulse: f64,
    pub(crate) lower_translation: f64,
    pub(crate) upper_translation: f64,
    pub(crate) max_motor_force: f64,
    pub(crate) motor_speed: f64,
    pub(crate) enable_limit: bool,
    pub(crate) enable_motor: bool,
    pub(crate) limit_state: LimitState,
    pub(crate) axis: Vec2,
    pub(crate) perp: Vec2,
    pub(crate) s1: f64,
    pub(crate) s2: f64,
    pub(crate) a1: f64,
    pub(crate) a2: f64,
    pub(crate) k: Mat33,
    pub(crate) local_center_a: Vec2,
    pub(crate) local_center_b: Vec2,
    pub(crate) inv_mass_a: f64,
    pub(crate) inv_mass_b: f64,
    pub(crate) inv_ia: f64,
    pub(crate) inv_ib: f64,
}

impl PrismaticJoint {
    pub(crate) fn new(def: &PrismaticJointDef) -> Self {
        Self {
            base: JointBase {
                body_a: def.body_a,
                body_b: def.body_b,
                collide_connected: def.collide_connected,
                island_flag: false,
                user_data: def.user_data,
            },
            local_anchor_a: def.local_anchor_a,
            local_anchor_b: def.local_anchor_b,
            local_x_axis_a: def.local_axis_a,
            local_y_axis_a: Vec2::new(-def.local_axis_a.y, def.local_axis_a.x),
            reference_angle: def.reference_angle,
            impulse: Vec3::default(),
            motor_mass: 0.0,
            motor_impulse: 0.0,
            lower_translation: def.lower_translation,
            upper_translation: def.upper_translation,
            max_motor_force: def.max_motor_force,
            motor_speed: def.motor_speed,
            enable_limit: def.enable_limit,
            enable_motor: def.enable_motor,
            limit_state: LimitState::Inactive,
            axis: Vec2::zero(),
            perp: Vec2::zero(),
            s1: 0.0,
            s2: 0.0,
            a1: 0.0,
            a2: 0.0,
            k: Mat33::default(),
            local_center_a: Vec2::zero(),
            local_center_b: Vec2::zero(),
            inv_mass_a: 0.0,
            inv_mass_b: 0.0,
            inv_ia: 0.0,
            inv_ib: 0.0,
        }
    }

    pub fn get_anchor_a(&self, store: &Store) -> Vec2 {
        store.body(self.base.body_a).get_world_point(self.local_anchor_a)
    }

    pub fn get_anchor_b(&self, store: &Store) -> Vec2 {
        store.body(self.base.body_b).get_world_point(self.local_anchor_b)
    }

    pub fn get_reaction_force(&self, inv_dt: f64) -> Vec2 {
        let c = self.motor_impulse + self.impulse.z;
        Vec2::new(
            inv_dt * (self.impulse.x * self.perp.x + c * self.axis.x),
            inv_dt * (self.impulse.x * self.perp.y + c * self.axis.y),
        )
    }

    pub fn get_reaction_torque(&self, inv_dt: f64) -> f64 {
        inv_dt * self.impulse.y
    }

    /// `b2PrismaticJoint.GetJointTranslation`: signed translation of B's anchor along A's axis.
    pub fn get_joint_translation(&self, store: &Store) -> f64 {
        let a = store.body(self.base.body_a);
        let b = store.body(self.base.body_b);
        let p1 = a.get_world_point(self.local_anchor_a);
        let p2 = b.get_world_point(self.local_anchor_b);
        let dx = p2.x - p1.x;
        let dy = p2.y - p1.y;
        let axis = a.get_world_vector(self.local_x_axis_a);
        axis.x * dx + axis.y * dy
    }

    /// `b2PrismaticJoint.GetJointSpeed`.
    pub fn get_joint_speed(&self, store: &Store) -> f64 {
        let a = store.body(self.base.body_a);
        let b = store.body(self.base.body_b);

        let ra = a.xf.r;
        let n = self.local_anchor_a.x - a.sweep.local_center.x;
        let s = self.local_anchor_a.y - a.sweep.local_center.y;
        let r = ra.col1.x * n + ra.col2.x * s;
        let s = ra.col1.y * n + ra.col2.y * s;
        let n = r;

        let rb = b.xf.r;
        let aa = self.local_anchor_b.x - b.sweep.local_center.x;
        let l = self.local_anchor_b.y - b.sweep.local_center.y;
        let r = rb.col1.x * aa + rb.col2.x * l;
        let l = rb.col1.y * aa + rb.col2.y * l;
        let aa = r;

        let m = a.sweep.c.x + n;
        let c = a.sweep.c.y + s;
        let h = b.sweep.c.x + aa;
        let p = b.sweep.c.y + l;
        let y = a.get_world_vector(self.local_x_axis_a);
        let u = a.linear_velocity;
        let x = b.linear_velocity;
        let wa = a.angular_velocity;
        let wb = b.angular_velocity;

        (h - m) * (-wa * y.y)
            + (p - c) * (wa * y.x)
            + (y.x * (x.x + -wb * l - u.x - -wa * s) + y.y * (x.y + wb * aa - u.y - wa * n))
    }

    pub fn is_limit_enabled(&self) -> bool {
        self.enable_limit
    }

    pub fn enable_limit(&mut self, flag: bool) {
        self.enable_limit = flag;
    }

    pub fn get_lower_limit(&self) -> f64 {
        self.lower_translation
    }

    pub fn get_upper_limit(&self) -> f64 {
        self.upper_translation
    }

    pub fn set_limits(&mut self, lower: f64, upper: f64) {
        self.lower_translation = lower;
        self.upper_translation = upper;
    }

    pub fn is_motor_enabled(&self) -> bool {
        self.enable_motor
    }

    pub fn enable_motor(&mut self, flag: bool) {
        self.enable_motor = flag;
    }

    pub fn get_motor_speed(&self) -> f64 {
        self.motor_speed
    }

    pub fn set_motor_speed(&mut self, speed: f64) {
        self.motor_speed = speed;
    }

    pub fn set_max_motor_force(&mut self, force: f64) {
        self.max_motor_force = force;
    }

    /// `b2PrismaticJoint.GetMotorForce`: the accumulated motor impulse.
    pub fn get_motor_force(&self) -> f64 {
        self.motor_impulse
    }

    /// Writes the impulse `(px, py, la, lb)` into the bodies: linear `p` on A and -B, angular `la`/`lb`.
    fn apply(&self, sa: &mut BodyWork, sb: &mut BodyWork, px: f64, py: f64, la: f64, lb: f64) {
        sa.v.x -= self.inv_mass_a * px;
        sa.v.y -= self.inv_mass_a * py;
        sa.w -= self.inv_ia * la;
        sb.v.x += self.inv_mass_b * px;
        sb.v.y += self.inv_mass_b * py;
        sb.w += self.inv_ib * lb;
    }

    pub(crate) fn init_velocity_constraints(&mut self, bodies: &mut Arena<Body>, step: &TimeStep) {
        let mut sa = BodyWork::load(bodies.get(self.base.body_a.0));
        let mut sb = BodyWork::load(bodies.get(self.base.body_b.0));

        self.local_center_a = sa.lc;
        self.local_center_b = sb.lc;

        let ra = rotate_local(&sa.r, self.local_anchor_a, self.local_center_a);
        let rb = rotate_local(&sb.r, self.local_anchor_b, self.local_center_b);
        let dx = sb.c.x + rb.x - sa.c.x - ra.x;
        let dy = sb.c.y + rb.y - sa.c.y - ra.y;

        self.inv_mass_a = sa.inv_mass;
        self.inv_mass_b = sb.inv_mass;
        self.inv_ia = sa.inv_i;
        self.inv_ib = sb.inv_i;

        self.axis = mul_mv(&sa.r, self.local_x_axis_a);
        self.a1 = (dx + ra.x) * self.axis.y - (dy + ra.y) * self.axis.x;
        self.a2 = rb.x * self.axis.y - rb.y * self.axis.x;
        self.motor_mass = self.inv_mass_a
            + self.inv_mass_b
            + self.inv_ia * self.a1 * self.a1
            + self.inv_ib * self.a2 * self.a2;
        if self.motor_mass > MIN_VALUE {
            self.motor_mass = 1.0 / self.motor_mass;
        }

        self.perp = mul_mv(&sa.r, self.local_y_axis_a);
        self.s1 = (dx + ra.x) * self.perp.y - (dy + ra.y) * self.perp.x;
        self.s2 = rb.x * self.perp.y - rb.y * self.perp.x;

        let (ma, mb, da, db) = (self.inv_mass_a, self.inv_mass_b, self.inv_ia, self.inv_ib);
        let (s1, s2, a1, a2) = (self.s1, self.s2, self.a1, self.a2);
        self.k.col1.x = ma + mb + da * s1 * s1 + db * s2 * s2;
        self.k.col1.y = da * s1 + db * s2;
        self.k.col1.z = da * s1 * a1 + db * s2 * a2;
        self.k.col2.x = self.k.col1.y;
        self.k.col2.y = da + db;
        self.k.col2.z = da * a1 + db * a2;
        self.k.col3.x = self.k.col1.z;
        self.k.col3.y = self.k.col2.z;
        self.k.col3.z = ma + mb + da * a1 * a1 + db * a2 * a2;

        if self.enable_limit {
            let t = self.axis.x * dx + self.axis.y * dy;
            if abs_f(self.upper_translation - self.lower_translation) < 2.0 * LINEAR_SLOP {
                self.limit_state = LimitState::Equal;
            } else if t <= self.lower_translation {
                if self.limit_state != LimitState::AtLower {
                    self.limit_state = LimitState::AtLower;
                    self.impulse.z = 0.0;
                }
            } else if t >= self.upper_translation {
                if self.limit_state != LimitState::AtUpper {
                    self.limit_state = LimitState::AtUpper;
                    self.impulse.z = 0.0;
                }
            } else {
                self.limit_state = LimitState::Inactive;
                self.impulse.z = 0.0;
            }
        } else {
            self.limit_state = LimitState::Inactive;
        }

        if !self.enable_motor {
            self.motor_impulse = 0.0;
        }

        if step.warm_starting {
            self.impulse.x *= step.dt_ratio;
            self.impulse.y *= step.dt_ratio;
            self.motor_impulse *= step.dt_ratio;

            let axial = self.motor_impulse + self.impulse.z;
            let px = self.impulse.x * self.perp.x + axial * self.axis.x;
            let py = self.impulse.x * self.perp.y + axial * self.axis.y;
            let la = self.impulse.x * self.s1 + self.impulse.y + axial * self.a1;
            let lb = self.impulse.x * self.s2 + self.impulse.y + axial * self.a2;
            self.apply(&mut sa, &mut sb, px, py, la, lb);
            commit(bodies, self.base.body_a, self.base.body_b, &sa, &sb);
        } else {
            self.impulse.set_zero();
            self.motor_impulse = 0.0;
        }
    }

    pub(crate) fn solve_velocity_constraints(&mut self, bodies: &mut Arena<Body>, step: &TimeStep) {
        let mut sa = BodyWork::load(bodies.get(self.base.body_a.0));
        let mut sb = BodyWork::load(bodies.get(self.base.body_b.0));

        if self.enable_motor && self.limit_state != LimitState::Equal {
            let cdot = self.axis.x * (sb.v.x - sa.v.x)
                + self.axis.y * (sb.v.y - sa.v.y)
                + self.a2 * sb.w
                - self.a1 * sa.w;
            let f = self.motor_mass * (self.motor_speed - cdot);
            let old = self.motor_impulse;
            let bound = step.dt * self.max_motor_force;
            self.motor_impulse = clamp(self.motor_impulse + f, -bound, bound);
            let f = self.motor_impulse - old;
            let px = f * self.axis.x;
            let py = f * self.axis.y;
            let la = f * self.a1;
            let lb = f * self.a2;
            self.apply(&mut sa, &mut sb, px, py, la, lb);
        }

        let dperp = self.perp.x * (sb.v.x - sa.v.x)
            + self.perp.y * (sb.v.y - sa.v.y)
            + self.s2 * sb.w
            - self.s1 * sa.w;
        let dang = sb.w - sa.w;

        if self.enable_limit && self.limit_state != LimitState::Inactive {
            let dtrans = self.axis.x * (sb.v.x - sa.v.x)
                + self.axis.y * (sb.v.y - sa.v.y)
                + self.a2 * sb.w
                - self.a1 * sa.w;
            let old = self.impulse;
            let mut d = Vec3::default();
            self.k.solve33(&mut d, -dperp, -dang, -dtrans);
            self.impulse.add(d);
            match self.limit_state {
                LimitState::AtLower => self.impulse.z = max_f(self.impulse.z, 0.0),
                LimitState::AtUpper => self.impulse.z = min_f(self.impulse.z, 0.0),
                _ => {}
            }

            let dz = self.impulse.z - old.z;
            let ra = -dperp - dz * self.k.col3.x;
            let rb = -dang - dz * self.k.col3.y;
            let mut g = Vec2::zero();
            self.k.solve22(&mut g, ra, rb);
            g.x += old.x;
            g.y += old.y;
            self.impulse.x = g.x;
            self.impulse.y = g.y;

            d.x = self.impulse.x - old.x;
            d.y = self.impulse.y - old.y;
            d.z = self.impulse.z - old.z;
            let px = d.x * self.perp.x + d.z * self.axis.x;
            let py = d.x * self.perp.y + d.z * self.axis.y;
            let la = d.x * self.s1 + d.y + d.z * self.a1;
            let lb = d.x * self.s2 + d.y + d.z * self.a2;
            self.apply(&mut sa, &mut sb, px, py, la, lb);
        } else {
            let mut w = Vec2::zero();
            self.k.solve22(&mut w, -dperp, -dang);
            self.impulse.x += w.x;
            self.impulse.y += w.y;
            let px = w.x * self.perp.x;
            let py = w.x * self.perp.y;
            let la = w.x * self.s1 + w.y;
            let lb = w.x * self.s2 + w.y;
            self.apply(&mut sa, &mut sb, px, py, la, lb);
        }

        commit(bodies, self.base.body_a, self.base.body_b, &sa, &sb);
    }

    pub(crate) fn solve_position_constraints(&mut self, bodies: &mut Arena<Body>) -> bool {
        let mut sa = BodyWork::load(bodies.get(self.base.body_a.0));
        let mut sb = BodyWork::load(bodies.get(self.base.body_b.0));

        let rot_a = Mat22::from_angle(sa.a);
        let rot_b = Mat22::from_angle(sb.a);

        let ra = rotate_local(&rot_a, self.local_anchor_a, self.local_center_a);
        let rb = rotate_local(&rot_b, self.local_anchor_b, self.local_center_b);
        let dx = sb.c.x + rb.x - sa.c.x - ra.x;
        let dy = sb.c.y + rb.y - sa.c.y - ra.y;

        let mut trans_err = 0.0;
        let mut corr = 0.0;
        let mut limited = false;
        if self.enable_limit {
            self.axis = mul_mv(&rot_a, self.local_x_axis_a);
            self.a1 = (dx + ra.x) * self.axis.y - (dy + ra.y) * self.axis.x;
            self.a2 = rb.x * self.axis.y - rb.y * self.axis.x;

            let t = self.axis.x * dx + self.axis.y * dy;
            if abs_f(self.upper_translation - self.lower_translation) < 2.0 * LINEAR_SLOP {
                corr = clamp(t, -MAX_LINEAR_CORRECTION, MAX_LINEAR_CORRECTION);
                trans_err = abs_f(t);
                limited = true;
            } else if t <= self.lower_translation {
                corr = clamp(t - self.lower_translation + LINEAR_SLOP, -MAX_LINEAR_CORRECTION, 0.0);
                trans_err = self.lower_translation - t;
                limited = true;
            } else if t >= self.upper_translation {
                corr = clamp(t - self.upper_translation + LINEAR_SLOP, 0.0, MAX_LINEAR_CORRECTION);
                trans_err = t - self.upper_translation;
                limited = true;
            }
        }

        self.perp = mul_mv(&rot_a, self.local_y_axis_a);
        self.s1 = (dx + ra.x) * self.perp.y - (dy + ra.y) * self.perp.x;
        self.s2 = rb.x * self.perp.y - rb.y * self.perp.x;

        let lin = self.perp.x * dx + self.perp.y * dy;
        let ang = sb.a - sa.a - self.reference_angle;
        trans_err = max_f(trans_err, abs_f(lin));
        let ang_err = abs_f(ang);

        let (ma, mb, da, db) = (self.inv_mass_a, self.inv_mass_b, self.inv_ia, self.inv_ib);
        let (s1, s2, a1, a2) = (self.s1, self.s2, self.a1, self.a2);
        let mut g = Vec3::default();
        if limited {
            self.k.col1.x = ma + mb + da * s1 * s1 + db * s2 * s2;
            self.k.col1.y = da * s1 + db * s2;
            self.k.col1.z = da * s1 * a1 + db * s2 * a2;
            self.k.col2.x = self.k.col1.y;
            self.k.col2.y = da + db;
            self.k.col2.z = da * a1 + db * a2;
            self.k.col3.x = self.k.col1.z;
            self.k.col3.y = self.k.col2.z;
            self.k.col3.z = ma + mb + da * a1 * a1 + db * a2 * a2;
            self.k.solve33(&mut g, -lin, -ang, -corr);
        } else {
            let f11 = ma + mb + da * s1 * s1 + db * s2 * s2;
            let f21 = da * s1 + db * s2;
            let f22 = da + db;
            self.k.col1.set(f11, f21, 0.0);
            self.k.col2.set(f21, f22, 0.0);
            let mut r = Vec2::zero();
            self.k.solve22(&mut r, -lin, -ang);
            g.x = r.x;
            g.y = r.y;
            g.z = 0.0;
        }

        let px = g.x * self.perp.x + g.z * self.axis.x;
        let py = g.x * self.perp.y + g.z * self.axis.y;
        let la = g.x * self.s1 + g.y + g.z * self.a1;
        let lb = g.x * self.s2 + g.y + g.z * self.a2;
        sa.c.x -= ma * px;
        sa.c.y -= ma * py;
        sa.a -= da * la;
        sb.c.x += mb * px;
        sb.c.y += mb * py;
        sb.a += db * lb;

        commit_and_sync(bodies, self.base.body_a, self.base.body_b, &sa, &sb);

        trans_err <= LINEAR_SLOP && ang_err <= ANGULAR_SLOP
    }
}
