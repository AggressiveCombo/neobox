// Test play: the editor's map in the engine's offline game, one player, endless.
// The caller shows `nodes` in its playing layer (root class "offline playing",
// see offline.css) and calls `destroy` when it goes back to editing.

import type { AppCtx } from "../ctx";
import type { Engine } from "../engine";
import { FrameLoop } from "../local-loop";
import type { MatchStart } from "../protocol";
import { h } from "../ui/dom";
import { touchControls } from "../ui/screens/hud";
import { mapText } from "./io";
import type { Obj } from "./schema";

const TICK_HZ = 30;
/** Solo play never ends a match, so it runs with endless respawns. */
const ENDLESS = 6;

export interface TestPlay {
  /** Children of the playing layer: touch controls and the top bar. */
  readonly nodes: readonly Node[];
  destroy(): void;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Start a one-player game on `doc`. Rejects with the engine's message when the
 * map is invalid. `onLeave` runs when the player taps Edit, or with a message
 * when the game stops on an error.
 */
export async function startTestPlay(ctx: AppCtx, doc: Obj, onLeave: (failure?: string) => void): Promise<TestPlay> {
  const eng: Engine = await ctx.engine();
  const code = ctx.wasm.mapEncode(mapText(doc));
  const names: ReadonlyMap<number, string> = new Map([[0, ctx.store.state.name || "You"]]);
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
      players: [[0, 1]],
      settings: { game_mode: ENDLESS },
      maps: [code],
      intro: false,
      rotation: false,
    };
    eng.localStart(match, 0);
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
    h("button", { type: "button", onclick: () => onLeave() }, "Edit"),
    h("span", { class: "offline-title" }, "Test play"),
    h("button", { type: "button", onclick: restart }, "Restart"),
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
