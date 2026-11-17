# client/qa instruments

Headless browser instruments for the neobox client. Each one drives the built client (`NEOBOX_DIST`) against a fresh server and writes JSON + markdown records. Run from `client/`.

## Common rules

- Browsers start only through `launchEngine(name)` in `client/e2e/lib.mjs`. It mutes every context (firefox gets a null audio device). Do not call `chromium.launch` / `firefox.launch` / `webkit.launch` directly.
- Headless only. Port 8080 is never used (`startServer` picks a free port with a fresh DB).
- Capabilities differ by engine. CDP-only features (network/CPU throttling, heap, raw WebSocket where noted, long tasks, CLS) run on chromium only. Elsewhere they record `N/A` with the probe value.

### Environment variables

| Variable | Default | Used by |
| --- | --- | --- |
| `NEOBOX_DIST` | none, required (or `--dist <build dir>`); the path and its `BUILT_FROM` are printed at start | all (`lib-qa.mjs`, `sweep.mjs`, `e2e/lib.mjs`) |
| `QA_OUT` | `neobox-scratch/qa/round0-perf` (lib-qa); per-instrument defaults noted below | all record instruments |
| `QA_ENGINES` | `chromium,firefox,webkit` | every instrument that runs in browsers (`selectedEngines()`) |
| `QA_SELF_TEST` | unset | instruments with a self-test: see each section |
| `QA_ONLY` | all keys | `audit.mjs` |
| `QA_INVENTORY` | session `local/INVENTORY.md` | `audit.mjs` |
| `QA_FPS_MS`, `QA_SOAK_MS`, `QA_SOAK_RUNS` | 30000, 600000, 3 | `perf.mjs` |

### Output layout

- `<QA_OUT>/<instrument>-<engine>.json` and `.md`: one record per case (`pass`, `fail`, `info`, metrics, detail, evidence paths).
- `<QA_OUT>/evidence/<instrument>-<engine>/`: screenshots and JSON dumps referenced by the records.
- Self-test runs overwrite the same files, so use a separate `QA_OUT` for them.

## perf.mjs

Rubric D12. Load time, LCP, CLS, frame pacing and a heap soak.

- Command: `cd client && QA_OUT=<dir> bun qa/perf.mjs`
- Engines: all three. Banded (9-level gates) on chromium only; firefox and webkit are measured and reported as info. CDP-only cases are N/A off chromium.
- Cases: `probe`, `load.none.{webgpu,webgl2}` (3 cold loads each, worst run), `load.fast3g`, `load.slow3g`, `fps.{practice,match}.{webgpu,webgl2}` and the `.cpu4x` variants (chromium), `soak.t1m.run{1..3}` and `soak.t3t4x.run{1..3}` (chromium, default 10 min each).
- Soak metric: `perf.heapMB.endMinusStartPct` compares the median of 3 heap samples after a 60 s warm-up with the median of the last 3, so JIT warm-up is not counted as retention; the slope and the 15 % band are unchanged. The soak runs with no e2e pixel probe (`startPractice` `pixels: false`). Details in `PERF.md`.
- Renderer: `webgl2` hides `navigator.gpu` before the app boots; the case fails if the app reports another renderer. `webgpu` is N/A when the probe finds no `navigator.gpu`.
- Self-test: `QA_SELF_TEST=jank` (busy main thread during the fps cases; must fail the fps gates) or `QA_SELF_TEST=leak` (retained heap during soak; must fail the soak gates). The file has no case filter, so a self-test runs all cases; to keep it short: `QA_SOAK_MS=60000 QA_SOAK_RUNS=1 QA_FPS_MS=6000 QA_ENGINES=chromium`.
- Known limits: LCP and CLS support is read from the probe (`probe.lcpSupported`, `probe.clsSupported`); where an engine does not report the entry the case records the miss rather than inventing a value. Soak uses the practice mode only.
- Full details and gates: `PERF.md`.

## pwa.mjs

Installed-app manifest, the home menu in display-mode standalone, and audio before the first gesture.

