//! Port of `b2Body` (box2dweb `Box2D.Dynamics.b2Body`).
//!
//! Operations that touch only the body are inherent methods. Operations that
//! also need the store's fixtures/contacts/joints or the contact manager's
//! broad phase are free functions taking `&mut Store`.

use crate::collision::broadphase::BroadPhase;
use crate::collision::shapes::MassData;
use crate::common::math::{Sweep, Transform, Vec2, add_vv, cross_fv, mul_mv, mul_tmv, mul_x, mul_xt, subtract_vv};
use crate::dynamics::contact::ContactListener;
use crate::dynamics::contact_manager::ContactManager;
use crate::dynamics::fixture::{Fixture, FixtureDef};
use crate::dynamics::store::Store;
use crate::ids::{BodyId, ContactId, FixtureId, JointId};

pub(crate) const ISLAND_FLAG: u16 = 1;
pub(crate) const AWAKE_FLAG: u16 = 2;
pub(crate) const ALLOW_SLEEP_FLAG: u16 = 4;
pub(crate) const BULLET_FLAG: u16 = 8;
pub(crate) const FIXED_ROTATION_FLAG: u16 = 16;
pub(crate) const ACTIVE_FLAG: u16 = 32;

/// `b2Body.b2_staticBody` / `b2_kinematicBody` / `b2_dynamicBody`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum BodyType {
    #[default]
    Static,
    Kinematic,
    Dynamic,
}

/// `b2BodyDef`.
#[derive(Clone, Debug)]
pub struct BodyDef {
    pub body_type: BodyType,
    pub position: Vec2,
    pub angle: f64,
    pub linear_velocity: Vec2,
    pub angular_velocity: f64,
    pub linear_damping: f64,
    pub angular_damping: f64,
    pub allow_sleep: bool,
    pub awake: bool,
    pub fixed_rotation: bool,
    pub bullet: bool,
    pub active: bool,
    pub inertia_scale: f64,
    pub user_data: u64,
}

impl Default for BodyDef {
    fn default() -> Self {
        BodyDef {
            body_type: BodyType::Static,
            position: Vec2::default(),
            angle: 0.0,
            linear_velocity: Vec2::default(),
            angular_velocity: 0.0,
            linear_damping: 0.0,
            angular_damping: 0.0,
            allow_sleep: true,
            awake: true,
            fixed_rotation: false,
            bullet: false,
            active: true,
            inertia_scale: 1.0,
            user_data: 0,
        }
    }
}

/// `b2Body`. Fixture, contact and joint edge lists are stored in creation
/// order; box2dweb's intrusive lists prepend, so iteration is newest-first.
#[derive(Debug)]
pub struct Body {
    pub(crate) flags: u16,
    pub(crate) body_type: BodyType,
    pub(crate) xf: Transform,
    pub(crate) sweep: Sweep,
    pub(crate) linear_velocity: Vec2,
    pub(crate) angular_velocity: f64,
    pub(crate) force: Vec2,
    pub(crate) torque: f64,
    pub(crate) sleep_time: f64,
    pub(crate) mass: f64,
    pub(crate) inv_mass: f64,
    pub(crate) inertia: f64,
    pub(crate) inv_i: f64,
    pub(crate) linear_damping: f64,
    pub(crate) angular_damping: f64,
    pub(crate) inertia_scale: f64,
    pub(crate) user_data: u64,
    pub(crate) fixture_list: Vec<FixtureId>,
    pub(crate) contact_list: Vec<ContactId>,
    pub(crate) joint_list: Vec<JointId>,
}

