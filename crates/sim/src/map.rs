//! Hitbox.io map format: decode/encode of "map codes" and the compact JSON
//! object model.
//!
//! A map code is `encodeURIComponent(base64(zlib_deflate(JSON)))`. The JSON
//! has the buckets `b` (bodies), `j` (joints), `s` (spawns), `p` (pickups,
//! parse-only), `tu` (turrets), `tc` (team cores, parse-only), `gp` (grapple
//! points), `c` (capture points) and `set` (map settings). Every object uses
//! numeric-string keys; a missing key means "constructor default".
//!
//! Compatibility contract: every map the original accepts must decode here
//! with identical field values. Keys the original ignores are kept in
//! `extra` so that a Neobox round-trip never loses data; Neobox extensions
//! must only ever add new keys (never reinterpret existing ones).

use crate::js::{to_number, truthy};
use serde_json::{Map, Value};
use neobox_box2d::Shape;
use std::sync::{Arc, OnceLock};

/// Largest object id accepted in sparse buckets (bodies are stored by id).
pub const MAX_OBJECT_ID: f64 = 65535.0;
/// Largest accepted map code length (characters).
pub const MAX_CODE_LEN: usize = 8 * 1024 * 1024;
/// Largest accepted inflated JSON length (bytes). Public Hitbox maps reach
/// 55 MB (art maps with thousands of polygon vertices).
pub const MAX_JSON_LEN: usize = 64 * 1024 * 1024;
/// Most shapes a map may have in total. The largest playable public map has
/// about 25 000; the only two public maps above this (600 000+ stacked
/// shapes) freeze the original game.
pub const MAX_MAP_SHAPES: usize = 1 << 16;
/// Most polygon vertices a map may have in total (largest playable public
/// map: about 100 000).
pub const MAX_MAP_VERTICES: usize = 1 << 20;

#[derive(Debug)]
pub enum MapError {
    TooLarge,
    /// More shapes or vertices than [`MAX_MAP_SHAPES`] / [`MAX_MAP_VERTICES`].
    TooComplex { what: &'static str, count: usize, limit: usize },
    BadEncoding(&'static str),
    BadJson(String),
    BadStructure(&'static str),
}

impl std::fmt::Display for MapError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MapError::TooLarge => write!(f, "map is too large"),
            MapError::TooComplex { what, count, limit } => write!(f, "map has {count} {what}; the limit is {limit}"),
            MapError::BadEncoding(w) => write!(f, "invalid map code: {w}"),
            MapError::BadJson(e) => write!(f, "invalid map JSON: {e}"),
            MapError::BadStructure(w) => write!(f, "invalid map: {w}"),
        }
    }
}
impl std::error::Error for MapError {}

/// Unknown keys of a map object, kept as JSON object text ("" when none) so
/// that round-trips never lose data (and states stay plain data).
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, Default, PartialEq)]
pub struct Extra(pub String);

impl Extra {
    pub fn from_map(m: &Map<String, Value>) -> Extra {
        if m.is_empty() { Extra::default() } else { Extra(Value::Object(m.clone()).to_string()) }
    }
    pub fn to_map(&self) -> Map<String, Value> {
        if self.0.is_empty() {
            return Map::new();
        }
        match serde_json::from_str::<Value>(&self.0) {
            Ok(Value::Object(m)) => m,
            _ => Map::new(),
        }
    }
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

/// Body collision group (`25`), stored as raw JSON. Only the strings
/// "a".."d" select a collision category (the original uses a strict switch).
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq)]
pub struct Group(pub String);

impl Group {
    pub fn named(s: &str) -> Group {
        Group(Value::String(s.into()).to_string())
    }
    pub fn from_value(v: &Value) -> Group {
        Group(v.to_string())
    }
    pub fn to_value(&self) -> Value {
        serde_json::from_str(&self.0).unwrap_or(Value::Null)
    }
    /// The group name when it is a JSON string.
    pub fn as_str(&self) -> Option<&str> {
        let s = self.0.as_str();
        if s.len() >= 2 && s.starts_with('"') && s.ends_with('"') && !s[1..s.len() - 1].contains(['"', '\\']) {
            Some(&s[1..s.len() - 1])
        } else {
            None
        }
    }
}

/// Map settings (`set`). Field names follow their meaning; keys in comments.
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq)]
pub struct MapSettings {
    /// `3` camera/screen width in world units (clamped to at most 100).
    pub screen_width: f64,
    /// `4` editor snap size.
    pub snap: f64,
    /// Key 5: unused (kept for round-trip).
    pub unknown_5: f64,
    /// `7`/`8` background texture offset.
    pub bg_offset_x: f64,
    pub bg_offset_y: f64,
    /// `9` background image id (0 = solid colour).
    pub background_image: f64,
    /// `10` background texture scale.
    pub bg_scale: f64,
    /// `11` background parallax.
    pub parallax: f64,
    /// `12` background top colour.
    pub color_top: f64,
    /// Key 13: flag with unknown meaning.
    pub unknown_13: bool,
    /// `15` arena width.
    pub width: f64,
    /// `16` arena height.
    pub height: f64,
    /// `17` background bottom colour.
    pub color_bottom: f64,
    /// `18` gravity (world units / s^2, +y is down).
    pub gravity: f64,
    /// `19` player edge wrapping.
    pub wrap: bool,
    /// Neobox key `"aspect"` (not numeric, so the original never reads it): `"wide"` selects the 16:9 view; absent or `"classic"` the original's 16:10.
    /// Not in the binary encoding: a new field there would stop every recorded snapshot (clips, saved replays) decoding. A wide
    /// map keeps `"aspect": "wide"` in `extra`, and [`MapSettings::restore_wide`] reads it back after a decode.
    #[serde(skip)]
    pub wide: bool,
    pub extra: Extra,
}

impl Default for MapSettings {
    fn default() -> Self {
        MapSettings {
            screen_width: 30.0,
            snap: 1.0,
            unknown_5: 1.0,
            bg_offset_x: 0.0,
            bg_offset_y: 0.0,
            background_image: 0.0,
            bg_scale: 1.0,
            parallax: 0.9,
            color_top: 16777215.0,
            unknown_13: false,
            width: 0.0,
            height: 0.0,
            color_bottom: 16777215.0,
            gravity: 15.0,
            wrap: false,
            wide: false,
            extra: Extra::default(),
        }
    }
}

/// The view's width over its height: 16:10 for the original, 16:9 for `wide` maps.
pub const CLASSIC_VIEW_ASPECT: f64 = 1.6;
pub const WIDE_VIEW_ASPECT: f64 = 16.0 / 9.0;

impl MapSettings {
    pub fn view_aspect(&self) -> f64 {
        if self.wide { WIDE_VIEW_ASPECT } else { CLASSIC_VIEW_ASPECT }
    }

    /// Set `wide` from `extra` (a binary decode leaves it false; see the field).
    pub fn restore_wide(&mut self) {
        self.wide = self.extra.to_map().get("aspect").and_then(Value::as_str) == Some("wide");
    }
}

