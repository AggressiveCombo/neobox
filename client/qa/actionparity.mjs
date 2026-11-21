// Action-visual parity instrument: drives one player action in our game and checks the frame the client draws it from.
// Reads the wasm frame through globalThis.__qaEngine (src/engine.ts): every vertex's colour, keyed by its RGB (the low
// 24 bits of packRgba). Actions so far:
// - rocket-charge: while charging, the frame may add vertices only in the launcher's own colours (rail and hub grey,
//   hub red; geometry.ts putLauncher). A player-coloured vertex added while charging is the solid aim line that the
//   original never draws (removed in 5d330c8): the check fails on it.
// - push-charge: while push runs the body keeps its playerRgb colour (the original draws no push lift). The body's exact pixel
//   count in a screenshot must not fall when X is held; a lifted body colour fails it.
// - corpse-colour: a player who falls out of the arena leaves debris (wasm frame.rs, source_player). Its colour must be
//   the client's colour for that player (globalThis.__qaPlayerRgb, geometry.ts playerRgb), the colour the living body
//   is drawn in. The wasm colour table of 02f3b72 draws it in another colour: the check fails there.
// - palette-default, corpse-colour in each colour-blind palette (accessibility addition, DEVIATIONS.md): the default team and
//   FFA colours are the original's (red, blue, six FFA colours); each palette's corpse keeps the body's colour.
// - bat-charge: the body keeps its playerRgb colour while the bat swings (the original draws no bat lift). Its exact-colour
//   pixel count in screenshots before and after holding C must not fall; a lifted body colour fails it.
// - dash-body: the body keeps its playerRgb colour while a dash runs (the original draws no dash lift). Its exact-colour
//   pixel count on the body's lowest 8 rows must not fall while holding D+Z (the bat and aim overlay cross its top rows in
//   both games); needs a build with dashEnabled on (the Free play preset leaves it off).
// - movement-trail: a jumping body draws no trail (the original's jump frames show none); trail-coloured pixels must be absent.
// - stamina-bar, label-box, label-marker: the local label is drawn as in the original (overlay.ts drawNames). Its box is black
//   at 60%, 18 CSS px tall. Its top row is the stamina bar: one CSS px (devicePixelRatio device rows) at the box width, green
//   over a black track, with nothing green above the box. The followed player's yellow marker (#ffd440, outlined) tip sits
//   4 CSS px above the box top. Checked at DPR1 and DPR3 on the overlay canvas.
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
    players.push({ id: u[b], team: u[b + 4], x: f[b + 1], y: f[b + 2], size: f[b + 8], rocket: f[b + 10], stamina: f[b + 5], flags: u[b + 6] });
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

// The local label box (CSS px -> device px): the stamina bar is drawn in its top row and changes colour as a dash spends stamina.
const labelBoxOf = (id) => page.evaluate((pid) => {
  const r = globalThis.__qaDraw?.rects.find((q) => q.kind === "label" && q.id === pid);
  const d = devicePixelRatio;
  return r ? { x0: r.box.left * d, y0: r.box.top * d, x1: r.box.right * d, y1: r.box.bottom * d } : null;
}, id);
// Body-coloured pixels outside the label box.
function bodyOutside(buf, rgb, box, y0 = 0, y1 = Infinity) {
  const { data, width } = PNG.sync.read(buf);
  const r = (rgb >> 16) & 0xff, g = (rgb >> 8) & 0xff, b = rgb & 0xff;
  let n = 0;
  for (let i = 0; i < data.length; i += 4) {
    const p = i / 4, x = p % width, y = (p - x) / width;
    if (box && x >= box.x0 && x < box.x1 && y >= box.y0 && y < box.y1) continue;
    if (y < y0 || y > y1) continue;
    if (data[i] === r && data[i + 1] === g && data[i + 2] === b) n++;
  }
  return n;
}
// Lowest row holding body-coloured pixels outside the label box (-1 when none).
function bodyLowest(buf, rgb, box) {
  const { data, width } = PNG.sync.read(buf);
  const r = (rgb >> 16) & 0xff, g = (rgb >> 8) & 0xff, b = rgb & 0xff;
  let low = -1;
  for (let i = 0; i < data.length; i += 4) {
    const p = i / 4, x = p % width, y = (p - x) / width;
    if (box && x >= box.x0 && x < box.x1 && y >= box.y0 && y < box.y1) continue;
    if (data[i] === r && data[i + 1] === g && data[i + 2] === b) low = Math.max(low, y);
  }
  return low;
}

