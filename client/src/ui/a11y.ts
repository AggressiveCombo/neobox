// Accessibility preferences, applied to the page: reduced motion (`data-motion` on
// <html>, read by style.css and by the scripts through reducedMotion()), menu text
// size (`--text-scale`) and the readable typeface (`data-font`). Only the settings
// screen writes the prefs; this module only reads them.

import { prefs } from "../prefs";

const SYSTEM_REDUCE = window.matchMedia("(prefers-reduced-motion: reduce)");

/** Whether decorative motion should stop: the player's choice, or the system's while the choice is "system". */
export function reducedMotion(): boolean {
  const { motion } = prefs.value;
  return motion === "reduce" || (motion === "system" && SYSTEM_REDUCE.matches);
}

function apply(): void {
  const root = document.documentElement;
  root.dataset.motion = reducedMotion() ? "reduce" : "full";
  root.style.setProperty("--text-scale", String(prefs.value.textScale));
  root.dataset.font = prefs.value.readableFont ? "readable" : "default";
}

/** Apply the accessibility preferences now, and again whenever they or the system motion setting change. */
export function startA11y(): void {
  apply();
  prefs.subscribe(apply);
  SYSTEM_REDUCE.addEventListener("change", apply);
}
