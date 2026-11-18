// The wasm engine's state on a screen that needs it: a progress bar while the module
// downloads, the failure with a Try again button, and nothing once the engine is ready.

import { type EngineState, engineLoader } from "../engine-loader";
import { h } from "./dom";
import "./engine-status.css";

export interface EngineStatus {
  readonly el: HTMLElement;
  /** Stop following the engine (call when the screen leaves). */
  destroy(): void;
}

/** `onReady` runs once when the engine becomes ready after a failure (a screen that gave up waiting resumes). */
export function engineStatus(onReady?: () => void): EngineStatus {
  const label = h("span", { class: "engine-status-text" });
  const bar = h("progress", { class: "engine-status-bar" });
  const retry = h("button", { type: "button", class: "engine-status-retry", onclick: () => engineLoader.retry() }, "Try again");
  const el = h("div", { class: "engine-status", role: "status" }, label, bar, retry);

  const render = (state: EngineState): void => {
    el.hidden = state.status === "ready";
    el.className = state.status === "failed" ? "engine-status offline-error" : "engine-status offline-status";
    bar.hidden = state.status !== "loading";
    retry.hidden = state.status !== "failed";
    if (state.status === "loading") {
      if (state.total > 0) {
        bar.max = state.total;
        bar.value = state.loaded;
        label.textContent = `Loading the game engine… ${Math.floor((state.loaded / state.total) * 100)}%`;
      } else {
        bar.removeAttribute("value");
        label.textContent = "Loading the game engine…";
      }
    } else if (state.status === "failed") {
      label.textContent = `The game engine failed to load: ${state.error}`;
    }
  };

  // A failure seen by this screen stays pending until the engine recovers, even through the loading state of the retry.
  let recovering = engineLoader.state.status === "failed";
  const unsubscribe = engineLoader.subscribe((state) => {
    if (state.status === "failed") recovering = true;
    render(state);
    if (state.status === "ready" && recovering) {
      recovering = false;
      onReady?.();
    }
  });
  render(engineLoader.state);
  let live = true;
  return {
    el,
    destroy() {
      if (!live) return;
      live = false;
      unsubscribe();
    },
  };
}
