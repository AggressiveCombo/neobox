//! Player behaviour: body creation, input (movement, jumping, abilities),
//! contact reactions, death and serialization.

use crate::input::Input;
use crate::js;
use crate::map::{BodyDef, MapShape, BODY_DYNAMIC};
use crate::settings::GameSettings;
use crate::state::*;
use crate::step::{effect, fixture_owner, kind, sort_near, sound, tag, v2, Ctx};
use neobox_box2d::math::Vec2;
use neobox_box2d::{
    BodyDef as B2BodyDef, BodyId, BodyType, ContactId, ContactImpulse, DistanceJointDef, FixtureDef, JointDef, PolygonShape,
    Shape, Store, World,
};
use std::sync::Arc;

/// Friction of the player box.
pub const FRICTION: f64 = 0.15;
/// Restitution of the player box (negative, as in the original).
pub const RESTITUTION: f64 = -0.5;
/// Attacker credit duration in ticks.
pub const CREDIT_TICKS: f64 = 150.0;
/// Players younger than this (ticks) cannot interact (spawn protection).
pub const SPAWN_GRACE: f64 = 27.0;
/// Collision category of players.
pub const CATEGORY: u16 = 2;

/// Impact-sound limiter.
#[derive(Clone, Copy, Debug)]
pub struct Limiter {
    value: f64,
    add: f64,
    dec: f64,
}

impl Limiter {
    pub fn new(init: f64, max: f64, add: f64, dec: f64) -> Limiter {
        let mut value = init + add;
        if value > max {
            value = max;
        }
        Limiter { value, add, dec }
    }
    pub fn request(&mut self) -> f64 {
        let r = js::max(0.0, self.value);
        self.value -= self.dec;
        if self.value < -self.add {
            self.value = -self.add;
        }
        r
    }
    pub fn value(&self) -> f64 {
        self.value
    }
}

/// Runtime wrapper of a player for one tick.
pub(crate) struct PlayerObj {
    pub index: u32,
    pub row: Player,
    /// half size used for distance sorting
    pub sort_half_width: f64,
    pub half_width: f64,
    pub half_height: f64,
    pub body: Option<BodyId>,
    /// parachute canopy body
    pub chute: Option<BodyId>,
    /// died this tick
    pub died: bool,
    /// died by damage or fall (debris flies up)
    pub debris_up: bool,
    /// leaves the state this tick
    pub leaving: bool,
    /// jumped this tick
    pub jumped: bool,
    /// touched a freeze body
    pub froze: bool,
    /// holds the special key (blocks movement input)
    pub special_held: bool,
    pub new_effects: Vec<Effect>,
    pub new_sounds: Vec<Sound>,
    pub new_projectiles: Vec<Projectile>,
    /// bodies held by grab joints this tick
    pub grabbed: Vec<BodyId>,
    pub limiter: Limiter,
    /// touched the next race checkpoint this tick
    pub passed: bool,
    /// goes back to the last race checkpoint at the end of the tick
    pub to_checkpoint: Option<(f64, f64)>,
}

impl PlayerObj {
    pub fn new(index: u32, mut row: Player, gs: &GameSettings) -> PlayerObj {
        row.teleported = false;
        let limiter = Limiter::new(row.sound_limiter, 1.0, 0.2, 0.8);
        PlayerObj {
            index,
            row,
            sort_half_width: gs.player_width / 2.0,
            half_width: gs.player_width / 2.0,
            half_height: gs.player_height / 2.0,
            body: None,
            chute: None,
            died: false,
            debris_up: false,
            leaving: false,
            jumped: false,
            froze: false,
            special_held: false,
            new_effects: Vec::new(),
            new_sounds: Vec::new(),
            new_projectiles: Vec::new(),
            grabbed: Vec::new(),
            limiter,
            passed: false,
            to_checkpoint: None,
        }
    }

    #[inline]
    pub fn id(&self) -> f64 {
        self.index as f64
    }

    /// Same team (teams > 1 only).
    pub fn same_team(&self, team: f64) -> bool {
        self.row.team == team && self.row.team > 1.0
    }

    /// Dash in its active window.
    pub fn dashing(&self, gs: &GameSettings) -> bool {
        self.row.dash_frame >= 3.0 && self.row.dash_frame < gs.dash_init_delay + gs.dash_active
    }

    /// Take damage.
    pub fn damage(&mut self, amount: f64) {
        self.row.health -= amount;
        self.row.health = js::min(100.0, self.row.health);
        self.row.health = js::max(0.0, self.row.health);
    }

    fn sound_at(&mut self, store: &Store, kind: f64, ttl: f64, volume: f64) {
        let b = self.body.expect("player body");
        let p = store.body(b).get_position();
        self.new_sounds.push(Sound { x: p.x, y: p.y, kind, ttl, volume, player: self.id(), effect_row: false });
    }
}

fn player_body(ctx: &Ctx<'_>, i: usize) -> BodyId {
    ctx.players[i].body.expect("player body")
}

/// Create the player's physics body.
pub(crate) fn create(ctx: &mut Ctx<'_>, world: &mut World, i: usize) {
    let gs = ctx.gs;
    let p = &ctx.players[i];
    let mut def = B2BodyDef::default();
    def.body_type = BodyType::Dynamic;
    def.position = v2(p.row.x, p.row.y);
    def.angle = p.row.angle;
    def.angular_velocity = p.row.angular_velocity;
    def.fixed_rotation = false;
    def.linear_damping = 0.3;
    if p.row.ghost {
        def.linear_damping = gs.ghost_damping;
    }
    def.angular_damping = 0.5;
    def.bullet = true;
    def.user_data = tag(kind::PLAYER, i);
    let body = world.create_body(&def);
    let mut shape = PolygonShape::new();
    shape.set_as_box(p.half_width, p.half_height);
    let mut fd = FixtureDef::new(Shape::Polygon(shape));
    fd.density = 2.0 / (2.0 * p.half_width * p.half_height * 2.0);
    fd.friction = FRICTION;
    fd.restitution = RESTITUTION;
    fd.filter.category_bits = CATEGORY;
    world.create_fixture(body, &fd);
    world.store_mut().body_mut(body).set_linear_velocity(v2(p.row.vx, p.row.vy));
    ctx.players[i].body = Some(body);
}

/// Apply one tick of input.
pub(crate) fn update(ctx: &mut Ctx<'_>, world: &mut World, i: usize, mut input: Input) {
    let gs = ctx.gs;
    crate::race::reset_key(ctx, i, input.bat);
    if ctx.players[i].row.frozen > 0.0 {
        input = Input::default();
    }
    if !ctx.players[i].row.ghost {
        force_push(ctx, world, i, &input);
        if gs.bat_enabled {
            bat(ctx, world, i, &input);
        }
        if gs.dash_enabled {
            dash(ctx, world, i, &input);
        } else if gs.parachute_enabled {
            parachute(ctx, world, i, &input);
        } else {
            grab(ctx, world, i, &input);
        }
        if gs.egg_enabled {
            egg(ctx, world, i, &input);
        } else {
            rocket(ctx, world, i, &input);
        }
        movement(ctx, world, i, &input);
        jump(ctx, world, i, &input);
    } else {
        ghost_float(ctx, world, i);
        ghost_move(ctx, world, i, &input);
    }
    let p = &mut ctx.players[i];
    if input.up {
        p.row.up_held += 1.0;
    } else {
        p.row.up_held = 0.0;
    }
}

