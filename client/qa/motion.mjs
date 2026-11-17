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
//
// Keys: motion.transition.ms (settle time, absent when not settled), motion.transition.limit,
// motion.samples (screenshots taken), motion.sample.ms (median interval between samples),
// motion.cssEnd.ms (in-page cross-check: longest remaining finite CSS animation or transition at the
// trigger, from document.getAnimations), motion.masked.px (idle-animated pixels excluded).
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
import { ensureRoomMap, playFromMenu } from "../e2e/lib.mjs";

const mode = selfTestMode();
const CHANGE = 0.005; // RUBRIC D20: change below 0.5% of region pixels
const PIXEL_DELTA = 24; // per-pixel sum of |channel delta|: the same test as image.mjs differingPixels
const MAX_MS = 3000; // a transition that is not stable by then fails
const SETTLE_SETUP_MS = 600; // let load-time animations finish before the reference frame
const BASELINE_MS = 250; // idle gap between the two baseline frames that find animated pixels
const JANKY = "*{animation-duration:1500ms!important;transition-duration:1500ms!important}";

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

/**
 * Measures one transition. `trigger` performs the action; `arrived` rejects unless the destination
 * is on screen. Never throws for a slow or unstable transition: returns pass false with a detail.
 */
async function measure(page, { id, limit, trigger, arrived }) {
  const shot = () => page.screenshot({ animations: "allow", caret: "hide", timeout: 8000 });
  // Two idle frames before the trigger: pixels that still move between them are masked for the case.
  const idle = decode(await shot());
  await page.waitForTimeout(BASELINE_MS);
  const ref = decode(await shot());
  const { mask, masked } = animatedMask(idle, ref);
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
  if (res.error) {
    return { pass: false, detail: `${id}: ${res.error} (${diffs.length} samples)`, metrics };
  }
  metrics["motion.transition.ms"] = res.ms;
  // The destination must be there: a transition that settles on the wrong screen fails.
  const reached = await arrived().then(
    () => true,
    () => false,
  );
  const detail =
    `${id} settled at ${res.ms} ms, limit ${limit} ms; ${diffs.length} samples, median ${metrics["motion.sample.ms"]} ms apart; `
    + `change began at ${res.startMs} ms${reached ? "" : "; destination not reached"}`;
  return { pass: reached && res.ms <= limit, detail, metrics };
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

const CASES = [
  {
    id: "ui.modal.open.news",
    limit: 300,
    run: async (s) => {
      const { page } = await openMenu(s, "news");
      const dialog = page.getByRole("dialog", { name: "Update news" });
      return measure(page, {
        id: "ui.modal.open.news",
        limit: 300,
        trigger: () => button(page, "News").click(),
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
      await button(page, "News").click();
      await dialog.waitFor({ state: "visible" });
      await sleep(SETTLE_SETUP_MS);
      return measure(page, {
        id: "ui.modal.close.news",
        limit: 300,
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
        trigger: () => button(page, "New room").click(),
        arrived: () => form.waitFor({ state: "visible", timeout: MAX_MS }),
      });
    },
  },
  {
    id: "scene.menu.browse",
    limit: 400,
    run: async (s) => {
      const { page } = await openMenu(s, "browse");
      return measure(page, {
        id: "scene.menu.browse",
        limit: 400,
        trigger: () => button(page, "Browse rooms").click(),
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
        limit: 400,
        trigger: () => button(page, "Create room").click(),
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
        limit: 400,
        trigger: () => button(page, "Start").click(),
        arrived: () => hud.waitFor({ state: "visible", timeout: MAX_MS }),
      });
    },
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
