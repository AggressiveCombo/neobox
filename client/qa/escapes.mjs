// Escape table runner: runs every temporal detector (temporal.mjs DETECTORS) twice per engine and
// writes one row per escape E01-E12: both run values, whether the two runs agree, and the verdict.
// Escapes without a detector are listed as "not built" so the table covers all twelve.
//
// Usage:  cd client && QA_OUT=<dir> node qa/escapes.mjs --dist <dist> [--src <src dir>]
//         Run once per build (pre and post fix) and compare the tables.
//         --src is the source tree the copy-claims check reads (default: the client repo src).

import path from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { Results, launchEngine, outDir, runCleanups, selectedEngines, startServer, writeIndex } from "./lib-qa.mjs";
import { DETECTORS, runOne } from "./temporal.mjs";

const ESCAPES = [
  ["E01", "replay camera jitter", "motion.jitter.count"],
  ["E02", "camera drift when idle", "camera.static.drift.px"],
  ["E03", "full-screen flash on replay close", "motion.fullFlash.count"],
  ["E04", "HUD overlap over the game arena", "overlay.hud.overlap"],
  ["E05", "readable-font pref changes text metrics", "font.pref.metricDelta"],
  ["E06", "render order (label over the followed marker)", "overlay.marker.underLabel"],
  ["E07", "unsourced copy claims", "copy.claims.unsourced"],
  ["E08", "transition missing", "transition.present"],
  ["E09", "scroll target offset in settings", "scroll.target.offset"],
  ["E10", "layout shift on nav Next and on toast", "layout.navShift.px"],
  ["E11", "prompted input does not react", "interaction.promptedInput.reacts"],
  ["E12", "editor drag performance", "editor.perf.dragP95ms"],
];

const argv = process.argv.slice(2);
let src;
for (let i = 0; i < argv.length; i++) if (argv[i] === "--src") src = argv[++i];

const rows = [];
for (const engine of selectedEngines()) {
  const browser = await launchEngine(engine);
  const results = new Results("escapes", engine);
  const srv = await startServer();
  for (const det of DETECTORS) {
    const runs = [];
    for (let k = 0; k < 2; k++) runs.push(await runOne(det, { browser, base: srv.base, results, src }));
    const values = runs.map((r) => r.metrics?.[det.key] ?? null);
    const [a, b] = values;
    const big = Math.max(Math.abs(a ?? 0), Math.abs(b ?? 0));
    // Timing values vary run to run; counts must match exactly, and a timing value of 10+ may differ by 10%.
    const same = a === b || (Number.isFinite(a) && Number.isFinite(b) && big >= 10 && Math.abs(a - b) <= 0.1 * big);
    const stable = same && runs[0].verdict === runs[1].verdict;
    rows.push({
      engine,
      escape: det.escape,
      key: det.key,
      run1: values[0],
      run2: values[1],
      stable,
      verdict: stable ? runs[0].verdict.toUpperCase() : "UNSTABLE",
      detail: runs[0].detail ?? null,
    });
  }
  await srv.stop();
  results.save();
}

for (const [escape, desc, key] of ESCAPES) {
  if (rows.some((r) => r.escape === escape)) continue;
  rows.push({ engine: "-", escape, key, run1: null, run2: null, stable: null, verdict: "NOT BUILT", detail: desc });
}
rows.sort((a, b) => a.escape.localeCompare(b.escape) || a.engine.localeCompare(b.engine));

const cell = (v) => (v === null || v === undefined ? "n/a" : String(v));
const lines = [
  "| escape | engine | key | run1 | run2 | stable | verdict | detail |",
  "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ...rows.map((r) => `| ${r.escape} | ${r.engine} | ${r.key ?? "-"} | ${cell(r.run1)} | ${cell(r.run2)} | ${cell(r.stable)} | ${r.verdict} | ${cell(r.detail)} |`),
];
const dir = path.join(outDir(), "escapes");
mkdirSync(dir, { recursive: true });
writeFileSync(path.join(dir, "escapes.json"), `${JSON.stringify(rows, null, 2)}\n`);
writeFileSync(path.join(dir, "escapes.md"), `${lines.join("\n")}\n`);
console.log(lines.join("\n"));
writeIndex();
await runCleanups();
