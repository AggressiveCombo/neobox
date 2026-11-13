//! State dump in the original game's array layout (its `F({Ta: true})`
//! serialization). Used to diff Neobox against reference trajectories
//! recorded from the original (`tools/oracle/record.cjs`).

use crate::map::{num_value, MapCap, MapGrapple, MapJoint, MapSettings, MapShape, MapSpawn, MapTurret, ProjectileDef};
use crate::state::*;
use serde_json::Value;

fn n(v: f64) -> Value {
    num_value(v)
}
fn b(v: bool) -> Value {
    Value::Bool(v)
}
fn opt(v: Option<f64>) -> Value {
    v.map_or(Value::Null, n)
}

fn sparse<T>(s: &Sparse<T>, f: impl Fn(&T) -> Value) -> Value {
    let len = s.ids().last().map_or(0, |k| k as usize + 1);
    let mut out = vec![Value::Null; len];
    for (k, v) in s.iter() {
        out[k as usize] = f(v);
    }
    Value::Array(out)
}

fn settings(s: &MapSettings) -> Value {
    Value::Array(vec![
        n(s.screen_width),
        n(s.snap),
        n(s.gn),
        n(s.background_image),
        n(s.bg_offset_x),
        n(s.bg_offset_y),
        n(s.bg_scale),
        n(s.parallax),
        n(s.color_top),
        b(s.qn),
        n(s.width),
        n(s.height),
        n(s.color_bottom),
        n(s.gravity),
        b(s.wrap),
    ])
}

fn sound(s: &Sound) -> Value {
    if s.effect_row {
        // the effect class layout: x, y, type, On, Rn, Dn, Ln, volume, zIndex, Un, jn
        return Value::Array(vec![n(s.x), n(s.y), n(s.kind), n(-1.0), n(-1.0), n(20.0), n(0.0), n(s.volume), n(0.0), n(0.0), n(s.player)]);
    }
    Value::Array(vec![n(s.x), n(s.y), n(s.kind), n(s.ttl), n(s.volume), n(s.player)])
}

fn spawn(s: &MapSpawn) -> Value {
    Value::Array(vec![
        n(s.x),
        n(s.y),
        n(s.priority),
        n(s.angle),
        Value::Array(s.teams.iter().map(|t| b(*t)).collect()),
        n(s.cap_sequence),
    ])
}

fn record(r: &PlayerRecord) -> Value {
    Value::Array(vec![
        n(r.id),
        n(r.team),
        n(r.kills),
        n(r.wins),
        n(r.co),
        n(r.do_),
        n(r.po),
        Value::Array(r.wo.iter().map(|v| n(*v)).collect()),
        Value::Array(r.mo.iter().map(|v| n(*v)).collect()),
        n(r.yo),
        n(r.fo),
        b(r.alive),
        n(r.respawn),
        n(r.spawn),
        n(r.lives),
        n(r.eliminated),
        n(r.last_victim),
        n(r.kill_timer),
        n(r.killed_by),
        n(r.death_timer),
        n(r.suicide_timer),
    ])
}

fn round(r: &Round) -> Value {
    Value::Array(vec![
        n(r.game_over),
        n(r.round_over),
        n(r.intro),
        n(r.po),
        n(r.seed),
        n(r.round_number),
        n(r.bo),
        n(r.io),
        n(r.ticks),
        n(r.winner),
        n(r.objective_team),
        n(r.eliminations),
        n(r.min_lives),
        b(r.lo),
        n(r.red),
        n(r.blue),
        Value::Array(r.players.values().map(record).collect()),
    ])
}

fn shape(s: &MapShape) -> Value {
    let mut v = vec![
        n(s.kind),
        n(s.x),
        n(s.y),
        opt(s.density),
        opt(s.friction),
        opt(s.restitution),
        n(s.color),
        b(s.closed),
        n(0.0),
        n(s.aa),
        n(s.la),
        n(s.ua),
        b(s.no_physics),
        n(s.z_index),
    ];
    if s.kind == crate::map::SHAPE_CIRCLE {
        v.push(n(s.radius));
    } else {
        for p in &s.points {
            v.push(n(p[0]));
            v.push(n(p[1]));
        }
    }
    Value::Array(v)
}

