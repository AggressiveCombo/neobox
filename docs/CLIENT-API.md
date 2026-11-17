# Client ⇄ WASM ⇄ Server interfaces

The browser client is TypeScript (`client/`), bundled with Bun. All game
logic (simulation, rollback netcode, frame building) runs in one WASM module
built from `crates/wasm` (no wasm-bindgen; plain C-ABI exports). The server
speaks the protocol in `crates/net/src/protocol.rs`.

## Transport

One WebSocket per client: `wss://<host>/ws` (`ws://` locally), plus an
optional WebRTC data channel for the binary hot path.

* **Text frames** carry JSON control messages: `ClientMsg` / `ServerMsg`
  (serde `{"t": "<snake_case variant>", ...fields}`), see
  `crates/net/src/protocol.rs` for every variant and field.
* **Binary frames** carry the gameplay hot path. The client never decodes
  or encodes them itself: binary frames from the server are passed to
  `nb_server_frame`, and the bytes produced by `nb_frame` are sent as a
  binary frame.
* **WebRTC** (when `welcome.rtc` is true): the client opens a data channel
  `{ordered: false, maxRetransmits: 0}` (UDP-like: a lost packet never
  delays later ones), sends `rtc_offer` with its SDP over the WebSocket and
  applies the `rtc_answer`. While the channel is open, binary frames travel
  over it in both directions; otherwise over the WebSocket. Both directions
  tolerate loss: the client resends unacknowledged input changes and the
  server resends every tick the client has not confirmed.

Typical flow: connect → send `hello` → `welcome` → `list_rooms`/`rooms` →
`create_room` or `join_room` → `joined` (your player id in the room) →
`room` updates (lobby) → host `start` →
`match_start` (or `snapshot` when joining a running match) → binary frames
both ways → `match_end` → back to lobby (`room`).

## WASM exports

All pointers are offsets into the module's linear memory (`memory` export).
Strings are UTF-8. Every call is synchronous and cheap except where noted.

| Export | Signature | Meaning |
| --- | --- | --- |
| `nb_alloc` | `(len: u32) -> u32` | Allocate `len` bytes for passing input data. |
| `nb_free` | `(ptr: u32, len: u32)` | Free a buffer from `nb_alloc`. |
| `nb_error_ptr`/`nb_error_len` | `() -> u32` | Last error message (after a call returned `< 0`). |
| `nb_match_start` | `(json: u32, json_len: u32, local: i32, now_ms: f64) -> i32` | Start a session from the `start` object of a `match_start` message (JSON text). `local` = your player id, or `-1` to spectate. 0 = ok. |
| `nb_match_snapshot` | `(json: u32, json_len: u32, local: i32, tick: u32, snap: u32, snap_len: u32, now_ms: f64) -> i32` | Same, from a `snapshot` message (`state` is base64: decode it to bytes first). |
| `nb_match_end` | `()` | Drop the session. |
| `nb_server_frame` | `(ptr: u32, len: u32, now_ms: f64) -> i32` | Feed one binary server frame received at `now_ms` (`performance.now()`, the clock pings are stamped with). Returns 0, or 1 if a resync is needed (send `{"t":"resync"}`). |
| `nb_frame` | `(now_ms: f64, mask: u32) -> u32` | Once per animation frame: advance the tick clock, apply the local input mask (bits below), predict, and build the frame buffer. Returns the length of the outgoing binary frame at `nb_out_ptr()` (0 = nothing to send). |
| `nb_out_ptr` | `() -> u32` | Outgoing binary frame (valid until the next call). |
| `nb_frame_ptr`/`nb_frame_len` | `() -> u32` | Frame buffer (layout below; length in bytes). |
| `nb_ping` | `(now_ms: f64) -> u32` | Build a ping frame (send every ~1 s, stamped with `performance.now()`); returns its length at `nb_out_ptr()`. |
| `nb_map_preview` | `(code: u32, code_len: u32) -> i32` | Decode a Hitbox map code and build a frame buffer of its lobby layout (players absent). 0 = ok; errors set the message. |
| `nb_map_encode` | `(json: u32, json_len: u32) -> i32` | Compact map JSON → map code; result string at `nb_out_ptr()`, length returned. |

