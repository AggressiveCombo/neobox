//! Map bodies, joints, projectiles, turrets, capture points and the unused
//! `pu` bucket.

use crate::js;
use crate::map::{BodyDef, MapCap, MapJoint, MapShape, MapTurret, BODY_DYNAMIC, BODY_KINEMATIC, BODY_STATIC, SHAPE_CIRCLE, SHAPE_POLYGON};
use crate::player::Limiter;
use crate::state::*;
use crate::step::{body_tag, effect, kind, sort_near, sound, tag, v2, Ctx};
use neobox_box2d::dynamics::joints::{self, PrismaticJoint};
use neobox_box2d::math::Vec2;
use neobox_box2d::{
    BodyDef as B2BodyDef, BodyId, BodyType, CircleShape, ContactId, ContactImpulse, DistanceJointDef, FixtureDef, Joint,
    JointDef, JointId, PolygonShape, PrismaticJointDef, RevoluteJointDef, Shape, Store, World, AABB,
};

/// Projectile shapes.
pub const PROJ_ROUND: f64 = 0.0;
pub const PROJ_ROCKET: f64 = 1.0;
pub const PROJ_CAPSULE: f64 = 2.0;

/// Joint kinds and motor modes.
pub const JOINT_DISTANCE: f64 = 0.0;
pub const JOINT_REVOLUTE: f64 = 1.0;
pub const JOINT_PRISMATIC: f64 = 2.0;
pub const MOTOR_NONE: f64 = 0.0;
pub const MOTOR_STOP: f64 = 1.0;
pub const MOTOR_PING_PONG: f64 = 2.0;
pub const MOTOR_LATCH: f64 = 3.0;
/// Revolute joints enable their motor when the mode equals this value.
pub const REVOLUTE_MOTOR_ON: f64 = 1.0;

/// Collision categories of the four body groups "a".."d".
const GROUP_A: u16 = 8;
const GROUP_B: u16 = 16;
const GROUP_C: u16 = 32;
const GROUP_D: u16 = 64;

// ------------------------------------------------------------------ bodies

pub(crate) struct BodyObj {
    pub index: u32,
    pub eo: Body,
    pub body: Option<BodyId>,
    /// `el` removed this tick
    pub removed: bool,
    /// `ol` impact sounds this tick
    pub impacts: u32,
    /// `rl` objective delivered for team (-1 none)
    pub objective: f64,
    /// `al` touched by a player (releases latched joints)
    pub player_touch: bool,
    /// `Tr` a race object touched its next checkpoint this tick
    pub race_passed: bool,
    pub new_sounds: Vec<Sound>,
    pub limiter: Limiter,
}

impl BodyObj {
    pub fn new(index: u32, mut eo: Body) -> BodyObj {
        eo.teleported = false;
        let limiter = Limiter::new(eo.sound_limiter, 1.0, 0.1, 0.4);
        BodyObj {
            index,
            eo,
            body: None,
            removed: false,
            impacts: 0,
            objective: -1.0,
            player_touch: false,
            race_passed: false,
            new_sounds: Vec::new(),
            limiter,
        }
    }
}

impl BodyDef {
    /// The physics shapes of `shapes` (`None` where a row creates no fixture), built once per definition.
    pub(crate) fn physics_shapes(&self) -> &[Option<Shape>] {
        self.physics.0.get_or_init(|| self.shapes.iter().map(physics_shape).collect())
    }
}

/// The physics shape of one map shape row; `None` where the row creates no fixture.
fn physics_shape(s: &MapShape) -> Option<Shape> {
    if s.no_physics {
        return None;
    }
    if s.kind == SHAPE_CIRCLE {
        let mut c = CircleShape::new(s.radius);
        c.set_local_position(v2(s.x, s.y));
        Some(Shape::Circle(c))
    } else if s.kind == SHAPE_POLYGON {
        if !s.closed || s.points.len() <= 2 {
            return None;
        }
        let pts: Vec<Vec2> = s.points.iter().map(|p| v2(p[0] + s.x, p[1] + s.y)).collect();
        let mut p = PolygonShape::new();
        p.set_as_array(&pts, pts.len());
        Some(Shape::Polygon(p))
    } else {
        // the original would throw creating a fixture without a shape
        None
    }
}

