// Performance instrument (rubric D12): load time and LCP/CLS, frame pacing in a practice run and
// a live match (normal CPU and 4x CPU throttle, both renderers), network profiles, and a heap soak.
// Every engine runs the frame and load cases; CDP-only parts (throttling, network profiles, heap,
// long tasks, CLS) run on chromium and record N/A on the others with the probe value.
// Renderers: WebGPU (default) and WebGL2 (navigator.gpu hidden before the app boots). WebGPU is
// N/A where the probe finds no navigator.gpu.
//
// Run: cd client && QA_OUT=<dir> bun qa/perf.mjs            (QA_ENGINES=chromium to limit engines)
// Env: QA_SOAK_MS (default 600000 = 10 min), QA_SOAK_RUNS (default 3), QA_FPS_MS (default 30000).
// Output: <QA_OUT>/perf-<engine>.{json,md}, evidence under <QA_OUT>/evidence/perf-<engine>/.
// Self-test: QA_SELF_TEST=jank (busy main thread) or QA_SELF_TEST=leak (retained heap) must fail.

import path from "node:path";
import {
  Results,
  cdpOf,
  heapSample,
  launchEngine,
  matchWithGuest,
  median,
  outDir,
  percentile,
  rel,
  runCleanups,
  selectedEngines,
  selfTestMode,
  setCpu,
  setNetwork,
  shot,
  slope,
  sleep,
  startPractice,
  startServer,
  watchPage,
  writeIndex,
} from "./lib-qa.mjs";

// Rubric D12 bands at the 9 level (section 3); a case passes when every banded metric it covers
// meets them. Worst run counts (rubric section 1 rule 8).
const GATE = {
  loadMs: 1500,
  slow3gMs: 8000,
  lcpMs: 2000,
  transferKB: 600,
  clsLoad: 0.1,
  fpsPctDisplay: 92,
  fps4x: 30,
  droppedPct: 1,
  longTasks: 0,
  heapSlope: 0.5,
  heapEndPct: 15,
};
const RENDERERS = ["webgpu", "webgl2"];
const FPS_MS = Number(process.env.QA_FPS_MS ?? 30000);
const SOAK_MS = Number(process.env.QA_SOAK_MS ?? 600000);
const SOAK_RUNS = Number(process.env.QA_SOAK_RUNS ?? 3);
const LOAD_RUNS = 3;
const CPU_RATE = 4;
// LCP is final at the first input or 10 s (Chrome definition, rubric D12); CLS counts 5 s after interactive.
const LCP_WINDOW_MS = 10000;
const CLS_AFTER_MS = 5000;
const DROP_FACTOR = 1.5;

const round = (n, d = 1) => (Number.isFinite(n) ? Number(n.toFixed(d)) : null);
const max = (values) => (values.some((v) => v === null) ? null : Math.max(...values));

/**
 * Runs in every page before app code: records LCP entries, the first input time and layout
 * shifts. `hideGpu` hides navigator.gpu so the app takes the WebGL2 path.
 */
function perfInit(hideGpu) {
  if (hideGpu) Object.defineProperty(navigator, "gpu", { value: undefined, configurable: true });
  const q = (window.__qaPerf = { lcp: [], shifts: [], inputAt: null, lcpSupported: false, clsSupported: false });
  for (const type of ["keydown", "pointerdown", "mousedown", "touchstart"]) {
    addEventListener(type, () => { if (q.inputAt === null) q.inputAt = performance.now(); }, { capture: true, passive: true });
  }
  const observe = (type, onEntries) => {
    try {
      new PerformanceObserver((list) => onEntries(list.getEntries())).observe({ type, buffered: true });
      return true;
    } catch {
      return false;
    }
  };
  q.lcpSupported = observe("largest-contentful-paint", (es) => { for (const e of es) q.lcp.push(e.startTime); });
  q.clsSupported = observe("layout-shift", (es) => { for (const e of es) if (!e.hadRecentInput) q.shifts.push([e.startTime, e.value]); });
}

/** Adds the init script to every context the case opens. */
function prepare(s, renderer) {
  const openOriginal = s.open.bind(s);
  s.open = async (label, opts) => {
    const h = await openOriginal(label, opts);
    await h.context.addInitScript(perfInit, renderer === "webgl2");
    watchPage(h);
    return h;
  };
}

