// Inventory rows for the rooms slice: the main menu header, quick play, browse, the create form, the room page with its
// controls, the room chat and its commands and notices, and the links into rooms. Each scenario names the rows it proves
// in `inv`; every check asserts a row's "shows" column, with role/name locators where they exist.

import { deflateSync } from "node:zlib";
import { ADMIN_PASSWORD, PASSWORD, adminRoom, button, createRoom, dismissPhoneSplash, ipIn, joinByInvite, matchWithGuest, menuName, navTo, playFromMenu, regionServers, roomCode, roomTitle, signedIn, sleep, startMatch, uniqueName } from "./lib.mjs";

const check = (ok, message) => {
  if (!ok) throw new Error(message);
};

const goMenu = async (page, base) => {
  await page.goto(base);
  await menuName(page).waitFor();
};

/** The menu header tools (News, Mute music, Fullscreen, Sign in) in `header.home-top`. */
const homeTop = (page) => page.locator("header.home-top");

/** The quick play page's Name field (the home screen has its own "Your name" input). */
const quickName = (page) => page.getByRole("textbox", { name: "Name", exact: true });

/** The quick play page's cards and their mode title. */
const quickCard = (page, title) => page.locator(".quick-card").filter({ has: page.getByRole("heading", { name: title, exact: true }) });

/** Drops the expected 500 console error a route-simulated failure logs, so the scenario fails only on other problems. */
function allowStatus500(handle) {
  const kept = handle.problems.filter((p) => !/status of 500|Failed to load resource/.test(p));
  handle.problems.splice(0, handle.problems.length, ...kept);
}

// ---------------------------------------------------------------- group 1: menu header and quick play

/** menu-home, menu-news-btn, menu-mute-btn, menu-fullscreen-btn: the home screen and its header tools. */
async function menuHome(s) {
  const h = await s.open("guest");
  const { page } = h;
  await goMenu(page, s.base);
  check(await menuName(page).isEditable(), "the guest name field is read-only");
  check(await page.getByText("Playing as", { exact: true }).isVisible(), "home does not say Playing as");
  check(await button(page, "Quick play").isEnabled(), "Quick play is disabled");
  check(await button(page, "Browse rooms").isEnabled(), "Browse rooms is disabled");
  for (const name of ["News", "Mute music", "Fullscreen", "Sign in"]) {
    check(await homeTop(page).getByRole("button", { name, exact: true }).isVisible(), `header has no ${name} button`);
  }

  // menu-news-btn: News opens "Update news" (one entry per page); the unread dot clears; Escape closes it.
  check(await page.locator(".home-unread").isVisible(), "the unread dot is hidden before the first News open");
  await homeTop(page).getByRole("button", { name: "News", exact: true }).click();
  const news = page.getByRole("dialog", { name: "Update news", exact: true });
  await news.waitFor({ state: "visible" });
  check(/^1 of \d+$/.test((await news.locator(".news-count").textContent()) ?? ""), "news does not start at entry 1");
  await page.keyboard.press("Escape");
  await news.waitFor({ state: "hidden" });
  check(await page.locator(".home-unread").isHidden(), "the unread dot is still shown after News was read");

  // menu-mute-btn: the header button flips between Mute music and Unmute music.
  await homeTop(page).getByRole("button", { name: "Mute music", exact: true }).click();
  check(await homeTop(page).getByRole("button", { name: "Unmute music", exact: true }).count() === 1, "after mute the label is not Unmute music");
  await homeTop(page).getByRole("button", { name: "Unmute music", exact: true }).click();
  check(await homeTop(page).getByRole("button", { name: "Mute music", exact: true }).count() === 1, "after unmute the label is not Mute music");

  // menu-fullscreen-btn: the button enters fullscreen and its label flips to Exit fullscreen.
  await homeTop(page).getByRole("button", { name: "Fullscreen", exact: true }).click();
  await homeTop(page).getByRole("button", { name: "Exit fullscreen", exact: true }).waitFor({ state: "visible" });
  check(await page.evaluate(() => document.fullscreenElement !== null), "the page is not fullscreen after the Fullscreen click");
  await homeTop(page).getByRole("button", { name: "Exit fullscreen", exact: true }).click();
  await homeTop(page).getByRole("button", { name: "Fullscreen", exact: true }).waitFor({ state: "visible" });
  return "name field, Playing as, play buttons, header tools; News dialog; mute label flip; fullscreen label flip";
}

/** quick-empty: a server with no rotation says so on the quick page. */
async function quickEmpty(s) {
  const h = await s.open("guest");
  const { page } = h;
  await page.route("**/api/rotation", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ meta: {}, maps: [] }) }),
  );
  await goMenu(page, s.base);
  await button(page, "Quick play").click();
  await page.getByRole("heading", { name: "Quick play", exact: true }).waitFor();
  await page.getByText("This server has no quick play.", { exact: true }).waitFor({ state: "visible" });
  return "empty rotation: This server has no quick play.";
}

/** quick-error: a rotation that fails to load gives the retry-later message. */
async function quickError(s) {
  const h = await s.open("guest");
  const { page } = h;
  await page.route("**/api/rotation", (route) => route.fulfill({ status: 500, contentType: "text/plain", body: "boom" }));
  await goMenu(page, s.base);
  await button(page, "Quick play").click();
  await page.getByRole("heading", { name: "Quick play", exact: true }).waitFor();
  await page.getByText("Could not load quick play. Try again later.", { exact: true }).waitFor({ state: "visible" });
  allowStatus500(h);
  return "rotation HTTP 500: Could not load quick play. Try again later.";
}

/** quick-page, quick-mode-card: the quick page's name field and its two mode cards, and the map carousel on a card. */
async function quickPage(s) {
  const h = await s.open("guest");
  const { page } = h;
  await goMenu(page, s.base);
  await button(page, "Quick play").click();
  await page.getByRole("heading", { name: "Quick play", exact: true }).waitFor();
  check(await quickName(page).isEditable(), "quick name field is read-only for a guest");
  for (const title of ["Sweaty Bois", "Team Madness"]) {
    await quickCard(page, title).waitFor({ state: "visible" });
  }
  check((await page.locator(".quick-card h2").allTextContents()).join("|") === "Sweaty Bois|Team Madness", "quick play cards are not Sweaty Bois and Team Madness");
  const playSweaty = quickCard(page, "Sweaty Bois").getByRole("button", { name: "Play Sweaty Bois", exact: true });
  check(await playSweaty.isDisabled(), "Play is enabled before a guest name is typed");
  await quickName(page).fill(uniqueName("quick"));
  await playSweaty.waitFor({ state: "visible" });

  // quick-mode-card: the count line, the carousel arrows, the caption that steps, and the Play button.
  const card = quickCard(page, "Sweaty Bois");
  await card.getByText(/^\d+ playing$/).waitFor({ state: "visible" });
  const caption = card.locator(".quick-map-name");
  const first = (await caption.textContent())?.trim() ?? "";
  check(first !== "", "the Sweaty Bois carousel has no map caption");
  check(await card.getByRole("button", { name: "Previous Sweaty Bois map", exact: true }).count() === 1, "no Previous arrow on the Sweaty Bois card");
  await card.getByRole("button", { name: "Next Sweaty Bois map", exact: true }).click();
  await card.locator(".quick-map-name").filter({ hasText: /\S/ }).waitFor();
  const next = (await caption.textContent())?.trim() ?? "";
  check(next !== first, `Next did not step the map caption ("${first}" -> "${next}")`);
  check(await card.getByRole("button", { name: "Play Sweaty Bois", exact: true }).isEnabled(), "Play Sweaty Bois is disabled");
  return `2 mode cards; Sweaty Bois caption steps "${first}" -> "${next}"; Play Sweaty Bois enabled`;
}

