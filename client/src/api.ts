// Plain HTTP helpers for the server's JSON endpoints.

import { request } from "./account";
import { HttpError } from "./http-error";
import { pageFetch } from "./page-leave";

export interface BuiltinMap {
  name: string;
  code: string;
}

export async function fetchBuiltinMaps(signal?: AbortSignal): Promise<BuiltinMap[]> {
  const res = await pageFetch("/api/maps", { signal, headers: { accept: "application/json" } });
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
  const res = await pageFetch("/api/stats", { signal, headers: { accept: "application/json" } });
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
  const res = await pageFetch("/api/rotation", { signal, headers: { accept: "application/json" } });
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
    const res = await pageFetch("/api/ticket", { cache: "no-store", headers: { accept: "application/json" } });
    if (!res.ok) return null;
    const data: unknown = await res.json();
    return typeof data === "object" && data !== null && "ticket" in data && typeof data.ticket === "string"
      ? data.ticket
      : null;
  } catch {
    return null;
  }
}

/** Why a report is filed. The admin list sorts illegal content first. */
export type ReportCategory = "illegal" | "harassment" | "cheating" | "spam" | "inappropriate" | "other";

/** A reason a player picks in a report dialog, and the category the server files it under. */
export interface ReportReason {
  label: string;
  category: ReportCategory;
}

export const PLAYER_REPORT_REASONS: readonly ReportReason[] = [
  { label: "Illegal content", category: "illegal" },
  { label: "Harassment or hate", category: "harassment" },
  { label: "Cheating", category: "cheating" },
  { label: "Spam", category: "spam" },
  { label: "Offensive name", category: "inappropriate" },
  { label: "Other", category: "other" },
];

export const MAP_REPORT_REASONS: readonly ReportReason[] = [
  { label: "Illegal content", category: "illegal" },
  { label: "Offensive", category: "inappropriate" },
  { label: "Broken", category: "other" },
  { label: "Stolen", category: "other" },
  { label: "Spam", category: "spam" },
  { label: "Other", category: "other" },
];

/** A report filed from inside a room (a player, or the room's map), or on a library map from outside any room. */
export type ReportInput =
  | { kind: "player"; room: string; player: number; category: ReportCategory; reason: string }
  | { kind: "map"; room: string; category: ReportCategory; reason: string }
  | { kind: "map"; map: number; category: ReportCategory; reason: string };

/** POST /api/report. Resolves once the server has stored the report; errors carry the server's message. */
export async function sendReport(input: ReportInput): Promise<void> {
  await request<void>("POST", "/api/report", input);
}

export type FeedbackKind = "bug" | "suggestion";

export interface FeedbackInput {
  kind: FeedbackKind;
  message: string;
  screen: string;
  context: string;
  name: string;
}

/** POST /api/feedback. Stores a player bug report or feature suggestion for admins. */
export async function sendFeedback(input: FeedbackInput): Promise<void> {
  await request<void>("POST", "/api/feedback", input);
}

export type HitboxSort = "hot" | "top" | "new" | "picks" | "best";
export type HitboxSearchBy = "both" | "name" | "author";

export interface HitboxMap {
  id: number;
  name: string;
  author: string;
  description: string;
  upvotes: number;
  downvotes: number;
  published: string;
  code: string;
}

export interface HitboxPage {
  maps: HitboxMap[];
  more: boolean;
  next_offset: number | null;
}

export interface HitboxQuery {
  q: string;
  sort: HitboxSort;
  by: HitboxSearchBy;
  offset: number;
}

/** GET /api/hitbox/maps: server-proxied Hitbox.io map search and browse. */
export async function fetchHitboxMaps(query: HitboxQuery, signal?: AbortSignal): Promise<HitboxPage> {
  const params = new URLSearchParams({ sort: query.sort, by: query.by, offset: String(query.offset) });
  const q = query.q.trim();
  if (q !== "") params.set("q", q);
  const res = await pageFetch(`/api/hitbox/maps?${params.toString()}`, {
    signal,
    headers: { accept: "application/json" },
  });
  const text = await res.text();
  let data: unknown = null;
  if (text !== "") {
    try {
      data = JSON.parse(text);
    } catch {
      // handled below
    }
  }
  if (!res.ok) {
    const msg =
      typeof data === "object" && data !== null && "error" in data && typeof data.error === "string"
        ? data.error
        : null;
    if (msg !== null) throw new Error(msg);
    throw new HttpError(res.status);
  }
  if (typeof data !== "object" || data === null || !Array.isArray((data as HitboxPage).maps)) {
    throw new Error("The server sent an unexpected reply. Try again in a moment.");
  }
  return data as HitboxPage;
}
