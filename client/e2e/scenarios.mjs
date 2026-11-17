// The e2e scenarios. Each one drives the real UI of a real server (see lib.mjs)
// and returns an optional detail string for its `ok` line. Each scenario gets its own server (a fresh database) unless
// it brings a topology, so `run.mjs` can run any subset in any order, in parallel.

import {
  ADMIN_PASSWORD,
  adminRoom,
  button,
  builtinMaps,
  createRoom,
  expectNoOverflow,
  matchWithGuest,
  menuName,
  measureFirstChange,
  navTo,
  waitStable,
  PASSWORD,
  playFromMenu,
  probeChanges,
  waitQuiet,
  roomCode,
  roomTitle,
  signedIn,
  sleep,
  uniqueName,
  waitForPixels,
  ensureProbe,
  joinByInvite,
  ensureRoomMap,
  startMatch,
  signUp,
  dismissPhoneSplash,
  ipIn,
  geoServer,
  regionServers,
  rtcServer,
} from "./lib.mjs";
import { livenessScenarios } from "./liveness.mjs";
import { matchInvScenarios } from "./inv-match.mjs";
import { roomsInvScenarios } from "./inv-rooms.mjs";
import { writeFileSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const check = (ok, message) => {
  if (!ok) throw new Error(message);
};

/** The Back button of the current screen (every screen has one). */
const back = (page) => button(page, "Back").first();

/** Waits until the menu's name box shows `name` (a signed-in account fills it in). */
async function expectMenuName(page, name) {
  for (let i = 0; i < 100; i++) {
    if ((await menuName(page).inputValue()) === name) return;
    await sleep(100);
  }
  throw new Error(`menu name is not "${name}"`);
}

/** Waits for a friend row matching `text`, re-opening the Friends screen (it only refreshes on open). */
async function friendRow(page, text, sub = "", timeoutMs = 25_000) {
  const end = Date.now() + timeoutMs;
  const row = page.locator("li.friend-row").filter({ hasText: text }).filter({ hasText: sub }).first();
  for (;;) {
    // the list loads after the screen opens, so give each open a moment before re-opening
    if (await row.waitFor({ state: "attached", timeout: 2_000 }).then(() => true, () => false)) return row;
    if (Date.now() > end) throw new Error(`friend row "${text}" never appeared`);
    await back(page).click();
    await navTo(page, "Friends");
  }
}

/** Lobby room-player row for a name. */
const playerRow = (page, name) => page.locator("li.room-player").filter({ hasText: name });

// ------------------------------------------------------------------ scenarios

async function menu(s) {
  const h = await s.open("desktop");
  const { page } = h;
  await page.goto(s.base);
  await menuName(page).waitFor();
  check(await button(page, "Quick play").isVisible(), "Quick play button not visible");
  check(await button(page, "Browse rooms").isVisible(), "Browse rooms button not visible");
  const links = ["Training", "Library", "Friends", "Practice", "Replay", "Map editor", "Settings", "About"];
  for (const link of links) {
    await navTo(page, link);
    if (link === "Map editor") {
      await button(page, "Back").click();
    } else if (link === "Training") {
      // the training hall is a game view: it leaves like practice does
      await button(page, "Leave").click();
    } else {
      // the other screens show a Back button
      await back(page).click();
    }
    await menuName(page).waitFor();
  }
  return `${links.length} links`;
}

async function settings(s) {
  const h = await s.open("desktop");
  const { page } = h;
  await page.goto(s.base);
  await menuName(page).waitFor();
  await navTo(page, "Settings");
  const jump = page.getByRole("button", { name: /^Jump key/ }).first();
  await jump.click();
  await page.keyboard.press("KeyK");
  await page.getByRole("button", { name: /^Jump key.*KeyK|^Jump key.*K\b/ }).first().waitFor();
  await page.reload();
  await menuName(page).waitFor();
  await navTo(page, "Settings");
  check(
    (await page.getByRole("button", { name: /^Jump key/ }).first().getAttribute("aria-label"))?.includes("K"),
    "rebound Jump key did not persist across reload",
  );
  const volume = page.getByRole("slider", { name: "Volume", exact: true });
  await volume.fill("30");
  await page.reload();
  await menuName(page).waitFor();
  await navTo(page, "Settings");
  check((await page.getByRole("slider", { name: "Volume", exact: true }).inputValue()) === "30", "volume did not persist");
  await page.getByLabel("Deuteranopia (green-blind)", { exact: false }).check();
  await page.reload();
  await menuName(page).waitFor();
  await navTo(page, "Settings");
  check(
    await page.getByLabel("Deuteranopia (green-blind)", { exact: false }).isChecked(),
    "palette choice did not persist",
  );
  // Touch: the tall Jump slot takes Bat; Bat moves into the slot Jump left. Persists across a reload.
  await page.locator(".settings-nav-item", { hasText: "Touch" }).click();
  await page.locator('.touch-layout select[data-slot="jump"]').selectOption("bat");
  await page.reload();
  await menuName(page).waitFor();
  await navTo(page, "Settings");
  check(
    (await page.locator('.touch-layout select[data-slot="jump"]').inputValue()) === "bat" &&
      (await page.locator('.touch-layout select[data-slot="bat"]').inputValue()) === "up",
    "touch button layout did not persist as a swap",
  );
  await button(page, "Reset to defaults").click();
  return "jump rebind, volume, palette, touch layout persisted";
}

async function accessibilityPrefs(s) {
  const { page } = await s.open("desktop");
  const openSettings = async () => {
    await page.goto(s.base);
    await menuName(page).waitFor();
    await navTo(page, "Settings");
    await page.getByRole("radiogroup", { name: "Motion", exact: true }).waitFor();
  };
  const choose = (group, option) =>
    page.getByRole("radiogroup", { name: group, exact: true }).getByRole("radio", { name: option, exact: true }).click();
  const rootData = (key) => page.evaluate((k) => document.documentElement.dataset[k], key);
  const rootFontSize = () => page.evaluate(() => getComputedStyle(document.documentElement).fontSize);
  const bodyFont = () => page.evaluate(() => getComputedStyle(document.body).fontFamily);

  // The system's reduce-motion setting applies while the player has not chosen one.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openSettings();
  check((await rootData("motion")) === "reduce", "system reduce-motion did not apply");
  // The player's choice overrides the system both ways.
  await choose("Motion", "Full");
  check((await rootData("motion")) === "full", "Full did not override the system reduce-motion");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await choose("Motion", "Reduce");
  check((await rootData("motion")) === "reduce", "Reduce did not override the system setting");
  await openSettings();
  check((await rootData("motion")) === "reduce", "Reduce did not persist across reload");

  await choose("Text size", "150%");
  check((await rootFontSize()) === "24px", `150% text size gave root font-size ${await rootFontSize()}`);
  await openSettings();
  check((await rootFontSize()) === "24px", "150% text size did not persist across reload");

  await page.getByRole("switch", { name: /^Readable font/ }).check();
  check((await rootData("font")) === "readable", "readable font did not apply");
  check((await bodyFont()).includes("OpenDyslexic"), `body font is ${await bodyFont()}`);
  await openSettings();
  check(await page.getByRole("switch", { name: /^Readable font/ }).isChecked(), "readable font did not persist across reload");
  check((await bodyFont()).includes("OpenDyslexic"), "readable font not applied after reload");

  await button(page, "Reset to defaults").click();
  await page.getByRole("dialog").getByRole("button", { name: "Reset everything", exact: true }).click();
  check((await rootFontSize()) === "16px", "reset did not restore the text size");
  check((await rootData("font")) === "default", "reset did not restore the font");
  return "motion override, 150% text, readable font persisted; reset restores";
}

async function accounts(s) {
  const name = uniqueName("acct");
  const h = await s.open("desktop");
  const { page } = h;
  await page.goto(s.base);
  await menuName(page).waitFor();
  await page.getByRole("button", { name: /^(Sign in|Account, Level \d+)$/ }).first().click();
  await page.locator(".account-form").getByLabel("name", { exact: true }).fill(name);
  await page.getByLabel("password", { exact: true }).fill(PASSWORD);
  await button(page, "Create account").click();
  await page.getByText("Account created.").waitFor();
  await page.goto(s.base);
  await menuName(page).waitFor();
  await page.reload();
  await expectMenuName(page, name);
  await page.getByRole("button", { name: /^(Sign in|Account, Level \d+)$/ }).first().click();
  await page.getByText(name, { exact: false }).first().waitFor();
  await button(page, "Sign out").click();
  await page.locator(".account-form").getByLabel("name", { exact: true }).waitFor();
  await page.locator(".account-form").getByLabel("name", { exact: true }).fill(name);
  await page.getByLabel("password", { exact: true }).fill(PASSWORD);
  await button(page, "Sign in").click();
  await page.getByText("Signed in.").waitFor();
  return `account ${name}`;
}

async function friends(s) {
  const a = await signedIn(s, "alice");
  const b = await signedIn(s, "bob");
  await navTo(a.page, "Friends");
  await a.page.getByLabel("friend's name", { exact: true }).fill(b.userName);
  await button(a.page, "Send request").click();
  await a.page.getByText(`Request sent to ${b.userName}.`).waitFor();
  await navTo(b.page, "Friends");
  const incoming = await friendRow(b.page, a.userName);
  await incoming.getByRole("button", { name: "Accept", exact: true }).click();
  await b.page.getByText(`You are now friends with ${a.userName}.`).waitFor();
  // B enters a room, which also marks B online: A sees the room in the friend row and can join it.
  const roomName = uniqueName("fr");
  await createRoom(b, s.base, roomName, { isPublic: true });
  await a.page.goto(s.base);
  await menuName(a.page).waitFor();
  await navTo(a.page, "Friends");
  const inRoom = await friendRow(a.page, b.userName, `in ${roomName}`);
  await inRoom.getByText(`in ${roomName}`, { exact: true }).waitFor();
  await inRoom.getByRole("button", { name: "Join", exact: true }).click();
  await roomTitle(a.page, roomName).waitFor();
  return "request, accept, online in a room, join";
}

async function library(s) {
  const user = await signedIn(s, "maker");
  const maps = await builtinMaps(s.base);
  const map = maps[0];
  const name = uniqueName("lib");
  const { page } = user;
  const openMap = async (p, mapName) => {
    await p.locator("ul[aria-label=maps] li").filter({ hasText: mapName }).first().locator(".map-card").click();
    const dlg = p.getByRole("dialog", { name: mapName, exact: true });
    await dlg.waitFor();
    return dlg;
  };
  await navTo(page, "Library");
  await page.getByRole("tab", { name: "Mine", exact: true }).or(button(page, "Mine")).first().click();
  await page.getByRole("button", { name: "Upload a map", exact: true }).click();
  await page.getByPlaceholder("Map name", { exact: true }).fill(name);
  await page.getByLabel("map code", { exact: true }).fill(map.code);
  await page.getByRole("radiogroup", { name: "Visibility", exact: true }).getByRole("radio", { name: "Public", exact: true }).click();
  await page.getByRole("button", { name: "Upload map", exact: true }).click();
  await page.locator("ul[aria-label=maps] li").filter({ hasText: name }).waitFor();
  // Not in public Browse until an admin approves it. The owner sees their own pending map
  // there too, so look from another visitor's browser.
  const visitor = await s.open("visitor");
  await visitor.page.goto(s.base);
  await menuName(visitor.page).waitFor();
  await navTo(visitor.page, "Library");
  await button(visitor.page, "Browse").or(visitor.page.getByRole("tab", { name: "Browse", exact: true })).first().click();
  check((await visitor.page.locator("ul[aria-label=maps] li").filter({ hasText: name }).count()) === 0, "unapproved map is public");

  const admin = await s.open("admin");
  await admin.page.goto(`${s.base}/admin`);
  await admin.page.locator("#pw").fill(ADMIN_PASSWORD);
  await button(admin.page, "Log in").click();
  await admin.page.getByRole("heading", { name: "Map approvals" }).waitFor();
  await admin.page
    .locator("table#maps tbody tr")
    .filter({ hasText: name })
    .getByRole("button", { name: "Approve", exact: true })
    .click();
  await admin.page.getByText(`Approved ${name}.`).waitFor();

  await page.reload();
  await navTo(page, "Library");
  await button(page, "Browse").or(page.getByRole("tab", { name: "Browse", exact: true })).first().click();
  const card = page.locator("ul[aria-label=maps] li").filter({ hasText: name });
  await card.first().waitFor();
  const dlg = await openMap(page, name);
  check(await dlg.getByRole("button", { name: "Upvote", exact: true }).isDisabled(), "the author can vote on their own map");
  await dlg.getByRole("button", { name: "Star", exact: true }).click();
  await dlg.getByRole("button", { name: "Starred", exact: true }).waitFor();
  await page.keyboard.press("Escape");
  await dlg.waitFor({ state: "detached" });

  // Another account upvotes; the vote is still shown after a reload.
  const voter = await signedIn(s, "voter");
  await navTo(voter.page, "Library");
  let vote = await openMap(voter.page, name);
  await vote.getByRole("button", { name: "Upvote", exact: true }).click();
  await vote.locator('button[aria-pressed="true"]', { hasText: "Upvote" }).waitFor();
  await vote.getByText("1 vote ·", { exact: false }).waitFor();
  await voter.page.keyboard.press("Escape");
  await vote.waitFor({ state: "detached" });
  await voter.page.reload();
  await navTo(voter.page, "Library");
  vote = await openMap(voter.page, name);
  await vote.locator('button[aria-pressed="true"]', { hasText: "Upvote" }).waitFor();
  await vote.getByText("1 vote ·", { exact: false }).waitFor();

  // A room host picks the approved map from the room's Library picker.
  await back(page).click();
  const roomName = uniqueName("pick");
  await createRoom(user, s.base, roomName, { isPublic: true });
  await button(page, "Change map").click();
  await button(page, "Library").click();
  const picker = page.getByRole("dialog", { name: "Pick a map" });
  await picker.waitFor();
  await picker.locator(".map-card").filter({ hasText: name }).first().click();
  await page.locator(".room-map-name").filter({ hasText: name }).waitFor();
  // the original's Fastest Times window for the library map: nobody has raced it yet
  await button(page, "Fastest Times").click();
  const times = page.getByRole("dialog", { name: "Fastest Times" });
  await times.getByText(`${name} by ${user.userName}`).waitFor();
  await times.getByText("No Records").waitFor();
  await page.keyboard.press("Escape");
  await times.waitFor({ state: "detached" });
  return `approved ${name}, voted, starred, picked in room, Fastest Times`;
}

async function roomMatch(s) {
  const m = await matchWithGuest(s, { clipboard: true });
  const { host, guest } = m;
  await waitForPixels(host, "host canvas");
  await waitForPixels(guest, "guest canvas");
  // Frames freeze during the start countdown; wait it out, then holding
  // ArrowRight moves the guest's player, so the rendered frames keep changing.
  await sleep(4000);
  const before = await probeChanges(guest.page);
  await guest.page.keyboard.down("ArrowRight");
  await sleep(1000);
  await guest.page.keyboard.up("ArrowRight");
  const moved = (await probeChanges(guest.page)) - before;
  check(moved > 5, `guest frames barely changed while holding ArrowRight (${moved} changes)`);
  await host.page.locator(".hud-scores table.hud-table").waitFor({ state: "attached" }).catch(() => {});
  return `both canvases render; ${moved} frame changes while holding Right`;
}

/** Lobby: lock teams, kick, ban/unban, chat with Up-arrow recall. Runs before the match starts. */
async function roomLobby(s) {
  const hostName = uniqueName("host");
  const guestName = uniqueName("guest");
  const extraName = uniqueName("extra");
  const roomName = uniqueName("lobby");
  const host = await s.open("host", { name: hostName });
  const code = await createRoom(host, s.base, roomName, { isPublic: true });
  const guest = await s.open("guest", { name: guestName });
  await joinByInvite(guest, s.base, code, roomName);
  const extra = await s.open("extra", { name: extraName });
  await joinByInvite(extra, s.base, code, roomName);
  await playerRow(host.page, guestName).waitFor();
  await playerRow(host.page, extraName).waitFor();

  await button(host.page, "Lock teams").click();
  await button(host.page, "Unlock teams").waitFor();

  await playerRow(host.page, extraName).getByRole("button", { name: `Actions for ${extraName}`, exact: true }).click();
  await host.page.getByRole("menuitem", { name: "Kick", exact: true }).click();
  await playerRow(host.page, extraName).waitFor({ state: "detached" });
  await extra.page.getByText(/kicked/i).first().waitFor();

  await playerRow(host.page, guestName).getByRole("button", { name: `Actions for ${guestName}`, exact: true }).click();
  await host.page.getByRole("menuitem", { name: "Ban", exact: true }).click();
  await host.page.locator("li.room-ban").filter({ hasText: guestName }).waitFor();
  await host.page.locator("li.room-ban").filter({ hasText: guestName }).getByRole("button", { name: "Unban", exact: true }).click();
  await host.page.locator("li.room-ban").filter({ hasText: guestName }).waitFor({ state: "detached" });
  await joinByInvite(guest, s.base, code, roomName);
  await playerRow(host.page, guestName).waitFor();

  const message = `hello ${uniqueName("")}`.slice(0, 20);
  const chat = guest.page.getByLabel("Chat message", { exact: true });
  await chat.fill(message);
  await chat.press("Enter");
  await host.page.locator("div.room-chat-log").getByText(message, { exact: false }).waitFor();
  await guest.page.getByLabel("Chat message", { exact: true }).focus();
  await guest.page.keyboard.press("ArrowUp");
  check(
    (await guest.page.getByLabel("Chat message", { exact: true }).inputValue()) === message,
    "Up arrow did not recall the last chat line",
  );
  return `lock, kick, ban/unban, chat recall (room ${code})`;
}

/** Polls the admin view (refreshed about once a second) until `name` holds exactly one connected seat in room `code`. */
async function connectedSeat(base, code, name) {
  const end = Date.now() + 5000;
  for (;;) {
    const players = (await adminRoom(base, code)).players;
    const seats = players.filter((p) => p.name === name);
    if (seats.length === 1 && seats[0].connected) return seats[0];
    if (Date.now() > end) throw new Error(`${name} has no single connected seat: ${JSON.stringify(players.map((p) => [p.id, p.name, p.connected]))}`);
    await sleep(250);
  }
}

async function reconnect(s) {
  const m = await matchWithGuest(s, { clipboard: false });
  const { host, guest, guestName, code } = m;
  const before = await connectedSeat(s.base, code, guestName);
  await guest.page.reload();
  await guest.page.locator(".hud-leave").waitFor({ state: "visible", timeout: 20_000 });
  await waitForPixels(guest, "guest canvas after reload");
  await host.page.locator(".hud-leave").waitFor({ state: "visible" });
  // the reload resumed the held seat rather than joining as a second player
  await sleep(1500);
  const after = await connectedSeat(s.base, code, guestName);
  check(after.id === before.id, `the guest came back as player ${after.id}, was ${before.id}`);
  return `guest resumed seat ${before.id} in the same match`;
}

/**
 * The reload's resumed snapshot lands while the engine is still downloading (a slow link, a loaded host): the match
 * is entered once the engine has loaded, not left on the room screen.
 */
async function reconnectSlowEngine(s) {
  const m = await matchWithGuest(s, { clipboard: false });
  const { host, guest, guestName, code } = m;
  const before = await connectedSeat(s.base, code, guestName);
  // the engine's download is held until the resumed match is on the room screen
  let asked = () => {};
  const requested = new Promise((resolve) => {
    asked = resolve;
  });
  let release = () => {};
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  // the worker fetches the engine itself, where a route cannot see it (firefox, webkit): drop it so the reload asks the network
  await guest.page.evaluate(async () => {
    for (const registration of await navigator.serviceWorker.getRegistrations()) await registration.unregister();
  });
  await guest.context.route("**/neobox.wasm*", async (route) => {
    asked();
    await gate;
    await route.continue();
  });
  // a slower CPU also stretches the engine's compile (chromium exposes the throttle)
  const cdp = s.env.browser.browserType().name() === "chromium" ? await guest.context.newCDPSession(guest.page) : null;
  await cdp?.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await guest.page.reload();
  const didAsk = await Promise.race([requested.then(() => true), sleep(10_000).then(() => false)]);
  check(didAsk, "the reloaded page did not ask for the engine");
  await guest.page.getByText("match in progress", { exact: true }).waitFor();
  // the resumed snapshot follows the room on the same socket: let it land while the engine still waits
  await sleep(500);
  check((await guest.page.locator(".hud-leave").count()) === 0, "the match opened before the engine loaded");
  release();
  await cdp?.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  await guest.page.locator(".hud-leave").waitFor({ state: "visible", timeout: 20_000 });
  await waitForPixels(guest, "guest canvas after reload");
  await host.page.locator(".hud-leave").waitFor({ state: "visible" });
  // the reload resumed the held seat rather than joining as a second player
  await sleep(1500);
  const after = await connectedSeat(s.base, code, guestName);
  check(after.id === before.id, `the guest came back as player ${after.id}, was ${before.id}`);
  return `guest resumed seat ${before.id} while the engine loaded, then entered the match`;
}

async function quickPlay(s) {
  const host = await s.open("qhost", { name: uniqueName("qh") });
  const roomName = uniqueName("qroom");
  const code = await createRoom(host, s.base, roomName, { isPublic: true });
  const fresh = await s.open("fresh", { name: uniqueName("qf") });
  await fresh.page.goto(s.base);
  await menuName(fresh.page).fill(uniqueName("qf"));
  await button(fresh.page, "Quick play").click();
  await fresh.page.getByRole("heading", { name: "Quick play", exact: true }).waitFor();
  // the original's cards: players online and a rotation carousel that steps through the maps
  const card = fresh.page.locator(".quick-card", { hasText: "Sweaty Bois" });
  await card.getByText(/\d+ playing/).waitFor();
  const mid = card.locator(".quick-thumb-mid");
  const first = await mid.getAttribute("title");
  await card.getByRole("button", { name: "Next Sweaty Bois map" }).click();
  check((await mid.getAttribute("title")) !== first, "the carousel did not move");
  await card.locator(".quick-choose").click();
  // quick-play rooms start by themselves: the match HUD comes up without a host
  await fresh.page.locator(".hud-leave").waitFor({ state: "visible", timeout: 20_000 });
  await waitForPixels(fresh, "quick-play canvas");
  check(!fresh.page.url().endsWith(`/${code}`), "quick play joined the custom room");
  // alone in the room: the original's matchmaking notice
  await fresh.page.getByText("Waiting for other players to join this arena...").waitFor();
  return "mode card (count, carousel) opened a self-starting quick-play match with the matching notice";
}

/** Experience: a finished match shows the post-game panel and levels appear in the roster. */
async function levels(s) {
  const user = await signedIn(s, "lvl");
  const { page } = user;
  const roomName = uniqueName("lv");
  const code = await createRoom(user, s.base, roomName, { isPublic: false });
  const guestName = uniqueName("lg");
  const guest = await s.open("lv-guest", { name: guestName });
  await joinByInvite(guest, s.base, code, roomName);
  await playerRow(page, guestName).first().waitFor();
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
  await panel.getByText(/\+\d+ xp/).waitFor();
  const guestPanel = guest.page.getByRole("dialog", { name: "Game over" });
  await guestPanel.waitFor({ timeout: 20_000 });
  await page.keyboard.press("Escape");
  await panel.waitFor({ state: "detached" });
  await page.locator("span.room-level").filter({ hasText: /^Lv \d+$/ }).first().waitFor();
  return "post-game panel for the account and the guest, level in the roster";
}

/** Lobby signals: emoji shortcodes, typing indicator, start countdown with abort. */
async function lobbySignals(s) {
  const hostName = uniqueName("sh");
  const guestName = uniqueName("sg");
  const roomName = uniqueName("sig");
  const host = await s.open("sig-host", { name: hostName });
  const code = await createRoom(host, s.base, roomName, { isPublic: false });
  const guest = await s.open("sig-guest", { name: guestName });
  await joinByInvite(guest, s.base, code, roomName);
  await host.page.locator("div.room-chat-log").getByText(`${guestName} has joined the game`).waitFor();
  const chat = guest.page.getByLabel("Chat message", { exact: true });
  await chat.pressSequentially("gg :fire:", { delay: 30 });
  await host.page.locator(".room-typing", { hasText: `${guestName} is` }).waitFor();
  await chat.press("Enter");
  await host.page.locator("div.room-chat-log").getByText("gg 🔥").waitFor();
  await button(host.page, "Start").click();
  await button(host.page, "Abort start").click();
  await button(host.page, "Start").waitFor();
  check(!(await host.page.locator(".hud-leave").isVisible()), "aborted countdown still started the match");
  return "join line, typing indicator, emoji, start abort";
}

/** Training hall: lessons name the bound keys; Leave returns to the menu. */
async function training(s) {
  const h = await s.open("training", { name: uniqueName("tr") });
  const { page } = h;
  await page.goto(s.base);
  await menuName(page).waitFor();
  await navTo(page, "Training");
  await page.locator(".training-text").waitFor();
  await waitForPixels(h, "training canvas");
  const first = await page.locator(".training-text").textContent();
  await button(page, "Next").click();
  const second = await page.locator(".training-text").textContent();
  check(first !== second, "Next did not change the lesson");
  await button(page, "Replay tutorial").click();
  const again = await page.locator(".training-text").textContent();
  check(again === first, `Replay tutorial did not return to the first lesson: ${again}`);
  await button(page, "Leave").click();
  await menuName(page).waitFor();
  return "lessons step, replay tutorial, canvas renders, leave";
}

/** In-match menu (the original's): the lobby and the controls while the match runs, then back to the game. */
async function matchMenu(s) {
  const { host } = await matchWithGuest(s, { clipboard: false });
  const { page } = host;
  await waitForPixels(host, "host canvas");

  await button(page, "Menu").click();
  await button(page, "Show lobby").click();
  await button(page, "Back to game").click();
  await page.locator(".hud-root").waitFor();

  await button(page, "Menu").click();
  await button(page, "Change controls").click();
  await page.getByRole("heading", { name: "Settings", exact: true }).waitFor();
  await button(page, "Back").click();
  await page.locator(".hud-root").waitFor();
  await waitForPixels(host, "host canvas after the menu");

  // Escape opens and closes the menu while the chat is closed
  await page.keyboard.press("Escape");
  await page.locator("#hud-menu").waitFor();
  await page.keyboard.press("Escape");
  await page.locator("#hud-menu").waitFor({ state: "hidden" });
  return "lobby and controls during a match, back to the running game";
}

/** Update news: opens, pages, closes; the menu shows players online. */
async function news(s) {
  const h = await s.open("news", { name: uniqueName("nw") });
  const { page } = h;
  await page.goto(s.base);
  await menuName(page).waitFor();
  await page.getByText(/\d+ players? online/).waitFor();
  await page.getByRole("button", { name: /News/ }).click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor();
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
  return "players online, news dialog";
}

/** /record in a match saves a clip that plays behind the main menu. */
async function clips(s) {
  const m = await matchWithGuest(s, { clipboard: false });
  const { host } = m;
  await waitForPixels(host, "match canvas");
  await sleep(7000);
  await host.page.keyboard.press("Enter");
  await host.page.keyboard.type("/record");
  await host.page.keyboard.press("Enter");
  await host.page.getByText("Clip saved", { exact: false }).first().waitFor({ timeout: 15_000 });
  const viewer = await s.open("clip-viewer", { name: uniqueName("cv") });
  await viewer.page.goto(s.base);
  await menuName(viewer.page).waitFor();
  await viewer.page.locator(".menu-clip-credit").filter({ hasText: /recorded by/ }).waitFor({ timeout: 20_000 });
  await waitForPixels(viewer, "menu clip canvas");
  return "clip recorded and played behind the menu";
}

/** Jukebox: a pasted YouTube link becomes a suggestion; the host plays it for the room. */
async function jukebox(s) {
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
  return "suggestion line, host play, jukebox on both pages";
}

/** Every sound and music file the page requests exists, and a UI click fetches a sound effect. */
async function sounds(s) {
  const h = await s.open("desktop");
  const { page } = h;
  const fetched = [];
  const missing = [];
  page.on("response", (res) => {
    const { pathname } = new URL(res.url());
    if (!/^\/(sfx|music)\//.test(pathname)) return;
    if (res.status() >= 400) missing.push(`${res.status()} ${pathname}`);
    else if (pathname.startsWith("/sfx/")) fetched.push(pathname);
  });
  await page.goto(s.base);
  await menuName(page).waitFor();
  await navTo(page, "Settings");
  await back(page).click();
  await menuName(page).waitFor();
  await sleep(300);
  check(missing.length === 0, `sound or music files missing: ${missing.join(", ")}`);
  // Without Web Audio the page creates no audio context, so it never requests a sound effect.
  if (!s.env.browser.webAudio) {
    check(fetched.length === 0, `${fetched.length} sound effects fetched with no Web Audio in this engine`);
    return "no Web Audio in this engine: no sound effects requested";
  }
  check(fetched.length > 0, "a click fetched no sound effect");
  return `${fetched.length} sound effects fetched, none missing`;
}

async function replay(s) {
  const m = await matchWithGuest(s, { clipboard: false });
  const { host } = m;
  await waitForPixels(host, "match canvas");
    await host.page.locator(".hud-end").click();
    // a closed dialog stays in the DOM while it animates out, so only an open one counts
    const endDialog = host.page.getByRole("alertdialog", { name: "End the match?", exact: true }).and(host.page.locator("dialog[open]"));
    await endDialog.waitFor();
    // Escape cancels: the match goes on, and the HUD stays live behind the dialog.
    await host.page.keyboard.press("Escape");
    await endDialog.waitFor({ state: "hidden" });
    await host.page.locator(".hud-end").waitFor();
    await host.page.locator(".hud-end").click();
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
  await host.page.locator("input[type=file]").first().setInputFiles(file);
  await host.page.locator(".offline.playing").waitFor();
  await waitForPixels(host, "replay canvas");
  await button(host.page, "Play").click();
  await button(host.page, "Pause").waitFor();
  await button(host.page, "Pause").click();
  const seek = host.page.getByLabel("Seek", { exact: true });
  await seek.fill(String(await seek.getAttribute("min")));
  await waitQuiet(host.page, 500, 8000).catch(() => {});
  return "saved, reopened, rendered, play/pause/seek";
}

async function practice(s) {
  const h = await s.open("desktop");
  const { page } = h;
  await page.goto(s.base);
  await menuName(page).waitFor();
  await navTo(page, "Practice");
  // a built-in map from the list (it loads after the presets render)
  await page.locator(".offline-list .offline-choice").first().click();
  await button(page, "Start").click();
  await page.locator(".offline.playing").waitFor();
  await waitForPixels(h, "practice canvas");
  await button(page, "Leave").click();
  await button(page, "Start").waitFor();
  await back(page).click();
  await menuName(page).waitFor();
  return "built-in map renders, Leave returns to setup";
}

async function phone(s) {
  const h = await s.open("phone", { phone: true, name: uniqueName("ph") });
  const { page } = h;
  await page.goto(s.base);
  await dismissPhoneSplash(page);
  await menuName(page).waitFor();
  await expectNoOverflow(page, "menu");
  await navTo(page, "Practice");
  await expectNoOverflow(page, "practice setup");
  await page.locator(".offline-list .offline-choice").first().click();
  await button(page, "Start").click();
  await page.locator(".offline.playing").waitFor();
  // The phone is portrait here: the turn-sideways gate shows; play on anyway.
  const anyway = page.getByRole("button", { name: "Play in portrait anyway", exact: true });
  if (await anyway.isVisible()) await anyway.click();
  check(await page.locator(".hud-touch-layer").isVisible(), "touch controls are not visible on the phone");
  await waitForPixels(h, "phone practice canvas");
  await button(page, "Leave").click();
  await button(page, "Start").waitFor();
  await back(page).click();
  const host = await s.open("phone-host", { name: uniqueName("pho") });
  await createRoom(host, s.base, uniqueName("pr"), { isPublic: true });
  const code = await roomCode(host.page);
  await page.goto(`${s.base}/${code}`);
  await dismissPhoneSplash(page);
  await page.locator("h1.room-title").waitFor();
  await expectNoOverflow(page, "room");
  return "menu, practice touch layer, room: no overflow";
}

/**
 * Sends touch points as `{ type, points }` with `touchStart` / `touchMove` / `touchEnd`. Chromium
 * gets real touch events over CDP. Firefox and WebKit have no CDP, so the same pointer handlers
 * (the HUD listens to pointer events, not touch-specific ones) get a mouse press instead.
 */
async function touchDriver(page, browser) {
  if (browser.browserType().name() === "chromium") {
    const cdp = await page.context().newCDPSession(page);
    return (type, points) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points });
  }
  return async (type, points) => {
    if (type === "touchStart") {
      await page.mouse.move(points[0].x, points[0].y);
      await page.mouse.down();
    } else if (type === "touchMove") {
      await page.mouse.move(points[0].x, points[0].y);
    } else {
      await page.mouse.up();
    }
  };
}

