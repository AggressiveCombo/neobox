// Side panel: the fields of the selected entity, or the map settings when
// nothing is selected. Every field change is one undoable commit. Fields are
// grouped under headings.

import { h } from "../ui/dom";
import { icon, type IconName } from "../ui/icons";
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
import { type Ref, getList, isCircle, kindLabel, mergeBodies, patchEntity, patchShape, setShapeColor, setShapeOutline, shapeOutline } from "./model";

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

/** A heading and the fields under it. */
type Group = [string, Field[]];

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

const BODY_GROUPS: Group[] = [
  [
    "Position",
    [
      { key: "2", label: "X", kind: "num", step: 0.5 },
      { key: "3", label: "Y", kind: "num", step: 0.5 },
      { key: "4", label: "Angle (deg)", kind: "num", step: 1, deg: true },
      { key: "14", label: "Motion", kind: "select", options: MOTION },
      { key: "15", label: "Wrap", kind: "bool" },
    ],
  ],
  [
    "Start motion",
    [
      { key: "6", label: "Start velocity X", kind: "num", step: 0.5 },
      { key: "7", label: "Start velocity Y", kind: "num", step: 0.5 },
      { key: "5", label: "Start spin (rad/s)", kind: "num", step: 0.1 },
    ],
  ],
  [
    "Material",
    [
      { key: "8", label: "Density", kind: "num", step: 0.1, min: 0 },
      { key: "9", label: "Bounce", kind: "num", step: 0.05, min: 0 },
      { key: "10", label: "Friction", kind: "num", step: 0.05, min: 0 },
      { key: "11", label: "Linear damping", kind: "num", step: 0.05, min: 0 },
      { key: "12", label: "Angular damping", kind: "num", step: 0.05, min: 0 },
      { key: "57", label: "Fixed rotation", kind: "bool" },
    ],
  ],
  [
    "Forces",
    [
      { key: "17", label: "Force X", kind: "num", step: 0.5 },
      { key: "18", label: "Force Y", kind: "num", step: 0.5 },
      { key: "19", label: "Torque", kind: "num", step: 0.5 },
      { key: "21", label: "Dynamic threshold", kind: "num", step: 0.1, min: 0 },
      { key: "22", label: "Removal threshold", kind: "num", step: 0.1, min: 0 },
    ],
  ],
  [
    "Appearance",
    [
      { key: "24", label: "Z index", kind: "num", step: 1 },
      { key: "55", label: "Parallax", kind: "num", step: 0.05 },
      { key: "50", label: "Invisible", kind: "bool" },
      { key: "23", label: "Scenery (no physics)", kind: "bool" },
      { key: "56", label: "Lifetime (ticks, -1 = forever)", kind: "num", step: 1 },
    ],
  ],
  [
    "Gameplay",
    [
      { key: "13", label: "Kills players", kind: "bool" },
      { key: "20", label: "Damage", kind: "num", step: 1, min: 0 },
      { key: "32", label: "Freeze players", kind: "bool" },
      { key: "43", label: "No jump", kind: "bool" },
      { key: "45", label: "Bullet", kind: "bool" },
      { key: "60", label: "Immune to abilities", kind: "bool" },
      { key: "31", label: "Race checkpoint (0 = none, highest = finish)", kind: "num", step: 1, min: 0 },
      { key: "34", label: "Race object", kind: "bool" },
    ],
  ],
  [
    "Objective",
    [
      { key: "61", label: "Objective", kind: "select", options: OBJECTIVES },
      { key: "62", label: "Objective target", kind: "select", options: OBJECTIVE_TARGETS },
    ],
  ],
  [
    "Collisions",
    [
      { key: "30", label: "Players", kind: "select", options: PASS },
      { key: "65", label: "Projectiles", kind: "select", options: PASS },
      { key: "25", label: "Group", kind: "select", options: GROUPS },
      { key: "26", label: "Collides with group A", kind: "bool" },
      { key: "27", label: "Collides with group B", kind: "bool" },
      { key: "28", label: "Collides with group C", kind: "bool" },
      { key: "29", label: "Collides with group D", kind: "bool" },
    ],
  ],
  [
    "Pinning and zones",
    [
      { key: "36", label: "Pinned", kind: "bool" },
      { key: "37", label: "Pin X", kind: "num", step: 0.5 },
      { key: "38", label: "Pin Y", kind: "num", step: 0.5 },
      { key: "39", label: "Force zone", kind: "bool" },
      { key: "40", label: "Zone X", kind: "num", step: 0.5 },
      { key: "41", label: "Zone Y", kind: "num", step: 0.5 },
    ],
  ],
];