impl Body {
    /// `b2Body` constructor (`m_world` is not stored; the world owns the body).
    pub(crate) fn new(def: &BodyDef) -> Body {
        let mut flags = 0;
        if def.bullet {
            flags |= BULLET_FLAG;
        }
        if def.fixed_rotation {
            flags |= FIXED_ROTATION_FLAG;
        }
        if def.allow_sleep {
            flags |= ALLOW_SLEEP_FLAG;
        }
        if def.awake {
            flags |= AWAKE_FLAG;
        }
        if def.active {
            flags |= ACTIVE_FLAG;
        }

        let mut xf = Transform::default();
        xf.position.set_v(def.position);
        xf.r.set(def.angle);

        let mut sweep = Sweep::default();
        sweep.t0 = 1.0;
        sweep.a0 = def.angle;
        sweep.a = def.angle;
        let r = xf.r;
        let lc = sweep.local_center;
        sweep.c.x = r.col1.x * lc.x + r.col2.x * lc.y;
        sweep.c.y = r.col1.y * lc.x + r.col2.y * lc.y;
        sweep.c.x += xf.position.x;
        sweep.c.y += xf.position.y;
        sweep.c0 = sweep.c;

        let (mass, inv_mass) = if def.body_type == BodyType::Dynamic {
            (1.0, 1.0)
        } else {
            (0.0, 0.0)
        };

        Body {
            flags,
            body_type: def.body_type,
            xf,
            sweep,
            linear_velocity: def.linear_velocity,
            angular_velocity: def.angular_velocity,
            force: Vec2::default(),
            torque: 0.0,
            sleep_time: 0.0,
            mass,
            inv_mass,
            inertia: 0.0,
            inv_i: 0.0,
            linear_damping: def.linear_damping,
            angular_damping: def.angular_damping,
            inertia_scale: def.inertia_scale,
            user_data: def.user_data,
            fixture_list: Vec::new(),
            contact_list: Vec::new(),
            joint_list: Vec::new(),
        }
    }

    /// `b2Body.GetDefinition`. box2dweb does not copy `active` or `inertiaScale`,
    /// so those take the `b2BodyDef` defaults.
    pub(crate) fn get_definition(&self) -> BodyDef {
        BodyDef {
            body_type: self.body_type,
            position: self.xf.position,
            angle: self.sweep.a,
            linear_velocity: self.linear_velocity,
            angular_velocity: self.angular_velocity,
            linear_damping: self.linear_damping,
            angular_damping: self.angular_damping,
            allow_sleep: self.is_sleeping_allowed(),
            awake: self.is_awake(),
            fixed_rotation: self.is_fixed_rotation(),
            bullet: self.is_bullet(),
            active: true,
            inertia_scale: 1.0,
            user_data: self.user_data,
        }
    }

    pub fn get_type(&self) -> BodyType {
        self.body_type
    }

    pub fn is_static(&self) -> bool {
        self.body_type == BodyType::Static
    }

    pub fn is_kinematic(&self) -> bool {
        self.body_type == BodyType::Kinematic
    }

    pub fn is_dynamic(&self) -> bool {
        self.body_type == BodyType::Dynamic
    }

    pub fn get_transform(&self) -> &Transform {
        &self.xf
    }

    pub fn get_position(&self) -> Vec2 {
        self.xf.position
    }

    pub fn get_angle(&self) -> f64 {
        self.sweep.a
    }

    pub fn get_world_center(&self) -> Vec2 {
        self.sweep.c
    }

    pub fn get_local_center(&self) -> Vec2 {
        self.sweep.local_center
    }

    pub fn get_linear_velocity(&self) -> Vec2 {
        self.linear_velocity
    }

    pub fn set_linear_velocity(&mut self, v: Vec2) {
        if self.body_type != BodyType::Static {
            self.linear_velocity.set_v(v);
        }
    }

    pub fn get_angular_velocity(&self) -> f64 {
        self.angular_velocity
    }

    pub fn set_angular_velocity(&mut self, w: f64) {
        if self.body_type != BodyType::Static {
            self.angular_velocity = w;
        }
    }

    pub fn get_linear_damping(&self) -> f64 {
        self.linear_damping
    }

    pub fn set_linear_damping(&mut self, d: f64) {
        self.linear_damping = d;
    }

    pub fn get_angular_damping(&self) -> f64 {
        self.angular_damping
    }

    pub fn set_angular_damping(&mut self, d: f64) {
        self.angular_damping = d;
    }

    pub fn apply_force(&mut self, force: Vec2, point: Vec2) {
        if self.body_type == BodyType::Dynamic {
            if !self.is_awake() {
                self.set_awake(true);
            }
            self.force.x += force.x;
            self.force.y += force.y;
            self.torque +=
                (point.x - self.sweep.c.x) * force.y - (point.y - self.sweep.c.y) * force.x;
        }
    }

    pub fn apply_torque(&mut self, torque: f64) {
        if self.body_type == BodyType::Dynamic {
            if !self.is_awake() {
                self.set_awake(true);
            }
            self.torque += torque;
        }
    }

    pub fn apply_impulse(&mut self, impulse: Vec2, point: Vec2) {
        if self.body_type == BodyType::Dynamic {
            if !self.is_awake() {
                self.set_awake(true);
            }
            self.linear_velocity.x += self.inv_mass * impulse.x;
            self.linear_velocity.y += self.inv_mass * impulse.y;
            self.angular_velocity += self.inv_i
                * ((point.x - self.sweep.c.x) * impulse.y - (point.y - self.sweep.c.y) * impulse.x);
        }
    }

