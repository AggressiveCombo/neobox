//! Bit-exact comparison against the box2dweb reference traces.
//!
//! Every `tools/box2d-ref/scenarios/<name>.json` is replayed through the public
//! `neobox_box2d` API, performing exactly the actions and emitting exactly the
//! records of `tools/box2d-ref/run.cjs`, then compared record by record with
//! `tests/fixtures/<name>.trace.json.gz`. Values compare by IEEE-754 bit pattern
//! (`0x` + 16 hex digits, as run.cjs `hex()`; booleans are 1/0, ids are numbers).
//!
//! Scenarios run sequentially inside one test because the warm-starting and
//! continuous-physics flags are process-wide statics.
//! `NEOBOX_B2=<substring>` restricts the run to matching scenario names.

use std::collections::HashMap;
use std::fs::{self, File};
use std::io::BufReader;
use std::path::Path;

use flate2::read::GzDecoder;
use serde_json::Value;

use neobox_box2d::collision::aabb::AABB;
use neobox_box2d::collision::manifold::{Manifold, ManifoldType};
use neobox_box2d::collision::shapes::{CircleShape, PolygonShape, Shape};
use neobox_box2d::dynamics::body::{self, BodyDef, BodyType};
use neobox_box2d::dynamics::contact;
use neobox_box2d::dynamics::joints;
use neobox_box2d::dynamics::fixture::{Filter, FixtureDef};
use neobox_box2d::dynamics::joints::{
    DistanceJointDef, Joint, JointDef, PrismaticJointDef, RevoluteJointDef,
};
use neobox_box2d::dynamics::world::{ContactImpulse, ContactListener, World};
use neobox_box2d::dynamics::Store;
use neobox_box2d::math::Vec2;
use neobox_box2d::{BodyId, ContactId, FixtureId, JointId};

type Records = Vec<(String, u64)>;

// ---------------------------------------------------------------------------
// JSON helpers (mirror the JS scenario reads in run.cjs)
// ---------------------------------------------------------------------------

fn fnum(v: &Value) -> f64 {
    v.as_f64().unwrap_or_else(|| panic!("expected number, got {v}"))
}

fn fbool(v: &Value) -> bool {
    v.as_bool().unwrap_or_else(|| panic!("expected bool, got {v}"))
}

fn fstr(v: &Value) -> &str {
    v.as_str().unwrap_or_else(|| panic!("expected string, got {v}"))
}

fn fvec(v: &Value) -> Vec2 {
    Vec2 { x: fnum(&v[0]), y: fnum(&v[1]) }
}

fn farr(v: &Value) -> &[Value] {
    v.as_array().map(Vec::as_slice).unwrap_or(&[])
}

/// run.cjs `setIf`: overwrite `dst` only when the key is present.
fn set_num(src: &Value, key: &str, dst: &mut f64) {
    if let Some(x) = src.get(key) {
        *dst = fnum(x);
    }
}

fn set_bool(src: &Value, key: &str, dst: &mut bool) {
    if let Some(x) = src.get(key) {
        *dst = fbool(x);
    }
}

/// run.cjs `makeFilter`: b2FilterData defaults (1, 0xFFFF, 0) overridden by present keys.
fn filter_of(v: &Value) -> Filter {
    Filter {
        category_bits: v.get("categoryBits").map_or(1, |x| fnum(x) as u16),
        mask_bits: v.get("maskBits").map_or(0xFFFF, |x| fnum(x) as u16),
        group_index: v.get("groupIndex").map_or(0, |x| fnum(x) as i16),
    }
}

fn body_type(t: &str) -> BodyType {
    match t {
        "static" => BodyType::Static,
        "kinematic" => BodyType::Kinematic,
        "dynamic" => BodyType::Dynamic,
        other => panic!("unknown body type {other}"),
    }
}

