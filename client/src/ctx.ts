// The services every screen may use. Built once by app.ts and passed to each
// screen factory. Screens never import net/engine/store singletons directly.

import type { BuiltinMap } from "./api";
import type { Input } from "./input";
import type { ClientMsg } from "./protocol";
import type { Sfx } from "./audio";
import type { Engine, FrameView } from "./engine";
import type { Scene } from "./frame";
import type { AppState, Store } from "./state";
import type { Net } from "./net";

/** Draws the engine's current frame (renderer, overlay labels, sounds); null when it is empty. */
export type Present = (names: ReadonlyMap<number, string>, tickHz: number) => Scene | null;

/** Engine helpers usable without a running match (map picker). */
export interface WasmTools {
  /** Build the lobby layout of a map code (throws Error with the engine message on failure). */
  mapPreview(code: string): FrameView;
  /** Compact map JSON into a map code (throws on failure). */
  mapEncode(json: string): string;
}

export interface AppCtx {
  readonly store: Store<AppState>;
  readonly net: Net;
  readonly input: Input;
  readonly sfx: Sfx;
  readonly wasm: WasmTools;
  /** The game engine (resolves once loaded; replays, local games, editor). */
  engine(): Promise<Engine>;
  /** Draw whatever frame the engine built last. Screens with a game view call it every animation frame. */
  readonly present: Present;
  /** Send a JSON control message (dropped silently when disconnected). */
  send(msg: ClientMsg): void;
  /** Short message at the bottom of the screen. */
  toast(text: string, kind?: "info" | "error"): void;
  /** Connect if needed, say hello with `name`, then show the room browser. */
  play(name: string): void;
  /** Join a room by code (connects with the saved name first, or asks for a name on the menu). */
  joinRoom(code: string): void;
  /** Close the connection and return to the main menu. */
  disconnect(): void;
  /** Built-in maps from /api/maps (cached). */
  maps(): Promise<BuiltinMap[]>;
  /** The current room's map code and name (asks the server; rejects outside a room or after 5 s). */
  roomMap(): Promise<{ code: string; name: string }>;
  /**
   * Keep the overlay's objective bar and kill line below `bar`, a control strip across
   * the top of a game view, until the returned function is called.
   */
  reserveTop(bar: HTMLElement): () => void;
}

/** A mounted screen. The app calls `update` after every store change and `destroy` when leaving. */
export interface ScreenHandle {
  readonly el: HTMLElement;
  update(state: AppState, prev: AppState): void;
  destroy(): void;
}

export type ScreenFactory = (ctx: AppCtx) => ScreenHandle;

/** The in-match HUD: a ScreenHandle that also gets the scene every rendered frame. */
export interface HudHandle extends ScreenHandle {
  /** Called once per rendered frame while the match screen is mounted. Keep it cheap. */
  onFrame(scene: Scene): void;
}

export type HudFactory = (ctx: AppCtx) => HudHandle;
