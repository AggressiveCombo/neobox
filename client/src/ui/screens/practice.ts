// Practice: one player in the engine's offline game, on a built-in map or a
// pasted map code, with a rules preset. Needs only the engine, no server.
// Keys: the game keys from prefs; Esc goes back to setup (or closes from setup).

import type { BuiltinMap } from "../../api";
import type { ScreenFactory, ScreenHandle } from "../../ctx";
import type { Engine } from "../../engine";
import { HttpError } from "../../http-error";
import { FrameLoop } from "../../local-loop";
import { bundledMaps } from "../../offline-maps";
import type { GameSettings, MatchStart } from "../../protocol";
import type { Screen } from "../../state";
import { type Child, h } from "../dom";
import { type EngineStatus, engineStatus } from "../engine-status";
import { icon } from "../icons";
import { field, page, pageHead, seg } from "../kit";
import { rotateGate, touchControls } from "./hud";
import "./practice.css";

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
  hint: HTMLElement;
  start: HTMLButtonElement;
  status: HTMLElement;
  code: HTMLInputElement;
}

export const practiceScreen: ScreenFactory = (ctx) => {
  const root = h("div", { class: "offline" });
  let origin: Screen = "menu";
  let originKnown = false;
  let destroyed = false;

  let maps: BuiltinMap[] | null = null;
  let mapsError: { copy: string; detail: string } | null = null;
  let choice: Choice | null = null;
  let preset = PRESETS[0];
  let setup: SetupUi | null = null;
  let engineUi: EngineStatus | null = null;
  // Phones: Start is a footer under the scrolling setup, not over it (practice.css). Desktop keeps it in the rules column.
  const phoneQuery = window.matchMedia("(max-width: 600px)");
  function placeStart(): void {
    const bar = root.querySelector<HTMLElement>(".practice-actions");
    const grid = root.querySelector<HTMLElement>(".practice-grid");
    const pg = root.querySelector<HTMLElement>(".practice-page");
    if (!bar || !grid || !pg) return;
    if (phoneQuery.matches) pg.append(bar);
    else grid.append(bar);
  }
  phoneQuery.addEventListener("change", placeStart);

  // Live game.
  let eng: Engine | null = null;
  let running = false;
  let mapName = "";
  let mapCode = "";
  let rules: GameSettings = {};
  let names: ReadonlyMap<number, string> = new Map();
  let touch: { el: HTMLElement; destroy(): void } | null = null;
  let rotate: { el: HTMLElement; destroy(): void } | null = null;
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
    rotate?.destroy();
    rotate = null;
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

  /** The playing view: touch controls under, Leave and Restart on top, the portrait gate over all. */
  function showGame(): void {
    touch = touchControls(ctx);
    rotate = rotateGate();
    root.className = "offline playing";
    const bar = h(
      "div",
      { class: "offline-top offline-overlay" },
      h("button", { type: "button", onclick: () => showSetup() }, icon("arrow-left", 18), "Leave"),
      h("h1", { class: "offline-title" }, mapName),
      h("button", { type: "button", onclick: restart }, icon("rotate-ccw", 18), "Restart"),
    );
    root.replaceChildren(h("main", { class: "offline-play" }, touch.el, bar), rotate.el);
    releaseTop = ctx.reserveTop(bar);
    loop.start();
  }

  /** The map rows: built-in maps, then a pasted code if it is not one of them (shown as the current pick, not a button). */
  function renderMaps(): void {
    if (!setup) return;
    const items: Node[] = [];
    if (maps === null && !mapsError) items.push(h("p", { class: "offline-status", role: "status" }, "Loading maps…"));
    if (mapsError) {
      items.push(
        h(
          "div",
          { class: "offline-error", role: "alert" },
          h("p", null, mapsError.copy),
          h("details", null, h("summary", null, "Details"), h("p", null, mapsError.detail)),
        ),
      );
      items.push(h("button", { type: "button", class: "quiet", onclick: retryMaps }, icon("rotate-ccw", 18), "Try again"));
    }
    if (maps?.length === 0) items.push(h("p", { class: "offline-status" }, "This server has no built-in maps. Paste a map code to play."));
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
          m.name,
        ),
      );
    }
    if (choice && !maps?.some((m) => m.code === choice?.code)) {
      items.push(
        h(
          "div",
          { class: "offline-choice", "aria-current": "true" },
          choice.name,
          h("span", { class: "practice-choice-note" }, "Pasted code"),
        ),
      );
    }
    setup.list.replaceChildren(...items);
    setup.start.disabled = !choice;
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
    } catch {
      // The engine status on this screen reports the failure and offers Try again.
      return;
    }
    try {
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
    } catch {
      // The engine status on this screen reports the failure and offers Try again.
      if (!destroyed && setup) setup.status.textContent = "";
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

  /** The setup view: map tiles, paste field, rules, Start. */
  function showSetup(message = ""): void {
    stopGame();
    engineUi?.destroy();
    eng = null;
    root.className = "offline";

    const list = h("div", { class: "offline-list" });
    const code = h("input", {
      type: "text",
      placeholder: "Map code",
      autocomplete: "off",
      spellcheck: "false",
      onkeydown: (e: Event) => {
        if ((e as KeyboardEvent).key === "Enter") void useCode();
      },
    });
    const hint = h("p", { class: "field-hint" }, preset.hint);
    const rulesSeg = seg(
      "Rules",
      PRESETS.map((p) => ({ value: p.id, label: p.label })),
      preset.id,
      (id) => {
        const next = PRESETS.find((p) => p.id === id);
        if (!next) return;
        preset = next;
        hint.textContent = next.hint;
      },
    );
    const status = h("p", { class: message ? "offline-error" : "offline-status", role: "status" }, message);
    const loading = engineStatus();
    engineUi = loading;
    const startBtn = h("button", { type: "button", class: "primary big block", onclick: () => void start() }, icon("play", 20), "Start");
    setup = { list, hint, start: startBtn, status, code };

    const content: Child[] = [
      h("p", { class: "lead" }, "Play alone on a map. Nothing is sent to the server."),
      h(
        "div",
        { class: "practice-grid" },
        h("section", { class: "section practice-maps" }, h("h2", null, "Map"), list),
        h(
          "div",
          { class: "panel practice-side" },
          h(
            "div",
            { class: "practice-code" },
            field("Map code", code, "Or paste a map code to play it."),
            h("button", { type: "button", onclick: () => void useCode() }, "Use code"),
          ),
          h("h2", null, "Rules"),
          rulesSeg.el,
          hint,
        ),
        h("div", { class: "practice-actions" }, loading.el, status, startBtn),
      ),
    ];
    root.replaceChildren(page("practice-page", pageHead({ title: "Practice", back: exit }), ...content));
    placeStart();

    renderMaps();
    if (maps === null && !mapsError) void loadMaps();
  }

  async function loadMaps(): Promise<void> {
    try {
      maps = await ctx.maps().catch(async (err: unknown) => {
        // The server's list is out of reach (offline): the maps bundled with the app stand in.
        try {
          return await bundledMaps(ctx);
        } catch {
          throw err;
        }
      });
      // Start is one tap away: the first built-in map is picked until the player chooses another.
      choice ??= maps[0] ? { name: maps[0].name, code: maps[0].code } : null;
    } catch (err) {
      mapsError = { copy: err instanceof HttpError ? "The server could not list its maps. Try again." : "Could not load maps. Check your connection, then try again.", detail: errText(err) };
    }
    if (destroyed) return;
    renderMaps();
  }

  /** Load the maps again after a failure (the server first, then the bundled maps). */
  function retryMaps(): void {
    mapsError = null;
    renderMaps();
    void loadMaps();
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
      engineUi?.destroy();
      eng = null;
      phoneQuery.removeEventListener("change", placeStart);
      root.remove();
    },
  } satisfies ScreenHandle;
};