fn make_shape(sh: &Value) -> Shape {
    match fstr(&sh["type"]) {
        "box" => {
            let mut p = PolygonShape::new();
            p.set_as_box(fnum(&sh["hx"]), fnum(&sh["hy"]));
            Shape::Polygon(p)
        }
        "orientedBox" => {
            let mut p = PolygonShape::new();
            p.set_as_oriented_box(fnum(&sh["hx"]), fnum(&sh["hy"]), fvec(&sh["center"]), fnum(&sh["angle"]));
            Shape::Polygon(p)
        }
        "polygon" => {
            let pts: Vec<Vec2> = farr(&sh["vertices"]).iter().map(fvec).collect();
            let mut p = PolygonShape::new();
            p.set_as_array(&pts, pts.len());
            Shape::Polygon(p)
        }
        "circle" => {
            let mut c = CircleShape::new(fnum(&sh["radius"]));
            c.set_local_position(fvec(&sh["center"]));
            Shape::Circle(c)
        }
        other => panic!("unknown shape {other}"),
    }
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

/// The trace log plus the current step / event counter (run.cjs `curStep`, `evCounter`).
#[derive(Default)]
struct Log {
    recs: Records,
    step: usize,
    ev: usize,
}

impl Log {
    fn num(&mut self, key: impl Into<String>, v: f64) {
        self.recs.push((key.into(), v.to_bits()));
    }

    fn flag(&mut self, key: impl Into<String>, v: bool) {
        self.num(key, if v { 1.0 } else { 0.0 });
    }
}

#[derive(Clone, Copy)]
struct BodyState {
    px: f64,
    py: f64,
    a: f64,
    vx: f64,
    vy: f64,
    w: f64,
}

struct FixInfo {
    index: usize,
    name: String,
}

fn fix_index(map: &HashMap<FixtureId, FixInfo>, f: FixtureId) -> f64 {
    map.get(&f).expect("fixture not owned by scenario").index as f64
}

fn fix_name(map: &HashMap<FixtureId, FixInfo>, f: FixtureId) -> &str {
    &map.get(&f).expect("fixture not owned by scenario").name
}

/// run.cjs `installListener`: records events (when enabled) and applies disable rules in PreSolve.
struct Listener<'a> {
    log: &'a mut Log,
    fix_info: &'a HashMap<FixtureId, FixInfo>,
    rules: &'a [Value],
    events: bool,
}

impl Listener<'_> {
    fn emit(&mut self, store: &Store, t: f64, c: ContactId, extra: Vec<(String, f64)>) {
        let contact = store.contact(c);
        let fa = fix_index(self.fix_info, contact.get_fixture_a());
        let fb = fix_index(self.fix_info, contact.get_fixture_b());
        let p = format!("s{}.ev.{}", self.log.step, self.log.ev);
        self.log.ev += 1;
        self.log.num(format!("{p}.t"), t);
        self.log.num(format!("{p}.fa"), fa);
        self.log.num(format!("{p}.fb"), fb);
        for (k, v) in extra {
            self.log.num(format!("{p}.{k}"), v);
        }
    }

    fn disabled(&self, store: &Store, c: ContactId) -> bool {
        let contact = store.contact(c);
        let (fa, fb) = (contact.get_fixture_a(), contact.get_fixture_b());
        let (na, nb) = (fix_name(self.fix_info, fa), fix_name(self.fix_info, fb));
        for r in self.rules {
            if let Some(pair) = r.get("fixtures") {
                let (x, y) = (fstr(&pair[0]), fstr(&pair[1]));
                if (na == x && nb == y) || (na == y && nb == x) {
                    return true;
                }
            }
            if let Some(cat) = r.get("categoryBits") {
                let m = fnum(cat) as u64;
                let ca = store.fixture(fa).get_filter().category_bits as u64;
                let cb = store.fixture(fb).get_filter().category_bits as u64;
                if (ca & m) != 0 || (cb & m) != 0 {
                    return true;
                }
            }
        }
        false
    }
}

impl ContactListener for Listener<'_> {
    fn begin_contact(&mut self, store: &mut Store, c: ContactId) {
        if self.events {
            self.emit(store, 0.0, c, Vec::new());
        }
    }

    fn end_contact(&mut self, store: &mut Store, c: ContactId) {
        if self.events {
            self.emit(store, 1.0, c, Vec::new());
        }
    }

    fn pre_solve(&mut self, store: &mut Store, c: ContactId, old_manifold: &Manifold) {
        let en = store.contact(c).is_enabled();
        if self.events {
            let extra = vec![
                ("oldpc".to_owned(), old_manifold.point_count as f64),
                ("en".to_owned(), if en { 1.0 } else { 0.0 }),
            ];
            self.emit(store, 2.0, c, extra);
        }
        if self.disabled(store, c) {
            store.contact_mut(c).set_enabled(false);
        }
    }

    fn post_solve(&mut self, store: &mut Store, c: ContactId, impulse: &ContactImpulse) {
        if !self.events {
            return;
        }
        let pc = store.contact(c).get_manifold().point_count as usize;
        let mut extra = vec![("pc".to_owned(), pc as f64)];
        for j in 0..pc {
            extra.push((format!("p{j}.ni"), impulse.normal_impulses[j]));
            extra.push((format!("p{j}.ti"), impulse.tangent_impulses[j]));
        }
        self.emit(store, 3.0, c, extra);
    }
}

