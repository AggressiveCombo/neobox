// Inventory rows for the rooms slice: the main menu header, quick play, browse, the create form, the room page with its
// controls, the room chat and its commands and notices, and the links into rooms. Each scenario names the rows it proves
// in `inv`; every check asserts a row's "shows" column, with role/name locators where they exist.

import { PASSWORD, button, createRoom, menuName, playFromMenu, roomCode, roomTitle, uniqueName } from "./lib.mjs";

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
];
