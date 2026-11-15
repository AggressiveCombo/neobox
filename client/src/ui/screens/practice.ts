// Practice: one player in the engine's offline game, on a built-in map or a
// pasted map code, with a rules preset. Needs only the engine, no server.
// Keys: the game keys from prefs; Esc goes back to setup (or closes from setup).

import type { BuiltinMap } from "../../api";
import type { ScreenFactory, ScreenHandle } from "../../ctx";
import type { Engine } from "../../engine";
import { FrameLoop } from "../../local-loop";
import type { GameSettings, MatchStart } from "../../protocol";
import type { Screen } from "../../state";
import { h } from "../dom";
import { touchControls } from "./hud";

const TICK_HZ = 30;

interface Preset {
  id: string;
  label: string;
  hint: string;
  settings: GameSettings;
}

// Solo play never ends a match (the sim's win checks need two players) and in a
// lives mode a player out of lives would be stuck, so practice is always Endless.
const ENDLESS = 6;
const PRESETS: Preset[] = [
  { id: "free", label: "Free play", hint: "Every ability, endless respawns", settings: { game_mode: ENDLESS } },
  {
    id: "movement",
    label: "Movement only",
    hint: "No bat or egg",
    settings: { game_mode: ENDLESS, bat_enabled: false, egg_enabled: false },
  },
];

