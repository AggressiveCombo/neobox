// Map JSON as the sim reads it (crates/sim/src/map.rs). Keys are the sim's short
// numeric strings. A field equal to its default is left out on write, like the
// original writer; unknown keys survive every edit untouched.

export type Obj = Record<string, unknown>;

/** Map arrays the editor edits; `set` holds the map settings object. */
export const LIST_KEYS = ["b", "j", "s", "tu", "gp", "c"] as const;
export type ListKey = (typeof LIST_KEYS)[number];

/** Sim limits (crates/sim/src/map.rs). */
export const MAX_OBJECT_ID = 65535;
export const MAX_SHAPES = 65536;
export const MAX_VERTICES = 1048576;

export const MOTION_STATIC = 0;
export const MOTION_KINEMATIC = 1;
export const MOTION_DYNAMIC = 2;

export const JOINT_KINDS = [
  { value: 0, label: "Spring" },
  { value: 1, label: "Pivot" },
  { value: 2, label: "Slider" },
] as const;

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

/** Body defaults (sim BodyDef::default). */
export const BODY_DEFAULTS: Obj = {
  "4": 0,
  "8": 1,
  "9": 0.5,
  "10": 0.5,
  "11": 0.3,
  "12": 0.5,
  "13": false,
  "14": MOTION_STATIC,
  "15": false,
  "17": 0,
  "18": 0,
  "19": 0,
  "20": 0,
  "21": 0,
  "22": 0,
  "23": false,
  "24": 0,
  "25": "a",
  "26": true,
  "27": true,
  "28": true,
  "29": true,
  "30": 0,
  "32": false,
  "36": false,
  "37": 0,
  "38": 0,
  "39": false,
  "40": 0,
  "41": 0,
  "43": false,
  "45": false,
  "50": false,
  "55": 0,
  "56": -1,
  "57": false,
  "58": -1,
  "60": false,
  "61": 0,
  "62": 0,
  "63": true,
  "65": 0,
};

/** Shape defaults. Keys 4, 5, 6 (density, friction, restitution) inherit from the body when absent. */
export const SHAPE_DEFAULTS: Obj = {
  "1": 0,
  "2": 0,
  "3": 0,
  "7": 4627659,
  "8": true,
  "9": 0,
  "14": false,
  "15": 0,
};

export const JOINT_DEFAULTS: Obj = {
  "1": 0,
  "2": 0,
  "3": 0,
  "4": 0,
  "5": 0,
  "6": true,
  "7": -1,
  "8": -1,
  "9": 0.5,
  "10": 0.5,
  "11": 0.5,
  "12": 0,
  "13": 0,
  "14": -1,
  "16": 0,
  "17": false,
  "18": 0,
  "19": 0,
};

export const SPAWN_DEFAULTS: Obj = { "3": 0, "4": 0, "5": true, "6": false, "7": false, "8": -2 };

export const TURRET_DEFAULTS: Obj = { "5": 0, "6": 0, "7": 20, "8": 0, "9": 1, "10": 10, "11": 5, "24": 20 };

export const GRAPPLE_DEFAULTS: Obj = { "3": 5, "4": -1 };

export const CAP_DEFAULTS: Obj = { "3": 3, "4": -1, "5": -1, "6": -1, "7": 120, "8": 0 };

export const SETTINGS_DEFAULTS: Obj = {
  "3": 30,
  "4": 1,
  "5": 1,
  "7": 0,
  "8": 0,
  "9": 0,
  "10": 1,
  "11": 0.9,
  "12": 16777215,
  "13": false,
  "15": 0,
  "16": 0,
  "17": 16777215,
  "18": 15,
  "19": false,
};

export function emptyDoc(): Obj {
  return { b: [], j: [], s: [], tu: [], gp: [], c: [], set: {} };
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
  const p = o["p"];
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
  return colorHex(num(shape, "7", SHAPE_DEFAULTS["7"] as number));
}