/// Shape kind (`1`): 0 polygon, 1 circle.
pub const SHAPE_POLYGON: f64 = 0.0;
pub const SHAPE_CIRCLE: f64 = 1.0;

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq)]
pub struct MapShape {
    /// `1` kind (0 polygon, 1 circle).
    pub kind: f64,
    /// `2`/`3` offset added to every vertex / circle centre.
    pub x: f64,
    pub y: f64,
    /// `4`/`5`/`6` per-shape material overrides (`None` = use the body's).
    pub density: Option<f64>,
    pub friction: Option<f64>,
    pub restitution: Option<f64>,
    /// `7` colour (0xRRGGBB).
    pub color: f64,
    /// `8` polygon is closed/solid (an open polygon creates no fixture).
    pub closed: bool,
    /// `9` circle radius.
    pub radius: f64,
    /// Keys 11, 12, 13: editor/render fields (meaning unknown).
    pub unknown_11: f64,
    pub unknown_12: f64,
    pub unknown_13: f64,
    /// `14` scenery (no fixture).
    pub no_physics: bool,
    /// `15` draw order.
    pub z_index: f64,
    /// `p` polygon vertices, local to (`x`, `y`).
    pub points: Vec<[f64; 2]>,
    pub extra: Extra,
}

impl Default for MapShape {
    fn default() -> Self {
        MapShape {
            kind: 0.0,
            x: 0.0,
            y: 0.0,
            density: None,
            friction: None,
            restitution: None,
            color: 4627659.0,
            closed: true,
            radius: 0.0,
            unknown_11: 0.0,
            unknown_12: 0.0,
            unknown_13: 1.0,
            no_physics: false,
            z_index: 0.0,
            points: Vec::new(),
            extra: Extra::default(),
        }
    }
}

/// Body motion type (`14`).
pub const BODY_STATIC: f64 = 0.0;
pub const BODY_KINEMATIC: f64 = 1.0;
pub const BODY_DYNAMIC: f64 = 2.0;

/// Box2D shapes of a [`BodyDef`]'s `shapes`, built on first use. Derived data: it takes no part in equality.
#[derive(Clone, Debug, Default)]
pub(crate) struct PhysicsCache(pub(crate) OnceLock<Vec<Option<Shape>>>);

impl PartialEq for PhysicsCache {
    fn eq(&self, _: &Self) -> bool {
        true
    }
}

/// Immutable part of a body (shared between all simulation states).
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq)]
pub struct BodyDef {
    pub id: u32,
    pub density: f64,
    pub restitution: f64,
    pub friction: f64,
    pub linear_damping: f64,
    pub angular_damping: f64,
    /// `13` kills players on contact.
    pub kill_players: bool,
    /// `14` motion type.
    pub motion: f64,
    /// `15` wraps around the arena edges.
    pub wrap: bool,
    /// `17`/`18` constant force (per unit mass), `19` constant torque.
    pub force_x: f64,
    pub force_y: f64,
    pub torque: f64,
    /// `21` damage at which a static or kinematic body becomes dynamic.
    pub dynamic_threshold: f64,
    /// `22` damage threshold for removal.
    pub removal_threshold: f64,
    /// `23` scenery: no physics at all (moved kinematically if motion==1).
    pub no_physics: bool,
    pub z_index: f64,
    /// `25` collision group: the strings "a".."d" select a category; any
    /// other value (kept raw) selects none, like the original's `switch`.
    pub group: Group,
    /// `26`..`29` collides with groups a..d.
    pub collide_a: bool,
    pub collide_b: bool,
    pub collide_c: bool,
    pub collide_d: bool,
    /// `30` player collision: 0 collide, 1 pass-through, 2/3 pass for team 2/3.
    pub player_pass: f64,
    /// `65` projectile collision: 0 collide, 1 pass, 2/3 pass for team.
    pub projectile_pass: f64,
    /// `32` freezes players on contact.
    pub freeze_players: bool,
    /// `43` "no jump": contacts do not count as ground.
    pub no_jump: bool,
    /// `45` continuous collision.
    pub bullet: bool,
    /// `50` invisible.
    pub invisible: bool,
    /// `55` parallax.
    pub parallax: f64,
    /// `57`
    pub fixed_rotation: bool,
    /// `58` source player id of generated debris (-1 for map bodies).
    pub source_player: f64,
    /// `60` unaffected by abilities.
    pub ability_immune: bool,
    /// Keys 61 (objective flag), 62 (objective target), 63 (meaning unknown).
    pub objective: f64,
    pub objective_target: f64,
    pub unknown_63: bool,
    /// `36` pinned to the ground with a revolute joint at local (`37`,`38`).
    pub pinned: bool,
    pub pin_x: f64,
    pub pin_y: f64,
    /// `39` force zone with force (`40`,`41`).
    pub force_zone: bool,
    pub zone_x: f64,
    pub zone_y: f64,
    /// `31` race checkpoint number (0 = none). Players pass the
    /// checkpoints in order; the highest number is the finish.
    pub checkpoint: f64,
    /// `34` race object: it must be carried through the
    /// checkpoints in order, and reaching the finish ends the round.
    pub race_object: bool,
    /// `44` checkpoints the race object has passed: runtime state the
    /// original kept in the body's definition.
    pub race_progress: f64,
    pub shapes: Vec<MapShape>,
    pub extra: Extra,
    /// Box2D shapes of `shapes`, built on first use.
    #[serde(skip)]
    pub(crate) physics: PhysicsCache,
}

impl Default for BodyDef {
    fn default() -> Self {
        BodyDef {
            id: 0,
            density: 1.0,
            restitution: 0.5,
            friction: 0.5,
            linear_damping: 0.3,
            angular_damping: 0.5,
            kill_players: false,
            motion: 0.0,
            wrap: false,
            force_x: 0.0,
            force_y: 0.0,
            torque: 0.0,
            dynamic_threshold: 0.0,
            removal_threshold: 0.0,
            no_physics: false,
            z_index: 0.0,
            group: Group::named("a"),
            collide_a: true,
            collide_b: true,
            collide_c: true,
            collide_d: true,
            player_pass: 0.0,
            projectile_pass: 0.0,
            freeze_players: false,
            no_jump: false,
            bullet: false,
            invisible: false,
            parallax: 0.0,
            fixed_rotation: false,
            source_player: -1.0,
            ability_immune: false,
            objective: 0.0,
            objective_target: 0.0,
            unknown_63: true,
            pinned: false,
            pin_x: 0.0,
            pin_y: 0.0,
            force_zone: false,
            zone_x: 0.0,
            zone_y: 0.0,
            checkpoint: 0.0,
            race_object: false,
            race_progress: 0.0,
            shapes: Vec::new(),
            extra: Extra::default(),
            physics: PhysicsCache::default(),
        }
    }
}

/// A body as stored in the map (initial dynamic state + shared definition).
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq)]
pub struct MapBody {
    pub x: f64,
    pub y: f64,
    pub angle: f64,
    pub angular_velocity: f64,
    pub vx: f64,
    pub vy: f64,
    /// `16`: the body is teleported.
    pub teleported: bool,
    /// `20` accumulated damage.
    pub damage: f64,
    /// `56` lifetime countdown (-1 = none).
    pub lifetime: f64,
    /// `64` impact-sound limiter state.
    pub sound_limiter: f64,
    /// `pf` push attribution (player id -> weight).
    pub push_from: Vec<(u32, f64)>,
    pub def: Arc<BodyDef>,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq)]
pub struct MapJoint {
    /// `1`,`2` local anchor on body A; `3`,`4` on body B.
    pub ax: f64,
    pub ay: f64,
    pub bx: f64,
    pub by: f64,
    /// `5` 0 distance ("springy"), 1 revolute, 2 prismatic ("line").
    pub kind: f64,
    /// `6`
    pub collide_connected: bool,
    /// `7` body A id (-1 ground), `8` body B id.
    pub body_a: f64,
    pub body_b: f64,
    /// `9` frequency, `10` damping ratio, `11` length (distance joints).
    pub frequency: f64,
    pub damping: f64,
    pub length: f64,
    /// `12` motor speed, `13` max motor torque/force.
    pub motor_speed: f64,
    pub max_motor: f64,
    /// `14` player id overriding body A (-1 none).
    pub player_a: f64,
    /// `15`, meaning unknown.
    pub unknown_15: bool,
    /// `16` motor mode: 0 none, 1 stop at ends, 2 ping-pong, 3 latch.
    pub motor_mode: f64,
    /// `17` latched.
    pub latched: bool,
    /// `18`,`19` prismatic axis end point (body A local).
    pub axis_x: f64,
    pub axis_y: f64,
    pub extra: Extra,
}

