# Deviations from Hitbox.io

neobox reproduces Hitbox.io's simulation number for number: the physics
library is a bit-exact port of the Box2D build the original runs, and the
game rules are checked tick by tick against trajectories recorded from the
original client (`tests/reference`, replayed by `cargo test`). Everything
below is a deliberate difference, with the reason.

Entries marked **FLAG** are judgement calls that may need revisiting.

## Networking and timing

| # | Original | neobox | Reason |
| --- | --- | --- | --- |
| N1 | Rooms live in the host's browser (host transfer, kicks, settings); inputs are relayed through a Socket.IO server and also sent peer-to-peer over PeerJS WebRTC data channels; every client predicts and rolls back on the inputs it has received. | A dedicated server owns the room and the input timeline: it stamps every input change with the tick it takes effect (never in the past) and broadcasts confirmed ticks. Clients predict and roll back against that single timeline. | One authoritative timeline removes desyncs from clients disagreeing about input timing, host advantage and host-leave problems, and scales past 10 players (peer-to-peer traffic grows with the square of the player count). |
| N2 | Each input change is sent once (`[mask, tick, sequence]`). | Game data travels over a WebRTC data channel configured unordered with no retransmission (UDP-like), with WebSocket fallback. Clients resend every unacknowledged input change; the server resends every tick the client has not confirmed. A change that arrives late still lasts at least one tick. | A lost packet never stalls the ones behind it (TCP head-of-line blocking), so loss on mobile networks costs no extra round trip, and no input is ever dropped. |
| N3 | Clocks synchronised with timesync. | Each client's tick clock is steered so its inputs arrive slightly before the server needs them (the margin grows with measured jitter). | Fewest late inputs (a late input means a rollback for everyone) with the least added latency. |
| N4 | — | The server sends a state checksum every 30 ticks; a client whose state differs reloads a snapshot. | Any desync heals itself within a second instead of persisting. |
| N5 | Fixed 30 Hz simulation driven from `requestAnimationFrame`. | Same 30 Hz simulation; rendering interpolates between the last two simulated ticks at the display's refresh rate. | Smooth motion at 60–240 Hz while physics stays frame-rate independent. |
| N6 | Input is sampled once per tick, so a key pressed and released between two ticks is never seen. | Such a tap is latched and applied for one tick. | No dropped taps at any frame rate or on slow devices. |
| N7 | Holding left and right moves left (left has priority; right is ignored). | Left + right together cancel (no horizontal input), applied by the server to the authoritative timeline. **FLAG**: the original behaviour may be relied on by some players; it was reported as a bug. | Reported as a bug ("holding left cancels / holding right is ignored"). Applied server-side so every client agrees. |
| N8 | Rooms of 1–10 players. | Rooms of 1–32 players (server limit configurable). | Scalability goal; the simulation and protocol have no 10-player assumption. |

## Simulation

| # | Original | neobox | Reason |
| --- | --- | --- | --- |
| S1 | `timeScale` accepted any value; 0 freezes the game (infinite step), negative or huge values break physics. Other numeric host settings accept NaN/Infinity. | `timeScale` limited to 1..1000, `playerSize` to 0.05..20, explosion radii to ≤ 100, projectile sizes > 0, every numeric setting must be finite. Rejected `/set` commands explain the limit. | These values crash or freeze every client. Values inside the limits behave exactly like the original. |
| S2 | Math uses the browser's `Math.sin/cos/atan2/exp`, whose last bits differ between browsers (one source of desyncs). The game already rounds its own trig to 7 decimals. | Software implementations with identical results on every platform; the game's 7-decimal rounding is reproduced. | Determinism across browsers and between server and clients. Verified bit-exact against the recordings. |
| S3 | A body's damage threshold field `21` ("becomes dynamic at damage") throws inside the original when reached (it tries to modify an immutable definition), which stops that client's simulation. | The threshold is ignored; field `22` (removal threshold) works as in the original. **FLAG**: the intended behaviour (conversion to a dynamic body) could be implemented later as a map-format extension. | Reproducing an exception is not possible deterministically; ignoring it matches what players see on clients that survive. |
| S4 | A map shape of an unknown type throws while building the world. | The shape is skipped. | Such maps would be unplayable; skipping keeps the rest of the map working. |
| S5 | — | Lives and round scores are shown clamped at 0. The simulation keeps the original (possibly negative) values. | Reported as a bug ("negative lives / round score"); the underlying numbers are kept so gameplay stays identical. |
| S6 | `Math.pow` comes from the browser's operating-system math library, so its last bits differ between platforms. The game uses it for one value: the parachute sound volume. | One portable `pow` (fdlibm) on every platform. | Determinism between server and all clients. Only a sound volume can differ, by about 1e-16. The reference test compares that one field to 1e-12. |
| S7 | Box2D's warm-starting and continuous-physics switches are global to the page. | They belong to each physics world. | The server runs many rooms at once; a global switch would let rooms influence each other. Every world uses the same values as the original, so results are identical. |
| S8 | Box2D has no limit on collision pairs or contacts. A map of thousands of stacked shapes asks for billions of them and freezes or crashes the browser tab. | At most about 1 million candidate pairs per collision pass and 524 288 contacts per world. Past either limit the remaining collisions are skipped, the same way on every peer, and the server stops the match with a chat message. The server also stops a match whose ticks stay slower than real time for 3 seconds. The duplicate-contact check uses a hash set instead of walking the body's contact list (same result, no quadratic slowdown). | One room must never be able to exhaust the server's memory or CPU. The heaviest of 376 tested public maps uses under a tenth of these limits, so normal play is unchanged. |