/// Per-tick countdowns of freeze and attacker credit.
pub(crate) fn pre_step(p: &mut PlayerObj) {
    if p.row.frozen > 0.0 {
        p.row.frozen -= 1.0;
    }
    if p.row.attacker_timer > 0.0 {
        p.row.attacker_timer -= 1.0;
    }
}

/// Horizontal movement forces and air control.
fn movement(ctx: &mut Ctx<'_>, world: &mut World, i: usize, input: &Input) {
    let p = &ctx.players[i];
    let mut input = *input;
    if p.row.stunned || p.special_held {
        input = Input::default();
    }
    let body = player_body(ctx, i);
    let mut brake = 120.0;
    let mut idle = 10.0;
    let speed = (p.row.vx * p.row.vx + p.row.vy * p.row.vy).sqrt();
    let mut force = 80.0 - 60.0 * js::min(speed / 15.0, 1.0);
    let moving_right = p.row.vx > 0.4;
    let moving_left = p.row.vx < -0.4;
    // grounded: ray from the centre straight down
    let grounded = {
        let mut hit = false;
        let from = v2(p.row.x, p.row.y);
        let to = v2(p.row.x, p.row.y + js::max(p.half_height, p.half_width) + 0.2);
        let team = p.row.team;
        world.ray_cast(
            |store, f, _pt, _n, _frac| {
                if store.fixture(f).is_sensor() {
                    return 1.0;
                }
                let (_, k, bi) = fixture_owner(store, f);
                if k == kind::BODY {
                    let pass = ctx.bodies[bi].row.def.player_pass;
                    if pass == 1.0 || pass == team {
                        return 1.0;
                    }
                }
                hit = true;
                0.0
            },
            from,
            to,
        );
        hit
    };
    if !grounded {
        brake *= 0.3;
        force *= 0.3;
        idle = 0.0;
    }
    let fx = if moving_left {
        if input.left {
            Some(-force)
        } else if input.right {
            Some(brake)
        } else {
            Some(idle)
        }
    } else if moving_right {
        if input.left {
            Some(-brake)
        } else if input.right {
            Some(force)
        } else {
            Some(-idle)
        }
    } else if input.left {
        Some(-force)
    } else if input.right {
        Some(force)
    } else {
        None
    };
    let store = world.store_mut();
    let b = store.body_mut(body);
    if let Some(fx) = fx {
        let c = b.get_world_center();
        b.apply_force(v2(fx, 0.0), c);
    }
    if !grounded && input.up && b.get_linear_velocity().y < 0.0 {
        let c = b.get_world_center();
        b.apply_force(v2(0.0, -18.0), c);
    }
    if !grounded && input.down {
        let c = b.get_world_center();
        b.apply_force(v2(0.0, 20.0), c);
    }
}

/// Count ray hits around the player: [down, up, right, left].
fn contact_rays(ctx: &Ctx<'_>, world: &World, i: usize, axis_aligned: bool) -> [u32; 4] {
    let p = &ctx.players[i];
    let gs = ctx.gs;
    let body = p.body.expect("player body");
    let store = world.store();
    let b = store.body(body);
    let probe = 0.15;
    let pos = b.get_position();
    let (l, r, d, u) = if !axis_aligned {
        (
            b.get_world_point(v2(-(p.half_width + probe), 0.0)),
            b.get_world_point(v2(p.half_width + probe, 0.0)),
            b.get_world_point(v2(0.0, p.half_height + probe)),
            b.get_world_point(v2(0.0, -(p.half_height + probe))),
        )
    } else {
        (
            v2(pos.x - (p.half_width + probe), pos.y),
            v2(pos.x + (p.half_width + probe), pos.y),
            v2(pos.x, pos.y + (p.half_height + probe)),
            v2(pos.x, pos.y - (p.half_height + probe)),
        )
    };
    let origin = v2(p.row.x, p.row.y);
    let mut counts = [0u32; 4];
    let mut cb = |store: &Store, f, point: Vec2, _n: Vec2, frac: f64| -> f64 {
        if store.fixture(f).is_sensor() {
            return 1.0;
        }
        let (_, k, bi) = fixture_owner(store, f);
        if k == kind::PROJECTILE {
            return 1.0;
        }
        if k == kind::PLAYER && !gs.fighters_collide {
            return 1.0;
        }
        if k == kind::BODY && ctx.bodies[bi].row.def.no_jump {
            return frac;
        }
        let mut d = point;
        d.subtract(store.body(body).get_position());
        let mut a = js::qatan2(d.y, d.x) * (180.0 / std::f64::consts::PI);
        if a < 0.0 {
            a += 360.0;
        }
        if a > 330.0 || a < 45.0 {
            counts[2] += 1;
        } else if a > 45.0 && a < 135.0 {
            counts[0] += 1;
        } else if a > 135.0 && a < 240.0 {
            counts[3] += 1;
        } else {
            counts[1] += 1;
        }
        0.0
    };
    world.ray_cast(&mut cb, origin, l);
    world.ray_cast(&mut cb, origin, r);
    world.ray_cast(&mut cb, origin, d);
    world.ray_cast(&mut cb, origin, u);
    counts
}

/// Jumping (ground, coyote, walls, ceiling, air jump).
fn jump(ctx: &mut Ctx<'_>, world: &mut World, i: usize, input: &Input) {
    let mut input = *input;
    if ctx.players[i].row.stunned {
        input = Input::default();
    }
    let [down, up, right, left] = contact_rays(ctx, world, i, false);
    let body = player_body(ctx, i);
    let p = &mut ctx.players[i];
    if down > 0 || right > 0 || left > 0 {
        p.row.air_jump = true;
    }
    if p.row.coyote > 0.0 {
        p.row.coyote -= 1.0;
    }
    if down > 0 {
        p.row.coyote = 4.0;
    }
    let store = world.store_mut();
    if input.up && p.row.up_held == 0.0 && p.row.rope.state != ATTACH_ON {
        let b = store.body_mut(body);
        if (down > 0 || p.row.coyote > 0.0) && up == 0 {
            let c = b.get_world_center();
            b.apply_impulse(v2(0.0, -20.0), c);
            p.jumped = true;
            p.sound_at(store, sound::JUMP, 15.0, 1.0);
            p.row.coyote = 0.0;
        } else if right > 0 {
            let v = b.get_linear_velocity();
            if v.y > 0.0 {
                b.set_linear_velocity(v2(v.x, 0.0));
            }
            let c = b.get_world_center();
            b.apply_impulse(v2(-10.0, -20.0), c);
            p.jumped = true;
            p.sound_at(store, sound::JUMP, 15.0, 1.0);
        } else if left > 0 {
            let v = b.get_linear_velocity();
            if v.y > 0.0 {
                b.set_linear_velocity(v2(v.x, 0.0));
            }
            let c = b.get_world_center();
            b.apply_impulse(v2(10.0, -20.0), c);
            p.jumped = true;
            p.sound_at(store, sound::JUMP, 15.0, 1.0);
        } else if up > 0 {
            let c = b.get_world_center();
            b.apply_impulse(v2(0.0, 20.0), c);
            p.jumped = true;
            p.sound_at(store, sound::JUMP, 15.0, 1.0);
        }
        let b = store.body_mut(body);
        if down == 0
            && p.row.coyote == 0.0
            && up == 0
            && right == 0
            && left == 0
            && !p.jumped
            && p.row.air_jump
            && b.get_linear_velocity().y > -2.0
        {
            let v = b.get_linear_velocity();
            if v.y > 0.0 {
                b.set_linear_velocity(v2(v.x, 0.0));
            }
            let c = b.get_world_center();
            b.apply_impulse(v2(0.0, -15.0), c);
            p.jumped = true;
            p.row.air_jump = false;
            // air-jump puff effect and sound
            let pos = store.body(body).get_position();
            p.new_effects.push(Effect {
                x: pos.x,
                y: pos.y + 0.8 * js::min(p.half_height, p.half_width),
                ttl: 15.0,
                kind: effect::AIR_JUMP,
                player: p.id(),
                ..Effect::default()
            });
            p.sound_at(store, sound::AIR_JUMP, 15.0, 1.0);
        }
    }
}