- Command: `cd client && bun qa/pwa.mjs`
- Engines: all three. `menu-standalone` runs on chromium (real `matchMedia` override); other engines record info.
- Outputs: `pwa-<engine>.{json,md}`.
- Self-test: `QA_SELF_TEST=manifest` (display, theme colour and maskable icon broken; must fail `pwa.manifest.ok`), `standalone` (manifest `start_url` points at a missing page; must fail), `audio` (`play()` faked to resolve and an element plays at load; must fail `audio.startedBeforeGesture`).
- Known limit: standalone display-mode is probed through a `matchMedia` override because CDP display-mode emulation has no effect in this build.

## security.mjs

XSS payload injection, server name limit, WebSocket origin check, chat rate limit and server-side profanity masking (RUBRIC D24, section 9.1).

- Command: `cd client && QA_OUT=<dir> node qa/security.mjs`
- Engines: XSS, chat rate-limit and profanity cases on every selected engine; raw origin, name and moderation cases on chromium only (others get an info row).
- Keys: `sec.xss.hits` (0 passes), `sec.server.nameLimit`, `sec.ws.originRejected`, `sec.chat.rateLimited`, `sec.profanity.viewerMasked`, `sec.mod.muteBlocked`, `sec.mod.kickVisible`, `sec.chat.dupDelivered` (0 passes), `sec.typing.relayed` (0 passes). The moderation case (`mod`) is raw WebSocket: a host, a guest and a watcher share a room; a control typing signal must reach the host; one chat line must reach the watcher once; the host mutes the guest (its chat must be refused with `muted` and not reach the host, its typing must not reach the host); the host kicks the guest (the guest must get a `kicked` reason).
- Self-test (`QA_SELF_TEST`): `xss` (unsafe `innerHTML` into `h1.room-title`), `namelimit` (valid 15-char name sent where a 16-char refusal is expected), `origin` (allowed origin sent where a refusal is expected), `ratelimit` (3 chats where 20 are expected), `profanity` (the raw host sends a clean line where a masked profane word is expected), `mute` (the host skips the mute frame where the guest is expected to be refused). Only that key's case runs and it must FAIL.
- Known limit: each case opens its own page and server. `xss` hits are read from `window.__xssHits` and `window.__xss`, which an init script defines before page code (`openPage`). `profanity` is the masking check: a raw-WebSocket host (client bypassed) creates a room, a browser viewer joins it and sees `fuck` as `****` (default prefs); the viewer then leaves, turns "Filter profanity" off under Settings > Chat, rejoins, and must see `shit` as typed. It runs on every engine. Firefox and WebKit ignore `Navigated away from page` errors in the xss and profanity cases: the viewer navigates on purpose, and those engines report the app's in-flight calls as that error. The raw origin and name cases run on chromium only.

## social.mjs

Two-client and multi-client room flows, HUD ping badge, Browse room count, presence latency (RUBRIC D17).

- Command: `cd client && QA_OUT=<dir> node qa/social.mjs`
- Engines: every case runs on every engine (chromium, firefox, webkit), twice: desktop (1280x800 mouse) and phone (touch, landscape 844x390, `social.phone` = 1). Chromium also copies the invite through the clipboard; firefox and webkit open the invite URL.
- Keys: `social.twoClient.pass`, `social.multi.pass` (N = min(4, room capacity)), `social.ping.error.ms` (<= 10), `social.ping.updateMs`, `social.roomList.counts.ok`, `social.presence.latencyMs` (<= 1000). Case ids carry a `.phone` suffix for the phone variant.
- Each case starts a fresh server and drives the real UI. After the match ends the host sees the postgame modal; the flow clicks "Back to room" on every client before the leave buttons.
- Ping: `social.ping.error.ms` compares the HUD badge with the stats-overlay RTT row. Both read `state.stats.rttMs` (game.ts `engine.rtt()`), so a gap means a stale or mid-update read. Chromium judge round 4 (28 ms vs 0 ms) did not reproduce on HEAD: desktop and phone both 1 ms vs 1 ms, max diff 0.
- Self-test (`QA_SELF_TEST`): `twoclient` (guest never joins; `twoClient.pass` must be 0), `multi` (last client never joins; `multi.pass` must be 0), `ping` (badge pinned to "250 ms"; `ping.error.ms` > 10), `presence` (host inbound messages delayed 1500 ms; latency > 1000), `roomcount` (phantom room card; `roomList.counts.ok` 0). Only that key's desktop case runs.
- Known limit: multi needs N clients on distinct IPs; capacity is the room `max_players` clamped to `NEOBOX_MAX_PLAYERS` (default 32).

