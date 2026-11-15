// Plain HTTP helpers for the server's JSON endpoints.

export interface BuiltinMap {
  name: string;
  code: string;
}

export async function fetchBuiltinMaps(signal?: AbortSignal): Promise<BuiltinMap[]> {
  const res = await fetch("/api/maps", { signal, headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`/api/maps: HTTP ${res.status}`);
  const data: unknown = await res.json();
  if (!Array.isArray(data)) throw new Error("/api/maps: unexpected response");
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

/** GET /api/stats: connections, rooms and quick-play players, for the lobby. */
export interface ServerStats {
  online: number;
  rooms: number;
  quick: { ffa: number; teams: number; lives: number };
}

export async function fetchStats(signal?: AbortSignal): Promise<ServerStats> {
  const res = await fetch("/api/stats", { signal, headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`/api/stats: HTTP ${res.status}`);
  return (await res.json()) as ServerStats;
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
