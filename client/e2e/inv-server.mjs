// Inventory rows for the server edge: connection close reasons, errors, reconnect, admin actions and account HTTP
// errors. Each scenario names the rows it proves in `inv`. Raw-socket scenarios assert the wire (close code and
// reason, error code and text) and run on chromium only; browser scenarios assert the text the player sees.

import { adminPost, builtinMaps, ipIn, PASSWORD, regionServers, sleep, startServer, uniqueName } from "./lib.mjs";

const check = (ok, message) => {
  if (!ok) throw new Error(message);
};

const WAIT_MS = 6_000;

/** A raw socket: records every JSON frame and the close. `until` resolves with the first frame matching `pred` after `from`. */
function socket(base, { ip, cookie } = {}) {
  const headers = {
    ...(ip && { "X-Forwarded-For": ip }),
    ...(cookie && { cookie }),
  };
  const ws = new WebSocket(`${base.replace(/^http/, "ws")}/ws`, { headers });
  const msgs = [];
  let close = null;
  let resolveClosed;
  const closed = new Promise((resolve) => (resolveClosed = resolve));
  const opening = new Promise((resolve) => {
    ws.onopen = () => resolve(true);
    ws.onerror = () => resolve(false);
  });
  ws.onmessage = (ev) => {
    if (typeof ev.data === "string") msgs.push(JSON.parse(ev.data));
  };
  ws.onclose = (ev) => {
    close = { code: ev.code, reason: ev.reason };
    resolveClosed(close);
  };
  const sock = {
    ws,
    msgs,
    opening,
    closed,
    send(obj) {
      ws.send(JSON.stringify(obj));
    },
    async until(pred, from = 0, ms = WAIT_MS) {
      const end = Date.now() + ms;
      for (;;) {
        for (let i = from; i < msgs.length; i++) if (pred(msgs[i])) return msgs[i];
        if (Date.now() > end) throw new Error(`no matching frame in ${ms} ms; got ${JSON.stringify(msgs.slice(from))}`);
        await sleep(25);
      }
    },
    /** Sends `obj` and expects the error `code` (null: any code) and text `message` (optional); returns the frame. */
    async expectError(obj, code, message) {
      const from = msgs.length;
      sock.send(obj);
      const e = await sock.until((m) => m.t === "error", from);
      check(code === null || e.code === code, `${obj.t}: error code ${e.code} (want ${code}): ${e.message}`);
      if (message) check(e.message === message, `${obj.t}: error text "${e.message}" (want "${message}")`);
      return e;
    },
    async hello(name) {
      const from = msgs.length;
      sock.send({ t: "hello", version: 1, name });
      const w = await sock.until((m) => m.t === "welcome" || m.t === "error", from);
      check(w.t === "welcome", `hello ${name}: ${w.code} ${w.message}`);
      return w;
    },
    async createRoom(name, opts = {}) {
      const from = msgs.length;
      sock.send({ t: "create_room", name, password: null, max_players: 4, public: false, ...opts });
      const joined = await sock.until((m) => m.t === "joined", from);
      const room = await sock.until((m) => m.t === "room", from);
      return { you: joined.you, code: room.room.code };
    },
    async joinRoom(code, password = null) {
      const from = msgs.length;
      sock.send({ t: "join_room", room: code, password });
      const joined = await sock.until((m) => m.t === "joined" || m.t === "error", from);
      check(joined.t === "joined", `join ${code}: ${joined.code} ${joined.message}`);
      return joined;
    },
    shut() {
      try {
        ws.close();
      } catch {
        // already closed
      }
    },
  };
  return sock;
}

/** A connected socket with a hello done. */
async function player(base, name, opts) {
  const c = socket(base, opts);
  check(await c.opening, `could not open ${name}'s socket`);
  await c.hello(name);
  return c;
}

// ---------------------------------------------------------------- protocol (no room)