## motion.mjs

Transition settle time (RUBRIC D20 `motion.transition.ms`): menu modal open and close, and scene transitions (menu to browse, browse to room, room to match).

- Command: `cd client && QA_OUT=<dir> node qa/motion.mjs`
- Engines: all three, desktop only (1280x800).
- Method: two idle screenshots 250 ms apart find the pixels that animate with no trigger (canvas arenas, match playfield); they are masked from every frame of that case, and `motion.masked.px` is their count. Then the trigger, then viewport screenshots until two consecutive sample pairs each change < 0.5% of unmasked pixels (per-pixel sum of channel deltas > 24, the image.mjs test). The settle time is the sample from which the region stayed stable, measured from just before the trigger. A case fails when more than half the screenshot animates while idle (nothing left to measure).
- Cases and limits: `ui.modal.open.news`, `ui.modal.close.news`, `ui.modal.open.createRoom` (300 ms); `scene.menu.browse`, `scene.browse.room`, `scene.room.match` (400 ms). A case also fails when no change follows the trigger, when the region is not stable within 3000 ms, or when the destination screen is not reached.
- Resolution: a Playwright screenshot takes tens of ms, so the RUBRIC's 16 ms sample period is not reachable. Read `motion.sample.ms` (median interval between samples) next to every value; the settle time is only as fine as that period. Timing on a busy host is provisional.
- Keys: `motion.transition.ms`, `motion.transition.limit`, `motion.samples`, `motion.sample.ms`, `motion.cssEnd.ms` (in-page cross-check: longest remaining finite CSS animation or transition at the trigger, from `document.getAnimations`), `motion.masked.px`.
- Self-test (`QA_SELF_TEST=janky`): every CSS animation and transition is stretched to 1500 ms with `!important`, so every case must FAIL. Use a separate `QA_OUT`.
- Not covered here: `motion.cls` (layout shift; CDP-only, chromium) and `reducedMotion.pixelDiff` (D08).

## playfield.mjs (RUBRIC D16; play-field HUD, sprite contrast, camera, hit feedback)

- Command: `cd client && QA_OUT=<dir> bun qa/playfield.mjs` (`QA_ENGINES=chromium` to limit; `PALETTES=default` to limit palettes). Env: `QA_CAM_MS` (15000), `QA_PLAY_MS` (30000).
- Engines: chromium (webgpu and webgl2), firefox and webkit (webgl2), both palettes (default and deuteranopia) at every tier viewport (T1-M to T11-T).
- Ground truth is engine state, not screenshots: a read-only init-script hook on the wasm frame exports (`window.__qaPF`) and the camera's published view (`globalThis.__qaCam`, src/camera.ts). The sprite contrast sample (T1-M, T5-T) reads the match canvas.
- Cases: `tier.<palette>.<renderer>` (HUD overlap, spawn points, contrast); `camera.<map>` (every live player in view on the four reference maps); `feedback.hit.frames` (hit feedback latency in engine ticks).
- Phone tiers: a touch-only phone welcome is dismissed after load (`dismissPhoneSplash`), since it covers the Start button.
- Outputs: `playfield-<engine>.{json,md}`; screenshots under `evidence/playfield-<engine>/`.
- Self-tests (`QA_SELF_TEST`, use a separate `QA_OUT`; each must FAIL): `hud` (a fixed box over the local sprite before each HUD sample), `contrast` (sprite fill replaced by its background before the ratio), `camera` (a fake live player in the far corner of the in-view check), `feedback` (synthetic 5-tick delay, no browser).

## robust.mjs

Console and network health, slow network, disconnect and reconnect, offline window, reload, back navigation, resize, phone rotation, tab switch, two tabs of one account, and a bad room code.

