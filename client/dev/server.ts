// Dev-only server: serves the client with the fake engine and a mock /ws that
// speaks src/protocol.ts. Run with `bun client/dev/server.ts` (PORT, default 5173).

import path from "node:path";
import type { ServerWebSocket } from "bun";
import {
  GAME_MODES,
  MAX_CHAT_LEN,
  MAX_ROOM_NAME_LEN,
  NAME_RE,
  ROOM_MAX_PLAYERS,
  ROOM_MIN_PLAYERS,
  TEAM_BLUE,
  TEAM_FFA,
  TEAM_RED,
  TEAM_SPECTATOR,
  isTeamMode,
} from "../src/protocol";
import type { ClientMsg, GameSettings, MatchStart, RoomInfo, RoomState, ServerMsg } from "../src/protocol";
import { SETTINGS } from "../src/settings";
import type { SettingKind } from "../src/settings";

const CLIENT = path.resolve(import.meta.dir, "..");
const PORT = Number(process.env.PORT ?? 5173);
const TICK_HZ = 60;
const BOT_ID_BASE = 1000;
const DEFAULT_MODE = 0;
const MAP_NAME = "Alpha";

interface Session {
  id: number;
  name: string;
  hello: boolean;
  room: Room | null;
}

interface Member {
  id: number;
  name: string;
  team: number;
}

interface Room {
  code: string;
  name: string;
  max_players: number;
  password: string | null;
  public: boolean;
  members: Member[];
  hostId: number;
  settings: GameSettings;
  map_name: string;
  in_match: boolean;
  bans: Set<string>;
}

const MAPS = [
  { name: "Alpha", code: "nbx-alpha-01" },
  { name: "Bravo", code: "nbx-bravo-02" },
  { name: "Charlie", code: "nbx-charlie-03" },
];

const DEFAULT_SETTINGS: GameSettings = {
  game_mode: DEFAULT_MODE,
  time_scale: 1,
  gravity_offset: 0,
  push_players: true,
  push_range: 12,
  push_delay: 0,
  max_stamina: 100,
  bat_enabled: true,
  dash_enabled: true,
  parachute_enabled: true,
  egg_enabled: false,
  objective_limit: 10,
  player_width: 1,
  player_height: 2,
};

const rooms = new Map<string, Room>();
const sockets = new Map<number, ServerWebSocket<Session>>();
let nextId = 1;
let nextBotId = BOT_ID_BASE;

function addFixtureRoom(
  code: string,
  name: string,
  max_players: number,
  password: string | null,
  bots: string[],
  map_name: string,
  in_match: boolean,
): void {
  const members = bots.map((n) => ({ id: nextBotId++, name: n, team: TEAM_FFA }));
  const hostId = members[0]?.id ?? 0;
  rooms.set(code, {
    code,
    name,
    max_players,
    password,
    public: true,
    members,
    hostId,
    settings: { ...DEFAULT_SETTINGS },
    map_name,
    in_match,
    bans: new Set(),
  });
}

addFixtureRoom("LOBBY1", "Open lobby", 8, null, ["Nova", "Pixel"], "Alpha", false);
addFixtureRoom("SECRET", "Private room", 4, "hunter2", ["Quill"], "Bravo", false);
addFixtureRoom("FAST01", "Fast kills", 6, null, ["Rift", "Ember", "Orbit", "Vex"], "Charlie", true);

function newSession(): Session {
  return { id: nextId++, name: "", hello: false, room: null };
}

function newCode(): string {
  for (;;) {
    const code = crypto.randomUUID().slice(0, 6).toUpperCase();
    if (!rooms.has(code)) return code;
  }
}

function modeOf(room: Room): number {
  const mode = room.settings.game_mode;
  return typeof mode === "number" ? mode : DEFAULT_MODE;
}

function send(id: number, msg: ServerMsg): void {
  sockets.get(id)?.send(JSON.stringify(msg));
}

