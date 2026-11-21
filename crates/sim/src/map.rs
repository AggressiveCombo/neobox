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
    /// `5` unused enum (kept for round-trip).
    pub gn: f64,
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
    /// `13` flag (`Qn`).
    pub qn: bool,
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
            gn: 1.0,
            bg_offset_x: 0.0,
            bg_offset_y: 0.0,
            background_image: 0.0,
            bg_scale: 1.0,
            parallax: 0.9,
            color_top: 16777215.0,
            qn: false,
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
    /// `11`/`12`/`13` editor/render fields.
    pub aa: f64,
    pub la: f64,
    pub ua: f64,
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
            aa: 0.0,
            la: 0.0,
            ua: 1.0,
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
    /// `61` objective flag (`sa`), `62` objective target (`ha`), `63` (`ea`).
    pub objective: f64,
    pub objective_target: f64,
    pub ea: bool,
    /// `36` pinned to the ground with a revolute joint at local (`37`,`38`).
    pub pinned: bool,
    pub pin_x: f64,
    pub pin_y: f64,
    /// `39` force zone with force (`40`,`41`).
    pub force_zone: bool,
    pub zone_x: f64,
    pub zone_y: f64,
    /// `31` race checkpoint number (`Ko`, 0 = none). Players pass the
    /// checkpoints in order; the highest number is the finish.
    pub checkpoint: f64,
    /// `34` race object (`Qo`): it must be carried through the
    /// checkpoints in order, and reaching the finish ends the round.
    pub race_object: bool,
    /// `44` checkpoints the race object has passed (`$o`): runtime state the
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
            ea: true,
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
    /// `16`
    pub ye: bool,
    /// `20` accumulated damage.
    pub damage: f64,
    /// `56` lifetime countdown (-1 = none).
    pub lifetime: f64,
    /// `64` impact-sound limiter state.
    pub va: f64,
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
    /// `15`
    pub ha: bool,
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
            ha: false,
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
    /// size (`u`)
    pub size: f64,
    pub density: f64,
    pub friction: f64,
    pub restitution: f64,
    /// lifetime in ticks (`m`)
    pub life: f64,
    /// player damage (`g`)
    pub damage: f64,
    /// object damage (`v`)
    pub object_damage: f64,
    /// owner player id (`k`)
    pub owner: f64,
    /// homing turn rate (`S`)
    pub turn_rate: f64,
    /// team (`N`)
    pub team: f64,
    /// explosion radius (`M`)
    pub explode_radius: f64,
    /// gravity scale (`C`)
    pub gravity_scale: f64,
    /// bounces instead of exploding on walls (`T`)
    pub bounces: bool,
    /// 0 round, 1 rocket ("L"), 2 capsule ("U")
    pub shape: f64,
    pub linear_damping: f64,
    /// bounce counter (`_`)
    pub bounce_count: f64,
    /// bounce limit (`P`)
    pub bounce_limit: f64,
    /// angle follows velocity (`B`)
    pub align: bool,
    /// explosion damages players (`I`)
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
    /// health (`qe`)
    pub health: f64,
    /// max health (`Nl`)
    pub max_health: f64,
    /// current cooldown (`Ml`)
    pub cooldown: f64,
    /// team (`N`)
    pub team: f64,
    /// fire interval (`Cl`)
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
    /// sequence number (`Mr`, -1 none)
    pub sequence: f64,
    /// owner team (`Sr`)
    pub owner: f64,
    /// team currently capturing (`qu`)
    pub capturer: f64,
    /// capture time (`Vu`)
    pub capture_time: f64,
    /// progress (`Ku`)
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
    let d = MapSettings::default();
    let wide = decode_aspect(o)?;
    let mut extra = extra(o, &["3", "4", "5", "7", "8", "9", "10", "11", "12", "13", "15", "16", "17", "18", "19", "aspect"]);
    if wide {
        extra.insert("aspect".into(), Value::from("wide"));
    }
    Ok(MapSettings {
        screen_width: crate::js::min(num(o, "3", d.screen_width), 100.0),
        snap: num(o, "4", d.snap),
        gn: num(o, "5", d.gn),
        bg_offset_x: num(o, "7", d.bg_offset_x),
        bg_offset_y: num(o, "8", d.bg_offset_y),
        background_image: num(o, "9", d.background_image),
        bg_scale: num(o, "10", d.bg_scale),
        parallax: num(o, "11", d.parallax),
        color_top: num(o, "12", d.color_top),
        qn: flag(o, "13", d.qn),
        width: num(o, "15", d.width),
        height: num(o, "16", d.height),
        color_bottom: num(o, "17", d.color_bottom),
        gravity: num(o, "18", d.gravity),
        wrap: flag(o, "19", d.wrap),
        wide,
        extra: Extra::from_map(&extra),
    })
}

