// Phone welcome, like the original's: on touch-only devices the first screen
// says the game is made for keyboards but plays well in fullscreen landscape,
// and Play enters fullscreen (a tap is the gesture browsers require for it).

import { h } from "./dom";
import { logoImg } from "./logo";

/** Show the welcome over the app on touch-only devices (a finger is the only pointer). */
export function showPhoneSplash(): void {
  if (!matchMedia("(pointer: coarse)").matches || matchMedia("(any-pointer: fine)").matches) return;
  const play = h("button", { type: "button", class: "phone-splash-play" }, "Play");
  const splash = h(
    "div",
    { class: "phone-splash", role: "dialog", "aria-modal": "true", "aria-label": "Welcome" },
    logoImg(96),
    h(
      "p",
      { class: "phone-splash-text" },
      "Welcome! neobox is made for keyboards, but it plays well on a phone in fullscreen and landscape. " +
        "If you leave fullscreen, the Fullscreen button in the menus brings it back.",
    ),
    play,
  );
  play.addEventListener("click", () => {
    if (document.fullscreenEnabled && document.fullscreenElement === null) {
      // refused on some browsers (iPhone Safari has no page fullscreen): play on without it
      document.documentElement.requestFullscreen().catch(() => undefined);
    }
    splash.remove();
  });
  document.body.append(splash);
  play.focus();
}
