// Settings: controls, sound, display, accessibility, touch and chat on one page. The section list
// beside them (a row of buttons on phones) jumps to a section. Every change is written
// to prefs at once (persisted, and read live by the rest of the app).

import type { ScreenFactory } from "../../ctx";
import { GAMEPAD_LABELS, RESERVED_KEYS, keyLabel } from "../../input";
import {
  ACTIONS,
  DEFAULT_PREFS,
  DEFAULT_TOUCH_LAYOUT,
  MOTIONS,
  THEMES,
  TOUCH_ACTIONS,
  TOUCH_SLOTS,
  assignTouchAction,
  prefs,
  type Action,
  type KeyBindings,
  type Motion,
  type Palette,
  type Theme,
  type TouchAction,
  type TouchSlot,
} from "../../prefs";
import { PALETTES, cssHex } from "../../render/geometry";
import type { Screen } from "../../state";
import { openColorPicker } from "../color-picker";
import { TOUCH_BUTTONS } from "./hud";
import { h, type Child } from "../dom";
import { icon, type IconName } from "../icons";
import { iconButton, openModal, page, pageHead, seg, toggle } from "../kit";
import { soundSettingsSection } from "../sound-settings";

const PALETTE_LABELS: Record<Palette, string> = {
  default: "Default",
  deuteranopia: "Deuteranopia (green-blind)",
  protanopia: "Protanopia (red-blind)",
  tritanopia: "Tritanopia (blue-blind)",
};

const THEME_OPTIONS: Record<Theme, { label: string; icon: IconName }> = {
  system: { label: "System", icon: "monitor" },
  light: { label: "Light", icon: "sun" },
  dark: { label: "Dark", icon: "moon" },
};

const MOTION_LABELS: Record<Motion, string> = { system: "System", reduce: "Reduce", full: "Full" };

/** Menu text sizes, as multiples of the base size (prefs.textScale). */
const TEXT_SCALES = [1, 1.15, 1.3, 1.5] as const;

interface Slot {
  action: Action;
  index: number;
}

/** A key pressed for a slot that is already bound to other actions. */
interface Conflict extends Slot {
  code: string;
  others: Action[];
}

/** The sections, in page order. The id names the section element. */
const SECTIONS = [
  { id: "controls", label: "Controls", icon: "gamepad-2" },
  { id: "touch", label: "Touch", icon: "hand" },
  { id: "sound", label: "Sound", icon: "volume-2" },
  { id: "display", label: "Display", icon: "palette" },
  { id: "access", label: "Accessibility", icon: "accessibility" },
  { id: "chat", label: "Chat", icon: "message-square" },
] as const;
type SectionId = (typeof SECTIONS)[number]["id"];

function labelOf(action: Action): string {
  return ACTIONS.find((a) => a.action === action)?.label ?? action;
}

function slotKey(action: Action, index: number): string {
  return `${action}:${index}`;
}

/** A 0..100 (or other range) slider with its current value shown beside the label. */
function rangeField(
  label: string,
  min: number,
  max: number,
  step: number,
  onChange: (v: number) => void,
): { el: HTMLElement; set(v: number): void } {
  const out = h("output", { class: "settings-value num" });
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
    el: h("div", { class: "settings-field" }, h("div", { class: "settings-field-head" }, h("span", { class: "field-label" }, label), out), input),
    set(v) {
      input.value = String(v);
      out.textContent = `${v}%`;
    },
  };
}