/// `oo` for a map body.
pub(crate) fn body_create(ctx: &mut Ctx<'_>, world: &mut World, i: usize) {
    let o = &mut ctx.bodies[i];
    let def = o.eo.def.clone();
    if def.no_physics {
        if def.motion == BODY_KINEMATIC {
            o.eo.x += o.eo.vx / 30.0;
            o.eo.y += o.eo.vy / 30.0;
        }
        return;
    }
    let mut bd = B2BodyDef::default();
    if def.motion == BODY_STATIC {
        bd.body_type = BodyType::Static;
    } else if def.motion == BODY_KINEMATIC {
        bd.body_type = BodyType::Kinematic;
    } else if def.motion == BODY_DYNAMIC {
        bd.body_type = BodyType::Dynamic;
    }
    bd.position = v2(o.eo.x, o.eo.y);
    bd.angle = o.eo.angle;
    bd.angular_velocity = o.eo.angular_velocity;
    bd.fixed_rotation = def.fixed_rotation;
    bd.linear_damping = def.linear_damping;
    bd.angular_damping = def.angular_damping;
    bd.bullet = def.bullet;
    bd.user_data = tag(kind::BODY, i);
    let body = world.create_body(&bd);
    o.body = Some(body);
    let shapes = def.physics_shapes();
    for (s, shape) in def.shapes.iter().zip(shapes) {
        let Some(shape) = shape else {
            continue;
        };
        let mut fd = FixtureDef::new(shape.clone());
        fd.density = s.density.unwrap_or(def.density);
        fd.friction = s.friction.unwrap_or(def.friction);
        fd.restitution = s.restitution.unwrap_or(def.restitution);
        if def.zone_x != 0.0 || def.zone_y != 0.0 {
            fd.is_sensor = true;
        }
        if def.freeze_players || def.objective_target > 0.0 {
            fd.is_sensor = true;
        }
        match def.group.as_str() {
            Some("a") => fd.filter.category_bits = GROUP_A,
            Some("b") => fd.filter.category_bits = GROUP_B,
            Some("c") => fd.filter.category_bits = GROUP_C,
            Some("d") => fd.filter.category_bits = GROUP_D,
            _ => {}
        }
        if !def.collide_a {
            fd.filter.mask_bits -= GROUP_A;
        }
        if !def.collide_b {
            fd.filter.mask_bits -= GROUP_B;
        }
        if !def.collide_c {
            fd.filter.mask_bits -= GROUP_C;
        }
        if !def.collide_d {
            fd.filter.mask_bits -= GROUP_D;
        }
        if def.player_pass == 1.0 {
            fd.filter.mask_bits -= crate::player::CATEGORY;
        }
        world.create_fixture(body, &fd);
    }
    let store = world.store_mut();
    store.body_mut(body).set_linear_velocity(v2(o.eo.vx, o.eo.vy));
    if def.pinned {
        let anchor = v2(def.pin_x, def.pin_y);
        let wp = store.body(body).get_world_point(anchor);
        let jd = RevoluteJointDef {
            body_a: body,
            body_b: world.get_ground_body(),
            local_anchor_a: anchor,
            local_anchor_b: wp,
            enable_limit: false,
            lower_angle: 0.0,
            upper_angle: 0.0,
            enable_motor: false,
            motor_speed: 0.0,
            max_motor_torque: 0.0,
            collide_connected: false,
            ..RevoluteJointDef::default()
        };
        world.create_joint(&JointDef::Revolute(jd));
    }
    let store = world.store_mut();
    let b = store.body_mut(body);
    let mut f = v2(def.force_x, def.force_y);
    f.multiply(b.get_mass());
    let c = b.get_world_center();
    b.apply_force(f, c);
    let m = b.get_mass();
    b.apply_torque(def.torque * m);
    if def.wrap {
        body_wrap(ctx, world, i);
    }
}

/// `dl`: wrap a body around the arena when its bounds leave it entirely.
fn body_wrap(ctx: &mut Ctx<'_>, world: &mut World, i: usize) {
    let w = ctx.prev_settings.width;
    let h = ctx.prev_settings.height;
    let o = &mut ctx.bodies[i];
    let body = o.body.expect("body");
    let store = world.store();
    let mut aabb = AABB { lower_bound: v2(f64::MAX, f64::MAX), upper_bound: v2(-f64::MAX, -f64::MAX) };
    for f in store.body(body).iter_fixtures() {
        let fa = store.fixture(f).get_aabb();
        aabb = AABB::combine(&aabb, &fa);
    }
    let dx = w + (aabb.upper_bound.x - aabb.lower_bound.x);
    let dy = h + (aabb.upper_bound.y - aabb.lower_bound.y);
    // b2Body.SetPosition (moves the fixtures in the broadphase too)
    let shift_x = |world: &mut World, by: f64| {
        let p = world.store().body(body).get_position();
        world.set_position(body, v2(p.x + by, p.y));
    };
    let shift_y = |world: &mut World, by: f64| {
        let p = world.store().body(body).get_position();
        world.set_position(body, v2(p.x, p.y + by));
    };
    if aabb.upper_bound.x < 0.0 {
        shift_x(world, dx);
        o.eo.teleported = true;
    }
    if aabb.lower_bound.x > w {
        shift_x(world, -dx);
        o.eo.teleported = true;
    }
    if aabb.upper_bound.y < 0.0 {
        shift_y(world, dy);
        o.eo.teleported = true;
    }
    if aabb.lower_bound.y > h {
        shift_y(world, -dy);
        o.eo.teleported = true;
    }
}

/// `ao`: push attribution decays.
pub(crate) fn body_pre_step(o: &mut BodyObj) {
    o.eo.push_from.retain(|_, w| {
        *w *= 0.985;
        !(*w < 0.8)
    });
}

/// `ro`: lifetime, objective delivery, latch release.
pub(crate) fn body_post_step(ctx: &mut Ctx<'_>, i: usize) {
    let o = &mut ctx.bodies[i];
    if o.eo.lifetime > 0.0 {
        o.eo.lifetime -= 1.0;
        if o.eo.lifetime == 0.0 {
            o.removed = true;
        }
    }
    let objective = o.objective;
    let touch = o.player_touch;
    let id = o.index as f64;
    if objective != -1.0 {
        crate::round::objective(ctx, objective);
    }
    if touch {
        for j in ctx.joints.iter_mut() {
            if j.eo.body_b == id && j.eo.motor_mode == MOTOR_LATCH && j.eo.latched {
                j.eo.latched = false;
            }
        }
    }
}