// ---------------------------------------------------------------------------
// Scenario runner (run.cjs `runScenario`)
// ---------------------------------------------------------------------------

struct Run<'s> {
    sc: &'s Value,
    world: World,
    log: Log,
    events: bool,
    rules: &'s [Value],
    fix_index_by_name: HashMap<String, usize>,
    body_by_name: HashMap<String, BodyId>,
    body_name: HashMap<BodyId, String>,
    fix_by_name: HashMap<String, FixtureId>,
    fix_info: HashMap<FixtureId, FixInfo>,
    joint_by_name: HashMap<String, JointId>,
    joint_name: HashMap<JointId, String>,
}

impl<'s> Run<'s> {
    fn new(sc: &'s Value) -> Self {
        // global fixture index: declaration order, stable across rebuilds
        let mut fix_index_by_name = HashMap::new();
        let mut i = 0;
        for b in farr(&sc["bodies"]) {
            for fx in farr(&b["fixtures"]) {
                fix_index_by_name.insert(fstr(&fx["name"]).to_owned(), i);
                i += 1;
            }
        }
        // library statics, set right after construction (which resets both)
        let mut world = World::new(fvec(&sc["gravity"]), fbool(&sc["doSleep"]));
        world.set_warm_starting(fbool(&sc["warmStarting"]));
        world.set_continuous_physics(fbool(&sc["continuousPhysics"]));
        Run {
            sc,
            world,
            log: Log::default(),
            events: sc["listener"]["events"].as_bool().unwrap_or(false),
            rules: farr(&sc["listener"]["disable"]),
            fix_index_by_name,
            body_by_name: HashMap::new(),
            body_name: HashMap::new(),
            fix_by_name: HashMap::new(),
            fix_info: HashMap::new(),
            joint_by_name: HashMap::new(),
            joint_name: HashMap::new(),
        }
    }

    /// run.cjs `resetMaps`.
    fn reset_maps(&mut self) {
        self.body_by_name.clear();
        self.body_name.clear();
        self.fix_by_name.clear();
        self.fix_info.clear();
        self.joint_by_name.clear();
        self.joint_name.clear();
    }

    fn body_id(&self, name: &str) -> BodyId {
        *self.body_by_name.get(name).unwrap_or_else(|| panic!("unknown body {name}"))
    }

    fn joint_id(&self, name: &str) -> JointId {
        *self.joint_by_name.get(name).unwrap_or_else(|| panic!("unknown joint {name}"))
    }

    fn bind_ground(&mut self) {
        let ground = self.world.get_ground_body();
        self.body_name.insert(ground, "__ground".to_owned());
    }

