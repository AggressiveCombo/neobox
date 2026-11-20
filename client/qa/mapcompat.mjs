// Map-compat instrument: the camera's view stays inside the arena on every map, as the original's does.
// The original clamps its view to the arena (the playable area), so a map's bodies below or beside the arena
// (its digit drums, its static ground) are not framed. Ground truth is the camera's published view (globalThis.__qaCam,
// src/camera.ts: cx, cy, w, h and the arena aw, ah) sampled every animation frame while the player plays the map.
//
// Rule checked per frame (EPS 1e-3 world units):
//   - an axis whose arena is longer than the view: the view lies inside the arena on that axis;
//   - an axis whose arena fits the base view (the map's Screen width, set "3", and its height by the aspect): the view
//     is centred on the arena on that axis.
// Maps: every compact map JSON in the repo's maps/ directory, plus the ';'-separated paths in QA_MAPS (e.g. a community map).
// The map is loaded as a map code (base64 of the deflated JSON, as Practice > Map code > Use code takes it).
//
// Usage:  cd client && QA_OUT=<dir> node qa/mapcompat.mjs --dist <dist>     (QA_ENGINES narrows engines)
// Env:    QA_MAPS (extra map JSON paths), QA_CAM_MS (6000: sampling time per map).
// Self-test (QA_SELF_TEST=bounds, use a separate QA_OUT): every sample's view is moved one view height below the arena;
// each case must FAIL.

import { deflateSync } from "node:zlib";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { Results, QA_DIR, launchEngine, navTo, runCleanups, selectedEngines, sleep, startServer, writeIndex, button, menuName, selfTestMode } from "./lib-qa.mjs";

const EPS = 1e-3;
const CAM_MS = Number(process.env.QA_CAM_MS ?? 6000);
const REPO_MAPS = path.resolve(QA_DIR, "../../maps");

/** Map files to check: the repo's compact maps, then QA_MAPS. */
function mapFiles() {
  const files = existsSync(REPO_MAPS) ? readdirSync(REPO_MAPS).filter((f) => f.endsWith(".json")).map((f) => path.join(REPO_MAPS, f)) : [];
  for (const p of (process.env.QA_MAPS ?? "").split(";").map((s) => s.trim()).filter(Boolean)) files.push(p);
  return files;
}

/** A map JSON file as the code Practice takes: base64 of the deflated JSON. */
function mapCode(file) {
  const json = JSON.parse(readFileSync(file, "utf8"));
  return { code: deflateSync(JSON.stringify(json)).toString("base64"), baseWidth: Number(json.set?.["3"] ?? 30) };
}

/** Practice: the map by code, started; the player is playing when this returns. */
async function startCodePractice(page, base, code) {
  await page.goto(base);
  await menuName(page).waitFor({ timeout: 15000 });
  await navTo(page, "Practice");
  await page.getByPlaceholder("Map code", { exact: true }).fill(code);
  await button(page, "Use code").click();
  await button(page, "Start").click({ timeout: 15000 });
  await page.locator(".offline.playing").waitFor({ timeout: 15000 });
}

/** Samples the published camera once per animation frame for `ms`, while `act` runs. */
async function sampleCamera(page, ms, act) {
  const sampling = page.evaluate(
    (dur) =>
      new Promise((resolve) => {
        const out = [];
        const t0 = performance.now();
        const frame = () => {
          const c = globalThis.__qaCam;
          if (c && c.w > 0) out.push({ cx: c.cx, cy: c.cy, w: c.w, h: c.h, aw: c.aw, ah: c.ah, tick: c.tick });
          if (performance.now() - t0 < dur) requestAnimationFrame(frame);
          else resolve(out);
        };
        requestAnimationFrame(frame);
      }),
    ms,
  );
  await act();
  return sampling;
}

