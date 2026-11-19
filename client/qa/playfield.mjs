// Play-field instrument (rubric D16): HUD boxes over live sprites and spawn points at every tier
// viewport in both palettes; sprite contrast (WCAG 1.4.11, 3:1) against the local background at T1-M
// and T5-T; camera keeps every live player in view on the four reference maps; hit feedback latency
// in engine ticks. Ground truth is engine state (a read-only init-script hook on the wasm frame
// exports) plus the camera's published view (globalThis.__qaCam, src/camera.ts), not screenshots,
// except for the contrast sample, which reads the match canvas.
//
// Run: cd client && QA_OUT=<dir> bun qa/playfield.mjs        (QA_ENGINES=chromium to limit engines)
// Env: PALETTES (default "default,deuteranopia"), QA_CAM_MS (15000), QA_PLAY_MS (30000), QA_CASES (comma list of
//      "tier", "camera", "feedback"; default all: runs only the named cases of the matrix).
// Output: <QA_OUT>/playfield-<engine>.{json,md}, screenshots under <QA_OUT>/evidence/playfield-<engine>/.
// Self-tests (QA_SELF_TEST, use a separate QA_OUT; each must FAIL):
//   hud       a fixed box is put over the local live sprite before each HUD sample
//   contrast  each sprite's fill luminance is replaced by its background's before the ratio
//   camera    a fake live player is added in the arena's far corner to the in-view check
//   feedback  a synthetic engine log with a 5-tick delay (no browser)

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PALETTES as GEOMETRY_PALETTES, AWAY_RING_BELOW_LUM, relLuminance } from "../src/render/geometry.ts";
import {
  Results,
  createRoom,
  dismissPhoneSplash,
  joinByInvite,
  launchEngine,
  nextClientIp,
  runCleanups,
  selectedEngines,
  selfTestMode,
  shot,
  sleep,
  startMatch,
  startServer,
  stripThirdPartyForwardedFor,
  button,
  menuName,
  navTo,
  uniqueName,
  watchPage,
  writeIndex,
  rel,
} from "./lib-qa.mjs";
import { ROWS, isTouch } from "./presets.mjs";
import { fixtureMatch } from "./gameplay.mjs";

