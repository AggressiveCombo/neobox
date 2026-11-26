//! The raw JSON keys of the Hitbox map format, as named constants.
//!
//! The file format is fixed: every string here is part of the bytes of a map
//! code, so changing one breaks every existing map. Only this module holds the
//! literal strings; the decoder and encoder use these names.
//!
//! Object keys are numeric strings. A key with no known meaning is named
//! `UNKNOWN_<key>`; it is still read and written so that the value survives.
//! The mapping to the original game's internal names lives in
//! `docs/ORIGINAL-NAMES.md`.

/// Top-level keys of a map.
pub mod root {
    /// Bodies (`b`).
    pub const BODIES: &str = "b";
    /// Joints (`j`).
    pub const JOINTS: &str = "j";
    /// Spawn points (`s`).
    pub const SPAWNS: &str = "s";
    /// Pickups (`p`): parse-only, kept verbatim.
    pub const PICKUPS: &str = "p";
    /// Turrets (`tu`).
    pub const TURRETS: &str = "tu";
    /// Team cores (`tc`): parse-only, kept verbatim.
    pub const TEAM_CORES: &str = "tc";
    /// Grapple points (`gp`).
    pub const GRAPPLES: &str = "gp";
    /// Capture points (`c`).
    pub const CAPS: &str = "c";
    /// Map settings (`set`).
    pub const SETTINGS: &str = "set";
    /// Every top-level key this module reads; any other key is kept as extra.
    pub const DECODED: &[&str] = &[BODIES, JOINTS, SPAWNS, PICKUPS, TURRETS, TEAM_CORES, GRAPPLES, CAPS, SETTINGS];
}

/// Map settings object (`set`).
pub mod settings {
    pub const SCREEN_WIDTH: &str = "3";
    pub const SNAP: &str = "4";
    pub const UNKNOWN_5: &str = "5";
    pub const BG_OFFSET_X: &str = "7";
    pub const BG_OFFSET_Y: &str = "8";
    pub const BACKGROUND_IMAGE: &str = "9";
    pub const BG_SCALE: &str = "10";
    pub const PARALLAX: &str = "11";
    pub const COLOR_TOP: &str = "12";
    pub const UNKNOWN_13: &str = "13";
    pub const WIDTH: &str = "15";
    pub const HEIGHT: &str = "16";
    pub const COLOR_BOTTOM: &str = "17";
    pub const GRAVITY: &str = "18";
    pub const WRAP: &str = "19";
    /// Neobox's own key (not numeric, so the original never reads it).
    pub const ASPECT: &str = "aspect";
    /// Every key this module reads; any other key is kept as extra.
    pub const DECODED: &[&str] = &[
        SCREEN_WIDTH,
        SNAP,
        UNKNOWN_5,
        BG_OFFSET_X,
        BG_OFFSET_Y,
        BACKGROUND_IMAGE,
        BG_SCALE,
        PARALLAX,
        COLOR_TOP,
        UNKNOWN_13,
        WIDTH,
        HEIGHT,
        COLOR_BOTTOM,
        GRAVITY,
        WRAP,
        ASPECT,
    ];
}

/// Shape object (entries of a body's `s` list).
pub mod shape {
    pub const KIND: &str = "1";
    pub const X: &str = "2";
    pub const Y: &str = "3";
    pub const DENSITY: &str = "4";
    pub const FRICTION: &str = "5";
    pub const RESTITUTION: &str = "6";
    pub const COLOR: &str = "7";
    pub const CLOSED: &str = "8";
    pub const RADIUS: &str = "9";
    pub const UNKNOWN_11: &str = "11";
    pub const UNKNOWN_12: &str = "12";
    pub const UNKNOWN_13: &str = "13";
    pub const NO_PHYSICS: &str = "14";
    pub const Z_INDEX: &str = "15";
    /// Polygon vertices (flat list of x, y pairs).
    pub const POINTS: &str = "p";
    /// Every key this module reads; any other key is kept as extra.
    pub const DECODED: &[&str] = &[
        KIND,
        X,
        Y,
        DENSITY,
        FRICTION,
        RESTITUTION,
        COLOR,
        CLOSED,
        RADIUS,
        UNKNOWN_11,
        UNKNOWN_12,
        UNKNOWN_13,
        NO_PHYSICS,
        Z_INDEX,
        POINTS,
    ];
}

