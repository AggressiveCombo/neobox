//! `b2DistanceJoint` / `b2DistanceJointDef` (box2dweb operation order preserved).

use crate::arena::Arena;
use crate::common::math::{Vec2, clamp};
use crate::common::settings::{B2_PI, LINEAR_SLOP, MAX_LINEAR_CORRECTION};
use crate::dynamics::TimeStep;
use crate::dynamics::body::Body;
use crate::dynamics::joints::{BodyWork, JointBase, commit, commit_and_sync};
use crate::dynamics::store::Store;
use crate::ids::BodyId;

/// `b2DistanceJointDef`. Build with [`DistanceJointDef::new`] then optionally `initialize`.
#[derive(Clone, Copy, Debug)]
pub struct DistanceJointDef {
    pub body_a: BodyId,
    pub body_b: BodyId,
    pub local_anchor_a: Vec2,
    pub local_anchor_b: Vec2,
    pub length: f64,
    pub frequency_hz: f64,
    pub damping_ratio: f64,
    pub collide_connected: bool,
    pub user_data: u64,
}

/// The JS defaults with both bodies unset (`BodyId(0)`): set them before use.
impl Default for DistanceJointDef {
    fn default() -> Self {
        Self::new(BodyId(0), BodyId(0))
    }
}

impl DistanceJointDef {
    /// `new b2DistanceJointDef()` with the bodies set; anchors zero, length 1, no spring.
    pub fn new(body_a: BodyId, body_b: BodyId) -> Self {
        Self {
            body_a,
            body_b,
            local_anchor_a: Vec2::zero(),
            local_anchor_b: Vec2::zero(),
            length: 1.0,
            frequency_hz: 0.0,
            damping_ratio: 0.0,
            collide_connected: false,
            user_data: 0,
        }
    }

    /// `b2DistanceJointDef.Initialize(bodyA, bodyB, anchorA, anchorB)` with world-space anchors.
    pub fn initialize(&mut self, store: &Store, body_a: BodyId, body_b: BodyId, anchor_a: Vec2, anchor_b: Vec2) {
        self.body_a = body_a;
        self.body_b = body_b;
        self.local_anchor_a = store.body(body_a).get_local_point(anchor_a);
        self.local_anchor_b = store.body(body_b).get_local_point(anchor_b);
        let s = anchor_b.x - anchor_a.x;
        let r = anchor_b.y - anchor_a.y;
        self.length = (s * s + r * r).sqrt();
        self.frequency_hz = 0.0;
        self.damping_ratio = 0.0;
    }
}

/// `b2DistanceJoint`.
#[derive(Clone, Debug)]
pub struct DistanceJoint {
    pub(crate) base: JointBase,
    pub(crate) local_anchor_a: Vec2,
    pub(crate) local_anchor_b: Vec2,
    pub(crate) u: Vec2,
    pub(crate) impulse: f64,
    pub(crate) mass: f64,
    pub(crate) length: f64,
    pub(crate) frequency_hz: f64,
    pub(crate) damping_ratio: f64,
    pub(crate) gamma: f64,
    pub(crate) bias: f64,
}

