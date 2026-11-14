// Settings: controls, audio, graphics, accessibility and touch. Every change is
// written to prefs at once (persisted, and read live by the rest of the app).

import type { ScreenFactory } from "../../ctx";
import { GAMEPAD_LABELS, RESERVED_KEYS, keyLabel } from "../../input";
import { ACTIONS, DEFAULT_KEYS, prefs, type Action, type KeyBindings, type Palette } from "../../prefs";
import { PALETTES, cssHex } from "../../render/geometry";
import type { Screen } from "../../state";
import { openColorPicker } from "../color-picker";
import { h, type Child } from "../dom";

const PALETTE_LABELS: Record<Palette, string> = {
  default: "Default",
  deuteranopia: "Deuteranopia (green-blind)",
  protanopia: "Protanopia (red-blind)",
  tritanopia: "Tritanopia (blue-blind)",
};

interface Slot {
  action: Action;
  index: number;
}

/** A key pressed for a slot that is already bound to other actions. */
interface Conflict extends Slot {
  code: string;
  others: Action[];
}

function labelOf(action: Action): string {
  return ACTIONS.find((a) => a.action === action)?.label ?? action;
}

function slotKey(action: Action, index: number): string {
  return `${action}:${index}`;
}

function rangeField(
  label: string,
  min: number,
  max: number,
  step: number,
  onChange: (v: number) => void,
): { el: HTMLElement; set(v: number): void } {
  const out = h("output", { class: "settings-value" });
  const input = h("input", {
    type: "range",
    min,
    max,
    step,
    class: "settings-range",
    "aria-label": label,
    oninput: () => {
      const v = Number(input.value);
      out.textContent = `${v}%`;
      onChange(v);
    },
  });
  return {
    el: h("div", { class: "settings-field" }, h("div", { class: "settings-field-head" }, h("span", null, label), out), input),
    set(v) {
      input.value = String(v);
      out.textContent = `${v}%`;
    },
  };
}

function checkField(
  label: string,
  hint: string | null,
  onChange: (on: boolean) => void,
): { el: HTMLElement; set(on: boolean): void } {
  const box = h("input", { type: "checkbox", onchange: () => onChange(box.checked) });
  return {
    el: h("label", { class: "check settings-check" }, box, h("span", { class: "settings-check-body" }, h("span", null, label), hint ? h("small", { class: "settings-hint" }, hint) : null)),
    set(on) {
      box.checked = on;
    },
  };
}

function swatch(rgb: number, title: string): HTMLElement {
  return h("span", { class: "swatch", title, style: `background:${cssHex(rgb)}` });
}

