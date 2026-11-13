//! The tick function: `State(t) -> State(t+1)`.
//!
//! Mirrors the original's per-tick order exactly:
//! 1. reset the physics world and set gravity;
//! 2. during the intro countdown, only tick round state (no physics);
//! 3. otherwise wrap every row in a runtime object (bucket order, id order),
//!    create physics bodies (`oo`), run player input (`mu`), apply
//!    join/leave events (`qo`), run pre-step logic (`ao`), step Box2D,
//!    clear forces, run post-step logic (`ro`) and serialize every object
//!    into a fresh state (`lo`).

use crate::input::Input;
use crate::map::MapSettings;
use crate::objects::{BodyObj, CapObj, JointObj, ProjObj, PuObj, TurretObj};
use crate::player::PlayerObj;
use crate::round::RoundObj;
use crate::settings::GameSettings;
use crate::state::*;
use neobox_box2d::math::Vec2;
use neobox_box2d::{BodyId, ContactId, ContactImpulse, ContactListener, FixtureId, Manifold, Store, World};

/// Sound effect kinds (`Cr` bucket `type`).
pub mod sound {
    pub const JUMP: f64 = 1.0;
    pub const AIR_JUMP: f64 = 2.0;
    pub const PUSH_HIT: f64 = 3.0;
    pub const PUSH_MISS: f64 = 4.0;
    pub const PUSH_EMPTY: f64 = 5.0;
    pub const IMPACT: f64 = 6.0;
    pub const IMPACT_NOJUMP: f64 = 7.0;
    pub const FREEZE: f64 = 8.0;
    pub const SPAWN: f64 = 9.0;
    pub const COUNTDOWN: f64 = 10.0;
    pub const DEATH: f64 = 11.0;
    pub const BODY_IMPACT: f64 = 12.0;
    pub const BAT_SWING: f64 = 13.0;
    pub const BAT_HIT: f64 = 14.0;
    pub const ROCKET_CHARGE: f64 = 15.0;
    pub const ROCKET_FIRE: f64 = 16.0;
    pub const EXPLOSION: f64 = 17.0;
    pub const PARACHUTE: f64 = 18.0;
    pub const GHOST_TRAIL: f64 = 19.0;
}

/// Visual effect kinds (`zl` bucket `type`).
pub mod effect {
    pub const EXPLOSION: f64 = 0.0;
    pub const PUSH_LINE: f64 = 33.0;
    pub const PUSH_EMPTY: f64 = 5.0;
    pub const PUSH_WAVE: f64 = 43.0;
    pub const AIR_JUMP: f64 = 18.0;
}

/// Object kinds (the original's `ho` values).
pub mod kind {
    pub const NONE: u32 = u32::MAX;
    pub const BODY: u32 = 0;
    pub const PLAYER: u32 = 1;
    pub const PROJECTILE: u32 = 2;
    pub const GRAPPLE: u32 = 3;
    pub const TURRET: u32 = 4;
    pub const PARACHUTE: u32 = 14;
    pub const PU: u32 = 15;
    pub const CAP: u32 = 16;
}

#[inline]
pub(crate) fn tag(kind: u32, index: usize) -> u64 {
    ((kind as u64) << 32) | (index as u64 + 1)
}

/// (kind, index) of a physics body's owner. `kind::NONE` for the ground body.
#[inline]
pub(crate) fn untag(t: u64) -> (u32, usize) {
    if t == 0 { (kind::NONE, 0) } else { ((t >> 32) as u32, (t & 0xffff_ffff) as usize - 1) }
}

#[inline]
pub(crate) fn body_tag(store: &Store, b: BodyId) -> (u32, usize) {
    untag(store.body(b).get_user_data())
}

#[inline]
pub(crate) fn fixture_owner(store: &Store, f: FixtureId) -> (BodyId, u32, usize) {
    let b = store.fixture(f).get_body();
    let (k, i) = body_tag(store, b);
    (b, k, i)
}

#[inline]
pub(crate) fn v2(x: f64, y: f64) -> Vec2 {
    Vec2 { x, y }
}

/// Join/leave events applied at a tick.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Events {
    /// Players that left (`Vo`).
    pub removed: Vec<u32>,
    /// Players that joined, with their team (`Xo`).
    pub joined: Vec<(u32, f64)>,
}

