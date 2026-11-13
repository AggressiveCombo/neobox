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

/// Short-lived sound event (`Cr` bucket). `ttl` counts down every tick.
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq)]
pub struct Sound {
    pub x: f64,
    pub y: f64,
    pub kind: f64,
    /// `Dn`
    pub ttl: f64,
    pub volume: f64,
    /// `jn` emitting player (-1 none)
    pub player: f64,
    /// The original creates the parachute sound with its effect class, so the
    /// row serializes in the effect layout (ttl 20 at index 5) and is read
    /// back next tick as a sound whose ttl is the effect's `On` (-1): it
    /// lives for exactly one tick. Such sounds are stored with `ttl` -1.
    #[serde(default)]
    pub effect_row: bool,
}

impl Default for Sound {
    fn default() -> Self {
        Sound { x: 0.0, y: 0.0, kind: 0.0, ttl: 0.0, volume: 1.0, player: -1.0, effect_row: false }
    }
}

/// Short-lived visual effect (`zl` bucket).
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq)]
pub struct Effect {
    pub x: f64,
    pub y: f64,
    pub kind: f64,
    /// `On`/`Rn` secondary point (e.g. push target)
    pub x2: f64,
    pub y2: f64,
    /// `Dn`
    pub ttl: f64,
    /// `Ln`
    pub ln: f64,
    pub volume: f64,
    pub z_index: f64,
    /// `Un` team colour
    pub team: f64,
    /// `jn` player
    pub player: f64,
}

impl Default for Effect {
    fn default() -> Self {
        Effect { x: 0.0, y: 0.0, kind: 0.0, x2: -1.0, y2: -1.0, ttl: 0.0, ln: 0.0, volume: 1.0, z_index: 0.0, team: 0.0, player: -1.0 }
    }
}

/// Id allocators (`Dl` bucket).
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, Default, PartialEq)]
pub struct Counters {
    /// `Rl` next projectile slot (grows forever).
    pub projectile: f64,
    /// `Ju` cycling visual-effect slot (0..=250).
    pub effect: f64,
    /// `cu` next turret slot.
    pub turret: f64,
    /// `wu` next `pu` slot.
    pub pu: f64,
}

impl Counters {
    /// `Yl()`: returns the current effect slot and advances it (wraps after 250).
    pub fn next_effect(&mut self) -> f64 {
        let v = self.effect;
        self.effect += 1.0;
        if self.effect > 250.0 {
            self.effect = 0.0;
        }
        v
    }
}

/// Per-player round record (`ir.Pi` rows).
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq)]
pub struct PlayerRecord {
    pub id: f64,
    /// `N` team (0 spectator, 1 FFA, 2 red, 3 blue)
    pub team: f64,
    /// `Ei` kills / score
    pub kills: f64,
    /// `Fi` round wins
    pub wins: f64,
    pub co: f64,
    pub do_: f64,
    pub po: f64,
    pub wo: Vec<f64>,
    pub mo: Vec<f64>,
    pub yo: f64,
    pub fo: f64,
    /// `bo` alive this round
    pub alive: bool,
    /// `vo` respawn countdown (-1 none)
    pub respawn: f64,
    /// `ko` claimed spawn index (-1 none)
    pub spawn: f64,
    /// `Bi` lives left
    pub lives: f64,
    /// `Ii` elimination order
    pub eliminated: f64,
    /// `So` last victim
    pub last_victim: f64,
    /// `No` kill-banner timer
    pub kill_timer: f64,
    /// `Mo` killed by
    pub killed_by: f64,
    /// `Co` death-banner timer
    pub death_timer: f64,
    /// `To` suicide-banner timer
    pub suicide_timer: f64,
}

impl Default for PlayerRecord {
    fn default() -> Self {
        PlayerRecord {
            id: 0.0,
            team: 0.0,
            kills: 0.0,
            wins: 0.0,
            co: 0.0,
            do_: 0.0,
            po: 0.0,
            wo: Vec::new(),
            mo: Vec::new(),
            yo: f64::NAN,
            fo: 0.0,
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

/// Match/round state (`ir` bucket).
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq)]
pub struct Round {
    /// `xo` game-over countdown (-1 = running); slows physics to 40%.
    pub game_over: f64,
    /// `_o` round-over countdown (-1 = running).
    pub round_over: f64,
    /// `$e` intro countdown (-1 = finished).
    pub intro: f64,
    pub po: f64,
    /// spawn PRNG state
    pub seed: f64,
    /// `Eo` round number
    pub round_number: f64,
    pub bo: f64,
    pub io: f64,
    /// `Fo` tick counter
    pub ticks: f64,
    /// `Ao` winner (player id / -1 draw / -2 ...)
    pub winner: f64,
    /// `Oo` winning team of the last objective
    pub objective_team: f64,
    /// `Ro` elimination counter
    pub eliminations: f64,
    /// `Do` lowest lives left (late-join lives)
    pub min_lives: f64,
    /// `Lo`
    pub lo: bool,
    /// `Uo`/`jo` red/blue score or lives
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
            po: 2.0,
            seed: 0.0,
            round_number: 0.0,
            bo: 0.0,
            io: 0.0,
            ticks: 0.0,
            winner: 0.0,
            objective_team: -1.0,
            eliminations: 0.0,
            min_lives: -1.0,
            lo: false,
            red: 0.0,
            blue: 0.0,
            players: Sparse::new(),
        }
    }
}