export const settingsScreen: ScreenFactory = (ctx) => {
  const { store, input } = ctx;
  /** The screen open before settings; Back returns there. */
  let returnTo: Screen = "menu";
  let returnKnown = false;
  let destroyed = false;
  /** Bumped whenever a capture is started or stopped, so stale waits do nothing. */
  let captureToken = 0;
  let capturing: Slot | null = null;
  let conflict: Conflict | null = null;
  let notice: { text: string; error: boolean } | null = null;
  /** Slot to focus after the next controls render (keyboard users keep their place). */
  let focusKey: string | null = null;
  let keysJson = JSON.stringify(prefs.value.keys);

  // Controls
  const noticeEl = h("p", { class: "settings-notice", role: "status" });
  const bindList = h("div", { class: "bind-list" });
  const gamepad = h(
    "dl",
    { class: "settings-pad" },
    ACTIONS.flatMap(({ action, label }) => [h("dt", null, label), h("dd", null, GAMEPAD_LABELS[action])]),
  );

  // Audio, graphics and touch inputs; refresh() keeps them in step with prefs.
  const volume = rangeField("Volume", 0, 100, 1, (v) => prefs.set({ volume: v / 100 }));
  const muted = checkField("Mute all sound", null, (on) => prefs.set({ muted: on }));
  const musicMuted = checkField("Mute menu music", null, (on) => prefs.set({ musicMuted: on }));
  const jukebox = rangeField("Jukebox volume", 0, 100, 1, (v) => prefs.set({ jukeboxVolume: v / 100 }));
  const filterProfanity = checkField("Filter profanity", "Masks rude words in other players' chat.", (on) =>
    prefs.set({ filterProfanity: on }),
  );
  const scale = rangeField("Render scale", 50, 100, 5, (v) => prefs.set({ renderScale: v / 100 }));
  const antialias = checkField("Anti-aliasing", "Smooths edges. Takes effect after a reload.", (on) => prefs.set({ antialias: on }));
  const stats = checkField("Show stats", "Ping, FPS and rollbacks. Same as F3.", (on) => {
    prefs.set({ showStats: on });
    store.set({ showStats: on });
  });
  const paletteRadios = new Map<Palette, HTMLInputElement>();
  const paletteGroup = h(
    "fieldset",
    { class: "palette-group" },
    h("legend", { class: "settings-legend" }, "Colour palette"),
    (Object.keys(PALETTE_LABELS) as Palette[]).map((name) => {
      const info = PALETTES[name];
      const radio = h("input", { type: "radio", name: "palette", value: name, onchange: () => prefs.set({ palette: name }) });
      paletteRadios.set(name, radio);
      return h(
        "label",
        { class: "palette-option" },
        radio,
        h(
          "span",
          { class: "palette-body" },
          h("span", { class: "palette-name" }, PALETTE_LABELS[name]),
          h(
            "span",
            { class: "palette-swatches", "aria-hidden": "true" },
            swatch(info.red, "Red team"),
            swatch(info.blue, "Blue team"),
            h("span", { class: "swatch-gap" }),
            info.ffa.map((c) => swatch(c, "Free for all")),
          ),
        ),
      );
    }),
  );
  const touchSize = rangeField("Control size", 70, 150, 5, (v) => prefs.set({ touchScale: v / 100 }));
  const leftHanded = checkField("Left-handed layout", "Movement stick on the right, buttons on the left.", (on) =>
    prefs.set({ touchLeftHanded: on }),
  );

  const colorSwatch = h("span", { class: "swatch", "aria-hidden": "true" });
  const colorNote = h("p", { class: "settings-hint" });
  /** The colour picker opened from this screen, closed again when the screen is left. */
  let closePicker: (() => void) | null = null;
  const chooseColor = h(
    "button",
    {
      type: "button",
      onclick: () => {
        closePicker?.();
        closePicker = openColorPicker(prefs.value.color ?? 0x888888, (color) => prefs.set({ color }));
      },
    },
    "Choose colour",
  );
  const autoColor = h("button", { type: "button", onclick: () => prefs.set({ color: null }) }, "Automatic");

  function syncColor(): void {
    const color = prefs.value.color;
    colorSwatch.hidden = color === null;
    if (color !== null) colorSwatch.style.background = cssHex(color);
    colorNote.textContent = color === null ? "The server picks a colour until you choose one." : "Your colour in rooms.";
  }

  /** Cancel a pending key capture (if any) and make its waiter a no-op. */
  function stopCapture(): void {
    captureToken++;
    capturing = null;
    input.cancelCapture();
  }

  async function bind(action: Action, index: number): Promise<void> {
    const token = ++captureToken;
    capturing = { action, index };
    conflict = null;
    notice = { text: `Press a key for ${labelOf(action)}. Esc cancels.`, error: false };
    focusKey = slotKey(action, index);
    renderControls();
    const code = await input.captureNextKey();
    if (destroyed || token !== captureToken) return;
    capturing = null;
    notice = null;
    focusKey = slotKey(action, index);
    if (code === null) {
      renderControls();
      return;
    }
    if (RESERVED_KEYS.has(code)) {
      notice = { text: `${keyLabel(code)} is used by the game or browser. Pick another key.`, error: true };
      renderControls();
      return;
    }
    const keys = prefs.value.keys;
    const others = ACTIONS.map((a) => a.action).filter((a) => a !== action && keys[a].includes(code));
    if (others.length > 0) {
      conflict = { action, index, code, others };
      renderControls();
      return;
    }
    assign(action, index, code);
  }

  /** Bind `code` to a slot, taking it off every other action (the move). */
  function assign(action: Action, index: number, code: string): void {
    const keys: KeyBindings = { ...prefs.value.keys };
    for (const { action: other } of ACTIONS) {
      if (other !== action) keys[other] = keys[other].filter((c) => c !== code);
    }
    const rest = keys[action].filter((c, j) => j !== index && c !== code);
    const pos = Math.min(index, rest.length);
    rest.splice(pos, 0, code);
    keys[action] = rest;
    conflict = null;
    notice = null;
    focusKey = slotKey(action, pos);
    prefs.set({ keys });
  }

  function removeKey(action: Action, index: number): void {
    stopCapture();
    conflict = null;
    notice = null;
    prefs.set({ keys: { ...prefs.value.keys, [action]: prefs.value.keys[action].filter((_, j) => j !== index) } });
  }

  function resetKeys(): void {
    stopCapture();
    conflict = null;
    notice = { text: "Controls reset to the defaults.", error: false };
    prefs.set({ keys: DEFAULT_KEYS });
    renderControls();
  }

  function bindRow(action: Action, label: string): HTMLElement {
    const keys = prefs.value.keys[action];
    const busyIndex = capturing?.action === action ? capturing.index : -1;
    const slots: Child[] = keys.map((code, index) => {
      const busy = index === busyIndex;
      return h(
        "span",
        { class: "bind-key" },
        h(
          "button",
          {
            type: "button",
            class: busy ? "bind-slot is-capturing" : "bind-slot",
            "data-slot": slotKey(action, index),
            "aria-label": `${label} key ${index + 1}: ${keyLabel(code)}. Change`,
            onclick: () => void bind(action, index),
          },
          busy ? "Press a key" : keyLabel(code),
        ),
        h(
          "button",
          {
            type: "button",
            class: "bind-remove",
            "aria-label": `Remove ${keyLabel(code)} from ${label}`,
            onclick: () => removeKey(action, index),
          },
          "×",
        ),
      );
    });
    if (keys.length === 0 && busyIndex < 0) slots.push(h("span", { class: "bind-none" }, "No key"));
    if (keys.length < 3) {
      const busy = keys.length === busyIndex;
      slots.push(
        h(
          "button",
          {
            type: "button",
            class: busy ? "bind-add is-capturing" : "bind-add",
            "data-slot": slotKey(action, keys.length),
            onclick: () => void bind(action, keys.length),
          },
          busy ? "Press a key" : "+ Add key",
        ),
      );
    }
    if (busyIndex >= 0) {
      slots.push(
        h(
          "button",
          {
            type: "button",
            class: "bind-cancel",
            onclick: () => {
              stopCapture();
              notice = null;
              focusKey = null;
              renderControls();
            },
          },
          "Cancel",
        ),
      );
    }
    const pending = conflict?.action === action ? conflict : null;
    return h(
      "div",
      { class: "bind-row" },
      h("span", { class: "bind-label" }, label),
      h("div", { class: "bind-keys" }, slots),
      pending
        ? h(
            "div",
            { class: "bind-conflict", role: "alert" },
            h(
              "p",
              null,
              `${keyLabel(pending.code)} is already used for ${pending.others.map(labelOf).join(" and ")}. Move it to ${label}?`,
            ),
            h(
              "div",
              { class: "actions" },
              h(
                "button",
                {
                  type: "button",
                  class: "primary",
                  onclick: () => {
                    conflict = null;
                    assign(pending.action, pending.index, pending.code);
                  },
                },
                "Move",
              ),
              h(
                "button",
                {
                  type: "button",
                  onclick: () => {
                    conflict = null;
                    renderControls();
                  },
                },
                "Cancel",
              ),
            ),
          )
        : null,
    );
  }

  function renderControls(): void {
    noticeEl.textContent = notice?.text ?? "";
    noticeEl.classList.toggle("is-error", notice?.error === true);
    bindList.replaceChildren(...ACTIONS.map(({ action, label }) => bindRow(action, label)));
    if (focusKey !== null) {
      bindList.querySelector<HTMLElement>(`[data-slot="${focusKey}"]`)?.focus();
      focusKey = null;
    }
  }

  function refresh(): void {
    const p = prefs.value;
    volume.set(Math.round(p.volume * 100));
    muted.set(p.muted);
    scale.set(Math.round(p.renderScale * 100));
    antialias.set(p.antialias);
    stats.set(store.state.showStats);
    for (const [name, radio] of paletteRadios) radio.checked = name === p.palette;
    touchSize.set(Math.round(p.touchScale * 100));
    leftHanded.set(p.touchLeftHanded);
    musicMuted.set(p.musicMuted);
    jukebox.set(Math.round(p.jukeboxVolume * 100));
    filterProfanity.set(p.filterProfanity);
    syncColor();
  }

  const el = h(
    "div",
    { class: "screen settings-screen" },
    h(
      "header",
      { class: "settings-header" },
      h("button", { type: "button", class: "settings-back", onclick: () => store.set({ screen: returnTo }) }, "Back"),
      h("h1", { class: "settings-heading" }, "Settings"),
    ),
    h(
      "section",
      { class: "panel" },
      h("h2", null, "Controls"),
      h("p", { class: "settings-hint" }, "Click a key to change it. Each action takes up to three keys."),
      noticeEl,
      bindList,
      h("h3", { class: "settings-sub" }, "Gamepad (fixed)"),
      gamepad,
      h("div", { class: "actions" }, h("button", { type: "button", onclick: resetKeys }, "Reset to defaults")),
    ),
    h(
      "section",
      { class: "panel" },
      h("h2", null, "Audio"),
      volume.el,
      muted.el,
      musicMuted.el,
      jukebox.el,
    ),
    h(
      "section",
      { class: "panel" },
      h("h2", null, "Graphics"),
      scale.el,
      h("p", { class: "settings-hint" }, "Lower is faster on weak devices."),
      antialias.el,
      stats.el,
    ),
    h("section", { class: "panel" }, h("h2", null, "Accessibility"), paletteGroup),
    h(
      "section",
      { class: "panel" },
      h("h2", null, "Touch"),
      touchSize.el,
      leftHanded.el,
    ),
    h(
      "section",
      { class: "panel" },
      h("h2", null, "Chat"),
      filterProfanity.el,
    ),
    h(
      "section",
      { class: "panel" },
      h("h2", null, "Appearance"),
      h("div", { class: "actions" }, colorSwatch, chooseColor, autoColor),
      colorNote,
    ),
  );

  renderControls();
  refresh();

  const unsubscribe = prefs.subscribe(() => {
    const json = JSON.stringify(prefs.value.keys);
    if (json !== keysJson) {
      keysJson = json;
      renderControls();
    }
    refresh();
  });

  return {
    el,
    update(state, prev) {
      if (!returnKnown) {
        returnKnown = true;
        returnTo = prev.screen === "settings" ? "menu" : prev.screen;
      }
      stats.set(state.showStats);
    },
    destroy() {
      destroyed = true;
      stopCapture();
      closePicker?.();
      unsubscribe();
      el.remove();
    },
  };
};