/// Candidate filter shared by abilities: dynamic, solid, non-debris, not immune map bodies.
fn targetable_body(ctx: &Ctx<'_>, bi: usize) -> bool {
    let b = &ctx.bodies[bi];
    !b.row.def.no_physics && b.row.def.motion == BODY_DYNAMIC && b.row.def.source_player == -1.0 && !b.row.def.ability_immune
}

/// Force push (hold the push key, drains stamina).
fn force_push(ctx: &mut Ctx<'_>, world: &mut World, i: usize, input: &Input) {
    let gs = ctx.gs;
    {
        let p = &mut ctx.players[i];
        if !input.push {
            p.row.push_frames = 0.0;
        }
        if !input.push && !input.bat && p.row.stamina < gs.max_stamina {
            p.row.stamina += gs.ammo_regen;
            if p.row.stamina > gs.max_stamina {
                p.row.stamina = gs.max_stamina;
            }
        }
        if !input.push || input.bat {
            return;
        }
        if p.row.stamina < gs.push_min_ammo && p.row.push_frames == 0.0 {
            return;
        }
        if p.row.stamina <= 0.0 {
            return;
        }
        if p.row.push_frames == 0.0 {
            p.row.stamina -= gs.push_first_spend;
        } else {
            p.row.stamina -= gs.push_spend;
        }
        if p.row.stamina <= 0.0 {
            p.row.stamina = 0.0;
        }
        p.row.push_frames += 1.0;
    }
    let me = player_body(ctx, i);
    let my_id = ctx.players[i].row.id;
    let my_team = ctx.players[i].row.team;
    let frames = ctx.players[i].row.push_frames;
    let mut hit_any = false;
    let list: Vec<BodyId> = world.bodies().collect();
    for b in list {
        let store = world.store();
        if store.body(b).get_type() != BodyType::Dynamic || b == me {
            continue;
        }
        let (k, oi) = crate::step::body_tag(store, b);
        if k == kind::PROJECTILE {
            continue;
        }
        if k == kind::BODY && ctx.bodies[oi].row.def.source_player != -1.0 {
            continue;
        }
        if k == kind::BODY && ctx.bodies[oi].row.def.ability_immune {
            continue;
        }
        if !gs.push_players && k == kind::PLAYER {
            continue;
        }
        if k == kind::PLAYER {
            let t = &ctx.players[oi];
            if t.row.age <= SPAWN_GRACE || t.dashing(gs) || t.same_team(my_team) {
                continue;
            }
        }
        let mut d = store.body(b).get_position();
        d.subtract(store.body(me).get_position());
        let dist = d.length();
        if dist > gs.push_range {
            continue;
        }
        hit_any = true;
        let n = dist / gs.push_range;
        d.normalize();
        d.multiply(5.0 - 1.0 * n);
        d.multiply(store.body(b).get_mass());
        let target_pos = store.body(b).get_position();
        let my_pos = store.body(me).get_position();
        if frames > gs.push_delay {
            let store = world.store_mut();
            let pos = store.body(b).get_position();
            store.body_mut(b).apply_impulse(d, pos);
            if k == kind::PLAYER {
                let t = &mut ctx.players[oi];
                t.row.attacker = my_id;
                t.row.attacker_timer = CREDIT_TICKS;
            }
        }
        let p = &mut ctx.players[i];
        if frames % 3.0 == 1.0 {
            p.new_effects.push(Effect {
                x: my_pos.x,
                y: my_pos.y,
                x2: target_pos.x,
                y2: target_pos.y,
                ttl: 5.0,
                kind: effect::PUSH_LINE,
                z_index: 0.0,
                team: my_team,
                player: p.id(),
                ..Effect::default()
            });
        }
        if frames == 1.0 {
            p.new_effects.push(Effect {
                x: my_pos.x,
                y: my_pos.y,
                x2: target_pos.x,
                y2: target_pos.y,
                ttl: 3.0,
                kind: effect::PUSH_LINE,
                z_index: 0.0,
                team: my_team,
                player: p.id(),
                ..Effect::default()
            });
        }
        if k == kind::BODY {
            let pid = p.index;
            let w = ctx.bodies[oi].row.push_from.get(pid).copied();
            ctx.bodies[oi].row.push_from.insert(pid, w.map_or(1.0, |w| w + 1.0));
        }
    }
    let store = world.store();
    let p = &mut ctx.players[i];
    if frames % 3.0 == 1.0 {
        p.sound_at(store, if hit_any { sound::PUSH_HIT } else { sound::PUSH_MISS }, 10.0, 0.8);
    }
    if !hit_any && frames % 3.0 == 1.0 {
        let pos = store.body(me).get_position();
        p.new_effects.push(Effect {
            x: pos.x,
            y: pos.y,
            player: p.id(),
            ttl: 4.0,
            kind: effect::PUSH_WAVE,
            team: my_team,
            volume: 1.0,
            ..Effect::default()
        });
    }
}

fn bat_hit_before(hits: &[f64], k: f64, id: f64) -> bool {
    let mut i = 0;
    while i + 1 < hits.len() {
        if hits[i] == k && hits[i + 1] == id {
            return true;
        }
        i += 2;
    }
    false
}