/// `wl` for a map body.
pub(crate) fn body_begin_contact(ctx: &mut Ctx<'_>, store: &mut Store, i: usize, other: BodyId, c: ContactId) {
    let def = ctx.bodies[i].eo.def.clone();
    let (k, oi) = body_tag(store, other);
    if def.zone_x != 0.0 || def.zone_y != 0.0 {
        // force zone
        let mut f = v2(def.zone_x, def.zone_y);
        if k == kind::PROJECTILE {
            f.multiply(0.3);
        }
        let center = store.body(other).get_world_center();
        store.body_mut(other).apply_force(f, center);
    } else if k == kind::PROJECTILE {
        let team = ctx.projectiles[oi].eo.team;
        if def.projectile_pass == 1.0 || def.projectile_pass == team {
            store.contact_mut(c).set_enabled(false);
        } else {
            // `fl`: projectile damage
            let dmg = ctx.projectiles[oi].eo.object_damage;
            let o = &mut ctx.bodies[i];
            o.eo.damage += dmg;
            // the heav.io builds turned the body dynamic here; today's
            // original throws instead (its definition is frozen)
            if o.eo.damage >= def.dynamic_threshold && def.dynamic_threshold > 0.0 && def.motion != BODY_DYNAMIC {
                let mut d = (*o.eo.def).clone();
                d.motion = BODY_DYNAMIC;
                o.eo.def = std::sync::Arc::new(d);
            }
            if o.eo.damage >= def.removal_threshold && def.removal_threshold > 0.0 {
                o.removed = true;
            }
        }
    } else if def.objective > 0.0 && k == kind::BODY {
        let target = ctx.bodies[oi].eo.def.objective_target;
        let o = &mut ctx.bodies[i];
        if (def.objective == 1.0 || def.objective == 2.0) && target == 2.0 {
            o.objective = 2.0;
        }
        if (def.objective == 1.0 || def.objective == 3.0) && target == 3.0 {
            o.objective = 3.0;
        }
    } else {
        crate::race::object_touch(ctx, i, k, oi);
    }
    // race checkpoints let everything through on the first contact tick
    if def.checkpoint > 0.0 {
        store.contact_mut(c).set_enabled(false);
    }
}

/// `yl` for a map body: impact sounds.
pub(crate) fn body_post_solve(ctx: &mut Ctx<'_>, store: &mut Store, i: usize, impulse: &ContactImpulse) {
    let o = &mut ctx.bodies[i];
    if o.eo.def.motion != BODY_DYNAMIC || o.eo.def.source_player > -1.0 {
        return;
    }
    let body = o.body.expect("body");
    let per_mass = impulse.normal_impulses[0] / store.body(body).get_mass();
    if per_mass > 5.0 && o.impacts <= 3 {
        let pos = store.body(body).get_position();
        let volume = 0.008 * per_mass * o.limiter.request();
        o.new_sounds.push(Sound { x: pos.x, y: pos.y, ttl: 5.0, kind: sound::BODY_IMPACT, player: o.index as f64, volume, effect_row: false });
        o.impacts += 1;
    }
}

/// `lo` for a map body.
pub(crate) fn body_serialize(ctx: &mut Ctx<'_>, world: &World, i: usize, next: &mut State) {
    let o = &mut ctx.bodies[i];
    if o.removed {
        return;
    }
    if !o.eo.def.no_physics {
        let b = world.store().body(o.body.expect("body"));
        let p = b.get_position();
        let v = b.get_linear_velocity();
        o.eo.x = p.x;
        o.eo.y = p.y;
        o.eo.angle = b.get_angle();
        o.eo.angular_velocity = b.get_angular_velocity();
        o.eo.vx = v.x;
        o.eo.vy = v.y;
        o.eo.sound_limiter = o.limiter.value();
    }
    next.bodies.insert(o.eo.def.id, o.eo.clone());
    next.sounds.append(&mut o.new_sounds);
}

// ------------------------------------------------------------------ joints

pub(crate) struct JointObj {
    pub index: u32,
    pub eo: MapJoint,
    /// prismatic joint handle and its moving body
    pub prismatic: Option<(JointId, BodyId)>,
}

impl JointObj {
    pub fn new(index: u32, eo: MapJoint) -> JointObj {
        JointObj { index, eo, prismatic: None }
    }
}

