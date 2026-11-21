// Test play: the editor's map in the engine's offline game, in the chosen game mode.
// The caller shows `nodes` in its playing layer (root class "offline playing",
// see offline.css) and calls `destroy` when it goes back to editing.

import type { AppCtx } from "../ctx";
import type { Engine } from "../engine";
import { FrameLoop } from "../local-loop";
import { TEAM_BLUE, TEAM_FFA, TEAM_RED, isTeamMode, type MatchStart } from "../protocol";
import { h } from "../ui/dom";
import { icon } from "../ui/icons";
import { touchControls } from "../ui/screens/hud";
import type { Obj } from "./schema";

const TICK_HZ = 30;
/** Solo play never ends a match: the default test play mode, with endless respawns. */
export const TEST_PLAY_DEFAULT_MODE = 6;

export interface TestPlay {
  /** Children of the playing layer: touch controls and the top bar. */
  readonly nodes: readonly Node[];
  destroy(): void;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Start a game on `doc` in `mode`. Endless is the player alone; any other mode adds one idle dummy (on the other
 * team in team modes), so modes that end when one player is left still play. Rejects with the engine's message
 * when the map is invalid. `onLeave` runs when the player taps Edit, or with a message when the game stops on an error.
 */
export async function startTestPlay(ctx: AppCtx, doc: Obj, mode: number, onLeave: (failure?: string) => void): Promise<TestPlay> {
  const eng: Engine = await ctx.engine();
  const solo = mode === TEST_PLAY_DEFAULT_MODE;
  const team = isTeamMode(mode);
  const names: ReadonlyMap<number, string> = new Map([
    [0, ctx.store.state.name || "You"],
    [1, "Dummy"],
  ]);
  let running = false;
  let destroyed = false;

  const halt = (): void => {
    if (running) eng.localEnd();
    running = false;
  };
  const begin = (): void => {
    halt();
    const match: MatchStart = {
      seed: Math.floor(Math.random() * 0x7fffffff),
      start_tick: 0,
      tick_hz: TICK_HZ,
      players: solo ? [[0, TEAM_FFA]] : [[0, team ? TEAM_RED : TEAM_FFA], [1, team ? TEAM_BLUE : TEAM_FFA]],
      settings: { game_mode: mode },
      maps: [],
      intro: false,
      rotation: false,
    };
    eng.localStart({ ...match, map: doc, dummies: solo ? [] : [{ id: 1, mode: "idle" }] }, 0);
    running = true;
  };

  const loop = new FrameLoop(
    (dt) => {
      if (eng.localFrame(dt, ctx.input.mask())) begin();
      ctx.present(names, TICK_HZ);
    },
    (err) => {
      if (destroyed) return;
      halt();
      onLeave(errText(err));
    },
  );

  begin();
  const touch = touchControls(ctx);
  const restart = (): void => {
    try {
      begin();
    } catch (err) {
      loop.stop();
      halt();
      onLeave(errText(err));
    }
  };
  const top = h(
    "div",
    { class: "offline-top offline-overlay" },
    h("button", { type: "button", onclick: () => onLeave() }, icon("pencil", 18), "Edit"),
    h("span", { class: "offline-title" }, "Test play"),
    h("button", { type: "button", onclick: restart }, icon("rotate-ccw", 18), "Restart"),
  );
  const releaseTop = ctx.reserveTop(top);
  loop.start();

  return {
    nodes: [touch.el, top],
    destroy() {
      destroyed = true;
      loop.stop();
      halt();
      touch.destroy();
      releaseTop();
    },
  };
}
