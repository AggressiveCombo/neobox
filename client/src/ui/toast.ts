// Short transient messages stacked in a host element. Each toast removes itself
// after TOAST_MS; evicting the oldest one clears its timer so none are left behind.
// Toasts float over the page and never resize it. While any shows, the bottom bars
// and controls in CLEAR_SELECTOR are measured and the stack is raised above them
// (--toast-clear, style.css), so a toast does not cover them.

import { h } from "./dom";

const MAX_TOASTS = 4;
const TOAST_MS = 3500;
const LEAVE_MS = 160;
/** Bottom bars and controls a toast must sit above: editor hint row and tools, room and replay docks, Practice's Start footer, the match's touch controls. */
const CLEAR_SELECTOR = ".editor-foot, .editor-float, .room-dock, .replay-dock, .practice-actions, .hud-stick, .hud-actions";

const timers = new WeakMap<HTMLElement, number>();

export function showToast(host: HTMLElement, text: string, kind: "info" | "error"): void {
  // The same message already on screen: restart its timer instead of stacking a copy.
  for (const el of host.children) {
    if (el instanceof HTMLElement && el.textContent === text && el.classList.contains(`toast-${kind}`) && !el.classList.contains("is-leaving")) {
      dismiss(host, el);
      break;
    }
  }
  while (host.childElementCount >= MAX_TOASTS) {
    const oldest = host.firstElementChild;
    if (!(oldest instanceof HTMLElement)) break;
    dismiss(host, oldest);
  }
  const el = h(
    "div",
    { class: `toast toast-${kind}`, role: kind === "error" ? "alert" : "status" },
    text,
  );
  host.appendChild(el);
  timers.set(el, window.setTimeout(() => leave(host, el), TOAST_MS));
  sync(host);
}

/** Timed out: fade down, then go. */
function leave(host: HTMLElement, el: HTMLElement): void {
  timers.delete(el);
  el.classList.add("is-leaving");
  window.setTimeout(() => {
    el.remove();
    sync(host);
  }, LEAVE_MS);
}

function dismiss(host: HTMLElement, el: HTMLElement): void {
  const timer = timers.get(el);
  if (timer !== undefined) window.clearTimeout(timer);
  timers.delete(el);
  el.remove();
  sync(host);
}

/** Publishes the bottom clearance while toasts show. Measured every frame for the few toast seconds so a bar that changes is followed. */
function sync(host: HTMLElement): void {
  cancelAnimationFrame(tracking);
  tracking = 0;
  const doc = host.ownerDocument;
  if (host.childElementCount > 0) track(doc);
  else doc.documentElement.style.removeProperty("--toast-clear");
}

let tracking = 0;

function track(doc: Document): void {
  doc.documentElement.style.setProperty("--toast-clear", `${clearance(doc)}px`);
  tracking = requestAnimationFrame(() => track(doc));
}

/** Height from the bottom of the viewport to the top of the highest bottom-anchored bar or control. */
function clearance(doc: Document): number {
  const bottom = window.innerHeight * 0.75;
  let px = 0;
  for (const el of doc.querySelectorAll<HTMLElement>(CLEAR_SELECTOR)) {
    const r = el.getBoundingClientRect();
    if (r.height === 0 || r.bottom < bottom || getComputedStyle(el).visibility === "hidden") continue;
    px = Math.max(px, Math.ceil(window.innerHeight - r.top));
  }
  return px;
}
