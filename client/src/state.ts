// Minimal observable store for app-level state (screen, identity, room, stats).

import type { RoomInfo, RoomState } from "./protocol";
import type { NetStatus, Transport } from "./net";

export type Screen = "menu" | "about" | "browse" | "room" | "match";

export interface ChatLine {
  /** null = server/system message. */
  from: number | null;
  name: string;
  text: string;
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

export interface AppState {
  screen: Screen;
  name: string;
  myId: number | null;
  serverName: string;
  connection: NetStatus;
  /** Close reason or error detail for the last connection change. */
  connectDetail: string;
  rooms: RoomInfo[];
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

export function initialState(): AppState {
  return {
    screen: "menu",
    name: "",
    myId: null,
    serverName: "",
    connection: "closed",
    connectDetail: "",
    rooms: [],
    room: null,
    chat: [],
    inMatch: false,
    tickHz: 0,
    stats: { transport: "ws", pingMs: -1, rttMs: 0, predDepth: 0, rollbacksPerSec: 0, fps: 0 },
    showStats: false,
    showScores: false,
  };
}
