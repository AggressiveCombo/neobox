# neobox-box2d public API (planned; keep in sync)

Crate `neobox_box2d`. All scalars `f64`. Names follow box2dweb in snake_case.
Handles are `Copy` newtypes over `u32` (`BodyId`, `FixtureId`, `JointId`, `ContactId`).
No `Rc`/`RefCell`. Listener and query callbacks receive `&Store` / `&mut Store`.

## Storage

```rust
pub struct Store { /* private: bodies, fixtures, joints, contacts arenas + intrusive list heads */ }
impl Store {
    pub fn body(&self, id: BodyId) -> &Body;
    pub fn body_mut(&mut self, id: BodyId) -> &mut Body;
    pub fn fixture(&self, id: FixtureId) -> &Fixture;
    pub fn fixture_mut(&mut self, id: FixtureId) -> &mut Fixture;
    pub fn joint(&self, id: JointId) -> &Joint;
    pub fn joint_mut(&mut self, id: JointId) -> &mut Joint;
    pub fn contact(&self, id: ContactId) -> &Contact;
    pub fn contact_mut(&mut self, id: ContactId) -> &mut Contact;
    /// box2dweb `b2Body.GetFixtureList` order (reverse creation).
    pub fn body_fixtures(&self, id: BodyId) -> impl Iterator<Item = FixtureId> + '_;
    /// box2dweb `b2Body.GetContactList` order.
    pub fn body_contacts(&self, id: BodyId) -> impl Iterator<Item = ContactId> + '_;
    /// `b2Contact.GetWorldManifold` (uses current body transforms).
    pub fn world_manifold(&self, id: ContactId) -> WorldManifold;
}
```

## World

```rust
pub struct World { /* private */ }
impl World {
    /// `new b2World(gravity, doSleep)`. Creates the ground body.
    pub fn new(gravity: Vec2, do_sleep: bool) -> World;
    /// `b2World.prototype.novakReset`: fresh contact manager/broadphase/solver/island,
    /// empty lists, new ground body. Keeps heap capacity.
    pub fn reset(&mut self);
    pub fn set_gravity(&mut self, g: Vec2);
    pub fn get_gravity(&self) -> Vec2;
    /// `b2World.m_warmStarting` (a static in box2dweb; per world here so
    /// worlds on different threads never interfere). `new` sets it true.
    pub fn set_warm_starting(&mut self, flag: bool);
    pub fn get_warm_starting(&self) -> bool;
    /// `b2World.m_continuousPhysics` (static in box2dweb). `new` and `reset`
    /// set it true.
    pub fn set_continuous_physics(&mut self, flag: bool);
    pub fn store(&self) -> &Store;
    pub fn store_mut(&mut self) -> &mut Store;
    pub fn get_ground_body(&self) -> BodyId;
    pub fn body_count(&self) -> usize;
    pub fn joint_count(&self) -> usize;
    pub fn contact_count(&self) -> usize;
    /// `b2World.CreateBody`.
    pub fn create_body(&mut self, def: &BodyDef) -> BodyId;
    /// Destroying a body/fixture/joint may emit EndContact (box2dweb `DestroyBody` -> `DestroyContact`).
    /// The listener is a per-call parameter so the game can borrow its own state during the call.
    /// `destroy_body`/`destroy_fixture` do nothing while the world is stepping (box2dweb lock).
    pub fn destroy_body(&mut self, id: BodyId, listener: &mut dyn ContactListener);
    /// `b2Body.CreateFixture`; sets the world's new-fixture flag (next `step` runs `find_new_contacts`).
    pub fn create_fixture(&mut self, body: BodyId, def: &FixtureDef) -> FixtureId;
    pub fn destroy_fixture(&mut self, id: FixtureId, listener: &mut dyn ContactListener);
    pub fn create_joint(&mut self, def: &JointDef) -> JointId;
    /// box2dweb `DestroyJoint` emits no listener callback; the listener parameter is unused.
    pub fn destroy_joint(&mut self, id: JointId, listener: &mut dyn ContactListener);
    /// Body-level wrappers that need the world (contact manager / flags).
    pub fn set_position(&mut self, body: BodyId, p: Vec2);
    pub fn set_angle(&mut self, body: BodyId, angle: f64);
    pub fn set_position_and_angle(&mut self, body: BodyId, p: Vec2, angle: f64);
    pub fn set_active(&mut self, body: BodyId, flag: bool, listener: &mut dyn ContactListener);
    pub fn set_type(&mut self, body: BodyId, t: BodyType);
    pub fn set_fixed_rotation(&mut self, body: BodyId, flag: bool);
    pub fn reset_mass_data(&mut self, body: BodyId);
    pub fn set_awake(&mut self, body: BodyId, flag: bool);
    /// `b2World.Step(dt, velocityIterations, positionIterations)`.
    pub fn step(&mut self, dt: f64, velocity_iterations: i32, position_iterations: i32, listener: &mut dyn ContactListener);
    pub fn clear_forces(&mut self);
    /// Body list in box2dweb order (reverse creation).
    pub fn bodies(&self) -> impl Iterator<Item = BodyId> + '_;
    /// Joint list in box2dweb order (reverse creation).
    pub fn joints(&self) -> impl Iterator<Item = JointId> + '_;
    /// Contact list in box2dweb order (newest first).
    pub fn contacts(&self) -> impl Iterator<Item = ContactId> + '_;
    /// `b2World.RayCast(callback, p1, p2)`. Callback returns box2dweb fraction semantics:
    /// -1 ignore fixture, 0 terminate, fraction clip ray, 1 continue.
    pub fn ray_cast<F>(&self, callback: F, p1: Vec2, p2: Vec2)
    where F: FnMut(&Store, FixtureId, Vec2 /*point*/, Vec2 /*normal*/, f64 /*fraction*/) -> f64;
    /// `b2World.QueryAABB(callback, aabb)`: callback returns false to stop.
    pub fn query_aabb<F>(&self, callback: F, aabb: AABB)
    where F: FnMut(&Store, FixtureId) -> bool;
}
```


