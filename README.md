# neobox

A free and open-source spiritual successor to
[Hitbox.io](https://hitbox.io), the physics platform-fighter by **Chaz**
(also the creator of Bonk.io). neobox recreates Hitbox.io's gameplay
number-for-number, loads Hitbox.io maps, and is built to be fast,
scalable (rooms of up to 32 players) and maintainable, with first-class
mobile support.

neobox is a fan project. It is not affiliated with or endorsed by Chaz or
Hitbox.io, and it contains no Hitbox.io code, art, sounds or fonts.

## Highlights

* **Same feel as the original.** The physics engine is a bit-exact Rust
  port of the Box2D build Hitbox.io runs on, and the game rules are
  verified tick-by-tick against trajectories recorded from the original
  game (`tests/reference`). Differences are deliberate and listed in
  [DEVIATIONS.md](DEVIATIONS.md).
* **Hitbox.io maps work.** Paste a map code or load a map file in the lobby.
* **Low latency netcode.** Deterministic 30 Hz simulation with client-side
  prediction and rollback; the server stamps inputs, so there is no host
  advantage and no desync from frame-rate differences. Game data travels
  over WebRTC (UDP-like) with automatic WebSocket fallback.
* **Runs everywhere.** WebGPU renderer with a WebGL2 fallback, dynamic
  resolution, any refresh rate; keyboard, gamepad and full touch controls;
  iOS Safari included.
* **Admin interface.** Live rooms, players, tick rate, latency, bandwidth,
  match state and logs, with kick/ban/close controls (`/admin`).

## Layout

| Path | What |
| --- | --- |
| `crates/box2d` | Bit-exact port of Hitbox.io's Box2D build (Zlib licence, like Box2D). |
| `crates/sim` | Deterministic game simulation and the Hitbox map format. |
| `crates/net` | Wire protocol, server input timeline, client prediction/rollback. |
| `crates/wasm` | The browser game module (simulation + netcode + frame building). |
| `crates/server` | Game server: rooms, WebSocket/WebRTC transport, admin interface. |
| `crates/bots` | Headless bot players for load and soak tests (`cargo run --release -p neobox-bots -- ws://127.0.0.1:8080/ws 32 120`). |
| `client` | Web client (TypeScript, no framework): renderer, input, UI, audio. |
| `maps` | Built-in maps. |
| `tests`, `tools` | Reference recordings from the original game and the tools that make them. |
| `deploy` | Build script, systemd unit and Caddy configuration. |
| `docs` | Interface notes. |

## Building and running

Requirements: [Rust](https://rustup.rs) and [Bun](https://bun.sh).

```sh
bash deploy/build.sh                         # builds dist-server/
cd dist-server && NEOBOX_ADMIN_PASSWORD=dev ./neobox-server
```

Open <http://127.0.0.1:8080>. To put it online see [DEPLOY.md](DEPLOY.md).

Tests:

```sh
cargo test --release                         # includes the reference trajectories
```

## Credits

* **Chaz**, creator of Hitbox.io, whose game this project pays tribute to.
* Box2D by Erin Catto; Box2DFlash/box2dweb ports by their authors.

## Licence

neobox is free software under the
[GNU Affero General Public License v3.0 or later](LICENSE). The physics
crate `crates/box2d` is under the Zlib licence (see its `LICENSE`).
