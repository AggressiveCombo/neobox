// Performance instrument (rubric D12): load time and LCP/CLS, frame pacing in a practice run and
// a live match (normal CPU and 4x CPU throttle, both renderers), network profiles, and a heap soak.
// Every engine runs the frame and load cases; CDP-only parts (throttling, network profiles, heap,
// long tasks, CLS) run on chromium and record N/A on the others with the probe value.
// Renderers: WebGPU (default) and WebGL2 (navigator.gpu hidden before the app boots). WebGPU is
// N/A where the probe finds no navigator.gpu.
//
// Run: cd client && QA_OUT=<dir> bun qa/perf.mjs            (QA_ENGINES=chromium to limit engines)
// Env: QA_SOAK_MS (default 600000 = 10 min), QA_SOAK_RUNS (default 3), QA_FPS_MS (default 30000), QA_FRAME_RUNS (default 3).
// Output: <QA_OUT>/perf-<engine>.{json,md}, evidence under <QA_OUT>/evidence/perf-<engine>/.
// Self-test: QA_SELF_TEST=jank (busy main thread) or QA_SELF_TEST=leak (retained heap) must fail; QA_SELF_TEST=action
// (2.5 s busy inside every UI action window) must fail the ui.* cases.

import path from "node:path";
import {
  Results,
  button,
  cdpOf,
  createRoom,
  heapSample,
  launchEngine,
  matchWithGuest,
  median,
  menuName,
  navTo,
  outDir,
  percentile,
  rel,
  runCleanups,
  selectedEngines,
  selfTestMode,
  setCpu,
  setNetwork,
  shot,
  signUp,
  slope,
  sleep,
  startPractice,
  startServer,
  uniqueName,
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
  actionP95: 300,
  inpMs: 200,
};
const RENDERERS = ["webgpu", "webgl2"];
const FPS_MS = Number(process.env.QA_FPS_MS ?? 30000);
const FRAME_RUNS = Number(process.env.QA_FRAME_RUNS ?? 3);
const SOAK_MS = Number(process.env.QA_SOAK_MS ?? 600000);
const SOAK_RUNS = Number(process.env.QA_SOAK_RUNS ?? 3);
// Soak baseline and end: medians of SOAK_EDGE samples each, the baseline taken after SOAK_WARM_MS of JIT warm-up.
const SOAK_WARM_MS = 60000;
const SOAK_EDGE = 3;
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
  const q = (window.__qaPerf = { lcp: [], shifts: [], events: [], inputAt: null, menuAt: null, lcpSupported: false, clsSupported: false, eventSupported: false });
  for (const type of ["keydown", "pointerdown", "mousedown", "touchstart"]) {
    addEventListener(type, () => { if (q.inputAt === null) q.inputAt = performance.now(); }, { capture: true, passive: true });
  }
  // Home interactive: performance.now() at the first poll that finds the menu's name box visible.
  const poll = () => {
    const el = document.querySelector('input[placeholder="name"]');
    if (el && el.offsetParent !== null) q.menuAt = performance.now();
    else setTimeout(poll, 10);
  };
  poll();
  const observe = (type, onEntries, extra = {}) => {
    try {
      new PerformanceObserver((list) => onEntries(list.getEntries())).observe({ type, buffered: true, ...extra });
      return true;
    } catch {
      return false;
    }
  };
  q.lcpSupported = observe("largest-contentful-paint", (es) => { for (const e of es) q.lcp.push(e.startTime); });
  q.clsSupported = observe("layout-shift", (es) => { for (const e of es) if (!e.hadRecentInput) q.shifts.push([e.startTime, e.value]); });
  // Event Timing for INP: keydown interactions. The 16 ms threshold is the lowest the API reports.
  q.eventSupported = observe("event", (es) => { for (const e of es) if (e.name === "keydown" && e.interactionId > 0) q.events.push({ start: e.startTime, dur: e.duration, id: e.interactionId }); }, { durationThreshold: 16 });
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

/** Worst of several frame runs (rubric section 1 rule 8): lowest fps, highest dropped share and tail times, any long-task count. */
function worstOf(runs) {
  const worst = (key, pick) => (runs.some((r) => r[key] === null) ? null : pick(...runs.map((r) => r[key])));
  return {
    "perf.displayHz": runs[0]["perf.displayHz"],
    "perf.fps.median": worst("perf.fps.median", Math.min),
    "perf.fps.pctDisplay": worst("perf.fps.pctDisplay", Math.min),
    "perf.droppedFrames.pct": worst("perf.droppedFrames.pct", Math.max),
    "perf.frame.p95Ms": worst("perf.frame.p95Ms", Math.max),
    "perf.frame.p99Ms": worst("perf.frame.p99Ms", Math.max),
    "perf.longTasks": worst("perf.longTasks", Math.max),
    "perf.fps.runs": runs.map((r) => r["perf.fps.median"]),
    "perf.droppedFrames.runs": runs.map((r) => r["perf.droppedFrames.pct"]),
    "perf.longTasks.runs": runs.map((r) => r["perf.longTasks"]),
    frames: runs.map((r) => r.frames),
  };
}

