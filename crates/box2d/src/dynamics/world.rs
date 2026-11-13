//! `b2World`: owns every body, fixture, contact and joint, and steps them.
//!
//! Lists that box2dweb keeps as intrusive linked lists with prepend are `Vec`s in
//! creation order here; iterating them in reverse gives the original's newest-first
//! order. The solve half of `Step` (`Solve` and `SolveTOI`) lives in `world_solve.rs`.

use crate::collision::aabb::{AABB, RayCastInput, RayCastOutput};
use crate::common::math::Vec2;
use crate::dynamics::TimeStep;
use crate::dynamics::body::{self, Body, BodyDef, BodyType};
pub use crate::dynamics::contact::{ContactImpulse, ContactListener, NoListener};
use crate::dynamics::contact_manager::ContactManager;
use crate::dynamics::fixture::{self, FixtureDef};
use crate::dynamics::island::Island;
use crate::dynamics::joints::{self, JointDef};
use crate::dynamics::store::Store;
use crate::ids::{BodyId, ContactId, FixtureId, JointId};

/// `b2World.e_newFixture`
const E_NEW_FIXTURE: u32 = 1;
/// `b2World.e_locked`
const E_LOCKED: u32 = 2;

/// The physics world.
pub struct World {
    pub(crate) store: Store,
    pub(crate) contact_manager: ContactManager,
    /// `m_island` (reused by `solve` and `solve_toi`)
    pub(crate) island: Island,
    /// `s_stack` (island depth-first search; reused)
    pub(crate) stack: Vec<BodyId>,
    /// `m_bodyList` in creation order (iterate reversed for box2dweb order)
    pub(crate) bodies: Vec<BodyId>,
    /// `m_jointList` in creation order (iterate reversed for box2dweb order)
    pub(crate) joints: Vec<JointId>,
    /// `m_gravity`
    pub(crate) gravity: Vec2,
    /// `m_allowSleep`
    pub(crate) allow_sleep: bool,
    /// `m_groundBody`
    pub(crate) ground_body: BodyId,
    /// `m_flags` (`E_NEW_FIXTURE`, `E_LOCKED`)
    pub(crate) flags: u32,
    /// `m_inv_dt0`
    pub(crate) inv_dt0: f64,
    /// `SolveTOI` body queue (reused)
    pub(crate) toi_queue: Vec<BodyId>,
    /// `b2World.m_warmStarting`. A static (process-wide) flag in box2dweb;
    /// per world here so worlds in different threads (server rooms) never
    /// affect each other. Behaviour within one world is identical.
    warm_starting: bool,
    /// `b2World.m_continuousPhysics` (static in box2dweb, see above).
    continuous_physics: bool,
}

/// Allocates a body in the store and appends it to the creation-order list.
fn spawn_body(store: &mut Store, bodies: &mut Vec<BodyId>, def: &BodyDef) -> BodyId {
    let id = BodyId(store.bodies.insert(Body::new(def)));
    bodies.push(id);
    id
}

impl World {
    /// `new b2World(gravity, doSleep)`. Creates the ground body.
    pub fn new(gravity: Vec2, do_sleep: bool) -> World {
        // the constructor sets both statics to true
        let mut store = Store::new();
        let mut bodies = Vec::new();
        let ground_body = spawn_body(&mut store, &mut bodies, &BodyDef::default());
        World {
            store,
            contact_manager: ContactManager::new(),
            island: Island::new(),
            stack: Vec::new(),
            bodies,
            joints: Vec::new(),
            gravity,
            allow_sleep: do_sleep,
            ground_body,
            flags: 0,
            inv_dt0: 0.0,
            toi_queue: Vec::new(),
            warm_starting: true,
            continuous_physics: true,
        }
    }

    /// `b2World.prototype.novakReset`: fresh contact manager/broadphase/solver/island,
    /// empty lists, new ground body. Keeps heap capacity. Sets only the static
    /// continuous-physics flag, as box2dweb does; the warm-starting flag and `m_flags`
    /// are untouched.
    pub fn reset(&mut self) {
        self.continuous_physics = true;
        self.store.bodies.clear();
        self.store.fixtures.clear();
        self.store.contacts.clear();
        // novakReset builds a new contact factory: empty pools
        for pool in &mut self.store.contact_pool {
            pool.clear();
        }
        self.store.joints.clear();
        self.bodies.clear();
        self.joints.clear();
        self.contact_manager.reset();
        self.island.clear();
        self.stack.clear();
        self.toi_queue.clear();
        self.inv_dt0 = 0.0;
        self.ground_body = spawn_body(&mut self.store, &mut self.bodies, &BodyDef::default());
    }

    /// `b2World.SetGravity`.
    pub fn set_gravity(&mut self, g: Vec2) {
        self.gravity = g;
    }

