import { button, createRoom, menuName, navTo, sleep, signedIn, uniqueName } from "./lib.mjs";

const check = (ok, message) => {
  if (!ok) throw new Error(message);
};

const CLASSIC = 1.6;
const WIDE = 16 / 9;
const TOLERANCE = 0.02;
const near = (a, want) => Math.abs(a - want) / want < TOLERANCE;

/** Test play's camera aspect, from the in-game view (camera.ts publishes the view on globalThis.__qaCam). */
async function testPlayAspect(page, canvas, want) {
  await page.evaluate(() => {
    if (globalThis.__qaCam) globalThis.__qaCam.w = 0;
  });
  await button(page, "Test play").click();
  await page.locator(".offline.playing .offline-title").waitFor();
  let ratio = 0;
  for (let i = 0; i < 100; i++) {
    ratio = await page.evaluate(() => {
      const c = globalThis.__qaCam;
      return c && c.w > 0 ? c.w / c.h : 0;
    });
    if (ratio > 0) break;
    await sleep(100);
  }
  check(near(ratio, want), `test play view is ${ratio.toFixed(3)}, want ${want.toFixed(3)}`);
  await button(page, "Edit").click();
  await canvas.waitFor({ state: "visible" });
  return ratio;
}

/** The editor's share code (the Menu's code box), then the menu closed again. */
async function shareCode(page) {
  await button(page, "Menu").click();
  const code = await page.locator("textarea.editor-code").inputValue();
  check(code.length > 0, "share code is empty");
  await button(page, "Close").click();
  return code;
}

/** The map-wide View setting (the Map panel, with nothing selected). */
const viewSetting = (page) => page.locator("label.field", { has: page.getByText("View", { exact: true }) }).locator("select");

/** Editor: a new map is wide, the View setting toggles it both ways, undo/redo follow, and test play takes it. */
async function mapAspectEditor(s) {
  const user = await signedIn(s, "aspect");
  const { page } = user;
  await navTo(page, "Map editor");
  const canvas = page.locator("canvas.editor-canvas");
  await canvas.waitFor({ state: "visible" });
  await sleep(500);
  const box = await canvas.boundingBox();
  check(box && box.width > 100 && box.height > 100, "editor canvas has no size");
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  check((await viewSetting(page).inputValue()) === "wide", "a new map is not wide");
  // Test play needs a body: two taps make a box.
  await button(page, "Box").click();
  await page.mouse.click(cx - box.width * 0.2, cy - box.height * 0.2);
  await page.waitForFunction(() => document.querySelector(".editor-hint")?.textContent.includes("opposite corner"));
  await page.mouse.click(cx - box.width * 0.1, cy - box.height * 0.1);
  await page.waitForFunction(() => (JSON.parse(localStorage.getItem("neobox.editor.draft") ?? "{}").b ?? []).length > 0);
  // The new body is selected: the Select tool and a click on empty canvas clear it, so the Map panel (with View) shows.
  await button(page, "Select").click();
  await page.mouse.click(cx + box.width * 0.35, cy - box.height * 0.35);
  await viewSetting(page).waitFor({ state: "visible" });

  const wideTest = await testPlayAspect(page, canvas, WIDE);

  // The View setting: classic, undo back to wide, redo back to classic.
  await viewSetting(page).selectOption("classic");
  check((await viewSetting(page).inputValue()) === "classic", "View did not switch to classic");
  check(await button(page, "Undo").isEnabled(), "View change does not enable Undo");
  const classicTest = await testPlayAspect(page, canvas, CLASSIC);
  await button(page, "Undo").click();
  check((await viewSetting(page).inputValue()) === "wide", "Undo did not restore wide");
  await button(page, "Redo").click();
  check((await viewSetting(page).inputValue()) === "classic", "Redo did not restore classic");

  // A built-in map is an original Hitbox map: classic, with its own arena (the code is kept for the room preview).
  await button(page, "Menu").click();
  await page.locator(".editor-menu").waitFor({ state: "visible" });
  await page.locator(".editor-list .editor-item").first().click();
  const replaceDialog = page.getByRole("alertdialog", { name: "Replace the current map?", exact: true });
  await replaceDialog.getByRole("button", { name: "Replace map", exact: true }).click();
  await page.locator(".editor-menu").waitFor({ state: "hidden" });
  check((await viewSetting(page).inputValue()) === "classic", "a built-in map is not classic");
  const classicCode = await shareCode(page);

  // Back to wide for the built-in map's share code.
  await viewSetting(page).selectOption("wide");
  const wideCode = await shareCode(page);

  // Leave the editor (unsaved edits ask first), then make a room with each code.
  const dialog = page.getByRole("alertdialog", { name: "Leave without saving?", exact: true });
  await button(page, "Back").click();
  await dialog.waitFor();
  await dialog.getByRole("button", { name: "Leave", exact: true }).click();
  await menuName(page).waitFor();

  await createRoom(user, s.base, uniqueName("aspectroom"), { isPublic: false });
  const preview = page.locator(".room-map-preview");
  await button(page, "Change map").click();
  await page.getByLabel("Map code or JSON", { exact: true }).fill(classicCode);
  await button(page, "Use code").click();
  await page.locator(".room-map-name").filter({ hasText: /\S/ }).waitFor();
  await expectAspect(preview, CLASSIC, "room preview of a classic map");
  await button(page, "Change map").click();
  await page.getByLabel("Map code or JSON", { exact: true }).fill(wideCode);
  await button(page, "Use code").click();
  await expectAspect(preview, WIDE, "room preview of a wide map");

  return `new map wide; View toggles, undo/redo; test play ${wideTest.toFixed(3)} wide, ${classicTest.toFixed(3)} classic; room previews follow`;
}

/** The canvas's drawn frame and its bitmap have the map's aspect (the arena fills the frame: no letterbox stubs). */
async function expectAspect(locator, want, label) {
  let box = null;
  let bitmap = 0;
  for (let i = 0; i < 100; i++) {
    box = await locator.boundingBox();
    bitmap = await locator.evaluate((c) => c.width / c.height);
    if (box && box.height > 0 && near(box.width / box.height, want) && near(bitmap, want)) return;
    await sleep(100);
  }
  check(false, `${label}: box ${box ? (box.width / box.height).toFixed(3) : "none"}, bitmap ${bitmap.toFixed(3)}, want ${want.toFixed(3)}`);
}

export const mapAspectScenarios = [{ name: "map aspect", run: mapAspectEditor }];
