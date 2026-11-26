// Map JSON as the sim reads it (crates/sim/src/map.rs). The file format keys every
// object with short numeric strings. This module is the only place those strings
// appear: the constants below give each one a name, and the rest of the client
// uses the names. A field equal to its default is left out on write, like the
// original writer; unknown keys survive every edit untouched.
// Original bundle names of these keys: docs/ORIGINAL-NAMES.md.

export type Obj = Record<string, unknown>;

/** Top-level keys of a map: the entity lists and the settings object. */
export const MAP = {
  bodies: "b",
  joints: "j",
  spawns: "s",
  turrets: "tu",
  grapples: "gp",
  caps: "c",
  settings: "set",
} as const;

/** Map arrays the editor edits; `MAP.settings` holds the map settings object. */
export const LIST_KEYS = [MAP.bodies, MAP.joints, MAP.spawns, MAP.turrets, MAP.grapples, MAP.caps] as const;
export type ListKey = (typeof LIST_KEYS)[number];

/** Body keys. Motion and collision values are read by the sim (crates/sim/src/map.rs). */
export const BODY = {
  id: "1",
  x: "2",
  y: "3",
  angle: "4",
  /** Start spin (rad/s). */
  angularVelocity: "5",
  /** Start velocity. */
  velocityX: "6",
  velocityY: "7",
  density: "8",
  restitution: "9",
  friction: "10",
  linearDamping: "11",
  angularDamping: "12",
  killsPlayers: "13",
  /** 0 static, 1 kinematic, 2 dynamic. */
  motion: "14",
  wrap: "15",
  /** Sim field with no editor meaning. */
  flag16: "16",
  forceX: "17",
  forceY: "18",
  torque: "19",
  damage: "20",
  dynamicThreshold: "21",
  removalThreshold: "22",
  /** No physics at all. */
  scenery: "23",
  zIndex: "24",
  /** Collision group: "a".."d". */
  group: "25",
  collideA: "26",
  collideB: "27",
  collideC: "28",
  collideD: "29",
  playerPass: "30",
  checkpoint: "31",
  freezePlayers: "32",
  raceObject: "34",
  pinned: "36",
  pinX: "37",
  pinY: "38",
  forceZone: "39",
  zoneX: "40",
  zoneY: "41",
  noJump: "43",
  raceProgress: "44",
  continuousCollision: "45",
  invisible: "50",
  parallax: "55",
  lifetime: "56",
  fixedRotation: "57",
  sourcePlayer: "58",
  abilityImmune: "60",
  objective: "61",
  objectiveTarget: "62",
  /** Sim field with no editor meaning. */
  flag63: "63",
  /** Impact-sound limiter state. */
  impactLimiter: "64",
  projectilePass: "65",
  /** The body's shapes (array). */
  shapes: "s",
} as const;

/** Shape keys (an entry of a body's shapes array). */
export const SHAPE = {
  /** 0 polygon, 1 circle. */
  kind: "1",
  /** Offset in the body's frame. */
  x: "2",
  y: "3",
  /** Per-shape material overrides; absent means the body's value. */
  density: "4",
  friction: "5",
  restitution: "6",
  /** Colour, 0xRRGGBB. */
  color: "7",
  /** Polygon is solid; an open polygon creates no fixture. */
  closed: "8",
  radius: "9",
  /** Editor/render fields the editor does not name. */
  editor11: "11",
  editor12: "12",
  editor13: "13",
  noPhysics: "14",
  zIndex: "15",
  /** Polygon vertices, local to the shape offset (flat array). */
  points: "p",
} as const;