fn body(o: &Body) -> Value {
    let d = &o.def;
    let mut v = vec![
        n(d.id as f64),
        n(o.x),
        n(o.y),
        n(o.angle),
        n(o.angular_velocity),
        n(o.vx),
        n(o.vy),
        n(d.density),
        n(d.restitution),
        n(d.friction),
        n(d.linear_damping),
        n(d.angular_damping),
        b(d.kill_players),
        n(d.motion),
        b(d.wrap),
        b(o.teleported),
        n(d.force_x),
        n(d.force_y),
        n(d.torque),
        n(o.damage),
        n(d.dynamic_threshold),
        n(d.removal_threshold),
        b(d.no_physics),
        n(d.z_index),
        d.group.to_value(),
        b(d.collide_a),
        b(d.collide_b),
        b(d.collide_c),
        b(d.collide_d),
        n(d.player_pass),
        n(d.projectile_pass),
        b(d.freeze_players),
        b(d.no_jump),
        b(d.bullet),
        b(d.invisible),
        n(d.parallax),
        n(o.lifetime),
        n(d.source_player),
        b(d.fixed_rotation),
        b(d.ability_immune),
        n(d.objective),
        n(d.objective_target),
        b(d.ea),
        n(o.sound_limiter),
        b(d.pinned),
    ];
    if d.pinned {
        v.push(n(d.pin_x));
        v.push(n(d.pin_y));
    }
    v.push(b(d.force_zone));
    if d.force_zone {
        v.push(n(d.zone_x));
        v.push(n(d.zone_y));
    }
    v.push(Value::Array(d.shapes.iter().map(shape).collect()));
    let mut pf = Vec::new();
    for (k, w) in o.push_from.iter() {
        pf.push(n(k as f64));
        pf.push(n(*w));
    }
    v.push(Value::Array(pf));
    Value::Array(v)
}

fn joint(j: &MapJoint) -> Value {
    let mut v = vec![n(j.ax), n(j.ay), n(j.bx), n(j.by), n(j.kind), b(j.collide_connected), n(j.body_a), n(j.body_b)];
    if j.kind == 0.0 {
        v.extend([n(j.frequency), n(j.damping), n(j.length)]);
    }
    if j.kind == 1.0 || j.kind == 2.0 {
        v.extend([n(j.motor_speed), n(j.max_motor)]);
    }
    v.extend([n(j.player_a), b(j.ha), n(j.motor_mode), b(j.latched), n(j.axis_x), n(j.axis_y)]);
    Value::Array(v)
}

fn effect(e: &Effect) -> Value {
    Value::Array(vec![
        n(e.x),
        n(e.y),
        n(e.kind),
        n(e.x2),
        n(e.y2),
        n(e.ttl),
        n(e.ln),
        n(e.volume),
        n(e.z_index),
        n(e.team),
        n(e.player),
    ])
}

fn attach(a: &Attach) -> Value {
    let mut v = vec![n(a.state), n(a.de)];
    if a.state == ATTACH_ON {
        v.extend([n(a.target), n(a.kind), n(a.ax), n(a.ay)]);
    } else {
        v.push(b(false));
    }
    Value::Array(v)
}

fn player(p: &Player) -> Value {
    let mut v = vec![
        n(p.id),
        n(p.x),
        n(p.y),
        n(p.angle),
        n(p.angular_velocity),
        n(p.vx),
        n(p.vy),
        n(p.up_held),
        b(p.teleported),
        n(p.health),
        n(p.team),
        b(p.air_jump),
        n(p.spawn_x),
        n(p.spawn_y),
        n(p.ze2),
        n(p.age),
        n(p.frozen),
        b(p.tn),
        b(p.stunned),
        n(p.coyote),
        n(p.en),
        n(p.push_frames),
        n(p.stamina),
        n(p.attacker),
        n(p.attacker_timer),
        n(p.bat_frame),
        n(p.bat_aim),
        Value::Array(p.bat_hits.iter().map(|v| n(*v)).collect()),
        b(p.freeze_ready),
        n(p.dash_frame),
        n(p.dash_speed),
        n(p.rocket_frame),
        n(p.rocket_aim),
        n(p.egg_frame),
        n(p.egg_aim),
        n(p.sound_limiter),
        n(p.kn),
        n(p.sn2),
        b(p.nn2),
        b(p.ghost),
        n(p.kills),
    ];
    v.push(attach(&p.rope));
    v.push(attach(&p.link));
    for g in &p.grabs {
        v.push(attach(g));
    }
    v.push(match &p.parachute {
        Some(c) => Value::Array(vec![n(c.x), n(c.y), n(c.angle), n(c.angular_velocity), n(c.vx), n(c.vy), n(c.deploy)]),
        None => Value::Null,
    });
    Value::Array(v)
}

