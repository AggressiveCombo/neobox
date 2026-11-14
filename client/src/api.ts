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

/** Websocket URL for the current origin (`wss` on https). */
export function wsUrl(): string {
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${location.host}/ws`;
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
