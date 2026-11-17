// The rubric capture plan (RUBRIC rev7, section 2.2): every cell the sweep must cover, by tier.
// Pure data, no browser. A cell is (tier, state, engine, theme, row, axis, renderer); a physical run
// is the distinct (engine, theme, row, axis, renderer, state) tuple, so a state present in two tiers
// (postgame) is captured once and counted in both.

import { ROW_G_MOCK, TIER_F_ROWS, TIER_P_ROWS, rowById } from "./presets.mjs";

export const ENGINES = ["chromium", "firefox", "webkit"];
export const THEMES = ["light", "dark"];

/** Engine and renderer pairs for the gameplay and canvas tiers (chromium runs both renderers). */
export const COMBOS = [
  { engine: "chromium", renderer: "webgpu" },
  { engine: "chromium", renderer: "webgl2" },
  { engine: "firefox", renderer: "webgl2" },
  { engine: "webkit", renderer: "webgl2" },
];

/** Appearance axes of tier A: reduced motion, forced colours, more contrast, colour-blind palettes. */
export const AXES_A = ["reduce", "forced", "more", "palette-deuteranopia", "palette-protanopia", "palette-tritanopia"];

/** Tier P: page screens, every engine, the 18 viewport rows (T3-notch is added on chromium only). */
export const P_STATES = [
  "menu-anon", "menu-quick", "browse", "room-host", "library-grid", "friends-empty", "settings", "about",
  "privacy", "account-guest", "profile", "menu-news", "postgame", "postgame-user",
];
/** Tier F: fit screens (gameplay, replay, editor), on the four engine/renderer combos. */
export const F_STATES = ["match-running", "training", "practice-running", "replay-loaded", "editor-empty"];
/** Gameplay screens, which also run under the gamepad mock row. */
export const F_GAMEPLAY = ["match-running", "training", "practice-running"];
/** Tier A, combos x rows x axes: the gameplay and home screens. */
export const A_COMBO_STATES = ["match-running", "menu-anon"];
/** Tier A, engines x rows x axes (no renderer): room and settings. */
export const A_ENGINE_STATES = ["room-host", "settings"];
/** Tier S, canvas states on the combos. */
export const S_CANVAS_STATES = ["menu-user", "match-full", "match-kicked", "match-disconnected", "offline-match"];
export const S_STANDALONE = "menu-standalone";
/** Tier S, the remaining states on engines x rows (no renderer). */
export const S_OTHER_STATES = [
  "create-room", "error-toast", "settings-controls", "account-user", "room-full", "error-404-room", "error-api",
  "toast-invite", "empty-library", "empty-browser", "offline-load", "postgame",
];

/** Cell counts the plan must produce (RUBRIC rev7 tiers: 2572 cells in total). */
export const EXPECTED = { P: 1540, F: 464, A: 336, S: 232 };
export const EXPECTED_TOTAL = 2572;

const rowsA = () => [rowById("T1-M"), rowById("T3-T")];

/** Every planned cell, in a stable order. */
export function planCells() {
  const cells = [];
  const add = (tier, state, engine, theme, row, axis, renderer) => cells.push({ tier, state, engine, theme, row, axis, renderer });

  for (const state of P_STATES)
    for (const engine of ENGINES)
      for (const theme of THEMES)
        for (const row of TIER_P_ROWS) add("P", state, engine, theme, row, "none", null);
  for (const state of P_STATES)
    for (const theme of THEMES) add("P", state, "chromium", theme, rowById("T3-notch"), "none", null);

  for (const state of F_STATES)
    for (const { engine, renderer } of COMBOS)
      for (const theme of THEMES) {
        for (const row of TIER_F_ROWS) add("F", state, engine, theme, row, "none", renderer);
        if (F_GAMEPLAY.includes(state)) add("F", state, engine, theme, ROW_G_MOCK, "none", renderer);
      }

  for (const state of A_COMBO_STATES)
    for (const { engine, renderer } of COMBOS)
      for (const theme of THEMES)
        for (const row of rowsA()) for (const axis of AXES_A) add("A", state, engine, theme, row, axis, renderer);
  for (const state of A_ENGINE_STATES)
    for (const engine of ENGINES)
      for (const theme of THEMES)
        for (const row of rowsA()) for (const axis of AXES_A) add("A", state, engine, theme, row, axis, null);

  for (const state of S_CANVAS_STATES)
    for (const { engine, renderer } of COMBOS)
      for (const theme of THEMES) for (const row of rowsA()) add("S", state, engine, theme, row, "none", renderer);
  for (const { engine, renderer } of COMBOS)
    for (const theme of THEMES) add("S", S_STANDALONE, engine, theme, rowById("T3-T"), "none", renderer);
  for (const state of S_OTHER_STATES)
    for (const engine of ENGINES)
      for (const theme of THEMES) for (const row of rowsA()) add("S", state, engine, theme, row, "none", null);

  return cells;
}

/** Identity of one physical capture; cells that share it run once. */
export const runKey = (c) => [c.engine, c.theme, c.row.id, c.axis, c.renderer ?? "-", c.state].join("|");

/** Distinct physical runs of the cells, each carrying the list of tiers that name it. */
export function uniqueRuns(cells) {
  const runs = new Map();
  for (const c of cells) {
    const key = runKey(c);
    if (!runs.has(key)) runs.set(key, { ...c, tiers: [] });
    const run = runs.get(key);
    if (!run.tiers.includes(c.tier)) run.tiers.push(c.tier);
  }
  return [...runs.values()];
}

/** Cells matching every given filter (each an array of allowed values; omitted = any). */
export function filterCells(cells, { tiers, states, rows, engines, themes } = {}) {
  const ok = (list, value) => !list || list.includes(value);
  return cells.filter(
    (c) => ok(tiers, c.tier) && ok(states, c.state) && ok(rows, c.row.id) && ok(engines, c.engine) && ok(themes, c.theme),
  );
}

/** Human-readable coverage of one tier: states, rows, combos, axes, themes and the cell count. */
export function describeTier(cells, tier) {
  const mine = cells.filter((c) => c.tier === tier);
  const uniq = (f) => [...new Set(mine.map(f))];
  const combos = uniq((c) => (c.renderer ? `${c.engine}/${c.renderer}` : c.engine));
  const lines = [
    `${tier}: ${mine.length} cells, ${uniqueRuns(mine).length} runs`,
    `  states (${uniq((c) => c.state).length}): ${uniq((c) => c.state).join(", ")}`,
    `  rows (${uniq((c) => c.row.id).length}): ${uniq((c) => c.row.id).join(", ")}`,
    `  engine/renderer: ${combos.join(", ")}`,
    `  axes: ${uniq((c) => c.axis).join(", ")}; themes: ${uniq((c) => c.theme).join(", ")}`,
  ];
  for (const state of uniq((c) => c.state)) {
    const n = mine.filter((c) => c.state === state).length;
    lines.push(`    ${state}: ${n}`);
  }
  return lines;
}