/** A landscape phone joins a match and drives the touch stick and Jump with real touch events. */
async function phoneLandscapeTouch(s) {
  const roomName = uniqueName("touch room");
  const host = await s.open("host", { name: uniqueName("host") });
  const code = await createRoom(host, s.base, roomName, { isPublic: true });
  // Opened at landscape size: resizing a live WebGL page hangs headless Firefox's viewport.
  const guest = await s.open("guest", { phone: true, viewport: { width: 844, height: 390 }, name: uniqueName("touch") });
  const { page } = guest;
  await joinByInvite(guest, s.base, code, roomName);
  await dismissPhoneSplash(page);
  await roomTitle(page, roomName).waitFor();
  await startMatch(host, [guest]);
  await page.locator(".hud-touch-layer").waitFor({ state: "visible" });
  await waitForPixels(guest, "landscape canvas");
  // Frames freeze during the start countdown; wait it out before touching the controls.
  await sleep(4000);
  await ensureProbe(page);
  const send = await touchDriver(page, s.env.browser);
  const centre = async (selector) => {
    const box = await page.locator(selector).boundingBox();
    check(box && box.width > 0, `${selector} has no size`);
    return { x: box.x + box.width / 2, y: box.y + box.height / 2, r: box.width / 2, box };
  };

  const geom = (c) => `${Math.round(c.box.x)},${Math.round(c.box.y)} ${Math.round(c.box.width)}x${Math.round(c.box.height)}`;
  // Live size, not the emulated one: entering fullscreen (the landscape splash) makes headless Firefox use the screen size.
  const vp = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const stick = await centre(".hud-stick");
  const actions = await centre(".hud-actions");
  check(stick.box.x + stick.box.width <= actions.box.x, "touch stick and action buttons overlap");
  check(
    stick.box.y + stick.box.height <= vp.height && actions.box.y + actions.box.height <= vp.height,
    `touch controls run off the landscape screen (viewport ${vp.width}x${vp.height}, stick ${geom(stick)}, actions ${geom(actions)})`,
  );

  // Thumb on the stick, slid right: the player moves, so the canvas keeps changing.
  const beforeStick = await probeChanges(page);
  await send("touchStart", [{ x: stick.x, y: stick.y }]);
  await send("touchMove", [{ x: stick.x + stick.r * 0.8, y: stick.y }]);
  await sleep(1000);
  await send("touchEnd", []);
  const moved = (await probeChanges(page)) - beforeStick;
  check(moved > 5, `guest frames barely changed while holding the touch stick right (${moved} changes)`);

  // Jump is a touch button of its own: holding it makes the player leap.
  const jump = await centre('.hud-touch[data-action="up"]');
  const beforeJump = await probeChanges(page);
  await send("touchStart", [{ x: jump.x, y: jump.y }]);
  await sleep(1000);
  await send("touchEnd", []);
  const jumped = (await probeChanges(page)) - beforeJump;
  check(jumped > 5, `guest frames barely changed while holding Jump (${jumped} changes)`);
  return `stick right: ${moved} frame changes; Jump: ${jumped} frame changes`;
}