/// The `aspect` key is Neobox's own (non-numeric, so the original never reads it): absent or `"classic"` is the original's 16:10, `"wide"` is 16:9.
fn decode_aspect(o: &Map<String, Value>) -> Result<bool, MapError> {
    match o.get("aspect") {
        None => Ok(false),
        Some(Value::String(s)) if s == "classic" => Ok(false),
        Some(Value::String(s)) if s == "wide" => Ok(true),
        Some(_) => Err(MapError::BadStructure("settings aspect must be \"classic\" or \"wide\"")),
    }
}

fn decode_shape(o: &Map<String, Value>) -> MapShape {
    let d = MapShape::default();
    let opt = |k: &str| o.get(k).map(to_number);
    let mut points = Vec::new();
    if let Some(Value::Array(p)) = o.get("p") {
        let mut i = 0;
        while i < p.len() {
            let x = to_number(&p[i]);
            let y = p.get(i + 1).map_or(f64::NAN, to_number);
            points.push([x, y]);
            i += 2;
        }
    }
    MapShape {
        kind: num(o, "1", d.kind),
        x: num(o, "2", d.x),
        y: num(o, "3", d.y),
        density: opt("4"),
        friction: opt("5"),
        restitution: opt("6"),
        color: num(o, "7", d.color),
        closed: flag(o, "8", d.closed),
        radius: num(o, "9", d.radius),
        aa: num(o, "11", d.aa),
        la: num(o, "12", d.la),
        ua: num(o, "13", d.ua),
        no_physics: flag(o, "14", d.no_physics),
        z_index: num(o, "15", d.z_index),
        points,
        extra: extra_of(o, &["1", "2", "3", "4", "5", "6", "7", "8", "9", "11", "12", "13", "14", "15", "p"]),
    }
}

fn decode_body(o: &Map<String, Value>) -> Result<(f64, MapBody), MapError> {
    let d = BodyDef::default();
    let id = num(o, "1", 0.0);
    // Field 30 accepts a legacy boolean: true = collide (0), false = pass (1)
    // and also disables projectile collision.
    let (player_pass, mut projectile_pass) = match o.get("30") {
        Some(Value::Bool(true)) => (0.0, d.projectile_pass),
        Some(Value::Bool(false)) => (1.0, 1.0),
        Some(v) => (to_number(v), d.projectile_pass),
        None => (d.player_pass, d.projectile_pass),
    };
    if let Some(v) = o.get("65") {
        projectile_pass = to_number(v);
    }
    let group = o.get("25").map_or_else(|| d.group.clone(), Group::from_value);
    let mut shapes = Vec::new();
    for s in list(o, "s", true)? {
        shapes.push(decode_shape(obj(s)?));
    }
    let mut push_from = Vec::new();
    if let Some(Value::Array(pf)) = o.get("pf") {
        let mut i = 0;
        while i + 1 < pf.len() {
            let k = to_number(&pf[i]);
            if k >= 0.0 && k.fract() == 0.0 && k <= MAX_OBJECT_ID {
                push_from.push((k as u32, to_number(&pf[i + 1])));
            }
            i += 2;
        }
        push_from.sort_by_key(|e| e.0);
        push_from.dedup_by_key(|e| e.0);
    }
    let def = BodyDef {
        id: if id >= 0.0 && id.fract() == 0.0 && id <= MAX_OBJECT_ID { id as u32 } else { 0 },
        density: num(o, "8", d.density),
        restitution: num(o, "9", d.restitution),
        friction: num(o, "10", d.friction),
        linear_damping: num(o, "11", d.linear_damping),
        angular_damping: num(o, "12", d.angular_damping),
        kill_players: flag(o, "13", d.kill_players),
        motion: num(o, "14", d.motion),
        wrap: flag(o, "15", d.wrap),
        force_x: num(o, "17", d.force_x),
        force_y: num(o, "18", d.force_y),
        torque: num(o, "19", d.torque),
        dynamic_threshold: num(o, "21", d.dynamic_threshold),
        removal_threshold: num(o, "22", d.removal_threshold),
        no_physics: flag(o, "23", d.no_physics),
        z_index: num(o, "24", d.z_index),
        group,
        collide_a: flag(o, "26", d.collide_a),
        collide_b: flag(o, "27", d.collide_b),
        collide_c: flag(o, "28", d.collide_c),
        collide_d: flag(o, "29", d.collide_d),
        player_pass,
        projectile_pass,
        freeze_players: flag(o, "32", d.freeze_players),
        no_jump: flag(o, "43", d.no_jump),
        bullet: flag(o, "45", d.bullet),
        invisible: flag(o, "50", d.invisible),
        parallax: num(o, "55", d.parallax),
        fixed_rotation: flag(o, "57", d.fixed_rotation),
        source_player: num(o, "58", d.source_player),
        ability_immune: flag(o, "60", d.ability_immune),
        objective: num(o, "61", d.objective),
        objective_target: num(o, "62", d.objective_target),
        ea: flag(o, "63", d.ea),
        pinned: flag(o, "36", d.pinned),
        pin_x: num(o, "37", d.pin_x),
        pin_y: num(o, "38", d.pin_y),
        force_zone: flag(o, "39", d.force_zone),
        zone_x: num(o, "40", d.zone_x),
        zone_y: num(o, "41", d.zone_y),
        checkpoint: num(o, "31", d.checkpoint),
        race_object: flag(o, "34", d.race_object),
        race_progress: num(o, "44", d.race_progress),
        shapes,
        extra: extra_of(
            o,
            &[
                "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14", "15", "16", "17", "18", "19", "20",
                "21", "22", "23", "24", "25", "26", "27", "28", "29", "30", "31", "32", "34", "36", "37", "38", "39", "40",
                "41", "43", "44", "45", "50", "55", "56", "57", "58", "60", "61", "62", "63", "64", "65", "s", "pf",
            ],
        ),
        physics: PhysicsCache::default(),
    };
    let body = MapBody {
        x: num(o, "2", 0.0),
        y: num(o, "3", 0.0),
        angle: num(o, "4", 0.0),
        angular_velocity: num(o, "5", 0.0),
        vx: num(o, "6", 0.0),
        vy: num(o, "7", 0.0),
        ye: flag(o, "16", false),
        damage: num(o, "20", 0.0),
        lifetime: num(o, "56", -1.0),
        va: num(o, "64", 1.0),
        push_from,
        def: Arc::new(def),
    };
    Ok((id, body))
}