impl Default for MapJoint {
    fn default() -> Self {
        MapJoint {
            ax: 0.0,
            ay: 0.0,
            bx: 0.0,
            by: 0.0,
            kind: 0.0,
            collide_connected: true,
            body_a: 0.0,
            body_b: 0.0,
            frequency: 0.5,
            damping: 0.5,
            length: 0.5,
            motor_speed: 0.0,
            max_motor: 0.0,
            player_a: -1.0,
            unknown_15: false,
            motor_mode: 0.0,
            latched: false,
            axis_x: 0.0,
            axis_y: 0.0,
            extra: Extra::default(),
        }
    }
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq)]
pub struct MapSpawn {
    pub x: f64,
    pub y: f64,
    pub priority: f64,
    pub angle: f64,
    /// Team usage flags indexed by team: [spectator, ffa, red, blue, unused].
    pub teams: [bool; 5],
    /// `8` capture-point sequence this spawn belongs to (-2 none).
    pub cap_sequence: f64,
    pub extra: Extra,
}

impl Default for MapSpawn {
    fn default() -> Self {
        MapSpawn {
            x: 0.0,
            y: 0.0,
            priority: 0.0,
            angle: 0.0,
            teams: [false, true, false, false, false],
            cap_sequence: -2.0,
            extra: Extra::default(),
        }
    }
}

/// Projectile parameters (shared by turrets and runtime projectiles).
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq)]
pub struct ProjectileDef {
    pub x: f64,
    pub y: f64,
    pub vx: f64,
    pub vy: f64,
    pub angle: f64,
    pub angular_velocity: f64,
    /// size
    pub size: f64,
    pub density: f64,
    pub friction: f64,
    pub restitution: f64,
    /// lifetime in ticks
    pub life: f64,
    /// player damage
    pub damage: f64,
    /// object damage
    pub object_damage: f64,
    /// owner player id
    pub owner: f64,
    /// homing turn rate
    pub turn_rate: f64,
    /// team
    pub team: f64,
    /// explosion radius
    pub explode_radius: f64,
    /// gravity scale
    pub gravity_scale: f64,
    /// bounces instead of exploding on walls
    pub bounces: bool,
    /// 0 round, 1 rocket, 2 capsule
    pub shape: f64,
    pub linear_damping: f64,
    /// bounce counter
    pub bounce_count: f64,
    /// bounce limit
    pub bounce_limit: f64,
    /// angle follows velocity
    pub align: bool,
    /// explosion damages players
    pub explode_damage: bool,
}

impl Default for ProjectileDef {
    fn default() -> Self {
        ProjectileDef {
            x: 0.0,
            y: 0.0,
            vx: 0.0,
            vy: 0.0,
            angle: 0.0,
            angular_velocity: 0.0,
            size: 0.1,
            density: 5.0,
            friction: 0.5,
            restitution: 0.0,
            life: 300.0,
            damage: 1.0,
            object_damage: 2.0,
            owner: 0.0,
            turn_rate: 0.0,
            team: 0.0,
            explode_radius: 0.0,
            gravity_scale: 0.0,
            bounces: false,
            shape: 0.0,
            linear_damping: 0.0,
            bounce_count: 0.0,
            bounce_limit: 0.0,
            align: false,
            explode_damage: false,
        }
    }
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq)]
pub struct MapTurret {
    pub x: f64,
    pub y: f64,
    pub vx: f64,
    pub vy: f64,
    pub angle: f64,
    pub angular_velocity: f64,
    /// health
    pub health: f64,
    /// max health
    pub max_health: f64,
    /// current cooldown
    pub cooldown: f64,
    /// team
    pub team: f64,
    /// fire interval
    pub fire_interval: f64,
    pub range: f64,
    pub bullet: ProjectileDef,
    pub extra: Extra,
}

impl Default for MapTurret {
    fn default() -> Self {
        MapTurret {
            x: 0.0,
            y: 0.0,
            vx: 0.0,
            vy: 0.0,
            angle: 0.0,
            angular_velocity: 0.0,
            health: 20.0,
            max_health: 20.0,
            cooldown: 0.0,
            team: 1.0,
            fire_interval: 10.0,
            range: 5.0,
            bullet: ProjectileDef::default(),
            extra: Extra::default(),
        }
    }
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq)]
pub struct MapGrapple {
    pub x: f64,
    pub y: f64,
    pub range: f64,
    /// attached body id (-1 = world)
    pub body: f64,
    pub extra: Extra,
}

impl Default for MapGrapple {
    fn default() -> Self {
        MapGrapple { x: 0.0, y: 0.0, range: 5.0, body: -1.0, extra: Extra::default() }
    }
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq)]
pub struct MapCap {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    /// sequence number (-1 none)
    pub sequence: f64,
    /// owner team
    pub owner: f64,
    /// team currently capturing
    pub capturer: f64,
    /// capture time
    pub capture_time: f64,
    /// progress
    pub progress: f64,
    pub extra: Extra,
}

impl Default for MapCap {
    fn default() -> Self {
        MapCap {
            x: 0.0,
            y: 0.0,
            width: 3.0,
            sequence: -1.0,
            owner: -1.0,
            capturer: -1.0,
            capture_time: 120.0,
            progress: 0.0,
            extra: Extra::default(),
        }
    }
}

/// A decoded map.
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, Default, PartialEq)]
pub struct MapData {
    pub settings: MapSettings,
    /// Bodies by id (sparse; ascending id order like a JS array).
    pub bodies: Vec<(u32, MapBody)>,
    pub joints: Vec<MapJoint>,
    pub spawns: Vec<MapSpawn>,
    pub turrets: Vec<MapTurret>,
    pub grapples: Vec<MapGrapple>,
    pub caps: Vec<MapCap>,
    /// Parse-only buckets (hidden in the original), kept verbatim.
    pub pickups: Vec<Value>,
    pub team_cores: Vec<Value>,
    /// Unknown top-level keys, kept verbatim for round-trips.
    pub extra: Map<String, Value>,
}

// ---------------------------------------------------------------- decoding

fn num(o: &Map<String, Value>, k: &str, d: f64) -> f64 {
    o.get(k).map_or(d, to_number)
}
fn flag(o: &Map<String, Value>, k: &str, d: bool) -> bool {
    o.get(k).map_or(d, truthy)
}
fn extra(o: &Map<String, Value>, known: &[&str]) -> Map<String, Value> {
    o.iter().filter(|(k, _)| !known.contains(&k.as_str())).map(|(k, v)| (k.clone(), v.clone())).collect()
}
fn extra_of(o: &Map<String, Value>, known: &[&str]) -> Extra {
    Extra::from_map(&extra(o, known))
}
fn obj(v: &Value) -> Result<&Map<String, Value>, MapError> {
    v.as_object().ok_or(MapError::BadStructure("object expected"))
}
fn list<'a>(root: &'a Map<String, Value>, k: &str, required: bool) -> Result<&'a [Value], MapError> {
    match root.get(k) {
        Some(Value::Array(a)) => Ok(a),
        None | Some(Value::Null) if !required => Ok(&[]),
        _ => Err(MapError::BadStructure("missing bucket")),
    }
}

