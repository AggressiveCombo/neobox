// Minimal observable store for app-level state (screen, identity, room, stats).

import type { QuickQueue, RoomInfo, RoomState, XpAward } from "./protocol";
import type { NetStatus, Transport } from "./net";

export type Screen =
  | "menu"
  | "about"
  | "privacy"
  | "browse"
  | "quick"
  | "room"
  | "match"
  | "replay"
  | "practice"
  | "training"
  | "settings"
  | "account"
  | "friends"
  | "library"
  | "editor";

export interface ChatLine {
  /** null = server/system message. */
  from: number | null;
  name: string;
  text: string;
  /** A YouTube link the player pasted: the host can play it on the jukebox. */
  suggest?: { video: string; title: string };
}

/** Live numbers for the F3 stats overlay (refreshed about 4 times a second). */
export interface Stats {
  transport: Transport;
  /** Last measured ping to the server, ms (-1 unknown). */
  pingMs: number;
  /** Round-trip estimate from the engine, ms. */
  rttMs: number;
  /** Confirmed ticks behind the head (prediction depth). */
  predDepth: number;
  rollbacksPerSec: number;
  fps: number;
}

/** The signed-in account (from GET /api/account/me), or null for guests. */
export interface Account {
  id: number;
  name: string;
  /** Experience total (see levels.ts). */
  xp: number;
}

export interface AppState {
  screen: Screen;
  name: string;
  account: Account | null;
  myId: number | null;
  serverName: string;
  connection: NetStatus;
  /** Close reason or error detail for the last connection change. */
  connectDetail: string;
  rooms: RoomInfo[];
  /** The viewer's country (ISO alpha-2) from the room list: km or miles, and the flag column. Null if unknown. */
  country: string | null;
  room: RoomState | null;
  chat: ChatLine[];
  /** Set while a match is running (from match_start or snapshot). */
  inMatch: boolean;
  /** Server tick rate for the current match (0 = none). */
  tickHz: number;
  stats: Stats;
  /** Stats overlay (F3) and scoreboard (Tab held) visibility. Toggled by app.ts from keys. */
  showStats: boolean;
  showScores: boolean;
  /** A finished online match can be saved as a replay (cleared when a match starts or the room is left). */
  replayReady: boolean;
  /** The connection dropped while in a room; retrying with the room's resume token. */
  reconnecting: boolean;
  /** Quick-play queue to join after the next welcome (menu quick play). */
  intent: QuickQueue | null;
  /** Room code that needs a password (invite link or a join that was refused). */
  invite: string | null;
  /** Experience from the last game (shown by the post-game panel; cleared when it closes or a match starts). */
  xp: XpAward | null;
  /** Players typing a chat line: player id → time (performance.now()) of their last typing signal. */
  typing: Readonly<Record<number, number>>;
  /** The map editor was opened from the room by the host: it can send its map back to the room. */
  editorForRoom: boolean;
}

export type Listener<T> = (state: T, prev: T) => void;

export class Store<T extends object> {
  private listeners = new Set<Listener<T>>();

  constructor(public state: T) {}

  set(patch: Partial<T>): void {
    const prev = this.state;
    this.state = { ...prev, ...patch };
    for (const fn of this.listeners) fn(this.state, prev);
  }

  subscribe(fn: Listener<T>): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

export const CHAT_LIMIT = 200;
export const NAME_STORAGE_KEY = "neobox.name";
/** sessionStorage: this tab's room seat `{ room, token }`, so a reload resumes it. */
export const SEAT_STORAGE_KEY = "neobox.seat";

export function initialState(): AppState {
  return {
    screen: "menu",
    name: "",
    account: null,
    myId: null,
    serverName: "",
    connection: "closed",
    connectDetail: "",
    rooms: [],
    country: null,
    room: null,
    chat: [],
    inMatch: false,
    tickHz: 0,
    stats: { transport: "ws", pingMs: -1, rttMs: 0, predDepth: 0, rollbacksPerSec: 0, fps: 0 },
    showStats: false,
    showScores: false,
    replayReady: false,
    reconnecting: false,
    intent: null,
    invite: null,
    xp: null,
    typing: {},
    editorForRoom: false,
  };
}
