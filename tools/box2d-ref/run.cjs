#!/usr/bin/env node
/*
 * Box2D reference trace recorder (Neobox port oracle).
 *
 * Runs the ORIGINAL archived, patched Box2D library (Box2DFlash 2.1a-derived,
 * minified) in a Node vm context and writes bit-exact traces that the Rust port
 * is checked against.
 *
 *   node tools/box2d-ref/run.cjs            # every scenarios/*.json
 *   node tools/box2d-ref/run.cjs a b        # only scenarios/a.json, scenarios/b.json
 *
 * Library: $BOX2D_LIB or C:/Users/aggressivecombo/hitbox-everything/evidence/public-client/Box2D.min.js
 * (loaded fresh per scenario: the warm-start/continuous flags are library statics).
 * Output: crates/box2d/tests/fixtures/<name>.trace.json.gz (relative to this file; gzip, zlib).
 *
 * ---------------------------------------------------------------------------
 * SCENARIO SCHEMA (scenarios/<name>.json)
 * {
 *   "name": "<file basename>",
 *   "mode": "persistent" | "rebuild",
 *   "gravity": [gx, gy],
 *   "doSleep": bool,                  // new b2World(gravity, doSleep)
 *   "warmStarting": bool,             // world.SetWarmStarting(b) after construction
 *   "continuousPhysics": bool,        // world.SetContinuousPhysics(b) after construction
 *   "listener": { "events": bool, "disable": [rule...] }   // optional
 *       rule = {"fixtures":[fa,fb]}  (unordered name pair) | {"categoryBits": n}
 *       (disables contact when (fA.categoryBits & n) || (fB.categoryBits & n))
 *       PreSolve applies rules even when events=false. Sensors never reach PreSolve.
 *   "bodies": [ { "name", "def": {type, position, angle, linearVelocity, angularVelocity,
 *                 linearDamping, angularDamping, fixedRotation, bullet, allowSleep, awake, active},
 *                 "fixtures": [ {"name", "shape", "density", "friction", "restitution",
 *                                "isSensor", "filter": {categoryBits, maskBits, groupIndex}} ] } ],
 *   "joints": [ ... ],                // persistent mode only; created after all bodies
 *   "steps": [ { "dt", "velIterations", "posIterations", "before": [CMD], "after": [CMD] } ]
 * }
 * SHAPE: box{hx,hy} (SetAsBox) | orientedBox{hx,hy,center,angle} | polygon{vertices} (SetAsArray,
 *        body-local) | circle{radius,center} (b2CircleShape + SetLocalPosition)
 * JOINT: distance{name,bodyA,bodyB,anchorA,anchorB,length?,frequencyHz,dampingRatio,collideConnected}
 *        revolute{name,bodyA,bodyB,anchor,enableLimit,lowerAngle,upperAngle,enableMotor,motorSpeed,
 *                 maxMotorTorque,collideConnected}
 *        prismatic{name,bodyA,bodyB,anchor,axis,enableLimit,lowerTranslation,upperTranslation,
 *                  enableMotor,motorSpeed,maxMotorForce,collideConnected}
 * CMD: applyForce{body,force,point} applyImpulse{body,impulse,point} applyTorque{body,torque}
 *      setLinearVelocity{body,v} setAngularVelocity{body,w} setTransform{body,position,angle}
 *      (SetPosition + SetAngle) setAwake{body,awake} setFixedRotation{body,flag}
 *      setLinearDamping{body,value} setAngularDamping{body,value}
 *      setFilter{fixture,filter} (fixture.SetFilterData; library bug: contacts NOT refiltered)
 *      jointSetMotorSpeed{joint,speed} jointSetMaxMotorTorque{joint,value}
 *      jointSetMaxMotorForce{joint,value} clearForces{} (world.ClearForces)
 *      rayCast{name,p1,p2,returns: minusOne|zero|fraction|one}
 *      queryAABB{name,aabb:[lx,ly,ux,uy]}  (callback returns true)
 *      Ray callback policy: minusOne->-1, zero->0, fraction->fraction, one->1.
 * MODES
 *   persistent: one world; bodies then joints created once; per step: before, Step, after, snapshot.
 *   rebuild:    before EVERY step: world.novakReset(); SetGravity; SetContactListener (if any);
 *               recreate all bodies+fixtures in declaration order. Step 0 uses declared defs;
 *               step k>0 uses the previous snapshot's position/angle/linear+angular velocity.
 *               No joints. Ground body is recreated by novakReset.
 * Fixture index: global, declaration order (body order, then fixture order). Body/fixture/joint
 * names are globally unique. Unnamed fixtures would be "__none" (generator always names them).
 *
 * ---------------------------------------------------------------------------
 * TRACE FORMAT: {"name","mode","steps":<count>,"records":[[key,hex],...]}
 * Encoding: every value is an f64, written as "0x" + 16 hex digits of its IEEE-754 bits
 * (DataView setFloat64 / getBigUint64, big-endian bit pattern). Booleans -> 1/0.
 * Integers/indices/ids are f64 too. NaN payloads are whatever V8 writes (canonical NaN).
 * Records are one sequential log in emission order.
 *
 * KEYS
 *  Ray command n (emitted when the command runs; invocations buffered so count comes first):
 *    ray.n.count ; ray.n.k.f,.px,.py,.nx,.ny,.fr,.ret   (k = 0-based callback invocation)
 *  Query command n:  qry.n.count ; qry.n.k.f
 *  Events during Step, global per-step counter e reset each step (S = step index):
 *    s<S>.ev.<e>.t  (0 Begin, 1 End, 2 Pre, 3 Post), .fa, .fb  (fixture indices A/B)
 *    Pre : .oldpc (oldManifold.m_pointCount), .en (IsEnabled() on entry, before rules)
 *    Post: .pc (manifold m_pointCount), per j: .p<j>.ni, .p<j>.ti (impulse arg)
 *  Snapshot after step S (after its "after" commands):
 *    s<S>.body.<name>.px,.py (GetPosition) .a (GetAngle) .vx,.vy (GetLinearVelocity)
 *        .w (GetAngularVelocity) .cx,.cy (GetWorldCenter) .awake (IsAwake)
 *        .mass (GetMass) .inertia (GetInertia)        -- body list order, ground "__ground" included
 *    s<S>.fix.<fname>.lx,.ly,.ux,.uy (GetAABB)         -- GetFixtureList order under each body
 *    s<S>.c<i>.fa,.fb,.touch,.en,.mt,.pc,.nx,.ny,.lx,.ly   -- contact list order
 *        .nx,.ny = manifold.m_localPlaneNormal ; .lx,.ly = manifold.m_localPoint
 *        .mt = manifold.m_type raw (1 circles, 2 faceA, 4 faceB), -1 if undefined
 *        per j<pc: .p<j>.lx,.ly (m_points[j].m_localPoint), .p<j>.id (m_points[j].m_id.key),
 *                  .p<j>.ni,.p<j>.ti (m_normalImpulse, m_tangentImpulse)
 *        if pc>0: GetWorldManifold(wm): .wn.x,.wn.y ; per j: .wp<j>.x,.wp<j>.y
 *        (NO .sep: archived b2WorldManifold has only m_normal/m_points; no m_separations exists)
 *    s<S>.j.<name>.ax,.ay (GetAnchorA) .bx,.by (GetAnchorB) .rx,.ry (GetReactionForce(1/dt))
 *        .rt (GetReactionTorque(1/dt)), then by type (GetType: 1 revolute, 2 prismatic, 3 distance):
 *        distance : .len (GetLength)
 *        revolute : .ang (GetJointAngle) .spd (GetJointSpeed) .mt (GetMotorTorque(1/dt))
 *        prismatic: .tr (GetJointTranslation) .spd (GetJointSpeed) .mf (GetMotorForce(1/dt))
 *
 * ---------------------------------------------------------------------------
 * API SUBSTITUTIONS / NOTES (archived library, verified by grep of beaut.js)
 *  - Warm-start / continuous: statics on b2World; set via world.SetWarmStarting / SetContinuousPhysics.
 *  - Angle: body.GetAngle() (= sweep.a). b2Mat22/b2Transform GetAngle NOT used (SafeTrig case bug).
 *  - Joint GetMotorTorque(t) ignores its argument in the library and returns m_maxMotorTorque;
 *    prismatic GetMotorForce(t) ignores its argument and returns m_motorImpulse (unscaled).
 *    Both recorded as the library returns them.
 *  - setTransform uses body.SetPosition + body.SetAngle (exists).
 *  - Fixture SetFilterData: guarded by `if(!this.m_body)` (never true), so existing contacts are
 *    NOT flagged for refiltering. Recorded as the library behaves.
 *  - Contact listener is a b2ContactListener instance with overridden methods; the library
 *    calls BeginContact(c), EndContact(c), PreSolve(c, oldManifold), PostSolve(c, impulse).
 *  - Body list: CreateBody prepends, so the trace order is the library's list order.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');

const LIB_PATH =
  process.env.BOX2D_LIB ||
  'C:/Users/aggressivecombo/hitbox-everything/evidence/public-client/Box2D.min.js';
const SCEN_DIR = path.join(__dirname, 'scenarios');
const OUT_DIR = path.join(__dirname, '..', '..', 'crates', 'box2d', 'tests', 'fixtures');

const BODY_TYPE = { static: 0, kinematic: 1, dynamic: 2 };
const TRUE_BITS = '0x3ff0000000000000';

function loadBox2D() {
  const code = fs.readFileSync(LIB_PATH, 'utf8');
  const ctx = {};
  ctx.window = ctx;
  ctx.self = ctx;
  vm.createContext(ctx);
  vm.runInContext(code, ctx, { filename: LIB_PATH });
  if (!ctx.Box2D) throw new Error('Box2D global not defined after loading ' + LIB_PATH);
  return ctx.Box2D;
}

const dv = new DataView(new ArrayBuffer(8));
function hex(v) {
  let x;
  if (typeof v === 'boolean') x = v ? 1 : 0;
  else if (typeof v === 'number') x = v;
  else throw new Error('non-numeric trace value: ' + String(v));
  dv.setFloat64(0, x);
  return '0x' + dv.getBigUint64(0).toString(16).padStart(16, '0');
}

function setIf(target, src, keys) {
  for (const k of keys) if (src[k] !== undefined) target[k] = src[k];
}

function validate(sc) {
  if (sc.mode !== 'persistent' && sc.mode !== 'rebuild') throw new Error('bad mode ' + sc.mode);
  if (sc.mode === 'rebuild' && sc.joints && sc.joints.length) throw new Error('joints not allowed in rebuild');
  const bodyNames = new Set();
  const fixNames = new Set();
  for (const b of sc.bodies) {
    if (bodyNames.has(b.name) || b.name === '__ground') throw new Error('duplicate body ' + b.name);
    bodyNames.add(b.name);
    for (const f of b.fixtures) {
      if (fixNames.has(f.name)) throw new Error('duplicate fixture ' + f.name);
      fixNames.add(f.name);
    }
  }
  const jointNames = new Set();
  for (const j of sc.joints || []) {
    if (jointNames.has(j.name)) throw new Error('duplicate joint ' + j.name);
    jointNames.add(j.name);
  }
}

function runScenario(sc) {
  validate(sc);
  const B = loadBox2D();
  const V = B.Common.Math.b2Vec2;
  const Dyn = B.Dynamics;
  const Shapes = B.Collision.Shapes;
  const Joints = B.Dynamics.Joints;
  const persistent = sc.mode === 'persistent';

  // global fixture index (declaration order), stable across rebuilds
  const fixIndexByName = new Map();
  {
    let i = 0;
    for (const b of sc.bodies) for (const f of b.fixtures) fixIndexByName.set(f.name, i++);
  }

  const rec = [];
  const push = (k, v) => rec.push([k, hex(v)]);

  const world = new Dyn.b2World(new V(sc.gravity[0], sc.gravity[1]), sc.doSleep);
  world.SetWarmStarting(sc.warmStarting);
  world.SetContinuousPhysics(sc.continuousPhysics);

  // per-world object maps; rebuilt every step in rebuild mode
  let bodyByName, bodyName, fixByName, fixInfo, jointByName, jointName;
  function resetMaps() {
    bodyByName = new Map();
    bodyName = new Map();
    fixByName = new Map();
    fixInfo = new Map();
    jointByName = new Map();
    jointName = new Map();
  }
  resetMaps();

  const fixIdx = (f) => {
    const info = fixInfo.get(f);
    if (!info) throw new Error('fixture not owned by scenario (ground fixtures unsupported)');
    return info.index;
  };
  const fixNameOf = (f) => {
    const info = fixInfo.get(f);
    if (!info) throw new Error('fixture not owned by scenario');
    return info.name;
  };

  function makeShape(s) {
    if (s.type === 'box') {
      const p = new Shapes.b2PolygonShape();
      p.SetAsBox(s.hx, s.hy);
      return p;
    }
    if (s.type === 'orientedBox') {
      const p = new Shapes.b2PolygonShape();
      p.SetAsOrientedBox(s.hx, s.hy, new V(s.center[0], s.center[1]), s.angle);
      return p;
    }
    if (s.type === 'polygon') {
      const p = new Shapes.b2PolygonShape();
      const arr = s.vertices.map((v) => new V(v[0], v[1]));
      p.SetAsArray(arr, arr.length);
      return p;
    }
    if (s.type === 'circle') {
      const c = new Shapes.b2CircleShape(s.radius);
      c.SetLocalPosition(new V(s.center[0], s.center[1]));
      return c;
    }
    throw new Error('unknown shape ' + s.type);
  }

  function makeFilter(f) {
    const d = new Dyn.b2FilterData();
    setIf(d, f, ['categoryBits', 'maskBits', 'groupIndex']);
    return d;
  }

  function createBodies(prev) {
    for (const b of sc.bodies) {
      const d = b.def;
      const bd = new Dyn.b2BodyDef();
      bd.type = BODY_TYPE[d.type];
      let pos = d.position;
      let ang = d.angle;
      let lv = d.linearVelocity || [0, 0];
      let av = d.angularVelocity;
      if (prev && prev[b.name]) {
        const s = prev[b.name];
        pos = [s.px, s.py];
        ang = s.a;
        lv = [s.vx, s.vy];
        av = s.w;
      }
      bd.position = new V(pos[0], pos[1]);
      if (ang !== undefined) bd.angle = ang;
      bd.linearVelocity = new V(lv[0], lv[1]);
      if (av !== undefined) bd.angularVelocity = av;
      setIf(bd, d, ['linearDamping', 'angularDamping', 'fixedRotation', 'bullet', 'allowSleep', 'awake', 'active']);
      const body = world.CreateBody(bd);
      bodyByName.set(b.name, body);
      bodyName.set(body, b.name);
      for (const f of b.fixtures) {
        const fd = new Dyn.b2FixtureDef();
        fd.shape = makeShape(f.shape);
        setIf(fd, f, ['density', 'friction', 'restitution', 'isSensor']);
        if (f.filter) fd.filter = makeFilter(f.filter);
        const fix = body.CreateFixture(fd);
        fixByName.set(f.name, fix);
        fixInfo.set(fix, { index: fixIndexByName.get(f.name), name: f.name });
      }
    }
  }

  function createJoints() {
    for (const j of sc.joints || []) {
      const bA = bodyByName.get(j.bodyA);
      const bB = bodyByName.get(j.bodyB);
      if (!bA || !bB) throw new Error('joint ' + j.name + ': unknown body');
      let def;
      if (j.type === 'distance') {
        def = new Joints.b2DistanceJointDef();
        def.Initialize(bA, bB, new V(j.anchorA[0], j.anchorA[1]), new V(j.anchorB[0], j.anchorB[1]));
        if (j.length !== undefined) def.length = j.length;
        def.frequencyHz = j.frequencyHz;
        def.dampingRatio = j.dampingRatio;
        def.collideConnected = j.collideConnected;
      } else if (j.type === 'revolute') {
        def = new Joints.b2RevoluteJointDef();
        def.Initialize(bA, bB, new V(j.anchor[0], j.anchor[1]));
        setIf(def, j, ['enableLimit', 'lowerAngle', 'upperAngle', 'enableMotor', 'motorSpeed', 'maxMotorTorque', 'collideConnected']);
      } else if (j.type === 'prismatic') {
        def = new Joints.b2PrismaticJointDef();
        def.Initialize(bA, bB, new V(j.anchor[0], j.anchor[1]), new V(j.axis[0], j.axis[1]));
        setIf(def, j, ['enableLimit', 'lowerTranslation', 'upperTranslation', 'enableMotor', 'motorSpeed', 'maxMotorForce', 'collideConnected']);
      } else {
        throw new Error('unknown joint type ' + j.type);
      }
      const joint = world.CreateJoint(def);
      jointByName.set(j.name, joint);
      jointName.set(joint, j.name);
    }
  }

  // ---- contact listener -------------------------------------------------
  const events = !!(sc.listener && sc.listener.events);
  const rules = (sc.listener && sc.listener.disable) || [];
  let curStep = -1;
  let evCounter = 0;

  function emitEvent(t, contact, extras) {
    const p = 's' + curStep + '.ev.' + evCounter++;
    push(p + '.t', t);
    push(p + '.fa', fixIdx(contact.GetFixtureA()));
    push(p + '.fb', fixIdx(contact.GetFixtureB()));
    for (const [k, v] of extras) push(p + '.' + k, v);
  }

  function shouldDisable(contact) {
    const fa = contact.GetFixtureA();
    const fb = contact.GetFixtureB();
    const na = fixNameOf(fa);
    const nb = fixNameOf(fb);
    for (const r of rules) {
      if (r.fixtures) {
        const [x, y] = r.fixtures;
        if ((na === x && nb === y) || (na === y && nb === x)) return true;
      }
      if (r.categoryBits !== undefined) {
        const ca = fa.GetFilterData().categoryBits;
        const cb = fb.GetFilterData().categoryBits;
        if ((ca & r.categoryBits) || (cb & r.categoryBits)) return true;
      }
    }
    return false;
  }

  function installListener() {
    const L = new Dyn.b2ContactListener();
    if (events) {
      L.BeginContact = (c) => emitEvent(0, c, []);
      L.EndContact = (c) => emitEvent(1, c, []);
      L.PostSolve = (c, impulse) => {
        const pc = c.GetManifold().m_pointCount;
        const extras = [['pc', pc]];
        for (let j = 0; j < pc; j++) {
          extras.push(['p' + j + '.ni', impulse.normalImpulses[j]]);
          extras.push(['p' + j + '.ti', impulse.tangentImpulses[j]]);
        }
        emitEvent(3, c, extras);
      };
    }
    L.PreSolve = (c, oldManifold) => {
      const en = c.IsEnabled();
      if (events) emitEvent(2, c, [['oldpc', oldManifold.m_pointCount], ['en', en]]);
      if (shouldDisable(c)) c.SetEnabled(false);
    };
    world.SetContactListener(L);
  }

  // ---- commands -------------------------------------------------------
  function body(name) {
    const b = bodyByName.get(name);
    if (!b) throw new Error('unknown body ' + name);
    return b;
  }
  function joint(name) {
    const j = jointByName.get(name);
    if (!j) throw new Error('unknown joint ' + name);
    return j;
  }

  function rayCast(c) {
    const hits = [];
    const cb = (fixture, point, normal, fraction) => {
      let ret;
      switch (c.returns) {
        case 'minusOne': ret = -1; break;
        case 'zero': ret = 0; break;
        case 'fraction': ret = fraction; break;
        case 'one': ret = 1; break;
        default: throw new Error('bad returns ' + c.returns);
      }
      hits.push([fixIdx(fixture), point.x, point.y, normal.x, normal.y, fraction, ret]);
      return ret;
    };
    world.RayCast(cb, new V(c.p1[0], c.p1[1]), new V(c.p2[0], c.p2[1]));
    const p = 'ray.' + c.name;
    push(p + '.count', hits.length);
    hits.forEach((h, k) => {
      const q = p + '.' + k;
      push(q + '.f', h[0]);
      push(q + '.px', h[1]);
      push(q + '.py', h[2]);
      push(q + '.nx', h[3]);
      push(q + '.ny', h[4]);
      push(q + '.fr', h[5]);
      push(q + '.ret', h[6]);
    });
  }

  function queryAABB(c) {
    const hits = [];
    const aabb = new B.Collision.b2AABB();
    aabb.lowerBound = new V(c.aabb[0], c.aabb[1]);
    aabb.upperBound = new V(c.aabb[2], c.aabb[3]);
    world.QueryAABB((fixture) => {
      hits.push(fixIdx(fixture));
      return true;
    }, aabb);
    const p = 'qry.' + c.name;
    push(p + '.count', hits.length);
    hits.forEach((f, k) => push(p + '.' + k + '.f', f));
  }

  function runCmd(c) {
    switch (c.op) {
      case 'applyForce': body(c.body).ApplyForce(new V(c.force[0], c.force[1]), new V(c.point[0], c.point[1])); break;
      case 'applyImpulse': body(c.body).ApplyImpulse(new V(c.impulse[0], c.impulse[1]), new V(c.point[0], c.point[1])); break;
      case 'applyTorque': body(c.body).ApplyTorque(c.torque); break;
      case 'setLinearVelocity': body(c.body).SetLinearVelocity(new V(c.v[0], c.v[1])); break;
      case 'setAngularVelocity': body(c.body).SetAngularVelocity(c.w); break;
      case 'setTransform': {
        const b = body(c.body);
        b.SetPosition(new V(c.position[0], c.position[1]));
        b.SetAngle(c.angle);
        break;
      }
      case 'setAwake': body(c.body).SetAwake(c.awake); break;
      case 'setFixedRotation': body(c.body).SetFixedRotation(c.flag); break;
      case 'setLinearDamping': body(c.body).SetLinearDamping(c.value); break;
      case 'setAngularDamping': body(c.body).SetAngularDamping(c.value); break;
      case 'setFilter': {
        const f = fixByName.get(c.fixture);
        if (!f) throw new Error('unknown fixture ' + c.fixture);
        f.SetFilterData(makeFilter(c.filter));
        break;
      }
      case 'jointSetMotorSpeed': joint(c.joint).SetMotorSpeed(c.speed); break;
      case 'jointSetMaxMotorTorque': joint(c.joint).SetMaxMotorTorque(c.value); break;
      case 'jointSetMaxMotorForce': joint(c.joint).SetMaxMotorForce(c.value); break;
      case 'clearForces': world.ClearForces(); break;
      case 'rayCast': rayCast(c); break;
      case 'queryAABB': queryAABB(c); break;
      default: throw new Error('unknown op ' + c.op);
    }
  }

  // ---- snapshot ---------------------------------------------------------
  function snapshot(S, dt) {
    const state = {};
    for (let b = world.GetBodyList(); b; b = b.GetNext()) {
      const name = bodyName.get(b);
      if (name === undefined) throw new Error('unnamed body in world');
      const p = b.GetPosition();
      const lv = b.GetLinearVelocity();
      const wc = b.GetWorldCenter();
      const pre = 's' + S + '.body.' + name + '.';
      push(pre + 'px', p.x);
      push(pre + 'py', p.y);
      push(pre + 'a', b.GetAngle());
      push(pre + 'vx', lv.x);
      push(pre + 'vy', lv.y);
      push(pre + 'w', b.GetAngularVelocity());
      push(pre + 'cx', wc.x);
      push(pre + 'cy', wc.y);
      push(pre + 'awake', b.IsAwake());
      push(pre + 'mass', b.GetMass());
      push(pre + 'inertia', b.GetInertia());
      state[name] = { px: p.x, py: p.y, a: b.GetAngle(), vx: lv.x, vy: lv.y, w: b.GetAngularVelocity() };
      for (let f = b.GetFixtureList(); f; f = f.GetNext()) {
        const fname = fixInfo.get(f) ? fixNameOf(f) : '__none';
        const aabb = f.GetAABB();
        const fp = 's' + S + '.fix.' + fname + '.';
        push(fp + 'lx', aabb.lowerBound.x);
        push(fp + 'ly', aabb.lowerBound.y);
        push(fp + 'ux', aabb.upperBound.x);
        push(fp + 'uy', aabb.upperBound.y);
      }
    }
    let i = 0;
    for (let c = world.GetContactList(); c; c = c.GetNext(), i++) {
      const cp = 's' + S + '.c' + i + '.';
      const m = c.GetManifold();
      push(cp + 'fa', fixIdx(c.GetFixtureA()));
      push(cp + 'fb', fixIdx(c.GetFixtureB()));
      push(cp + 'touch', c.IsTouching());
      push(cp + 'en', c.IsEnabled());
      push(cp + 'mt', m.m_type === undefined || m.m_type === null ? -1 : m.m_type);
      push(cp + 'pc', m.m_pointCount);
      push(cp + 'nx', m.m_localPlaneNormal.x);
      push(cp + 'ny', m.m_localPlaneNormal.y);
      push(cp + 'lx', m.m_localPoint.x);
      push(cp + 'ly', m.m_localPoint.y);
      for (let j = 0; j < m.m_pointCount; j++) {
        const mp = m.m_points[j];
        push(cp + 'p' + j + '.lx', mp.m_localPoint.x);
        push(cp + 'p' + j + '.ly', mp.m_localPoint.y);
        push(cp + 'p' + j + '.id', mp.m_id.key);
        push(cp + 'p' + j + '.ni', mp.m_normalImpulse);
        push(cp + 'p' + j + '.ti', mp.m_tangentImpulse);
      }
      if (m.m_pointCount > 0) {
        const wm = new B.Collision.b2WorldManifold();
        c.GetWorldManifold(wm);
        push(cp + 'wn.x', wm.m_normal.x);
        push(cp + 'wn.y', wm.m_normal.y);
        for (let j = 0; j < m.m_pointCount; j++) {
          push(cp + 'wp' + j + '.x', wm.m_points[j].x);
          push(cp + 'wp' + j + '.y', wm.m_points[j].y);
        }
      }
    }
    const inv = 1 / dt;
    for (let j = world.GetJointList(); j; j = j.GetNext()) {
      const name = jointName.get(j);
      if (name === undefined) throw new Error('unnamed joint in world');
      const jp = 's' + S + '.j.' + name + '.';
      const a = j.GetAnchorA();
      const bb = j.GetAnchorB();
      const r = j.GetReactionForce(inv);
      push(jp + 'ax', a.x);
      push(jp + 'ay', a.y);
      push(jp + 'bx', bb.x);
      push(jp + 'by', bb.y);
      push(jp + 'rx', r.x);
      push(jp + 'ry', r.y);
      push(jp + 'rt', j.GetReactionTorque(inv));
      const t = j.GetType();
      if (t === 3) {
        push(jp + 'len', j.GetLength());
      } else if (t === 1) {
        push(jp + 'ang', j.GetJointAngle());
        push(jp + 'spd', j.GetJointSpeed());
        push(jp + 'mt', j.GetMotorTorque(inv));
      } else if (t === 2) {
        push(jp + 'tr', j.GetJointTranslation());
        push(jp + 'spd', j.GetJointSpeed());
        push(jp + 'mf', j.GetMotorForce(inv));
      } else {
        throw new Error('unknown joint type code ' + t);
      }
    }
    return state;
  }

  // ---- run ----------------------------------------------------------------
  if (persistent) {
    if (sc.listener) installListener();
    createBodies(null);
    bodyName.set(world.GetGroundBody(), '__ground');
    createJoints();
  }

  let prev = null;
  for (let S = 0; S < sc.steps.length; S++) {
    const st = sc.steps[S];
    curStep = S;
    evCounter = 0;
    if (!persistent) {
      world.novakReset();
      world.SetGravity(new V(sc.gravity[0], sc.gravity[1]));
      if (sc.listener) installListener();
      resetMaps();
      createBodies(prev);
      bodyName.set(world.GetGroundBody(), '__ground');
    }
    for (const c of st.before || []) runCmd(c);
    world.Step(st.dt, st.velIterations, st.posIterations);
    for (const c of st.after || []) runCmd(c);
    prev = snapshot(S, st.dt);
  }

  return { name: sc.name, mode: sc.mode, steps: sc.steps.length, records: rec };
}

function writeTrace(out) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const lines = out.records.map((r) => '  ' + JSON.stringify(r));
  const body =
    '{"name":' + JSON.stringify(out.name) +
    ',"mode":' + JSON.stringify(out.mode) +
    ',"steps":' + out.steps +
    ',"records":[\n' + lines.join(',\n') + '\n]}\n';
  const file = path.join(OUT_DIR, out.name + '.trace.json.gz');
  fs.writeFileSync(file, zlib.gzipSync(body));
  return file;
}

function main() {
  const argv = process.argv.slice(2);
  const names = argv.length
    ? argv.map((a) => a.replace(/\.json$/, ''))
    : fs.readdirSync(SCEN_DIR).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
  let totalSteps = 0;
  let totalRecords = 0;
  for (const n of names) {
    const sc = JSON.parse(fs.readFileSync(path.join(SCEN_DIR, n + '.json'), 'utf8'));
    if (sc.name !== n) throw new Error(`scenario file ${n}.json declares name ${sc.name}`);
    const out = runScenario(sc);
    const file = writeTrace(out);
    totalSteps += out.steps;
    totalRecords += out.records.length;
    console.log(`${n}: steps=${out.steps} records=${out.records.length} -> ${path.relative(process.cwd(), file)}`);
  }
  console.log(`total: scenarios=${names.length} steps=${totalSteps} records=${totalRecords}`);
}

if (require.main === module) main();

module.exports = { loadBox2D, hex, runScenario };
