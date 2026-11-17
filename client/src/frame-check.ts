// Shape check for server text frames. The client reads only these fields, so a frame missing one (a
// bug, a mismatched server, or a corrupted frame) is dropped here instead of throwing in the handlers.

import type { ServerMsg } from "./protocol";

type Kind = "str" | "num" | "bool" | "arr" | "obj" | "num?" | "obj?";

const FIELDS: Record<string, Record<string, Kind>> = {
  welcome: { version: "num", server: "str", rtc: "bool" },
  joined: { you: "num", token: "str" },
  rtc_answer: { sdp: "str" },
  error: { code: "str", message: "str" },
  rooms: { rooms: "arr" },
  redirect: { url: "str", then: "obj" },
  room: { room: "obj" },
  left: {},
  chat: { from: "num?", name: "str", text: "str" },
  match_start: { start: "obj", you: "num?" },
  snapshot: { start: "obj", tick: "num", state: "str", you: "num?", held: "arr" },
  match_end: { reason: "str" },
  kicked: { reason: "str" },
  tick_rate: { tick_hz: "num" },
  typing: { player: "num" },
  xp: { placement: "num", gained: "num", level: "num" },
  suggest: { from: "num", name: "str", video: "str", title: "str" },
  jukebox: { jukebox: "obj?" },
  map_code: { code: "str", name: "str" },
};

function fits(kind: Kind, v: unknown): boolean {
  switch (kind) {
    case "str":
      return typeof v === "string";
    case "num":
      return typeof v === "number";
    case "bool":
      return typeof v === "boolean";
    case "arr":
      return Array.isArray(v);
    case "obj":
      return typeof v === "object" && v !== null && !Array.isArray(v);
    case "num?":
      return v === null || typeof v === "number";
    case "obj?":
      return v === null || fits("obj", v);
  }
}

/** Deeper checks on the nested objects the screens walk through. */
const NESTED: Record<string, (m: Record<string, unknown>) => boolean> = {
  room: (m) => {
    const r = m.room as Record<string, unknown>;
    return fits("str", r.code) && Array.isArray(r.players) && fits("obj", r.settings);
  },
  match_start: (m) => matchOk(m.start),
  snapshot: (m) => matchOk(m.start),
};

function matchOk(start: unknown): boolean {
  const s = start as Record<string, unknown>;
  return fits("obj", s) && Array.isArray(s.players) && fits("obj", s.settings) && Array.isArray(s.maps);
}

/** The message when `value` is a well-formed server frame, otherwise null (with a console warning). */
export function checkServerMsg(value: object): ServerMsg | null {
  const m = value as Record<string, unknown>;
  const spec = FIELDS[m.t as string];
  if (spec === undefined) {
    console.warn("neobox: dropped server frame with unknown type", m.t);
    return null;
  }
  for (const [field, kind] of Object.entries(spec)) {
    if (!fits(kind, m[field])) {
      console.warn(`neobox: dropped ${String(m.t)} frame: bad "${field}"`);
      return null;
    }
  }
  const nested = NESTED[m.t as string];
  if (nested && !nested(m)) {
    console.warn(`neobox: dropped ${String(m.t)} frame: malformed payload`);
    return null;
  }
  return value as ServerMsg;
}
