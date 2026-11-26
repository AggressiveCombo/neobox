//! Neobox simulation: a deterministic, from-scratch reimplementation of the
//! Hitbox.io game rules on top of a bit-exact Box2D 2.1 port.
//!
//! The simulation is a pure function of plain data:
//! `State(t) + inputs + events -> State(t+1)` ([`Sim::step`], or
//! [`start::advance`] which also performs round transitions). This makes
//! rollback netcode, replays and server-side verification straightforward.
//!
//! Names here are descriptive. The original game's internal names, and the
//! field each one maps to, are listed in `docs/ORIGINAL-NAMES.md`.

pub mod compat;
pub mod input;
pub mod js;
pub mod map;
mod map_keys;
mod objects;
mod player;
mod race;
mod round;
pub mod settings;
pub mod start;
pub mod state;
pub mod step;

pub use input::Input;
pub use map::{MapData, MapError};
pub use settings::GameSettings;
pub use start::{advance, match_start, next_round, Outcome};
pub use state::State;
pub use step::{Events, Sim};