// Tier viewports (rubric section 2.1): one row per tier, primary geometry only.
const TIERS = ["T1-M", "T2-M", "T3-T", "T4-T", "T5-T", "T6-T", "T7-T", "T8-T", "T9-T", "T10-M", "T11-T"];
const CONTRAST_TIERS = ["T1-M", "T5-T"];
const PALETTES = (process.env.PALETTES ?? "default,deuteranopia").split(",").map((s) => s.trim());
// Reference maps (rubric section 1, "Reference maps"): the four built-in maps by display name.
const REFERENCE_MAPS = ["Proving Grounds", "Sky Islands", "Playground", "Twin Forts (teams)"];
// QA-only wide arena (client/qa/fixtures/qa-wide.json, pasted as map JSON like e2e's voidMap, never shipped): players start at both ends of a 200-wide floor.
const QA_WIDE = { id: "QA Wide Arena", json: readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures/qa-wide.json"), "utf8") };
const HUD_MS = 5000;
const HUD_EVERY_MS = 250;
const SAMPLE_MS = 250;
const CAM_MS = Number(process.env.QA_CAM_MS ?? 15000);
const PLAY_MS = Number(process.env.QA_PLAY_MS ?? 30000);
const FEEDBACK_SWINGS = 6; // point-blank bat swings per player on the fixture map
const BAT_HOLD_MS = 600; // KeyC held this long fires the bat
const BAT_GAP_MS = 1500; // after release the bat cycle resets
const CONTRAST_MIN = 3;
const FEEDBACK_MAX = 2;
// Judged hit events needed for feedback.hit.frames (fewer is a failed measurement, not a pass); the collection stops at this count or the time cap.
const FEEDBACK_MIN_EVENTS = 10;
const FEEDBACK_CAP_MS = 240000;
// Engine sound kinds of a hit (src/audio.ts): 3 push hit, 6 impact, 12 body impact, 14 bat hit.
const HIT_SOUNDS = [3, 6, 12, 14];
// Ticks at the end of a log whose feedback window has not closed yet; those events are not judged.
const OPEN_TAIL_TICKS = 60;
const DRIVE_KEYS = ["ArrowLeft", "ArrowRight", "ArrowUp", "KeyC", "KeyX"];
const MAPS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../maps");
// Edge chips (overlay.ts drawAway): the name is white on the panel; the player colour is a swatch (non-text, 1.4.11). Dark colours get a white ring.
const CHIP_TEXT_MIN = 4.5;
const CHIP_SWATCH_MIN = 3;

const rowOf = (id) => {
  const row = ROWS.find((r) => r.id === id);
  if (!row) throw new Error(`unknown tier row ${id}`);
  return row;
};

/**
 * Runs in every page before app code: wraps the wasm frame exports to keep the frame's engine state
 * (live players, spawns, hit/sound/health/bar counts per tick) and samples the match canvas after each
 * draw of the frame the camera published. Constants are inlined: this function is serialised into the page.
 */
function playfieldInit(cfg) {
  if (cfg.hideGpu) Object.defineProperty(navigator, "gpu", { value: undefined, configurable: true });
  // Merge, do not overwrite: the page's other saved settings survive this init script's palette pick.
  const savedPrefs = JSON.parse(localStorage.getItem("neobox.prefs") ?? "null") ?? {};
  localStorage.setItem("neobox.prefs", JSON.stringify({ ...savedPrefs, palette: cfg.palette }));
  if (localStorage.getItem("neobox.name") === null) localStorage.setItem("neobox.name", cfg.name);

  const acc = (window.__qaPF = {
    latest: null,
    snaps: new Map(),
    log: [],
    camTick: -1,
    camFrames: 0,
    camOut: 0,
    camLocalOut: 0,
    camUnind: 0,
    camLocalDetail: [],
    camDetail: [],
    contrastOn: false,
    contrast: [],
    lastSample: 0,
    scratch: null,
    selfTest: cfg.selfTest,
  });
  // sRGB byte -> linear light (WCAG relative luminance input).
  const LUT = new Float32Array(256);
  for (let c = 0; c < 256; c++) {
    const v = c / 255;
    LUT[c] = v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }

  // Frame layout: docs/CLIENT-API.md "Frame buffer" (src/frame.ts readScene).
  const parse = (ex) => {
    const len = ex.nb_frame_len();
    if (len < 64) return;
    const buf = ex.memory.buffer;
    const ptr = ex.nb_frame_ptr();
    const n = len >>> 2;
    const u = new Uint32Array(buf, ptr, n);
    const f = new Float32Array(buf, ptr, n);
    const localId = new Int32Array(buf, ptr, n)[15];
    const tick = u[14];
    const scores = new Map();
    for (let k = 0; k < u[7]; k++) {
      const o = u[8] + k * 15;
      scores.set(u[o], { alive: u[o + 5] !== 0, spectator: u[o + 1] === 0, spawnX: f[o + 13], spawnY: f[o + 14] });
    }
    const live = [];
    for (let k = 0; k < u[3]; k++) {
      const o = u[4] + k * 14;
      const id = u[o];
      const row = scores.get(id);
      const flags = u[o + 6];
      // flag 2 is GHOST: not a live sprite.
      if (row && row.alive && !row.spectator && (flags & 2) === 0) {
        live.push({ id, x: f[o + 1], y: f[o + 2], angle: f[o + 3], size: f[o + 8], health: f[o + 9] });
      }
    }
    const spawns = [];
    for (const [id, row] of scores) {
      if (!row.spectator && Number.isFinite(row.spawnX) && Number.isFinite(row.spawnY)) spawns.push({ id, x: row.spawnX, y: row.spawnY });
    }
    const sounds = [];
    for (let j = 0; j < u[5]; j++) sounds.push(u[u[6] + j * 5]);
    // Bat hits this frame: player victims (kind 1, by id) and other victims (bodies, projectiles).
    const victims = [];
    let bodyHits = 0;
    for (let k = 0; k < u[34]; k++) {
      const o = u[35] + k * 3;
      if (u[o + 1] === 1) victims.push(u[o + 2]);
      else bodyHits++;
    }
    const hp = {};
    for (const p of live) hp[p.id] = p.health;
    const snap = {
      tick,
      live,
      spawns,
      arenaW: f[10],
      arenaH: f[11],
      localId,
      localLive: live.some((p) => p.id === localId),
      maxSize: live.reduce((m, p) => Math.max(m, p.size), 0),
    };
    acc.latest = snap;
    acc.snaps.set(tick, snap);
    if (acc.snaps.size > 32) acc.snaps.delete(acc.snaps.keys().next().value);
    const last = acc.log[acc.log.length - 1];
    if (!last || last.tick !== tick) {
      acc.log.push({ tick, hits: u[34], bodyHits, victims, bars: u[32], sounds, hp });
      if (acc.log.length > 20000) acc.log.shift();
    }
  };
  const wrap = (result) => {
    const ex = result.instance.exports;
    const api = { ...ex };
    const frame = ex.nb_frame;
    api.nb_frame = (nowMs, mask) => {
      const rc = frame(nowMs, mask);
      parse(ex);
      return rc;
    };
    const localFrame = ex.nb_local_frame;
    api.nb_local_frame = (dt, mask) => {
      const rc = localFrame(dt, mask);
      parse(ex);
      return rc;
    };
    return { module: result.module, instance: { exports: api } };
  };
  const origStreaming = WebAssembly.instantiateStreaming;
  WebAssembly.instantiateStreaming = async (...a) => wrap(await origStreaming.apply(WebAssembly, a));
  const origInstantiate = WebAssembly.instantiate;
  WebAssembly.instantiate = async (...a) => {
    const r = await origInstantiate.apply(WebAssembly, a);
    return r.instance ? wrap(r) : r;
  };

  // Contrast of one sprite: median relative luminance of its interior (inside 0.6 half-sizes) against
  // the ring (1.8 to 2.6 half-sizes) on the canvas the frame was just drawn to. WCAG ratio of the two.
  const sampleContrast = (snap, cam) => {
    const src = document.querySelector("#gl-host canvas");
    if (!(src instanceof HTMLCanvasElement) || src.width === 0 || src.height === 0) return;
    const W = src.width;
    const H = src.height;
    if (!acc.scratch) acc.scratch = document.createElement("canvas");
    acc.scratch.width = W;
    acc.scratch.height = H;
    const g = acc.scratch.getContext("2d", { willReadFrequently: true });
    g.drawImage(src, 0, 0);
    const sx = W / cam.w;
    const sy = H / cam.h;
    for (const p of snap.live) {
      const cx = (p.x - cam.cx) * sx + W / 2;
      const cy = (p.y - cam.cy) * sy + H / 2;
      const r = (p.size / 2) * sx;
      if (!(r >= 3)) continue;
      const reach = Math.ceil(2.6 * r);
      const x0 = Math.max(0, Math.floor(cx - reach));
      const y0 = Math.max(0, Math.floor(cy - reach));
      const x1 = Math.min(W, Math.ceil(cx + reach));
      const y1 = Math.min(H, Math.ceil(cy + reach));
      if (x1 - x0 < 4 || y1 - y0 < 4) continue;
      const img = g.getImageData(x0, y0, x1 - x0, y1 - y0).data;
      const fg = [];
      const bg = [];
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const m = Math.max(Math.abs(xx + 0.5 - cx), Math.abs(yy + 0.5 - cy));
          if (m > 0.6 * r && (m <= 1.8 * r || m > 2.6 * r)) continue;
          const i = ((yy - y0) * (x1 - x0) + (xx - x0)) * 4;
          const lum = 0.2126 * LUT[img[i]] + 0.7152 * LUT[img[i + 1]] + 0.0722 * LUT[img[i + 2]];
          if (m <= 0.6 * r) fg.push(lum);
          else bg.push(lum);
        }
      }
      if (fg.length < 4 || bg.length < 4) continue;
      fg.sort((a, b) => a - b);
      bg.sort((a, b) => a - b);
      const lf = acc.selfTest === "contrast" ? bg[bg.length >> 1] : fg[fg.length >> 1];
      const lb = bg[bg.length >> 1];
      const ratio = (Math.max(lf, lb) + 0.05) / (Math.min(lf, lb) + 0.05);
      if (acc.contrast.length < 5000) acc.contrast.push({ tick: snap.tick, id: p.id, ratio: Math.round(ratio * 100) / 100 });
    }
  };

  // Once per published camera frame (camera.ts sets __qaCam in computeCamera, before the draw):
  // every live player's centre must lie inside the view, or (an opponent only) be listed in cam.away for an edge indicator.
  const onDraw = () => {
    const cam = globalThis.__qaCam;
    if (!cam || cam.tick < 0 || cam.tick === acc.camTick) return;
    const snap = acc.snaps.get(cam.tick);
    if (!snap) return;
    acc.camTick = cam.tick;
    const inside = (p) => Math.abs(p.x - cam.cx) <= cam.w / 2 && Math.abs(p.y - cam.cy) <= cam.h / 2;
    const pts = snap.live.map((p) => ({ id: p.id, x: p.x, y: p.y }));
    // Self-test: a fake player one view width beyond the view's right and bottom edges, which the check must fail.
    if (acc.selfTest === "camera") pts.push({ id: -1, x: cam.cx + cam.w, y: cam.cy + cam.h });
    const out = pts.filter((p) => !inside(p));
    const localOut = snap.localLive && out.some((p) => p.id === snap.localId);
    const unindicated = out.filter((p) => p.id !== snap.localId && !cam.away.includes(p.id));
    acc.camFrames++;
    if (localOut) {
      acc.camLocalOut++;
      const lp = snap.live.find((p) => p.id === snap.localId);
      if (acc.camLocalDetail.length < 12) acc.camLocalDetail.push({ tick: cam.tick, follow: cam.follow, lx: lp.x, ly: lp.y, cx: cam.cx, cy: cam.cy, w: cam.w, h: cam.h, arenaW: snap.arenaW, arenaH: snap.arenaH });
    }
    if (unindicated.length) acc.camUnind++;
    if (out.length) {
      acc.camOut++;
      if (acc.camDetail.length < 20) acc.camDetail.push({ tick: cam.tick, ids: out.map((p) => p.id), localOut, unindicated: unindicated.map((p) => p.id) });
    }
    if (acc.contrastOn && snap.live.length && performance.now() - acc.lastSample >= cfg.sampleMs) {
      acc.lastSample = performance.now();
      sampleContrast(snap, cam);
    }
  };
  // A draw runs its drawing calls synchronously in the frame callback; a microtask queued by the draw
  // runs before the frame is composited (the probe pattern of e2e/lib.mjs installProbe).
  let queued = false;
  const afterDraw = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      onDraw();
    });
  };
  const glProto = WebGL2RenderingContext.prototype;
  const drawArrays = glProto.drawArrays;
  glProto.drawArrays = function (...args) {
    const result = drawArrays.apply(this, args);
    if (this.canvas.parentElement?.id === "gl-host") afterDraw();
    return result;
  };
  if (typeof GPUQueue !== "undefined") {
    const submit = GPUQueue.prototype.submit;
    GPUQueue.prototype.submit = function (...args) {
      const result = submit.apply(this, args);
      afterDraw();
      return result;
    };
  }
}

