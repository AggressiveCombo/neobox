# perf.mjs: performance instrument

Rubric D12 (RUBRIC.md, lines 376-425). Source: `client/qa/perf.mjs`. Status: rewritten for R0-20; chromium self-tests and clean load runs executed (see "Verification status").

## Command

```
cd client && QA_OUT=C:/Users/aggressivecombo/neobox-scratch/qa/round1-instruments bun qa/perf.mjs
```

| Env | Default | Meaning |
| --- | --- | --- |
| `QA_ENGINES` | all three | engines to run |
| `QA_SOAK_MS` | 600000 | length of one soak run (10 min per the rubric) |
| `QA_SOAK_RUNS` | 3 | soak runs per condition |
| `QA_FPS_MS` | 30000 | frame sample length (30 s steady match for long tasks) |
| `QA_SELF_TEST` | unset | `jank` or `leak`; the run must fail |

Outputs: `<QA_OUT>/perf-<engine>.{json,md}` and `<QA_OUT>/evidence/perf-<engine>/` (fps screenshots).

## Cases and where they run

| Case | Engines | Notes |
| --- | --- | --- |
| `probe` | all | navigator.gpu, CDP availability, `PerformanceObserver.supportedEntryTypes`, user agent |
| `load.none.webgpu`, `load.none.webgl2` | all | 3 cold loads each; banded on chromium only |
| `load.fast3g` | chromium (CDP) | measured, not banded |
| `load.slow3g` | chromium (CDP) | banded: interactive <= 8000 ms |
| `fps.{practice,match}.{webgpu,webgl2}` | all | pctDisplay and dropped frames banded on chromium |
| `fps.*.cpu4x` | chromium (CDP) | median fps >= 30 at 4x CPU throttle |
| `soak.t1m.run{1..3}` | chromium (CDP) | 10 min each, normal CPU |
| `soak.t3t4x.run{1..3}` | chromium (CDP) | 10 min each, 4x CPU |

A case that depends on a missing capability records `N/A` with the probe value: no `navigator.gpu` means WebGPU is N/A; no CDP session means throttling, network, heap and soak are N/A.

## Measurements

- **Interactive / load**: `menuVisibleAt()`: time until the name box is visible (`performance.now()` in the page).
- **LCP**: a `PerformanceObserver('largest-contentful-paint', { buffered: true })` installed by an init script before app code. The value is the last entry at or before the earlier of the first input (keydown, pointerdown, mousedown, touchstart) and 10 s. Entries are read after the 10 s window (or 5 s after interactive, whichever is later).
- **CLS (load)**: sum of `layout-shift` values without `hadRecentInput`, up to 5 s after interactive.
- **Transfer**: navigation + resource `transferSize`, KB.
- **Frames**: `requestAnimationFrame` deltas over `QA_FPS_MS`. `perf.displayHz` is the idle rAF median (2 s) before input or throttling. `fps.median = 1000 / median(delta)`; `fps.pctDisplay = fps.median / displayHz`; `droppedFrames.pct` is the share of deltas above 1.5 frame intervals.
- **Long tasks**: `longtask` observer, counted over the match sample (chromium only; `null` where unsupported).
- **Heap soak**: `Performance.getMetrics` after a forced GC every 5 s, while the player walks left and right. `perf.heapMB.slope` is the least-squares regression of JS heap MB against minutes over the whole soak window (no warm-up exclusion); `endMinusStartPct` is the change from the first sample to the last.
- **Renderer**: `document.documentElement.dataset.renderer` for each case; the case fails if it is not the renderer the case asked for.

## Gates (9-level, chromium)

| Metric | Gate |
| --- | --- |
| `perf.loadMs` (worst of 3) | <= 1500 ms |
| `perf.lcpMs` (worst of 3) | <= 2000 ms (missing = fail on chromium) |
| `perf.transferKB` | <= 600 KB |
| `perf.cls.load` | <= 0.1 |
| `load.slow3g.interactiveMs` | <= 8000 ms |
| `perf.fps.pctDisplay` (practice and match, both renderers) | >= 92 |
| `perf.droppedFrames.pct` | <= 1 |
| `fps.*.cpu4x` `perf.fps.median` | >= 30 |
| `perf.longTasks` (match, 30 s) | 0 |
| `perf.heapMB.slope` (soak) | <= 0.5 MB/min |
| `perf.heapMB.endMinusStartPct` (soak) | <= 15 % |

Firefox and WebKit are measured and reported as info; the rubric bands only `fps.pctDisplay` and `droppedFrames.pct` there. Worst run counts.

## Self-tests

- `QA_SELF_TEST=jank`: a 120 ms busy loop every 250 ms on the main thread during the fps cases. Must fail the fps and dropped-frame gates.
- `QA_SELF_TEST=leak`: a 200k-element array retained every 500 ms during each soak. Must fail the soak gates.

The file has no case filter, so a self-test runs every case. Shorten with `QA_SOAK_MS=60000 QA_SOAK_RUNS=1 QA_FPS_MS=6000 QA_ENGINES=chromium` and a separate `QA_OUT`.

## Known limits

- LCP and CLS support differs by engine. The probe records `probe.lcpSupported` and `probe.clsSupported` per engine; where a value is missing the case says so instead of inventing one.
- Soak uses practice mode only (the match soak is not implemented).
- Run time is not yet measured. The soak alone is 6 x 10 min = 60 min on chromium; firefox and webkit run only the load and fps cases (estimate: minutes, not hours).
- `perf.displayHz` is a 2 s idle rAF sample on a shared host, not a vsync reading. Across the first verification run it ranged 20.6 to 144.9 Hz between cases, so `fps.pctDisplay` can exceed 100 or read low for reasons unrelated to the app. Treat pctDisplay as a noisy signal until displayHz is measured on a quiet host or replaced with a fixed reference.

## Verification status

- The rewrite imports resolve against `lib-qa.mjs` (`heapSample`, `setCpu`, `setNetwork`, `startPractice`, `matchWithGuest`, `watchPage`, `shot`, `slope`, `percentile`, `median`, `Results`, `writeIndex`, `runCleanups`).
- Executed on chromium (dist-FixA). Clean: load.none.webgpu/webgl2 and load.slow3g PASS (slow3g renderer-null fixed by waiting for `data-renderer`). Self-tests: jank injection FAILs the fps cases (dropped frames and long tasks); leak injection FAILs soak.t1m and soak.t3t4x (about 91 MB/min slope, end-minus-start about 3,200%). Known noise: a clean jank run measured soak.t1m slope 0.555 MB/min against the 0.5 limit, so the soak gate is marginal at 60 s windows.
- Still open: LCP and CLS on firefox and webkit (engine-specific support), full-length (>=10 min) soak on a clean build, and a quiet-host displayHz reference.