// --- dash-body: the body keeps its colour while a dash runs (the original draws no dash lift). Dash needs the dashEnabled
// rule, which the Free play preset leaves off: the build must enable it. ---
await sleep(3000); // the bat swing and its stamina settle; a dash needs 30 stamina
const dashIdle = await frame();
const dashIdleShot = await page.screenshot();
const dashMe = dashIdle?.players[0] ?? null;
const dashIdleBox = dashMe ? await labelBoxOf(dashMe.id) : null;
const dashRgb = dashMe ? await page.evaluate(([team, id]) => globalThis.__qaPlayerRgb?.(team, id) ?? null, [dashMe.team, dashMe.id]) : null;
await page.keyboard.down("d");
await page.keyboard.down("z");
let dashHeld = null;
let dashHeldShot = null;
let dashHeldBox = null;
for (let i = 0; i < 40 && dashHeld === null; i++) {
  await sleep(50);
  const f = await frame();
  if ((f?.players[0]?.flags & 64) !== 0) {
    dashHeld = f;
    dashHeldShot = await page.screenshot();
    dashHeldBox = await labelBoxOf(f.players[0].id);
  }
}
await page.keyboard.up("z");
await page.keyboard.up("d");
const dashing = dashHeld !== null;
const dashFoot = dashRgb === null ? -1 : bodyLowest(dashIdleShot, dashRgb, dashIdleBox);
const dashBody = { idle: dashFoot < 0 ? 0 : bodyOutside(dashIdleShot, dashRgb, dashIdleBox, dashFoot - 7, dashFoot), held: dashFoot < 0 || dashHeldShot === null ? 0 : bodyOutside(dashHeldShot, dashRgb, dashHeldBox, dashFoot - 7, dashFoot) };
for (const [name, shot] of [["dash-idle", dashIdleShot], ["dash-held", dashHeldShot]]) if (shot) writeFileSync(path.join(outDir(), "evidence", `${name}.png`), shot);
const dashPass = dashing && dashBody.idle > 0 && dashBody.held >= dashBody.idle;

// --- movement-trail: the original draws no motion trail behind a moving body (its jump and dash frames show none), so no
// trail-coloured pixels appear while the body rises. The body must move, or the check passes vacuously. ---
const TRAIL_RGB = 0x4d6d73; // the colour geometry.ts drew the trail in
await sleep(1500); // the bat swing settles
const jumpSize = (await frame())?.players[0]?.size ?? 0;
const jumpYs = [];
const jumpShots = [];
await page.keyboard.down("ArrowUp");
for (let i = 0; i < 6; i++) {
  await sleep(60);
  jumpYs.push((await frame())?.players[0]?.y ?? null);
  jumpShots.push(await page.screenshot());
}
await page.keyboard.up("ArrowUp");
const jumpYsKnown = jumpYs.filter((y) => y !== null);
const trailMoved = jumpYsKnown.length > 1 && jumpSize > 0 && Math.max(...jumpYsKnown) - Math.min(...jumpYsKnown) > jumpSize;
const trailPixels = jumpShots.map((s) => pixelsOf(s, TRAIL_RGB));
const trailPass = trailMoved && trailPixels.every((n) => n === 0);

