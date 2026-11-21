// Service worker updates. The page asks the browser for /sw.js on load, on focus, when the tab shows again and every
// minute; updateViaCache "none" keeps that check off the HTTP cache. A new worker takes over at once
// (install skips waiting, activate claims the page). A page on an older build learns of it from the new worker's
// controllerchange, or from the server's refusal (app.ts, "outdated"): both call newVersionOut, which shows a prompt
// and reloads once the player is idle on the menu. Nothing reloads a match, room, editor or replay. A page loaded less
// than LOOP_GUARD_MS ago does not reload itself, so a server and files that disagree cannot loop.

import { pageLeaving } from "./page-leave";
import type { AppState, Store } from "./state";

/** What a player on an older build reads: the same words the server's refusal carries. */
const NEW_VERSION_TEXT = "A new version of neobox is out. Reload to play.";
/** How long the menu must stay idle before the automatic reload, so the prompt can be read. */
const RELOAD_DELAY_MS = 2500;
/** How often an open page asks the browser for a new /sw.js: a deploy reaches a tab left open on the menu. */
const UPDATE_CHECK_MS = 60_000;
/** A page this young does not reload itself (see the header). */
const LOOP_GUARD_MS = 30_000;

let reloadPending = false;
let reloadTimer: number | undefined;

export function watchServiceWorker(store: Store<AppState>): void {
  if (!("serviceWorker" in navigator)) return;
  const sw = navigator.serviceWorker;
  // The first controllerchange is the first install's claim: it never reloads. Later ones are updates.
  let hadController = sw.controller !== null;

  store.subscribe(() => reloadWhenIdle(store));

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
        window.addEventListener("focus", () => void check());
        window.setInterval(() => void check(), UPDATE_CHECK_MS);
      })
      .catch((err: unknown) => {
        if (!pageLeaving()) console.warn("service worker:", err);
      });
  });

  sw.addEventListener("controllerchange", () => {
    const firstInstall = !hadController;
    hadController = true;
    if (!firstInstall) newVersionOut(store);
  });
}

/** This page is on an older build than the one now out: prompt for a reload, and reload once the player is idle on the menu. */
export function newVersionOut(store: Store<AppState>): void {
  reloadPending = true;
  showUpdatePrompt();
  reloadWhenIdle(store);
}

function reloadWhenIdle(store: Store<AppState>): void {
  if (!reloadPending || reloadTimer !== undefined) return;
  const youth = LOOP_GUARD_MS - performance.now();
  if (youth > 0) {
    // too young to reload itself: look again once the guard has passed (no store change may come meanwhile)
    reloadTimer = window.setTimeout(() => {
      reloadTimer = undefined;
      reloadWhenIdle(store);
    }, youth);
    return;
  }
  if (store.state.screen !== "menu" || store.state.inMatch) return;
  reloadTimer = window.setTimeout(() => {
    reloadTimer = undefined;
    if (store.state.screen === "menu" && !store.state.inMatch) location.reload();
  }, RELOAD_DELAY_MS);
}

function showUpdatePrompt(): void {
  if (document.getElementById("update-ready")) return;
  const box = document.createElement("div");
  box.id = "update-ready";
  box.setAttribute("role", "status");
  box.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:1000;display:flex;align-items:center;gap:12px;";
  const text = document.createElement("span");
  text.textContent = NEW_VERSION_TEXT;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "primary";
  button.textContent = "Reload";
  button.onclick = () => location.reload();
  box.append(text, button);
  document.body.appendChild(box);
}