/** quick-waiting: Play starts the matching wait ("Finding a room…") and the room's matching notice appears alone. */
async function quickWaiting(s) {
  const h = await s.open("guest");
  const { page } = h;
  await goMenu(page, s.base);
  await button(page, "Quick play").click();
  await page.getByRole("heading", { name: "Quick play", exact: true }).waitFor();
  await quickName(page).fill(uniqueName("quick"));
  await quickCard(page, "Sweaty Bois").getByRole("button", { name: "Play Sweaty Bois", exact: true }).click();
  await page.getByText("Finding a room…", { exact: true }).waitFor({ state: "visible" });
  // the match starts by itself: alone in it, the HUD carries the matching notice
  await page.locator(".hud-leave").waitFor({ state: "visible", timeout: 20_000 });
  await page.locator(".hud-matching").getByText("Waiting for other players to join this arena...", { exact: true }).waitFor({ state: "visible" });
  check(await page.getByRole("button", { name: "Cancel", exact: true }).count() === 0, "Cancel is still shown once the match is up");
  return "Finding a room… then the HUD matching notice; no Cancel once matched";
}

// ---------------------------------------------------------------- group 2: browse rooms

/** Opens Browse rooms as the guest `name`. */
async function openBrowse(page, base, name) {
  await goMenu(page, base);
  await playFromMenu(page, name);
  await page.getByRole("heading", { name: "Browse rooms", exact: true }).waitFor();
}

/** Browse's join-by-code field, its Join button, and its search field. */
const codeField = (page) => page.getByLabel("Room code", { exact: true });
const codeJoin = (page) => page.locator("form.code-join").getByRole("button", { name: "Join", exact: true });
const roomSearch = (page) => page.getByPlaceholder("Room, map, mode or region", { exact: true });
/** A listed room's row (the li), found by the room's name. */
const roomItem = (page, roomName) => page.locator('ul[aria-label="rooms"] li.room-item').filter({ has: page.locator("button.room-row", { hasText: roomName }) });

/** A public room with a password, created from the create form. Returns its code. */
async function createLockedRoom(h, base, roomName, password) {
  const { page } = h;
  await page.goto(base);
  await menuName(page).waitFor();
  await playFromMenu(page, null);
  await button(page, "New room").click();
  await page.getByRole("heading", { name: "Create a room", exact: true }).waitFor();
  await page.getByLabel("room name", { exact: true }).fill(roomName);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await button(page, "Create room").click();
  await roomTitle(page, roomName).waitFor();
  return roomCode(page);
}

/** browse-page (empty controls), browse-empty-none, browse-create-modal; an empty room name defaults to "NAME's game". */
async function browseEmpty(s) {
  const name = uniqueName("guest");
  const h = await s.open("guest", { name });
  const { page } = h;
  await openBrowse(page, s.base, name);
  for (const label of ["Refresh", "New room"]) {
    check(await button(page, label).isVisible(), `Browse has no ${label} button`);
  }
  check(await codeField(page).isVisible(), "Browse has no Room code field");
  check(await codeJoin(page).isDisabled(), "Join is enabled with an empty room code");
  check(await roomSearch(page).isVisible(), "Browse has no room search field");
  await page.getByText("No open rooms right now. Create one and invite friends.", { exact: true }).waitFor({ state: "visible" });

  await button(page, "New room").click();
  await page.getByRole("heading", { name: "Create a room", exact: true }).waitFor();
  check(await page.getByLabel("room name", { exact: true }).isVisible(), "the create form has no room name field");
  check(await page.getByLabel("Password", { exact: true }).isVisible(), "the create form has no Password field");
  check((await page.getByLabel("Max players", { exact: true }).inputValue()) === "8", "Max players does not default to 8");
  check(await page.getByLabel("Public", { exact: true }).isChecked(), "Public is not checked by default");
  await page.getByText(`Leave empty for "${name}'s game".`, { exact: true }).waitFor({ state: "visible" });

  await button(page, "Create room").click();
  await page.locator("h1.room-title").waitFor({ state: "visible" });
  check((await page.locator("h1.room-title").textContent())?.trim() === `${name}'s game`, "an empty room name did not default to NAME's game");
  return `Browse empty text; Refresh, New room, Room code, Join disabled, search; create modal defaults; empty name -> "${name}'s game"`;
}

/** browse-page (code join), browse-row, browse-locked-row, browse-password-slot, browse-empty-filter, browse-filters. */
async function browseRows(s) {
  const hostA = await s.open("hostOpen", { name: uniqueName("hostopen") });
  const codeA = await createRoom(hostA, s.base, "Open lobby one", { isPublic: true });
  const hostB = await s.open("hostLocked", { name: uniqueName("hostlocked") });
  const codeB = await createLockedRoom(hostB, s.base, "Locked lobby", PASSWORD);
  const name = uniqueName("guest");
  const h = await s.open("guest", { name });
  const { page } = h;
  await openBrowse(page, s.base, name);
  check(await codeJoin(page).isDisabled(), "Join is enabled with an empty room code");
  const rowA = roomItem(page, "Open lobby one");
  const rowB = roomItem(page, "Locked lobby");
  await rowA.locator("button.room-row").waitFor({ state: "visible" });
  await rowB.locator("button.room-row").waitFor({ state: "visible" });

  // browse-row: the open room is listed once, with its 1/8 count.
  check(await page.locator('ul[aria-label="rooms"] li').filter({ hasText: "Open lobby one" }).count() === 1, "Open lobby one is not listed once");
  check(/1\s*\/\s*8/.test((await rowA.textContent()) ?? ""), "the open room row does not show 1/8 players");

  // browse-locked-row: a lock icon; the password field opens on click; the row Join stays disabled until typed.
  check(await rowB.getByRole("img", { name: "password protected", exact: true }).count() === 1, "the locked row has no password lock icon");
  check(await page.getByLabel("password for Locked lobby", { exact: true }).count() === 0, "the locked row's password field is open before the click");
  await rowB.locator("button.room-row").click();
  const pw = page.getByLabel("password for Locked lobby", { exact: true });
  await pw.waitFor({ state: "visible" });
  check(await rowB.getByRole("button", { name: "Join", exact: true }).isDisabled(), "the locked row Join is enabled before a password is typed");

  // browse-password-slot: a wrong password says so and keeps Browse and the field open.
  await pw.fill("wrongpass");
  await rowB.getByRole("button", { name: "Join", exact: true }).click();
  await page.getByText(/wrong password/i).first().waitFor({ state: "visible" });
  check(await button(page, "New room").isVisible(), "a wrong password left Browse rooms");
  check(await pw.isVisible(), "the password field closed after a wrong password");

  // browse-empty-filter: a search with no hit says so; clearing it lists the rooms again.
  await roomSearch(page).fill("zzz-nothing");
  await page.getByText("No rooms match. Clear the search or show full rooms.", { exact: true }).waitFor({ state: "visible" });
  await roomSearch(page).fill("");
  await rowA.locator("button.room-row").waitFor({ state: "visible" });

  // browse-filters: Hide full rooms is a switch, off by default, on after a click.
  const hide = page.getByRole("switch", { name: "Hide full rooms", exact: true });
  check(await hide.count() === 1, "no Hide full rooms switch");
  check(!(await hide.isChecked()), "Hide full rooms is on by default");
  await page.locator("label.check").filter({ hasText: "Hide full rooms" }).click();
  check(await hide.isChecked(), "Hide full rooms did not turn on after the click");
  await rowA.locator("button.room-row").waitFor({ state: "visible" });

  // browse-page: a typed lowercase code is uppercased, and Join opens that room.
  await codeField(page).fill(codeA.toLowerCase());
  check((await codeField(page).inputValue()) === codeA, `Room code holds "${await codeField(page).inputValue()}", not ${codeA}`);
  check(await codeJoin(page).isEnabled(), "Join stays disabled for a valid room code");
  await codeJoin(page).click();
  await roomTitle(page, "Open lobby one").waitFor({ state: "visible" });
  return `rows: "Open lobby one" 1/8, locked row + password field, wrong password, filter empty text, Hide full rooms switch, code join`;
}

// ---------------------------------------------------------------- group 3: create room, room page and host controls

/** The room page's roster rows, and a panel section by its class. */
const rosterRows = (page) => page.locator("li.room-player");
const panel = (page, cls) => page.locator(`section.room-panel.${cls}`);

