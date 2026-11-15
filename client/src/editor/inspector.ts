// Side panel: the fields of the selected entity, or the map settings when
// nothing is selected. Every field change is one undoable commit.

import { h } from "../ui/dom";
import {
  BODY_DEFAULTS,
  CAP_DEFAULTS,
  GRAPPLE_DEFAULTS,
  JOINT_DEFAULTS,
  JOINT_KINDS,
  MOTOR_MODES,
  type Obj,
  SETTINGS_DEFAULTS,
  SHAPE_DEFAULTS,
  SPAWN_DEFAULTS,
  TURRET_DEFAULTS,
  asObj,
  colorHex,
  flag,
  flatPoints,
  hexColor,
  list,
  num,
  shapeColor,
  withField,
} from "./schema";
import { type Ref, getList, isCircle, kindLabel, mergeBodies, patchEntity, patchShape, setShapeColor } from "./model";

type Value = number | boolean | string;
type Apply = (v: Value) => void;

interface Option {
  value: number | string;
  label: string;
}

interface Field {
  key: string;
  label: string;
  kind: "num" | "bool" | "select" | "colour";
  step?: number;
  min?: number;
  max?: number;
  /** Stored in radians, shown in degrees. */
  deg?: boolean;
  options?: readonly Option[];
}

const MOTION: Option[] = [
  { value: 0, label: "Static" },
  { value: 1, label: "Kinematic" },
  { value: 2, label: "Dynamic" },
];

const GROUPS: Option[] = ["a", "b", "c", "d"].map((value) => ({ value, label: value.toUpperCase() }));

const PASS: Option[] = [
  { value: 0, label: "Collides" },
  { value: 1, label: "Passes through" },
  { value: 2, label: "Red passes" },
  { value: 3, label: "Blue passes" },
];

const OBJECTIVES: Option[] = [
  { value: 0, label: "Not an objective" },
  { value: 1, label: "Shared" },
  { value: 2, label: "Red" },
  { value: 3, label: "Blue" },
];

const OBJECTIVE_TARGETS: Option[] = [
  { value: 0, label: "No" },
  { value: 2, label: "Red wins" },
  { value: 3, label: "Blue wins" },
];

/** Capture zones A to G, stored as 0 to 6. */
const ZONES: Option[] = ["A", "B", "C", "D", "E", "F", "G"].map((label, value) => ({ value, label }));

const BODY_FIELDS: Field[] = [
  { key: "2", label: "X", kind: "num", step: 0.5 },
  { key: "3", label: "Y", kind: "num", step: 0.5 },
  { key: "4", label: "Angle (deg)", kind: "num", step: 1, deg: true },
  { key: "14", label: "Motion", kind: "select", options: MOTION },
  { key: "6", label: "Start velocity X", kind: "num", step: 0.5 },
  { key: "7", label: "Start velocity Y", kind: "num", step: 0.5 },
  { key: "5", label: "Start spin (rad/s)", kind: "num", step: 0.1 },
  { key: "8", label: "Density", kind: "num", step: 0.1, min: 0 },
  { key: "9", label: "Bounce", kind: "num", step: 0.05, min: 0 },
  { key: "10", label: "Friction", kind: "num", step: 0.05, min: 0 },
  { key: "11", label: "Linear damping", kind: "num", step: 0.05, min: 0 },
  { key: "12", label: "Angular damping", kind: "num", step: 0.05, min: 0 },
  { key: "13", label: "Kills players", kind: "bool" },
  { key: "15", label: "Wrap", kind: "bool" },
  { key: "17", label: "Force X", kind: "num", step: 0.5 },
  { key: "18", label: "Force Y", kind: "num", step: 0.5 },
  { key: "19", label: "Torque", kind: "num", step: 0.5 },
  { key: "20", label: "Damage", kind: "num", step: 1, min: 0 },
  { key: "21", label: "Dynamic threshold", kind: "num", step: 0.1, min: 0 },
  { key: "22", label: "Removal threshold", kind: "num", step: 0.1, min: 0 },
  { key: "23", label: "Scenery (no physics)", kind: "bool" },
  { key: "24", label: "Z index", kind: "num", step: 1 },
  { key: "55", label: "Parallax", kind: "num", step: 0.05 },
  { key: "56", label: "Lifetime (ticks, -1 = forever)", kind: "num", step: 1 },
  { key: "25", label: "Group", kind: "select", options: GROUPS },
  { key: "26", label: "Collides with group A", kind: "bool" },
  { key: "27", label: "Collides with group B", kind: "bool" },
  { key: "28", label: "Collides with group C", kind: "bool" },
  { key: "29", label: "Collides with group D", kind: "bool" },
  { key: "30", label: "Players", kind: "select", options: PASS },
  { key: "65", label: "Projectiles", kind: "select", options: PASS },
  { key: "32", label: "Freeze players", kind: "bool" },
  { key: "43", label: "No jump", kind: "bool" },
  { key: "45", label: "Bullet", kind: "bool" },
  { key: "50", label: "Invisible", kind: "bool" },
  { key: "57", label: "Fixed rotation", kind: "bool" },
  { key: "60", label: "Immune to abilities", kind: "bool" },
  { key: "61", label: "Objective", kind: "select", options: OBJECTIVES },
  { key: "62", label: "Objective target", kind: "select", options: OBJECTIVE_TARGETS },
  { key: "36", label: "Pinned", kind: "bool" },
  { key: "37", label: "Pin X", kind: "num", step: 0.5 },
  { key: "38", label: "Pin Y", kind: "num", step: 0.5 },
  { key: "39", label: "Force zone", kind: "bool" },
  { key: "40", label: "Zone X", kind: "num", step: 0.5 },
  { key: "41", label: "Zone Y", kind: "num", step: 0.5 },
];