fn decode_joint(o: &Map<String, Value>) -> MapJoint {
    let d = MapJoint::default();
    MapJoint {
        ax: num(o, "1", d.ax),
        ay: num(o, "2", d.ay),
        bx: num(o, "3", d.bx),
        by: num(o, "4", d.by),
        kind: num(o, "5", d.kind),
        collide_connected: flag(o, "6", d.collide_connected),
        body_a: num(o, "7", d.body_a),
        body_b: num(o, "8", d.body_b),
        frequency: num(o, "9", d.frequency),
        damping: num(o, "10", d.damping),
        length: num(o, "11", d.length),
        motor_speed: num(o, "12", d.motor_speed),
        max_motor: num(o, "13", d.max_motor),
        player_a: num(o, "14", d.player_a),
        ha: flag(o, "15", d.ha),
        motor_mode: num(o, "16", d.motor_mode),
        latched: flag(o, "17", d.latched),
        axis_x: num(o, "18", d.axis_x),
        axis_y: num(o, "19", d.axis_y),
        extra: extra_of(o, &["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14", "15", "16", "17", "18", "19"]),
    }
}

fn decode_spawn(o: &Map<String, Value>) -> MapSpawn {
    let d = MapSpawn::default();
    let mut teams = d.teams;
    teams[1] = flag(o, "5", teams[1]);
    teams[2] = flag(o, "6", teams[2]);
    teams[3] = flag(o, "7", teams[3]);
    MapSpawn {
        x: num(o, "1", d.x),
        y: num(o, "2", d.y),
        priority: num(o, "3", d.priority),
        angle: num(o, "4", d.angle),
        teams,
        cap_sequence: num(o, "8", d.cap_sequence),
        extra: extra_of(o, &["1", "2", "3", "4", "5", "6", "7", "8"]),
    }
}