function sendError(id: number, code: string, message: string): void {
  send(id, { t: "error", code, message });
}

function roomState(room: Room): RoomState {
  return {
    code: room.code,
    name: room.name,
    max_players: room.max_players,
    password: room.password !== null,
    players: room.members.map((m) => ({ id: m.id, name: m.name, team: m.team, ping_ms: 25, host: m.id === room.hostId })),
    settings: room.settings,
    map_name: room.map_name,
    in_match: room.in_match,
    tick_hz: TICK_HZ,
  };
}

function roomInfo(room: Room): RoomInfo {
  return {
    code: room.code,
    name: room.name,
    players: room.members.length,
    max_players: room.max_players,
    password: room.password !== null,
    in_match: room.in_match,
    map: room.map_name,
  };
}

function sendRoom(room: Room, msg: ServerMsg): void {
  for (const m of room.members) send(m.id, msg);
}

function broadcastRoom(room: Room): void {
  sendRoom(room, { t: "room", room: roomState(room) });
}

/** Removes the session from its room; the host passes to the next member; empty rooms are dropped. */
function leave(s: Session): void {
  const room = s.room;
  if (!room) return;
  s.room = null;
  room.members = room.members.filter((m) => m.id !== s.id);
  if (room.members.length === 0) {
    rooms.delete(room.code);
    return;
  }
  const next = room.members[0];
  if (room.hostId === s.id && next) room.hostId = next.id;
  broadcastRoom(room);
}

/** Applies a game mode: team modes give FFA players red; other modes drop red/blue to FFA. */
function setMode(room: Room, mode: number): void {
  room.settings.game_mode = mode;
  const teamMode = isTeamMode(mode);
  for (const m of room.members) {
    if (teamMode && m.team === TEAM_FFA) m.team = TEAM_RED;
    if (!teamMode && (m.team === TEAM_RED || m.team === TEAM_BLUE)) m.team = TEAM_FFA;
  }
}

function parseSetting(kind: SettingKind, raw: string): number | boolean | null {
  if (kind === "b") return raw === "true";
  const n = Number(raw.trim());
  if (!Number.isFinite(n)) return null;
  return kind === "i" ? Math.trunc(n) : n;
}

/** The caller's room when they are its host; otherwise sends the error and returns null. */
function hostRoom(s: Session, what: string): Room | null {
  const room = s.room;
  if (!room) {
    sendError(s.id, "not_in_room", "Join a room first");
    return null;
  }
  if (room.hostId !== s.id) {
    sendError(s.id, "not_host", `Only the host can ${what}`);
    return null;
  }
  return room;
}

