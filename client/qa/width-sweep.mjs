// Width sweep: CSS widths 280..3840 in steps of 20, at each height in HEIGHTS, mouse profile at
// devicePixelRatio 1 (layout only; touch splash and DPR left out on purpose). Separate from the
// rubric plan in plan.mjs. Each geometry is a row object, so captures land under <out>/<engine>/<theme>/W<W>x<H>/.
//
// Usage (from client/): bun qa/width-sweep.mjs --dist <build dir> [--engines chromium] [--themes light]
//   [--states menu-anon,room-host] [--jobs 3] [--out DIR]   (default out: neobox-scratch/qa/width-sweep)

import { cliArg, requireDist, runSweep } from "./sweep.mjs";
import { writeSummary } from "./summarize.mjs";

export const WIDTHS = Array.from({ length: (3840 - 280) / 20 + 1 }, (_, i) => 280 + 20 * i);
export const HEIGHTS = [480, 800, 1200];
export const WIDTH_SWEEP_OUT = "C:/Users/aggressivecombo/neobox-scratch/qa/width-sweep";

const rows = WIDTHS.flatMap((W) => HEIGHTS.map((H) => ({ id: `W${W}x${H}`, W, H, dsf: 1, input: "M" })));

requireDist();
const engines = cliArg("engines", "chromium").split(",").map((s) => s.trim());
const themes = cliArg("themes", "light").split(",").map((s) => s.trim());
const states = cliArg("states", "menu-anon,room-host").split(",").map((s) => s.trim());
const jobs = Number(cliArg("jobs", "3"));
const outRoot = cliArg("out", WIDTH_SWEEP_OUT);

const cells = [];
for (const state of states)
  for (const engine of engines)
    for (const theme of themes)
      for (const row of rows) cells.push({ tier: "W", state, engine, theme, row, axis: "none", renderer: null });

const results = await runSweep({ cells, jobs, outRoot });
const passed = results.filter((r) => r.failures.length === 0).length;
await writeSummary(outRoot);
console.log(`${passed}/${results.length} width-sweep captures pass; summary in ${outRoot}/summary.md`);
