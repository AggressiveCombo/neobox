//! `Box2D.Common.b2Settings` constants from the archived Box2D.min.js.
//!
//! `b2_polygonRadius` is intentionally absent: the archive evaluates
//! `2 * b2_linearSlop` before `b2_linearSlop` is assigned, so it is `NaN` and
//! unused by the library. `b2Settings.b2_pi` is [`PI`].

use core::f64::consts::PI;

pub const VERSION: &str = "2.1alpha";
pub const USHRT_MAX: u32 = 65535;
/// `b2_pi` (`Math.PI`).
pub const B2_PI: f64 = PI;
pub const MAX_MANIFOLD_POINTS: usize = 2;
pub const AABB_EXTENSION: f64 = 0.1;
pub const AABB_MULTIPLIER: f64 = 2.0;
pub const LINEAR_SLOP: f64 = 0.005;
pub const ANGULAR_SLOP: f64 = (2.0 / 180.0) * PI;
pub const TOI_SLOP: f64 = 8.0 * LINEAR_SLOP;
pub const MAX_TOI_CONTACTS_PER_ISLAND: usize = 32;
pub const MAX_TOI_JOINTS_PER_ISLAND: usize = 32;
pub const VELOCITY_THRESHOLD: f64 = 1e-4;
pub const MAX_LINEAR_CORRECTION: f64 = 0.2;
pub const MAX_ANGULAR_CORRECTION: f64 = (8.0 / 180.0) * PI;
pub const MAX_TRANSLATION: f64 = 20.0;
pub const MAX_TRANSLATION_SQUARED: f64 = MAX_TRANSLATION * MAX_TRANSLATION;
pub const MAX_ROTATION: f64 = 0.5 * PI;
pub const MAX_ROTATION_SQUARED: f64 = MAX_ROTATION * MAX_ROTATION;
pub const CONTACT_BAUMGARTE: f64 = 0.2;
pub const TIME_TO_SLEEP: f64 = 0.5;
pub const LINEAR_SLEEP_TOLERANCE: f64 = 0.01;
pub const ANGULAR_SLEEP_TOLERANCE: f64 = (2.0 / 180.0) * PI;
