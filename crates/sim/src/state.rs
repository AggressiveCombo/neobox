//! Simulation state: a plain-data snapshot of one tick.
//!
//! The simulation is a pure function `state(t) -> state(t+1)` (see
//! [`crate::step`]); the physics world is rebuilt from this data every tick,
//! exactly like the original. Snapshots are therefore cheap to keep for
//! rollback: cloning a state copies plain vectors and bumps `Arc` counts for
//! the immutable body definitions.

use crate::map::{BodyDef, MapCap, MapGrapple, MapJoint, MapSettings, MapSpawn, MapTurret, ProjectileDef};
use std::sync::Arc;

/// Sparse id-indexed storage with ascending-id iteration (a JS array with
/// holes). Ids are small; lookups are binary searches.
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq)]
pub struct Sparse<T> {
    items: Vec<(u32, T)>,
}

impl<T> Default for Sparse<T> {
    fn default() -> Self {
        Sparse { items: Vec::new() }
    }
}

impl<T> Sparse<T> {
    pub fn new() -> Self {
        Sparse { items: Vec::new() }
    }
    pub fn with_capacity(n: usize) -> Self {
        Sparse { items: Vec::with_capacity(n) }
    }
    pub fn len(&self) -> usize {
        self.items.len()
    }
    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }
    pub fn clear(&mut self) {
        self.items.clear();
    }
    fn find(&self, id: u32) -> Result<usize, usize> {
        // fast path: appends in ascending order
        match self.items.last() {
            Some(&(last, _)) if last < id => Err(self.items.len()),
            _ => self.items.binary_search_by_key(&id, |e| e.0),
        }
    }
    pub fn get(&self, id: u32) -> Option<&T> {
        self.find(id).ok().map(|i| &self.items[i].1)
    }
    pub fn get_mut(&mut self, id: u32) -> Option<&mut T> {
        match self.find(id) {
            Ok(i) => Some(&mut self.items[i].1),
            Err(_) => None,
        }
    }
    pub fn contains(&self, id: u32) -> bool {
        self.find(id).is_ok()
    }
    /// `arr[id] = value`
    pub fn insert(&mut self, id: u32, value: T) {
        match self.find(id) {
            Ok(i) => self.items[i].1 = value,
            Err(i) => self.items.insert(i, (id, value)),
        }
    }
    /// `delete arr[id]`
    pub fn remove(&mut self, id: u32) -> Option<T> {
        match self.find(id) {
            Ok(i) => Some(self.items.remove(i).1),
            Err(_) => None,
        }
    }
    pub fn iter(&self) -> impl Iterator<Item = (u32, &T)> {
        self.items.iter().map(|(k, v)| (*k, v))
    }
    pub fn iter_mut(&mut self) -> impl Iterator<Item = (u32, &mut T)> {
        self.items.iter_mut().map(|(k, v)| (*k, v))
    }
    pub fn values(&self) -> impl Iterator<Item = &T> {
        self.items.iter().map(|(_, v)| v)
    }
    pub fn ids(&self) -> impl Iterator<Item = u32> + '_ {
        self.items.iter().map(|(k, _)| *k)
    }
    pub fn retain(&mut self, mut f: impl FnMut(u32, &mut T) -> bool) {
        self.items.retain_mut(|(k, v)| f(*k, v));
    }
}

/// Converts a JS-ish numeric id to a sparse index (negative/fractional ids
/// are not array indices in JS and are never iterated).
pub fn index_of(v: f64) -> Option<u32> {
    if v >= 0.0 && v.fract() == 0.0 && v <= 4294967294.0 { Some(v as u32) } else { None }
}

/// Short-lived sound event. `ttl` counts down every tick.
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq)]
pub struct Sound {
    pub x: f64,
    pub y: f64,
    pub kind: f64,
    /// Countdown ticks left.
    pub ttl: f64,
    pub volume: f64,
    /// Emitting player (-1 none).
    pub player: f64,
    /// The original creates the parachute sound with its effect class, so the
    /// row serializes in the effect layout (ttl 20 at index 5) and is read
    /// back next tick as a sound whose ttl is the effect's lifetime value (-1): it
    /// lives for exactly one tick. Such sounds are stored with `ttl` -1.
    #[serde(default)]
    pub effect_row: bool,
}

impl Default for Sound {
    fn default() -> Self {
        Sound { x: 0.0, y: 0.0, kind: 0.0, ttl: 0.0, volume: 1.0, player: -1.0, effect_row: false }
    }
}

