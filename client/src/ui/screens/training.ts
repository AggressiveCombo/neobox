// Training hall: the fixed training map with two target dummies and a short list
// of lessons. Next steps through the lessons; Finish returns. Keys: the game keys
// from prefs; Esc leaves.

import type { ScreenFactory, ScreenHandle } from "../../ctx";
import type { Engine, LocalStart } from "../../engine";
import { GAMEPAD_LABELS, inputProfile, keyLabel, onInputProfile, padButton } from "../../input";
import { type Action, prefs } from "../../prefs";
import { FrameLoop } from "../../local-loop";
import type { Screen } from "../../state";
import { type Child, h } from "../dom";
import { type EngineStatus, engineStatus } from "../engine-status";
import { icon } from "../icons";
import { page, pageHead } from "../kit";
import { TOUCH_BUTTONS, rotateGate, touchControls } from "./hud";

const TICK_HZ = 30;
/** Endless game mode id, the same one practice uses (lives would strand a player). */
const ENDLESS = 6;

/** Standard gamepad mapping: Start advances a lesson. A stays jump, so it cannot confirm. */
const PAD_START = 9;

/** Label for an action in the player's current input profile: keys, touch controls or pad buttons. */
function controlLabel(action: Action): string {
  switch (inputProfile()) {
    case "pad":
      return GAMEPAD_LABELS[action];
    case "touch":
      return touchLabel(action);
    case "keyboard": {
      const code = prefs.value.keys[action][0];
      return code === undefined ? "an unbound key" : keyLabel(code);
    }
  }
}

/** Touch names: the stick for directions, the on-screen buttons (labelled as in the HUD) for the rest. */
function touchLabel(action: Action): string {
  if (action === "left") return "Stick left";
  if (action === "right") return "Stick right";
  if (action === "down") return "Stick down";
  return TOUCH_BUTTONS[action].label;
}

/** A control named in a lesson: a `.key` box with its label for the current profile. */
function control(action: Action): Child {
  return h("span", { class: "key" }, controlLabel(action));
}