async function latency(s) {
  const h = await s.open("latency", { name: uniqueName("lat") });
  const { page } = h;
  await createRoom(h, s.base, uniqueName("lt"), { isPublic: false });
  await ensureRoomMap(page);
  await button(page, "Start").click();
  await page.locator(".hud-leave").waitFor({ state: "visible" });
  await waitForPixels(h, "match canvas");
  await ensureProbe(page);
  // Frames freeze during the start countdown; wait it out before measuring.
  await sleep(4000);
  const ms = await measureFirstChange(page, 1500);
  check(ms !== null, "no frame changed after ArrowRight keydown");
  check(ms <= 250, `input latency ${ms.toFixed(0)} ms exceeds 250 ms`);
  return `keydown to first moved frame: ${ms.toFixed(0)} ms`;
}

async function editor(s) {
  const user = await signedIn(s, "mapper");
  const { page } = user;
  await navTo(page, "Map editor");
  const canvas = page.locator("canvas.editor-canvas");
  await canvas.waitFor({ state: "visible" });
  // The screen transition moves the canvas for a few frames: measure once its rect stops changing.
  let box = await canvas.boundingBox();
  for (let settled = 0; settled < 3; ) {
    await sleep(100);
    const next = await canvas.boundingBox();
    settled = next && box && next.x === box.x && next.y === box.y && next.width === box.width && next.height === box.height ? settled + 1 : 0;
    box = next;
  }
  check(box && box.width > 100 && box.height > 100, "editor canvas has no size");
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await button(page, "Box").click();
  await page.mouse.move(cx - 80, cy - 50);
  await page.mouse.down();
  await page.mouse.move(cx, cy, { steps: 8 });
  await page.mouse.move(cx + 80, cy + 50, { steps: 8 });
  await page.mouse.up();
  check(await button(page, "Undo").isEnabled(), "box drawn does not enable Undo");
  await button(page, "Select").click();
  await page.mouse.click(cx, cy);
  check(await button(page, "Delete").first().isEnabled(), "selecting does not enable Delete");
  await button(page, "Delete").first().click();
  await button(page, "Undo").click();
  check(await button(page, "Redo").isEnabled(), "redo not enabled after undo");
  await button(page, "Redo").click();
  check(await button(page, "Undo").isEnabled(), "undo not enabled after redo");

  // Inside a body (the original's double-click): a circle drawn there joins the box's body.
  // (the redo above deleted the first box again: draw a fresh one)
  await button(page, "Box").click();
  await page.mouse.move(cx - 80, cy - 50);
  await page.mouse.down();
  await page.mouse.move(cx + 80, cy + 50, { steps: 8 });
  await page.mouse.up();
  await button(page, "Select").click();
  await page.mouse.dblclick(cx, cy);
  await page.locator(".editor-scope").waitFor({ state: "visible" });
  await button(page, "Circle").click();
  await page.mouse.move(cx + 20, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 40, cy, { steps: 6 });
  await page.mouse.up();
  await page.waitForFunction(
    () => (JSON.parse(localStorage.getItem("neobox.editor.draft") ?? "{}").b ?? []).some((b) => (b.s ?? []).length === 2),
  );
  await page.keyboard.press("Escape");
  await page.locator(".editor-scope").waitFor({ state: "hidden" });

  // Drag-free routes (WCAG 2.5.7): two taps make a box, Enter drops one at the view centre, Shift+arrow moves the selection.
  const draftBodies = () => page.evaluate(() => JSON.parse(localStorage.getItem("neobox.editor.draft") ?? "{}").b ?? []);
  const bodyCount = async () => (await draftBodies()).length;
  const bodiesBefore = await bodyCount();
  await button(page, "Box").click();
  await page.mouse.click(cx - box.width * 0.3, cy - box.height * 0.3);
  await page.waitForFunction(() => document.querySelector(".editor-hint")?.textContent.includes("opposite corner"));
  await page.mouse.click(cx - box.width * 0.1, cy - box.height * 0.1);
  await page.waitForFunction((n) => (JSON.parse(localStorage.getItem("neobox.editor.draft") ?? "{}").b ?? []).length === n + 1, bodiesBefore);
  await page.keyboard.press("Enter");
  await page.waitForFunction((n) => (JSON.parse(localStorage.getItem("neobox.editor.draft") ?? "{}").b ?? []).length === n + 2, bodiesBefore);
  const x0 = (await draftBodies()).at(-1)["2"];
  await page.keyboard.press("Shift+ArrowRight");
  await page.waitForFunction(
    (x) => {
      const v = (JSON.parse(localStorage.getItem("neobox.editor.draft") ?? "{}").b ?? []).at(-1)?.["2"];
      return typeof v === "number" && Math.abs(v - (x + 10)) < 1e-3;
    },
    x0,
  );

  // Built-in maps from the menu (the map has content now: confirm replacing it).
  await button(page, "Menu").click();
  await page.locator(".editor-menu").waitFor({ state: "visible" });
  await page.locator(".editor-list .editor-item").first().click();
  const replaceDialog = page.getByRole("alertdialog", { name: "Replace the current map?", exact: true });
  await replaceDialog.getByRole("button", { name: "Replace map", exact: true }).click();
  await page.locator(".editor-menu").waitFor({ state: "hidden" });

  // Share code, then test play.
  await button(page, "Menu").click();
  const code = await page.locator("textarea.editor-code").inputValue();
  check(code.length > 0, "share code is empty");
  await button(page, "Close").click();
  await button(page, "Test play").click();
  await page.locator(".offline.playing .offline-title").waitFor();
  await waitForPixels(user, "editor test play canvas");
  await button(page, "Edit").click();
  await canvas.waitFor({ state: "visible" });

  // The shared code loads in Practice...
  await button(page, "Back").click();
  await menuName(page).waitFor();
  await navTo(page, "Practice");
  await page.getByLabel("Map code", { exact: true }).fill(code);
  await button(page, "Use code").click();
  await button(page, "Start").click();
  await page.locator(".offline.playing").waitFor();
  await waitForPixels(user, "practice canvas with editor map");
  await button(page, "Leave").click();
  await back(page).click();
  await menuName(page).waitFor();

  // ...and as a room map.
  await createRoom(user, s.base, uniqueName("edroom"), { isPublic: false });
  await button(page, "Change map").click();
  await page.getByLabel("Map code or JSON", { exact: true }).fill(code);
  await button(page, "Use code").click();
  await page.locator(".room-map-name").filter({ hasText: /\S/ }).waitFor();
  await button(page, "Leave").click();
  await button(page, "Back").click();
  await menuName(page).waitFor();

  // Save to library (signed in).
  await navTo(page, "Map editor");
  await canvas.waitFor({ state: "visible" });
  const name = uniqueName("edsave");
  await button(page, "Menu").click();
  await page.getByRole("button", { name: "Save to library", exact: true }).click();
  await page.getByRole("dialog").getByLabel("Map name", { exact: true }).fill(name);
  await page.getByRole("dialog").getByRole("button", { name: "Upload", exact: true }).click();
  await page.getByText("Saved to your library").waitFor();
  return `drew/undo/delete, built-in, test play, share code in Practice and room (${name})`;
}

