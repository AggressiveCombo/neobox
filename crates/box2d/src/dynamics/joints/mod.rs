//! `b2Joint` base, shared velocity/position body copies, and joint dispatch.
//!
//! Typed joints (`DistanceJoint`, `RevoluteJoint`, `PrismaticJoint`) are plain structs
//! that operate on bodies passed in explicitly; the functions here route the generic
//! operations (create, destroy, solver phases, reaction queries) to the right variant.

pub mod distance;
pub mod prismatic;
pub mod revolute;

pub use distance::{DistanceJoint, DistanceJointDef};
pub use prismatic::{PrismaticJoint, PrismaticJointDef};
pub use revolute::{RevoluteJoint, RevoluteJointDef};

use crate::arena::Arena;
use crate::common::math::{Mat22, Vec2};
use crate::dynamics::TimeStep;
use crate::dynamics::body::Body;
use crate::dynamics::store::Store;
use crate::ids::{BodyId, ContactId, JointId};

/// `b2Joint` state shared by every joint type (`m_bodyA`, `m_bodyB`, `m_collideConnected`,
/// `m_islandFlag`, `m_userData`).
#[derive(Clone, Debug)]
pub struct JointBase {
    pub body_a: BodyId,
    pub body_b: BodyId,
    pub collide_connected: bool,
    pub island_flag: bool,
    pub user_data: u64,
}

/// `b2Joint.e_*` type tags.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum JointType {
    Distance,
    Revolute,
    Prismatic,
}

/// Limit state shared by revolute and prismatic joints (`b2Joint.e_*Limit`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum LimitState {
    Inactive,
    AtLower,
    AtUpper,
    Equal,
}

/// A joint definition, as passed to [`create`].
#[derive(Clone, Debug)]
pub enum JointDef {
    Distance(DistanceJointDef),
    Revolute(RevoluteJointDef),
    Prismatic(PrismaticJointDef),
}

/// A live joint stored in `Store::joints`.
#[derive(Clone, Debug)]
pub enum Joint {
    Distance(DistanceJoint),
    Revolute(RevoluteJoint),
    Prismatic(PrismaticJoint),
}

impl Joint {
    pub fn base(&self) -> &JointBase {
        match self {
            Joint::Distance(j) => &j.base,
            Joint::Revolute(j) => &j.base,
            Joint::Prismatic(j) => &j.base,
        }
    }

    pub fn base_mut(&mut self) -> &mut JointBase {
        match self {
            Joint::Distance(j) => &mut j.base,
            Joint::Revolute(j) => &mut j.base,
            Joint::Prismatic(j) => &mut j.base,
        }
    }

    /// `b2Joint.GetType`.
    pub fn get_type(&self) -> JointType {
        match self {
            Joint::Distance(_) => JointType::Distance,
            Joint::Revolute(_) => JointType::Revolute,
            Joint::Prismatic(_) => JointType::Prismatic,
        }
    }
}

/// Copy of the body fields a joint solver reads and writes. Loaded once per solver call
/// and written back with [`commit`] or [`commit_and_sync`].
#[derive(Clone, Copy, Debug)]
pub(crate) struct BodyWork {
    pub r: Mat22,
    pub lc: Vec2,
    pub c: Vec2,
    pub a: f64,
    pub v: Vec2,
    pub w: f64,
    pub inv_mass: f64,
    pub inv_i: f64,
}

impl BodyWork {
    pub(crate) fn load(b: &Body) -> Self {
        Self {
            r: b.xf.r,
            lc: b.sweep.local_center,
            c: b.sweep.c,
            a: b.sweep.a,
            v: b.linear_velocity,
            w: b.angular_velocity,
            inv_mass: b.inv_mass,
            inv_i: b.inv_i,
        }
    }
}

/// Writes back velocities only (velocity solver phase).
pub(crate) fn commit(bodies: &mut Arena<Body>, a: BodyId, b: BodyId, sa: &BodyWork, sb: &BodyWork) {
    let ba = bodies.get_mut(a.0);
    ba.linear_velocity = sa.v;
    ba.angular_velocity = sa.w;
    let bb = bodies.get_mut(b.0);
    bb.linear_velocity = sb.v;
    bb.angular_velocity = sb.w;
}

/// Writes back sweeps then calls `SynchronizeTransform` on both bodies (position solver phase).
pub(crate) fn commit_and_sync(bodies: &mut Arena<Body>, a: BodyId, b: BodyId, sa: &BodyWork, sb: &BodyWork) {
    let ba = bodies.get_mut(a.0);
    ba.sweep.c = sa.c;
    ba.sweep.a = sa.a;
    ba.synchronize_transform();
    let bb = bodies.get_mut(b.0);
    bb.sweep.c = sb.c;
    bb.sweep.a = sb.a;
    bb.synchronize_transform();
}

/// `r = R * (local - center)`, the body-local anchor rotated into world orientation (no translation).
#[inline]
pub(crate) fn rotate_local(r: &Mat22, local: Vec2, center: Vec2) -> Vec2 {
    let x = local.x - center.x;
    let y = local.y - center.y;
    Vec2::new(r.col1.x * x + r.col2.x * y, r.col1.y * x + r.col2.y * y)
}

/// Flags every contact between `a` and `b` for filtering (box2dweb `FlagForFiltering` loop in
/// `CreateJoint` / `DestroyJoint`, used when `collideConnected` is false).
fn flag_contacts_between(store: &mut Store, a: BodyId, b: BodyId) {
    let contacts: Vec<ContactId> = store.body(b).iter_contact_edges().collect();
    for cid in contacts {
        let contact = store.contact(cid);
        let fa = store.fixture(contact.get_fixture_a()).get_body();
        let fb = store.fixture(contact.get_fixture_b()).get_body();
        let other = if fa.0 == b.0 { fb } else { fa };
        if other.0 == a.0 {
            store.contact_mut(cid).flag_for_filtering();
        }
    }
}

