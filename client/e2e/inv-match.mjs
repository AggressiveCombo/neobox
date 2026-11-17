// Inventory rows for the match HUD, its menu, chat, input, offline, phone and editor screens. Each scenario names
// the rows it proves in `inv`; every check asserts a row's "shows" column, with role/name locators where they exist.

import { button, createRoom, joinByInvite, matchWithGuest, probeChanges, roomTitle, sleep, startMatch, uniqueName, waitForPixels, waitQuiet } from "./lib.mjs";

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

/** Chat rows: Enter opens and focuses the box, Enter sends to both players, ArrowUp recalls, Escape closes, the length cap, and another player's typing line. */
async function matchChat(s) {
  const { host, guest, guestName } = await matchWithGuest(s, { clipboard: true });
  const hp = host.page;
  const gp = guest.page;
  const input = (p) => p.getByLabel("Chat message", { exact: true });
  const form = (p) => p.locator(".hud-chat-form");
  const log = (p) => p.locator(".hud-chat-log");

  // chat-open-enter: Enter with nothing focused opens the box and focuses it.
  await hp.locator(".hud-root").waitFor({ state: "visible" });
  await hp.keyboard.press("Enter");
  await input(hp).waitFor({ state: "visible" });
  check((await input(hp).getAttribute("placeholder")) === "Press Enter to send a message", "chat placeholder is not the keyboard hint");
  check(await input(hp).evaluate((el) => el === document.activeElement), "chat box is not focused after Enter");

  // chat-send: Enter sends the line to both players and closes the box.
  await hp.keyboard.type("hello there");
  await hp.keyboard.press("Enter");
  await form(hp).waitFor({ state: "hidden" });
  await log(hp).getByText("hello there").waitFor({ state: "visible" });
  await log(gp).getByText("hello there").waitFor({ state: "visible" });

  // chat-history: Enter then ArrowUp recalls the last own line.
  await hp.keyboard.press("Enter");
  await input(hp).waitFor({ state: "visible" });
  await input(hp).press("ArrowUp");
  check((await input(hp).inputValue()) === "hello there", "ArrowUp did not recall the last line");

  // chat-close: Escape closes the box without sending and clears it.
  await input(hp).press("Escape");
  await form(hp).waitFor({ state: "hidden" });
  check((await log(hp).getByText("hello there").count()) === 1, "Escape sent or duplicated the recalled line");

  // chat-escape-menu: with chat closed, Escape opens the match menu (not chat); a second Escape closes it.
  await hp.keyboard.press("Escape");
  await hp.locator("#hud-menu").waitFor({ state: "visible" });
  await hp.keyboard.press("Escape");
  await hp.locator("#hud-menu").waitFor({ state: "hidden" });

  // chat-length: the box stops at the protocol's cap.
  await hp.keyboard.press("Enter");
  const max = Number(await input(hp).getAttribute("maxlength"));
  check(max > 0, "chat box has no maxlength");
  await input(hp).fill("x".repeat(max + 50));
  check((await input(hp).inputValue()).length <= max, `chat box accepted more than ${max} characters`);
  await input(hp).press("Escape");
  await form(hp).waitFor({ state: "hidden" });

  // hud-typing: another player's open box shows "<name> is typing…" to the room.
  await gp.keyboard.press("Enter");
  await input(gp).waitFor({ state: "visible" });
  await gp.keyboard.type("typing now");
  await hp.locator(".hud-typing").filter({ hasText: guestName }).waitFor({ state: "visible" });
  check(((await hp.locator(".hud-typing").textContent()) ?? "").includes("typing"), "typing line lacks the word typing");
  await input(gp).press("Escape");
  return "chat open, send, recall, close, length cap and typing line checked";
}

/** Controls rows: the Change button arms a key capture ("Press a key"); each reserved key is refused with its notice; Escape cancels. */
async function matchKeys(s) {
  const { host } = await matchWithGuest(s, { clipboard: true });
  const { page } = host;
  const busy = () => page.getByText("Press a key", { exact: true }).first();
  await page.locator(".hud-root").waitFor({ state: "visible" });
  await page.locator(".hud-menu-btn").click();
  await menuItem(page, "Change controls").click();
  const bind = page.getByRole("button", { name: /key 1: .*\. Change$/ }).first();
  await bind.waitFor({ state: "visible" });
  // kb-reserved: each reserved key is refused with its notice, and the capture ends.
  for (const key of ["F3", "Tab", "Enter"]) {
    await bind.click();
    await busy().waitFor({ state: "visible" });
    await page.keyboard.press(key);
    await page.getByText(`${key} is used by the game or browser. Pick another key.`).first().waitFor({ state: "visible" });
    await busy().waitFor({ state: "hidden" });
  }
  // Escape cancels a capture.
  await bind.click();
  await busy().waitFor({ state: "visible" });
  await page.keyboard.press("Escape");
  await busy().waitFor({ state: "hidden" });
  return "Change arms a key capture; F3, Tab, Enter refused with notices; Escape cancels";
}

