//! `Box2D.Dynamics` (world, bodies, fixtures, contacts, islands, joints).

pub mod body;
pub mod contact;
pub mod contact_manager;
pub mod contact_solver;
pub mod fixture;
pub mod island;
pub mod joints;
pub mod store;
pub mod world;
mod world_solve;

pub use store::Store;

/// `b2TimeStep`: per-step solver parameters.
#[derive(Clone, Copy, Debug, Default)]
pub struct TimeStep {
    pub dt: f64,
    pub inv_dt: f64,
    pub dt_ratio: f64,
    pub velocity_iterations: i32,
    pub position_iterations: i32,
    pub warm_starting: bool,
}
