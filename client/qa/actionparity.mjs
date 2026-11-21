// Action-visual parity instrument: drives one player action in our game and checks the frame the client draws it from.
// Reads the wasm frame through globalThis.__qaEngine (src/engine.ts): every vertex's colour, keyed by its RGB (the low
// 24 bits of packRgba). Actions so far:
// - rocket-charge: while charging, the frame may add vertices only in the launcher's own colours (rail and hub grey,
//   hub red; geometry.ts putLauncher). A player-coloured vertex added while charging is the solid aim line that the
//   original never draws (removed in 5d330c8): the check fails on it.
// - corpse-colour: a player who falls out of the arena leaves debris (wasm frame.rs, source_player). Its colour must be
//   the client's colour for that player (globalThis.__qaPlayerRgb, geometry.ts playerRgb), the colour the living body
//   is drawn in. The wasm colour table of 02f3b72 draws it in another colour: the check fails there.
// - stamina-bar: the local player's stamina is a bar on a black track on the overlay canvas, one CSS px tall (devicePixelRatio
//   device rows) and the label's width, directly above the name label (overlay.ts drawStamina). Checked at DPR1 and DPR3: the
//   rows just above the label hold only green or black, and no other row does. A bar under the body fails it.
// - bat-charge: the body keeps its playerRgb colour while the bat swings (the original draws no bat lift). Its exact-colour
//   pixel count in screenshots before and after holding C must not fall; a lifted body colour fails it.
//
// Usage:  cd client && QA_OUT=<dir> node qa/actionparity.mjs --dist <dist>
// Output: <QA_OUT>/actionparity.json; exit code 1 on FAIL. Needs a build with the __qaEngine and __qaPlayerRgb hooks.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
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
const frameOf = (pg) => pg.evaluate(() => {
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
    players.push({ id: u[b], team: u[b + 4], x: f[b + 1], rocket: f[b + 10], flags: u[b + 6] });
  }
  return { colours, players };
});
const frame = () => frameOf(page);

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

// Pixels in a PNG screenshot whose RGB is exactly rgb (the living body is drawn by geometry.ts, outside the wasm vertex buffer).
function pixelsOf(buf, rgb) {
  const { data } = PNG.sync.read(buf);
  const r = (rgb >> 16) & 0xff, g = (rgb >> 8) & 0xff, b = rgb & 0xff;
  let n = 0;
  for (let i = 0; i < data.length; i += 4) if (data[i] === r && data[i + 1] === g && data[i + 2] === b) n++;
  return n;
}

// --- bat-charge: the body keeps its colour while the bat swings (the original draws no bat lift) ---
await sleep(3000); // let the rocket check settle
const batIdle = await frame();
const batIdleShot = await page.screenshot();
const batMe = batIdle?.players[0] ?? null;
const batRgb = batMe ? await page.evaluate(([team, id]) => globalThis.__qaPlayerRgb?.(team, id) ?? null, [batMe.team, batMe.id]) : null;
await page.keyboard.down("c");
let batHeld = null;
let batHeldShot = null;
for (let i = 0; i < 10 && batHeld === null; i++) {
  await sleep(100);
  const f = await frame();
  if ((f?.players[0]?.flags & 16) !== 0) {
    batHeld = f;
    batHeldShot = await page.screenshot();
  }
}
await page.keyboard.up("c");
const batting = batHeld !== null;
const batBody = { idle: batRgb === null ? 0 : pixelsOf(batIdleShot, batRgb), held: batRgb === null || batHeldShot === null ? 0 : pixelsOf(batHeldShot, batRgb) };
for (const [name, shot] of [["bat-idle", batIdleShot], ["bat-held", batHeldShot]]) if (shot) writeFileSync(path.join(outDir(), "evidence", `${name}.png`), shot);
const batPass = batting && batBody.idle > 0 && batBody.held >= batBody.idle;