/// Short-lived visual effect.
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq)]
pub struct Effect {
    pub x: f64,
    pub y: f64,
    pub kind: f64,
    /// Secondary point (e.g. push target).
    pub x2: f64,
    pub y2: f64,
    /// Countdown ticks left.
    pub ttl: f64,
    /// Extra value; serialized, not read by the sim.
    pub extra_value: f64,
    pub volume: f64,
    pub z_index: f64,
    /// Team colour.
    pub team: f64,
    /// Player.
    pub player: f64,
}

impl Default for Effect {
    fn default() -> Self {
        Effect { x: 0.0, y: 0.0, kind: 0.0, x2: -1.0, y2: -1.0, ttl: 0.0, extra_value: 0.0, volume: 1.0, z_index: 0.0, team: 0.0, player: -1.0 }
    }
}

/// Id allocators.
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, Default, PartialEq)]
pub struct Counters {
    /// Next projectile slot (grows forever).
    pub projectile: f64,
    /// Cycling visual-effect slot (0..=250).
    pub effect: f64,
    /// Next turret slot.
    pub turret: f64,
    /// Next pickup slot.
    pub pickups: f64,
}

impl Counters {
    /// Returns the current effect slot and advances it (wraps after 250).
    pub fn next_effect(&mut self) -> f64 {
        let v = self.effect;
        self.effect += 1.0;
        if self.effect > 250.0 {
            self.effect = 0.0;
        }
        v
    }
}

/// Per-player round record.
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq)]
pub struct PlayerRecord {
    pub id: f64,
    /// Team (0 spectator, 1 FFA, 2 red, 3 blue).
    pub team: f64,
    /// Kills / score.
    pub kills: f64,
    /// Round wins.
    pub wins: f64,
    // Race times (heav.io builds; the current original keeps these slots
    // unused). Times are run ticks (the player's age when it happened).
    /// Best finish time this match (0 = none).
    pub best_finish_time: f64,
    /// Age at the last tick, while the map has checkpoints.
    pub checkpoint_age: f64,
    /// Last finish time.
    pub last_finish_time: f64,
    /// Checkpoint times of the best run (by checkpoint number; NaN = none).
    pub best_checkpoint_times: Vec<f64>,
    /// Checkpoint times of the current run (by checkpoint number; NaN = none).
    pub checkpoint_times: Vec<f64>,
    /// Time behind (+) or ahead of (-) the best run at the last checkpoint (NaN = none).
    pub checkpoint_delta: f64,
    /// Time of the last checkpoint.
    pub last_checkpoint_time: f64,
    /// Alive this round.
    pub alive: bool,
    /// Respawn countdown (-1 none).
    pub respawn: f64,
    /// Claimed spawn index (-1 none).
    pub spawn: f64,
    /// Lives left.
    pub lives: f64,
    /// Elimination order.
    pub eliminated: f64,
    /// Last victim.
    pub last_victim: f64,
    /// Kill-banner timer.
    pub kill_timer: f64,
    /// Killed by.
    pub killed_by: f64,
    /// Death-banner timer.
    pub death_timer: f64,
    /// Suicide-banner timer.
    pub suicide_timer: f64,
}

impl Default for PlayerRecord {
    fn default() -> Self {
        PlayerRecord {
            id: 0.0,
            team: 0.0,
            kills: 0.0,
            wins: 0.0,
            best_finish_time: 0.0,
            checkpoint_age: 0.0,
            last_finish_time: 0.0,
            best_checkpoint_times: Vec::new(),
            checkpoint_times: Vec::new(),
            checkpoint_delta: f64::NAN,
            last_checkpoint_time: 0.0,
            alive: false,
            respawn: -1.0,
            spawn: -1.0,
            lives: 0.0,
            eliminated: 0.0,
            last_victim: -1.0,
            kill_timer: -1.0,
            killed_by: -1.0,
            death_timer: -1.0,
            suicide_timer: -1.0,
        }
    }
}