async function protocolErrors(s) {
  const base = s.base;
  // malformed JSON before hello
  let c = socket(base);
  await c.opening;
  c.ws.send("not json{");
  const bad = await c.until((m) => m.t === "error");
  check(bad.code === "bad_message" && bad.message === "Malformed message", `malformed: ${bad.code} ${bad.message}`);
  c.shut();

  // any command before hello
  c = socket(base);
  await c.opening;
  await c.expectError({ t: "list_rooms" }, "no_hello", "Say hello first");
  c.shut();

  // stale protocol version
  c = socket(base);
  await c.opening;
  await c.expectError({ t: "hello", version: 0, name: "Stale" }, "version", "Please reload the page: the game was updated");
  c.shut();

  // invalid player name
  c = socket(base);
  await c.opening;
  await c.expectError({ t: "hello", version: 1, name: "bad!name" }, "invalid_playername", "Names are 1-15 letters, digits, spaces or underscores");
  c.shut();

  // unknown quick-play queue
  c = await player(base, uniqueName("Queue"));
  await c.expectError({ t: "quick_play", queue: "bogus", exclude: [] }, "bad_queue", "Unknown quick-play mode");
  c.shut();

  // chat outside a room
  c = await player(base, uniqueName("Lobby"));
  await c.expectError({ t: "chat", text: "hi" }, "not_in_room", "Join a room first");
  c.shut();

  // unknown room code
  c = await player(base, uniqueName("Seek"));
  await c.expectError({ t: "join_room", room: "ZZZZZZ", password: null }, "room_not_found", "Room not found");
  c.shut();

  // password over the limit
  c = await player(base, uniqueName("Pass"));
  await c.expectError(
    { t: "create_room", name: "Long", password: "p".repeat(65), max_players: 2, public: false },
    "bad_password",
    "Passwords are at most 64 characters",
  );
  c.shut();

  // WebRTC offer with WebRTC off (the default config)
  c = await player(base, uniqueName("Rtc"));
  await c.expectError({ t: "rtc_offer", sdp: "v=0" }, "rtc_unavailable", "WebRTC is disabled");
  c.shut();

  // a message flood closes the socket with policy 1008 "flood"
  c = await player(base, uniqueName("Flood"));
  for (let i = 0; i < 450; i++) c.ws.send(JSON.stringify({ t: "list_rooms" }));
  const flood = await c.closed;
  check(flood.code === 1008 && flood.reason === "flood", `flood close: ${flood.code} ${flood.reason}`);

  // a frame over the size limit closes with 1009
  c = await player(base, uniqueName("Big"));
  c.ws.send("x".repeat(2 * 1024 * 1024 + 8192));
  const big = await c.closed;
  check(big.code === 1009, `oversize frame close: ${big.code} ${big.reason}`);
  return "malformed, no_hello, version, bad name, bad queue, not in room, room not found, bad password, rtc unavailable, flood 1008, too_big 1009";
}

// ---------------------------------------------------------------- room errors

async function roomErrors(s) {
  const base = s.base;
  const host = await player(base, uniqueName("Host"));
  const { code } = await host.createRoom("Edge", { password: "pw", max_players: 2 });

  // wrong password, then a correct guest fills the room
  const wrong = await player(base, uniqueName("Wrong"));
  await wrong.expectError({ t: "join_room", room: code, password: "nope" }, null, "Wrong password");
  wrong.shut();

  const guest = await player(base, uniqueName("Guest"));
  await guest.joinRoom(code, "pw");

  const third = await player(base, uniqueName("Third"));
  await third.expectError({ t: "join_room", room: code, password: "pw" }, null, "The room is full");
  third.shut();

  // a non-host cannot lock teams, change mode, or start
  await guest.expectError({ t: "set_lock", locked: true }, "not_host", "Only the host can lock teams");
  await guest.expectError({ t: "set_mode", mode: 3 }, "not_host", "Only the host can change the mode");
  await guest.expectError({ t: "start" }, "not_host", "Only the host can start");

  // host-only: bad team ids, then lock, then a locked guest cannot move
  await host.expectError({ t: "set_team", team: 9 }, "bad_team", "No such team");
  await host.expectError({ t: "set_team", team: 2 }, "bad_team", "Teams are only used in team modes");
  const locked = host.until((m) => m.t === "room");
  host.send({ t: "set_lock", locked: true });
  await locked;
  await guest.expectError({ t: "set_team", team: 1 }, "teams_locked", "Teams are locked by the host");

  // map, settings, jukebox
  await host.expectError({ t: "set_map", code: "not a map!!", name: null }, "bad_map");
  await host.expectError({ t: "set_map", code: "A".repeat(2 * 1024 * 1024 + 1), name: null }, "map_too_large", "Map is too large");
  await host.expectError({ t: "set_setting", key: "nosuchkey", value: "1" }, "bad_setting");
  await host.expectError({ t: "set_mode", mode: 9 }, "bad_setting", "Unknown game mode");
  await host.expectError({ t: "jukebox", action: "play", video: "https://example.com/x" }, "bad_video", "That is not a YouTube video");
  await host.expectError({ t: "jukebox", action: "dance" }, "bad_message", "Unknown jukebox action");

  // chat burst past the budget
  let limited = false;
  for (let i = 0; i < 8 && !limited; i++) {
    const from = host.msgs.length;
    host.send({ t: "chat", text: `burst ${i}` });
    const hit = await host.until((m) => m.t === "error" || m.t === "chat", from).catch(() => null);
    if (hit?.t === "error" && hit.code === "rate_limited") limited = true;
  }
  check(limited, "chat burst never hit rate_limited");
  host.shut();
  guest.shut();
  return "wrong password, room full, not host (lock/mode/start), bad team, teams locked, bad map, map too large, bad setting, bad video, jukebox action, rate limited";
}