/// `ao` for a joint: create it in the world.
pub(crate) fn joint_create(ctx: &mut Ctx<'_>, world: &mut World, i: usize) {
    let j = ctx.joints[i].eo.clone();
    let body_of = |ctx: &Ctx<'_>, id: f64| ctx.body_index(id).map(|bi| ctx.bodies[bi].body);
    let mut a_obj = body_of(ctx, j.body_a);
    let b_obj = body_of(ctx, j.body_b);
    if j.player_a > -1.0 {
        if let Some(pi) = ctx.player_index(j.player_a) {
            a_obj = Some(ctx.players[pi].body);
        }
    }
    let ground = world.get_ground_body();
    let (a, b) = if j.kind == JOINT_PRISMATIC {
        (Some(ground), b_obj.flatten())
    } else {
        let a = if j.body_a == -1.0 {
            Some(ground)
        } else {
            match a_obj {
                Some(a) => a,
                None => return,
            }
        };
        match b_obj {
            Some(b) => (a, b),
            None => return,
        }
    };
    let (Some(a), Some(b)) = (a, b) else { return };
    if a == b {
        return;
    }
    if j.kind == JOINT_DISTANCE {
        let d = DistanceJointDef {
            body_a: a,
            body_b: b,
            local_anchor_a: v2(j.ax, j.ay),
            local_anchor_b: v2(j.bx, j.by),
            length: j.length,
            frequency_hz: j.frequency,
            damping_ratio: j.damping,
            collide_connected: j.collide_connected,
            ..DistanceJointDef::default()
        };
        world.create_joint(&JointDef::Distance(d));
    }
    if j.kind == JOINT_REVOLUTE {
        let d = RevoluteJointDef {
            body_a: a,
            body_b: b,
            local_anchor_a: v2(j.ax, j.ay),
            local_anchor_b: v2(j.bx, j.by),
            collide_connected: j.collide_connected,
            enable_motor: j.motor_mode == REVOLUTE_MOTOR_ON,
            motor_speed: j.motor_speed,
            max_motor_torque: j.max_motor,
            ..RevoluteJointDef::default()
        };
        world.create_joint(&JointDef::Revolute(d));
    }
    if j.kind == JOINT_PRISMATIC {
        neobox_box2d::dynamics::body::set_fixed_rotation(world.store_mut(), b, false);
        let mut axis = v2(j.axis_x - j.ax, j.axis_y - j.ay);
        axis.normalize();
        let dx = j.axis_x - j.ax;
        let dy = j.axis_y - j.ay;
        let upper = (dx * dx + dy * dy).sqrt();
        let d = PrismaticJointDef {
            body_a: a,
            body_b: b,
            local_anchor_a: v2(j.ax, j.ay),
            local_anchor_b: v2(j.bx, j.by),
            local_axis_a: axis,
            enable_limit: true,
            lower_translation: 0.0,
            upper_translation: upper,
            reference_angle: world.store().body(b).get_angle(),
            enable_motor: j.motor_mode != MOTOR_NONE,
            motor_speed: j.motor_speed,
            max_motor_force: j.max_motor,
            collide_connected: j.collide_connected,
            ..PrismaticJointDef::default()
        };
        let lower = d.lower_translation;
        let id = world.create_joint(&JointDef::Prismatic(d));
        ctx.joints[i].prismatic = Some((id, b));
        let store = world.store_mut();
        let t = prismatic(store, id).get_joint_translation(store);
        let at_lower = t - lower < 0.1;
        let at_upper = upper - t < 0.1;
        let eo = &mut ctx.joints[i].eo;
        if eo.motor_mode == MOTOR_STOP {
            if (eo.motor_speed < 0.0 && at_lower) || (eo.motor_speed > 0.0 && at_upper) {
                // box2dweb's setters wake both bodies first
                joints::wake_bodies(store, id);
                prismatic_mut(store, id).set_motor_speed(0.0);
            }
        } else if eo.motor_mode == MOTOR_PING_PONG || eo.motor_mode == MOTOR_LATCH {
            let before = eo.motor_speed;
            if at_lower {
                eo.motor_speed = eo.motor_speed.abs();
            }
            if at_upper {
                eo.motor_speed = -eo.motor_speed.abs();
            }
            joints::wake_bodies(store, id);
            prismatic_mut(store, id).set_motor_speed(eo.motor_speed);
            if eo.motor_mode == MOTOR_LATCH {
                if at_lower && before < 0.0 {
                    eo.latched = true;
                }
                if eo.latched {
                    joints::wake_bodies(store, id);
                    prismatic_mut(store, id).set_motor_speed(0.0);
                    joints::wake_bodies(store, id);
                    prismatic_mut(store, id).set_max_motor_force(99999.0);
                }
            }
        }
    }
}

fn prismatic(store: &Store, id: JointId) -> &PrismaticJoint {
    match store.joint(id) {
        Joint::Prismatic(p) => p,
        _ => unreachable!("joint {id:?} is prismatic"),
    }
}

fn prismatic_mut(store: &mut Store, id: JointId) -> &mut PrismaticJoint {
    match store.joint_mut(id) {
        Joint::Prismatic(p) => p,
        _ => unreachable!("joint {id:?} is prismatic"),
    }
}

/// `ro` for a joint: prismatic bodies stop at their limits.
pub(crate) fn joint_post_step(ctx: &mut Ctx<'_>, world: &mut World, i: usize) {
    if ctx.joints[i].eo.kind != JOINT_PRISMATIC {
        return;
    }
    let Some((id, body)) = ctx.joints[i].prismatic else { return };
    let store = world.store_mut();
    let j = prismatic(store, id);
    let t = j.get_joint_translation(store);
    let low = t - j.get_lower_limit() < 0.1;
    let high = j.get_upper_limit() - t < 0.1;
    if low || high {
        store.body_mut(body).set_linear_velocity(v2(0.0, 0.0));
    }
}

// ------------------------------------------------------------------ projectiles

pub(crate) struct ProjObj {
    pub index: u32,
    pub eo: Projectile,
    pub body: Option<BodyId>,
    /// `el` terminated by a hit
    pub terminated: bool,
    /// `Ul` hit point (explosion centre)
    pub hit_point: Option<Vec2>,
    pub new_effects: Vec<Effect>,
    pub new_sounds: Vec<Sound>,
}

impl ProjObj {
    pub fn new(index: u32, eo: Projectile) -> ProjObj {
        ProjObj { index, eo, body: None, terminated: false, hit_point: None, new_effects: Vec::new(), new_sounds: Vec::new() }
    }
}