fn decode_settings(o: &Map<String, Value>) -> Result<MapSettings, MapError> {
    use crate::map_keys::settings as k;
    let d = MapSettings::default();
    let wide = decode_aspect(o)?;
    let mut extra = extra(o, k::DECODED);
    if wide {
        extra.insert(k::ASPECT.into(), Value::from("wide"));
    }
    Ok(MapSettings {
        screen_width: crate::js::min(num(o, k::SCREEN_WIDTH, d.screen_width), 100.0),
        snap: num(o, k::SNAP, d.snap),
        unknown_5: num(o, k::UNKNOWN_5, d.unknown_5),
        bg_offset_x: num(o, k::BG_OFFSET_X, d.bg_offset_x),
        bg_offset_y: num(o, k::BG_OFFSET_Y, d.bg_offset_y),
        background_image: num(o, k::BACKGROUND_IMAGE, d.background_image),
        bg_scale: num(o, k::BG_SCALE, d.bg_scale),
        parallax: num(o, k::PARALLAX, d.parallax),
        color_top: num(o, k::COLOR_TOP, d.color_top),
        unknown_13: flag(o, k::UNKNOWN_13, d.unknown_13),
        width: num(o, k::WIDTH, d.width),
        height: num(o, k::HEIGHT, d.height),
        color_bottom: num(o, k::COLOR_BOTTOM, d.color_bottom),
        gravity: num(o, k::GRAVITY, d.gravity),
        wrap: flag(o, k::WRAP, d.wrap),
        wide,
        extra: Extra::from_map(&extra),
    })
}

/// The `aspect` key is Neobox's own (non-numeric, so the original never reads it): absent or `"classic"` is the original's 16:10, `"wide"` is 16:9.
fn decode_aspect(o: &Map<String, Value>) -> Result<bool, MapError> {
    match o.get(crate::map_keys::settings::ASPECT) {
        None => Ok(false),
        Some(Value::String(s)) if s == "classic" => Ok(false),
        Some(Value::String(s)) if s == "wide" => Ok(true),
        Some(_) => Err(MapError::BadStructure("settings aspect must be \"classic\" or \"wide\"")),
    }
}

fn decode_shape(o: &Map<String, Value>) -> MapShape {
    use crate::map_keys::shape as k;
    let d = MapShape::default();
    let opt = |key: &str| o.get(key).map(to_number);
    let mut points = Vec::new();
    if let Some(Value::Array(p)) = o.get(k::POINTS) {
        let mut i = 0;
        while i < p.len() {
            let x = to_number(&p[i]);
            let y = p.get(i + 1).map_or(f64::NAN, to_number);
            points.push([x, y]);
            i += 2;
        }
    }
    MapShape {
        kind: num(o, k::KIND, d.kind),
        x: num(o, k::X, d.x),
        y: num(o, k::Y, d.y),
        density: opt(k::DENSITY),
        friction: opt(k::FRICTION),
        restitution: opt(k::RESTITUTION),
        color: num(o, k::COLOR, d.color),
        closed: flag(o, k::CLOSED, d.closed),
        radius: num(o, k::RADIUS, d.radius),
        unknown_11: num(o, k::UNKNOWN_11, d.unknown_11),
        unknown_12: num(o, k::UNKNOWN_12, d.unknown_12),
        unknown_13: num(o, k::UNKNOWN_13, d.unknown_13),
        no_physics: flag(o, k::NO_PHYSICS, d.no_physics),
        z_index: num(o, k::Z_INDEX, d.z_index),
        points,
        extra: extra_of(o, k::DECODED),
    }
}

fn decode_body(o: &Map<String, Value>) -> Result<(f64, MapBody), MapError> {
    use crate::map_keys::body as k;
    let d = BodyDef::default();
    let id = num(o, k::ID, 0.0);
    // A legacy boolean is accepted: true = collide (0), false = pass (1)
    // and also disables projectile collision.
    let (player_pass, mut projectile_pass) = match o.get(k::PLAYER_PASS) {
        Some(Value::Bool(true)) => (0.0, d.projectile_pass),
        Some(Value::Bool(false)) => (1.0, 1.0),
        Some(v) => (to_number(v), d.projectile_pass),
        None => (d.player_pass, d.projectile_pass),
    };
    if let Some(v) = o.get(k::PROJECTILE_PASS) {
        projectile_pass = to_number(v);
    }
    let group = o.get(k::GROUP).map_or_else(|| d.group.clone(), Group::from_value);
    let mut shapes = Vec::new();
    for s in list(o, k::SHAPES, true)? {
        shapes.push(decode_shape(obj(s)?));
    }
    let mut push_from = Vec::new();
    if let Some(Value::Array(pf)) = o.get(k::PUSH_FROM) {
        let mut i = 0;
        while i + 1 < pf.len() {
            let key = to_number(&pf[i]);
            if key >= 0.0 && key.fract() == 0.0 && key <= MAX_OBJECT_ID {
                push_from.push((key as u32, to_number(&pf[i + 1])));
            }
            i += 2;
        }
        push_from.sort_by_key(|e| e.0);
        push_from.dedup_by_key(|e| e.0);
    }
    let def = BodyDef {
        id: if id >= 0.0 && id.fract() == 0.0 && id <= MAX_OBJECT_ID { id as u32 } else { 0 },
        density: num(o, k::DENSITY, d.density),
        restitution: num(o, k::RESTITUTION, d.restitution),
        friction: num(o, k::FRICTION, d.friction),
        linear_damping: num(o, k::LINEAR_DAMPING, d.linear_damping),
        angular_damping: num(o, k::ANGULAR_DAMPING, d.angular_damping),
        kill_players: flag(o, k::KILLS_PLAYERS, d.kill_players),
        motion: num(o, k::MOTION, d.motion),
        wrap: flag(o, k::WRAP, d.wrap),
        force_x: num(o, k::FORCE_X, d.force_x),
        force_y: num(o, k::FORCE_Y, d.force_y),
        torque: num(o, k::TORQUE, d.torque),
        dynamic_threshold: num(o, k::DYNAMIC_THRESHOLD, d.dynamic_threshold),
        removal_threshold: num(o, k::REMOVAL_THRESHOLD, d.removal_threshold),
        no_physics: flag(o, k::NO_PHYSICS, d.no_physics),
        z_index: num(o, k::Z_INDEX, d.z_index),
        group,
        collide_a: flag(o, k::COLLIDE_A, d.collide_a),
        collide_b: flag(o, k::COLLIDE_B, d.collide_b),
        collide_c: flag(o, k::COLLIDE_C, d.collide_c),
        collide_d: flag(o, k::COLLIDE_D, d.collide_d),
        player_pass,
        projectile_pass,
        freeze_players: flag(o, k::FREEZE_PLAYERS, d.freeze_players),
        no_jump: flag(o, k::NO_JUMP, d.no_jump),
        bullet: flag(o, k::BULLET, d.bullet),
        invisible: flag(o, k::INVISIBLE, d.invisible),
        parallax: num(o, k::PARALLAX, d.parallax),
        fixed_rotation: flag(o, k::FIXED_ROTATION, d.fixed_rotation),
        source_player: num(o, k::SOURCE_PLAYER, d.source_player),
        ability_immune: flag(o, k::ABILITY_IMMUNE, d.ability_immune),
        objective: num(o, k::OBJECTIVE, d.objective),
        objective_target: num(o, k::OBJECTIVE_TARGET, d.objective_target),
        unknown_63: flag(o, k::UNKNOWN_63, d.unknown_63),
        pinned: flag(o, k::PINNED, d.pinned),
        pin_x: num(o, k::PIN_X, d.pin_x),
        pin_y: num(o, k::PIN_Y, d.pin_y),
        force_zone: flag(o, k::FORCE_ZONE, d.force_zone),
        zone_x: num(o, k::ZONE_X, d.zone_x),
        zone_y: num(o, k::ZONE_Y, d.zone_y),
        checkpoint: num(o, k::CHECKPOINT, d.checkpoint),
        race_object: flag(o, k::RACE_OBJECT, d.race_object),
        race_progress: num(o, k::RACE_PROGRESS, d.race_progress),
        shapes,
        extra: extra_of(o, k::DECODED),
        physics: PhysicsCache::default(),
    };
    let body = MapBody {
        x: num(o, k::X, 0.0),
        y: num(o, k::Y, 0.0),
        angle: num(o, k::ANGLE, 0.0),
        angular_velocity: num(o, k::ANGULAR_VELOCITY, 0.0),
        vx: num(o, k::VX, 0.0),
        vy: num(o, k::VY, 0.0),
        teleported: flag(o, k::TELEPORTED, false),
        damage: num(o, k::DAMAGE, 0.0),
        lifetime: num(o, k::LIFETIME, -1.0),
        sound_limiter: num(o, k::SOUND_LIMITER, 1.0),
        push_from,
        def: Arc::new(def),
    };
    Ok((id, body))
}