function handle(s: Session, msg: ClientMsg): void {
  switch (msg.t) {
    case "hello": {
      if (!NAME_RE.test(msg.name)) {
        sendError(s.id, "invalid_playername", "Names are 1-15 letters, digits, spaces or underscores");
        return;
      }
      s.name = msg.name;
      s.hello = true;
      send(s.id, { t: "welcome", version: 1, server: "neobox dev", rtc: false });
      return;
    }
    case "list_rooms":
      send(s.id, { t: "rooms", rooms: [...rooms.values()].filter((r) => r.public).map(roomInfo) });
      return;
    case "create_room": {
      if (msg.max_players < ROOM_MIN_PLAYERS || msg.max_players > ROOM_MAX_PLAYERS) {
        sendError(s.id, "bad_message", `Rooms hold ${ROOM_MIN_PLAYERS}-${ROOM_MAX_PLAYERS} players`);
        return;
      }
      leave(s);
      const name = msg.name.trim().slice(0, MAX_ROOM_NAME_LEN) || `${s.name}'s game`;
      const room: Room = {
        code: newCode(),
        name,
        max_players: msg.max_players,
        password: msg.password || null,
        public: msg.public,
        members: [{ id: s.id, name: s.name, team: TEAM_FFA }],
        hostId: s.id,
        settings: { ...DEFAULT_SETTINGS },
        map_name: MAP_NAME,
        in_match: false,
        bans: new Set(),
      };
      rooms.set(room.code, room);
      s.room = room;
      send(s.id, { t: "joined", you: s.id });
      broadcastRoom(room);
      return;
    }
    case "join_room": {
      leave(s);
      const room = rooms.get(msg.room);
      if (!room) {
        sendError(s.id, "room_not_found", "Room not found");
        return;
      }
      if (room.password !== null && msg.password !== room.password) {
        sendError(s.id, "wrong_password", "Wrong password");
        return;
      }
      if (room.bans.has(s.name)) {
        sendError(s.id, "banned", "You are banned from this room");
        return;
      }
      if (room.members.length >= room.max_players) {
        sendError(s.id, "room_full", "The room is full");
        return;
      }
      const team = room.in_match || isTeamMode(modeOf(room)) ? TEAM_SPECTATOR : TEAM_FFA;
      room.members.push({ id: s.id, name: s.name, team });
      s.room = room;
      send(s.id, { t: "joined", you: s.id });
      broadcastRoom(room);
      return;
    }
    case "leave_room":
      leave(s);
      send(s.id, { t: "left" });
      return;
    case "chat": {
      const room = s.room;
      if (!room) {
        sendError(s.id, "not_in_room", "Join a room first");
        return;
      }
      const text = msg.text.trim();
      if (text.length === 0 || text.length > MAX_CHAT_LEN) {
        sendError(s.id, "bad_message", `Chat messages are 1-${MAX_CHAT_LEN} characters`);
        return;
      }
      sendRoom(room, { t: "chat", from: s.id, name: s.name, text });
      return;
    }
    case "set_team": {
      const room = s.room;
      if (!room) {
        sendError(s.id, "not_in_room", "Join a room first");
        return;
      }
      const teamMode = isTeamMode(modeOf(room));
      const allowed = teamMode ? [TEAM_SPECTATOR, TEAM_RED, TEAM_BLUE] : [TEAM_SPECTATOR, TEAM_FFA];
      if (!allowed.includes(msg.team)) {
        sendError(s.id, "bad_team", teamMode ? "This mode uses red and blue teams" : "Teams are only used in team modes");
        return;
      }
      const me = room.members.find((m) => m.id === s.id);
      if (me) me.team = msg.team;
      broadcastRoom(room);
      return;
    }
    case "set_map": {
      const room = hostRoom(s, "change the map");
      if (!room) return;
      const map = MAPS.find((m) => m.code === msg.code);
      if (!map) {
        sendError(s.id, "bad_map", "Could not load the map");
        return;
      }
      room.map_name = msg.name ?? map.name;
      broadcastRoom(room);
      return;
    }
    case "set_setting": {
      const room = hostRoom(s, "change settings");
      if (!room) return;
      const def = SETTINGS.find((d) => d.label.toLowerCase() === msg.key.toLowerCase());
      if (!def) {
        sendError(s.id, "bad_setting", `Unknown setting ${msg.key}`);
        return;
      }
      const value = parseSetting(def.kind, msg.value);
      if (value === null) {
        sendError(s.id, "bad_setting", `Invalid value for ${def.label}`);
        return;
      }
      room.settings[def.field] = value;
      broadcastRoom(room);
      return;
    }
    case "reset_settings": {
      const room = hostRoom(s, "change settings");
      if (!room) return;
      room.settings = { ...DEFAULT_SETTINGS };
      setMode(room, DEFAULT_MODE);
      broadcastRoom(room);
      return;
    }
    case "set_mode": {
      const room = hostRoom(s, "change the mode");
      if (!room) return;
      if (!GAME_MODES.some((m) => m.id === msg.mode)) {
        sendError(s.id, "bad_setting", "Unknown game mode");
        return;
      }
      setMode(room, msg.mode);
      broadcastRoom(room);
      return;
    }
    case "start": {
      const room = hostRoom(s, "start the match");
      if (!room) return;
      const players = room.members
        .filter((m) => m.team !== TEAM_SPECTATOR)
        .map((m): [number, number] => [m.id, m.team]);
      const start: MatchStart = {
        seed: Math.floor(Math.random() * 2 ** 31),
        start_tick: 0,
        tick_hz: TICK_HZ,
        players,
        settings: room.settings,
        maps: [],
        intro: true,
        rotation: false,
      };
      for (const m of room.members) send(m.id, { t: "match_start", start, you: m.id });
      return;
    }
    case "kick": {
      const room = hostRoom(s, "kick players");
      if (!room) return;
      const target = room.members.find((m) => m.id === msg.player);
      if (!target || target.id === s.id) {
        sendError(s.id, "bad_message", "No such player");
        return;
      }
      room.members = room.members.filter((m) => m.id !== target.id);
      if (msg.ban) room.bans.add(target.name);
      const kicked = sockets.get(target.id);
      if (kicked) kicked.data.room = null;
      send(target.id, { t: "kicked", reason: msg.ban ? "You were banned by the host" : "You were kicked by the host" });
      broadcastRoom(room);
      return;
    }
    default:
      sendError(s.id, "bad_message", "Not supported by the dev server");
  }
}