/**
 * Runs in the page: HUD boxes (visible leaf elements under the HUD root: .hud-root in a room match, the
 * playing view .offline.playing in practice) that overlap a live sprite's bounding box or a spawn point
 * (rubric D16), both mapped from engine state through the canvas rect and __qaCam. `selfTest` puts a fixed
 * 24px box over the local sprite first (the self-test defect). Not ready until at least one HUD box is
 * measured: a page with no HUD must not pass on zero boxes.
 */
function measureHud(selfTest) {
  const acc = window.__qaPF;
  const lat = acc?.latest;
  const cam = globalThis.__qaCam;
  const gl = document.querySelector("#gl-host canvas");
  if (!lat || !cam || cam.tick < 0 || !(gl instanceof HTMLCanvasElement)) return { ready: false };
  const root = document.querySelector(".hud-root, .offline.playing");
  if (!root) return { ready: false, reason: "no HUD root" };
  // The portrait gate (hud.ts) covers the HUD on portrait touch viewports: what it covers is not the HUD.
  if (root.querySelector(":scope > .hud-rotate:not([hidden])")) return { ready: false, reason: "portrait gate" };
  const r = gl.getBoundingClientRect();
  const sx = r.width / cam.w;
  const sy = r.height / cam.h;
  const toPx = (x, y) => [r.left + r.width / 2 + (x - cam.cx) * sx, r.top + r.height / 2 + (y - cam.cy) * sy];
  if (selfTest) {
    let d = document.getElementById("qa-pf-defect");
    if (!d) {
      d = document.createElement("div");
      d.id = "qa-pf-defect";
      d.style.cssText = "position:fixed;width:24px;height:24px;background:#f0f;pointer-events:none";
      root.appendChild(d);
    }
    const me = lat.live.find((p) => p.id === lat.localId) ?? lat.live[0];
    if (me) {
      const [cx, cy] = toPx(me.x, me.y);
      d.style.left = `${cx - 12}px`;
      d.style.top = `${cy - 12}px`;
    }
  }
  // Player: the bounding box of its (rotated) square. Spawn: the spawn point itself (rubric D16).
  const targets = [];
  for (const p of lat.live) {
    const e = (p.size / 2) * (Math.abs(Math.cos(p.angle)) + Math.abs(Math.sin(p.angle)));
    const [cx, cy] = toPx(p.x, p.y);
    targets.push({ name: `player ${p.id}`, point: false, x0: cx - e * sx, y0: cy - e * sy, x1: cx + e * sx, y1: cy + e * sy });
  }
  for (const s of lat.spawns) {
    const [cx, cy] = toPx(s.x, s.y);
    targets.push({ name: `spawn ${s.id}`, point: true, x0: cx, y0: cy, x1: cx, y1: cy });
  }
  const overlaps = (b, q) =>
    q.point ? b.left <= q.x0 && q.x0 <= b.right && b.top <= q.y0 && q.y0 <= b.bottom : b.left < q.x1 && b.right > q.x0 && b.top < q.y1 && b.bottom > q.y0;
  let boxes = 0;
  const names = [];
  let overlapping = 0;
  for (const el of root.querySelectorAll("*")) {
    if (el.childElementCount > 0 || el.getClientRects().length === 0) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || Number(cs.opacity) === 0) continue;
    const b = el.getBoundingClientRect();
    if (b.width < 1 || b.height < 1) continue;
    boxes++;
    const t = targets.find((q) => overlaps(b, q));
    if (!t) continue;
    overlapping++;
    if (names.length < 8) {
      const cls = typeof el.className === "string" ? el.className : (el.className?.baseVal ?? "");
      names.push(`${el.tagName.toLowerCase()}.${cls.trim().split(/\s+/).join(".")} over ${t.name}`);
    }
  }
  if (boxes === 0) return { ready: false, reason: "no visible HUD box" };
  return { ready: true, boxes, targets: targets.length, overlapping, names };
}

