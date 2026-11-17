// Viewport-profile rows of the rubric (section 2.2 table). Each row is one capture geometry; `id` is
// the rubric row id and names the output directory. Z200/Z400 are the effective CSS viewports after
// browser zoom (zoom 200% of 1280x800, zoom 400% of 1280x1024). TS200 keeps the viewport and doubles
// the root font size. PL rows expand every visible string (pseudo-localisation).
// Input: M = mouse + keyboard, K = keyboard only (no pointer), T = touch emulation, G = gamepad mock.

export const ROWS = [
  { id: "T1-M", W: 1280, H: 800, dsf: 1, input: "M", textSpacing: true },
  { id: "T1-M2", W: 1280, H: 800, dsf: 2, input: "M" },
  { id: "T1-K", W: 1280, H: 800, dsf: 1, input: "K" },
  { id: "T2-M", W: 1920, H: 1080, dsf: 1, input: "M" },
  { id: "T2-M2", W: 1920, H: 1080, dsf: 2, input: "M" },
  { id: "T3-T", W: 390, H: 844, dsf: 2, input: "T" },
  { id: "T3-notch", W: 390, H: 844, dsf: 2, input: "T", notch: { top: 47, bottom: 34 } },
  { id: "T4-T", W: 844, H: 390, dsf: 2, input: "T" },
  { id: "T5-T", W: 320, H: 568, dsf: 2, input: "T", textSpacing: true },
  { id: "T6-T", W: 768, H: 1024, dsf: 2, input: "T" },
  { id: "T7-T", W: 568, H: 320, dsf: 2, input: "T" },
  { id: "T8-T", W: 360, H: 800, dsf: 3, input: "T" },
  { id: "T9-T", W: 412, H: 915, dsf: 2.625, input: "T" },
  { id: "T10-M", W: 1024, H: 768, dsf: 1, input: "M" },
  { id: "T11-T", W: 1180, H: 820, dsf: 2, input: "T" },
  { id: "Z200-M", W: 640, H: 400, dsf: 1, input: "M", zoom: 200 },
  { id: "Z400-M", W: 320, H: 256, dsf: 1, input: "M", zoom: 400 },
  { id: "TS200-M", W: 1280, H: 800, dsf: 1, input: "M", rootScale: 2 },
  { id: "PL-T1-M", W: 1280, H: 800, dsf: 1, input: "M", pseudo: true },
  { id: "PL-T5-T", W: 320, H: 568, dsf: 2, input: "T", pseudo: true },
];

/** Tier P (page screens): the 18 viewport-profile rows. T3-notch is chromium only; T7-T is Tier F only. */
export const TIER_P_ROWS = ROWS.filter((r) => !["T3-notch", "T7-T"].includes(r.id));

/** Tier F (fit screens): these 11 rows, plus ROW_G_MOCK on gameplay screens only. */
const TIER_F_IDS = ["T1-M", "T1-M2", "T1-K", "T2-M", "T3-T", "T4-T", "T5-T", "T6-T", "T7-T", "Z200-M", "TS200-M"];
export const TIER_F_ROWS = ROWS.filter((r) => TIER_F_IDS.includes(r.id));
export const ROW_G_MOCK = { id: "T1-G-mock", W: 1280, H: 800, dsf: 1, input: "G" };

/** Row by id; throws on an unknown id so a typo cannot silently drop a cell. */
export function rowById(id) {
  const row = [...ROWS, ROW_G_MOCK].find((r) => r.id === id);
  if (!row) throw new Error(`unknown row "${id}" (known: ${ROWS.map((r) => r.id).join(", ")}, T1-G-mock)`);
  return row;
}

/** Touch emulation (isMobile, hasTouch) for a row. */
export const isTouch = (row) => row.input === "T";

/** Pointer profile the target-size rules use: touch rows 44/48 px, others 24 px. */
export const profileOf = (row) => (isTouch(row) ? "touch" : "mouse");