    pub fn get_mass(&self) -> f64 {
        self.mass
    }

    pub fn get_inertia(&self) -> f64 {
        self.inertia
    }

    pub fn get_mass_data(&self) -> MassData {
        MassData {
            mass: self.mass,
            center: self.sweep.local_center,
            i: self.inertia,
        }
    }

    /// `b2Body.SetMassData`.
    pub fn set_mass_data(&mut self, data: &MassData) {
        if self.body_type != BodyType::Dynamic {
            return;
        }
        self.inv_mass = 0.0;
        self.inertia = 0.0;
        self.inv_i = 0.0;
        self.mass = data.mass;
        if self.mass <= 0.0 {
            self.mass = 1.0;
        }
        self.inv_mass = 1.0 / self.mass;
        if data.i > 0.0 && self.flags & FIXED_ROTATION_FLAG == 0 {
            self.inertia = data.i
                - self.mass * (data.center.x * data.center.x + data.center.y * data.center.y);
            self.inv_i = 1.0 / self.inertia;
        }

        let e = self.sweep.c;
        self.sweep.local_center.set_v(data.center);
        self.sweep.c0 = mul_x(&self.xf, self.sweep.local_center);
        self.sweep.c = self.sweep.c0;
        self.linear_velocity.x += -(self.angular_velocity * (self.sweep.c.y - e.y));
        self.linear_velocity.y += self.angular_velocity * (self.sweep.c.x - e.x);
    }

    pub fn is_bullet(&self) -> bool {
        self.flags & BULLET_FLAG == BULLET_FLAG
    }

    pub fn set_bullet(&mut self, flag: bool) {
        if flag {
            self.flags |= BULLET_FLAG;
        } else {
            self.flags &= !BULLET_FLAG;
        }
    }

    pub fn set_sleeping_allowed(&mut self, flag: bool) {
        if flag {
            self.flags |= ALLOW_SLEEP_FLAG;
        } else {
            self.flags &= !ALLOW_SLEEP_FLAG;
            self.set_awake(true);
        }
    }

    pub fn is_sleeping_allowed(&self) -> bool {
        self.flags & ALLOW_SLEEP_FLAG == ALLOW_SLEEP_FLAG
    }

    pub fn set_awake(&mut self, flag: bool) {
        if flag {
            self.flags |= AWAKE_FLAG;
            self.sleep_time = 0.0;
        } else {
            self.flags &= !AWAKE_FLAG;
            self.sleep_time = 0.0;
            self.linear_velocity = Vec2::default();
            self.angular_velocity = 0.0;
            self.force = Vec2::default();
            self.torque = 0.0;
        }
    }

    pub fn is_awake(&self) -> bool {
        self.flags & AWAKE_FLAG == AWAKE_FLAG
    }

    pub fn is_fixed_rotation(&self) -> bool {
        self.flags & FIXED_ROTATION_FLAG == FIXED_ROTATION_FLAG
    }

    pub fn is_active(&self) -> bool {
        self.flags & ACTIVE_FLAG == ACTIVE_FLAG
    }

    pub(crate) fn island_flag(&self) -> bool {
        self.flags & ISLAND_FLAG == ISLAND_FLAG
    }

    pub(crate) fn set_island_flag(&mut self, flag: bool) {
        if flag {
            self.flags |= ISLAND_FLAG;
        } else {
            self.flags &= !ISLAND_FLAG;
        }
    }

    pub fn get_world_point(&self, local: Vec2) -> Vec2 {
        mul_x(&self.xf, local)
    }

    pub fn get_local_point(&self, world: Vec2) -> Vec2 {
        mul_xt(&self.xf, world)
    }

    pub fn get_world_vector(&self, local: Vec2) -> Vec2 {
        mul_mv(&self.xf.r, local)
    }

    pub fn get_local_vector(&self, world: Vec2) -> Vec2 {
        mul_tmv(&self.xf.r, world)
    }

    pub fn get_linear_velocity_from_world_point(&self, p: Vec2) -> Vec2 {
        Vec2 {
            x: self.linear_velocity.x - self.angular_velocity * (p.y - self.sweep.c.y),
            y: self.linear_velocity.y + self.angular_velocity * (p.x - self.sweep.c.x),
        }
    }

