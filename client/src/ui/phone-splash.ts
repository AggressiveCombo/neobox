// Phone welcome: on touch-only devices, a short sheet at the bottom of the first landscape match
// says play goes fullscreen. Play enters fullscreen (a tap is the gesture browsers require for
// it). Not now, Escape or Play close it. The sheet is not modal: the page underneath stays usable.
// In portrait the HUD's rotate gate already asks to turn the phone and offers full screen, so the
// sheet waits for a landscape match instead of stacking a second prompt on the gate.

import { h } from "./dom";
import { icon } from "./icons";
import { wordmark } from "./kit";
import { PHONE_SPLASH_SEEN_KEY } from "../storage-keys";
import { local } from "../storage";

/**
 * Show the welcome sheet on touch-only devices (a finger is the only pointer), once per device,
 * in the first match played in landscape.
 */
export function showPhoneSplash(): void {
  if (!matchMedia("(pointer: coarse)").matches || matchMedia("(any-pointer: fine)").matches) return;
  if (matchMedia("(orientation: portrait)").matches) return;
  if (local.getItem(PHONE_SPLASH_SEEN_KEY) !== null) return;
  local.setItem(PHONE_SPLASH_SEEN_KEY, "1");
  const play = h("button", { type: "button", class: "primary big" }, icon("play", 20), "Play");
  const notNow = h("button", { type: "button", class: "quiet big" }, "Not now");
  const sheet = h(
    "div",
    { class: "phone-splash", role: "dialog", "aria-label": "Welcome" },
    h("div", { class: "phone-splash-head" }, wordmark()),
    h("p", { class: "phone-splash-lead" }, "Play goes fullscreen where the browser allows it."),
    h("div", { class: "phone-splash-actions" }, notNow, play),
  );
  const close = (): void => {
    window.removeEventListener("keydown", onKey);
    sheet.remove();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") close();
  };
  notNow.addEventListener("click", close);
  play.addEventListener("click", () => {
    if (document.fullscreenEnabled && document.fullscreenElement === null) {
      // refused on some browsers: play on without it
      document.documentElement.requestFullscreen().catch(() => undefined);
    }
    close();
  });
  window.addEventListener("keydown", onKey);
  document.body.append(sheet);
  play.focus();
}
