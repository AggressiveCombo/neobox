// Temporal QA detectors: the escape classes (client/qa escape table E01-E12) that only show up in a
// time series or a frame sequence. Each detector is one case on a fresh Scenario and returns metrics
// keyed as in thresholds.json (keys with "runner": true). validateRecord decides the verdict.
//
// Detectors (escape id, threshold key):
//   E01 motion.jitter.count       menu clip start and replay start: camera reversals/jumps and tick jumps in the first second
//   E02 camera.static.drift.px    practice run, 10 s: camera drift in screen px while nothing moves
//   E03 motion.fullFlash.count    replay Close: unmasked, game-less runs of the GL view that last <= 150 ms (rAF sampler)
//   E04 overlay.hud.overlap       replay and practice: opaque panels drawn over the game arena (count);
//                                  overlay.void.px: how far the view reaches past the arena (px)
//   E05 font.pref.metricDelta     About page: readable-font pref changes text metrics (%)
//   E07 copy.claims.unsourced     copy claims with no source (no browser; copy-claims.mjs)
//   E08 transition.present        settings sections and training Next: share of changes that animate (rAF sampler, ratio)
//   E09 scroll.target.offset      settings nav: section lands at the scroll target (px)
//   E10 layout.navShift.px        news dialog Next and training Next move between pages (px)
//                                  layout.toastShift.px: controls move when a toast appears (px)
//   E11 interaction.promptedInput.reacts  training: share of prompts whose named key lights its .key within 150 ms
//   E12 editor.perf.dragP95ms     editor: p95 rAF interval while a shape is dragged (ms), 1x CPU
//                                  editor.perf.drag4xP95ms: the same drag at 4x CPU on the stress map
//   E06 overlay.marker.underLabel: frames where a name label is drawn over the followed player's marker (__qaDraw)
//
// Trace: an init script on each context records the camera (globalThis.__qaCam, camera.ts) and the
// engine tick (globalThis.__qaTick, game.ts) per animation frame, and marks when the replay view or the
// menu clip starts. The trace is installed through s.open, so every state prepared by states.mjs gets it.
//
// Usage:  cd client && QA_OUT=<dir> node qa/temporal.mjs --dist <dist>   (QA_ENGINES narrows engines)

import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Results, QA_DIR, launchEngine, median, navTo, percentile, runCleanups, selectedEngines, sleep, startServer, writeIndex } from "./lib-qa.mjs";
import { stateById } from "./states.mjs";
import { runCopyClaims, loadRegister } from "./copy-claims.mjs";
import { validateRecord } from "./thresholds.mjs";

const KEYS = ["ArrowLeft", "ArrowRight", "ArrowUp", "KeyX", "KeyZ", "KeyC", "KeyV"];
const PREFS_KEY = "neobox.prefs"; // src/storage-keys.ts
/** First default key per action (prefs.ts DEFAULT_KEYS). */
const FIRST_KEY = { left: "ArrowLeft", right: "ArrowRight", up: "ArrowUp", down: "ArrowDown", push: "KeyX", rocket: "KeyZ", bat: "KeyC", grab: "KeyV" };
/** Stress map (1500 bodies) for the 4x-CPU editor drag; QA_STRESS_MAP overrides the path. */
const STRESS_MAP = process.env.QA_STRESS_MAP ?? path.resolve(QA_DIR, "../../../neobox-scratch/editor-perf/stress.json");