fn projectile(q: &ProjectileDef) -> Value {
    Value::Array(vec![
        n(q.x),
        n(q.y),
        n(q.vx),
        n(q.vy),
        n(q.angle),
        n(q.angular_velocity),
        n(q.size),
        n(q.density),
        n(q.friction),
        n(q.restitution),
        n(q.life),
        n(q.damage),
        n(q.object_damage),
        n(q.owner),
        n(q.turn_rate),
        n(q.team),
        n(q.explode_radius),
        n(q.gravity_scale),
        b(q.bounces),
        n(q.shape),
        n(q.linear_damping),
        n(q.bounce_count),
        n(q.bounce_limit),
        b(q.align),
        b(q.explode_damage),
    ])
}

fn turret(t: &MapTurret) -> Value {
    Value::Array(vec![
        n(t.x),
        n(t.y),
        n(t.vx),
        n(t.vy),
        n(t.angle),
        n(t.angular_velocity),
        n(t.health),
        n(t.max_health),
        n(t.cooldown),
        n(t.team),
        n(t.fire_interval),
        n(t.range),
        projectile(&t.bullet),
    ])
}

fn grapple(g: &MapGrapple) -> Value {
    Value::Array(vec![n(g.x), n(g.y), n(g.range), n(g.body)])
}

fn pu(p: &PuRow) -> Value {
    Value::Array(vec![n(p.x), n(p.y), n(p.angle), n(p.health), n(p.yu), n(p.team)])
}

fn cap(c: &MapCap) -> Value {
    Value::Array(vec![n(c.x), n(c.y), n(c.width), n(c.sequence), n(c.owner), n(c.capturer), n(c.capture_time), n(c.progress)])
}

impl State {
    /// The state in the original's 14-bucket array layout.
    pub fn to_original_layout(&self) -> Value {
        Value::Array(vec![
            Value::Array(vec![settings(&self.settings)]),
            Value::Array(self.sounds.iter().map(sound).collect()),
            sparse(&self.spawns, spawn),
            Value::Array(vec![Value::Array(vec![
                n(self.counters.projectile),
                n(self.counters.effect),
                n(self.counters.turret),
                n(self.counters.pu),
            ])]),
            Value::Array(vec![round(&self.round)]),
            sparse(&self.bodies, body),
            sparse(&self.joints, joint),
            sparse(&self.effects, effect),
            sparse(&self.players, player),
            sparse(&self.projectiles, projectile),
            sparse(&self.turrets, turret),
            sparse(&self.grapples, grapple),
            sparse(&self.pu, pu),
            Value::Array(self.caps.iter().map(cap).collect()),
        ])
    }
}

/// Compare two original-layout values: numbers must be identical (`-0` and
/// `0` are equal: JSON cannot tell them apart), `null` matches `null`/NaN,
/// and booleans match 0/1. Returns the path of the first difference.
pub fn first_difference(a: &Value, b: &Value) -> Option<String> {
    fn num(v: &Value) -> Option<f64> {
        match v {
            Value::Number(x) => x.as_f64(),
            Value::Bool(t) => Some(if *t { 1.0 } else { 0.0 }),
            _ => None,
        }
    }
    fn walk(a: &Value, b: &Value, path: &mut String) -> bool {
        match (a, b) {
            (Value::Array(x), Value::Array(y)) => {
                let n = x.len().max(y.len());
                for i in 0..n {
                    let av = x.get(i).unwrap_or(&Value::Null);
                    let bv = y.get(i).unwrap_or(&Value::Null);
                    let len = path.len();
                    path.push_str(&format!("[{i}]"));
                    if !walk(av, bv, path) {
                        return false;
                    }
                    path.truncate(len);
                }
                true
            }
            (Value::Null, Value::Null) => true,
            (Value::String(x), Value::String(y)) => x == y,
            _ => match (num(a), num(b)) {
                (Some(x), Some(y)) => x == y,
                _ => false,
            },
        }
    }
    let mut path = String::new();
    if walk(a, b, &mut path) { None } else { Some(path) }
}
