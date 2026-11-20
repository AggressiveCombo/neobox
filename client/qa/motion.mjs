// Motion QA instrument (RUBRIC D20: motion.transition.ms). For each UI transition the instrument
// takes a reference screenshot, fires the trigger, then samples the screenshot region until it is
// stable: a sample pair whose changed-pixel fraction is < 0.5% on both sides. The settle time is
// measured from the trigger. Pixels that animate while the page is idle (canvas arenas, playfields)
// are masked out of every frame; they are not part of the UI transition being measured.
//
// Cases (desktop 1280x800, every engine):
//   ui.modal.open.news        menu News button opens the "Update news" dialog      limit 300 ms
//   ui.modal.close.news       Escape closes it                                     limit 300 ms
//   ui.modal.open.createRoom  Browse rooms "New room" opens the create-room form   limit 300 ms
//   scene.menu.browse         menu "Browse rooms" -> the Browse screen             limit 400 ms
//   scene.browse.room         create-room "Create room" -> the room lobby          limit 400 ms
//   scene.room.match          room "Start" -> the match HUD                        limit 400 ms
//   chrome.pages                menu -> each page -> Back; shared chrome vs Browse rooms  limit 0.5 px at rest, 2 px in flight
//
// Keys: motion.transition.ms (settle time, absent when not settled), motion.transition.limit,
// motion.samples (screenshots taken), motion.sample.ms (median interval between samples),
// motion.cssEnd.ms (in-page cross-check: longest remaining finite CSS animation or transition at the
// trigger, from document.getAnimations), motion.masked.px (idle-animated pixels excluded).
// Direct cases (scene.* and the modal opens) time the transition on the page clock: trigger click -> last end of
// its animations (scene: screen-in/screen-out, style.css 240/160 ms; modal open: the dialog's appear and backdrop
// fade-in, 220 ms each). Their motion.screenshot.ms is the screenshot settle, a diagnostic only.
// motion.chromeShift.px (shared chrome vs Browse rooms at rest) and motion.chromeTravel.px (chrome travel
// in flight), from chrome.pages.
//
// Resolution: one screenshot takes tens of ms, so the 16 ms sample period of the RUBRIC cannot be
// reached through Playwright. Every value comes with the measured median sample period; the settle
// time is only as fine as that period. Each sample pair is still compared with the 0.5% rule.
// Timing from a busy host is provisional: the final run must be on a quiet host.
//
// Usage:  cd client && QA_OUT=C:/Users/aggressivecombo/neobox-scratch/qa/round0-motion node qa/motion.mjs
//         (QA_ENGINES=chromium narrows the engines)
// Self-test (QA_SELF_TEST=janky): every CSS animation and transition is stretched to 1500 ms with
// !important, so every case must FAIL on its limit.
// Chrome self-test (QA_SELF_TEST=chromejump): restores the old Account column width; chrome.pages must FAIL.

import { PNG } from "pngjs";
import {
  Results,
  button,
  launchEngine,
  menuName,
  runCleanups,
  selectedEngines,
  selfTestMode,
  sleep,
  startServer,
  uniqueName,
  writeIndex,
} from "./lib-qa.mjs";
import { drumOption, ensureRoomMap, navTo, playFromMenu, rollDrum } from "../e2e/lib.mjs";

const mode = selfTestMode();
const CHANGE = 0.005; // RUBRIC D20: change below 0.5% of region pixels
const PIXEL_DELTA = 24; // per-pixel sum of |channel delta|: the same test as image.mjs differingPixels
const MAX_MS = 3000; // a transition that is not stable by then fails
const SETTLE_SETUP_MS = 600; // let load-time animations finish before the reference frame
const BASELINE_MS = 250; // idle gap between the two baseline frames that find animated pixels
const JANKY = "*{animation-duration:1500ms!important;transition-duration:1500ms!important}";
const CHROMEJUMP = ".account-page .page-inner{max-width:1040px!important}"; // the old Account column width this case exists to catch
const CHROME_SETTLE_MS = 600; // page transitions are 240 ms; settled chrome is read after this
const CHROME_SHIFT_PX = 0.5; // shared chrome does not move between pages (sub-pixel rounding only)
const CHROME_TRAVEL_PX = 2; // no travel while a page changes: the crossfade keeps chrome in place
const round = (n) => Math.round(n * 10) / 10;

