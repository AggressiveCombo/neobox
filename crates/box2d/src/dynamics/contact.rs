//! `b2Contact` (box2dweb `Box2D.Dynamics.Contacts.b2Contact`). The circle,
//! polygon and polygon-vs-circle specializations are one type here; the
//! evaluator is chosen from the shape kinds of the two fixtures.

use crate::collision::collide::{collide_circles, collide_polygon_and_circle, collide_polygons};
use crate::collision::distance::{DistanceInput, DistanceOutput, DistanceProxy, SimplexCache, distance};
use crate::collision::manifold::{Manifold, WorldManifold};
use crate::collision::shapes::Shape;
use crate::collision::toi::{TOIInput, TOIOutput, time_of_impact};
use crate::common::math::{MIN_VALUE, Sweep, Transform};
use crate::common::settings::LINEAR_SLOP;
use crate::dynamics::store::Store;
use crate::ids::{BodyId, ContactId, FixtureId};

/// `b2ContactImpulse`: per-point impulses reported to `post_solve`.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct ContactImpulse {
    pub normal_impulses: [f64; 2],
    pub tangent_impulses: [f64; 2],
}

/// `b2ContactListener`. Default methods are no-ops.
pub trait ContactListener {
    fn begin_contact(&mut self, _store: &mut Store, _contact: ContactId) {}
    fn end_contact(&mut self, _store: &mut Store, _contact: ContactId) {}
    fn pre_solve(&mut self, _store: &mut Store, _contact: ContactId, _old_manifold: &Manifold) {}
    fn post_solve(&mut self, _store: &mut Store, _contact: ContactId, _impulse: &ContactImpulse) {}
}

/// Listener that ignores every callback.
#[derive(Clone, Copy, Debug, Default)]
pub struct NoListener;

impl ContactListener for NoListener {}

/// `b2Contact`.
#[derive(Clone, Debug)]
pub struct Contact {
    pub(crate) flags: u16,
    pub(crate) fixture_a: FixtureId,
    pub(crate) fixture_b: FixtureId,
    pub(crate) manifold: Manifold,
    pub(crate) old_manifold: Manifold,
    pub(crate) toi: f64,
}

fn set_flag(flags: &mut u16, bit: u16, on: bool) {
    if on {
        *flags |= bit;
    } else {
        *flags &= !bit;
    }
}

impl Contact {
    pub(crate) const SENSOR_FLAG: u16 = 0x0001;
    pub(crate) const CONTINUOUS_FLAG: u16 = 0x0002;
    pub(crate) const ISLAND_FLAG: u16 = 0x0004;
    pub(crate) const TOI_FLAG: u16 = 0x0008;
    pub(crate) const TOUCHING_FLAG: u16 = 0x0010;
    pub(crate) const ENABLED_FLAG: u16 = 0x0020;
    pub(crate) const FILTER_FLAG: u16 = 0x0040;

    pub fn get_fixture_a(&self) -> FixtureId {
        self.fixture_a
    }

    pub fn get_fixture_b(&self) -> FixtureId {
        self.fixture_b
    }

    pub fn get_manifold(&self) -> &Manifold {
        &self.manifold
    }

    pub fn is_touching(&self) -> bool {
        self.flags & Self::TOUCHING_FLAG != 0
    }

    pub fn is_enabled(&self) -> bool {
        self.flags & Self::ENABLED_FLAG != 0
    }

    pub fn set_enabled(&mut self, flag: bool) {
        set_flag(&mut self.flags, Self::ENABLED_FLAG, flag);
    }

    pub(crate) fn is_sensor(&self) -> bool {
        self.flags & Self::SENSOR_FLAG != 0
    }

    pub(crate) fn is_continuous(&self) -> bool {
        self.flags & Self::CONTINUOUS_FLAG != 0
    }

    pub fn flag_for_filtering(&mut self) {
        self.flags |= Self::FILTER_FLAG;
    }
}

