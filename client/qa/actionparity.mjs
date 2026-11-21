// Action-visual parity instrument: drives one player action in our game and checks the frame the client draws it from.
// Reads the wasm frame through globalThis.__qaEngine (src/engine.ts): every vertex's colour, keyed by its RGB (the low
// 24 bits of packRgba). Actions so far:
// - rocket-charge: while charging, the frame may add vertices only in the launcher's own colours (rail and hub grey,
//   hub red; geometry.ts putLauncher). A player-coloured vertex added while charging is the solid aim line that the
//   original never draws (removed in 5d330c8): the check fails on it.
// - corpse-colour: a player who falls out of the arena leaves debris (wasm frame.rs, source_player). Its colour must be
//   the client's colour for that player (globalThis.__qaPlayerRgb, geometry.ts playerRgb), the colour the living body
//   is drawn in. The wasm colour table of 02f3b72 draws it in another colour: the check fails there.
//
// Usage:  cd client && QA_OUT=<dir> node qa/actionparity.mjs --dist <dist>
// Output: <QA_OUT>/actionparity.json; exit code 1 on FAIL. Needs a build with the __qaEngine and __qaPlayerRgb hooks.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { launchEngine, startServer, startPractice, runCleanups, sleep, outDir } from "./lib-qa.mjs";

// packRgba (geometry.ts) packs r, g, b into the low 24 bits and alpha into the top byte.
const LAUNCHER_RGB = new Set([0xdddddd, 0x20208c]); // LINE_RGB 0xdddddd; LAUNCHER_RED_RGB 0x8c2020 (r=0x8c, g=0x20, b=0x20 packs to 0x20208c)
const MIN_ADDED = 2; // vertices a stray element adds; a duplicated aim line adds dozens
const FALL_MS = 12000; // walking left from the spawn drops the player out of the practice arena well inside this

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
    players.push({ id: u[b], team: u[b + 4], x: f[b + 1], rocket: f[b + 10] });
  }
  return { colours, players };
});

// Colours that grew between two frames by at least MIN_ADDED vertices (launcher colours excluded when asked).
function grownColours(before, after, skip = new Set()) {
  const out = [];
  for (const [key, count] of Object.entries(after.colours)) {
    const k = Number(key);
    const d = count - (before.colours[key] ?? 0);
    if (d < MIN_ADDED || skip.has(k)) continue;
    out.push({ rgb: `0x${k.toString(16).padStart(6, "0")}`, added: d });
  }
  return out;
}

// --- rocket-charge ---
const idle = await frame();
await page.keyboard.down("z");
await sleep(1500);
const held = await frame();
await page.keyboard.up("z");

const rocketGrew = idle && held ? grownColours(idle, held) : [];
const rocketAdded = rocketGrew.filter((row) => !LAUNCHER_RGB.has(Number(row.rgb)));
const charging = !!held && held.players.some((p) => p.rocket > 0);
const rocketPass = idle !== null && held !== null && charging && rocketAdded.length === 0;

// --- corpse-colour: walk left off the platform; the player's debris keeps the player's colour ---
await sleep(500);
const alive = await frame();
const me = alive?.players[0] ?? null;
const expectedRgb = me ? await page.evaluate(([team, id]) => globalThis.__qaPlayerRgb?.(team, id) ?? null, [me.team, me.id]) : null;
// The frame's colour keys are packed low byte first (see LAUNCHER_RGB): swap red and blue from playerRgb's RRGGBB.
const expected = expectedRgb === null ? null : ((expectedRgb & 0xff) << 16) | (expectedRgb & 0xff00) | ((expectedRgb >>> 16) & 0xff);
await page.keyboard.down("ArrowLeft");
let dead = null;
const xs = [];
const until = Date.now() + FALL_MS;
while (Date.now() < until) {
  await sleep(250);
  // A ledge stops the walk: tap jump now and then so the player clears it.
  if (xs.length % 4 === 3) await page.keyboard.press("ArrowUp");
  const now = await frame();
  xs.push(now?.players[0]?.x ?? null);
  if (now && now.players.length === 0) { dead = now; break; }
}
await page.keyboard.up("ArrowLeft");
const corpseGrew = dead && alive ? grownColours(alive, dead) : [];
const corpseHit = expected !== null && corpseGrew.some((row) => Number(row.rgb) === expected);
const corpsePass = me !== null && expected !== null && dead !== null && corpseHit;
const corpse = {
  pass: corpsePass,
  died: dead !== null,
  player: me,
  expected: expected === null ? null : `0x${expected.toString(16).padStart(6, "0")}`,
  walkX: xs.filter((_, i) => i % 4 === 0),
  debrisColours: corpseGrew.sort((a, b) => b.added - a.added).slice(0, 8),
};

const pass = rocketPass && corpsePass && errors.length === 0;
const result = {
  pass,
  actions: {
    "rocket-charge": {
      pass: rocketPass,
      hookPresent: idle !== null && held !== null,
      charging,
      addedNonLauncher: rocketAdded,
      grew: rocketGrew.sort((a, b) => b.added - a.added).slice(0, 12),
    },
    "corpse-colour": corpse,
  },
  pageErrors: errors,
};
mkdirSync(outDir(), { recursive: true });
writeFileSync(path.join(outDir(), "actionparity.json"), JSON.stringify(result, null, 2));
console.log(`${rocketPass ? "PASS" : "FAIL"} rocket-charge ${JSON.stringify(rocketAdded)}${idle && held ? "" : " (no __qaEngine: build lacks the hook)"}`);
console.log(`${corpsePass ? "PASS" : "FAIL"} corpse-colour expected ${corpse.expected} debris ${JSON.stringify(corpse.debrisColours.slice(0, 3))}${dead ? "" : " (player did not fall)"}`);
await srv.stop();
await runCleanups();
process.exitCode = pass ? 0 : 1;
