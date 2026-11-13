# neobox client

Browser client for neobox, a fan-made spiritual successor to Hitbox.io, created by Chaz. Not affiliated.

Game logic runs in Rust compiled to WASM (`neobox.wasm`, built from `crates/wasm`). This directory is the TypeScript shell: screens, input, rendering (WebGPU with WebGL2 fallback), audio and networking.

## Layout

- `src/main.ts`: entry; calls `start()` from `src/app.ts`.
- `src/app.ts`: services, connection state machine, screen mounting.
- `src/game.ts`: per-frame match loop (engine step, render, overlay, sounds, HUD, stats).
- `src/engine.ts`: typed wrapper over the WASM exports (`docs/CLIENT-API.md`).
- `src/net.ts`: WebSocket control channel and optional WebRTC data channel for gameplay.
- `src/render/`: WebGPU and WebGL2 backends, shared geometry, debug overlay, map preview.
- `src/ui/`: DOM screens (menu, about, browser, room, HUD) and toasts.
- `src/input.ts`: keyboard, touch and gamepad to the input bitmask.
- `src/audio.ts`: original procedural sound effects (WebAudio oscillators).
- `dev/`: development-only fake engine and mock server. Not part of the production bundle.
- `public/`: static assets (`logo.svg`); `neobox.wasm` is placed here by the integrator.

## Commands

```sh
bun install
bun run build        # bundles to client/dist
bunx tsc --noEmit    # type check
```

## Credits

The name neobox and the logo are original. No Hitbox.io assets, fonts, images, sounds, texts or styles are used.

Source: https://github.com/AggressiveCombo/neobox. License: AGPL-3.0-or-later.
