// Phone welcome: on touch-only devices, a short sheet at the bottom of the first screen
// says how to play on a phone. Play enters fullscreen (a tap is the gesture browsers
// require for it). Not now, Escape or Play close it. The sheet is not modal: the page
// underneath stays usable, so an invite link can be joined while it is open.

import { h } from "./dom";
import { icon } from "./icons";
import { wordmark } from "./kit";
import { PHONE_SPLASH_SEEN_KEY } from "../storage-keys";

/**
 * Show the welcome sheet on touch-only devices (a finger is the only pointer), once per device.
 * Matches in portrait have their own "turn your phone" screen in the HUD.
 */
export function showPhoneSplash(): void {
  if (!matchMedia("(pointer: coarse)").matches || matchMedia("(any-pointer: fine)").matches) return;
  if (localStorage.getItem(PHONE_SPLASH_SEEN_KEY) !== null) return;
  localStorage.setItem(PHONE_SPLASH_SEEN_KEY, "1");
  const play = h("button", { type: "button", class: "primary big" }, icon("play", 20), "Play");
  const notNow = h("button", { type: "button", class: "quiet big" }, "Not now");
  const sheet = h(
    "div",
    { class: "phone-splash", role: "dialog", "aria-label": "Welcome" },
    h("div", { class: "phone-splash-head" }, wordmark()),
    h("p", { class: "phone-splash-lead" }, "Turn your phone sideways to play. Play goes fullscreen where the browser allows it."),
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