/// Bat swing: aim during wind-up, hit during the fire window.
fn bat(ctx: &mut Ctx<'_>, world: &mut World, i: usize, input: &Input) {
    let gs = ctx.gs;
    let cone = gs.bat_angle * (std::f64::consts::PI / 180.0);
    let mut hit = false;
    {
        let p = &mut ctx.players[i];
        if p.row.bat_frame == -1.0 {
            if input.bat && p.row.stamina > gs.bat_init_cost {
                p.row.bat_frame += 1.0;
            }
        } else if p.row.bat_frame < gs.bat_hold_until {
            if input.bat {
                p.row.bat_frame += 1.0;
            }
            if !input.bat {
                p.row.bat_frame = -1.0;
            }
        }
        if p.row.bat_frame == gs.bat_hold_until {
            if input.bat {
                p.row.stamina = js::max(0.0, p.row.stamina - gs.bat_hold_cost);
                if p.row.stamina == 0.0 {
                    p.row.bat_frame += 1.0;
                }
            } else {
                p.row.bat_frame += 1.0;
            }
        }
        if p.row.bat_frame > gs.bat_hold_until {
            p.row.bat_frame += 1.0;
        }
    }
    let frame = ctx.players[i].row.bat_frame;
    let me_tag = (kind::PLAYER, i);
    let my_team = ctx.players[i].row.team;
    let origin = world.store().body(player_body(ctx, i)).get_position();
    if frame > -1.0 && frame < gs.bat_fire_on {
        // aim at the nearest target
        let mut cands = Vec::new();
        for bi in 0..ctx.bodies.len() {
            if targetable_body(ctx, bi) {
                cands.push((kind::BODY, bi));
            }
        }
        for pi in 0..ctx.players.len() {
            if !ctx.players[pi].same_team(my_team) {
                cands.push((kind::PLAYER, pi));
            }
        }
        for qi in 0..ctx.projectiles.len() {
            cands.push((kind::PROJECTILE, qi));
        }
        let near = sort_near(world.store(), ctx, origin, &cands, me_tag);
        if let Some(n) = near.first() {
            ctx.players[i].row.bat_aim = js::qatan2(n.dy, n.dx);
        }
    }
    if frame >= gs.bat_fire_on && frame < gs.bat_fire_on + gs.bat_fire_frames {
        let hits = ctx.players[i].row.bat_hits.clone();
        let mut cands = Vec::new();
        for bi in 0..ctx.bodies.len() {
            let b = &ctx.bodies[bi];
            if !b.row.def.no_physics
                && b.row.def.motion == BODY_DYNAMIC
                && b.row.def.source_player == -1.0
                && !bat_hit_before(&hits, kind::BODY as f64, b.index as f64)
                && !b.row.def.ability_immune
            {
                cands.push((kind::BODY, bi));
            }
        }
        for pi in 0..ctx.players.len() {
            let t = &ctx.players[pi];
            if t.row.age > SPAWN_GRACE
                && !bat_hit_before(&hits, kind::PLAYER as f64, t.id())
                && !t.dashing(gs)
                && !t.same_team(my_team)
            {
                cands.push((kind::PLAYER, pi));
            }
        }
        for qi in 0..ctx.projectiles.len() {
            if !bat_hit_before(&hits, kind::PROJECTILE as f64, ctx.projectiles[qi].index as f64) {
                cands.push((kind::PROJECTILE, qi));
            }
        }
        let near = sort_near(world.store(), ctx, origin, &cands, me_tag);
        let aim = ctx.players[i].row.bat_aim;
        let my_id = ctx.players[i].id();
        for n in near {
            if n.dist > gs.bat_range {
                continue;
            }
            let a = js::qatan2(n.dy, n.dx);
            let diff = (a - aim).abs();
            if js::min(diff, 2.0 * std::f64::consts::PI - diff) >= cone {
                continue;
            }
            let mut imp = v2(n.dx, n.dy);
            imp.normalize();
            imp.multiply(gs.bat_power);
            let target_body;
            match n.kind {
                kind::BODY => {
                    let b = &mut ctx.bodies[n.index];
                    let bb = b.body.expect("body");
                    imp.multiply(0.45 * world.store().body(bb).get_mass());
                    ctx.players[i].row.bat_hits.extend([kind::BODY as f64, b.index as f64]);
                    let w = b.row.push_from.get(ctx.players[i].index).copied();
                    b.row.push_from.insert(ctx.players[i].index, w.map_or(1.0, |w| w + 10.0));
                    target_body = bb;
                }
                kind::PROJECTILE => {
                    let q = &mut ctx.projectiles[n.index];
                    if q.row.owner == my_id {
                        let s = js::max(js::min(gs.rocket_self_bat_scale, 1.0), 0.0);
                        if s == 0.0 {
                            continue;
                        }
                        imp.multiply(s);
                    }
                    q.row.owner = my_id;
                    q.row.team = my_team;
                    ctx.players[i].row.bat_hits.extend([kind::PROJECTILE as f64, q.index as f64]);
                    imp.multiply(0.25);
                    target_body = q.body.expect("projectile body");
                }
                _ => {
                    let t = &mut ctx.players[n.index];
                    t.row.attacker = my_id;
                    t.row.attacker_timer = CREDIT_TICKS;
                    let tid = t.id();
                    target_body = t.body.expect("player body");
                    ctx.players[i].row.bat_hits.extend([kind::PLAYER as f64, tid]);
                }
            }
            let store = world.store_mut();
            let c = store.body(target_body).get_world_center();
            store.body_mut(target_body).apply_impulse(imp, c);
            hit = true;
        }
    }
    let store = world.store();
    let p = &mut ctx.players[i];
    if p.row.bat_frame == gs.bat_fire_on {
        p.sound_at(store, sound::BAT_SWING, 15.0, 1.0);
    }
    if p.row.bat_frame == gs.bat_reset_on {
        p.row.bat_frame = -1.0;
        p.row.bat_hits.clear();
    }
    if hit {
        p.sound_at(store, sound::BAT_HIT, 15.0, 1.0);
    }
}

/// Dash (settings-enabled alternative to grab).
fn dash(ctx: &mut Ctx<'_>, world: &mut World, i: usize, input: &Input) {
    let gs = ctx.gs;
    let body = player_body(ctx, i);
    let p = &mut ctx.players[i];
    if p.row.dash_frame == -1.0 && input.rocket && p.row.stamina >= gs.dash_cost {
        p.row.dash_frame += 1.0;
        p.row.stamina -= gs.dash_cost;
    } else if p.row.dash_frame > -1.0 {
        p.row.dash_frame += 1.0;
    }
    let b = world.store_mut().body_mut(body);
    if p.row.dash_frame == gs.dash_init_delay {
        let v = b.get_linear_velocity();
        p.row.dash_speed = v.length();
        let a = js::qatan2(v.y, v.x);
        let dx = js::qcos(a) * gs.dash_boost;
        let dy = js::qsin(a) * gs.dash_boost;
        let mut v = b.get_linear_velocity();
        v.x += dx;
        v.y += dy;
        b.set_linear_velocity(v);
    }
    if p.row.dash_frame == gs.dash_init_delay + gs.dash_active {
        let v = b.get_linear_velocity();
        let r = v.length() / p.row.dash_speed;
        if r > 1.0 {
            b.set_linear_velocity(v2(v.x / r, v.y / r));
        }
    }
    if p.row.dash_frame == gs.dash_init_delay + gs.dash_active + gs.dash_cooldown {
        p.row.dash_frame = -1.0;
    }
}

