// Temporal QA detectors: the escape classes (client/qa escape table E01-E12) that only show up in a
// time series or a frame sequence. Each detector is one case on a fresh Scenario and returns metrics
// keyed as in thresholds.json (keys with "runner": true). validateRecord decides the verdict.
//
// Detectors (escape id, threshold key):
//   E01 motion.jitter.count       menu clip start: clip tick jumps only (camera follows the stall); replay start: camera reversals/jumps and tick jumps in the first second
//   E02 camera.static.drift.px    practice run on a map that fits both axes, the player playing it: camera drift in screen px at fixed zoom
//   E03 motion.fullFlash.count    replay Close: unmasked, game-less runs of the GL view that last <= 150 ms (rAF sampler)
//   E04 overlay.hud.overlap       replay and practice: opaque panels (any position) over the game view, each >= 1% of it (count);
//                                  overlay.void.px: how far a game-view frame reaches past the playable bounds (px)
//                                  menu clip card (desktop light/dark, phone portrait): overlay.backdrop.void.px (card corners past the arena, px),
//                                  overlay.backdrop.page.px (page-white pixels inside the card outside the arena, css px^2),
//                                  overlay.backdrop.control.count (bar with no clip, caption over pause or clipped or translucent, card past the viewport)
//   E05 font.pref.metricDelta     About page: readable-font pref changes text metrics (%)
//   E07 copy.claims.unsourced     copy claims with no source (no browser; copy-claims.mjs)
//   E08 transition.present        settings sections and training Next: share of changes that animate (browser animation events and scroll timing; rAF samples secondary)
//   E09 scroll.target.offset      settings nav: section lands at the scroll target (px)
//   E10 layout.navShift.px        news dialog Next and training Next move between pages (px)
//                                  layout.toastShift.px: controls move when a toast appears (px)
//   E11 interaction.promptedInput.reacts  training: share of prompts whose named key lights its .key within 150 ms
//   E12 editor.perf.dragP95Frames: editor: p95 rAF interval while a shape is dragged, in 60 Hz vsync frames (1 = on time), 1x CPU
//                                  editor.perf.drag4xP95ms: the same drag at 4x CPU on the stress map (ms)
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
import { Results, QA_DIR, dismissPhoneSplash, launchEngine, median, navTo, percentile, runCleanups, selectedEngines, sleep, startServer, writeIndex } from "./lib-qa.mjs";
import { stateById } from "./states.mjs";
import { runCopyClaims, loadRegister } from "./copy-claims.mjs";
import { validateRecord } from "./thresholds.mjs";

const KEYS = ["ArrowLeft", "ArrowRight", "ArrowUp", "KeyX", "KeyZ", "KeyC", "KeyV"];
const PREFS_KEY = "neobox.prefs"; // src/storage-keys.ts
/** First default key per action (prefs.ts DEFAULT_KEYS). */
const FIRST_KEY = { left: "ArrowLeft", right: "ArrowRight", up: "ArrowUp", down: "ArrowDown", push: "KeyX", rocket: "KeyZ", bat: "KeyC", grab: "KeyV" };
/** Stress map (1500 bodies) for the 4x-CPU editor drag; QA_STRESS_MAP overrides the path. */
const STRESS_MAP = process.env.QA_STRESS_MAP ?? path.resolve(QA_DIR, "fixtures/stress-map.json");

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
      const play = cam && Boolean(document.querySelector(".offline.playing"));
      trace.frames.push({ t, cx: cam ? c.cx : undefined, cy: cam ? c.cy : undefined, w: cam ? c.w : undefined, h: cam ? c.h : undefined, aw: cam ? c.aw : undefined, ah: cam ? c.ah : undefined, bx0: cam ? c.bx0 : undefined, by0: cam ? c.by0 : undefined, bx1: cam ? c.bx1 : undefined, by1: cam ? c.by1 : undefined, play, tick });
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
 * visible wobble; smaller flips depend on frame timing). A jump is a step above 4x the median moving step and
 * above 1% of the view width: the median collapses while the camera is still, so the floor keeps a pan that
 * starts from rest (a sub-visible step) from counting as a snap.
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
    if (Math.abs(d) > Math.max(4 * med, 0.01 * (win[0].w || 1))) jumps++;
    last = sign;
  }
  return { count: reversals + jumps, reversals, jumps, n: win.length };
}