const JOINT_FIELDS: Field[] = [
  { key: "5", label: "Kind", kind: "select", options: JOINT_KINDS },
  { key: "6", label: "Bodies collide", kind: "bool" },
  { key: "9", label: "Frequency", kind: "num", step: 0.1, min: 0 },
  { key: "10", label: "Damping", kind: "num", step: 0.05, min: 0 },
  { key: "11", label: "Length", kind: "num", step: 0.5, min: 0 },
  { key: "12", label: "Motor speed", kind: "num", step: 0.5 },
  { key: "13", label: "Max motor force", kind: "num", step: 1, min: 0 },
  { key: "16", label: "Motor mode", kind: "select", options: MOTOR_MODES },
  { key: "17", label: "Latched", kind: "bool" },
];

const TURRET_FIELDS: Field[] = [
  {
    key: "9",
    label: "Team",
    kind: "select",
    options: [
      { value: 1, label: "Free for all" },
      { value: 2, label: "Red" },
      { value: 3, label: "Blue" },
    ],
  },
  { key: "7", label: "Health", kind: "num", step: 1, min: 1 },
  { key: "24", label: "Max health", kind: "num", step: 1, min: 1 },
  { key: "10", label: "Fire interval (ticks)", kind: "num", step: 1, min: 1 },
  { key: "11", label: "Range", kind: "num", step: 0.5, min: 0 },
];

/** The turret's bullet (sim keys 12 to 23). */
const BULLET_FIELDS: Field[] = [
  { key: "12", label: "Bullet speed", kind: "num", step: 0.5, min: 0 },
  { key: "13", label: "Bullet size", kind: "num", step: 0.1, min: 0 },
  { key: "14", label: "Bullet density", kind: "num", step: 0.1, min: 0 },
  { key: "15", label: "Bullet friction", kind: "num", step: 0.05, min: 0 },
  { key: "16", label: "Bullet bounce", kind: "num", step: 0.05, min: 0 },
  { key: "17", label: "Bullet life (ticks)", kind: "num", step: 1, min: 0 },
  { key: "18", label: "Bullet damage", kind: "num", step: 1, min: 0 },
  { key: "19", label: "Bullet turn rate", kind: "num", step: 0.1 },
  { key: "20", label: "Explosion radius", kind: "num", step: 0.5, min: 0 },
  { key: "21", label: "Bullets bounce", kind: "bool" },
  { key: "22", label: "Bullet shape", kind: "num", step: 1, min: 0 },
  { key: "23", label: "Bullet linear damping", kind: "num", step: 0.05, min: 0 },
];

const SPAWN_FIELDS: Field[] = [
  { key: "3", label: "Priority", kind: "num", step: 1 },
  { key: "4", label: "Angle (deg)", kind: "num", step: 1, deg: true },
  {
    key: "8",
    label: "Activated by capture zone",
    kind: "select",
    options: [{ value: -2, label: "Not activated" }, ...ZONES],
  },
];

const GRAPPLE_FIELDS: Field[] = [{ key: "3", label: "Range", kind: "num", step: 0.5, min: 0 }];