async function editorPhone(s) {
  const h = await s.open("editor-phone", { phone: true });
  const { page } = h;
  await page.goto(s.base);
  await dismissPhoneSplash(page);
  await menuName(page).waitFor();
  await navTo(page, "Map editor");
  const canvas = page.locator("canvas.editor-canvas");
  await canvas.waitFor({ state: "visible" });
  await expectNoOverflow(page, "editor");
  await button(page, "Test play").click();
  await page.locator(".offline.playing").waitFor();
  await button(page, "Edit").click();
  await canvas.waitFor({ state: "visible" });
  return "editor and test play fit the phone";
}

/** Back asks before leaving unsaved map edits, and page unload warns only then. */
async function editorLeave(s) {
  const h = await s.open("editor-leave");
  const { page } = h;
  await page.goto(s.base);
  await menuName(page).waitFor();
  await navTo(page, "Map editor");
  const canvas = page.locator("canvas.editor-canvas");
  await canvas.waitFor({ state: "visible" });
  await waitStable(canvas);
  // No edits: Back leaves at once.
  await back(page).click();
  await menuName(page).waitFor();
  await navTo(page, "Map editor");
  await canvas.waitFor({ state: "visible" });
  const box = await waitStable(canvas);
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await button(page, "Box").click();
  await page.mouse.move(cx - 80, cy - 50);
  await page.mouse.down();
  await page.mouse.move(cx + 80, cy + 50, { steps: 8 });
  await page.mouse.up();
  check(await button(page, "Undo").isEnabled(), "box drawn does not enable Undo");
  // Page unload with unsaved edits asks the browser to confirm; the harness dismisses it, which keeps the page.
  h.allowedDialogs.add("beforeunload");
  const unload = page.waitForEvent("dialog", { timeout: 10000 }).then((d) => d.type());
  void page.reload().catch(() => {});
  check((await unload) === "beforeunload", "reload with unsaved edits did not ask before unloading");
  h.allowedDialogs.delete("beforeunload");
  await canvas.waitFor({ state: "visible" });
  // In-app Back asks too: Cancel keeps the editor open, Leave goes back.
  const dialog = page.getByRole("alertdialog", { name: "Leave without saving?", exact: true });
  await back(page).click();
  await dialog.waitFor();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  await canvas.waitFor({ state: "visible" });
  await back(page).click();
  await dialog.waitFor();
  await dialog.getByRole("button", { name: "Leave", exact: true }).click();
  await menuName(page).waitFor();
  // The confirmed Leave removed the editor's unload guard: a reload from the menu does not ask.
  await page.reload();
  await menuName(page).waitFor();
  return "Back and unload ask only with unsaved edits; Cancel keeps the editor; Leave drops the guard";
}

