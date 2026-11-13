//! Bit-exact Rust port of the archived, patched Box2DFlash 2.1a (box2dweb)
//! library the Hitbox.io client runs.
//!
//! Every floating-point expression keeps the operation order of the JavaScript
//! source, every transcendental function comes from `libm`, and every
//! container iterates in the same order as the intrusive lists of the original.
//! Results are therefore identical on native and `wasm32-unknown-unknown`.
//!
//! Storage is arena-based: bodies, fixtures, joints and contacts live in a
//! [`dynamics::Store`] and are referred to by the copyable handles in
//! [`ids`]. Listener callbacks receive `&mut Store`, so no `RefCell` is needed.

pub mod arena;
pub mod collision;
pub mod common;
pub mod dynamics;
pub mod ids;

pub use collision::aabb::AABB;
pub use collision::manifold::{Manifold, WorldManifold};
pub use collision::shapes::{CircleShape, PolygonShape, Shape};
pub use common::math;
pub use dynamics::body::{BodyDef, BodyType};
pub use dynamics::fixture::{Filter, FixtureDef};
pub use dynamics::joints::{DistanceJointDef, Joint, JointDef, PrismaticJointDef, RevoluteJointDef};
pub use dynamics::world::{ContactImpulse, ContactListener, NoListener, World};
pub use dynamics::Store;
pub use ids::{BodyId, ContactId, FixtureId, JointId};
