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
- `src/ui/`: DOM screens (menu, browser, room, HUD, settings, account, friends, library, practice, replay, map editor, about) and toasts.
- `src/editor/`: map editor model, view, tools, undo history and test play.
- `src/input.ts`: keyboard, touch and gamepad to the input bitmask.
- `src/audio.ts`: original procedural sound effects (WebAudio oscillators).
- `e2e/`: browser end-to-end suite against the real server (headless, muted Chromium).
- `public/`: static assets (`logo.svg`, the project's logo); `neobox.wasm` is placed here by the build.

## Commands

```sh
bun install
bun run build        # bundles to client/dist
bunx tsc --noEmit    # type check
bun run e2e          # end-to-end suite; needs `bash deploy/build.sh` first
```

To develop, run the real server against the build: `bash deploy/build.sh` once, then after client changes
`bun run build` and reload (the server serves `dist-server/client`; set `NEOBOX_STATIC=client/dist` to serve the fresh build directly).

The e2e suite starts `dist-server/neobox-server` on a free port with a fresh database and drives every
feature through the UI. `bun run e2e replay editor` runs only scenarios whose names contain those words.
Chromium is found through `CHROME_PATH`, Playwright's download (`bunx playwright-core install chromium`),
or an installed Chrome/Edge/Chromium. Screenshots of failures go to `e2e/shots/`.

## Credits

The name neobox and the logo are original. No Hitbox.io assets, fonts, images, sounds, texts or styles are used.

Source: https://github.com/AggressiveCombo/neobox. License: AGPL-3.0-or-later.