/**
 * Runs in the page: the edge chips of this frame (globalThis.__qaAway, published by overlay.ts) against the
 * local sprite and the HUD leaves (the leaf filter of measureHud). `chips` is null when the chips were published
 * for another tick than the camera's. Every off-screen opponent (cam.away) needs a chip.
 */
function measureAway() {
  const lat = window.__qaPF?.latest;
  const cam = globalThis.__qaCam;
  const aw = globalThis.__qaAway;
  const gl = document.querySelector("#gl-host canvas");
  if (!lat || !cam || cam.tick < 0 || !(gl instanceof HTMLCanvasElement)) return { ready: false };
  const away = cam.away.length;
  if (away === 0) return { ready: true, away, chips: 0, missing: 0, overLocal: 0, overHud: 0, names: [] };
  if (!aw || aw.tick !== cam.tick) return { ready: true, away, chips: null, missing: 0, overLocal: 0, overHud: 0, names: [] };
  const chips = aw.chips.map((c) => ({ id: c.id, left: c.x, top: c.y, right: c.x + c.w, bottom: c.y + c.h }));
  const missing = cam.away.filter((id) => !chips.some((c) => c.id === id)).length;
  const hit = (b, q) => b.left < q.right && b.right > q.left && b.top < q.bottom && b.bottom > q.top;
  const r = gl.getBoundingClientRect();
  const sx = r.width / cam.w;
  const sy = r.height / cam.h;
  const toPx = (x, y) => [r.left + r.width / 2 + (x - cam.cx) * sx, r.top + r.height / 2 + (y - cam.cy) * sy];
  let overLocal = 0;
  const me = lat.live.find((p) => p.id === lat.localId);
  if (me) {
    const e = (me.size / 2) * (Math.abs(Math.cos(me.angle)) + Math.abs(Math.sin(me.angle)));
    const [cx, cy] = toPx(me.x, me.y);
    const box = { left: cx - e * sx, right: cx + e * sx, top: cy - e * sy, bottom: cy + e * sy };
    overLocal = chips.filter((c) => hit(c, box)).length;
  }
  const names = [];
  let overHud = 0;
  const root = document.querySelector(".hud-root, .offline.playing");
  if (root) {
    for (const el of root.querySelectorAll("*")) {
      if (el.childElementCount > 0 || el.getClientRects().length === 0) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || Number(cs.opacity) === 0) continue;
      const b = el.getBoundingClientRect();
      if (b.width < 1 || b.height < 1) continue;
      const box = { left: b.left, right: b.right, top: b.top, bottom: b.bottom };
      for (const c of chips) {
        if (!hit(c, box)) continue;
        overHud++;
        if (names.length < 8) {
          const cls = typeof el.className === "string" ? el.className : (el.className?.baseVal ?? "");
          names.push(`${el.tagName.toLowerCase()}.${cls.trim().split(/\s+/).join(".")} under chip ${c.id}`);
        }
      }
    }
  }
  return { ready: true, away, chips: chips.length, missing, overLocal, overHud, names };
}

/** Whether the run of hit ticks from log[i] landed on something that reacts: a body or projectile, or a player alive before the hit. A hit on a dead player has no feedback to give. */
function reactsToHit(log, i) {
  for (let j = i; j < log.length && log[j].hits > 0; j++) {
    if (log[j].bodyHits > 0) return true;
    const prev = j > 0 ? log[j - 1] : null;
    if (!prev || log[j].victims.some((id) => id in prev.hp)) return true;
  }
  return false;
}

/**
 * Pure: feedback events of an engine log (one per run of ticks with hit records). Frames = ticks.
 * visual: the hit flash, drawn from the predicted hit record of the frame (overlay hitFlashes), so 0 when the
 * frame that carries the record is the hit's frame. sound: the first hit sound of the predicted stream.
 * consequence (reported, not judged): the first frame where a victim's health drops or dies or a damage bar grows;
 * for a player victim that is the KO after the fall, so it can be many ticks after the hit.
 */
export function feedbackEvents(log) {
  const events = [];
  for (let i = 0; i < log.length; i++) {
    if (!(log[i].hits > 0) || (i > 0 && log[i - 1].hits > 0)) continue;
    if (!reactsToHit(log, i)) continue;
    const hit = log[i].tick;
    let visual = null;
    let sound = null;
    let consequence = null;
    for (let j = i; j < log.length && (visual === null || sound === null || consequence === null); j++) {
      const f = log[j];
      const prev = j > 0 ? log[j - 1] : null;
      if (visual === null && f.hits > 0) visual = f.tick - hit;
      if (consequence === null && prev) {
        const dropped = Object.keys(f.hp).some((id) => id in prev.hp && f.hp[id] < prev.hp[id]);
        const killed = log[i].victims.some((id) => id in prev.hp && !(id in f.hp));
        if (dropped || killed || f.bars > prev.bars) consequence = f.tick - hit;
      }
      if (sound === null && f.sounds.some((k) => HIT_SOUNDS.includes(k))) sound = f.tick - hit;
    }
    events.push({ tick: hit, visual, sound, consequence, frames: visual === null || sound === null ? null : Math.max(visual, sound) });
  }
  return events;
}