pub(crate) fn projectile_create(ctx: &mut Ctx<'_>, world: &mut World, i: usize) {
    let o = &mut ctx.projectiles[i];
    let e = &o.eo;
    let mut bd = B2BodyDef::default();
    bd.body_type = BodyType::Dynamic;
    bd.position = v2(e.x, e.y);
    if e.align {
        bd.angle = js::qatan2(e.vy, e.vx);
    } else {
        bd.angle = e.angle;
        bd.angular_velocity = e.angular_velocity;
    }
    bd.fixed_rotation = false;
    bd.linear_damping = e.linear_damping;
    bd.bullet = true;
    bd.user_data = tag(kind::PROJECTILE, i);
    let body = world.create_body(&bd);
    o.body = Some(body);
    let mut shapes: Vec<Shape> = Vec::new();
    if e.shape == PROJ_ROUND {
        shapes.push(Shape::Circle(CircleShape::new(e.size)));
    } else if e.shape == PROJ_ROCKET {
        let mut p = PolygonShape::new();
        p.set_as_box(2.5 * e.size, e.size);
        shapes.push(Shape::Polygon(p));
    } else if e.shape == PROJ_CAPSULE {
        let mut p = PolygonShape::new();
        p.set_as_box(1.5 * e.size, e.size);
        shapes.push(Shape::Polygon(p));
        let mut c1 = CircleShape::new(e.size);
        c1.set_local_position(v2(1.5 * -e.size, 0.0));
        shapes.push(Shape::Circle(c1));
        let mut c2 = CircleShape::new(e.size);
        c2.set_local_position(v2(1.5 * e.size, 0.0));
        shapes.push(Shape::Circle(c2));
    }
    for s in shapes {
        let mut fd = FixtureDef::new(s);
        fd.density = e.density;
        fd.friction = e.friction;
        fd.restitution = e.restitution;
        world.create_fixture(body, &fd);
    }
    let g = world.get_gravity().y;
    let store = world.store_mut();
    let b = store.body_mut(body);
    b.set_linear_velocity(v2(e.vx, e.vy));
    let mass = b.get_mass_data().mass;
    let anti = (1.0 - e.gravity_scale) * g;
    let c = b.get_world_center();
    b.apply_force(v2(0.0, -anti * mass), c);
}

/// `ao`: homing.
pub(crate) fn projectile_pre_step(ctx: &mut Ctx<'_>, world: &mut World, i: usize) {
    let turn = ctx.projectiles[i].eo.turn_rate;
    if !(turn > 0.0) {
        return;
    }
    let team = ctx.projectiles[i].eo.team;
    let owner = ctx.player_index(ctx.projectiles[i].eo.owner);
    let mut cands = Vec::new();
    for pi in 0..ctx.players.len() {
        cands.push((kind::PLAYER, pi));
    }
    for ti in 0..ctx.turrets.len() {
        cands.push((kind::TURRET, ti));
    }
    let body = ctx.projectiles[i].body.expect("projectile body");
    let origin = world.store().body(body).get_position();
    let near = sort_near(world.store(), ctx, origin, &cands, (kind::PROJECTILE, i));
    let mut target = None;
    for n in near {
        let t_team = match n.kind {
            kind::PLAYER => ctx.players[n.index].eo.team,
            _ => ctx.turrets[n.index].eo.team,
        };
        let same = t_team == team && team > 1.0;
        let is_owner = n.kind == kind::PLAYER && Some(n.index) == owner;
        if !is_owner && !same {
            target = Some(n);
            break;
        }
    }
    let Some(t) = target else { return };
    let tb = match t.kind {
        kind::PLAYER => ctx.players[t.index].body,
        _ => ctx.turrets[t.index].body,
    }
    .expect("target body");
    let store = world.store_mut();
    let mut d = store.body(tb).get_position();
    d.subtract(store.body(body).get_position());
    let want = js::qatan2(d.y, d.x);
    let v = store.body(body).get_linear_velocity();
    let cur = js::qatan2(v.y, v.x);
    let speed = v.length();
    let two_pi = 2.0 * std::f64::consts::PI;
    let ccw = (cur - want + two_pi) % two_pi > std::f64::consts::PI;
    let a = if ccw { cur + turn } else { cur - turn };
    store.body_mut(body).set_linear_velocity(v2(js::qcos(a) * speed, js::qsin(a) * speed));
}

/// `ro`: age and explode.
pub(crate) fn projectile_post_step(ctx: &mut Ctx<'_>, world: &mut World, i: usize) {
    let o = &mut ctx.projectiles[i];
    o.eo.life -= 1.0;
    if (o.terminated || o.eo.life == 0.0) && o.eo.explode_radius > 0.0 {
        explode(ctx, world, i);
    }
}

/// `Jl`: explosion impulse (and optional damage) around the projectile.
fn explode(ctx: &mut Ctx<'_>, world: &mut World, i: usize) {
    let gs = ctx.gs;
    let body = ctx.projectiles[i].body.expect("projectile body");
    let mut cands = Vec::new();
    for pi in 0..ctx.players.len() {
        cands.push((kind::PLAYER, pi));
    }
    for qi in 0..ctx.projectiles.len() {
        cands.push((kind::PROJECTILE, qi));
    }
    let origin = match ctx.projectiles[i].hit_point {
        Some(p) => p,
        None => world.store().body(body).get_position(),
    };
    let near = sort_near(world.store(), ctx, origin, &cands, (kind::PROJECTILE, i));
    let (radius, owner, team, damage, explode_damage) = {
        let e = &ctx.projectiles[i].eo;
        (e.explode_radius, e.owner, e.team, e.damage, e.explode_damage)
    };
    for n in near {
        if !(n.dist < radius) {
            continue;
        }
        let mut imp = v2(n.dx, n.dy);
        imp.normalize();
        imp.multiply(gs.rocket_explode_push);
        let tb = match n.kind {
            kind::PROJECTILE => {
                imp.multiply(0.5);
                ctx.projectiles[n.index].body
            }
            _ => ctx.players[n.index].body,
        }
        .expect("target body");
        let store = world.store_mut();
        let pos = store.body(tb).get_position();
        store.body_mut(tb).apply_impulse(imp, pos);
        if explode_damage && n.kind == kind::PLAYER {
            let t = &mut ctx.players[n.index];
            if !t.same_team(team) && t.id() != owner {
                t.damage(damage);
                t.eo.attacker = owner;
                t.eo.attacker_timer = 10.0;
            }
        }
    }
    let o = &mut ctx.projectiles[i];
    let at = match o.hit_point {
        Some(p) => p,
        None => world.store().body(body).get_position(),
    };
    o.new_effects.push(Effect { x: at.x, y: at.y, ttl: 5.0, kind: effect::EXPLOSION, volume: o.eo.explode_radius, ..Effect::default() });
    if o.eo.explode_radius > 0.1 {
        o.new_sounds.push(Sound { x: at.x, y: at.y, ttl: 15.0, kind: sound::EXPLOSION, volume: 0.3, ..Sound::default() });
    }
}

