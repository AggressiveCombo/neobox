// Appearance colour picker: a grid of preset colour squares and a custom colour input in a dialog.
// Saving hands the colour (0xRRGGBB) to `onSave`; Cancel, Escape or the scrim close without saving.

import { cssHex } from "../render/geometry";
import { h } from "./dom";
import { icon } from "./icons";
import { openModal } from "./kit";

/** Preset appearance colours. Pale and dark ends are included so every background stays readable. */
const PRESETS: readonly { color: number; name: string }[] = [
  { color: 0xe53935, name: "Red" },
  { color: 0xff7043, name: "Orange" },
  { color: 0xffb300, name: "Amber" },
  { color: 0x7cb342, name: "Green" },
  { color: 0x26a69a, name: "Teal" },
  { color: 0x29b6f6, name: "Light blue" },
  { color: 0x1e88e5, name: "Blue" },
  { color: 0x3949ab, name: "Dark blue" },
  { color: 0x8e24aa, name: "Purple" },
  { color: 0xec407a, name: "Pink" },
  { color: 0xf5f5f5, name: "White" },
  { color: 0x9e9e9e, name: "Grey" },
  { color: 0x5d4037, name: "Brown" },
  { color: 0x1b1b1b, name: "Black" },
];

const STEP: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

/** Ink for the check on a swatch: dark on the pale presets, white on the rest. */
function markColor(color: number): string {
  const luma = 0.299 * ((color >> 16) & 0xff) + 0.587 * ((color >> 8) & 0xff) + 0.114 * (color & 0xff);
  return luma > 160 ? "#0a0a0a" : "#ffffff";
}

/** Open the colour picker over the current screen. Returns a function that closes it. */
export function openColorPicker(initial: number, onSave: (color: number) => void): () => void {
  let chosen = initial;

  const preview = h("span", { class: "color-preview", "aria-hidden": "true" });
  const colorName = h("span", { class: "color-name", "aria-live": "polite" });
  const custom = h("input", {
    type: "color",
    class: "color-custom",
    value: cssHex(initial),
    oninput: () => select(Number.parseInt(custom.value.slice(1), 16)),
  });
  const swatches: HTMLButtonElement[] = PRESETS.map(({ color, name }) =>
    h("button", {
      type: "button",
      role: "radio",
      class: "color-swatch",
      "aria-label": name,
      "aria-checked": "false",
      style: `background:${cssHex(color)};color:${markColor(color)}`,
      onclick: () => select(color),
    }),
  );

  /** Arrow keys move the choice around the grid, as in any radio group. */
  function onGridKey(e: Event): void {
    if (!(e instanceof KeyboardEvent)) return;
    const step = STEP[e.key];
    if (step === undefined) return;
    e.preventDefault();
    const at = swatches.indexOf(document.activeElement as HTMLButtonElement);
    const next = (Math.max(0, at) + step + swatches.length) % swatches.length;
    select(PRESETS[next].color);
    swatches[next].focus();
  }

  /** Mark `color` as the chosen one: preview, name, custom input and the radio states follow it. */
  function select(color: number): void {
    chosen = color;
    const hex = cssHex(color);
    preview.style.background = hex;
    custom.value = hex;
    const index = PRESETS.findIndex((p) => p.color === color);
    colorName.textContent = index >= 0 ? PRESETS[index].name : `Custom ${hex}`;
    swatches.forEach((el, i) => {
      const on = i === index;
      el.setAttribute("aria-checked", String(on));
      // Roving tabindex: the grid is one tab stop, on the chosen colour (or the first when custom).
      el.tabIndex = on || (index < 0 && i === 0) ? 0 : -1;
      el.replaceChildren(...(on ? [icon("check", 18)] : []));
    });
  }

  const cancelBtn = h("button", { type: "button", onclick: () => close() }, icon("x", 18), "Cancel");
  const saveBtn = h(
    "button",
    {
      type: "button",
      class: "primary",
      onclick: () => {
        onSave(chosen);
        close();
      },
    },
    icon("save", 18),
    "Save colour",
  );

  const { close } = openModal({
    title: "Appearance colour",
    body: [
      h(
        "div",
        { class: "color-picker" },
        h(
          "div",
          { class: "color-preview-row" },
          preview,
          h("div", { class: "color-preview-text" }, colorName),
        ),
        h("div", { class: "color-swatches", role: "radiogroup", "aria-label": "Colour", onkeydown: onGridKey }, swatches),
        h("label", { class: "color-custom-row" }, "Custom colour", custom),
      ),
    ],
    actions: [cancelBtn, saveBtn],
  });

  select(initial);
  return close;
}