## Maps

| # | Original | neobox | Reason |
| --- | --- | --- | --- |
| M1 | Map codes are read and written by the original's encoder. | Map codes are read losslessly: every field the original reads decodes to the same value, and fields it ignores are kept verbatim so a neobox round trip never loses data. Future neobox extensions may only add new keys. | "Never break existing Hitbox maps." |
| M2 | Online map browser with saving, publishing and voting, and a map editor. | A map library: signed-in players upload maps as public, unlisted or private; everyone can search and sort (new, top, most played), vote and star maps; room hosts pick library maps from the room. Public uploads appear only after an admin approves them in `/admin`. A map editor in the client builds maps and exports ordinary Hitbox map codes. | Approval keeps abusive or broken maps out of the public list without blocking private sharing. Map codes stay the exchange format, so maps move freely between the library, the editor, pasted codes and files. |
| M3 | No size limit. | Map codes up to 2 MB (the largest public code is 0.7 MB) and up to 64 MB of map data after decompression; at most 65 536 shapes and 1 048 576 polygon vertices per map. Of 378 public maps sampled from hitbox.io, 376 load. The 2 rejected maps stack 600 000+ shapes on one spot (the largest map that loads has about 25 000 shapes). The host gets a "map has N shapes; the limit is 65536" error. **FLAG**: the two rejected maps cannot be played in neobox. Judging by their size they cannot be played in the original either. | A small code can expand to gigabytes, and maps this dense cannot be simulated in real time. The limits protect the server and phones. |

## Presentation

| # | Original | neobox | Reason |
| --- | --- | --- | --- |
| P1 | Shapes are drawn from separate render data (textures, outlines, z-order quirks); visible shapes can differ from hitboxes. | Everything is drawn from the physics geometry itself, in map order. | Hitboxes always match what is drawn (reported bug); fewer draw calls. |
| P2 | Fixed 16:10 view (`W` × `W/1.6` world units; 2:1 on mobile), letterboxed; zooming changes outline widths and name sizes. | The view fills the window. Landscape windows always show at least the original's whole `W` × `W/1.6` area (wider windows see a little more sideways, taller ones a little more vertically). Portrait phones keep the original's vertical extent and see less sideways. Line widths and text are in screen pixels. **FLAG**: seeing slightly more than the original on non-16:10 screens is a small information difference between players. | Uses the whole screen on every device including phones; nobody sees less than in the original in landscape; consistent visuals at any zoom. |
| P3 | Hitbox.io art, fonts, sounds and music. | Original neobox visuals; sounds are synthesised procedurally; no music. | Legal: original assets only. |
| P4 | Off-screen objects are rendered; memory from finished rounds can leak. | GPU draws one vertex buffer per frame built from the current state; nothing persists between rounds. | Performance on low-end devices (reported bugs). |

## Platform

| # | Original | neobox | Reason |
| --- | --- | --- | --- |
| L1 | Accounts with XP, levels and unlockable skins. | Optional accounts (name and password) that keep settings on every device, own uploaded maps and hold the friends list. Guests can play everything except publishing maps and friends. No XP, levels or skins. | Playing never requires an account. The original's progression unlocks the original's art, which neobox cannot use (P3). |
| L2 | Friends list. | Friends list with online status and the room a friend is in, with a Join button. | Same purpose; joining a friend's room is one click. |
| L3 | Quick play. | Quick play joins the fullest public room that has no password and a free slot (oldest on a tie), or creates a public room when there is none. | Fills existing rooms first so players find each other. |
| L4 | — | A dropped connection or a page reload keeps the player's slot; the client rejoins the same room, team and match automatically with a resume token. | Mobile networks and accidental reloads no longer cost a player their place. |
| L5 | Replays. | Any finished match can be saved as a `.nbreplay` file (the match's inputs; the deterministic simulation rebuilds every tick) and watched with play/pause, speed 0.25–4×, frame stepping and seeking. Files stay on the player's device. | Small files, exact playback, no server storage. |
| L6 | — | Practice: play alone on any built-in or pasted map without a server, with endless respawns. | Learning maps and movement offline. |
| L7 | Jukebox/music and emotes. | Not included. | They need music and emote art neobox does not have (P3); gameplay does not depend on them. |