/// `wl` for a projectile.
pub(crate) fn projectile_begin_contact(ctx: &mut Ctx<'_>, store: &mut Store, i: usize, other: BodyId, point: Vec2, c: ContactId) {
    let (k, oi) = body_tag(store, other);
    let (owner, team, damage, object_damage, bounces) = {
        let e = &ctx.projectiles[i].eo;
        (e.owner, e.team, e.damage, e.object_damage, e.bounces)
    };
    let mut ignore = false;
    if k == kind::PLAYER {
        let t = &mut ctx.players[oi];
        if t.id() == owner || t.eo.age < crate::player::SPAWN_GRACE || t.same_team(team) {
            ignore = true;
            store.contact_mut(c).set_enabled(false);
        } else {
            t.damage(damage);
            t.eo.attacker = owner;
            t.eo.attacker_timer = 10.0;
        }
    }
    if k == kind::TURRET {
        let t = &mut ctx.turrets[oi].eo;
        if !(t.team == team && t.team != 1.0) {
            t.health = js::max(0.0, t.health - object_damage);
        }
    }
    if k == kind::PU {
        let t = &mut ctx.pu[oi].eo;
        if !(t.team == team && t.team != 1.0) {
            t.health = js::max(0.0, t.health - object_damage);
        }
    }
    if k == kind::PROJECTILE {
        store.contact_mut(c).set_enabled(false);
        ignore = true;
    }
    if k == kind::BODY {
        let def = &ctx.bodies[oi].eo.def;
        if def.projectile_pass == 1.0 || def.projectile_pass == team {
            ignore = true;
        }
        if def.force_zone {
            ignore = true;
            store.contact_mut(c).set_enabled(false);
        }
    }
    let o = &mut ctx.projectiles[i];
    if !bounces {
        if k != kind::GRAPPLE && k != kind::PROJECTILE && k != 6 && !ignore {
            o.terminated = true;
            o.hit_point = Some(point);
        }
    } else {
        if (k == kind::PLAYER || k == kind::TURRET) && !ignore {
            o.terminated = true;
            o.hit_point = Some(point);
        }
        if k == kind::BODY {
            if o.eo.bounce_count >= o.eo.bounce_limit && o.eo.bounce_limit > 0.0 {
                o.terminated = true;
                o.hit_point = Some(point);
            } else {
                o.eo.bounce_count += 1.0;
            }
        }
    }
}

/// `lo` for a projectile.
pub(crate) fn projectile_serialize(ctx: &mut Ctx<'_>, world: &World, i: usize, next: &mut State) {
    let o = &mut ctx.projectiles[i];
    let b = world.store().body(o.body.expect("projectile body"));
    let p = b.get_position();
    let v = b.get_linear_velocity();
    o.eo.x = p.x;
    o.eo.y = p.y;
    o.eo.vx = v.x;
    o.eo.vy = v.y;
    if !o.eo.align {
        o.eo.angle = b.get_angle();
        o.eo.angular_velocity = b.get_angular_velocity();
    }
    if o.eo.life > 0.0 && !o.terminated {
        next.projectiles.insert(o.index, o.eo.clone());
    }
    for e in o.new_effects.drain(..) {
        let slot = next.counters.next_effect();
        if let Some(s) = index_of(slot) {
            next.effects.insert(s, e);
        }
    }
    next.sounds.append(&mut o.new_sounds);
}

// ------------------------------------------------------------------ turrets

pub(crate) struct TurretObj {
    pub index: u32,
    pub eo: MapTurret,
    pub body: Option<BodyId>,
    pub dead: bool,
    pub shot: Option<Projectile>,
}

impl TurretObj {
    pub fn new(index: u32, eo: MapTurret) -> TurretObj {
        TurretObj { index, eo, body: None, dead: false, shot: None }
    }
}

pub(crate) fn turret_create(ctx: &mut Ctx<'_>, world: &mut World, i: usize) {
    let o = &mut ctx.turrets[i];
    let mut bd = B2BodyDef::default();
    bd.body_type = BodyType::Static;
    bd.position = v2(o.eo.x, o.eo.y);
    bd.user_data = tag(kind::TURRET, i);
    let body = world.create_body(&bd);
    o.body = Some(body);
    let mut pts = Vec::with_capacity(8);
    for g in 0..8 {
        let a = g as f64 * std::f64::consts::PI / 4.0 + std::f64::consts::PI / 8.0;
        pts.push(v2(0.7 * js::qcos(a), 0.7 * js::qsin(a)));
    }
    let mut p = PolygonShape::new();
    p.set_as_array(&pts, pts.len());
    world.create_fixture(body, &FixtureDef::new(Shape::Polygon(p)));
    let store = world.store_mut();
    let b = store.body_mut(body);
    b.set_linear_velocity(v2(o.eo.vx, o.eo.vy));
    let mass = b.get_mass_data().mass;
    let c = b.get_world_center();
    b.apply_force(v2(0.0, -14.0 * mass), c);
}