const CAP_FIELDS: Field[] = [
  { key: "3", label: "Width", kind: "num", step: 0.5, min: 0 },
  { key: "4", label: "Sequence", kind: "select", options: [{ value: -1, label: "None" }, ...ZONES] },
  {
    key: "5",
    label: "Owner",
    kind: "select",
    options: [
      { value: -1, label: "None" },
      { value: 2, label: "Red" },
      { value: 3, label: "Blue" },
    ],
  },
  { key: "7", label: "Capture time (ticks)", kind: "num", step: 1, min: 1 },
];

const MAP_FIELDS: Field[] = [
  { key: "3", label: "Screen width", kind: "num", step: 1, min: 1, max: 100 },
  {
    key: "4",
    label: "Snap",
    kind: "select",
    options: [
      { value: 0, label: "Off" },
      { value: 0.5, label: "0.5" },
      { value: 1, label: "1" },
      { value: 2, label: "2" },
      { value: 5, label: "5" },
      { value: 10, label: "10" },
    ],
  },
  { key: "18", label: "Gravity", kind: "num", step: 1 },
  { key: "19", label: "Wrap players", kind: "bool" },
  { key: "15", label: "Arena width", kind: "num", step: 1, min: 0 },
  { key: "16", label: "Arena height", kind: "num", step: 1, min: 0 },
  { key: "12", label: "Background top colour", kind: "colour" },
  { key: "17", label: "Background bottom colour", kind: "colour" },
  { key: "9", label: "Background image", kind: "num", step: 1, min: 0 },
  { key: "10", label: "Background scale", kind: "num", step: 0.1, min: 0 },
  { key: "7", label: "Background offset X", kind: "num", step: 1 },
  { key: "8", label: "Background offset Y", kind: "num", step: 1 },
  { key: "11", label: "Background parallax", kind: "num", step: 0.05, min: 0 },
];

const SPAWN_TEAMS: Option[] = [
  { value: 0, label: "Free for all" },
  { value: 1, label: "Red" },
  { value: 2, label: "Blue" },
];

/** Shape keys that can be overridden per shape: shape key, label, body key it inherits from. */
const OVERRIDES: [string, string, string][] = [
  ["4", "Density", "8"],
  ["5", "Friction", "10"],
  ["6", "Bounce", "9"],
];

/** Current value of a field, as the input shows it (degrees for angles). */
function readField(o: Obj, f: Field, defaults: Obj): Value {
  const d = defaults[f.key];
  if (f.kind === "bool") return flag(o, f.key, d === true);
  if (typeof d === "string") {
    const v = o[f.key];
    return typeof v === "string" ? v : d;
  }
  const v = num(o, f.key, typeof d === "number" ? d : 0);
  return f.deg ? (v * 180) / Math.PI : v;
}

/** Stored form of an input value: degrees back to radians, floats rounded to shed float noise. */
function stored(f: Field, v: Value): Value {
  if (typeof v !== "number") return v;
  const x = f.deg ? (v * Math.PI) / 180 : v;
  return Math.round(x * 1e6) / 1e6;
}

function fieldRow(f: Field, value: Value, apply: Apply): HTMLElement {
  if (f.kind === "bool") {
    return h(
      "label",
      { class: "check" },
      h("input", { type: "checkbox", checked: value === true, onchange: (e: Event) => apply((e.target as HTMLInputElement).checked) }),
      h("span", null, f.label),
    );
  }
  if (f.kind === "select") {
    const sel = h(
      "select",
      {
        onchange: (e: Event) => {
          const picked = (e.target as HTMLSelectElement).value;
          const opt = (f.options ?? []).find((o) => String(o.value) === picked);
          if (opt) apply(opt.value);
        },
      },
      ...(f.options ?? []).map((o) => h("option", { value: String(o.value) }, o.label)),
    );
    sel.value = String(value);
    return h("label", { class: "field" }, h("span", { class: "field-label" }, f.label), sel);
  }
  if (f.kind === "colour") {
    const input = h("input", {
      type: "color",
      value: colorHex(Number(value)),
      onchange: (e: Event) => apply(hexColor((e.target as HTMLInputElement).value)),
    });
    return h("label", { class: "field" }, h("span", { class: "field-label" }, f.label), input);
  }
  const input = h("input", {
    type: "number",
    step: f.step ?? "any",
    min: f.min,
    max: f.max,
    value: String(Math.round(Number(value) * 1e6) / 1e6),
    inputmode: "decimal",
    onchange: (e: Event) => {
      const el = e.target as HTMLInputElement;
      const n = Number(el.value);
      if (el.value.trim() === "" || !Number.isFinite(n)) {
        el.value = String(value);
        return;
      }
      apply(n);
    },
  });
  return h("label", { class: "field" }, h("span", { class: "field-label" }, f.label), input);
}