/// Runtime objects for one tick (the original's per-step wrappers).
pub(crate) struct Ctx<'g> {
    pub gs: &'g GameSettings,
    /// Map settings of the previous state (read by bodies).
    pub prev_settings: MapSettings,
    /// Map settings wrapper (`I$`), serialized into the new state.
    pub settings: MapSettings,
    pub sounds: Vec<Sound>,
    pub spawns: Vec<(u32, crate::map::MapSpawn)>,
    pub counters: Counters,
    pub round: RoundObj,
    pub bodies: Vec<BodyObj>,
    pub joints: Vec<JointObj>,
    pub effects: Vec<(u32, Effect)>,
    pub players: Vec<PlayerObj>,
    pub projectiles: Vec<ProjObj>,
    pub turrets: Vec<TurretObj>,
    pub grapples: Vec<(u32, crate::map::MapGrapple)>,
    pub pu: Vec<PuObj>,
    pub caps: Vec<CapObj>,
    pub prev_caps: Vec<crate::map::MapCap>,
    /// (x, y, team) of the previous state's players (round logic reads them).
    pub prev_players: Vec<(f64, f64, f64)>,
}

impl Ctx<'_> {
    pub fn player_index(&self, id: f64) -> Option<usize> {
        let id = index_of(id)?;
        self.players.binary_search_by_key(&id, |p| p.index).ok()
    }
    pub fn body_index(&self, id: f64) -> Option<usize> {
        let id = index_of(id)?;
        self.bodies.binary_search_by_key(&id, |b| b.index).ok()
    }
}

/// The simulation (owns a reusable physics world).
pub struct Sim {
    world: World,
}

impl Default for Sim {
    fn default() -> Self {
        Self::new()
    }
}

impl Sim {
    pub fn new() -> Sim {
        // the original constructs its world once, gravity (0,0), sleep off,
        // and then disables warm starting
        let mut world = World::new(v2(0.0, 0.0), false);
        world.set_warm_starting(false);
        Sim { world }
    }

    /// The last step hit the physics engine's pair/contact limit (maps far
    /// beyond what the original can run; see `neobox_box2d` `MAX_PAIRS`).
    /// Deterministic: every peer sees the same value.
    pub fn overloaded(&self) -> bool {
        self.world.overloaded()
    }

    /// Advance one tick. `inputs[id]` is player `id`'s input mask (missing
    /// entries = no input).
    pub fn step(&mut self, prev: &State, inputs: &[u8], events: Option<&Events>, gs: &GameSettings) -> State {
        let world = &mut self.world;
        world.reset();
        let gravity = prev.settings.gravity + gs.gravity_offset;
        if world.get_gravity().y != gravity {
            let g = world.get_gravity();
            world.set_gravity(v2(g.x, gravity));
        }

        if prev.round.intro > -1.0 {
            return intro_step(prev, events, gs);
        }

        let mut ctx = build(prev, gs);

        // oo: create physics bodies in bucket/id order
        for i in 0..ctx.bodies.len() {
            crate::objects::body_create(&mut ctx, world, i);
        }
        for i in 0..ctx.players.len() {
            crate::player::create(&mut ctx, world, i);
        }
        for i in 0..ctx.projectiles.len() {
            crate::objects::projectile_create(&mut ctx, world, i);
        }
        for i in 0..ctx.turrets.len() {
            crate::objects::turret_create(&mut ctx, world, i);
        }
        for i in 0..ctx.pu.len() {
            crate::objects::pu_create(&mut ctx, world, i);
        }
        for i in 0..ctx.caps.len() {
            crate::objects::cap_create(&mut ctx, world, i);
        }

        // mu: player input
        for i in 0..ctx.players.len() {
            let id = ctx.players[i].index as usize;
            let mask = inputs.get(id).copied().unwrap_or(0);
            crate::player::update(&mut ctx, world, i, Input::from_mask(mask));
        }

        // qo: join/leave events
        crate::round::events(&mut ctx, events);
        if let Some(ev) = events {
            for p in ctx.players.iter_mut() {
                if ev.removed.contains(&p.index) {
                    p.gone = true;
                }
            }
        }

        // ao: pre-step logic
        crate::round::pre_step(&mut ctx);
        for b in ctx.bodies.iter_mut() {
            crate::objects::body_pre_step(b);
        }
        for i in 0..ctx.joints.len() {
            crate::objects::joint_create(&mut ctx, world, i);
        }
        for p in ctx.players.iter_mut() {
            crate::player::pre_step(p);
        }
        for i in 0..ctx.projectiles.len() {
            crate::objects::projectile_pre_step(&mut ctx, world, i);
        }
        for i in 0..ctx.turrets.len() {
            crate::objects::turret_pre_step(&mut ctx, world, i);
        }

        // physics
        let mut dt = 1.0 / gs.time_scale;
        if prev.round.game_over > -1.0 {
            dt *= 0.4;
        }
        {
            let mut listener = Listener { ctx: &mut ctx };
            world.step(dt, 6, 12, &mut listener);
        }
        world.clear_forces();

        // ro: post-step logic
        crate::round::post_step(&mut ctx);
        for i in 0..ctx.bodies.len() {
            crate::objects::body_post_step(&mut ctx, i);
        }
        for i in 0..ctx.joints.len() {
            crate::objects::joint_post_step(&mut ctx, world, i);
        }
        for i in 0..ctx.players.len() {
            crate::player::post_step(&mut ctx, world, i);
        }
        for i in 0..ctx.projectiles.len() {
            crate::objects::projectile_post_step(&mut ctx, world, i);
        }
        for t in ctx.turrets.iter_mut() {
            crate::objects::turret_post_step(t);
        }
        for i in 0..ctx.caps.len() {
            crate::objects::cap_post_step(&mut ctx, i);
        }

        // lo: serialize
        serialize(ctx, world)
    }
}