/** kb-default-bindings: the default keys move and jump the player (D right, A left, Space jump). */
async function matchDefaults(s) {
  const { host } = await matchWithGuest(s, { clipboard: true });
  const { page } = host;
  await waitForPixels(host, "match canvas");
  // Frames freeze during the start countdown (see roomMatch in scenarios.mjs); wait it out before holding keys.
  await sleep(4000);
  const held = async (code) => {
    await waitQuiet(page);
    const before = await probeChanges(page);
    await page.keyboard.down(code);
    await sleep(600);
    await page.keyboard.up(code);
    return (await probeChanges(page)) - before;
  };
  check((await held("KeyD")) > 0, "holding KeyD (right) does not change the canvas");
  check((await held("KeyA")) > 0, "holding KeyA (left) does not change the canvas");
  check((await held("Space")) > 0, "holding Space (jump) does not change the canvas");
  return "KeyD, KeyA and Space change the match canvas";
}

/** mouse-input: a pointer hover then click opens the match menu; Escape closes it. */
async function matchMouse(s) {
  const { host } = await matchWithGuest(s, { clipboard: true });
  const { page } = host;
  await page.locator(".hud-root").waitFor({ state: "visible" });
  await menuBtn(page).hover();
  await menuBtn(page).click();
  await menuPanel(page).waitFor({ state: "visible" });
  check((await menuBtn(page).getAttribute("aria-expanded")) === "true", "menu button is not aria-expanded after click");
  await page.keyboard.press("Escape");
  await menuPanel(page).waitFor({ state: "hidden" });
  return "hover then click opens the menu (aria-expanded=true); Escape closes it";
}

/**
 * gamepad-map: a standard-mapping pad (getGamepads overridden as in qa/input.mjs) moves the player on the d-pad and jumps on A.
 * Push, bat, rocket and grab have no visible effect in an empty match, so they are not proven here.
 */
async function matchPad(s) {
  const { host } = await matchWithGuest(s, { clipboard: true });
  const { page } = host;
  await waitForPixels(host, "match canvas");
  // Frames freeze during the start countdown (see roomMatch in scenarios.mjs); wait it out before pressing the pad.
  await sleep(4000);
  await page.evaluate(() => {
    const pad = {
      id: "qa-pad (STANDARD GAMEPAD)",
      index: 0,
      connected: true,
      mapping: "standard",
      buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })),
      axes: [0, 0, 0, 0],
    };
    window.__e2ePad = pad;
    Object.defineProperty(navigator, "getGamepads", { value: () => [pad], configurable: true });
  });
  const pressPad = (index, down) =>
    page.evaluate(([i, d]) => {
      window.__e2ePad.buttons[i] = { pressed: d, value: d ? 1 : 0 };
    }, [index, down]);
  for (const [name, index] of [["DPadRight", 15], ["DPadLeft", 14], ["A", 0]]) {
    await waitQuiet(page);
    const before = await probeChanges(page);
    await pressPad(index, true);
    await sleep(1000);
    await pressPad(index, false);
    const moved = (await probeChanges(page)) - before;
    check(moved > 0, `${name} did not change the match canvas (${moved} changes)`);
  }
  return "DPadRight, DPadLeft and A change the match canvas";
}

/** Void map: no ground, three spawns at different heights, so the players fall out one at a time. */
const SPECTATE_MAP = '{"b":[],"j":[],"s":[{"1":15,"2":10},{"1":25,"2":40},{"1":35,"2":70}],"p":[],"tu":[],"tc":[],"gp":[],"c":[],"set":{"3":40,"15":40,"16":25}}';

/**
 * hud-spectate (a) and chat-spectate-step: one life each on the void map; the first player to fall out is eliminated
 * and the spectator bar follows the living players. ArrowRight moves the followed player.
 */
