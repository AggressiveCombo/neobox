// Service worker updates. The browser checks /sw.js on load and whenever the tab regains focus;
// updateViaCache "none" keeps that check off the HTTP cache. A new worker takes over at once
// (install skips waiting, activate claims the page), so the page reloads once to run the new build.
// The reload never interrupts a match, room, editor or replay: it happens at once only on the
// menu. Anywhere else a small prompt waits, and the reload runs on the next visit to the menu.

import { pageLeaving } from "./page-leave";
import type { AppState, Store } from "./state";

export function watchServiceWorker(store: Store<AppState>): void {
  if (!("serviceWorker" in navigator)) return;
  const sw = navigator.serviceWorker;
  // The first controllerchange is the first install's claim: it never reloads. Later ones are updates.
  let hadController = sw.controller !== null;
  let pending = false;

  store.subscribe((state, prev) => {
    if (pending && state.screen === "menu" && !state.inMatch && prev.screen !== "menu") location.reload();
  });

  window.addEventListener("load", () => {
    sw.register("/sw.js", { updateViaCache: "none" })
      .then((reg) => {
        // Engines that block service workers (automation, some privacy modes) resolve no registration: nothing to update.
        if (!reg) return;
        const check = async (): Promise<void> => {
          if (pageLeaving()) return;
          try {
            await reg.update();
          } catch (err: unknown) {
            if (!pageLeaving()) console.warn("service worker update:", err);
          }
        };
        void check();
        document.addEventListener("visibilitychange", () => {
          if (document.visibilityState === "visible") void check();
        });
      })
      .catch((err: unknown) => {
        if (!pageLeaving()) console.warn("service worker:", err);
      });
  });

  sw.addEventListener("controllerchange", () => {
    const firstInstall = !hadController;
    hadController = true;
    if (firstInstall) return;
    const { screen, inMatch } = store.state;
    if (screen === "menu" && !inMatch) {
      location.reload();
      return;
    }
    pending = true;
    showUpdatePrompt();
  });
}

function showUpdatePrompt(): void {
  if (document.getElementById("update-ready")) return;
  const button = document.createElement("button");
  button.id = "update-ready";
  button.type = "button";
  button.className = "primary";
  button.textContent = "Update ready, reload";
  button.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:1000;";
  button.onclick = () => location.reload();
  document.body.appendChild(button);
}