/** Pure: the feedback metric over a log; events whose window is still open are not judged. */
export function feedbackMetric(log) {
  const last = log.length ? log[log.length - 1].tick : 0;
  const closed = feedbackEvents(log).filter((e) => e.tick <= last - OPEN_TAIL_TICKS);
  const missing = closed.filter((e) => e.frames === null).length;
  const frames = closed.filter((e) => e.frames !== null).map((e) => e.frames);
  return { events: closed.length, missing, max: frames.length ? Math.max(...frames) : null };
}

/** Synthetic log for the feedback self-test: `hits` hits on player 1 (every 10 ticks from tick 10); each one's health drop and hit sound come `delay` ticks later. */
export function syntheticLog(delay, hits = 1) {
  const hitTicks = Array.from({ length: hits }, (_, k) => 10 + 10 * k);
  const log = [];
  for (let t = 0; t <= hitTicks[hits - 1] + 80; t++) {
    const landed = hitTicks.filter((h) => t >= h + delay).length;
    log.push({ tick: t, hits: hitTicks.includes(t) ? 1 : 0, bodyHits: 0, victims: hitTicks.includes(t) ? [1] : [], bars: 0, sounds: hitTicks.includes(t - delay) ? [6] : [], hp: { 1: 100 - 5 * landed } });
  }
  return log;
}

function feedbackVerdict(log) {
  const m = feedbackMetric(log);
  const enough = m.events >= FEEDBACK_MIN_EVENTS;
  const pass = enough && m.missing === 0 && m.max <= FEEDBACK_MAX;
  const detail = `${m.events} hit events (${enough ? "enough" : `need ${FEEDBACK_MIN_EVENTS}`}), max ${m.max} frames, ${m.missing} without feedback (threshold ${FEEDBACK_MAX})`;
  return { pass, metrics: { "feedback.hit.frames": m.max, "feedback.hit.events": m.events, "feedback.hit.missing": m.missing }, detail };
}

/** Opens a page in a context sized and touch-emulated for `row` (its own context; the match is a fresh room). */
async function openPage(s, browser, engine, row, cfg, opened) {
  const touch = isTouch(row);
  const ip = nextClientIp();
  const context = await browser.newContext({
    viewport: { width: row.W, height: row.H },
    deviceScaleFactor: row.dsf,
    isMobile: touch && engine !== "firefox",
    hasTouch: touch,
    acceptDownloads: true,
    extraHTTPHeaders: { "X-Forwarded-For": ip },
  });
  await stripThirdPartyForwardedFor(context);
  await context.addInitScript(playfieldInit, { hideGpu: cfg.renderer !== "webgpu", palette: cfg.palette, name: cfg.name, selfTest: cfg.selfTest, sampleMs: SAMPLE_MS });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  const handle = { label: cfg.label, context, page, ip, problems: [] };
  page.on("pageerror", (err) => handle.problems.push(`${cfg.label}: page error: ${err.message}`));
  page.on("console", (msg) => {
    if (msg.type() === "error") handle.problems.push(`${cfg.label}: console error: ${msg.text()}`);
  });
  page.on("dialog", (dialog) => {
    handle.problems.push(`${cfg.label}: unexpected dialog: ${dialog.message()}`);
    void dialog.dismiss();
  });
  watchPage(handle);
  s.handles.push(handle);
  opened.push(handle);
  return handle;
}

async function waitMatch(page, renderer) {
  await page.waitForFunction(() => window.__qaPF?.latest?.localLive === true, null, { timeout: 30000 });
  await page.waitForFunction(() => !!document.documentElement.dataset.renderer, null, { timeout: 30000 });
  const got = await page.evaluate(() => document.documentElement.dataset.renderer);
  if (got !== renderer) throw new Error(`renderer is ${got}, expected ${renderer}`);
}

/** Random key holds on every page for `ms` (moves, jumps, bat and push): exercises the camera and produces hits. */
async function drive(pages, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await Promise.all(
      pages.map(async (p) => {
        const key = DRIVE_KEYS[Math.floor(Math.random() * DRIVE_KEYS.length)];
        await p.keyboard.down(key);
        await sleep(250 + Math.random() * 400);
        await p.keyboard.up(key);
      }),
    );
  }
}
/**
 * Practice from the menu as lib-qa's startPractice does, but dismisses the touch-only phone welcome after
 * the page loads (it covers the Start button on touch rows). Pixels are not probed (the tier cell reads none).
 */
async function startPracticeHere(h, base, renderer) {
  await h.page.goto(base);
  await dismissPhoneSplash(h.page);
  await menuName(h.page).waitFor({ timeout: 15000 });
  await navTo(h.page, "Practice");
  await h.page.locator(".offline-list .offline-choice").first().click({ timeout: 15000 });
  await button(h.page, "Start").click({ timeout: 15000 });
  await h.page.locator(".offline.playing").waitFor({ timeout: 15000 });
  await h.page.waitForFunction(() => !!document.documentElement.dataset.renderer, null, { timeout: 30000 });
  const got = await h.page.evaluate(() => document.documentElement.dataset.renderer ?? null);
  if (got !== renderer) throw new Error(`renderer is ${got}, expected ${renderer}`);
}

