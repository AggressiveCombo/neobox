// Screen changes: the new screen slides in from the side you are heading to
// (deeper = from the right, back = from the left) while a frozen copy of the old
// one fades out over it. Game views only cross-fade. Transform and opacity only.

import type { Screen } from "../state";
import { reducedMotion } from "./a11y";

export type TransitionKind = "forward" | "back" | "fade";

/** How deep a screen sits: the menu, a page off the menu, a room, a match. */
const DEPTH: Record<Screen, number> = {
  menu: 0,
  about: 1,
  privacy: 1,
  browse: 1,
  quick: 1,
  settings: 1,
  account: 1,
  friends: 1,
  library: 1,
  training: 1,
  practice: 1,
  replay: 1,
  editor: 1,
  room: 2,
  match: 3,
};

/** Screens drawn over the game view: they fade so the arena never slides. */
const GAME: Partial<Record<Screen, true>> = { match: true, training: true, practice: true, replay: true, editor: true };

export function transitionKind(from: Screen, to: Screen): TransitionKind {
  if (GAME[from] || GAME[to]) return "fade";
  const a = DEPTH[from];
  const b = DEPTH[to];
  if (b > a) return "forward";
  if (b < a) return "back";
  return "fade";
}

const LEAVE_MS = 180;

/**
 * Animate a screen change inside `host`, which already holds `entering`.
 * `leaving` (the old screen's element, already destroyed) is shown frozen on top
 * while it fades, then removed; it is inert and hidden from assistive tech.
 * `scrollTop` is where the host was scrolled before the swap, so the frozen copy
 * stays where the player last saw it.
 */
export function playScreenTransition(
  host: HTMLElement,
  leaving: HTMLElement | null,
  entering: HTMLElement,
  kind: TransitionKind,
  scrollTop: number,
): void {
  if (reducedMotion()) return;
  const inClasses = ["screen-in", `screen-in-${kind}`];
  entering.classList.add(...inClasses);
  const done = (e: AnimationEvent): void => {
    if (e.target !== entering) return;
    entering.classList.remove(...inClasses);
    entering.removeEventListener("animationend", done);
  };
  entering.addEventListener("animationend", done);
  if (!leaving) return;
  leaving.inert = true;
  leaving.setAttribute("aria-hidden", "true");
  leaving.classList.add("screen-out", `screen-out-${kind}`);
  leaving.style.top = `${-scrollTop}px`;
  host.appendChild(leaving);
  window.setTimeout(() => leaving.remove(), LEAVE_MS);
}
