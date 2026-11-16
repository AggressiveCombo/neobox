// The built-in maps for a client that cannot reach the server: build.ts bundles maps/*.json and maps/*.txt as
// /offline-maps.json, and the engine encodes each map into the code /api/maps would have sent.

import type { BuiltinMap } from "./api";
import type { AppCtx } from "./ctx";

export async function bundledMaps(ctx: AppCtx): Promise<BuiltinMap[]> {
  const res = await fetch("/offline-maps.json");
  if (!res.ok) throw new Error(`offline-maps.json: HTTP ${res.status}`);
  const entries: unknown = await res.json();
  if (!Array.isArray(entries)) throw new Error("offline-maps.json: unexpected content");
  await ctx.engine();
  return entries.map((entry: { name: string; map?: unknown; code?: string }) => ({
    name: entry.name,
    code: entry.code ?? ctx.wasm.mapEncode(JSON.stringify(entry.map)),
  }));
}