/// `ao`: cooldown and firing at the nearest visible enemy.
pub(crate) fn turret_pre_step(ctx: &mut Ctx<'_>, world: &mut World, i: usize) {
    if ctx.turrets[i].eo.cooldown != 0.0 {
        ctx.turrets[i].eo.cooldown -= 1.0;
        return;
    }
    let mut cands = Vec::new();
    for pi in 0..ctx.players.len() {
        cands.push((kind::PLAYER, pi));
    }
    for ti in 0..ctx.turrets.len() {
        cands.push((kind::TURRET, ti));
    }
    let body = ctx.turrets[i].body.expect("turret body");
    let origin = world.store().body(body).get_position();
    let near = sort_near(world.store(), ctx, origin, &cands, (kind::TURRET, i));
    let (range, team) = (ctx.turrets[i].eo.range, ctx.turrets[i].eo.team);
    for n in near {
        let (t_team, tb) = match n.kind {
            kind::PLAYER => (ctx.players[n.index].eo.team, ctx.players[n.index].body),
            _ => (ctx.turrets[n.index].eo.team, ctx.turrets[n.index].body),
        };
        if n.dist < range && (t_team != team || team == 1.0) {
            let tb = tb.expect("target body");
            if line_of_sight(world, body, tb) {
                let a = js::qatan2(n.dy, n.dx);
                let o = &mut ctx.turrets[i];
                let mut shot = o.eo.bullet.clone();
                let dist = 1.5 + shot.size;
                let speed = shot.vx;
                shot.x = o.eo.x + js::qcos(a) * dist;
                shot.y = o.eo.y + js::qsin(a) * dist;
                shot.vx = js::qcos(a) * speed;
                shot.vy = js::qsin(a) * speed;
                shot.owner = 999.0;
                shot.team = o.eo.team;
                o.eo.cooldown = o.eo.fire_interval;
                o.shot = Some(shot);
                break;
            }
        }
    }
}

/// `Bl`: nothing blocks the ray before the target body.
fn line_of_sight(world: &World, from: BodyId, to: BodyId) -> bool {
    let store = world.store();
    let p1 = store.body(from).get_position();
    let p2 = store.body(to).get_position();
    let mut target = 999.0;
    let mut nearest = 999.0;
    world.ray_cast(
        |store, f, _pt, _n, frac| {
            let b = store.fixture(f).get_body();
            let (k, _) = body_tag(store, b);
            if k == kind::PROJECTILE {
                return 1.0;
            }
            if b == to {
                target = frac;
            }
            if frac < nearest {
                nearest = frac;
            }
            1.0
        },
        p1,
        p2,
    );
    !(nearest < target)
}

/// `ro`
pub(crate) fn turret_post_step(o: &mut TurretObj) {
    if o.eo.health <= 0.0 {
        o.dead = true;
    }
}

pub(crate) fn turret_serialize(ctx: &mut Ctx<'_>, world: &World, i: usize, next: &mut State) {
    let o = &mut ctx.turrets[i];
    if !o.dead {
        let b = world.store().body(o.body.expect("turret body"));
        let p = b.get_position();
        let v = b.get_linear_velocity();
        o.eo.x = p.x;
        o.eo.y = p.y;
        o.eo.angle = b.get_angle();
        o.eo.angular_velocity = b.get_angular_velocity();
        o.eo.vx = v.x;
        o.eo.vy = v.y;
        next.turrets.insert(o.index, o.eo.clone());
    }
    if let Some(s) = o.shot.take() {
        if let Some(slot) = index_of(next.counters.projectile) {
            next.projectiles.insert(slot, s);
        }
        next.counters.projectile += 1.0;
    }
}

// ------------------------------------------------------------------ capture points

pub(crate) struct CapObj {
    pub eo: MapCap,
    pub body: Option<BodyId>,
    /// players touching per team (`Xu`)
    pub per_team: [u32; 4],
    /// ids of touching players (`Zu`)
    pub touching: Vec<f64>,
    pub touched: bool,
}

impl CapObj {
    pub fn new(eo: MapCap) -> CapObj {
        CapObj { eo, body: None, per_team: [0; 4], touching: Vec::new(), touched: false }
    }
}

pub(crate) fn cap_create(ctx: &mut Ctx<'_>, world: &mut World, i: usize) {
    let o = &mut ctx.caps[i];
    let mut bd = B2BodyDef::default();
    bd.body_type = BodyType::Static;
    bd.position = v2(o.eo.x, o.eo.y);
    bd.user_data = tag(kind::CAP, i);
    let body = world.create_body(&bd);
    o.body = Some(body);
    let h = o.eo.width / 2.0;
    let pts = [v2(-h - 0.5, 0.0), v2(-h, -0.5), v2(h, -0.5), v2(h + 0.5, 0.0)];
    let mut p = PolygonShape::new();
    p.set_as_array(&pts, pts.len());
    world.create_fixture(body, &FixtureDef::new(Shape::Polygon(p)));
}

pub(crate) fn cap_begin_contact(ctx: &mut Ctx<'_>, store: &mut Store, i: usize, other: BodyId) {
    let (k, oi) = body_tag(store, other);
    if k == kind::PLAYER {
        let team = ctx.players[oi].eo.team;
        let id = ctx.players[oi].id();
        let o = &mut ctx.caps[i];
        if let Some(t) = index_of(team).filter(|t| *t < 4) {
            o.per_team[t as usize] += 1;
        }
        o.touching.push(id);
        o.touched = true;
    }
}