fn decode_joint(o: &Map<String, Value>) -> MapJoint {
    use crate::map_keys::joint as k;
    let d = MapJoint::default();
    MapJoint {
        ax: num(o, k::AX, d.ax),
        ay: num(o, k::AY, d.ay),
        bx: num(o, k::BX, d.bx),
        by: num(o, k::BY, d.by),
        kind: num(o, k::KIND, d.kind),
        collide_connected: flag(o, k::COLLIDE_CONNECTED, d.collide_connected),
        body_a: num(o, k::BODY_A, d.body_a),
        body_b: num(o, k::BODY_B, d.body_b),
        frequency: num(o, k::FREQUENCY, d.frequency),
        damping: num(o, k::DAMPING, d.damping),
        length: num(o, k::LENGTH, d.length),
        motor_speed: num(o, k::MOTOR_SPEED, d.motor_speed),
        max_motor: num(o, k::MAX_MOTOR, d.max_motor),
        player_a: num(o, k::PLAYER_A, d.player_a),
        unknown_15: flag(o, k::UNKNOWN_15, d.unknown_15),
        motor_mode: num(o, k::MOTOR_MODE, d.motor_mode),
        latched: flag(o, k::LATCHED, d.latched),
        axis_x: num(o, k::AXIS_X, d.axis_x),
        axis_y: num(o, k::AXIS_Y, d.axis_y),
        extra: extra_of(o, k::DECODED),
    }
}

fn decode_spawn(o: &Map<String, Value>) -> MapSpawn {
    use crate::map_keys::spawn as k;
    let d = MapSpawn::default();
    let mut teams = d.teams;
    teams[1] = flag(o, k::TEAM_FFA, teams[1]);
    teams[2] = flag(o, k::TEAM_RED, teams[2]);
    teams[3] = flag(o, k::TEAM_BLUE, teams[3]);
    MapSpawn {
        x: num(o, k::X, d.x),
        y: num(o, k::Y, d.y),
        priority: num(o, k::PRIORITY, d.priority),
        angle: num(o, k::ANGLE, d.angle),
        teams,
        cap_sequence: num(o, k::CAP_SEQUENCE, d.cap_sequence),
        extra: extra_of(o, k::DECODED),
    }
}

fn decode_turret(o: &Map<String, Value>) -> MapTurret {
    use crate::map_keys::{bullet, turret as k};
    let d = MapTurret::default();
    let b = &d.bullet;
    let bullet = ProjectileDef {
        vx: num(o, bullet::VX, b.vx),
        size: num(o, bullet::SIZE, b.size),
        density: num(o, bullet::DENSITY, b.density),
        friction: num(o, bullet::FRICTION, b.friction),
        restitution: num(o, bullet::RESTITUTION, b.restitution),
        life: num(o, bullet::LIFE, b.life),
        damage: num(o, bullet::DAMAGE, b.damage),
        turn_rate: num(o, bullet::TURN_RATE, b.turn_rate),
        explode_radius: num(o, bullet::EXPLODE_RADIUS, b.explode_radius),
        bounces: flag(o, bullet::BOUNCES, b.bounces),
        shape: num(o, bullet::SHAPE, b.shape),
        linear_damping: num(o, bullet::LINEAR_DAMPING, b.linear_damping),
        ..b.clone()
    };
    MapTurret {
        x: num(o, k::X, d.x),
        y: num(o, k::Y, d.y),
        vx: num(o, k::VX, d.vx),
        vy: num(o, k::VY, d.vy),
        angle: num(o, k::ANGLE, d.angle),
        angular_velocity: num(o, k::ANGULAR_VELOCITY, d.angular_velocity),
        health: num(o, k::HEALTH, d.health),
        cooldown: num(o, k::COOLDOWN, d.cooldown),
        team: num(o, k::TEAM, d.team),
        fire_interval: num(o, k::FIRE_INTERVAL, d.fire_interval),
        range: num(o, k::RANGE, d.range),
        max_health: num(o, k::MAX_HEALTH, d.max_health),
        bullet,
        extra: extra_of(o, k::DECODED),
    }
}

fn decode_grapple(o: &Map<String, Value>) -> MapGrapple {
    use crate::map_keys::grapple as k;
    let d = MapGrapple::default();
    MapGrapple {
        x: num(o, k::X, d.x),
        y: num(o, k::Y, d.y),
        range: num(o, k::RANGE, d.range),
        body: num(o, k::BODY, d.body),
        extra: extra_of(o, k::DECODED),
    }
}

fn decode_cap(o: &Map<String, Value>) -> MapCap {
    use crate::map_keys::cap as k;
    let d = MapCap::default();
    MapCap {
        x: num(o, k::X, d.x),
        y: num(o, k::Y, d.y),
        width: num(o, k::WIDTH, d.width),
        sequence: num(o, k::SEQUENCE, d.sequence),
        owner: num(o, k::OWNER, d.owner),
        capturer: num(o, k::CAPTURER, d.capturer),
        capture_time: num(o, k::CAPTURE_TIME, d.capture_time),
        progress: num(o, k::PROGRESS, d.progress),
        extra: extra_of(o, k::DECODED),
    }
}