/** Remaining time of the longest finite running CSS animation or transition, in ms. */
const CSS_END = () => {
  let max = 0;
  for (const a of document.getAnimations({ subtree: true })) {
    if (a.playState !== "running") continue;
    const t = a.effect?.getComputedTiming();
    if (!t || !Number.isFinite(t.endTime)) continue;
    const rem = t.endTime - (a.currentTime ?? 0);
    if (rem > max) max = rem;
  }
  return Math.round(max);
};

/** Decodes a PNG screenshot. */
function decode(buf) {
  return PNG.sync.read(buf);
}

/** Per-pixel sum of channel deltas: the image.mjs differingPixels test. */
function pixelDelta(d, e, i) {
  return Math.abs(d[i] - e[i]) + Math.abs(d[i + 1] - e[i + 1]) + Math.abs(d[i + 2] - e[i + 2]);
}

/**
 * Pixels that differ between two idle frames animate without any trigger (canvas arenas, playfields,
 * looping effects). They are masked out of every comparison and reported as motion.masked.px.
 */
function animatedMask(a, b) {
  const mask = new Uint8Array(a.width * a.height);
  let masked = 0;
  for (let p = 0; p < mask.length; p++) {
    if (pixelDelta(a.data, b.data, p * 4) > PIXEL_DELTA) {
      mask[p] = 1;
      masked++;
    }
  }
  return { mask, masked };
}

/**
 * Masks the live clip square (menu arena) by its on-screen box. A modal's scrim dims the clip, so its
 * idle change falls under PIXEL_DELTA and animatedMask misses it; the clip then keeps the frame above
 * CHANGE for as long as it plays behind the dialog. The square is what the idle frame showed as live.
 */
async function maskLiveSquare(page, mask, width) {
  const boxes = await page.evaluate(() =>
    [...document.querySelectorAll(".menu-square.is-live")].map((el) => {
      const r = el.getBoundingClientRect();
      return { x0: r.left, y0: r.top, x1: r.right, y1: r.bottom, dpr: window.devicePixelRatio };
    }),
  );
  let added = 0;
  for (const b of boxes) {
    for (let y = Math.max(0, Math.floor(b.y0 * b.dpr)); y < Math.ceil(b.y1 * b.dpr); y++) {
      for (let x = Math.max(0, Math.floor(b.x0 * b.dpr)); x < Math.min(width, Math.ceil(b.x1 * b.dpr)); x++) {
        if (!mask[y * width + x]) {
          mask[y * width + x] = 1;
          added++;
        }
      }
    }
  }
  return added;
}

/** Fraction of unmasked pixels that changed between two decoded frames. */
function changedFraction(a, b, mask, masked) {
  let n = 0;
  for (let p = 0; p < mask.length; p++) {
    if (!mask[p] && pixelDelta(a.data, b.data, p * 4) > PIXEL_DELTA) n++;
  }
  return n / (mask.length - masked);
}

/**
 * diffs[k] is the change between sample k-1 (or the reference frame for k = 0) and sample k.
 * The transition starts at the first diff >= CHANGE. It settles at the first k whose diffs[k] and
 * diffs[k+1] are both < CHANGE after the start: the region was already stable at sample k-1.
 */
function settle(diffs, times) {
  const started = diffs.findIndex((d) => d >= CHANGE);
  if (started < 0) return { error: "no visible change after the trigger" };
  for (let k = started + 1; k + 1 < diffs.length; k++) {
    if (diffs[k] < CHANGE && diffs[k + 1] < CHANGE) return { ms: times[k - 1], startMs: times[started] };
  }
  return { error: `not stable within ${MAX_MS} ms` };
}

const gaps = (times) => times.slice(1).map((t, i) => t - times[i]);

