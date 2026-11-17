// Shared helpers for the QA instruments (perf.mjs, robust.mjs, input.mjs): per-engine
// browser launch, network profiles, console/network capture, CDP helpers, result records,
// and the JSON/markdown writers. Server lifecycle and UI helpers come from client/e2e/lib.mjs.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const QA_DIR = path.dirname(fileURLToPath(import.meta.url));

// The shared test build (QA-PLAN.md). e2e/lib.mjs reads NEOBOX_DIST when it loads, so the
// default is set before its (top-level awaited) import.
process.env.NEOBOX_DIST ??= "C:/Users/aggressivecombo/neobox-scratch/dist-main";
const lib = await import("../e2e/lib.mjs");
export const {
  DESKTOP,
  PHONE,
  Scenario,
  button,
  builtinMaps,
  createRoom,
  dismissPhoneSplash,
  ensureProbe,
  freePort,
  matchWithGuest,
  menuName,
  navTo,
  onCleanup,
  probeChanges,
  resolveChromium,
  roomCode,
  roomTitle,
  runCleanups,
  sleep,
  startMatch,
  startServer,
  uniqueName,
  waitForPixels,
  adminRoom,
  signUp,
  PASSWORD,
  nextClientIp,
  joinByInvite,
  DIST_DIR,
  launchEngine,
  muteAudio,
} = lib;

export const ENGINES = ["chromium", "firefox", "webkit"];

/**
 * Console errors a browser reports for a benign page navigation. Firefox logs the app's WebSocket as
 * "interrupted while the page was loading" when a case leaves the page; it is not a page error. Narrow on
 * purpose: the message must match exactly, and service worker errors are not listed here.
 */
const ENGINE_NOISE = { firefox: [/The connection to ws:\/\/\S+ was interrupted while the page was loading\./] };

/** True when a console error is known benign noise for this engine. */
export function engineNoise(engine, text) {
  return (ENGINE_NOISE[engine] ?? []).some((re) => re.test(text));
}

/**
 * Opens the practice mode from the menu, starts a run and checks the renderer path. Returns the renderer.
 * `pixels: false` skips the canvas colour wait, which installs the e2e pixel probe (its change log grows per frame).
 */
export async function startPractice(h, base, renderer, { timeout = 15000, pixels = true } = {}) {
  await h.page.goto(base);
  await menuName(h.page).waitFor({ timeout });
  await navTo(h.page, "Practice");
  await h.page.locator(".offline-list .offline-choice").first().click({ timeout });
  await button(h.page, "Start").click({ timeout });
  await h.page.locator(".offline.playing").waitFor({ timeout });
  if (pixels) await waitForPixels(h, "practice", 3, timeout * 2);
  // The renderer is created asynchronously (app.ts ensureRenderer); the attribute is set once it is ready.
  if (renderer !== null) await h.page.waitForFunction(() => !!document.documentElement.dataset.renderer, null, { timeout: timeout * 2 });
  const got = await h.page.evaluate(() => document.documentElement.dataset.renderer ?? null);
  if (renderer !== null && got !== renderer) throw new Error(`renderer is ${got}, expected ${renderer}`);
  return got;
}

/** Output directory for every instrument (QA_OUT overrides). */
export function outDir() {
  const dir = process.env.QA_OUT ?? "C:/Users/aggressivecombo/neobox-scratch/qa/round0-perf";
  mkdirSync(path.join(dir, "evidence"), { recursive: true });
  return dir;
}

/** Engines to run: QA_ENGINES (comma list) or all three. */
export function selectedEngines() {
  const want = (process.env.QA_ENGINES ?? "chromium,firefox,webkit").split(",").map((s) => s.trim());
  return ENGINES.filter((e) => want.includes(e));
}

/** Self-test mode: QA_SELF_TEST=<mode> injects a known defect; a working instrument must fail on it. */
export function selfTestMode() {
  return process.env.QA_SELF_TEST ?? null;
}

// Browser launch and per-context audio muting come from e2e/lib.mjs (launchEngine, muteAudio):
// every instrument context must go through muteAudio(context). See that file for the mute switches.

/** Chrome DevTools presets: RTT ms, bytes per second. */
export const NET_PROFILES = {
  none: null,
  fast3g: { latency: 562.5, downloadThroughput: (1638.4 * 1024) / 8, uploadThroughput: (768 * 1024) / 8 },
  slow3g: { latency: 2000, downloadThroughput: (500 * 1024) / 8, uploadThroughput: (500 * 1024) / 8 },
};

/** CDP session for a page (chromium only). */
export async function cdpOf(page) {
  return page.context().newCDPSession(page);
}

export async function setNetwork(cdp, profile) {
  const p = NET_PROFILES[profile];
  if (!p) {
    await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    return;
  }
  await cdp.send("Network.emulateNetworkConditions", { offline: false, ...p });
}

export async function setCpu(cdp, rate) {
  await cdp.send("Emulation.setCPUThrottlingRate", { rate });
}