## Listener

```rust
pub trait ContactListener {
    fn begin_contact(&mut self, store: &mut Store, contact: ContactId) {}
    fn end_contact(&mut self, store: &mut Store, contact: ContactId) {}
    fn pre_solve(&mut self, store: &mut Store, contact: ContactId, old_manifold: &Manifold) {}
    fn post_solve(&mut self, store: &mut Store, contact: ContactId, impulse: &ContactImpulse) {}
}
/// Convenience no-op listener (box2dweb with no listener set).
pub struct NoListener;
impl ContactListener for NoListener {}
pub struct ContactImpulse { pub normal_impulses: [f64; 2], pub tangent_impulses: [f64; 2] }
```

`contact.set_enabled(false)` is `store.contact_mut(id).set_enabled(false)`.
`body.GetLinearVelocity().y = v` is `store.body_mut(b).set_linear_velocity(Vec2 { x, y: v })`.

## Definitions

```rust
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BodyType { Static, Kinematic, Dynamic }

#[derive(Clone, Copy, Debug)]
pub struct Filter { pub category_bits: u16, pub mask_bits: u16, pub group_index: i16 } // default 1, 0xFFFF, 0

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
} // impl Default = box2dweb b2BodyDef defaults

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
```

### Shapes

```rust
pub enum Shape { Circle(CircleShape), Polygon(PolygonShape) }
impl CircleShape {
    pub fn new(radius: f64) -> CircleShape;
    pub fn set_local_position(&mut self, p: Vec2);
    pub fn get_radius(&self) -> f64;
}
impl PolygonShape {
    pub fn new() -> PolygonShape;
    pub fn set_as_box(&mut self, hx: f64, hy: f64);
    pub fn set_as_oriented_box(&mut self, hx: f64, hy: f64, center: Vec2, angle: f64);
    pub fn set_as_array(&mut self, points: &[Vec2]);
    pub fn get_vertex_count(&self) -> usize;
    pub fn get_vertices(&self) -> &[Vec2];
    pub fn get_normals(&self) -> &[Vec2];
}
pub struct MassData { pub mass: f64, pub center: Vec2, pub i: f64 }
```

