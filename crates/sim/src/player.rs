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

/// Impact-sound limiter (`A3`).
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
    pub eo: Player,
    /// half size used for distance sorting (`hs`)
    pub hs: f64,
    pub hu: f64,
    pub eu: f64,
    pub body: Option<BodyId>,
    /// parachute canopy body (`lu`)
    pub chute: Option<BodyId>,
    /// `_l` died this tick
    pub dead: bool,
    /// `Xl` died by damage/fall (debris flies up)
    pub xl: bool,
    /// `Zl` leaves the state this tick
    pub gone: bool,
    /// `$l` jumped this tick
    pub jumped: bool,
    /// `iu` touched a freeze body
    pub froze: bool,
    /// `su` holds the special key (blocks movement input)
    pub su: bool,
    pub new_effects: Vec<Effect>,
    pub new_sounds: Vec<Sound>,
    pub new_projectiles: Vec<Projectile>,
    /// bodies held by grab joints this tick (`tu`)
    pub grabbed: Vec<BodyId>,
    pub limiter: Limiter,
}

impl PlayerObj {
    pub fn new(index: u32, mut eo: Player, gs: &GameSettings) -> PlayerObj {
        eo.teleported = false;
        let limiter = Limiter::new(eo.sound_limiter, 1.0, 0.2, 0.8);
        PlayerObj {
            index,
            eo,
            hs: gs.player_width / 2.0,
            hu: gs.player_width / 2.0,
            eu: gs.player_height / 2.0,
            body: None,
            chute: None,
            dead: false,
            xl: false,
            gone: false,
            jumped: false,
            froze: false,
            su: false,
            new_effects: Vec::new(),
            new_sounds: Vec::new(),
            new_projectiles: Vec::new(),
            grabbed: Vec::new(),
            limiter,
        }
    }

    #[inline]
    pub fn id(&self) -> f64 {
        self.index as f64
    }

    /// `Gl`: same team (teams > 1 only).
    pub fn same_team(&self, team: f64) -> bool {
        self.eo.team == team && self.eo.team > 1.0
    }

    /// `Fu`: dash in its active window.
    pub fn dashing(&self, gs: &GameSettings) -> bool {
        self.eo.dash_frame >= 3.0 && self.eo.dash_frame < gs.dash_init_delay + gs.dash_active
    }