// --- push-charge: the body keeps its colour while push runs (the original draws no push lift) ---
// Counts the body's exact colour (playerRgb) in screenshots before and after 1 s of holding X, which drains stamina.
await sleep(3000); // let the rocket check's shot and stamina settle
const pushIdle = await frame();
const pushIdleShot = await page.screenshot();
const pushMe = pushIdle?.players[0] ?? null;
const pushRgb = pushMe ? await page.evaluate(([team, id]) => globalThis.__qaPlayerRgb?.(team, id) ?? null, [pushMe.team, pushMe.id]) : null;
await page.keyboard.down("x");
await sleep(1000);
const pushHeld = await frame();
const pushHeldShot = await page.screenshot();
await page.keyboard.up("x");
const pushing = !!pushIdle && !!pushHeld && pushHeld.players[0].stamina < pushIdle.players[0].stamina;
const pushBody = { idle: pushRgb === null ? 0 : pixelsOf(pushIdleShot, pushRgb), held: pushRgb === null ? 0 : pixelsOf(pushHeldShot, pushRgb) };
for (const [name, shot] of [["push-idle", pushIdleShot], ["push-held", pushHeldShot]]) writeFileSync(path.join(outDir(), "evidence", `${name}.png`), shot);
const pushStamina = [pushIdle?.players[0]?.stamina ?? null, pushHeld?.players[0]?.stamina ?? null];
const pushPass = pushing && pushBody.idle > 0 && pushBody.held >= pushBody.idle;