/** Resolves with performance.now() once the menu's name box is visible (home interactive). */
const menuVisibleAt = () =>
  new Promise((resolve) => {
    const tick = () => {
      const el = document.querySelector('input[placeholder="name"]');
      if (el && el.offsetParent !== null) resolve(performance.now());
      else setTimeout(tick, 10);
    };
    tick();
  });

/** Frame deltas (ms) over `ms` plus long-task count (where PerformanceObserver supports longtask). */
const frameSample = (page, ms) =>
  page.evaluate(
    (ms) =>
      new Promise((resolve) => {
        const deltas = [];
        let last = null;
        let longTasks = 0;
        let po = null;
        try {
          po = new PerformanceObserver((list) => {
            longTasks += list.getEntries().length;
          });
          po.observe({ type: "longtask", buffered: false });
        } catch {
          po = null;
        }
        const t0 = performance.now();
        const frame = (t) => {
          if (last !== null) deltas.push(t - last);
          last = t;
          if (t - t0 < ms) {
            requestAnimationFrame(frame);
          } else {
            po?.disconnect();
            resolve({ deltas, longTasks, longTasksSupported: po !== null });
          }
        };
        requestAnimationFrame(frame);
      }),
    ms,
  );

/** Busy main thread (self-test jank) so the frame and dropped-frame budgets must fail. */
const jankForever = () =>
  setInterval(() => {
    const t = performance.now();
    while (performance.now() - t < 120);
  }, 250);

/** Idle rAF median on the same page, before input and before CPU throttling. */
async function measureDisplayHz(page) {
  const idle = await frameSample(page, 2000);
  return 1000 / median(idle.deltas);
}

function frameMetrics(sample, displayHz) {
  const d = sample.deltas;
  const fps = 1000 / median(d);
  const interval = 1000 / displayHz;
  const dropped = (d.filter((x) => x > DROP_FACTOR * interval).length / d.length) * 100;
  return {
    "perf.displayHz": round(displayHz, 1),
    "perf.fps.median": round(fps),
    "perf.fps.pctDisplay": round((fps / displayHz) * 100),
    "perf.droppedFrames.pct": round(dropped, 2),
    "perf.frame.p95Ms": round(percentile(d, 95)),
    "perf.frame.p99Ms": round(percentile(d, 99)),
    "perf.longTasks": sample.longTasksSupported ? sample.longTasks : null,
    frames: d.length,
  };
}

/** One page load (cold context): home interactive, LCP, transfer, CLS and the renderer. */
async function loadOnce(s, base, label, net) {
  const h = await s.open(label);
  if (net) await setNetwork(await cdpOf(h.page), net);
  await h.page.goto(base, { waitUntil: "load" });
  const loadMs = await h.page.evaluate(menuVisibleAt);
  // Wait for the LCP window to close (10 s, or CLS's 5 s after interactive), then read the entries.
  await h.page.evaluate(
    (until) => new Promise((resolve) => setTimeout(resolve, Math.max(0, until - performance.now()))),
    Math.max(LCP_WINDOW_MS, loadMs + CLS_AFTER_MS),
  );
  // The renderer is created on the first engine frame, which a slow network can delay past the window; wait for it
  // (the wait does not change loadMs, which is already measured).
  await h.page.waitForFunction(() => !!document.documentElement.dataset.renderer, null, { timeout: 60000 }).catch(() => undefined);
  const info = await h.page.evaluate(
    ({ loadMs, lcpWindow, clsAfter }) => {
      const q = window.__qaPerf;
      const lcpEnd = Math.min(lcpWindow, q.inputAt ?? Infinity);
      const lcpBefore = q.lcp.filter((t) => t <= lcpEnd);
      const clsEnd = loadMs + clsAfter;
      const nav = performance.getEntriesByType("navigation")[0];
      const res = performance.getEntriesByType("resource");
      const bytes = (nav?.transferSize ?? 0) + res.reduce((a, r) => a + (r.transferSize || 0), 0);
      return {
        lcpMs: q.lcpSupported && lcpBefore.length ? lcpBefore[lcpBefore.length - 1] : null,
        // Sum of layout-shift values up to the window end (no session-window grouping).
        cls: q.clsSupported ? q.shifts.filter(([t]) => t <= clsEnd).reduce((a, [, v]) => a + v, 0) : null,
        transferKB: bytes / 1024,
        renderer: document.documentElement.dataset.renderer ?? null,
        gpu: !!navigator.gpu,
      };
    },
    { loadMs, lcpWindow: LCP_WINDOW_MS, clsAfter: CLS_AFTER_MS },
  );
  await h.context.close();
  return { loadMs, ...info };
}

