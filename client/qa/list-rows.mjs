// List-row icon alignment: in every list of `.list-row` buttons on screen, the leading icons must share one x (within 1 px),
// and each row must start its content (justify-content: flex-start). Checked on the room's mode picker and roster menus.
// Usage: bun qa/list-rows.mjs (QA_ENGINES to choose). Exits 1 on a misaligned list.

import { DESKTOP, createRoom, launchEngine, runCleanups, selectedEngines, startServer, uniqueName, button } from "./lib-qa.mjs";

const TOLERANCE_PX = 1;

// Leading icon of each visible row, grouped by the row's parent: [{ parent, rows: [{ text, x, start }] }].
const scan = () => {
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
  };
  const groups = new Map();
  for (const row of document.querySelectorAll("button.list-row")) {
    if (!visible(row)) continue;
    const icon = row.querySelector(":scope > svg");
    if (!icon || !visible(icon)) continue;
    const parent = row.parentElement;
    if (!groups.has(parent)) groups.set(parent, []);
    groups.get(parent).push({
      text: row.textContent.trim().slice(0, 30),
      x: icon.getBoundingClientRect().left,
      start: getComputedStyle(row).justifyContent === "flex-start",
    });
  }
  return [...groups.values()].filter((rows) => rows.length >= 2);
};

async function checkPage(page, label, failures) {
  const lists = await page.evaluate(scan);
  if (lists.length === 0) failures.push(`${label}: no list of icon rows on screen`);
  for (const rows of lists) {
    const xs = rows.map((r) => r.x);
    const spread = Math.max(...xs) - Math.min(...xs);
    const bad = rows.filter((r) => !r.start).map((r) => r.text);
    if (spread > TOLERANCE_PX) failures.push(`${label}: icons span ${spread.toFixed(1)} px across ${rows.length} rows (${rows.map((r) => r.text).join(" | ")})`);
    if (bad.length > 0) failures.push(`${label}: rows not flex-start: ${bad.join(", ")}`);
  }
  return lists.length;
}

async function runEngine(engine, base) {
  const browser = await launchEngine(engine);
  const failures = [];
  let lists = 0;
  try {
    const context = await browser.newContext(DESKTOP);
    const page = await context.newPage();
    const roomName = uniqueName("rows");
    await createRoom({ page }, base, roomName);
    await button(page, "Change mode").click();
    lists += await checkPage(page, `${engine} room mode picker`, failures);
    await page.keyboard.press("Escape");
  } finally {
    await runCleanups();
  }
  console.log(`${engine}: ${lists} row list(s) checked, ${failures.length} failure(s)`);
  for (const f of failures) console.log(`  FAIL ${f}`);
  return failures.length;
}

let failed = 0;
for (const engine of selectedEngines()) {
  const server = await startServer();
  try {
    failed += await runEngine(engine, server.base);
  } finally {
    await runCleanups();
  }
}
process.exit(failed > 0 ? 1 : 0);