// --- stamina-bar, label box and marker: the local label's box is black at 60%, 18 CSS px tall (overlay.ts drawNames) ---
// The bar is the box's top row; the followed player's marker (yellow, outlined) tip sits 4 CSS px above the box.
// Probes the overlay canvas around the local label of page pg.
const staminaOn = async (pg) => {
  const me = (await frameOf(pg))?.players[0] ?? null;
  const probe = me ? await pg.evaluate((id) => {
    const c = document.getElementById("overlay");
    const lab = globalThis.__qaDraw?.rects.find((r) => r.kind === "label" && r.id === id);
    const mark = globalThis.__qaDraw?.rects.find((r) => r.kind === "marker" && r.id === id) ?? null;
    if (!c || !lab) return null;
    const r = c.getBoundingClientRect();
    const sx = c.width / r.width, sy = c.height / r.height;
    const dpr = window.devicePixelRatio;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    // The draw rects are in the view's CSS px (the overlay canvas covers the view): scale them to canvas pixels.
    const x0 = Math.round(lab.box.left * sx), x1 = Math.round(lab.box.right * sx);
    const yBase = Math.round(lab.box.top * sy), yEnd = Math.round(lab.box.bottom * sy);
    const rows = [];
    for (let y = yBase - 2 * dpr; y < yBase + 2 * dpr; y++) {
      const d = ctx.getImageData(x0, y, x1 - x0, 1).data;
      let green = 0, opaque = 0, box = 0, other = 0;
      for (let i = 0; i < d.length; i += 4) {
        const [R, G, B, A] = [d[i], d[i + 1], d[i + 2], d[i + 3]];
        if (A === 255 && Math.abs(R - 52) <= 3 && Math.abs(G - 186) <= 3 && Math.abs(B - 86) <= 3) green++;
        else if (A === 255 && R + G + B <= 6) opaque++; // the bar's black track
        else if (A >= 140 && A <= 166 && R + G + B <= 6) box++; // the label box: black at 60% (alpha 153)
        else other++;
      }
      rows.push({ y, green, opaque, box, other });
    }
    // Box fill: the left padding column (no text), below the bar: black at 60% (alpha 153).
    const col = ctx.getImageData(x0 + 1, yBase + dpr, 1, yEnd - yBase - dpr).data;
    let boxRows = 0;
    for (let i = 0; i < col.length; i += 4) if (col[i + 3] >= 140 && col[i + 3] <= 166 && col[i] + col[i + 1] + col[i + 2] <= 6) boxRows++;
    // The followed player's marker: its yellow pixels in its box.
    let marker = null;
    if (mark) {
      const mx0 = Math.round(mark.box.left * sx), mx1 = Math.round(mark.box.right * sx);
      const my0 = Math.round(mark.box.top * sy), my1 = Math.round(mark.box.bottom * sy);
      const md = ctx.getImageData(mx0, my0, mx1 - mx0, my1 - my0).data;
      let yellow = 0;
      for (let i = 0; i < md.length; i += 4) {
        if (md[i + 3] === 255 && Math.abs(md[i] - 255) <= 3 && Math.abs(md[i + 1] - 212) <= 3 && Math.abs(md[i + 2] - 64) <= 3) yellow++;
      }
      marker = { top: my0, bottom: my1, yellow };
    }
    return { dpr, labelW: lab.box.right - lab.box.left, width: x1 - x0, yBase, yEnd, rows, boxRows, boxH: yEnd - yBase - dpr, marker };
  }, me.id) : null;
  return { me, probe };
};
// The bar: dpr device rows from the box top, each full width (a fractional fill edge may blend one pixel), with nothing above it.
const staminaPassOf = (probe) => {
  if (!probe) return false;
  const bars = probe.rows.filter((row) => row.y >= probe.yBase && row.y < probe.yBase + probe.dpr);
  const above = probe.rows.filter((row) => row.y < probe.yBase && (row.green > 0 || row.opaque > 0));
  return bars.length === probe.dpr && bars.every((row) => row.green + row.opaque >= probe.width - 1 && row.other <= 1)
    && bars.reduce((sum, row) => sum + row.green, 0) > 0 && above.length === 0
    && Math.abs(probe.width - probe.labelW * probe.dpr) <= 1;
};
// The box is black at 60% over its interior below the bar.
const boxPassOf = (probe) => !!probe && probe.boxH > 0 && probe.boxRows === probe.boxH;
// The marker has yellow pixels, and its tip sits 4 CSS px above the box top.
const markerPassOf = (probe) => !!probe?.marker && probe.marker.yellow > 0 && Math.abs(probe.yBase - probe.marker.bottom - 4 * probe.dpr) <= 1;
const stamina1 = await staminaOn(page);
const ctx3 = await browser.newContext({ viewport: { width: 1366, height: 768 }, deviceScaleFactor: 3 });
const page3 = await ctx3.newPage();
await startPractice({ page: page3 }, srv.base, null, { pixels: false });
await sleep(3000);
const stamina3 = await staminaOn(page3);
await ctx3.close();
const staminaPass = staminaPassOf(stamina1.probe) && staminaPassOf(stamina3.probe);
const boxPass = boxPassOf(stamina1.probe) && boxPassOf(stamina3.probe);
const markerPass = markerPassOf(stamina1.probe) && markerPassOf(stamina3.probe);