impl MapData {
    /// Decode a map from its compact JSON object.
    pub fn from_json(v: &Value) -> Result<MapData, MapError> {
        use crate::map_keys::root as top;
        let root = obj(v)?;
        let mut map = MapData::default();
        for b in list(root, top::BODIES, true)? {
            let (id, body) = decode_body(obj(b)?)?;
            // JS stores `pl[id] = body`: non-index ids are not iterated.
            if id >= 0.0 && id.fract() == 0.0 && id <= MAX_OBJECT_ID {
                let id = id as u32;
                match map.bodies.binary_search_by_key(&id, |e| e.0) {
                    Ok(i) => map.bodies[i].1 = body,
                    Err(i) => map.bodies.insert(i, (id, body)),
                }
            } else if id >= 0.0 && id.fract() == 0.0 {
                return Err(MapError::BadStructure("body id too large"));
            }
        }
        let shapes: usize = map.bodies.iter().map(|b| b.1.def.shapes.len()).sum();
        if shapes > MAX_MAP_SHAPES {
            return Err(MapError::TooComplex { what: "shapes", count: shapes, limit: MAX_MAP_SHAPES });
        }
        let vertices: usize = map.bodies.iter().flat_map(|b| &b.1.def.shapes).map(|s| s.points.len()).sum();
        if vertices > MAX_MAP_VERTICES {
            return Err(MapError::TooComplex { what: "polygon vertices", count: vertices, limit: MAX_MAP_VERTICES });
        }
        for j in list(root, top::JOINTS, true)? {
            map.joints.push(decode_joint(obj(j)?));
        }
        for s in list(root, top::SPAWNS, true)? {
            map.spawns.push(decode_spawn(obj(s)?));
        }
        map.pickups = list(root, top::PICKUPS, false)?.to_vec();
        for t in list(root, top::TURRETS, false)? {
            map.turrets.push(decode_turret(obj(t)?));
        }
        map.team_cores = list(root, top::TEAM_CORES, false)?.to_vec();
        for g in list(root, top::GRAPPLES, false)? {
            map.grapples.push(decode_grapple(obj(g)?));
        }
        for c in list(root, top::CAPS, false)? {
            map.caps.push(decode_cap(obj(c)?));
        }
        map.settings = match root.get(top::SETTINGS) {
            Some(Value::Object(o)) => decode_settings(o)?,
            _ => return Err(MapError::BadStructure("missing settings")),
        };
        map.extra = extra(root, top::DECODED);
        Ok(map)
    }

    /// Decode a Hitbox map code.
    pub fn from_code(code: &str) -> Result<MapData, MapError> {
        let json = decode_code(code)?;
        let v: Value = serde_json::from_str(&json).map_err(|e| MapError::BadJson(e.to_string()))?;
        MapData::from_json(&v)
    }

    /// Encode as compact JSON with the original writer's default omission.
    pub fn to_json(&self) -> Value {
        use crate::map_keys::root as top;
        let mut root = Map::new();
        root.insert(top::BODIES.into(), Value::Array(self.bodies.iter().map(|(id, b)| encode_body(*id, b)).collect()));
        root.insert(top::JOINTS.into(), Value::Array(self.joints.iter().map(encode_joint).collect()));
        root.insert(top::SPAWNS.into(), Value::Array(self.spawns.iter().map(encode_spawn).collect()));
        root.insert(top::PICKUPS.into(), Value::Array(self.pickups.clone()));
        root.insert(top::TURRETS.into(), Value::Array(self.turrets.iter().map(encode_turret).collect()));
        root.insert(top::TEAM_CORES.into(), Value::Array(self.team_cores.clone()));
        root.insert(top::GRAPPLES.into(), Value::Array(self.grapples.iter().map(encode_grapple).collect()));
        root.insert(top::CAPS.into(), Value::Array(self.caps.iter().map(encode_cap).collect()));
        root.insert(top::SETTINGS.into(), encode_settings(&self.settings));
        for (k, v) in &self.extra {
            root.insert(k.clone(), v.clone());
        }
        Value::Object(root)
    }

    /// Encode as a Hitbox-compatible map code.
    pub fn to_code(&self) -> String {
        encode_code(&self.to_json().to_string())
    }
}

// ---------------------------------------------------------------- encoding

struct Out(Map<String, Value>);
impl Out {
    fn n(&mut self, k: &str, v: f64, d: f64) {
        // J$.R: emit when `v != d` (JS loose inequality on numbers)
        if v != d || (v.is_nan() && d.is_nan()) {
            self.0.insert(k.into(), num_value(v));
        }
    }
    fn b(&mut self, k: &str, v: bool, d: bool) {
        if v != d {
            self.0.insert(k.into(), Value::Bool(v));
        }
    }
    fn always(&mut self, k: &str, v: Value) {
        self.0.insert(k.into(), v);
    }
    fn extra(mut self, e: &Extra) -> Value {
        for (k, v) in e.to_map() {
            self.0.entry(k).or_insert(v);
        }
        Value::Object(self.0)
    }
}

/// JSON number for an f64 (JSON has no NaN/Infinity: JS stringifies them as null).
pub fn num_value(v: f64) -> Value {
    if v.is_finite() {
        if v.fract() == 0.0 && v.abs() < 9007199254740992.0 {
            Value::from(v as i64)
        } else {
            serde_json::Number::from_f64(v).map_or(Value::Null, Value::Number)
        }
    } else {
        Value::Null
    }
}

fn encode_settings(s: &MapSettings) -> Value {
    use crate::map_keys::settings as k;
    let d = MapSettings::default();
    let mut o = Out(Map::new());
    o.n(k::SCREEN_WIDTH, s.screen_width, d.screen_width);
    o.n(k::SNAP, s.snap, d.snap);
    o.n(k::UNKNOWN_5, s.unknown_5, d.unknown_5);
    o.n(k::BG_OFFSET_X, s.bg_offset_x, d.bg_offset_x);
    o.n(k::BG_OFFSET_Y, s.bg_offset_y, d.bg_offset_y);
    o.n(k::BACKGROUND_IMAGE, s.background_image, d.background_image);
    o.n(k::BG_SCALE, s.bg_scale, d.bg_scale);
    o.n(k::PARALLAX, s.parallax, d.parallax);
    o.n(k::COLOR_TOP, s.color_top, d.color_top);
    o.b(k::UNKNOWN_13, s.unknown_13, d.unknown_13);
    o.n(k::WIDTH, s.width, d.width);
    o.n(k::HEIGHT, s.height, d.height);
    o.n(k::COLOR_BOTTOM, s.color_bottom, d.color_bottom);
    o.n(k::GRAVITY, s.gravity, d.gravity);
    o.b(k::WRAP, s.wrap, d.wrap);
    if s.wide {
        o.0.insert(k::ASPECT.into(), Value::from("wide"));
    }
    o.extra(&s.extra)
}

fn encode_shape(s: &MapShape) -> Value {
    use crate::map_keys::shape as k;
    let d = MapShape::default();
    let mut o = Out(Map::new());
    o.n(k::KIND, s.kind, d.kind);
    o.n(k::X, s.x, d.x);
    o.n(k::Y, s.y, d.y);
    if let Some(v) = s.density {
        o.always(k::DENSITY, num_value(v));
    }
    if let Some(v) = s.friction {
        o.always(k::FRICTION, num_value(v));
    }
    if let Some(v) = s.restitution {
        o.always(k::RESTITUTION, num_value(v));
    }
    o.n(k::COLOR, s.color, d.color);
    o.b(k::CLOSED, s.closed, d.closed);
    o.n(k::RADIUS, s.radius, d.radius);
    o.n(k::UNKNOWN_11, s.unknown_11, d.unknown_11);
    o.n(k::UNKNOWN_12, s.unknown_12, d.unknown_12);
    o.n(k::UNKNOWN_13, s.unknown_13, d.unknown_13);
    o.b(k::NO_PHYSICS, s.no_physics, d.no_physics);
    o.n(k::Z_INDEX, s.z_index, d.z_index);
    let mut p = Vec::with_capacity(s.points.len() * 2);
    for (i, v) in s.points.iter().enumerate() {
        p.push(num_value(v[0]));
        // A trailing point with no y (odd-length `p`) is written without it:
        // the original reads the missing y as undefined, not null.
        if i + 1 < s.points.len() || !v[1].is_nan() {
            p.push(num_value(v[1]));
        }
    }
    o.always(k::POINTS, Value::Array(p));
    o.extra(&s.extra)
}

