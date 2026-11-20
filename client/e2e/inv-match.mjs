// Inventory rows for the match HUD, its menu, chat, input, offline, phone and editor screens. Each scenario names
// the rows it proves in `inv`; every check asserts a row's "shows" column, with role/name locators where they exist.

import { builtinMaps, button, createRoom, dismissPhoneSplash, joinByInvite, matchWithGuest, menuName, navTo, playFromMenu, probeChanges, roomTitle, signedIn, sleep, startMatch, uniqueName, waitForPixels, waitQuiet, waitStable } from "./lib.mjs";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

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
  // Keys go to the host's page; bring it to front after the guest's page was opened.
  await page.bringToFront();
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
  // A held key can land while the host is still settling from the previous move under load: retry, as the jump below does.
  const movedBy = async (code) => {
    let n = 0;
    for (let attempt = 0; attempt < 3 && n === 0; attempt++) {
      if (attempt > 0) await sleep(1000);
      n = await held(code);
    }
    return n;
  };
  check((await movedBy("KeyD")) > 0, "holding KeyD (right) does not change the canvas");
  check((await movedBy("KeyA")) > 0, "holding KeyA (left) does not change the canvas");
  // A jump needs ground (or the single air jump); a first press can land while the host is still airborne from D/A.
  let jumped = 0;
  for (let attempt = 0; attempt < 3 && jumped === 0; attempt++) {
    if (attempt > 0) await sleep(1000);
    jumped = await held("Space");
  }
  check(jumped > 0, "holding Space (jump) does not change the canvas");
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
    // A browser fires gamepadconnected when a pad appears; the game polls only while one is connected.
    window.dispatchEvent(new Event("gamepadconnected"));
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
  const followed = spectator.page.locator(".hud-spectate-name");
  await spectator.page.keyboard.press("ArrowRight");
  await followed.filter({ hasNotText: first }).waitFor({ timeout: 5000 });
  const second = await followed.textContent();
  // chat-spectate-step: ArrowLeft steps back to the first player
  await spectator.page.keyboard.press("ArrowLeft");
  await followed.filter({ hasText: first }).waitFor({ timeout: 5000 });
  check(second !== first, "ArrowRight did not change the followed player");
  return `eliminated player sees the spectator bar ("${first}"); ArrowRight and ArrowLeft move the followed player`;
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
  // Choosing Spectate can return the lobby to the match by itself, so "Back to game" may be gone before a click lands: the spectator bar is the signal.
  const label = late.page.locator(".hud-spectate-label");
  await label.waitFor({ state: "visible" });
  const text = await late.page.locator(".hud-spectate-name").textContent();
  check(text.startsWith("Spectating"), `late joiner's spectator bar reads "${text}"`);
  return `mid-match joiner chooses Spectate in the lobby; the spectator bar shows ("${text}")`;
}

/** Mask-only copy of the qa/input.mjs HOOK: each page records the input mask the engine receives (window.__mask). */
const MASK_HOOK = () => {
  window.__mask = { cur: 0, seen: 0, calls: 0 };
  const record = (mask) => {
    window.__mask.cur = mask;
    window.__mask.seen |= mask;
    window.__mask.calls++;
  };
  const wrap = (result) => {
    const ex = result.instance.exports;
    const api = { ...ex };
    const localFrame = ex.nb_local_frame;
    api.nb_local_frame = (dt, mask) => {
      record(mask);
      return localFrame(dt, mask);
    };
    const frame = ex.nb_frame;
    api.nb_frame = (nowMs, mask) => {
      record(mask);
      return frame(nowMs, mask);
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
};

/** Opens each page of `s` with MASK_HOOK installed before its scripts run (every context the scenario opens). */
function withMaskHook(s) {
  const open = s.open.bind(s);
  s.open = async (label, opts) => {
    const h = await open(label, opts);
    await h.context.addInitScript(MASK_HOOK);
    return h;
  };
  return s;
}

/** Standard-mapping pad on the page (getGamepads overridden, as in qa/input.mjs PAD_INIT). */
async function installPad(page) {
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
    window.dispatchEvent(new Event("gamepadconnected"));
  });
}

const pressPad = (page, index, down) =>
  page.evaluate(
    ([i, d]) => {
      window.__e2ePad.buttons[i] = { pressed: d, value: d ? 1 : 0 };
    },
    [index, down],
  );

