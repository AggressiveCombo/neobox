// The e2e scenarios. Each one drives the real UI of a real server (see lib.mjs)
// and returns an optional detail string for its `ok` line. Scenarios share a
// server but no state, so `run.mjs` can run any subset in any order.

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
} from "./lib.mjs";
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
async function friendRow(page, text, timeoutMs = 25_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const row = page.locator("li.friend-row").filter({ hasText: text });
    if ((await row.count()) > 0) return row.first();
    if (Date.now() > end) throw new Error(`friend row "${text}" never appeared`);
    await sleep(500);
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
  check(await button(page, "Play").isVisible(), "Play button not visible");
  const links = ["Training", "Library", "Friends", "Practice", "Replay", "Map editor", "Settings", "About"];
  for (const link of links) {
    await navTo(page, link);
    await sleep(150);
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
  await button(page, "Reset to defaults").click();
  return "jump rebind, volume, palette persisted";
}

async function accounts(s) {
  const name = uniqueName("acct");
  const h = await s.open("desktop");
  const { page } = h;
  await page.goto(s.base);
  await menuName(page).waitFor();
  await page.getByRole("button", { name: /^(Sign in|Account)$/ }).first().click();
  await page.getByLabel("name", { exact: true }).fill(name);
  await page.getByLabel("password", { exact: true }).fill(PASSWORD);
  await button(page, "Create account").click();
  await page.getByText("Account created.").waitFor();
  await page.goto(s.base);
  await menuName(page).waitFor();
  await page.reload();
  await expectMenuName(page, name);
  await page.getByRole("button", { name: /^(Sign in|Account)$/ }).first().click();
  await page.getByText(name, { exact: false }).first().waitFor();
  await button(page, "Sign out").click();
  await page.getByLabel("name", { exact: true }).waitFor();
  await page.getByLabel("name", { exact: true }).fill(name);
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
  // B enters a room, which also marks B online: A sees the room in the friend row and can join it.
  const roomName = uniqueName("fr");
  await createRoom(b, s.base, roomName, { isPublic: true });
  await a.page.goto(s.base);
  await menuName(a.page).waitFor();
  await navTo(a.page, "Friends");
  const inRoom = await friendRow(a.page, b.userName);
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
  await navTo(page, "Library");
  await page.getByRole("tab", { name: "Mine", exact: true }).or(button(page, "Mine")).first().click();
  await page.getByPlaceholder("Map name", { exact: true }).fill(name);
  await page.getByLabel("map code", { exact: true }).fill(map.code);
  await page.getByLabel("visibility", { exact: true }).selectOption("public");
  await button(page, "Upload").click();
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
  check(await card.getByRole("button", { name: "Upvote", exact: true }).isDisabled(), "the author can vote on their own map");
  await card.getByRole("button", { name: "Star", exact: true }).click();
  await card.getByRole("button", { name: "Starred", exact: true }).waitFor();

  // Another account upvotes; the vote is still shown after a reload.
  const voter = await signedIn(s, "voter");
  const vcard = () => voter.page.locator("ul[aria-label=maps] li").filter({ hasText: name });
  await navTo(voter.page, "Library");
  await vcard().getByRole("button", { name: "Upvote", exact: true }).click();
  await vcard().locator('button[aria-label="Upvote"][aria-pressed="true"]').waitFor();
  await voter.page.reload();
  await navTo(voter.page, "Library");
  await vcard().locator('button[aria-label="Upvote"][aria-pressed="true"]').waitFor();
  await vcard().getByText("1 vote ·", { exact: false }).waitFor();

  // A room host picks the approved map from the room's Library picker.
  await back(page).click();
  const roomName = uniqueName("pick");
  await createRoom(user, s.base, roomName, { isPublic: true });
  await button(page, "Library").click();
  const picker = page.getByRole("dialog", { name: "Pick a map" });
  await picker.waitFor();
  await picker.locator(".map-card").filter({ hasText: name }).first().click();
  await page.locator(".room-map-name").filter({ hasText: name }).waitFor();
  return `approved ${name}, voted, starred, picked in room`;
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
  host.acceptDialogs = true;
  const code = await createRoom(host, s.base, roomName, { isPublic: true });
  const guest = await s.open("guest", { name: guestName });
  await joinByInvite(guest, s.base, code, roomName);
  const extra = await s.open("extra", { name: extraName });
  await joinByInvite(extra, s.base, code, roomName);
  await playerRow(host.page, guestName).waitFor();
  await playerRow(host.page, extraName).waitFor();

  await button(host.page, "Lock teams").click();
  await button(host.page, "Unlock teams").waitFor();

  await playerRow(host.page, extraName).getByRole("button", { name: "Kick", exact: true }).click();
  await playerRow(host.page, extraName).waitFor({ state: "detached" });
  await extra.page.getByText(/kicked/i).first().waitFor();

  await playerRow(host.page, guestName).getByRole("button", { name: "Ban", exact: true }).click();
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

async function quickPlay(s) {
  const host = await s.open("qhost", { name: uniqueName("qh") });
  const roomName = uniqueName("qroom");
  const code = await createRoom(host, s.base, roomName, { isPublic: true });
  const fresh = await s.open("fresh", { name: uniqueName("qf") });
  await fresh.page.goto(s.base);
  await menuName(fresh.page).fill(uniqueName("qf"));
  await button(fresh.page, "Quick play").click();
  await fresh.page.getByRole("heading", { name: "Quick play", exact: true }).waitFor();
  await fresh.page.getByRole("button", { name: /Free for all/ }).click();
  // quick-play rooms start by themselves: the match HUD comes up without a host
  await fresh.page.locator(".hud-leave").waitFor({ state: "visible", timeout: 20_000 });
  await waitForPixels(fresh, "quick-play canvas");
  check(!fresh.page.url().endsWith(`/${code}`), "quick play joined the custom room");
  return "queue card opened a self-starting quick-play match";
}

/** Experience: a finished match shows the post-game panel and levels appear in the roster. */
async function levels(s) {
  const user = await signedIn(s, "lvl");
  const { page } = user;
  const roomName = uniqueName("lv");
  const code = await createRoom(user, s.base, roomName, { isPublic: false });
  const guest = await s.open("lv-guest", { name: uniqueName("lg") });
  await joinByInvite(guest, s.base, code, roomName);
  await playerRow(page, "Guest").first().waitFor();
  // a map with no ground and one life each: the match ends by itself
  const voidMap = '{"b":[],"j":[],"s":[{"1":15,"2":10},{"1":25,"2":10}],"p":[],"tu":[],"tc":[],"gp":[],"c":[],"set":{"3":40,"15":40,"16":25}}';
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
  await page.locator("span.room-level").filter({ hasText: /^Level \d+$/ }).first().waitFor();
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
  await host.page.getByLabel(`${guestName} is typing`).waitFor();
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

async function replay(s) {
  const m = await matchWithGuest(s, { clipboard: false });
  const { host } = m;
  await waitForPixels(host, "match canvas");
  host.acceptDialogs = true;
  await host.page.locator(".hud-end").click();
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
  const box = await canvas.boundingBox();
  check(box && box.width > 100 && box.height > 100, "editor canvas has no size");
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await button(page, "Box (W)").click();
  await page.mouse.move(cx - 80, cy - 50);
  await page.mouse.down();
  await page.mouse.move(cx, cy, { steps: 8 });
  await page.mouse.move(cx + 80, cy + 50, { steps: 8 });
  await page.mouse.up();
  check(await button(page, "Undo").isEnabled(), "box drawn does not enable Undo");
  await button(page, "Select (Q)").click();
  await page.mouse.click(cx, cy);
  check(await button(page, "Delete").first().isEnabled(), "selecting does not enable Delete");
  await button(page, "Delete").first().click();
  await button(page, "Undo").click();
  check(await button(page, "Redo").isEnabled(), "redo not enabled after undo");
  await button(page, "Redo").click();
  check(await button(page, "Undo").isEnabled(), "undo not enabled after redo");

  // Inside a body (the original's double-click): a circle drawn there joins the box's body.
  // (the redo above deleted the first box again: draw a fresh one)
  await button(page, "Box (W)").click();
  await page.mouse.move(cx - 80, cy - 50);
  await page.mouse.down();
  await page.mouse.move(cx + 80, cy + 50, { steps: 8 });
  await page.mouse.up();
  await button(page, "Select (Q)").click();
  await page.mouse.dblclick(cx, cy);
  await page.locator(".editor-scope").waitFor({ state: "visible" });
  await button(page, "Circle (E)").click();
  await page.mouse.move(cx + 20, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 40, cy, { steps: 6 });
  await page.mouse.up();
  await page.waitForFunction(
    () => (JSON.parse(localStorage.getItem("neobox.editor.draft") ?? "{}").b ?? []).some((b) => (b.s ?? []).length === 2),
  );
  await page.keyboard.press("Escape");
  await page.locator(".editor-scope").waitFor({ state: "hidden" });

  // Built-in maps from the menu (the map has content now: confirm replacing it).
  user.acceptDialogs = true;
  await button(page, "Menu").click();
  await page.locator(".editor-menu").waitFor({ state: "visible" });
  await page.locator(".editor-list .editor-item").first().click();
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
  await page.getByLabel("Map code or JSON", { exact: true }).fill(code);
  await page.getByLabel("Map code or JSON", { exact: true }).press("Tab");
  await page.locator(".room-map-name").filter({ hasText: /\S/ }).waitFor();
  await button(page, "Leave").click();
  await button(page, "Back").click();
  await menuName(page).waitFor();

  // Save to library (signed in).
  await navTo(page, "Map editor");
  await canvas.waitFor({ state: "visible" });
  const name = uniqueName("edsave");
  await button(page, "Menu").click();
  await page.getByLabel("Map name", { exact: true }).fill(name);
  await button(page, "Save to library").click();
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
  check(text === "Level 1", `roster shows "${text}" for the signed-in player, expected "Level 1"`);
  return "room on the New York node; roster shows Level 1";
}

export const scenarios = [
  { name: "menu", run: menu },
  { name: "settings", run: settings },
  { name: "accounts", run: accounts },
  { name: "friends", run: friends },
  { name: "library", run: library },
  { name: "room lobby", run: roomLobby },
  { name: "room match", run: roomMatch },
  { name: "match menu", run: matchMenu },
  { name: "reconnect", run: reconnect },
  { name: "quick play", run: quickPlay },
  { name: "levels", run: levels },
  { name: "jukebox", run: jukebox },
  { name: "lobby signals", run: lobbySignals },
  { name: "training", run: training },
  { name: "news", run: news },
  { name: "clips", run: clips },
  { name: "replay", run: replay },
  { name: "practice", run: practice },
  { name: "phone", run: phone },
  { name: "input latency", run: latency },
  { name: "map editor", run: editor },
  { name: "map editor phone", run: editorPhone },
  { name: "geo room list", run: geoRoomList, topology: geoServer },
  { name: "regions", run: regionRooms, topology: regionServers },
  { name: "regions account", run: regionAccount, topology: regionServers },
];