fn encode_body(id: u32, b: &MapBody) -> Value {
    use crate::map_keys::body as k;
    let d = BodyDef::default();
    let f = &b.def;
    let mut o = Out(Map::new());
    o.n(k::ID, id as f64, 0.0);
    o.n(k::X, b.x, 0.0);
    o.n(k::Y, b.y, 0.0);
    o.n(k::ANGLE, b.angle, 0.0);
    o.n(k::ANGULAR_VELOCITY, b.angular_velocity, 0.0);
    o.n(k::VX, b.vx, 0.0);
    o.n(k::VY, b.vy, 0.0);
    o.n(k::DENSITY, f.density, d.density);
    o.n(k::RESTITUTION, f.restitution, d.restitution);
    o.n(k::FRICTION, f.friction, d.friction);
    o.n(k::LINEAR_DAMPING, f.linear_damping, d.linear_damping);
    o.n(k::ANGULAR_DAMPING, f.angular_damping, d.angular_damping);
    o.b(k::KILLS_PLAYERS, f.kill_players, d.kill_players);
    o.n(k::MOTION, f.motion, d.motion);
    o.b(k::WRAP, f.wrap, d.wrap);
    o.b(k::TELEPORTED, b.teleported, false);
    o.n(k::FORCE_X, f.force_x, d.force_x);
    o.n(k::FORCE_Y, f.force_y, d.force_y);
    o.n(k::TORQUE, f.torque, d.torque);
    o.n(k::DAMAGE, b.damage, 0.0);
    o.n(k::DYNAMIC_THRESHOLD, f.dynamic_threshold, d.dynamic_threshold);
    o.n(k::REMOVAL_THRESHOLD, f.removal_threshold, d.removal_threshold);
    o.b(k::NO_PHYSICS, f.no_physics, d.no_physics);
    o.n(k::Z_INDEX, f.z_index, d.z_index);
    if f.group != d.group {
        o.always(k::GROUP, f.group.to_value());
    }
    o.b(k::COLLIDE_A, f.collide_a, d.collide_a);
    o.b(k::COLLIDE_B, f.collide_b, d.collide_b);
    o.b(k::COLLIDE_C, f.collide_c, d.collide_c);
    o.b(k::COLLIDE_D, f.collide_d, d.collide_d);
    o.n(k::PLAYER_PASS, f.player_pass, d.player_pass);
    o.n(k::CHECKPOINT, f.checkpoint, d.checkpoint);
    o.b(k::FREEZE_PLAYERS, f.freeze_players, d.freeze_players);
    o.b(k::RACE_OBJECT, f.race_object, d.race_object);
    o.b(k::PINNED, f.pinned, d.pinned);
    o.n(k::PIN_X, f.pin_x, d.pin_x);
    o.n(k::PIN_Y, f.pin_y, d.pin_y);
    o.b(k::FORCE_ZONE, f.force_zone, d.force_zone);
    o.n(k::ZONE_X, f.zone_x, d.zone_x);
    o.n(k::ZONE_Y, f.zone_y, d.zone_y);
    o.b(k::NO_JUMP, f.no_jump, d.no_jump);
    o.n(k::RACE_PROGRESS, f.race_progress, d.race_progress);
    o.b(k::BULLET, f.bullet, d.bullet);
    o.b(k::INVISIBLE, f.invisible, d.invisible);
    o.n(k::PARALLAX, f.parallax, d.parallax);
    o.n(k::LIFETIME, b.lifetime, -1.0);
    o.b(k::FIXED_ROTATION, f.fixed_rotation, d.fixed_rotation);
    o.n(k::SOURCE_PLAYER, f.source_player, d.source_player);
    o.b(k::ABILITY_IMMUNE, f.ability_immune, d.ability_immune);
    o.n(k::OBJECTIVE, f.objective, d.objective);
    o.n(k::OBJECTIVE_TARGET, f.objective_target, d.objective_target);
    o.b(k::UNKNOWN_63, f.unknown_63, d.unknown_63);
    o.n(k::SOUND_LIMITER, b.sound_limiter, 1.0);
    o.n(k::PROJECTILE_PASS, f.projectile_pass, d.projectile_pass);
    o.always(k::SHAPES, Value::Array(f.shapes.iter().map(encode_shape).collect()));
    if !b.push_from.is_empty() {
        let mut pf = Vec::new();
        for (k, w) in &b.push_from {
            pf.push(Value::from(*k));
            pf.push(num_value(*w));
        }
        o.always(k::PUSH_FROM, Value::Array(pf));
    }
    o.extra(&f.extra)
}

fn encode_joint(j: &MapJoint) -> Value {
    use crate::map_keys::joint as k;
    let d = MapJoint::default();
    let mut o = Out(Map::new());
    o.n(k::AX, j.ax, d.ax);
    o.n(k::AY, j.ay, d.ay);
    o.n(k::BX, j.bx, d.bx);
    o.n(k::BY, j.by, d.by);
    o.always(k::KIND, num_value(j.kind));
    o.always(k::COLLIDE_CONNECTED, Value::Bool(j.collide_connected));
    o.always(k::BODY_A, num_value(j.body_a));
    o.always(k::BODY_B, num_value(j.body_b));
    o.always(k::FREQUENCY, num_value(j.frequency));
    o.always(k::DAMPING, num_value(j.damping));
    o.always(k::LENGTH, num_value(j.length));
    o.always(k::MOTOR_SPEED, num_value(j.motor_speed));
    o.always(k::MAX_MOTOR, num_value(j.max_motor));
    o.n(k::PLAYER_A, j.player_a, d.player_a);
    o.b(k::UNKNOWN_15, j.unknown_15, d.unknown_15);
    o.n(k::MOTOR_MODE, j.motor_mode, d.motor_mode);
    o.b(k::LATCHED, j.latched, d.latched);
    o.n(k::AXIS_X, j.axis_x, d.axis_x);
    o.n(k::AXIS_Y, j.axis_y, d.axis_y);
    o.extra(&j.extra)
}

fn encode_spawn(s: &MapSpawn) -> Value {
    use crate::map_keys::spawn as k;
    let d = MapSpawn::default();
    let mut o = Out(Map::new());
    o.n(k::X, s.x, d.x);
    o.n(k::Y, s.y, d.y);
    o.n(k::PRIORITY, s.priority, d.priority);
    o.n(k::ANGLE, s.angle, d.angle);
    o.b(k::TEAM_FFA, s.teams[1], d.teams[1]);
    o.b(k::TEAM_RED, s.teams[2], d.teams[2]);
    o.b(k::TEAM_BLUE, s.teams[3], d.teams[3]);
    o.n(k::CAP_SEQUENCE, s.cap_sequence, d.cap_sequence);
    o.extra(&s.extra)
}