/** A guest name typed on the menu is kept for the next visit before any play action. */
async function quickPlayName(s) {
  const h = await s.open("quick-name");
  const { page } = h;
  await page.goto(s.base);
  await menuName(page).waitFor();
  await menuName(page).fill("QuickKept7");
  await page.reload();
  await menuName(page).waitFor();
  const after = await menuName(page).inputValue();
  check(after === "QuickKept7", `name after reload is "${after}", not the typed name`);
  return "typed name kept across reload without a play action";
}

/** The room-list row of `roomName` on the room list (`ul[aria-label="rooms"]`). */
const roomRow = (page, roomName) =>
  page.locator('ul[aria-label="rooms"] li.room-item').filter({ hasText: roomName }).locator("button.room-row");

/** Opens the room list from the menu (Play) and returns the row of `roomName`. */
async function openRoomList(h, base, roomName) {
  await h.page.goto(base);
  await menuName(h.page).waitFor();
  await playFromMenu(h.page, null);
  await h.page.locator('ul[aria-label="rooms"]').waitFor();
  const row = roomRow(h.page, roomName);
  await row.waitFor();
  return row;
}

/** A room row's distance: the number and its unit ("km" or "mi"); "—" when unknown. */
async function rowDistance(row) {
  const text = ((await row.locator("span.room-distance").textContent()) ?? "").trim();
  const m = /^(\d+) (km|mi)$/.exec(text);
  return { text, value: m ? Number(m[1]) : null, unit: m ? m[2] : null };
}