impl Round {
    /// `Wo()`: 16-bit xorshift; returns a value in (0, 1].
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

/// Grab/rope attachment state (`f6`).
#[derive(serde::Serialize, serde::Deserialize, Clone, Copy, Debug, PartialEq)]
pub struct Attach {
    /// `Oe`: 0 idle, 2 attached, 3 lost, 4
    pub state: f64,
    /// `De`
    pub de: f64,
    /// `Le` kind of the attached object
    pub kind: f64,
    /// `Ue` id of the attached object
    pub target: f64,
    /// `je`/`We` local anchor on the target
    pub ax: f64,
    pub ay: f64,
}

pub const ATTACH_IDLE: f64 = 0.0;
pub const ATTACH_ON: f64 = 2.0;
pub const ATTACH_LOST: f64 = 3.0;

impl Default for Attach {
    fn default() -> Self {
        Attach { state: ATTACH_IDLE, de: -1.0, kind: 0.0, target: 0.0, ax: 0.0, ay: 0.0 }
    }
}

/// Parachute canopy body state (`Pn`).
#[derive(serde::Serialize, serde::Deserialize, Clone, Copy, Debug, Default, PartialEq)]
pub struct Parachute {
    pub x: f64,
    pub y: f64,
    pub angle: f64,
    pub angular_velocity: f64,
    pub vx: f64,
    pub vy: f64,
    /// `Ae` deploy countdown
    pub deploy: f64,
}

/// A player (`Ho` bucket row).
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq)]
pub struct Player {
    pub id: f64,
    pub x: f64,
    pub y: f64,
    pub angle: f64,
    pub angular_velocity: f64,
    pub vx: f64,
    pub vy: f64,
    /// `ze` ticks the jump key has been held.
    pub up_held: f64,
    /// `Ye` teleported this tick (do not interpolate).
    pub teleported: bool,
    /// `qe` health.
    pub health: f64,
    /// `N` team.
    pub team: f64,
    /// `Ve` air jump available.
    pub air_jump: bool,
    /// `Ke`/`Xe` spawn point.
    pub spawn_x: f64,
    pub spawn_y: f64,
    pub ze2: f64,
    /// `Qe` ticks alive.
    pub age: f64,
    /// `$e` frozen ticks (input ignored).
    pub frozen: f64,
    pub tn: bool,
    /// `sn` movement disabled.
    pub stunned: bool,
    /// `hn` coyote-time counter.
    pub coyote: f64,
    pub en: f64,
    /// `nn` force-push frame counter.
    pub push_frames: f64,
    /// `rn` stamina.
    pub stamina: f64,
    /// `an` last attacker (-1 none).
    pub attacker: f64,
    /// `ln` attacker credit timer.
    pub attacker_timer: f64,
    /// `un` bat frame (-1 idle).
    pub bat_frame: f64,
    /// `cn` bat aim angle.
    pub bat_aim: f64,
    /// `dn` bat hit history: [kind, id, kind, id, ...].
    pub bat_hits: Vec<f64>,
    /// `fn` may trigger the freeze sound.
    pub freeze_ready: bool,
    /// `wn` dash frame (-1 idle).
    pub dash_frame: f64,
    /// `mn` speed before the dash.
    pub dash_speed: f64,
    /// `pn` rocket frame (-1 idle).
    pub rocket_frame: f64,
    /// `gn` rocket aim angle.
    pub rocket_aim: f64,
    /// `yn` egg charge frame.
    pub egg_frame: f64,
    /// `bn` egg aim angle.
    pub egg_aim: f64,
    /// `vn` impact-sound limiter.
    pub sound_limiter: f64,
    pub kn: f64,
    pub sn2: f64,
    pub nn2: bool,
    /// `Mn` ghost (flies, no gravity, fires ghost rockets).
    pub ghost: bool,
    /// `Cn` kills credited; the player becomes a ghost when it reaches the
    /// `ghost_after` setting (0 = never, the original default).
    pub kills: f64,
    /// `Tn` grapple-point rope (inert in the original).
    pub rope: Attach,
    /// `xn` player link (inert in the original).
    pub link: Attach,
    /// `_n` grab anchors (8 directions).
    pub grabs: [Attach; 8],
    /// `Pn` parachute.
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
            ze2: 0.0,
            age: 0.0,
            frozen: 0.0,
            tn: false,
            stunned: false,
            coyote: 0.0,
            en: 0.0,
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
            kn: 0.0,
            sn2: 0.0,
            nn2: false,
            ghost: false,
            kills: 0.0,
            rope: Attach::default(),
            link: Attach::default(),
            grabs: [Attach::default(); 8],
            parachute: None,
        }
    }
}

/// A map body (`pl` bucket row).
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq)]
pub struct Body {
    pub x: f64,
    pub y: f64,
    pub angle: f64,
    pub angular_velocity: f64,
    pub vx: f64,
    pub vy: f64,
    /// `Ye` teleported this tick.
    pub teleported: bool,
    /// `ya` accumulated damage.
    pub damage: f64,
    /// `ba` lifetime countdown (-1 none).
    pub lifetime: f64,
    /// `va` impact-sound limiter.
    pub sound_limiter: f64,
    /// `ka` push attribution: player id -> weight.
    pub push_from: Sparse<f64>,
    pub def: Arc<BodyDef>,
}

/// A projectile (`Ol` bucket row).
pub type Projectile = ProjectileDef;

/// Unused bucket (`pu`): kept for state-layout parity.
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq)]
pub struct PuRow {
    pub x: f64,
    pub y: f64,
    pub angle: f64,
    pub health: f64,
    pub yu: f64,
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
    pub pu: Sparse<PuRow>,
    pub caps: Vec<MapCap>,
}
