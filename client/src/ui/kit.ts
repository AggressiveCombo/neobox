// Shared building blocks for screens, styled by style.css (see DESIGN.md).
// Each returns plain elements built with `h`; screens keep their own state.

import { h, type Child } from "./dom";
import { icon, type IconName } from "./icons";
import { reducedMotion } from "./a11y";

const MODAL_CLOSE_MS = 140;
/** What Tab can land on inside a modal. */
const TAB_STOPS = 'a[href],button:not(:disabled),input:not(:disabled):not([type=hidden]),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex="-1"])';

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

/** Phones: the page actions head the content column instead of the head, so the head is one height on every page. */
const phoneQuery = window.matchMedia("(max-width: 600px)");

function placeActions(pg: HTMLElement): void {
  const head = pg.querySelector<HTMLElement>(":scope > .page-head");
  const inner = pg.querySelector<HTMLElement>(":scope > .page-inner");
  const acts = pg.querySelector<HTMLElement>(":scope > .page-head > .page-actions, :scope > .page-inner > .page-actions");
  if (!head || !inner || !acts) return;
  if (phoneQuery.matches) inner.prepend(acts);
  else head.append(acts);
}

phoneQuery.addEventListener("change", () => document.querySelectorAll<HTMLElement>("main.page").forEach(placeActions));

