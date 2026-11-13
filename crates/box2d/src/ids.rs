//! Copyable arena handles. Indices are stable for the lifetime of the object
//! and are recycled after destruction (see [`crate::arena::Arena`]).

macro_rules! define_id {
    ($(#[$meta:meta])* $name:ident) => {
        $(#[$meta])*
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
        pub struct $name(pub u32);
    };
}

define_id!(
    /// Handle to a `b2Body` stored in the world.
    BodyId
);
define_id!(
    /// Handle to a `b2Fixture` stored in the world.
    FixtureId
);
define_id!(
    /// Handle to a `b2Joint` stored in the world.
    JointId
);
define_id!(
    /// Handle to a `b2Contact` stored in the world.
    ContactId
);