## Body

```rust
pub struct Body { /* private */ }
impl Body {
    pub fn get_type(&self) -> BodyType;
    pub fn get_position(&self) -> Vec2;
    pub fn set_position(&mut self, p: Vec2);
    pub fn get_angle(&self) -> f64;
    pub fn set_angle(&mut self, a: f64);
    pub fn get_world_center(&self) -> Vec2;
    pub fn get_local_center(&self) -> Vec2;
    pub fn get_linear_velocity(&self) -> Vec2;
    pub fn set_linear_velocity(&mut self, v: Vec2);
    pub fn get_angular_velocity(&self) -> f64;
    pub fn set_angular_velocity(&mut self, w: f64);
    pub fn get_linear_damping(&self) -> f64;
    pub fn set_linear_damping(&mut self, d: f64);
    pub fn get_angular_damping(&self) -> f64;
    pub fn set_angular_damping(&mut self, d: f64);
    pub fn apply_force(&mut self, force: Vec2, point: Vec2);
    pub fn apply_impulse(&mut self, impulse: Vec2, point: Vec2);
    pub fn apply_torque(&mut self, torque: f64);
    pub fn get_mass(&self) -> f64;
    pub fn get_inertia(&self) -> f64;
    pub fn get_mass_data(&self) -> MassData;
    pub fn set_mass_data(&mut self, data: &MassData);
    pub fn reset_mass_data(&mut self);
    pub fn set_fixed_rotation(&mut self, flag: bool);
    pub fn is_fixed_rotation(&self) -> bool;
    pub fn set_bullet(&mut self, flag: bool);
    pub fn is_bullet(&self) -> bool;
    pub fn set_awake(&mut self, flag: bool);
    pub fn is_awake(&self) -> bool;
    pub fn is_active(&self) -> bool;
    pub fn get_world_point(&self, local: Vec2) -> Vec2;
    pub fn get_local_point(&self, world: Vec2) -> Vec2;
    pub fn get_world_vector(&self, local: Vec2) -> Vec2;
    pub fn get_local_vector(&self, world: Vec2) -> Vec2;
    pub fn get_user_data(&self) -> u64;
    pub fn set_user_data(&mut self, tag: u64);
}
```

## Fixture

```rust
pub struct Fixture { /* private */ }
pub struct Filter { pub category_bits: u16, pub mask_bits: u16, pub group_index: i16 } // Default: 1, 0xFFFF, 0
impl Fixture {
    pub fn get_body(&self) -> BodyId;
    pub fn get_type(&self) -> ShapeType;
    pub fn get_shape(&self) -> &Shape;
    /// `b2Fixture.GetAABB`: the stored (tight, as synchronised) AABB.
    pub fn get_aabb(&self) -> AABB;
    pub fn is_sensor(&self) -> bool;
    pub fn get_density(&self) -> f64;
    pub fn set_density(&mut self, d: f64);
    pub fn get_friction(&self) -> f64;
    pub fn set_friction(&mut self, f: f64);
    pub fn get_restitution(&self) -> f64;
    pub fn set_restitution(&mut self, r: f64);
    pub fn get_filter(&self) -> Filter;
    /// Copies the filter only (box2dweb does not flag contacts here).
    pub fn set_filter(&mut self, f: Filter);
    pub fn get_user_data(&self) -> u64;
    pub fn set_user_data(&mut self, tag: u64);
    pub fn get_mass_data(&self) -> MassData;
}
/// Store-based operations (need the owning body's transform or contact list).
pub fn set_sensor(store: &mut Store, id: FixtureId, flag: bool);
pub fn test_point(store: &Store, id: FixtureId, p: Vec2) -> bool;
pub fn ray_cast(store: &Store, id: FixtureId, output: &mut RayCastOutput, input: &RayCastInput) -> bool;
```

## Joints