/// `b2Contact.Reset` plus the factory's create/register selection. The
/// circle/polygon pair is reordered so the polygon is always fixture A
/// (box2dweb's non-primary register swap).
pub fn create(store: &mut Store, fixture_a: FixtureId, fixture_b: FixtureId) -> ContactId {
    let swap = matches!(store.fixture(fixture_a).shape, Shape::Circle(_))
        && matches!(store.fixture(fixture_b).shape, Shape::Polygon(_));
    let (fa, fb) = if swap {
        (fixture_b, fixture_a)
    } else {
        (fixture_a, fixture_b)
    };
    let fix_a = store.fixture(fa);
    let fix_b = store.fixture(fb);
    let body_a = store.body(fix_a.body);
    let body_b = store.body(fix_b.body);

    // `Reset`: m_flags = e_enabledFlag
    let mut flags = Contact::ENABLED_FLAG;
    if fix_a.is_sensor || fix_b.is_sensor {
        flags |= Contact::SENSOR_FLAG;
    }
    if !body_a.is_dynamic() || body_a.is_bullet() || !body_b.is_dynamic() || body_b.is_bullet() {
        flags |= Contact::CONTINUOUS_FLAG;
    }

    // `b2ContactFactory.Create`: reuse a pooled contact (its manifolds keep
    // their old contents), then `Reset` (only the point count is cleared).
    // A circle-polygon request looks in the circle-polygon register, whose
    // pool is never filled (destroyed contacts go to polygon-circle).
    let pooled = if swap { None } else { store.contact_pool[pool_index(&fix_a.shape, &fix_b.shape)].pop() };
    let contact = match pooled {
        Some(mut c) => {
            c.flags = flags;
            c.fixture_a = fa;
            c.fixture_b = fb;
            c.manifold.point_count = 0;
            c
        }
        None => Contact {
            flags,
            fixture_a: fa,
            fixture_b: fb,
            manifold: Manifold::default(),
            old_manifold: Manifold::default(),
            toi: 0.0,
        },
    };
    ContactId(store.contacts.insert(contact))
}

/// Register pool of a (post-swap) shape pair.
fn pool_index(a: &Shape, b: &Shape) -> usize {
    match (a, b) {
        (Shape::Circle(_), _) => 0,
        (Shape::Polygon(_), Shape::Circle(_)) => 1,
        (Shape::Polygon(_), Shape::Polygon(_)) => 2,
    }
}

/// `b2ContactFactory.Destroy`: wakes both bodies if the contact was touching,
/// then returns the contact to its register pool.
pub fn destroy(store: &mut Store, id: ContactId) {
    let c = store.contact(id);
    if c.manifold.point_count > 0 {
        let body_a = store.fixture(c.fixture_a).body;
        let body_b = store.fixture(c.fixture_b).body;
        store.body_mut(body_a).set_awake(true);
        store.body_mut(body_b).set_awake(true);
    }
    let pool = pool_index(&store.fixture(store.contact(id).fixture_a).shape, &store.fixture(store.contact(id).fixture_b).shape);
    let c = store.contacts.remove(id.0);
    store.contact_pool[pool].push(c);
}

/// `b2Contact.Evaluate` dispatched on the shape pair. The polygon is always
/// fixture A for a circle/polygon contact, so the circle-first pairing is
/// unreachable.
fn evaluate(manifold: &mut Manifold, shape_a: &Shape, xf_a: &Transform, shape_b: &Shape, xf_b: &Transform) {
    match (shape_a, shape_b) {
        (Shape::Circle(a), Shape::Circle(b)) => collide_circles(manifold, a, xf_a, b, xf_b),
        (Shape::Polygon(a), Shape::Circle(b)) => {
            collide_polygon_and_circle(manifold, a, xf_a, b, xf_b)
        }
        (Shape::Polygon(a), Shape::Polygon(b)) => collide_polygons(manifold, a, xf_a, b, xf_b),
        (Shape::Circle(_), Shape::Polygon(_)) => {}
    }
}

/// `b2Shape.TestOverlap`: distance query with radii; overlapping when the
/// distance is effectively zero.
fn shapes_overlap(shape_a: &Shape, xf_a: &Transform, shape_b: &Shape, xf_b: &Transform) -> bool {
    let proxy_a = DistanceProxy::new(shape_a);
    let proxy_b = DistanceProxy::new(shape_b);
    let input = DistanceInput {
        proxy_a: &proxy_a,
        proxy_b: &proxy_b,
        transform_a: xf_a,
        transform_b: xf_b,
        use_radii: true,
    };
    let mut cache = SimplexCache::default();
    let mut out = DistanceOutput::default();
    distance(&mut out, &mut cache, &input);
    out.distance < 10.0 * MIN_VALUE
}