export interface InspectorOpts {
  doc: Obj;
  sel: readonly Ref[];
  /** Replace the map with `next` as one undo step. */
  commit(next: Obj): void;
  /** Delete the selected entities. */
  remove(): void;
  /** Body being edited in place and its selected shapes, if any. */
  scope?: { index: number; shapes: readonly number[] } | null;
}

/** The inspector content for the current selection. */
export function renderInspector(o: InspectorOpts): HTMLElement {
  const { doc, sel } = o;
  if (o.scope) {
    const body = getList(doc, "body")[o.scope.index];
    if (body) return scopeInspector(doc, o.scope.index, body, o.scope.shapes, o.commit, o.remove);
  }
  if (sel.length === 0) return mapSettings(doc, o.commit);
  if (sel.length > 1) {
    const bodies = sel.filter((r) => r.kind === "body").map((r) => r.i);
    const merge =
      bodies.length === sel.length && bodies.length > 1
        ? [h("button", { type: "button", onclick: () => o.commit(mergeBodies(doc, bodies).doc) }, "Merge bodies")]
        : [];
    return h(
      "div",
      { class: "inspector" },
      h("p", { class: "inspector-title" }, `${sel.length} selected`),
      h("p", { class: "hint" }, "Drag to move them, or use the arrow keys."),
      ...merge,
      h("button", { type: "button", class: "danger", onclick: o.remove }, "Delete"),
    );
  }
  const ref = sel[0]!;
  const item = getList(doc, ref.kind)[ref.i];
  if (!item) return mapSettings(doc, o.commit);
  const apply = (patch: Obj): void => o.commit(patchEntity(doc, ref, patch));
  const fields = (fs: Field[], defaults: Obj): HTMLElement[] =>
    fs.map((f) => fieldRow(f, readField(item, f, defaults), (v) => apply({ [f.key]: stored(f, v) })));

  const children: (Node | string | false | null | undefined)[] = [
    // bodies go by their map id: the id joints and grapple points refer to
    h("p", { class: "inspector-title" }, ref.kind === "body" ? `Body ${num(item, "1", ref.i)}` : `${kindLabel(ref.kind)} ${ref.i + 1}`),
  ];
  if (ref.kind === "body") {
    children.push(...fields(BODY_FIELDS, BODY_DEFAULTS), shapesBlock(doc, ref.i, o.commit));
  } else if (ref.kind === "joint") {
    children.push(
      h("p", { class: "hint" }, `Joins ${anchorName(num(item, "7", -1))} and ${anchorName(num(item, "8", -1))}`),
      ...fields(JOINT_FIELDS, JOINT_DEFAULTS),
    );
  } else if (ref.kind === "spawn") {
    const team = flag(item, "6", false) ? 1 : flag(item, "7", false) ? 2 : 0;
    children.push(
      ...fields(SPAWN_FIELDS, SPAWN_DEFAULTS),
      fieldRow({ key: "team", label: "Team", kind: "select", options: SPAWN_TEAMS }, team, (v) => {
        const t = Number(v);
        apply({ "5": t === 0, "6": t === 1, "7": t === 2 });
      }),
    );
  } else if (ref.kind === "turret") {
    children.push(...fields(TURRET_FIELDS, TURRET_DEFAULTS), ...fields(BULLET_FIELDS, TURRET_DEFAULTS));
  } else if (ref.kind === "grapple") {
    const attach: Field = {
      key: "4",
      label: "Attached to",
      kind: "select",
      options: [
        { value: -1, label: "Nothing (static)" },
        ...getList(doc, "body").map((b) => ({ value: num(b, "1", -1), label: `Body ${num(b, "1", -1)}` })),
      ],
    };
    children.push(...fields([...GRAPPLE_FIELDS, attach], GRAPPLE_DEFAULTS));
  } else {
    children.push(...fields(CAP_FIELDS, CAP_DEFAULTS));
  }
  children.push(h("button", { type: "button", class: "danger", onclick: o.remove }, "Delete"));
  return h("div", { class: "inspector" }, ...children);
}

function anchorName(id: number): string {
  return id < 0 ? "the ground" : `body ${id}`;
}