/// Body object (entries of `b`).
pub mod body {
    pub const ID: &str = "1";
    pub const X: &str = "2";
    pub const Y: &str = "3";
    pub const ANGLE: &str = "4";
    pub const ANGULAR_VELOCITY: &str = "5";
    pub const VX: &str = "6";
    pub const VY: &str = "7";
    pub const DENSITY: &str = "8";
    pub const RESTITUTION: &str = "9";
    pub const FRICTION: &str = "10";
    pub const LINEAR_DAMPING: &str = "11";
    pub const ANGULAR_DAMPING: &str = "12";
    pub const KILLS_PLAYERS: &str = "13";
    pub const MOTION: &str = "14";
    pub const WRAP: &str = "15";
    /// Flag: the body is teleported.
    pub const TELEPORTED: &str = "16";
    pub const FORCE_X: &str = "17";
    pub const FORCE_Y: &str = "18";
    pub const TORQUE: &str = "19";
    pub const DAMAGE: &str = "20";
    pub const DYNAMIC_THRESHOLD: &str = "21";
    pub const REMOVAL_THRESHOLD: &str = "22";
    pub const NO_PHYSICS: &str = "23";
    pub const Z_INDEX: &str = "24";
    pub const GROUP: &str = "25";
    pub const COLLIDE_A: &str = "26";
    pub const COLLIDE_B: &str = "27";
    pub const COLLIDE_C: &str = "28";
    pub const COLLIDE_D: &str = "29";
    pub const PLAYER_PASS: &str = "30";
    pub const CHECKPOINT: &str = "31";
    pub const FREEZE_PLAYERS: &str = "32";
    pub const RACE_OBJECT: &str = "34";
    pub const PINNED: &str = "36";
    pub const PIN_X: &str = "37";
    pub const PIN_Y: &str = "38";
    pub const FORCE_ZONE: &str = "39";
    pub const ZONE_X: &str = "40";
    pub const ZONE_Y: &str = "41";
    pub const NO_JUMP: &str = "43";
    pub const RACE_PROGRESS: &str = "44";
    pub const BULLET: &str = "45";
    pub const INVISIBLE: &str = "50";
    pub const PARALLAX: &str = "55";
    pub const LIFETIME: &str = "56";
    pub const FIXED_ROTATION: &str = "57";
    pub const SOURCE_PLAYER: &str = "58";
    pub const ABILITY_IMMUNE: &str = "60";
    pub const OBJECTIVE: &str = "61";
    pub const OBJECTIVE_TARGET: &str = "62";
    pub const UNKNOWN_63: &str = "63";
    /// Impact-sound limiter state.
    pub const SOUND_LIMITER: &str = "64";
    pub const PROJECTILE_PASS: &str = "65";
    /// Shapes (list of shape objects).
    pub const SHAPES: &str = "s";
    /// Push attribution: flat list of player id, weight pairs.
    pub const PUSH_FROM: &str = "pf";
    /// Every key this module reads; any other key is kept as extra.
    pub const DECODED: &[&str] = &[
        ID,
        X,
        Y,
        ANGLE,
        ANGULAR_VELOCITY,
        VX,
        VY,
        DENSITY,
        RESTITUTION,
        FRICTION,
        LINEAR_DAMPING,
        ANGULAR_DAMPING,
        KILLS_PLAYERS,
        MOTION,
        WRAP,
        TELEPORTED,
        FORCE_X,
        FORCE_Y,
        TORQUE,
        DAMAGE,
        DYNAMIC_THRESHOLD,
        REMOVAL_THRESHOLD,
        NO_PHYSICS,
        Z_INDEX,
        GROUP,
        COLLIDE_A,
        COLLIDE_B,
        COLLIDE_C,
        COLLIDE_D,
        PLAYER_PASS,
        CHECKPOINT,
        FREEZE_PLAYERS,
        RACE_OBJECT,
        PINNED,
        PIN_X,
        PIN_Y,
        FORCE_ZONE,
        ZONE_X,
        ZONE_Y,
        NO_JUMP,
        RACE_PROGRESS,
        BULLET,
        INVISIBLE,
        PARALLAX,
        LIFETIME,
        FIXED_ROTATION,
        SOURCE_PLAYER,
        ABILITY_IMMUNE,
        OBJECTIVE,
        OBJECTIVE_TARGET,
        UNKNOWN_63,
        SOUND_LIMITER,
        PROJECTILE_PASS,
        SHAPES,
        PUSH_FROM,
    ];
}