/// Match/round state.
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq)]
pub struct Round {
    /// Game-over countdown (-1 = running); slows physics to 40%.
    pub game_over: f64,
    /// Round-over countdown (-1 = running).
    pub round_over: f64,
    /// Intro countdown (-1 = finished).
    pub intro: f64,
    /// Kept for state layout; no rule reads it (2 by default).
    pub reserved_2: f64,
    /// Spawn PRNG state.
    pub seed: f64,
    /// Round number.
    pub round_number: f64,
    /// Kept for state layout; no rule reads it.
    pub reserved_0: f64,
    /// Index of the current map in the rotation playlist.
    pub map_index: f64,
    /// Tick counter.
    pub ticks: f64,
    /// Winner (player id / -1 draw / -2 ...).
    pub winner: f64,
    /// Winning team of the last objective.
    pub objective_team: f64,
    /// Elimination counter.
    pub eliminations: f64,
    /// Lowest lives left (late-join lives).
    pub min_lives: f64,
    /// Map rotation: the next map is played after a game over (set by `match_start`).
    pub rotation: bool,
    /// Red and blue score or lives.
    pub red: f64,
    pub blue: f64,
    pub players: Sparse<PlayerRecord>,
}

impl Default for Round {
    fn default() -> Self {
        Round {
            game_over: -1.0,
            round_over: -1.0,
            intro: -1.0,
            reserved_2: 2.0,
            seed: 0.0,
            round_number: 0.0,
            reserved_0: 0.0,
            map_index: 0.0,
            ticks: 0.0,
            winner: 0.0,
            objective_team: -1.0,
            eliminations: 0.0,
            min_lives: -1.0,
            rotation: false,
            red: 0.0,
            blue: 0.0,
            players: Sparse::new(),
        }
    }
}

impl Round {
    /// Advances the seeded 16-bit xorshift; returns a value in (0, 1].
    pub fn random(&mut self) -> f64 {
        let mut s = crate::js::to_int32(self.seed);
        if s == 0 {
            s = 1;
        }
        s ^= (2047 & s) << 5;
        s ^= s >> 7;
        s ^= (3 & s) << 14;
        self.seed = (65535 & s) as f64;
        self.seed / 65535.0
    }
}

/// Grab/rope attachment state.
#[derive(serde::Serialize, serde::Deserialize, Clone, Copy, Debug, PartialEq)]
pub struct Attach {
    /// 0 idle, 2 attached, 3 lost (see the `ATTACH_*` constants).
    pub state: f64,
    /// Kept for state layout; no rule reads it (-1 by default).
    pub reserved: f64,
    /// Kind of the attached object.
    pub kind: f64,
    /// Id of the attached object.
    pub target: f64,
    /// Local anchor on the target.
    pub ax: f64,
    pub ay: f64,
}

pub const ATTACH_IDLE: f64 = 0.0;
pub const ATTACH_ON: f64 = 2.0;
pub const ATTACH_LOST: f64 = 3.0;

impl Default for Attach {
    fn default() -> Self {
        Attach { state: ATTACH_IDLE, reserved: -1.0, kind: 0.0, target: 0.0, ax: 0.0, ay: 0.0 }
    }
}

/// Parachute canopy body state.
#[derive(serde::Serialize, serde::Deserialize, Clone, Copy, Debug, Default, PartialEq)]
pub struct Parachute {
    pub x: f64,
    pub y: f64,
    pub angle: f64,
    pub angular_velocity: f64,
    pub vx: f64,
    pub vy: f64,
    /// Deploy countdown.
    pub deploy: f64,
}

