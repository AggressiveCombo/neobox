// Orientation instrument (rubric D04, orientation.locked). Each state is prepared on a phone-emulated page at the
// T3-T portrait row (390x844), then rotated to landscape (844x390) and back. The page must follow the rotation:
// content shows in both orientations, the portrait rotate gate (match only) has a dismiss control, the landscape view
// shows no gate, and the heading survives the round trip. Any miss sets orientation.locked = 1.
//
// Chromium and webkit rotate live (setViewportSize). Firefox cannot be trusted to keep its phone page across a live
// resize, so the landscape leg is prepared again in a fresh landscape context; the return leg is then not observed
// (rotate.backMeasured = 0).
//
// Usage (from client/): bun qa/orientation.mjs --dist <build dir> --out <dir>
//   [--engines chromium,webkit,firefox] [--states menu-anon,room-host,match-running,editor-empty] [--theme light]
// Self-test: ORIENT_SELF_TEST=lock hides the page in landscape (a portrait-only lock). Every record must then have
// orientation.locked = 1, or the run exits 1.
// Records: <out>/<engine>/<theme>/T3-T-rotate/<state>.json, plus <state>-landscape.png.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { cliArg, requireDist } from "./sweep.mjs";

requireDist();
const { startServer, launchEngine, runCleanups, dismissPhoneSplash, sleep } = await import("../e2e/lib.mjs");
const { QaScenario, THEMES } = await import("./capture.mjs");
const { stateById } = await import("./states.mjs");
const { rowById, isTouch } = await import("./presets.mjs");

const PORTRAIT = rowById("T3-T");
const LANDSCAPE = { ...PORTRAIT, id: "T3-T-L", W: PORTRAIT.H, H: PORTRAIT.W };
const SELF_TEST = process.env.ORIENT_SELF_TEST === "lock";
const outRoot = cliArg("out", null);
if (!outRoot) throw new Error("no output: pass --out <dir>");
const engines = cliArg("engines", "chromium,webkit,firefox").split(",");
const stateIds = cliArg("states", "menu-anon,room-host,match-running,editor-empty").split(",");
const theme = cliArg("theme", "light");
if (!THEMES[theme]) throw new Error(`unknown theme "${theme}"`);

const GATE_NAME = "Turn your phone sideways";

/** Waits for the boot screen to clear and the page to go quiet. */
async function idle(page) {
  await page.waitForFunction(() => {
    const boot = document.getElementById("boot");
    return boot === null || boot.hidden;
  });
  await sleep(500);
}

/** What is on screen now: visible controls and canvases in the viewport, the first visible heading, and the rotate gate. */
async function measure(page) {
  const dom = await page.evaluate(() => {
    const vw = innerWidth;
    const vh = innerHeight;
    const shown = (el) => {
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return false;
      if (r.right <= 0 || r.bottom <= 0 || r.left >= vw || r.top >= vh) return false;
      const cs = getComputedStyle(el);
      return cs.visibility !== "hidden" && cs.display !== "none" && cs.opacity !== "0";
    };
    const controls = [...document.querySelectorAll("button, a[href], input, select, textarea, [role=button], [role=tab]")].filter(shown).length;
    const canvases = [...document.querySelectorAll("canvas")].filter(shown).length;
    const heading = [...document.querySelectorAll("h1, h2")].find(shown)?.textContent?.trim() ?? null;
    return { vw, vh, scale: visualViewport.scale, controls, canvases, heading };
  });
  const gateEl = page.locator(".hud-rotate:not([hidden])").first();
  const gate = await gateEl.isVisible().catch(() => false);
  let gateButtons = 0;
  if (gate) {
    const n = await gateEl.locator("button").count();
    for (let i = 0; i < n; i++) if (await gateEl.locator("button").nth(i).isVisible().catch(() => false)) gateButtons++;
  }
  return { ...dom, gate, gateButtons, content: dom.controls + dom.canvases };
}

/** Self-test only: a portrait-only lock, the page hidden in landscape, so the content cannot follow the rotation. */
async function injectPortraitLock(page) {
  if (SELF_TEST) await page.addStyleTag({ content: "@media (orientation: landscape) { body { display: none !important; } }" });
}

/** The reasons the page fails to follow the rotation (empty when it follows). */
function reasons(P0, L, P1) {
  const out = [];
  if (P0.gate && P0.gateButtons === 0) out.push("portrait rotate gate has no dismiss control");
  if (P0.content === 0) out.push("portrait shows no content");
  if (L.gate) out.push("landscape shows the rotate gate");
  if (L.content === 0) out.push("landscape shows no content");
  if (P1 && P1.content === 0) out.push("back in portrait shows no content");
  if (P1 && (P1.vw !== PORTRAIT.W || P1.scale !== 1)) out.push(`back in portrait: layout ${P1.vw}px wide at scale ${P1.scale.toFixed(2)}, expected ${PORTRAIT.W}px at 1`);
  if (P1 && P0.heading !== null && P1.heading !== P0.heading) out.push(`heading changed: "${P0.heading}" -> "${P1.heading}"`);
  return out;
}