impl DistanceJoint {
    pub(crate) fn new(def: &DistanceJointDef) -> Self {
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
            u: Vec2::zero(),
            impulse: 0.0,
            mass: 0.0,
            length: def.length,
            frequency_hz: def.frequency_hz,
            damping_ratio: def.damping_ratio,
            gamma: 0.0,
            bias: 0.0,
        }
    }

    pub fn get_anchor_a(&self, store: &Store) -> Vec2 {
        store.body(self.base.body_a).get_world_point(self.local_anchor_a)
    }

    pub fn get_anchor_b(&self, store: &Store) -> Vec2 {
        store.body(self.base.body_b).get_world_point(self.local_anchor_b)
    }

    pub fn get_reaction_force(&self, inv_dt: f64) -> Vec2 {
        Vec2::new(inv_dt * self.impulse * self.u.x, inv_dt * self.impulse * self.u.y)
    }

    /// Always zero for a distance joint (box2dweb `GetReactionTorque`).
    pub fn get_reaction_torque(&self, _inv_dt: f64) -> f64 {
        0.0
    }

    pub fn get_length(&self) -> f64 {
        self.length
    }

    pub fn set_length(&mut self, length: f64) {
        self.length = length;
    }

    pub fn get_frequency(&self) -> f64 {
        self.frequency_hz
    }

    pub fn set_frequency(&mut self, hz: f64) {
        self.frequency_hz = hz;
    }

    pub fn get_damping_ratio(&self) -> f64 {
        self.damping_ratio
    }

    pub fn set_damping_ratio(&mut self, ratio: f64) {
        self.damping_ratio = ratio;
    }

    pub(crate) fn init_velocity_constraints(&mut self, bodies: &mut Arena<Body>, step: &TimeStep) {
        let mut sa = BodyWork::load(bodies.get(self.base.body_a.0));
        let mut sb = BodyWork::load(bodies.get(self.base.body_b.0));

        let e = sa.r;
        let mut ax = self.local_anchor_a.x - sa.lc.x;
        let mut ay = self.local_anchor_a.y - sa.lc.y;
        let n = e.col1.x * ax + e.col2.x * ay;
        ay = e.col1.y * ax + e.col2.y * ay;
        ax = n;

        let e = sb.r;
        let mut bx = self.local_anchor_b.x - sb.lc.x;
        let mut by = self.local_anchor_b.y - sb.lc.y;
        let n = e.col1.x * bx + e.col2.x * by;
        by = e.col1.y * bx + e.col2.y * by;
        bx = n;

        self.u.x = sb.c.x + bx - sa.c.x - ax;
        self.u.y = sb.c.y + by - sa.c.y - ay;
        let len = (self.u.x * self.u.x + self.u.y * self.u.y).sqrt();
        if len > LINEAR_SLOP {
            self.u.multiply(1.0 / len);
        } else {
            self.u.set_zero();
        }

        let cra = ax * self.u.y - ay * self.u.x;
        let crb = bx * self.u.y - by * self.u.x;
        let inv_mass_sum = sa.inv_mass + sa.inv_i * cra * cra + sb.inv_mass + sb.inv_i * crb * crb;
        self.mass = if inv_mass_sum != 0.0 { 1.0 / inv_mass_sum } else { 0.0 };

        if self.frequency_hz > 0.0 {
            let x = len - self.length;
            let omega = 2.0 * B2_PI * self.frequency_hz;
            let f = 2.0 * self.mass * self.damping_ratio * omega;
            let d = self.mass * omega * omega;
            self.gamma = step.dt * (f + step.dt * d);
            self.gamma = if self.gamma != 0.0 { 1.0 / self.gamma } else { 0.0 };
            self.bias = x * step.dt * d * self.gamma;
            self.mass = inv_mass_sum + self.gamma;
            self.mass = if self.mass != 0.0 { 1.0 / self.mass } else { 0.0 };
        }

        if step.warm_starting {
            self.impulse *= step.dt_ratio;
            let px = self.impulse * self.u.x;
            let py = self.impulse * self.u.y;
            sa.v.x -= sa.inv_mass * px;
            sa.v.y -= sa.inv_mass * py;
            sa.w -= sa.inv_i * (ax * py - ay * px);
            sb.v.x += sb.inv_mass * px;
            sb.v.y += sb.inv_mass * py;
            sb.w += sb.inv_i * (bx * py - by * px);
        } else {
            self.impulse = 0.0;
        }
        commit(bodies, self.base.body_a, self.base.body_b, &sa, &sb);
    }

    pub(crate) fn solve_velocity_constraints(&mut self, bodies: &mut Arena<Body>) {
        let mut sa = BodyWork::load(bodies.get(self.base.body_a.0));
        let mut sb = BodyWork::load(bodies.get(self.base.body_b.0));

        let e = sa.r;
        let sx0 = self.local_anchor_a.x - sa.lc.x;
        let sy0 = self.local_anchor_a.y - sa.lc.y;
        let ax = e.col1.x * sx0 + e.col2.x * sy0;
        let ay = e.col1.y * sx0 + e.col2.y * sy0;

        let e = sb.r;
        let bx0 = self.local_anchor_b.x - sb.lc.x;
        let by0 = self.local_anchor_b.y - sb.lc.y;
        let bx = e.col1.x * bx0 + e.col2.x * by0;
        let by = e.col1.y * bx0 + e.col2.y * by0;

        let cax = sa.v.x + -sa.w * ay;
        let cay = sa.v.y + sa.w * ax;
        let cbx = sb.v.x + -sb.w * by;
        let cby = sb.v.y + sb.w * bx;
        let cdot = self.u.x * (cbx - cax) + self.u.y * (cby - cay);
        let impulse = -self.mass * (cdot + self.bias + self.gamma * self.impulse);
        self.impulse += impulse;

        let px = impulse * self.u.x;
        let py = impulse * self.u.y;
        sa.v.x -= sa.inv_mass * px;
        sa.v.y -= sa.inv_mass * py;
        sa.w -= sa.inv_i * (ax * py - ay * px);
        sb.v.x += sb.inv_mass * px;
        sb.v.y += sb.inv_mass * py;
        sb.w += sb.inv_i * (bx * py - by * px);
        commit(bodies, self.base.body_a, self.base.body_b, &sa, &sb);
    }

    pub(crate) fn solve_position_constraints(&mut self, bodies: &mut Arena<Body>) -> bool {
        if self.frequency_hz > 0.0 {
            return true;
        }
        let mut sa = BodyWork::load(bodies.get(self.base.body_a.0));
        let mut sb = BodyWork::load(bodies.get(self.base.body_b.0));

        let e = sa.r;
        let sx0 = self.local_anchor_a.x - sa.lc.x;
        let sy0 = self.local_anchor_a.y - sa.lc.y;
        let ax = e.col1.x * sx0 + e.col2.x * sy0;
        let ay = e.col1.y * sx0 + e.col2.y * sy0;

        let e = sb.r;
        let bx0 = self.local_anchor_b.x - sb.lc.x;
        let by0 = self.local_anchor_b.y - sb.lc.y;
        let bx = e.col1.x * bx0 + e.col2.x * by0;
        let by = e.col1.y * bx0 + e.col2.y * by0;

        let mut px = sb.c.x + bx - sa.c.x - ax;
        let mut py = sb.c.y + by - sa.c.y - ay;
        let len = (px * px + py * py).sqrt();
        px /= len;
        py /= len;

        let x = clamp(len - self.length, -MAX_LINEAR_CORRECTION, MAX_LINEAR_CORRECTION);
        let impulse = -self.mass * x;
        self.u.set(px, py);
        let fx = impulse * self.u.x;
        let fy = impulse * self.u.y;

        sa.c.x -= sa.inv_mass * fx;
        sa.c.y -= sa.inv_mass * fy;
        sa.a -= sa.inv_i * (ax * fy - ay * fx);
        sb.c.x += sb.inv_mass * fx;
        sb.c.y += sb.inv_mass * fy;
        sb.a += sb.inv_i * (bx * fy - by * fx);
        commit_and_sync(bodies, self.base.body_a, self.base.body_b, &sa, &sb);

        x.abs() < LINEAR_SLOP
    }
}