/// `ro`: capture progress.
pub(crate) fn cap_post_step(ctx: &mut Ctx<'_>, i: usize) {
    if crate::round::round_over(ctx) || crate::round::game_over(ctx) {
        return;
    }
    let gs = ctx.gs;
    if !ctx.caps[i].touched {
        let e = &mut ctx.caps[i].eo;
        if e.progress > 0.0 {
            e.progress -= 0.25;
            if e.progress <= 0.0 {
                e.progress = 0.0;
                e.capturer = -1.0;
            }
        }
        return;
    }
    if matches!(gs.game_mode, 3..=5) {
        let red = ctx.caps[i].per_team[2];
        let blue = ctx.caps[i].per_team[3];
        if !((red > 0 && blue == 0) || (blue > 0 && red == 0)) {
            return;
        }
        let team = if red > 0 { 2.0 } else { 3.0 };
        let count = ctx.caps[i].per_team[team as usize] as f64;
        let (owner, seq) = (ctx.caps[i].eo.owner, ctx.caps[i].eo.sequence);
        if owner != team {
            let mut allowed = true;
            if seq != -1.0 {
                let prev = if team == 2.0 { seq - 1.0 } else { seq + 1.0 };
                for c in ctx.caps.iter() {
                    if c.eo.sequence == prev && c.eo.owner != team && prev >= 0.0 {
                        allowed = false;
                    }
                }
            }
            if allowed {
                let e = &mut ctx.caps[i].eo;
                if e.capturer != team {
                    e.progress -= count;
                    if e.progress <= 0.0 {
                        e.progress = 0.0;
                        e.capturer = team;
                    }
                } else {
                    e.progress += count;
                    if e.progress >= e.capture_time {
                        e.owner = team;
                        e.progress = 0.0;
                        e.capturer = -1.0;
                        let next_seq = if team == 2.0 { seq - 1.0 } else { seq + 1.0 };
                        for c in ctx.caps.iter_mut() {
                            if c.eo.sequence == next_seq && c.eo.progress > 0.0 {
                                c.eo.progress = 0.0;
                                c.eo.capturer = -1.0;
                            }
                        }
                        if ctx.caps.iter().all(|c| c.eo.owner == team) {
                            crate::round::objective(ctx, team);
                        }
                    }
                }
            }
        } else {
            let e = &mut ctx.caps[i].eo;
            if e.progress > 0.0 {
                e.progress -= count;
                if e.progress < 0.0 {
                    e.progress = 0.0;
                }
            }
        }
    } else {
        let capturer = ctx.caps[i].eo.capturer;
        let n = ctx.caps[i].touching.len();
        let first = ctx.caps[i].touching.first().copied().unwrap_or(f64::NAN);
        let e = &mut ctx.caps[i].eo;
        if n > 1 {
            if !ctx.caps[i].touching.contains(&capturer) {
                let e = &mut ctx.caps[i].eo;
                e.progress -= n as f64;
                if e.progress < 0.0 {
                    e.progress = 0.0;
                }
            }
        } else if n == 1 {
            if first == capturer {
                e.progress += 1.0;
            } else if first == e.owner {
                if e.progress > 0.0 {
                    e.progress -= 1.0;
                    if e.progress < 0.0 {
                        e.progress = 0.0;
                        e.capturer = -1.0;
                    }
                }
            } else if capturer == -1.0 && e.owner != first {
                e.capturer = first;
            } else {
                e.progress -= n as f64;
                if e.progress <= 0.0 {
                    e.progress = 0.0;
                    e.capturer = -1.0;
                }
            }
        }
        let e = &mut ctx.caps[i].eo;
        if e.progress >= e.capture_time {
            e.owner = first;
            e.capturer = -1.0;
            e.progress = 0.0;
            if ctx.caps.iter().all(|c| c.eo.owner == first) {
                crate::round::capture_win(ctx, first);
            }
        }
    }
}

// ------------------------------------------------------------------ pu (unused bucket)

pub(crate) struct PuObj {
    pub index: u32,
    pub eo: PuRow,
    pub body: Option<BodyId>,
}

impl PuObj {
    pub fn new(index: u32, eo: PuRow) -> PuObj {
        PuObj { index, eo, body: None }
    }
}

pub(crate) fn pu_create(ctx: &mut Ctx<'_>, world: &mut World, i: usize) {
    let o = &mut ctx.pu[i];
    let mut bd = B2BodyDef::default();
    bd.body_type = BodyType::Static;
    bd.position = v2(o.eo.x, o.eo.y);
    bd.angle = o.eo.angle;
    bd.user_data = tag(kind::PU, i);
    let body = world.create_body(&bd);
    let mut p = PolygonShape::new();
    p.set_as_box(2.0, 0.5);
    world.create_fixture(body, &FixtureDef::new(Shape::Polygon(p)));
    o.body = Some(body);
}

pub(crate) fn pu_serialize(ctx: &mut Ctx<'_>, world: &World, i: usize, next: &mut State) {
    let o = &mut ctx.pu[i];
    if o.eo.health != 0.0 {
        let b = world.store().body(o.body.expect("pu body"));
        let p = b.get_position();
        o.eo.x = p.x;
        o.eo.y = p.y;
        o.eo.angle = b.get_angle();
        next.pu.insert(o.index, o.eo.clone());
    }
}