    /// run.cjs `createBodies`: declared defs, or previous snapshot state in rebuild mode.
    fn create_bodies(&mut self, prev: Option<&HashMap<String, BodyState>>) {
        let sc = self.sc;
        let null = Value::Null;
        for b in farr(&sc["bodies"]) {
            let name = fstr(&b["name"]);
            let d = &b["def"];
            let mut pos = fvec(&d["position"]);
            let mut ang = d.get("angle").map(fnum);
            let mut lv = d.get("linearVelocity").map_or(Vec2::default(), fvec);
            let mut av = d.get("angularVelocity").map(fnum);
            if let Some(p) = prev.and_then(|m| m.get(name)) {
                pos = Vec2 { x: p.px, y: p.py };
                ang = Some(p.a);
                lv = Vec2 { x: p.vx, y: p.vy };
                av = Some(p.w);
            }
            let mut bd = BodyDef {
                body_type: body_type(fstr(&d["type"])),
                position: pos,
                linear_velocity: lv,
                ..BodyDef::default()
            };
            if let Some(a) = ang {
                bd.angle = a;
            }
            if let Some(w) = av {
                bd.angular_velocity = w;
            }
            set_num(d, "linearDamping", &mut bd.linear_damping);
            set_num(d, "angularDamping", &mut bd.angular_damping);
            set_bool(d, "fixedRotation", &mut bd.fixed_rotation);
            set_bool(d, "bullet", &mut bd.bullet);
            set_bool(d, "allowSleep", &mut bd.allow_sleep);
            set_bool(d, "awake", &mut bd.awake);
            set_bool(d, "active", &mut bd.active);

            let body = self.world.create_body(&bd);
            self.body_by_name.insert(name.to_owned(), body);
            self.body_name.insert(body, name.to_owned());
            for fx in farr(&b["fixtures"]) {
                let fname = fstr(&fx["name"]);
                let def = FixtureDef {
                    shape: make_shape(&fx["shape"]),
                    density: fnum(&fx["density"]),
                    friction: fnum(&fx["friction"]),
                    restitution: fnum(&fx["restitution"]),
                    is_sensor: fbool(&fx["isSensor"]),
                    filter: filter_of(fx.get("filter").unwrap_or(&null)),
                    user_data: 0,
                };
                let fid = self.world.create_fixture(body, &def);
                self.fix_by_name.insert(fname.to_owned(), fid);
                let index = self.fix_index_by_name[fname];
                self.fix_info.insert(fid, FixInfo { index, name: fname.to_owned() });
            }
        }
    }

    /// run.cjs `createJoints` (persistent mode only).
    fn create_joints(&mut self) {
        let sc = self.sc;
        for j in farr(&sc["joints"]) {
            let name = fstr(&j["name"]);
            let ba = self.body_id(fstr(&j["bodyA"]));
            let bb = self.body_id(fstr(&j["bodyB"]));
            let def = match fstr(&j["type"]) {
                "distance" => {
                    let mut d = DistanceJointDef::new(ba, bb);
                    d.initialize(self.world.store(), ba, bb, fvec(&j["anchorA"]), fvec(&j["anchorB"]));
                    set_num(j, "length", &mut d.length);
                    d.frequency_hz = fnum(&j["frequencyHz"]);
                    d.damping_ratio = fnum(&j["dampingRatio"]);
                    d.collide_connected = fbool(&j["collideConnected"]);
                    JointDef::Distance(d)
                }
                "revolute" => {
                    let mut d = RevoluteJointDef::new(ba, bb);
                    d.initialize(self.world.store(), ba, bb, fvec(&j["anchor"]));
                    set_bool(j, "enableLimit", &mut d.enable_limit);
                    set_num(j, "lowerAngle", &mut d.lower_angle);
                    set_num(j, "upperAngle", &mut d.upper_angle);
                    set_bool(j, "enableMotor", &mut d.enable_motor);
                    set_num(j, "motorSpeed", &mut d.motor_speed);
                    set_num(j, "maxMotorTorque", &mut d.max_motor_torque);
                    set_bool(j, "collideConnected", &mut d.collide_connected);
                    JointDef::Revolute(d)
                }
                "prismatic" => {
                    let mut d = PrismaticJointDef::new(ba, bb);
                    d.initialize(self.world.store(), ba, bb, fvec(&j["anchor"]), fvec(&j["axis"]));
                    set_bool(j, "enableLimit", &mut d.enable_limit);
                    set_num(j, "lowerTranslation", &mut d.lower_translation);
                    set_num(j, "upperTranslation", &mut d.upper_translation);
                    set_bool(j, "enableMotor", &mut d.enable_motor);
                    set_num(j, "motorSpeed", &mut d.motor_speed);
                    set_num(j, "maxMotorForce", &mut d.max_motor_force);
                    set_bool(j, "collideConnected", &mut d.collide_connected);
                    JointDef::Prismatic(d)
                }
                other => panic!("unknown joint type {other}"),
            };
            let jid = self.world.create_joint(&def);
            self.joint_by_name.insert(name.to_owned(), jid);
            self.joint_name.insert(jid, name.to_owned());
        }
    }

