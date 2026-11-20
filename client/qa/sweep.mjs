// Runs the rubric capture plan (plan.mjs) and writes summary.json and summary.md. Headless only.
//
// Usage (from client/): bun qa/sweep.mjs --dist <build dir> [--plan] [--tiers P,F,A,S] [--states a,b]
//   [--rows T1-M,...] [--engines chromium,firefox,webkit] [--themes light,dark] [--jobs 3] [--out DIR] [--label NAME] [--resume] [--rerun-failed DIR]
// --resume reuses the records already in --out: a cell with a clean <state>.json is skipped; an errored one is recaptured.
// --rerun-failed DIR captures again only the runs that DIR/summary.json lists as failing (within the other filters).
// Its passing runs are copied into --out and marked carried in summary.json, so --out holds the full plan.
// --dist (or NEOBOX_DIST) is required: there is no default build. --plan prints the coverage per tier
// against the rubric counts and runs nothing. Default out: neobox-scratch/qa/capture/<dist basename>.
// Cells the engine cannot run (notch rows, webgpu) are never planned; see plan.mjs.

import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
    // One browser per engine, shared by the workers. A browser that died under load is relaunched for the next
    // capture (and for the retry); otherwise every later newContext fails with "Target ... has been closed".
    const relaunching = new Map();
    const browserFor = (engine) => {
      const live = browsers.get(engine);
      if (live?.isConnected()) return Promise.resolve(live);
      if (!relaunching.has(engine)) {
        relaunching.set(
          engine,
          launchEngine(engine).then((fresh) => {
            browsers.set(engine, fresh);
            relaunching.delete(engine);
            return fresh;
          }),
        );
      }
      return relaunching.get(engine);
    };
    let next = 0;
    const worker = async () => {
      while (next < runs.length) {
        const run = runs[next++];
        const { engine, theme, row, axis, renderer, state, tiers } = run;
        const file = path.join(captureDir(outRoot, { engine, theme, row, axis, renderer }), `${state}.json`);
        let record = resume && existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
        if (!record || record.error) {
          const capture = async () =>
            captureOne({
              base: server.base,
              browser: await browserFor(engine),
              engine,
              theme,
              row,
              state: stateById(state),
              outRoot,
              axis,
              renderer,
            });
          record = await capture();
          // A lost connection is the rig, not the page: retry once; a second loss stays on the record as infra.
          if (record.infra) record = await capture();
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

/** Identity of one run: a summary.json result and a planned cell give the same key (used by --rerun-failed). */
const runKey = (r) => [r.engine, r.theme, r.row?.id ?? r.row, r.axis ?? "none", r.renderer ?? "", r.state].join("|");

/**
 * Copies the carried-over passes of a --rerun-failed source into outRoot, so the merged summary reads one tree.
 * Returns the carried results, marked `carried`.
 */
async function carryOver(fromRoot, outRoot, carried) {
  const { captureDir } = await import("./capture.mjs");
  return carried.map((r) => {
    const opts = { engine: r.engine, theme: r.theme, row: { id: r.row?.id ?? r.row }, axis: r.axis, renderer: r.renderer };
    const src = captureDir(fromRoot, opts);
    const dst = captureDir(outRoot, opts);
    mkdirSync(dst, { recursive: true });
    for (const f of [`${r.state}.json`, `${r.state}.png`]) if (existsSync(path.join(src, f))) cpSync(path.join(src, f), path.join(dst, f));
    if (existsSync(path.join(src, r.state))) cpSync(path.join(src, r.state), path.join(dst, r.state), { recursive: true });
    return { ...r, carried: true };
  });
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
  const scope = filterCells(all, filters);
  // --rerun-failed DIR: only the runs DIR/summary.json lists as failing (within the filters) are captured again.
  const rerunFrom = cliArg("rerun-failed", null);
  let cells = scope;
  let carried = [];
  if (rerunFrom) {
    const prev = JSON.parse(readFileSync(path.join(rerunFrom, "summary.json"), "utf8"));
    const inScope = new Set(scope.map((c) => runKey(c)));
    const mine = prev.filter((r) => inScope.has(runKey(r)));
    const known = new Set(mine.map((r) => runKey(r)));
    const failed = new Set(mine.filter((r) => r.failures.length > 0).map((r) => runKey(r)));
    carried = mine.filter((r) => r.failures.length === 0);
    // Failing runs, and in-scope runs the source never recorded, are captured; passing runs are carried.
    cells = scope.filter((c) => failed.has(runKey(c)) || !known.has(runKey(c)));
    console.log(`rerun-failed: ${uniqueRuns(cells).length} runs to capture (${failed.size} failing and the rest unrecorded in ${rerunFrom}); ${carried.length} passing runs carried over`);
  }
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
  if (rerunFrom && path.resolve(outRoot) === path.resolve(rerunFrom)) throw new Error("--out must differ from the --rerun-failed source");
  const label = cliArg("label", path.basename(outRoot));
  const jobs = Number(cliArg("jobs", "3"));
  const resume = process.argv.includes("--resume");
  const fresh = await runSweep({ cells, jobs, outRoot, resume });
  const results = fresh.concat(rerunFrom ? await carryOver(rerunFrom, outRoot, carried) : []);
  if (rerunFrom) writeFileSync(path.join(outRoot, "summary.json"), `${JSON.stringify(results, null, 2)}\n`);
  const note = rerunFrom ? `Merged with ${rerunFrom}: ${carried.length} passing runs carried over (marked carried in summary.json); ${fresh.length} re-captured.` : "";
  await writeSummary(outRoot, label, note);
  const passed = results.filter((r) => r.failures.length === 0).length;
  const cov = coverage(scope, results);
  for (const t of tiers)
    console.log(`coverage ${t}: planned ${cov[t].planned} cells, ${cov[t].runs} runs, ${cov[t].passing} passing`);
  console.log(`${passed}/${results.length} runs pass; summary in ${outRoot}/summary.md`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