const rowRegion = async (row) => ((await row.locator("span.room-region").textContent()) ?? "").trim();

/** Geo: the room list shows the host's flag and the distance from the viewer to the room's server, in the viewer's unit. */
async function geoRoomList(s) {
  const roomName = uniqueName("geo");
  const host = await s.open("london", { name: uniqueName("lon"), ip: ipIn("192.0.2") });
  await createRoom(host, s.base, roomName, { isPublic: true });

  const ny = await s.open("newyork", { name: uniqueName("nyv"), ip: ipIn("203.0.113") });
  const nyRow = await openRoomList(ny, s.base, roomName);
  const flag = nyRow.locator("img.room-flag");
  const src = (await flag.getAttribute("src")) ?? "";
  check(src.endsWith("flags/gb.svg"), `the London host's row shows flag "${src}", expected GB`);
  const alt = await flag.getAttribute("alt");
  check(alt === "United Kingdom", `flag alt is "${alt}", expected "United Kingdom"`);
  const nyDist = await rowDistance(nyRow);
  check(
    nyDist.unit === "mi" && nyDist.value >= 3000 && nyDist.value <= 4500,
    `New York viewer sees "${nyDist.text}", expected about 3860 mi`,
  );

  const fra = await s.open("frankfurt", { name: uniqueName("fra"), ip: ipIn("198.51.100") });
  const fraDist = await rowDistance(await openRoomList(fra, s.base, roomName));
  check(fraDist.unit === "km" && fraDist.value <= 50, `Frankfurt viewer sees "${fraDist.text}", expected 0-50 km`);

  const unknown = await s.open("unknown", { name: uniqueName("unk") });
  const unkDist = await rowDistance(await openRoomList(unknown, s.base, roomName));
  check(unkDist.text === "—", `viewer of unknown location sees "${unkDist.text}", expected "—"`);
  return `GB flag; New York ${nyDist.text}; Frankfurt ${fraDist.text}; unknown "${unkDist.text}"`;
}