    /// run.cjs `runCmd`.
    fn run_cmd(&mut self, c: &Value) {
        match fstr(&c["op"]) {
            "applyForce" => {
                let id = self.body_id(fstr(&c["body"]));
                self.world.store_mut().body_mut(id).apply_force(fvec(&c["force"]), fvec(&c["point"]));
            }
            "applyImpulse" => {
                let id = self.body_id(fstr(&c["body"]));
                self.world.store_mut().body_mut(id).apply_impulse(fvec(&c["impulse"]), fvec(&c["point"]));
            }
            "applyTorque" => {
                let id = self.body_id(fstr(&c["body"]));
                self.world.store_mut().body_mut(id).apply_torque(fnum(&c["torque"]));
            }
            "setLinearVelocity" => {
                let id = self.body_id(fstr(&c["body"]));
                self.world.store_mut().body_mut(id).set_linear_velocity(fvec(&c["v"]));
            }
            "setAngularVelocity" => {
                let id = self.body_id(fstr(&c["body"]));
                self.world.store_mut().body_mut(id).set_angular_velocity(fnum(&c["w"]));
            }
            "setTransform" => {
                // SetPosition then SetAngle (no SetTransform in the archived library)
                let id = self.body_id(fstr(&c["body"]));
                self.world.set_position(id, fvec(&c["position"]));
                self.world.set_angle(id, fnum(&c["angle"]));
            }
            "setAwake" => {
                let id = self.body_id(fstr(&c["body"]));
                self.world.store_mut().body_mut(id).set_awake(fbool(&c["awake"]));
            }
            "setFixedRotation" => {
                let id = self.body_id(fstr(&c["body"]));
                body::set_fixed_rotation(self.world.store_mut(), id, fbool(&c["flag"]));
            }
            "setLinearDamping" => {
                let id = self.body_id(fstr(&c["body"]));
                self.world.store_mut().body_mut(id).set_linear_damping(fnum(&c["value"]));
            }
            "setAngularDamping" => {
                let id = self.body_id(fstr(&c["body"]));
                self.world.store_mut().body_mut(id).set_angular_damping(fnum(&c["value"]));
            }
            "setFilter" => {
                let name = fstr(&c["fixture"]);
                let fid = *self
                    .fix_by_name
                    .get(name)
                    .unwrap_or_else(|| panic!("unknown fixture {name}"));
                // library bug preserved: contacts are not refiltered
                self.world.store_mut().fixture_mut(fid).set_filter(filter_of(&c["filter"]));
            }
            "jointSetMotorSpeed" => {
                let jid = self.joint_id(fstr(&c["joint"]));
                let speed = fnum(&c["speed"]);
                match self.world.store_mut().joint_mut(jid) {
                    Joint::Revolute(j) => j.set_motor_speed(speed),
                    Joint::Prismatic(j) => j.set_motor_speed(speed),
                    _ => panic!("jointSetMotorSpeed: joint type has no motor speed"),
                }
            }
            "jointSetMaxMotorTorque" => {
                let jid = self.joint_id(fstr(&c["joint"]));
                let value = fnum(&c["value"]);
                match self.world.store_mut().joint_mut(jid) {
                    Joint::Revolute(j) => j.set_max_motor_torque(value),
                    _ => panic!("jointSetMaxMotorTorque: joint is not revolute"),
                }
            }
            "jointSetMaxMotorForce" => {
                let jid = self.joint_id(fstr(&c["joint"]));
                let value = fnum(&c["value"]);
                match self.world.store_mut().joint_mut(jid) {
                    Joint::Prismatic(j) => j.set_max_motor_force(value),
                    _ => panic!("jointSetMaxMotorForce: joint is not prismatic"),
                }
            }
            "clearForces" => self.world.clear_forces(),
            "rayCast" => self.ray_cast(c),
            "queryAABB" => self.query_aabb(c),
            other => panic!("unknown op {other}"),
        }
    }

    /// run.cjs `rayCast`: callback return policy minusOne/zero/fraction/one.
    fn ray_cast(&mut self, c: &Value) {
        let returns = fstr(&c["returns"]);
        let fix = &self.fix_info;
        let mut hits: Vec<(f64, Vec2, Vec2, f64, f64)> = Vec::new();
        self.world.ray_cast(
            |_store, fid, point, normal, fraction| {
                let ret = match returns {
                    "minusOne" => -1.0,
                    "zero" => 0.0,
                    "fraction" => fraction,
                    "one" => 1.0,
                    other => panic!("bad returns {other}"),
                };
                hits.push((fix_index(fix, fid), point, normal, fraction, ret));
                ret
            },
            fvec(&c["p1"]),
            fvec(&c["p2"]),
        );
        let p = format!("ray.{}", fstr(&c["name"]));
        self.log.num(format!("{p}.count"), hits.len() as f64);
        for (k, (fi, pt, n, fr, ret)) in hits.iter().enumerate() {
            let q = format!("{p}.{k}");
            self.log.num(format!("{q}.f"), *fi);
            self.log.num(format!("{q}.px"), pt.x);
            self.log.num(format!("{q}.py"), pt.y);
            self.log.num(format!("{q}.nx"), n.x);
            self.log.num(format!("{q}.ny"), n.y);
            self.log.num(format!("{q}.fr"), *fr);
            self.log.num(format!("{q}.ret"), *ret);
        }
    }

