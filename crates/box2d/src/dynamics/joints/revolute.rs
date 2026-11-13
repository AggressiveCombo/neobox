//! `b2RevoluteJoint` / `b2RevoluteJointDef` (box2dweb operation order preserved).

use crate::arena::Arena;
use crate::common::math::{Mat22, Mat33, Vec2, Vec3, abs_f, clamp};
use crate::common::settings::{ANGULAR_SLOP, LINEAR_SLOP, MAX_ANGULAR_CORRECTION};
use crate::dynamics::TimeStep;
use crate::dynamics::body::Body;
use crate::dynamics::joints::{BodyWork, JointBase, LimitState, commit, commit_and_sync, rotate_local};
use crate::dynamics::store::Store;
use crate::ids::BodyId;

/// `b2RevoluteJointDef`. Build with [`RevoluteJointDef::new`] then optionally `initialize`.
#[derive(Clone, Copy, Debug)]
pub struct RevoluteJointDef {
    pub body_a: BodyId,
    pub body_b: BodyId,
    pub local_anchor_a: Vec2,
    pub local_anchor_b: Vec2,
    pub reference_angle: f64,
    pub enable_limit: bool,
    pub lower_angle: f64,
    pub upper_angle: f64,
    pub enable_motor: bool,
    pub motor_speed: f64,
    pub max_motor_torque: f64,
    pub collide_connected: bool,
    pub user_data: u64,
}

/// The JS defaults with both bodies unset (`BodyId(0)`): set them before use.
impl Default for RevoluteJointDef {
    fn default() -> Self {
        Self::new(BodyId(0), BodyId(0))
    }
}

impl RevoluteJointDef {
    /// `new b2RevoluteJointDef()` with the bodies set; anchors, angles, torque and speed zero, limit and motor off.
    pub fn new(body_a: BodyId, body_b: BodyId) -> Self {
        Self {
            body_a,
            body_b,
            local_anchor_a: Vec2::zero(),
            local_anchor_b: Vec2::zero(),
            reference_angle: 0.0,
            enable_limit: false,
            lower_angle: 0.0,
            upper_angle: 0.0,
            enable_motor: false,
            motor_speed: 0.0,
            max_motor_torque: 0.0,
            collide_connected: false,
            user_data: 0,
        }
    }

    /// `b2RevoluteJointDef.Initialize(bodyA, bodyB, anchor)` with a world-space anchor.
    pub fn initialize(&mut self, store: &Store, body_a: BodyId, body_b: BodyId, anchor: Vec2) {
        self.body_a = body_a;
        self.body_b = body_b;
        self.local_anchor_a = store.body(body_a).get_local_point(anchor);
        self.local_anchor_b = store.body(body_b).get_local_point(anchor);
        self.reference_angle = store.body(body_b).get_angle() - store.body(body_a).get_angle();
    }
}

/// `b2RevoluteJoint`.
#[derive(Clone, Debug)]
pub struct RevoluteJoint {
    pub(crate) base: JointBase,
    pub(crate) local_anchor_a: Vec2,
    pub(crate) local_anchor_b: Vec2,
    pub(crate) reference_angle: f64,
    pub(crate) impulse: Vec3,
    pub(crate) motor_impulse: f64,
    pub(crate) mass: Mat33,
    pub(crate) motor_mass: f64,
    pub(crate) lower_angle: f64,
    pub(crate) upper_angle: f64,
    pub(crate) max_motor_torque: f64,
    pub(crate) motor_speed: f64,
    pub(crate) enable_limit: bool,
    pub(crate) enable_motor: bool,
    pub(crate) limit_state: LimitState,
}