/** Regions: a room opened on the New York node is listed on the Frankfurt main server and joins from there. */
async function regionRooms(s) {
  const roomName = uniqueName("nyc");
  const guestName = uniqueName("frg");
  const host = await s.open("nyhost", { name: uniqueName("nyh"), ip: ipIn("203.0.113") });
  const code = await createRoom(host, s.base, roomName, { isPublic: true });
  check((await adminRoom(s.base, code)).region === "New York", "the room is not on the New York node"); // main's admin lists every node's rooms

  const guest = await s.open("frguest", { name: guestName, ip: ipIn("198.51.100") });
  const row = await openRoomList(guest, s.base, roomName);
  const region = await rowRegion(row);
  check(region === "New York", `room region is "${region}", expected "New York"`);
  const dist = await rowDistance(row);
  check(
    dist.unit === "km" && dist.value >= 5500 && dist.value <= 7000,
    `Frankfurt viewer sees "${dist.text}" to New York, expected about 6200 km`,
  );
  await row.click();
  await roomTitle(guest.page, roomName).waitFor();
  await playerRow(host.page, guestName).waitFor();
  await startMatch(host, [guest]);
  await waitForPixels(host, "host canvas");
  await waitForPixels(guest, "guest canvas");

  await guest.page.locator(".hud-leave").click();
  await guest.page.locator('ul[aria-label="rooms"]').waitFor();
  await button(guest.page, "Refresh").click();
  const after = roomRow(guest.page, roomName);
  await after.waitFor();
  check((await rowRegion(after)) === "New York", "the main list no longer shows the New York region after the guest left");
  return `hosted on New York, joined from the Frankfurt list at ${dist.text}; guest back on the main list`;
}

/** Regions with an account: a signed-in New Yorker's room lands on the node and the roster shows their level. */
async function regionAccount(s) {
  const name = uniqueName("nyacc");
  const acct = await signedIn(s, "nyacct", name, { ip: ipIn("203.0.113") });
  const code = await createRoom(acct, s.base, uniqueName("acct"), { isPublic: true });
  check((await adminRoom(s.base, code)).region === "New York", "the room is not on the New York node");
  const level = acct.page.locator("li.room-player").filter({ hasText: name }).locator("span.room-level");
  await level.waitFor();
  const text = ((await level.textContent()) ?? "").trim();
  check(text === "Lv 1", `roster shows "${text}" for the signed-in player, expected "Lv 1"`);
  return "room on the New York node; roster shows Lv 1";
}

/** An invite link opened by a signed-in player with no saved guest name joins the room once the account loads. */
async function inviteSignedIn(s) {
  const host = await s.open("ihost", { name: uniqueName("ih") });
  const roomName = uniqueName("inv");
  const code = await createRoom(host, s.base, roomName, { isPublic: false });
  const name = uniqueName("iacc");
  const acct = await s.open("iacct");
  await signUp(acct, s.base, name);
  await joinByInvite(acct, s.base, code, roomName);
  await playerRow(host.page, name).waitFor();
  return "a signed-in player without a saved guest name joined from the invite link";
}

/** Waits until both players of room `code` have their game data on `transport` (`udp`: the data channel). */
async function waitForTransports(s, code, transport) {
  const end = Date.now() + 15_000;
  let transports = [];
  for (;;) {
    transports = (await adminRoom(s.base, code)).players.map((p) => p.transport);
    if (transports.length === 2 && transports.every((t) => t === transport)) return;
    if (Date.now() > end) throw new Error(`transports stayed ${JSON.stringify(transports)}, expected ${transport} for both`);
    await sleep(250);
  }
}

const waitForUdp = (s, code) => waitForTransports(s, code, "udp");

