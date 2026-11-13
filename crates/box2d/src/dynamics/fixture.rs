//! `b2Fixture`, `b2FixtureDef` and `b2FilterData` (box2dweb Dynamics).
//!
//! Operations that only touch the fixture are inherent methods. Operations
//! that need the owning body's transform or its contact list take `&Store`
//! or `&mut Store` as free functions, matching `body.rs`.

use crate::collision::aabb::{AABB, RayCastInput, RayCastOutput};
use crate::collision::broadphase::BroadPhase;
use crate::collision::shapes::{MassData, Shape, ShapeType};
use crate::common::math::{Transform, Vec2, subtract_vv};
use crate::dynamics::contact::Contact;
use crate::dynamics::store::Store;
use crate::ids::{BodyId, FixtureId};

/// `b2FilterData`. Defaults: category 1, mask 0xFFFF, group 0.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Filter {
    pub category_bits: u16,
    pub mask_bits: u16,
    pub group_index: i16,
}

impl Default for Filter {
    fn default() -> Self {
        Filter {
            category_bits: 1,
            mask_bits: 0xFFFF,
            group_index: 0,
        }
    }
}

/// `b2FixtureDef`. Use [`FixtureDef::new`] for the box2dweb defaults.
#[derive(Clone, Debug)]
pub struct FixtureDef {
    pub shape: Shape,
    pub density: f64,
    pub friction: f64,
    pub restitution: f64,
    pub is_sensor: bool,
    pub filter: Filter,
    pub user_data: u64,
}

impl FixtureDef {
    /// `new b2FixtureDef()` with `shape` set: friction 0.2, restitution 0,
    /// density 0, default filter, not a sensor, user data 0.
    pub fn new(shape: Shape) -> Self {
        FixtureDef {
            shape,
            density: 0.0,
            friction: 0.2,
            restitution: 0.0,
            is_sensor: false,
            filter: Filter::default(),
            user_data: 0,
        }
    }
}

/// `b2Fixture`. Lives in `Store::fixtures`; the owning body keeps its id in
/// `fixture_list`.
#[derive(Debug)]
pub struct Fixture {
    pub(crate) shape: Shape,
    pub(crate) body: BodyId,
    pub(crate) density: f64,
    pub(crate) friction: f64,
    pub(crate) restitution: f64,
    pub(crate) is_sensor: bool,
    pub(crate) filter: Filter,
    /// `m_proxy`: broad-phase proxy id, `None` when no proxy exists.
    pub(crate) proxy_id: Option<u32>,
    /// `m_aabb`: the AABB last given to the broad phase.
    pub(crate) aabb: AABB,
    pub(crate) user_tag: u64,
}

impl Fixture {
    /// `b2Fixture.prototype.Create(body, def)`. Copies the definition; box2dweb's
    /// `Create` ignores the transform argument, so none is taken here.
    pub fn new(body: BodyId, def: &FixtureDef) -> Fixture {
        Fixture {
            shape: def.shape.clone(),
            body,
            density: def.density,
            friction: def.friction,
            restitution: def.restitution,
            is_sensor: def.is_sensor,
            filter: def.filter,
            proxy_id: None,
            aabb: AABB::new(),
            user_tag: def.user_data,
        }
    }

    /// `b2Fixture.prototype.GetType`.
    pub fn get_type(&self) -> ShapeType {
        self.shape.shape_type()
    }

    /// `b2Fixture.prototype.GetShape`.
    pub fn get_shape(&self) -> &Shape {
        &self.shape
    }

    /// `b2Fixture.prototype.GetBody`.
    pub fn get_body(&self) -> BodyId {
        self.body
    }

    /// `b2Fixture.prototype.GetAABB`: the AABB last given to the broad phase.
    pub fn get_aabb(&self) -> AABB {
        self.aabb
    }

    /// `b2Fixture.prototype.IsSensor`.
    pub fn is_sensor(&self) -> bool {
        self.is_sensor
    }

    /// `b2Fixture.prototype.GetDensity`.
    pub fn get_density(&self) -> f64 {
        self.density
    }

    /// `b2Fixture.prototype.SetDensity`. Does not reset the body's mass.
    pub fn set_density(&mut self, density: f64) {
        self.density = density;
    }

    /// `b2Fixture.prototype.GetFriction`.
    pub fn get_friction(&self) -> f64 {
        self.friction
    }