    pub fn get_linear_velocity_from_local_point(&self, p: Vec2) -> Vec2 {
        let e = mul_x(&self.xf, p);
        Vec2 {
            x: self.linear_velocity.x - self.angular_velocity * (e.y - self.sweep.c.y),
            y: self.linear_velocity.y + self.angular_velocity * (e.x - self.sweep.c.x),
        }
    }

    pub fn get_user_data(&self) -> u64 {
        self.user_data
    }

    pub fn set_user_data(&mut self, tag: u64) {
        self.user_data = tag;
    }

    /// `b2Body.Advance`: moves the sweep to `alpha` and resyncs the transform.
    pub fn advance(&mut self, alpha: f64) {
        self.sweep.advance(alpha);
        self.sweep.c = self.sweep.c0;
        self.sweep.a = self.sweep.a0;
        self.synchronize_transform();
    }

    /// `b2Body.SynchronizeTransform`.
    pub fn synchronize_transform(&mut self) {
        self.xf.r.set(self.sweep.a);
        let r = self.xf.r;
        let lc = self.sweep.local_center;
        self.xf.position.x = self.sweep.c.x - (r.col1.x * lc.x + r.col2.x * lc.y);
        self.xf.position.y = self.sweep.c.y - (r.col1.y * lc.x + r.col2.y * lc.y);
    }

    pub(crate) fn push_contact_edge(&mut self, id: ContactId) {
        self.contact_list.push(id);
    }

    pub(crate) fn remove_contact_edge(&mut self, id: ContactId) {
        if let Some(p) = self.contact_list.iter().position(|&c| c == id) {
            self.contact_list.remove(p);
        }
    }

    /// Contact edges in box2dweb `m_contactList` order (newest first).
    pub fn iter_contact_edges(&self) -> impl Iterator<Item = ContactId> + '_ {
        self.contact_list.iter().rev().copied()
    }

    pub(crate) fn push_joint_edge(&mut self, id: JointId) {
        self.joint_list.push(id);
    }

    pub(crate) fn remove_joint_edge(&mut self, id: JointId) {
        if let Some(p) = self.joint_list.iter().position(|&j| j == id) {
            self.joint_list.remove(p);
        }
    }

    /// Joint edges in box2dweb `m_jointList` order (newest first).
    pub fn iter_joint_edges(&self) -> impl Iterator<Item = JointId> + '_ {
        self.joint_list.iter().rev().copied()
    }

    /// Fixtures in box2dweb `m_fixtureList` order (newest first).
    pub fn iter_fixtures(&self) -> impl Iterator<Item = FixtureId> + '_ {
        self.fixture_list.iter().rev().copied()
    }
}

/// `b2Body.ResetMassData`.
pub fn reset_mass_data(store: &mut Store, id: BodyId) {
    {
        let b = store.body_mut(id);
        b.mass = 0.0;
        b.inv_mass = 0.0;
        b.inertia = 0.0;
        b.inv_i = 0.0;
        b.sweep.local_center = Vec2::default();
        if b.body_type == BodyType::Static || b.body_type == BodyType::Kinematic {
            return;
        }
    }

    let n = store.body(id).fixture_list.len();
    let mut o = Vec2::default();
    for i in (0..n).rev() {
        let fid = store.body(id).fixture_list[i];
        if store.fixture(fid).density != 0.0 {
            let md = store.fixture(fid).get_mass_data();
            let b = store.body_mut(id);
            b.mass += md.mass;
            o.x += md.center.x * md.mass;
            o.y += md.center.y * md.mass;
            b.inertia += md.i;
        }
    }

    let b = store.body_mut(id);
    if b.mass > 0.0 {
        b.inv_mass = 1.0 / b.mass;
        o.x *= b.inv_mass;
        o.y *= b.inv_mass;
    } else {
        b.mass = 1.0;
        b.inv_mass = 1.0;
    }
    if b.inertia > 0.0 && b.flags & FIXED_ROTATION_FLAG == 0 {
        b.inertia -= b.mass * (o.x * o.x + o.y * o.y);
        b.inertia *= b.inertia_scale;
        b.inv_i = 1.0 / b.inertia;
    } else {
        b.inertia = 0.0;
        b.inv_i = 0.0;
    }

    let a = b.sweep.c;
    b.sweep.local_center = o;
    b.sweep.c0 = mul_x(&b.xf, b.sweep.local_center);
    b.sweep.c = b.sweep.c0;
    b.linear_velocity.x += -(b.angular_velocity * (b.sweep.c.y - a.y));
    b.linear_velocity.y += b.angular_velocity * (b.sweep.c.x - a.x);
}