/** An on/off switch (kit's toggle) with a setter for outside changes. */
function switchField(
  label: string,
  hint: string | null,
  onChange: (on: boolean) => void,
): { el: HTMLElement; set(on: boolean): void } {
  const el = toggle(label, false, onChange, hint ?? undefined);
  const box = el.querySelector("input");
  if (!box) throw new Error("toggle without a switch");
  return {
    el,
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

  // Display
  const themeSeg = seg(
    "Theme",
    THEMES.map((value) => ({ value, label: THEME_OPTIONS[value].label, icon: THEME_OPTIONS[value].icon })),
    prefs.value.theme,
    (v) => prefs.set({ theme: v }),
  );
  const scale = rangeField("Render scale", 50, 100, 5, (v) => prefs.set({ renderScale: v / 100 }));
  const antialias = switchField("Anti-aliasing", "Smooths edges. Takes effect after a reload.", (on) => prefs.set({ antialias: on }));
  const stats = switchField("Show stats", "Ping, FPS and rollbacks. Same as F3.", (on) => {
    prefs.set({ showStats: on });
    store.set({ showStats: on });
  });
  const paletteRadios = new Map<Palette, HTMLInputElement>();
  const paletteGroup = h(
    "fieldset",
    { class: "palette-group" },
    h("legend", { class: "field-label" }, "Colour palette"),
    h("p", { class: "field-hint" }, "Pick one that keeps red and blue teams apart for you."),
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

  // Accessibility: motion, text size and a readable typeface. The palette above is listed here too.
  const motionSeg = seg(
    "Motion",
    MOTIONS.map((value) => ({ value, label: MOTION_LABELS[value] })),
    prefs.value.motion,
    (v) => prefs.set({ motion: v }),
  );
  const textSeg = seg(
    "Text size",
    TEXT_SCALES.map((v) => ({ value: String(v), label: `${Math.round(v * 100)}%` })),
    String(prefs.value.textScale),
    (v) => prefs.set({ textScale: Number(v) }),
  );
  const readable = switchField("Readable font", "A typeface made for dyslexic readers, with wider spacing.", (on) =>
    prefs.set({ readableFont: on }),
  );
  const captions = switchField("Sound captions", "Shows a text line for game sounds such as jumps, impacts and deaths.", (on) =>
    prefs.set({ captions: on }),
  );

  const colorSwatch = h("span", { class: "swatch", "aria-hidden": "true" });
  const colorNote = h("p", { class: "field-hint" });
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

  // Touch: a small drawing of the on-screen controls that follows the size, side and button layout.
  const touchSize = rangeField("Control size", 70, 150, 5, (v) => prefs.set({ touchScale: v / 100 }));
  const leftHanded = switchField("Left-handed layout", "Movement stick on the right, buttons on the left.", (on) =>
    prefs.set({ touchLeftHanded: on }),
  );
  const touchCells = {} as Record<TouchSlot, HTMLElement>;
  const touchPreview = h(
    "div",
    { class: "touch-preview", "aria-hidden": "true" },
    h("span", { class: "touch-stick" }),
    h(
      "span",
      { class: "touch-buttons" },
      TOUCH_SLOTS.map((slot) => {
        const cell = h("span", { class: "touch-cell", "data-slot": slot });
        touchCells[slot] = cell;
        return cell;
      }),
    ),
  );
  /** Where each slot sits on screen (the drawing above is mirrored when left-handed). */
  const TOUCH_POSITIONS: Record<TouchSlot, string> = {
    rocket: "Top left",
    push: "Top middle",
    jump: "Tall, right",
    bat: "Bottom left",
    grab: "Bottom middle",
  };
  const touchSelects = {} as Record<TouchSlot, HTMLSelectElement>;
  const touchSlotRows = TOUCH_SLOTS.map((slot) => {
    const select = h(
      "select",
      {
        class: "touch-select",
        "data-slot": slot,
        onchange: () => prefs.set({ touchLayout: assignTouchAction(prefs.value.touchLayout, slot, select.value as TouchAction) }),
      },
      TOUCH_ACTIONS.map((action) => h("option", { value: action }, TOUCH_BUTTONS[action].label)),
    );
    touchSelects[slot] = select;
    return h("label", { class: "touch-slot" }, h("span", { class: "field-label" }, TOUCH_POSITIONS[slot]), select);
  });
  const touchLayout = h(
    "div",
    { class: "touch-layout" },
    h("h3", { class: "settings-sub" }, "Button layout"),
    h("p", { class: "field-hint" }, "Pick what each button does. An action already in use moves to the button you changed."),
    h("div", { class: "touch-slots" }, touchSlotRows),
    h(
      "div",
      { class: "settings-group" },
      h("button", { type: "button", class: "quiet", onclick: () => prefs.set({ touchLayout: DEFAULT_TOUCH_LAYOUT }) }, icon("rotate-ccw", 18), "Default layout"),
    ),
  );

  // Chat
  const filterProfanity = switchField("Filter profanity", "Masks rude words in other players' chat.", (on) =>
    prefs.set({ filterProfanity: on }),
  );

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

  /** Every setting back to its default, after the player confirms. */
  function resetAll(): void {
    stopCapture();
    conflict = null;
    notice = null;
    prefs.set({ ...DEFAULT_PREFS });
    store.set({ showStats: DEFAULT_PREFS.showStats });
    ctx.toast("Settings reset to the defaults.");
  }

  function confirmReset(): void {
    const modal = openModal({
      title: "Reset settings?",
      body: [
        h("p", null, "Controls, sound, display, accessibility, touch and chat go back to the defaults. Your account and your friends are not changed."),
      ],
      actions: [
        h("button", { type: "button", onclick: () => modal.close() }, "Cancel"),
        h(
          "button",
          {
            type: "button",
            class: "danger",
            onclick: () => {
              modal.close();
              resetAll();
            },
          },
          "Reset everything",
        ),
      ],
    });
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
            class: busy ? "key bind-slot is-capturing" : "key bind-slot",
            "data-slot": slotKey(action, index),
            "aria-label": `${label} key ${index + 1}: ${keyLabel(code)}. Change`,
            onclick: () => void bind(action, index),
          },
          busy ? "Press a key" : keyLabel(code),
        ),
        iconButton("x", `Remove ${keyLabel(code)} from ${label}`, () => removeKey(action, index), "bind-remove"),
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
          busy ? "Press a key" : [icon("plus", 18), "Add key"],
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
    themeSeg.set(p.theme);
    scale.set(Math.round(p.renderScale * 100));
    antialias.set(p.antialias);
    stats.set(store.state.showStats);
    for (const [name, radio] of paletteRadios) radio.checked = name === p.palette;
    motionSeg.set(p.motion);
    textSeg.set(String(p.textScale));
    readable.set(p.readableFont);
    captions.set(p.captions);
    touchSize.set(Math.round(p.touchScale * 100));
    leftHanded.set(p.touchLeftHanded);
    touchPreview.style.setProperty("--touch-scale", String(p.touchScale));
    touchPreview.classList.toggle("is-left", p.touchLeftHanded);
    for (const slot of TOUCH_SLOTS) {
      const action = p.touchLayout[slot];
      touchSelects[slot].value = action;
      touchCells[slot].replaceChildren(icon(TOUCH_BUTTONS[action].icon, 18));
    }
    filterProfanity.set(p.filterProfanity);
    syncColor();
  }

  /** Back to the screen settings opened from; a match that ended meanwhile returns to its room. */
  function back(): void {
    const ended = returnTo === "match" && !store.state.inMatch;
    store.set({ screen: ended ? (store.state.room ? "room" : "menu") : returnTo });
  }

  const bodies = new Map<SectionId, HTMLElement>();
  function section(id: SectionId, title: string, hint: string | null, ...content: Child[]): HTMLElement {
    const name = SECTIONS.find((s) => s.id === id)?.icon;
    const el = h(
      "section",
      { class: "panel settings-section", "aria-labelledby": `settings-${id}-title`, "data-section": id },
      h("h2", { id: `settings-${id}-title` }, name ? icon(name, 22) : null, title),
      hint ? h("p", { class: "field-hint" }, hint) : null,
      ...content,
    );
    bodies.set(id, el);
    return el;
  }

  const sectionNav = h(
    "nav",
    { class: "settings-nav", "aria-label": "Settings sections" },
    SECTIONS.map(({ id, label, icon: name }) =>
      h(
        "button",
        {
          type: "button",
          class: "quiet settings-nav-item",
          onclick: () => bodies.get(id)?.scrollIntoView({ block: "start" }),
        },
        icon(name, 18),
        label,
      ),
    ),
  );

  const el = page(
    "settings-page",
    pageHead({
      title: "Settings",
      back,
      actions: [h("button", { type: "button", class: "quiet", onclick: () => store.set({ screen: "account" }) }, icon("circle-user", 18), "Account")],
    }),
    h(
      "div",
      { class: "settings-layout" },
      sectionNav,
      h(
        "div",
        { class: "settings-body" },
        section(
          "controls",
          "Controls",
          "Click a key to change it. Up to three keys per action.",
          noticeEl,
          bindList,
          h("h3", { class: "settings-sub" }, "Gamepad (fixed)"),
          gamepad,
        ),
        section(
          "touch",
          "Touch",
          "The on-screen controls on phones and tablets.",
          touchSize.el,
          touchPreview,
          leftHanded.el,
          touchLayout,
        ),
        section("sound", "Sound", null, soundSettingsSection()),
        section(
          "display",
          "Display",
          null,
          h("div", { class: "settings-group" }, h("span", { class: "field-label" }, "Theme"), themeSeg.el),
          scale.el,
          h("p", { class: "field-hint" }, "Lower is faster on weak devices."),
          antialias.el,
          stats.el,
          h("div", { class: "settings-group" }, h("span", { class: "field-label" }, "Your colour"), colorSwatch, chooseColor, autoColor),
          colorNote,
        ),
        section(
          "access",
          "Accessibility",
          "Motion, text size and reading aids. Changes apply straight away.",
          h("div", { class: "settings-group" }, h("span", { class: "field-label" }, "Motion"), motionSeg.el),
          h("p", { class: "field-hint" }, "Reduce stops slides, pop-ups and hover movement. System follows your device setting."),
          h("div", { class: "settings-group" }, h("span", { class: "field-label" }, "Text size"), textSeg.el),
          h("p", { class: "field-hint" }, "Scales the text in the menus."),
          readable.el,
          captions.el,
          paletteGroup,
        ),
        section("chat", "Chat", null, filterProfanity.el),
        h(
          "section",
          { class: "settings-reset" },
          h("p", { class: "field-hint" }, "Changes save as you make them."),
          h("button", { type: "button", class: "danger", onclick: confirmReset }, icon("rotate-ccw", 18), "Reset to defaults"),
        ),
      ),
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
