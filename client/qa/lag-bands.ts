// Lag-band calibration for the editor's physics counter (editor/controller.ts lagVerdict).
// Times the production wasm sim (neobox.wasm) in Bun, with no browser: endless mode, 30 Hz tick, a floor plus
// N static 0.5-unit squares with no contacts. Each sample is one localFrame call, which advances one tick and builds
// its frame, so the cost matches what the editor pays per tick.
// Run: bun client/qa/lag-bands.ts <path to neobox.wasm>
import { readFileSync } from "node:fs";
import type { LocalStart, RawEngine } from "../src/engine.ts";

const TICK_HZ = 30;
const ENDLESS = 6;
const wasm = process.argv[2];
if (!wasm) throw new Error("usage: bun client/qa/lag-bands.ts <neobox.wasm>");

// engine.ts reads window at import time (page-leave.ts), so a static import would fail under Bun before this alias
// exists; the import has to follow it.
if (!("window" in globalThis)) Object.assign(globalThis, { window: globalThis });
const { Engine } = await import("../src/engine.ts");

const raw = await WebAssembly.instantiate(readFileSync(wasm), {});
// Wasm exports are untyped at runtime; the ABI is the NeoboxExports type that Engine expects.
const wasmExports = raw.instance.exports as unknown as RawEngine["exports"];
const eng = new Engine({ exports: wasmExports });

for (const n of [0, 800, 1600, 3200, 6400]) {
  const shapes: unknown[] = [{ p: [-200, -1, 200, -1, 200, 0, -200, 0] }];
  for (let i = 0; i < n; i++) {
    const cx = (i % 20) * 1.5 - 15;
    const cy = Math.floor(i / 20) * 1.5 + 1;
    shapes.push({ p: [cx - 0.25, cy - 0.25, cx + 0.25, cy - 0.25, cx + 0.25, cy + 0.25, cx - 0.25, cy + 0.25] });
  }
  const code = eng.mapEncode(JSON.stringify({ b: [{ "2": 0, "3": 0, s: shapes }], j: [], s: [], set: {} }));
  const start: LocalStart = { seed: 1, start_tick: 0, tick_hz: TICK_HZ, players: [[0, 1]], settings: { game_mode: ENDLESS }, maps: [code], intro: false, rotation: false };
  eng.localStart(start, 0);
  for (let i = 0; i < 20; i++) eng.localFrame(1000 / TICK_HZ, 0);
  const ticks = 200;
  const t = performance.now();
  for (let i = 0; i < ticks; i++) eng.localFrame(1000 / TICK_HZ, 0);
  const perTick = (performance.now() - t) / ticks;
  eng.localEnd();
  console.log(`RESULT shapes=${n + 1} ms_per_tick=${perTick.toFixed(2)}`);
}
