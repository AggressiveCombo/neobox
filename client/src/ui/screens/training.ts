// Training hall: the fixed training map with two target dummies and a short list
// of lessons. Next steps through the lessons; Finish marks the hall as done
// (localStorage) and returns. Keys: the game keys from prefs; Esc leaves.

import type { ScreenFactory, ScreenHandle } from "../../ctx";
import type { Engine, LocalStart } from "../../engine";
import { keyLabel } from "../../input";
import { type Action, prefs } from "../../prefs";
import { FrameLoop } from "../../local-loop";
import type { Screen } from "../../state";
import { h } from "../dom";
import { touchControls } from "./hud";

const TICK_HZ = 30;
/** Endless game mode id, the same one practice uses (lives would strand a player). */
const ENDLESS = 6;
/** localStorage flag set when the player finishes the lessons. */
export const TRAINING_DONE_KEY = "neobox.trainingDone";

/** Label for the first key bound to a game action, as the player set it in Settings. */
function keyName(action: Action): string {
  const code = prefs.value.keys[action][0];
  return code === undefined ? "an unbound key" : keyLabel(code);
}

/** Lesson texts, one per step, worded with the player's current bindings. */
function lessonTexts(): string[] {
  const left = keyName("left");
  const right = keyName("right");
  const jump = keyName("up");
  const push = keyName("push");
  const rocket = keyName("rocket");
  const bat = keyName("bat");
  return [
    `Run with ${left} and ${right} to get a feel for the ground. Jump with ${jump}.`,
    `Jump onto the high ledge, then hit the nearest dummy with the bat (${bat}).`,
    `Hit the dummy on the far side with force push (${push}). Each hit sends it further toward the edge.`,
    `Dummies do not fight back. Mix the bat (${bat}), force push (${push}) and rocket (${rocket}) until you can hit them at will.`,
  ];
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Random seed for each run, so the dummies do not repeat exactly. */
function newSeed(): number {
  return Math.floor(Math.random() * 0x7fffffff);
}

export const trainingScreen: ScreenFactory = (ctx) => {
  const root = h("div", { class: "offline" });
  let origin: Screen = "menu";
  let originKnown = false;
  let destroyed = false;

  let eng: Engine | null = null;
  let running = false;
  let lesson = 0;
  let names: ReadonlyMap<number, string> = new Map();
  let touch: { el: HTMLElement; destroy(): void } | null = null;
  let lessonEl: HTMLElement | null = null;
  let nextBtn: HTMLButtonElement | null = null;

  const loop = new FrameLoop(
    (dt) => frame(dt),
    (err) => showMessage(`The training stopped: ${errText(err)}`),
  );

  /** Where Leave returns to; room and browse only when still valid. */
  function resolveOrigin(): Screen {
    const s = ctx.store.state;
    if (origin === "room" && s.room) return "room";
    if (origin === "browse" && s.serverName) return "browse";
    if (origin === "about") return "about";
    return "menu";
  }

  function leave(): void {
    ctx.store.set({ screen: resolveOrigin() });
  }

  /** End the offline game if one runs (idempotent). */
  function stopGame(): void {
    loop.stop();
    if (running) eng?.localEnd();
    running = false;
    touch?.destroy();
    touch = null;
  }

  function frame(dt: number): void {
    if (!eng) return;
    eng.localFrame(dt, ctx.input.mask());
    ctx.present(names, TICK_HZ);
  }

  /** Start the training match from its first tick. */
  function begin(): void {
    if (!eng) return;
    if (running) eng.localEnd();
    running = false;
    const start: LocalStart = {
      seed: newSeed(),
      start_tick: 0,
      tick_hz: TICK_HZ,
      // everyone free-for-all, like the original's hall
      players: [
        [0, 1],
        [1, 1],
        [2, 1],
      ],
      settings: { game_mode: ENDLESS },
      maps: [mapCode],
      intro: false,
      rotation: false,
      dummies: [
        { id: 1, mode: "left_even" },
        { id: 2, mode: "idle" },
      ],
    };
    eng.localStart(start, 0);
    running = true;
  }

  let mapCode = "";

  /** The training map as a map code, from the bundled training.json (`{name, map}` like maps/*.json). */
  async function loadMapCode(): Promise<string> {
    const res = await fetch("/training.json");
    if (!res.ok) throw new Error(`training.json: HTTP ${res.status}`);
    const doc: unknown = await res.json();
    const map = typeof doc === "object" && doc !== null && "map" in doc ? doc.map : doc;
    return ctx.wasm.mapEncode(JSON.stringify(map));
  }

  function showMessage(message: string): void {
    stopGame();
    root.className = "offline";
    root.replaceChildren(
      h("p", { class: "offline-error" }, message),
      h("button", { type: "button", onclick: leave }, "Back"),
    );
  }

  function renderLesson(): void {
    if (!lessonEl || !nextBtn) return;
    const texts = lessonTexts();
    const last = lesson === texts.length - 1;
    lessonEl.textContent = `${lesson + 1}/${texts.length}  ${texts[lesson]}`;
    nextBtn.textContent = last ? "Finish" : "Next";
  }

  function next(): void {
    if (lesson < lessonTexts().length - 1) {
      lesson += 1;
      renderLesson();
      return;
    }
    localStorage.setItem(TRAINING_DONE_KEY, "1");
    leave();
  }

  function restart(): void {
    try {
      begin();
    } catch (err) {
      showMessage(`Could not restart: ${errText(err)}`);
    }
  }

  /** The playing view: touch controls under, lesson panel and controls on top. */
  function showGame(): void {
    touch = touchControls(ctx);
    lessonEl = h("p", { class: "training-text" });
    nextBtn = h("button", { type: "button", class: "training-next", onclick: next });
    root.className = "offline playing";
    root.replaceChildren(
      touch.el,
      h(
        "div",
        { class: "offline-top offline-overlay" },
        h("button", { type: "button", onclick: leave }, "Leave"),
        h("span", { class: "offline-title" }, "Training hall"),
        h("button", { type: "button", onclick: restart }, "Restart"),
      ),
      h("div", { class: "training-lesson" }, lessonEl, nextBtn),
    );
    renderLesson();
    loop.start();
  }

  async function start(): Promise<void> {
    root.className = "offline";
    root.replaceChildren(h("p", { class: "status" }, "Loading the training hall…"));
    let engine: Engine;
    try {
      [engine, mapCode] = await Promise.all([ctx.engine(), loadMapCode()]);
    } catch (err) {
      if (!destroyed) showMessage(`The training hall could not load: ${errText(err)}`);
      return;
    }
    if (destroyed) return;
    eng = engine;
    names = new Map([
      [0, ctx.store.state.name || "You"],
      [1, "Dummy 1"],
      [2, "Dummy 2"],
    ]);
    showGame();
    try {
      begin();
    } catch (err) {
      showMessage(`Could not start: ${errText(err)}`);
    }
  }

  const onKey = (e: KeyboardEvent): void => {
    if (e.code !== "Escape") return;
    e.preventDefault();
    leave();
  };
  window.addEventListener("keydown", onKey);

  void start();

  return {
    el: root,
    update(_, prev) {
      if (!originKnown) {
        origin = prev.screen;
        originKnown = true;
      }
    },
    destroy() {
      destroyed = true;
      window.removeEventListener("keydown", onKey);
      stopGame();
      root.remove();
    },
  } satisfies ScreenHandle;
};