// --- corpse-colour: walk left off the platform; the player's debris keeps the player's colour ---
// The frame's colour keys are packed low byte first (see LAUNCHER_RGB): swap red and blue from playerRgb's RRGGBB.
const packedOf = (rgb) => ((rgb & 0xff) << 16) | (rgb & 0xff00) | ((rgb >>> 16) & 0xff);
// Walks the local player off the platform on page pg; checks the living body and the debris against playerRgb.
async function corpseOf(pg, label = "default") {
  await sleep(500);
  const alive = await frameOf(pg);
  const shotAlive = await pg.screenshot();
  const me = alive?.players[0] ?? null;
  const rgb = me ? await pg.evaluate(([team, id]) => globalThis.__qaPlayerRgb?.(team, id) ?? null, [me.team, me.id]) : null;
  const expected = rgb === null ? null : packedOf(rgb);
  await pg.keyboard.down("ArrowLeft");
  let dead = null;
  const xs = [];
  const until = Date.now() + FALL_MS;
  while (Date.now() < until) {
    await sleep(250);
    // A ledge stops the walk: tap jump now and then so the player clears it.
    if (xs.length % 4 === 3) await pg.keyboard.press("ArrowUp");
    const now = await frameOf(pg);
    xs.push(now?.players[0]?.x ?? null);
    if (now && now.players.length === 0) { dead = now; break; }
  }
  await pg.keyboard.up("ArrowLeft");
  const shotDead = dead ? await pg.screenshot() : null;
  for (const [name, shot] of [["alive", shotAlive], ["dead", shotDead]]) {
    if (shot) writeFileSync(path.join(outDir(), "evidence", `corpse-${label}-${name}.png`), shot);
  }
  const corpseGrew = dead && alive ? grownColours(alive, dead) : [];
  // Pixels of the body's colour before the fall (the living body) and in the debris after it (same palette).
  const pixels = { alive: rgb === null ? 0 : pixelsOf(shotAlive, rgb), dead: rgb === null || !shotDead ? 0 : pixelsOf(shotDead, rgb) };
  const corpseHit = expected !== null && corpseGrew.some((row) => Number(row.rgb) === expected);
  return {
    pass: me !== null && expected !== null && dead !== null && corpseHit && pixels.alive > 0,
    died: dead !== null,
    pixels,
    player: me,
    expected: expected === null ? null : `0x${expected.toString(16).padStart(6, "0")}`,
    walkX: xs.filter((_, i) => i % 4 === 0),
    debrisColours: corpseGrew.sort((a, b) => b.added - a.added).slice(0, 8),
  };
}
const corpse = await corpseOf(page);
const corpsePass = corpse.pass;

// --- palette: the default team and FFA colours are the original's (red, blue, six FFA colours) ---
const ORIGINAL = { red: 0xd44234, blue: 0x347bd4, ffa: [0xf9fc91, 0x33658a, 0xe34a6f, 0x3acf60, 0xbc56d5, 0xeea210] };
const tableNow = await page.evaluate(() => {
  const rgb = globalThis.__qaPlayerRgb;
  return { red: rgb?.(2, 0) ?? null, blue: rgb?.(3, 0) ?? null, ffa: [0, 1, 2, 3, 4, 5].map((id) => rgb?.(1, id) ?? null) };
});
const paletteDefaultPass = tableNow.red === ORIGINAL.red && tableNow.blue === ORIGINAL.blue &&
  tableNow.ffa.every((rgb, i) => rgb === ORIGINAL.ffa[i]);

// --- colour-blind palettes (accessibility addition, DEVIATIONS.md): the corpse keeps the body's colour in each ---
const cvd = {};
for (const palette of ["deuteranopia", "protanopia", "tritanopia"]) {
  const ctxP = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  // PREFS_KEY (src/storage-keys.ts) holds the prefs JSON; missing keys take their defaults.
  await ctxP.addInitScript((value) => localStorage.setItem("neobox.prefs", value), JSON.stringify({ palette }));
  const pageP = await ctxP.newPage();
  await startPractice({ page: pageP }, srv.base, null, { pixels: false });
  await sleep(3000);
  cvd[palette] = await corpseOf(pageP, palette);
  await ctxP.close();
}
const cvdPass = Object.values(cvd).every((row) => row.pass);

