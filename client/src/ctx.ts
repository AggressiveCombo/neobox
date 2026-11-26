// The services every screen may use. Built once by app.ts and passed to each
// screen factory. Screens never import net/engine/store singletons directly.

import type { BuiltinMap } from "./api";
import type { Input } from "./input";
import type { ClientMsg } from "./protocol";
import type { Sfx } from "./audio";
import type { Engine, FrameView } from "./engine";
import type { Scene } from "./frame";
import type { AppState, Screen, Store } from "./state";
import type { Net } from "./net";

/**
 * Draws the engine's current frame (renderer, overlay labels, sounds); null when it is empty.
 * `chrome: false` draws the world and player names only (menu clips): no objective bar, feed or banners.
 */
export type Present = (names: ReadonlyMap<number, string>, tickHz: number, chrome?: boolean) => Scene | null;

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
  /** Keep the game view shown while the last frame is held without drawing (a paused menu clip). Without it the view hides after VIEW_IDLE_MS and the clip blanks. */
  readonly holdView: () => void;
  /** Send a JSON control message (dropped silently when disconnected). */
  send(msg: ClientMsg): void;
  /** Short message at the bottom of the screen. */
  toast(text: string, kind?: "info" | "error"): void;
  /** Connect if needed, say hello with `name`, then show the room browser. */
  play(name: string): void;
  /**
   * Join a room by code, with its password if it has one. The room's pending state shows at once; the server's answer
   * follows (connects first with the saved name when needed).
   */
  joinRoom(code: string, password?: string | null): void;
  /** Give up the join or room list still pending (Back or Cancel): returns to where the join was started. */
  cancelJoin(): void;
  /** Quick play: find a room of mode `queue` (`qp_1`, ...), skipping quick-play rooms already visited. */
  quickPlay(queue: string): void;
  /** Close the connection and return to the main menu, or to `screen` in the same state change (no transient menu entry). */
  disconnect(screen?: Screen): void;
  /** Built-in maps from /api/maps (cached). */
  maps(): Promise<BuiltinMap[]>;
  /** The current room's map code and name (asks the server; rejects outside a room or after 5 s). */
  roomMap(): Promise<{ code: string; name: string }>;
  /**
   * Keep the overlay's objective bar and kill line below `bar`, a control strip across
   * the top of a game view, until the returned function is called.
   */
  reserveTop(bar: HTMLElement): () => void;
  /** Keep the objective bar clear of `bar`, a HUD chip row in the view's top corners, until the returned function is called. */
  reserveChrome(bar: HTMLElement): () => void;
  /** Hide the separate canvas objective bar while the HUD topbar renders objective info directly. */
  setObjectiveInTopbar(on: boolean): void;
  /** Open the global bug report or suggestion dialog from any screen. */
  openFeedback(kind: "bug" | "suggestion"): void;
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