/** One tier cell: a practice match (the local player alone; no room, no second client) at the tier's viewport and palette; HUD overlap and (T1-M, T5-T) sprite contrast. */
async function tierCell(results, browser, engine, base, tier, palette, renderer, selfTest) {
  const row = rowOf(tier);
  const id = `${tier}.${palette}.${renderer}`;
  const opened = [];
  const contrastOn = CONTRAST_TIERS.includes(tier);
  const out = await results.case(
    id,
    async (s) => {
      const h = await openPage(s, browser, engine, row, { label: `player-${tier}`, renderer, palette, name: uniqueName("pf"), selfTest }, opened);
      await startPracticeHere(h, base, renderer);
      await h.page.waitForFunction(() => window.__qaPF?.latest?.localLive === true, null, { timeout: 30000 });
      await h.page.evaluate((on) => {
        const a = window.__qaPF;
        a.log.length = 0;
        a.contrast.length = 0;
        a.contrastOn = on;
      }, contrastOn);
      const samples = [];
      let worst = null;
      let minBoxes = null;
      let gated = 0;
      const t0 = Date.now();
      while (Date.now() - t0 < HUD_MS) {
        const m = await h.page.evaluate(measureHud, selfTest === "hud");
        if (m.reason === "portrait gate") {
          gated++;
          await button(h.page, "Play in portrait anyway").click({ timeout: 5000 });
          continue;
        }
        if (m.ready) {
          samples.push(m.overlapping);
          minBoxes = minBoxes === null ? m.boxes : Math.min(minBoxes, m.boxes);
          if (!worst || m.overlapping > worst.overlapping) worst = m;
        }
        await sleep(HUD_EVERY_MS);
      }
      const contrast = await h.page.evaluate(() => {
        window.__qaPF.contrastOn = false;
        return window.__qaPF.contrast.slice();
      });
      const hudMax = samples.length ? Math.max(...samples) : null;
      const fails = contrastOn ? contrast.filter((c) => c.ratio < CONTRAST_MIN).length : null;
      const minRatio = contrastOn && contrast.length ? Math.min(...contrast.map((c) => c.ratio)) : null;
      const file = path.join(results.evidenceDir, `${id}.png`.replaceAll(/[^\w.\-]+/g, "_"));
      const saved = await shot(h.page, file);
      const problems = [];
      if (samples.length === 0) problems.push("no measurable HUD sample (no HUD root, or engine state not ready)");
      if (contrastOn && contrast.length === 0) problems.push("no sprite contrast sample");
      const pass = problems.length === 0 && hudMax === 0 && (fails === null || fails === 0);
      return {
        pass,
        detail: [
          problems.join("; "),
          `playfield.hudOverlap=${hudMax} over ${minBoxes ?? 0} HUD boxes min${worst?.names.length ? ` (${worst.names.join("; ")})` : ""}`,
          gated ? `portrait gate dismissed ${gated}x (Play in portrait anyway)` : null,
          contrastOn ? `contrast.sprite.fails=${fails} min ${minRatio}:1 over ${contrast.length} sprite samples` : null,
        ]
          .filter(Boolean)
          .join(", "),
        metrics: {
          "playfield.hudOverlap": hudMax,
          "playfield.hudBoxes": minBoxes,
          "playfield.samples": samples.length,
          "contrast.sprite.fails": fails,
          "contrast.sprite.minRatio": minRatio,
          "contrast.sprite.samples": contrast.length,
        },
        evidence: saved ? [rel(saved)] : [],
      };
    },
    { browser, base },
  );
  for (const h of opened) await h.context.close().catch(() => undefined);
  return out;
}

/** The renderer each engine can run here: WebGPU on chromium only, WebGL2 elsewhere. */
const rendererFor = (engine) => (engine === "chromium" ? "webgpu" : "webgl2");

/** Two clients in one room on `mapName` (or the room default), running random inputs for `ms`. */
async function pairMatch(s, browser, engine, base, { mapName = null, mapJson = null, selfTest, renderer = rendererFor(engine), palette = "default" }, opened) {
  const row = rowOf("T1-M");
  const roomName = uniqueName("room");
  const hostName = uniqueName("host");
  const guestName = uniqueName("guest");
  const host = await openPage(s, browser, engine, row, { label: "host", renderer, palette, name: hostName, selfTest }, opened);
  const code = await createRoom(host, base, roomName, { isPublic: true });
  await dismissPhoneSplash(host.page);
  const guest = await openPage(s, browser, engine, row, { label: "guest", renderer, palette, name: guestName, selfTest }, opened);
  await joinByInvite(guest, base, code, roomName);
  await dismissPhoneSplash(guest.page);
  if (mapName || mapJson) {
    await host.page.getByRole("button", { name: "Change map", exact: true }).click();
    if (mapJson) {
      await host.page.getByLabel("Map code or JSON", { exact: true }).fill(mapJson);
      await host.page.getByRole("button", { name: "Use code", exact: true }).click();
      await host.page.locator(".room-map-name").filter({ hasText: "Custom map" }).waitFor({ timeout: 60000 });
    } else {
      // The built-in list loads async (room.ts "loading maps"); on a loaded shared host it can take longer than the 20s default.
      const mapBtn = host.page.locator(".room-map-list button").filter({ hasText: mapName }).first();
      await mapBtn.waitFor({ timeout: 60000 });
      await mapBtn.click();
      await host.page.locator(".room-map-name").filter({ hasText: mapName }).waitFor();
    }
  }
  await startMatch(host, [guest]);
  await waitMatch(host.page, renderer);
  await waitMatch(guest.page, renderer);
  return { host, guest };
}

/** Samples one page's edge chips while it plays (see measureAway): frames with an off-screen opponent, and what is wrong in them. */
async function sampleAway(page, ms) {
  const acc = { awayFrames: 0, staleFrames: 0, missing: 0, overLocalFrames: 0, overHud: 0, names: [] };
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const m = await page.evaluate(measureAway);
    if (m.ready && m.away > 0) {
      if (m.chips === null) acc.staleFrames++;
      else {
        acc.awayFrames++;
        acc.missing += m.missing;
        if (m.overLocal > 0) acc.overLocalFrames++;
        acc.overHud += m.overHud;
        for (const n of m.names) if (acc.names.length < 8) acc.names.push(n);
      }
    }
    await sleep(SAMPLE_MS);
  }
  return acc;
}

/**
 * Static (rubric chips): the edge chip's name is white on its panel (rgba(0,0,0,0.5) over the ground) for every
 * shipped ground (map sets "12" and "17", and the void). The player colour is a swatch: a colour darker than
 * AWAY_RING_BELOW_LUM gets a white ring (overlay.ts), so the colour meets the ring and the ring meets the panel;
 * a lighter colour meets the panel directly. Colours are the ones overlay.ts draws (PALETTES; team and FFA
 * colours). Room colours are swatches only, so they need no per-colour text check.
 */