/** gamepad-push, -bat, -rocket, -grab: each standard-mapping button sets its action's mask bit in the engine (input.ts BIT). */
async function matchPadActions(s) {
  withMaskHook(s);
  const { host } = await matchWithGuest(s, { clipboard: true });
  const { page } = host;
  await waitForPixels(host, "match canvas");
  // Frames freeze during the start countdown (see roomMatch in scenarios.mjs); wait it out before pressing the pad.
  await sleep(4000);
  await installPad(page);
  const actions = [
    { row: "gamepad-push", button: 2, name: "X", bit: 16 },
    { row: "gamepad-bat", button: 1, name: "B", bit: 64 },
    { row: "gamepad-rocket", button: 3, name: "Y", bit: 32 },
    { row: "gamepad-rocket", button: 5, name: "RB", bit: 32 },
    { row: "gamepad-grab", button: 4, name: "LB", bit: 128 },
  ];
  for (const { row, button: index, name, bit } of actions) {
    await waitQuiet(page);
    await page.evaluate(() => {
      window.__mask.seen = 0;
    });
    await pressPad(page, index, true);
    await sleep(500);
    await pressPad(page, index, false);
    const seen = await page.evaluate(() => window.__mask.seen);
    check((seen & bit) !== 0, `${row} (${name}): the engine mask never had bit ${bit} (mask seen ${seen})`);
  }
  return "X push, B bat, Y and RB rocket, LB grab each set their mask bit in the engine";
}

/** kb-blur-clear: a held key reaches the engine; a window blur drops it from the mask while the match loop keeps running. */
async function matchBlurClear(s) {
  withMaskHook(s);
  const { host } = await matchWithGuest(s, { clipboard: true });
  const { page } = host;
  await waitForPixels(host, "match canvas");
  await sleep(4000);
  await page.keyboard.down("ArrowRight");
  await sleep(500);
  const held = await page.evaluate(() => window.__mask.cur);
  check((held & 2) !== 0, `ArrowRight held but the engine mask is ${held}`);
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  const calls = await page.evaluate(() => window.__mask.calls);
  await sleep(500);
  const after = await page.evaluate(() => ({ cur: window.__mask.cur, calls: window.__mask.calls }));
  await page.keyboard.up("ArrowRight");
  check(after.calls > calls, "the match loop stopped after the window blurred");
  check((after.cur & 2) === 0, `blur left ArrowRight in the engine mask (${after.cur})`);
  return "ArrowRight reaches the engine while held; after window blur the mask drops it and frames keep running";
}

/** NEW-chat-record: "/record" in the match chat cuts a clip and the chat log reports it. */
async function matchChatRecord(s) {
  const { host } = await matchWithGuest(s, { clipboard: true });
  const { page } = host;
  await waitForPixels(host, "match canvas");
  // the clip is cut from recorded frames: let some play accumulate first
  await sleep(7000);
  await page.keyboard.press("Enter");
  const input = page.getByLabel("Chat message", { exact: true });
  await input.waitFor({ state: "visible" });
  await input.fill("/record");
  await input.press("Enter");
  await page.locator(".hud-chat-log").getByText(/Clip saved/).waitFor({ state: "visible" });
  return "/record reports the clip as saved in the match chat log";
}

/**
 * A phone host alone in a public room; its match runs with the rotate gate up unless `dismissGate` clears it.
 * `portrait` holds the phone upright. Firefox's non-mobile phone context (phoneOptions) keeps the window size and
 * drops the phone viewport on the splash step, so the viewport is set after that step, right before the match.
 */
async function phoneSoloMatch(s, { dismissGate, portrait = false }) {
  const host = await s.open("phone", { phone: true, name: uniqueName("phone") });
  const roomName = uniqueName("room");
  await createRoom(host, s.base, roomName, { isPublic: true });
  await dismissPhoneSplash(host.page);
  if (portrait) {
    await host.page.setViewportSize({ width: 390, height: 844 });
    await host.page.waitForFunction(() => innerWidth === 390);
  }
  await startMatch(host, [], { keepRotateGate: !dismissGate });
  return host;
}

/** hud-rotate: a portrait phone in a running match shows the turn-sideways dialog with Full screen and Play in portrait anyway. */
async function matchRotateGate(s) {
  const { page } = await phoneSoloMatch(s, { dismissGate: false, portrait: true });
  const gate = page.getByRole("dialog", { name: "Turn your phone sideways", exact: true });
  await gate.waitFor({ state: "visible" });
  // Full screen is offered only where the browser can go full screen (hud.ts rotateGate: hidden when unsupported).
  const fullscreen = await page.evaluate(() => document.fullscreenEnabled === true);
  const fullVisible = await gate.getByRole("button", { name: "Full screen" }).isVisible();
  check(fullVisible === fullscreen, `rotate gate Full screen visible=${fullVisible}, but the browser fullscreenEnabled=${fullscreen}`);
  check((await gate.getByRole("button", { name: "Play in portrait anyway", exact: true }).count()) === 1, "rotate gate has no Play in portrait anyway button");
  return `portrait phone match: the rotate dialog shows "Play in portrait anyway" and Full screen ${fullscreen ? "(browser supports it)" : "hidden (browser has no fullscreen)"}`;
}