fn decode_turret(o: &Map<String, Value>) -> MapTurret {
    let d = MapTurret::default();
    let b = &d.bullet;
    let bullet = ProjectileDef {
        vx: num(o, "12", b.vx),
        size: num(o, "13", b.size),
        density: num(o, "14", b.density),
        friction: num(o, "15", b.friction),
        restitution: num(o, "16", b.restitution),
        life: num(o, "17", b.life),
        damage: num(o, "18", b.damage),
        turn_rate: num(o, "19", b.turn_rate),
        explode_radius: num(o, "20", b.explode_radius),
        bounces: flag(o, "21", b.bounces),
        shape: num(o, "22", b.shape),
        linear_damping: num(o, "23", b.linear_damping),
        ..b.clone()
    };
    MapTurret {
        x: num(o, "1", d.x),
        y: num(o, "2", d.y),
        vx: num(o, "3", d.vx),
        vy: num(o, "4", d.vy),
        angle: num(o, "5", d.angle),
        angular_velocity: num(o, "6", d.angular_velocity),
        health: num(o, "7", d.health),
        cooldown: num(o, "8", d.cooldown),
        team: num(o, "9", d.team),
        fire_interval: num(o, "10", d.fire_interval),
        range: num(o, "11", d.range),
        max_health: num(o, "24", d.max_health),
        bullet,
        extra: extra_of(
            o,
            &["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14", "15", "16", "17", "18", "19", "20", "21", "22", "23", "24"],
        ),
    }
}

fn decode_grapple(o: &Map<String, Value>) -> MapGrapple {
    let d = MapGrapple::default();
    MapGrapple {
        x: num(o, "1", d.x),
        y: num(o, "2", d.y),
        range: num(o, "3", d.range),
        body: num(o, "4", d.body),
        extra: extra_of(o, &["1", "2", "3", "4"]),
    }
}

fn decode_cap(o: &Map<String, Value>) -> MapCap {
    let d = MapCap::default();
    MapCap {
        x: num(o, "1", d.x),
        y: num(o, "2", d.y),
        width: num(o, "3", d.width),
        sequence: num(o, "4", d.sequence),
        owner: num(o, "5", d.owner),
        capturer: num(o, "6", d.capturer),
        capture_time: num(o, "7", d.capture_time),
        progress: num(o, "8", d.progress),
        extra: extra_of(o, &["1", "2", "3", "4", "5", "6", "7", "8"]),
    }
}