/** A full-viewport page on the ground colour: `head`, then the content in a centred column. */
export function page(className: string, head: HTMLElement, ...content: Child[]): HTMLElement {
  const pg = h("main", { class: `page ${className}` }, head, h("div", { class: "page-inner enter" }, ...content));
  placeActions(pg);
  return pg;
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

/** An open modal. `pushed`: its history entry exists (a modal opened while a pop is in flight waits for it). */
interface ModalEntry {
  dialog: HTMLDialogElement;
  id: string;
  pushed: boolean;
}
/** Open modals, top last. Each one owns a history entry; Back closes the top one (popstate in app.ts closes the modals above it). */
const openStack: ModalEntry[] = [];
/** Modals opened while a pop is in flight: their history entries are pushed once it lands (pushDeferredModals). */
const unpushed: ModalEntry[] = [];
/** Entries of modals closed from the page whose pop has not been asked for yet. */
let deadEntries = 0;
/** The history.go() that page-side closes asked for, not yet landed: the nav subscriber holds screen changes until it does. */
let popInFlight = false;
export function modalPopPending(): boolean {
  return popInFlight || deadEntries > 0;
}
/**
 * Called from popstate: true, with that pop accounted for, if this Back is a page-side modal close's pop. The next
 * queued pop is asked for only now: WebKit drops a history traversal queued behind one still in flight.
 */
export function takeModalPop(): boolean {
  if (!popInFlight) return false;
  popInFlight = false;
  flushModalPops();
  return true;
}

/**
 * Pushes the history entries of modals opened while the pops were in flight. Call after takeModalPop returned true, once the
 * landed screen is recorded: a push made earlier would be the entry the pop lands on.
 */
export function pushDeferredModals(): void {
  if (modalPopPending()) return;
  for (const m of unpushed.splice(0)) pushModalEntry(m);
}
function pushModalEntry(m: ModalEntry): void {
  m.pushed = true;
  history.pushState({ ...history.state, modal: m.id }, "");
}
function flushModalPops(): void {
  if (popInFlight || deadEntries === 0) return;
  const n = deadEntries;
  deadEntries = 0;
  popInFlight = true;
  history.go(-n);
}

/**
 * A modal <dialog> on the ground colour. Escape and a click on the scrim close
 * it; it removes itself from the page when closed. Opening one adds a history
 * entry, so the browser's Back closes it instead of leaving the page.
 */
export function openModal(opts: ModalOptions): { dialog: HTMLDialogElement; close(): void; id: string } {
  const titleId = uid("m");
  const id = uid("modal");
  const actions = opts.actions && opts.actions.length > 0 ? opts.actions : [h("button", { type: "button" }, "Close")];
  const dialog = h(
    "dialog",
    { class: "modal", "aria-labelledby": titleId },
    h("div", { class: "modal-head" }, h("h2", { id: titleId }, opts.title)),
    h("div", { class: "modal-body", tabindex: "0" }, ...opts.body),
    h("div", { class: "modal-actions" }, ...actions),
  );
  const entry: ModalEntry = { dialog, id, pushed: false };
  // Close at once, so the page is interactive and focus is back where it was before the exit
  // animation runs; the closed dialog then fades out (style.css dialog.modal.is-closing).
  const close = (): void => {
    if (!dialog.open) return;
    // The pop is asked for here, not in the close event (queued by the browser as a task): a navigation the user starts
    // right after Close must not be overtaken by it. Closed from the page, the entry is still in history, so it is popped;
    // left in place it would be a dead entry: Back would land on the screen the modal opened over. Page-side closes queue
    // their pops one at a time (flushModalPops); screen changes made until they land wait (app.ts).
    if (entry.pushed) {
      deadEntries++;
      flushModalPops();
    }
    dialog.close();
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
    const i = openStack.indexOf(entry);
    if (i >= 0) openStack.splice(i, 1);
    const u = unpushed.indexOf(entry);
    if (u >= 0) unpushed.splice(u, 1);
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
  openStack.push(entry);
  if (modalPopPending()) unpushed.push(entry);
  else pushModalEntry(entry);
  dialog.showModal();
  // Native modal focus can leave the dialog (to BODY or browser chrome) on Tab past its ends, so the trap is explicit.
  // It stops itself once the dialog is closed, so the close path needs no change.
  const trapTab = (e: KeyboardEvent): void => {
    if (!dialog.open) {
      document.removeEventListener("keydown", trapTab, true);
      return;
    }
    if (e.key !== "Tab" || openStack[openStack.length - 1] !== entry) return;
    const stops = [...dialog.querySelectorAll<HTMLElement>(TAB_STOPS)].filter((el) => el.getClientRects().length > 0);
    if (stops.length === 0) return;
    const first = stops[0];
    const last = stops[stops.length - 1];
    const active = document.activeElement;
    const inside = dialog.contains(active);
    if (e.shiftKey ? !inside || active === first || active === dialog : !inside || active === last) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
    }
  };
  document.addEventListener("keydown", trapTab, true);
  // Without an explicit [autofocus], start on the dialog itself rather than ringing its first button.
  if (!dialog.querySelector("[autofocus]")) {
    dialog.tabIndex = -1;
    dialog.focus();
  }
  return { dialog, close, id };
}

/** What a confirm asks: a title, one line of consequence, and the label of the action it guards. */
export interface ConfirmOptions {
  title: string;
  message: string;
  action: string;
}

/**
 * A destructive confirm (role alertdialog) built on openModal. Cancel has the initial focus. Only the action
 * resolves true; Cancel, Escape, the scrim and Back resolve false. Nothing blocks: the page keeps running behind it.
 * Its history entry is popped like any modal's (see openModal), and the caller's screen change waits for that pop.
 */
export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const messageId = uid("confirm");
  let answered = false;
  const finish = (yes: boolean): void => {
    if (answered) return;
    answered = true;
    close();
    resolve(yes);
  };
  const cancel = h("button", { type: "button", class: "quiet", autofocus: true }, "Cancel");
  const actionBtn = h("button", { type: "button", class: "danger" }, opts.action);
  const { dialog, close } = openModal({
    title: opts.title,
    body: [h("p", { id: messageId }, opts.message)],
    actions: [cancel, actionBtn],
    onclose: () => finish(false),
  });
  dialog.setAttribute("role", "alertdialog");
  dialog.setAttribute("aria-describedby", messageId);
  // Listeners added after openModal's run after its own (Escape and scrim close it first, synchronously).
  dialog.addEventListener("cancel", () => finish(false));
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) finish(false);
  });
  cancel.addEventListener("click", () => finish(false));
  actionBtn.addEventListener("click", () => finish(true));
  return promise;
}

/**
 * Close the open modals above the one with entry `id` (all of them when `id` is null); with `inclusive`, that one too.
 * Silent: history is not touched, since Back (or a screen change that takes over the modal's entry) has already moved on.
 */
export function closeModalsAbove(id: string | null, inclusive = false): void {
  // A modal not yet pushed has no entry in the history that landed: it stays open.
  const pushed = openStack.filter((m) => m.pushed);
  const at = id === null ? -1 : pushed.findIndex((m) => m.id === id);
  if (id !== null && at < 0) return;
  const from = id === null ? 0 : at + (inclusive ? 0 : 1);
  for (const m of pushed.slice(from).reverse()) {
    m.dialog.close();
  }
}

let uidCounter = 0;
/** A page-unique id for label/aria wiring. */
export function uid(prefix: string): string {
  uidCounter++;
  return `${prefix}-${uidCounter}`;
}