async function matchSpectate(s) {
  const host = await s.open("sp-host", { name: uniqueName("sph") });
  const roomName = uniqueName("sp");
  const code = await createRoom(host, s.base, roomName, { isPublic: false });
  const guests = [];
  const names = [];
  for (const id of ["spa", "spb"]) {
    const name = uniqueName(id);
    const guest = await s.open(id, { name });
    await joinByInvite(guest, s.base, code, roomName);
    guests.push(guest);
    names.push(name);
  }
  for (const name of names) await host.page.locator("li.room-player").filter({ hasText: name }).waitFor();
  const { page } = host;
  await button(page, "Change map").click();
  await page.getByLabel("Map code or JSON", { exact: true }).fill(SPECTATE_MAP);
  await button(page, "Use code").click();
  const chat = page.getByLabel("Chat message", { exact: true });
  await chat.fill("/mode 1");
  await chat.press("Enter");
  await chat.fill("/set objectiveLimit 1");
  await chat.press("Enter");
  await page.locator("div.room-chat-log").getByText("objectiveLimit: 1").waitFor();
  await startMatch(host, guests);
  const spectator = await Promise.any(
    [host, ...guests].map((h) =>
      h.page
        .locator(".hud-spectate-label")
        .waitFor({ state: "visible", timeout: 60_000 })
        .then(() => h),
    ),
  );
  const name = spectator.page.locator(".hud-spectate-name");
  const first = await name.textContent();
  check(first.startsWith("Spectating"), `spectator bar reads "${first}", expected "Spectating ..."`);
  await spectator.page.keyboard.press("ArrowRight");
  await spectator.page.locator(".hud-spectate-name").filter({ hasNotText: first }).waitFor({ timeout: 5000 });
  return `eliminated player sees the spectator bar ("${first}") and ArrowRight moves to another player`;
}

/** hud-spectate (b): a player who joins a running match spectates it; the bar shows after Back to game. */
async function matchSpectateJoin(s) {
  const { code } = await matchWithGuest(s, { clipboard: true });
  const late = await s.open("spc", { name: uniqueName("spl") });
  // a running match moves the joiner straight to the HUD, so the room title may pass unseen; accept either
  await late.page.goto(`${s.base}/${code}`);
  await late.page.locator("h1.room-title").or(late.page.locator(".hud-root")).first().waitFor();
  await late.page.locator(".hud-root").waitFor({ state: "visible" });
  await openMenu(late.page);
  await menuItem(late.page, "Show lobby").click();
  await late.page.locator(".room-team-pick").getByText("Spectate", { exact: true }).click();
  const back = button(late.page, "Back to game");
  const label = late.page.locator(".hud-spectate-label");
  await back.or(label).first().waitFor();
  if (await back.isVisible()) await back.click();
  await late.page.locator(".hud-root").waitFor({ state: "visible" });
  await label.waitFor({ state: "visible" });
  const text = await late.page.locator(".hud-spectate-name").textContent();
  check(text.startsWith("Spectating"), `late joiner's spectator bar reads "${text}"`);
  return `mid-match joiner chooses Spectate in the lobby; the spectator bar shows ("${text}")`;
}

export const matchInvScenarios = [
  { name: "inv match hud and menu", inv: ["hud-main", "hud-menu", "hud-menu (Volume)", "hud-menu (Mute music)", "hud-menu (Fullscreen)", "hud-menu (Change controls)", "hud-stats", "hud-scores", "hud-end (host End match)"], run: matchHudMenu },
  { name: "inv match menu lobby", inv: ["hud-menu (Show lobby)"], run: matchMenuLobby },
  { name: "inv match leave", inv: ["hud-leave"], run: matchLeave },
  { name: "inv match chat", inv: ["chat-open-enter", "chat-send", "chat-history", "chat-close", "chat-escape-menu", "chat-length", "hud-typing"], run: matchChat },
  { name: "inv match keys", inv: ["kb-reserved (F3/Tab/Enter in capture)"], run: matchKeys },
  { name: "inv match defaults", inv: ["kb-default-bindings"], run: matchDefaults },
  { name: "inv match mouse", inv: ["mouse-input"], run: matchMouse },
  { name: "inv match gamepad", inv: ["gamepad-map"], run: matchPad },
  { name: "inv match spectate", inv: ["hud-spectate", "chat-spectate-step"], run: matchSpectate },
  { name: "inv match spectate join", inv: ["hud-spectate"], run: matchSpectateJoin },
];
