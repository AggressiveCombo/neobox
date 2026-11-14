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
  TURRET_DEFAULTS,
  asObj,
  flag,
  flatPoints,
  hexColor,
  list,
  num,
  shapeColor,
  withField,
} from "./schema";
import { type Ref, getList, isCircle, kindLabel, patchEntity, setBodyShapes } from "./model";

interface Option {
  value: number;
  label: string;
}

interface Field {
  key: string;
  label: string;
  kind: "num" | "bool" | "select";
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

const BODY_FIELDS: Field[] = [
  { key: "2", label: "X", kind: "num", step: 0.5 },
  { key: "3", label: "Y", kind: "num", step: 0.5 },
  { key: "4", label: "Angle (deg)", kind: "num", step: 1, deg: true },
  { key: "14", label: "Motion", kind: "select", options: MOTION },
  { key: "8", label: "Density", kind: "num", step: 0.1, min: 0 },
  { key: "9", label: "Bounce", kind: "num", step: 0.05, min: 0 },
  { key: "10", label: "Friction", kind: "num", step: 0.05, min: 0 },
  { key: "13", label: "Kills players", kind: "bool" },
  { key: "15", label: "Wrap", kind: "bool" },
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

const GRAPPLE_FIELDS: Field[] = [{ key: "3", label: "Range", kind: "num", step: 0.5, min: 0 }];

const CAP_FIELDS: Field[] = [
  { key: "3", label: "Width", kind: "num", step: 0.5, min: 0 },
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
  { key: "19", label: "Wrap players", kind: "bool" },
];

const SPAWN_TEAMS: Option[] = [
  { value: 0, label: "Free for all" },
  { value: 1, label: "Red" },
  { value: 2, label: "Blue" },
];

/** Current value of a field, as the input shows it (degrees for angles). */
function readField(o: Obj, f: Field, defaults: Obj): number | boolean {
  const d = defaults[f.key];
  if (f.kind === "bool") return flag(o, f.key, d === true);
  const v = num(o, f.key, typeof d === "number" ? d : 0);
  return f.deg ? (v * 180) / Math.PI : v;
}

/** Stored form of an input value (degrees back to radians), rounded to shed float noise. */
function storeValue(f: Field, raw: number): number {
  const v = f.deg ? (raw * Math.PI) / 180 : raw;
  return Math.round(v * 1e6) / 1e6;
}

function fieldRow(label: string, kind: Field["kind"], value: number | boolean, apply: (v: number | boolean) => void, f?: Field): HTMLElement {
  if (kind === "bool") {
    return h(
      "label",
      { class: "check" },
      h("input", { type: "checkbox", checked: value === true, onchange: (e: Event) => apply((e.target as HTMLInputElement).checked) }),
      h("span", null, label),
    );
  }
  if (kind === "select") {
    const sel = h(
      "select",
      { onchange: (e: Event) => apply(Number((e.target as HTMLSelectElement).value)) },
      ...(f?.options ?? []).map((o) => h("option", { value: String(o.value) }, o.label)),
    );
    sel.value = String(value);
    return h("label", { class: "field" }, h("span", { class: "field-label" }, label), sel);
  }
  const input = h("input", {
    type: "number",
    step: f?.step ?? "any",
    min: f?.min,
    max: f?.max,
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
  return h("label", { class: "field" }, h("span", { class: "field-label" }, label), input);
}

function fieldRowFor(f: Field, value: number | boolean, apply: (v: number | boolean) => void): HTMLElement {
  return fieldRow(f.label, f.kind, value, apply, f);
}

export interface InspectorOpts {
  doc: Obj;
  sel: readonly Ref[];
  /** Replace the map with `next` as one undo step. */
  commit(next: Obj): void;
  /** Delete the selected entities. */
  remove(): void;
}

/** The inspector content for the current selection. */
export function renderInspector(o: InspectorOpts): HTMLElement {
  const { doc, sel } = o;
  if (sel.length === 0) return mapSettings(doc, o.commit);
  if (sel.length > 1) {
    return h(
      "div",
      { class: "inspector" },
      h("p", { class: "inspector-title" }, `${sel.length} selected`),
      h("p", { class: "hint" }, "Drag to move them, or use the arrow keys."),
      h("button", { type: "button", class: "danger", onclick: o.remove }, "Delete"),
    );
  }
  const ref = sel[0]!;
  const item = getList(doc, ref.kind)[ref.i];
  if (!item) return mapSettings(doc, o.commit);
  const apply = (patch: Obj): void => o.commit(patchEntity(doc, ref, patch));
  const fields = (fs: Field[], defaults: Obj): HTMLElement[] =>
    fs.map((f) =>
      fieldRowFor(f, readField(item, f, defaults), (v) => apply({ [f.key]: typeof v === "boolean" ? v : storeValue(f, v) })),
    );

  const children: (Node | string | false | null | undefined)[] = [
    h("p", { class: "inspector-title" }, `${kindLabel(ref.kind)} ${ref.i + 1}`),
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
      fieldRow("Team", "select", team, (v) => {
        const t = Number(v);
        apply({ "5": t === 0, "6": t === 1, "7": t === 2 });
      }, { key: "team", label: "Team", kind: "select", options: SPAWN_TEAMS }),
    );
  } else if (ref.kind === "turret") {
    children.push(...fields(TURRET_FIELDS, TURRET_DEFAULTS));
  } else if (ref.kind === "grapple") {
    children.push(...fields(GRAPPLE_FIELDS, GRAPPLE_DEFAULTS));
  } else {
    children.push(...fields(CAP_FIELDS, CAP_DEFAULTS));
  }
  children.push(h("button", { type: "button", class: "danger", onclick: o.remove }, "Delete"));
  return h("div", { class: "inspector" }, ...children);
}

function anchorName(id: number): string {
  return id < 0 ? "the ground" : `body ${id}`;
}

/** One colour input per shape of a body. */
function shapesBlock(doc: Obj, bodyIdx: number, commit: (next: Obj) => void): HTMLElement {
  const body = getList(doc, "body")[bodyIdx] ?? {};
  const shapes = list(body, "s");
  const rows = shapes.map((s, si) => {
    const shape = asObj(s);
    const label = isCircle(shape) ? "Circle" : `Polygon, ${flatPoints(shape).length / 2} points`;
    const colour = h("input", {
      type: "color",
      value: shapeColor(shape),
      "aria-label": `Shape ${si + 1} colour`,
      onchange: (e: Event) => {
        const hex = (e.target as HTMLInputElement).value;
        commit(setBodyShapes(doc, bodyIdx, shapes.map((x, k) => (k === si ? { ...asObj(x), "7": hexColor(hex) } : x))));
      },
    });
    return h("label", { class: "field shape-row" }, h("span", { class: "field-label" }, label), colour);
  });
  return h("div", { class: "inspector-shapes" }, h("p", { class: "field-label" }, `Shapes (${shapes.length})`), ...rows);
}

/** Map-wide settings, shown when nothing is selected. */
function mapSettings(doc: Obj, commit: (next: Obj) => void): HTMLElement {
  const set = asObj(doc.set);
  const rows = MAP_FIELDS.map((f) =>
    fieldRowFor(f, readField(set, f, SETTINGS_DEFAULTS), (v) => {
      const value = typeof v === "boolean" ? v : storeValue(f, v);
      commit({ ...doc, set: withField(set, f.key, value, SETTINGS_DEFAULTS) });
    }),
  );
  return h(
    "div",
    { class: "inspector" },
    h("p", { class: "inspector-title" }, "Map"),
    h("p", { class: "hint" }, `${getList(doc, "body").length} bodies, ${getList(doc, "joint").length} joints. Select an item to edit it.`),
    ...rows,
  );
}