function median(xs) {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

// Animation timer (direct, no screenshots): the first click or key press after arming sets the start; the animations
// that end after it record their end times on the page's clock. `SETTLE[required]` lists the keys whose last end is the
// settle, and `required` must have ended: a scene change (screen-in, screen-out; style.css), a modal open (the open
// dialog's appear and its ::backdrop fade-in) or a modal close (the closing dialog's modal-out). Toasts also use
// `appear`, so only the dialog's own animations count.
const SETTLE = { "screen-in": ["screen-in", "screen-out"], modal: ["modal"], "modal-out": ["modal-out"] };
const SCENE_ARM = () => {
  window.__qaScene = { start: null, ends: [] };
  if (window.__qaSceneOn) return;
  window.__qaSceneOn = true;
  const start = () => {
    if (window.__qaScene.start === null) window.__qaScene.start = performance.now();
  };
  document.addEventListener("click", start, true);
  document.addEventListener("keydown", start, true);
  document.addEventListener("animationend", (e) => {
    const dialog = e.target instanceof Element && e.target.matches("dialog.modal[open]");
    const closing = e.target instanceof Element && e.target.matches("dialog.modal.is-closing");
    let key = null;
    if (e.animationName === "screen-in" || e.animationName === "screen-out") key = e.animationName;
    else if (dialog && e.animationName === "appear") key = "modal";
    else if (dialog && e.animationName === "fade-in" && e.pseudoElement === "::backdrop") key = "modal";
    else if (closing && e.animationName === "modal-out") key = "modal-out";
    if (key) window.__qaScene.ends.push({ key, t: e.timeStamp });
  }, true);
};
// Settle time of the armed change, or null while its required animation has not ended.
const SCENE_END = ([required, keys]) => {
  const s = window.__qaScene;
  if (!s || s.start === null || !s.ends.some((e) => e.key === required)) return null;
  return Math.round(Math.max(...s.ends.filter((e) => keys.includes(e.key)).map((e) => e.t)) - s.start);
};
async function sceneEnd(page, required) {
  const until = Date.now() + MAX_MS;
  for (;;) {
    const ms = await page.evaluate(SCENE_END, [required, SETTLE[required]]);
    if (ms !== null || Date.now() > until) return ms;
    await sleep(20);
  }
}

/**
 * Measures one transition. `trigger` performs the action; `arrived` rejects unless the destination
 * is on screen. Never throws for a slow or unstable transition: returns pass false with a detail.
 */
async function measure(page, { id, limit, trigger, arrived, liveSquare = false, direct = false }) {
  const shot = () => page.screenshot({ animations: "allow", caret: "hide", timeout: 8000 });
  // Two idle frames before the trigger: pixels that still move between them are masked for the case.
  const idle = decode(await shot());
  await page.waitForTimeout(BASELINE_MS);
  const ref = decode(await shot());
  const { mask, masked: idleMasked } = animatedMask(idle, ref);
  const masked = idleMasked + (liveSquare ? await maskLiveSquare(page, mask, ref.width) : 0);
  const total = ref.width * ref.height;
  if (masked > total / 2) {
    return {
      pass: false,
      detail: `${id}: ${masked} of ${total} px animate while idle; nothing left to measure`,
      metrics: { "motion.transition.limit": limit, "motion.masked.px": masked },
    };
  }
  let prev = ref;

  const t0 = Date.now();
  if (direct) await page.evaluate(SCENE_ARM);
  await trigger();
  const cssEnd = await page.evaluate(CSS_END);

  const diffs = [];
  const times = [];
  let res = { error: "no sample taken" };
  while (Date.now() - t0 <= MAX_MS) {
    const at = Date.now() - t0;
    const cur = decode(await shot());
    diffs.push(changedFraction(prev, cur, mask, masked));
    times.push(at);
    prev = cur;
    res = settle(diffs, times);
    if (!res.error) break;
  }
  const metrics = {
    "motion.transition.limit": limit,
    "motion.samples": diffs.length,
    "motion.sample.ms": median(gaps(times)),
    "motion.cssEnd.ms": cssEnd,
    "motion.masked.px": masked,
  };
  if (res.error && !direct) {
    return { pass: false, detail: `${id}: ${res.error} (${diffs.length} samples)`, metrics };
  }
  // A direct case is timed from the trigger click to the end of its animations (scene: screen-in/screen-out; modal:
  // the dialog's appear and backdrop fade-in). The screenshot settle is a diagnostic only: its sampling cost is the host's.
  const ms = direct ? await sceneEnd(page, direct) : res.ms;
  if (ms === null) return { pass: false, detail: `${id}: no ${direct} animation ended after the trigger`, metrics };
  metrics["motion.transition.ms"] = ms;
  if (direct) metrics["motion.screenshot.ms"] = res.error ? null : res.ms;
  // The destination must be there: a transition that settles on the wrong screen fails.
  const reached = await arrived().then(
    () => true,
    () => false,
  );
  const shotNote = direct ? `screenshot settle ${res.error ? "not reached" : `${res.ms} ms`}` : `change began at ${res.startMs} ms`;
  const detail =
    `${id} ${direct ? "animation ended" : "settled"} at ${ms} ms, limit ${limit} ms; ${diffs.length} samples, median ${metrics["motion.sample.ms"]} ms apart; `
    + `${shotNote}${reached ? "" : "; destination not reached"}`;
  return { pass: reached && ms <= limit, detail, metrics };
}

/** Opens the menu with a valid guest name and waits for it to load. Janky mode stretches animations. */
async function openMenu(s, label) {
  const h = await s.open(label, { name: uniqueName("motion") });
  await h.page.goto(s.base);
  await menuName(h.page).waitFor();
  await sleep(SETTLE_SETUP_MS);
  if (mode === "janky") await h.page.addStyleTag({ content: JANKY });
  return h;
}

/** Menu -> Browse -> create-room form (the form is open, nothing submitted). */
async function openCreateForm(page) {
  await playFromMenu(page, null);
  await button(page, "New room").click();
  await page.getByRole("heading", { name: "Create a room", exact: true }).waitFor({ state: "visible" });
  await page.getByLabel("room name", { exact: true }).fill(uniqueName("room"));
}

/** Installs a per-frame reader of the current page's shared chrome (head box, Back, title, primary column) into window.__chrome; window.__chromeSel says which elements (set per page). */
function installChromeSampler() {
  const geom = () => {
    const sel = window.__chromeSel;
    const pg = [...document.querySelectorAll(sel.scope)].find((p) => !p.parentElement.closest(sel.scope) && !p.closest(".screen-out"));
    if (!pg) return null;
    const box = (el) => {
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { x: b.x, y: b.y, r: b.right };
    };
    return {
      head: box(pg.querySelector(sel.head)),
      back: box(pg.querySelector(sel.back)),
      title: box(pg.querySelector(sel.title)),
      column: box(pg.querySelector(sel.column)),
    };
  };
  window.__chromeSel = null;
  window.__chrome = [];
  const tick = () => {
    window.__chrome.push({ g: window.__chromeSel ? geom() : null });
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/** Largest displacement of shared chrome between two geometries. Title width varies with its text, so only its origin counts; the column's right edge counts too. */
function chromeDelta(a, b) {
  if (!a || !b) return Infinity;
  let max = 0;
  for (const k of ["head", "back", "title", "column"]) {
    const p = a[k];
    const q = b[k];
    if (!p || !q) return Infinity;
    for (const f of k === "column" ? ["x", "y", "r"] : ["x", "y"]) max = Math.max(max, Math.abs(p[f] - q[f]));
  }
  return max;
}

/** A sampled frame has every shared element (none missing mid-swap). */
function chromeComplete(g) {
  return !!g && ["head", "back", "title", "column"].every((k) => g[k]);
}

const PAGE_SEL = { scope: "#ui .page", head: ":scope > .page-head", back: ".page-back", title: ".page-head h1", column: ":scope > .page-inner" };

// `own` screens are full-screen tools or games with their own bar: their chrome is not compared with Browse rooms
// at rest (a different layout by design); only travel is checked, against their own settled geometry.
const CHROME_PAGES = [
  { id: "browse", title: "Browse rooms", sel: PAGE_SEL, open: (p) => navTo(p, "Browse rooms") },
  { id: "quick", title: "Quick play", sel: PAGE_SEL, open: (p) => navTo(p, "Quick play") },
  { id: "settings", title: "Settings", sel: PAGE_SEL, open: (p) => navTo(p, "Settings") },
  { id: "account", title: "Account", sel: PAGE_SEL, open: (p) => navTo(p, "Profile") },
  { id: "library", title: "Library", sel: PAGE_SEL, open: (p) => navTo(p, "Library") },
  { id: "practice", title: "Practice", sel: PAGE_SEL, open: (p) => navTo(p, "Practice") },
  { id: "about", title: "About neobox", sel: PAGE_SEL, open: (p) => navTo(p, "About") },
  { id: "friends", title: "Friends", sel: PAGE_SEL, open: (p) => navTo(p, "Friends") },
  {
    id: "editor",
    own: true,
    sel: { scope: "#ui .screen.editor", head: ".editor-top", back: ".editor-top > button", title: ".editor-top input", column: ".editor-stage" },
    ready: (p) => p.locator("#ui .editor-top input"),
    open: (p) => navTo(p, "Map editor"),
    leave: (p) => p.locator("#ui .editor-top > button").first().click(),
  },
  {
    id: "training",
    own: true,
    sel: { scope: "#ui .offline.playing", head: ".offline-top", back: ".offline-top > button", title: ".offline-title", column: ".training-lesson" },
    ready: (p) => p.locator("#ui .offline-top .offline-title"),
    open: (p) => navTo(p, "Training"),
    leave: (p) => p.locator("#ui .offline-top > button").first().click(),
  },
];

/** Back to the menu from a page: its Back control (or `leave`), then the menu's destination drum. */
async function backToMenu(page, leave) {
  if (leave) await leave(page);
  else {
    const back = page.locator("#ui .page-back");
    if (await back.count()) await back.first().click();
    else await button(page, "Back").first().click();
  }
  await drumOption(page, "Browse rooms").waitFor({ state: "visible", timeout: MAX_MS });
  await sleep(CHROME_SETTLE_MS);
}

/**
 * Menu -> each page -> Back. The first page (Browse rooms) is the reference; every page's chrome must
 * sit where it does there (motion.chromeShift.px, after settle), and must not travel while it changes
 * (motion.chromeTravel.px, sampled every frame).
 */
async function chromePages(s) {
  const { page } = await openMenu(s, "chrome");
  if (mode === "chromejump") await page.addStyleTag({ content: CHROMEJUMP });
  await page.evaluate(installChromeSampler);
  let ref = null;
  let shift = 0;
  let travel = 0;
  const lines = [];
  for (const p of CHROME_PAGES) {
    await page.evaluate((sel) => {
      window.__chromeSel = sel;
      window.__chrome.length = 0;
    }, p.sel);
    await p.open(page);
    if (p.ready) await p.ready(page).waitFor({ state: "visible", timeout: MAX_MS });
    else await page.locator("#ui .page-head h1", { hasText: p.title }).waitFor({ state: "visible", timeout: MAX_MS });
    await sleep(CHROME_SETTLE_MS);
    const frames = await page.evaluate(() => window.__chrome.splice(0));
    const ready = frames.filter((f) => chromeComplete(f.g));
    const settled = ready.at(-1)?.g ?? null;
    if (!settled) return { pass: false, detail: `${p.id}: no page chrome found` };
    // Travel: every frame of the change against this screen's own settled chrome.
    const dTravel = ready.reduce((m, f) => Math.max(m, chromeDelta(f.g, settled)), 0);
    travel = Math.max(travel, dTravel);
    let rest = "own layout, not compared with Browse rooms";
    if (!p.own) {
      ref ??= settled;
      const dShift = chromeDelta(settled, ref);
      shift = Math.max(shift, dShift);
      rest = `${round(dShift)} px at rest`;
    }
    lines.push(`${p.id} ${rest}, ${round(dTravel)} px in flight (${frames.length - ready.length} frames without page chrome)`);
    await backToMenu(page, p.leave);
  }
  const metrics = {
    "motion.chromeShift.px": round(shift),
    "motion.chromeTravel.px": round(travel),
    "motion.chromeShift.limit": CHROME_SHIFT_PX,
    "motion.chromeTravel.limit": CHROME_TRAVEL_PX,
  };
  const pass = shift <= CHROME_SHIFT_PX && travel <= CHROME_TRAVEL_PX;
  return { pass, detail: `chrome vs Browse rooms: ${lines.join("; ")}`, metrics };
}

const CASES = [
  {
    id: "ui.modal.open.news",
    limit: 300,
    run: async (s) => {
      const { page } = await openMenu(s, "news");
      const dialog = page.getByRole("dialog", { name: "Update news" });
      await rollDrum(page, "News");
      return measure(page, {
        id: "ui.modal.open.news",
        limit: 300,
        direct: "modal",
        liveSquare: true,
        trigger: () => drumOption(page, "News").evaluate((el) => el.click()),
        arrived: () => dialog.waitFor({ state: "visible", timeout: MAX_MS }),
      });
    },
  },
  {
    id: "ui.modal.close.news",
    limit: 300,
    run: async (s) => {
      const { page } = await openMenu(s, "newsclose");
      const dialog = page.getByRole("dialog", { name: "Update news" });
      await navTo(page, "News");
      await dialog.waitFor({ state: "visible" });
      await sleep(SETTLE_SETUP_MS);
      return measure(page, {
        id: "ui.modal.close.news",
        limit: 300,
        direct: "modal-out",
        liveSquare: true,
        trigger: () => page.keyboard.press("Escape"),
        arrived: () => dialog.waitFor({ state: "detached", timeout: MAX_MS }),
      });
    },
  },
  {
    id: "ui.modal.open.createRoom",
    limit: 300,
    run: async (s) => {
      const { page } = await openMenu(s, "newroom");
      await playFromMenu(page, null);
      await button(page, "New room").waitFor({ state: "visible" });
      await sleep(SETTLE_SETUP_MS);
      const form = page.getByRole("heading", { name: "Create a room", exact: true });
      return measure(page, {
        id: "ui.modal.open.createRoom",
        limit: 300,
        direct: "modal",
        trigger: () => button(page, "New room").evaluate((el) => el.click()),
        arrived: () => form.waitFor({ state: "visible", timeout: MAX_MS }),
      });
    },
  },
  {
    id: "scene.menu.browse",
    limit: 400,
    run: async (s) => {
      const { page } = await openMenu(s, "browse");
      await rollDrum(page, "Browse rooms");
      return measure(page, {
        id: "scene.menu.browse",
        direct: "screen-in",
        limit: 400,
        trigger: () => drumOption(page, "Browse rooms").evaluate((el) => el.click()),
        arrived: () => button(page, "New room").waitFor({ state: "visible", timeout: MAX_MS }),
      });
    },
  },
  {
    id: "scene.browse.room",
    limit: 400,
    run: async (s) => {
      const { page } = await openMenu(s, "room");
      await openCreateForm(page);
      await sleep(SETTLE_SETUP_MS);
      const lobby = button(page, "Start");
      return measure(page, {
        id: "scene.browse.room",
        direct: "screen-in",
        limit: 400,
        trigger: () => button(page, "Create room").evaluate((el) => el.click()),
        arrived: () => lobby.waitFor({ state: "visible", timeout: MAX_MS }),
      });
    },
  },
  {
    id: "scene.room.match",
    limit: 400,
    run: async (s) => {
      const { page } = await openMenu(s, "match");
      await openCreateForm(page);
      await button(page, "Create room").click();
      await button(page, "Start").waitFor({ state: "visible" });
      await ensureRoomMap(page);
      await sleep(SETTLE_SETUP_MS);
      const hud = page.locator(".hud-leave");
      return measure(page, {
        id: "scene.room.match",
        direct: "screen-in",
        limit: 400,
        trigger: () => button(page, "Start").evaluate((el) => el.click()),
        arrived: () => hud.waitFor({ state: "visible", timeout: MAX_MS }),
      });
    },
  },
  {
    id: "chrome.pages",
    run: chromePages,
  },
];

for (const engine of selectedEngines()) {
  const browser = await launchEngine(engine);
  const results = new Results("motion", engine);
  for (const c of CASES) {
    const srv = await startServer();
    await results.case(c.id, (s) => c.run(s), { browser, base: srv.base });
  }
  results.save();
}

writeIndex();
await runCleanups();