    /// `b2World.GetGravity`.
    pub fn get_gravity(&self) -> Vec2 {
        self.gravity
    }

    /// `b2World.SetWarmStarting`.
    pub fn set_warm_starting(&mut self, flag: bool) {
        self.warm_starting = flag;
    }

    pub fn get_warm_starting(&self) -> bool {
        self.warm_starting
    }

    /// `b2World.SetContinuousPhysics`.
    pub fn set_continuous_physics(&mut self, flag: bool) {
        self.continuous_physics = flag;
    }

    pub fn store(&self) -> &Store {
        &self.store
    }

    pub fn store_mut(&mut self) -> &mut Store {
        &mut self.store
    }

    /// `b2World.GetGroundBody`.
    pub fn get_ground_body(&self) -> BodyId {
        self.ground_body
    }

    /// `b2World.GetBodyCount`.
    pub fn body_count(&self) -> usize {
        self.bodies.len()
    }

    /// `b2World.GetJointCount`.
    pub fn joint_count(&self) -> usize {
        self.joints.len()
    }

    /// `b2World.GetContactCount`.
    pub fn contact_count(&self) -> usize {
        self.contact_manager.contact_count
    }

    fn is_locked(&self) -> bool {
        self.flags & E_LOCKED != 0
    }

    /// `b2World.CreateBody`.
    pub fn create_body(&mut self, def: &BodyDef) -> BodyId {
        spawn_body(&mut self.store, &mut self.bodies, def)
    }

    /// `b2World.DestroyBody`. Does nothing while the world is stepping.
    /// Joints go first, then contacts (both newest-first), then fixtures.
    pub fn destroy_body(&mut self, id: BodyId, listener: &mut dyn ContactListener) {
        if self.is_locked() {
            return;
        }
        loop {
            let next = self.store.body(id).iter_joint_edges().next();
            let Some(j) = next else { break };
            self.remove_joint_entry(j);
            joints::destroy(&mut self.store, j);
        }
        loop {
            let next = self.store.body(id).iter_contact_edges().next();
            let Some(c) = next else { break };
            self.contact_manager.destroy(&mut self.store, c, listener);
        }
        let fixtures: Vec<FixtureId> = self.store.body(id).iter_fixtures().collect();
        for f in fixtures {
            self.store
                .fixture_mut(f)
                .destroy_proxy(&mut self.contact_manager.broad_phase);
            self.store.fixtures.remove(f.0);
        }
        if let Some(p) = self.bodies.iter().position(|&b| b == id) {
            self.bodies.remove(p);
        }
        self.store.bodies.remove(id.0);
    }

    /// `b2Body.CreateFixture`. Sets the world's new-fixture flag so the next `step`
    /// runs `find_new_contacts`.
    pub fn create_fixture(&mut self, body: BodyId, def: &FixtureDef) -> FixtureId {
        let fid = body::create_fixture(
            &mut self.store,
            &mut self.contact_manager.broad_phase,
            body,
            def,
        );
        self.flags |= E_NEW_FIXTURE;
        fid
    }

    /// `b2Body.DestroyFixture`. Does nothing while the world is stepping.
    pub fn destroy_fixture(&mut self, id: FixtureId, listener: &mut dyn ContactListener) {
        if self.is_locked() {
            return;
        }
        body::destroy_fixture(&mut self.store, &mut self.contact_manager, id, listener);
    }

    /// `b2World.CreateJoint`.
    pub fn create_joint(&mut self, def: &JointDef) -> JointId {
        let id = joints::create(&mut self.store, def);
        self.joints.push(id);
        id
    }

    /// `b2World.DestroyJoint`. box2dweb emits no listener callback here, so the
    /// listener is unused.
    pub fn destroy_joint(&mut self, id: JointId, _listener: &mut dyn ContactListener) {
        self.remove_joint_entry(id);
        joints::destroy(&mut self.store, id);
    }

    fn remove_joint_entry(&mut self, id: JointId) {
        if let Some(p) = self.joints.iter().position(|&j| j == id) {
            self.joints.remove(p);
        }
    }

    /// `b2Body.SetPosition`.
    pub fn set_position(&mut self, body: BodyId, p: Vec2) {
        body::set_position(&mut self.store, &mut self.contact_manager, body, p);
    }

    /// `b2Body.SetAngle`.
    pub fn set_angle(&mut self, body: BodyId, angle: f64) {
        body::set_angle(&mut self.store, &mut self.contact_manager, body, angle);
    }

    /// `b2Body.SetPositionAndAngle`.
    pub fn set_position_and_angle(&mut self, body: BodyId, p: Vec2, angle: f64) {
        body::set_position_and_angle(&mut self.store, &mut self.contact_manager, body, p, angle);
    }

