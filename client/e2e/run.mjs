// Browser end-to-end suite: starts the built server (dist-server) on a free port
// with a fresh database, drives the real UI in headless Chromium, and reports
// one line per scenario. Usage: `bun run e2e [name-substring ...]`.

import { existsSync } from "node:fs";
import path from "node:path";
import {
  DIST_DIR,
  launchEngine,
  onCleanup,
  runCleanups,
  Scenario,
  SHOTS_DIR,
  startServer,
  sleep,
} from "./lib.mjs";
import { scenarios } from "./scenarios.mjs";

const filters = process.argv.slice(2).map((f) => f.toLowerCase());
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

const started = Date.now();
const server = await startServer();
const browser = await launchEngine(process.env.NEOBOX_ENGINE || "chromium");
const env = { base: server.base, browser };
console.log(`server ${server.base}  (dist ${DIST_DIR})`);

let failed = 0;
let skipped = 0;
for (const scenario of selected) {
  if (scenario.webrtc && !browser.webrtc) {
    skipped++;
    console.log(`skip ${scenario.name}: ${process.env.NEOBOX_ENGINE || "chromium"} has no RTCPeerConnection`);
    continue;
  }
  const s = new Scenario(scenario.name, { ...env });
  const t0 = Date.now();
  let detail = "";
  let error = null;
  let topology = null;
  const runScenario = async () => {
    if (scenario.topology) {
      topology = await scenario.topology();
      s.env.base = topology.base;
      s.env.output = topology.output;
      s.env.nodeBase = topology.nodeBase;
    }
    return scenario.run(s);
  };
  try {
    detail = (await withDeadline(runScenario())) ?? "";
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  const problems = s.problems();
  if (!error && problems.length > 0) error = problems.join("; ");
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  if (error) {
    failed++;
    const shots = await s.screenshot();
    console.log(`FAIL ${scenario.name} (${secs}s): ${error}`);
    for (const file of shots) console.log(`     screenshot ${path.relative(SHOTS_DIR, file)}`);
    if (topology) console.log(`server logs:\n${topology.output()}`);
  } else {
    console.log(`ok   ${scenario.name} (${secs}s)${detail ? `: ${detail}` : ""}`);
  }
  await Promise.race([s.close(), sleep(10_000)]); // a hung page must not stall the suite
  await topology?.stop();
}

console.log(`${selected.length - failed - skipped}/${selected.length} scenarios passed${skipped ? `, ${skipped} skipped` : ""} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
if (failed > 0) console.log(`server log tail:\n${server.output()}`);
await runCleanups();
process.exit(failed > 0 ? 1 : 0);