    /// `b2Fixture.prototype.SetFriction`.
    pub fn set_friction(&mut self, friction: f64) {
        self.friction = friction;
    }

    /// `b2Fixture.prototype.GetRestitution`.
    pub fn get_restitution(&self) -> f64 {
        self.restitution
    }

    /// `b2Fixture.prototype.SetRestitution`.
    pub fn set_restitution(&mut self, restitution: f64) {
        self.restitution = restitution;
    }

    /// `b2Fixture.prototype.GetFilterData`.
    pub fn get_filter(&self) -> Filter {
        self.filter
    }

    /// `b2Fixture.prototype.SetFilterData`: copies the filter only.
    ///
    /// The archived box2dweb tests `!this.m_body` before walking the contact
    /// list, so attached fixtures never flag their contacts for filtering.
    /// That behaviour is reproduced here.
    pub fn set_filter(&mut self, filter: Filter) {
        self.filter = filter;
    }

    /// `b2Fixture.prototype.GetUserData`.
    pub fn get_user_data(&self) -> u64 {
        self.user_tag
    }

    /// `b2Fixture.prototype.SetUserData`.
    pub fn set_user_data(&mut self, tag: u64) {
        self.user_tag = tag;
    }

    /// `b2Fixture.prototype.GetMassData`: mass data at the stored density.
    pub fn get_mass_data(&self) -> MassData {
        self.shape.compute_mass(self.density)
    }

    /// `b2Fixture.prototype.CreateProxy(broadPhase, xf)`.
    pub fn create_proxy(&mut self, bp: &mut BroadPhase, xf: &Transform, id: FixtureId) {
        self.shape.compute_aabb(&mut self.aabb, xf);
        self.proxy_id = Some(bp.create_proxy(self.aabb, id));
    }

    /// `b2Fixture.prototype.DestroyProxy(broadPhase)`.
    pub fn destroy_proxy(&mut self, bp: &mut BroadPhase) {
        if let Some(proxy) = self.proxy_id.take() {
            bp.destroy_proxy(proxy);
        }
    }

    /// `b2Fixture.prototype.Synchronize(broadPhase, xf1, xf2)`: refreshes the
    /// swept AABB and moves the proxy by the displacement `xf2.p - xf1.p`.
    pub fn synchronize(&mut self, bp: &mut BroadPhase, xf1: &Transform, xf2: &Transform) {
        let Some(proxy) = self.proxy_id else {
            return;
        };
        let mut s = AABB::new();
        let mut r = AABB::new();
        self.shape.compute_aabb(&mut s, xf1);
        self.shape.compute_aabb(&mut r, xf2);
        self.aabb.combine_from(&s, &r);
        let displacement = subtract_vv(xf2.position, xf1.position);
        bp.move_proxy(proxy, self.aabb, displacement);
    }
}

/// `b2Fixture.prototype.SetSensor`. When the flag changes, every contact on
/// the owning body that involves this fixture takes the new sensor state
/// `fixtureA.IsSensor() || fixtureB.IsSensor()`.
pub fn set_sensor(store: &mut Store, id: FixtureId, flag: bool) {
    if store.fixture(id).is_sensor == flag {
        return;
    }
    store.fixture_mut(id).is_sensor = flag;
    let body = store.fixture(id).body;
    let n = store.body(body).contact_list.len();
    for i in (0..n).rev() {
        let cid = store.body(body).contact_list[i];
        let (fa, fb) = {
            let c = store.contact(cid);
            (c.fixture_a, c.fixture_b)
        };
        if fa == id || fb == id {
            let sensor = store.fixture(fa).is_sensor || store.fixture(fb).is_sensor;
            let c = store.contact_mut(cid);
            if sensor {
                c.flags |= Contact::SENSOR_FLAG;
            } else {
                c.flags &= !Contact::SENSOR_FLAG;
            }
        }
    }
}

/// `b2Fixture.prototype.TestPoint(p)`, using the owning body's transform.
pub fn test_point(store: &Store, id: FixtureId, p: Vec2) -> bool {
    let f = store.fixture(id);
    f.shape.test_point(store.body(f.body).get_transform(), p)
}

/// `b2Fixture.prototype.RayCast(output, input)`, using the owning body's
/// transform.
pub fn ray_cast(store: &Store, id: FixtureId, output: &mut RayCastOutput, input: &RayCastInput) -> bool {
    let f = store.fixture(id);
    f.shape.ray_cast(output, input, store.body(f.body).get_transform())
}