    /// `Ll`: take damage.
    pub fn damage(&mut self, amount: f64) {
        self.eo.health -= amount;
        self.eo.health = js::min(100.0, self.eo.health);
        self.eo.health = js::max(0.0, self.eo.health);
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

/// `oo`: create the player's physics body.
pub(crate) fn create(ctx: &mut Ctx<'_>, world: &mut World, i: usize) {
    let gs = ctx.gs;
    let p = &ctx.players[i];
    let mut def = B2BodyDef::default();
    def.body_type = BodyType::Dynamic;
    def.position = v2(p.eo.x, p.eo.y);
    def.angle = p.eo.angle;
    def.angular_velocity = p.eo.angular_velocity;
    def.fixed_rotation = false;
    def.linear_damping = 0.3;
    if p.eo.ghost {
        def.linear_damping = gs.ghost_damping;
    }
    def.angular_damping = 0.5;
    def.bullet = true;
    def.user_data = tag(kind::PLAYER, i);
    let body = world.create_body(&def);
    let mut shape = PolygonShape::new();
    shape.set_as_box(p.hu, p.eu);
    let mut fd = FixtureDef::new(Shape::Polygon(shape));
    fd.density = 2.0 / (2.0 * p.hu * p.eu * 2.0);
    fd.friction = FRICTION;
    fd.restitution = RESTITUTION;
    fd.filter.category_bits = CATEGORY;
    world.create_fixture(body, &fd);
    world.store_mut().body_mut(body).set_linear_velocity(v2(p.eo.vx, p.eo.vy));
    ctx.players[i].body = Some(body);
}

/// `mu`: apply one tick of input.
pub(crate) fn update(ctx: &mut Ctx<'_>, world: &mut World, i: usize, mut input: Input) {
    let gs = ctx.gs;
    if ctx.players[i].eo.frozen > 0.0 {
        input = Input::default();
    }
    if !ctx.players[i].eo.ghost {
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
        p.eo.up_held += 1.0;
    } else {
        p.eo.up_held = 0.0;
    }
}

/// `ao`
pub(crate) fn pre_step(p: &mut PlayerObj) {
    if p.eo.frozen > 0.0 {
        p.eo.frozen -= 1.0;
    }
    if p.eo.attacker_timer > 0.0 {
        p.eo.attacker_timer -= 1.0;
    }
}

/// `Nu`: horizontal movement forces and air control.
fn movement(ctx: &mut Ctx<'_>, world: &mut World, i: usize, input: &Input) {
    let p = &ctx.players[i];
    let mut input = *input;
    if p.eo.stunned || p.su {
        input = Input::default();
    }
    let body = player_body(ctx, i);
    let mut brake = 120.0;
    let mut idle = 10.0;
    let speed = (p.eo.vx * p.eo.vx + p.eo.vy * p.eo.vy).sqrt();
    let mut force = 80.0 - 60.0 * js::min(speed / 15.0, 1.0);
    let moving_right = p.eo.vx > 0.4;
    let moving_left = p.eo.vx < -0.4;
    // grounded: ray from the centre straight down
    let grounded = {
        let mut hit = false;
        let from = v2(p.eo.x, p.eo.y);
        let to = v2(p.eo.x, p.eo.y + js::max(p.eu, p.hu) + 0.2);
        let team = p.eo.team;
        world.ray_cast(
            |store, f, _pt, _n, _frac| {
                if store.fixture(f).is_sensor() {
                    return 1.0;
                }
                let (_, k, bi) = fixture_owner(store, f);
                if k == kind::BODY {
                    let pass = ctx.bodies[bi].eo.def.player_pass;
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
    ctx.players[i].eo.grounded = grounded;
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

/// `_u`: count ray hits around the player: [down, up, right, left].
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
            b.get_world_point(v2(-(p.hu + probe), 0.0)),
            b.get_world_point(v2(p.hu + probe, 0.0)),
            b.get_world_point(v2(0.0, p.eu + probe)),
            b.get_world_point(v2(0.0, -(p.eu + probe))),
        )
    } else {
        (
            v2(pos.x - (p.hu + probe), pos.y),
            v2(pos.x + (p.hu + probe), pos.y),
            v2(pos.x, pos.y + (p.eu + probe)),
            v2(pos.x, pos.y - (p.eu + probe)),
        )
    };
    let origin = v2(p.eo.x, p.eo.y);
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
        if k == kind::BODY && ctx.bodies[bi].eo.def.no_jump {
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

/// `Mu`: jumping (ground, coyote, walls, ceiling, air jump).
fn jump(ctx: &mut Ctx<'_>, world: &mut World, i: usize, input: &Input) {
    let mut input = *input;
    if ctx.players[i].eo.stunned {
        input = Input::default();
    }
    let [down, up, right, left] = contact_rays(ctx, world, i, false);
    let body = player_body(ctx, i);
    let p = &mut ctx.players[i];
    if down > 0 || right > 0 || left > 0 {
        p.eo.air_jump = true;
    }
    if p.eo.coyote > 0.0 {
        p.eo.coyote -= 1.0;
    }
    if down > 0 {
        p.eo.coyote = 4.0;
    }
    let store = world.store_mut();
    if input.up && p.eo.up_held == 0.0 && p.eo.rope.state != ATTACH_ON {
        let b = store.body_mut(body);
        if (down > 0 || p.eo.coyote > 0.0) && up == 0 {
            let c = b.get_world_center();
            b.apply_impulse(v2(0.0, -20.0), c);
            p.jumped = true;
            p.sound_at(store, sound::JUMP, 15.0, 1.0);
            p.eo.coyote = 0.0;
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
            && p.eo.coyote == 0.0
            && up == 0
            && right == 0
            && left == 0
            && !p.jumped
            && p.eo.air_jump
            && b.get_linear_velocity().y > -2.0
        {
            let v = b.get_linear_velocity();
            if v.y > 0.0 {
                b.set_linear_velocity(v2(v.x, 0.0));
            }
            let c = b.get_world_center();
            b.apply_impulse(v2(0.0, -15.0), c);
            p.jumped = true;
            p.eo.air_jump = false;
            // air-jump puff effect (`Eu`) and sound (`Bu`)
            let pos = store.body(body).get_position();
            p.new_effects.push(Effect {
                x: pos.x,
                y: pos.y + 0.8 * js::min(p.eu, p.hu),
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
    !b.eo.def.no_physics && b.eo.def.motion == BODY_DYNAMIC && b.eo.def.source_player == -1.0 && !b.eo.def.ability_immune
}

/// `fu`: force push (hold the push key, drains stamina).
fn force_push(ctx: &mut Ctx<'_>, world: &mut World, i: usize, input: &Input) {
    let gs = ctx.gs;
    {
        let p = &mut ctx.players[i];
        if !input.push {
            p.eo.push_frames = 0.0;
        }
        if !input.push && !input.bat && p.eo.stamina < gs.max_stamina {
            p.eo.stamina += gs.ammo_regen;
            if p.eo.stamina > gs.max_stamina {
                p.eo.stamina = gs.max_stamina;
            }
        }
        if !input.push || input.bat {
            return;
        }
        if p.eo.stamina < gs.push_min_ammo && p.eo.push_frames == 0.0 {
            return;
        }
        if p.eo.stamina <= 0.0 {
            return;
        }
        if p.eo.push_frames == 0.0 {
            p.eo.stamina -= gs.push_first_spend;
        } else {
            p.eo.stamina -= gs.push_spend;
        }
        if p.eo.stamina <= 0.0 {
            p.eo.stamina = 0.0;
        }
        p.eo.push_frames += 1.0;
    }
    let me = player_body(ctx, i);
    let my_id = ctx.players[i].eo.id;
    let my_team = ctx.players[i].eo.team;
    let frames = ctx.players[i].eo.push_frames;
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
        if k == kind::BODY && ctx.bodies[oi].eo.def.source_player != -1.0 {
            continue;
        }
        if k == kind::BODY && ctx.bodies[oi].eo.def.ability_immune {
            continue;
        }
        if !gs.push_players && k == kind::PLAYER {
            continue;
        }
        if k == kind::PLAYER {
            let t = &ctx.players[oi];
            if t.eo.age <= SPAWN_GRACE || t.dashing(gs) || t.same_team(my_team) {
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
                t.eo.attacker = my_id;
                t.eo.attacker_timer = CREDIT_TICKS;
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
            let w = ctx.bodies[oi].eo.push_from.get(pid).copied();
            ctx.bodies[oi].eo.push_from.insert(pid, w.map_or(1.0, |w| w + 1.0));
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

/// `gu`: bat swing (aim during wind-up, hit during the fire window).
fn bat(ctx: &mut Ctx<'_>, world: &mut World, i: usize, input: &Input) {
    let gs = ctx.gs;
    let cone = gs.bat_angle * (std::f64::consts::PI / 180.0);
    let mut hit = false;
    {
        let p = &mut ctx.players[i];
        if p.eo.bat_frame == -1.0 {
            if input.bat && p.eo.stamina > gs.bat_init_cost {
                p.eo.bat_frame += 1.0;
            }
        } else if p.eo.bat_frame < gs.bat_hold_until {
            if input.bat {
                p.eo.bat_frame += 1.0;
            }
            if !input.bat {
                p.eo.bat_frame = -1.0;
            }
        }
        if p.eo.bat_frame == gs.bat_hold_until {
            if input.bat {
                p.eo.stamina = js::max(0.0, p.eo.stamina - gs.bat_hold_cost);
                if p.eo.stamina == 0.0 {
                    p.eo.bat_frame += 1.0;
                }
            } else {
                p.eo.bat_frame += 1.0;
            }
        }
        if p.eo.bat_frame > gs.bat_hold_until {
            p.eo.bat_frame += 1.0;
        }
    }
    let frame = ctx.players[i].eo.bat_frame;
    let me_tag = (kind::PLAYER, i);
    let my_team = ctx.players[i].eo.team;
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
            ctx.players[i].eo.bat_aim = js::qatan2(n.dy, n.dx);
        }
    }
    if frame >= gs.bat_fire_on && frame < gs.bat_fire_on + gs.bat_fire_frames {
        let hits = ctx.players[i].eo.bat_hits.clone();
        let mut cands = Vec::new();
        for bi in 0..ctx.bodies.len() {
            let b = &ctx.bodies[bi];
            if !b.eo.def.no_physics
                && b.eo.def.motion == BODY_DYNAMIC
                && b.eo.def.source_player == -1.0
                && !bat_hit_before(&hits, kind::BODY as f64, b.index as f64)
                && !b.eo.def.ability_immune
            {
                cands.push((kind::BODY, bi));
            }
        }
        for pi in 0..ctx.players.len() {
            let t = &ctx.players[pi];
            if t.eo.age > SPAWN_GRACE
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
        let aim = ctx.players[i].eo.bat_aim;
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
                    ctx.players[i].eo.bat_hits.extend([kind::BODY as f64, b.index as f64]);
                    let w = b.eo.push_from.get(ctx.players[i].index).copied();
                    b.eo.push_from.insert(ctx.players[i].index, w.map_or(1.0, |w| w + 10.0));
                    target_body = bb;
                }
                kind::PROJECTILE => {
                    let q = &mut ctx.projectiles[n.index];
                    if q.eo.owner == my_id {
                        let s = js::max(js::min(gs.rocket_self_bat_scale, 1.0), 0.0);
                        if s == 0.0 {
                            continue;
                        }
                        imp.multiply(s);
                    }
                    q.eo.owner = my_id;
                    q.eo.team = my_team;
                    ctx.players[i].eo.bat_hits.extend([kind::PROJECTILE as f64, q.index as f64]);
                    imp.multiply(0.25);
                    target_body = q.body.expect("projectile body");
                }
                _ => {
                    let t = &mut ctx.players[n.index];
                    t.eo.attacker = my_id;
                    t.eo.attacker_timer = CREDIT_TICKS;
                    let tid = t.id();
                    target_body = t.body.expect("player body");
                    ctx.players[i].eo.bat_hits.extend([kind::PLAYER as f64, tid]);
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
    if p.eo.bat_frame == gs.bat_fire_on {
        p.sound_at(store, sound::BAT_SWING, 15.0, 1.0);
    }
    if p.eo.bat_frame == gs.bat_reset_on {
        p.eo.bat_frame = -1.0;
        p.eo.bat_hits.clear();
    }
    if hit {
        p.sound_at(store, sound::BAT_HIT, 15.0, 1.0);
    }
}

/// `yu`: dash (settings-enabled alternative to grab).
fn dash(ctx: &mut Ctx<'_>, world: &mut World, i: usize, input: &Input) {
    let gs = ctx.gs;
    let body = player_body(ctx, i);
    let p = &mut ctx.players[i];
    if p.eo.dash_frame == -1.0 && input.rocket && p.eo.stamina >= gs.dash_cost {
        p.eo.dash_frame += 1.0;
        p.eo.stamina -= gs.dash_cost;
    } else if p.eo.dash_frame > -1.0 {
        p.eo.dash_frame += 1.0;
    }
    let b = world.store_mut().body_mut(body);
    if p.eo.dash_frame == gs.dash_init_delay {
        let v = b.get_linear_velocity();
        p.eo.dash_speed = v.length();
        let a = js::qatan2(v.y, v.x);
        let dx = js::qcos(a) * gs.dash_boost;
        let dy = js::qsin(a) * gs.dash_boost;
        let mut v = b.get_linear_velocity();
        v.x += dx;
        v.y += dy;
        b.set_linear_velocity(v);
    }
    if p.eo.dash_frame == gs.dash_init_delay + gs.dash_active {
        let v = b.get_linear_velocity();
        let r = v.length() / p.eo.dash_speed;
        if r > 1.0 {
            b.set_linear_velocity(v2(v.x / r, v.y / r));
        }
    }
    if p.eo.dash_frame == gs.dash_init_delay + gs.dash_active + gs.dash_cooldown {
        p.eo.dash_frame = -1.0;
    }
}

/// `bu`: parachute (settings-enabled alternative to grab).
fn parachute(ctx: &mut Ctx<'_>, world: &mut World, i: usize, input: &Input) {
    let held = input.grab;
    {
        let p = &mut ctx.players[i];
        if held && p.eo.parachute.is_none() {
            p.eo.parachute = Some(Parachute {
                x: p.eo.x,
                y: p.eo.y - 0.5,
                vx: p.eo.vx,
                vy: p.eo.vy - 3.0,
                angle: 0.0,
                angular_velocity: 0.0,
                deploy: 4.0,
            });
        }
    }
    let Some(chute) = ctx.players[i].eo.parachute else {
        return;
    };
    if !held {
        ctx.players[i].eo.parachute = None;
        return;
    }
    let body = player_body(ctx, i);
    let (hu, eu) = (ctx.players[i].hu, ctx.players[i].eu);
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
    shape.set_as_box(2.0 * hu, 0.5 * eu);
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
        let mut b = store.body(canopy).get_world_point(v2(2.0 * side * hu, 0.0));
        b.subtract(a);
        let len = b.length();
        if len >= 2.0 {
            let def = DistanceJointDef {
                body_a: body,
                body_b: canopy,
                local_anchor_a: v2(0.0, 0.0),
                local_anchor_b: v2(2.0 * side * hu, 0.0),
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
    let rocket_idle = ctx.players[i].eo.rocket_frame == -1.0;
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

/// `Ru`: local anchor of grab direction `dir` (0..8) on the player box.
fn grab_anchor(dir: usize, outer: bool, hu: f64, eu: f64) -> Vec2 {
    let e = if outer { 1.0 } else { 0.0 };
    let (x, y) = match dir {
        0 => (hu + e, -(eu + e)),
        1 => (hu + e, eu + e),
        2 => (-(hu + e), eu + e),
        3 => (-(hu + e), -(eu + e)),
        4 => (hu + e, 0.0),
        5 => (-(hu + e), 0.0),
        6 => (0.0, eu + e),
        7 => (0.0, -(eu + e)),
        _ => (0.0, 0.0),
    };
    v2(x, y)
}

/// `vu`: grab (8 directional rays attach distance joints to dynamic bodies).
fn grab(ctx: &mut Ctx<'_>, world: &mut World, i: usize, input: &Input) {
    let held = input.grab;
    let body = player_body(ctx, i);
    for dir in 0..8 {
        let mut a = ctx.players[i].eo.grabs[dir];
        if !held && a.state != ATTACH_IDLE {
            a.state = ATTACH_IDLE;
            ctx.players[i].eo.grabs[dir] = a;
        }
        if a.state == ATTACH_ON && a.kind == kind::PLAYER as f64 {
            if let Some(ti) = ctx.player_index(a.target) {
                if ctx.players[ti].eo.age == 0.0 {
                    a = Attach { state: ATTACH_LOST, ..Attach::default() };
                    ctx.players[i].eo.grabs[dir] = a;
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
                ctx.players[i].eo.grabs[dir] = a;
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
                    let (hu, eu) = (ctx.players[i].hu, ctx.players[i].eu);
                    let def = DistanceJointDef {
                        body_a: body,
                        body_b: tb,
                        local_anchor_a: grab_anchor(dir, false, hu, eu),
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
                    ctx.players[i].eo.grabs[dir] = a;
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
        kind::PU => ctx.pu[oi].index as f64,
        _ => f64::NAN,
    }
}

/// `no.Ye` of the owner (objects without it count as not teleported).
fn owner_teleported(ctx: &Ctx<'_>, k: u32, oi: usize) -> bool {
    match k {
        kind::PLAYER => ctx.players[oi].eo.teleported,
        kind::BODY => ctx.bodies[oi].eo.teleported,
        _ => false,
    }
}

/// `Wu`: ray from the centre through grab direction `dir`; nearest
/// non-static, non-sensor map body (that the player collides with).
fn grab_ray(ctx: &Ctx<'_>, world: &World, i: usize, dir: usize) -> Option<(BodyId, Vec2)> {
    let p = &ctx.players[i];
    let body = p.body?;
    let origin = v2(p.eo.x, p.eo.y);
    let end = world.store().body(body).get_world_point(grab_anchor(dir, true, p.hu, p.eu));
    let team = p.eo.team;
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
            let pass = ctx.bodies[bi].eo.def.player_pass;
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
    let team = ctx.players[i].eo.team;
    let mut cands = Vec::new();
    for pi in 0..ctx.players.len() {
        if !ctx.players[pi].same_team(team) {
            cands.push((kind::PLAYER, pi));
        }
    }
    if include_turrets {
        for ti in 0..ctx.turrets.len() {
            let t = &ctx.turrets[ti].eo;
            if !(team == t.team && team > 1.0) {
                cands.push((kind::TURRET, ti));
            }
        }
    }
    let origin = world.store().body(ctx.players[i].body?).get_position();
    let near = sort_near(world.store(), ctx, origin, &cands, (kind::PLAYER, i));
    near.first().map(|n| js::qatan2(n.dy, n.dx))
}

/// `Su`: rocket (charge, steer, fire).
fn rocket(ctx: &mut Ctx<'_>, world: &mut World, i: usize, input: &Input) {
    let gs = ctx.gs;
    let frame = ctx.players[i].eo.rocket_frame;
    let held = input.rocket;
    if held {
        ctx.players[i].su = true;
    }
    if frame == -1.0 && held && ctx.players[i].eo.stamina >= gs.rocket_cost {
        ctx.players[i].eo.rocket_frame = 0.0;
        if let Some(a) = aim_target(ctx, world, i, true) {
            ctx.players[i].eo.gn_set(a);
        }
    }
    if frame > -1.0 && frame < 5.0 {
        if held {
            ctx.players[i].eo.rocket_frame += 1.0;
            if let Some(a) = aim_target(ctx, world, i, true) {
                ctx.players[i].eo.gn_set(a);
            }
        } else {
            ctx.players[i].eo.rocket_frame = -1.0;
        }
        if frame == 4.0 {
            let store = world.store();
            ctx.players[i].sound_at(store, sound::ROCKET_CHARGE, 15.0, 0.2);
        }
    }
    if frame == 5.0 {
        if let Some(a) = aim_target(ctx, world, i, true) {
            ctx.players[i].eo.gn_set(a);
        }
        ctx.players[i].eo.rocket_frame += 1.0;
        ctx.players[i].eo.stamina -= gs.rocket_cost;
    }
    let p = &mut ctx.players[i];
    if frame == 6.0 {
        if input.left {
            p.eo.rocket_aim -= gs.rocket_aim_rate;
        }
        if input.right {
            p.eo.rocket_aim += gs.rocket_aim_rate;
        }
        p.eo.stamina -= gs.ammo_regen;
        if !held {
            p.eo.rocket_frame += 1.0;
        }
    }
    if frame > 6.0 && frame < 8.0 {
        p.eo.rocket_frame += 1.0;
    }
    if frame == 8.0 {
        let pos = world.store().body(p.body.expect("player body")).get_position();
        let c = js::qcos(p.eo.rocket_aim);
        let s = js::qsin(p.eo.rocket_aim);
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
            team: p.eo.team,
            damage: 999.0,
            object_damage: 40.0,
            align: true,
            ..Projectile::default()
        });
        p.eo.rocket_frame = -1.0;
        let store = world.store();
        p.sound_at(store, sound::ROCKET_FIRE, 15.0, 0.4);
    }
}

impl Player {
    #[inline]
    fn gn_set(&mut self, a: f64) {
        self.rocket_aim = a;
    }
}

/// `ku`: egg throw (settings-enabled alternative to the rocket).
fn egg(ctx: &mut Ctx<'_>, world: &mut World, i: usize, input: &Input) {
    let gs = ctx.gs;
    let mut frame = ctx.players[i].eo.egg_frame;
    let held = input.rocket;
    let aim = |ctx: &mut Ctx<'_>, world: &World| {
        if let Some(a) = aim_target(ctx, world, i, false) {
            ctx.players[i].eo.egg_aim = a;
        }
    };
    let throw = |ctx: &mut Ctx<'_>, world: &World, power: f64| {
        let p = &mut ctx.players[i];
        let a = p.eo.egg_aim;
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
            team: p.eo.team,
            damage: 999.0,
            align: false,
            angular_velocity: vx * gs.egg_spin,
            explode_damage: true,
            ..Projectile::default()
        });
    };
    if held {
        ctx.players[i].su = true;
        if frame == 0.0 && ctx.players[i].eo.stamina >= gs.egg_cost {
            frame += 1.0;
            aim(ctx, world);
        } else if frame == gs.egg_delay1 {
            frame += 1.0;
            ctx.players[i].eo.stamina -= gs.egg_cost;
        } else if frame > 0.0 {
            frame += 1.0;
            let p = &mut ctx.players[i];
            p.eo.stamina -= gs.ammo_regen;
            if frame > gs.egg_delay2 + gs.egg_delay_ammo {
                p.eo.stamina = js::max(0.0, p.eo.stamina - 1.0);
            }
            if input.left {
                p.eo.egg_aim -= gs.egg_aim_rate;
            } else if input.right {
                p.eo.egg_aim += gs.egg_aim_rate;
            }
            if p.eo.stamina == 0.0 {
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
    ctx.players[i].eo.egg_frame = frame;
}

/// `Cu`: ghosts float (cancel gravity).
fn ghost_float(ctx: &mut Ctx<'_>, world: &mut World, i: usize) {
    let body = player_body(ctx, i);
    let g = world.get_gravity().y;
    let store = world.store_mut();
    let mut f = v2(0.0, -g);
    f.multiply(store.body(body).get_mass());
    let c = store.body(body).get_world_center();
    store.body_mut(body).apply_force(f, c);
}

/// `Tu`: ghost movement and ghost rockets.
fn ghost_move(ctx: &mut Ctx<'_>, world: &mut World, i: usize, input: &Input) {
    let gs = ctx.gs;
    let body = player_body(ctx, i);
    let p = &mut ctx.players[i];
    p.eo.rocket_frame = -1.0;
    p.eo.bat_frame = -1.0;
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
    if input.rocket && p.eo.stamina >= 100.0 {
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
            team: p.eo.team,
            damage: 999.0,
            object_damage: 40.0,
            align: true,
            ..Projectile::default()
        });
        p.eo.stamina -= 100.0;
        p.new_sounds.push(Sound { x: pos.x, y: pos.y, ttl: 15.0, kind: sound::ROCKET_FIRE, player: p.id(), volume: 0.3, effect_row: false });
    } else {
        p.eo.stamina += gs.ghost_regen;
        if p.eo.stamina > gs.max_stamina {
            p.eo.stamina = gs.max_stamina;
        }
    }
    if p.eo.age % 3.0 == 0.0 {
        p.new_sounds.push(Sound { x: pos.x, y: pos.y, ttl: 5.0, kind: sound::GHOST_TRAIL, player: p.id(), volume: 1.0, effect_row: false });
    }
}

/// `wl` (BeginContact) for a player.
pub(crate) fn begin_contact(ctx: &mut Ctx<'_>, store: &mut Store, i: usize, other: BodyId, c: ContactId) {
    let gs = ctx.gs;
    let (k, oi) = crate::step::body_tag(store, other);
    if k == kind::BODY {
        let def = ctx.bodies[oi].eo.def.clone();
        let p = &mut ctx.players[i];
        if def.player_pass == 1.0 || def.player_pass == p.eo.team {
            store.contact_mut(c).set_enabled(false);
        }
        if def.kill_players && p.eo.age > 10.0 {
            p.damage(999.0);
        }
        if def.freeze_players {
            if p.eo.freeze_ready {
                p.sound_at(store, sound::FREEZE, 30.0, 0.6);
                p.eo.frozen = 33.0;
                p.eo.freeze_ready = false;
            }
            p.froze = true;
        }
        if def.motion == BODY_DYNAMIC {
            ctx.bodies[oi].player_touch = true;
        }
    }
    if k == kind::PLAYER {
        let my_age = ctx.players[i].eo.age;
        let my_team = ctx.players[i].eo.team;
        let o = &ctx.players[oi];
        if my_age > SPAWN_GRACE && o.eo.age > SPAWN_GRACE && !o.same_team(my_team) {
            let me = player_body(ctx, i);
            let mut d = store.body(other).get_position();
            d.subtract(store.body(me).get_position());
            let angle = js::qatan2(d.y, d.x) * (180.0 / std::f64::consts::PI);
            let other_vy = store.body(other).get_linear_velocity().y;
            let rel = other_vy - store.body(me).get_linear_velocity().y;
            let other_id = o.id();
            if angle > -140.0 && angle < -40.0 && rel > 5.0 && !ctx.players[i].dashing(gs) {
                let p = &mut ctx.players[i];
                p.dead = true;
                p.gone = true;
                p.eo.attacker = other_id;
                p.eo.attacker_timer = CREDIT_TICKS;
                let v = store.body(me).get_linear_velocity();
                store.body_mut(me).set_linear_velocity(v2(v.x, other_vy + 3.0));
            }
        }
    }
}

/// `yl` (PostSolve) for a player.
pub(crate) fn post_solve(ctx: &mut Ctx<'_>, store: &mut Store, i: usize, other: BodyId, impulse: &ContactImpulse) {
    let n0 = impulse.normal_impulses[0];
    {
        let p = &mut ctx.players[i];
        if n0 > 50.0 && p.eo.age > SPAWN_GRACE {
            p.gone = true;
            p.dead = true;
        }
    }
    let (k, oi) = crate::step::body_tag(store, other);
    if k == kind::BODY {
        let mut best = -1.0;
        let mut top = 0.0;
        for (pid, w) in ctx.bodies[oi].eo.push_from.iter() {
            if *w > top {
                best = pid as f64;
                top = *w;
            }
        }
        if best != -1.0 {
            let p = &mut ctx.players[i];
            p.eo.attacker = best;
            p.eo.attacker_timer = CREDIT_TICKS;
        }
    }
    let body = player_body(ctx, i);
    let per_mass = n0 / store.body(body).get_mass();
    if per_mass > 1.0 && !ctx.players[i].grabbed.contains(&other) {
        let kind_ = if k == kind::BODY && ctx.bodies[oi].eo.def.no_jump { sound::IMPACT_NOJUMP } else { sound::IMPACT };
        let p = &mut ctx.players[i];
        let vol = 0.025 * per_mass * p.limiter.request();
        p.sound_at(store, kind_, 10.0, vol);
    }
}

/// `ro`: edge wrapping, death, kill credit.
pub(crate) fn post_step(ctx: &mut Ctx<'_>, world: &mut World, i: usize) {
    let gs = ctx.gs;
    let body = player_body(ctx, i);
    if !ctx.players[i].froze && !ctx.players[i].eo.freeze_ready {
        ctx.players[i].eo.freeze_ready = true;
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
            p.eo.teleported = true;
        } else if pos.y < 0.0 - half {
            pos.y += ah + 2.0 * half;
            p.eo.teleported = true;
        }
        if pos.x > aw + half {
            pos.x -= aw + 2.0 * half;
            vel.x += 5.0;
            p.eo.teleported = true;
        } else if pos.x < 0.0 - half {
            pos.x += aw + 2.0 * half;
            vel.x -= 5.0;
            p.eo.teleported = true;
        }
        world.set_position(body, pos);
        world.store_mut().body_mut(body).set_linear_velocity(vel);
    }
    let y = world.store().body(body).get_position().y;
    let p = &mut ctx.players[i];
    if p.eo.health <= 0.0 || (!wrap && y > ah + p.eu) {
        p.dead = true;
        p.xl = true;
    }
    if ctx.players[i].dead {
        let me = ctx.players[i].id();
        let attacker = ctx.players[i].eo.attacker;
        if ctx.players[i].eo.attacker_timer > 0.0 && attacker != me {
            crate::round::kill(ctx, attacker, me);
            if let Some(ai) = ctx.player_index(attacker) {
                let a = &mut ctx.players[ai];
                a.eo.kills += 1.0;
                if a.eo.kills == gs.ghost_after {
                    a.eo.ghost = true;
                }
            }
        } else {
            crate::round::suicide(ctx, me);
        }
        crate::round::respawn_in(ctx, me, 60.0);
        ctx.players[i].gone = true;
    }
}

/// `lo`: write the player into the next state (or leave debris when dead).
pub(crate) fn serialize(ctx: &mut Ctx<'_>, world: &mut World, i: usize, next: &mut State) {
    let body = player_body(ctx, i);
    let chute = ctx.players[i].chute;
    {
        let p = &mut ctx.players[i];
        let store = world.store();
        if p.gone {
            if p.dead {
                debris(p, store, next);
                let pos = store.body(body).get_position();
                p.new_sounds.push(Sound { x: pos.x, y: pos.y, ttl: 5.0, kind: sound::DEATH, player: p.id(), volume: 0.23, effect_row: false });
            }
        } else if !p.dead {
            let b = store.body(body);
            let pos = b.get_position();
            let vel = b.get_linear_velocity();
            p.eo.x = pos.x;
            p.eo.y = pos.y;
            p.eo.angle = b.get_angle();
            p.eo.angular_velocity = b.get_angular_velocity();
            p.eo.vx = vel.x;
            p.eo.vy = vel.y;
            p.eo.age += 1.0;
            if let (Some(pc), Some(cb)) = (p.eo.parachute.as_mut(), chute) {
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
            p.eo.sound_limiter = p.limiter.value();
            next.players.insert(p.index, p.eo.clone());
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

/// `ru`: split the dead player's box into two dynamic debris halves.
fn debris(p: &mut PlayerObj, store: &Store, next: &mut State) {
    let h = p.hu;
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
        if p.xl {
            let over = vy - 10.0;
            if over > 0.0 {
                vy = 10.0 + over / 4.0;
            }
            vy *= -1.0;
        }
        let shape = MapShape {
            kind: crate::map::SHAPE_POLYGON,
            color: p.eo.team,
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