/// `b2Body.SetType`.
pub fn set_type(store: &mut Store, id: BodyId, t: BodyType) {
    if store.body(id).body_type == t {
        return;
    }
    store.body_mut(id).body_type = t;
    reset_mass_data(store, id);
    let b = store.body_mut(id);
    if t == BodyType::Static {
        b.linear_velocity = Vec2::default();
        b.angular_velocity = 0.0;
    }
    b.set_awake(true);
    b.force = Vec2::default();
    b.torque = 0.0;
    let n = store.body(id).contact_list.len();
    for i in 0..n {
        let c = store.body(id).contact_list[i];
        store.contact_mut(c).flag_for_filtering();
    }
}

/// `b2Body.SetFixedRotation`.
pub fn set_fixed_rotation(store: &mut Store, id: BodyId, flag: bool) {
    {
        let b = store.body_mut(id);
        if flag {
            b.flags |= FIXED_ROTATION_FLAG;
        } else {
            b.flags &= !FIXED_ROTATION_FLAG;
        }
    }
    reset_mass_data(store, id);
}

/// `b2Body.SetPositionAndAngle`. Calls `find_new_contacts` like box2dweb.
pub fn set_position_and_angle(
    store: &mut Store,
    cm: &mut ContactManager,
    id: BodyId,
    p: Vec2,
    angle: f64,
) {
    {
        let b = store.body_mut(id);
        b.xf.r.set(angle);
        b.xf.position.set_v(p);
        let r = b.xf.r;
        let lc = b.sweep.local_center;
        b.sweep.c.x = r.col1.x * lc.x + r.col2.x * lc.y;
        b.sweep.c.y = r.col1.y * lc.x + r.col2.y * lc.y;
        b.sweep.c.x += b.xf.position.x;
        b.sweep.c.y += b.xf.position.y;
        b.sweep.c0 = b.sweep.c;
        b.sweep.a0 = angle;
        b.sweep.a = angle;
    }
    let xf = store.body(id).xf;
    let n = store.body(id).fixture_list.len();
    for i in (0..n).rev() {
        let fid = store.body(id).fixture_list[i];
        store.fixture_mut(fid).synchronize(&mut cm.broad_phase, &xf, &xf);
    }
    cm.find_new_contacts(store);
}

/// `b2Body.SetPosition`.
pub fn set_position(store: &mut Store, cm: &mut ContactManager, id: BodyId, p: Vec2) {
    let angle = store.body(id).get_angle();
    set_position_and_angle(store, cm, id, p, angle);
}

/// `b2Body.SetAngle`.
pub fn set_angle(store: &mut Store, cm: &mut ContactManager, id: BodyId, angle: f64) {
    let p = store.body(id).get_position();
    set_position_and_angle(store, cm, id, p, angle);
}

/// `b2Body.SynchronizeFixtures`.
pub fn synchronize_fixtures(store: &mut Store, bp: &mut BroadPhase, id: BodyId) {
    let mut xf1 = Transform::default();
    let (c0, lc, a0) = {
        let b = store.body(id);
        (b.sweep.c0, b.sweep.local_center, b.sweep.a0)
    };
    xf1.r.set(a0);
    let r = xf1.r;
    xf1.position.x = c0.x - (r.col1.x * lc.x + r.col2.x * lc.y);
    xf1.position.y = c0.y - (r.col1.y * lc.x + r.col2.y * lc.y);
    let xf = store.body(id).xf;
    let n = store.body(id).fixture_list.len();
    for i in (0..n).rev() {
        let fid = store.body(id).fixture_list[i];
        store.fixture_mut(fid).synchronize(bp, &xf1, &xf);
    }
}

/// `b2Body.CreateFixture`. The caller sets the world's new-fixture flag.
pub fn create_fixture(
    store: &mut Store,
    bp: &mut BroadPhase,
    id: BodyId,
    def: &FixtureDef,
) -> FixtureId {
    let xf = store.body(id).xf;
    let fid = FixtureId(store.fixtures.insert(Fixture::new(id, def)));
    if store.body(id).is_active() {
        store.fixture_mut(fid).create_proxy(bp, &xf, fid);
    }
    store.body_mut(id).fixture_list.push(fid);
    if store.fixture(fid).density > 0.0 {
        reset_mass_data(store, id);
    }
    fid
}

