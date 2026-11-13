// Short transient messages stacked in a host element. Each toast removes itself
// after TOAST_MS; evicting the oldest one clears its timer so none are left behind.

import { h } from "./dom";

const MAX_TOASTS = 4;
const TOAST_MS = 3500;

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
  timers.set(el, window.setTimeout(() => dismiss(el), TOAST_MS));
}

function dismiss(el: HTMLElement): void {
  const timer = timers.get(el);
  if (timer !== undefined) window.clearTimeout(timer);
  timers.delete(el);
  el.remove();
}