/// Parachute (settings-enabled alternative to grab).
fn parachute(ctx: &mut Ctx<'_>, world: &mut World, i: usize, input: &Input) {
    let held = input.grab;
    {
        let p = &mut ctx.players[i];
        if held && p.row.parachute.is_none() {
            p.row.parachute = Some(Parachute {
                x: p.row.x,
                y: p.row.y - 0.5,
                vx: p.row.vx,
                vy: p.row.vy - 3.0,
                angle: 0.0,
                angular_velocity: 0.0,
                deploy: 4.0,
            });
        }
    }
    let Some(chute) = ctx.players[i].row.parachute else {
        return;
    };
    if !held {
        ctx.players[i].row.parachute = None;
        return;
    }
    let body = player_body(ctx, i);
    let (half_width, half_height) = (ctx.players[i].half_width, ctx.players[i].half_height);
    if chute.deploy == 2.0 {
        let store = world.store();
        let p = &mut ctx.players[i];
        let pos = store.body(body).get_position();
        let speed = store.body(body).get_linear_velocity().length();
        p.new_sounds.push(Sound {
            x: pos.x,
            y: pos.y,
            ttl: -1.0,
            kind: sound::PARACHUTE,
            player: p.id(),
            volume: js::max(js::min(0.01 * libm::pow(speed, 1.5), 1.0), 0.0),
            effect_row: true,
        });
    }
    let mut def = B2BodyDef::default();
    def.body_type = BodyType::Dynamic;
    def.position = v2(chute.x, chute.y);
    def.angle = chute.angle;
    def.angular_velocity = chute.angular_velocity;
    def.linear_damping = 10.0;
    def.angular_damping = 0.5;
    def.user_data = tag(kind::PARACHUTE, i);
    let canopy = world.create_body(&def);
    let mut shape = PolygonShape::new();
    shape.set_as_box(2.0 * half_width, 0.5 * half_height);
    let mut fd = FixtureDef::new(Shape::Polygon(shape));
    fd.density = 1.3;
    fd.friction = 0.3;
    fd.restitution = 0.3;
    fd.is_sensor = true;
    fd.filter.category_bits = CATEGORY;
    fd.filter.mask_bits = 0;
    world.create_fixture(canopy, &fd);
    world.store_mut().body_mut(canopy).set_linear_velocity(v2(chute.vx, chute.vy));
    ctx.players[i].chute = Some(canopy);
    let mut attached = false;
    for side in [-1.0, 1.0] {
        let store = world.store();
        let a = store.body(body).get_world_point(v2(0.0, 0.0));
        let mut b = store.body(canopy).get_world_point(v2(2.0 * side * half_width, 0.0));
        b.subtract(a);
        let len = b.length();
        if len >= 2.0 {
            let def = DistanceJointDef {
                body_a: body,
                body_b: canopy,
                local_anchor_a: v2(0.0, 0.0),
                local_anchor_b: v2(2.0 * side * half_width, 0.0),
                length: 2.0,
                frequency_hz: 2.0,
                damping_ratio: 0.4,
                collide_connected: true,
                ..DistanceJointDef::default()
            };
            world.create_joint(&JointDef::Distance(def));
            attached = true;
        }
    }
    let rocket_idle = ctx.players[i].row.rocket_frame == -1.0;
    let store = world.store_mut();
    if attached {
        if rocket_idle {
            if input.left && store.body(canopy).get_linear_velocity().x < 0.0 {
                let c = store.body(canopy).get_world_center();
                store.body_mut(canopy).apply_force(v2(-30.0, 0.0), c);
            } else if input.right && store.body(body).get_linear_velocity().x > 0.0 {
                let c = store.body(canopy).get_world_center();
                store.body_mut(canopy).apply_force(v2(30.0, 0.0), c);
            }
            if input.left && store.body(body).get_linear_velocity().x < 0.0 {
                let c = store.body(body).get_world_center();
                store.body_mut(body).apply_force(v2(-10.0, 0.0), c);
            } else if input.right && store.body(body).get_linear_velocity().x > 0.0 {
                let c = store.body(body).get_world_center();
                store.body_mut(body).apply_force(v2(10.0, 0.0), c);
            }
        }
        let v = store.body(canopy).get_linear_velocity();
        if v.y > 0.0 {
            store.body_mut(canopy).set_linear_velocity(v2(v.x, 0.55 * v.y));
        }
    } else {
        store.body_mut(canopy).set_linear_damping(2.0);
    }
}

/// Local anchor of grab direction `dir` (0..8) on the player box.
fn grab_anchor(dir: usize, outer: bool, half_width: f64, half_height: f64) -> Vec2 {
    let e = if outer { 1.0 } else { 0.0 };
    let (x, y) = match dir {
        0 => (half_width + e, -(half_height + e)),
        1 => (half_width + e, half_height + e),
        2 => (-(half_width + e), half_height + e),
        3 => (-(half_width + e), -(half_height + e)),
        4 => (half_width + e, 0.0),
        5 => (-(half_width + e), 0.0),
        6 => (0.0, half_height + e),
        7 => (0.0, -(half_height + e)),
        _ => (0.0, 0.0),
    };
    v2(x, y)
}

/// Grab (8 directional rays attach distance joints to dynamic bodies).
fn grab(ctx: &mut Ctx<'_>, world: &mut World, i: usize, input: &Input) {
    let held = input.grab;
    let body = player_body(ctx, i);
    for dir in 0..8 {
        let mut a = ctx.players[i].row.grabs[dir];
        if !held && a.state != ATTACH_IDLE {
            a.state = ATTACH_IDLE;
            ctx.players[i].row.grabs[dir] = a;
        }
        if a.state == ATTACH_ON && a.kind == kind::PLAYER as f64 {
            if let Some(ti) = ctx.player_index(a.target) {
                if ctx.players[ti].row.age == 0.0 {
                    a = Attach { state: ATTACH_LOST, ..Attach::default() };
                    ctx.players[i].row.grabs[dir] = a;
                }
            }
        }
        if held && a.state == ATTACH_IDLE {
            if let Some((target, point)) = grab_ray(ctx, world, i, dir) {
                let store = world.store();
                let (k, oi) = crate::step::body_tag(store, target);
                let local = store.body(target).get_local_point(point);
                a.state = ATTACH_ON;
                a.target = owner_id(ctx, k, oi);
                a.kind = k as f64;
                a.ax = local.x;
                a.ay = local.y;
                ctx.players[i].row.grabs[dir] = a;
            }
        }
        if a.state == ATTACH_ON {
            // find the attached object's body by walking the world body list
            let mut found: Option<(BodyId, u32, usize)> = None;
            for b in world.bodies() {
                let (k, oi) = crate::step::body_tag(world.store(), b);
                if k == kind::NONE || k == kind::PARACHUTE {
                    continue;
                }
                if k as f64 == a.kind && owner_id(ctx, k, oi) == a.target {
                    found = Some((b, k, oi));
                    break;
                }
            }
            match found {
                Some((tb, k, oi)) if !owner_teleported(ctx, k, oi) => {
                    let (half_width, half_height) = (ctx.players[i].half_width, ctx.players[i].half_height);
                    let def = DistanceJointDef {
                        body_a: body,
                        body_b: tb,
                        local_anchor_a: grab_anchor(dir, false, half_width, half_height),
                        local_anchor_b: v2(a.ax, a.ay),
                        length: 0.0,
                        frequency_hz: 2.0,
                        damping_ratio: 0.4,
                        collide_connected: true,
                        ..DistanceJointDef::default()
                    };
                    world.create_joint(&JointDef::Distance(def));
                    ctx.players[i].grabbed.push(tb);
                }
                _ => {
                    a.state = ATTACH_LOST;
                    ctx.players[i].row.grabs[dir] = a;
                }
            }
        }
    }
}

fn owner_id(ctx: &Ctx<'_>, k: u32, oi: usize) -> f64 {
    match k {
        kind::PLAYER => ctx.players[oi].id(),
        kind::BODY => ctx.bodies[oi].index as f64,
        kind::PROJECTILE => ctx.projectiles[oi].index as f64,
        kind::TURRET => ctx.turrets[oi].index as f64,
        kind::PICKUP => ctx.pickups[oi].index as f64,
        _ => f64::NAN,
    }
}

/// Teleported flag of the owner (objects without it count as not teleported).
fn owner_teleported(ctx: &Ctx<'_>, k: u32, oi: usize) -> bool {
    match k {
        kind::PLAYER => ctx.players[oi].row.teleported,
        kind::BODY => ctx.bodies[oi].row.teleported,
        _ => false,
    }
}