/** A guest's Manage section has no host controls: no buttons and no ban list. */
const guestHasNoManage = async (page) =>
  (await panel(page, "room-manage").getByRole("button").count()) === 0 &&
  (await panel(page, "room-manage").getByText("No one is banned.", { exact: true }).count()) === 0;

/** A host with a new public room named `roomName`. Clipboard is granted where the browser has it. */
async function openHostRoom(s, roomName, { clipboard = false } = {}) {
  const name = uniqueName("host");
  const h = await s.open("host", { name, clipboard: clipboard && s.env.browser.clipboard });
  const code = await createRoom(h, s.base, roomName, { isPublic: true });
  return { h, name, code };
}

/** A host in a fresh public room with a unique title. */
async function openHostRoomNamed(s, opts) {
  const roomName = uniqueName("room");
  const { h, name, code } = await openHostRoom(s, roomName, opts);
  return { h, name, code, roomName };
}

/** A guest that joins the room by its invite URL, in the lobby (no match started). */
async function joinGuest(s, code, roomName) {
  const name = uniqueName("guest");
  const g = await s.open("guest", { name });
  await joinByInvite(g, s.base, code, roomName);
  return { g, name };
}

/** room-header, room-invite: title, Code fact, Invite and Leave only; Invite copies the invite link. */
async function roomHeader(s) {
  const roomName = "Lobby desktop";
  const { h, code } = await openHostRoom(s, roomName, { clipboard: true });
  const { page } = h;
  await roomTitle(page, roomName).waitFor({ state: "visible" });
  check((await page.locator("h1.room-title").textContent())?.trim() === roomName, "the room title is not the room name");
  check((await page.locator("div.room-fact").filter({ hasText: "Code" }).locator("dd").textContent())?.trim() === code, "the Code fact does not show the room code");
  check(await button(page, "Invite").isEnabled(), "Invite is disabled in the lobby");
  check(await button(page, "Leave").isVisible(), "no Leave button in the room header");
  check(await button(page, "Back to game").count() === 0, "Back to game shows in a lobby not opened from a match");
  check(await button(page, "Save replay").count() === 0, "Save replay shows before a replay is ready");
  if (s.env.browser.clipboard) {
    await button(page, "Invite").click();
    await page.locator(".toast").first().waitFor({ state: "visible" });
    let url = "";
    for (let i = 0; i < 50 && url !== `${s.base}/${code}`; i++) {
      url = await page.evaluate(() => navigator.clipboard.readText());
      if (url !== `${s.base}/${code}`) await sleep(100);
    }
    check(url === `${s.base}/${code}`, `invite link is "${url}", expected ${s.base}/${code}`);
  }
  return `title "${roomName}", Code fact ${code}; header Invite and Leave; Invite copies ${s.env.browser.clipboard ? "the link" : "(no clipboard in this engine)"}`;
}

/** room-players, room-player-row: Players heading with the count, the roster, the host crown, the guest's view. */
async function roomPlayers(s) {
  const { h, name, code, roomName } = await openHostRoomNamed(s);
  const { page } = h;
  const heading = page.locator("h2.room-panel-title").filter({ hasText: "Players" });
  check(((await heading.textContent()) ?? "").replace(/\s/g, "") === "Players1/8", `Players heading is "${await heading.textContent()}", not Players 1/8`);
  check(await page.getByRole("radiogroup", { name: "Join or spectate", exact: true }).isVisible(), "no Join or spectate choice for the host");
  check(await rosterRows(page).count() === 1, "the host's roster is not one row");
  const mine = rosterRows(page).filter({ hasText: name });
  check(await mine.getByText("you", { exact: true }).isVisible(), "the host's own row has no you marker");
  check(await mine.getByRole("img", { name: "Room host", exact: true }).count() === 1, "the host row has no crown");
  check(await mine.getByRole("img", { name: "Verified account", exact: true }).count() === 0, "a guest account shows the verified badge");
  check(await mine.locator(".room-level").count() === 0, "a guest account shows a level chip");

  const { g, name: guestName } = await joinGuest(s, code, roomName);
  await rosterRows(page).filter({ hasText: guestName }).waitFor({ state: "visible" });
  check(await rosterRows(page).count() === 2, "the host's roster does not list two players");
  check(await rosterRows(g.page).count() === 2, "the guest's roster does not list two players");
  check(await rosterRows(g.page).filter({ hasText: name }).getByRole("img", { name: "Room host", exact: true }).count() === 1, "the guest's view has no crown on the host");
  check(await guestHasNoManage(g.page), "the Manage panel shows host controls to a guest");
  return `host: Players 1/8, Join or spectate, own row you+crown; guest sees 2 rows and the host crown; Manage hidden for guest`;
}

