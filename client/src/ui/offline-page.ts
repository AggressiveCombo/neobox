// What a server-only screen shows while the browser is offline: that it is offline, and the
// modes that still work without a connection. app.ts mounts it in place of the screen and
// mounts the screen again once the connection is back.

import type { AppCtx, ScreenHandle } from "../ctx";
import type { Screen } from "../state";
import { h } from "./dom";
import { page, pageHead } from "./kit";

/** Screens that need the server, by title. Every other screen works offline. */
const ONLINE_TITLES: Partial<Record<Screen, string>> = {
  browse: "Rooms",
  quick: "Quick play",
  friends: "Friends",
  library: "Library",
  account: "Account",
};

export function needsServer(screen: Screen): boolean {
  return ONLINE_TITLES[screen] !== undefined;
}

export function offlinePage(ctx: AppCtx, screen: Screen): ScreenHandle {
  const title = ONLINE_TITLES[screen] ?? "This screen";
  const el = page(
    "offline-page",
    pageHead({ title, back: () => ctx.store.set({ screen: "menu" }) }),
    h(
      "section",
      { class: "panel offline-state", role: "status" },
      h("h2", null, "You are offline"),
      h("p", null, "This device has no network connection, so the server cannot be reached."),
      h("p", null, `${title} needs a connection to the server. It will open again when you are back online.`),
      h("p", null, "Practice and Training work without one."),
      h(
        "div",
        { class: "offline-state-actions" },
        h("button", { type: "button", class: "primary", onclick: () => window.location.reload() }, "Try again"),
        h("button", { type: "button", onclick: () => ctx.store.set({ screen: "practice" }) }, "Practice"),
        h("button", { type: "button", onclick: () => ctx.store.set({ screen: "training" }) }, "Training"),
      ),
    ),
  );
  return {
    el,
    update() {},
    destroy() {
      el.remove();
    },
  };
}
