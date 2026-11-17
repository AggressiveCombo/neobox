// Plain HTTP helpers for the server's JSON endpoints.

import { request } from "./account";
import { HttpError } from "./http-error";

export interface BuiltinMap {
  name: string;
  code: string;
}

export async function fetchBuiltinMaps(signal?: AbortSignal): Promise<BuiltinMap[]> {
  const res = await fetch("/api/maps", { signal, headers: { accept: "application/json" } });
  if (!res.ok) throw new HttpError(res.status);
  const data: unknown = await res.json();
  if (!Array.isArray(data)) throw new Error("The server sent an unexpected reply. Try again in a moment.");
  return data.filter(
    (m): m is BuiltinMap => typeof m?.name === "string" && typeof m?.code === "string",
  );
}

/** Websocket URL of a server base URL (`http` to `ws`, `https` to `wss`); the socket is at `/ws`. */
export function wsUrlFor(base: string): string {
  const url = new URL("/ws", base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

/** Websocket URL of this page's own server (`wss` on https). */
export function wsUrl(): string {
  return wsUrlFor(location.origin);
}

/**
 * GET /api/stats: connections, rooms and players per kind of room. `counts` is keyed like the
 * original's playercount.json: each quick-play mode (`qp_1`, ...), `qp`, `custom` and `total`.
 */
export interface ServerStats {
  online: number;
  rooms: number;
  counts: Record<string, number>;
}

export async function fetchStats(signal?: AbortSignal): Promise<ServerStats> {
  const res = await fetch("/api/stats", { signal, headers: { accept: "application/json" } });
  if (!res.ok) throw new HttpError(res.status);
  return (await res.json()) as ServerStats;
}

/** A quick-play mode of the server's rotation, with the maps it plays in order. */
export interface QuickMode {
  /** `qp_1`, `qp_2`, ... */
  id: string;
  title: string;
  description: string;
  maps: { name: string; author: string; code: string }[];
}

interface RotationJson {
  maps?: { name?: unknown; author?: unknown; leveldata?: unknown; modes?: unknown }[];
  meta?: Record<string, { title?: unknown; description?: unknown } | number>;
}

/** GET /api/rotation (the original's maps2.json format): modes `qp_1`..`qp_10` in order. */
export async function fetchQuickModes(signal?: AbortSignal): Promise<QuickMode[]> {
  const res = await fetch("/api/rotation", { signal, headers: { accept: "application/json" } });
  if (!res.ok) throw new HttpError(res.status);
  const data = (await res.json()) as RotationJson;
  const modes: QuickMode[] = [];
  for (let i = 1; i <= 10; i++) {
    const id = `qp_${i}`;
    const meta = data.meta?.[id];
    if (typeof meta !== "object" || meta === null) continue;
    modes.push({
      id,
      title: typeof meta.title === "string" ? meta.title : id,
      description: typeof meta.description === "string" ? meta.description : "",
      maps: (data.maps ?? [])
        .filter((m) => Array.isArray(m.modes) && m.modes.includes(id) && typeof m.leveldata === "string")
        .map((m) => ({
          name: typeof m.name === "string" ? m.name : "",
          author: typeof m.author === "string" ? m.author : "",
          code: m.leveldata as string,
        })),
    });
  }
  return modes;
}

/**
 * A ticket for a game node, from this (home) server. Only signed-in players have one; null for
 * guests or when it cannot be fetched, and the player then joins the node as a guest.
 */
export async function fetchTicket(): Promise<string | null> {
  try {
    const res = await fetch("/api/ticket", { cache: "no-store", headers: { accept: "application/json" } });
    if (!res.ok) return null;
    const data: unknown = await res.json();
    return typeof data === "object" && data !== null && "ticket" in data && typeof data.ticket === "string"
      ? data.ticket
      : null;
  } catch {
    return null;
  }
}

/** A report filed from inside a room (a player, or the room's map), or on a library map from outside any room. */
export type ReportInput =
  | { kind: "player"; room: string; player: number; reason: string }
  | { kind: "map"; room: string; reason: string }
  | { kind: "map"; map: number; reason: string };

/** POST /api/report. Resolves once the server has stored the report; errors carry the server's message. */
export async function sendReport(input: ReportInput): Promise<void> {
  await request<void>("POST", "/api/report", input);
}