/** Joint keys. */
export const JOINT = {
  /** Anchor on body A (local). */
  anchorAX: "1",
  anchorAY: "2",
  /** Anchor on body B (local). */
  anchorBX: "3",
  anchorBY: "4",
  /** 0 spring, 1 pivot, 2 slider. */
  kind: "5",
  collideConnected: "6",
  /** Body ids (-1 is the ground). */
  bodyA: "7",
  bodyB: "8",
  frequency: "9",
  damping: "10",
  length: "11",
  motorSpeed: "12",
  maxMotor: "13",
  /** Player id overriding body A (-1 none). */
  playerA: "14",
  /** Sim field with no editor meaning. */
  flag15: "15",
  /** 0 none, 1 stop, 2 ping-pong, 3 latch. */
  motorMode: "16",
  latched: "17",
  /** Slider axis end point (body A local). */
  axisX: "18",
  axisY: "19",
} as const;

/** Spawn keys. */
export const SPAWN = {
  x: "1",
  y: "2",
  priority: "3",
  angle: "4",
  /** Team usage flags. */
  teamFreeForAll: "5",
  teamRed: "6",
  teamBlue: "7",
  /** Capture-point sequence (-2 none). */
  capSequence: "8",
} as const;

/** Turret keys. Keys 12-23 are the projectile the turret fires. */
export const TURRET = {
  x: "1",
  y: "2",
  vx: "3",
  vy: "4",
  angle: "5",
  angularVelocity: "6",
  health: "7",
  cooldown: "8",
  team: "9",
  fireInterval: "10",
  range: "11",
  bulletVx: "12",
  bulletSize: "13",
  bulletDensity: "14",
  bulletFriction: "15",
  bulletRestitution: "16",
  bulletLife: "17",
  bulletDamage: "18",
  bulletTurnRate: "19",
  bulletExplodeRadius: "20",
  bulletBounces: "21",
  bulletShape: "22",
  bulletLinearDamping: "23",
  maxHealth: "24",
} as const;

/** Grapple point keys. */
export const GRAPPLE = {
  x: "1",
  y: "2",
  range: "3",
  /** Attached body id (-1 is the world). */
  body: "4",
} as const;

/** Anchored markers (spawn, turret, grapple, capture point) keep their position at keys 1 and 2. */
export const MARKER = {
  x: "1",
  y: "2",
} as const;

/** Capture point keys. */
export const CAP = {
  x: "1",
  y: "2",
  width: "3",
  /** Sequence number (-1 none). */
  sequence: "4",
  /** Owner team. */
  owner: "5",
  /** Team currently capturing. */
  capturer: "6",
  captureTime: "7",
  progress: "8",
} as const;

/** Map settings keys (the `set` object). */
export const SETTINGS = {
  screenWidth: "3",
  snap: "4",
  /** Unused enum, kept for round-trips. */
  unused5: "5",
  bgOffsetX: "7",
  bgOffsetY: "8",
  bgImage: "9",
  bgScale: "10",
  parallax: "11",
  colorTop: "12",
  /** Sim flag with no editor meaning. */
  flag13: "13",
  width: "15",
  height: "16",
  colorBottom: "17",
  gravity: "18",
  wrap: "19",
  /** Neobox key (not numeric): "wide" selects the 16:9 view. */
  aspect: "aspect",
} as const;

/** Joint kinds (`JOINT.kind`). */
export const JOINT_KINDS = [
  { value: 0, label: "Spring" },
  { value: 1, label: "Pivot" },
  { value: 2, label: "Slider" },
] as const;

/** Body motion types (`BODY.motion`). */
export const MOTION_STATIC = 0;
export const MOTION_KINEMATIC = 1;
export const MOTION_DYNAMIC = 2;

export const MOTOR_MODES = [
  { value: 0, label: "None" },
  { value: 1, label: "Stop" },
  { value: 2, label: "Ping-pong" },
  { value: 3, label: "Latch" },
] as const;

export const TEAM_SPAWNS = [
  { value: "ffa", label: "Free for all" },
  { value: "red", label: "Red" },
  { value: "blue", label: "Blue" },
] as const;

/** Sim limits (crates/sim/src/map.rs). */
export const MAX_OBJECT_ID = 65535;
export const MAX_SHAPES = 65536;
export const MAX_VERTICES = 1048576;