async function inMatch(s) {
  const base = s.base;
  const host = await player(base, uniqueName("Solo"));
  await host.createRoom("Solo", { max_players: 2 });
  // a host alone starts at once
  const started = host.until((m) => m.t === "match_start");
  host.send({ t: "start" });
  await started;
  const [map] = await builtinMaps(base);
  await host.expectError({ t: "set_map", code: map.code, name: map.name }, "in_match", "Wait for the match to end");
  // the host ends the match: match_end with the reason, and the chat line
  const from = host.msgs.length;
  host.send({ t: "end_match" });
  const end = await host.until((m) => m.t === "match_end", from);
  check(/host/.test(end.reason), `match_end reason "${end.reason}"`);
  const chat = await host.until((m) => m.t === "chat" && /ended the match/.test(m.text), from);
  check(chat.text.includes("No experience was awarded"), `end chat "${chat.text}"`);
  host.shut();
  return `in-match set_map refused; host end_match -> match_end "${end.reason}"`;
}

// ---------------------------------------------------------------- admin, kicks, tick rate

async function adminAndKicks(s) {
  const base = s.base;
  const host = await player(base, uniqueName("Adm"));
  const { code } = await host.createRoom("Admin", { max_players: 4 });
  const guest = await player(base, uniqueName("Gst"));
  const joined = await guest.joinRoom(code);

  // broadcast reaches the room
  const say = await adminPost(base, "/admin/api/broadcast", { text: "hello edge" });
  check(say.status < 300, `broadcast HTTP ${say.status}`);
  await host.until((m) => m.t === "chat" && m.text === "[admin] hello edge");

  // tick rate: accepted in the lobby, refused outside 5..120 Hz
  const tick = await adminPost(base, `/admin/api/rooms/${code}`, { action: "set_tick_rate", hz: 20 });
  check(tick.status < 300, `set_tick_rate HTTP ${tick.status}: ${tick.text}`);
  await host.until((m) => m.t === "tick_rate" && m.tick_hz === 20);
  const badTick = await adminPost(base, `/admin/api/rooms/${code}`, { action: "set_tick_rate", hz: 3 });
  check(badTick.status === 400 && /between 5 and 120 Hz/.test(badTick.text), `bad tick: ${badTick.status} ${badTick.text}`);

  // kick without ban: the guest gets Kicked, then policy close "kicked"
  const kickFrom = guest.msgs.length;
  const r = await adminPost(base, `/admin/api/rooms/${code}`, { action: "kick", player: joined.you, ban: false });
  check(r.status < 300, `kick HTTP ${r.status}`);
  const kicked = await guest.until((m) => m.t === "kicked", kickFrom);
  check(kicked.reason === "You were kicked", `kick reason "${kicked.reason}"`);
  const kclose = await guest.closed;
  check(kclose.code === 1008 && kclose.reason === "kicked", `kick close: ${kclose.code} ${kclose.reason}`);

  // a player kicked with a ban is refused on rejoin
  const banIp = ipIn("10.9.9");
  const again = await player(base, uniqueName("Ret"), { ip: banIp });
  const seat = await again.joinRoom(code);
  const ban = await adminPost(base, `/admin/api/rooms/${code}`, { action: "kick", player: seat.you, ban: true });
  check(ban.status < 300, `ban HTTP ${ban.status}`);
  const banned = await again.until((m) => m.t === "kicked");
  check(banned.reason === "You were banned", `ban reason "${banned.reason}"`);
  const bclose = await again.closed;
  check(bclose.code === 1008 && bclose.reason === "banned", `ban close: ${bclose.code} ${bclose.reason}`);
  const retry = await player(base, uniqueName("Ban"), { ip: banIp });
  await retry.expectError({ t: "join_room", room: code, password: null }, "banned", "You are banned from this room");
  retry.shut();

  // closing the room: the members get Kicked, the host gets the chat line
  const other = await player(base, uniqueName("Closer"));
  const room2 = await other.createRoom("Closing", { max_players: 4 });
  const member = await player(base, uniqueName("Member"));
  await member.joinRoom(room2.code);
  const close = await adminPost(base, `/admin/api/rooms/${room2.code}`, { action: "close" });
  check(close.status < 300, `close HTTP ${close.status}`);
  const gone = await member.until((m) => m.t === "kicked");
  check(gone.reason === "Room closed by an administrator", `close reason "${gone.reason}"`);
  await other.until((m) => m.t === "chat" && m.text === "This room was closed by an administrator");
  host.shut();
  return "admin say, tick 20 Hz (400 outside 5-120), kick -> kicked/1008, ban -> banned rejoin refused, close -> Kicked";
}