impl RevoluteJoint {
    pub(crate) fn new(def: &RevoluteJointDef) -> Self {
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
            reference_angle: def.reference_angle,
            impulse: Vec3::default(),
            motor_impulse: 0.0,
            mass: Mat33::default(),
            motor_mass: 0.0,
            lower_angle: def.lower_angle,
            upper_angle: def.upper_angle,
            max_motor_torque: def.max_motor_torque,
            motor_speed: def.motor_speed,
            enable_limit: def.enable_limit,
            enable_motor: def.enable_motor,
            limit_state: LimitState::Inactive,
        }
    }

    pub fn get_anchor_a(&self, store: &Store) -> Vec2 {
        store.body(self.base.body_a).get_world_point(self.local_anchor_a)
    }

    pub fn get_anchor_b(&self, store: &Store) -> Vec2 {
        store.body(self.base.body_b).get_world_point(self.local_anchor_b)
    }

    pub fn get_reaction_force(&self, inv_dt: f64) -> Vec2 {
        Vec2::new(inv_dt * self.impulse.x, inv_dt * self.impulse.y)
    }

    pub fn get_reaction_torque(&self, inv_dt: f64) -> f64 {
        inv_dt * self.impulse.z
    }

    /// `b2RevoluteJoint.GetJointAngle`.
    pub fn get_joint_angle(&self, store: &Store) -> f64 {
        store.body(self.base.body_b).sweep.a - store.body(self.base.body_a).sweep.a - self.reference_angle
    }

    /// `b2RevoluteJoint.GetJointSpeed`.
    pub fn get_joint_speed(&self, store: &Store) -> f64 {
        store.body(self.base.body_b).angular_velocity - store.body(self.base.body_a).angular_velocity
    }

    pub fn is_limit_enabled(&self) -> bool {
        self.enable_limit
    }

    pub fn enable_limit(&mut self, flag: bool) {
        self.enable_limit = flag;
    }

    pub fn get_lower_limit(&self) -> f64 {
        self.lower_angle
    }

    pub fn get_upper_limit(&self) -> f64 {
        self.upper_angle
    }

    pub fn set_limits(&mut self, lower: f64, upper: f64) {
        self.lower_angle = lower;
        self.upper_angle = upper;
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

    /// `b2RevoluteJoint.GetMotorTorque`: returns the maximum motor torque.
    pub fn get_motor_torque(&self) -> f64 {
        self.max_motor_torque
    }

    pub fn set_max_motor_torque(&mut self, torque: f64) {
        self.max_motor_torque = torque;
    }

    /// `b2RevoluteJoint.InitVelocityConstraints`.
    pub(crate) fn init_velocity_constraints(&mut self, bodies: &mut Arena<Body>, step: &TimeStep) {
        let mut sa = BodyWork::load(bodies.get(self.base.body_a.0));
        let mut sb = BodyWork::load(bodies.get(self.base.body_b.0));

        let ra = rotate_local(&sa.r, self.local_anchor_a, sa.lc);
        let rb = rotate_local(&sb.r, self.local_anchor_b, sb.lc);
        let (l, m) = (ra.x, ra.y);
        let (c, h) = (rb.x, rb.y);
        let (ma, mb, ia, ib) = (sa.inv_mass, sb.inv_mass, sa.inv_i, sb.inv_i);

        self.mass.col1.x = ma + mb + m * m * ia + h * h * ib;
        self.mass.col2.x = -m * l * ia - h * c * ib;
        self.mass.col3.x = -m * ia - h * ib;
        self.mass.col1.y = self.mass.col2.x;
        self.mass.col2.y = ma + mb + l * l * ia + c * c * ib;
        self.mass.col3.y = l * ia + c * ib;
        self.mass.col1.z = self.mass.col3.x;
        self.mass.col2.z = self.mass.col3.y;
        self.mass.col3.z = ia + ib;
        self.motor_mass = 1.0 / (ia + ib);
        if !self.enable_motor {
            self.motor_impulse = 0.0;
        }

        if self.enable_limit {
            let f = sb.a - sa.a - self.reference_angle;
            if abs_f(self.upper_angle - self.lower_angle) < 2.0 * ANGULAR_SLOP {
                self.limit_state = LimitState::Equal;
            } else if f <= self.lower_angle {
                if self.limit_state != LimitState::AtLower {
                    self.impulse.z = 0.0;
                }
                self.limit_state = LimitState::AtLower;
            } else if f >= self.upper_angle {
                if self.limit_state != LimitState::AtUpper {
                    self.impulse.z = 0.0;
                }
                self.limit_state = LimitState::AtUpper;
            } else {
                self.limit_state = LimitState::Inactive;
                self.impulse.z = 0.0;
            }
        } else {
            self.limit_state = LimitState::Inactive;
        }

        if step.warm_starting {
            self.impulse.x *= step.dt_ratio;
            self.impulse.y *= step.dt_ratio;
            self.motor_impulse *= step.dt_ratio;
            let px = self.impulse.x;
            let py = self.impulse.y;
            sa.v.x -= ma * px;
            sa.v.y -= ma * py;
            sa.w -= ia * (l * py - m * px + self.motor_impulse + self.impulse.z);
            sb.v.x += mb * px;
            sb.v.y += mb * py;
            sb.w += ib * (c * py - h * px + self.motor_impulse + self.impulse.z);
        } else {
            self.impulse.set_zero();
            self.motor_impulse = 0.0;
        }
        commit(bodies, self.base.body_a, self.base.body_b, &sa, &sb);
    }

    /// `b2RevoluteJoint.SolveVelocityConstraints`.
    pub(crate) fn solve_velocity_constraints(&mut self, bodies: &mut Arena<Body>, step: &TimeStep) {
        let mut sa = BodyWork::load(bodies.get(self.base.body_a.0));
        let mut sb = BodyWork::load(bodies.get(self.base.body_b.0));
        let (ma, mb, ia, ib) = (sa.inv_mass, sb.inv_mass, sa.inv_i, sb.inv_i);
        let mut va = sa.v;
        let mut wa = sa.w;
        let mut vb = sb.v;
        let mut wb = sb.w;

        if self.enable_motor && self.limit_state != LimitState::Equal {
            let cdot = wb - wa - self.motor_speed;
            let impulse = -(self.motor_mass * cdot);
            let old = self.motor_impulse;
            let max = step.dt * self.max_motor_torque;
            self.motor_impulse = clamp(self.motor_impulse + impulse, -max, max);
            let delta = self.motor_impulse - old;
            wa -= ia * delta;
            wb += ib * delta;
        }

        let ra = rotate_local(&sa.r, self.local_anchor_a, sa.lc);
        let rb = rotate_local(&sb.r, self.local_anchor_b, sb.lc);
        let cdx = vb.x + -wb * rb.y - va.x - -wa * ra.y;
        let cdy = vb.y + wb * rb.x - va.y - wa * ra.x;

        if self.enable_limit && self.limit_state != LimitState::Inactive {
            let cdw = wb - wa;
            let mut impulse3 = Vec3::default();
            self.mass.solve33(&mut impulse3, -cdx, -cdy, -cdw);
            match self.limit_state {
                LimitState::Equal => self.impulse.add(impulse3),
                LimitState::AtLower => {
                    if self.impulse.z + impulse3.z < 0.0 {
                        impulse3 = self.clamp_limit_impulse(cdx, cdy);
                    }
                }
                LimitState::AtUpper => {
                    if self.impulse.z + impulse3.z > 0.0 {
                        impulse3 = self.clamp_limit_impulse(cdx, cdy);
                    }
                }
                LimitState::Inactive => {}
            }
            va.x -= ma * impulse3.x;
            va.y -= ma * impulse3.y;
            wa -= ia * (ra.x * impulse3.y - ra.y * impulse3.x + impulse3.z);
            vb.x += mb * impulse3.x;
            vb.y += mb * impulse3.y;
            wb += ib * (rb.x * impulse3.y - rb.y * impulse3.x + impulse3.z);
        } else {
            let mut impulse2 = Vec2::zero();
            self.mass.solve22(&mut impulse2, -cdx, -cdy);
            self.impulse.x += impulse2.x;
            self.impulse.y += impulse2.y;
            va.x -= ma * impulse2.x;
            va.y -= ma * impulse2.y;
            wa -= ia * (ra.x * impulse2.y - ra.y * impulse2.x);
            vb.x += mb * impulse2.x;
            vb.y += mb * impulse2.y;
            wb += ib * (rb.x * impulse2.y - rb.y * impulse2.x);
        }

        sa.v = va;
        sa.w = wa;
        sb.v = vb;
        sb.w = wb;
        commit(bodies, self.base.body_a, self.base.body_b, &sa, &sb);
    }

    /// Limit-clamp branch of the velocity solve: re-solves the point block alone, zeroes
    /// `impulse.z`, and returns the replacement `impulse3` (`(reduced.x, reduced.y, -impulse.z)`).
    fn clamp_limit_impulse(&mut self, cdx: f64, cdy: f64) -> Vec3 {
        let mut reduced = Vec2::zero();
        self.mass.solve22(&mut reduced, -cdx, -cdy);
        let z = -self.impulse.z;
        self.impulse.x += reduced.x;
        self.impulse.y += reduced.y;
        self.impulse.z = 0.0;
        Vec3::new(reduced.x, reduced.y, z)
    }

    /// `b2RevoluteJoint.SolvePositionConstraints`.
    pub(crate) fn solve_position_constraints(&mut self, bodies: &mut Arena<Body>) -> bool {
        let mut sa = BodyWork::load(bodies.get(self.base.body_a.0));
        let mut sb = BodyWork::load(bodies.get(self.base.body_b.0));
        let mut l = 0.0;

        if self.enable_limit && self.limit_state != LimitState::Inactive {
            let angle = sb.a - sa.a - self.reference_angle;
            let (err, x) = if self.limit_state == LimitState::Equal {
                let s = clamp(angle - self.lower_angle, -MAX_ANGULAR_CORRECTION, MAX_ANGULAR_CORRECTION);
                (abs_f(s), -self.motor_mass * s)
            } else if self.limit_state == LimitState::AtLower {
                let s = angle - self.lower_angle;
                let s = clamp(s + ANGULAR_SLOP, -MAX_ANGULAR_CORRECTION, 0.0);
                (-(angle - self.lower_angle), -self.motor_mass * s)
            } else {
                let s = angle - self.upper_angle;
                let s = clamp(s - ANGULAR_SLOP, 0.0, MAX_ANGULAR_CORRECTION);
                (angle - self.upper_angle, -self.motor_mass * s)
            };
            l = err;
            sa.a -= sa.inv_i * x;
            sb.a += sb.inv_i * x;
            commit_and_sync(bodies, self.base.body_a, self.base.body_b, &sa, &sb);
            sa = BodyWork::load(bodies.get(self.base.body_a.0));
            sb = BodyWork::load(bodies.get(self.base.body_b.0));
        }

        let ra = rotate_local(&sa.r, self.local_anchor_a, sa.lc);
        let rb = rotate_local(&sb.r, self.local_anchor_b, sb.lc);
        let mut dx = sb.c.x + rb.x - sa.c.x - ra.x;
        let mut dy = sb.c.y + rb.y - sa.c.y - ra.y;
        let b_sq = dx * dx + dy * dy;
        let m = b_sq.sqrt();
        let (ma, mb, ia, ib) = (sa.inv_mass, sb.inv_mass, sa.inv_i, sb.inv_i);

        let lin = 10.0 * LINEAR_SLOP;
        if b_sq > lin * lin {
            let k = 1.0 / (ma + mb);
            let hx = -(k * dx);
            let hy = -(k * dy);
            sa.c.x -= 0.5 * ma * hx;
            sa.c.y -= 0.5 * ma * hy;
            sb.c.x += 0.5 * mb * hx;
            sb.c.y += 0.5 * mb * hy;
            dx = sb.c.x + rb.x - sa.c.x - ra.x;
            dy = sb.c.y + rb.y - sa.c.y - ra.y;
        }

        let mut k = Mat22::from_vv(Vec2::new(ma + mb, 0.0), Vec2::new(0.0, ma + mb));
        let k2 = Mat22::from_vv(
            Vec2::new(ia * ra.y * ra.y, -ia * ra.x * ra.y),
            Vec2::new(-ia * ra.x * ra.y, ia * ra.x * ra.x),
        );
        let k3 = Mat22::from_vv(
            Vec2::new(ib * rb.y * rb.y, -ib * rb.x * rb.y),
            Vec2::new(-ib * rb.x * rb.y, ib * rb.x * rb.x),
        );
        k.add_m(&k2);
        k.add_m(&k3);

        let mut imp = Vec2::zero();
        k.solve(&mut imp, -dx, -dy);
        let hx = imp.x;
        let hy = imp.y;
        sa.c.x -= ma * hx;
        sa.c.y -= ma * hy;
        sa.a -= ia * (ra.x * hy - ra.y * hx);
        sb.c.x += mb * hx;
        sb.c.y += mb * hy;
        sb.a += ib * (rb.x * hy - rb.y * hx);
        commit_and_sync(bodies, self.base.body_a, self.base.body_b, &sa, &sb);

        m <= LINEAR_SLOP && l <= ANGULAR_SLOP
    }
}