/** Heap, DOM node and listener counts from CDP Performance.getMetrics, after a GC. */
export async function heapSample(cdp) {
  await cdp.send("Performance.enable").catch(() => undefined);
  await cdp.send("HeapProfiler.collectGarbage").catch(() => undefined);
  const { metrics } = await cdp.send("Performance.getMetrics");
  const get = (name) => metrics.find((m) => m.name === name)?.value ?? NaN;
  return {
    heapMB: get("JSHeapUsedSize") / 1048576,
    nodes: get("Nodes"),
    listeners: get("JSEventListeners"),
  };
}

/** Least-squares slope of y over x (y per x unit). NaN when fewer than 2 points. */
export function slope(points) {
  if (points.length < 2) return NaN;
  const n = points.length;
  const mx = points.reduce((a, p) => a + p.x, 0) / n;
  const my = points.reduce((a, p) => a + p.y, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of points) {
    num += (p.x - mx) * (p.y - my);
    den += (p.x - mx) ** 2;
  }
  return den === 0 ? NaN : num / den;
}

export function percentile(values, q) {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((q / 100) * sorted.length) - 1));
  return sorted[idx];
}

export const median = (values) => percentile(values, 50);

/** Matches a media file URL: a navigation can cancel these loads, which is not a failure. */
const MEDIA_URL = /\.(mp3|ogg|wav|m4a|webm)(\?|$)/i;
const ABORT_ERRORS = new Set(["net::ERR_ABORTED", "NS_BINDING_ABORTED"]);

/**
 * Network/console capture for a page; `expected(url)` marks deliberate failures. A media request
 * cancelled by ERR_ABORTED is counted in netAborted (metric net.abortedMedia), not failed.
 */
export function watchPage(handle, { expected = () => false } = {}) {
  const page = handle.page;
  handle.warnings = [];
  handle.netFailed = [];
  handle.netExpected = [];
  handle.netAborted = [];
  handle.netAbortedOther = [];
  page.on("console", (msg) => {
    if (msg.type() === "warning") handle.warnings.push(`${handle.label}: ${msg.text()}`);
  });
  page.on("requestfailed", (req) => {
    const err = req.failure()?.errorText ?? "";
    // Chromium reports a cancelled request as net::ERR_ABORTED, Firefox as NS_BINDING_ABORTED.
    if (ABORT_ERRORS.has(err)) {
      (MEDIA_URL.test(req.url()) ? handle.netAborted : handle.netAbortedOther).push(req.url());
      return;
    }
    const entry = `${req.method()} ${req.url()} ${err}`.trim();
    (expected(req.url()) ? handle.netExpected : handle.netFailed).push(`${handle.label}: ${entry}`);
  });
  page.on("response", (res) => {
    if (res.status() < 400) return;
    const entry = `${res.status()} ${res.request().method()} ${res.url()}`;
    (expected(res.url()) ? handle.netExpected : handle.netFailed).push(`${handle.label}: ${entry}`);
  });
}

/** Injects a page script before any page code runs (every navigation in the context). */
export async function initScript(context, fn, arg) {
  await context.addInitScript(fn, arg);
}

/** Screenshot of one page into the evidence folder. Returns the path (or null when the page is gone). */
export async function shot(page, file) {
  mkdirSync(path.dirname(file), { recursive: true });
  try {
    await page.screenshot({ path: file, timeout: 8000 });
    return file;
  } catch {
    return null;
  }
}

/** Rewrites a result file with relative evidence paths from `outDir`. */
export function rel(file) {
  return file ? path.relative(outDir(), file).replaceAll("\\", "/") : null;
}

/**
 * One instrument run for one engine. Each case gets a fresh server and browser
 * context (see Scenario), its problems are collected, and its outcome is recorded.
 */
export class Results {
  constructor(instrument, engine) {
    this.instrument = instrument;
    this.engine = engine;
    this.selfTest = selfTestMode();
    this.started = new Date().toISOString();
    this.cases = [];
    this.evidenceDir = path.join(outDir(), "evidence", `${instrument}-${engine}`);
    mkdirSync(this.evidenceDir, { recursive: true });
  }