/// A player row.
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq)]
pub struct Player {
    pub id: f64,
    pub x: f64,
    pub y: f64,
    pub angle: f64,
    pub angular_velocity: f64,
    pub vx: f64,
    pub vy: f64,
    /// Ticks the jump key has been held.
    pub up_held: f64,
    /// Teleported this tick (do not interpolate).
    pub teleported: bool,
    /// Health.
    pub health: f64,
    /// Team.
    pub team: f64,
    /// Air jump available.
    pub air_jump: bool,
    /// Spawn point.
    pub spawn_x: f64,
    pub spawn_y: f64,
    /// Race checkpoints passed this run. The heav.io builds used this slot
    /// for something else; the current original keeps it but never changes it.
    pub checkpoint: f64,
    /// Ticks alive.
    pub age: f64,
    /// Frozen ticks (input ignored).
    pub frozen: f64,
    /// Kept for state layout; no rule reads it.
    pub reserved_flag: bool,
    /// Movement disabled.
    pub stunned: bool,
    /// Coyote-time counter.
    pub coyote: f64,
    /// Compared against the race reset limit when the bat key is pressed.
    pub reset_count: f64,
    /// Force-push frame counter.
    pub push_frames: f64,
    /// Stamina.
    pub stamina: f64,
    /// Last attacker (-1 none).
    pub attacker: f64,
    /// Attacker credit timer.
    pub attacker_timer: f64,
    /// Bat frame (-1 idle).
    pub bat_frame: f64,
    /// Bat aim angle.
    pub bat_aim: f64,
    /// Bat hit history: [kind, id, kind, id, ...].
    pub bat_hits: Vec<f64>,
    /// May trigger the freeze sound.
    pub freeze_ready: bool,
    /// Dash frame (-1 idle).
    pub dash_frame: f64,
    /// Speed before the dash.
    pub dash_speed: f64,
    /// Rocket frame (-1 idle).
    pub rocket_frame: f64,
    /// Rocket aim angle.
    pub rocket_aim: f64,
    /// Egg charge frame.
    pub egg_frame: f64,
    /// Egg aim angle.
    pub egg_aim: f64,
    /// Impact-sound limiter.
    pub sound_limiter: f64,
    /// Kept for state layout; no rule reads it.
    pub reserved_count: f64,
    /// Kept for state layout; no rule reads it.
    pub reserved_count_2: f64,
    /// Kept for state layout; no rule reads it.
    pub reserved_flag_2: bool,
    /// Ghost (flies, no gravity, fires ghost rockets).
    pub ghost: bool,
    /// Kills credited; the player becomes a ghost when it reaches the
    /// `ghost_after` setting (0 = never, the original default).
    pub kills: f64,
    /// Grapple-point rope (inert in the original).
    pub rope: Attach,
    /// Player link (inert in the original).
    pub link: Attach,
    /// Grab anchors (8 directions).
    pub grabs: [Attach; 8],
    /// Parachute.
    pub parachute: Option<Parachute>,
}

impl Default for Player {
    fn default() -> Self {
        Player {
            id: 0.0,
            x: 0.0,
            y: 0.0,
            angle: 0.0,
            angular_velocity: 0.0,
            vx: 0.0,
            vy: 0.0,
            up_held: 0.0,
            teleported: false,
            health: 100.0,
            team: 0.0,
            air_jump: true,
            spawn_x: 0.0,
            spawn_y: 0.0,
            checkpoint: 0.0,
            age: 0.0,
            frozen: 0.0,
            reserved_flag: false,
            stunned: false,
            coyote: 0.0,
            reset_count: 0.0,
            push_frames: 0.0,
            stamina: 0.0,
            attacker: -1.0,
            attacker_timer: 0.0,
            bat_frame: -1.0,
            bat_aim: 0.0,
            bat_hits: Vec::new(),
            freeze_ready: true,
            dash_frame: -1.0,
            dash_speed: 0.0,
            rocket_frame: -1.0,
            rocket_aim: 0.0,
            egg_frame: 0.0,
            egg_aim: 0.0,
            sound_limiter: 1.0,
            reserved_count: 0.0,
            reserved_count_2: 0.0,
            reserved_flag_2: false,
            ghost: false,
            kills: 0.0,
            rope: Attach::default(),
            link: Attach::default(),
            grabs: [Attach::default(); 8],
            parachute: None,
        }
    }
}

/// A map body row.
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq)]
pub struct Body {
    pub x: f64,
    pub y: f64,
    pub angle: f64,
    pub angular_velocity: f64,
    pub vx: f64,
    pub vy: f64,
    /// Teleported this tick.
    pub teleported: bool,
    /// Accumulated damage.
    pub damage: f64,
    /// Lifetime countdown (-1 none).
    pub lifetime: f64,
    /// Impact-sound limiter.
    pub sound_limiter: f64,
    /// Push attribution: player id -> weight.
    pub push_from: Sparse<f64>,
    pub def: Arc<BodyDef>,
}

/// A projectile row.
pub type Projectile = ProjectileDef;

/// Pickup bucket row. Nothing in the sim reads it; kept for state layout.
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq)]
pub struct PickupRow {
    pub x: f64,
    pub y: f64,
    pub angle: f64,
    pub health: f64,
    pub reserved: f64,
    pub team: f64,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, Default, PartialEq)]
pub struct State {
    pub settings: MapSettings,
    pub sounds: Vec<Sound>,
    pub spawns: Sparse<MapSpawn>,
    pub counters: Counters,
    pub round: Round,
    pub bodies: Sparse<Body>,
    pub joints: Sparse<MapJoint>,
    pub effects: Sparse<Effect>,
    pub players: Sparse<Player>,
    pub projectiles: Sparse<Projectile>,
    pub turrets: Sparse<MapTurret>,
    pub grapples: Sparse<MapGrapple>,
    pub pickups: Sparse<PickupRow>,
    pub caps: Vec<MapCap>,
}
