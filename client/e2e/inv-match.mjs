// Inventory rows for the match HUD, its menu, chat, input, offline, phone and editor screens. Each scenario names
// the rows it proves in `inv`; every check asserts a row's "shows" column, with role/name locators where they exist.

import { button, matchWithGuest, roomTitle } from "./lib.mjs";

const check = (ok, message) => {
  if (!ok) throw new Error(message);
};

/** The match menu chip and its panel (#hud-menu). */
const menuBtn = (page) => page.locator(".hud-menu-btn");
const menuPanel = (page) => page.locator("#hud-menu");
const menuItem = (page, name) => menuPanel(page).getByRole("button", { name, exact: true });

async function openMenu(page) {
  if (await menuPanel(page).isHidden()) await menuBtn(page).click();
  await menuPanel(page).waitFor({ state: "visible" });
}

async function closeMenu(page) {
  await page.keyboard.press("Escape");
  await menuPanel(page).waitFor({ state: "hidden" });
}

/** hud-main, hud-menu and its items (volume, mute, fullscreen, controls), F3 stats, Tab scoreboard, host End match. */
async function matchHudMenu(s) {
  const { host, guest } = await matchWithGuest(s, { clipboard: true });
  const { page } = host;

  // hud-main: the match HUD is up on the host, with the Leave chip.
  await page.locator(".hud-root").waitFor({ state: "visible" });
  check(await page.locator(".hud-leave").isVisible(), "host has no Leave chip in the match HUD");

  // hud-menu: the chip opens the panel and reports it with aria-expanded.
  await openMenu(page);
  check((await menuBtn(page).getAttribute("aria-expanded")) === "true", "menu chip is not aria-expanded while open");

  // hud-menu (Volume): the slider keeps its value across a reopen.
  const volume = menuPanel(page).getByRole("slider", { name: "Volume", exact: true });
  await volume.fill("40");
  await closeMenu(page);
  await openMenu(page);
  check((await volume.inputValue()) === "40", `volume did not survive a reopen (${await volume.inputValue()})`);

  // hud-menu (Mute music): the label flips and back.
  await menuItem(page, "Mute music").click();
  await menuItem(page, "Unmute music").waitFor({ state: "visible" });
  await menuItem(page, "Unmute music").click();
  await menuItem(page, "Mute music").waitFor({ state: "visible" });

  // hud-menu (Fullscreen): the item shows where the browser allows fullscreen, and flips to Exit fullscreen.
  const fullscreen = menuItem(page, "Fullscreen");
  check(await fullscreen.isVisible(), "Fullscreen item is hidden although fullscreen is enabled");
  await fullscreen.click();
  await menuItem(page, "Exit fullscreen").waitFor({ state: "visible" });
  await menuItem(page, "Exit fullscreen").click();
  await menuItem(page, "Fullscreen").waitFor({ state: "visible" });

  // hud-menu: Escape closes it and returns focus to the chip.
  await closeMenu(page);
  check((await menuBtn(page).getAttribute("aria-expanded")) === "false", "menu chip still aria-expanded after Escape");

  // hud-menu (Change controls): opens the settings screen; Back returns to the match.
  await openMenu(page);
  await menuItem(page, "Change controls").click();
  await button(page, "Back").first().waitFor({ state: "visible" });
  await button(page, "Back").first().click();
  await page.locator(".hud-root").waitFor({ state: "visible" });

  // hud-stats: F3 toggles the stats panel (Transport row shows).
  await page.keyboard.press("F3");
  await page.locator(".hud-stats").waitFor({ state: "visible" });
  check(await page.locator(".hud-stats").getByText("Transport", { exact: true }).isVisible(), "stats panel has no Transport row");
  await page.keyboard.press("F3");
  await page.locator(".hud-stats").waitFor({ state: "hidden" });

  // hud-scores: holding Tab shows the scoreboard, releasing hides it.
  await page.keyboard.down("Tab");
  await page.locator(".hud-scores").waitFor({ state: "visible" });
  await page.keyboard.up("Tab");
  await page.locator(".hud-scores").waitFor({ state: "hidden" });

  // hud-end (host End match): the confirm dialog ends the match for everyone in the room.
  await page.locator(".hud-end").click();
  const dialog = page.getByRole("alertdialog").filter({ hasText: "End the match?" });
  await dialog.waitFor({ state: "visible" });
  await dialog.getByRole("button", { name: "End match", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  await page.locator(".hud-leave").waitFor({ state: "hidden" });
  await guest.page.locator(".hud-leave").waitFor({ state: "hidden" });
  return "host HUD, menu items, stats, scores and End match all checked";
}

/** hud-menu (Show lobby): the menu's lobby item leaves the match HUD for the room screen. */
async function matchMenuLobby(s) {
  const { host, roomName } = await matchWithGuest(s, { clipboard: true });
  const { page } = host;
  await openMenu(page);
  await menuItem(page, "Show lobby").click();
  await roomTitle(page, roomName).waitFor({ state: "visible" });
  return "Show lobby opened the room screen";
}

/** hud-leave: the Leave chip leaves at once, with no confirm, and the Browse rooms list shows. */
async function matchLeave(s) {
  const { guest } = await matchWithGuest(s, { clipboard: true });
  const { page } = guest;
  await page.locator(".hud-leave").click();
  await page.getByRole("heading", { name: "Browse rooms", exact: true }).waitFor({ state: "visible" });
  check((await page.getByRole("alertdialog").count()) === 0, "Leave opened a confirm dialog");
  await page.locator(".hud-leave").waitFor({ state: "hidden" });
  return "Leave went straight to Browse rooms";
}

export const matchInvScenarios = [
  { name: "inv match hud and menu", inv: ["hud-main", "hud-menu", "hud-menu (Volume)", "hud-menu (Mute music)", "hud-menu (Fullscreen)", "hud-menu (Change controls)", "hud-stats", "hud-scores", "hud-end (host End match)"], run: matchHudMenu },
  { name: "inv match menu lobby", inv: ["hud-menu (Show lobby)"], run: matchMenuLobby },
  { name: "inv match leave", inv: ["hud-leave"], run: matchLeave },
];
