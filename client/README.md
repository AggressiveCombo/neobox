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

## Icons

Icons come from `src/ui/icons.ts` (Lucide bodies, typed `IconName`), rendered with `icon(name, size)`. Colour inherits from the text.

Rules, applied on every screen:

- Every button with a verb gets a leading icon (`icon(name, 18)`).
- Every section heading (h2/h3 in a panel or section) gets a leading icon (`icon(name, 20)`).
- Empty states get a large muted icon (`icon(name, 40)` inside `.empty`).
- Stats and list rows get an icon (14 chips, 16 list items, 18 rows).
- Icon-only controls keep a visible label or a tooltip (`title`) and an `aria-label`.
- One icon per concept everywhere (table below). Do not reuse a concept's icon for another meaning.
- Icons are decorative (`aria-hidden`); the text carries the meaning.

Concept to icon:

| Concept | Icon |
| --- | --- |
| Play, start, play a map | `play` |
| New or create (room, item) | `plus` |
| Join a room | `door-open` |
| Sign in / sign out / create account | `log-in` / `log-out` / `user-plus` |
| Account, profile | `circle-user` |
| Friends (list), friend request | `users`, `user-plus` |
| Accept / remove friend | `user-check`, `user-minus` |
| Back, previous / next | `arrow-left`, `arrow-right` |
| Try again, refresh | `refresh-cw` |
| Restart | `rotate-ccw` |
| Save / load file / download / upload | `save` / `folder-open` / `download` / `upload` |
| Copy, copy code | `copy` |
| Paste or map code | `clipboard` |
| Invite link, share | `link-2`, `share-2` |
| Search / sort / filter | `search` / `arrow-up-down` / `sliders-horizontal` |
| Close | `x` |
| Delete | `trash-2` |
| Edit, rename | `pencil` |
| Votes | `thumbs-up`, `thumbs-down` |
| Plays, count | `play` |
| Maps | `map` |
| Rooms | `door-open` |
| Players, people | `users` |
| Chat, messages | `message-square` |
| Level | `star` |
| Fastest time, records | `timer` |
| Leaderboard, top makers | `trophy` |
| Date, joined | `calendar` |
| Duration, time | `clock` |
| Connection, online / offline | `wifi` / `wifi-off` |
| Password, private room / public room | `key-round`, `lock` / `lock-open` |
| Warning, error | `triangle-alert` |
| Success | `circle-check` |
| Info, help | `info`, `circle-help` |
| Privacy, shield | `shield` |
| News | `newspaper` |
| Documentation, licence | `book-open` |
| Settings | `settings` |
| Replay, clips | `film` |
| Training, practice | `dumbbell`, `target` |
| Editor | `pencil-ruler` |
| Library | `library-big` |
| Room code, hash | `hash` |
| Empty list | `inbox` |
| Empty search result | `search-x` |
| Fullscreen / sound on / sound off | `maximize` / `volume-2` / `volume-x` |
| Keyboard, gamepad, mouse, phone | `keyboard`, `gamepad-2`, `mouse-pointer-2`, `smartphone` |


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