const JOINT_GROUPS: Group[] = [
  [
    "Joint",
    [
      { key: "5", label: "Kind", kind: "select", options: JOINT_KINDS },
      { key: "6", label: "Bodies collide", kind: "bool" },
      { key: "17", label: "Latched", kind: "bool" },
    ],
  ],
  [
    "Spring",
    [
      { key: "9", label: "Frequency", kind: "num", step: 0.1, min: 0 },
      { key: "10", label: "Damping", kind: "num", step: 0.05, min: 0 },
      { key: "11", label: "Length", kind: "num", step: 0.5, min: 0 },
    ],
  ],
  [
    "Motor",
    [
      { key: "12", label: "Motor speed", kind: "num", step: 0.5 },
      { key: "13", label: "Max motor force", kind: "num", step: 1, min: 0 },
      { key: "16", label: "Motor mode", kind: "select", options: MOTOR_MODES },
    ],
  ],
];

/** The turret, then its bullet (sim keys 12 to 23). */
const TURRET_GROUPS: Group[] = [
  [
    "Turret",
    [
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
    ],
  ],
  [
    "Bullet",
    [
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
    ],
  ],
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

const MAP_GROUPS: Group[] = [
  [
    "Screen",
    [
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
      {
        key: "aspect",
        label: "View",
        kind: "select",
        options: [
          { value: "classic", label: "Classic 16:10" },
          { value: "wide", label: "Wide 16:9" },
        ],
      },
    ],
  ],
  [
    "Physics",
    [
      { key: "18", label: "Gravity", kind: "num", step: 1 },
      { key: "19", label: "Wrap players", kind: "bool" },
    ],
  ],
  [
    "Arena",
    [
      { key: "15", label: "Arena width", kind: "num", step: 1, min: 0 },
      { key: "16", label: "Arena height", kind: "num", step: 1, min: 0 },
    ],
  ],
  [
    "Background",
    [
      { key: "12", label: "Background top colour", kind: "colour" },
      { key: "17", label: "Background bottom colour", kind: "colour" },
      { key: "9", label: "Background image", kind: "num", step: 1, min: 0 },
      { key: "10", label: "Background scale", kind: "num", step: 0.1, min: 0 },
      { key: "7", label: "Background offset X", kind: "num", step: 1 },
      { key: "8", label: "Background offset Y", kind: "num", step: 1 },
      { key: "11", label: "Background parallax", kind: "num", step: 0.05, min: 0 },
    ],
  ],
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

function fieldRow(f: Field, value: Value, apply: Apply, mixed = false): HTMLElement {
  const labelText = mixed ? `${f.label} (mixed)` : f.label;
  if (f.kind === "bool") {
    const input = h("input", {
      type: "checkbox",
      role: "switch",
      checked: !mixed && value === true,
      onchange: (e: Event) => apply((e.target as HTMLInputElement).checked),
    });
    if (mixed) input.indeterminate = true;
    return h("label", { class: "check" }, input, h("span", null, labelText));
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
      ...(mixed ? [h("option", { value: "__mixed__", disabled: true }, "Mixed…")] : []),
      ...(f.options ?? []).map((o) => h("option", { value: String(o.value) }, o.label)),
    );
    sel.value = mixed ? "__mixed__" : String(value);
    return h("label", { class: "field" }, h("span", { class: "field-label" }, labelText), sel);
  }
  if (f.kind === "colour") {
    const input = h("input", {
      type: "color",
      value: colorHex(Number(value)),
      onchange: (e: Event) => apply(hexColor((e.target as HTMLInputElement).value)),
    });
    return h("label", { class: "field" }, h("span", { class: "field-label" }, labelText), input);
  }
  const input = h("input", {
    type: "number",
    step: f.step ?? "any",
    min: f.min,
    max: f.max,
    value: mixed ? "" : String(Math.round(Number(value) * 1e6) / 1e6),
    placeholder: mixed ? "Mixed" : undefined,
    inputmode: "decimal",
    onchange: (e: Event) => {
      const el = e.target as HTMLInputElement;
      const n = Number(el.value);
      if (el.value.trim() === "" || !Number.isFinite(n)) {
        el.value = mixed ? "" : String(Math.round(Number(value) * 1e6) / 1e6);
        return;
      }
      apply(n);
    },
  });
  return h("label", { class: "field" }, h("span", { class: "field-label" }, labelText), input);
}

/** Shared value across `items` for field `f`, plus whether the items disagree. */
function readMultiField(items: readonly Obj[], f: Field, defaults: Obj): { value: Value; mixed: boolean } {
  const first = readField(items[0] ?? {}, f, defaults);
  for (let i = 1; i < items.length; i++) {
    if (readField(items[i]!, f, defaults) !== first) return { value: first, mixed: true };
  }
  return { value: first, mixed: false };
}

/** Field rows under their headings for multiple selected entities of the same kind. */
function multiFieldGroups(gs: readonly Group[], items: readonly Obj[], defaults: Obj, set: (f: Field, v: Value) => void): HTMLElement[] {
  return gs.map(([title, fs]) =>
    h(
      "section",
      { class: "inspector-group" },
      h("h3", null, icon(GROUP_ICONS[title] ?? "pencil-ruler", 20), title),
      ...fs.map((f) => {
        const { value, mixed } = readMultiField(items, f, defaults);
        return fieldRow(f, value, (v) => set(f, v), mixed);
      }),
    ),
  );
}

const KIND_ICONS: Record<string, IconName> = {
  body: "square",
  joint: "link-2",
  spawn: "flag",
  turret: "crosshair",
  grapple: "anchor",
  cap: "target",
};

const GROUP_ICONS: Record<string, IconName> = {
  Position: "move-up",
  "Start motion": "play",
  Material: "hand",
  Forces: "zap",
  Appearance: "palette",
  Gameplay: "swords",
  Objective: "target",
  Collisions: "layout-grid",
  "Pinning and zones": "anchor",
  Joint: "link-2",
  Spring: "repeat",
  Motor: "rotate-cw",
  Turret: "crosshair",
  Bullet: "send",
  Screen: "monitor",
  Physics: "gauge",
};

/** Field rows under their headings. `item` is read through `defaults`; `set` gets each change. */
function fieldGroups(gs: readonly Group[], item: Obj, defaults: Obj, set: (f: Field, v: Value) => void): HTMLElement[] {
  return gs.map(([title, fs]) =>
    h(
      "section",
      { class: "inspector-group" },
      h("h3", null, icon(GROUP_ICONS[title] ?? "pencil-ruler", 20), title),
      ...fs.map((f) => fieldRow(f, readField(item, f, defaults), (v) => set(f, v))),
    ),
  );
}

/** A map edit: takes the current map and returns the next one. */
export type Edit = (doc: Obj) => Obj;
/** Fields commit edits, not maps: an edit runs at commit time against the map then, so a commit after another edit keeps that edit. */
type Commit = (edit: Edit) => void;

export interface InspectorOpts {
  doc: Obj;
  sel: readonly Ref[];
  /** Apply `edit` to the current map as one undo step. It runs synchronously. */
  commit(edit: Edit): void;
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
    return multiInspector(doc, sel, o.commit, o.remove);
  }
  const ref = sel[0]!;
  const item = getList(doc, ref.kind)[ref.i];
  if (!item) return mapSettings(doc, o.commit);
  const apply = (patch: Obj): void => o.commit((d) => patchEntity(d, ref, patch));
  const setField = (f: Field, v: Value): void => apply({ [f.key]: stored(f, v) });
  const fields = (fs: Field[], defaults: Obj): HTMLElement[] => fs.map((f) => fieldRow(f, readField(item, f, defaults), (v) => setField(f, v)));

  const children: (Node | string | false | null | undefined)[] = [
    // bodies go by their map id: the id joints and grapple points refer to
    h("h2", { class: "inspector-title" }, icon(KIND_ICONS[ref.kind] ?? "pencil-ruler", 20), ref.kind === "body" ? `Body ${num(item, "1", ref.i)}` : `${kindLabel(ref.kind)} ${ref.i + 1}`),
  ];
  if (ref.kind === "body") {
    children.push(...fieldGroups(BODY_GROUPS, item, BODY_DEFAULTS, setField), shapesBlock(doc, ref.i, o.commit));
  } else if (ref.kind === "joint") {
    children.push(
      h("p", { class: "hint" }, `Joins ${anchorName(num(item, "7", -1))} and ${anchorName(num(item, "8", -1))}`),
      ...fieldGroups(JOINT_GROUPS, item, JOINT_DEFAULTS, setField),
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
    children.push(...fieldGroups(TURRET_GROUPS, item, TURRET_DEFAULTS, setField));
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
  children.push(h("button", { type: "button", class: "danger", onclick: o.remove }, icon("trash-2", 18), "Delete"));
  return h("div", { class: "inspector" }, ...children);
}

function anchorName(id: number): string {
  return id < 0 ? "the ground" : `body ${id}`;
}

/** Bulk property editor when multiple top-level entities are selected. */
function multiInspector(doc: Obj, sel: readonly Ref[], commit: Commit, remove: () => void): HTMLElement {
  const byKind = new Map<Ref["kind"], Ref[]>();
  for (const r of sel) {
    const arr = byKind.get(r.kind);
    if (arr) arr.push(r);
    else byKind.set(r.kind, [r]);
  }
  const singleKind = byKind.size === 1 ? sel[0]!.kind : null;
  const bodyRefs = byKind.get("body") ?? [];
  const bodies = bodyRefs.map((r) => r.i);

  const patchAll = (refs: readonly Ref[], patch: Obj): void =>
    commit((d) => refs.reduce((acc, r) => patchEntity(acc, r, patch), d));
  const setAllField = (refs: readonly Ref[]) => (f: Field, v: Value): void => patchAll(refs, { [f.key]: stored(f, v) });

  const children: (Node | string | false | null | undefined)[] = [
    h("h2", { class: "inspector-title" }, icon(singleKind ? (KIND_ICONS[singleKind] ?? "pencil-ruler") : "pencil-ruler", 20), `${sel.length} selected`),
    h(
      "p",
      { class: "hint" },
      singleKind
        ? "Edits below apply to all selected items in one step."
        : [...byKind.entries()].map(([k, rs]) => `${rs.length} ${kindLabel(k).toLowerCase()}${rs.length === 1 ? "" : "s"}`).join(", ") + ".",
    ),
  ];

  // Colour picker + merge action whenever multiple bodies are selected (or bodies are part of a mixed selection).
  if (bodies.length > 0) {
    const bodyObjs = bodies.map((bi) => getList(doc, "body")[bi]).filter((b): b is Obj => b !== undefined);
    const allColours: string[] = [];
    for (const b of bodyObjs) {
      for (const s of list(b, "s")) allColours.push(shapeColor(asObj(s)));
    }
    const firstHex = allColours[0] ?? "#ffffff";
    const mixedCol = allColours.some((c) => c !== firstHex);
    const colourInput = h("input", {
      type: "color",
      value: firstHex,
      "aria-label": "Shape colour for all selected bodies",
      onchange: (e: Event) => {
        const hex = hexColor((e.target as HTMLInputElement).value);
        commit((d) => {
          let next = d;
          for (const bi of bodies) {
            const b = getList(next, "body")[bi];
            if (!b) continue;
            const nShapes = list(b, "s").length;
            for (let si = 0; si < nShapes; si++) next = setShapeColor(next, bi, si, hex);
          }
          return next;
        });
      },
    });
    children.push(
      h("label", { class: "field shape-row" }, h("span", { class: "field-label" }, mixedCol ? "Shape colour (mixed)" : "Shape colour"), colourInput),
    );
    if (singleKind === "body" && bodies.length > 1) {
      children.push(h("button", { type: "button", onclick: () => commit((d) => mergeBodies(d, bodies).doc) }, icon("combine", 18), "Merge bodies"));
    }
    if (bodyObjs.length > 0) {
      if (singleKind !== "body") {
        children.push(h("p", { class: "hint" }, `Editing properties for ${bodyObjs.length} selected ${bodyObjs.length === 1 ? "body" : "bodies"}:`));
      }
      children.push(...multiFieldGroups(BODY_GROUPS, bodyObjs, BODY_DEFAULTS, setAllField(bodyRefs)));
    }
  } else if (singleKind === "joint") {
    const items = sel.map((r) => getList(doc, "joint")[r.i]).filter((x): x is Obj => x !== undefined);
    children.push(...multiFieldGroups(JOINT_GROUPS, items, JOINT_DEFAULTS, setAllField(sel)));
  } else if (singleKind === "spawn") {
    const items = sel.map((r) => getList(doc, "spawn")[r.i]).filter((x): x is Obj => x !== undefined);
    const teams = items.map((item) => (flag(item, "6", false) ? 1 : flag(item, "7", false) ? 2 : 0));
    const mixedTeam = teams.some((t) => t !== teams[0]);
    children.push(
      ...SPAWN_FIELDS.map((f) => {
        const { value, mixed } = readMultiField(items, f, SPAWN_DEFAULTS);
        return fieldRow(f, value, (v) => setAllField(sel)(f, v), mixed);
      }),
      fieldRow(
        { key: "team", label: "Team", kind: "select", options: SPAWN_TEAMS },
        teams[0] ?? 0,
        (v) => {
          const t = Number(v);
          patchAll(sel, { "5": t === 0, "6": t === 1, "7": t === 2 });
        },
        mixedTeam,
      ),
    );
  } else if (singleKind === "turret") {
    const items = sel.map((r) => getList(doc, "turret")[r.i]).filter((x): x is Obj => x !== undefined);
    children.push(...multiFieldGroups(TURRET_GROUPS, items, TURRET_DEFAULTS, setAllField(sel)));
  } else if (singleKind === "grapple") {
    const items = sel.map((r) => getList(doc, "grapple")[r.i]).filter((x): x is Obj => x !== undefined);
    const attach: Field = {
      key: "4",
      label: "Attached to",
      kind: "select",
      options: [
        { value: -1, label: "Nothing (static)" },
        ...getList(doc, "body").map((b) => ({ value: num(b, "1", -1), label: `Body ${num(b, "1", -1)}` })),
      ],
    };
    children.push(
      ...[...GRAPPLE_FIELDS, attach].map((f) => {
        const { value, mixed } = readMultiField(items, f, GRAPPLE_DEFAULTS);
        return fieldRow(f, value, (v) => setAllField(sel)(f, v), mixed);
      }),
    );
  } else if (singleKind === "cap") {
    const items = sel.map((r) => getList(doc, "cap")[r.i]).filter((x): x is Obj => x !== undefined);
    children.push(
      ...CAP_FIELDS.map((f) => {
        const { value, mixed } = readMultiField(items, f, CAP_DEFAULTS);
        return fieldRow(f, value, (v) => setAllField(sel)(f, v), mixed);
      }),
    );
  }

  children.push(h("button", { type: "button", class: "danger", onclick: remove }, icon("trash-2", 18), "Delete"));
  return h("div", { class: "inspector" }, ...children);
}

/** The inspector while editing inside a body: the selected shape's fields, or the body's shape list when none is selected. */
function scopeInspector(doc: Obj, bi: number, body: Obj, shapes: readonly number[], commit: Commit, remove: () => void): HTMLElement {
  if (shapes.length === 0) {
    return h(
      "div",
      { class: "inspector" },
      h("h2", { class: "inspector-title" }, icon("square", 20), `Body ${num(body, "1", bi)}`),
      h("p", { class: "hint" }, "Click a shape to edit it."),
      shapesBlock(doc, bi, commit),
    );
  }
  const del = h("button", { type: "button", class: "danger", onclick: remove }, icon("trash-2", 18), "Delete");
  if (shapes.length > 1) {
    const allShapes = list(body, "s");
    const picked = shapes.map((si) => asObj(allShapes[si] ?? {}));
    const allCircles = picked.every(isCircle);
    const allPolys = picked.every((s) => !isCircle(s));
    const colours = picked.map(shapeColor);
    const firstHex = colours[0] ?? "#ffffff";
    const mixedCol = colours.some((c) => c !== firstHex);
    const colour = h("input", {
      type: "color",
      value: firstHex,
      "aria-label": "Colour for all selected shapes",
      onchange: (e: Event) => {
        const hex = hexColor((e.target as HTMLInputElement).value);
        commit((d) => shapes.reduce((acc, si) => setShapeColor(acc, bi, si, hex), d));
      },
    });
    const fs: Field[] = [
      { key: "2", label: "Offset X", kind: "num", step: 0.5 },
      { key: "3", label: "Offset Y", kind: "num", step: 0.5 },
      ...(allCircles ? [{ key: "9", label: "Radius", kind: "num" as const, step: 0.5, min: 0 }] : []),
      ...(allPolys ? [{ key: "8", label: "Closed", kind: "bool" as const }] : []),
      { key: "14", label: "Scenery (no physics)", kind: "bool" },
      { key: "15", label: "Z index", kind: "num", step: 1 },
    ];
    return h(
      "div",
      { class: "inspector" },
      h("h2", { class: "inspector-title" }, icon("pentagon", 20), `${shapes.length} shapes selected`),
      h("p", { class: "hint" }, "Edits below apply to all selected shapes in one step."),
      h("label", { class: "field shape-row" }, h("span", { class: "field-label" }, mixedCol ? "Colour (mixed)" : "Colour"), colour),
      ...fs.map((f) => {
        const { value, mixed } = readMultiField(picked, f, SHAPE_DEFAULTS);
        return fieldRow(
          f,
          value,
          (v) => commit((d) => shapes.reduce((acc, si) => patchShape(acc, bi, si, { [f.key]: stored(f, v) }), d)),
          mixed,
        );
      }),
      del,
    );
  }
  const si = shapes[0]!;
  return h(
    "div",
    { class: "inspector" },
    h("h2", { class: "inspector-title" }, icon("pentagon", 20), `Shape ${si + 1} in body ${num(body, "1", bi)}`),
    shapeBlock(bi, body, si, asObj(list(body, "s")[si] ?? {}), commit),
    del,
  );
}

/** Editable rows for every shape of a body. A shape's rows are built when its disclosure first opens, so a selection with many shapes does not rebuild them all. A lone shape starts open. */
function shapesBlock(doc: Obj, bodyIdx: number, commit: Commit): HTMLElement {
  const body = getList(doc, "body")[bodyIdx] ?? {};
  const shapes = list(body, "s");
  const lone = shapes.length === 1;
  return h(
    "section",
    { class: "inspector-group inspector-shapes" },
    h("h3", null, icon("pentagon", 20), `Shapes (${shapes.length})`),
    ...shapes.map((s, si) => {
      const shape = asObj(s);
      const details = h("details", { class: "inspector-shape-details", open: lone }, h("summary", null, `Shape ${si + 1}`));
      let built = false;
      const build = (): void => {
        if (built || !details.open) return;
        built = true;
        details.append(shapeBlock(bodyIdx, body, si, shape, commit));
      };
      details.addEventListener("toggle", build);
      build();
      return details;
    }),
  );
}

/** Numeric X/Y fields for each point of a polygon shape: the keyboard route to the vertex drag. Shape-relative, like the stored outline. */
function pointFields(bodyIdx: number, si: number, shape: Obj, commit: Commit): HTMLElement {
  const outline = shapeOutline(shape);
  const axis = (k: number, which: "x" | "y", value: number): HTMLElement => {
    const input = h("input", {
      type: "number",
      step: 0.5,
      value: String(Math.round(value * 1e6) / 1e6),
      "aria-label": `Point ${k + 1} ${which.toUpperCase()}`,
      onchange: (e: Event) => {
        const el = e.target as HTMLInputElement;
        const n = Number(el.value);
        if (!Number.isFinite(n)) return;
        try {
          commit((d) => {
            const pts = shapeOutline(shapeAt(d, bodyIdx, si));
            const q = pts[k]!;
            const moved = which === "x" ? { x: n, y: q.y } : { x: q.x, y: n };
            return setShapeOutline(d, bodyIdx, si, pts.map((p, i) => (i === k ? moved : p)));
          });
        } catch {
          // Not a simple polygon: keep the stored outline and show it again.
          el.value = String(value);
        }
      },
    });
    return h("label", { class: "field point-field" }, h("span", { class: "field-label" }, which.toUpperCase()), input);
  };
  return h(
    "details",
    { class: "inspector-points" },
    h("summary", null, `Points (${outline.length})`),
    ...outline.map((p, k) => h("div", { class: "point-row" }, h("span", { class: "field-label" }, `Point ${k + 1}`), axis(k, "x", p.x), axis(k, "y", p.y))),
  );
}

/** The stored shape `si` of body `bodyIdx` in `doc`, or an empty object. */
function shapeAt(doc: Obj, bodyIdx: number, si: number): Obj {
  return asObj(list(getList(doc, "body")[bodyIdx] ?? {}, "s")[si] ?? {});
}

function shapeBlock(bodyIdx: number, body: Obj, si: number, shape: Obj, commit: Commit): HTMLElement {
  const set = (patch: Obj): void => commit((d) => patchShape(d, bodyIdx, si, patch));
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
    onchange: (e: Event) => {
      const hex = hexColor((e.target as HTMLInputElement).value);
      commit((d) => setShapeColor(d, bodyIdx, si, hex));
    },
  });
  const overrides = OVERRIDES.map(([key, label, bodyKey]) => {
    const inherited = num(body, bodyKey, Number(BODY_DEFAULTS[bodyKey]));
    const own = key in shape;
    return h(
      "label",
      { class: "check" },
      h("input", {
        type: "checkbox",
        role: "switch",
        checked: own,
        onchange: (e: Event) => {
          const on = (e.target as HTMLInputElement).checked;
          // The inherited value is read when the edit runs, like the other shape commits.
          commit((d) => patchShape(d, bodyIdx, si, { [key]: on ? num(getList(d, "body")[bodyIdx] ?? {}, bodyKey, Number(BODY_DEFAULTS[bodyKey])) : undefined }));
        },
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
    ...(circle ? [] : [pointFields(bodyIdx, si, shape, commit)]),
    ...overrides,
  );
}

/** Map-wide settings, shown when nothing is selected. */
function mapSettings(doc: Obj, commit: Commit): HTMLElement {
  const set = asObj(doc.set);
  return h(
    "div",
    { class: "inspector" },
    h("h2", { class: "inspector-title" }, icon("map", 20), "Map"),
    h("p", { class: "hint" }, `${getList(doc, "body").length} bodies, ${getList(doc, "joint").length} joints`),
    ...fieldGroups(MAP_GROUPS, set, SETTINGS_DEFAULTS, (f, v) => commit((d) => ({ ...d, set: withField(asObj(d.set), f.key, stored(f, v), SETTINGS_DEFAULTS) }))),
  );
}