// --- stamina-bar: one CSS px tall and the label's width, on the rows just above the local label; nothing else there ---
// Probes the overlay pixels above the local label of page pg.
const staminaOn = async (pg) => {
  const me = (await frameOf(pg))?.players[0] ?? null;
  const probe = me ? await pg.evaluate((id) => {
    const c = document.getElementById("overlay");
    const lab = globalThis.__qaDraw?.rects.find((r) => r.kind === "label" && r.id === id);
    if (!c || !lab) return null;
    const r = c.getBoundingClientRect();
    const sx = c.width / r.width, sy = c.height / r.height;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    // The draw rects are in the view's CSS px (the overlay canvas covers the view): scale them to canvas pixels.
    const x0 = Math.round(lab.box.left * sx), x1 = Math.round(lab.box.right * sx);
    const yBase = Math.round(lab.box.top * sy);
    const rows = [];
    for (let y = yBase - 6; y < yBase; y++) {
      const d = ctx.getImageData(x0, y, x1 - x0, 1).data;
      let green = 0, black = 0, other = 0;
      for (let i = 0; i < d.length; i += 4) {
        const [R, G, B, A] = [d[i], d[i + 1], d[i + 2], d[i + 3]];
        if (A === 255 && Math.abs(R - 52) <= 3 && Math.abs(G - 186) <= 3 && Math.abs(B - 86) <= 3) green++;
        else if (A >= 128 && R + G + B <= 6) black++; // the track is black at 70% opacity over the label plate
        else other++;
      }
      rows.push({ y, green, black, other });
    }
    return { dpr: window.devicePixelRatio, labelW: lab.box.right - lab.box.left, yBase, width: x1 - x0, rows };
  }, me.id) : null;
  return { me, probe };
};
// One CSS px = dpr device rows, each full bar width (a fractional fill edge may blend one pixel per row).
const staminaPassOf = (probe) => {
  if (!probe) return false;
  // Full-width rows only: the label's outline stroke (black, partly transparent) can touch the rows above the bar.
  const bars = probe.rows.filter((row) => row.green + row.black >= probe.width - 1);
  return bars.length === probe.dpr && bars[0].y === probe.yBase - probe.dpr && bars[bars.length - 1].y === probe.yBase - 1
    && bars.every((row) => row.other <= 1) && bars.reduce((sum, row) => sum + row.green, 0) > 0 && Math.abs(probe.width - probe.labelW * probe.dpr) <= 1;
};
const stamina1 = await staminaOn(page);
const ctx3 = await browser.newContext({ viewport: { width: 1366, height: 768 }, deviceScaleFactor: 3 });
const page3 = await ctx3.newPage();
await startPractice({ page: page3 }, srv.base, null, { pixels: false });
await sleep(3000);
const stamina3 = await staminaOn(page3);
await ctx3.close();
const me0 = stamina1.me;
const staminaPass = staminaPassOf(stamina1.probe) && staminaPassOf(stamina3.probe);

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

const pass = rocketPass && batPass && staminaPass && corpsePass && errors.length === 0;
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
    "bat-charge": { pass: batPass, batting, flags: batHeld?.players[0]?.flags ?? null, body: batBody, rgb: batRgb === null ? null : `0x${batRgb.toString(16).padStart(6, "0")}` },
    "corpse-colour": corpse,
    "stamina-bar": { pass: staminaPass, dpr1: stamina1.probe, dpr3: stamina3.probe },
  },
  pageErrors: errors,
};
mkdirSync(outDir(), { recursive: true });
writeFileSync(path.join(outDir(), "actionparity.json"), JSON.stringify(result, null, 2));
console.log(`${rocketPass ? "PASS" : "FAIL"} rocket-charge ${JSON.stringify(rocketAdded)}${idle && held ? "" : " (no __qaEngine: build lacks the hook)"}`);
console.log(`${corpsePass ? "PASS" : "FAIL"} corpse-colour expected ${corpse.expected} debris ${JSON.stringify(corpse.debrisColours.slice(0, 3))}${dead ? "" : " (player did not fall)"}`);
console.log(`${batPass ? "PASS" : "FAIL"} bat-charge body ${JSON.stringify(batBody)} rgb ${batRgb === null ? "none" : batRgb.toString(16)}${batting ? "" : " (bat did not swing)"}`);
console.log(`${staminaPass ? "PASS" : "FAIL"} stamina-bar dpr1 ${JSON.stringify(stamina1.probe?.rows.filter((r) => r.green || r.black || r.other))} dpr3 ${JSON.stringify(stamina3.probe?.rows.filter((r) => r.green || r.black || r.other))} label top ${stamina1.probe?.yBase ?? "none"}`);
await srv.stop();
await runCleanups();
process.exitCode = pass ? 0 : 1;