/**
 * Engine tick jumps in [from, to]: a frame that advances the tick by more than max(3, 4x the median positive step)
 * plus half a tick. The clip advances by dt x hz with dt capped at 50 ms (menu-clips.ts), so a capped frame at 60 Hz
 * is exactly 3 ticks and float rounding can land just above it; a stall (the pre build's 250 ms cap) is far above it.
 */
export function tickJumps(frames, from, to) {
  const win = frames.filter((f) => f.tick >= 0 && f.t >= from && f.t <= to);
  const steps = [];
  for (let i = 1; i < win.length; i++) steps.push(win[i].tick - win[i - 1].tick);
  const pos = steps.filter((d) => d > 0);
  if (!pos.length) return { jumps: 0, max: 0 };
  const limit = Math.max(3, 4 * median(pos)) + 0.5;
  return { jumps: steps.filter((d) => d > limit).length, max: Math.max(...pos) };
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

/** Page side of E04: opaque panels (any position) that cover at least 1% of the game view, outermost only. */
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
      if (cs.display === "none" || cs.visibility === "hidden") continue;
      if (alpha(cs.backgroundColor) < 0.5) continue;
      const b = el.getBoundingClientRect();
      if (b.left <= a.left + 2 && b.right >= a.right - 2 && b.top <= a.top + 2 && b.bottom >= a.bottom - 2) continue; // a backdrop behind the whole arena
      const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (ox > 0 && oy > 0 && ox * oy >= 0.01 * a.width * a.height) cands.add(el);
    }
  }
  const outer = [...cands].filter((el) => {
    for (let p = el.parentElement; p; p = p.parentElement) if (cands.has(p)) return false;
    return true;
  });
  return { n: outer.length, names: outer.slice(0, 5).map((el) => `${el.tagName.toLowerCase()}.${String(el.className).split(" ").slice(0, 2).join(".")}`) };
};

/**
 * Page side of E08. startSignature starts a recorder in the page and resolves after its first frame, so it is
 * running before the click. stopSignature stops it and returns what it saw. The recorder stays in the page, so a
 * slow Playwright round trip cannot miss the change. Presence comes from the browser's own state, not from frame
 * samples: `anim` counts animationstart and transitionrun events inside the training lesson; `deferred` (mode
 * "scroll") is set when the settings scroller did not move during the click itself but moved afterwards, i.e. the
 * scroll is an animation. `sigs` (per-frame samples) is a secondary signal.
 * mode "scroll": the settings scroller's scrollTop; mode "training": each lesson span's opacity, transform and top.
 */
