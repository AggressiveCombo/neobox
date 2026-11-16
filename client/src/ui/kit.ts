// Shared building blocks for screens, styled by style.css (see DESIGN.md).
// Each returns plain elements built with `h`; screens keep their own state.

import { h, type Child } from "./dom";
import { icon, type IconName } from "./icons";
import { reducedMotion } from "./a11y";

const MODAL_CLOSE_MS = 140;

/** The mark and the name, as one link-like unit. */
export function wordmark(): HTMLElement {
  return h("span", { class: "wordmark" }, h("span", { class: "mark", "aria-hidden": "true" }), "neobox");
}

export interface PageHeadOptions {
  title: string;
  /** Shows a Back button that calls this. */
  back?: () => void;
  backLabel?: string;
  actions?: Child[];
}

/** The sticky top row of a page: Back, the title (the page's h1), actions on the right. */
export function pageHead(opts: PageHeadOptions): HTMLElement {
  return h(
    "header",
    { class: "page-head" },
    opts.back ? h("button", { class: "quiet page-back", onclick: opts.back }, icon("arrow-left"), opts.backLabel ?? "Back") : null,
    h("h1", null, opts.title),
    opts.actions && opts.actions.length > 0 ? h("div", { class: "page-actions" }, ...opts.actions) : null,
  );
}

/** A full-viewport page on the ground colour: `head`, then the content in a centred column. */
export function page(className: string, head: HTMLElement, ...content: Child[]): HTMLElement {
  return h("main", { class: `page ${className}` }, head, h("div", { class: "page-inner enter" }, ...content));
}

/** A labelled control with an optional hint under it. The label is tied to the control. */
export function field(label: string, control: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, hint?: string): HTMLElement {
  if (!control.id) control.id = uid("f");
  const hintEl = hint ? h("span", { class: "field-hint", id: uid("h") }, hint) : null;
  if (hintEl) control.setAttribute("aria-describedby", hintEl.id);
  return h("div", { class: "field" }, h("label", { class: "field-label", for: control.id }, label), control, hintEl);
}

/** A labelled on/off switch (a checkbox with role="switch"). */
export function toggle(label: string, checked: boolean, onchange: (on: boolean) => void, hint?: string): HTMLElement {
  const box = h("input", { type: "checkbox", role: "switch", checked });
  box.addEventListener("change", () => onchange(box.checked));
  return h("label", { class: "check" }, box, h("span", { class: "check-text" }, label, hint ? h("span", { class: "field-hint" }, hint) : null));
}

export interface SegOption<T extends string> {
  value: T;
  label: string;
  icon?: IconName;
  disabled?: boolean;
}

/**
 * One choice of a few, as a row of buttons (role="radiogroup"). Arrow keys move
 * the choice; a square indicator slides under the chosen option. Returns the
 * group and a setter for outside changes.
 */
export function seg<T extends string>(
  label: string,
  options: readonly SegOption<T>[],
  value: T,
  onchange: (v: T) => void,
): { el: HTMLElement; set(v: T): void } {
  const buttons = options.map((o) =>
    h("button", { type: "button", class: "seg-option", role: "radio", "data-value": o.value, disabled: o.disabled === true }, o.icon ? icon(o.icon, 16) : null, o.label),
  );
  const indicator = h("span", { class: "seg-indicator", "aria-hidden": "true" });
  const el = h("div", { class: "seg is-indicated", role: "radiogroup", "aria-label": label }, indicator, ...buttons);
  let placed = false;
  /** Move the indicator under the chosen button. The first placement does not slide. */
  const place = (): void => {
    const on = buttons.find((b) => b.getAttribute("aria-checked") === "true");
    if (!on || !on.isConnected) return;
    indicator.style.width = `${on.offsetWidth}px`;
    indicator.style.height = `${on.offsetHeight}px`;
    indicator.style.transform = `translate(${on.offsetLeft}px, ${on.offsetTop}px)`;
    if (!placed) {
      placed = true;
      requestAnimationFrame(() => el.classList.add("is-ready"));
    }
  };
  const set = (v: T): void => {
    for (const b of buttons) {
      const on = b.dataset.value === v;
      b.setAttribute("aria-checked", String(on));
      b.tabIndex = on ? 0 : -1;
    }
    place();
  };
  set(value);
  new ResizeObserver(place).observe(el);
  buttons.forEach((b, i) => {
    b.addEventListener("click", () => {
      set(options[i].value);
      onchange(options[i].value);
    });
    b.addEventListener("keydown", (e) => {
      const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
      if (step === 0) return;
      e.preventDefault();
      for (let j = 1; j <= buttons.length; j++) {
        const k = (i + step * j + buttons.length) % buttons.length;
        if (!buttons[k].disabled) {
          buttons[k].focus();
          buttons[k].click();
          return;
        }
      }
    });
  });
  return { el, set };
}