/// `b2Contact.Update` without the callbacks. Returns `(was_touching,
/// touching, sensor, wake)` where `wake` names the two bodies to wake when
/// touching changed.
fn refresh(store: &mut Store, id: ContactId) -> (bool, bool, bool, Option<(BodyId, BodyId)>) {
    let Store {
        bodies,
        fixtures,
        contacts,
        ..
    } = store;
    let c = contacts.get_mut(id.0);
    std::mem::swap(&mut c.manifold, &mut c.old_manifold);
    c.flags |= Contact::ENABLED_FLAG;

    let was_touching = c.is_touching();
    let sensor = c.is_sensor();
    let fa = fixtures.get(c.fixture_a.0);
    let fb = fixtures.get(c.fixture_b.0);
    let (body_a, body_b) = (fa.body, fb.body);
    let ba = bodies.get(body_a.0);
    let bb = bodies.get(body_b.0);
    let aabb_overlap = fa.aabb.test_overlap(&fb.aabb);

    let mut touching = false;
    let mut wake = None;
    if sensor {
        if aabb_overlap {
            touching = shapes_overlap(&fa.shape, &ba.xf, &fb.shape, &bb.xf);
        }
        c.manifold.point_count = 0;
    } else {
        if !ba.is_dynamic() || ba.is_bullet() || !bb.is_dynamic() || bb.is_bullet() {
            c.flags |= Contact::CONTINUOUS_FLAG;
        } else {
            c.flags &= !Contact::CONTINUOUS_FLAG;
        }
        if aabb_overlap {
            evaluate(&mut c.manifold, &fa.shape, &ba.xf, &fb.shape, &bb.xf);
            touching = c.manifold.point_count > 0;
            let old = &c.old_manifold;
            let new = &mut c.manifold;
            for p in new.points[..new.point_count].iter_mut() {
                p.normal_impulse = 0.0;
                p.tangent_impulse = 0.0;
                if let Some(o) = old.points[..old.point_count]
                    .iter()
                    .find(|o| o.id.key == p.id.key)
                {
                    p.normal_impulse = o.normal_impulse;
                    p.tangent_impulse = o.tangent_impulse;
                }
            }
        } else {
            c.manifold.point_count = 0;
        }
        if touching != was_touching {
            wake = Some((body_a, body_b));
        }
    }
    set_flag(&mut c.flags, Contact::TOUCHING_FLAG, touching);
    (was_touching, touching, sensor, wake)
}

/// `b2Contact.Update`: refreshes the manifold and fires begin/end/pre-solve.
pub fn update(store: &mut Store, id: ContactId, listener: &mut dyn ContactListener) {
    let (was_touching, touching, sensor, wake) = refresh(store, id);
    if let Some((a, b)) = wake {
        store.body_mut(a).set_awake(true);
        store.body_mut(b).set_awake(true);
    }
    if !was_touching && touching {
        listener.begin_contact(store, id);
    }
    if was_touching && !touching {
        listener.end_contact(store, id);
    }
    if !sensor {
        let old = store.contact(id).old_manifold;
        listener.pre_solve(store, id, &old);
    }
}

/// `b2Contact.GetWorldManifold` using the current body transforms.
pub fn world_manifold(store: &Store, id: ContactId) -> WorldManifold {
    let c = store.contact(id);
    let fa = store.fixture(c.fixture_a);
    let fb = store.fixture(c.fixture_b);
    let mut wm = WorldManifold::default();
    wm.initialize(
        &c.manifold,
        &store.body(fa.body).xf,
        fa.shape.radius(),
        &store.body(fb.body).xf,
        fb.shape.radius(),
    );
    wm
}

/// `b2Contact.ComputeTOI`: time of impact of the two fixtures over the given
/// sweeps, returned as the fraction `t`.
pub fn compute_toi(store: &Store, id: ContactId, sweep_a: &Sweep, sweep_b: &Sweep) -> f64 {
    let c = store.contact(id);
    let proxy_a = DistanceProxy::new(&store.fixture(c.fixture_a).shape);
    let proxy_b = DistanceProxy::new(&store.fixture(c.fixture_b).shape);
    let input = TOIInput {
        proxy_a: &proxy_a,
        proxy_b: &proxy_b,
        sweep_a: *sweep_a,
        sweep_b: *sweep_b,
        tolerance: LINEAR_SLOP,
    };
    let mut out = TOIOutput::default();
    time_of_impact(&mut out, &input);
    out.t
}
