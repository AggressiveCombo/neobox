// Short transient messages stacked in a host element. Each toast removes itself
// after TOAST_MS; evicting the oldest one clears its timer so none are left behind.
// While any toast shows, body.has-toasts lifts the page (#ui) above the stack
// (style.css), so a toast never covers content or controls.

import { h } from "./dom";

const MAX_TOASTS = 4;
const TOAST_MS = 3500;
const LEAVE_MS = 160;

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

/** Publishes the stack's height and whether any toast is shown; style.css reserves that space. */
function sync(host: HTMLElement): void {
  const root = host.ownerDocument;
  root.documentElement.style.setProperty("--toast-stack", `${host.offsetHeight}px`);
  root.body.classList.toggle("has-toasts", host.childElementCount > 0);
}