  /**
   * Runs `fn(scenario)` as one case. `fn` returns { pass?, detail?, metrics?, evidence? }; pass
   * defaults to true. Any thrown error, or any unexpected console error / page error, fails it.
   * Failed cases get screenshots of every open page. `info: true` (or `out.info === true`) records numbers without a verdict.
   */
  async case(id, fn, { browser, base, info = false, ignore = [], label = id } = {}) {
    const t0 = Date.now();
    const s = new Scenario(label, { base, browser });
    let out = {};
    let error = null;
    try {
      out = (await fn(s)) ?? {};
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    const unignored = s.problems().filter((p) => !ignore.some((re) => re.test(p)));
    const exempt = unignored.filter((p) => engineNoise(this.engine, p));
    const problems = unignored.filter((p) => !engineNoise(this.engine, p));
    const warnings = s.handles.flatMap((h) => h.warnings ?? []);
    const netFailed = s.handles.flatMap((h) => h.netFailed ?? []);
    const netAborted = s.handles.flatMap((h) => h.netAborted ?? []);
    const netAbortedOther = s.handles.flatMap((h) => h.netAbortedOther ?? []);
    const netExpected = s.handles.flatMap((h) => h.netExpected ?? []);
    const pass = !error && problems.length === 0 && netFailed.length === 0 && (out.pass ?? true);
    const isInfo = info || out.info === true;
    const evidence = [...(out.evidence ?? [])];
    if (!pass) {
      for (const h of s.handles) {
        const file = path.join(this.evidenceDir, `${id}-${h.label}.png`.replaceAll(/[^\w.\-]+/g, "_"));
        const saved = await shot(h.page, file).catch(() => null);
        if (saved) evidence.push(rel(saved));
      }
    }
    const rec = {
      id,
      verdict: isInfo ? "info" : pass ? "pass" : "fail",
      detail: [error, out.detail].filter(Boolean).join("; ") || undefined,
      metrics: { ...out.metrics, "net.abortedMedia": netAborted.length, "net.abortedOther": netAbortedOther.length },
      problems: problems.length ? problems : undefined,
      warnings: warnings.length ? warnings.slice(0, 20) : undefined,
      netFailed: netFailed.length ? netFailed : undefined,
      netExpected: netExpected.length ? netExpected : undefined,
      exempt: exempt.length ? exempt : undefined,
      evidence: evidence.length ? evidence : undefined,
      seconds: Number(((Date.now() - t0) / 1000).toFixed(1)),
    };
    this.cases.push(rec);
    const tag = rec.verdict === "info" ? "info" : pass ? "PASS" : "FAIL";
    console.log(`${tag} ${this.instrument}/${this.engine}/${id} (${rec.seconds}s)${rec.detail ? `: ${rec.detail}` : ""}`);
    return rec;
  }

  /** Writes <instrument>-<engine>.json and .md into the output directory. */
  save() {
    const dir = outDir();
    const base = path.join(dir, `${this.instrument}-${this.engine}`);
    const summary = {
      instrument: this.instrument,
      engine: this.engine,
      selfTest: this.selfTest,
      started: this.started,
      finished: new Date().toISOString(),
      cases: this.cases,
    };
    writeFileSync(`${base}.json`, `${JSON.stringify(summary, null, 2)}\n`);
    writeFileSync(`${base}.md`, `${markdownFor(summary)}\n`);
    return `${base}.json`;
  }
}

function markdownFor(sum) {
  const lines = [];
  lines.push(`# ${sum.instrument} on ${sum.engine}${sum.selfTest ? ` (self-test: ${sum.selfTest})` : ""}`);
  lines.push("");
  lines.push(`Started ${sum.started}, finished ${sum.finished}.`);
  lines.push("");
  lines.push("| case | verdict | detail | evidence |");
  lines.push("| --- | --- | --- | --- |");
  for (const c of sum.cases) {
    const detail = [c.detail, c.problems?.join(" | "), c.netFailed?.join(" | "), c.exempt && `exempt: ${c.exempt.join(" | ")}`].filter(Boolean).join(" ").replaceAll("|", "\\|");
    const ev = (c.evidence ?? []).join(", ");
    lines.push(`| ${c.id} | ${c.verdict} | ${detail} | ${ev} |`);
  }
  const metricCases = sum.cases.filter((c) => c.metrics);
  if (metricCases.length) {
    lines.push("");
    lines.push("## Metrics");
    for (const c of metricCases) {
      lines.push("");
      lines.push(`### ${c.id}`);
      lines.push("```json");
      lines.push(JSON.stringify(c.metrics, null, 2));
      lines.push("```");
    }
  }
  return lines.join("\n");
}

/**
 * Builds SUMMARY.md and summary.json from every <instrument>-<engine>.json in the output directory.
 * Verdicts count pass/fail/info; a self-test run counts as "detected" when it has at least one fail.
 */
export function writeIndex() {
  const dir = outDir();
  const files = readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "summary.json");
  const runs = files.map((f) => JSON.parse(readFileSync(path.join(dir, f), "utf8")));
  const rows = [];
  let fails = 0;
  for (const run of runs) {
    for (const c of run.cases) {
      if (c.verdict === "fail") fails++;
      rows.push({ instrument: run.instrument, engine: run.engine, selfTest: run.selfTest, ...c });
    }
  }
  writeFileSync(path.join(dir, "summary.json"), `${JSON.stringify({ runs: runs.length, fails, rows }, null, 2)}\n`);
  const lines = ["# QA round 0 summary (perf, robust, input)", "", `${runs.length} runs, ${rows.length} cases, ${fails} failing.`, ""];
  lines.push("| instrument | engine | self-test | case | verdict | detail |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const r of rows) {
    const detail = (r.detail ?? "").replaceAll("|", "\\|");
    lines.push(`| ${r.instrument} | ${r.engine} | ${r.selfTest ?? ""} | ${r.id} | ${r.verdict} | ${detail} |`);
  }
  writeFileSync(path.join(dir, "SUMMARY.md"), `${lines.join("\n")}\n`);
  return path.join(dir, "SUMMARY.md");
}

export function exists(file) {
  return existsSync(file);
}

export { DIST_DIR as DIST };