/// Joint object (entries of `j`).
pub mod joint {
    pub const AX: &str = "1";
    pub const AY: &str = "2";
    pub const BX: &str = "3";
    pub const BY: &str = "4";
    pub const KIND: &str = "5";
    pub const COLLIDE_CONNECTED: &str = "6";
    pub const BODY_A: &str = "7";
    pub const BODY_B: &str = "8";
    pub const FREQUENCY: &str = "9";
    pub const DAMPING: &str = "10";
    pub const LENGTH: &str = "11";
    pub const MOTOR_SPEED: &str = "12";
    pub const MAX_MOTOR: &str = "13";
    pub const PLAYER_A: &str = "14";
    pub const UNKNOWN_15: &str = "15";
    pub const MOTOR_MODE: &str = "16";
    pub const LATCHED: &str = "17";
    pub const AXIS_X: &str = "18";
    pub const AXIS_Y: &str = "19";
    /// Every key this module reads; any other key is kept as extra.
    pub const DECODED: &[&str] = &[
        AX,
        AY,
        BX,
        BY,
        KIND,
        COLLIDE_CONNECTED,
        BODY_A,
        BODY_B,
        FREQUENCY,
        DAMPING,
        LENGTH,
        MOTOR_SPEED,
        MAX_MOTOR,
        PLAYER_A,
        UNKNOWN_15,
        MOTOR_MODE,
        LATCHED,
        AXIS_X,
        AXIS_Y,
    ];
}

/// Spawn object (entries of `s`).
pub mod spawn {
    pub const X: &str = "1";
    pub const Y: &str = "2";
    pub const PRIORITY: &str = "3";
    pub const ANGLE: &str = "4";
    /// Team usage flags: free-for-all (5), red (6), blue (7).
    pub const TEAM_FFA: &str = "5";
    pub const TEAM_RED: &str = "6";
    pub const TEAM_BLUE: &str = "7";
    pub const CAP_SEQUENCE: &str = "8";
    /// Every key this module reads; any other key is kept as extra.
    pub const DECODED: &[&str] = &[X, Y, PRIORITY, ANGLE, TEAM_FFA, TEAM_RED, TEAM_BLUE, CAP_SEQUENCE];
}

/// Turret object (entries of `tu`).
pub mod turret {
    pub const X: &str = "1";
    pub const Y: &str = "2";
    pub const VX: &str = "3";
    pub const VY: &str = "4";
    pub const ANGLE: &str = "5";
    pub const ANGULAR_VELOCITY: &str = "6";
    pub const HEALTH: &str = "7";
    pub const COOLDOWN: &str = "8";
    pub const TEAM: &str = "9";
    pub const FIRE_INTERVAL: &str = "10";
    pub const RANGE: &str = "11";
    pub const MAX_HEALTH: &str = "24";
    /// Every key this module reads, including the bullet keys 12 to 23; any
    /// other key is kept as extra.
    pub const DECODED: &[&str] = &[
        X,
        Y,
        VX,
        VY,
        ANGLE,
        ANGULAR_VELOCITY,
        HEALTH,
        COOLDOWN,
        TEAM,
        FIRE_INTERVAL,
        RANGE,
        super::bullet::VX,
        super::bullet::SIZE,
        super::bullet::DENSITY,
        super::bullet::FRICTION,
        super::bullet::RESTITUTION,
        super::bullet::LIFE,
        super::bullet::DAMAGE,
        super::bullet::TURN_RATE,
        super::bullet::EXPLODE_RADIUS,
        super::bullet::BOUNCES,
        super::bullet::SHAPE,
        super::bullet::LINEAR_DAMPING,
        MAX_HEALTH,
    ];
}

/// Projectile fired by a turret. Its keys are the turret's keys 12 to 23.
pub mod bullet {
    pub const VX: &str = "12";
    pub const SIZE: &str = "13";
    pub const DENSITY: &str = "14";
    pub const FRICTION: &str = "15";
    pub const RESTITUTION: &str = "16";
    pub const LIFE: &str = "17";
    pub const DAMAGE: &str = "18";
    pub const TURN_RATE: &str = "19";
    pub const EXPLODE_RADIUS: &str = "20";
    pub const BOUNCES: &str = "21";
    pub const SHAPE: &str = "22";
    pub const LINEAR_DAMPING: &str = "23";
}

/// Grapple point object (entries of `gp`).
pub mod grapple {
    pub const X: &str = "1";
    pub const Y: &str = "2";
    pub const RANGE: &str = "3";
    pub const BODY: &str = "4";
    /// Every key this module reads; any other key is kept as extra.
    pub const DECODED: &[&str] = &[X, Y, RANGE, BODY];
}

/// Capture point object (entries of `c`).
pub mod cap {
    pub const X: &str = "1";
    pub const Y: &str = "2";
    pub const WIDTH: &str = "3";
    pub const SEQUENCE: &str = "4";
    pub const OWNER: &str = "5";
    pub const CAPTURER: &str = "6";
    pub const CAPTURE_TIME: &str = "7";
    pub const PROGRESS: &str = "8";
    /// Every key this module reads; any other key is kept as extra.
    pub const DECODED: &[&str] = &[X, Y, WIDTH, SEQUENCE, OWNER, CAPTURER, CAPTURE_TIME, PROGRESS];
}