/**
 * One page load (cold context): home interactive (the init script's menuAt, performance.now() of the page), LCP,
 * transfer, CLS and the renderer. `net` is a NET_PROFILES key; `cpu` throttles the CPU to CPU_RATE.
 */
async function loadOnce(s, base, label, { net, cpu }) {
  const h = await s.open(label);
  if (net || cpu) {
    const cdp = await cdpOf(h.page);
    if (net) await setNetwork(cdp, net);
    if (cpu) await setCpu(cdp, CPU_RATE);
  }
  await h.page.goto(base, { waitUntil: "load" });
  await h.page.waitForFunction(() => window.__qaPerf.menuAt !== null, null, { timeout: 60000 });
  const loadMs = await h.page.evaluate(() => window.__qaPerf.menuAt);
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

/**
 * LOAD_RUNS cold loads; the worst run is reported and banded. `cpu` runs them at CPU_RATE, where only CLS is banded
 * (rubric D12 T3-T row).
 */
async function loadCase(s, base, { net, renderer, gated, cpu = false }) {
  const runs = [];
  for (let i = 0; i < LOAD_RUNS; i++) runs.push(await loadOnce(s, base, `load${i}`, { net, cpu }));
  const wrong = runs.find((r) => renderer && r.renderer !== renderer);
  if (wrong) throw new Error(`renderer is ${wrong.renderer}, expected ${renderer}`);
  const loadMs = max(runs.map((r) => r.loadMs));
  const lcpMs = max(runs.map((r) => r.lcpMs));
  const cls = max(runs.map((r) => r.cls));
  const transferKB = max(runs.map((r) => r.transferKB));
  if (cpu) {
    const problems = cls === null ? ["CLS not measured"] : cls > GATE.clsLoad ? [`cls.load ${round(cls, 3)} > ${GATE.clsLoad} (4x CPU)`] : [];
    return {
      pass: problems.length === 0,
      metrics: {
        "load.cpu4x.interactiveMs": round(loadMs, 0),
        "load.cpu4x.runs": runs.map((r) => round(r.loadMs, 0)),
        "perf.lcpMs.cpu4x": round(lcpMs, 0),
        "perf.cls.load.cpu4x": round(cls, 3),
        "perf.renderer": runs[0].renderer,
        cpu4x: true,
      },
      detail: problems.length ? problems.join("; ") : `9-band: cls.load<=${GATE.clsLoad} (4x CPU)`,
    };
  }
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

/**
 * One frame-pacing case: a practice run or a live match, normal or 4x CPU. FRAME_RUNS windows run on one page;
 * the worst of them is banded (rubric section 1 rule 8).
 */
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
  const runs = [];
  try {
    for (let i = 0; i < FRAME_RUNS; i++) runs.push(frameMetrics(await frameSample(page, FPS_MS), displayHz));
  } finally {
    await page.keyboard.up("ArrowRight").catch(() => undefined);
    if (cdp) await setCpu(cdp, 1).catch(() => undefined);
  }
  const file = await shot(page, path.join(outDir(), "evidence", `perf-${ctx.engine}`, `fps-${kind}-${renderer}${cpu ? "-cpu4x" : ""}.png`));
  const metrics = { ...worstOf(runs), kind, renderer, cpu4x: cpu, "perf.renderer": renderer };
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
    detail: problems.length
      ? problems.join("; ")
      : cpu
        ? `9-band: fps.median>=${GATE.fps4x} (4x), dropped<=${GATE.droppedPct}%, worst of ${FRAME_RUNS} runs`
        : `9-band: pctDisplay>=${GATE.fpsPctDisplay}, dropped<=${GATE.droppedPct}%, worst of ${FRAME_RUNS} runs`,
  };
}

