// Screen changes are a crossfade: the new screen fades in while a frozen copy of the old one
// fades out over it. Nothing travels, so the shared chrome (page head, back, title) stays put
// and the change never reads as the layout moving. Opacity only (style.css "Screen changes").

import { reducedMotion } from "./a11y";

const LEAVE_MS = 160;

/**
 * Animate a screen change inside `host`, which already holds `entering`.
 * `leaving` (the old screen's element, already destroyed) is shown frozen on top
 * while it fades, then removed; it is inert and hidden from assistive tech.
 * `scrollTop` is where the host was scrolled before the swap, so the frozen copy
 * stays where the player last saw it.
 */
export function playScreenTransition(host: HTMLElement, leaving: HTMLElement | null, entering: HTMLElement, scrollTop: number): void {
  if (reducedMotion()) return;
  entering.classList.add("screen-in");
  const done = (e: AnimationEvent): void => {
    if (e.target !== entering) return;
    entering.classList.remove("screen-in");
    entering.removeEventListener("animationend", done);
  };
  entering.addEventListener("animationend", done);
  if (!leaving) return;
  leaving.inert = true;
  leaving.setAttribute("aria-hidden", "true");
  leaving.classList.add("screen-out");
  leaving.style.top = `${-scrollTop}px`;
  host.appendChild(leaving);
  window.setTimeout(() => leaving.remove(), LEAVE_MS);
}
