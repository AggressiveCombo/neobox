// Temporal QA detectors: the escape classes (client/qa escape table E01-E12) that only show up in a
// time series or a frame sequence. Each detector is one case on a fresh Scenario and returns metrics
// keyed as in thresholds.json (keys with "runner": true). validateRecord decides the verdict.
//
// Detectors (escape id, threshold key):
//   E01 motion.jitter.count       replay view: camera direction reversals and jumps in the first second
//   E02 camera.static.drift.px    practice run, 10 s: camera drift in screen px while nothing moves
//   E03 motion.fullFlash.count    replay Close: one-frame full-screen flashes in a screenshot sequence
//   E05 font.pref.metricDelta     About page: readable-font pref changes text metrics (%)
//   E07 copy.claims.unsourced     copy claims with no source (no browser; copy-claims.mjs)
//   E08 transition.present        settings/training transitions that run an animation at 60 ms
//   E09 scroll.target.offset      settings nav: section lands at the scroll target (px)
//   E10 layout.navShift.px        news dialog Next and training Next move between pages (px)
// Not built here: E04 (HUD overlap), E06 (render order), E11 (promptedInput), E12 (editor.perf).
//
// Trace: an init script on each context records the camera (globalThis.__qaCam, camera.ts) per
// animation frame and a mark when the replay view appears. The trace is installed through s.open, so
// every state prepared by states.mjs gets it from its first navigation.
//
// Usage:  cd client && QA_OUT=<dir> node qa/temporal.mjs --dist <dist>   (QA_ENGINES narrows engines)

import path from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import { Results, QA_DIR, launchEngine, median, runCleanups, selectedEngines, sleep, startServer, writeIndex } from "./lib-qa.mjs";
import { stateById } from "./states.mjs";
import { runCopyClaims, loadRegister } from "./copy-claims.mjs";
import { validateRecord } from "./thresholds.mjs";

const KEYS = ["ArrowLeft", "ArrowRight", "ArrowUp", "KeyX", "KeyZ", "KeyC", "KeyV"];
const PREFS_KEY = "neobox.prefs"; // src/storage-keys.ts