async function chipContrastCase(results) {
  return results.case("chip.contrast", async () => {
    const grounds = new Set([0x0a0a0a]);
    for (const f of readdirSync(MAPS_DIR).filter((f) => f.endsWith(".json"))) {
      const set = JSON.parse(readFileSync(path.join(MAPS_DIR, f), "utf8")).map?.set ?? {};
      for (const k of ["12", "17"]) if (typeof set[k] === "number") grounds.add(set[k]);
    }
    const lum = relLuminance;
    const ratio = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    const panelOver = (bg) => {
      const ch = (s) => Math.round(((bg >> s) & 255) * 0.5);
      return (ch(16) << 16) | (ch(8) << 8) | ch(0);
    };
    const colours = new Set();
    for (const p of Object.values(GEOMETRY_PALETTES)) {
      colours.add(p.red);
      colours.add(p.blue);
      for (const c of p.ffa) colours.add(c);
    }
    let textMin = Infinity;
    let ringMin = Infinity;
    let swatchMin = Infinity;
    const white = lum(0xffffff);
    for (const g of grounds) {
      const panelLum = lum(panelOver(g));
      textMin = Math.min(textMin, ratio(white, panelLum));
      // Dark colours get a ring: the ring meets the panel, the colour meets the ring. Lighter colours meet the panel.
      ringMin = Math.min(ringMin, ratio(white, panelLum));
      for (const c of colours) {
        const cl = lum(c);
        swatchMin = Math.min(swatchMin, cl < AWAY_RING_BELOW_LUM ? ratio(cl, white) : ratio(cl, panelLum));
      }
    }
    const pass = textMin >= CHIP_TEXT_MIN && ringMin >= CHIP_SWATCH_MIN && swatchMin >= CHIP_SWATCH_MIN;
    return {
      pass,
      detail: `chip name white on panel min ${textMin.toFixed(2)}:1 over ${grounds.size} grounds (need ${CHIP_TEXT_MIN}); swatch edge (white ring if dark, else panel) min ${swatchMin.toFixed(2)}:1 over ${colours.size} palette colours (need ${CHIP_SWATCH_MIN}); ring white on panel min ${ringMin.toFixed(2)}:1`,
      metrics: { "chip.textMinRatio": Math.round(textMin * 100) / 100, "chip.ringMinRatio": Math.round(ringMin * 100) / 100, "chip.swatchMinRatio": Math.round(swatchMin * 100) / 100, "chip.grounds": grounds.size, "chip.paletteColours": colours.size },
    };
  });
}

/** Pure: camera.inView (rubric D16) from the frame counts; 1 only when every live player is inside the view on every frame. */
export function cameraInView(frames, outFrames) {
  return frames > 0 && outFrames === 0 ? 1 : 0;
}

/** Camera (rubric camera.inView): both clients play one map; every live player's centre must be in view on every published frame. `forced`: nobody moves, so on a wide map the spawns leave an opponent off-screen and its edge chip must show. */
async function cameraCase(results, browser, engine, base, map, selfTest, forced = false) {
  const mapOpt = typeof map === "string" ? { mapName: map } : { mapJson: map.json };
  const id = `camera.${(typeof map === "string" ? map : map.id).replaceAll(/[^\w]+/g, "-").toLowerCase()}${forced ? "-forced-away" : ""}`;
  const opened = [];
  const out = await results.case(
    id,
    async (s) => {
      const { host, guest } = await pairMatch(s, browser, engine, base, { ...mapOpt, selfTest }, opened);
      for (const h of [host, guest]) await h.page.evaluate(() => Object.assign(window.__qaPF, { camFrames: 0, camOut: 0, camLocalOut: 0, camUnind: 0, camDetail: [], camLocalDetail: [] }));
      const [, ...chipPer] = await Promise.all([forced ? sleep(CAM_MS) : drive([host.page, guest.page], CAM_MS), ...[host, guest].map((h) => sampleAway(h.page, CAM_MS))]);
      const per = [];
      for (const h of [host, guest]) per.push(await h.page.evaluate(() => ({ frames: window.__qaPF.camFrames, out: window.__qaPF.camOut, localOut: window.__qaPF.camLocalOut, unind: window.__qaPF.camUnind, detail: window.__qaPF.camDetail, localDetail: window.__qaPF.camLocalDetail })));
      const frames = per.reduce((n, p) => n + p.frames, 0);
      const outFrames = per.reduce((n, p) => n + p.out, 0);
      const localOut = per.reduce((n, p) => n + p.localOut, 0);
      const unind = per.reduce((n, p) => n + p.unind, 0);
      // Rubric D16 (camera.inView): 1 only when every live player, the local one and every opponent, is inside the view on every published frame.
      const inView = cameraInView(frames, outFrames);
      const allInView = frames > 0 ? (frames - outFrames) / frames : 0;
      // Edge chips (overlay.ts drawAway) while someone is off-screen: each has a chip; none covers the local sprite or a HUD box.
      const chipAway = chipPer.reduce((n, c) => n + c.awayFrames, 0);
      const chipMissing = chipPer.reduce((n, c) => n + c.missing, 0);
      const chipLocal = chipPer.reduce((n, c) => n + c.overLocalFrames, 0);
      const chipHud = chipPer.reduce((n, c) => n + c.overHud, 0);
      const chipNames = chipPer.flatMap((c) => c.names).slice(0, 8);
      const chipOk = chipMissing === 0 && chipLocal === 0 && chipHud === 0;
      // Forced-away run: an opponent is off-screen by design, so the pass is each off-screen opponent having its edge chip (and the local player in view).
      const indicated = frames > 0 && localOut === 0 && unind === 0 && chipAway > 0 ? 1 : 0;
      const file = path.join(results.evidenceDir, `${id}.png`);
      const saved = await shot(host.page, file);
      return {
        pass: forced ? indicated === 1 && chipOk : inView === 1 && chipOk,
        detail: `camera.inView=${inView}: local out on ${localOut} frames, opponents out without indicator on ${unind}; all live in view on ${(allInView * 100).toFixed(1)}% of ${frames} frames (host ${per[0].out}/${per[0].frames} out, guest ${per[1].out}/${per[1].frames} out); chips over ${chipAway} away frames: missing ${chipMissing}, over local sprite ${chipLocal}, over HUD ${chipHud}${chipNames.length ? ` (${chipNames.join("; ")})` : ""}`,
        metrics: { ...(forced ? { "camera.indicatedAway": indicated } : { "camera.inView": inView }), "camera.localOutFrames": localOut, "camera.indicatorMissFrames": unind, "camera.allInView": Math.round(allInView * 1000) / 1000, "camera.outFrames": outFrames, "camera.frames": frames, "camera.detail": per.flatMap((p) => p.detail).slice(0, 10), "camera.localDetail": per.flatMap((p) => p.localDetail).slice(0, 12), "chip.awayFrames": chipAway, "chip.missing": chipMissing, "chip.overLocalFrames": chipLocal, "chip.overHud": chipHud, "chip.names": chipNames },
        evidence: saved ? [rel(saved)] : [],
      };
    },
    { browser, base },
  );
  for (const h of opened) await h.context.close().catch(() => undefined);
  return out;
}