/** LOAD_RUNS cold loads; the worst run is reported and banded. */
async function loadCase(s, base, { net, renderer, gated }) {
  const runs = [];
  for (let i = 0; i < LOAD_RUNS; i++) runs.push(await loadOnce(s, base, `load${i}`, net));
  const wrong = runs.find((r) => renderer && r.renderer !== renderer);
  if (wrong) throw new Error(`renderer is ${wrong.renderer}, expected ${renderer}`);
  const loadMs = max(runs.map((r) => r.loadMs));
  const lcpMs = max(runs.map((r) => r.lcpMs));
  const cls = max(runs.map((r) => r.cls));
  const transferKB = max(runs.map((r) => r.transferKB));
  const metrics = {
    [net ? `load.${net}.interactiveMs` : "perf.loadMs"]: round(loadMs, 0),
    [net ? `load.${net}.runs` : "perf.loadMs.runs"]: runs.map((r) => round(r.loadMs, 0)),
    "perf.lcpMs": round(lcpMs, 0),
    "perf.lcpMs.runs": runs.map((r) => round(r.lcpMs, 0)),
    "perf.cls.load": round(cls, 3),
    "perf.transferKB": round(transferKB, 0),
    "perf.renderer": runs[0].renderer,
    "perf.gpu": runs[0].gpu,
    network: net ?? "none",
  };
  if (net === "slow3g") {
    return { pass: loadMs <= GATE.slow3gMs, metrics, detail: `slow3g interactive <= ${GATE.slow3gMs} ms (9 band)` };
  }
  if (net) return { pass: true, metrics, detail: "fast3g: measured, not banded" };
  const problems = [];
  if (loadMs > GATE.loadMs) problems.push(`loadMs ${round(loadMs, 0)} > ${GATE.loadMs}`);
  if (lcpMs === null) problems.push("LCP not measured");
  else if (lcpMs > GATE.lcpMs) problems.push(`lcpMs ${round(lcpMs, 0)} > ${GATE.lcpMs}`);
  if (transferKB > GATE.transferKB) problems.push(`transferKB ${round(transferKB, 0)} > ${GATE.transferKB}`);
  if (cls === null) problems.push("CLS not measured");
  else if (cls > GATE.clsLoad) problems.push(`cls.load ${round(cls, 3)} > ${GATE.clsLoad}`);
  return {
    pass: problems.length === 0,
    metrics,
    detail: problems.length ? problems.join("; ") : `9-band: load<=${GATE.loadMs} ms, LCP<=${GATE.lcpMs} ms, transfer<=${GATE.transferKB} KB, CLS<=${GATE.clsLoad}`,
  };
}