/**
 * A square icon-only button (style.css button.icon, 44px). The label is both the
 * accessible name and the tooltip, so it is never missing.
 */
export function iconButton(name: IconName, label: string, onclick: () => void, className = ""): HTMLButtonElement {
  return h(
    "button",
    { type: "button", class: className ? `icon ${className}` : "icon", "aria-label": label, title: label, onclick },
    icon(name, 20),
  );
}

/** The tipping-box loader with a line of text beside it. */
export function loading(text: string): HTMLElement {
  return h("p", { class: "loading-line", role: "status" }, h("span", { class: "loader", "aria-hidden": "true" }), text);
}

/** A player's coloured square with their initial. `color` is 0xRRGGBB; the letter takes whichever ink contrasts more with it. */
export function avatar(name: string, color: number | null, small = false): HTMLElement {
  const el = h("span", { class: small ? "avatar small" : "avatar", "aria-hidden": "true" }, small ? "" : initial(name));
  if (color !== null) {
    el.style.setProperty("--avatar", `#${color.toString(16).padStart(6, "0")}`);
    // The letter takes whichever of white or near-black contrasts more with the colour.
    el.style.color = contrastRatio(color, 0xffffff) > contrastRatio(color, 0x0a0a0a) ? "#ffffff" : "#0a0a0a";
    // A colour within 3:1 of either theme's ground loses its edge: outline it in ink.
    if (GROUNDS.some((g) => contrastRatio(color, g) < 3)) el.classList.add("is-edged");
  }
  return el;
}

/** Light and dark `--ground` (style.css). */
const GROUNDS = [0xf7f7f7, 0x0a0a0a] as const;

/** WCAG contrast ratio of two 0xRRGGBB colours, 1 to 21. */
export function contrastRatio(a: number, b: number): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** WCAG relative luminance of a 0xRRGGBB colour. */
function relativeLuminance(rgb: number): number {
  const lin = (c: number): number => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin((rgb >> 16) & 0xff) + 0.7152 * lin((rgb >> 8) & 0xff) + 0.0722 * lin(rgb & 0xff);
}

function initial(name: string): string {
  const c = name.trim().charAt(0);
  return c ? c.toUpperCase() : "?";
}

export interface ModalOptions {
  title: string;
  body: Child[];
  /** Buttons for the bottom row; a Close button is added when none is given. */
  actions?: HTMLButtonElement[];
  onclose?: () => void;
}

/**
 * A modal <dialog> on the ground colour. Escape and a click on the scrim close
 * it; it removes itself from the page when closed.
 */
export function openModal(opts: ModalOptions): { dialog: HTMLDialogElement; close(): void } {
  const titleId = uid("m");
  const actions = opts.actions && opts.actions.length > 0 ? opts.actions : [h("button", { type: "button" }, "Close")];
  const dialog = h(
    "dialog",
    { class: "modal", "aria-labelledby": titleId },
    h("div", { class: "modal-body" }, h("h2", { id: titleId }, opts.title), ...opts.body, h("div", { class: "modal-actions" }, ...actions)),
  );
  // Close at once, so the page is interactive and focus is back where it was before the exit
  // animation runs; the closed dialog then fades out (style.css dialog.modal.is-closing).
  const close = (): void => {
    if (dialog.open) dialog.close();
  };
  if (!opts.actions || opts.actions.length === 0) actions[0].addEventListener("click", close);
  dialog.addEventListener("cancel", (e) => {
    e.preventDefault();
    close();
  });
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) close();
  });
  dialog.addEventListener("close", () => {
    opts.onclose?.();
    if (reducedMotion()) {
      dialog.remove();
      return;
    }
    dialog.inert = true;
    dialog.classList.add("is-closing");
    window.setTimeout(() => dialog.remove(), MODAL_CLOSE_MS);
  });
  document.body.appendChild(dialog);
  dialog.showModal();
  // Without an explicit [autofocus], start on the dialog itself rather than ringing its first button.
  if (!dialog.querySelector("[autofocus]")) {
    dialog.tabIndex = -1;
    dialog.focus();
  }
  return { dialog, close };
}

let uidCounter = 0;
/** A page-unique id for label/aria wiring. */
export function uid(prefix: string): string {
  uidCounter++;
  return `${prefix}-${uidCounter}`;
}