impl MapData {
    /// Decode a map from its compact JSON object.
    pub fn from_json(v: &Value) -> Result<MapData, MapError> {
        let root = obj(v)?;
        let mut map = MapData::default();
        for b in list(root, "b", true)? {
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
        for j in list(root, "j", true)? {
            map.joints.push(decode_joint(obj(j)?));
        }
        for s in list(root, "s", true)? {
            map.spawns.push(decode_spawn(obj(s)?));
        }
        map.pickups = list(root, "p", false)?.to_vec();
        for t in list(root, "tu", false)? {
            map.turrets.push(decode_turret(obj(t)?));
        }
        map.team_cores = list(root, "tc", false)?.to_vec();
        for g in list(root, "gp", false)? {
            map.grapples.push(decode_grapple(obj(g)?));
        }
        for c in list(root, "c", false)? {
            map.caps.push(decode_cap(obj(c)?));
        }
        map.settings = match root.get("set") {
            Some(Value::Object(o)) => decode_settings(o)?,
            _ => return Err(MapError::BadStructure("missing settings")),
        };
        map.extra = extra(root, &["b", "j", "s", "p", "tu", "tc", "gp", "c", "set"]);
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
        let mut root = Map::new();
        root.insert("b".into(), Value::Array(self.bodies.iter().map(|(id, b)| encode_body(*id, b)).collect()));
        root.insert("j".into(), Value::Array(self.joints.iter().map(encode_joint).collect()));
        root.insert("s".into(), Value::Array(self.spawns.iter().map(encode_spawn).collect()));
        root.insert("p".into(), Value::Array(self.pickups.clone()));
        root.insert("tu".into(), Value::Array(self.turrets.iter().map(encode_turret).collect()));
        root.insert("tc".into(), Value::Array(self.team_cores.clone()));
        root.insert("gp".into(), Value::Array(self.grapples.iter().map(encode_grapple).collect()));
        root.insert("c".into(), Value::Array(self.caps.iter().map(encode_cap).collect()));
        root.insert("set".into(), encode_settings(&self.settings));
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
    let d = MapSettings::default();
    let mut o = Out(Map::new());
    o.n("3", s.screen_width, d.screen_width);
    o.n("4", s.snap, d.snap);
    o.n("5", s.gn, d.gn);
    o.n("7", s.bg_offset_x, d.bg_offset_x);
    o.n("8", s.bg_offset_y, d.bg_offset_y);
    o.n("9", s.background_image, d.background_image);
    o.n("10", s.bg_scale, d.bg_scale);
    o.n("11", s.parallax, d.parallax);
    o.n("12", s.color_top, d.color_top);
    o.b("13", s.qn, d.qn);
    o.n("15", s.width, d.width);
    o.n("16", s.height, d.height);
    o.n("17", s.color_bottom, d.color_bottom);
    o.n("18", s.gravity, d.gravity);
    o.b("19", s.wrap, d.wrap);
    if s.wide {
        o.0.insert("aspect".into(), Value::from("wide"));
    }
    o.extra(&s.extra)
}

fn encode_shape(s: &MapShape) -> Value {
    let d = MapShape::default();
    let mut o = Out(Map::new());
    o.n("1", s.kind, d.kind);
    o.n("2", s.x, d.x);
    o.n("3", s.y, d.y);
    if let Some(v) = s.density {
        o.always("4", num_value(v));
    }
    if let Some(v) = s.friction {
        o.always("5", num_value(v));
    }
    if let Some(v) = s.restitution {
        o.always("6", num_value(v));
    }
    o.n("7", s.color, d.color);
    o.b("8", s.closed, d.closed);
    o.n("9", s.radius, d.radius);
    o.n("11", s.aa, d.aa);
    o.n("12", s.la, d.la);
    o.n("13", s.ua, d.ua);
    o.b("14", s.no_physics, d.no_physics);
    o.n("15", s.z_index, d.z_index);
    let mut p = Vec::with_capacity(s.points.len() * 2);
    for v in &s.points {
        p.push(num_value(v[0]));
        p.push(num_value(v[1]));
    }
    o.always("p", Value::Array(p));
    o.extra(&s.extra)
}

fn encode_body(id: u32, b: &MapBody) -> Value {
    let d = BodyDef::default();
    let f = &b.def;
    let mut o = Out(Map::new());
    o.n("1", id as f64, 0.0);
    o.n("2", b.x, 0.0);
    o.n("3", b.y, 0.0);
    o.n("4", b.angle, 0.0);
    o.n("5", b.angular_velocity, 0.0);
    o.n("6", b.vx, 0.0);
    o.n("7", b.vy, 0.0);
    o.n("8", f.density, d.density);
    o.n("9", f.restitution, d.restitution);
    o.n("10", f.friction, d.friction);
    o.n("11", f.linear_damping, d.linear_damping);
    o.n("12", f.angular_damping, d.angular_damping);
    o.b("13", f.kill_players, d.kill_players);
    o.n("14", f.motion, d.motion);
    o.b("15", f.wrap, d.wrap);
    o.b("16", b.ye, false);
    o.n("17", f.force_x, d.force_x);
    o.n("18", f.force_y, d.force_y);
    o.n("19", f.torque, d.torque);
    o.n("20", b.damage, 0.0);
    o.n("21", f.dynamic_threshold, d.dynamic_threshold);
    o.n("22", f.removal_threshold, d.removal_threshold);
    o.b("23", f.no_physics, d.no_physics);
    o.n("24", f.z_index, d.z_index);
    if f.group != d.group {
        o.always("25", f.group.to_value());
    }
    o.b("26", f.collide_a, d.collide_a);
    o.b("27", f.collide_b, d.collide_b);
    o.b("28", f.collide_c, d.collide_c);
    o.b("29", f.collide_d, d.collide_d);
    o.n("30", f.player_pass, d.player_pass);
    o.n("31", f.checkpoint, d.checkpoint);
    o.b("32", f.freeze_players, d.freeze_players);
    o.b("34", f.race_object, d.race_object);
    o.b("36", f.pinned, d.pinned);
    o.n("37", f.pin_x, d.pin_x);
    o.n("38", f.pin_y, d.pin_y);
    o.b("39", f.force_zone, d.force_zone);
    o.n("40", f.zone_x, d.zone_x);
    o.n("41", f.zone_y, d.zone_y);
    o.b("43", f.no_jump, d.no_jump);
    o.n("44", f.race_progress, d.race_progress);
    o.b("45", f.bullet, d.bullet);
    o.b("50", f.invisible, d.invisible);
    o.n("55", f.parallax, d.parallax);
    o.n("56", b.lifetime, -1.0);
    o.b("57", f.fixed_rotation, d.fixed_rotation);
    o.n("58", f.source_player, d.source_player);
    o.b("60", f.ability_immune, d.ability_immune);
    o.n("61", f.objective, d.objective);
    o.n("62", f.objective_target, d.objective_target);
    o.b("63", f.ea, d.ea);
    o.n("64", b.va, 1.0);
    o.n("65", f.projectile_pass, d.projectile_pass);
    o.always("s", Value::Array(f.shapes.iter().map(encode_shape).collect()));
    if !b.push_from.is_empty() {
        let mut pf = Vec::new();
        for (k, w) in &b.push_from {
            pf.push(Value::from(*k));
            pf.push(num_value(*w));
        }
        o.always("pf", Value::Array(pf));
    }
    o.extra(&f.extra)
}

fn encode_joint(j: &MapJoint) -> Value {
    let d = MapJoint::default();
    let mut o = Out(Map::new());
    o.n("1", j.ax, d.ax);
    o.n("2", j.ay, d.ay);
    o.n("3", j.bx, d.bx);
    o.n("4", j.by, d.by);
    o.always("5", num_value(j.kind));
    o.always("6", Value::Bool(j.collide_connected));
    o.always("7", num_value(j.body_a));
    o.always("8", num_value(j.body_b));
    o.always("9", num_value(j.frequency));
    o.always("10", num_value(j.damping));
    o.always("11", num_value(j.length));
    o.always("12", num_value(j.motor_speed));
    o.always("13", num_value(j.max_motor));
    o.n("14", j.player_a, d.player_a);
    o.b("15", j.ha, d.ha);
    o.n("16", j.motor_mode, d.motor_mode);
    o.b("17", j.latched, d.latched);
    o.n("18", j.axis_x, d.axis_x);
    o.n("19", j.axis_y, d.axis_y);
    o.extra(&j.extra)
}

fn encode_spawn(s: &MapSpawn) -> Value {
    let d = MapSpawn::default();
    let mut o = Out(Map::new());
    o.n("1", s.x, d.x);
    o.n("2", s.y, d.y);
    o.n("3", s.priority, d.priority);
    o.n("4", s.angle, d.angle);
    o.b("5", s.teams[1], d.teams[1]);
    o.b("6", s.teams[2], d.teams[2]);
    o.b("7", s.teams[3], d.teams[3]);
    o.n("8", s.cap_sequence, d.cap_sequence);
    o.extra(&s.extra)
}

fn encode_turret(t: &MapTurret) -> Value {
    let d = MapTurret::default();
    let b = &d.bullet;
    let mut o = Out(Map::new());
    o.n("1", t.x, d.x);
    o.n("2", t.y, d.y);
    o.n("3", t.vx, d.vx);
    o.n("4", t.vy, d.vy);
    o.n("5", t.angle, d.angle);
    o.n("6", t.angular_velocity, d.angular_velocity);
    o.n("7", t.health, d.health);
    o.n("8", t.cooldown, d.cooldown);
    o.n("9", t.team, d.team);
    o.n("10", t.fire_interval, d.fire_interval);
    o.n("11", t.range, d.range);
    o.n("12", t.bullet.vx, b.vx);
    o.n("13", t.bullet.size, b.size);
    o.n("14", t.bullet.density, b.density);
    o.n("15", t.bullet.friction, b.friction);
    o.n("16", t.bullet.restitution, b.restitution);
    o.n("17", t.bullet.life, b.life);
    o.n("18", t.bullet.damage, b.damage);
    o.n("19", t.bullet.turn_rate, b.turn_rate);
    o.n("20", t.bullet.explode_radius, b.explode_radius);
    o.b("21", t.bullet.bounces, b.bounces);
    o.n("22", t.bullet.shape, b.shape);
    o.n("23", t.bullet.linear_damping, b.linear_damping);
    o.n("24", t.max_health, d.max_health);
    o.extra(&t.extra)
}

fn encode_grapple(g: &MapGrapple) -> Value {
    let d = MapGrapple::default();
    let mut o = Out(Map::new());
    o.n("1", g.x, d.x);
    o.n("2", g.y, d.y);
    o.n("3", g.range, d.range);
    o.n("4", g.body, d.body);
    o.extra(&g.extra)
}

fn encode_cap(c: &MapCap) -> Value {
    let d = MapCap::default();
    let mut o = Out(Map::new());
    o.n("1", c.x, d.x);
    o.n("2", c.y, d.y);
    o.n("3", c.width, d.width);
    o.n("4", c.sequence, d.sequence);
    o.n("5", c.owner, d.owner);
    o.n("6", c.capturer, d.capturer);
    o.n("7", c.capture_time, d.capture_time);
    o.n("8", c.progress, d.progress);
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