// ---------------------------------------------------------------- lifecycle

/** A session cookie for a new account on the main server: its sockets share one seat. */
async function sessionCookie(base, ip, name) {
  const res = await fetch(`${base}/api/account/register`, {
    method: "POST",
    headers: { "content-type": "application/json", "X-Forwarded-For": ip },
    body: JSON.stringify({ name, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`register ${name}: HTTP ${res.status} ${await res.text()}`);
  return (res.headers.get("set-cookie") ?? "").split(";")[0];
}

async function replacedAccount(s) {
  const base = s.base;
  const name = uniqueName("Twin");
  const ip = ipIn("198.51.100");
  const cookie = await sessionCookie(base, ip, name);
  const first = await player(base, name, { ip, cookie });
  const { code } = await first.createRoom("Twins", { max_players: 4 });
  const second = await player(base, name, { ip, cookie });
  await second.joinRoom(code);
  const closed = await first.closed;
  check(closed.code === 1008 && closed.reason === "replaced", `replaced close: ${closed.code} ${closed.reason}`);
  second.shut();
  return "second socket of the same account took the seat; first closed 1008 replaced";
}

async function disconnectHold(s) {
  const base = s.base;
  const host = await player(base, uniqueName("Hold"));
  const { code } = await host.createRoom("Hold", { max_players: 4 });
  const guest = await player(base, uniqueName("Gone"));
  await guest.joinRoom(code);
  const t0 = Date.now();
  guest.shut();
  const left = await host.until((m) => m.t === "chat" && m.text.endsWith("has left the game"), 0, 90_000);
  const held = Date.now() - t0;
  check(held >= 55_000, `guest removed after ${held} ms (hold is 60 s)`);
  host.shut();
  return `"${left.text}" after ${Math.round(held / 1000)} s`;
}

async function idleKick(s) {
  const base = s.base;
  const c = await player(base, uniqueName("Idle"));
  const from = c.msgs.length;
  c.send({ t: "quick_play", queue: null, exclude: [] });
  await c.until((m) => m.t === "joined", from);
  const kicked = await c.until((m) => m.t === "kicked", 0, 150_000);
  check(kicked.reason.length > 0, "idle kick carried no reason");
  const close = await c.closed;
  check(close.code === 1008 && close.reason === "idle", `idle close: ${close.code} ${close.reason}`);
  return `quick-play player idle 120 s: Kicked "${kicked.reason}" + policy close idle`;
}

async function badTicket(s) {
  const c = socket(s.env.nodeBase);
  check(await c.opening, "could not open the node socket");
  await c.expectError({ t: "hello", version: 1, name: uniqueName("Tix"), ticket: "forged.ticket" }, "bad_ticket", "Sign in again");
  c.shut();
  return "node hello with a forged ticket: bad_ticket";
}

// ---------------------------------------------------------------- topologies

/** Two rooms per server. */
async function roomCapTopology() {
  const srv = await startServer({ extraEnv: { NEOBOX_MAX_ROOMS: "2" } });
  return { base: srv.base, nodeBase: null, output: srv.output, stop: srv.stop };
}

async function roomCap(s) {
  const base = s.base;
  const a = await player(base, uniqueName("RoomA"));
  await a.createRoom("A");
  const b = await player(base, uniqueName("RoomB"));
  await b.createRoom("B");
  const c = await player(base, uniqueName("RoomC"));
  await c.expectError(
    { t: "create_room", name: "C", password: null, max_players: 2, public: false },
    "server_full",
    "Too many rooms right now, try again later",
  );
  a.shut();
  b.shut();
  c.shut();
  return "third room refused with server_full at NEOBOX_MAX_ROOMS=2";
}

/** Eight sockets per address. */
async function connCapTopology() {
  const srv = await startServer({ extraEnv: { NEOBOX_MAX_CONNS_PER_IP: "8" } });
  return { base: srv.base, nodeBase: null, output: srv.output, stop: srv.stop };
}

async function connCap(s) {
  const base = s.base;
  const sockets = [];
  for (let i = 0; i < 8; i++) {
    const c = socket(base, { ip: "127.0.0.1" });
    check(await c.opening, `socket ${i + 1} of 8 refused`);
    sockets.push(c);
  }
  const ninth = socket(base, { ip: "127.0.0.1" });
  check((await ninth.opening) === false, "a 9th socket from one address opened");
  sockets[0].shut();
  await sleep(500);
  const again = socket(base, { ip: "127.0.0.1" });
  check(await again.opening, "no socket slot back after one closed");
  again.shut();
  for (const c of sockets.slice(1)) c.shut();
  return "9th socket from one address refused at NEOBOX_MAX_CONNS_PER_IP=8; slot reusable";
}

const edgeCases = [
  {
    name: "edge protocol errors",
    run: protocolErrors,
    inv: ["err-malformed", "err-no-hello", "err-version", "err-bad-name", "err-bad-queue", "err-not-in-room", "err-room-not-found", "err-bad-password-len", "err-rtc-unavailable", "conn-flood", "conn-frame-too-big"],
  },
  {
    name: "edge room errors",
    run: roomErrors,
    inv: ["err-wrong-password", "err-room-full", "err-not-host", "err-teams-locked", "err-bad-team", "err-bad-map", "err-map-too-large", "err-bad-setting", "err-bad-video", "err-jukebox-action", "err-rate-limited"],
  },
  { name: "edge in match", run: inMatch, inv: ["err-in-match", "match-end"] },
  {
    name: "edge admin and kicks",
    run: adminAndKicks,
    inv: ["sys-admin-say", "sys-tick", "tick-rate", "kicked-msg", "err-banned", "sys-closed-by-admin", "kicked-admin"],
  },
  { name: "edge replaced account", run: replacedAccount, inv: ["replaced"] },
  { name: "edge disconnect hold", run: disconnectHold, inv: ["timeout"] },
  { name: "edge idle kick", run: idleKick, serial: true, inv: ["kicked-idle"] },
  { name: "edge bad ticket", topology: regionServers, run: badTicket, inv: ["err-bad-ticket"] },
  { name: "edge room cap", topology: roomCapTopology, run: roomCap, inv: ["err-server-full-rooms"] },
  { name: "edge connection cap", topology: connCapTopology, run: connCap, inv: ["conn-too-many-ip"] },
];

/** None of these opens a page, so the runner runs them on the first engine only (`wire`). */
export const serverInvScenarios = edgeCases.map((scenario) => ({ ...scenario, wire: true }));