/** Heap soak in a practice run (chromium CDP): regression slope over the whole window; end-minus-start between medians after warm-up. */
async function soakCase(s, base, { cpu }) {
  const h = await s.open("soak");
  // The soak needs no e2e pixel probe (its changes log grows with every frame); the game is checked by .offline.playing and the renderer.
  await startPractice(h, base, "webgpu", { pixels: false });
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
  // Retention, not JIT warm-up: baseline = median of SOAK_EDGE samples from the warm-up window on, end = median of the last SOAK_EDGE.
  const warmMs = Math.min(SOAK_WARM_MS, SOAK_MS / 5);
  const warmIdx = points.findIndex((p) => p.t * 1000 >= warmMs);
  const shortSoak = warmIdx < 0 || warmIdx + 2 * SOAK_EDGE > points.length;
  const baseMB = median(points.slice(warmIdx, warmIdx + SOAK_EDGE).map((p) => p.heapMB));
  const endMB = median(points.slice(-SOAK_EDGE).map((p) => p.heapMB));
  const endPct = ((endMB - baseMB) / baseMB) * 100;
  const last = points[points.length - 1];
  const metrics = {
    "perf.heapMB.start": round(baseMB, 2),
    "perf.heapMB.end": round(endMB, 2),
    "perf.heapMB.slope": round(perMin, 3),
    "perf.heapMB.endMinusStartPct": round(endPct, 1),
    "perf.heapMB.warmupS": round(warmMs / 1000, 0),
    "perf.nodes.end": last.nodes,
    "perf.listeners.end": last.listeners,
    cpu4x: cpu,
    samples: points.length,
    seconds: round(SOAK_MS / 1000, 0),
  };
  const problems = [];
  if (shortSoak) problems.push(`soak too short for a warm-up baseline and end samples (${points.length} samples)`);
  if (!Number.isFinite(perMin)) problems.push("slope not computable");
  else if (perMin > GATE.heapSlope) problems.push(`heap slope ${round(perMin, 3)} MB/min > ${GATE.heapSlope}`);
  if (!(endPct <= GATE.heapEndPct)) problems.push(`heap end-minus-start ${round(endPct, 1)}% > ${GATE.heapEndPct}%`);
  return {
    pass: problems.length === 0,
    metrics,
    detail: problems.length ? problems.join("; ") : `9-band: slope<=${GATE.heapSlope} MB/min, end-minus-start<=${GATE.heapEndPct}%`,
  };
}

/** Samples per UI action (rubric C26: n >= 20 per action per cell). */
const ACTION_N = Number(process.env.QA_ACTION_N ?? 20);
/** QA_SELF_TEST=action: busy time injected inside every trigger-to-confirmation window. */
const BUSY_MS = 2500;
const roomHeader = (page) => page.locator("h1.room-title");
const browseHeading = (page) => page.getByRole("heading", { name: "Browse rooms", exact: true });

/**
 * Trigger-to-confirmation time (ms, page clock). The click runs inside the page, so a busy main thread counts
 * toward the time; then the first visible confirmation is awaited and the page clock read again.
 */
async function timedClick(page, trigger, confirm) {
  const el = await trigger.elementHandle();
  const busy = selfTestMode() === "action" ? BUSY_MS : 0;
  const t0 = await el.evaluate((node, busy) => {
    const t = performance.now();
    if (busy) {
      const end = t + busy;
      while (performance.now() < end);
    }
    node.click();
    return t;
  }, busy);
  await confirm.first().waitFor({ state: "visible", timeout: 30000 });
  const t1 = await page.evaluate(() => performance.now());
  await el.dispose();
  return t1 - t0;
}

/** ui.actionMs.p95.<action> per action: p95 over ACTION_N samples, every run kept (rubric D12). */
function actionResult(samples, { cpu }) {
  const sfx = cpu ? ".cpu4x" : "";
  const metrics = { cpu4x: cpu };
  const problems = [];
  for (const [action, ms] of Object.entries(samples)) {
    const key = `ui.actionMs.p95.${action}${sfx}`;
    const p95 = percentile(ms, 95);
    metrics[key] = round(p95, 0);
    metrics[`${key}.n`] = ms.length;
    metrics[`${key}.runs`] = ms.map((v) => round(v, 0));
    if (ms.length < ACTION_N) problems.push(`${action} n=${ms.length} < ${ACTION_N}`);
    if (!(p95 < GATE.actionP95)) problems.push(`${key} ${round(p95, 0)} >= ${GATE.actionP95} ms`);
  }
  return {
    pass: problems.length === 0,
    metrics,
    detail: problems.length ? problems.join("; ") : `9-band: p95 < ${GATE.actionP95} ms (n=${ACTION_N} each)`,
  };
}