Input mask bits: 1 left, 2 right, 4 up/jump, 8 down, 16 force push (X),
32 rocket/special (Z), 64 bat (C), 128 grab/parachute (V).

## Frame buffer

Little-endian. Word = 4 bytes. View it as both `Uint32Array` and
`Float32Array` over `memory.buffer` at `nb_frame_ptr()` (re-create the views
if `memory.buffer` changed).

Header (words 0..37):

| Word | Type | Field |
| --- | --- | --- |
| 0 | u32 | layout version (7) |
| 1 | u32 | world vertex count |
| 2 | u32 | world vertex offset (words) |
| 3 | u32 | player count |
| 4 | u32 | player offset (words) |
| 5 | u32 | sound count (new sounds since the previous frame) |
| 6 | u32 | sound offset (words) |
| 7 | u32 | score row count |
| 8 | u32 | score row offset (words) |
| 9 | f32 | camera view width in world units (map "screen width") |
| 10 | f32 | arena width |
| 11 | f32 | arena height |
| 12 | u32 | background top colour 0xRRGGBB |
| 13 | u32 | background bottom colour 0xRRGGBB |
| 14 | u32 | current tick |
| 15 | i32 | local player id (-1 none) |
| 16 | f32 | intro countdown ticks left (-1 when running) |
| 17 | f32 | round-over countdown (-1) |
| 18 | f32 | game-over countdown (-1); slow motion while ≥ 0 |
| 19 | f32 | winner (player id; -1 draw; -2 nobody) |
| 20 | f32 | objective team (2 red / 3 blue / -1 / -2) |
| 21 | f32 | red score/lives |
| 22 | f32 | blue score/lives |
| 23 | i32 | game mode |
| 24 | f32 | objective limit |
| 25 | f32 | max stamina |
| 26 | f32 | round number |
| 27 | u32 | flags: bit0 map wraps |
| 28 | f32 | network: confirmed ticks behind head (prediction depth) |
| 29 | f32 | network: rollbacks per second |
| 30 | u32 | kill count (kills since the previous frame) |
| 31 | u32 | kill offset (words) |
| 32 | u32 | damage bar count |
| 33 | u32 | damage bar offset (words) |
| 34 | u32 | predicted bat hit count (hit visuals) |
| 35 | u32 | predicted bat hit offset (words) |
| 36 | u32 | confirmed bat hit count (event log) |
| 37 | u32 | confirmed bat hit offset (words) |

World vertices: 3 words each `x f32, y f32, colour u32`; the colour's bytes
in memory are R, G, B, A (i.e. `r | g << 8 | b << 16 | a << 24`, ready for a
`unorm8x4` / normalized `UNSIGNED_BYTE` attribute), not premultiplied.
Positions are already interpolated, in world units (+y is down). Draw as a
triangle list in buffer order (back to front).

Players: 14 words each:
`id u32, x f32, y f32, angle f32, team u32, stamina f32, flags u32,
attacker u32, size f32, health f32, rocket f32, rocket_angle f32, egg f32,
egg_aim f32`. `rocket` is the rocket launcher's charge (-1 when idle) and
`rocket_angle` its interpolated aim; `egg` is the egg throw charge and
`egg_aim` its aim.
Flags: bit0 local, bit1 ghost, bit2 frozen, bit4 bat swinging, bit5
pushing, bit6 dashing, bit7 teleported (no interpolation), bit8 air jump
available.

Sounds: 5 words each `kind u32, x f32, y f32, volume f32, player i32`.
Kinds: 1 jump, 2 air jump, 3 push hit, 4 push miss, 5 push click (reserved:
neither the original game nor the sim ever emits it), 6 impact, 7 impact on a
no-jump body, 8 freeze, 9
spawn, 10 countdown, 11 death, 12 body impact, 13 bat swing, 14 bat hit, 15
rocket charge, 16 rocket fire, 17 explosion, 18 parachute, 19 ghost trail, 20
fanfare (game over).