/** Prepares a state on one row and returns its handle's page, after the phone splash and boot settle. */
async function prepareOn(state, scenario, row) {
  const h = await state.prepare(scenario);
  if (isTouch(row) && !state.splash) await dismissPhoneSplash(h.page);
  await idle(h.page);
  await injectPortraitLock(h.page);
  return h.page;
}

const errText = (err) => (err instanceof Error ? err.message.split("\n")[0] : String(err));

/** Resizes the page and waits until the layout viewport reports the new size (the resize event is async). */
async function rotateTo(page, row) {
  await page.setViewportSize({ width: row.W, height: row.H });
  await page.waitForFunction(([w, h]) => innerWidth === w && innerHeight === h, [row.W, row.H], { timeout: 5000 }).catch(() => undefined);
  await sleep(400);
}

/** One state on one engine. Chromium and webkit rotate live; firefox measures the landscape leg in a fresh context. */
async function runState(engine, browser, base, stateId) {
  const state = stateById(stateId);
  const live = engine !== "firefox";
  const dir = path.join(outRoot, engine, theme, "T3-T-rotate");
  mkdirSync(dir, { recursive: true });
  const record = {
    engine,
    theme,
    row: PORTRAIT.id,
    axis: "none",
    renderer: null,
    viewport: { W: PORTRAIT.W, H: PORTRAIT.H },
    dsf: PORTRAIT.dsf,
    state: state.id,
    metrics: {},
    details: {},
    info: { self_test: SELF_TEST ? "lock" : null, live },
  };
  let P0 = null;
  let L = null;
  let P1 = null;
  const cap = { engine, theme, row: PORTRAIT, axis: "none", renderer: null };
  const s = new QaScenario(state.id, { base, browser }, cap);
  try {
    const page = await prepareOn(state, s, PORTRAIT);
    P0 = await measure(page);
    if (live) {
      await rotateTo(page, LANDSCAPE);
      L = await measure(page);
      await page.screenshot({ animations: "disabled", caret: "hide", path: path.join(dir, `${state.id}-landscape.png`) });
      await rotateTo(page, PORTRAIT);
      P1 = await measure(page);
      await page.screenshot({ animations: "disabled", caret: "hide", path: path.join(dir, `${state.id}-back.png`) });
      if (L.vw !== LANDSCAPE.W) throw new Error(`landscape viewport is ${L.vw} wide, expected ${LANDSCAPE.W}`);
    }
  } catch (err) {
    record.error = errText(err);
  } finally {
    await s.close();
  }
  if (!live && P0 && !record.error) {
    const sL = new QaScenario(`${state.id}-L`, { base, browser }, { ...cap, row: LANDSCAPE });
    try {
      const page = await prepareOn(state, sL, LANDSCAPE);
      L = await measure(page);
      if (L.vw !== LANDSCAPE.W) throw new Error(`landscape context is ${L.vw} wide`);
      await page.screenshot({ animations: "disabled", caret: "hide", path: path.join(dir, `${state.id}-landscape.png`) });
    } catch (err) {
      record.error = errText(err);
    } finally {
      await sL.close();
    }
  }
  if (!record.error) {
    const why = reasons(P0, L, P1);
    record.metrics["orientation.locked"] = why.length ? 1 : 0;
    record.metrics["rotate.backMeasured"] = live ? 1 : 0;
    record.details = { reasons: why, portrait: P0, landscape: L, back: P1 };
  }
  writeFileSync(path.join(dir, `${state.id}.json`), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

const server = await startServer();
const results = [];
try {
  for (const engine of engines) {
    const browser = await launchEngine(engine);
    try {
      for (const id of stateIds) {
        const record = await runState(engine, browser, server.base, id);
        results.push(record);
        const why = record.error ? `error: ${record.error}` : record.details.reasons.join("; ") || "follows";
        console.log(`${engine} ${id}: orientation.locked=${record.metrics["orientation.locked"] ?? "n/a"} ${why}`);
      }
    } finally {
      await browser.close().catch(() => {});
    }
  }
} finally {
  await runCleanups();
}

if (SELF_TEST) {
  const missed = results.filter((r) => !r.error && r.metrics["orientation.locked"] !== 1);
  const errored = results.filter((r) => r.error);
  if (missed.length || errored.length) {
    console.error(`self-test FAILED: ${missed.length} record(s) did not fail as required, ${errored.length} errored`);
    process.exit(1);
  }
  console.log(`self-test PASSED: orientation.locked = 1 in all ${results.length} record(s)`);
}