/** joinRoom and leave: a guest joins the host's open room from Browse and leaves it, ACTION_N times. */
async function roomActions(s, base, { cpu }) {
  const host = await s.open("host", { name: uniqueName("host") });
  const roomName = uniqueName("room");
  await createRoom(host, base, roomName, { isPublic: true });
  const { page } = await s.open("guest", { name: uniqueName("guest") });
  await page.goto(base);
  await menuName(page).waitFor();
  await button(page, "Browse rooms").click();
  const row = page.locator("button.room-row").filter({ hasText: roomName });
  if (cpu) await setCpu(await cdpOf(page), CPU_RATE);
  const join = [];
  const leave = [];
  for (let i = 0; i < ACTION_N; i++) {
    await row.waitFor({ state: "visible" });
    join.push(await timedClick(page, row, roomHeader(page)));
    leave.push(await timedClick(page, button(page, "Leave"), browseHeading(page)));
  }
  return actionResult({ joinRoom: join, leave }, { cpu });
}

/** start: a guest joins the host's room (a solo host starts at once, with no countdown), then the host starts and aborts the countdown ACTION_N times. */
async function startActions(s, base, { cpu }) {
  const host = await s.open("host", { name: uniqueName("host") });
  const roomName = uniqueName("room");
  await createRoom(host, base, roomName, { isPublic: true });
  const guestName = uniqueName("guest");
  const guest = (await s.open("guest", { name: guestName })).page;
  await guest.goto(base);
  await menuName(guest).waitFor();
  await button(guest, "Browse rooms").click();
  await guest.locator("button.room-row").filter({ hasText: roomName }).click();
  const { page } = host;
  await page.getByText(guestName, { exact: true }).first().waitFor();
  const start = button(page, "Start");
  const notice = page.locator(".room-starting");
  if (cpu) await setCpu(await cdpOf(page), CPU_RATE);
  const ms = [];
  for (let i = 0; i < ACTION_N; i++) {
    await start.waitFor({ state: "visible" });
    ms.push(await timedClick(page, start, notice));
    await button(page, "Abort start").click();
    await notice.waitFor({ state: "hidden" });
  }
  return actionResult({ start: ms }, { cpu });
}

/** createRoom: the host creates a room from Browse; the leave that follows is untimed (see roomActions). */
async function createActions(s, base, { cpu }) {
  const { page } = await s.open("host", { name: uniqueName("host") });
  await page.goto(base);
  await menuName(page).waitFor();
  await button(page, "Browse rooms").click();
  if (cpu) await setCpu(await cdpOf(page), CPU_RATE);
  const ms = [];
  for (let i = 0; i < ACTION_N; i++) {
    await button(page, "New room").click();
    await page.getByRole("heading", { name: "Create a room", exact: true }).waitFor();
    const roomName = uniqueName("room");
    await page.getByLabel("room name", { exact: true }).fill(roomName);
    ms.push(await timedClick(page, button(page, "Create room"), roomHeader(page).filter({ hasText: roomName })));
    await button(page, "Leave").click();
    await browseHeading(page).waitFor();
  }
  return actionResult({ createRoom: ms }, { cpu });
}

/** openSettings: Settings from the menu's more navigation opens its page; the menu is reloaded (untimed) between samples. */
async function settingsActions(s, base, { cpu }) {
  const { page } = await s.open("settings");
  if (cpu) await setCpu(await cdpOf(page), CPU_RATE);
  const nav = button(page.getByRole("navigation", { name: "more", exact: true }), "Settings");
  const heading = page.getByRole("heading", { name: "Settings", exact: true });
  const ms = [];
  for (let i = 0; i < ACTION_N; i++) {
    await page.goto(base);
    await menuName(page).waitFor();
    ms.push(await timedClick(page, nav, heading));
  }
  return actionResult({ openSettings: ms }, { cpu });
}

/** saveEditorMap: Save in the map editor (signed in) opens the save dialog; the dialog is cancelled (untimed), ACTION_N times. */
async function editorActions(s, base, { cpu }) {
  const h = await s.open("editor");
  await signUp(h, base, uniqueName("editor"));
  const { page } = h;
  await page.goto(base);
  await menuName(page).waitFor();
  await navTo(page, "Map editor");
  if (cpu) await setCpu(await cdpOf(page), CPU_RATE);
  const save = page.getByRole("button", { name: "Save", exact: true });
  const modal = page.locator(".modal");
  const ms = [];
  for (let i = 0; i < ACTION_N; i++) {
    ms.push(await timedClick(page, save, modal));
    await button(modal, "Cancel").click();
    await modal.waitFor({ state: "hidden" });
  }
  return actionResult({ saveEditorMap: ms }, { cpu });
}