/** Init script: per-frame camera and tick trace, and the marks for the replay view and the menu clip. */
const TRACE = () => {
  const trace = { frames: [], clip: [], draw: [], marks: {} };
  window.__qaTrace = trace;
  let lastDraw = null;
  const frame = () => {
    const c = window.__qaCam;
    const tick = window.__qaTick ? window.__qaTick.tick : -1;
    const cam = c && c.w > 0;
    const t = performance.now();
    if ((cam || tick >= 0) && trace.frames.length < 6000) {
      trace.frames.push({ t, cx: cam ? c.cx : undefined, cy: cam ? c.cy : undefined, w: cam ? c.w : undefined, h: cam ? c.h : undefined, aw: cam ? c.aw : undefined, ah: cam ? c.ah : undefined, tick });
    }
    const k = window.__qaClip;
    if (k && k.tick >= 0 && trace.clip.length < 6000) trace.clip.push({ t, tick: k.tick, dtMs: k.dtMs });
    const d = window.__qaDraw;
    if (d && d !== lastDraw && trace.draw.length < 6000) {
      lastDraw = d;
      trace.draw.push({ t, tick: d.tick, rects: d.rects });
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  const watch = () => {
    if (trace.marks.replay === undefined && document.querySelector(".offline.playing.replay-view")) trace.marks.replay = performance.now();
    if (trace.marks.clip === undefined && document.querySelector(".menu-square.is-live")) trace.marks.clip = performance.now();
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
 * 0.1% of the view width. A reversal flips the sign of the last step above 0.5% of the view width (a
 * visible wobble; smaller flips depend on frame timing). A jump is a step above 4x the median moving step.
 */
export function cameraJitter(frames, from, to) {
  const win = frames.filter((f) => f.w > 0 && f.t >= from && f.t <= to);
  if (win.length < 3) return { count: 0, reversals: 0, jumps: 0, n: win.length };
  const eps = 0.001 * (win[0].w || 1);
  const rev = 0.005 * (win[0].w || 1);
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
    if (last && sign !== last && Math.abs(d) > rev) reversals++;
    if (Math.abs(d) > 4 * med) jumps++;
    last = sign;
  }
  return { count: reversals + jumps, reversals, jumps, n: win.length };
}

/**
 * Engine tick jumps in [from, to]: a frame that advances the tick by more than max(3, 4x the median
 * positive step). A long frame step (a stalled frame advanced by the full time gap) shows as a jump.
 */
export function tickJumps(frames, from, to) {
  const win = frames.filter((f) => f.tick >= 0 && f.t >= from && f.t <= to);
  const steps = [];
  for (let i = 1; i < win.length; i++) steps.push(win[i].tick - win[i - 1].tick);
  const pos = steps.filter((d) => d > 0);
  if (!pos.length) return 0;
  const limit = Math.max(3, 4 * median(pos));
  return steps.filter((d) => d > limit).length;
}

/**
 * Lit runs of the GL view: a sample is lit when the view is shown, unmasked, and no game screen is on.
 * A flash is a lit run that ends (a masked or game sample follows) within 150 ms.
 */
export function litFlashes(samples) {
  const runs = [];
  let start = null;
  for (let i = 0; i < samples.length; i++) {
    if (samples[i].lit && start === null) start = samples[i].t;
    if (!samples[i].lit && start !== null) {
      runs.push(samples[i].t - start);
      start = null;
    }
  }
  return { flashes: runs.filter((d) => d <= 150).length, runs: runs.map((d) => Math.round(d)) };
}

/** Page side of E03: samples the GL view every frame for `ms`, starting when called. */
const sampleGl = (ms) =>
  new Promise((resolve) => {
    const gl = document.getElementById("gl-host");
    const t0 = performance.now();
    const out = [];
    const step = () => {
      const t = performance.now();
      const shown = Boolean(gl) && gl.style.visibility !== "hidden";
      const clip = gl ? gl.style.clipPath : "";
      const unmasked = !clip || clip === "none";
      const game = Boolean(document.querySelector(".offline.playing"));
      out.push({ t, lit: shown && unmasked && !game });
      if (t - t0 < ms) requestAnimationFrame(step);
      else resolve(out);
    };
    requestAnimationFrame(step);
  });

/** Page side of E04: opaque fixed/absolute panels over the game arena (outermost only). */
const overlapPanels = () => {
  const gl = document.getElementById("gl-host");
  if (!gl) return { n: -1, names: [] };
  const a = gl.getBoundingClientRect();
  if (a.width < 1) return { n: 0, names: [] };
  const alpha = (c) => {
    const m = /rgba?\(([^)]+)\)/.exec(c);
    if (!m) return 0;
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    return p.length > 3 ? p[3] : 1;
  };
  const cands = new Set();
  for (const root of document.querySelectorAll(".offline.playing, .hud")) {
    for (const el of root.querySelectorAll("*")) {
      const cs = getComputedStyle(el);
      if ((cs.position !== "fixed" && cs.position !== "absolute") || cs.display === "none" || cs.visibility === "hidden") continue;
      if (alpha(cs.backgroundColor) < 0.5) continue;
      const b = el.getBoundingClientRect();
      if (b.width < 120 || b.height < 60) continue;
      if (b.left <= a.left + 2 && b.right >= a.right - 2 && b.top <= a.top + 2 && b.bottom >= a.bottom - 2) continue; // a backdrop behind the whole arena
      const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (ox > 2 && oy > 2) cands.add(el);
    }
  }
  const outer = [...cands].filter((el) => {
    for (let p = el.parentElement; p; p = p.parentElement) if (cands.has(p)) return false;
    return true;
  });
  return { n: outer.length, names: outer.slice(0, 5).map((el) => `${el.tagName.toLowerCase()}.${String(el.className).split(" ").slice(0, 2).join(".")}`) };
};

/**
 * Page side of E08. startSignature starts a per-frame recorder in the page and resolves after its first frame,
 * so it is running before the click. stopSignature stops it and returns the samples. Recording stays in the page,
 * so a slow Playwright round trip cannot miss the change. mode "scroll": the settings scroller's scrollTop;
 * mode "training": each lesson span's opacity, transform and top (the animation is on the spans).
 */
const startSignature = (mode) =>
  new Promise((resolve) => {
    const scrollerOf = (el) => {
      let sc = el?.parentElement ?? null;
      while (sc && !["auto", "scroll"].includes(getComputedStyle(sc).overflowY)) sc = sc.parentElement;
      return sc;
    };
    const sigOf = () => {
      if (mode === "scroll") {
        const sc = scrollerOf(document.querySelector("section.settings-section"));
        return sc ? String(Math.round(sc.scrollTop * 10)) : "none";
      }
      const el = document.querySelector(".training-text");
      if (!el) return "none";
      return [el, ...el.querySelectorAll(":scope > span")]
        .map((n) => {
          const cs = getComputedStyle(n);
          return `${cs.opacity}|${cs.transform}|${Math.round(n.getBoundingClientRect().top)}`;
        })
        .join("#");
    };
    const rec = { on: true, out: [] };
    window.__qaSig = rec;
    const step = () => {
      if (!rec.on) return;
      rec.out.push(sigOf());
      requestAnimationFrame(step);
    };
    requestAnimationFrame(() => {
      step();
      resolve();
    });
  });

const stopSignature = () => {
  const rec = window.__qaSig;
  if (!rec) return [];
  rec.on = false;
  return rec.out;
};


/** Page side of E09 and the settle wait: resolves once the settings scroller stops moving (or after 2 s). */
const settleScroll = () =>
  new Promise((resolve) => {
    const sc = (() => {
      let p = document.querySelector("section.settings-section")?.parentElement ?? null;
      while (p && !["auto", "scroll"].includes(getComputedStyle(p).overflowY)) p = p.parentElement;
      return p;
    })();
    let last = -1;
    let stable = 0;
    let frames = 0;
    const step = () => {
      const v = sc ? sc.scrollTop : 0;
      stable = v === last ? stable + 1 : 0;
      last = v;
      frames++;
      if (stable >= 6 || frames > 120) resolve();
      else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });

/** Jumps in the 1 s after `at`: engine tick steps and, when `withCam`, camera direction reversals and jumps. */
function windowJitter(tr, at, withCam) {
  const cam = withCam ? cameraJitter(tr.frames, at, at + 1000) : { count: 0, reversals: 0, jumps: 0, n: 0 };
  const ticks = tickJumps(tr.frames, at, at + 1000);
  const clipTicks = tickJumps(tr.clip, at, at + 1000);
  return { count: cam.count + ticks + clipTicks, text: `reversals=${cam.reversals} camJumps=${cam.jumps} tickJumps=${ticks} clipTickJumps=${clipTicks} frames=${cam.n}` };
}

/** E01: the menu clip's first second (clip ticks, anchored on its first tick), then the replay's first second (camera and ticks, anchored on its mark). */
async function jitterMotion(s) {
  const menu = await stateById("menu-anon").prepare(traced(s));
  const clipUp = await menu.page
    .waitForFunction(() => window.__qaTrace?.clip?.some((c) => c.tick >= 0), null, { timeout: 10000 })
    .then(() => true, () => false);
  if (!clipUp) return { pass: false, detail: "menu clip never started" };
  await sleep(1200);
  const mt = await menu.page.evaluate(() => window.__qaTrace);
  const clip = windowJitter(mt, mt.clip.find((c) => c.tick >= 0).t, true);
  const rp = await stateById("replay-loaded").prepare(traced(s));
  await sleep(1200);
  const rt = await rp.page.evaluate(() => window.__qaTrace);
  if (rt.marks.replay === undefined) return { pass: false, detail: "replay never started" };
  const replay = windowJitter(rt, rt.marks.replay, true);
  return { metrics: { "motion.jitter.count": clip.count + replay.count }, detail: `clip ${clip.text}; replay ${replay.text}` };
}

/** E03: Close on the replay while the GL view is sampled per frame. */
async function fullFlash(s) {
  const h = await stateById("replay-loaded").prepare(traced(s));
  await sleep(800);
  const close = h.page.locator(".offline-top").getByRole("button", { name: "Close" }).first();
  const sampling = h.page.evaluate(sampleGl, 1500);
  await close.click();
  const samples = await sampling;
  // Self-test (QA_SELF_TEST=flash): a 6-frame full-window paint, the defect E03 must catch.
  if (process.env.QA_SELF_TEST?.includes("flash")) for (let i = 200; i < 206 && i < samples.length; i++) samples[i].lit = true;
  const r = litFlashes(samples);
  return { metrics: { "motion.fullFlash.count": r.flashes }, detail: `lit runs ms=${r.runs.join(",") || "none (0 flashes)"}` };
}

/** E02: a 10 s practice run; the view centre must not move in world units while the zoom holds. */
async function cameraDrift(s) {
  const h = await stateById("practice-running").prepare(traced(s));
  await sleep(10000);
  const tr = await h.page.evaluate(() => ({ frames: window.__qaTrace.frames, css: document.querySelector("canvas")?.getBoundingClientRect().width ?? 0 }));
  const f = tr.frames.filter((x) => x.w > 0 && Number.isFinite(x.cx) && Number.isFinite(x.cy));
  // Self-test (QA_SELF_TEST=drift): a slow world-unit creep at fixed zoom, the defect E02 must catch.
  if (process.env.QA_SELF_TEST?.includes("drift")) f.forEach((x, i) => { x.cx += Math.min(i, 200) * 0.01; });
  if (f.length < 2) return { pass: false, detail: "no camera frames" };
  // Each zoom level is measured from its own anchor (the centre where that zoom began), so a zoom change never
  // counts as drift. px is at that frame's zoom: css px per world unit = css / w.
  const levels = new Map();
  let px = 0;
  for (const x of f) {
    const key = x.w.toFixed(3);
    const a = levels.get(key) ?? { cx: x.cx, cy: x.cy, n: 0 };
    levels.set(key, a);
    a.n++;
    px = Math.max(px, Math.max(Math.abs(x.cx - a.cx), Math.abs(x.cy - a.cy)) * (tr.css / x.w));
  }
  const held = [...levels.values()].filter((a) => a.n >= 2).reduce((sum, a) => sum + a.n, 0);
  if (held < f.length / 2) return { pass: false, detail: `zoom changed on most frames (${held} of ${f.length} held): no fixed-zoom run to measure` };
  const ws = f.map((x) => x.w);
  const span = (Math.max(...ws) / Math.min(...ws) - 1) * 100;
  return { metrics: { "camera.static.drift.px": Number(px.toFixed(2)) }, detail: `frames=${f.length} heldAtZoom=${held} levels=${levels.size} zoomSpan=${span.toFixed(2)}% px=${px.toFixed(2)}` };
}

/** Page side of E04 void: how far the view reaches past the arena, in css px (camera centre cx/cy, view w/h, arena aw/ah). */
const voidPx = () => {
  const f = window.__qaTrace.frames.filter((x) => x.w > 0 && Number.isFinite(x.aw));
  const gl = document.getElementById("gl-host") ?? document.querySelector("canvas");
  const css = gl ? gl.getBoundingClientRect().width : 0;
  let worst = 0;
  for (const x of f) {
    const out = Math.max(0, x.w / 2 - x.cx, x.cx + x.w / 2 - x.aw, x.h / 2 - x.cy, x.cy + x.h / 2 - x.ah);
    worst = Math.max(worst, (out * css) / x.w);
  }
  return { n: f.length, px: Number(worst.toFixed(2)) };
};

/** E04: the replay and the practice run, each with the panels that cover the game arena and the void past the arena. */
async function hudOverlap(s) {
  const parts = [];
  let total = 0;
  let worstVoid = 0;
  for (const id of ["replay-loaded", "practice-running"]) {
    const h = await stateById(id).prepare(traced(s));
    await sleep(600);
    const r = await h.page.evaluate(overlapPanels);
    if (r.n < 0) return { pass: false, detail: `${id}: no game view` };
    const v = await h.page.evaluate(voidPx);
    if (!v.n) return { pass: false, detail: `${id}: no camera frames` };
    total += r.n;
    worstVoid = Math.max(worstVoid, v.px);
    parts.push(`${id}=${r.n}${r.names.length ? ` [${r.names.join(" ")}]` : ""} void=${v.px}`);
  }
  return { metrics: { "overlay.hud.overlap": total, "overlay.void.px": worstVoid }, detail: parts.join("; ") };
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

/**
 * E08: four listed changes (settings sections 1-3 from the nav, and training Next). A change animates when
 * its sampled signature takes at least 4 distinct values (start, end and 2 in between). The metric is the
 * share of the four that animate.
 */
async function transitions(s) {
  const parts = [];
  let animated = 0;
  const changes = 4;
  const judge = (label, sigs) => {
    const distinct = new Set(sigs).size;
    const ok = distinct >= 4;
    if (ok) animated++;
    parts.push(`${label}=${distinct}${ok ? "" : "(no anim)"}`);
  };
  const st = await stateById("settings").prepare(traced(s));
  for (const i of [1, 2, 3]) {
    await st.page.evaluate(startSignature, "scroll");
    await st.page.locator(".settings-nav-item").nth(i).click();
    await sleep(700);
    judge(`settings${i}`, await st.page.evaluate(stopSignature));
  }
  const tr = await stateById("training").prepare(traced(s));
  await tr.page.evaluate(startSignature, "training");
  await tr.page.locator(".training-next").first().click();
  await sleep(700);
  judge("training", await tr.page.evaluate(stopSignature));
  return { metrics: { "transition.present": Number((animated / changes).toFixed(2)) }, detail: parts.join(" ") };
}

/** E09: each settings nav item lands its section at the scroller top (the first section at the top). */
async function scrollTarget(s) {
  const h = await stateById("settings").prepare(traced(s));
  const page = h.page;
  const items = await page.locator(".settings-nav-item").count();
  let worst = 0;
  const rows = [];
  for (let i = 0; i < items; i++) {
    await page.locator(".settings-nav-item").nth(i).click();
    await page.evaluate(settleScroll);
    const off = await page.evaluate((i) => {
      const sec = document.querySelectorAll("section.settings-section")[i];
      if (!sec) return null;
      let sc = sec.parentElement;
      while (sc && !["auto", "scroll"].includes(getComputedStyle(sc).overflowY)) sc = sc.parentElement;
      if (!sc) return null;
      if (i === 0) return sc.scrollTop; // first section: the scroller must be at the top
      const r = sec.getBoundingClientRect();
      const box = sc.getBoundingClientRect();
      if (sc.scrollTop >= sc.scrollHeight - sc.clientHeight - 1) {
        // Clamped at the bottom: a section that fits must be fully in view; a taller one cannot reach the top.
        if (sec.offsetHeight > sc.clientHeight) return 0;
        return Math.max(0, r.bottom - box.bottom, box.top - r.top);
      }
      const actual = r.top - box.top;
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

/**
 * E11: each training lesson that names keys. Holding each named key must light its .key box
 * (.is-hit) within 150 ms. The metric is the share of prompts that react on every named key.
 */
async function promptedInput(s) {
  const h = await stateById("training").prepare(traced(s));
  const page = h.page;
  let prompts = 0;
  let reacting = 0;
  const parts = [];
  for (let l = 0; l < 12; l++) {
    const actions = await page.evaluate(() => [...new Set([...document.querySelectorAll(".training-text .key[data-action]")].map((e) => e.dataset.action))]);
    if (actions.length) {
      prompts++;
      let ok = true;
      for (const a of actions) {
        const code = FIRST_KEY[a];
        if (!code) {
          ok = false;
          continue;
        }
        await page.keyboard.down(code);
        const hit = await page
          .waitForFunction((act) => Boolean(document.querySelector(`.training-text .key[data-action="${act}"].is-hit`)), a, { timeout: 150, polling: "raf" })
          .then(() => true, () => false);
        await page.keyboard.up(code);
        ok = ok && hit;
        await sleep(120);
      }
      if (ok) reacting++;
      parts.push(`${l + 1}:${actions.join("+")}=${ok ? "ok" : "NO"}`);
    }
    const next = page.locator(".training-next").first();
    if (await next.isDisabled().catch(() => true)) break;
    await next.click({ timeout: 1500 }).catch(() => {});
    await sleep(250);
  }
  const reacts = prompts ? Number((reacting / prompts).toFixed(2)) : 0;
  return { metrics: { "interaction.promptedInput.reacts": reacts }, detail: parts.join(" ") };
}

/** One drag over the editor canvas (mouse down, `steps` moves, up). Returns the rAF intervals (ms) during the drag. */
async function dragFrames(page, steps) {
  const box = await page.locator("canvas.editor-canvas").boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  const sampling = page.evaluate(
    () =>
      new Promise((resolve) => {
        const d = [];
        let last = performance.now();
        const step = (t) => {
          d.push(t - last);
          last = t;
          if (d.length < 150) requestAnimationFrame(step);
          else resolve(d);
        };
        requestAnimationFrame(step);
      }),
  );
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) await page.mouse.move(cx + i * 2, cy + i);
  await page.mouse.up();
  return (await sampling).slice(2);
}

/** E12: the editor with two shapes; one is dragged across the canvas. p95 of the rAF interval during the drag. */
async function editorDrag(s) {
  const h = await stateById("editor-shapes").prepare(traced(s));
  const frames = await dragFrames(h.page, 60);
  const p95 = Number(percentile(frames, 95).toFixed(2));
  return { metrics: { "editor.perf.dragP95ms": p95 }, detail: `frames=${frames.length} max=${Math.max(...frames).toFixed(1)}` };
}

/**
 * E12 at 4x CPU: the stress map (editor-perf/stress.json, 1500 bodies) is the editor draft, then the same drag.
 * Chromium only (the CDP throttle); other engines fail explicitly.
 */
async function editorDrag4x(s) {
  const h = await stateById("menu-user").prepare(traced(s));
  const page = h.page;
  let cdp;
  try {
    cdp = await page.context().newCDPSession(page);
  } catch {
    return { pass: false, detail: "CDP unavailable (chromium only)" };
  }
  const draft = readFileSync(STRESS_MAP, "utf8");
  // The editor reads the draft when it opens: set it from the menu, then open the editor in-app. A reload meets the unload prompt and hung.
  await page.evaluate((d) => localStorage.setItem("neobox.editor.draft", d), draft);
  await navTo(page, "Map editor");
  await page.locator("canvas.editor-canvas").waitFor({ timeout: 60000 });
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  const frames = await dragFrames(page, 50);
  const p95 = Number(percentile(frames, 95).toFixed(2));
  return { metrics: { "editor.perf.drag4xP95ms": p95 }, detail: `frames=${frames.length} max=${Math.max(...frames).toFixed(1)}` };
}

/** E06: frames where a name label (overlay, z 1) is drawn over the followed player's marker (GL, z 0). Window CSS px. */
async function renderOrder(s) {
  const h = await stateById("practice-running").prepare(traced(s));
  await sleep(6000);
  const r = await h.page.evaluate(() => {
    const hit = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    let frames = 0;
    let under = 0;
    for (const d of window.__qaTrace.draw) {
      const m = d.rects.find((q) => q.kind === "marker");
      if (!m) continue;
      frames++;
      if (d.rects.some((q) => q.kind === "label" && hit(q.box, m.box))) under++;
    }
    return { frames, under };
  });
  if (!r.frames) return { pass: false, detail: "no followed marker drawn" };
  return { metrics: { "overlay.marker.underLabel": r.under }, detail: `frames=${r.frames} underLabel=${r.under}` };
}

/** Control boxes on the page (visible buttons, links, fields), keyed by label and occurrence, for E10. */
const controlBoxes = () => {
  const seen = new Map();
  return [...document.querySelectorAll("button, a[href], input, select, textarea")]
    .filter((e) => {
      const cs = getComputedStyle(e);
      const b = e.getBoundingClientRect();
      return b.width > 0 && b.height > 0 && cs.visibility !== "hidden" && cs.display !== "none";
    })
    .map((e) => {
      const base = (e.getAttribute("aria-label") || e.textContent || e.id || e.tagName).trim().slice(0, 40);
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      const b = e.getBoundingClientRect();
      return { k: `${base}#${n}`, x: b.x, y: b.y };
    });
};

/** E10 toast: each trigger opens the toast; `pre` runs before the first snapshot, `act` raises the toast. */
const TOAST_TRIGGERS = [
  {
    name: "editor",
    state: "editor-shapes",
    pre: async (h) => h.page.locator(".editor-menu-toggle").click(),
    act: async (h) => h.page.getByRole("button", { name: /copy map code/i }).first().click(),
  },
  {
    name: "room",
    state: "room-host",
    // The app copies the link only where the context may write the clipboard; without it there is no toast.
    pre: async (h) => h.page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(h.page.url()).origin }).catch(() => {}),
    act: async (h) => h.page.getByRole("button", { name: "Invite", exact: true }).first().click(),
  },
];

/** E10: a toast must not move the controls on the page. The worst move (px, L1) over the triggers. */
async function toastShift(s) {
  const parts = [];
  let worst = 0;
  for (const t of TOAST_TRIGGERS) {
    const h = await stateById(t.state).prepare(traced(s));
    await sleep(500);
    if (t.pre) await t.pre(h);
    await sleep(300);
    const before = await h.page.evaluate(controlBoxes);
    await t.act(h);
    await sleep(500);
    if (!(await h.page.locator("#toasts > *").count())) return { pass: false, detail: `${t.name}: no toast raised` };
    const after = await h.page.evaluate(controlBoxes);
    const at = new Map(before.map((r) => [r.k, r]));
    let d = 0;
    for (const r of after) {
      const o = at.get(r.k);
      if (o) d = Math.max(d, Math.abs(o.x - r.x) + Math.abs(o.y - r.y));
    }
    worst = Math.max(worst, d);
    parts.push(`${t.name}=${d.toFixed(1)}`);
  }
  return { metrics: { "layout.toastShift.px": Number(worst.toFixed(1)) }, detail: parts.join(" ") };
}

/** Copy claims need no browser: the source strings and the register decide. */
async function copyClaims(ctx) {
  const register = loadRegister(path.join(QA_DIR, "copy-claims.json"));
  const res = runCopyClaims({ srcDir: ctx.src ? path.resolve(ctx.src) : undefined, register });
  return { metrics: res.metrics, detail: res.failures.slice(0, 5).join(" | ") || undefined };
}

/** E-id, threshold key, the detector. `browser: false` runs without a browser. */
export const DETECTORS = [
  { escape: "E01", key: "motion.jitter.count", run: jitterMotion },
  { escape: "E02", key: "camera.static.drift.px", run: cameraDrift },
  { escape: "E03", key: "motion.fullFlash.count", run: fullFlash },
  { escape: "E04", key: "overlay.hud.overlap", run: hudOverlap },
  { escape: "E05", key: "font.pref.metricDelta", run: fontPref },
  { escape: "E06", key: "overlay.marker.underLabel", run: renderOrder },
  { escape: "E07", key: "copy.claims.unsourced", run: copyClaims, browser: false },
  { escape: "E08", key: "transition.present", run: transitions },
  { escape: "E09", key: "scroll.target.offset", run: scrollTarget },
  { escape: "E10", key: "layout.navShift.px", run: navShift },
  { escape: "E10", key: "layout.toastShift.px", run: toastShift },
  { escape: "E11", key: "interaction.promptedInput.reacts", run: promptedInput },
  { escape: "E12", key: "editor.perf.dragP95ms", run: editorDrag },
  { escape: "E12", key: "editor.perf.drag4xP95ms", run: editorDrag4x },
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
    if (!Number.isFinite(metrics[det.key])) failures.push("no finite metric");
    return { metrics, failures, detail: [out?.detail, ...failures].filter(Boolean).join("; ") || undefined };
  };
  if (det.browser === false) {
    const out = await det.run(ctx);
    const j = judge(out);
    return { id: `${det.escape}-${det.key}`, verdict: j.failures.length ? "fail" : "pass", metrics: j.metrics, detail: j.detail };
  }
  const id = `${det.escape}-${det.key}`;
  const rec = await results.case(
    id,
    async (s) => {
      const out = (await det.run(s, ctx)) ?? {};
      const j = judge(out);
      return { pass: out.pass !== false && j.failures.length === 0, metrics: j.metrics, detail: j.detail };
    },
    { browser, base },
  );
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