const pass = rocketPass && batPass && dashPass && trailPass && pushPass && staminaPass && boxPass && markerPass && corpsePass && paletteDefaultPass && cvdPass && errors.length === 0;
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
    "movement-trail": { pass: trailPass, moved: trailMoved, y: jumpYs, trailPixels },
    "dash-body": { pass: dashPass, dashing, flags: dashHeld?.players[0]?.flags ?? null, body: dashBody, rgb: dashRgb === null ? null : `0x${dashRgb.toString(16).padStart(6, "0")}` },
    "push-charge": { pass: pushPass, pushing, stamina: pushStamina, flags: pushHeld?.players[0]?.flags ?? null, body: pushBody, rgb: pushRgb === null ? null : `0x${pushRgb.toString(16).padStart(6, "0")}` },
    "corpse-colour": { ...corpse, cvd },
    "palette-default": { pass: paletteDefaultPass, original: ORIGINAL, table: tableNow },
    "stamina-bar": { pass: staminaPass, dpr1: stamina1.probe, dpr3: stamina3.probe },
    "label-box": { pass: boxPass, dpr1: stamina1.probe?.boxRows, dpr3: stamina3.probe?.boxRows },
    "label-marker": { pass: markerPass, dpr1: stamina1.probe?.marker, dpr3: stamina3.probe?.marker },
  },
  pageErrors: errors,
};
mkdirSync(outDir(), { recursive: true });
writeFileSync(path.join(outDir(), "actionparity.json"), JSON.stringify(result, null, 2));
console.log(`${rocketPass ? "PASS" : "FAIL"} rocket-charge ${JSON.stringify(rocketAdded)}${idle && held ? "" : " (no __qaEngine: build lacks the hook)"}`);
console.log(`${pushPass ? "PASS" : "FAIL"} push-charge body ${JSON.stringify(pushBody)} rgb ${pushRgb === null ? "none" : pushRgb.toString(16)} stamina ${JSON.stringify(pushStamina)}${pushing ? "" : " (stamina did not drain)"}`);
console.log(`${corpsePass ? "PASS" : "FAIL"} corpse-colour expected ${corpse.expected} debris ${JSON.stringify(corpse.debrisColours.slice(0, 3))}${corpse.died ? "" : " (player did not fall)"}`);
console.log(`${batPass ? "PASS" : "FAIL"} bat-charge body ${JSON.stringify(batBody)} rgb ${batRgb === null ? "none" : batRgb.toString(16)}${batting ? "" : " (bat did not swing)"}`);
console.log(`${trailPass ? "PASS" : "FAIL"} movement-trail moved ${trailMoved} y ${JSON.stringify(jumpYs)} trail pixels per shot ${JSON.stringify(trailPixels)}`);
console.log(`${dashPass ? "PASS" : "FAIL"} dash-body body ${JSON.stringify(dashBody)} rgb ${dashRgb === null ? "none" : dashRgb.toString(16)}${dashing ? "" : " (dash did not start)"}`);
console.log(`${paletteDefaultPass ? "PASS" : "FAIL"} palette-default red ${tableNow.red?.toString(16)} blue ${tableNow.blue?.toString(16)} ffa ${JSON.stringify(tableNow.ffa.map((c) => c?.toString(16)))}`);
for (const [palette, row] of Object.entries(cvd)) console.log(`${row.pass ? "PASS" : "FAIL"} corpse-colour ${palette} expected ${row.expected} debris ${JSON.stringify(row.debrisColours.slice(0, 3))}${row.died ? "" : " (player did not fall)"}`);
console.log(`${staminaPass ? "PASS" : "FAIL"} stamina-bar dpr1 ${JSON.stringify(stamina1.probe?.rows.filter((r) => r.green || r.opaque || r.other))} dpr3 ${JSON.stringify(stamina3.probe?.rows.filter((r) => r.green || r.opaque || r.other))} box top ${stamina1.probe?.yBase ?? "none"}`);
console.log(`${boxPass ? "PASS" : "FAIL"} label-box dpr1 ${stamina1.probe?.boxRows ?? "none"}/${stamina1.probe?.boxH ?? "none"} dpr3 ${stamina3.probe?.boxRows ?? "none"}/${stamina3.probe?.boxH ?? "none"}`);
console.log(`${markerPass ? "PASS" : "FAIL"} label-marker dpr1 ${JSON.stringify(stamina1.probe?.marker ?? null)} dpr3 ${JSON.stringify(stamina3.probe?.marker ?? null)} box top ${stamina1.probe?.yBase ?? "none"}`);
await srv.stop();
await runCleanups();
process.exitCode = pass ? 0 : 1;
