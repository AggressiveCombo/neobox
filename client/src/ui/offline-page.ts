// What a server-only screen shows while the browser is offline: that it is unavailable, a Retry, and the
// modes that still work without a connection. app.ts mounts it in place of the screen. Retry, or the
// browser's online event, checks the server and then hands back to app.ts through `reopen`.

import { fetchStats } from "../api";
import type { AppCtx, ScreenHandle } from "../ctx";
import type { Screen } from "../state";
import { h } from "./dom";
import { icon } from "./icons";
import { page, pageHead } from "./kit";

/** Screens that need the server, by title. Every other screen works offline. */
const ONLINE_TITLES: Partial<Record<Screen, string>> = {
  browse: "Browse rooms",
  quick: "Quick play",
  friends: "Friends",
  library: "Library",
  account: "Account",
};

export function needsServer(screen: Screen): boolean {
  return ONLINE_TITLES[screen] !== undefined;
}

export function offlinePage(ctx: AppCtx, screen: Screen, reopen: () => void): ScreenHandle {
  const title = ONLINE_TITLES[screen] ?? "This screen";
  const note = h("p", { class: "offline-state-note", role: "status" });
  const retry = h("button", { type: "button", class: "primary", onclick: () => void attempt() }, icon("refresh-cw", 18), "Retry");
  let checking = false;

  /** Ask the server; if it answers, the screen opens. Otherwise the page says it is still offline. */
  async function attempt(): Promise<void> {
    if (checking) return;
    checking = true;
    retry.disabled = true;
    note.textContent = "";
    try {
      await fetchStats();
      if (el.isConnected) reopen();
    } catch {
      if (el.isConnected) note.textContent = "Still offline. Retry when the connection is back.";
    } finally {
      checking = false;
      retry.disabled = false;
    }
  }

  const onOnline = (): void => void attempt();
  const el = page(
    "offline-page",
    pageHead({ title, back: () => ctx.store.set({ screen: "menu" }) }),
    h(
      "section",
      { class: "panel offline-state" },
      h("h2", null, `${title} unavailable offline`),
      h("p", null, "This device has no network connection, so the server cannot be reached."),
      h("p", null, "It opens again when you are back online."),
      h("p", null, "Practice and Training work without one."),
      h(
        "div",
        { class: "offline-state-actions" },
        retry,
        h("button", { type: "button", onclick: () => ctx.store.set({ screen: "practice" }) }, "Practice"),
        h("button", { type: "button", onclick: () => ctx.store.set({ screen: "training" }) }, "Training"),
      ),
      note,
    ),
  );
  window.addEventListener("online", onOnline);
  return {
    el,
    update() {},
    destroy() {
      window.removeEventListener("online", onOnline);
      el.remove();
    },
  };
}
