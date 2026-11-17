// Runs the rubric capture plan (plan.mjs) and writes summary.json and summary.md. Headless only.
//
// Usage (from client/): bun qa/sweep.mjs --dist <build dir> [--plan] [--tiers P,F,A,S] [--states a,b]
//   [--rows T1-M,...] [--engines chromium,firefox,webkit] [--themes light,dark] [--jobs 3] [--out DIR] [--label NAME] [--resume]
// --resume reuses the records already in --out: a cell with a clean <state>.json is skipped; an errored one is recaptured.
// --dist (or NEOBOX_DIST) is required: there is no default build. --plan prints the coverage per tier
// against the rubric counts and runs nothing. Default out: neobox-scratch/qa/capture/<dist basename>.
// Cells the engine cannot run (notch rows, webgpu) are never planned; see plan.mjs.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EXPECTED, EXPECTED_TOTAL, describeTier, filterCells, planCells, uniqueRuns } from "./plan.mjs";
import { validateRecord } from "./thresholds.mjs";
import { writeSummary } from "./summarize.mjs";

/** Value of `--name value` in argv, or the fallback. */
export function cliArg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

/**
 * The build directory for this run: --dist or NEOBOX_DIST, with no default. Sets NEOBOX_DIST, which
 * e2e/lib.mjs reads when it loads, so call this before any dynamic import of it.
 */
export function requireDist() {
  const dist = cliArg("dist", process.env.NEOBOX_DIST);
  if (!dist) throw new Error("no build: pass --dist <build dir> or set NEOBOX_DIST");
  process.env.NEOBOX_DIST = dist;
  return dist;
}

/**
 * Captures every distinct run of `cells` (cells sharing a run capture once) and validates each record.
 * Returns one result per run: { tiers, engine, theme, row, axis, renderer, state, failures }.
 */
export async function runSweep({ cells, jobs = 3, outRoot, resume = false }) {
  const { startServer, runCleanups, launchEngine } = await import("../e2e/lib.mjs");
  const { captureOne, captureDir } = await import("./capture.mjs");
  const { stateById } = await import("./states.mjs");

  const runs = uniqueRuns(cells);
  mkdirSync(outRoot, { recursive: true });

  const results = [];
  const server = await startServer();
  try {
    const browsers = new Map();
    for (const engine of new Set(runs.map((r) => r.engine))) browsers.set(engine, await launchEngine(engine));
    let next = 0;
    const worker = async () => {
      while (next < runs.length) {
        const run = runs[next++];
        const { engine, theme, row, axis, renderer, state, tiers } = run;
        const file = path.join(captureDir(outRoot, { engine, theme, row, axis, renderer }), `${state}.json`);
        let record = resume && existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
        if (!record || record.error) {
          record = await captureOne({
            base: server.base,
            browser: browsers.get(engine),
            engine,
            theme,
            row,
            state: stateById(state),
            outRoot,
            axis,
            renderer,
          });
        }
        const failures = validateRecord(record);
        const label = [tiers.join("+"), engine, theme, row.id, axis !== "none" ? axis : null, renderer, state]
          .filter(Boolean)
          .join(" ");
        results.push({ tiers, engine, theme, row: row.id, axis, renderer, state, failures });
        console.log(`${failures.length === 0 ? "PASS" : "FAIL"} ${label}${failures.length ? `: ${failures.join("; ")}` : ""}`);
      }
    };
    await Promise.all(Array.from({ length: Math.min(jobs, runs.length) }, worker));
  } finally {
    await server.stop();
    await runCleanups();
    writeFileSync(path.join(outRoot, "summary.json"), `${JSON.stringify(results, null, 2)}\n`);
  }
  return results;
}

/** Per-tier coverage: planned cells, runs captured, runs passing. */
function coverage(cells, results) {
  const out = {};
  for (const tier of ["P", "F", "A", "S"]) {
    const mine = results.filter((r) => r.tiers.includes(tier));
    out[tier] = {
      planned: cells.filter((c) => c.tier === tier).length,
      runs: mine.length,
      passing: mine.filter((r) => r.failures.length === 0).length,
    };
  }
  return out;
}

async function main() {
  const planOnly = process.argv.includes("--plan");
  const dist = planOnly ? null : requireDist();
  const { STATES } = await import("./states.mjs");

  const split = (name) => cliArg(name, null)?.split(",").map((s) => s.trim()) ?? null;
  const filters = {
    tiers: split("tiers"),
    states: split("states"),
    rows: split("rows"),
    engines: split("engines"),
    themes: split("themes"),
  };
  const all = planCells();
  const cells = filterCells(all, filters);
  const filtered = Object.values(filters).some(Boolean);

  // Every planned state id must name a real state, so a typo or a removed state fails loudly here.
  const known = new Set(STATES.map((st) => st.id));
  const missing = [...new Set(all.map((c) => c.state))].filter((id) => !known.has(id));
  if (missing.length && !planOnly) throw new Error(`plan names states missing from states.mjs: ${missing.join(", ")}`);
  if (missing.length) console.log(`MISSING states (not yet in states.mjs): ${missing.join(", ")}`);

  const tiers = ["P", "F", "A", "S"];
  const planned = Object.fromEntries(tiers.map((t) => [t, all.filter((c) => c.tier === t).length]));
  console.log(`plan: ${all.length} cells (rubric ${EXPECTED_TOTAL}), ${uniqueRuns(all).length} distinct runs`);
  for (const t of tiers)
    console.log(`  ${t}: ${planned[t]} cells (rubric ${EXPECTED[t]})${planned[t] === EXPECTED[t] ? "" : "  MISMATCH"}`);
  if (planOnly) {
    for (const t of tiers) console.log(describeTier(all, t).join("\n"));
    const ok = all.length === EXPECTED_TOTAL && tiers.every((t) => planned[t] === EXPECTED[t]);
    console.log(ok ? "plan matches rubric" : "plan does NOT match rubric");
    process.exitCode = ok ? 0 : 1;
    return;
  }
  if (filtered) console.log(`filtered: ${cells.length} cells, ${uniqueRuns(cells).length} distinct runs`);

  const outRoot = cliArg("out", `C:/Users/aggressivecombo/neobox-scratch/qa/capture/${path.basename(dist)}`);
  const label = cliArg("label", path.basename(outRoot));
  const jobs = Number(cliArg("jobs", "3"));
  const resume = process.argv.includes("--resume");
  const results = await runSweep({ cells, jobs, outRoot, resume });
  await writeSummary(outRoot, label);
  const passed = results.filter((r) => r.failures.length === 0).length;
  const cov = coverage(cells, results);
  for (const t of tiers)
    console.log(`coverage ${t}: planned ${cov[t].planned} cells, ${cov[t].runs} runs, ${cov[t].passing} passing`);
  console.log(`${passed}/${results.length} runs pass; summary in ${outRoot}/summary.md`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