Score rows: 15 words each: `id u32, team u32, kills f32, wins f32, lives f32,
alive u32, respawn f32, eliminated f32, killed_by i32, last_victim i32,
kill_timer f32, death_timer f32, suicide_timer f32, spawn_x f32, spawn_y f32`.
`killed_by` and `last_victim` are player ids, -1 for none. `spawn_x`/`spawn_y`
are the claimed respawn point (NaN when none), flashed by the spawn preview.

Kill triples: 3 words each, `killer u32, victim u32, tick u32`, in order, for the
kills since the previous frame (confirmed ticks; `tick` is the tick the kill happened
on). Count in word 30, offset in word 31.

Bat hits: 3 words each, `swinger u32, kind u32, index u32` (kind 0 body, 1 player,
2 projectile; index is the body or projectile index, or the victim's player id for
kind 1). Words 34/35 hold the predicted ticks' hits (the hit visuals, which a
rollback may undo). Words 36/37 hold the confirmed ticks' hits: 4 words each, the
same three plus `tick u32` (the event log every client agrees on). Both are for the
ticks since the previous frame.

Damage bars: 4 words each, `x f32, y f32, fraction f32, colour u32`
(0xRRGGBB), one per body with a dynamic (field 21) or removal (field 22)
damage threshold, at the body's interpolated position.

## Camera

The original shows a view `W` = header word 9 world units wide and `W / A` high,
where `A` = 1.6, or 2 for its mobile user agents (`VIEW_ASPECT` in `camera.ts`,
the same user-agent test). The game view is that rect, as large as the window
allows and centred: `fitView(winW, winH)` returns it, and `publishView` sets
`--view-x/-y/-w/-h` (px) on `documentElement`. The game canvases and the overlay
sit on that rect; the window around it is letterbox, painted by `#gl-host`. The
renderers and overlay draw only inside it. Centre on the local player (or the
arena centre when spectating), clamped per axis to `[view/2, arena - view/2]`;
when the arena is smaller than the view on an axis, centre the arena on that axis.
`present(names, hz, false)` (menu clips) draws names and damage bars only: no
objective bar, feed, banners or intro. The objective bar sits in the view's top row
(8 px in); when HUD chip rows (`AppCtx.reserveChrome`, `reserveTop`) cover that row, it
takes the widest free run between them, else it goes under them, centred.

## Replays and clips

`nb_replay_export(names, len)` takes a JSON array of `[player id, name]` pairs
and returns the whole recording as replay JSON text. `nb_replay_clip(names,
len, max_secs, min_secs)` cuts the last `max_secs` of the recording the same
way; it returns null when less than `min_secs` of play is recorded. The server
stores the replay JSON text it is given, after checking it with the same
parser the replay viewer uses.

`nb_replay_load(json, len)` parses replay JSON (rejects unknown versions),
`nb_replay_frame(tick, follow)` builds the frame buffer for a tick and
`nb_replay_close()` releases the replay. The replay viewer loads files
(gunzipped first when needed) and clips (plain text) through the same path.

Clips are uploaded with `POST /api/clips` `{replay, map_name}` and listed with
`GET /api/clips?before=<id>` (newest first, 10 per page). `GET /api/clips/<id>`
returns the replay JSON text. The main menu hands a clip to the replay screen
with `queueReplay(name, text)`; the screen opens it as soon as it mounts.

## Local games

`nb_local_start(json, len, player)` starts an offline match. The JSON is a
match start (seed, start tick, tick rate, players as `[id, team]`, settings,
maps, intro, rotation) plus an optional `dummies` array of `{id, mode}` where
`mode` is `"idle"` or `"left_even"`. Dummies are ordinary players that take no
input. `nb_local_frame(dt_ms, mask)` advances the game and `nb_local_end()`
stops it.

## Training hall

The training hall loads `/training.json`, a map document in the same
`{name, map}` shape the editor saves, and encodes it with `nb_map_encode`. It
plays with two dummies and a fixed set of lesson texts. Finishing the lessons
sets `localStorage["neobox.trainingDone"]`.