/** Body defaults (sim BodyDef::default). */
export const BODY_DEFAULTS: Obj = {
  [BODY.angle]: 0,
  [BODY.angularVelocity]: 0,
  [BODY.velocityX]: 0,
  [BODY.velocityY]: 0,
  [BODY.density]: 1,
  [BODY.restitution]: 0.5,
  [BODY.friction]: 0.5,
  [BODY.linearDamping]: 0.3,
  [BODY.angularDamping]: 0.5,
  [BODY.killsPlayers]: false,
  [BODY.motion]: MOTION_STATIC,
  [BODY.wrap]: false,
  [BODY.flag16]: false,
  [BODY.forceX]: 0,
  [BODY.forceY]: 0,
  [BODY.torque]: 0,
  [BODY.damage]: 0,
  [BODY.dynamicThreshold]: 0,
  [BODY.removalThreshold]: 0,
  [BODY.scenery]: false,
  [BODY.zIndex]: 0,
  [BODY.group]: "a",
  [BODY.collideA]: true,
  [BODY.collideB]: true,
  [BODY.collideC]: true,
  [BODY.collideD]: true,
  [BODY.playerPass]: 0,
  [BODY.pinned]: false,
  [BODY.pinX]: 0,
  [BODY.pinY]: 0,
  [BODY.forceZone]: false,
  [BODY.zoneX]: 0,
  [BODY.zoneY]: 0,
  [BODY.freezePlayers]: false,
  [BODY.noJump]: false,
  [BODY.continuousCollision]: false,
  [BODY.invisible]: false,
  [BODY.parallax]: 0,
  [BODY.lifetime]: -1,
  [BODY.fixedRotation]: false,
  [BODY.sourcePlayer]: -1,
  [BODY.abilityImmune]: false,
  [BODY.objective]: 0,
  [BODY.objectiveTarget]: 0,
  [BODY.flag63]: true,
  [BODY.impactLimiter]: 1,
  [BODY.projectilePass]: 0,
};

/** Shape defaults. Keys 4, 5, 6 (density, friction, restitution) inherit from the body when absent. */
export const SHAPE_DEFAULTS: Obj = {
  [SHAPE.kind]: 0,
  [SHAPE.x]: 0,
  [SHAPE.y]: 0,
  [SHAPE.color]: 4627659,
  [SHAPE.closed]: true,
  [SHAPE.radius]: 0,
  [SHAPE.noPhysics]: false,
  [SHAPE.zIndex]: 0,
};

export const JOINT_DEFAULTS: Obj = {
  [JOINT.anchorAX]: 0,
  [JOINT.anchorAY]: 0,
  [JOINT.anchorBX]: 0,
  [JOINT.anchorBY]: 0,
  [JOINT.kind]: 0,
  [JOINT.collideConnected]: true,
  [JOINT.bodyA]: -1,
  [JOINT.bodyB]: -1,
  [JOINT.frequency]: 0.5,
  [JOINT.damping]: 0.5,
  [JOINT.length]: 0.5,
  [JOINT.motorSpeed]: 0,
  [JOINT.maxMotor]: 0,
  [JOINT.playerA]: -1,
  [JOINT.motorMode]: 0,
  [JOINT.latched]: false,
  [JOINT.axisX]: 0,
  [JOINT.axisY]: 0,
};

export const SPAWN_DEFAULTS: Obj = {
  [SPAWN.priority]: 0,
  [SPAWN.angle]: 0,
  [SPAWN.teamFreeForAll]: true,
  [SPAWN.teamRed]: false,
  [SPAWN.teamBlue]: false,
  [SPAWN.capSequence]: -2,
};