/** The player walks, drops and jumps about the map, so the view meets the arena's edges (keys: prefs.ts DEFAULT_KEYS). */
async function playAround(page, ms) {
  const hold = async (keys, t) => {
    for (const k of keys) await page.keyboard.down(k);
    await sleep(t);
    for (const k of keys) await page.keyboard.up(k);
  };
  const end = Date.now() + ms;
  const steps = [["ArrowDown"], ["ArrowRight"], ["ArrowUp", "ArrowRight"], ["ArrowLeft"], ["ArrowDown", "ArrowLeft"], ["ArrowUp"]];
  for (let i = 0; Date.now() < end; i++) await hold(steps[i % steps.length], 900);
}

/** Per-frame check of one map's samples; returns the counts and the lowest margins (negative = outside the arena). */
function judge(samples, baseWidth) {
  let outside = 0;
  let offCentre = 0;
  let minLeft = Infinity;
  let minBottom = Infinity;
  const detail = [];
  for (const s0 of samples) {
    const s = process.env.QA_SELF_TEST === "bounds" ? { ...s0, cy: s0.ah + s0.h } : s0;
    const aspect = s.w / s.h;
    const baseH = baseWidth / aspect;
    const bad = [];
    if (s.w <= s.aw) {
      minLeft = Math.min(minLeft, s.cx - s.w / 2);
      if (s.cx - s.w / 2 < -EPS || s.cx + s.w / 2 > s.aw + EPS) bad.push("x");
    }
    if (s.h <= s.ah) {
      minBottom = Math.min(minBottom, s.ah - (s.cy + s.h / 2));
      if (s.cy - s.h / 2 < -EPS || s.cy + s.h / 2 > s.ah + EPS) bad.push("y");
    }
    if (s.aw <= baseWidth && Math.abs(s.cx - s.aw / 2) > EPS) bad.push("centreX");
    if (s.ah <= baseH && Math.abs(s.cy - s.ah / 2) > EPS) bad.push("centreY");
    if (bad.length) {
      outside++;
      if (detail.length < 3) detail.push({ tick: s.tick, bad: bad.join(","), cx: +s.cx.toFixed(3), cy: +s.cy.toFixed(3), w: +s.w.toFixed(3), h: +s.h.toFixed(3), aw: s.aw, ah: s.ah });
    }
  }
  return { outside, detail, minLeft, minBottom };
}

const engines = selectedEngines();
const maps = mapFiles().map((file) => ({ file, id: path.basename(file, ".json"), ...mapCode(file) }));
const selfTest = selfTestMode();

for (const engine of engines) {
  const browser = await launchEngine(engine);
  const results = new Results("mapcompat", engine);
  const srv = await startServer();
  for (const map of maps) {
    const rec = await results.case(
      `camera.${map.id}`,
      async (s) => {
        const h = await s.open("player");
        await startCodePractice(h.page, srv.base, map.code);
        const samples = await sampleCamera(h.page, CAM_MS, () => playAround(h.page, CAM_MS));
        if (samples.length < 60) return { pass: false, detail: `only ${samples.length} camera frames` };
        const j = judge(samples, map.baseWidth);
        const metrics = {
          "mapcompat.camera.outside.frames": j.outside,
          "mapcompat.camera.frames": samples.length,
          "mapcompat.camera.minLeftMarginWu": Number.isFinite(j.minLeft) ? +j.minLeft.toFixed(3) : null,
          "mapcompat.camera.minBottomMarginWu": Number.isFinite(j.minBottom) ? +j.minBottom.toFixed(3) : null,
        };
        return {
          pass: j.outside === 0,
          metrics,
          detail: j.outside ? `outside frames=${j.outside}/${samples.length} first=${JSON.stringify(j.detail)}` : `frames=${samples.length} inside arena and centred`,
        };
      },
      { browser, base: srv.base },
    );
    console.log(`${rec.verdict?.toUpperCase?.() ?? (rec.pass ? "PASS" : "FAIL")} ${engine} ${map.id} ${rec.detail ?? ""}`);
  }
  await srv.stop();
  results.save();
}
writeIndex();
await runCleanups();
if (selfTest) console.log(`self-test ${selfTest}: every case above must be FAIL`);