/// Ray from the centre through grab direction `dir`; nearest
/// non-static, non-sensor map body (that the player collides with).
fn grab_ray(ctx: &Ctx<'_>, world: &World, i: usize, dir: usize) -> Option<(BodyId, Vec2)> {
    let p = &ctx.players[i];
    let body = p.body?;
    let origin = v2(p.row.x, p.row.y);
    let end = world.store().body(body).get_world_point(grab_anchor(dir, true, p.half_width, p.half_height));
    let team = p.row.team;
    let mut best = f64::INFINITY;
    let mut hit: Option<(BodyId, Vec2)> = None;
    world.ray_cast(
        |store, f, point, _n, frac| {
            if store.fixture(f).is_sensor() {
                return 1.0;
            }
            let (b, k, bi) = fixture_owner(store, f);
            if k != kind::BODY {
                return 1.0;
            }
            let pass = ctx.bodies[bi].row.def.player_pass;
            if pass == 1.0 || pass == team {
                return 1.0;
            }
            if frac < best && store.body(b).get_type() != BodyType::Static {
                best = frac;
                hit = Some((b, point));
            }
            1.0
        },
        origin,
        end,
    );
    hit
}

/// Nearest valid target for rocket/egg aiming: players not on my team and
/// (for rockets) turrets not on my team.
fn aim_target(ctx: &Ctx<'_>, world: &World, i: usize, include_turrets: bool) -> Option<f64> {
    let team = ctx.players[i].row.team;
    let mut cands = Vec::new();
    for pi in 0..ctx.players.len() {
        if !ctx.players[pi].same_team(team) {
            cands.push((kind::PLAYER, pi));
        }
    }
    if include_turrets {
        for ti in 0..ctx.turrets.len() {
            let t = &ctx.turrets[ti].row;
            if !(team == t.team && team > 1.0) {
                cands.push((kind::TURRET, ti));
            }
        }
    }
    let origin = world.store().body(ctx.players[i].body?).get_position();
    let near = sort_near(world.store(), ctx, origin, &cands, (kind::PLAYER, i));
    near.first().map(|n| js::qatan2(n.dy, n.dx))
}

/// Rocket (charge, steer, fire).
fn rocket(ctx: &mut Ctx<'_>, world: &mut World, i: usize, input: &Input) {
    let gs = ctx.gs;
    let frame = ctx.players[i].row.rocket_frame;
    let held = input.rocket;
    if held {
        ctx.players[i].special_held = true;
    }
    if frame == -1.0 && held && ctx.players[i].row.stamina >= gs.rocket_cost {
        ctx.players[i].row.rocket_frame = 0.0;
        if let Some(a) = aim_target(ctx, world, i, true) {
            ctx.players[i].row.set_rocket_aim(a);
        }
    }
    if frame > -1.0 && frame < 5.0 {
        if held {
            ctx.players[i].row.rocket_frame += 1.0;
            if let Some(a) = aim_target(ctx, world, i, true) {
                ctx.players[i].row.set_rocket_aim(a);
            }
        } else {
            ctx.players[i].row.rocket_frame = -1.0;
        }
        if frame == 4.0 {
            let store = world.store();
            ctx.players[i].sound_at(store, sound::ROCKET_CHARGE, 15.0, 0.2);
        }
    }
    if frame == 5.0 {
        if let Some(a) = aim_target(ctx, world, i, true) {
            ctx.players[i].row.set_rocket_aim(a);
        }
        ctx.players[i].row.rocket_frame += 1.0;
        ctx.players[i].row.stamina -= gs.rocket_cost;
    }
    let p = &mut ctx.players[i];
    if frame == 6.0 {
        if input.left {
            p.row.rocket_aim -= gs.rocket_aim_rate;
        }
        if input.right {
            p.row.rocket_aim += gs.rocket_aim_rate;
        }
        p.row.stamina -= gs.ammo_regen;
        if !held {
            p.row.rocket_frame += 1.0;
        }
    }
    if frame > 6.0 && frame < 8.0 {
        p.row.rocket_frame += 1.0;
    }
    if frame == 8.0 {
        let pos = world.store().body(p.body.expect("player body")).get_position();
        let c = js::qcos(p.row.rocket_aim);
        let s = js::qsin(p.row.rocket_aim);
        p.new_projectiles.push(Projectile {
            owner: p.id(),
            x: pos.x + 0.2 * c,
            y: pos.y + 0.2 * s,
            vx: c * gs.rocket_speed,
            vy: s * gs.rocket_speed,
            shape: crate::objects::PROJ_ROCKET,
            size: gs.rocket_radius,
            life: gs.rocket_age,
            turn_rate: gs.rocket_turn_rate,
            gravity_scale: gs.rocket_gravity_scale,
            bounces: gs.rocket_bounces,
            restitution: gs.rocket_restitution,
            bounce_limit: gs.rocket_bounce_limit,
            explode_radius: gs.rocket_explode_radius,
            team: p.row.team,
            damage: 999.0,
            object_damage: 40.0,
            align: true,
            ..Projectile::default()
        });
        p.row.rocket_frame = -1.0;
        let store = world.store();
        p.sound_at(store, sound::ROCKET_FIRE, 15.0, 0.4);
    }
}

impl Player {
    #[inline]
    fn set_rocket_aim(&mut self, a: f64) {
        self.rocket_aim = a;
    }
}

/// Egg throw (settings-enabled alternative to the rocket).
fn egg(ctx: &mut Ctx<'_>, world: &mut World, i: usize, input: &Input) {
    let gs = ctx.gs;
    let mut frame = ctx.players[i].row.egg_frame;
    let held = input.rocket;
    let aim = |ctx: &mut Ctx<'_>, world: &World| {
        if let Some(a) = aim_target(ctx, world, i, false) {
            ctx.players[i].row.egg_aim = a;
        }
    };
    let throw = |ctx: &mut Ctx<'_>, world: &World, power: f64| {
        let p = &mut ctx.players[i];
        let a = p.row.egg_aim;
        let c = js::qcos(a);
        let s = js::qsin(a);
        let pos = world.store().body(p.body.expect("player body")).get_position();
        let vx = power * gs.egg_power * c;
        p.new_projectiles.push(Projectile {
            owner: p.id(),
            x: pos.x + 0.2 * c,
            y: pos.y + 0.2 * s,
            vx,
            vy: power * gs.egg_power * s,
            shape: gs.egg_shape,
            size: gs.egg_size,
            life: gs.egg_age,
            turn_rate: 0.0,
            gravity_scale: 1.0,
            bounces: true,
            restitution: gs.egg_restitution,
            bounce_limit: 99999.0,
            explode_radius: gs.egg_explode_radius,
            team: p.row.team,
            damage: 999.0,
            align: false,
            angular_velocity: vx * gs.egg_spin,
            explode_damage: true,
            ..Projectile::default()
        });
    };
    if held {
        ctx.players[i].special_held = true;
        if frame == 0.0 && ctx.players[i].row.stamina >= gs.egg_cost {
            frame += 1.0;
            aim(ctx, world);
        } else if frame == gs.egg_delay1 {
            frame += 1.0;
            ctx.players[i].row.stamina -= gs.egg_cost;
        } else if frame > 0.0 {
            frame += 1.0;
            let p = &mut ctx.players[i];
            p.row.stamina -= gs.ammo_regen;
            if frame > gs.egg_delay2 + gs.egg_delay_ammo {
                p.row.stamina = js::max(0.0, p.row.stamina - 1.0);
            }
            if input.left {
                p.row.egg_aim -= gs.egg_aim_rate;
            } else if input.right {
                p.row.egg_aim += gs.egg_aim_rate;
            }
            if p.row.stamina == 0.0 {
                throw(ctx, world, js::min((frame - gs.egg_delay1) / gs.egg_delay2, 1.0));
                frame = 0.0;
            }
        }
    } else {
        if frame > gs.egg_delay1 {
            throw(ctx, world, js::min((frame - gs.egg_delay1) / gs.egg_delay2, 1.0));
        }
        frame = 0.0;
    }
    ctx.players[i].row.egg_frame = frame;
}