export const TURRET_DEFAULTS: Obj = {
  [TURRET.x]: 0,
  [TURRET.y]: 0,
  [TURRET.vx]: 0,
  [TURRET.vy]: 0,
  [TURRET.angle]: 0,
  [TURRET.angularVelocity]: 0,
  [TURRET.health]: 20,
  [TURRET.cooldown]: 0,
  [TURRET.team]: 1,
  [TURRET.fireInterval]: 10,
  [TURRET.range]: 5,
  [TURRET.bulletVx]: 0,
  [TURRET.bulletSize]: 0.1,
  [TURRET.bulletDensity]: 5,
  [TURRET.bulletFriction]: 0.5,
  [TURRET.bulletRestitution]: 0,
  [TURRET.bulletLife]: 300,
  [TURRET.bulletDamage]: 1,
  [TURRET.bulletTurnRate]: 0,
  [TURRET.bulletExplodeRadius]: 0,
  [TURRET.bulletBounces]: false,
  [TURRET.bulletShape]: 0,
  [TURRET.bulletLinearDamping]: 0,
  [TURRET.maxHealth]: 20,
};

export const GRAPPLE_DEFAULTS: Obj = { [GRAPPLE.range]: 5, [GRAPPLE.body]: -1 };

export const CAP_DEFAULTS: Obj = {
  [CAP.width]: 3,
  [CAP.sequence]: -1,
  [CAP.owner]: -1,
  [CAP.capturer]: -1,
  [CAP.captureTime]: 120,
  [CAP.progress]: 0,
};

/** Map settings defaults (sim MapSettings::default). */
export const SETTINGS_DEFAULTS: Obj = {
  [SETTINGS.screenWidth]: 30,
  [SETTINGS.snap]: 1,
  [SETTINGS.unused5]: 1,
  [SETTINGS.bgOffsetX]: 0,
  [SETTINGS.bgOffsetY]: 0,
  [SETTINGS.bgImage]: 0,
  [SETTINGS.bgScale]: 1,
  [SETTINGS.parallax]: 0.9,
  [SETTINGS.colorTop]: 16777215,
  [SETTINGS.flag13]: false,
  [SETTINGS.width]: 0,
  [SETTINGS.height]: 0,
  [SETTINGS.colorBottom]: 16777215,
  [SETTINGS.gravity]: 15,
  [SETTINGS.wrap]: false,
};

export function emptyDoc(): Obj {
  return {
    [MAP.bodies]: [],
    [MAP.joints]: [],
    [MAP.spawns]: [],
    [MAP.turrets]: [],
    [MAP.grapples]: [],
    [MAP.caps]: [],
    [MAP.settings]: {},
  };
}

/** A new body or entity: the given fields, with default-equal ones dropped. */
export function compact(fields: Obj, defaults: Obj): Obj {
  const out: Obj = {};
  for (const [k, v] of Object.entries(fields)) {
    if (k in defaults && defaults[k] === v) continue;
    out[k] = v;
  }
  return out;
}

/** Copy of `o` with `key` set to `value`, or removed when it equals the default. */
export function withField(o: Obj, key: string, value: unknown, defaults: Obj): Obj {
  const next = { ...o };
  if (key in defaults && defaults[key] === value) delete next[key];
  else next[key] = value;
  return next;
}

export function num(o: Obj, key: string, fallback: number): number {
  const v = o[key];
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

export function flag(o: Obj, key: string, fallback: boolean): boolean {
  const v = o[key];
  return typeof v === "boolean" ? v : fallback;
}

export function list(doc: Obj, key: string): Obj[] {
  const v = doc[key];
  return Array.isArray(v) ? (v as Obj[]) : [];
}

export function asObj(v: unknown): Obj {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {};
}

export function flatPoints(o: Obj): number[] {
  const p = o[SHAPE.points];
  return Array.isArray(p) ? p.map((n) => (typeof n === "number" ? n : 0)) : [];
}

export function colorHex(int: number): string {
  return `#${(int & 0xffffff).toString(16).padStart(6, "0")}`;
}

export function hexColor(hex: string): number {
  return parseInt(hex.replace("#", ""), 16) & 0xffffff;
}

/** Colour of a body's shape (CSS hex). */
export function shapeColor(shape: Obj): string {
  return colorHex(num(shape, SHAPE.color, SHAPE_DEFAULTS[SHAPE.color] as number));
}