/** One frame-pacing case: a practice run or a live match, normal or 4x CPU. */
async function frameCase(s, base, ctx, { kind, renderer, cpu }) {
  let page;
  if (kind === "practice") {
    const h = await s.open("practice");
    await startPractice(h, base, renderer);
    page = h.page;
  } else {
    const { host } = await matchWithGuest(s, { clipboard: false });
    const got = await host.page.evaluate(() => document.documentElement.dataset.renderer ?? null);
    if (got !== renderer) throw new Error(`renderer is ${got}, expected ${renderer}`);
    page = host.page;
  }
  const displayHz = await measureDisplayHz(page);
  const cdp = cpu ? await cdpOf(page) : null;
  if (cdp) await setCpu(cdp, CPU_RATE);
  if (selfTestMode() === "jank") await page.evaluate(jankForever);
  await page.keyboard.down("ArrowRight");
  let sample;
  try {
    sample = await frameSample(page, FPS_MS);
  } finally {
    await page.keyboard.up("ArrowRight").catch(() => undefined);
    if (cdp) await setCpu(cdp, 1).catch(() => undefined);
  }
  const file = await shot(page, path.join(outDir(), "evidence", `perf-${ctx.engine}`, `fps-${kind}-${renderer}${cpu ? "-cpu4x" : ""}.png`));
  const metrics = { ...frameMetrics(sample, displayHz), kind, renderer, cpu4x: cpu, "perf.renderer": renderer };
  const problems = [];
  if (cpu) {
    if (metrics["perf.fps.median"] < GATE.fps4x) problems.push(`fps.median ${metrics["perf.fps.median"]} < ${GATE.fps4x} (4x)`);
  } else if (metrics["perf.fps.pctDisplay"] < GATE.fpsPctDisplay) {
    problems.push(`fps.pctDisplay ${metrics["perf.fps.pctDisplay"]} < ${GATE.fpsPctDisplay}`);
  }
  if (metrics["perf.droppedFrames.pct"] > GATE.droppedPct) problems.push(`droppedFrames.pct ${metrics["perf.droppedFrames.pct"]} > ${GATE.droppedPct}`);
  if (kind === "match" && metrics["perf.longTasks"] !== null && metrics["perf.longTasks"] > GATE.longTasks) {
    problems.push(`longTasks ${metrics["perf.longTasks"]} > ${GATE.longTasks} over ${FPS_MS / 1000} s`);
  }
  return {
    pass: problems.length === 0,
    metrics,
    evidence: file ? [rel(file)] : [],
    detail: problems.length ? problems.join("; ") : cpu ? `9-band: fps.median>=${GATE.fps4x} (4x), dropped<=${GATE.droppedPct}%` : `9-band: pctDisplay>=${GATE.fpsPctDisplay}, dropped<=${GATE.droppedPct}%`,
  };
}

/** Heap soak in a practice run (chromium CDP): regression slope over the whole window and end-minus-start. */
async function soakCase(s, base, { cpu }) {
  const h = await s.open("soak");
  await startPractice(h, base, "webgpu");
  const cdp = await cdpOf(h.page);
  if (cpu) await setCpu(cdp, CPU_RATE);
  if (selfTestMode() === "leak") {
    await h.page.evaluate(() => {
      window.__leak = [];
      setInterval(() => window.__leak.push(new Array(200000).fill(1)), 500);
    });
  }
  const points = [];
  const t0 = Date.now();
  let key = "ArrowRight";
  await h.page.keyboard.down(key);
  try {
    while (Date.now() - t0 < SOAK_MS) {
      const hs = await heapSample(cdp);
      points.push({ t: (Date.now() - t0) / 1000, heapMB: hs.heapMB, nodes: hs.nodes, listeners: hs.listeners });
      await sleep(5000);
      // Walk left and right so the player and its effects keep running.
      await h.page.keyboard.up(key);
      key = key === "ArrowRight" ? "ArrowLeft" : "ArrowRight";
      await h.page.keyboard.down(key);
    }
  } finally {
    await h.page.keyboard.up(key).catch(() => undefined);
    if (cpu) await setCpu(cdp, 1).catch(() => undefined);
  }
  // Least-squares slope over the whole soak window (rubric D12: linear slope of JS heap over the soak).
  const perMin = slope(points.map((p) => ({ x: p.t / 60, y: p.heapMB })));
  const first = points[0];
  const last = points[points.length - 1];
  const endPct = ((last.heapMB - first.heapMB) / first.heapMB) * 100;
  const metrics = {
    "perf.heapMB.start": round(first.heapMB, 2),
    "perf.heapMB.end": round(last.heapMB, 2),
    "perf.heapMB.slope": round(perMin, 3),
    "perf.heapMB.endMinusStartPct": round(endPct, 1),
    "perf.nodes.end": last.nodes,
    "perf.listeners.end": last.listeners,
    cpu4x: cpu,
    samples: points.length,
    seconds: round(SOAK_MS / 1000, 0),
  };
  const problems = [];
  if (!Number.isFinite(perMin)) problems.push("slope not computable");
  else if (perMin > GATE.heapSlope) problems.push(`heap slope ${round(perMin, 3)} MB/min > ${GATE.heapSlope}`);
  if (!(endPct <= GATE.heapEndPct)) problems.push(`heap end-minus-start ${round(endPct, 1)}% > ${GATE.heapEndPct}%`);
  return {
    pass: problems.length === 0,
    metrics,
    detail: problems.length ? problems.join("; ") : `9-band: slope<=${GATE.heapSlope} MB/min, end-minus-start<=${GATE.heapEndPct}%`,
  };
}

