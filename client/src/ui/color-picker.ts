// Appearance colour picker: preset swatches and a custom colour input in a dialog. Saving
// hands the colour (0xRRGGBB) to `onSave`; Cancel, Escape or the backdrop close without saving.

import { cssHex } from "../render/geometry";
import { h } from "./dom";

/** Preset appearance colours. Pale and dark ends are included so every background stays readable. */
const PRESETS: readonly number[] = [
  0xe53935, 0xff7043, 0xffb300, 0x7cb342, 0x26a69a, 0x29b6f6, 0x1e88e5, 0x3949ab, 0x8e24aa, 0xec407a, 0xf5f5f5, 0x9e9e9e, 0x5d4037, 0x1b1b1b,
];

/** Open the colour picker over the current screen. Returns a function that closes it. */
export function openColorPicker(initial: number, onSave: (color: number) => void): () => void {
  let chosen = initial;

  const preview = h("span", { class: "color-preview", "aria-hidden": "true" });
  const custom = h("input", {
    type: "color",
    class: "color-custom",
    "aria-label": "custom colour",
    value: cssHex(initial),
    oninput: () => select(Number.parseInt(custom.value.slice(1), 16)),
  });
  const swatches = PRESETS.map((c) =>
    h("button", {
      type: "button",
      class: "color-swatch",
      "aria-label": cssHex(c),
      "aria-pressed": "false",
      style: `background:${cssHex(c)}`,
      onclick: () => select(c),
    }),
  );

  /** Mark `color` as the chosen one: preview, custom input and preset pressed states follow it. */
  function select(color: number): void {
    chosen = color;
    preview.style.background = cssHex(color);
    custom.value = cssHex(color);
    swatches.forEach((el, i) => el.setAttribute("aria-pressed", String(PRESETS[i] === color)));
  }

  const closeBtn = h("button", { type: "button", onclick: () => dismiss() }, "Cancel");
  const saveBtn = h(
    "button",
    {
      type: "button",
      class: "primary",
      onclick: () => {
        onSave(chosen);
        dismiss();
      },
    },
    "Save colour",
  );
  const sheet = h(
    "section",
    { class: "picker-sheet color-sheet" },
    h("header", { class: "picker-head" }, h("h2", null, "Appearance colour"), closeBtn),
    h("div", { class: "color-preview-row" }, preview, h("span", { class: "row-sub" }, "Your colour in rooms")),
    h("div", { class: "color-swatches" }, swatches),
    h("label", { class: "color-custom-row" }, h("span", null, "Custom"), custom),
    h("div", { class: "actions" }, saveBtn),
  );
  const overlay: HTMLDivElement = h(
    "div",
    {
      class: "picker-overlay",
      role: "dialog",
      "aria-modal": "true",
      "aria-label": "Appearance colour",
      onclick: (e: Event) => {
        if (e.target === overlay) dismiss();
      },
    },
    sheet,
  );

  function dismiss(): void {
    window.removeEventListener("keydown", onKey);
    overlay.remove();
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key === "Escape") dismiss();
  }

  select(initial);
  window.addEventListener("keydown", onKey);
  document.body.append(overlay);
  return dismiss;
}