/** room-mode: the Mode panel, the Game mode dialog's options, and picking one sets the mode (the team choice follows). */
async function roomMode(s) {
  const { h } = await openHostRoomNamed(s);
  const { page } = h;
  const modePanel = panel(page, "room-mode-panel");
  await modePanel.getByRole("button", { name: "Change mode", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Game mode", exact: true });
  await dialog.waitFor({ state: "visible" });
  const names = (await dialog.locator(".room-mode-option-name").allTextContents()).map((t) => t.trim());
  check(names.join("|") === "Kills|Lives|Rounds|Team rounds|Endless teams|Lives teams|Endless", `the Game mode dialog lists ${names.join(", ")}`);
  await dialog.getByRole("button", { name: /^Team rounds\b/ }).click();
  await dialog.waitFor({ state: "hidden" });
  await modePanel.getByText("Team rounds", { exact: true }).waitFor({ state: "visible" });
  await page.getByRole("radiogroup", { name: "Your team", exact: true }).waitFor({ state: "visible" });
  check(await page.getByRole("radiogroup", { name: "Your team", exact: true }).getByRole("radio", { name: "Red", exact: true }).count() === 1, "the team choice has no Red");
  return `Mode dialog lists 7 modes; after Team rounds the panel shows it and the team choice (Your team, Red) appears`;
}

/** room-map-modal, room-map-panel, room-map-errors: the Choose a map dialog, the Map panel, a bad pasted code. */
async function roomMap(s) {
  const { h } = await openHostRoomNamed(s);
  const { page } = h;
  const mapPanel = panel(page, "room-map-panel");
  await page.locator(".room-map-name").filter({ hasText: /\S/ }).waitFor({ state: "visible" });
  await mapPanel.getByRole("button", { name: "Change map", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Choose a map", exact: true });
  await dialog.waitFor({ state: "visible" });
  for (const label of ["Use code", "Library", "Editor"]) {
    check(await dialog.getByRole("button", { name: label, exact: true }).isVisible(), `the map dialog has no ${label}`);
  }
  check(await dialog.getByLabel("Map code or JSON", { exact: true }).isVisible(), "the map dialog has no Map code or JSON field");

  // room-map-errors: a pasted code that is not a map leaves the dialog open with an error toast.
  await dialog.getByLabel("Map code or JSON", { exact: true }).fill("not a map");
  await dialog.getByRole("button", { name: "Use code", exact: true }).click();
  await page.locator('.toast[role="alert"]').first().waitFor({ state: "visible" });
  check(await dialog.isVisible(), "a bad map code closed the dialog");
  await dialog.getByLabel("Map code or JSON", { exact: true }).fill("");

  // room-map-modal: a built-in map in the list becomes the room map and the dialog closes.
  const first = dialog.locator(".room-map-list button").first();
  const firstName = ((await first.textContent()) ?? "").trim();
  await first.click();
  await dialog.waitFor({ state: "hidden" });
  await page.locator(".room-map-name").filter({ hasText: firstName }).waitFor({ state: "visible" });
  return `Choose a map buttons incl. Use code/Library/Editor; bad code: alert toast, dialog stays; built-in "${firstName}" becomes the room map`;
}

/** room-manage: Lock teams toggles, End match is disabled with no match, the ban list is empty. Hidden from guests. */
async function roomManage(s) {
  const { h, roomName, code } = await openHostRoomNamed(s);
  const { page } = h;
  const manage = panel(page, "room-manage");
  await manage.getByText("No one is banned.", { exact: true }).waitFor({ state: "visible" });
  check(await manage.getByRole("button", { name: "End match", exact: true }).isDisabled(), "End match is enabled with no match running");
  const lock = manage.getByRole("button", { name: "Lock teams", exact: true });
  check(await lock.isEnabled(), "Lock teams is disabled");
  check(await manage.getByText("Players can change team.", { exact: true }).isVisible(), "no Players can change team line");
  await lock.click();
  await manage.getByRole("button", { name: "Unlock teams", exact: true }).waitFor({ state: "visible" });
  check(await manage.getByText("Players cannot change team.", { exact: true }).isVisible(), "no Players cannot change team line after lock");
  await manage.getByRole("button", { name: "Unlock teams", exact: true }).click();
  await manage.getByRole("button", { name: "Lock teams", exact: true }).waitFor({ state: "visible" });
  const { g } = await joinGuest(s, code, roomName);
  check(await guestHasNoManage(g.page), "the Manage panel shows host controls to a guest");
  return `Manage: Lock teams toggles to Unlock teams and back; End match disabled; "No one is banned."; hidden for guest`;
}

/** room-settings: the Settings panel lists the room's settings behind More settings; the host can edit, a guest cannot. */
async function roomSettings(s) {
  const { h, roomName, code } = await openHostRoomNamed(s);
  const { page } = h;
  const settings = panel(page, "room-settings-panel");
  check(await settings.getByRole("heading", { name: "Settings", exact: true }).isVisible(), "no Settings heading");
  await settings.getByText("More settings", { exact: true }).click();
  const rows = settings.locator(".room-setting");
  await rows.first().waitFor({ state: "visible" });
  const count = await rows.count();
  check(count > 0, `Settings lists ${count} rows`);
  check(await rows.first().locator("input").isEnabled(), "the host cannot edit a setting");
  const { g } = await joinGuest(s, code, roomName);
  await panel(g.page, "room-settings-panel").getByText("More settings", { exact: true }).click();
  check(await panel(g.page, "room-settings-panel").locator(".room-setting input").first().isDisabled(), "a guest can edit a setting");
  return `Settings: More settings reveals ${count} rows; host inputs enabled; guest inputs disabled`;
}

/** room-appearance: the Appearance palette button opens the colour dialog, Cancel closes it. */
async function roomAppearance(s) {
  const { h } = await openHostRoomNamed(s);
  const { page } = h;
  await button(page, "Appearance").click();
  const dialog = page.getByRole("dialog").filter({ hasText: "Custom colour" });
  await dialog.waitFor({ state: "visible" });
  check(await dialog.getByRole("button", { name: "Save colour", exact: true }).isVisible(), "the colour dialog has no Save colour");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  return `Appearance dialog: Custom colour, Cancel, Save colour`;
}

/** room-dock, room-starting: the dock says how many are ready; Start shows Match starting with Abort start; Abort ends it. */
async function roomDock(s) {
  const { h, roomName, code } = await openHostRoomNamed(s);
  const { page } = h;
  const dock = page.locator("footer.room-dock");
  check((await dock.getAttribute("aria-label")) === "Match controls", "the dock is not labelled Match controls");
  await dock.getByText("1 player ready", { exact: true }).waitFor({ state: "visible" });
  check(await dock.getByRole("button", { name: "Start", exact: true }).isEnabled(), "Start is disabled with one player");

  // A lone host starts at once; with a guest there is a one-second countdown, during which Abort start shows.
  const { g } = await joinGuest(s, code, roomName);
  await dock.getByText("2 players ready", { exact: true }).waitFor({ state: "visible" });
  await g.page.locator("footer.room-dock").getByText("Waiting for host to start", { exact: true }).waitFor({ state: "visible" });
  await dock.getByRole("button", { name: "Start", exact: true }).click();
  await button(page, "Abort start").waitFor({ state: "visible" });
  check(await dock.getByText("Match starting", { exact: true }).isVisible(), "the dock does not say Match starting");
  check(await dock.getByRole("button", { name: "Start", exact: true }).isDisabled(), "Start is enabled while starting");
  await button(page, "Abort start").click();
  await button(page, "Abort start").waitFor({ state: "hidden" });
  check(await page.locator(".hud-leave").count() === 0, "the match started after Abort start");
  await dock.getByText("2 players ready", { exact: true }).waitFor({ state: "visible" });
  return `dock: "1 player ready" alone; with a guest "2 players ready"; Start -> "Match starting" + Abort start; Abort returns to "2 players ready"; guest dock "Waiting for host to start"`;
}

// ---------------------------------------------------------------- group 4: room chat, commands and their notices

/** The server's chat budget per player: 3 lines at once, then one line every 3 s (room.rs CHAT_BURST, CHAT_REFILL_SECS). */
const CHAT_BURST = 3;
const CHAT_REFILL_MS = 3000;
/** Each page's budget as the last send left it: tokens, and the time of that send. */
const chatBudget = new WeakMap();

/** Sends one line through the room chat input (Enter). Waits for the budget to refill first, so a command is never rate-limited. */
async function sendChat(page, text) {
  const held = (at, { tokens, from }) => Math.min(CHAT_BURST, tokens + (at - from) / CHAT_REFILL_MS);
  const state = chatBudget.get(page) ?? { tokens: CHAT_BURST, from: Date.now() };
  let at = Date.now();
  let tokens = held(at, state);
  if (tokens < 1) {
    await sleep((1 - tokens) * CHAT_REFILL_MS + 100);
    at = Date.now();
    tokens = held(at, state);
  }
  chatBudget.set(page, { tokens: tokens - 1, from: at });
  const input = page.getByLabel("Chat message", { exact: true });
  await input.fill(text);
  await input.press("Enter");
}

/** A chat log line (a player's line or a system line) that contains `text`. */
const chatLine = (page, text) => page.locator("div.room-chat-log .room-chat-line").filter({ hasText: text }).first();

/** A roster group under its heading (Red (n), Blue (n), Spectating (n)); its rows are li.room-player. */
const rosterGroup = (page, heading) => page.locator("section.room-roster-group").filter({ has: page.getByRole("heading", { name: heading }) });

/** room-chat, cmd-help, notice-help, notice-unknown, notice-usage, notice-no-player, notice-record: chat is echoed to the room; each command answers in the chat log. */
async function chatNotices(s) {
  const { h, name } = await openHostRoomNamed(s);
  const { page } = h;
  await sendChat(page, "hello from host");
  await chatLine(page, `${name}: hello from host`).waitFor({ state: "visible" });
  await sendChat(page, "/help");
  await chatLine(page, "Commands: /set <key> <value>, /settings, /reset, /mode <n>, /start, /end, /lock, /unlock, /kick <name>, /ban <name>, /unban <name>, /mute <name>, /unmute <name>, /host <name>, /team <name> <ffa|red|blue|spec>, /join <ffa|red|blue|spec>, /upvote, /downvote, /fav, /unfav, /record").waitFor({ state: "visible" });
  await sendChat(page, "/nosuch");
  await chatLine(page, "Unknown command, try /help").waitFor({ state: "visible" });
  await sendChat(page, "/set");
  await chatLine(page, "Usage: /set <key> <value>").waitFor({ state: "visible" });
  await sendChat(page, "/kick nobody");
  await chatLine(page, "No player with that name").waitFor({ state: "visible" });
  await sendChat(page, "/record");
  await chatLine(page, "Type /record in a running match to send its last 15 seconds to the main menu").waitFor({ state: "visible" });
  return `chat echoes "${name}: hello from host"; /help, /nosuch, /set, /kick nobody, /record answer with their notices in the room chat`;
}

/** cmd-settings, cmd-set, sys-settings, cmd-reset, cmd-mode, sys-map: /settings lists the settings, /set echoes the one it changed, /reset restores the defaults, /mode 3 picks Team rounds, Change map announces the new map. */
async function chatSettings(s) {
  const { h } = await openHostRoomNamed(s);
  const { page } = h;
  const settingsLine = (i) => page.locator("div.room-chat-log .room-chat-system").filter({ hasText: "timeScale: " }).nth(i);
  await sendChat(page, "/settings");
  await settingsLine(0).waitFor({ state: "visible" });
  const defaultLimit = /objectiveLimit: ([^,]+)/.exec((await settingsLine(0).textContent()) ?? "")?.[1];
  check(defaultLimit !== undefined, "the /settings line has no objectiveLimit");
  const other = defaultLimit === "1" ? "2" : "1";
  await sendChat(page, `/set objectiveLimit ${other}`);
  await page.locator("div.room-chat-log .room-chat-system").filter({ hasText: new RegExp(`^objectiveLimit: ${other}$`) }).waitFor({ state: "visible" });
  await sendChat(page, "/reset");
  await chatLine(page, "Settings reset").waitFor({ state: "visible" });
  await sendChat(page, "/settings");
  await settingsLine(1).waitFor({ state: "visible" });
  const afterReset = /objectiveLimit: ([^,]+)/.exec((await settingsLine(1).textContent()) ?? "")?.[1];
  check(afterReset === defaultLimit, `objectiveLimit after /reset is ${afterReset}, not the default ${defaultLimit}`);
  await sendChat(page, "/mode 3");
  await panel(page, "room-mode-panel").getByText("Team rounds", { exact: true }).waitFor({ state: "visible" });
  await panel(page, "room-map-panel").getByRole("button", { name: "Change map", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Choose a map", exact: true });
  await dialog.waitFor({ state: "visible" });
  await dialog.locator(".room-map-list button").first().click();
  await dialog.waitFor({ state: "hidden" });
  await chatLine(page, "Map changed to ").waitFor({ state: "visible" });
  return `/settings echoes the list (objectiveLimit ${defaultLimit}); /set objectiveLimit ${other} echoes "objectiveLimit: ${other}"; /reset -> "Settings reset" and the default again; /mode 3 -> Team rounds; Change map -> "Map changed to ..."`;
}

/** cmd-lock, sys-teams-lock, cmd-unlock, cmd-team, cmd-join, sys-nobody, sys-nobody-spec-guest, sys-nobody-start, restore-team-host, restore-team-guest, sys-countdown, cmd-start: team moves by host and guest, the lock toggle, the nobody-to-play start, then a start with two teams. sys-no-map: a new room always has a map name, so /start never reaches "No map selected" (NOT-REACHABLE; the precondition is checked here, the row is not claimed). */
async function chatTeams(s) {
  const { h, name: hostName, code, roomName } = await openHostRoomNamed(s);
  const { page } = h;
  await page.locator(".room-map-name").filter({ hasText: /\S/ }).waitFor({ state: "visible" });
  const { g, name: guestName } = await joinGuest(s, code, roomName);
  await rosterRows(page).filter({ hasText: guestName }).waitFor({ state: "visible" });
  await sendChat(page, "/mode 3");
  await panel(page, "room-mode-panel").getByText("Team rounds", { exact: true }).waitFor({ state: "visible" });
  await sendChat(page, `/team ${guestName} red`);
  await rosterGroup(page, /^Red \(/).locator("li.room-player").filter({ hasText: guestName }).waitFor({ state: "visible" });
  await sendChat(page, "/lock");
  await chatLine(page, "Teams are locked").waitFor({ state: "visible" });
  await sendChat(page, "/unlock");
  await chatLine(page, "Teams are unlocked").waitFor({ state: "visible" });
  await sendChat(g.page, "/join blue");
  await rosterGroup(page, /^Blue \(/).locator("li.room-player").filter({ hasText: guestName }).waitFor({ state: "visible" });
  await sendChat(page, `/team ${hostName} spec`);
  await rosterGroup(page, /^Spectating \(/).locator("li.room-player").filter({ hasText: hostName }).waitFor({ state: "visible" });
  await sendChat(page, `/team ${guestName} spec`);
  await rosterGroup(page, /^Spectating \(/).locator("li.room-player").filter({ hasText: guestName }).waitFor({ state: "visible" });
  await sendChat(page, "/start");
  await chatLine(page, "Nobody to play: everyone is spectating").waitFor({ state: "visible" });
  await sendChat(page, `/team ${hostName} red`);
  await rosterGroup(page, /^Red \(/).locator("li.room-player").filter({ hasText: hostName }).waitFor({ state: "visible" });
  await sendChat(page, `/team ${guestName} blue`);
  await rosterGroup(page, /^Blue \(/).locator("li.room-player").filter({ hasText: guestName }).waitFor({ state: "visible" });
  await sendChat(page, "/start");
  await chatLine(page, "Game starting!").waitFor({ state: "visible" });
  await page.locator(".hud-leave").waitFor({ state: "visible" });
  await g.page.locator(".hud-leave").waitFor({ state: "visible" });
  return `/mode 3; /team guest red; /lock -> "Teams are locked"; /unlock -> "Teams are unlocked"; guest /join blue; /team host spec and guest spec; /start -> "Nobody to play: everyone is spectating"; back to red/blue; /start -> "Game starting!" and the HUD on both pages`;
}

// ---------------------------------------------------------------- group 5: invite links, join notices, room tabs, reports

/** Chat commands and lines share one budget: 3 at once, then one per CHAT_REFILL_SECS (3 s, room.rs). Waits out one refill, then sends. */
const sayPaced = async (page, text) => {
  await sleep(3100);
  await sendChat(page, text);
};

/** Every chat line with `text`; a command's answer is the one after the lines already in the log. */
const chatLines = (page, text) => page.locator("div.room-chat-log .room-chat-line").filter({ hasText: text });

/** Sends a command, then waits for its answer `text` as a new line in the log. */
async function sendAnswered(page, command, text) {
  const before = await chatLines(page, text).count();
  await sayPaced(page, command);
  await chatLines(page, text).nth(before).waitFor({ state: "visible" });
}

/** app-invite, app-invite-query: /CODE opens the room; ?room= (lower case) opens it and rewrites the address to /CODE; a link naming no room lands on the menu. */
async function inviteLinks(s) {
  const roomName = uniqueName("link");
  const host = await s.open("host", { name: uniqueName("host") });
  const code = await createRoom(host, s.base, roomName, { isPublic: true });

  const guest = await s.open("guest", { name: uniqueName("guest") });
  await guest.page.goto(`${s.base}/${code}`);
  await roomTitle(guest.page, roomName).waitFor();
  check(new URL(guest.page.url()).pathname === `/${code}`, `address is ${guest.page.url()}, expected /${code}`);

  const query = await s.open("query", { name: uniqueName("q") });
  await query.page.goto(`${s.base}/?room=${code.toLowerCase()}`);
  await roomTitle(query.page, roomName).waitFor();
  check(new URL(query.page.url()).pathname === `/${code}`, `?room= address is ${query.page.url()}, expected /${code}`);

  const bad = await s.open("bad", { name: uniqueName("bad") });
  await bad.page.goto(`${s.base}/?room=zz!`);
  await menuName(bad.page).waitFor();
  check((await roomTitle(bad.page).count()) === 0, "a link with a bad room code opened a room");
  check(new URL(bad.page.url()).pathname === "/", `a bad code left the address at ${bad.page.url()}`);
  return `/${code} opens "${roomName}" at /${code}; ?room=${code.toLowerCase()} opens it and rewrites to /${code}; ?room=zz! shows the menu at /`;
}

/** redirect: a Frankfurt guest opening a room hosted on the New York node has its sockets reach that node. */
async function regionRedirect(s) {
  const roomName = uniqueName("region");
  const host = await s.open("nyhost", { name: uniqueName("nyh"), ip: ipIn("203.0.113") });
  const code = await createRoom(host, s.base, roomName, { isPublic: true });
  check((await adminRoom(s.base, code)).region === "New York", "the room is not on the New York node");

  const guest = await s.open("frguest", { name: uniqueName("frg"), ip: ipIn("198.51.100") });
  const sockets = [];
  guest.page.on("websocket", (ws) => sockets.push(ws.url()));
  await guest.page.goto(`${s.base}/${code}`);
  await roomTitle(guest.page, roomName).waitFor();
  const nodePort = new URL(s.env.nodeBase).port;
  check(sockets.some((url) => new URL(url).port === nodePort), `guest sockets ${JSON.stringify(sockets)} never reach the node port ${nodePort}`);
  return `Frankfurt guest on /${code}: sockets ${JSON.stringify(sockets)} include the New York node port ${nodePort}; room region New York`;
}

/** sys-joined: a guest who joins by link is announced in the host's chat. */
async function joinAnnounced(s) {
  const { h, code, roomName } = await openHostRoomNamed(s);
  const { name: guestName } = await joinGuest(s, code, roomName);
  await chatLine(h.page, `${guestName} has joined the game`).waitFor({ state: "visible" });
  return `host chat: "${guestName} has joined the game"`;
}

/** room-notice: a player who joins while the match runs sees "match in progress" and is not put in the match. */
async function lateJoinNotice(s) {
  const { code, roomName } = await matchWithGuest(s);
  const late = await s.open("late", { name: uniqueName("late") });
  await joinByInvite(late, s.base, code, roomName);
  await late.page.locator("p.room-notice").filter({ hasText: "match in progress" }).waitFor({ state: "visible" });
  return `late joiner: p.room-notice "match in progress"`;
}

/** room-tabs, room-tabs-320: on a phone the room sections are tabs (Players, Match, Chat) and a tab selects its section; at 320x256 the tab bar sits inside the viewport. */
async function roomTabs(s) {
  const roomName = uniqueName("tabs");
  const host = await s.open("host", { name: uniqueName("host") });
  const code = await createRoom(host, s.base, roomName, { isPublic: true });
  const selected = async (tabs, name) => (await tabs.getByRole("tab", { name, exact: true }).getAttribute("aria-selected")) === "true";

  const guest = await s.open("guest", { name: uniqueName("guest"), phone: true });
  await guest.page.goto(`${s.base}/${code}`);
  await dismissPhoneSplash(guest.page);
  await roomTitle(guest.page, roomName).waitFor();
  const tabs = guest.page.getByRole("tablist", { name: "Room sections", exact: true });
  for (const name of ["Players", "Match", "Chat"]) {
    check(await tabs.getByRole("tab", { name, exact: true }).isVisible(), `no ${name} tab on the phone`);
  }
  check(await selected(tabs, "Players"), "Players is not the selected tab at load");
  await tabs.getByRole("tab", { name: "Match", exact: true }).click();
  check(await selected(tabs, "Match"), "Match does not select on click");
  await tabs.getByRole("tab", { name: "Chat", exact: true }).click();
  check(await selected(tabs, "Chat"), "Chat does not select on click");

  const tiny = await s.open("tiny", { name: uniqueName("tiny"), phone: true, viewport: { width: 320, height: 256 } });
  await tiny.page.goto(`${s.base}/${code}`);
  await dismissPhoneSplash(tiny.page);
  await roomTitle(tiny.page, roomName).waitFor();
  const bar = tiny.page.getByRole("tablist", { name: "Room sections", exact: true });
  const box = await bar.boundingBox();
  check(box !== null && box.x >= 0 && box.y >= 0 && box.x + box.width <= 320 && box.y + box.height <= 256, `tab bar ${JSON.stringify(box)} is not inside 320x256`);
  await bar.getByRole("tab", { name: "Match", exact: true }).click();
  check(await selected(bar, "Match"), "Match does not select on click at 320x256");
  return `phone tabs Players/Match/Chat, Players selected at load, Match and Chat switch; 320x256 tab bar at ${JSON.stringify(box)} and Match switches`;
}

/** room-row-menu, room-report-modal: a guest's menu on another player has only Report; Report opens "Report NAME" with four reasons; Send report confirms with a toast. */
async function reportPlayer(s) {
  const { name: hostName, code, roomName } = await openHostRoomNamed(s);
  const { g } = await joinGuest(s, code, roomName);
  const { page } = g;
  await rosterRows(page).filter({ hasText: hostName }).waitFor({ state: "visible" });
  await page.getByRole("button", { name: `Actions for ${hostName}`, exact: true }).click();
  const menu = page.getByRole("menu", { name: `Actions for ${hostName}`, exact: true });
  await menu.waitFor({ state: "visible" });
  const items = (await menu.getByRole("menuitem").allTextContents()).map((t) => t.trim());
  check(items.length === 1 && items[0] === "Report", `row menu items are ${JSON.stringify(items)}, expected ["Report"]`);

  await menu.getByRole("menuitem", { name: "Report", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: `Report ${hostName}`, exact: true });
  await dialog.waitFor({ state: "visible" });
  for (const reason of ["Harassment", "Offensive name", "Cheating", "Other"]) {
    check((await dialog.getByRole("radio", { name: reason, exact: true }).count()) === 1, `the report has no ${reason} reason`);
  }
  await dialog.getByRole("radio", { name: "Cheating", exact: true }).click();
  await dialog.getByRole("button", { name: "Send report", exact: true }).click();
  await page.getByText(`Thanks. An admin will look at ${hostName}.`, { exact: true }).waitFor({ state: "visible" });
  await dialog.waitFor({ state: "hidden" });
  return `row menu: ["Report"]; "Report ${hostName}" with 4 reasons; Send report -> "Thanks. An admin will look at ${hostName}."`;
}

// ---------------------------------------------------------------- group 6: host, kick, ban, leave

/** cmd-host, sys-host: /host hands the room to a player; both pages announce it, and the crown moves with it. */
async function chatHost(s) {
  const { h, name: hostName, code, roomName } = await openHostRoomNamed(s);
  const { g, name: guestName } = await joinGuest(s, code, roomName);
  const crown = (page, name) => rosterRows(page).filter({ hasText: name }).getByRole("img", { name: "Room host", exact: true });
  await sayPaced(h.page, `/host ${guestName}`);
  for (const page of [h.page, g.page]) await chatLine(page, `${guestName} is now the host`).waitFor({ state: "visible" });
  await crown(h.page, guestName).waitFor({ state: "visible" });
  await sayPaced(g.page, `/host ${hostName}`);
  for (const page of [h.page, g.page]) await chatLine(page, `${hostName} is now the host`).waitFor({ state: "visible" });
  await crown(g.page, hostName).waitFor({ state: "visible" });
  return `/host guest -> "${guestName} is now the host" on both pages and the crown moves; guest /host host hands it back`;
}

/** cmd-kick, sys-kick-ban, cmd-ban, cmd-unban, sys-left: /kick removes a player who can rejoin; /ban keeps them out and the Manage ban list shows them; /unban and the list's Unban lift it; a player who leaves is announced. */
async function kickBanLeave(s) {
  const { h, code, roomName } = await openHostRoomNamed(s);
  const { g, name: guestName } = await joinGuest(s, code, roomName);
  const manage = panel(h.page, "room-manage");
  const bans = manage.locator("li.room-ban").filter({ hasText: guestName });
  const inRoom = () => rosterRows(h.page).filter({ hasText: guestName }).waitFor({ state: "visible" });

  await sayPaced(h.page, `/kick ${guestName}`);
  await chatLine(h.page, `${guestName} was kicked`).waitFor({ state: "visible" });
  await rosterRows(h.page).filter({ hasText: guestName }).waitFor({ state: "detached" });
  await joinByInvite(g, s.base, code, roomName);
  await inRoom();

  await sayPaced(h.page, `/ban ${guestName}`);
  await chatLine(h.page, `${guestName} was banned`).waitFor({ state: "visible" });
  await bans.waitFor({ state: "visible" });
  await sayPaced(h.page, `/unban ${guestName}`);
  await chatLine(h.page, `${guestName} was unbanned`).waitFor({ state: "visible" });
  await manage.getByText("No one is banned.", { exact: true }).waitFor({ state: "visible" });
  await joinByInvite(g, s.base, code, roomName);
  await inRoom();

  // the Manage ban list's Unban button lifts a ban like /unban does
  await sayPaced(h.page, `/ban ${guestName}`);
  await bans.waitFor({ state: "visible" });
  const unbanned = await chatLines(h.page, `${guestName} was unbanned`).count();
  await bans.getByRole("button", { name: "Unban", exact: true }).click();
  await chatLines(h.page, `${guestName} was unbanned`).nth(unbanned).waitFor({ state: "visible" });
  await joinByInvite(g, s.base, code, roomName);
  await inRoom();

  await button(g.page, "Leave").click();
  await chatLine(h.page, `${guestName} has left the game`).waitFor({ state: "visible" });
  return `/kick -> "was kicked" and rejoin; /ban -> "was banned" and Manage ban list; /unban -> "was unbanned"; Unban button lifts a ban; guest Leave -> "has left the game"`;
}

// ---------------------------------------------------------------- group 7: match commands, replay, map commands

/** Sends a line in a match: the HUD chat opens with Enter when it is closed. */
async function matchChat(page, text) {
  if (!(await page.getByLabel("Chat message", { exact: true }).isVisible())) await page.keyboard.press("Enter");
  await sayPaced(page, text);
}

/** cmd-record, cmd-end: in a match /record saves the last 15 seconds (toast), and /end returns the host to the room. */
async function matchRecordEnd(s) {
  const { host } = await matchWithGuest(s);
  await sleep(6000); // a clip needs 5 s of play (clips.ts MIN_CLIP_SECS)
  const { page } = host;
  await matchChat(page, "/record");
  await page.getByText("Clip saved. It can play on the main menu.", { exact: true }).waitFor({ state: "visible" });
  await matchChat(page, "/end");
  await page.locator(".hud-leave").waitFor({ state: "hidden" });
  await roomTitle(page).waitFor({ state: "visible" });
  return `/record -> "Clip saved. It can play on the main menu."; /end -> match HUD hidden, room shown`;
}

/** room-replay-save: End match on the HUD, confirmed, leaves "Save replay" in the room; it downloads a .nbreplay. */
async function replaySave(s) {
  const { host } = await matchWithGuest(s);
  const { page } = host;
  await page.locator(".hud-end").click();
  const confirm = page.locator('[role="alertdialog"], [role="dialog"]').filter({ hasText: "End the match?" });
  await confirm.waitFor({ state: "visible" });
  await confirm.getByRole("button", { name: "End match", exact: true }).click();
  await button(page, "Save replay").waitFor({ state: "visible" });
  const [download] = await Promise.all([page.waitForEvent("download"), button(page, "Save replay").click()]);
  check(download.suggestedFilename().endsWith(".nbreplay"), `the replay downloads as ${download.suggestedFilename()}`);
  return `End match confirm -> "Save replay" in the room; downloads ${download.suggestedFilename()}`;
}

/** notice-map-cmd, cmd-upvote, cmd-downvote, cmd-fav, cmd-unfav, cmd-fave, cmd-unfave: a guest's vote gets the sign-in notice; the host's votes and favourites on a built-in map answer "not in the map library". */
async function mapCommands(s) {
  const h = await signedIn(s, "host", uniqueName("acct")); // map commands other than the notice need an account
  const roomName = uniqueName("room");
  const code = await createRoom(h, s.base, roomName, { isPublic: true });
  const { g } = await joinGuest(s, code, roomName);
  await sendAnswered(g.page, "/upvote", "Sign in to vote for maps and keep favourites");
  for (const cmd of ["/upvote", "/downvote", "/fav", "/unfav", "/fave", "/unfave"]) {
    await sendAnswered(h.page, cmd, "This map is not in the map library");
  }
  return `guest /upvote -> "Sign in to vote for maps and keep favourites"; signed-in host /upvote, /downvote, /fav, /unfav, /fave, /unfave -> "This map is not in the map library"`;
}

// ---------------------------------------------------------------- group 8: library maps, Fastest Times, race records, complexity

/** A map code as the room reads it: zlib-deflated JSON, base64, encodeURIComponent (sim map.rs decode_code). */
const mapCode = (map) => encodeURIComponent(deflateSync(Buffer.from(JSON.stringify(map))).toString("base64"));

const SETTINGS = { 3: 40, 15: 40, 16: 25 };
const FLOOR = { 1: 0, 2: 20, 3: 21, s: [{ p: [-20, -0.5, 20, -0.5, 20, 0.5, -20, 0.5] }] };
/** The race platform: a 12-unit ledge (fixture of client/qa/gameplay.mjs), its top at y 20.5. */
const RACE_PLATFORM = { 1: 0, 2: 20, 3: 21, s: [{ 7: 3754574, p: [-6, -0.5, 6, -0.5, 6, 0.5, -6, 0.5] }] };

/** A race: the spawn stands 4.5 units left of the finish, a solid checkpoint (31:1) the player walks into, which ends the run. */
const RACE_MAP = {
  b: [RACE_PLATFORM, { 1: 1, 2: 20, 3: 19.5, 31: 1, s: [{ p: [-0.5, -1, 0.5, -1, 0.5, 1, -0.5, 1] }] }],
  j: [],
  s: [{ 1: 15, 2: 19.5 }],
  p: [],
  tu: [],
  tc: [],
  gp: [],
  c: [],
  set: SETTINGS,
};

/** 1100 overlapping dynamic boxes: about 600k contact pairs, past MAX_CONTACTS (2^19), so the simulator stops the match (room.rs "too complex"). */
const COMPLEX_MAP = {
  b: [FLOOR, ...Array.from({ length: 1100 }, (_, i) => ({ 1: i + 1, 2: 20, 3: 10, 14: 2, s: [{ p: [-0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, 0.5] }] }))],
  j: [],
  s: [{ 1: 15, 2: 19.5 }],
  p: [],
  tu: [],
  tc: [],
  gp: [],
  c: [],
  set: SETTINGS,
};

/** Uploads `code` as a public map `name` from Library > Mine, then approves it as admin. Leaves the user on Library. */
async function uploadApprovedMap(s, user, code, name) {
  const { page } = user;
  await navTo(page, "Library");
  await page.getByRole("tab", { name: "Mine", exact: true }).or(button(page, "Mine")).first().click();
  await button(page, "Upload a map").click();
  await page.getByPlaceholder("Map name", { exact: true }).fill(name);
  await page.getByLabel("map code", { exact: true }).fill(code);
  await page.getByRole("radiogroup", { name: "Visibility", exact: true }).getByRole("radio", { name: "Public", exact: true }).click();
  await button(page, "Upload map").click();
  await page.locator("ul[aria-label=maps] li").filter({ hasText: name }).waitFor();
  const admin = await s.open("admin");
  await admin.page.goto(`${s.base}/admin`);
  await admin.page.locator("#pw").fill(ADMIN_PASSWORD);
  await button(admin.page, "Log in").click();
  await admin.page.getByRole("heading", { name: "Map approvals" }).waitFor();
  await admin.page.locator("table#maps tbody tr").filter({ hasText: name }).getByRole("button", { name: "Approve", exact: true }).click();
  await admin.page.getByText(`Approved ${name}.`, { exact: false }).waitFor();
}

/** The room host picks an approved library map (Change map > Library): it becomes the room map, a library map with an id. */
async function pickLibraryMap(page, name) {
  await button(page, "Change map").click();
  await button(page, "Library").click();
  const picker = page.getByRole("dialog", { name: "Pick a map", exact: true });
  await picker.waitFor();
  await picker.locator(".map-card").filter({ hasText: name }).first().click();
  await page.locator(".room-map-name").filter({ hasText: name }).waitFor();
}

/** The engine tick the page presents (game.ts publishes __qaTick), and a wait for a tick. */
const tickOf = (page) => page.evaluate(() => globalThis.__qaTick?.tick ?? -1);
async function waitTick(page, tick) {
  try {
    await page.waitForFunction((t) => (globalThis.__qaTick?.tick ?? -1) >= t, tick, { timeout: 120000, polling: 10 });
  } catch (err) {
    throw new Error(`engine tick never reached ${tick} (last presented: ${await tickOf(page)}): ${err.message}`);
  }
}

/** One run from the started match: holds ArrowRight from `delayTicks` after the HUD appears for 8 s (the finish is a few units away), then ends the match and returns to the room. */
async function raceRun(page, delayTicks) {
  await page.bringToFront();
  const t0 = await tickOf(page);
  await waitTick(page, t0 + delayTicks);
  await page.keyboard.down("ArrowRight");
  await sleep(6800);
  await page.keyboard.up("ArrowRight");
  const end = page.locator(".hud-end");
  if (await end.isVisible()) {
    await end.click();
    const confirm = page.getByRole("alertdialog", { name: "End the match?", exact: true });
    await confirm.getByRole("button", { name: "End match", exact: true }).click();
  }
  await roomTitle(page).waitFor({ state: "visible", timeout: 60000 });
}

/** The seconds of the room's personal-best line that comes after the `before` lines already in the log. */
async function personalBestSeconds(page, before) {
  const lines = page.locator("div.room-chat-log .room-chat-line").filter({ hasText: "personal best" });
  await lines.nth(before).waitFor({ state: "visible", timeout: 30000 });
  const text = (await lines.nth(before).textContent()) ?? "";
  const m = /set a personal best: (\d+\.\d+)s/.exec(text);
  if (!m) throw new Error(`personal best line "${text}" has no time`);
  return Number(m[1]);
}

/** sys-pb: a signed-in host races a library map with /set recordMode true. The first run (started 240 ticks after the HUD, past the countdown) and a second run held from the start: the faster one is a new personal best and is announced. */
async function racePersonalBest(s) {
  const user = await signedIn(s, "pbhost");
  const name = uniqueName("pb");
  await uploadApprovedMap(s, user, mapCode(RACE_MAP), name);
  const { page } = user;
  await createRoom(user, s.base, uniqueName("room"), { isPublic: true });
  await pickLibraryMap(page, name);
  await sendChat(page, "/set recordMode true");
  await chatLine(page, "recordMode: true").waitFor({ state: "visible" });
  const seconds = [];
  for (const delay of [240, 0]) {
    const before = await page.locator("div.room-chat-log .room-chat-line").filter({ hasText: "personal best" }).count();
    await startMatch(user, []);
    await raceRun(page, delay);
    seconds.push(await personalBestSeconds(page, before));
  }
  check(seconds[1] < seconds[0], `the faster run was not faster: ${seconds[0]}s then ${seconds[1]}s`);
  return `library map "${name}", /set recordMode true; personal best ${seconds[0]}s, then ${seconds[1]}s (faster, announced again)`;
}

/** room-fastest-modal: the built-in map's Fastest Times button is disabled; on an approved library map it opens "NAME by AUTHOR" with "No Records". */
async function fastestModal(s) {
  const user = await signedIn(s, "fastest");
  const name = uniqueName("fast");
  await uploadApprovedMap(s, user, mapCode(RACE_MAP), name);
  const { page } = user;
  await createRoom(user, s.base, uniqueName("room"), { isPublic: true });
  const fastest = button(page, "Fastest Times");
  await fastest.waitFor({ state: "visible" });
  check(await fastest.isDisabled(), "Fastest Times is enabled on a built-in map");
  await pickLibraryMap(page, name);
  check(await fastest.isEnabled(), "Fastest Times is disabled on a library map");
  await fastest.click();
  const times = page.getByRole("dialog", { name: "Fastest Times", exact: true });
  await times.getByText(`${name} by ${user.userName}`, { exact: true }).waitFor();
  await times.getByText("No Records", { exact: true }).waitFor();
  await page.keyboard.press("Escape");
  await times.waitFor({ state: "detached" });
  return `built-in map: Fastest Times disabled; library "${name}": "${name} by ${user.userName}", "No Records"`;
}

/** sys-too-complex: a host pastes a map of 1100 overlapping dynamic boxes; the match stops with the complexity notice. */
async function tooComplex(s) {
  const { h } = await openHostRoomNamed(s);
  const { page } = h;
  await button(page, "Change map").click();
  const dialog = page.getByRole("dialog", { name: "Choose a map", exact: true });
  await dialog.waitFor({ state: "visible" });
  await dialog.getByLabel("Map code or JSON", { exact: true }).fill(mapCode(COMPLEX_MAP));
  await dialog.getByRole("button", { name: "Use code", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await button(page, "Start").click();
  await chatLine(page, "This map is too complex to simulate, so the match was stopped.").waitFor({ state: "visible", timeout: 90000 });
  return `1100 overlapping dynamic boxes -> "This map is too complex to simulate, so the match was stopped."`;
}

// sys-no-map is NOT-REACHABLE (see chatTeams).
export const roomsInvScenarios = [
  { name: "inv rooms menu home", inv: ["menu-home", "menu-news-btn", "menu-mute-btn", "menu-fullscreen-btn"], run: menuHome },
  { name: "inv rooms quick empty", inv: ["quick-empty"], run: quickEmpty },
  { name: "inv rooms quick error", inv: ["quick-error"], run: quickError },
  { name: "inv rooms quick page", inv: ["quick-page", "quick-mode-card"], run: quickPage },
  { name: "inv rooms quick waiting", inv: ["quick-waiting"], run: quickWaiting },
  { name: "inv rooms browse empty", inv: ["browse-page", "browse-empty-none", "browse-create-modal", "NEW-browse-empty-name"], run: browseEmpty },
  {
    name: "inv rooms browse rows",
    inv: ["browse-page", "browse-row", "browse-locked-row", "browse-password-slot", "browse-empty-filter", "browse-filters", "NEW-browse-code-uppercase"],
    run: browseRows,
  },
  { name: "inv rooms room header", inv: ["room-header", "room-invite"], run: roomHeader },
  { name: "inv rooms room players", inv: ["room-players", "room-player-row"], run: roomPlayers },
  { name: "inv rooms room mode", inv: ["room-mode"], run: roomMode },
  { name: "inv rooms room map", inv: ["room-map-modal", "room-map-panel", "room-map-errors"], run: roomMap },
  { name: "inv rooms room manage", inv: ["room-manage"], run: roomManage },
  { name: "inv rooms room settings", inv: ["room-settings"], run: roomSettings },
  { name: "inv rooms room appearance", inv: ["room-appearance"], run: roomAppearance },
  { name: "inv rooms room dock", inv: ["room-dock", "room-starting"], run: roomDock },
  { name: "inv rooms chat notices", inv: ["room-chat", "cmd-help", "notice-help", "notice-unknown", "notice-usage", "notice-no-player", "notice-record"], run: chatNotices },
  { name: "inv rooms chat settings", inv: ["cmd-settings", "cmd-set", "sys-settings", "cmd-reset", "cmd-mode", "sys-map"], run: chatSettings },
  { name: "inv rooms chat teams", inv: ["cmd-lock", "sys-teams-lock", "cmd-unlock", "cmd-team", "cmd-join", "sys-nobody", "sys-nobody-spec-guest", "sys-nobody-start", "restore-team-host", "restore-team-guest", "sys-countdown", "cmd-start"], run: chatTeams },
  { name: "inv rooms invite links", inv: ["app-invite", "app-invite-query"], run: inviteLinks },
  { name: "inv rooms region redirect", inv: ["redirect"], topology: regionServers, run: regionRedirect },
  { name: "inv rooms join announced", inv: ["sys-joined"], run: joinAnnounced },
  { name: "inv rooms late join notice", inv: ["room-notice"], run: lateJoinNotice },
  { name: "inv rooms phone tabs", inv: ["room-tabs", "room-tabs-320"], run: roomTabs },
  { name: "inv rooms report player", inv: ["room-row-menu", "room-report-modal"], run: reportPlayer },
  { name: "inv rooms chat host", inv: ["cmd-host", "sys-host"], run: chatHost },
  { name: "inv rooms chat kick ban", inv: ["cmd-kick", "sys-kick-ban", "cmd-ban", "cmd-unban", "sys-left"], run: kickBanLeave },
  { name: "inv rooms match record end", inv: ["cmd-record", "cmd-end"], run: matchRecordEnd },
  { name: "inv rooms replay save", inv: ["room-replay-save"], run: replaySave },
  { name: "inv rooms map commands", inv: ["notice-map-cmd", "cmd-upvote", "cmd-downvote", "cmd-fav", "cmd-unfav", "cmd-fave", "cmd-unfave"], run: mapCommands },
  { name: "inv rooms fastest modal", inv: ["room-fastest-modal"], run: fastestModal },
  { name: "inv rooms race pb", inv: ["sys-pb"], run: racePersonalBest },
  { name: "inv rooms too complex", inv: ["sys-too-complex"], run: tooComplex },
];