```rust
pub enum JointDef { Distance(DistanceJointDef), Revolute(RevoluteJointDef), Prismatic(PrismaticJointDef) }
pub enum Joint { Distance(DistanceJoint), Revolute(RevoluteJoint), Prismatic(PrismaticJoint) }

pub struct DistanceJointDef { pub body_a: BodyId, pub body_b: BodyId, pub anchor_a: Vec2, pub anchor_b: Vec2,
    pub length: f64, pub frequency_hz: f64, pub damping_ratio: f64, pub collide_connected: bool, pub user_data: u64 }
impl DistanceJointDef { pub fn initialize(&mut self, b1: BodyId, b2: BodyId, anchor1: Vec2, anchor2: Vec2); }

pub struct RevoluteJointDef { pub body_a: BodyId, pub body_b: BodyId, pub local_anchor_a: Vec2, pub local_anchor_b: Vec2,
    pub reference_angle: f64, pub enable_limit: bool, pub lower_angle: f64, pub upper_angle: f64,
    pub enable_motor: bool, pub motor_speed: f64, pub max_motor_torque: f64, pub collide_connected: bool, pub user_data: u64 }
impl RevoluteJointDef { pub fn initialize(&mut self, b1: BodyId, b2: BodyId, anchor: Vec2); }

pub struct PrismaticJointDef { pub body_a: BodyId, pub body_b: BodyId, pub local_anchor_a: Vec2, pub local_anchor_b: Vec2,
    pub local_axis_a: Vec2, pub reference_angle: f64, pub enable_limit: bool, pub lower_translation: f64,
    pub upper_translation: f64, pub enable_motor: bool, pub max_motor_force: f64, pub motor_speed: f64,
    pub collide_connected: bool, pub user_data: u64 }
impl PrismaticJointDef { pub fn initialize(&mut self, b1: BodyId, b2: BodyId, anchor: Vec2, axis: Vec2); }

impl DistanceJoint {
    pub fn get_anchor_a(&self) -> Vec2; pub fn get_anchor_b(&self) -> Vec2;
    pub fn get_length(&self) -> f64; pub fn set_length(&mut self, l: f64);
    pub fn get_frequency(&self) -> f64; pub fn set_frequency(&mut self, hz: f64);
    pub fn get_damping_ratio(&self) -> f64; pub fn set_damping_ratio(&mut self, z: f64);
}
impl RevoluteJoint {
    pub fn get_joint_angle(&self, store: &Store) -> f64;
    pub fn get_joint_speed(&self, store: &Store) -> f64;
    pub fn get_motor_speed(&self) -> f64; pub fn set_motor_speed(&mut self, s: f64);
    pub fn get_motor_torque(&self) -> f64; pub fn set_max_motor_torque(&mut self, t: f64);
    pub fn is_motor_enabled(&self) -> bool; pub fn enable_motor(&mut self, flag: bool);
    pub fn get_lower_limit(&self) -> f64; pub fn get_upper_limit(&self) -> f64;
    pub fn set_limits(&mut self, lower: f64, upper: f64);
    pub fn enable_limit(&mut self, flag: bool);
}
impl PrismaticJoint {
    pub fn get_joint_translation(&self, store: &Store) -> f64;
    pub fn get_joint_speed(&self, store: &Store) -> f64;
    pub fn get_motor_speed(&self) -> f64; pub fn set_motor_speed(&mut self, s: f64);
    pub fn set_max_motor_force(&mut self, f: f64);
    pub fn get_motor_force(&self, inv_dt: f64) -> f64;
    pub fn get_lower_limit(&self) -> f64; pub fn get_upper_limit(&self) -> f64;
    pub fn set_limits(&mut self, lower: f64, upper: f64);
    pub fn enable_limit(&mut self, flag: bool);
    pub fn enable_motor(&mut self, flag: bool);
}
```

Joint accessors on `Store`: `store.joint(id)` returns `&Joint`; match on the enum, or
use `store.distance_joint(id)`, `store.revolute_joint(id)`, `store.prismatic_joint(id)`
(panic on type mismatch).

## Contact