/** Lesson texts, one per step, worded with the player's current bindings (keys are `.key` boxes). */
function lessons(): Child[][] {
  const left = control("left");
  const right = control("right");
  const jump = control("up");
  const push = control("push");
  const rocket = control("rocket");
  const bat = control("bat");
  const grab = control("grab");
  return [
    ["Run with ", left, " and ", right, ". Jump with ", jump, ", and press it again in the air for a second jump. Jump off walls too."],
    ["Keep holding ", jump, " after a jump to rise higher. Your marker turns yellow while the second jump is ready."],
    ["Landing on top of a dummy takes it out. Try it on the dummy that stands still."],
    ["Hold ", push, " to push hard: a dummy shoved into a wall or off the edge is out."],
    [
      "Hold ",
      bat,
      " and let go to swing the bat; it aims by itself. Hold ",
      rocket,
      " and steer with ",
      left,
      " and ",
      right,
      " to aim a rocket.",
    ],
    ["The bar above each name is stamina: abilities spend it and everyone can see it. Hold ", grab, " next to a moving object to hang on."],
    ["Abilities combine, and objects move too. Mix them until you can hit the dummies at will, then Finish."],
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
  let rotate: { el: HTMLElement; destroy(): void } | null = null;
  let lessonEl: HTMLElement | null = null;
  let countEl: HTMLElement | null = null;
  let stepEls: HTMLElement[] = [];
  let nextBtn: HTMLButtonElement | null = null;
  /** Start hint on Next (pad profile only). Created once per showGame, so profile changes never re-create it. */
  let startKey: HTMLElement | null = null;
  let releaseTop: (() => void) | null = null;
  let mapCode = "";
  let engineUi: EngineStatus | null = null;
  let startHeld = false;
  let unsubProfile: (() => void) | null = null;

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
    rotate?.destroy();
    rotate = null;
    releaseTop?.();
    releaseTop = null;
    unsubProfile?.();
    unsubProfile = null;
    startHeld = false;
  }

  function frame(dt: number): void {
    if (!eng) return;
    // Start advances on its press edge; a press is not repeated while held.
    const startDown = padButton(PAD_START);
    const press = startDown && !startHeld;
    startHeld = startDown;
    if (press) {
      next();
      return;
    }
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

  /** The training map as JSON, from the bundled training.json (`{name, map}` like maps/*.json). */
  async function loadMapJson(): Promise<string> {
    const res = await fetch("/training.json");
    if (!res.ok) throw new Error(`training.json: HTTP ${res.status}`);
    const doc: unknown = await res.json();
    const map = typeof doc === "object" && doc !== null && "map" in doc ? doc.map : doc;
    return JSON.stringify(map);
  }

  /** A plain page (loading, errors) with the hall's head and Back. */
  function showPage(...content: Child[]): void {
    engineUi?.destroy();
    // Waiting for the engine shows its progress; a failed load shows the error and Retry at once.
    const status = engineStatus(() => void start());
    engineUi = status;
    root.className = "offline";
    root.replaceChildren(page("offline-page", pageHead({ title: "Training hall", back: leave }), ...content, status.el));
  }

  function showMessage(message: string): void {
    stopGame();
    showPage(h("p", { class: "offline-error" }, message));
  }

  /** Chips and their control names: rebuilt on a profile change, which must not touch the Next button. */
  function renderText(): void {
    if (!lessonEl) return;
    const texts = lessons();
    lessonEl.replaceChildren(h("span", null, ...texts[lesson]));
  }

  function syncStart(): void {
    if (startKey) startKey.style.display = inputProfile() === "pad" ? "" : "none";
  }

  function renderLesson(): void {
    if (!lessonEl || !nextBtn || !countEl || !startKey) return;
    const texts = lessons();
    const last = lesson === texts.length - 1;
    renderText();
    countEl.textContent = `${lesson + 1} of ${texts.length}`;
    stepEls.forEach((step, i) => {
      step.classList.toggle("is-done", i < lesson);
      step.classList.toggle("is-current", i === lesson);
    });
    nextBtn.replaceChildren(last ? "Finish" : "Next", icon(last ? "flag" : "arrow-right", 18), startKey);
    syncStart();
  }

  function next(): void {
    if (lesson < lessons().length - 1) {
      lesson += 1;
      renderLesson();
      return;
    }
    leave();
  }

  /** The original's "Replay Tutorial": a fresh hall from the first lesson. */
  function replayTutorial(): void {
    lesson = 0;
    renderLesson();
    try {
      begin();
    } catch (err) {
      showMessage(`Could not restart: ${errText(err)}`);
    }
  }

  /** The playing view: touch controls under, the top bar, and the lesson card. */
  function showGame(): void {
    touch = touchControls(ctx);
    rotate = rotateGate();
    unsubProfile?.();
    unsubProfile = onInputProfile(() => {
      renderText();
      syncStart();
    });
    lessonEl = h("p", { class: "training-text", "aria-live": "polite" });
    countEl = h("span", { class: "training-count" });
    stepEls = lessons().map(() => h("span", { class: "training-step", "aria-hidden": "true" }));
    startKey = h("span", { class: "key" }, "Start");
    nextBtn = h("button", { type: "button", class: "primary training-next", onclick: next });
    root.className = "offline playing";
    const bar = h(
      "div",
      { class: "offline-top offline-overlay" },
      h("button", { type: "button", onclick: leave }, icon("arrow-left", 18), "Leave"),
      h("span", { class: "offline-title" }, "Training hall"),
      h("button", { type: "button", onclick: replayTutorial }, icon("rotate-ccw", 18), "Replay tutorial"),
    );
    const card = h(
      "section",
      { class: "training-lesson", "aria-label": "Lesson" },
      h("div", { class: "training-progress" }, h("span", { class: "training-steps" }, ...stepEls), countEl),
      lessonEl,
      nextBtn,
    );
    engineUi?.destroy();
    engineUi = null;
    root.replaceChildren(h("main", { class: "offline-play" }, touch.el, bar, card), rotate.el);
    releaseTop = ctx.reserveTop(bar);
    renderLesson();
    loop.start();
  }

  async function start(): Promise<void> {
    showPage(h("p", { class: "offline-status" }, "Loading the training hall…"));
    // The map JSON fetches while the engine loads; encoding needs the engine, so it waits for it.
    const mapJson = loadMapJson();
    mapJson.catch(() => {});
    let engine: Engine;
    try {
      engine = await ctx.engine();
    } catch {
      if (!destroyed) showPage();
      return;
    }
    try {
      mapCode = ctx.wasm.mapEncode(await mapJson);
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
      engineUi?.destroy();
      root.remove();
    },
  } satisfies ScreenHandle;
};
