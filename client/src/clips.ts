// Clips: the last part of a match, cut from the engine's recording (/record) and
// uploaded to the server, where the main menu plays them. Typed wrappers over
// /api/clips; failures carry the server's `error` text.

import type { AppCtx } from "./ctx";

/** Seconds of play a clip keeps: the end of the match. */
const CLIP_SECS = 15;
/** Shortest clip worth uploading, seconds. */
const MIN_CLIP_SECS = 5;

/** One clip in the listing (GET /api/clips), newest first. */
export interface ClipSummary {
  id: number;
  recorder: string;
  map_name: string;
  created: number;
  size: number;
}

async function clipRequest(path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(path, init);
  if (res.ok) return res;
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
  throw new Error(typeof body?.error === "string" ? body.error : `${path}: HTTP ${res.status}`);
}

/**
 * Cut the last 15 s of the current match and upload it under the room's map.
 * Resolves to the chat notice text describing the outcome; never rejects.
 */
export async function recordClip(ctx: AppCtx): Promise<string> {
  try {
    const eng = await ctx.engine();
    const names = (ctx.store.state.room?.players ?? []).map((p): [number, string] => [p.id, p.name]);
    const replay = eng.replayClip(names, CLIP_SECS, MIN_CLIP_SECS);
    if (replay === null) return `Nothing to clip yet: a clip needs at least ${MIN_CLIP_SECS} seconds of play.`;
    // signed-in players are credited by their account; guests by their player name
    const body = { replay, map_name: ctx.store.state.room?.map_name ?? "", name: ctx.store.state.name };
    await clipRequest("/api/clips", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
    });
    return "Clip saved. It can play on the main menu.";
  } catch (err) {
    return `Could not save the clip: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** One page of clips, newest first. `before`: the id of the last clip of the previous page. */
export async function listClips(before?: number): Promise<ClipSummary[]> {
  const query = before === undefined ? "" : `?before=${before}`;
  const res = await clipRequest(`/api/clips${query}`, { headers: { accept: "application/json" } });
  return (await res.json()) as ClipSummary[];
}

/** The replay JSON text of a clip, ready for `Engine.replayLoad`. */
export async function fetchClipReplay(id: number): Promise<string> {
  const res = await clipRequest(`/api/clips/${id}`);
  return res.text();
}
