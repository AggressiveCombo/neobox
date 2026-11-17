# client/qa instruments

Headless browser instruments for the neobox client. Each one drives the built client (`NEOBOX_DIST`) against a fresh server and writes JSON + markdown records. Run from `client/`.

## Common rules

- Browsers start only through `launchEngine(name)` in `client/e2e/lib.mjs`. It mutes every context (firefox gets a null audio device). Do not call `chromium.launch` / `firefox.launch` / `webkit.launch` directly.
- Headless only. Port 8080 is never used (`startServer` picks a free port with a fresh DB).
- Capabilities differ by engine. CDP-only features (network/CPU throttling, heap, raw WebSocket where noted, long tasks, CLS) run on chromium only. Elsewhere they record `N/A` with the probe value.

### Environment variables

| Variable | Default | Used by |
| --- | --- | --- |
| `NEOBOX_DIST` | `C:/Users/aggressivecombo/neobox-scratch/dist-main` | all (set in `lib-qa.mjs`, `sweep.mjs`, `e2e/lib.mjs`) |
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
- Engines: XSS, chat rate-limit and profanity cases on every selected engine; raw origin and name cases on chromium only (others get an info row).
- Keys: `sec.xss.hits` (0 passes), `sec.server.nameLimit`, `sec.ws.originRejected`, `sec.chat.rateLimited`, `sec.profanity.viewerMasked`.
- Self-test (`QA_SELF_TEST`): `xss` (unsafe `innerHTML` into `h1.room-title`), `namelimit` (valid 15-char name sent where a 16-char refusal is expected), `origin` (allowed origin sent where a refusal is expected), `ratelimit` (3 chats where 20 are expected), `profanity` (the raw host sends a clean line where a masked profane word is expected). Only that key's case runs and it must FAIL.
- Known limit: each case opens its own page and server. `xss` hits are read from `window.__xssHits` and `window.__xss`, which an init script defines before page code (`openPage`). `profanity` is the masking check: a raw-WebSocket host (client bypassed) creates a room, a browser viewer joins it and sees `fuck` as `****` (default prefs); the viewer then leaves, turns "Filter profanity" off under Settings > Chat, rejoins, and must see `shit` as typed. It runs on every engine. Firefox and WebKit ignore `Navigated away from page` errors in the xss and profanity cases: the viewer navigates on purpose, and those engines report the app's in-flight calls as that error. The raw origin and name cases run on chromium only.

## social.mjs

Two-client and multi-client room flows, HUD ping badge, Browse room count, presence latency (RUBRIC D17).

- Command: `cd client && QA_OUT=<dir> node qa/social.mjs`
- Engines: every engine runs the room flows and presence. The ping badge and Browse list are DOM-only checks and run on chromium only (N/A elsewhere).
- Keys: `social.twoClient.pass`, `social.multi.pass` (N = min(4, room capacity)), `social.ping.error.ms` (<= 10), `social.ping.updateMs`, `social.roomList.counts.ok`, `social.presence.latencyMs` (<= 1000).
- Each case starts a fresh server and drives the real UI. After the match ends the host sees the postgame modal; the flow clicks "Back to room" on every client before the leave buttons.
- Self-test (`QA_SELF_TEST`): `twoclient` (guest never joins; `twoClient.pass` must be 0), `multi` (last client never joins; `multi.pass` must be 0), `ping` (forced badge value), `presence` (delayed presence hook), `roomcount` (private room counted).
- Known limit: multi needs N clients on distinct IPs; capacity is the room `max_players` clamped to `NEOBOX_MAX_PLAYERS` (default 32).

## robust.mjs

Console and network health, slow network, disconnect and reconnect, reload, back navigation, resize, phone rotation, tab switch and a bad room code.

- Command: `cd client && bun qa/robust.mjs`
- Engines: all three; CDP-only parts (network profiles) on chromium.
- Fails on uncaught page errors, unexpected console errors, and unexpected failed or >= 400 requests. Deliberate faults (offline windows, the bad room) are recorded as `netExpected`, not failed.
- Outputs: `robust-<engine>.{json,md}`.
- Self-test (`QA_SELF_TEST`): `console` (console error at load), `request` (failed cross-origin request at load), `badroom` (a real room code where the unknown one is expected). Each runs only its own case (`boot.clean.webgl2` or `badroom`) and must FAIL.
- Known limit: headless does not hide a background tab; the tab-switch case records `detail: headless did not hide the background tab`.

## input.mjs (QaInput-owned; CLI only)

Keyboard bindings, reserved keys, on-screen touch controls and gamepads.

- Command: `cd client && bun qa/input.mjs` (`QA_ENGINES` to narrow; `input.latency` alone via the case argument; `QA_LATENCY_SAMPLES` sets the latency sample count, default 30)
- Outputs: `input-<engine>.{json,md}`, evidence under `evidence/input-<engine>/` (`latency-samples.json` holds per-sample latency, state and control-flip values, plus rAF intervals).
- Cases: `keys.default`, `keys.reserved`, `touch.buttons`, `touch.stick` (CDP touch on chromium, mouse events elsewhere), `gamepad.buttons`, `gamepad.stick` (injected standard-mapping pad), `input.latency`.
- Signal: frame change of the practice canvas (hash per frame), idle window against held-input window. `input.latency` reads full-resolution canvas pixels in-page (`PIXEL_PROBE`, rAF readback) and the engine state (`window.__qa`), timed against a trusted ArrowRight keydown (`HOOK`, first init script).
- `input.latency`: each sample walks the player to the left wall, waits until the canvas has been still 500 ms, then presses ArrowRight. `input.latency.ms` is the p95 of keydown to the first presented frame whose pixels differ from rest; `input.latency.stateMs` is the same to the first engine frame with a changed local state. Pass: p95 <= 250 ms, no sample without a presented change, no change in a frame before the keydown. `input.rafMs.off|on` are rAF intervals without and with the readback running, so the probe's own cost is visible.
- Known limits: inputs with no visible effect in the current state (rocket with no ammo, grab with no target) read as silent; the detail names them. Latency numbers measured on a loaded host are not comparable to quiet-host numbers.
- Self-test: `QA_SELF_TEST=delay-input` (ArrowRight delivered 300 ms late) must FAIL `input.latency`. Other faults are listed in `input.mjs`.

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