const INP_KEYS = "abcdefghijklmno";

/** Keydown interactions in one control: Event Timing durations (ms), one per keypress, from a burst that starts now. */
async function keyInteractions(page, control) {
  await control.click();
  await page.evaluate(() => {
    window.__qaPerf.mark = performance.now();
  });
  for (const key of INP_KEYS) await page.keyboard.press(key);
  // Event Timing entries reach the observer asynchronously; give them a few frames.
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 300)));
  return page.evaluate(() => {
    const q = window.__qaPerf;
    if (!q.eventSupported) throw new Error("Event Timing (event observer) not supported");
    const worst = new Map();
    for (const e of q.events) if (e.start >= q.mark) worst.set(e.id, Math.max(e.dur, worst.get(e.id) ?? 0));
    return [...worst.values()];
  });
}

/**
 * perf.inp.ms: p75 over 30 keydown interactions, 15 in the menu name box and 15 in room chat. Interactions Event
 * Timing does not report (under the 16 ms threshold) count as 16 ms, so the p75 cannot be flattered.
 */
async function inpCase(s, base, { cpu }) {
  const host = await s.open("host", { name: uniqueName("host") });
  const roomName = uniqueName("room");
  await createRoom(host, base, roomName, { isPublic: true });
  const { page } = await s.open("guest", { name: uniqueName("guest") });
  await page.goto(base);
  await menuName(page).waitFor();
  if (cpu) await setCpu(await cdpOf(page), CPU_RATE);
  const menu = await keyInteractions(page, menuName(page));
  await button(page, "Browse rooms").click();
  await page.locator("button.room-row").filter({ hasText: roomName }).click();
  await roomHeader(page).waitFor();
  const chat = await keyInteractions(page, page.getByLabel("Chat message", { exact: true }));
  const reported = [...menu, ...chat];
  const missing = 2 * INP_KEYS.length - reported.length;
  const values = [...reported, ...Array(Math.max(0, missing)).fill(16)];
  const sfx = cpu ? ".cpu4x" : "";
  const p75 = percentile(values, 75);
  const pass = p75 <= GATE.inpMs;
  return {
    pass,
    metrics: {
      [`perf.inp.ms${sfx}`]: round(p75, 0),
      [`perf.inp.runs${sfx}`]: values.map((v) => round(v, 0)),
      [`perf.inp.missing${sfx}`]: missing,
      cpu4x: cpu,
    },
    detail: pass ? `9-band: p75 <= ${GATE.inpMs} ms over ${values.length} interactions` : `perf.inp.ms ${round(p75, 0)} > ${GATE.inpMs}`,
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

const naFor = (reason) => ({ info: true, detail: `N/A: ${reason}`, metrics: { "na.reason": reason } });
const naGpu = (ctx) => naFor(`WebGPU path unavailable: probe navigator.gpu=${ctx.gpu} on ${ctx.engine}`);
const naCdp = (ctx) => naFor(`CDP-only metric: probe found no CDPSession on ${ctx.engine}`);

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
  // 4x CPU cold load: CLS is banded on T3-T (rubric D12 table).
  await results.case(
    "load.cpu4x.webgpu",
    async (s) => {
      if (!ctx.cdp) return naCdp(ctx);
      if (!ctx.gpu) return naGpu(ctx);
      prepare(s, "webgpu");
      return loadCase(s, base, { renderer: "webgpu", gated: true, cpu: true });
    },
    { browser, base },
  );

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

  // UI latency and input latency (CDP cells, normal and 4x CPU): ui.actionMs.p95.<action> and perf.inp.ms.
  if (ctx.cdp) {
    for (const cpu of [false, true]) {
      const tag = cpu ? "t3t4x" : "t1m";
      const cases = {
        room: roomActions,
        start: startActions,
        createRoom: createActions,
        openSettings: settingsActions,
        saveEditorMap: editorActions,
        inp: inpCase,
      };
      for (const [name, fn] of Object.entries(cases)) {
        await results.case(
          `ui.${name}.${tag}`,
          async (s) => {
            prepare(s, "webgpu");
            return fn(s, base, { cpu });
          },
          { browser, base },
        );
      }
      await results.case(
        `ui.ready.${tag}`,
        async () => naFor("no ready action in the product: the room has no player ready toggle, start is host-only"),
        { browser, base },
      );
    }
  }

  results.save();
  await browser.close().catch(() => undefined);
}

writeIndex();
await runCleanups();
