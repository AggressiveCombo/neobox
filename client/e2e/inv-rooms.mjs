// Inventory rows for the rooms slice: the main menu header, quick play, browse, the create form, the room page with its
// controls, the room chat and its commands and notices, and the links into rooms. Each scenario names the rows it proves
// in `inv`; every check asserts a row's "shows" column, with role/name locators where they exist.

import { PASSWORD, button, createRoom, joinByInvite, menuName, playFromMenu, roomCode, roomTitle, sleep, uniqueName } from "./lib.mjs";

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

export const roomsInvScenarios = [
  { name: "inv rooms menu home", inv: ["menu-home", "menu-news-btn", "menu-mute-btn", "menu-fullscreen-btn"], run: menuHome },
  { name: "inv rooms quick empty", inv: ["quick-empty"], run: quickEmpty },
  { name: "inv rooms quick error", inv: ["quick-error"], run: quickError },
  { name: "inv rooms quick page", inv: ["quick-page", "quick-mode-card"], run: quickPage },
  { name: "inv rooms quick waiting", inv: ["quick-waiting"], run: quickWaiting },
  { name: "inv rooms browse empty", inv: ["browse-page", "browse-empty-none", "browse-create-modal"], run: browseEmpty },
  {
    name: "inv rooms browse rows",
    inv: ["browse-page", "browse-row", "browse-locked-row", "browse-password-slot", "browse-empty-filter", "browse-filters"],
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
];