function onMessage(s: Session, text: string): void {
  let msg: ClientMsg | null;
  try {
    msg = JSON.parse(text);
  } catch {
    msg = null;
  }
  if (msg === null || typeof msg !== "object") {
    sendError(s.id, "bad_message", "Malformed message");
    return;
  }
  if (!s.hello && msg.t !== "hello") {
    sendError(s.id, "bad_message", "Say hello first");
    return;
  }
  handle(s, msg);
}

function notFound(): Response {
  return new Response("not found", { status: 404 });
}

async function serveFile(rel: string): Promise<Response> {
  const full = path.resolve(CLIENT, rel);
  if (!full.startsWith(CLIENT + path.sep)) return notFound();
  const file = Bun.file(full);
  return (await file.exists()) ? new Response(file) : notFound();
}

async function indexHtml(): Promise<Response> {
  const html = await Bun.file(path.join(CLIENT, "index.html")).text();
  return new Response(html.replace("./src/main.ts", "/dev/entry.js"), {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

async function entryBundle(): Promise<Response> {
  const result = await Bun.build({
    entrypoints: [path.join(import.meta.dir, "entry.ts")],
    target: "browser",
    format: "esm",
    minify: false,
  });
  const out = result.outputs[0];
  if (!result.success || !out) {
    return new Response(result.logs.map(String).join("\n"), { status: 500 });
  }
  return new Response(await out.text(), { headers: { "content-type": "text/javascript; charset=utf-8" } });
}

async function route(pathname: string): Promise<Response> {
  if (pathname === "/" || pathname === "/index.html") return indexHtml();
  if (pathname === "/dev/entry.js") return entryBundle();
  if (pathname === "/api/maps") return Response.json(MAPS);
  if (pathname === "/logo.svg") return serveFile("public/logo.svg");
  if (pathname.startsWith("/src/") || pathname.startsWith("/public/")) return serveFile(pathname.slice(1));
  return notFound();
}

const server = Bun.serve<Session>({
  port: PORT,
  async fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === "/ws") {
      return srv.upgrade(req, { data: newSession() }) ? undefined : new Response("upgrade failed", { status: 400 });
    }
    return route(url.pathname);
  },
  websocket: {
    open(ws) {
      sockets.set(ws.data.id, ws);
    },
    message(ws, message) {
      // Binary frames are per-tick input packets; the dev server does not simulate matches, so it drops them.
      if (typeof message === "string") onMessage(ws.data, message);
    },
    close(ws) {
      leave(ws.data);
      sockets.delete(ws.data.id);
    },
  },
});

console.log(`neobox dev server: http://localhost:${server.port}`);
