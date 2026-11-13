//! Arena storage shared by the world, contacts, islands and joints.
//!
//! Callbacks (listener, ray cast, query) receive `&Store`/`&mut Store`, so
//! game code can look up any body/fixture/contact by handle without `RefCell`.

use crate::arena::Arena;
use crate::dynamics::body::Body;
use crate::dynamics::contact::Contact;
use crate::dynamics::fixture::Fixture;
use crate::dynamics::joints::Joint;
use crate::ids::{BodyId, ContactId, FixtureId, JointId};

#[derive(Debug, Default)]
pub struct Store {
    pub bodies: Arena<Body>,
    pub fixtures: Arena<Fixture>,
    pub contacts: Arena<Contact>,
    pub joints: Arena<Joint>,
    /// `b2ContactFactory` register pools (circle-circle, polygon-circle,
    /// polygon-polygon): destroyed contacts are reused newest-first and keep
    /// their stale manifold data, exactly like box2dweb.
    pub(crate) contact_pool: [Vec<Contact>; 3],
}

impl Store {
    pub fn new() -> Self {
        Self::default()
    }

    #[inline]
    pub fn body(&self, id: BodyId) -> &Body {
        self.bodies.get(id.0)
    }

    #[inline]
    pub fn body_mut(&mut self, id: BodyId) -> &mut Body {
        self.bodies.get_mut(id.0)
    }

    #[inline]
    pub fn fixture(&self, id: FixtureId) -> &Fixture {
        self.fixtures.get(id.0)
    }

    #[inline]
    pub fn fixture_mut(&mut self, id: FixtureId) -> &mut Fixture {
        self.fixtures.get_mut(id.0)
    }

    #[inline]
    pub fn contact(&self, id: ContactId) -> &Contact {
        self.contacts.get(id.0)
    }

    #[inline]
    pub fn contact_mut(&mut self, id: ContactId) -> &mut Contact {
        self.contacts.get_mut(id.0)
    }

    #[inline]
    pub fn joint(&self, id: JointId) -> &Joint {
        self.joints.get(id.0)
    }

    #[inline]
    pub fn joint_mut(&mut self, id: JointId) -> &mut Joint {
        self.joints.get_mut(id.0)
    }
}