/// Ghosts float (cancel gravity).
fn ghost_float(ctx: &mut Ctx<'_>, world: &mut World, i: usize) {
    let body = player_body(ctx, i);
    let g = world.get_gravity().y;
    let store = world.store_mut();
    let mut f = v2(0.0, -g);
    f.multiply(store.body(body).get_mass());
    let c = store.body(body).get_world_center();
    store.body_mut(body).apply_force(f, c);
}

/// Ghost movement and ghost rockets.
fn ghost_move(ctx: &mut Ctx<'_>, world: &mut World, i: usize, input: &Input) {
    let gs = ctx.gs;
    let body = player_body(ctx, i);
    let p = &mut ctx.players[i];
    p.row.rocket_frame = -1.0;
    p.row.bat_frame = -1.0;
    let mut f = v2(0.0, 0.0);
    if input.left {
        f.x -= 1.0;
    }
    if input.right {
        f.x += 1.0;
    }
    if input.up {
        f.y -= 1.0;
    }
    if input.down {
        f.y += 1.0;
    }
    f.normalize();
    f.multiply(gs.ghost_force);
    let store = world.store_mut();
    let c = store.body(body).get_world_center();
    store.body_mut(body).apply_force(f, c);
    let pos = store.body(body).get_position();
    if input.rocket && p.row.stamina >= 100.0 {
        let mut vx = gs.ghost_rocket_speed;
        if store.body(body).get_linear_velocity().x < 0.1 {
            vx *= -1.0;
        }
        p.new_projectiles.push(Projectile {
            owner: p.id(),
            x: pos.x,
            y: pos.y + 0.2,
            vx,
            vy: gs.ghost_rocket_speed,
            shape: crate::objects::PROJ_ROCKET,
            size: gs.ghost_rocket_radius,
            life: gs.ghost_rocket_age,
            turn_rate: gs.ghost_rocket_turn,
            gravity_scale: gs.rocket_gravity_scale,
            bounces: gs.rocket_bounces,
            restitution: gs.rocket_restitution,
            bounce_limit: gs.rocket_bounce_limit,
            explode_radius: gs.ghost_rocket_explode,
            team: p.row.team,
            damage: 999.0,
            object_damage: 40.0,
            align: true,
            ..Projectile::default()
        });
        p.row.stamina -= 100.0;
        p.new_sounds.push(Sound { x: pos.x, y: pos.y, ttl: 15.0, kind: sound::ROCKET_FIRE, player: p.id(), volume: 0.3, effect_row: false });
    } else {
        p.row.stamina += gs.ghost_regen;
        if p.row.stamina > gs.max_stamina {
            p.row.stamina = gs.max_stamina;
        }
    }
    if p.row.age % 3.0 == 0.0 {
        p.new_sounds.push(Sound { x: pos.x, y: pos.y, ttl: 5.0, kind: sound::GHOST_TRAIL, player: p.id(), volume: 1.0, effect_row: false });
    }
}

/// Handles the start of a contact for a player.
pub(crate) fn begin_contact(ctx: &mut Ctx<'_>, store: &mut Store, i: usize, other: BodyId, c: ContactId) {
    let gs = ctx.gs;
    let (k, oi) = crate::step::body_tag(store, other);
    if k == kind::BODY {
        let def = ctx.bodies[oi].row.def.clone();
        let p = &mut ctx.players[i];
        if def.player_pass == 1.0 || def.player_pass == p.row.team {
            store.contact_mut(c).set_enabled(false);
        }
        if def.kill_players && p.row.age > 10.0 {
            p.damage(999.0);
        }
        // the next race checkpoint (heav.io builds)
        if def.checkpoint == p.row.checkpoint + 1.0 {
            p.passed = true;
        }
        if def.freeze_players {
            if p.row.freeze_ready {
                p.sound_at(store, sound::FREEZE, 30.0, 0.6);
                p.row.frozen = 33.0;
                p.row.freeze_ready = false;
            }
            p.froze = true;
        }
        if def.motion == BODY_DYNAMIC {
            ctx.bodies[oi].player_touch = true;
        }
    }
    if k == kind::PLAYER {
        let my_age = ctx.players[i].row.age;
        let my_team = ctx.players[i].row.team;
        let o = &ctx.players[oi];
        if my_age > SPAWN_GRACE && o.row.age > SPAWN_GRACE && !o.same_team(my_team) {
            let me = player_body(ctx, i);
            let mut d = store.body(other).get_position();
            d.subtract(store.body(me).get_position());
            let angle = js::qatan2(d.y, d.x) * (180.0 / std::f64::consts::PI);
            let other_vy = store.body(other).get_linear_velocity().y;
            let rel = other_vy - store.body(me).get_linear_velocity().y;
            let other_id = o.id();
            if angle > -140.0 && angle < -40.0 && rel > 5.0 && !ctx.players[i].dashing(gs) {
                let p = &mut ctx.players[i];
                p.died = true;
                p.leaving = true;
                p.row.attacker = other_id;
                p.row.attacker_timer = CREDIT_TICKS;
                let v = store.body(me).get_linear_velocity();
                store.body_mut(me).set_linear_velocity(v2(v.x, other_vy + 3.0));
            }
        }
    }
}

/// Post-solve handler for a player.
pub(crate) fn post_solve(ctx: &mut Ctx<'_>, store: &mut Store, i: usize, other: BodyId, impulse: &ContactImpulse) {
    let n0 = impulse.normal_impulses[0];
    {
        let p = &mut ctx.players[i];
        if n0 > 50.0 && p.row.age > SPAWN_GRACE {
            p.leaving = true;
            p.died = true;
        }
    }
    let (k, oi) = crate::step::body_tag(store, other);
    if k == kind::BODY {
        let mut best = -1.0;
        let mut top = 0.0;
        for (pid, w) in ctx.bodies[oi].row.push_from.iter() {
            if *w > top {
                best = pid as f64;
                top = *w;
            }
        }
        if best != -1.0 {
            let p = &mut ctx.players[i];
            p.row.attacker = best;
            p.row.attacker_timer = CREDIT_TICKS;
        }
    }
    let body = player_body(ctx, i);
    let per_mass = n0 / store.body(body).get_mass();
    if per_mass > 1.0 && !ctx.players[i].grabbed.contains(&other) {
        let kind_ = if k == kind::BODY && ctx.bodies[oi].row.def.no_jump { sound::IMPACT_NOJUMP } else { sound::IMPACT };
        let p = &mut ctx.players[i];
        let vol = 0.025 * per_mass * p.limiter.request();
        p.sound_at(store, kind_, 10.0, vol);
    }
}