/** WebRTC: with UDP offered, both players' game data moves to the data channel and the match runs. Engines without RTCPeerConnection stay on the WebSocket. */
async function rtcMatch(s) {
  const m = await matchWithGuest(s, { clipboard: false });
  const transport = s.env.browser.webrtc ? "udp" : "ws";
  if (transport === "udp") await waitForUdp(s, m.code);
  else await waitForTransports(s, m.code, "ws");
  await waitForPixels(m.guest, "guest canvas");
  // the start countdown freezes frames; then holding Right moves the guest
  await sleep(4000);
  const before = await probeChanges(m.guest.page);
  await m.guest.page.keyboard.down("ArrowRight");
  await sleep(1000);
  await m.guest.page.keyboard.up("ArrowRight");
  const moved = (await probeChanges(m.guest.page)) - before;
  check(moved > 5, `guest frames barely changed over ${transport} (${moved} changes)`);
  return `both players on ${transport}${transport === "ws" ? " (no RTCPeerConnection in this engine)" : ""}; ${moved} frame changes while holding Right`;
}

/**
 * A guest page stalls for seconds (no animation frames, no acks): over UDP the
 * server resends a snapshot, the restored match must show the same map as before.
 */
async function resyncKeepsMap(s) {
  const m = await matchWithGuest(s, { clipboard: false });
  const { host, guest, code } = m;
  await waitForUdp(s, code);
  await waitForPixels(host, "host canvas");
  await waitForPixels(guest, "guest canvas");
  await sleep(4000); // the start countdown freezes frames
  await waitQuiet(guest.page, 800);
  const before = await guest.page.evaluate(() => window.__e2eProbe.hash);
  const resyncs = () => (s.env.output?.() ?? "").split("\n").filter((l) => l.includes("too far behind") && l.includes(`room=${code}`)).length;
  const start = resyncs();
  for (let round = 1; round <= 2; round++) {
    await guest.page.evaluate(() => {
      const end = performance.now() + 4000;
      while (performance.now() < end) {
        // busy: the page processes no frames and sends no acks
      }
    });
    await sleep(4000);
    await waitQuiet(guest.page, 800);
    const after = await guest.page.evaluate(() => window.__e2eProbe.hash);
    check(after === before, `the map changed after snapshot resync ${round}`);
  }
  const sent = resyncs() - start;
  check(sent >= 2, `the server resent a snapshot ${sent} time(s) to the stalled guest, expected 2`);
  await sleep(3000);
  const more = resyncs() - start - sent;
  check(more === 0, `the guest kept falling behind after it recovered (${more} more snapshots)`);
  return `${sent} snapshot resyncs; map unchanged; no resyncs after recovery`;
}

/** The training hall opens while the engine's wasm is still downloading: it waits for the engine, then shows the lesson. */
async function trainingSlowEngine(s) {
  const h = await s.open("training slow", { name: uniqueName("tr") });
  const { page } = h;
  let release = () => {};
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await page.route("**/neobox.wasm*", async (route) => {
    await gate;
    await route.continue();
  });
  await page.goto(s.base);
  await menuName(page).waitFor();
  await navTo(page, "Training");
  await page.getByText("Loading the training hall…", { exact: true }).waitFor();
  release();
  await page.locator(".training-text").waitFor();
  check((await page.getByText("could not load", { exact: false }).count()) === 0, "the hall reported a load failure");
  await button(page, "Leave").click();
  await menuName(page).waitFor();
  return "training opened before the engine; lesson shown once it loaded";
}

/** A room's Choose a map -> Library -> pick: Back then leaves the room, not a dead modal entry. */
async function libraryPickBack(s) {
  const user = await signedIn(s, "picker");
  const maps = await builtinMaps(s.base);
  const name = uniqueName("pb");
  const { page } = user;
  await navTo(page, "Library");
  await page.getByRole("tab", { name: "Mine", exact: true }).or(button(page, "Mine")).first().click();
  await page.getByRole("button", { name: "Upload a map", exact: true }).click();
  await page.getByPlaceholder("Map name", { exact: true }).fill(name);
  await page.getByLabel("map code", { exact: true }).fill(maps[0].code);
  await page.getByRole("button", { name: "Upload map", exact: true }).click();
  await page.locator("ul[aria-label=maps] li").filter({ hasText: name }).waitFor();
  await back(page).click();
  const roomName = uniqueName("pickback");
  await createRoom(user, s.base, roomName, { isPublic: true });
  await button(page, "Change map").click();
  await button(page, "Library").click();
  const picker = page.getByRole("dialog", { name: "Pick a map" });
  await picker.waitFor();
  await picker.getByRole("tab", { name: "Mine", exact: true }).or(picker.getByRole("button", { name: "Mine", exact: true })).first().click();
  await picker.locator(".map-card").filter({ hasText: name }).first().click();
  await page.locator(".room-map-name").filter({ hasText: name }).waitFor();
  await page.goBack();
  await roomTitle(page, roomName).waitFor({ state: "detached" });
  return `picked ${name} from Library in the room; Back left the room`;
}

/** No WebGPU or WebGL 2: the first game screen gets the dialog, a later one gets a toast instead of a silent empty arena. */
async function rendererGone(s) {
  const h = await s.open("no graphics", { name: uniqueName("ng") });
  const { page } = h;
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "gpu", { value: undefined, configurable: true });
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
      return /webgl|webgpu/.test(String(type)) ? null : getContext.call(this, type, ...rest);
    };
  });
  await page.goto(s.base);
  await menuName(page).waitFor();
  // the renderer is tried at boot: the dialog covers the menu before any game screen is entered
  const dialog = page.getByRole("dialog", { name: "This browser cannot draw the game", exact: true });
  await dialog.waitFor();
  await dialog.getByRole("button", { name: "Back", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  await navTo(page, "Practice");
  await button(page, "Start").click();
  await page.getByText("WebGPU and WebGL 2 are unavailable", { exact: false }).waitFor();
  await button(page, "Leave").click();
  await back(page).click();
  await menuName(page).waitFor();
  return "graphics dialog once; practice entered again says so";
}

export const scenarios = [
  { name: "training slow engine", run: trainingSlowEngine },
  { name: "library pick back", run: libraryPickBack },
  { name: "renderer lost", run: rendererGone },
  { name: "menu", run: menu },
  { name: "settings", run: settings },
  { name: "accessibility prefs", run: accessibilityPrefs },
  { name: "accounts", run: accounts },
  { name: "friends", run: friends },
  { name: "library", run: library },
  { name: "room lobby", run: roomLobby },
  { name: "room match", run: roomMatch },
  { name: "match menu", run: matchMenu },
  { name: "reconnect", run: reconnect },
  { name: "reconnect slow engine", run: reconnectSlowEngine },
  { name: "quick play", run: quickPlay },
  { name: "quick play name", run: quickPlayName },
  { name: "levels", run: levels },
  { name: "jukebox", run: jukebox },
  { name: "lobby signals", run: lobbySignals },
  { name: "training", run: training },
  { name: "news", run: news },
  { name: "clips", run: clips },
  { name: "replay", run: replay },
  { name: "practice", run: practice },
  { name: "phone", run: phone },
  { name: "phone landscape touch", run: phoneLandscapeTouch },
  { name: "input latency", run: latency, serial: true },
  { name: "map editor", run: editor },
  { name: "map editor phone", run: editorPhone },
  { name: "map editor leave", run: editorLeave },
  { name: "geo room list", run: geoRoomList, topology: geoServer },
  { name: "regions", run: regionRooms, topology: regionServers },
  { name: "regions account", run: regionAccount, topology: regionServers },
  { name: "invite signed in", run: inviteSignedIn },
  { name: "webrtc match", run: rtcMatch, topology: rtcServer },
  { name: "resync keeps map", run: resyncKeepsMap, topology: rtcServer, webrtc: true },
  { name: "sounds", run: sounds },
  ...matchInvScenarios,
  ...roomsInvScenarios,
  ...livenessScenarios,
];