    /// `b2Body.SetActive`.
    pub fn set_active(&mut self, body: BodyId, flag: bool, listener: &mut dyn ContactListener) {
        body::set_active(&mut self.store, &mut self.contact_manager, body, flag, listener);
    }

    /// `b2Body.SetType`.
    pub fn set_type(&mut self, body: BodyId, t: BodyType) {
        body::set_type(&mut self.store, body, t);
    }

    /// `b2Body.SetFixedRotation`.
    pub fn set_fixed_rotation(&mut self, body: BodyId, flag: bool) {
        body::set_fixed_rotation(&mut self.store, body, flag);
    }

    /// `b2Body.ResetMassData`.
    pub fn reset_mass_data(&mut self, body: BodyId) {
        body::reset_mass_data(&mut self.store, body);
    }

    /// `b2Body.SetAwake`.
    pub fn set_awake(&mut self, body: BodyId, flag: bool) {
        self.store.body_mut(body).set_awake(flag);
    }

    /// `b2World.Step(dt, velocityIterations, positionIterations)`.
    pub fn step(
        &mut self,
        dt: f64,
        velocity_iterations: i32,
        position_iterations: i32,
        listener: &mut dyn ContactListener,
    ) {
        if self.flags & E_NEW_FIXTURE != 0 {
            self.contact_manager.find_new_contacts(&mut self.store);
            self.flags &= !E_NEW_FIXTURE;
        }
        self.flags |= E_LOCKED;
        let ts = TimeStep {
            dt,
            inv_dt: if dt > 0.0 { 1.0 / dt } else { 0.0 },
            dt_ratio: self.inv_dt0 * dt,
            velocity_iterations,
            position_iterations,
            warm_starting: self.warm_starting,
        };
        self.contact_manager.collide(&mut self.store, listener);
        if ts.dt > 0.0 {
            self.solve(&ts, listener);
        }
        if self.continuous_physics && ts.dt > 0.0 {
            self.solve_toi(&ts, listener);
        }
        if ts.dt > 0.0 {
            self.inv_dt0 = ts.inv_dt;
        }
        self.flags &= !E_LOCKED;
    }

    /// A pair or contact limit was hit since the last [`World::reset`]: some
    /// collisions were skipped (identically on every peer). See
    /// [`crate::collision::broadphase::MAX_PAIRS`].
    pub fn overloaded(&self) -> bool {
        self.contact_manager.overloaded
    }

    /// `b2World.ClearForces`.
    pub fn clear_forces(&mut self) {
        for &id in self.bodies.iter() {
            let b = self.store.body_mut(id);
            b.force.set_zero();
            b.torque = 0.0;
        }
    }

    /// Body list in box2dweb order (reverse creation).
    pub fn bodies(&self) -> impl Iterator<Item = BodyId> + '_ {
        self.bodies.iter().rev().copied()
    }

    /// Joint list in box2dweb order (reverse creation).
    pub fn joints(&self) -> impl Iterator<Item = JointId> + '_ {
        self.joints.iter().rev().copied()
    }

    /// Contact list in box2dweb order (newest first).
    pub fn contacts(&self) -> impl Iterator<Item = ContactId> + '_ {
        self.contact_manager.contact_list.iter().rev().copied()
    }

    /// `b2World.QueryAABB(callback, aabb)`: callback returns false to stop.
    pub fn query_aabb<F>(&self, mut callback: F, aabb: AABB)
    where
        F: FnMut(&Store, FixtureId) -> bool,
    {
        let store = &self.store;
        self.contact_manager
            .broad_phase
            .query(&mut |fid: FixtureId| callback(store, fid), aabb);
    }

    /// `b2World.RayCast(callback, p1, p2)`. Callback returns box2dweb fraction semantics:
    /// -1 ignore fixture, 0 terminate, fraction clip ray, 1 continue.
    pub fn ray_cast<F>(&self, mut callback: F, p1: Vec2, p2: Vec2)
    where
        F: FnMut(&Store, FixtureId, Vec2, Vec2, f64) -> f64,
    {
        let store = &self.store;
        let mut output = RayCastOutput::default();
        let input = RayCastInput {
            p1,
            p2,
            max_fraction: 1.0,
        };
        self.contact_manager.broad_phase.ray_cast(
            &mut |sub: &RayCastInput, fid: FixtureId| {
                if fixture::ray_cast(store, fid, &mut output, sub) {
                    let p = output.fraction;
                    let point = Vec2::new((1.0 - p) * p1.x + p * p2.x, (1.0 - p) * p1.y + p * p2.y);
                    callback(store, fid, point, output.normal, p)
                } else {
                    sub.max_fraction
                }
            },
            input,
        );
    }
}