/** hud-chat (touch Chat button): on a phone the top-bar Chat button opens the chat form on tap and closes it on a second tap. */
async function matchPhoneChat(s) {
  const { page } = await phoneSoloMatch(s, { dismissGate: true });
  const chatBtn = page.locator(".hud-chat-btn");
  const form = page.locator(".hud-chat-form");
  await chatBtn.waitFor({ state: "visible" });
  await chatBtn.tap();
  await form.waitFor({ state: "visible" });
  await chatBtn.tap();
  await form.waitFor({ state: "hidden" });
  return "phone Chat button opens the chat form on tap and closes it on a second tap";
}

/** hud-matching: a quick-play player alone in the match sees the waiting notice (hud.ts matchingEl). */
async function matchQuickAlone(s) {
  const solo = await s.open("solo", { name: uniqueName("solo") });
  await solo.page.goto(s.base);
  await menuName(solo.page).waitFor();
  await playFromMenu(solo.page, null, { quick: true });
  await solo.page.locator(".quick-choose").first().click();
  const notice = solo.page.locator(".hud-matching");
  await notice.waitFor({ state: "visible", timeout: 120_000 });
  const text = ((await notice.textContent()) ?? "").trim();
  check(text === "Waiting for other players to join this arena...", `quick-play notice reads "${text}"`);
  return `quick play alone shows "${text}"`;
}

/** Opens the Sweaty Bois quick-play card from the menu and waits for the match HUD. */
async function quickSweaty(page) {
  await playFromMenu(page, null, { quick: true });
  await page.locator(".quick-card", { hasText: "Sweaty Bois" }).locator(".quick-choose").click();
  await page.locator(".hud-leave").waitFor({ state: "visible", timeout: 30_000 });
}

/**
 * hud-xp and xp-quick: a signed-in player who wins a Sweaty Bois game (two round wins) gets the quick-play XP chip.
 * A rival that joins a solo round ends it as a draw; once the next round starts both are alive, and the rival's leave
 * hands the round to the winner. Each rival stays about 12 s (round over plus intro) before it leaves.
 */
async function matchQuickXp(s) {
  const winner = await signedIn(s, "xpwin", uniqueName("xpwin"));
  await quickSweaty(winner.page);
  const chip = winner.page.locator(".hud-xp");
  // the chip shows for three seconds, so the poll runs right after each rival leaves
  for (let attempt = 0; attempt < 6; attempt++) {
    const rival = await s.open(`xp-rival${attempt}`, { name: uniqueName("rival") });
    await rival.page.goto(s.base);
    await menuName(rival.page).waitFor();
    await quickSweaty(rival.page);
    await sleep(12_000);
    await rival.page.locator(".hud-leave").click();
    await rival.context.close();
    if (await chip.waitFor({ state: "visible", timeout: 15_000 }).then(() => true, () => false)) {
      const gained = ((await winner.page.locator(".hud-xp-gain").textContent()) ?? "").trim();
      check(gained === "+50 xp", `quick-play win shows "${gained}", not the first-place quick award +50 xp`);
      return `signed-in quick-play win shows the XP chip "${gained}"`;
    }
    // the round went on: another rival makes the next one
  }
  throw new Error("the signed-in quick-play winner never got the XP chip");
}

/** hud-error: the server refuses sign-out; the player stays signed in and an error toast shows (hud.ts signOut). */
async function matchSignOutError(s) {
  const host = await signedIn(s, "acct", uniqueName("acct"));
  await createRoom(host, s.base, uniqueName("room"), { isPublic: true });
  await startMatch(host, []);
  const { page } = host;
  await page.route("**/api/account/logout", (route) =>
    route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "sign-out refused (e2e)" }) }),
  );
  await openMenu(page);
  await menuItem(page, "Sign out").click();
  const toast = page.locator(".toast.toast-error").first();
  await toast.waitFor({ state: "visible" });
  // The refused request logs the browser's own 500 line; that is the forced failure, so only that one line is dropped.
  host.problems = host.problems.filter((p) => !(p.includes("status of 500") && p.includes("/api/account/logout")));
  const text = ((await toast.textContent()) ?? "").trim();
  check(text.length > 0, "the error toast is empty");
  check(await menuItem(page, "Sign out").isVisible(), "the player lost the signed-in menu after a refused sign-out");
  return `refused sign-out shows the error toast ("${text}") and the player stays signed in`;
}

const back = (page) => button(page, "Back").first();
const editorCanvas = (page) => page.locator("canvas.editor-canvas");