/** Init script: per-frame camera trace and the replay-view mark. Runs in the page before any app code. */
const TRACE = () => {
  const trace = { frames: [], marks: {} };
  window.__qaTrace = trace;
  const frame = () => {
    const c = window.__qaCam;
    if (c && c.w > 0 && trace.frames.length < 6000) trace.frames.push({ t: performance.now(), cx: c.cx, cy: c.cy, w: c.w, h: c.h });
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  const watch = () => {
    if (trace.marks.replay === undefined && document.querySelector(".offline.playing.replay-view")) trace.marks.replay = performance.now();
  };
  new MutationObserver(watch).observe(document, { subtree: true, childList: true, attributes: true });
};

/** Makes every page this scenario opens carry the trace. states.mjs prepares call s.open, so the wrap reaches them. */
function traced(s) {
  const open = s.open.bind(s);
  s.open = async (label, opts) => {
    const h = await open(label, opts);
    await h.context.addInitScript(TRACE);
    return h;
  };
  return s;
}

/**
 * Camera direction reversals and jumps in [from, to]. A step is a frame-to-frame change of cx above
 * 0.1% of the view width. A reversal flips the sign of the last moving step. A jump is a step above
 * 4x the median moving step.
 */
export function cameraJitter(frames, from, to) {
  const win = frames.filter((f) => f.t >= from && f.t <= to);
  if (win.length < 3) return { count: 0, reversals: 0, jumps: 0, n: win.length };
  const eps = 0.001 * (win[0].w || 1);
  const steps = [];
  for (let i = 1; i < win.length; i++) steps.push(win[i].cx - win[i - 1].cx);
  const moving = steps.map((d) => Math.abs(d)).filter((m) => m > eps);
  const med = moving.length ? median(moving) : 0;
  let reversals = 0;
  let jumps = 0;
  let last = 0;
  for (const d of steps) {
    if (Math.abs(d) <= eps) continue;
    const sign = Math.sign(d);
    if (last && sign !== last) reversals++;
    if (Math.abs(d) > 4 * med) jumps++;
    last = sign;
  }
  return { count: reversals + jumps, reversals, jumps, n: win.length };
}

/** Fraction of sampled pixels whose channel-sum delta is above 24 (image.mjs differingPixels rule). */
function diffFrac(A, B) {
  if (A.width !== B.width || A.height !== B.height) return 1;
  let changed = 0;
  let total = 0;
  for (let p = 0; p < A.data.length; p += 16) {
    const d = Math.abs(A.data[p] - B.data[p]) + Math.abs(A.data[p + 1] - B.data[p + 1]) + Math.abs(A.data[p + 2] - B.data[p + 2]);
    total++;
    if (d > 24) changed++;
  }
  return changed / total;
}

/** One-frame flashes: frame i differs from both neighbours while the neighbours match each other. */
export function countFlashes(buffers) {
  const imgs = buffers.map((b) => PNG.sync.read(b));
  let n = 0;
  for (let i = 1; i + 1 < imgs.length; i++) {
    if (diffFrac(imgs[i - 1], imgs[i]) > 0.4 && diffFrac(imgs[i], imgs[i + 1]) > 0.4 && diffFrac(imgs[i - 1], imgs[i + 1]) < 0.1) n++;
  }
  return n;
}

/** Screenshots before and during a trigger: the first is the reference frame, then `n` samples `gap` ms apart. */
async function burst(page, trigger, n, gap) {
  const shots = [await page.screenshot({ type: "png" })];
  const clicking = trigger();
  for (let i = 0; i < n; i++) {
    shots.push(await page.screenshot({ type: "png" }));
    await sleep(gap);
  }
  await clicking;
  return shots;
}

async function jitterReplay(s) {
  const h = await stateById("replay-loaded").prepare(traced(s));
  await sleep(1500);
  const tr = await h.page.evaluate(() => window.__qaTrace);
  const mark = tr?.marks?.replay;
  if (mark === undefined) return { pass: false, detail: "no replay mark" };
  const j = cameraJitter(tr.frames, mark, mark + 1000);
  return { metrics: { "motion.jitter.count": j.count }, detail: `reversals=${j.reversals} jumps=${j.jumps} frames=${j.n}` };
}

async function fullFlash(s) {
  const h = await stateById("replay-loaded").prepare(traced(s));
  await sleep(800);
  const close = h.page.locator(".offline-top").getByRole("button", { name: "Close" }).first();
  const shots = await burst(h.page, () => close.click(), 10, 40);
  return { metrics: { "motion.fullFlash.count": countFlashes(shots) }, detail: `frames=${shots.length}` };
}

async function cameraDrift(s) {
  const h = await stateById("practice-running").prepare(traced(s));
  await sleep(10000);
  const tr = await h.page.evaluate(() => ({ frames: window.__qaTrace.frames, css: document.querySelector("canvas")?.getBoundingClientRect().width ?? 0 }));
  const f = tr.frames;
  if (f.length < 2) return { pass: false, detail: "no camera frames" };
  const scale = tr.css / (f[0].w || 1); // css px per world unit
  let units = 0;
  for (const x of f) units = Math.max(units, Math.abs(x.cx - f[0].cx), Math.abs(x.cy - f[0].cy));
  const px = Number((units * scale).toFixed(2));
  return { metrics: { "camera.static.drift.px": px }, detail: `frames=${f.length} units=${units.toFixed(2)} scale=${scale.toFixed(3)}` };
}

async function fontPref(s) {
  const h = await stateById("about").prepare(traced(s));
  const page = h.page;
  const measure = () =>
    page.evaluate(() => {
      const ps = [...document.querySelectorAll("p")].filter((p) => p.offsetParent !== null && p.textContent.trim());
      const height = ps.reduce((a, p) => a + p.getBoundingClientRect().height, 0);
      let xh = 0;
      if (ps[0]) {
        const c = document.createElement("canvas").getContext("2d");
        c.font = getComputedStyle(ps[0]).font;
        xh = c.measureText("x").actualBoundingBoxAscent;
      }
      return { height, xh, n: ps.length };
    });
  const setPrefs = (extra) =>
    page.evaluate(
      ({ key, extra }) => {
        const prev = JSON.parse(localStorage.getItem(key) ?? "{}");
        localStorage.setItem(key, JSON.stringify({ ...prev, ...extra }));
      },
      { key: PREFS_KEY, extra },
    );
  await setPrefs({ textScale: 1, readableFont: false });
  await page.reload();
  await sleep(400);
  const a = await measure();
  await setPrefs({ readableFont: true });
  await page.reload();
  await sleep(400);
  const b = await measure();
  if (!a.n || !a.xh) return { pass: false, detail: "no paragraphs measured" };
  const r = b.height / a.height;
  const xr = b.xh / a.xh;
  const delta = Number((Math.max(Math.abs(r - 1), Math.abs(xr - 1)) * 100).toFixed(2));
  return { metrics: { "font.pref.metricDelta": delta }, detail: `height ${a.height.toFixed(1)}->${b.height.toFixed(1)} xh ${a.xh}->${b.xh}` };
}

/** Probe: click nav item `idx` and count running animations (120-400 ms) 60 ms later. */
const transitionProbe = (page, sel, idx) =>
  page.evaluate(
    async ({ sel, idx }) => {
      const el = document.querySelectorAll(sel)[idx];
      if (!el) return -1;
      el.click();
      await new Promise((r) => setTimeout(r, 60));
      return document.getAnimations().filter((a) => {
        const d = a.effect?.getComputedTiming().duration;
        return a.playState === "running" && typeof d === "number" && d >= 120 && d <= 400;
      }).length;
    },
    { sel, idx },
  );

async function transitionPresent(s) {
  const st = await stateById("settings").prepare(traced(s));
  const probes = [await transitionProbe(st.page, ".settings-nav-item", 1), await transitionProbe(st.page, ".settings-nav-item", 2)];
  const tr = await stateById("training").prepare(traced(s));
  probes.push(await transitionProbe(tr.page, ".training-next", 0));
  const present = probes.filter((n) => n > 0).length;
  return { metrics: { "transition.present": present }, detail: `probes=${probes.join(",")}` };
}

async function scrollTarget(s) {
  const h = await stateById("settings").prepare(traced(s));
  const page = h.page;
  const items = await page.locator(".settings-nav-item").count();
  let worst = 0;
  const rows = [];
  for (let i = 0; i < items; i++) {
    await page.locator(".settings-nav-item").nth(i).click();
    await sleep(400);
    const off = await page.evaluate((i) => {
      const sec = document.querySelectorAll("section.settings-section")[i];
      if (!sec) return null;
      let sc = sec.parentElement;
      while (sc && !["auto", "scroll"].includes(getComputedStyle(sc).overflowY)) sc = sc.parentElement;
      if (!sc) return null;
      if (i === 0) return sc.scrollTop; // first section: the scroller must be at the top
      if (sc.scrollTop >= sc.scrollHeight - sc.clientHeight - 1) return 0; // clamped at the bottom: target not reachable
      const actual = sec.getBoundingClientRect().top - sc.getBoundingClientRect().top;
      const pad = parseFloat(getComputedStyle(sc).scrollPaddingTop) || 0;
      const margin = parseFloat(getComputedStyle(sec).scrollMarginTop) || 0;
      return Math.abs(actual - pad - margin);
    }, i);
    if (off === null) continue;
    rows.push(Number(off.toFixed(1)));
    worst = Math.max(worst, off);
  }
  return { metrics: { "scroll.target.offset": Number(worst.toFixed(1)) }, detail: `offsets=${rows.join(",")}` };
}

async function navShift(s) {
  const news = await stateById("menu-news").prepare(traced(s));
  const next = news.page.getByRole("button", { name: "Next" }).first();
  const newsPos = [];
  for (let i = 0; i < 6; i++) {
    const b = await next.boundingBox();
    if (!b) break;
    newsPos.push([b.x, b.y]);
    if (await next.isDisabled()) break;
    await next.click({ timeout: 1500 }).catch(() => {});
    await sleep(250);
  }
  const tr = await stateById("training").prepare(traced(s));
  const tNext = tr.page.locator(".training-next").first();
  const trPos = [];
  for (let i = 0; i < 7; i++) {
    const b = await tNext.boundingBox();
    if (!b) break;
    trPos.push([b.x, b.y]);
    for (const k of KEYS) await tr.page.keyboard.press(k);
    await tNext.click({ timeout: 1500 }).catch(() => {});
    await sleep(300);
  }
  const shift = (pos) => (pos.length ? Math.max(...pos.map(([x, y]) => Math.abs(x - pos[0][0]) + Math.abs(y - pos[0][1]))) : 0);
  const px = Number(Math.max(shift(newsPos), shift(trPos)).toFixed(1));
  return { metrics: { "layout.navShift.px": px }, detail: `news=${newsPos.length} training=${trPos.length}` };
}

/** Copy claims need no browser: the source strings and the register decide. */
async function copyClaims(ctx) {
  const register = loadRegister(path.join(QA_DIR, "copy-claims.json"));
  const res = runCopyClaims({ srcDir: ctx.src ? path.resolve(ctx.src) : undefined, register });
  return { metrics: res.metrics, detail: res.failures.slice(0, 5).join(" | ") || undefined };
}

/** E-id, threshold key, the detector. `browser: false` runs without a browser. */
export const DETECTORS = [
  { escape: "E01", key: "motion.jitter.count", run: jitterReplay },
  { escape: "E02", key: "camera.static.drift.px", run: cameraDrift },
  { escape: "E03", key: "motion.fullFlash.count", run: fullFlash },
  { escape: "E05", key: "font.pref.metricDelta", run: fontPref },
  { escape: "E07", key: "copy.claims.unsourced", run: copyClaims, browser: false },
  { escape: "E08", key: "transition.present", run: transitionPresent },
  { escape: "E09", key: "scroll.target.offset", run: scrollTarget },
  { escape: "E10", key: "layout.navShift.px", run: navShift },
];

/**
 * Runs one detector. Returns { id, verdict, metrics, detail }. ctx: { base, src? }.
 * `browser` and `results` are needed for browser detectors (Results.case gives each case its own scenario).
 */
export async function runOne(det, { browser, base, results, src } = {}) {
  const ctx = { base, src };
  const judge = (out) => {
    const metrics = out?.metrics ?? {};
    const failures = validateRecord({ metrics, fit: false });
    if (metrics[det.key] === undefined) failures.push("no metric");
    return { metrics, failures, detail: [out?.detail, ...failures].filter(Boolean).join("; ") || undefined };
  };
  if (det.browser === false) {
    const out = await det.run(ctx);
    const j = judge(out);
    return { id: `${det.escape}-${det.key}`, verdict: j.failures.length ? "fail" : "pass", metrics: j.metrics, detail: j.detail };
  }
  const id = `${det.escape}-${det.key}`;
  const rec = await results.case(id, async (s) => {
    const out = (await det.run(s, ctx)) ?? {};
    const j = judge(out);
    return { pass: out.pass !== false && j.failures.length === 0, metrics: j.metrics, detail: j.detail };
  }, { browser, base });
  return rec;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const argv = process.argv.slice(2);
  let src;
  for (let i = 0; i < argv.length; i++) if (argv[i] === "--src") src = argv[++i];
  for (const engine of selectedEngines()) {
    const browser = await launchEngine(engine);
    const results = new Results("temporal", engine);
    const srv = await startServer();
    for (const det of DETECTORS) {
      const rec = await runOne(det, { browser, base: srv.base, results, src });
      console.log(`${rec.verdict.toUpperCase()} ${rec.id} ${det.key}=${rec.metrics?.[det.key] ?? "n/a"}${rec.detail ? ` (${rec.detail})` : ""}`);
    }
    await srv.stop();
    results.save();
  }
  writeIndex();
  await runCleanups();
}