```rust
pub struct Contact { /* private */ }
impl Contact {
    pub fn get_fixture_a(&self) -> FixtureId;
    pub fn get_fixture_b(&self) -> FixtureId;
    pub fn get_manifold(&self) -> &Manifold;
    pub fn is_touching(&self) -> bool;
    pub fn is_enabled(&self) -> bool;
    pub fn set_enabled(&mut self, flag: bool);
}

pub struct WorldManifold { pub normal: Vec2, pub points: [Vec2; 2], pub separations: [f64; 2] }
```

## Math (`neobox_box2d::math`)

Plain value types (`Copy`, `Default`, `PartialEq`), box2dweb formulas kept verbatim.

```rust
pub struct Vec2 { pub x: f64, pub y: f64 }
pub struct Vec3 { pub x: f64, pub y: f64, pub z: f64 }
pub struct Mat22 { pub col1: Vec2, pub col2: Vec2 }
pub struct Mat33 { pub col1: Vec3, pub col2: Vec3, pub col3: Vec3 }
pub struct Transform { pub position: Vec2, pub r: Mat22 }
pub struct Sweep { /* local_center, c0, c, a0, a, t0 */ }

impl Vec2 {
    pub fn new(x: f64, y: f64) -> Vec2;            // (to add) = b2Vec2 constructor
    pub fn length(&self) -> f64;                   // Math.sqrt(x*x + y*y)
    pub fn length_squared(&self) -> f64;
    pub fn normalize(&mut self) -> f64;            // divides by length (if > MIN_VALUE); returns length
    pub fn add(&mut self, v: Vec2);
    pub fn subtract(&mut self, v: Vec2);
    pub fn multiply(&mut self, s: f64);
    pub fn set(&mut self, x: f64, y: f64);
    pub fn set_v(&mut self, v: Vec2);
    pub fn set_zero(&mut self);
    pub fn negative_self(&mut self);
    pub fn copy(&self) -> Vec2;
    pub fn is_valid(&self) -> bool;
}
pub fn dot(a: Vec2, b: Vec2) -> f64;
pub fn cross_vv(a: Vec2, b: Vec2) -> f64;
pub fn mul_mv(m: &Mat22, v: Vec2) -> Vec2;     // b2Math.MulMV
pub fn mul_tmv(m: &Mat22, v: Vec2) -> Vec2;    // b2Math.MulTMV
pub fn mul_x(t: &Transform, v: Vec2) -> Vec2;  // b2Math.MulX
pub fn mul_xt(t: &Transform, v: Vec2) -> Vec2; // b2Math.MulXT
pub fn distance(a: Vec2, b: Vec2) -> f64;
pub fn js_round(x: f64) -> f64;
pub fn js_min(a: f64, b: f64) -> f64;
pub fn js_max(a: f64, b: f64) -> f64;
```

AABB (`neobox_box2d::collision::aabb::AABB`): `combine(a, b) -> AABB` (static, `b2AABB.Combine`),
`combine_from(&mut self, a, b)` (instance `Combine`), `contains`, `test_overlap`, `ray_cast`,
`get_center`, `get_extents`, `is_valid`.

## Settings

`neobox_box2d::common::settings` holds the `b2Settings` constants (`LINEAR_SLOP`, `ANGULAR_SLOP`,
`TOI_SLOP`, `AABB_EXTENSION`, ...). `b2_polygonRadius` is absent: the archive evaluates it as NaN
(`2 * undefined`), and it is never used.

## Known box2dweb quirks preserved / omitted

- `b2_polygonRadius`: NaN in the archive, not exported.
- `SafeTrig.safeSin/safeCos` (round to 1e-7) used only in `b2Mat22.Set`.
- `Math.pow` buoyancy (`b2CircleShape.ComputeSubmergedArea`, `b2PolygonShape.ComputeSubmergedArea`): omitted, unused by the game.
- `SafeATan2`/`SafeTan` are undefined in the archive (throws `TypeError`) in `b2Mat22.GetAngle`, `b2Transform.GetAngle`, and chain-edge connection: omitted.
- `b2WorldManifold` / `Contact.GetWorldManifold` depend on current body transforms, not on sweeps.