    /// run.cjs `queryAABB`: callback always returns true.
    fn query_aabb(&mut self, c: &Value) {
        let a = farr(&c["aabb"]);
        let aabb = AABB {
            lower_bound: Vec2 { x: fnum(&a[0]), y: fnum(&a[1]) },
            upper_bound: Vec2 { x: fnum(&a[2]), y: fnum(&a[3]) },
        };
        let fix = &self.fix_info;
        let mut hits: Vec<f64> = Vec::new();
        self.world.query_aabb(
            |_store, fid| {
                hits.push(fix_index(fix, fid));
                true
            },
            aabb,
        );
        let p = format!("qry.{}", fstr(&c["name"]));
        self.log.num(format!("{p}.count"), hits.len() as f64);
        for (k, fi) in hits.iter().enumerate() {
            self.log.num(format!("{p}.{k}.f"), *fi);
        }
    }

    /// run.cjs `snapshot`: body list, fixture AABBs, contact list, joint list.
    fn snapshot(&mut self, si: usize, dt: f64) -> HashMap<String, BodyState> {
        let mut state = HashMap::new();
        let inv = 1.0 / dt;
        let store = self.world.store();

        for id in self.world.bodies() {
            let name = self.body_name.get(&id).expect("unnamed body in world").clone();
            let body = store.body(id);
            let p = body.get_position();
            let lv = body.get_linear_velocity();
            let wc = body.get_world_center();
            let angle = body.get_angle();
            let w = body.get_angular_velocity();
            let awake = body.is_awake();
            let mass = body.get_mass();
            let inertia = body.get_inertia();
            let pre = format!("s{si}.body.{name}.");
            self.log.num(format!("{pre}px"), p.x);
            self.log.num(format!("{pre}py"), p.y);
            self.log.num(format!("{pre}a"), angle);
            self.log.num(format!("{pre}vx"), lv.x);
            self.log.num(format!("{pre}vy"), lv.y);
            self.log.num(format!("{pre}w"), w);
            self.log.num(format!("{pre}cx"), wc.x);
            self.log.num(format!("{pre}cy"), wc.y);
            self.log.flag(format!("{pre}awake"), awake);
            self.log.num(format!("{pre}mass"), mass);
            self.log.num(format!("{pre}inertia"), inertia);
            state.insert(
                name,
                BodyState { px: p.x, py: p.y, a: angle, vx: lv.x, vy: lv.y, w },
            );
            let fixtures: Vec<FixtureId> = store.body(id).iter_fixtures().collect();
            for fid in fixtures {
                let fname = self.fix_info.get(&fid).map_or("__none", |i| i.name.as_str());
                let aabb = store.fixture(fid).get_aabb();
                let fp = format!("s{si}.fix.{fname}.");
                self.log.num(format!("{fp}lx"), aabb.lower_bound.x);
                self.log.num(format!("{fp}ly"), aabb.lower_bound.y);
                self.log.num(format!("{fp}ux"), aabb.upper_bound.x);
                self.log.num(format!("{fp}uy"), aabb.upper_bound.y);
            }
        }

        for (i, cid) in self.world.contacts().enumerate() {
            let c = store.contact(cid);
            let m = c.get_manifold();
            let cp = format!("s{si}.c{i}.");
            let fa = fix_index(&self.fix_info, c.get_fixture_a());
            let fb = fix_index(&self.fix_info, c.get_fixture_b());
            let mt = match m.manifold_type {
                None => -1.0,
                Some(ManifoldType::Circles) => 1.0,
                Some(ManifoldType::FaceA) => 2.0,
                Some(ManifoldType::FaceB) => 4.0,
            };
            let pc = m.point_count as usize;
            self.log.num(format!("{cp}fa"), fa);
            self.log.num(format!("{cp}fb"), fb);
            self.log.flag(format!("{cp}touch"), c.is_touching());
            self.log.flag(format!("{cp}en"), c.is_enabled());
            self.log.num(format!("{cp}mt"), mt);
            self.log.num(format!("{cp}pc"), pc as f64);
            self.log.num(format!("{cp}nx"), m.local_normal.x);
            self.log.num(format!("{cp}ny"), m.local_normal.y);
            self.log.num(format!("{cp}lx"), m.local_point.x);
            self.log.num(format!("{cp}ly"), m.local_point.y);
            for j in 0..pc {
                let mp = &m.points[j];
                self.log.num(format!("{cp}p{j}.lx"), mp.local_point.x);
                self.log.num(format!("{cp}p{j}.ly"), mp.local_point.y);
                self.log.num(format!("{cp}p{j}.id"), mp.id.key as f64);
                self.log.num(format!("{cp}p{j}.ni"), mp.normal_impulse);
                self.log.num(format!("{cp}p{j}.ti"), mp.tangent_impulse);
            }
            if pc > 0 {
                let wm = contact::world_manifold(store, cid);
                self.log.num(format!("{cp}wn.x"), wm.normal.x);
                self.log.num(format!("{cp}wn.y"), wm.normal.y);
                for j in 0..pc {
                    self.log.num(format!("{cp}wp{j}.x"), wm.points[j].x);
                    self.log.num(format!("{cp}wp{j}.y"), wm.points[j].y);
                }
            }
        }

        for jid in self.world.joints() {
            let name = self.joint_name.get(&jid).expect("unnamed joint in world").clone();
            let joint = store.joint(jid);
            let jp = format!("s{si}.j.{name}.");
            let a = joints::get_anchor_a(store, jid);
            let bb = joints::get_anchor_b(store, jid);
            let r = joints::get_reaction_force(store, jid, inv);
            let rt = joints::get_reaction_torque(store, jid, inv);
            self.log.num(format!("{jp}ax"), a.x);
            self.log.num(format!("{jp}ay"), a.y);
            self.log.num(format!("{jp}bx"), bb.x);
            self.log.num(format!("{jp}by"), bb.y);
            self.log.num(format!("{jp}rx"), r.x);
            self.log.num(format!("{jp}ry"), r.y);
            self.log.num(format!("{jp}rt"), rt);
            match joint {
                Joint::Distance(d) => {
                    self.log.num(format!("{jp}len"), d.get_length());
                }
                Joint::Revolute(rj) => {
                    self.log.num(format!("{jp}ang"), rj.get_joint_angle(store));
                    self.log.num(format!("{jp}spd"), rj.get_joint_speed(store));
                    self.log.num(format!("{jp}mt"), rj.get_motor_torque());
                }
                Joint::Prismatic(pj) => {
                    self.log.num(format!("{jp}tr"), pj.get_joint_translation(store));
                    self.log.num(format!("{jp}spd"), pj.get_joint_speed(store));
                    self.log.num(format!("{jp}mf"), pj.get_motor_force());
                }
            }
        }
        state
    }