/** jukebox-url-enter, jukebox-panel, jukebox-toasts and toast-host: a pasted link suggests a play; the panel opens; a bad link in the box toasts an error. */
async function matchJukebox(s) {
  const roomName = uniqueName("jb");
  const host = await s.open("jb-host", { name: uniqueName("jh") });
  const code = await createRoom(host, s.base, roomName, { isPublic: true });
  const guest = await s.open("jb-guest", { name: uniqueName("jg") });
  await joinByInvite(guest, s.base, code, roomName);
  const chat = guest.page.getByLabel("Chat message", { exact: true });
  await chat.fill("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  await chat.press("Enter");
  const play = host.page.getByRole("button", { name: "Play on jukebox" });
  await play.waitFor({ timeout: 15_000 });
  await play.click();
  await host.page.getByLabel("Jukebox", { exact: true }).waitFor({ state: "visible" });
  await guest.page.getByLabel("Jukebox", { exact: true }).waitFor({ state: "visible" });
  const url = host.page.getByLabel("YouTube link", { exact: true });
  await url.fill("hello");
  await url.press("Enter");
  const toast = host.page.locator(".toast.toast-error").filter({ hasText: "Paste a YouTube video link." });
  await toast.waitFor({ state: "visible" });
  check((await toast.getAttribute("role")) === "alert", "the error toast has no alert role");
  return "suggestion, panel on both pages, and the bad-link error toast";
}

/** screen-transition: a menu change animates the entering screen and the frozen old one (document.getAnimations during the change). */
async function matchScreenTransition(s) {
  const visitor = await s.open("tr", { name: uniqueName("tr") });
  const { page } = visitor;
  await page.goto(s.base);
  await menuName(page).waitFor();
  const animated = async (go) => {
    await page.evaluate(() => {
      const names = new Set();
      window.__animNames = names;
      const end = performance.now() + 1500;
      const sample = () => {
        for (const a of document.getAnimations()) names.add(a.animationName ?? a.constructor.name);
        if (performance.now() < end) requestAnimationFrame(sample);
      };
      sample();
    });
    await go();
    await sleep(1600);
    return page.evaluate(() => [...window.__animNames]);
  };
  const settings = await animated(() => navTo(page, "Settings"));
  check(settings.length > 0, "opening Settings ran no animation");
  await back(page).click();
  await menuName(page).waitFor();
  const library = await animated(() => navTo(page, "Library"));
  check(library.length > 0, "opening Library ran no animation");
  await back(page).click();
  await menuName(page).waitFor();
  return `Settings animated [${settings.join(", ")}]; Library animated [${library.join(", ")}]`;
}

/** boot-splash: the boot card is up while the page loads (status role, Loading label) and hides once the menu is ready. */
async function matchBoot(s) {
  const h = await s.open("boot");
  const { page } = h;
  await page.goto(s.base, { waitUntil: "commit" });
  await page.waitForFunction(() => document.getElementById("boot") !== null, null, { timeout: 10_000 });
  const boot = page.locator("#boot");
  check((await boot.getAttribute("role")) === "status", "boot card has no status role");
  check((await boot.getAttribute("aria-label")) === "Loading neobox", "boot card is not labelled Loading neobox");
  await menuName(page).waitFor();
  await page.waitForFunction(() => {
    const el = document.getElementById("boot");
    return el === null || el.hidden;
  });
  return "boot card (status, Loading neobox) shown on load, hidden once the menu is up";
}

/** phone-splash-play and phone-splash-dismiss: a touch-only first visit shows the Welcome sheet; Play closes it and it stays gone after a reload. */
async function matchPhoneSplash(s) {
  const h = await s.open("splash", { phone: true });
  const { page } = h;
  await page.goto(s.base);
  const welcome = page.getByRole("dialog", { name: "Welcome", exact: true });
  await welcome.waitFor({ state: "visible" });
  await welcome.getByRole("button", { name: "Play", exact: true }).click();
  await welcome.waitFor({ state: "detached" });
  await menuName(page).waitFor();
  await page.reload();
  await menuName(page).waitFor();
  await sleep(800);
  check((await welcome.count()) === 0, "the Welcome sheet came back after a reload");
  return "Welcome sheet: Play closes it to the menu; it stays gone after reload";
}

/** practice-setup and practice-play: the setup lists the built-in maps with Start; a map plays, Leave returns to setup, Back to the menu. */
async function matchPractice(s) {
  const h = await s.open("practice");
  const { page } = h;
  await page.goto(s.base);
  await menuName(page).waitFor();
  await navTo(page, "Practice");
  const choices = page.locator(".offline-list .offline-choice");
  await choices.first().waitFor({ state: "visible" });
  const maps = await builtinMaps(s.base);
  const shown = await choices.count();
  check(shown === maps.length, `practice lists ${shown} map choices, the server has ${maps.length}`);
  await button(page, "Start").waitFor({ state: "visible" });
  await choices.first().click();
  await button(page, "Start").click();
  await page.locator(".offline.playing").waitFor();
  await waitForPixels(h, "practice canvas");
  await button(page, "Leave").click();
  await button(page, "Start").waitFor({ state: "visible" });
  await back(page).click();
  await menuName(page).waitFor();
  return `${shown} map choices and Start; the first map plays, Leave returns to setup, Back to the menu`;
}

/** training-hall: Next advances the lesson text; Replay tutorial returns to lesson 1; Leave returns to the menu. */
async function matchTraining(s) {
  const h = await s.open("training");
  const { page } = h;
  await page.goto(s.base);
  await menuName(page).waitFor();
  await navTo(page, "Training");
  const text = page.locator(".training-text");
  const count = page.locator(".training-count");
  await text.waitFor({ state: "visible" });
  const first = ((await text.textContent()) ?? "").trim();
  check((await count.textContent())?.startsWith("1 of"), `first lesson counter reads "${await count.textContent()}"`);
  await page.getByRole("button", { name: /^Next/ }).click();
  await count.filter({ hasText: "2 of" }).waitFor({ state: "visible" });
  const second = ((await text.textContent()) ?? "").trim();
  check(second !== first, "Next did not change the lesson text");
  await button(page, "Replay tutorial").click();
  await count.filter({ hasText: "1 of" }).waitFor({ state: "visible" });
  check(((await text.textContent()) ?? "").trim() === first, "Replay tutorial did not return to lesson 1");
  await button(page, "Leave").click();
  await menuName(page).waitFor();
  return "Next changes the lesson, Replay tutorial returns to lesson 1, Leave returns to the menu";
}

/** NEW-replay-save, replay-picker and replay-view: a match's Save replay downloads a .nbreplay that the Replay screen opens and plays. */
async function matchReplay(s) {
  const { host } = await matchWithGuest(s, { clipboard: false });
  await waitForPixels(host, "match canvas");
  await host.page.locator(".hud-end").click();
  // a closed dialog stays in the DOM while it animates out, so only an open one counts
  const endDialog = host.page.getByRole("alertdialog", { name: "End the match?", exact: true }).and(host.page.locator("dialog[open]"));
  await endDialog.waitFor();
  await endDialog.getByRole("button", { name: "End match", exact: true }).click();
  const save = button(host.page, "Save replay");
  await save.waitFor();
  const [download] = await Promise.all([host.page.waitForEvent("download"), save.click()]);
  check(download.suggestedFilename().endsWith(".nbreplay"), `download is ${download.suggestedFilename()}`);
  const dir = mkdtempSync(path.join(os.tmpdir(), "neobox-replay-"));
  const file = path.join(dir, download.suggestedFilename());
  await download.saveAs(file);
  await host.page.goto(s.base);
  await menuName(host.page).waitFor();
  await navTo(host.page, "Replay");
  // replay-picker: the Replay screen takes a .nbreplay file
  const picker = host.page.locator("input[type=file]").first();
  await picker.waitFor({ state: "attached" });
  check(((await picker.getAttribute("accept")) ?? "").includes(".nbreplay"), "the replay file input does not accept .nbreplay");
  await picker.setInputFiles(file);
  await host.page.locator(".offline.playing").waitFor();
  await waitForPixels(host, "replay canvas");
  // replay-view: Play and Pause toggle; the seek bar moves the replay
  await button(host.page, "Play").click();
  await button(host.page, "Pause").waitFor({ state: "visible" });
  await button(host.page, "Pause").click();
  await button(host.page, "Play").waitFor({ state: "visible" });
  const seek = host.page.getByLabel("Seek", { exact: true });
  const target = String(Math.floor(Number(await seek.getAttribute("max")) / 2));
  await seek.fill(target);
  check((await seek.inputValue()) === target, "the seek bar did not take the new position");
  return `saved ${download.suggestedFilename()}; the Replay screen opened it, Play/Pause toggled, seek moved`;
}

/** editor-page, editor-menu and editor-testplay: the editor canvas and tools, its Menu with the built-in maps and share code, and Test play. */
async function matchEditorMenu(s) {
  const user = await signedIn(s, "edmenu");
  const { page } = user;
  await navTo(page, "Map editor");
  const canvas = editorCanvas(page);
  await canvas.waitFor({ state: "visible" });
  // The canvas takes the stage's size (the side panel and viewport decide it); its backing store follows that box at the device ratio.
  const size = await canvas.evaluate((c) => ({ w: c.width, h: c.height, cssW: c.clientWidth, cssH: c.clientHeight, dpr: Math.min(window.devicePixelRatio || 1, 2) }));
  check(size.cssW > 0 && size.cssH > 0, `editor canvas has no box (${size.cssW}x${size.cssH})`);
  check(Math.abs(size.w - Math.round(size.cssW * size.dpr)) <= 1 && Math.abs(size.h - Math.round(size.cssH * size.dpr)) <= 1, `editor canvas backing ${size.w}x${size.h} does not match its box ${size.cssW}x${size.cssH} at ${size.dpr}x`);
  for (const name of ["Box", "Select", "Undo", "Redo", "Menu"]) await button(page, name).waitFor({ state: "visible" });
  const menu = page.locator(".editor-menu");
  const items = page.locator(".editor-list .editor-item");
  await button(page, "Menu").click();
  await menu.waitFor({ state: "visible" });
  const maps = await builtinMaps(s.base);
  // The list fills from the server after the menu opens: wait for the full count, then report the count that was checked.
  await page.waitForFunction((n) => document.querySelectorAll(".editor-list .editor-item").length >= n, maps.length, { timeout: 10000 }).catch(() => {});
  const listed = await items.count();
  check(listed === maps.length, `editor menu lists ${listed} maps, the server has ${maps.length}`);
  await button(page, "Close").click();
  await menu.waitFor({ state: "hidden" });
  // a built-in map from the menu; a fresh editor has nothing to replace
  await button(page, "Menu").click();
  await items.first().click();
  const replace = page.getByRole("alertdialog", { name: "Replace the current map?", exact: true });
  if (await replace.waitFor({ state: "visible", timeout: 1500 }).then(() => true, () => false)) {
    await replace.getByRole("button", { name: "Replace map", exact: true }).click();
  }
  await menu.waitFor({ state: "hidden" });
  await button(page, "Menu").click();
  await menu.waitFor({ state: "visible" });
  const code = await page.locator("textarea.editor-code").inputValue();
  check(code.length > 0, "share code is empty");
  await button(page, "Close").click();
  await menu.waitFor({ state: "hidden" });
  // editor-testplay: Test play starts an offline match; Edit returns to the canvas
  await button(page, "Test play").click();
  const title = page.locator(".offline.playing .offline-title");
  await title.waitFor({ state: "visible" });
  check(((await title.textContent()) ?? "").trim().length > 0, "test play shows no match title");
  await button(page, "Edit").click();
  await canvas.waitFor({ state: "visible" });
  return "editor canvas drawn at its box with tools; Menu lists the built-in maps and Close hides it; Test play then Edit";
}

/** modal-kit and editor-save-dialog: Save to library opens a modal with Map name and Upload; Cancel closes it. editor-toasts: Upload saves and toasts. */
async function matchEditorSave(s) {
  const user = await signedIn(s, "edsave");
  const { page } = user;
  await navTo(page, "Map editor");
  await editorCanvas(page).waitFor({ state: "visible" });
  const modal = page.locator("dialog.modal[open]");
  await button(page, "Menu").click();
  await page.getByRole("button", { name: "Save to library", exact: true }).click();
  await modal.waitFor({ state: "visible" });
  check((await modal.count()) === 1, `${await modal.count()} modals open after Save to library`);
  check(await modal.getByLabel("Map name", { exact: true }).isVisible(), "save dialog has no Map name field");
  check(await modal.getByRole("button", { name: "Upload", exact: true }).isVisible(), "save dialog has no Upload button");
  await modal.getByRole("button", { name: "Cancel", exact: true }).click();
  await modal.waitFor({ state: "hidden" });
  const name = uniqueName("edsave");
  await button(page, "Menu").click();
  await page.getByRole("button", { name: "Save to library", exact: true }).click();
  await modal.getByLabel("Map name", { exact: true }).fill(name);
  await modal.getByRole("button", { name: "Upload", exact: true }).click();
  await page.locator(".toast-info").filter({ hasText: "Saved to your library" }).waitFor({ state: "visible" });
  return `Save dialog (Map name, Upload) closes on Cancel; Upload toasts "Saved to your library" (${name})`;
}

/** editor-save-dialog (guest variant): a guest's Save to library opens the modal that asks them to sign in. */
async function matchEditorGuest(s) {
  const guest = await s.open("edguest", { name: uniqueName("edg") });
  const { page } = guest;
  await page.goto(s.base);
  await menuName(page).waitFor();
  await navTo(page, "Map editor");
  await editorCanvas(page).waitFor({ state: "visible" });
  await button(page, "Menu").click();
  for (const name of ["Save to library", "Load file", "Download", "Copy map code", "New map"]) {
    check(await page.getByRole("button", { name, exact: true }).first().isVisible(), `editor menu has no ${name}`);
  }
  await page.getByRole("button", { name: "Save to library", exact: true }).click();
  const modal = page.locator("dialog.modal[open]");
  await modal.waitFor({ state: "visible" });
  check((await modal.count()) === 1, `${await modal.count()} modals open for a guest save`);
  await modal.getByText("Sign in to save maps to your library.").waitFor({ state: "visible" });
  await modal.getByRole("button", { name: /^(Cancel|Close)$/ }).first().click();
  await modal.waitFor({ state: "hidden" });
  return "guest Save to library shows the sign-in prompt in one modal";
}

/** editor-inspector: shape fields keep every edit across a reselect: one committed with Enter, one committed by a click on the canvas, both read back after the body is selected again. */
async function matchEditorInspector(s) {
  const user = await signedIn(s, "edinsp");
  const { page } = user;
  await navTo(page, "Map editor");
  const canvas = editorCanvas(page);
  await canvas.waitFor({ state: "visible" });
  const box = await waitStable(canvas);
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await button(page, "Box").click();
  await page.mouse.move(cx - 80, cy - 50);
  await page.mouse.down();
  await page.mouse.move(cx + 80, cy + 50, { steps: 8 });
  await page.mouse.up();
  await button(page, "Select").click();
  const shape = page.locator(".editor-side details.inspector-shape-details").first();
  const offX = shape.getByLabel("Offset X", { exact: true });
  const offY = shape.getByLabel("Offset Y", { exact: true });
  const selectBody = async () => {
    await page.mouse.click(cx, cy);
    await offX.waitFor({ state: "visible" });
  };
  await selectBody();
  // The offsets move the shape in map units: at the opening zoom (Screen width across the canvas) 7.5 units is about
  // 200px, past the 160px box, so the reselect click at the centre would miss it. Small offsets keep it under the pointer.
  await offX.fill("1.5");
  await offX.press("Enter");
  await offY.fill("0.5");
  // A canvas press blurs the field (its change commits the 0.5), then clears the selection.
  await page.mouse.click(box.x + 5, box.y + 5);
  await selectBody();
  const want = { x: "1.5", y: "0.5" };
  let got = {};
  for (let i = 0; i < 30; i++) {
    got = { x: await offX.inputValue(), y: await offY.inputValue() };
    if (got.x === want.x && got.y === want.y) break;
    await sleep(100);
  }
  check(got.x === want.x, `Offset X is ${got.x} after reselect, edited to ${want.x}`);
  check(got.y === want.y, `Offset Y is ${got.y} after reselect, edited to ${want.y}`);
  return "shape Offset X and Y survive a reselect after Enter and blur commits";
}

/**
 * editor-inspector-close and editor-testplay-mode: on desktop the inspector's close button hides the panel (the canvas
 * widens) and the rail's Map settings button brings it back; test play starts in the mode picked beside it.
 */
async function matchEditorPanelAndMode(s) {
  const user = await signedIn(s, "edpanel");
  const { page } = user;
  await navTo(page, "Map editor");
  const canvas = editorCanvas(page);
  await canvas.waitFor({ state: "visible" });
  const side = page.getByRole("complementary", { name: "Inspector", exact: true });
  await side.waitFor({ state: "visible" });
  const wideBefore = (await waitStable(canvas)).width;
  await page.getByRole("button", { name: "Close inspector", exact: true }).click();
  await side.waitFor({ state: "hidden" });
  const wideAfter = (await waitStable(canvas)).width;
  check(wideAfter > wideBefore + 100, `the canvas did not take the inspector's width (${wideBefore} -> ${wideAfter})`);
  await page.locator(".editor-side-toggle").click();
  await side.waitFor({ state: "visible" });
  // A built-in map from the editor's Menu: a fresh map has no ground, so nobody would stay on screen.
  await button(page, "Menu").click();
  await page.locator(".editor-list .editor-item").first().click();
  const replace = page.getByRole("alertdialog", { name: "Replace the current map?", exact: true });
  if (await replace.waitFor({ state: "visible", timeout: 1500 }).then(() => true, () => false)) {
    await replace.getByRole("button", { name: "Replace map", exact: true }).click();
  }
  await page.locator(".editor-menu").waitFor({ state: "hidden" });
  const mode = page.getByRole("combobox", { name: "Test play mode", exact: true });
  check((await mode.inputValue()) === "6", `test play mode starts at ${await mode.inputValue()}, not Endless`);
  await mode.selectOption({ label: "Team rounds" });
  await button(page, "Test play").click();
  await page.locator(".offline.playing").waitFor();
  // A mode other than Endless adds a dummy opponent: the overlay's QA hook draws two name labels (you and Dummy).
  await page.waitForFunction(() => (globalThis.__qaDraw?.rects ?? []).filter((r) => r.kind === "label").length === 2, null, { timeout: 15000 });
  await button(page.locator(".offline-top"), "Edit").click();
  await canvas.waitFor({ state: "visible" });
  return `inspector closes (canvas ${wideBefore} -> ${wideAfter} px) and reopens; test play in Team rounds runs with a dummy opponent`;
}

/** postgame: a private room's signed-in host and guest see Game over with an XP line; Escape closes the host's; the room roster shows the level chip. */
async function matchPostgame(s) {
  const user = await signedIn(s, "pg");
  const { page } = user;
  const roomName = uniqueName("pg");
  const code = await createRoom(user, s.base, roomName, { isPublic: false });
  const guest = await signedIn(s, "pgg");
  await joinByInvite(guest, s.base, code, roomName);
  await page.locator("li.room-player").filter({ hasText: guest.userName }).waitFor();
  // a map with no ground and one life each: the match ends by itself
  const voidMap = '{"b":[],"j":[],"s":[{"1":15,"2":10},{"1":25,"2":10}],"p":[],"tu":[],"tc":[],"gp":[],"c":[],"set":{"3":40,"15":40,"16":25}}';
  await button(page, "Change map").click();
  await page.getByLabel("Map code or JSON", { exact: true }).fill(voidMap);
  await button(page, "Use code").click();
  const chat = page.getByLabel("Chat message", { exact: true });
  await chat.fill("/mode 1");
  await chat.press("Enter");
  await chat.fill("/set objectiveLimit 1");
  await chat.press("Enter");
  await page.locator("div.room-chat-log").getByText("objectiveLimit: 1").waitFor();
  await button(page, "Start").click();
  const panel = page.getByRole("dialog", { name: "Game over" });
  await panel.waitFor({ timeout: 60_000 });
  const xp = panel.getByText(/\+\d+ xp/);
  // the count runs up to the award after a short delay; read it once it lands
  await panel.getByText(/\+[1-9]\d* xp/).waitFor();
  const guestPanel = guest.page.getByRole("dialog", { name: "Game over" });
  await guestPanel.waitFor({ timeout: 20_000 });
  const gain = (await xp.textContent())?.trim();
  await page.keyboard.press("Escape");
  await panel.waitFor({ state: "detached" });
  await page.locator("span.room-level").filter({ hasText: /^Lv \d+$/ }).first().waitFor();
  return `Game over on both pages with "${gain}"; Escape closes it; level chip shows`;
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
  { name: "inv match gamepad actions", inv: ["gamepad-push", "gamepad-bat", "gamepad-rocket", "gamepad-grab"], run: matchPadActions },
  { name: "inv match blur", inv: ["kb-blur-clear"], run: matchBlurClear },
  { name: "inv match record", inv: ["NEW-chat-record"], run: matchChatRecord },
  { name: "inv match rotate gate", inv: ["hud-rotate"], run: matchRotateGate },
  { name: "inv match phone chat", inv: ["hud-chat (touch Chat button)"], run: matchPhoneChat },
  { name: "inv match matching", inv: ["hud-matching"], run: matchQuickAlone },
  { name: "inv match sign-out error", inv: ["hud-error"], run: matchSignOutError },
  { name: "inv match quick xp", inv: ["hud-xp", "xp-quick"], run: matchQuickXp },
  { name: "inv match jukebox", inv: ["jukebox-url-enter", "jukebox-panel", "jukebox-toasts", "toast-host"], run: matchJukebox },
  { name: "inv match screen transition", inv: ["screen-transition", "modal-kit"], run: matchScreenTransition },
  { name: "inv match boot", inv: ["boot-splash"], run: matchBoot },
  { name: "inv match phone splash", inv: ["phone-splash-play", "phone-splash-dismiss"], run: matchPhoneSplash },
  { name: "inv match practice", inv: ["practice-setup", "practice-play"], run: matchPractice },
  { name: "inv match training", inv: ["training-hall"], run: matchTraining },
  { name: "inv match replay", inv: ["NEW-replay-save", "replay-picker", "replay-view"], run: matchReplay },
  { name: "inv match editor menu", inv: ["editor-page", "editor-menu", "editor-testplay"], run: matchEditorMenu },
  { name: "inv match editor save", inv: ["editor-save-dialog", "editor-toasts"], run: matchEditorSave },
  { name: "inv match editor guest", inv: ["editor-save-dialog (guest)"], run: matchEditorGuest },
  { name: "inv match editor inspector", inv: ["editor-inspector-shape"], run: matchEditorInspector },
  { name: "inv match editor panel and mode", inv: ["editor-inspector-close", "editor-testplay-mode"], run: matchEditorPanelAndMode },
  { name: "inv match postgame", inv: ["postgame"], run: matchPostgame },
];