- Command: `cd client && bun qa/robust.mjs`
- Engines: all three; CDP-only parts (network profiles) on chromium.
- Fails on uncaught page errors, unexpected console errors, and unexpected failed or >= 400 requests. Deliberate faults (offline windows, the bad room) are recorded as `netExpected`, not failed.
- Outputs: `robust-<engine>.{json,md}`.
- Self-test (`QA_SELF_TEST`): `console` (console error at load), `request` (failed cross-origin request at load), `badroom` (a real room code where the unknown one is expected). Each runs only its own case (`boot.clean.webgl2` or `badroom`) and must FAIL.
- Offline (`net.offline20s.match`): the page's WebSockets go through `routeWebSocket` (`gateSocket`), which refuses every socket while the 20 s window is open. The live socket is dropped first, while the page is still online (taking the network down before the close leaves the close handshake without a reply, so no close event fires). Then the network is cut (CDP `Network.emulateNetworkConditions` offline on chromium, `setOffline` on other engines) and held for 20 s. Pass: the reconnect banner appears within 10 s, stays up for the whole window (sampled every 500 ms and checked at the end, `offline.heldToEnd`), clears after recovery, and the HUD is back.
- Tab switch (`tab.switch.match`): a second page is brought to front and the match page stays hidden for 60 s. When headless reports the page as visible, the case hides it by overriding `document.visibilityState`/`hidden` and dispatching `visibilitychange` (`tab.hiddenMethod: synthetic`). If the page still is not hidden, the case is `info` with `not exercised: the page could not be hidden`, never a pass. Pass: hidden for the whole window, visible again and HUD back on return.
- Two tabs (`two.tabs.sameAccount.match`): a guest joins the room, then the host account opens a second tab in the same context. The room must list two entries, one of them for the host account.
- Phone pages (`rotate.phone.practice`) open through `openPhoneAt`: an exact viewport, and a browserType shim so firefox and webkit resolve their device profile.

## input.mjs (QaInput-owned; CLI only)

Keyboard bindings, reserved keys, on-screen touch controls and gamepads.

- Command: `cd client && bun qa/input.mjs` (`QA_ENGINES` to narrow; `input.latency` alone via the case argument; `QA_LATENCY_SAMPLES` sets the latency sample count, default 30)
- Outputs: `input-<engine>.{json,md}`, evidence under `evidence/input-<engine>/` (`latency-samples.json` holds per-sample latency, state and control-flip values, plus rAF intervals).
- Cases: `keys.default`, `keys.reserved`, `keys.chatLeak`, `touch.buttons`, `touch.stick` (CDP touch on chromium, mouse events elsewhere), `gamepad.buttons`, `gamepad.stick` (injected standard-mapping pad), `input.latency` (all three engines).
- Signal: frame change of the practice canvas (hash per frame), idle window against held-input window. `input.latency` reads full-resolution canvas pixels in-page (`PIXEL_PROBE`, rAF readback) and the engine state (`window.__qa`), timed against a trusted ArrowRight keydown (`HOOK`, first init script).
- `keys.chatLeak`: with chat focused, each default game key is held in turn. The engine's input mask (`window1` over `window.__qa`) must stay 0 for every key and focus must stay in the chat field; after closing chat, ArrowRight must set the right bit. Pass: zero leaked keys (exact, threshold 0; the control is not canvas pixels), and the control sets the bit.
- `input.latency`: each sample walks the player to the left wall, waits until the canvas has been still 500 ms, then presses ArrowRight. `input.latency.ms` is the p95 of keydown to the first presented frame whose pixels differ from rest; `input.latency.stateMs` is the same to the first engine frame with a changed local state. Pass: p95 <= 250 ms, no sample without a presented change, no change in a frame before the keydown. `input.rafMs.off|on` are rAF intervals without and with the readback running, so the probe's own cost is visible. Runs on chromium, firefox and webkit.
- Known limits: inputs with no visible effect in the current state (rocket with no ammo, grab with no target) read as silent; the detail names them. Latency numbers measured on a loaded host are not comparable to quiet-host numbers.
- Self-test: `QA_SELF_TEST=delay-input` (ArrowRight delivered 300 ms late) must FAIL `input.latency`; `QA_SELF_TEST=chat-leak` (game keys reach the engine from the chat field) must FAIL `keys.chatLeak`. Other faults are listed in `input.mjs`.