/// Edge wrapping, death, kill credit.
pub(crate) fn post_step(ctx: &mut Ctx<'_>, world: &mut World, i: usize) {
    let gs = ctx.gs;
    let body = player_body(ctx, i);
    if !ctx.players[i].froze && !ctx.players[i].row.freeze_ready {
        ctx.players[i].row.freeze_ready = true;
    }
    let wrap = ctx.settings.wrap;
    let (aw, ah) = (ctx.settings.width, ctx.settings.height);
    if wrap {
        let half = gs.player_width / 2.0;
        let b = world.store().body(body);
        let mut pos = b.get_position();
        let mut vel = b.get_linear_velocity();
        let p = &mut ctx.players[i];
        if pos.y > ah + half {
            pos.y -= ah + 2.0 * half;
            p.row.teleported = true;
        } else if pos.y < 0.0 - half {
            pos.y += ah + 2.0 * half;
            p.row.teleported = true;
        }
        if pos.x > aw + half {
            pos.x -= aw + 2.0 * half;
            vel.x += 5.0;
            p.row.teleported = true;
        } else if pos.x < 0.0 - half {
            pos.x += aw + 2.0 * half;
            vel.x -= 5.0;
            p.row.teleported = true;
        }
        world.set_position(body, pos);
        world.store_mut().body_mut(body).set_linear_velocity(vel);
    }
    let y = world.store().body(body).get_position().y;
    let p = &ctx.players[i];
    if p.row.health <= 0.0 || (!wrap && y > ah + p.half_height) {
        if p.row.checkpoint > 0.0 {
            // heav.io race: back to the last checkpoint instead of dying
            crate::race::back_to_checkpoint(ctx, i);
        } else {
            let p = &mut ctx.players[i];
            p.died = true;
            p.debris_up = true;
        }
    }
    if ctx.players[i].passed {
        crate::race::passed(ctx, i);
    }
    crate::race::run_time(ctx, i);
    if ctx.players[i].died {
        let me = ctx.players[i].id();
        let attacker = ctx.players[i].row.attacker;
        if ctx.players[i].row.attacker_timer > 0.0 && attacker != me {
            crate::round::kill(ctx, attacker, me);
            if let Some(ai) = ctx.player_index(attacker) {
                let a = &mut ctx.players[ai];
                a.row.kills += 1.0;
                if a.row.kills == gs.ghost_after {
                    a.row.ghost = true;
                }
            }
        } else {
            crate::round::suicide(ctx, me);
        }
        crate::round::respawn_in(ctx, me, 60.0);
        ctx.players[i].leaving = true;
    }
}

/// Writes the player into the next state (or leaves debris when dead).
pub(crate) fn serialize(ctx: &mut Ctx<'_>, world: &mut World, i: usize, next: &mut State) {
    let body = player_body(ctx, i);
    let chute = ctx.players[i].chute;
    {
        let p = &mut ctx.players[i];
        let store = world.store();
        if p.leaving {
            if p.died {
                debris(p, store, next);
                let pos = store.body(body).get_position();
                p.new_sounds.push(Sound { x: pos.x, y: pos.y, ttl: 5.0, kind: sound::DEATH, player: p.id(), volume: 0.23, effect_row: false });
            }
        } else if let (false, Some((x, y))) = (p.died, p.to_checkpoint) {
            // the old body breaks up; a fresh player appears at the checkpoint, its run time still going
            debris(p, store, next);
            let e = &p.row;
            let back = Player {
                id: e.id,
                x,
                y,
                spawn_x: e.spawn_x,
                spawn_y: e.spawn_y,
                team: e.team,
                teleported: true,
                checkpoint: e.checkpoint,
                age: e.age,
                reset_count: e.reset_count,
                ..Player::default()
            };
            next.players.insert(p.index, back);
        } else if !p.died {
            let b = store.body(body);
            let pos = b.get_position();
            let vel = b.get_linear_velocity();
            p.row.x = pos.x;
            p.row.y = pos.y;
            p.row.angle = b.get_angle();
            p.row.angular_velocity = b.get_angular_velocity();
            p.row.vx = vel.x;
            p.row.vy = vel.y;
            p.row.age += 1.0;
            if let (Some(pc), Some(cb)) = (p.row.parachute.as_mut(), chute) {
                let c = store.body(cb);
                let cp = c.get_position();
                let cv = c.get_linear_velocity();
                pc.x = cp.x;
                pc.y = cp.y;
                pc.angle = c.get_angle();
                pc.angular_velocity = c.get_angular_velocity();
                pc.vx = cv.x;
                pc.vy = cv.y;
                if pc.deploy > 0.0 {
                    pc.deploy -= 1.0;
                }
            }
            p.row.sound_limiter = p.limiter.value();
            next.players.insert(p.index, p.row.clone());
        }
    }
    let p = &mut ctx.players[i];
    for q in p.new_projectiles.drain(..) {
        let slot = next.counters.projectile;
        if let Some(s) = index_of(slot) {
            next.projectiles.insert(s, q);
        }
        next.counters.projectile += 1.0;
    }
    for e in p.new_effects.drain(..) {
        let slot = next.counters.next_effect();
        if let Some(s) = index_of(slot) {
            next.effects.insert(s, e);
        }
    }
    next.sounds.append(&mut p.new_sounds);
}

/// Splits the dead player's box into two dynamic debris halves.
fn debris(p: &mut PlayerObj, store: &Store, next: &mut State) {
    let h = p.half_width;
    let tl = [-h, -h];
    let tr = [h, -h];
    let br = [h, h];
    let bl = [-h, h];
    let w = 1.5 * h;
    let gap = 2.0 * h - w;
    let r1 = next.round.random();
    let right = [h, gap / 2.0 - h + r1 * w];
    let r2 = next.round.random();
    let left = [-h, gap / 2.0 - h + r2 * w];
    let b = store.body(p.body.expect("player body"));
    let pos = b.get_position();
    let vel = b.get_linear_velocity();
    let piece = |pts: [[f64; 2]; 4], next: &mut State| {
        let r1 = next.round.random();
        let vx = vel.x + 2.0 * r1 - 1.0;
        let r2 = next.round.random();
        let mut vy = vel.y + 2.0 * r2 - 1.0;
        if p.debris_up {
            let over = vy - 10.0;
            if over > 0.0 {
                vy = 10.0 + over / 4.0;
            }
            vy *= -1.0;
        }
        let shape = MapShape {
            kind: crate::map::SHAPE_POLYGON,
            color: p.row.team,
            points: pts.to_vec(),
            ..MapShape::default()
        };
        let id = next.bodies.ids().last().map_or(0, |k| k + 1).max(next.bodies.len() as u32);
        let def = BodyDef {
            id,
            friction: FRICTION,
            density: 0.78125,
            restitution: RESTITUTION,
            motion: BODY_DYNAMIC,
            player_pass: 1.0,
            no_jump: true,
            group: crate::map::Group::named("d"),
            collide_d: false,
            source_player: p.id(),
            shapes: vec![shape],
            ..BodyDef::default()
        };
        let body = Body {
            x: pos.x,
            y: pos.y,
            angle: b.get_angle(),
            angular_velocity: b.get_angular_velocity(),
            vx,
            vy,
            teleported: false,
            damage: 0.0,
            lifetime: 90.0,
            sound_limiter: 1.0,
            push_from: Sparse::new(),
            def: Arc::new(def),
        };
        next.bodies.insert(id, body);
    };
    piece([left, tl, tr, right], next);
    piece([right, br, bl, left], next);
}