/** Feedback (rubric feedback.hit.frames): two clients play randomly for PLAY_MS; the host's engine log is judged. */
async function feedbackCase(results, browser, engine, base) {
  const opened = [];
  const out = await results.case(
    "feedback.hit.frames",
    async (s) => {
      const renderer = rendererFor(engine);
      const fixture = { base, open: (label, o) => openPage(s, browser, engine, rowOf("T1-M"), { label, renderer, palette: "default", name: o.name, selfTest: null }, opened) };
      const { host, guest } = await fixtureMatch(fixture, 99);
      await sleep(3000); // spawn grace before a bat can hit (sim SPAWN_GRACE)
      await host.page.evaluate(() => {
        window.__qaPF.log.length = 0;
      });
      // Rounds of point-blank bat swings, then random play, until FEEDBACK_MIN_EVENTS judged hit events exist or the time cap is reached.
      const started = Date.now();
      let log = [];
      for (;;) {
        await Promise.all([host.page, guest.page].map(async (page) => {
          for (let i = 0; i < FEEDBACK_SWINGS; i++) {
            await page.keyboard.down("KeyC");
            await sleep(BAT_HOLD_MS); // the bat fires at tick 13 (bat_fire_on)
            await page.keyboard.up("KeyC");
            await sleep(BAT_GAP_MS); // the bat cycle resets at tick 35 (bat_reset_on)
          }
        }));
        await drive([host.page, guest.page], PLAY_MS);
        log = await host.page.evaluate(() => window.__qaPF.log.slice());
        if (feedbackMetric(log).events >= FEEDBACK_MIN_EVENTS || Date.now() - started >= FEEDBACK_CAP_MS) break;
      }
      const hud = await host.page.evaluate(() => document.querySelectorAll(".hud-events li.hud-event-hit").length);
      await writeFile(path.join(results.evidenceDir, "feedback-events.json"), JSON.stringify({ logLength: log.length, logHits: log.reduce((n, f) => n + f.hits, 0), hudHitEvents: hud, events: feedbackEvents(log) }, null, 1));
      const verdict = feedbackVerdict(log);
      const file = path.join(results.evidenceDir, "feedback-hit-frames.png");
      const saved = await shot(host.page, file);
      return { ...verdict, evidence: saved ? [rel(saved)] : [] };
    },
    { browser, base },
  );
  for (const h of opened) await h.context.close().catch(() => undefined);
  return out;
}

const mode = selfTestMode();

const CASES = (process.env.QA_CASES ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const wantCase = (name) => CASES.length === 0 || CASES.includes(name);

if (mode === "feedback") {
  // Pure self-test: no browser, no server.
  const results = new Results("playfield", "pure");
  await results.case("feedback.selfTest", async () => feedbackVerdict(syntheticLog(5, FEEDBACK_MIN_EVENTS)));
  results.save();
  writeIndex();
} else if (mode === "camera-pure") {
  // Pure self-test: no browser, no server. A frame where the live players are all out of view must not read as in view (the same check as the forced-away run).
  const results = new Results("playfield", "pure");
  await results.case("camera.selfTest", async () => {
    const allOut = cameraInView(100, 100);
    return { pass: allOut === 1, detail: `every frame out of view reads as camera.inView=${allOut} (a working instrument gives 0); all in view reads ${cameraInView(100, 0)}; no frames read ${cameraInView(0, 0)}` };
  });
  results.save();
  writeIndex();
} else {
  const server = await startServer();
  const base = server.base;
  for (const engine of selectedEngines()) {
    const browser = await launchEngine(engine);
    const results = new Results("playfield", engine);
    const renderers = engine === "chromium" ? ["webgpu", "webgl2"] : ["webgl2"];
    if (mode === null) {
      for (const tier of wantCase("tier") ? TIERS : []) {
        for (const palette of PALETTES) {
          for (const renderer of renderers) await tierCell(results, browser, engine, base, tier, palette, renderer, null);
        }
      }
      for (const map of wantCase("camera") ? REFERENCE_MAPS : []) {
        await cameraCase(results, browser, engine, base, map, null);
      }
      if (wantCase("camera")) await cameraCase(results, browser, engine, base, QA_WIDE, null, true);
      if (wantCase("camera")) await chipContrastCase(results);
      if (engine === "chromium" && wantCase("feedback")) await feedbackCase(results, browser, engine, base);
    } else if (mode === "hud" || mode === "contrast") {
      await tierCell(results, browser, engine, base, "T1-M", "default", renderers[0], mode);
    } else if (mode === "camera") {
      await cameraCase(results, browser, engine, base, REFERENCE_MAPS[0], mode);
    }
    results.save();
    await browser.close().catch(() => undefined);
    if (mode) break;
  }
  writeIndex();
  await runCleanups();
}
