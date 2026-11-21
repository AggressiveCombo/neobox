// Action-visual parity instrument: drives one player action in our game and checks the frame the client draws it from.
// First action: rocket charge (idle, then z held). Per frame the wasm frame is read through globalThis.__qaEngine
// (src/engine.ts): every vertex's colour, keyed by its RGB (the low 24 bits of packRgba).
// Rule: while charging, the frame may add vertices only in the launcher's own colours (rail and hub grey, hub red;
// geometry.ts putLauncher). A player-coloured vertex added while charging is the solid aim line that the original
// never draws (removed in 5d330c8): the check fails on it.
//
// Usage:  cd client && QA_OUT=<dir> node qa/actionparity.mjs --dist <dist>
// Output: <QA_OUT>/actionparity.json; exit code 1 on FAIL. Needs a build with the __qaEngine hook.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { launchEngine, startServer, startPractice, runCleanups, sleep, outDir } from "./lib-qa.mjs";

// packRgba (geometry.ts) packs r, g, b into the low 24 bits and alpha into the top byte.
const LAUNCHER_RGB = new Set([0xdddddd, 0x20208c]); // LINE_RGB 0xdddddd; LAUNCHER_RED_RGB 0x8c2020 (r=0x8c, g=0x20, b=0x20 packs to 0x20208c)
const MIN_ADDED = 2; // vertices a stray element adds; a duplicated aim line adds dozens

const browser = await launchEngine("chromium");
const srv = await startServer();
const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
await startPractice({ page }, srv.base, null, { pixels: false });
await sleep(3000);

// One frame: the vertex count per RGB and the player records (rocket charge < 0 when idle).
const frame = () => page.evaluate(() => {
  const fb = globalThis.__qaEngine?.framebuffer?.();
  if (!fb) return null;
  const u = fb.u32, f = fb.f32, n = u[1], h = u[2];
  const colours = {};
  for (let i = 0; i < n; i++) {
    const c = (u[h + i * 3 + 2] & 0xffffff) >>> 0;
    colours[c] = (colours[c] ?? 0) + 1;
  }
  const players = [];
  const np = u[3], rec = u[4];
  for (let i = 0; i < np; i++) {
    const b = rec + i * 14;
    players.push({ id: u[b], team: u[b + 4], rocket: f[b + 10] });
  }
  return { colours, players };
});

const idle = await frame();
await page.keyboard.down("z");
await sleep(1500);
const held = await frame();
await page.keyboard.up("z");

const added = [];
const grew = [];
let charging = false;
if (idle && held) {
  charging = held.players.some((p) => p.rocket > 0);
  for (const [key, count] of Object.entries(held.colours)) {
    const k = Number(key);
    const d = count - (idle.colours[key] ?? 0);
    if (d <= 0) continue;
    const row = { rgb: `0x${k.toString(16).padStart(6, "0")}`, added: d };
    grew.push(row);
    if (d >= MIN_ADDED && !LAUNCHER_RGB.has(k)) added.push(row);
  }
}
const hookPresent = idle !== null && held !== null;
const pass = hookPresent && charging && added.length === 0 && errors.length === 0;
const result = {
  action: "rocket-charge",
  pass,
  hookPresent,
  charging,
  addedNonLauncher: added,
  grew: grew.sort((a, b) => b.added - a.added).slice(0, 12),
  pageErrors: errors,
};
mkdirSync(outDir(), { recursive: true });
writeFileSync(path.join(outDir(), "actionparity.json"), JSON.stringify(result, null, 2));
console.log(`${pass ? "PASS" : "FAIL"} rocket-charge ${JSON.stringify(added)}${hookPresent ? "" : " (no __qaEngine: build lacks the hook)"}`);
await srv.stop();
await runCleanups();
process.exitCode = pass ? 0 : 1;