    /// run.cjs `runScenario` main loop.
    fn run(mut self) -> Records {
        let sc = self.sc;
        let persistent = match fstr(&sc["mode"]) {
            "persistent" => true,
            "rebuild" => false,
            other => panic!("bad mode {other}"),
        };
        if persistent {
            self.create_bodies(None);
            self.bind_ground();
            self.create_joints();
        }
        if !persistent {
            assert!(farr(&sc["joints"]).is_empty(), "joints not allowed in rebuild mode");
        }
        let mut prev: Option<HashMap<String, BodyState>> = None;
        for (si, st) in farr(&sc["steps"]).iter().enumerate() {
            self.log.step = si;
            self.log.ev = 0;
            if !persistent {
                self.world.reset();
                self.world.set_gravity(fvec(&sc["gravity"]));
                self.reset_maps();
                self.create_bodies(prev.as_ref());
                self.bind_ground();
            }
            for c in farr(&st["before"]) {
                self.run_cmd(c);
            }
            let dt = fnum(&st["dt"]);
            let vel = fnum(&st["velIterations"]) as i32;
            let pos = fnum(&st["posIterations"]) as i32;
            {
                let mut listener = Listener {
                    log: &mut self.log,
                    fix_info: &self.fix_info,
                    rules: self.rules,
                    events: self.events,
                };
                self.world.step(dt, vel, pos, &mut listener);
            }
            for c in farr(&st["after"]) {
                self.run_cmd(c);
            }
            prev = Some(self.snapshot(si, dt));
        }
        self.log.recs
    }
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

fn load_trace(path: &Path) -> Records {
    let file = File::open(path).unwrap_or_else(|e| panic!("open {}: {e}", path.display()));
    let doc: Value = serde_json::from_reader(BufReader::new(GzDecoder::new(file)))
        .unwrap_or_else(|e| panic!("parse {}: {e}", path.display()));
    farr(&doc["records"])
        .iter()
        .map(|r| {
            let key = fstr(&r[0]).to_owned();
            let h = fstr(&r[1]);
            let digits = h.strip_prefix("0x").unwrap_or_else(|| panic!("bad hex {h}"));
            let bits = u64::from_str_radix(digits, 16).unwrap_or_else(|e| panic!("bad hex {h}: {e}"));
            (key, bits)
        })
        .collect()
}

fn hex(bits: u64) -> String {
    format!("0x{bits:016x}")
}

/// Step index encoded in a record key `s<S>.…`, or `-` for keys without one.
fn step_of(key: &str) -> String {
    let rest = match key.strip_prefix('s') {
        Some(r) => r,
        None => return "-".to_owned(),
    };
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() || !rest[digits.len()..].starts_with('.') {
        "-".to_owned()
    } else {
        digits
    }
}

/// Ok(record count) when identical; otherwise a report of the first mismatch.
fn compare(actual: &Records, expected: &Records) -> Result<usize, String> {
    for (i, (a, e)) in actual.iter().zip(expected.iter()).enumerate() {
        if a != e {
            return Err(format!(
                "{i} records match before the first mismatch (record #{i}, step {}): \
                 expected `{}` = {} ({}), actual `{}` = {} ({})",
                step_of(&e.0),
                e.0,
                hex(e.1),
                f64::from_bits(e.1),
                a.0,
                hex(a.1),
                f64::from_bits(a.1),
            ));
        }
    }
    if actual.len() != expected.len() {
        let i = actual.len().min(expected.len());
        return Err(format!(
            "{i} records match, then record count differs: expected {}, actual {}",
            expected.len(),
            actual.len()
        ));
    }
    Ok(actual.len())
}

#[test]
fn box2dweb_reference_traces() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let scen_dir = root.join("../../tools/box2d-ref/scenarios");
    let fix_dir = root.join("tests/fixtures");
    let filter = std::env::var("NEOBOX_B2").ok();