## netgame.mjs (RUBRIC D22; netcode under impairment)

Two clients play one match while a relay on the WebSocket path delays, jitters and loses messages. Reports desync, rollback depth and whether the match survives impairment.

- Command: `cd client && node qa/netgame.mjs <chromium|firefox|webkit>` (one engine per process). `JN_CONDS` picks conditions from `rtt0,rtt100,impair,jit,loss,lat` (default `rtt0,rtt100,impair`); `JN_DUR` is the play window in ms (default 30000). Chromium runs webgpu and webgl2; firefox and webkit run webgl2.
- Outputs: `netgame-<engine>.jsonl` (one record per renderer and condition), `evidence/netgame-<engine>-<renderer>-<cond>-{host,guest}.png`, and `evidence/netgame-<engine>-<renderer>-<cond>-samples.json` (every HUD sample of the play window: the time series behind the record), under `QA_OUT`.
- Metrics: `net.desync.count` (clients whose Snapshot row showed `gap a-b` or `hash t`; threshold 0), `net.rollback.depth.p95` (last HUD `Rollback p95` sample of each client, worst of the two, at rtt100; threshold <= 8; the per-run max is kept as `rollbackP95.hostMax`/`guestMax`), `net.impair.pass` (impair condition: 1 when the match runs the full play window (`fullWindow`: each client's last sample is past `JN_DUR` and still has HUD rows; the match is set to `objectiveLimit` 99 so it cannot end early), no resync, no desync, both canvases still change and the scoreboards agree).
- Host load: the record carries `fps` (median HUD FPS per client) and `starved`: true when either FPS median is under 20 or the FPS row is missing. With no jitter and no loss, it is also true when the measured RTT median is more than 100 ms above the injected RTT (page timers slip under host load). Under jitter or loss the measured RTT follows the relay's own model, so only FPS counts there. A starved engine inflates rollback depth and can blank the scoreboard read. Such runs are provisional; rerun the condition alone before reading a failure.
- Relay is FIFO only. A WebSocket is an ordered TCP stream: each direction has one queue released strictly in order, and a lost message stalls every later one (head-of-line), as TCP does. A relay that let a later message overtake an earlier one would model a transport the game never runs on, so there is no reorder mode.

## gameplay.mjs (RUBRIC D23; hit registration and replay fidelity)

Two cases on a fixture map (one flat 12-unit platform with a pit below): a bat hit pushes a player off the platform, and the last hitter gets the KO.

- Command: `cd client && NEOBOX_DIST=<build dir> QA_OUT=<dir> node qa/gameplay.mjs`. `QA_ENGINES` and `QA_RENDERERS` narrow the cells; `QA_REPLAY_MATCHES` (default 3) and `QA_REPLAY_MS` (default 60000) size the replay case. Self-tests: `QA_SELF_TEST=hitbox|replay`.
- `gameplay.hitbox.agree` (1 = pass): both clients, no relay, each player swings point-blank `HITBOX_SWINGS` (10) times, the first presser alternating by round (a fixed order credits one direction only: the first key lands the hit before the victim's bat fires, `crates/net/tests/bat_hits.rs`). Pass: no resync, equal non-empty hit logs on both clients, scoreboards agree, at least 5 checksum frames. `gameplay.hitbox.hits.hostToGuest` and `guestToHost` report each direction; they are not passed or failed on their own.
- `replay.fidelity` (1 = pass): a match recorded with objectiveLimit 2 is replayed without seeking; its KO order and scoreboard equal the live host's, the live clients agree, and at least one KO happened. `replay.log.match` reports whether the full event log equals live.
- Hit and KO truth comes from the client logs (the `.hud-events` rows), compared client to client. No server-side hit record is read here.

## audit.mjs

Inventory coverage, copy placeholders, design token spread, dead controls and preference persistence (RUBRIC D13, D14, D18, D19).

- Command: `cd client && QA_OUT=C:/Users/aggressivecombo/neobox-scratch/qa/round0-extra node qa/audit.mjs`
- Engines: `QA_ENGINES` (default all three).
- Cases: `QA_ONLY=copy,coverage,dead,tokens,persist,accountSync` (default all). Keys: `coverage.inventory.missing`, `copy.placeholderHits`, `tokens.distinct.<fontSize|radius|padding|color>.<role>`, `tokens.distinct.fontSize.body`, `deadControl.count`, `persist.roundTrip`, `persist.accountSync` (info).
- Pass rules: coverage and copy pass at 0; tokens pass when every role/property has one value and body font sizes are <= 6; dead controls pass at 0; persist passes at 1.0.
- Self-test (`QA_SELF_TEST`): `placeholder` (copy), `inventory` (coverage), `dead` (dead controls), `tokens` (stray button with its own radius/size), `persist` (wipes `neobox.prefs` before reload). Each runs only its own case and must FAIL.
- Persist selectors (radiogroups by aria-label, `label.check` switches, `.settings-nav-item`) are checked against `src/ui/screens/settings.ts`. `accountSync` is info only.
- The dead-control scan covers desktop only (by design); copy and coverage cover desktop and phone.

## capture.mjs (library) and sweep.mjs (CLI)

One capture is a page state at one (engine, theme, row, axis, renderer). `measureState()` in `capture.mjs` takes a row object (`{id, W, H, dsf, input, zoom?, textSpacing?, rootScale?, notch?, pseudo?}`, from `presets.mjs`), an axis (settings media: `none`, `reduce`, `forced`, `more`, `palette-*`) and `expectTheme`, and returns the metrics named in `thresholds.json`. `captureOne()` writes `<out>/<engine>/<theme>/<row.id>[-axis][-renderer]/<state>.{png,json}`.

- Command: `cd client && bun qa/sweep.mjs --dist <build dir> [--plan] [--tiers P,F,A,S] [--states a,b] [--rows T1-M,...] [--engines chromium,firefox,webkit] [--themes light,dark] [--jobs 3] [--out DIR]`
- `--dist` (or `NEOBOX_DIST`) is required; there is no default build. Default out: `neobox-scratch/qa/capture/<dist basename>`. Writes `summary.json` and `summary.md`.
- The cells come from `plan.mjs`, the rubric RUBRIC rev7 section 2.2 plan: tier P (14 page states, 18 rows plus T3-notch on chromium), F (5 fit states on four engine/renderer combos, plus the gamepad mock on gameplay), A (appearance axes), S (canvas and other states). 2572 cells; `--plan` prints the per-tier states, rows, combos and counts against the rubric and runs nothing. Cells that name the same physical run (postgame) capture once.
- Themes are `light` and `dark`. `--states` and `--rows` narrow the plan; the per-tier summary reports planned cells, runs and passes.
- C07 expected entries (rubric rev7f). A state that injects a failure lists what it breaks: `handle.expected` (URL patterns: the dropped socket `SOCKET_URL` in `states.mjs`, the sound files, the stubbed `/api/maps`) and `handle.expectedWarnings` (anchored text for app log lines the fault produces). Console errors match by the URL the browser names (`msg.location()` or any URL in the text), never by loose text. Matches land in `details.induced` and are not counted in `console.errors`.
- Browser-generated warnings (`BROWSER_WARNINGS` in `capture.mjs`) are matched on the whole text, not by substring: Firefox's `[JavaScript Warning: "WebGPU is disabled by blocklist." {file: ... line: N}]`, Firefox's `[JavaScript Warning: "The execution of microtasks on this page was reordered to avoid unsafe execution." {file: ... line: N}]`, Firefox's `[JavaScript Warning: "Request for fullscreen was denied because requesting element is not in the currently focused tab." {file: ... line: N}]` (headless capture tabs are never focused), and Playwright's `Service Worker registration blocked by Playwright`. Those are listed under `console.warnings` with the `browser |` prefix and not counted.
- Browser-generated console errors (`BROWSER_ERRORS` in `capture.mjs`, exact text): Firefox's `The connection to ws://<host>/ws was interrupted while the page was loading.` (a page navigated while its socket was still connecting). Listed in `details.browserErrors`, not counted.
- Summary: `details.induced`, `details.browserErrors` and `browser |` warnings are the exempt entries; every app-class entry counts toward `console.errors`, `console.warnings` or `page.errors`.

## states.mjs (data)

Page states the sweep captures. Each entry has `prepare(s)` that builds the state on a scenario and returns the handle to measure, plus flags: `fit` (no vertical scroll), `dialog` (modal open, focus-trap audit), `splash` (keep the phone splash). Ids include `menu-anon`, `menu-user`, `menu-news`, `menu-quick`, `browse`, `create-room`, `password-prompt-list`, `password-prompt-invite`, `error-toast`, `room-host` and others (see the file).

## presets.mjs (data)

Viewport rows of the rubric (section 2.2): `T1-M` 1280x800 dsf 1 (with text spacing), touch rows `T3-T` through `T11-T` at dsf 2-3, `T3-notch` (chromium only, safe-area insets), zoom rows `Z200-M` (640x400, zoom 200) and `Z400-M` (320x256, zoom 400), `TS200-M` (root font doubled), and pseudo-locale rows `PL-*`. Each row's `id` names its output directory. Input: M = mouse + keyboard, K = keyboard only, T = touch, G = gamepad mock.

## metrics.mjs, focus.mjs, image.mjs (libraries)

- `metrics.mjs`: `domMeasure()` (layout, overflow, overlap, obscuring, targets, SR names, balance, runs in the page), reduced-motion check, axe-core, reflow issues.
- `focus.mjs`: Tab-walk focus audit: `focus.invisible` (T1-K only), `focus.obscured` (every Tab stop, centre covered by a fixed or sticky element), `focus.order.jumps` (scroll-aware), `focus.trapBroken`.
- `image.mjs`: screenshot pixel metrics: void cells, text-over-media contrast, control border contrast.

## lib-qa.mjs (library)

Shared helpers for every instrument: `launchEngine` and `muteAudio` re-exports, `startPractice`, `outDir`, `selectedEngines`, `selfTestMode`, network profiles and `setNetwork`, `setCpu`, `cdpOf`, `heapSample`, `slope`, `percentile`, `median`, `watchPage` (page error and console tracking), `shot`, `Results` (per-case records and markdown), `writeIndex`.

## thresholds.mjs and thresholds.json (data)

Per-metric `max` / `min` for capture records; `validateRecord()` returns the failures for one record. `skipFit` rules skip a metric on screens that fit.

## validate.mjs

Detector self-test for the capture metrics. Every threshold in `thresholds.json` must fire on the fixture that injects its problem, and clean fixtures must produce zero failures.

- Command: `cd client && bun qa/validate.mjs [--engines chromium,firefox,webkit]`
- Exit code 1 when a detector misses its fixture, a clean fixture fails, or a threshold has no fixture.
- Fixtures: one or more per threshold key in `FIXTURES`; `clean` and `clean-dialog` must report zero failures. Each fixture names its row and axis (zoom, text spacing, notch, forced colours, more contrast).

## summarize.mjs

Reads every capture record under a root and writes `summary.md` (failures by metric, then by engine, theme, size and state, with example screenshots).

- Command: `bun qa/summarize.mjs [root]` (default `neobox-scratch/qa/round0`). `sweep.mjs` and `width-sweep.mjs` call the same writer.

## width-sweep.mjs

Layout-only width sweep: CSS widths 280 to 3840 in steps of 20 at heights 480, 800 and 1200, mouse profile at dsf 1, separate from the preset matrix.

- Command: `cd client && bun qa/width-sweep.mjs --dist <build dir> [--engines chromium] [--themes light] [--states menu-anon,room-host] [--jobs 16] [--out DIR]`
- Default out: `neobox-scratch/qa/width-sweep`. Chromium only by default; 540 sizes per state and theme, so narrow `--states` for quick runs.