/** Probe values that decide N/A: navigator.gpu, CDP session, supported entry types. */
async function probeEngine(s, base) {
  const h = await s.open("probe");
  await h.page.goto(base, { waitUntil: "load" });
  const env = await h.page.evaluate(() => ({
    gpu: !!navigator.gpu,
    entryTypes: [...(PerformanceObserver.supportedEntryTypes ?? [])],
    userAgent: navigator.userAgent,
  }));
  let cdp = true;
  let cdpError = null;
  try {
    await cdpOf(h.page);
  } catch (err) {
    cdp = false;
    cdpError = String(err.message ?? err).split("\n")[0];
  }
  return {
    metrics: {
      "probe.navigatorGpu": env.gpu,
      "probe.cdp": cdp,
      "probe.cdpError": cdpError,
      "probe.entryTypes": env.entryTypes,
      "probe.lcpSupported": env.entryTypes.includes("largest-contentful-paint"),
      "probe.longtaskSupported": env.entryTypes.includes("longtask"),
      "probe.clsSupported": env.entryTypes.includes("layout-shift"),
      "probe.userAgent": env.userAgent,
    },
    detail: `navigator.gpu=${env.gpu}, CDP=${cdp}`,
  };
}

const naGpu = (ctx) => ({ na: `WebGPU path unavailable: probe navigator.gpu=${ctx.gpu} on ${ctx.engine}` });
const naCdp = (ctx) => ({ na: `CDP-only metric: probe found no CDPSession on ${ctx.engine}` });

const engines = selectedEngines();
const server = await startServer();
const base = server.base;

for (const engine of engines) {
  const browser = await launchEngine(engine);
  const results = new Results("perf", engine);
  const probe = await results.case("probe", (s) => probeEngine(s, base), { browser, base, info: true });
  const ctx = { engine, gpu: probe.metrics["probe.navigatorGpu"] === true, cdp: probe.metrics["probe.cdp"] === true };
  // Banded on chromium (T1-M); firefox and webkit load cases are measured and not banded (rubric D12 table).
  const gated = engine === "chromium";

  for (const renderer of RENDERERS) {
    await results.case(
      `load.none.${renderer}`,
      async (s) => {
        if (renderer === "webgpu" && !ctx.gpu) return naGpu(ctx);
        prepare(s, renderer);
        return loadCase(s, base, { renderer, gated });
      },
      { browser, base, info: !gated },
    );
  }
  if (ctx.cdp) {
    for (const net of ["fast3g", "slow3g"]) {
      await results.case(
        `load.${net}`,
        async (s) => {
          prepare(s, "webgpu");
          return loadCase(s, base, { net, renderer: "webgpu", gated: net === "slow3g" });
        },
        { browser, base, info: net === "fast3g" },
      );
    }
  } else {
    await results.case("load.slow3g", async () => naCdp(ctx), { browser, base });
  }

  // Frame pacing, practice and match, both renderers; 4x CPU is chromium only.
  for (const cpu of [false, true]) {
    for (const renderer of RENDERERS) {
      for (const kind of ["practice", "match"]) {
        const id = `fps.${kind}.${renderer}${cpu ? ".cpu4x" : ""}`;
        await results.case(
          id,
          async (s) => {
            if (cpu && !ctx.cdp) return naCdp(ctx);
            if (renderer === "webgpu" && !ctx.gpu) return naGpu(ctx);
            prepare(s, renderer);
            return frameCase(s, base, ctx, { kind, renderer, cpu });
          },
          { browser, base },
        );
      }
    }
  }

  // Heap soak: 10 min x SOAK_RUNS on T1-M normal CPU and T3-T 4x CPU (chromium CDP only).
  for (let run = 1; run <= SOAK_RUNS; run++) {
    for (const cpu of [false, true]) {
      const id = `soak.${cpu ? "t3t4x" : "t1m"}.run${run}`;
      await results.case(
        id,
        async (s) => {
          if (!ctx.cdp) return naCdp(ctx);
          prepare(s, "webgpu");
          return soakCase(s, base, { cpu });
        },
        { browser, base },
      );
    }
  }

  results.save();
  await browser.close().catch(() => undefined);
}

writeIndex();
await runCleanups();