/// `b2Body.DestroyFixture`. Destroys the fixture's contacts first, then its
/// proxy, then frees it.
pub fn destroy_fixture(
    store: &mut Store,
    cm: &mut ContactManager,
    fixture_id: FixtureId,
    listener: &mut dyn ContactListener,
) {
    let id = store.fixture(fixture_id).body;
    if let Some(p) = store
        .body(id)
        .fixture_list
        .iter()
        .position(|&f| f == fixture_id)
    {
        store.body_mut(id).fixture_list.remove(p);
    }
    let mut i = store.body(id).contact_list.len();
    while i > 0 {
        i -= 1;
        let Some(&c) = store.body(id).contact_list.get(i) else {
            continue;
        };
        let contact = store.contact(c);
        if contact.fixture_a == fixture_id || contact.fixture_b == fixture_id {
            cm.destroy(store, c, listener);
        }
    }
    if store.body(id).is_active() {
        store.fixture_mut(fixture_id).destroy_proxy(&mut cm.broad_phase);
    }
    store.fixtures.remove(fixture_id.0);
    reset_mass_data(store, id);
}

/// `b2Body.SetActive`. Deactivation destroys every contact on the body via
/// `cm.destroy`, which must unlink the contact from both bodies' edge lists.
pub fn set_active(
    store: &mut Store,
    cm: &mut ContactManager,
    id: BodyId,
    flag: bool,
    listener: &mut dyn ContactListener,
) {
    if flag == store.body(id).is_active() {
        return;
    }
    if flag {
        store.body_mut(id).flags |= ACTIVE_FLAG;
        let xf = store.body(id).xf;
        let n = store.body(id).fixture_list.len();
        for i in (0..n).rev() {
            let fid = store.body(id).fixture_list[i];
            store.fixture_mut(fid).create_proxy(&mut cm.broad_phase, &xf, fid);
        }
    } else {
        store.body_mut(id).flags &= !ACTIVE_FLAG;
        let n = store.body(id).fixture_list.len();
        for i in (0..n).rev() {
            let fid = store.body(id).fixture_list[i];
            store.fixture_mut(fid).destroy_proxy(&mut cm.broad_phase);
        }
        while let Some(&c) = store.body(id).contact_list.last() {
            cm.destroy(store, c, listener);
        }
    }
}

/// `b2Body.ShouldCollide`: whether `a` may collide with `b`.
pub fn should_collide(store: &Store, a: BodyId, b: BodyId) -> bool {
    let ba = store.body(a);
    let bb = store.body(b);
    if ba.body_type != BodyType::Dynamic && bb.body_type != BodyType::Dynamic {
        return false;
    }
    for &j in ba.joint_list.iter().rev() {
        let base = store.joint(j).base();
        let other = if base.body_a == a { base.body_b } else { base.body_a };
        if other == b && !base.collide_connected {
            return false;
        }
    }
    true
}

/// `b2Body.Split`. Creates the new body (box2dweb calls `m_world.CreateBody`
/// before the loop; the caller must add the returned id to the world's body
/// list), moves each fixture for which `should_move` returns true, then
/// recomputes mass and velocities.
pub fn split(
    store: &mut Store,
    cm: &mut ContactManager,
    id: BodyId,
    should_move: &mut dyn FnMut(&Store, FixtureId) -> bool,
) -> BodyId {
    let n = store.body(id).linear_velocity;
    let s = store.body(id).angular_velocity;
    let r = store.body(id).sweep.c;
    let def = store.body(id).get_definition();
    let new_body = BodyId(store.bodies.insert(Body::new(&def)));

    let mut i = store.body(id).fixture_list.len();
    while i > 0 {
        i -= 1;
        let fid = store.body(id).fixture_list[i];
        if should_move(&*store, fid) {
            store.body_mut(id).fixture_list.remove(i);
            store.body_mut(new_body).fixture_list.push(fid);
            store.fixture_mut(fid).body = new_body;
        }
    }

    reset_mass_data(store, id);
    reset_mass_data(store, new_body);
    let h = store.body(id).sweep.c;
    let p = store.body(new_body).sweep.c;
    let y = add_vv(n, cross_fv(s, subtract_vv(h, r)));
    let u = add_vv(n, cross_fv(s, subtract_vv(p, r)));
    store.body_mut(id).set_linear_velocity(y);
    store.body_mut(new_body).set_linear_velocity(u);
    store.body_mut(id).set_angular_velocity(s);
    store.body_mut(new_body).set_angular_velocity(s);
    synchronize_fixtures(store, &mut cm.broad_phase, id);
    synchronize_fixtures(store, &mut cm.broad_phase, new_body);
    new_body
}
