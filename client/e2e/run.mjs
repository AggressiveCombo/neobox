// Browser end-to-end suite: drives the real UI of the built server (--dist or NEOBOX_DIST) in headless browsers and reports one
// line per scenario. Every scenario gets its own server (fresh database) unless it brings a topology of its own.
//
// Usage: `bun run e2e [--jobs N] [--engines chromium,firefox,webkit] [name-substring ...]`
//   --jobs N           run N scenarios at a time (env NEOBOX_E2E_JOBS, default 1)
//   --engines a,b,c    run every scenario on each engine, one browser per engine (env NEOBOX_ENGINE, default chromium)
// Scenarios that bind WebRTC to the LAN (rtcServer share one fixed executable path) or assert timing budgets are
// `serial`: they run alone, after the parallel pool has drained.
// Exit status: 0 when every scenario passed or was skipped, 1 on any failure, 2 on bad usage.

import { existsSync } from "node:fs";
import path from "node:path";
import {
  DIST_DIR,
  launchEngine,
  rtcServer,
  runCleanups,
  Scenario,
  SHOTS_DIR,
  startServer,
  sleep,
} from "./lib.mjs";
import { scenarios } from "./scenarios.mjs";

const ENGINES = ["chromium", "firefox", "webkit"];
const USAGE = "usage: bun run e2e [--jobs N] [--engines chromium,firefox,webkit] [name-substring ...]";

function usage(message) {
  console.error(`${message}\n${USAGE}`);
  process.exit(2);
}

const flags = {};
const filters = [];
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  const eq = arg.indexOf("=");
  const flag = arg.startsWith("--") ? (eq > 0 ? arg.slice(0, eq) : arg) : null;
  if (flag === "--jobs" || flag === "--engines") {
    const value = eq > 0 ? arg.slice(eq + 1) : argv[++i];
    if (value === undefined) usage(`${flag} needs a value`);
    flags[flag.slice(2)] = value;
  } else if (arg.startsWith("--")) {
    usage(`unknown option ${arg}`);
  } else {
    filters.push(arg.toLowerCase());
  }
}

const jobsText = flags.jobs ?? process.env.NEOBOX_E2E_JOBS ?? "1";
const jobs = Number(jobsText);
if (!Number.isInteger(jobs) || jobs < 1) usage(`--jobs must be a whole number of at least 1, got "${jobsText}"`);

const engines = (flags.engines ?? process.env.NEOBOX_ENGINE ?? "chromium").split(",").map((e) => e.trim());
for (const engine of engines) {
  if (!ENGINES.includes(engine)) usage(`unknown engine "${engine}"`);
}
if (new Set(engines).size !== engines.length) usage(`--engines lists an engine twice: ${engines.join(",")}`);

const selected = scenarios.filter((s) => filters.length === 0 || filters.some((f) => s.name.toLowerCase().includes(f)));

if (!existsSync(path.join(DIST_DIR, "client", "index.html"))) {
  console.error(`no server build at ${DIST_DIR}. Run \`bash deploy/build.sh\` first (or set NEOBOX_DIST).`);
  process.exit(2);
}
if (selected.length === 0) {
  console.error(`no scenario matches ${filters.join(", ")}`);
  process.exit(2);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    void runCleanups().finally(() => process.exit(130));
  });
}

const SCENARIO_TIMEOUT_MS = Number(process.env.NEOBOX_E2E_SCENARIO_TIMEOUT_MS) || 180_000;

/** Fails a scenario that runs past the limit, so one hung page cannot block the suite. */
function withDeadline(promise) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${SCENARIO_TIMEOUT_MS / 1000}s`)), SCENARIO_TIMEOUT_MS);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/** Runs `items` through `limit` concurrent workers; each item's `run` records its own outcome and never throws. */
async function runPool(items, limit) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await items[next++].run();
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** Scenarios that cannot share the machine with others: LAN WebRTC (one executable path) and timing budgets. */
const isSerial = (scenario) => scenario.serial === true || scenario.topology === rtcServer || scenario.webrtc === true;

const multi = engines.length > 1;
const started = Date.now();
console.log(`neobox e2e: ${selected.length} scenario(s) on ${engines.join(", ")}, jobs ${jobs} (dist ${DIST_DIR})`);

const browsers = new Map();
await Promise.all(engines.map(async (engine) => browsers.set(engine, await launchEngine(engine))));

/** One entry per (engine, scenario) in suite order; `status` is ok | fail | skip; `details` lines follow a failure. */
const outcomes = [];
const parallel = [];
const serial = [];

for (const engine of engines) {
  const browser = browsers.get(engine);
  for (const scenario of selected) {
    const label = multi ? `${scenario.name} [${engine}]` : scenario.name;
    const outcome = { label, status: "ok", line: "", details: [] };
    outcomes.push(outcome);
    let reason = null;
    if (scenario.webrtc && !browser.webrtc) reason = `${engine} has no RTCPeerConnection`;
    if (scenario.cdp && engine !== "chromium") reason = "CDP network emulation is chromium-only";
    if (reason) {
      outcome.status = "skip";
      outcome.line = `skip ${label}: ${reason}`;
      console.log(outcome.line);
      continue;
    }
    const task = { run: () => runTask(scenario, browser, label, outcome) };
    (isSerial(scenario) ? serial : parallel).push(task);
  }
}

/**
 * Starts the scenario's own server (or its topology), runs it, and records the outcome in `outcome`. Never throws.
 * The live line is printed on completion; failure details (screenshots, server logs) are printed in suite order by
 * the summary, so the output stays readable whatever the completion order was.
 */
async function runTask(scenario, browser, label, outcome) {
  const s = new Scenario(label, { browser, base: null, output: null, nodeBase: null });
  const t0 = Date.now();
  let world = null;
  let error = null;
  let detail = "";
  try {
    detail = (await withDeadline(
      (async () => {
        world = scenario.topology ? await scenario.topology() : await startServer();
        s.env.base = world.base;
        s.env.output = world.output;
        s.env.nodeBase = world.nodeBase ?? null;
        return scenario.run(s);
      })(),
    )) ?? "";
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  const problems = s.problems();
  if (!error && problems.length > 0) error = problems.join("; ");
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  if (error) {
    const shots = await s.screenshot();
    outcome.status = "fail";
    outcome.line = `FAIL ${label} (${secs}s): ${error}`;
    outcome.details = [
      ...shots.map((file) => `     screenshot ${path.relative(SHOTS_DIR, file)}`),
      ...(world ? [`server logs:\n${world.output()}`] : []),
    ];
  } else {
    outcome.line = `ok   ${label} (${secs}s)${detail ? `: ${detail}` : ""}`;
  }
  console.log(outcome.line);
  await Promise.race([s.close(), sleep(10_000)]); // a hung page must not stall the suite
  await world?.stop().catch((err) => console.error(`stopping ${label}'s server failed: ${err.message}`));
}

await runPool(parallel, jobs);
await runPool(serial, 1);

const failed = outcomes.filter((o) => o.status === "fail").length;
const skipped = outcomes.filter((o) => o.status === "skip").length;
console.log(`\nsummary:`);
for (const outcome of outcomes) {
  console.log(outcome.line);
  for (const line of outcome.details) console.log(line);
}
console.log(
  `${outcomes.length - failed - skipped}/${outcomes.length} scenarios passed${skipped ? `, ${skipped} skipped` : ""}, ${failed} failed in ${((Date.now() - started) / 1000).toFixed(1)}s`,
);
await runCleanups();
process.exit(failed > 0 ? 1 : 0);