interface Choice {
  name: string;
  code: string;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function newSeed(): number {
  return Math.floor(Math.random() * 0x7fffffff);
}

/** Setup-view widgets that change with selection and loading. */
interface SetupUi {
  list: HTMLElement;
  presets: HTMLElement;
  start: HTMLButtonElement;
  status: HTMLElement;
  code: HTMLInputElement;
}

export const practiceScreen: ScreenFactory = (ctx) => {
  const root = h("div", { class: "screen offline" });
  let origin: Screen = "menu";
  let originKnown = false;
  let destroyed = false;

  let maps: BuiltinMap[] | null = null;
  let mapsError = "";
  let choice: Choice | null = null;
  let preset = PRESETS[0];
  let setup: SetupUi | null = null;

  // Live game.
  let eng: Engine | null = null;
  let running = false;
  let mapName = "";
  let mapCode = "";
  let rules: GameSettings = {};
  let names: ReadonlyMap<number, string> = new Map();
  let touch: { el: HTMLElement; destroy(): void } | null = null;
  let releaseTop: (() => void) | null = null;

  const loop = new FrameLoop(
    (dt) => frame(dt),
    (err) => showSetup(`The game stopped: ${errText(err)}`),
  );

  /** Where Back returns to; room and browse only when still valid. */
  function resolveOrigin(): Screen {
    const s = ctx.store.state;
    if (origin === "room" && s.room) return "room";
    if (origin === "browse" && s.serverName) return "browse";
    if (origin === "about") return "about";
    return "menu";
  }

  function exit(): void {
    ctx.store.set({ screen: resolveOrigin() });
  }

  /** End the offline game if one runs (idempotent). */
  function stopGame(): void {
    loop.stop();
    if (running) eng?.localEnd();
    running = false;
    touch?.destroy();
    touch = null;
    releaseTop?.();
    releaseTop = null;
  }

  function frame(dt: number): void {
    if (!eng) return;
    eng.localFrame(dt, ctx.input.mask());
    ctx.present(names, TICK_HZ);
  }

  /** Start a fresh game with the current map and rules. */
  function begin(): void {
    if (!eng) return;
    if (running) eng.localEnd();
    running = false;
    const match: MatchStart = {
      seed: newSeed(),
      start_tick: 0,
      tick_hz: TICK_HZ,
      players: [[0, 1]],
      settings: rules,
      maps: [mapCode],
      intro: false,
      rotation: false,
    };
    eng.localStart(match, 0);
    running = true;
  }

  function restart(): void {
    try {
      begin();
    } catch (err) {
      showSetup(`Could not restart: ${errText(err)}`);
    }
  }

  /** The playing view: touch controls under, Leave and Restart on top. */
  function showGame(): void {
    touch = touchControls(ctx);
    root.className = "offline playing";
    const bar = h(
      "div",
      { class: "offline-top offline-overlay" },
      h("button", { type: "button", onclick: () => showSetup() }, "Leave"),
      h("span", { class: "offline-title" }, mapName),
      h("button", { type: "button", onclick: restart }, "Restart"),
    );
    root.replaceChildren(touch.el, bar);
    releaseTop = ctx.reserveTop(bar);
    loop.start();
  }

  function renderMaps(): void {
    if (!setup) return;
    const items: Node[] = [];
    if (maps === null && !mapsError) items.push(h("p", { class: "status" }, "Loading maps…"));
    if (mapsError) items.push(h("p", { class: "offline-error" }, `Could not load maps: ${mapsError}`));
    for (const m of maps ?? []) {
      const selected = choice?.code === m.code;
      items.push(
        h(
          "button",
          {
            type: "button",
            class: "offline-choice",
            "aria-pressed": String(selected),
            onclick: () => {
              choice = { name: m.name, code: m.code };
              renderMaps();
            },
          },
          h("span", null, m.name),
          h("small", null, "Built-in map"),
        ),
      );
    }
    if (choice && !maps?.some((m) => m.code === choice?.code)) {
      items.push(
        h(
          "button",
          { type: "button", class: "offline-choice", "aria-pressed": "true" },
          h("span", null, choice.name),
          h("small", null, "Pasted map code"),
        ),
      );
    }
    setup.list.replaceChildren(...items);
    setup.start.disabled = !choice;
  }

  function renderPresets(): void {
    if (!setup) return;
    setup.presets.replaceChildren(
      ...PRESETS.map((p) =>
        h(
          "button",
          {
            type: "button",
            class: "offline-choice",
            "aria-pressed": String(p.id === preset.id),
            onclick: () => {
              preset = p;
              renderPresets();
            },
          },
          h("span", null, p.label),
          h("small", null, p.hint),
        ),
      ),
    );
  }

  /** Validate a pasted map code with the engine, then select it. */
  async function useCode(): Promise<void> {
    if (!setup) return;
    const code = setup.code.value.trim();
    if (!code) {
      setup.status.textContent = "Paste a map code first.";
      setup.status.classList.add("offline-error");
      return;
    }
    try {
      await ctx.engine();
      ctx.wasm.mapPreview(code);
    } catch (err) {
      if (!setup) return;
      setup.status.textContent = `Invalid map code: ${errText(err)}`;
      setup.status.classList.add("offline-error");
      return;
    }
    if (!setup) return;
    choice = { name: "Pasted map", code };
    setup.status.textContent = "";
    setup.status.classList.remove("offline-error");
    renderMaps();
  }

  async function start(): Promise<void> {
    if (!choice || !setup) return;
    const picked = choice;
    setup.status.textContent = "Starting…";
    setup.status.classList.remove("offline-error");
    let engine: Engine;
    try {
      engine = await ctx.engine();
    } catch (err) {
      if (!destroyed && setup) {
        setup.status.textContent = `The engine failed to load: ${errText(err)}`;
        setup.status.classList.add("offline-error");
      }
      return;
    }
    if (destroyed) return;
    eng = engine;
    mapName = picked.name;
    mapCode = picked.code;
    rules = preset.settings;
    names = new Map([[0, ctx.store.state.name || "You"]]);
    showGame();
    try {
      begin();
    } catch (err) {
      showSetup(`Could not start: ${errText(err)}`);
    }
  }

  /** The setup view: map list, paste field, rules presets, Start. */
  function showSetup(message = ""): void {
    stopGame();
    eng = null;
    root.className = "screen offline";

    const list = h("div", { class: "offline-list" });
    const presets = h("div", { class: "offline-presets" });
    const code = h("input", {
      type: "text",
      placeholder: "Map code",
      autocomplete: "off",
      spellcheck: "false",
      "aria-label": "Map code",
      onkeydown: (e: Event) => {
        if ((e as KeyboardEvent).key === "Enter") void useCode();
      },
    });
    const status = h("p", { class: message ? "offline-error" : "status" }, message);
    const startBtn = h(
      "button",
      { type: "button", class: "primary", onclick: () => void start() },
      "Start",
    );
    setup = { list, presets, start: startBtn, status, code };

    root.replaceChildren(
      h(
        "section",
        { class: "panel" },
        h("h1", { class: "wordmark" }, "Practice"),
        h("p", { class: "credit" }, "Play alone on a map. Nothing is sent to the server."),
        h("div", { class: "field" }, h("span", { class: "field-label" }, "Map"), list),
        h(
          "div",
          { class: "field" },
          h("span", { class: "field-label" }, "Or paste a map code"),
          h(
            "div",
            { class: "actions" },
            code,
            h("button", { type: "button", onclick: () => void useCode() }, "Use code"),
          ),
        ),
        h("div", { class: "field" }, h("span", { class: "field-label" }, "Rules"), presets),
        status,
        h(
          "div",
          { class: "actions" },
          h("button", { type: "button", onclick: exit }, "Back"),
          startBtn,
        ),
      ),
    );

    renderMaps();
    renderPresets();
    if (maps === null && !mapsError) void loadMaps();
  }

  async function loadMaps(): Promise<void> {
    try {
      maps = await ctx.maps();
    } catch (err) {
      mapsError = errText(err);
    }
    if (destroyed) return;
    renderMaps();
  }

  const onKey = (e: KeyboardEvent): void => {
    if (e.code !== "Escape") return;
    e.preventDefault();
    if (running) showSetup();
    else exit();
  };
  window.addEventListener("keydown", onKey);

  showSetup();

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
      eng = null;
      root.remove();
    },
  } satisfies ScreenHandle;
};