/// Intro countdown tick: no physics, round bookkeeping only.
fn intro_step(prev: &State, events: Option<&Events>, gs: &GameSettings) -> State {
    let mut next = prev.clone();
    if next.round.intro % 30.0 == 0.0 && next.round.intro != 0.0 {
        next.sounds.push(Sound { ttl: 15.0, kind: sound::COUNTDOWN, ..Sound::default() });
    }
    let mut i = 0;
    while i < next.sounds.len() {
        next.sounds[i].ttl -= 1.0;
        if next.sounds[i].ttl == 0.0 {
            next.sounds.remove(i);
        } else {
            i += 1;
        }
    }
    crate::round::intro_tick(&mut next, events, gs);
    if let Some(ev) = events {
        for id in &ev.removed {
            next.players.remove(*id);
        }
    }
    next.round.intro -= 1.0;
    next
}

fn build<'g>(prev: &State, gs: &'g GameSettings) -> Ctx<'g> {
    Ctx {
        gs,
        prev_settings: prev.settings.clone(),
        settings: prev.settings.clone(),
        sounds: prev.sounds.clone(),
        spawns: prev.spawns.iter().map(|(k, v)| (k, v.clone())).collect(),
        counters: prev.counters.clone(),
        round: RoundObj::new(prev.round.clone(), gs).with_bodies(&prev.bodies),
        bodies: prev.bodies.iter().map(|(k, b)| BodyObj::new(k, b.clone())).collect(),
        joints: prev.joints.iter().map(|(k, j)| JointObj::new(k, j.clone())).collect(),
        effects: prev.effects.iter().map(|(k, e)| (k, e.clone())).collect(),
        players: prev.players.iter().map(|(k, p)| PlayerObj::new(k, p.clone(), gs)).collect(),
        projectiles: prev.projectiles.iter().map(|(k, p)| ProjObj::new(k, p.clone())).collect(),
        turrets: prev.turrets.iter().map(|(k, t)| TurretObj::new(k, t.clone())).collect(),
        grapples: prev.grapples.iter().map(|(k, g)| (k, g.clone())).collect(),
        pu: prev.pu.iter().map(|(k, p)| PuObj::new(k, p.clone())).collect(),
        caps: prev.caps.iter().map(|c| CapObj::new(c.clone())).collect(),
        prev_caps: prev.caps.clone(),
        prev_players: prev.players.values().map(|p| (p.x, p.y, p.team)).collect(),
    }
}

/// `lo` for every object, in bucket order, into a fresh state.
fn serialize(mut ctx: Ctx<'_>, world: &mut World) -> State {
    let mut next = State { settings: std::mem::take(&mut ctx.settings), ..State::default() };
    // sounds: decrement, keep living ones
    for mut s in std::mem::take(&mut ctx.sounds) {
        s.ttl -= 1.0;
        if s.ttl > 0.0 {
            next.sounds.push(s);
        }
    }
    for (k, s) in std::mem::take(&mut ctx.spawns) {
        next.spawns.insert(k, s);
    }
    next.counters = std::mem::take(&mut ctx.counters);
    crate::round::serialize(&mut ctx, &mut next);
    for i in 0..ctx.bodies.len() {
        crate::objects::body_serialize(&mut ctx, world, i, &mut next);
    }
    for j in ctx.joints.iter() {
        next.joints.insert(j.index, j.eo.clone());
    }
    for (k, mut e) in std::mem::take(&mut ctx.effects) {
        e.ttl -= 1.0;
        if e.ttl > 0.0 {
            next.effects.insert(k, e);
        }
    }
    for i in 0..ctx.players.len() {
        crate::player::serialize(&mut ctx, world, i, &mut next);
    }
    for i in 0..ctx.projectiles.len() {
        crate::objects::projectile_serialize(&mut ctx, world, i, &mut next);
    }
    for i in 0..ctx.turrets.len() {
        crate::objects::turret_serialize(&mut ctx, world, i, &mut next);
    }
    for (k, g) in std::mem::take(&mut ctx.grapples) {
        next.grapples.insert(k, g);
    }
    for i in 0..ctx.pu.len() {
        crate::objects::pu_serialize(&mut ctx, world, i, &mut next);
    }
    for c in ctx.caps.drain(..) {
        next.caps.push(c.eo);
    }
    next
}