fn encode_turret(t: &MapTurret) -> Value {
    use crate::map_keys::{bullet, turret as k};
    let d = MapTurret::default();
    let b = &d.bullet;
    let mut o = Out(Map::new());
    o.n(k::X, t.x, d.x);
    o.n(k::Y, t.y, d.y);
    o.n(k::VX, t.vx, d.vx);
    o.n(k::VY, t.vy, d.vy);
    o.n(k::ANGLE, t.angle, d.angle);
    o.n(k::ANGULAR_VELOCITY, t.angular_velocity, d.angular_velocity);
    o.n(k::HEALTH, t.health, d.health);
    o.n(k::COOLDOWN, t.cooldown, d.cooldown);
    o.n(k::TEAM, t.team, d.team);
    o.n(k::FIRE_INTERVAL, t.fire_interval, d.fire_interval);
    o.n(k::RANGE, t.range, d.range);
    o.n(bullet::VX, t.bullet.vx, b.vx);
    o.n(bullet::SIZE, t.bullet.size, b.size);
    o.n(bullet::DENSITY, t.bullet.density, b.density);
    o.n(bullet::FRICTION, t.bullet.friction, b.friction);
    o.n(bullet::RESTITUTION, t.bullet.restitution, b.restitution);
    o.n(bullet::LIFE, t.bullet.life, b.life);
    o.n(bullet::DAMAGE, t.bullet.damage, b.damage);
    o.n(bullet::TURN_RATE, t.bullet.turn_rate, b.turn_rate);
    o.n(bullet::EXPLODE_RADIUS, t.bullet.explode_radius, b.explode_radius);
    o.b(bullet::BOUNCES, t.bullet.bounces, b.bounces);
    o.n(bullet::SHAPE, t.bullet.shape, b.shape);
    o.n(bullet::LINEAR_DAMPING, t.bullet.linear_damping, b.linear_damping);
    o.n(k::MAX_HEALTH, t.max_health, d.max_health);
    o.extra(&t.extra)
}

fn encode_grapple(g: &MapGrapple) -> Value {
    use crate::map_keys::grapple as k;
    let d = MapGrapple::default();
    let mut o = Out(Map::new());
    o.n(k::X, g.x, d.x);
    o.n(k::Y, g.y, d.y);
    o.n(k::RANGE, g.range, d.range);
    o.n(k::BODY, g.body, d.body);
    o.extra(&g.extra)
}

fn encode_cap(c: &MapCap) -> Value {
    use crate::map_keys::cap as k;
    let d = MapCap::default();
    let mut o = Out(Map::new());
    o.n(k::X, c.x, d.x);
    o.n(k::Y, c.y, d.y);
    o.n(k::WIDTH, c.width, d.width);
    o.n(k::SEQUENCE, c.sequence, d.sequence);
    o.n(k::OWNER, c.owner, d.owner);
    o.n(k::CAPTURER, c.capturer, d.capturer);
    o.n(k::CAPTURE_TIME, c.capture_time, d.capture_time);
    o.n(k::PROGRESS, c.progress, d.progress);
    o.extra(&c.extra)
}

// ---------------------------------------------------------------- code <-> json

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn percent_decode(s: &str) -> Result<Vec<u8>, MapError> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let h = |c: u8| (c as char).to_digit(16).ok_or(MapError::BadEncoding("bad percent escape"));
            let hi = h(*b.get(i + 1).ok_or(MapError::BadEncoding("truncated percent escape"))?)?;
            let lo = h(*b.get(i + 2).ok_or(MapError::BadEncoding("truncated percent escape"))?)?;
            out.push((hi * 16 + lo) as u8);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    Ok(out)
}

fn base64_decode(s: &[u8]) -> Result<Vec<u8>, MapError> {
    // atob(): ignores ASCII whitespace, accepts optional padding.
    let mut vals = Vec::with_capacity(s.len());
    for &c in s {
        match c {
            b'A'..=b'Z' => vals.push(c - b'A'),
            b'a'..=b'z' => vals.push(c - b'a' + 26),
            b'0'..=b'9' => vals.push(c - b'0' + 52),
            b'+' => vals.push(62),
            b'/' => vals.push(63),
            b'=' | b' ' | b'\t' | b'\n' | b'\r' | b'\x0c' => {}
            _ => return Err(MapError::BadEncoding("invalid base64")),
        }
    }
    if vals.len() % 4 == 1 {
        return Err(MapError::BadEncoding("invalid base64 length"));
    }
    let mut out = Vec::with_capacity(vals.len() * 3 / 4);
    for ch in vals.chunks(4) {
        let n = ch.iter().enumerate().fold(0u32, |a, (i, &v)| a | (v as u32) << (18 - 6 * i));
        out.push((n >> 16) as u8);
        if ch.len() > 2 {
            out.push((n >> 8) as u8);
        }
        if ch.len() > 3 {
            out.push(n as u8);
        }
    }
    Ok(out)
}

fn base64_encode(b: &[u8]) -> String {
    let mut s = String::with_capacity(b.len().div_ceil(3) * 4);
    for ch in b.chunks(3) {
        let n = (ch[0] as u32) << 16 | (*ch.get(1).unwrap_or(&0) as u32) << 8 | *ch.get(2).unwrap_or(&0) as u32;
        s.push(B64[(n >> 18) as usize & 63] as char);
        s.push(B64[(n >> 12) as usize & 63] as char);
        s.push(if ch.len() > 1 { B64[(n >> 6) as usize & 63] as char } else { '=' });
        s.push(if ch.len() > 2 { B64[n as usize & 63] as char } else { '=' });
    }
    s
}

/// Decode a map code into its JSON text.
///
/// pako's `inflate(..., {to: "string"})` decodes the output as UTF-8.
pub fn decode_code(code: &str) -> Result<String, MapError> {
    if code.len() > MAX_CODE_LEN {
        return Err(MapError::TooLarge);
    }
    let b64 = percent_decode(code.trim())?;
    let deflated = base64_decode(&b64)?;
    let raw = miniz_oxide::inflate::decompress_to_vec_zlib_with_limit(&deflated, MAX_JSON_LEN)
        .or_else(|_| miniz_oxide::inflate::decompress_to_vec_with_limit(&deflated, MAX_JSON_LEN))
        .map_err(|_| MapError::BadEncoding("bad compressed data"))?;
    Ok(String::from_utf8_lossy(&raw).into_owned())
}

/// Encode JSON text into a map code (UTF-8, zlib default level, base64,
/// `encodeURIComponent`).
pub fn encode_code(json: &str) -> String {
    let z = miniz_oxide::deflate::compress_to_vec_zlib(json.as_bytes(), 6);
    let b = base64_encode(&z);
    let mut out = String::with_capacity(b.len() + 16);
    for c in b.chars() {
        match c {
            '+' => out.push_str("%2B"),
            '/' => out.push_str("%2F"),
            '=' => out.push_str("%3D"),
            _ => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod aspect_tests {
    use super::*;
    use serde_json::json;

    fn obj(v: Value) -> Map<String, Value> {
        match v {
            Value::Object(o) => o,
            _ => panic!("not an object"),
        }
    }

    fn decode(v: Value) -> MapSettings {
        match decode_settings(&obj(v)) {
            Ok(s) => s,
            Err(_) => panic!("settings should decode"),
        }
    }

    #[test]
    fn absent_aspect_is_classic() {
        let s = decode(json!({ "3": 30 }));
        assert!(!s.wide);
        assert_eq!(s.view_aspect(), CLASSIC_VIEW_ASPECT);
    }

    #[test]
    fn explicit_classic_is_classic_and_not_written_back() {
        let s = decode(json!({ "aspect": "classic" }));
        assert!(!s.wide);
        assert!(encode_settings(&s).get("aspect").is_none());
    }

    #[test]
    fn wide_round_trips_through_encode() {
        let s = decode(json!({ "aspect": "wide" }));
        assert!(s.wide);
        assert_eq!(s.view_aspect(), WIDE_VIEW_ASPECT);
        let encoded = encode_settings(&s);
        assert!(encoded["aspect"] == "wide");
        assert!(decode(encoded).wide);
    }

    #[test]
    fn default_settings_are_classic_for_imports() {
        assert!(!MapSettings::default().wide);
    }

    #[test]
    fn unknown_aspect_is_rejected() {
        assert!(decode_settings(&obj(json!({ "aspect": "square" }))).is_err());
    }
}