/// `b2World.CreateJoint` for the arena and body edge lists. The world's joint ordering list
/// is maintained by the caller.
pub fn create(store: &mut Store, def: &JointDef) -> JointId {
    let (joint, body_a, body_b, collide_connected) = match def {
        JointDef::Distance(d) => (Joint::Distance(DistanceJoint::new(d)), d.body_a, d.body_b, d.collide_connected),
        JointDef::Revolute(d) => (Joint::Revolute(RevoluteJoint::new(d)), d.body_a, d.body_b, d.collide_connected),
        JointDef::Prismatic(d) => (Joint::Prismatic(PrismaticJoint::new(d)), d.body_a, d.body_b, d.collide_connected),
    };
    let id = JointId(store.joints.insert(joint));
    store.body_mut(body_a).push_joint_edge(id);
    store.body_mut(body_b).push_joint_edge(id);
    if !collide_connected {
        flag_contacts_between(store, body_b, body_a);
    }
    id
}

/// `b2World.DestroyJoint` for the arena and body edge lists. Wakes both bodies, unlinks
/// the edges, and re-flags contacts when `collideConnected` was false. The world's joint
/// ordering list is maintained by the caller.
pub fn destroy(store: &mut Store, id: JointId) {
    let (body_a, body_b, collide_connected) = {
        let base = store.joint(id).base();
        (base.body_a, base.body_b, base.collide_connected)
    };
    store.body_mut(body_a).set_awake(true);
    store.body_mut(body_b).set_awake(true);
    store.body_mut(body_a).remove_joint_edge(id);
    store.body_mut(body_b).remove_joint_edge(id);
    store.joints.remove(id.0);
    if !collide_connected {
        flag_contacts_between(store, body_b, body_a);
    }
}

/// Wakes both bodies of a joint. box2dweb's waking setters (`SetMotorSpeed`, `EnableLimit`,
/// `SetLimits`, ...) call `SetAwake(true)` on both bodies before changing state; the typed
/// setters that wake do not do it themselves, so the caller invokes this first.
pub fn wake_bodies(store: &mut Store, id: JointId) {
    let (body_a, body_b) = {
        let base = store.joint(id).base();
        (base.body_a, base.body_b)
    };
    store.body_mut(body_a).set_awake(true);
    store.body_mut(body_b).set_awake(true);
}

/// `b2Joint.IsActive`: both bodies are active.
pub fn is_active(store: &Store, id: JointId) -> bool {
    let base = store.joint(id).base();
    store.body(base.body_a).is_active() && store.body(base.body_b).is_active()
}

pub fn get_anchor_a(store: &Store, id: JointId) -> Vec2 {
    match store.joint(id) {
        Joint::Distance(j) => j.get_anchor_a(store),
        Joint::Revolute(j) => j.get_anchor_a(store),
        Joint::Prismatic(j) => j.get_anchor_a(store),
    }
}

pub fn get_anchor_b(store: &Store, id: JointId) -> Vec2 {
    match store.joint(id) {
        Joint::Distance(j) => j.get_anchor_b(store),
        Joint::Revolute(j) => j.get_anchor_b(store),
        Joint::Prismatic(j) => j.get_anchor_b(store),
    }
}

pub fn get_reaction_force(store: &Store, id: JointId, inv_dt: f64) -> Vec2 {
    match store.joint(id) {
        Joint::Distance(j) => j.get_reaction_force(inv_dt),
        Joint::Revolute(j) => j.get_reaction_force(inv_dt),
        Joint::Prismatic(j) => j.get_reaction_force(inv_dt),
    }
}

pub fn get_reaction_torque(store: &Store, id: JointId, inv_dt: f64) -> f64 {
    match store.joint(id) {
        Joint::Distance(j) => j.get_reaction_torque(inv_dt),
        Joint::Revolute(j) => j.get_reaction_torque(inv_dt),
        Joint::Prismatic(j) => j.get_reaction_torque(inv_dt),
    }
}

/// `b2Joint.InitVelocityConstraints(step)`.
pub fn init_velocity_constraints(store: &mut Store, id: JointId, step: &TimeStep) {
    let Store { bodies, joints, .. } = store;
    match joints.get_mut(id.0) {
        Joint::Distance(j) => j.init_velocity_constraints(bodies, step),
        Joint::Revolute(j) => j.init_velocity_constraints(bodies, step),
        Joint::Prismatic(j) => j.init_velocity_constraints(bodies, step),
    }
}

/// `b2Joint.SolveVelocityConstraints(step)`.
pub fn solve_velocity_constraints(store: &mut Store, id: JointId, step: &TimeStep) {
    let Store { bodies, joints, .. } = store;
    match joints.get_mut(id.0) {
        Joint::Distance(j) => j.solve_velocity_constraints(bodies),
        Joint::Revolute(j) => j.solve_velocity_constraints(bodies, step),
        Joint::Prismatic(j) => j.solve_velocity_constraints(bodies, step),
    }
}

/// `b2Joint.SolvePositionConstraints()`. box2dweb joints ignore the Baumgarte argument, so it is not passed.
pub fn solve_position_constraints(store: &mut Store, id: JointId) -> bool {
    let Store { bodies, joints, .. } = store;
    match joints.get_mut(id.0) {
        Joint::Distance(j) => j.solve_position_constraints(bodies),
        Joint::Revolute(j) => j.solve_position_constraints(bodies),
        Joint::Prismatic(j) => j.solve_position_constraints(bodies),
    }
}
