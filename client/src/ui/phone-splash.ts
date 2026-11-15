// Phone welcome: on touch-only devices, a sheet at the bottom of the first screen
// says how to play on a phone. Play enters fullscreen (a tap is the gesture browsers
// require for it). The sheet is not modal: the page underneath stays usable, so an
// invite link can be joined while it is open. Escape or Play closes it.

import { h } from "./dom";
import { wordmark } from "./kit";

/** Show the welcome sheet on touch-only devices (a finger is the only pointer). */
export function showPhoneSplash(): void {
  if (!matchMedia("(pointer: coarse)").matches || matchMedia("(any-pointer: fine)").matches) return;
  const play = h("button", { type: "button", class: "primary big block" }, "Play");
  const sheet = h(
    "div",
    { class: "phone-splash", role: "dialog", "aria-label": "Welcome" },
    h("div", { class: "phone-splash-head" }, wordmark()),
    h("p", { class: "phone-splash-lead" }, "neobox is a game of square fighters batting each other off floating maps. It is made for keyboards and plays well on a phone too."),
    h(
      "ul",
      { class: "boxed-list phone-splash-tips" },
      h("li", null, "Turn your phone sideways. Matches run in landscape, with touch controls on screen."),
      h("li", null, "Play goes fullscreen where the browser allows it. iPhone Safari has no page fullscreen."),
      h("li", null, "Add neobox to your home screen from the browser's share menu to open it like an app."),
    ),
    play,
  );
  const close = (): void => {
    window.removeEventListener("keydown", onKey);
    sheet.remove();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") close();
  };
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