/// Box2D contact callbacks dispatched to the game objects.
struct Listener<'c, 'g> {
    ctx: &'c mut Ctx<'g>,
}

impl ContactListener for Listener<'_, '_> {
    fn begin_contact(&mut self, store: &mut Store, c: ContactId) {
        let fa = store.contact(c).get_fixture_a();
        let fb = store.contact(c).get_fixture_b();
        let ba = store.fixture(fa).get_body();
        let bb = store.fixture(fb).get_body();
        let point = neobox_box2d::dynamics::contact::world_manifold(store, c).points[0];
        begin(self.ctx, store, ba, bb, fb, point, c);
        begin(self.ctx, store, bb, ba, fa, point, c);
    }

    fn pre_solve(&mut self, _store: &mut Store, _c: ContactId, _old: &Manifold) {
        // the original's PreSolve handlers are all empty
    }

    fn post_solve(&mut self, store: &mut Store, c: ContactId, impulse: &ContactImpulse) {
        let fa = store.contact(c).get_fixture_a();
        let fb = store.contact(c).get_fixture_b();
        let ba = store.fixture(fa).get_body();
        let bb = store.fixture(fb).get_body();
        post_solve(self.ctx, store, ba, bb, fb, impulse);
        post_solve(self.ctx, store, bb, ba, fa, impulse);
    }
}

fn begin(ctx: &mut Ctx<'_>, store: &mut Store, me: BodyId, other: BodyId, other_fixture: FixtureId, point: Vec2, c: ContactId) {
    match body_tag(store, me) {
        (kind::PLAYER, i) => crate::player::begin_contact(ctx, store, i, other, c),
        (kind::BODY, i) => crate::objects::body_begin_contact(ctx, store, i, other, c),
        (kind::PROJECTILE, i) => crate::objects::projectile_begin_contact(ctx, store, i, other, point, c),
        (kind::CAP, i) => crate::objects::cap_begin_contact(ctx, store, i, other),
        _ => {}
    }
    let _ = other_fixture;
}

fn post_solve(ctx: &mut Ctx<'_>, store: &mut Store, me: BodyId, other: BodyId, _other_fixture: FixtureId, impulse: &ContactImpulse) {
    match body_tag(store, me) {
        (kind::PLAYER, i) => crate::player::post_solve(ctx, store, i, other, impulse),
        (kind::BODY, i) => crate::objects::body_post_solve(ctx, store, i, impulse),
        _ => {}
    }
}

/// Distance-sorted candidate (`J$.ss`): owner reference, distance, offset.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Near {
    pub kind: u32,
    pub index: usize,
    pub dist: f64,
    pub dx: f64,
    pub dy: f64,
}

/// `J$.ss`: sort candidates by distance from `origin` (player candidates
/// measure to their surface: distance minus half the player size).
pub(crate) fn sort_near(store: &Store, ctx: &Ctx<'_>, origin: Vec2, cands: &[(u32, usize)], exclude: (u32, usize)) -> Vec<Near> {
    let mut out = Vec::with_capacity(cands.len());
    for &(k, i) in cands {
        if (k, i) == exclude {
            continue;
        }
        let (pos, hs) = match k {
            kind::PLAYER => {
                let p = &ctx.players[i];
                match p.body {
                    Some(b) => (store.body(b).get_position(), p.hs),
                    None => continue,
                }
            }
            kind::BODY => match ctx.bodies[i].body {
                Some(b) => (store.body(b).get_position(), 0.0),
                None => continue,
            },
            kind::PROJECTILE => match ctx.projectiles[i].body {
                Some(b) => (store.body(b).get_position(), 0.0),
                None => continue,
            },
            kind::TURRET => match ctx.turrets[i].body {
                Some(b) => (store.body(b).get_position(), 0.0),
                None => continue,
            },
            _ => continue,
        };
        let mut d = pos;
        d.subtract(origin);
        let mut dist = d.length();
        if hs != 0.0 {
            dist -= hs;
        }
        out.push(Near { kind: k, index: i, dist, dx: d.x, dy: d.y });
    }
    out.sort_by(|a, b| a.dist.partial_cmp(&b.dist).unwrap_or(std::cmp::Ordering::Equal));
    out
}
