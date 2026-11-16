// Short transient messages stacked in a host element. Each toast removes itself
// after TOAST_MS; evicting the oldest one clears its timer so none are left behind.

import { h } from "./dom";

const MAX_TOASTS = 4;
const TOAST_MS = 3500;
const LEAVE_MS = 160;

const timers = new WeakMap<HTMLElement, number>();

export function showToast(host: HTMLElement, text: string, kind: "info" | "error"): void {
  while (host.childElementCount >= MAX_TOASTS) {
    const oldest = host.firstElementChild;
    if (!(oldest instanceof HTMLElement)) break;
    dismiss(oldest);
  }
  const el = h(
    "div",
    { class: `toast toast-${kind}`, role: kind === "error" ? "alert" : "status" },
    text,
  );
  host.appendChild(el);
  timers.set(el, window.setTimeout(() => leave(el), TOAST_MS));
}

/** Timed out: fade down, then go. */
function leave(el: HTMLElement): void {
  timers.delete(el);
  el.classList.add("is-leaving");
  window.setTimeout(() => el.remove(), LEAVE_MS);
}

function dismiss(el: HTMLElement): void {
  const timer = timers.get(el);
  if (timer !== undefined) window.clearTimeout(timer);
  timers.delete(el);
  el.remove();
}