const startSignature = (mode) =>
  new Promise((resolve) => {
    const scrollerOf = (el) => {
      let sc = el?.parentElement ?? null;
      while (sc && !["auto", "scroll"].includes(getComputedStyle(sc).overflowY)) sc = sc.parentElement;
      return sc;
    };
    const scrollTop = () => scrollerOf(document.querySelector("section.settings-section"))?.scrollTop ?? null;
    const sigOf = () => {
      if (mode === "scroll") {
        const top = scrollTop();
        return top === null ? "none" : String(Math.round(top * 10));
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
    const rec = { on: true, mode, out: [], anim: 0, start: null, sync: null, scrollTop };
    rec.onAnim = (e) => {
      if (e.target instanceof Element && e.target.closest(".training-text")) rec.anim++;
    };
    rec.onClickStart = () => {
      rec.start = scrollTop();
    };
    rec.onClickEnd = () => {
      rec.sync = scrollTop();
    };
    document.addEventListener("animationstart", rec.onAnim, true);
    document.addEventListener("transitionrun", rec.onAnim, true);
    window.addEventListener("click", rec.onClickStart, true);
    window.addEventListener("click", rec.onClickEnd);
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
  if (!rec) return { sigs: [], anim: 0, deferred: false };
  rec.on = false;
  document.removeEventListener("animationstart", rec.onAnim, true);
  document.removeEventListener("transitionrun", rec.onAnim, true);
  window.removeEventListener("click", rec.onClickStart, true);
  window.removeEventListener("click", rec.onClickEnd);
  const end = rec.scrollTop();
  return {
    sigs: rec.out,
    anim: rec.anim,
    deferred: rec.mode === "scroll" && rec.start !== null && rec.sync === rec.start && end !== rec.start,
  };
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

/**
 * Jumps in the 1 s after `at`: engine tick steps and, when `countCam`, camera direction reversals and jumps of the
 * drawn view (__qaCam: the menu backdrop's view or the game's follow view). A stalled clip frame moves the clip's ticks
 * by the frame cap, so a stall reads as one tick jump and, if the view followed the clip, as one camera jump.
 */
function windowJitter(tr, at, countCam) {
  const cam = cameraJitter(tr.frames, at, at + 1000);
  const ticks = tickJumps(tr.frames, at, at + 1000);
  const clipTicks = tickJumps(tr.clip, at, at + 1000);
  const count = (countCam ? cam.count : 0) + ticks.jumps + clipTicks.jumps;
  return { count, text: `reversals=${cam.reversals} camJumps=${cam.jumps} tickJumps=${ticks.jumps} clipTickJumps=${clipTicks.jumps} clipMaxStep=${clipTicks.max.toFixed(2)} frames=${cam.n}` };
}

/** E01: the menu clip's first second (clip ticks, anchored on its first tick; a 300 ms main-thread stall injected 200 ms in, so the frame cap is exercised on every run), then the replay's first second (camera and ticks, anchored on its mark). */
async function jitterMotion(s) {
  const menu = await stateById("menu-anon").prepare(traced(s));
  const clipUp = await menu.page
    .waitForFunction(() => window.__qaTrace?.clip?.some((c) => c.tick >= 0), null, { timeout: 10000 })
    .then(() => true, () => false);
  if (!clipUp) return { pass: false, detail: "menu clip never started" };
  await sleep(200);
  // Fault injection: a 300 ms main-thread stall. The clip advances by the frame dt capped by MAX_FRAME_MS; the fixed cap keeps the step to ~1.5 ticks.
  await menu.page.evaluate(() => { const end = performance.now() + 300; while (performance.now() < end); });
  await sleep(1000);
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

/**
 * E02's player actions on a map that fits both axes: walk into each wall, jump, aim the rocket across the floor and at each
 * wall and fire, swing the bat, push. Default bindings (prefs.ts DEFAULT_KEYS). A camera that follows the moving bodies,
 * the rocket aim lines or the bat arcs only moves while the player makes them move, so an idle scene cannot test it.
 */
async function playFloorAndWalls(page) {
  const hold = async (keys, ms) => {
    for (const k of keys) await page.keyboard.down(k);
    await sleep(ms);
    for (const k of keys) await page.keyboard.up(k);
  };
  for (let pass = 0; pass < 2; pass++) {
    await hold(["ArrowRight"], 1800);
    await hold(["ArrowLeft"], 1800);
    await hold(["ArrowLeft", "ArrowUp"], 300);
    await hold(["KeyZ", "ArrowLeft"], 900);
    await hold(["KeyZ", "ArrowRight"], 1200);
    await hold(["KeyC", "ArrowRight"], 800);
    await hold(["KeyX", "ArrowLeft"], 400);
  }
}

/** E02: a practice run where the player plays the floor and both walls; the view centre must not move in world units while the zoom holds. */
async function cameraDrift(s) {
  const h = await stateById("practice-running").prepare(traced(s));
  await playFloorAndWalls(h.page);
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

/**
 * Page side of E04 void: how far a settled game view reaches past the playable bounds (where the backdrop is painted),
 * in css px. The first 500 ms of the game view are skipped: the camera still holds the previous screen's pose there.
 */
const voidPx = () => {
  const all = window.__qaTrace.frames.filter((x) => x.play && x.w > 0 && Number.isFinite(x.bx0));
  const t0 = all.length ? all[0].t : 0;
  const f = all.filter((x) => x.t >= t0 + 500);
  const gl = document.getElementById("gl-host") ?? document.querySelector("canvas");
  const css = gl ? gl.getBoundingClientRect().width : 0;
  let worst = 0;
  for (const x of f) {
    const out = Math.max(0, x.bx0 - (x.cx - x.w / 2), x.cx + x.w / 2 - x.bx1, x.by0 - (x.cy - x.h / 2), x.cy + x.h / 2 - x.by1);
    worst = Math.max(worst, (out * css) / x.w);
  }
  return { n: f.length, px: Number(worst.toFixed(2)) };
};

/** E04: the replay and the practice run: the opaque panels over the game view, and the void past the playable bounds. */
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

/** Page side of the menu backdrop: the card's corners and the arena bounds (css px), from the DOM and the menu camera. */
const backdropGeometry = () => {
  const sq = document.querySelector(".menu-square");
  const gl = document.getElementById("gl-host");
  const cam = window.__qaCam;
  if (!sq || !gl || !cam || !(cam.w > 0)) return null;
  const r = sq.getBoundingClientRect();
  const theta = (parseFloat(sq.style.getPropertyValue("--angle")) * Math.PI) / 180;
  const half = sq.offsetWidth / 2;
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  const gx = gl.getBoundingClientRect();
  const k = gx.width / cam.w;
  // world -> page px, the mapping of camera.ts (the GL view spans the camera's w by h)
  const toPage = (wx, wy) => [gx.left + (wx - (cam.cx - cam.w / 2)) * k, gx.top + (wy - (cam.cy - cam.h / 2)) * k];
  const [ax0, ay0] = toPage(cam.bx0 + 1, cam.by0 + 1);
  const [ax1, ay1] = toPage(cam.bx1 - 1, cam.by1 - 1);
  const corners = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ].map(([u, v]) => [cx + half * (u * Math.cos(theta) - v * Math.sin(theta)), cy + half * (u * Math.sin(theta) + v * Math.cos(theta))]);
  let outside = 0;
  for (const [x, y] of corners) outside = Math.max(outside, ax0 - x, x - ax1, ay0 - y, y - ay1, 0);
  // controls: a bar shown with no drawn clip, caption over pause, clipped text, translucent caption, card past the viewport
  const live = sq.classList.contains("is-live");
  const bar = document.querySelector(".menu-clip-bar");
  const credit = document.querySelector(".menu-clip-credit");
  const pause = document.querySelector(".menu-clip-pause");
  const issues = [];
  if (bar && !bar.hidden && bar.getBoundingClientRect().width > 0 && !live) issues.push("bar-without-clip");
  if (credit && pause && live) {
    const a = credit.getBoundingClientRect();
    const b = pause.getBoundingClientRect();
    if (a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom) issues.push("caption-over-pause");
    if (credit.scrollWidth > credit.clientWidth + 1 || credit.scrollHeight > credit.clientHeight + 1) issues.push("caption-clipped");
    const bg = getComputedStyle(credit).backgroundColor;
    const parts = /rgba?\(([^)]+)\)/.exec(bg)?.[1].split(/[\s,/]+/).filter(Boolean) ?? [];
    const alpha = parts.length > 3 ? Number(parts[3]) : 1;
    if (alpha > 0 && alpha < 1) issues.push("caption-translucent");
  }
  if (corners.some(([x, y]) => x < 0 || y < 0 || x > innerWidth || y > innerHeight)) issues.push("card-past-viewport");
  return { live, outside: Number(outside.toFixed(2)), issues, clip: { x: r.left, y: r.top, w: r.width, h: r.height }, theta, half, arena: [ax0, ay0, ax1, ay1] };
};

/** Decodes a PNG of the card and counts page-white pixels inside the card that lie outside the arena (the wedge a card corner past the arena shows). Arena pixels, pills included, are clip content. */
const backdropPixels = async ({ b64, g }) => {
  const img = new Image();
  img.src = `data:image/png;base64,${b64}`;
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, img.width, img.height).data;
  const scale = img.width / g.shot.w;
  const cos = Math.cos(g.theta);
  const sin = Math.sin(g.theta);
  const [ax0, ay0, ax1, ay1] = g.arena;
  let n = 0;
  for (let py = 0; py < img.height; py += 1) {
    for (let px = 0; px < img.width; px += 1) {
      const x = g.shot.x + (px + 0.5) / scale;
      const y = g.shot.y + (py + 0.5) / scale;
      const dx = x - (g.clip.x + g.clip.w / 2);
      const dy = y - (g.clip.y + g.clip.h / 2);
      const u = dx * cos + dy * sin;
      const v = -dx * sin + dy * cos;
      if (Math.abs(u) > g.half - 2 || Math.abs(v) > g.half - 2) continue;
      const i = (py * img.width + px) * 4;
      if (data[i] < 240 || data[i + 1] < 240 || data[i + 2] < 240) continue;
      const outsideArena = x < ax0 || x > ax1 || y < ay0 || y > ay1;
      if (outsideArena) n += 1;
    }
  }
  return n / (scale * scale);
};

/** E04 backdrop: the menu clip card (desktop light and dark, phone portrait; the phone landscape has no backdrop by design, menu.css). */
async function menuBackdrop(s) {
  const cases = [
    ["desktop-light", { viewport: { width: 1280, height: 800 } }, false],
    ["desktop-dark", { viewport: { width: 1280, height: 800 } }, true],
    ["phone-portrait", { viewport: { width: 390, height: 844 }, phone: true }, false],
  ];
  const parts = [];
  let worstVoid = 0;
  let pagePx = 0;
  let controls = 0;
  for (const [name, opts, dark] of cases) {
    const h = await s.open(`backdrop-${name}`, { name: "shots", ...opts });
    await h.page.goto(s.base);
    if (dark) await h.page.evaluate(() => (document.documentElement.dataset.theme = "dark"));
    if (opts.phone) await dismissPhoneSplash(h.page);
    await h.page.locator('.drum[data-settled="true"]').waitFor();
    await h.page.locator(".menu-square.is-live").waitFor({ timeout: 20000 }).catch(() => {});
    const samples = [];
    for (const wait of [1000, 3000]) {
      await sleep(wait);
      const g = await h.page.evaluate(backdropGeometry);
      if (!g) return { pass: false, detail: `${name}: no menu card or camera` };
      let px = 0;
      if (g.live) {
        // The card's box can reach past the viewport (a card-past-viewport control issue above): shoot only what is on screen.
        const x0 = Math.max(0, g.clip.x);
        const y0 = Math.max(0, g.clip.y);
        const x1 = Math.min(h.page.viewportSize().width, g.clip.x + g.clip.w);
        const y1 = Math.min(h.page.viewportSize().height, g.clip.y + g.clip.h);
        if (x1 > x0 && y1 > y0) {
          const shot = await h.page.screenshot({ clip: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } });
          px = await h.page.evaluate(backdropPixels, { b64: shot.toString("base64"), g: { ...g, shot: { x: x0, y: y0, w: x1 - x0 } } });
        }
      }
      samples.push({ wait, live: g.live, outside: g.outside, px: Number(px.toFixed(1)), issues: g.issues });
      worstVoid = Math.max(worstVoid, g.outside);
      pagePx = Math.max(pagePx, px);
      controls += g.issues.length;
    }
    const live = samples.every((x) => x.live);
    if (!live) controls += 1;
    parts.push(`${name} ${samples.map((x) => `+${x.wait}ms(live=${x.live} outside=${x.outside} px=${x.px}${x.issues.length ? ` ${x.issues.join(",")}` : ""})`).join(" ")}${live ? "" : " NO-LIVE-CLIP"}`);
    await h.page.close().catch(() => {});
  }
  return { metrics: { "overlay.backdrop.void.px": worstVoid, "overlay.backdrop.page.px": Math.round(pagePx), "overlay.backdrop.control.count": controls }, detail: parts.join("; ") };
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
 * E08: four listed changes (settings sections 1-3 from the nav, and training Next). A change animates when the
 * browser reports an animation for it (animationstart or transitionrun inside the lesson, or a settings scroll that
 * is deferred to motion), or when its sampled signature takes at least 4 distinct values. Presence comes from the
 * browser's state, so it does not depend on the frame rate; the samples only add to it. The metric is the share of
 * the four that animate.
 * Self-test (QA_SELF_TEST=notransition): transitions and animations are off and the settings scroll is instant.
 */
async function transitions(s) {
  const parts = [];
  let animated = 0;
  const changes = 4;
  const off = process.env.QA_SELF_TEST === "notransition";
  const disable = (page) =>
    page.evaluate(() => {
      const style = document.createElement("style");
      style.textContent = "*,*::before,*::after{transition:none!important;animation:none!important}";
      document.head.append(style);
      const scrollIntoView = Element.prototype.scrollIntoView;
      Element.prototype.scrollIntoView = function (opts) {
        return scrollIntoView.call(this, { ...opts, behavior: "instant" });
      };
    });
  const judge = (label, rec) => {
    const distinct = new Set(rec.sigs).size;
    const ok = rec.anim > 0 || rec.deferred || distinct >= 4;
    if (ok) animated++;
    parts.push(`${label}=${distinct}/${rec.anim}${rec.deferred ? "/deferred" : ""}${ok ? "" : "(no anim)"}`);
  };
  const st = await stateById("settings").prepare(traced(s));
  if (off) await disable(st.page);
  for (const i of [1, 2, 3]) {
    await st.page.evaluate(startSignature, "scroll");
    await st.page.locator(".settings-nav-item").nth(i).click();
    await sleep(700);
    judge(`settings${i}`, await st.page.evaluate(stopSignature));
  }
  const tr = await stateById("training").prepare(traced(s));
  if (off) await disable(tr.page);
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

/** The editor on the stress map (fixtures/stress-map.json, 1500 bodies), opened in-app: the editor reads the draft when it opens. */
async function stressEditor(s) {
  const h = await stateById("menu-user").prepare(traced(s));
  await h.page.evaluate((d) => localStorage.setItem("neobox.editor.draft", d), readFileSync(STRESS_MAP, "utf8"));
  await navTo(h.page, "Map editor");
  await h.page.locator("canvas.editor-canvas").waitFor({ timeout: 60000 });
  return h.page;
}

/**
 * One drag over the editor canvas: pointer down, `steps` moves, each followed by one animation frame, so the drag spans
 * `steps` frames; then pointer up. Returns the frame intervals (ms) of the frames that start inside the drag, without the first two.
 */
async function dragFrames(page, steps) {
  const box = await page.locator("canvas.editor-canvas").boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const nextFrame = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r())));
  await page.mouse.move(cx, cy);
  await nextFrame();
  const sampling = page.evaluate(
    () =>
      new Promise((resolve) => {
        window.__dragStop = false;
        const t = [];
        const step = () => {
          t.push(performance.now());
          if (window.__dragStop) resolve(t);
          else requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      }),
  );
  await page.evaluate(() => {
    window.__dragDown = performance.now();
  });
  if (process.env.QA_SELF_TEST === "dragstall") {
    // Every frame of the drag spends 40 ms in the main thread: over the 33.4 ms 4x gate and 2+ vsync frames at 1x.
    await page.evaluate(() => {
      window.__stallOn = true;
      const spin = () => {
        if (!window.__stallOn) return;
        const e = performance.now() + 40;
        while (performance.now() < e);
        requestAnimationFrame(spin);
      };
      requestAnimationFrame(spin);
    });
  }
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(cx + i * 2, cy + i);
    await nextFrame();
  }
  await page.mouse.up();
  await page.evaluate(() => {
    window.__dragUp = performance.now();
    window.__dragStop = true;
  });
  if (process.env.QA_SELF_TEST === "dragstall") await page.evaluate(() => { window.__stallOn = false; });
  const [down, up] = await page.evaluate(() => [window.__dragDown, window.__dragUp]);
  const ts = (await sampling).filter((x) => x >= down && x <= up);
  return ts.slice(1).map((x, i) => x - ts[i]).slice(2);
}

/**
 * E12: the stress map at 1x CPU; a 20-frame warm-up drag, then one 400-frame drag. p95 of its frame intervals in
 * vsync frames. Webkit reports rAF in whole ms, so a 60 Hz frame reads 16 or 17 ms; each interval is rounded to
 * whole frames (floor 1) before the p95. The 1500-body redraw is what the drag pays for (4084ab8 redraws only the moving bodies).
 */
async function editorDrag(s) {
  const page = await stressEditor(s);
  await dragFrames(page, 20);
  const frames = await dragFrames(page, 400);
  const vsync = frames.map((ms) => Math.max(1, Math.round(ms / (1000 / 60))));
  const p95 = Number(percentile(vsync, 95).toFixed(2));
  return { metrics: { "editor.perf.dragP95Frames": p95 }, detail: `frames=${frames.length} p50ms=${percentile(frames, 50).toFixed(1)} maxms=${Math.max(...frames).toFixed(1)}` };
}

/**
 * E12 at 4x CPU: the same stress-map drag under CDP CPU throttling. Chromium only (runOne reports other engines N/A).
 * A 60-step warm-up, then three 400-step drags pooled (1200 intervals): with one 400-step drag the p95 is the 20th-largest
 * interval, and that single drag swung 10 ms to 19 ms between runs of the same build. The pooled p95 is the same statistic.
 */
async function editorDrag4x(s) {
  const page = await stressEditor(s);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await dragFrames(page, 60);
  const frames = [];
  for (let i = 0; i < 3; i++) frames.push(...(await dragFrames(page, 400)));
  const p95 = Number(percentile(frames, 95).toFixed(2));
  return { metrics: { "editor.perf.drag4xP95ms": p95 }, detail: `frames=${frames.length} p50=${percentile(frames, 50).toFixed(1)} max=${Math.max(...frames).toFixed(1)}` };
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

/**
 * E10 toast: each trigger raises a toast; `pre` runs before the first snapshot, `act` raises it. The editor copy raises
 * one on every engine: "Code copied", or "Select the code and copy it by hand" where the clipboard write is refused.
 * The room invite raises none headless (it opens the invite dialog), so it is not a trigger.
 */
const TOAST_TRIGGERS = [
  {
    name: "editor",
    state: "editor-shapes",
    pre: async (h) => h.page.locator(".editor-menu-toggle").click(),
    act: async (h) => h.page.getByRole("button", { name: /copy map code/i }).first().click(),
  },
];

/** E10: a toast must not move the controls on the page. The worst move (px, L1) over the triggers. */
async function toastShift(s) {
  const parts = [];
  let worst = 0;
  for (const t of TOAST_TRIGGERS) {
    const h = await stateById(t.state).prepare(traced(s));
    await sleep(500);
    await t.pre(h);
    await sleep(300);
    const before = await h.page.evaluate(controlBoxes);
    await t.act(h);
    await sleep(500);
    if (!(await h.page.locator("#toasts > *").count())) return { pass: false, detail: `${t.name}: no toast raised` };
    const after = await h.page.evaluate(controlBoxes);
    const at = new Map(before.map((r) => [r.k, r]));
    let d = 0;
    let who = "";
    for (const r of after) {
      const o = at.get(r.k);
      if (!o) continue;
      const m = Math.abs(o.x - r.x) + Math.abs(o.y - r.y);
      if (m > d) [d, who] = [m, r.k];
    }
    worst = Math.max(worst, d);
    parts.push(`${t.name}=${d.toFixed(1)}${who ? ` (${who})` : ""}`);
  }
  return { metrics: { "layout.toastShift.px": Number(worst.toFixed(1)) }, detail: parts.join("; ") };
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
  { escape: "E04", key: "overlay.backdrop.page.px", run: menuBackdrop },
  { escape: "E05", key: "font.pref.metricDelta", run: fontPref },
  { escape: "E06", key: "overlay.marker.underLabel", run: renderOrder },
  { escape: "E07", key: "copy.claims.unsourced", run: copyClaims, browser: false },
  { escape: "E08", key: "transition.present", run: transitions },
  { escape: "E09", key: "scroll.target.offset", run: scrollTarget },
  { escape: "E10", key: "layout.navShift.px", run: navShift },
  { escape: "E10", key: "layout.toastShift.px", run: toastShift },
  { escape: "E11", key: "interaction.promptedInput.reacts", run: promptedInput },
  { escape: "E12", key: "editor.perf.dragP95Frames", run: editorDrag },
  { escape: "E12", key: "editor.perf.drag4xP95ms", run: editorDrag4x, engines: ["chromium"], naReason: "CPU throttle is CDP-only (chromium)" },
];

/**
 * Runs one detector. Returns { id, verdict, metrics, detail }. ctx: { base, src? }.
 * `browser` and `results` are needed for browser detectors (Results.case gives each case its own scenario).
 */
export async function runOne(det, { browser, base, results, src, engine } = {}) {
  const ctx = { base, src, engine };
  const judge = (out) => {
    const metrics = out?.metrics ?? {};
    const failures = validateRecord({ metrics, fit: false });
    if (!Number.isFinite(metrics[det.key])) failures.push("no finite metric");
    return { metrics, failures, detail: [out?.detail, ...failures].filter(Boolean).join("; ") || undefined };
  };
  if (det.engines && !det.engines.includes(ctx.engine)) {
    return { id: `${det.escape}-${det.key}`, verdict: "na", metrics: {}, detail: `not applicable on ${ctx.engine}: ${det.naReason}` };
  }
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