/** The inspector while editing inside a body: the selected shape's fields, or the body's shape list when none is selected. */
function scopeInspector(doc: Obj, bi: number, body: Obj, shapes: readonly number[], commit: (next: Obj) => void, remove: () => void): HTMLElement {
  if (shapes.length === 0) {
    return h(
      "div",
      { class: "inspector" },
      h("p", { class: "inspector-title" }, `Body ${num(body, "1", bi)}`),
      h("p", { class: "hint" }, "Click a shape to select it, or draw one with a shape tool."),
      shapesBlock(doc, bi, commit),
    );
  }
  const del = h("button", { type: "button", class: "danger", onclick: remove }, "Delete");
  if (shapes.length > 1) {
    return h(
      "div",
      { class: "inspector" },
      h("p", { class: "inspector-title" }, `${shapes.length} shapes selected`),
      h("p", { class: "hint" }, "Drag to move them, or use the arrow keys."),
      del,
    );
  }
  const si = shapes[0]!;
  return h(
    "div",
    { class: "inspector" },
    h("p", { class: "inspector-title" }, `Shape ${si + 1} in body ${num(body, "1", bi)}`),
    shapeBlock(doc, bi, body, si, asObj(list(body, "s")[si] ?? {}), commit),
    del,
  );
}

/** Editable rows for every shape of a body. */
function shapesBlock(doc: Obj, bodyIdx: number, commit: (next: Obj) => void): HTMLElement {
  const body = getList(doc, "body")[bodyIdx] ?? {};
  const shapes = list(body, "s");
  return h(
    "div",
    { class: "inspector-shapes" },
    h("p", { class: "field-label" }, `Shapes (${shapes.length})`),
    ...shapes.map((s, si) => shapeBlock(doc, bodyIdx, body, si, asObj(s), commit)),
  );
}

function shapeBlock(doc: Obj, bodyIdx: number, body: Obj, si: number, shape: Obj, commit: (next: Obj) => void): HTMLElement {
  const set = (patch: Obj): void => commit(patchShape(doc, bodyIdx, si, patch));
  const circle = isCircle(shape);
  const fs: Field[] = [
    { key: "2", label: "Offset X", kind: "num", step: 0.5 },
    { key: "3", label: "Offset Y", kind: "num", step: 0.5 },
    circle ? { key: "9", label: "Radius", kind: "num", step: 0.5, min: 0 } : { key: "8", label: "Closed", kind: "bool" },
    { key: "14", label: "Scenery (no physics)", kind: "bool" },
    { key: "15", label: "Z index", kind: "num", step: 1 },
  ];
  const colour = h("input", {
    type: "color",
    value: shapeColor(shape),
    "aria-label": `Shape ${si + 1} colour`,
    onchange: (e: Event) => commit(setShapeColor(doc, bodyIdx, si, hexColor((e.target as HTMLInputElement).value))),
  });
  const overrides = OVERRIDES.map(([key, label, bodyKey]) => {
    const inherited = num(body, bodyKey, Number(BODY_DEFAULTS[bodyKey]));
    const own = key in shape;
    return h(
      "label",
      { class: "check" },
      h("input", {
        type: "checkbox",
        checked: own,
        onchange: (e: Event) => set({ [key]: (e.target as HTMLInputElement).checked ? inherited : undefined }),
      }),
      h("span", null, `Own ${label.toLowerCase()}`),
      h("input", {
        type: "number",
        step: 0.1,
        min: 0,
        value: String(Math.round(num(shape, key, inherited) * 1e6) / 1e6),
        disabled: !own,
        onchange: (e: Event) => {
          const n = Number((e.target as HTMLInputElement).value);
          if (Number.isFinite(n)) set({ [key]: n });
        },
      }),
    );
  });
  const label = circle ? "Circle" : `Polygon, ${flatPoints(shape).length / 2} points`;
  return h(
    "div",
    { class: "inspector-shape" },
    h("p", { class: "field-label" }, `Shape ${si + 1}: ${label}`),
    h("label", { class: "field shape-row" }, h("span", { class: "field-label" }, "Colour"), colour),
    ...fs.map((f) => fieldRow(f, readField(shape, f, SHAPE_DEFAULTS), (v) => set({ [f.key]: stored(f, v) }))),
    ...overrides,
  );
}

/** Map-wide settings, shown when nothing is selected. */
function mapSettings(doc: Obj, commit: (next: Obj) => void): HTMLElement {
  const set = asObj(doc.set);
  const rows = MAP_FIELDS.map((f) =>
    fieldRow(f, readField(set, f, SETTINGS_DEFAULTS), (v) =>
      commit({ ...doc, set: withField(set, f.key, stored(f, v), SETTINGS_DEFAULTS) }),
    ),
  );
  return h(
    "div",
    { class: "inspector" },
    h("p", { class: "inspector-title" }, "Map"),
    h("p", { class: "hint" }, `${getList(doc, "body").length} bodies, ${getList(doc, "joint").length} joints. Select an item to edit it.`),
    ...rows,
  );
}