    let mut names: Vec<String> = fs::read_dir(&scen_dir)
        .unwrap_or_else(|e| panic!("read {}: {e}", scen_dir.display()))
        .map(|e| e.expect("read_dir entry").path())
        .filter(|p| p.extension().and_then(|x| x.to_str()) == Some("json"))
        .map(|p| p.file_stem().expect("file stem").to_string_lossy().into_owned())
        .collect();
    names.sort();
    if let Some(f) = &filter {
        names.retain(|n| n.contains(f.as_str()));
    }
    assert!(!names.is_empty(), "no scenarios match NEOBOX_B2={filter:?}");

    let mut report: Vec<String> = Vec::new();
    let mut failed = 0usize;
    for name in &names {
        let text = fs::read_to_string(scen_dir.join(format!("{name}.json")))
            .unwrap_or_else(|e| panic!("read scenario {name}: {e}"));
        let sc: Value = serde_json::from_str(&text).unwrap_or_else(|e| panic!("parse scenario {name}: {e}"));
        assert_eq!(fstr(&sc["name"]), name, "scenario file {name}.json declares another name");

        let steps = farr(&sc["steps"]).len();
        let actual = Run::new(&sc).run();
        let expected = load_trace(&fix_dir.join(format!("{name}.trace.json.gz")));
        match compare(&actual, &expected) {
            Ok(n) => report.push(format!("{name}: OK steps={steps} records={n}")),
            Err(why) => {
                failed += 1;
                report.push(format!("{name}: MISMATCH steps={steps} {why}"));
            }
        }
    }
    for line in &report {
        println!("{line}");
    }
    assert!(
        failed == 0,
        "{failed} of {} scenario(s) differ from box2dweb:\n{}",
        names.len(),
        report.join("\n")
    );
}
